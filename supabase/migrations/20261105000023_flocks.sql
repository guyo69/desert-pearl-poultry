-- 5 Nov 2026: flocks and houses from the farm (production clerk and farm manager).
--   * houses.breed: the breed of the flock in the house now.
--   * flocks: every flock placed in a house (breed, hens placed, date, age at
--     placing, expected lay rate), and when it left. One flock per house at a
--     time: placing a new flock ends the one before. Each house's current-flock
--     fields (birds_at_start, start_date, age_weeks_at_start, expected_lay, breed)
--     follow its current flock, so every screen and report keeps working.
--   * farm_daily2() now counts hens from the flock in the house on each day, so
--     a house's earlier flocks keep their lay rates after a new flock arrives.
--   * rpc_flock(action, p): house_new, place, edit, end (owner, farm manager,
--     production clerk; setup, so the owner can use it too).
-- Changed, not new: farm_daily2() (a read function), activity() and dashboard()
-- (both last changed in migration 22). The existing houses get one flock each,
-- copied from their current figures; no existing row changes.

alter table public.houses add column if not exists breed text;

create table if not exists public.flocks (
  id bigint generated always as identity primary key,
  house_id text not null references public.houses(id),
  breed text,
  hens int not null check (hens > 0),
  placed_on date not null,
  age_weeks numeric not null default 0 check (age_weeks >= 0),
  expected_lay numeric not null default 0.9 check (expected_lay between 0 and 1),
  ended_on date,
  end_note text,
  note text,
  recorded_at timestamptz not null default now(), recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  check (ended_on is null or ended_on >= placed_on)
);
create index if not exists flocks_house on public.flocks (house_id, placed_on);
create unique index if not exists flocks_one_current on public.flocks (house_id) where ended_on is null and voided_at is null;

alter table public.flocks enable row level security;
drop policy if exists read_farm on public.flocks;
create policy read_farm on public.flocks for select to authenticated using ((select can_farm()));
revoke all on public.flocks from public, anon, authenticated;
grant select on public.flocks to authenticated;
grant all on public.flocks to service_role;
drop trigger if exists zz_bump on public.flocks;
create trigger zz_bump after insert or update or delete on public.flocks for each statement execute function public._bump();

-- the flocks in the houses today, from the house list (recorded_by is left empty)
insert into public.flocks (house_id, hens, placed_on, age_weeks, expected_lay)
select h.id, h.birds_at_start, h.start_date, h.age_weeks_at_start, h.expected_lay
  from public.houses h
 where h.birds_at_start > 0 and not exists (select 1 from public.flocks f where f.house_id = h.id);

-- hens in each house on each day: the flock placed in it that day, less deaths since it was placed
create or replace function public.farm_daily2(p_from date, p_to date)
returns table (house_id text, d date, n int, b int, c int, j int, dmg int, deaths int, hens int)
language sql stable security invoker set search_path = public as $$
  select h.id, g.day::date,
    coalesce((select sum(e.n) from egg_collections e where e.house_id = h.id and e.d = g.day and e.voided_at is null), 0)::int,
    coalesce((select sum(e.b) from egg_collections e where e.house_id = h.id and e.d = g.day and e.voided_at is null), 0)::int,
    coalesce((select sum(e.c) from egg_collections e where e.house_id = h.id and e.d = g.day and e.voided_at is null), 0)::int,
    coalesce((select sum(e.j) from egg_collections e where e.house_id = h.id and e.d = g.day and e.voided_at is null), 0)::int,
    coalesce((select sum(e.dmg) from egg_collections e where e.house_id = h.id and e.d = g.day and e.voided_at is null), 0)::int,
    coalesce((select sum(m.birds) from mortality m where m.house_id = h.id and m.d = g.day and m.voided_at is null), 0)::int,
    (f.hens - coalesce((select sum(m.birds) from mortality m
        where m.house_id = h.id and m.d >= f.placed_on and m.d < g.day and m.voided_at is null), 0))::int
  from houses h
  cross join generate_series(p_from, p_to, interval '1 day') as g(day)
  cross join lateral (
    (select x.hens, x.placed_on from flocks x
      where x.house_id = h.id and x.voided_at is null and x.placed_on <= g.day and (x.ended_on is null or g.day::date < x.ended_on)
      order by x.placed_on desc, x.id desc limit 1)
    union all
    -- a house with no flock on record yet counts as before, from the house list
    (select h.birds_at_start, h.start_date
      where g.day::date >= h.start_date and not exists (select 1 from flocks y where y.house_id = h.id and y.voided_at is null))
    limit 1) f
$$;

-- ---------------------------------------------------------------------
-- Houses and flocks
--   house_new  {id, name}                                         a new, empty house
--   place      {house, breed?, hens, placed_on?, age_weeks, expected_lay, note?}
--                                                                 a new flock; ends the one before
--   edit       {flock, breed?, age_weeks?, expected_lay?, note?}  the flock in a house now
--   end        {house, ended_on?, note}                           the house is emptied
-- ---------------------------------------------------------------------
create or replace function public.rpc_flock(p_action text, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; h houses; f flocks; v_id text; v_name text; v_d date; v_hens int; v_age numeric; v_exp numeric;
        v_breed text := nullif(trim(coalesce(p->>'breed', '')), ''); v_note text := nullif(trim(coalesce(p->>'note', '')), ''); v_new bigint;
begin
  s := _require(array['owner','manager','clerk']::staff_role[]);
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Nothing to save'; end if;
  if length(coalesce(v_breed, '')) > 40 then raise exception 'The breed is too long'; end if;
  if length(coalesce(v_note, '')) > 200 then raise exception 'The note is too long'; end if;
  perform _lock('flock');
  if p_action in ('place', 'end') then
    select * into h from houses where id = p->>'house';
    if h.id is null then raise exception 'Choose the house'; end if;
  end if;
  case p_action
  when 'house_new' then
    v_id := upper(trim(coalesce(p->>'id', '')));
    v_name := trim(coalesce(p->>'name', ''));
    if v_id !~ '^[A-Z0-9]{1,6}$' then raise exception 'Give the house a short code: letters or numbers, up to 6'; end if;
    if v_name = '' or length(v_name) > 40 then raise exception 'Give the house a name'; end if;
    if exists (select 1 from houses where id = v_id) then raise exception 'There is already a house with the code %', v_id; end if;
    if exists (select 1 from houses where lower(name) = lower(v_name)) then raise exception 'There is already a house called %', v_name; end if;
    insert into houses (id, name, birds_at_start, start_date, age_weeks_at_start, expected_lay, active, sort)
    values (v_id, v_name, 0, biz_today(), 0, 0.9, true, (select coalesce(max(sort), 0) + 1 from houses));
    return jsonb_build_object('id', v_id, 'name', v_name);
  when 'place' then
    v_d := coalesce((p->>'placed_on')::date, biz_today());
    v_hens := (p->>'hens')::int;
    v_age := coalesce((p->>'age_weeks')::numeric, 0);
    v_exp := (p->>'expected_lay')::numeric;
    if v_exp > 1 then v_exp := v_exp / 100; end if;       -- 90 or 0.9
    if coalesce(v_hens, 0) <= 0 then raise exception 'Enter the hens placed'; end if;
    if v_hens > 200000 then raise exception 'That is more hens than a house holds. Check the number'; end if;
    if v_age < 0 or v_age > 120 then raise exception 'Enter the age in weeks'; end if;
    if v_exp is null or v_exp <= 0 or v_exp > 1 then raise exception 'Enter the expected lay rate'; end if;
    if v_d > biz_today() then raise exception 'The date cannot be in the future'; end if;
    if v_d < biz_today() - 62 then raise exception 'That is more than 62 days ago'; end if;
    select * into f from flocks where house_id = h.id and ended_on is null and voided_at is null;
    if f.id is not null then
      if v_d <= f.placed_on then raise exception 'The flock in % was placed on %. The new one must come after it', h.name, to_char(f.placed_on, 'DD Mon YYYY'); end if;
      update flocks set ended_on = v_d, end_note = coalesce(end_note, 'A new flock was placed') where id = f.id;
    elsif exists (select 1 from flocks where house_id = h.id and voided_at is null and ended_on > v_d) then
      raise exception 'The house had a flock until after that date. Choose a later date';
    end if;
    insert into flocks (house_id, breed, hens, placed_on, age_weeks, expected_lay, note, recorded_by)
    values (h.id, v_breed, v_hens, v_d, v_age, v_exp, v_note, s.id) returning id into v_new;
    update houses set birds_at_start = v_hens, start_date = v_d, age_weeks_at_start = v_age, expected_lay = v_exp, breed = v_breed, active = true
     where id = h.id;
    return jsonb_build_object('id', v_new, 'house', h.name, 'hens', v_hens, 'ended', f.id is not null);
  when 'edit' then
    select * into f from flocks where id = (p->>'flock')::bigint and voided_at is null;
    if f.id is null or f.ended_on is not null then raise exception 'Only the flock in a house now can be changed'; end if;
    v_age := coalesce((p->>'age_weeks')::numeric, f.age_weeks);
    v_exp := coalesce((p->>'expected_lay')::numeric, f.expected_lay);
    if v_exp > 1 then v_exp := v_exp / 100; end if;
    if v_age < 0 or v_age > 120 then raise exception 'Enter the age in weeks'; end if;
    if v_exp <= 0 or v_exp > 1 then raise exception 'Enter the expected lay rate'; end if;
    update flocks set breed = coalesce(v_breed, breed), age_weeks = v_age, expected_lay = v_exp, note = coalesce(v_note, note) where id = f.id;
    update houses set breed = coalesce(v_breed, breed), age_weeks_at_start = v_age, expected_lay = v_exp where id = f.house_id;
    return jsonb_build_object('id', f.id);
  when 'end' then
    v_d := coalesce((p->>'ended_on')::date, biz_today());
    select * into f from flocks where house_id = h.id and ended_on is null and voided_at is null;
    if f.id is null then raise exception '% has no flock in it', h.name; end if;
    if v_note is null then raise exception 'Say why the house is empty, for example sold or moved'; end if;
    if v_d > biz_today() then raise exception 'The date cannot be in the future'; end if;
    if v_d <= f.placed_on then raise exception 'The flock was placed on %. Choose a later date', to_char(f.placed_on, 'DD Mon YYYY'); end if;
    update flocks set ended_on = v_d, end_note = v_note where id = f.id;
    update houses set birds_at_start = 0 where id = h.id;
    return jsonb_build_object('id', f.id, 'house', h.name);
  else
    raise exception 'Unknown flock record';
  end case;
end $$;
revoke execute on function public.rpc_flock(text, jsonb) from public, anon;
grant execute on function public.rpc_flock(text, jsonb) to authenticated, service_role;

-- =====================================================================
-- Read functions with the flocks (latest versions from migration 22)
-- =====================================================================

create or replace function public.activity(p_limit int default 60, p_before timestamptz default null,
                                           p_loc text default null, p_kind text default null, p_cursor jsonb default null)
returns table (kind text, id bigint, d date, recorded_at timestamptz, by_name text, by_role public.staff_role,
               location_id text, voided boolean, data jsonb)
language plpgsql stable security invoker set search_path = public as $$
declare c_d date := (p_cursor->>'d')::date; c_at timestamptz := (p_cursor->>'at')::timestamptz;
        c_k text := p_cursor->>'k'; c_id bigint := (p_cursor->>'id')::bigint;
begin
  perform _me_json();
  return query
  with a as (
    select 'collect'::text k, x.id, x.d, x.recorded_at, x.recorded_by, 'FARM'::text loc, x.voided_at is not null v, to_jsonb(x) j from egg_collections x
    union all select 'mort', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null, to_jsonb(x) from mortality x
    union all select 'feed', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null, to_jsonb(x) from feed_moves x
               where not exists (select 1 from mill_batches b where b.feed_move_id = x.id)   -- milled feed shows as the milling
    union all select 'water', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null, to_jsonb(x) from water_logs x
    union all select 'med', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null,
                     to_jsonb(x) || jsonb_build_object('medicine', m.name, 'unit', m.unit) from med_moves x join medicines m on m.id = x.medicine_id
    union all select 'xfer', x.id, x.d, x.recorded_at, x.recorded_by, x.from_loc, x.voided_at is not null, to_jsonb(x) from transfers x
    union all select 'sale', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from sales x
    union all select 'brk', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from breakages x
    union all select 'count', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from stock_counts x
    union all select 'issue', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from stock_adj x
    union all select 'money', x.id, x.d, x.recorded_at, x.recorded_by, null, x.voided_at is not null, to_jsonb(x) from money_moves x
    union all select 'cash', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from cash_counts x
    union all select 'credit', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from credit_payments x
    union all select 'supply', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null,
                     to_jsonb(x) || jsonb_build_object('item', i.name, 'unit', i.unit) from supply_moves x join supplies i on i.id = x.supply_id
    union all select 'confirm', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null,
                     to_jsonb(x) || coalesce((select jsonb_build_object('house', f.house, 'what', 'feed', 'unit', 'kg') from feed_moves f where x.kind = 'feed' and f.id = x.move_id),
                                             (select jsonb_build_object('house', mm.house, 'what', md.name, 'unit', md.unit) from med_moves mm join medicines md on md.id = mm.medicine_id
                                               where x.kind = 'med' and mm.id = x.move_id), '{}'::jsonb)
      from issue_confirms x
    union all select 'raw', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null,
                     to_jsonb(x) || jsonb_build_object('material', m.name, 'bag_kg', m.bag_kg) from raw_moves x join raw_materials m on m.id = x.material_id
               where x.kind <> 'mill'                                                   -- what milling used is in the milling record
    union all select 'flock', x.id, x.placed_on, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null,
                     to_jsonb(x) || jsonb_build_object('house', h.name) from flocks x join houses h on h.id = x.house_id
               where x.recorded_by is not null                                         -- not the flocks carried over from the house list
    union all select 'mill', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null,
                     to_jsonb(x) || jsonb_build_object('bags', (select f.bags from feed_moves f where f.id = x.feed_move_id)) from mill_batches x
  )
  select a.k, a.id, a.d, a.recorded_at, s.display_name, s.role, a.loc, a.v, a.j
    from a left join staff s on s.id = a.recorded_by
   where (p_before is null or a.recorded_at < p_before)
     and (p_cursor is null or (a.d, a.recorded_at, a.k, a.id) < (c_d, c_at, c_k, c_id))
     and (p_kind is null or a.k = p_kind)
     and (p_loc is null or a.loc = p_loc
          or (a.k = 'xfer' and a.j->>'to_loc' = p_loc)
          or (a.k = 'money' and (a.j->>'from_acc' = 'CASH:' || p_loc or a.j->>'to_acc' = 'CASH:' || p_loc)))
   order by a.d desc, a.recorded_at desc, a.k desc, a.id desc
   limit least(greatest(p_limit, 1), 500);
end $$;
revoke execute on function public.activity(int, timestamptz, text, text, jsonb) from public, anon;
grant execute on function public.activity(int, timestamptz, text, text, jsonb) to authenticated, service_role;

create or replace function public.dashboard(p_days int default 45)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare t date := biz_today(); f date := biz_today() - greatest(least(p_days, 400), 7); r jsonb; v_me jsonb;
begin
  v_me := _me_json();  -- raises AUTH_* unless this session is fully signed in
  select jsonb_build_object(
    'today', t, 'from', f, 'server_time', now(), 'version', (select last_value from data_change_seq),
    'me', v_me,
    'settings', (select to_jsonb(s) - 'push_url' from settings s where id = 1),
    'locations', (select coalesce(jsonb_agg(to_jsonb(l) order by l.sort), '[]') from locations l),
    'accounts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.sort), '[]') from accounts a),
    'houses', (select coalesce(jsonb_agg(to_jsonb(h) order by h.sort), '[]') from houses h where h.active),
    'medicines', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'category', m.category, 'unit', m.unit, 'reorder', m.reorder,
                         'active', m.active, 'stock', coalesce(v.qty, 0)) order by m.category, m.name), '[]')
                    from medicines m left join v_med_stock v on v.medicine_id = m.id where can_farm()),
    'schedule', (select coalesce(jsonb_agg(to_jsonb(x) order by x.due), '[]') from schedule x where not x.cancelled and (x.due >= t - 14 or not x.done)),
    'staff', _staff_list(),
    'stock', (select coalesce(jsonb_agg(to_jsonb(v)), '[]') from v_stock v),
    'stock_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select location_id, d, kind, sum(n)::int n, sum(b)::int b, sum(c)::int c, sum(j)::int j from v_stock_moves where d >= f group by 1, 2, 3) x),
    'balances', (select coalesce(jsonb_agg(to_jsonb(v)), '[]') from v_balances v),
    'money_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select account_id, d, kind, sum(amount) amount from v_money_lines where d >= f group by 1, 2, 3) x),
    'sales_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select location_id, d, count(*)::int cnt, sum(value) value, sum(coalesce(list_value, value)) list_value,
               sum(cash) cash, sum(till) till, sum(paybill) paybill, sum(credit) credit,
               sum(n)::int n, sum(b)::int b, sum(c)::int c, sum(j)::int j, bool_or(imported) imported
          from sales where voided_at is null and d >= f group by 1, 2) x),
    'breakage_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select location_id, d, transit, sum(qty)::int qty from breakages where voided_at is null and d >= f group by 1, 2, 3) x),
    'received_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select to_loc location_id, received_d d, sum(sent_n + sent_b + sent_c + sent_j)::int sent, sum(recv_n + coalesce(recv_b,0) + recv_c + recv_j)::int recv
          from transfers where voided_at is null and status = 'received' and received_d >= f group by 1, 2) x),
    'farm_daily', case when can_farm() or is_mgmt() then (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from farm_daily2(f, t) x) else '[]'::jsonb end,
    'feed_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select d, kind, sum(kg) kg from v_feed_lines where d >= f group by 1, 2) x),
    'feed_stock', (select coalesce(sum(kg), 0) from v_feed_lines),
    'water_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select d, house_id, sum(litres) litres from water_logs where kind = 'intake' and voided_at is null and d >= f group by 1, 2) x),
    -- litres: the level now (last reading less water drunk since); reading: what the tank showed
    'tank', (select jsonb_build_object('litres', greatest(x.litres - x.drunk, 0), 'reading', x.litres, 'drunk_since', x.drunk,
                                       'recorded_at', x.recorded_at, 'd', x.d)
               from (select r.litres, r.recorded_at, r.d,
                            coalesce((select sum(w.litres) from water_logs w
                                       where w.kind = 'intake' and w.voided_at is null
                                         and (w.d > r.d or (w.d = r.d and w.recorded_at > r.recorded_at))), 0) drunk
                       from (select litres, recorded_at, d from water_logs where kind = 'tank' and voided_at is null
                              order by d desc, recorded_at desc, id desc limit 1) r) x),
    'tank_daily', (select coalesce(jsonb_agg(to_jsonb(x) order by x.d), '[]') from (
        select distinct on (d) d, litres from water_logs where kind = 'tank' and voided_at is null and d >= f order by d, recorded_at desc, id desc) x),
    'transit', (select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at), '[]') from transfers x where status = 'in_transit' and voided_at is null),
    'counts_today', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from stock_counts x where d = t and voided_at is null),
    'cash_counts_today', (select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at), '[]') from cash_counts x where d = t and voided_at is null),
    -- who still owes, by outlet and customer (the outlet's own only, for the person on duty)
    'credits', (select coalesce(jsonb_agg(to_jsonb(x) order by x.owed desc, x.customer), '[]') from (
        select o.location_id, (array_agg(o.customer order by o.d desc, o.id desc))[1] customer, sum(o.owed) owed,
               min(o.d) since, count(*)::int sales,
               (select max(p.d) from credit_payments p where p.voided_at is null and p.location_id = o.location_id
                   and lower(trim(p.customer)) = o.ckey) last_paid
          from (select s.id, s.d, s.location_id, s.customer, lower(trim(s.customer)) ckey,
                       s.credit - coalesce((select sum(p.amount) from credit_payments p where p.sale_id = s.id and p.voided_at is null), 0) owed
                  from sales s where s.voided_at is null and s.credit > 0) o
         where o.owed > 0
         group by o.location_id, o.ckey) x),
    -- the farm store: other supplies, and issues waiting for the production clerk
    'supplies', case when can_farm() then (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'category', x.category, 'unit', x.unit,
                         'reorder', x.reorder, 'active', x.active, 'stock', coalesce(v.qty, 0)) order by x.category, x.name), '[]')
                    from supplies x left join v_supply_stock v on v.supply_id = x.id) else '[]'::jsonb end,
    'store_pending', case when can_farm() then (select coalesce(jsonb_agg(to_jsonb(q) order by q.recorded_at), '[]') from (
        select 'feed' kind, f.id, f.d, f.recorded_at, f.house, f.house_id, 'Feed' what, f.kg qty, 'kg' unit, s.display_name by_name
          from feed_moves f left join staff s on s.id = f.recorded_by
         where f.need_confirm and f.voided_at is null and not exists (select 1 from issue_confirms c where c.kind = 'feed' and c.move_id = f.id and c.voided_at is null)
        union all
        select 'med', x.id, x.d, x.recorded_at, x.house, x.house_id, m.name, x.qty, m.unit, s.display_name
          from med_moves x join medicines m on m.id = x.medicine_id left join staff s on s.id = x.recorded_by
         where x.need_confirm and x.voided_at is null and not exists (select 1 from issue_confirms c where c.kind = 'med' and c.move_id = x.id and c.voided_at is null)) q)
      else '[]'::jsonb end,
    -- the feed mill: raw materials with the recipe and what is in the store, and the tonnes milled each day
    'raw', case when can_farm() then (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'per_tonne', m.per_tonne, 'bag_kg', m.bag_kg,
                         'active', m.active, 'sort', m.sort, 'stock', coalesce(v.kg, 0)) order by m.sort, m.id), '[]')
                    from raw_materials m left join v_raw_stock v on v.material_id = m.id) else '[]'::jsonb end,
    'mill_daily', case when can_farm() then (select coalesce(jsonb_agg(to_jsonb(x) order by x.d), '[]') from (
        select d, sum(tonnes) tonnes, count(*)::int batches from mill_batches where voided_at is null and d >= f group by d) x) else '[]'::jsonb end,
    -- every flock, the one in each house now and the earlier ones
    'flocks', case when can_farm() then (select coalesce(jsonb_agg(to_jsonb(x) - 'voided_by' - 'void_reason' order by x.placed_on desc, x.id desc), '[]')
                from flocks x where x.voided_at is null) else '[]'::jsonb end,
    'notifications', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]') from (
        select n.*, exists (select 1 from notification_reads r where r.notification_id = n.id and r.staff_id = auth.uid()) as read
          from notifications n where n.created_at > now() - interval '14 days' order by n.created_at desc limit 50) x)
  ) into r;
  return r;
end $$;
revoke execute on function public.dashboard(int) from public, anon;
grant execute on function public.dashboard(int) to authenticated, service_role;
