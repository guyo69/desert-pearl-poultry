-- =====================================================================
-- 1 Nov 2026: egg grades, daily sheets, issuing stock, back-dating,
-- feed buffer in bags, change tracking for lighter refreshes, backups.
--
--  * A fifth egg grade, "big" (b), with its own tray and loose price.
--    Grades now: normal (n), big (b), jumbo / double yolk (j),
--    cracked sellable (c). Damaged / broken eggs are recorded separately
--    (at collection, on arrival, at the shop) and always written off.
--  * stock_adj: eggs issued out of an outlet to someone outside the app's
--    outlets (customer on credit, bulk buyer, ...) or received from outside.
--  * Daily sheets that mirror the paper books: the farm's house sheet and
--    each shop's daily stock sheet. The owner and farm manager can enter
--    a missed day (up to 62 days back); everyone else records today.
--  * Sales can be recorded at the agreed price (list price stays recorded).
--  * Records imported from the paper books are flagged (imported); their
--    money is kept out of account balances, which start at go-live.
--  * The feed buffer is set in bags (315 bags = one week).
--  * data_version(): a counter bumped by every write, so phones refresh
--    the dashboard only when something changed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Change counter
-- ---------------------------------------------------------------------
create sequence if not exists public.data_change_seq;
revoke all on sequence public.data_change_seq from public, anon, authenticated;
grant select on sequence public.data_change_seq to authenticated;  -- read the counter, never move it

create or replace function public._bump() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform nextval('public.data_change_seq');
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['egg_collections','mortality','feed_moves','water_logs','med_moves','transfers','sales','breakages',
                           'stock_counts','money_moves','cash_counts','notifications','notification_reads','settings','houses',
                           'medicines','schedule','staff','locations','accounts'] loop
    execute format('create trigger zz_bump after insert or update or delete on public.%I for each statement execute function public._bump()', t);
  end loop;
end $$;

-- a few bytes the phones ask for every minute; the full dashboard is fetched only when v moves
create or replace function public.data_version() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _me();  -- raises AUTH_* unless this session is fully signed in
  return jsonb_build_object('v', (select last_value from data_change_seq), 'day', biz_today());
end $$;

-- ---------------------------------------------------------------------
-- 1. Grades: big eggs everywhere stock moves; damaged recorded apart
-- ---------------------------------------------------------------------
alter table public.egg_collections add column if not exists b int not null default 0 check (b >= 0);
alter table public.egg_collections add column if not exists dmg int not null default 0 check (dmg >= 0);
alter table public.egg_collections drop constraint if exists egg_collections_check;
alter table public.egg_collections add constraint egg_collections_any check (n + b + c + j + dmg > 0);
comment on column public.egg_collections.dmg is 'Damaged / broken at collection: part of production, never enters stock';

alter table public.transfers add column if not exists sent_b int not null default 0 check (sent_b >= 0);
alter table public.transfers add column if not exists recv_b int;
alter table public.transfers add column if not exists recv_dmg int not null default 0 check (recv_dmg >= 0);
alter table public.transfers drop constraint if exists transfers_check1;
alter table public.transfers drop constraint if exists transfers_check2;
alter table public.transfers add constraint transfers_any check (sent_n + sent_b + sent_c + sent_j > 0);
alter table public.transfers add constraint transfers_recv check (status = 'in_transit' or (
  recv_n between 0 and sent_n and coalesce(recv_b, 0) between 0 and sent_b and recv_c between 0 and sent_c and recv_j between 0 and sent_j));

alter table public.sales add column if not exists b int not null default 0 check (b >= 0);
alter table public.sales add column if not exists list_value numeric;
alter table public.sales add column if not exists imported boolean not null default false;
alter table public.sales drop constraint if exists sales_check;
alter table public.sales add constraint sales_any check (n + b + c + j > 0);
comment on column public.sales.list_value is 'Value at list prices; value is what was agreed and paid';

alter table public.stock_counts add column if not exists cnt_b int not null default 0 check (cnt_b >= 0);
alter table public.stock_counts add column if not exists adj_b int not null default 0;

alter table public.breakages drop constraint if exists breakages_item_check;
alter table public.breakages add constraint breakages_item check (item in ('N','B','C','J'));

alter table public.settings add column if not exists tray_b numeric not null default 480 check (tray_b >= 0);
alter table public.settings add column if not exists pc_b numeric not null default 17 check (pc_b >= 0);
alter table public.settings add column if not exists feed_buffer_bags numeric not null default 315 check (feed_buffer_bags > 0);
update public.settings set feed_buffer_bags = 315, feed_buffer_kg = 315 * bag_kg where id = 1;

-- eggs issued to (or taken in from) people and places outside the app's outlets
create table if not exists public.stock_adj (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  location_id text not null references public.locations(id),
  kind text not null check (kind in ('in', 'out')),
  n int not null default 0 check (n >= 0), b int not null default 0 check (b >= 0),
  c int not null default 0 check (c >= 0), j int not null default 0 check (j >= 0),
  party text,
  note text,
  imported boolean not null default false,
  check (n + b + c + j > 0)
);
create index if not exists stock_adj_loc on public.stock_adj (location_id, d);
alter table public.stock_adj enable row level security;
create policy read_loc on public.stock_adj for select to authenticated using ((select is_mgmt()) or location_id = (select me_loc()));
revoke all on public.stock_adj from public, anon, authenticated;
grant select on public.stock_adj to authenticated;
grant all on public.stock_adj to service_role;
create trigger zz_bump after insert or update or delete on public.stock_adj for each statement execute function public._bump();

-- stock views: big eggs as a new last column; issued / taken-in stock
create or replace view public.v_stock_moves with (security_invoker = true) as
  select 'FARM'::text as location_id, d, 'coll'::text as kind, n, c, j, b
    from egg_collections where voided_at is null
  union all
  select from_loc, d, 'out', -sent_n, -sent_c, -sent_j, -sent_b
    from transfers where voided_at is null
  union all
  select to_loc, received_d, 'recv', recv_n, recv_c, recv_j, coalesce(recv_b, 0)
    from transfers where voided_at is null and status = 'received'
  union all
  select location_id, d, 'sold', -n, -c, -j, -b
    from sales where voided_at is null
  union all
  select location_id, d, 'brk',
         -(case when item = 'N' then qty else 0 end),
         -(case when item = 'C' then qty else 0 end),
         -(case when item = 'J' then qty else 0 end),
         -(case when item = 'B' then qty else 0 end)
    from breakages where voided_at is null and not transit
  union all
  select location_id, d, 'adj', adj_n, adj_c, adj_j, adj_b
    from stock_counts where voided_at is null
  union all
  select location_id, d, case kind when 'out' then 'issue' else 'adj' end,
         case kind when 'out' then -n else n end, case kind when 'out' then -c else c end,
         case kind when 'out' then -j else j end, case kind when 'out' then -b else b end
    from stock_adj where voided_at is null;

create or replace view public.v_stock with (security_invoker = true) as
  select l.id as location_id,
         coalesce(sum(m.n), 0)::int as n, coalesce(sum(m.c), 0)::int as c, coalesce(sum(m.j), 0)::int as j,
         coalesce(sum(m.b), 0)::int as b
    from locations l left join v_stock_moves m on m.location_id = l.id
   group by l.id;

-- money from imported paper-book sales is kept out of balances
create or replace view public.v_money_lines with (security_invoker = true) as
  select 'CASH:' || location_id as account_id, d, 'sale'::text as kind, cash as amount, location_id
    from sales where voided_at is null and cash <> 0 and not imported
  union all select 'TILL', d, 'sale', till, location_id from sales where voided_at is null and till <> 0 and not imported
  union all select 'PAYBILL', d, 'sale', paybill, location_id from sales where voided_at is null and paybill <> 0 and not imported
  union all
  select from_acc, d, case when kind = 'expense' then 'expense' else 'move_out' end, -amount, null
    from money_moves where voided_at is null and from_acc is not null
  union all
  select from_acc, d, 'fee', -fee, null
    from money_moves where voided_at is null and from_acc is not null and fee <> 0
  union all
  select to_acc, d, case kind when 'move' then 'move_in' else kind end, amount, null
    from money_moves where voided_at is null and to_acc is not null;

-- stock by grade at a location, now or at the end of a given day
create or replace function public._stock4(p_loc text, p_upto date default null,
                                          out n int, out b int, out c int, out j int)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(m.n), 0)::int, coalesce(sum(m.b), 0)::int, coalesce(sum(m.c), 0)::int, coalesce(sum(m.j), 0)::int
    from v_stock_moves m where m.location_id = p_loc and (p_upto is null or m.d <= p_upto)
$$;

create or replace function public._price4(p_n int, p_b int, p_c int, p_j int) returns numeric
language sql stable security definer set search_path = public as $$
  select round((p_n / 30) * tray_n + (p_n % 30) * pc_n
             + (p_b / 30) * tray_b + (p_b % 30) * pc_b
             + (p_c / 30) * tray_c + (p_c % 30) * pc_c
             + p_j * pc_j)
    from settings where id = 1
$$;

-- the date a record is for: today, or an earlier day for the owner / farm manager
create or replace function public._day(s public.staff, p_date date) returns date
language plpgsql stable security definer set search_path = public as $$
begin
  if p_date is null or p_date = biz_today() then return biz_today(); end if;
  if p_date > biz_today() then raise exception 'You cannot record for a future date'; end if;
  if s.role not in ('owner','manager') then raise exception 'Only the owner or farm manager can record for an earlier day'; end if;
  if p_date < biz_today() - 62 then raise exception 'Records can be added up to 62 days back'; end if;
  return p_date;
end $$;

create or replace function public._grades(p jsonb, out n int, out b int, out c int, out j int)
language plpgsql immutable set search_path = public as $$
begin
  n := coalesce((p->>'n')::int, 0); b := coalesce((p->>'b')::int, 0);
  c := coalesce((p->>'c')::int, 0); j := coalesce((p->>'j')::int, 0);
  if n < 0 or b < 0 or c < 0 or j < 0 then raise exception 'Egg numbers cannot be negative'; end if;
end $$;

create or replace function public._check_have(p_loc text, n int, b int, c int, j int, p_upto date default null) returns void
language plpgsql stable security definer set search_path = public as $$
declare st record;
begin
  st := _stock4(p_loc, p_upto);
  if n > st.n then raise exception 'Only % normal eggs in stock at %', _eggs(st.n), _loc_short(p_loc); end if;
  if b > st.b then raise exception 'Only % big eggs in stock at %', _eggs(st.b), _loc_short(p_loc); end if;
  if c > st.c then raise exception 'Only % cracked eggs in stock at %', st.c, _loc_short(p_loc); end if;
  if j > st.j then raise exception 'Only % jumbo eggs in stock at %', st.j, _loc_short(p_loc); end if;
end $$;

-- A record entered for an earlier day changes the book from that day on. If a
-- stock count was made after that day, the count already took the missing
-- record in as a variance, so the variance is reduced by the same amount: the
-- book after that count does not move, and nothing is counted twice.
create or replace function public._rebase(p_loc text, p_d date, dn int, db int, dc int, dj int, p_same_day_close boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_d >= biz_today() or (dn = 0 and db = 0 and dc = 0 and dj = 0) then return; end if;
  update stock_counts set adj_n = adj_n - dn, adj_b = adj_b - db, adj_c = adj_c - dc, adj_j = adj_j - dj
   where id = (select x.id from stock_counts x
                where x.location_id = p_loc and x.voided_at is null
                  and (x.d > p_d or (p_same_day_close and x.d = p_d and x.kind = 'close'))
                order by x.d, case x.kind when 'open' then 0 when 'opening_balance' then 0 else 1 end, x.recorded_at
                limit 1);
end $$;

-- ---------------------------------------------------------------------
-- 2. Prices and the feed buffer (in bags)
-- ---------------------------------------------------------------------
create or replace function public.rpc_save_settings(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner']::staff_role[]);
  update settings t set
    tray_n          = coalesce((p->>'tray_n')::numeric, t.tray_n),
    pc_n            = coalesce((p->>'pc_n')::numeric, t.pc_n),
    tray_b          = coalesce((p->>'tray_b')::numeric, t.tray_b),
    pc_b            = coalesce((p->>'pc_b')::numeric, t.pc_b),
    tray_c          = coalesce((p->>'tray_c')::numeric, t.tray_c),
    pc_c            = coalesce((p->>'pc_c')::numeric, t.pc_c),
    pc_j            = coalesce((p->>'pc_j')::numeric, t.pc_j),
    feed_buffer_bags= coalesce((p->>'feed_buffer_bags')::numeric, t.feed_buffer_bags),
    bag_kg          = coalesce((p->>'bag_kg')::numeric, t.bag_kg),
    bag_price       = coalesce((p->>'bag_price')::numeric, t.bag_price),
    tank_capacity_l = coalesce((p->>'tank_capacity_l')::numeric, t.tank_capacity_l),
    water_drop_pct  = coalesce((p->>'water_drop_pct')::numeric, t.water_drop_pct),
    water_ratio_min = coalesce((p->>'water_ratio_min')::numeric, t.water_ratio_min),
    water_ratio_max = coalesce((p->>'water_ratio_max')::numeric, t.water_ratio_max),
    cash_tol        = coalesce((p->>'cash_tol')::numeric, t.cash_tol),
    unbanked_max    = coalesce((p->>'unbanked_max')::numeric, t.unbanked_max),
    break_tol       = coalesce((p->>'break_tol')::numeric, t.break_tol),
    lay_drop_pts    = coalesce((p->>'lay_drop_pts')::numeric, t.lay_drop_pts),
    updated_at      = now()
  where id = 1;
  update settings set feed_buffer_kg = feed_buffer_bags * bag_kg where id = 1;   -- the buffer is kept in bags
end $$;

-- feed notices speak in bags, like the store book
create or replace function public.rpc_feed(p_kind text, p_kg numeric, p_house text default null, p_note text default null,
                                           p_bags numeric default null, p_cost numeric default null, p_paid_from text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; st settings; v_before numeric; v_after numeric; b0 text; b1 text; v_money bigint; v_notified boolean := false;
begin
  s := _require(array['owner','manager','clerk']::staff_role[]);
  select * into st from settings where id = 1;
  if p_kind not in ('in','use') then raise exception 'Unknown feed movement'; end if;
  if coalesce(p_kg, 0) <= 0 then raise exception 'Enter the kilograms of feed'; end if;
  perform _lock('feed');
  v_before := _feed_stock();
  if p_kind = 'use' and p_kg > v_before then raise exception 'Only % kg of feed is in store', trim_scale(round(v_before, 1)); end if;
  if p_kind = 'in' and p_paid_from is not null then
    if coalesce(p_cost, 0) <= 0 then raise exception 'Enter the cost to record the payment'; end if;
    v_money := _spend(s, p_paid_from, p_cost, 'Feed', coalesce(p_note, 'Feed purchase') ||
                      case when p_bags is not null then format(', %s bags', p_bags) else '' end);
  end if;
  insert into feed_moves (kind, kg, bags, cost, house, note, money_move_id, recorded_by)
  values (p_kind, p_kg, p_bags, p_cost, p_house, p_note, v_money, s.id);
  v_after := v_before + case when p_kind = 'in' then p_kg else -p_kg end;
  b0 := buffer_band(v_before / st.feed_buffer_kg);
  b1 := buffer_band(v_after / st.feed_buffer_kg);
  if band_rank(b1) > band_rank(b0) and band_rank(b1) >= 3 then
    v_notified := true;
    perform _notify(band_sev(b1),
      format('Feed buffer dropped to %s (%s%%)', band_label(b1), round(v_after / st.feed_buffer_kg * 100)),
      format('%s bags left of the %s-bag weekly buffer. Order %s bags to restore a full buffer.',
             round(v_after / st.bag_kg), round(st.feed_buffer_bags), ceil(greatest(st.feed_buffer_kg - v_after, 0) / st.bag_kg)),
      array['owner','manager','clerk']::staff_role[], 'FARM', 'feed');
  end if;
  return jsonb_build_object('stock', v_after, 'level', v_after / st.feed_buffer_kg, 'band', b1,
                            'band_label', band_label(b1), 'notified', v_notified);
end $$;

-- ---------------------------------------------------------------------
-- 3. Farm: collection by grade, and the daily house sheet
-- ---------------------------------------------------------------------
create or replace function public.rpc_collect_eggs(p_house text, p_n int, p_b int, p_j int, p_c int, p_dmg int, p_date date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_id bigint; v_d date;
begin
  s := _require(array['owner','manager','clerk']::staff_role[]);
  v_d := _day(s, p_date);
  if not exists (select 1 from houses where id = p_house and active) then raise exception 'Unknown house'; end if;
  p_n := coalesce(p_n,0); p_b := coalesce(p_b,0); p_j := coalesce(p_j,0); p_c := coalesce(p_c,0); p_dmg := coalesce(p_dmg,0);
  if least(p_n, p_b, p_j, p_c, p_dmg) < 0 then raise exception 'Egg numbers cannot be negative'; end if;
  if p_n + p_b + p_j + p_c + p_dmg = 0 then raise exception 'Enter the number of eggs collected'; end if;
  insert into egg_collections (d, house_id, n, b, j, c, dmg, recorded_by)
  values (v_d, p_house, p_n, p_b, p_j, p_c, p_dmg, s.id) returning id into v_id;
  perform _rebase('FARM', v_d, p_n, p_b, p_c, p_j);
  return jsonb_build_object('id', v_id, 'total', p_n + p_b + p_j + p_c + p_dmg);
end $$;

-- the farm book, one row per house:
-- [{house, n, b, j, c, dmg, deaths, cause, feed_kg, water_l}]
create or replace function public.rpc_house_day(p_date date, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_d date; r jsonb; v_house houses; e record; v_deaths int; v_feed numeric; v_water numeric;
        v_dmg int; v_saved int := 0; v_feed_total numeric := 0; st settings; v_before numeric; v_after numeric;
begin
  s := _require(array['owner','manager','clerk']::staff_role[]);
  v_d := _day(s, p_date);
  select * into st from settings where id = 1;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'Nothing to save'; end if;
  perform _lock('feed');
  v_before := _feed_stock();
  for r in select * from jsonb_array_elements(p_rows) loop
    select * into v_house from houses where id = r->>'house' and active;
    if v_house.id is null then raise exception 'Unknown house %', r->>'house'; end if;
    e := _grades(r);
    v_dmg := coalesce((r->>'dmg')::int, 0);
    v_deaths := coalesce((r->>'deaths')::int, 0);
    v_feed := coalesce((r->>'feed_kg')::numeric, 0);
    v_water := coalesce((r->>'water_l')::numeric, 0);
    if v_dmg < 0 or v_deaths < 0 or v_feed < 0 or v_water < 0 then raise exception 'Numbers cannot be negative'; end if;
    if e.n + e.b + e.j + e.c + v_dmg > 0 then
      insert into egg_collections (d, house_id, n, b, j, c, dmg, recorded_by) values (v_d, v_house.id, e.n, e.b, e.j, e.c, v_dmg, s.id);
      perform _rebase('FARM', v_d, e.n, e.b, e.c, e.j);
      v_saved := v_saved + 1;
    end if;
    if v_deaths > 0 then
      insert into mortality (d, house_id, birds, cause, recorded_by)
      values (v_d, v_house.id, v_deaths, coalesce(nullif(trim(r->>'cause'), ''), 'Unknown'), s.id);
      v_saved := v_saved + 1;
    end if;
    if v_feed > 0 then
      insert into feed_moves (d, kind, kg, house, note, recorded_by) values (v_d, 'use', v_feed, v_house.name, 'Daily sheet', s.id);
      v_feed_total := v_feed_total + v_feed;
      v_saved := v_saved + 1;
    end if;
    if v_water > 0 then
      insert into water_logs (d, kind, house_id, litres, note, recorded_by) values (v_d, 'intake', v_house.id, v_water, 'Daily sheet', s.id);
      v_saved := v_saved + 1;
    end if;
  end loop;
  if v_saved = 0 then raise exception 'Nothing to save'; end if;
  v_after := v_before - v_feed_total;
  if v_feed_total > 0 and v_after < 0 then
    perform _notify('red', 'Feed store book is below zero',
      format('%s kg of feed use is recorded but the store book shows %s kg. Record feed deliveries so the buffer is right.',
             round(v_feed_total), round(v_before)), array['owner','manager']::staff_role[], 'FARM', 'feed');
  elsif v_feed_total > 0 and band_rank(buffer_band(v_after / st.feed_buffer_kg)) > band_rank(buffer_band(v_before / st.feed_buffer_kg))
        and band_rank(buffer_band(v_after / st.feed_buffer_kg)) >= 3 then
    perform _notify(band_sev(buffer_band(v_after / st.feed_buffer_kg)),
      format('Feed buffer dropped to %s (%s%%)', band_label(buffer_band(v_after / st.feed_buffer_kg)), round(v_after / st.feed_buffer_kg * 100)),
      format('%s bags left of the %s-bag weekly buffer. Order %s bags to restore it.',
             round(v_after / st.bag_kg), round(st.feed_buffer_bags), ceil(greatest(st.feed_buffer_kg - v_after, 0) / st.bag_kg)),
      array['owner','manager','clerk']::staff_role[], 'FARM', 'feed');
  end if;
  return jsonb_build_object('saved', v_saved, 'date', v_d);
end $$;

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
    (h.birds_at_start - coalesce((select sum(m.birds) from mortality m
        where m.house_id = h.id and m.d >= h.start_date and m.d < g.day and m.voided_at is null), 0))::int
  from houses h
  cross join generate_series(p_from, p_to, interval '1 day') as g(day)
  where g.day::date >= h.start_date
$$;

-- ---------------------------------------------------------------------
-- 4. Moving stock: send (all grades), receive with damaged on arrival,
--    issue out / take in from outside the app's outlets
-- ---------------------------------------------------------------------
create or replace function public.rpc_dispatch_many(p_from text, p_items jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; it jsonb; v_to text; v_seen text[] := '{}'; e record;
        tn int := 0; tb int := 0; tc int := 0; tj int := 0; v_id bigint; v_ids bigint[] := '{}';
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  perform _check_loc(s, p_from);
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Enter what you are sending'; end if;
  if jsonb_array_length(p_items) > 10 then raise exception 'Too many destinations in one entry'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_to := it->>'to';
    if v_to is null or not exists (select 1 from locations where id = v_to) then raise exception 'Unknown destination'; end if;
    if v_to = p_from then raise exception 'Choose a different destination'; end if;
    if v_to = any (v_seen) then raise exception 'Each outlet can appear only once'; end if;
    v_seen := v_seen || v_to;
    e := _grades(it);
    tn := tn + e.n; tb := tb + e.b; tc := tc + e.c; tj := tj + e.j;
  end loop;
  if tn + tb + tc + tj = 0 then raise exception 'Enter what you are sending'; end if;
  perform _lock('stock:' || p_from);
  begin
    perform _check_have(p_from, tn, tb, tc, tj);
  exception when others then
    raise exception '% (sending % in total)', sqlerrm, _eggs(tn + tb + tc + tj);
  end;
  for it in select * from jsonb_array_elements(p_items) loop
    e := _grades(it);
    if e.n + e.b + e.c + e.j > 0 then
      insert into transfers (from_loc, to_loc, sent_n, sent_b, sent_c, sent_j, note, recorded_by)
      values (p_from, it->>'to', e.n, e.b, e.c, e.j, p_note, s.id) returning id into v_id;
      v_ids := v_ids || v_id;
      perform _notify('info', format('Delivery on the way from %s', _loc_short(p_from)),
                      format('%s sent. Confirm the count when it arrives.', _eggs(e.n + e.b + e.c + e.j)), array['pos']::staff_role[], it->>'to', 'transfer');
    end if;
  end loop;
  return jsonb_build_object('ids', to_jsonb(v_ids), 'outlets', cardinality(v_ids), 'n', tn, 'b', tb, 'c', tc, 'j', tj);
end $$;

-- p_dmg: eggs that arrived damaged (part of the shortfall); they are written off
create or replace function public.rpc_receive_delivery(p_transfer bigint, p_n int, p_b int, p_j int, p_c int, p_dmg int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; x transfers; v_short int; v_missing int;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  select * into x from transfers where id = p_transfer and voided_at is null for update;
  if x.id is null then raise exception 'Delivery not found'; end if;
  if x.status <> 'in_transit' then raise exception 'This delivery was already received'; end if;
  perform _check_loc(s, x.to_loc);
  p_n := coalesce(p_n, x.sent_n); p_b := coalesce(p_b, x.sent_b); p_j := coalesce(p_j, x.sent_j); p_c := coalesce(p_c, x.sent_c);
  p_dmg := coalesce(p_dmg, 0);
  if least(p_n, p_b, p_j, p_c, p_dmg) < 0 then raise exception 'Quantities cannot be negative'; end if;
  if p_n > x.sent_n or p_b > x.sent_b or p_c > x.sent_c or p_j > x.sent_j then raise exception 'You cannot receive more than was sent'; end if;
  v_short := (x.sent_n + x.sent_b + x.sent_c + x.sent_j) - (p_n + p_b + p_c + p_j);
  if p_dmg > v_short then raise exception 'Damaged eggs (%) are more than the eggs not received in good condition (%)', p_dmg, v_short; end if;
  v_missing := v_short - p_dmg;
  update transfers set status = 'received', received_at = now(), received_d = biz_today(), received_by = s.id,
                       recv_n = p_n, recv_b = p_b, recv_c = p_c, recv_j = p_j, recv_dmg = p_dmg where id = x.id;
  insert into breakages (location_id, item, qty, reason, transit, transfer_id, recorded_by)
  select x.to_loc, i.item, i.q,
         case when p_dmg = 0 then 'Missing on arrival' when v_missing = 0 then 'Damaged on arrival' else 'Damaged or missing on arrival' end,
         true, x.id, s.id
    from (values ('N', x.sent_n - p_n), ('B', x.sent_b - p_b), ('C', x.sent_c - p_c), ('J', x.sent_j - p_j)) as i(item, q)
   where i.q > 0;
  if v_short > 0 then
    perform _notify('amber', format('%s short on delivery to %s', _eggs(v_short), _loc_short(x.to_loc)),
                    format('Sent %s, received %s good: %s damaged, %s missing.', _eggs(x.sent_n + x.sent_b + x.sent_c + x.sent_j),
                           _eggs(p_n + p_b + p_c + p_j), p_dmg, v_missing),
                    array['owner','manager']::staff_role[], x.to_loc, 'transfer');
  end if;
  return jsonb_build_object('short', v_short, 'damaged', p_dmg, 'missing', v_missing);
end $$;

-- eggs leave the outlet to someone outside the app (customer on credit, bulk buyer, ...)
create or replace function public.rpc_issue_out(p_loc text, p_n int, p_b int, p_j int, p_c int, p_party text, p_note text default null,
                                                p_date date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_d date; v_id bigint;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  perform _check_loc(s, p_loc);
  v_d := _day(s, p_date);
  p_n := coalesce(p_n,0); p_b := coalesce(p_b,0); p_j := coalesce(p_j,0); p_c := coalesce(p_c,0);
  if least(p_n, p_b, p_j, p_c) < 0 then raise exception 'Egg numbers cannot be negative'; end if;
  if p_n + p_b + p_j + p_c = 0 then raise exception 'Enter the eggs issued'; end if;
  if coalesce(trim(p_party), '') = '' then raise exception 'Say who received the eggs'; end if;
  perform _lock('stock:' || p_loc);
  perform _check_have(p_loc, p_n, p_b, p_c, p_j, case when v_d < biz_today() then v_d end);
  insert into stock_adj (d, location_id, kind, n, b, c, j, party, note, recorded_by)
  values (v_d, p_loc, 'out', p_n, p_b, p_c, p_j, left(trim(p_party), 80), p_note, s.id) returning id into v_id;
  perform _rebase(p_loc, v_d, -p_n, -p_b, -p_c, -p_j);
  perform _notify('info', format('%s issued from %s', _eggs(p_n + p_b + p_j + p_c), _loc_short(p_loc)),
                  format('To %s%s.', trim(p_party), coalesce(': ' || p_note, '')), array['owner','manager']::staff_role[], p_loc, 'transfer');
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.rpc_breakage(p_loc text, p_item text, p_qty int, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; st record; v_have int;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  perform _check_loc(s, p_loc);
  if p_item not in ('N','B','C','J') then raise exception 'Choose the type of egg'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'Enter how many eggs were damaged'; end if;
  perform _lock('stock:' || p_loc);
  st := _stock4(p_loc);
  v_have := case p_item when 'N' then st.n when 'B' then st.b when 'C' then st.c else st.j end;
  if p_qty > v_have then raise exception 'Only % on hand', v_have; end if;
  insert into breakages (location_id, item, qty, reason, recorded_by) values (p_loc, p_item, p_qty, coalesce(p_reason, 'Damaged'), s.id);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- 5. Counting stock (all grades, optionally for an earlier day)
-- ---------------------------------------------------------------------
create or replace function public._do_count4(s public.staff, p_loc text, p_kind text, p_n int, p_b int, p_j int, p_c int, p_d date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare st record; a_n int; a_b int; a_c int; a_j int;
begin
  perform _check_loc(s, p_loc);
  if p_kind not in ('open','close','opening_balance') then raise exception 'Unknown count'; end if;
  p_n := coalesce(p_n,0); p_b := coalesce(p_b,0); p_j := coalesce(p_j,0); p_c := coalesce(p_c,0);
  if least(p_n, p_b, p_j, p_c) < 0 then raise exception 'Counts cannot be negative'; end if;
  perform _lock('stock:' || p_loc);
  -- the book as it stood when the count was made: now for a count made today; for an earlier day,
  -- an opening count comes before that day's movements and a closing count after them
  st := case when p_d >= biz_today() then _stock4(p_loc)
             else _stock4(p_loc, case when p_kind = 'open' then p_d - 1 else p_d end) end;
  a_n := p_n - st.n; a_b := p_b - st.b; a_c := p_c - st.c; a_j := p_j - st.j;
  perform _rebase(p_loc, p_d, a_n, a_b, a_c, a_j, p_kind = 'open');
  insert into stock_counts (d, location_id, kind, cnt_n, cnt_b, cnt_c, cnt_j, adj_n, adj_b, adj_c, adj_j, recorded_by)
  values (p_d, p_loc, p_kind, p_n, p_b, p_c, p_j, a_n, a_b, a_c, a_j, s.id);
  if p_kind <> 'opening_balance' and (a_n <> 0 or a_b <> 0 or a_c <> 0 or a_j <> 0) then
    perform _notify('amber', format('Stock count variance at %s', _loc_short(p_loc)),
      format('%s count%s differs from the book by %s%s pieces (normal %s, big %s, cracked %s, jumbo %s).',
             case p_kind when 'open' then 'Opening' else 'Closing' end,
             case when p_d < biz_today() then ' for ' || to_char(p_d, 'DD Mon') else '' end,
             case when a_n + a_b + a_c + a_j > 0 then '+' else '' end, a_n + a_b + a_c + a_j, a_n, a_b, a_c, a_j),
      array['owner','manager']::staff_role[], p_loc, 'count');
  end if;
  return jsonb_build_object('adj_n', a_n, 'adj_b', a_b, 'adj_c', a_c, 'adj_j', a_j,
                            'book_n', st.n, 'book_b', st.b, 'book_c', st.c, 'book_j', st.j);
end $$;

create or replace function public.rpc_count_stock(p_loc text, p_kind text, p_n int, p_b int, p_j int, p_c int, p_date date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  if p_kind = 'opening_balance' and s.role <> 'owner' then raise exception 'Only the owner sets opening balances'; end if;
  return _do_count4(s, p_loc, p_kind, p_n, p_b, p_j, p_c, _day(s, p_date));
end $$;

-- ---------------------------------------------------------------------
-- 6. Sales at list price or at the agreed price
-- ---------------------------------------------------------------------
create or replace function public.rpc_record_sale(p_loc text, p_n int, p_b int, p_j int, p_c int,
                                                  p_cash numeric, p_till numeric, p_paybill numeric,
                                                  p_customer text default null, p_value numeric default null, p_date date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_d date; v_list numeric; v_value numeric; v_id bigint;
begin
  s := _require(array['owner','manager','pos']::staff_role[]);
  perform _check_loc(s, p_loc);
  v_d := _day(s, p_date);
  p_n := coalesce(p_n,0); p_b := coalesce(p_b,0); p_j := coalesce(p_j,0); p_c := coalesce(p_c,0);
  p_cash := coalesce(p_cash,0); p_till := coalesce(p_till,0); p_paybill := coalesce(p_paybill,0);
  if least(p_n, p_b, p_j, p_c) < 0 or least(p_cash, p_till, p_paybill) < 0 then raise exception 'Numbers cannot be negative'; end if;
  if p_n + p_b + p_j + p_c = 0 then raise exception 'Enter the eggs sold'; end if;
  perform _lock('stock:' || p_loc);
  perform _check_have(p_loc, p_n, p_b, p_c, p_j, case when v_d < biz_today() then v_d end);
  v_list := _price4(p_n, p_b, p_c, p_j);
  v_value := coalesce(p_value, v_list);
  if v_value <= 0 then raise exception 'Enter the amount the customer paid'; end if;
  if p_cash + p_till + p_paybill <> v_value then
    raise exception 'Payments (%) must equal the amount due (%)', _kes(p_cash + p_till + p_paybill), _kes(v_value);
  end if;
  insert into sales (d, location_id, n, b, c, j, value, list_value, cash, till, paybill, customer, recorded_by)
  values (v_d, p_loc, p_n, p_b, p_c, p_j, v_value, v_list, p_cash, p_till, p_paybill, nullif(trim(p_customer), ''), s.id) returning id into v_id;
  perform _rebase(p_loc, v_d, -p_n, -p_b, -p_c, -p_j);
  return jsonb_build_object('id', v_id, 'value', v_value, 'list_value', v_list);
end $$;

-- ---------------------------------------------------------------------
-- 7. The shop's daily sheet (the paper book, one line per day)
--    p: {damaged:{n,b,c,j}, issued:{n,b,c,j,party,note}, sales:{n,b,c,j,cash,till,paybill,value},
--        closing:{n,b,c,j}, cash_counted}
-- ---------------------------------------------------------------------
create or replace function public.rpc_shop_day(p_loc text, p_date date, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_d date; e record; k text; r jsonb := '{}'::jsonb;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  perform _check_loc(s, p_loc);
  v_d := _day(s, p_date);
  if p ? 'damaged' then
    e := _grades(p->'damaged');
    perform _lock('stock:' || p_loc);
    perform _check_have(p_loc, e.n, e.b, e.c, e.j, case when v_d < biz_today() then v_d end);
    foreach k in array array['N','B','C','J'] loop
      if (case k when 'N' then e.n when 'B' then e.b when 'C' then e.c else e.j end) > 0 then
        insert into breakages (d, location_id, item, qty, reason, recorded_by)
        values (v_d, p_loc, k, case k when 'N' then e.n when 'B' then e.b when 'C' then e.c else e.j end, 'Damaged (daily sheet)', s.id);
      end if;
    end loop;
    perform _rebase(p_loc, v_d, -e.n, -e.b, -e.c, -e.j);
  end if;
  if p ? 'issued' and coalesce((p->'issued'->>'n')::int, 0) + coalesce((p->'issued'->>'b')::int, 0) + coalesce((p->'issued'->>'c')::int, 0) + coalesce((p->'issued'->>'j')::int, 0) > 0 then
    r := r || jsonb_build_object('issued', rpc_issue_out(p_loc, (p->'issued'->>'n')::int, (p->'issued'->>'b')::int, (p->'issued'->>'j')::int,
                                                          (p->'issued'->>'c')::int, p->'issued'->>'party', p->'issued'->>'note', v_d));
  end if;
  if p ? 'sales' then
    e := _grades(p->'sales');
    if e.n + e.b + e.c + e.j > 0 then
      r := r || jsonb_build_object('sale', rpc_record_sale(p_loc, e.n, e.b, e.j, e.c, (p->'sales'->>'cash')::numeric, (p->'sales'->>'till')::numeric,
                                   (p->'sales'->>'paybill')::numeric, 'Day total (daily sheet)', (p->'sales'->>'value')::numeric, v_d));
    end if;
  end if;
  if p ? 'closing' then
    e := _grades(p->'closing');
    r := r || jsonb_build_object('closing', _do_count4(s, p_loc, 'close', e.n, e.b, e.j, e.c, v_d));
  end if;
  if p ? 'cash_counted' and p->>'cash_counted' is not null then
    if v_d < biz_today() then raise exception 'Cash can only be counted for today'; end if;
    r := r || jsonb_build_object('cash', _do_cash_count(s, p_loc, (p->>'cash_counted')::numeric));
  end if;
  return r || jsonb_build_object('date', v_d);
end $$;

-- what the daily sheet shows for a location and day, filled in from the records
create or replace function public.shop_day(p_loc text, p_date date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s staff; v_open record; v_close record;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  perform _check_loc(s, p_loc);
  v_open := _stock4(p_loc, p_date - 1);
  v_close := _stock4(p_loc, p_date);
  return jsonb_build_object(
    'date', p_date, 'location_id', p_loc,
    'opening', jsonb_build_object('n', v_open.n, 'b', v_open.b, 'c', v_open.c, 'j', v_open.j),
    'book_closing', jsonb_build_object('n', v_close.n, 'b', v_close.b, 'c', v_close.c, 'j', v_close.j),
    'received', (select jsonb_build_object('n', coalesce(sum(recv_n),0), 'b', coalesce(sum(recv_b),0), 'c', coalesce(sum(recv_c),0), 'j', coalesce(sum(recv_j),0),
                                           'dmg', coalesce(sum(recv_dmg),0), 'count', count(*))
                   from transfers where to_loc = p_loc and status = 'received' and received_d = p_date and voided_at is null),
    'pending', (select count(*) from transfers where to_loc = p_loc and status = 'in_transit' and voided_at is null),
    'sent', (select jsonb_build_object('n', coalesce(sum(sent_n),0), 'b', coalesce(sum(sent_b),0), 'c', coalesce(sum(sent_c),0), 'j', coalesce(sum(sent_j),0))
               from transfers where from_loc = p_loc and d = p_date and voided_at is null),
    'issued', (select jsonb_build_object('n', coalesce(sum(n),0), 'b', coalesce(sum(b),0), 'c', coalesce(sum(c),0), 'j', coalesce(sum(j),0))
                 from stock_adj where location_id = p_loc and d = p_date and kind = 'out' and voided_at is null),
    'damaged', (select jsonb_build_object('n', coalesce(sum(qty) filter (where item = 'N'),0), 'b', coalesce(sum(qty) filter (where item = 'B'),0),
                                          'c', coalesce(sum(qty) filter (where item = 'C'),0), 'j', coalesce(sum(qty) filter (where item = 'J'),0))
                  from breakages where location_id = p_loc and d = p_date and voided_at is null and not transit),
    'sales', (select jsonb_build_object('n', coalesce(sum(n),0), 'b', coalesce(sum(b),0), 'c', coalesce(sum(c),0), 'j', coalesce(sum(j),0),
                                        'value', coalesce(sum(value),0), 'cash', coalesce(sum(cash),0), 'till', coalesce(sum(till),0),
                                        'paybill', coalesce(sum(paybill),0), 'count', count(*))
                from sales where location_id = p_loc and d = p_date and voided_at is null),
    'counted', (select to_jsonb(x) from (select kind, cnt_n n, cnt_b b, cnt_c c, cnt_j j, recorded_at from stock_counts
                 where location_id = p_loc and d = p_date and voided_at is null and kind in ('open','close') order by recorded_at desc limit 1) x));
end $$;

-- ---------------------------------------------------------------------
-- 8. Opening balances and corrections know about big eggs and issues
-- ---------------------------------------------------------------------
create or replace function public.rpc_opening_balances(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; k text; v jsonb; v_cur numeric; v_feed numeric;
begin
  s := _require(array['owner']::staff_role[]);
  for k, v in select * from jsonb_each(coalesce(p->'stock', '{}')) loop
    perform _do_count4(s, k, 'opening_balance', coalesce((v->>'n')::int, 0), coalesce((v->>'b')::int, 0),
                       coalesce((v->>'j')::int, 0), coalesce((v->>'c')::int, 0), biz_today());
  end loop;
  for k, v in select * from jsonb_each(coalesce(p->'money', '{}')) loop
    if not exists (select 1 from accounts where id = k) then raise exception 'Unknown account %', k; end if;
    perform _lock('acc:' || k);
    v_cur := _balance(k);
    if (v #>> '{}')::numeric <> v_cur then
      insert into money_moves (kind, to_acc, amount, note, recorded_by) values ('opening', k, (v #>> '{}')::numeric - v_cur, 'Opening balance', s.id);
    end if;
  end loop;
  if p ? 'feed_kg' then
    perform _lock('feed');
    v_feed := _feed_stock();
    if (p->>'feed_kg')::numeric <> v_feed then
      insert into feed_moves (kind, kg, note, recorded_by) values ('adjust', (p->>'feed_kg')::numeric - v_feed, 'Opening balance', s.id);
    end if;
  end if;
  if p ? 'tank_l' then
    insert into water_logs (kind, litres, note, recorded_by) values ('tank', (p->>'tank_l')::numeric, 'Opening balance', s.id);
  end if;
  for k, v in select * from jsonb_each(coalesce(p->'medicines', '{}')) loop
    select qty into v_cur from v_med_stock where medicine_id = k::bigint;
    if (v #>> '{}')::numeric <> v_cur then
      insert into med_moves (medicine_id, kind, qty, note, recorded_by) values (k::bigint, 'adjust', (v #>> '{}')::numeric - v_cur, 'Opening balance', s.id);
    end if;
  end loop;
  update settings set go_live = coalesce(go_live, biz_today()) where id = 1;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.rpc_void(p_kind text, p_id bigint, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare s staff; v_table text; v_n int;
begin
  s := _require(array['owner','manager']::staff_role[]);
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason for the correction'; end if;
  v_table := case p_kind
    when 'collect' then 'egg_collections' when 'mort' then 'mortality' when 'feed' then 'feed_moves'
    when 'water' then 'water_logs' when 'med' then 'med_moves' when 'xfer' then 'transfers'
    when 'sale' then 'sales' when 'brk' then 'breakages' when 'count' then 'stock_counts'
    when 'money' then 'money_moves' when 'cash' then 'cash_counts' when 'issue' then 'stock_adj' end;
  if v_table is null then raise exception 'Unknown record type'; end if;
  execute format('update %I set voided_at = now(), voided_by = $1, void_reason = $2 where id = $3 and voided_at is null', v_table)
    using s.id, p_reason, p_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'Record not found or already corrected'; end if;
  if p_kind = 'xfer' then
    update breakages set voided_at = now(), voided_by = s.id, void_reason = 'Delivery voided: ' || p_reason where transfer_id = p_id and voided_at is null;
  elsif p_kind = 'cash' then
    update money_moves set voided_at = now(), voided_by = s.id, void_reason = 'Cash count voided: ' || p_reason where cash_count_id = p_id and voided_at is null;
  elsif p_kind = 'feed' then
    update money_moves set voided_at = now(), voided_by = s.id, void_reason = 'Feed record voided: ' || p_reason
     where id = (select money_move_id from feed_moves where id = p_id) and voided_at is null;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 9. Reads: dashboard and activity
-- ---------------------------------------------------------------------
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
               sum(cash) cash, sum(till) till, sum(paybill) paybill,
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

create or replace function public.activity(p_limit int default 60, p_before timestamptz default null,
                                           p_loc text default null, p_kind text default null)
returns table (kind text, id bigint, d date, recorded_at timestamptz, by_name text, by_role public.staff_role,
               location_id text, voided boolean, data jsonb)
language plpgsql stable security invoker set search_path = public as $$
begin
  perform _me_json();
  return query
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
    union all select 'issue', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from stock_adj x
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
   limit least(greatest(p_limit, 1), 500);
end $$;

-- ---------------------------------------------------------------------
-- 10. Weekly backup (Sunday 23:00 Nairobi), run by the `backup` edge function
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('dpv-weekly-backup', '0 20 * * 0', $cron$
      select net.http_post(
        url := replace((select push_url from public.settings where id = 1), '/push-notify', '/backup'),
        body := '{}'::jsonb,
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'x-dpv-trigger', (select value from public.app_secrets where key = 'trigger_secret')),
        timeout_milliseconds := 120000)
      where (select push_url from public.settings where id = 1) is not null
    $cron$);
  end if;
exception when others then
  raise notice 'weekly backup not scheduled: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 11. Privileges
-- ---------------------------------------------------------------------
revoke execute on function
  public._bump(), public.data_version(), public._stock4(text, date), public._price4(int, int, int, int), public._day(public.staff, date),
  public._grades(jsonb), public._check_have(text, int, int, int, int, date), public._do_count4(public.staff, text, text, int, int, int, int, date),
  public._rebase(text, date, int, int, int, int, boolean),
  public.rpc_collect_eggs(text, int, int, int, int, int, date), public.rpc_house_day(date, jsonb), public.farm_daily2(date, date),
  public.rpc_receive_delivery(bigint, int, int, int, int, int), public.rpc_issue_out(text, int, int, int, int, text, text, date),
  public.rpc_count_stock(text, text, int, int, int, int, date),
  public.rpc_record_sale(text, int, int, int, int, numeric, numeric, numeric, text, numeric, date),
  public.rpc_shop_day(text, date, jsonb), public.shop_day(text, date)
from public, anon;
revoke execute on function
  public._bump(), public._stock4(text, date), public._price4(int, int, int, int), public._day(public.staff, date),
  public._grades(jsonb), public._check_have(text, int, int, int, int, date), public._do_count4(public.staff, text, text, int, int, int, int, date),
  public._rebase(text, date, int, int, int, int, boolean)
from authenticated;
grant execute on function
  public.data_version(), public.farm_daily2(date, date), public.shop_day(text, date),
  public.rpc_collect_eggs(text, int, int, int, int, int, date), public.rpc_house_day(date, jsonb),
  public.rpc_receive_delivery(bigint, int, int, int, int, int), public.rpc_issue_out(text, int, int, int, int, text, text, date),
  public.rpc_count_stock(text, text, int, int, int, int, date),
  public.rpc_record_sale(text, int, int, int, int, numeric, numeric, numeric, text, numeric, date),
  public.rpc_shop_day(text, date, jsonb)
to authenticated;
-- the grade-blind versions stay callable until the new app is live; 20261101000009 retires them
grant execute on all functions in schema public to service_role;
