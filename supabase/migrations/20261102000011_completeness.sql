-- =====================================================================
-- 2 Nov 2026: completeness nudges.
--
-- Every morning daily_checks() looks at the previous business day and works
-- out, for each house and each sales point, what should have been entered and
-- what was. Gaps go to the people responsible at that place (in the app, by
-- push, and by email when they have an address), plus one summary to the
-- owner and farm manager.
--
-- "Nothing happened" versus "not entered":
--  * A laying house always lays, eats and drinks: no eggs, water or feed
--    record means the day was not entered.
--  * Deaths: no rows is ambiguous. The house sheet now records "no deaths"
--    explicitly (day_marks). Deaths are reported, never nudged on their own.
--  * Sales points: a day with no sales may be a closed day. Each location has
--    regular closed days (locations.closed_dow, ISO 1 = Monday ... 7 = Sunday;
--    Sunday everywhere for now), and staff can mark any day closed.
--
-- Also fixed in daily_checks(): it no longer waits for go_live (only the
-- unbanked-cash check does), lay rate counts big and damaged eggs, and every
-- alert carries a dedupe key, so a retry never sends it twice.
-- Existing rows are not changed. _notify() is unchanged; _notify_once() is new.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Closed days, the tracking start, day marks
-- ---------------------------------------------------------------------
alter table public.locations add column if not exists closed_dow int[] not null default '{7}';
alter table public.locations drop constraint if exists locations_closed_dow;
alter table public.locations add constraint locations_closed_dow check (closed_dow <@ array[1,2,3,4,5,6,7]);
comment on column public.locations.closed_dow is 'Days the location does not trade (ISO: 1 Monday ... 7 Sunday). No sales or counts are expected then.';

alter table public.settings add column if not exists tracking_from date;
comment on column public.settings.tracking_from is 'First business day the completeness checks and digests count. Days before it are not expected to have records.';
update public.settings set tracking_from = coalesce(tracking_from, (
  select min(x.d) from (select min(d) d from egg_collections where voided_at is null
                        union all select min(d) from sales where voided_at is null and not imported) x), biz_today())
 where id = 1;

create table if not exists public.day_marks (
  id bigint generated always as identity primary key,
  d date not null, recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  kind text not null check (kind in ('closed', 'no_deaths')),
  location_id text references public.locations(id),
  house_id text references public.houses(id),
  check ((kind = 'closed' and location_id is not null and house_id is null)
      or (kind = 'no_deaths' and house_id is not null and location_id is null))
);
comment on table public.day_marks is 'Explicit "nothing happened": a sales point closed for the day, or no deaths in a house.';
create unique index if not exists day_marks_one on public.day_marks (kind, d, coalesce(location_id, ''), coalesce(house_id, '')) where voided_at is null;
alter table public.day_marks enable row level security;
create policy read_marks on public.day_marks for select to authenticated
  using ((select is_mgmt()) or location_id = (select me_loc()) or (house_id is not null and (select can_farm())));
revoke all on public.day_marks from public, anon, authenticated;
grant select on public.day_marks to authenticated;
grant all on public.day_marks to service_role;
create trigger zz_bump after insert or update or delete on public.day_marks for each statement execute function public._bump();

-- p_kind 'closed' (p_loc) or 'no_deaths' (p_house); p_on false takes the mark back.
-- Anyone can mark today or yesterday (the morning nudge is about yesterday);
-- earlier days follow the usual rule (owner or farm manager, up to 62 days back).
create or replace function public.rpc_mark_day(p_kind text, p_loc text default null, p_house text default null,
                                               p_date date default null, p_on boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_d date; v_id bigint;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  v_d := case when p_date is null then biz_today() when p_date = biz_today() - 1 then p_date else _day(s, p_date) end;
  if p_kind = 'closed' then
    perform _check_loc(s, p_loc);
    if p_on and exists (select 1 from sales where location_id = p_loc and d = v_d and voided_at is null) then
      raise exception 'Sales are recorded for % on that day, so it was not closed', _loc_short(p_loc);
    end if;
  elsif p_kind = 'no_deaths' then
    if s.role not in ('owner','manager','clerk') then raise exception 'Only farm staff can confirm deaths'; end if;
    if not exists (select 1 from houses where id = p_house) then raise exception 'Unknown house'; end if;
    if p_on and exists (select 1 from mortality where house_id = p_house and d = v_d and voided_at is null) then
      raise exception 'Deaths are already recorded for that house and day';
    end if;
  else
    raise exception 'Unknown mark';
  end if;
  if p_on then
    insert into day_marks (d, kind, location_id, house_id, recorded_by)
    values (v_d, p_kind, case when p_kind = 'closed' then p_loc end, case when p_kind = 'no_deaths' then p_house end, s.id)
    on conflict (kind, d, coalesce(location_id, ''), coalesce(house_id, '')) where voided_at is null do nothing
    returning id into v_id;
  else
    update day_marks set voided_at = now(), voided_by = s.id, void_reason = 'Taken back'
     where kind = p_kind and d = v_d and voided_at is null
       and coalesce(location_id, '') = coalesce(case when p_kind = 'closed' then p_loc end, '')
       and coalesce(house_id, '') = coalesce(case when p_kind = 'no_deaths' then p_house end, '');
  end if;
  return jsonb_build_object('date', v_d, 'kind', p_kind, 'on', p_on);
end $$;

-- ---------------------------------------------------------------------
-- 2. Alerts that are sent once: a dedupe key per alert and day
-- ---------------------------------------------------------------------
alter table public.notifications add column if not exists dedupe_key text;
create unique index if not exists notifications_dedupe on public.notifications (dedupe_key) where dedupe_key is not null;

-- returns the new id, or null when an alert with that key was already sent
create or replace function public._notify_once(p_key text, p_sev text, p_title text, p_body text, p_roles public.staff_role[],
                                               p_loc text default null, p_kind text default null)
returns bigint language sql security definer set search_path = public as $$
  insert into notifications (sev, title, body, to_roles, location_id, kind, dedupe_key)
  values (p_sev, p_title, coalesce(p_body, ''), p_roles, p_loc, p_kind, p_key)
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id
$$;

-- ---------------------------------------------------------------------
-- 3. What should have been entered for a day, and what was
-- ---------------------------------------------------------------------
-- One item per place: houses (eggs, water), the farm (feed), and each sales
-- point (sales, opening count, closing count) unless it was closed.
create or replace function public.completeness(p_day date)
returns jsonb language sql stable security definer set search_path = public as $$
  with st as (select * from settings where id = 1),
  hs as (select * from houses h where h.active and h.birds_at_start > 0 and h.start_date <= p_day),
  house_items as (
    select jsonb_build_object(
      'scope', 'house', 'id', h.id, 'name', h.name, 'location_id', 'FARM', 'roles', jsonb_build_array('clerk', 'manager'),
      'expected', jsonb_build_array('eggs', 'water'),
      'missing', to_jsonb(array_remove(array[
        case when not exists (select 1 from egg_collections e where e.house_id = h.id and e.d = p_day and e.voided_at is null) then 'eggs' end,
        case when not exists (select 1 from water_logs w where w.house_id = h.id and w.d = p_day and w.kind = 'intake' and w.voided_at is null) then 'water' end
      ], null)),
      'deaths', case
        when exists (select 1 from mortality m where m.house_id = h.id and m.d = p_day and m.voided_at is null) then 'recorded'
        when exists (select 1 from day_marks k where k.house_id = h.id and k.d = p_day and k.kind = 'no_deaths' and k.voided_at is null) then 'none'
        else 'unconfirmed' end) j, h.sort
    from hs h),
  farm_item as (
    select jsonb_build_object(
      'scope', 'farm', 'id', 'FEED', 'name', 'Central Farm feed', 'location_id', 'FARM', 'roles', jsonb_build_array('clerk', 'manager'),
      'expected', jsonb_build_array('feed'),
      'missing', case when exists (select 1 from feed_moves f where f.d = p_day and f.kind = 'use' and f.voided_at is null)
                      then '[]'::jsonb else jsonb_build_array('feed') end) j
    where exists (select 1 from hs)),
  outlet_items as (
    select jsonb_build_object(
      'scope', 'outlet', 'id', l.id, 'name', l.name, 'location_id', l.id, 'roles', jsonb_build_array('pos'),
      'closed', c.closed, 'closed_why', c.why,
      'expected', case when c.closed then '[]'::jsonb else jsonb_build_array('sales', 'opening count', 'closing count') end,
      'missing', case when c.closed then '[]'::jsonb else to_jsonb(array_remove(array[
        case when not exists (select 1 from sales s where s.location_id = l.id and s.d = p_day and s.voided_at is null) then 'sales' end,
        case when not exists (select 1 from stock_counts k where k.location_id = l.id and k.d = p_day and k.kind = 'open' and k.voided_at is null) then 'opening count' end,
        case when not exists (select 1 from stock_counts k where k.location_id = l.id and k.d = p_day and k.kind = 'close' and k.voided_at is null) then 'closing count' end
      ], null)) end) j, l.sort
    from locations l
    cross join lateral (select
      extract(isodow from p_day)::int = any (l.closed_dow)
        or exists (select 1 from day_marks k where k.location_id = l.id and k.d = p_day and k.kind = 'closed' and k.voided_at is null) as closed,
      case when extract(isodow from p_day)::int = any (l.closed_dow) then 'regular closed day'
           when exists (select 1 from day_marks k where k.location_id = l.id and k.d = p_day and k.kind = 'closed' and k.voided_at is null) then 'marked closed' end as why) c)
  select jsonb_build_object('day', p_day, 'label', to_char(p_day, 'Dy DD Mon'),
    'tracked', p_day >= coalesce((select tracking_from from st), p_day),
    'items', coalesce((select jsonb_agg(j order by g, s) from (
        select j, 0 as g, sort as s from house_items
        union all select j, 1, 0 from farm_item
        union all select j, 2, sort from outlet_items) x), '[]'::jsonb))
$$;

-- for the owner and farm manager's "Days with gaps": the last p_days tracked days
create or replace function public.gaps(p_days int default 14)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s staff; v_from date; r jsonb := '[]'::jsonb; d date; c jsonb;
begin
  s := _me();
  if s.role not in ('owner','manager') then raise exception 'Only the owner or farm manager can see gaps'; end if;
  v_from := greatest(biz_today() - least(greatest(p_days, 1), 62), coalesce((select tracking_from from settings where id = 1), biz_today()));
  for d in select generate_series(v_from, biz_today() - 1, interval '1 day')::date loop
    c := completeness(d);
    r := r || coalesce((select jsonb_agg(i || jsonb_build_object('day', d, 'label', c->>'label'))
                          from jsonb_array_elements(c->'items') i where jsonb_array_length(i->'missing') > 0), '[]'::jsonb);
  end loop;
  return r;
end $$;

-- the morning nudges for one day; returns how many were sent (0 on a retry)
create or replace function public._completeness_nudges(p_day date)
returns int language plpgsql security definer set search_path = public as $$
declare c jsonb := completeness(p_day); i jsonb; v_id bigint; n int := 0; v_list text[] := '{}'; v_exp int := 0; v_ok int := 0;
        v_what text;
begin
  if not (c->>'tracked')::boolean then return 0; end if;
  for i in select * from jsonb_array_elements(c->'items') loop
    v_exp := v_exp + jsonb_array_length(i->'expected');
    v_ok := v_ok + jsonb_array_length(i->'expected') - jsonb_array_length(i->'missing');
    continue when jsonb_array_length(i->'missing') = 0;
    v_what := (select string_agg(x, ', ') from jsonb_array_elements_text(i->'missing') x);
    v_list := v_list || format('%s (%s)', i->>'name', v_what);
    v_id := _notify_once(format('gap:%s:%s:%s', p_day, i->>'scope', i->>'id'), 'amber',
      format('%s: %s not entered for %s', i->>'name', v_what, c->>'label'),
      case i->>'scope'
        when 'outlet' then 'Enter them on the daily stock sheet today. If you did not open, mark the day closed.'
        when 'farm' then 'Enter the feed given on the daily house sheet today.'
        else 'Enter them on the daily house sheet today.' end,
      array(select jsonb_array_elements_text(i->'roles'))::staff_role[], i->>'location_id', 'gap');
    if v_id is not null then n := n + 1; end if;
  end loop;
  if cardinality(v_list) > 0 then
    v_id := _notify_once(format('gap-summary:%s', p_day), case when v_ok * 10 < v_exp * 8 then 'orange' else 'amber' end,
      format('%s of %s daily records entered for %s', v_ok, v_exp, c->>'label'),
      'Missing: ' || array_to_string(v_list, '; ') || '. Figures for that day are provisional until they are entered.',
      array['owner','manager']::staff_role[], null, 'gap');
    if v_id is not null then n := n + 1; end if;
  end if;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- 4. Calls from the database to the weekly-digest edge function
--    (same trigger-secret pattern as push-notify and backup)
-- ---------------------------------------------------------------------
create or replace function public._digest_post(p_body jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text; v_id bigint;
begin
  select replace(push_url, '/push-notify', '/weekly-digest') into v_url from settings where id = 1;
  select value into v_secret from app_secrets where key = 'trigger_secret';
  if v_url is null or v_secret is null then return null; end if;
  begin
    select net.http_post(url := v_url, body := p_body,
                         headers := jsonb_build_object('Content-Type', 'application/json', 'x-dpv-trigger', v_secret),
                         timeout_milliseconds := 120000) into v_id;
  exception when others then
    return null;  -- never block the checks
  end;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 5. daily_checks(): completeness first, then the existing checks, each sent once
-- ---------------------------------------------------------------------
create or replace function public.daily_checks()
returns integer language plpgsql security definer set search_path = public as $$
declare st settings; t date := biz_today(); y date := biz_today() - 1; h record; v_y numeric; v_avg numeric; v_days int;
        v_feed numeric; v_water numeric; v_cnt int := 0; v_gaps int := 0; v_lvl numeric; l record; m record; r3 numeric; r7 numeric;
        v_farm boolean;
begin
  select * into st from settings where id = 1;
  v_farm := exists (select 1 from houses where active and birds_at_start > 0);

  -- 1. what was not entered yesterday
  v_gaps := _completeness_nudges(y);
  v_cnt := v_gaps;

  if v_farm then
    for h in select * from houses where active and birds_at_start > 0 loop
      -- water intake drop (a missing day is a completeness gap, not a drop)
      select coalesce(sum(litres), 0) into v_y from water_logs where kind = 'intake' and voided_at is null and house_id = h.id and d = y;
      select avg(q.t), count(*) into v_avg, v_days from (
        select sum(litres) t from water_logs where kind = 'intake' and voided_at is null and house_id = h.id and d between y - 7 and y - 1 group by d) q;
      if v_days >= 3 and v_y > 0 and v_y < v_avg * (1 - st.water_drop_pct / 100) then
        if _notify_once(format('dc:water-drop:%s:%s', y, h.id), 'orange', format('%s drank %s%% less water yesterday', h.name, round((1 - v_y / v_avg) * 100)),
             format('%s L against a 7-day average of %s L. A drop in water intake is often the first sign of disease or a blocked line.', round(v_y), round(v_avg)),
             array['owner','manager','clerk']::staff_role[], 'FARM', 'water') is not null then v_cnt := v_cnt + 1; end if;
      end if;
      -- lay rate: last 3 days against the 7 days before, all grades and damaged, entered days only
      select sum(n + b + c + j + dmg)::numeric / nullif(sum(hens), 0) into r3
        from farm_daily2(y - 2, y) where house_id = h.id and n + b + c + j + dmg > 0;
      select sum(n + b + c + j + dmg)::numeric / nullif(sum(hens), 0) into r7
        from farm_daily2(y - 9, y - 3) where house_id = h.id and n + b + c + j + dmg > 0;
      if r3 is not null and r7 is not null and (r7 - r3) * 100 > st.lay_drop_pts then
        if _notify_once(format('dc:lay-drop:%s:%s', y, h.id), 'orange', format('%s lay rate down %s points', h.name, round((r7 - r3) * 100, 1)),
             format('Last 3 days %s%% against %s%% the week before. Check water, feed intake and signs of disease.', round(r3 * 100, 1), round(r7 * 100, 1)),
             array['owner','manager']::staff_role[], 'FARM', 'production') is not null then v_cnt := v_cnt + 1; end if;
      end if;
    end loop;
    -- water : feed ratio for the whole farm
    select coalesce(sum(kg), 0) into v_feed from feed_moves where kind = 'use' and voided_at is null and d = y;
    select coalesce(sum(litres), 0) into v_water from water_logs where kind = 'intake' and voided_at is null and d = y;
    if v_feed > 0 and v_water > 0 and (v_water / v_feed < st.water_ratio_min or v_water / v_feed > st.water_ratio_max) then
      if _notify_once(format('dc:ratio:%s', y), 'amber', format('Water to feed ratio %s : 1 yesterday', round(v_water / v_feed, 2)),
           format('%s L water for %s kg feed. Normal range is %s to %s.', round(v_water), round(v_feed), st.water_ratio_min, st.water_ratio_max),
           array['owner','manager']::staff_role[], 'FARM', 'water') is not null then v_cnt := v_cnt + 1; end if;
    end if;
    -- feed and tank reminders when Low or worse
    v_lvl := _feed_stock() / nullif(st.feed_buffer_kg, 0);
    if v_lvl is not null and band_rank(buffer_band(v_lvl)) >= 4 then
      if _notify_once(format('dc:feed:%s', t), band_sev(buffer_band(v_lvl)), format('Feed still %s (%s%%)', band_label(buffer_band(v_lvl)), round(v_lvl * 100)),
           format('Order %s bags today.', ceil(greatest(st.feed_buffer_kg - _feed_stock(), 0) / st.bag_kg)), array['owner','manager']::staff_role[], 'FARM', 'feed') is not null
      then v_cnt := v_cnt + 1; end if;
    end if;
    v_lvl := _tank() / nullif(st.tank_capacity_l, 0);
    if v_lvl is not null and band_rank(buffer_band(v_lvl)) >= 4 then
      if _notify_once(format('dc:tank:%s', t), band_sev(buffer_band(v_lvl)), format('Water tank %s%% full', round(v_lvl * 100)), 'Refill the tank and record the new level.',
           array['manager','clerk']::staff_role[], 'FARM', 'water') is not null then v_cnt := v_cnt + 1; end if;
    end if;
  end if;
  -- vaccinations and treatments due in the next 2 days
  for m in select * from schedule where not done and not cancelled and due between t and t + 2 loop
    if _notify_once(format('dc:schedule:%s:%s', t, m.id), 'info', format('%s due %s', m.task, case when m.due = t then 'today' else to_char(m.due, 'Dy DD Mon') end), m.house,
         array['manager','clerk']::staff_role[], 'FARM', 'schedule') is not null then v_cnt := v_cnt + 1; end if;
  end loop;
  -- medicines below reorder level (Mondays only, to avoid repeating daily)
  if extract(isodow from t) = 1 then
    for m in select md.id, md.name, md.unit, md.reorder, v.qty from medicines md join v_med_stock v on v.medicine_id = md.id
              where md.active and v.qty <= md.reorder loop
      if _notify_once(format('dc:medicine:%s:%s', t, m.id), 'amber', format('%s below reorder level', m.name), format('%s %s left.', m.qty, m.unit),
           array['manager','clerk']::staff_role[], 'FARM', 'medicine') is not null then v_cnt := v_cnt + 1; end if;
    end loop;
  end if;
  -- unbanked cash (balances start at go-live)
  if st.go_live is not null then
    for l in select a.location_id, a.id, _balance(a.id) bal from accounts a where a.kind = 'cash' loop
      if l.bal > st.unbanked_max then
        if _notify_once(format('dc:unbanked:%s:%s', t, l.location_id), 'amber', format('%s cash unbanked at %s', _kes(l.bal), _loc_short(l.location_id)),
             format('Above the %s limit. Bank it or move it to Paybill.', _kes(st.unbanked_max)),
             array['owner','pos']::staff_role[], l.location_id, 'cash') is not null then v_cnt := v_cnt + 1; end if;
      end if;
    end loop;
  end if;
  -- emails for yesterday's gaps (weekly-digest function, mode "nudges"); it skips anyone already emailed
  if v_gaps > 0 then perform _digest_post(jsonb_build_object('mode', 'nudges', 'day', y)); end if;
  return v_cnt;
end $$;

-- ---------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------
revoke execute on function
  public._notify_once(text, text, text, text, public.staff_role[], text, text), public.completeness(date),
  public._completeness_nudges(date), public._digest_post(jsonb), public.gaps(int),
  public.rpc_mark_day(text, text, text, date, boolean)
from public, anon;
revoke execute on function
  public._notify_once(text, text, text, text, public.staff_role[], text, text), public.completeness(date),
  public._completeness_nudges(date), public._digest_post(jsonb)
from authenticated;
grant execute on function public.gaps(int), public.rpc_mark_day(text, text, text, date, boolean) to authenticated;
grant execute on all functions in schema public to service_role;
