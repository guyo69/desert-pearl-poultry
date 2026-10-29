-- ---------------------------------------------------------------------
-- 7. Reads
-- ---------------------------------------------------------------------
-- Names shown on the sign-in screen (no PINs, no contact details).
create or replace function public.staff_directory()
returns table (id uuid, display_name text, role public.staff_role, location_id text, location_name text)
language sql stable security definer set search_path = public as $$
  select s.id, s.display_name, s.role, s.location_id, l.name
    from staff s left join locations l on l.id = s.location_id
   where s.active
   order by array_position(array['owner','manager','clerk','pos']::staff_role[], s.role), l.sort nulls first, s.display_name
$$;

-- Everything a dashboard needs in one round trip. Runs with the caller's
-- permissions, so each role only receives what it is allowed to see.
create or replace function public.dashboard(p_days int default 45)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare t date := biz_today(); f date := biz_today() - greatest(least(p_days, 400), 7); r jsonb;
begin
  if not is_staff() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select jsonb_build_object(
    'today', t, 'from', f, 'server_time', now(),
    'me', (select to_jsonb(x) from (select id, display_name, role, location_id, must_change_pin from staff where id = auth.uid()) x),
    'settings', (select to_jsonb(s) from settings s where id = 1),
    'locations', (select coalesce(jsonb_agg(to_jsonb(l) order by l.sort), '[]') from locations l),
    'accounts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.sort), '[]') from accounts a),
    'houses', (select coalesce(jsonb_agg(to_jsonb(h) order by h.sort), '[]') from houses h where h.active),
    'medicines', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'unit', m.unit, 'reorder', m.reorder,
                         'active', m.active, 'stock', coalesce(v.qty, 0)) order by m.name), '[]')
                    from medicines m left join v_med_stock v on v.medicine_id = m.id where can_farm()),
    'schedule', (select coalesce(jsonb_agg(to_jsonb(x) order by x.due), '[]') from schedule x where not x.cancelled and (x.due >= t - 14 or not x.done)),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'display_name', display_name, 'role', role, 'location_id', location_id,
                 'active', active, 'must_change_pin', case when is_mgmt() then must_change_pin end,
                 'locked', case when is_mgmt() then coalesce(locked_until > now(), false) end) order by display_name), '[]') from staff),
    'stock', (select coalesce(jsonb_agg(to_jsonb(v)), '[]') from v_stock v),
    'stock_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select location_id, d, kind, sum(n)::int n, sum(c)::int c, sum(j)::int j from v_stock_moves where d >= f group by 1, 2, 3) x),
    'balances', (select coalesce(jsonb_agg(to_jsonb(v)), '[]') from v_balances v),
    'money_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select account_id, d, kind, sum(amount) amount from v_money_lines where d >= f group by 1, 2, 3) x),
    'sales_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select location_id, d, count(*)::int cnt, sum(value) value, sum(cash) cash, sum(till) till, sum(paybill) paybill,
               sum(n)::int n, sum(c)::int c, sum(j)::int j
          from sales where voided_at is null and d >= f group by 1, 2) x),
    'breakage_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select location_id, d, transit, sum(qty)::int qty from breakages where voided_at is null and d >= f group by 1, 2, 3) x),
    'received_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select to_loc location_id, received_d d, sum(sent_n + sent_c + sent_j)::int sent, sum(recv_n + recv_c + recv_j)::int recv
          from transfers where voided_at is null and status = 'received' and received_d >= f group by 1, 2) x),
    'farm_daily', case when can_farm() or is_mgmt() then (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from farm_daily(f, t) x) else '[]'::jsonb end,
    'feed_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select d, kind, sum(kg) kg from v_feed_lines where d >= f group by 1, 2) x),
    'feed_stock', (select coalesce(sum(kg), 0) from v_feed_lines),
    'water_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select d, house_id, sum(litres) litres from water_logs where kind = 'intake' and voided_at is null and d >= f group by 1, 2) x),
    'tank', (select to_jsonb(x) from (select litres, recorded_at, d from water_logs where kind = 'tank' and voided_at is null
                                       order by recorded_at desc, id desc limit 1) x),
    'tank_daily', (select coalesce(jsonb_agg(to_jsonb(x) order by x.d), '[]') from (
        select distinct on (d) d, litres from water_logs where kind = 'tank' and voided_at is null and d >= f order by d, recorded_at desc, id desc) x),
    'transit', (select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at), '[]') from transfers x where status = 'in_transit' and voided_at is null),
    'counts_today', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from stock_counts x where d = t and voided_at is null),
    'cash_counts_today', (select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at), '[]') from cash_counts x where d = t and voided_at is null),
    'notifications', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]') from (
        select n.*, exists (select 1 from notification_reads r where r.notification_id = n.id and r.staff_id = auth.uid()) as read
          from notifications n where n.created_at > now() - interval '14 days' order by n.created_at desc limit 50) x)
  ) into r;
  return r;
end $$;

-- Activity feed: every record, newest first.
create or replace function public.activity(p_limit int default 60, p_before timestamptz default null,
                                           p_loc text default null, p_kind text default null)
returns table (kind text, id bigint, d date, recorded_at timestamptz, by_name text, by_role public.staff_role,
               location_id text, voided boolean, data jsonb)
language sql stable security invoker set search_path = public as $$
  with a as (
    select 'collect'::text k, x.id, x.d, x.recorded_at, x.recorded_by, 'FARM'::text loc, x.voided_at is not null v, to_jsonb(x) j from egg_collections x
    union all select 'mort', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null, to_jsonb(x) from mortality x
    union all select 'feed', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null, to_jsonb(x) from feed_moves x
    union all select 'water', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null, to_jsonb(x) from water_logs x
    union all select 'med', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null,
                     to_jsonb(x) || jsonb_build_object('medicine', m.name, 'unit', m.unit) from med_moves x join medicines m on m.id = x.medicine_id
    union all select 'xfer', x.id, x.d, x.recorded_at, x.recorded_by, x.from_loc, x.voided_at is not null, to_jsonb(x) from transfers x
    union all select 'sale', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from sales x
    union all select 'brk', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from breakages x
    union all select 'count', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from stock_counts x
    union all select 'money', x.id, x.d, x.recorded_at, x.recorded_by, null, x.voided_at is not null, to_jsonb(x) from money_moves x
    union all select 'cash', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from cash_counts x
  )
  select a.k, a.id, a.d, a.recorded_at, s.display_name, s.role, a.loc, a.v, a.j
    from a left join staff s on s.id = a.recorded_by
   where (p_before is null or a.recorded_at < p_before)
     and (p_kind is null or a.k = p_kind)
     and (p_loc is null or a.loc = p_loc
          or (a.k = 'xfer' and a.j->>'to_loc' = p_loc)
          or (a.k = 'money' and (a.j->>'from_acc' = 'CASH:' || p_loc or a.j->>'to_acc' = 'CASH:' || p_loc)))
   order by a.recorded_at desc, a.id desc
   limit least(greatest(p_limit, 1), 500)
$$;

-- ---------------------------------------------------------------------
-- 8. Morning checks (run daily by pg_cron at 06:00 Nairobi)
-- ---------------------------------------------------------------------
create or replace function public.daily_checks() returns int
language plpgsql security definer set search_path = public as $$
declare st settings; y date := biz_today() - 1; h record; v_y numeric; v_avg numeric; v_days int; v_feed numeric; v_water numeric;
        v_cnt int := 0; v_lvl numeric; l record; m record; r3 numeric; r7 numeric;
begin
  select * into st from settings where id = 1;
  if st.go_live is null then return 0; end if;
  for h in select * from houses where active and birds_at_start > 0 loop
    -- water intake drop
    select coalesce(sum(litres), 0) into v_y from water_logs where kind = 'intake' and voided_at is null and house_id = h.id and d = y;
    select avg(t), count(*) into v_avg, v_days from (
      select sum(litres) t from water_logs where kind = 'intake' and voided_at is null and house_id = h.id and d between y - 7 and y - 1 group by d) q;
    if v_days >= 3 and v_y = 0 then
      perform _notify('amber', format('No water intake recorded for %s yesterday', h.name), 'Record the litres the birds drank so problems can be spotted early.',
                      array['manager','clerk']::staff_role[], 'FARM', 'water'); v_cnt := v_cnt + 1;
    elsif v_days >= 3 and v_y < v_avg * (1 - st.water_drop_pct / 100) then
      perform _notify('orange', format('%s drank %s%% less water yesterday', h.name, round((1 - v_y / v_avg) * 100)),
        format('%s L against a 7-day average of %s L. A drop in water intake is often the first sign of disease or a blocked line.', round(v_y), round(v_avg)),
        array['owner','manager','clerk']::staff_role[], 'FARM', 'water'); v_cnt := v_cnt + 1;
    end if;
    -- lay rate drop: last 3 days vs the 7 days before
    select sum(n + c + j)::numeric / nullif(sum(hens), 0) into r3 from farm_daily(y - 2, y) where house_id = h.id;
    select sum(n + c + j)::numeric / nullif(sum(hens), 0) into r7 from farm_daily(y - 9, y - 3) where house_id = h.id;
    if r3 is not null and r7 is not null and (r7 - r3) * 100 > st.lay_drop_pts then
      perform _notify('orange', format('%s lay rate down %s points', h.name, round((r7 - r3) * 100, 1)),
        format('Last 3 days %s%% against %s%% the week before. Check water, feed intake and signs of disease.', round(r3 * 100, 1), round(r7 * 100, 1)),
        array['owner','manager']::staff_role[], 'FARM', 'production'); v_cnt := v_cnt + 1;
    end if;
  end loop;
  -- water : feed ratio for the whole farm
  select coalesce(sum(kg), 0) into v_feed from feed_moves where kind = 'use' and voided_at is null and d = y;
  select coalesce(sum(litres), 0) into v_water from water_logs where kind = 'intake' and voided_at is null and d = y;
  if v_feed > 0 and v_water > 0 and (v_water / v_feed < st.water_ratio_min or v_water / v_feed > st.water_ratio_max) then
    perform _notify('amber', format('Water to feed ratio %s : 1 yesterday', round(v_water / v_feed, 2)),
      format('%s L water for %s kg feed. Normal range is %s to %s.', round(v_water), round(v_feed), st.water_ratio_min, st.water_ratio_max),
      array['owner','manager']::staff_role[], 'FARM', 'water'); v_cnt := v_cnt + 1;
  end if;
  -- feed and tank reminders when Low or worse
  v_lvl := _feed_stock() / st.feed_buffer_kg;
  if band_rank(buffer_band(v_lvl)) >= 4 then
    perform _notify(band_sev(buffer_band(v_lvl)), format('Feed still %s (%s%%)', band_label(buffer_band(v_lvl)), round(v_lvl * 100)),
      format('Order %s bags today.', ceil(greatest(st.feed_buffer_kg - _feed_stock(), 0) / st.bag_kg)), array['owner','manager']::staff_role[], 'FARM', 'feed'); v_cnt := v_cnt + 1;
  end if;
  v_lvl := _tank() / st.tank_capacity_l;
  if v_lvl is not null and band_rank(buffer_band(v_lvl)) >= 4 then
    perform _notify(band_sev(buffer_band(v_lvl)), format('Water tank %s%% full', round(v_lvl * 100)), 'Refill the tank and record the new level.',
      array['manager','clerk']::staff_role[], 'FARM', 'water'); v_cnt := v_cnt + 1;
  end if;
  -- vaccinations and treatments due in the next 2 days
  for m in select * from schedule where not done and not cancelled and due between biz_today() and biz_today() + 2 loop
    perform _notify('info', format('%s due %s', m.task, case when m.due = biz_today() then 'today' else to_char(m.due, 'Dy DD Mon') end), m.house,
                    array['manager','clerk']::staff_role[], 'FARM', 'schedule'); v_cnt := v_cnt + 1;
  end loop;
  -- medicines below reorder level (Mondays only, to avoid repeating daily)
  if extract(isodow from biz_today()) = 1 then
    for m in select md.name, md.unit, md.reorder, v.qty from medicines md join v_med_stock v on v.medicine_id = md.id
              where md.active and v.qty <= md.reorder loop
      perform _notify('amber', format('%s below reorder level', m.name), format('%s %s left.', m.qty, m.unit),
                      array['manager','clerk']::staff_role[], 'FARM', 'medicine'); v_cnt := v_cnt + 1;
    end loop;
  end if;
  -- unbanked cash
  for l in select a.location_id, a.id, _balance(a.id) bal from accounts a where a.kind = 'cash' loop
    if l.bal > st.unbanked_max then
      perform _notify('amber', format('%s cash unbanked at %s', _kes(l.bal), _loc_short(l.location_id)),
                      format('Above the %s limit. Bank it or move it to Paybill.', _kes(st.unbanked_max)),
                      array['owner','pos']::staff_role[], l.location_id, 'cash'); v_cnt := v_cnt + 1;
    end if;
  end loop;
  return v_cnt;
end $$;

-- ---------------------------------------------------------------------
-- 9. Row level security
-- ---------------------------------------------------------------------
alter table public.locations          enable row level security;
alter table public.accounts           enable row level security;
alter table public.staff              enable row level security;
alter table public.settings           enable row level security;
alter table public.houses             enable row level security;
alter table public.medicines          enable row level security;
alter table public.schedule           enable row level security;
alter table public.egg_collections    enable row level security;
alter table public.mortality          enable row level security;
alter table public.feed_moves         enable row level security;
alter table public.water_logs         enable row level security;
alter table public.med_moves          enable row level security;
alter table public.transfers          enable row level security;
alter table public.sales              enable row level security;
alter table public.breakages          enable row level security;
alter table public.stock_counts       enable row level security;
alter table public.money_moves        enable row level security;
alter table public.cash_counts        enable row level security;
alter table public.notifications      enable row level security;
alter table public.notification_reads enable row level security;
alter table public.push_subscriptions enable row level security;

-- reference data: any active staff member
create policy read_ref on public.locations for select to authenticated using ((select is_staff()));
create policy read_ref on public.accounts  for select to authenticated using ((select is_staff()));
create policy read_ref on public.staff     for select to authenticated using ((select is_staff()));
create policy read_ref on public.settings  for select to authenticated using ((select is_staff()));
create policy read_ref on public.houses    for select to authenticated using ((select is_staff()));
create policy read_ref on public.medicines for select to authenticated using ((select is_staff()));
create policy read_ref on public.schedule  for select to authenticated using ((select can_farm()));

-- farm production: owner, manager, clerk, farm counter
create policy read_farm on public.egg_collections for select to authenticated using ((select can_farm()));
create policy read_farm on public.mortality       for select to authenticated using ((select can_farm()));
create policy read_farm on public.feed_moves      for select to authenticated using ((select can_farm()));
create policy read_farm on public.water_logs      for select to authenticated using ((select can_farm()));
create policy read_farm on public.med_moves       for select to authenticated using ((select can_farm()));

-- sales points: management sees all; staff see their own location; clerk sees the farm
create policy read_loc on public.transfers for select to authenticated using (
  (select is_mgmt()) or (select me_role()) = 'clerk' or from_loc = (select me_loc()) or to_loc = (select me_loc()));
create policy read_loc on public.sales        for select to authenticated using ((select is_mgmt()) or location_id = (select me_loc()));
create policy read_loc on public.breakages    for select to authenticated using ((select is_mgmt()) or location_id = (select me_loc()));
create policy read_loc on public.stock_counts for select to authenticated using ((select is_mgmt()) or location_id = (select me_loc()));
create policy read_loc on public.cash_counts  for select to authenticated using ((select is_mgmt()) or location_id = (select me_loc()));
create policy read_loc on public.money_moves  for select to authenticated using (
  (select is_mgmt()) or recorded_by = auth.uid()
  or from_acc = 'CASH:' || (select me_loc()) or to_acc = 'CASH:' || (select me_loc()));

create policy read_own on public.notifications for select to authenticated using (
  (select me_role()) = any (to_roles) and (location_id is null or (select is_mgmt()) or location_id = (select me_loc())
                                           or (select me_role()) = 'clerk'));
create policy read_own on public.notification_reads for select to authenticated using (staff_id = auth.uid());
create policy read_own on public.push_subscriptions for select to authenticated using (staff_id = auth.uid());

-- ---------------------------------------------------------------------
-- 10. Privileges: tables are read-only to the app; writes go through rpc_*
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to authenticated;
revoke execute on function
  public._require(public.staff_role[]), public._check_loc(public.staff, text), public._stock(text), public._balance(text),
  public._feed_stock(), public._tank(), public._lock(text), public._price(int, int, int),
  public._notify(text, text, text, public.staff_role[], text, text), public._loc_short(text), public._acc_name(text),
  public._check_acc(public.staff, text), public._spend(public.staff, text, numeric, text, text),
  public._do_stock_count(public.staff, text, text, int, int, int), public._do_cash_count(public.staff, text, numeric),
  public.daily_checks()
from authenticated;
grant execute on function public.staff_directory() to anon;
grant execute on all functions in schema public to service_role;
grant all on all tables in schema public to service_role;

-- ---------------------------------------------------------------------
-- 11. Realtime + schedule (Supabase only; skipped elsewhere)
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.egg_collections, public.mortality, public.feed_moves, public.water_logs,
      public.med_moves, public.transfers, public.sales, public.breakages, public.stock_counts, public.money_moves,
      public.cash_counts, public.notifications, public.settings, public.houses, public.medicines, public.schedule;
  end if;
end $$;

do $$ begin
  create extension if not exists pg_cron;
  perform cron.schedule('dpv-daily-checks', '0 3 * * *', 'select public.daily_checks()');   -- 03:00 UTC = 06:00 Nairobi
exception when others then
  raise notice 'pg_cron not available (%). Enable it in Supabase and schedule public.daily_checks() daily.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 12. Reference data
-- ---------------------------------------------------------------------
insert into public.locations (id, name, short, kind, sort) values
  ('FARM',  'Central Farm',            'Farm',         'farm', 1),
  ('VAN',   'Mobile Van Unit',         'Van',          'van',  2),
  ('TUALA', 'Tuala Egg Shop',          'Tuala',        'shop', 3),
  ('RAYAN', 'Rayan Fedha',             'Rayan Fedha',  'shop', 4),
  ('LUCKY', 'Abdihakim Lucky Summer',  'Lucky Summer', 'shop', 5);

insert into public.accounts (id, name, kind, location_id, sort) values
  ('CASH:FARM',  'Cash · Farm',         'cash', 'FARM',  1),
  ('CASH:VAN',   'Cash · Van',          'cash', 'VAN',   2),
  ('CASH:TUALA', 'Cash · Tuala',        'cash', 'TUALA', 3),
  ('CASH:RAYAN', 'Cash · Rayan Fedha',  'cash', 'RAYAN', 4),
  ('CASH:LUCKY', 'Cash · Lucky Summer', 'cash', 'LUCKY', 5),
  ('TILL',       'M-Pesa Till',         'till', null,    6),
  ('PAYBILL',    'M-Pesa Paybill',      'paybill', null, 7),
  ('BANK',       'Bank',                'bank', null,    8);

insert into public.settings (id) values (1);

insert into public.houses (id, name, birds_at_start, expected_lay, sort) values
  ('A', 'House A', 0, 0.90, 1),
  ('B', 'House B', 0, 0.80, 2);

insert into public.medicines (name, unit, reorder) values
  ('Newcastle vaccine (LaSota)', 'doses', 400),
  ('Dewormer (Piperazine)', 'sachets', 3),
  ('Multivitamin + electrolytes', 'g', 250),
  ('Oxytetracycline 20%', 'g', 200);
