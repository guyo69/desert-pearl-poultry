-- 3 Nov 2026, client feedback:
--   1. Water drunk brings the tank level down, the way feed used brings the
--      feed store down. The level is the last tank reading less the water
--      drunk since that reading. A new reading resets it (after a refill).
--   2. Credit paid: a customer who bought on credit pays later. The payment
--      goes into the cash drawer, Till or Paybill, and "Outstanding credits"
--      shows who still owes what.
--   3. The activity log is ordered by the date a record is for, newest day
--      first, whatever day it was entered.
--   4. The farm manager can enter a skipped day's feed, water, deaths and
--      medicine (up to 62 days back, the same limit as the daily sheets).
-- Changed, not new: the internal helper _tank() (reminders now use the
-- level after water drunk), the read functions dashboard() and activity(),
-- and the view v_money_lines (credit payments added). No rpc_* or auth
-- function changes and no existing row is changed.

-- ---------------------------------------------------------------------
-- 1. Tank level after water drunk
-- ---------------------------------------------------------------------
-- Water drunk counts against the latest reading when it is for a later day,
-- or for the same day and entered after the reading.
create or replace function public._tank() returns numeric
language sql stable security definer set search_path = public as $$
  select greatest(r.litres - coalesce((
           select sum(w.litres) from water_logs w
            where w.kind = 'intake' and w.voided_at is null
              and (w.d > r.d or (w.d = r.d and w.recorded_at > r.recorded_at))), 0), 0)
    from (select litres, d, recorded_at from water_logs
           where kind = 'tank' and voided_at is null
           order by d desc, recorded_at desc, id desc limit 1) r
$$;
revoke execute on function public._tank() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Credit payments
-- ---------------------------------------------------------------------
create table if not exists public.credit_payments (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  sale_id bigint not null references public.sales(id),
  location_id text not null references public.locations(id),
  customer text not null,
  amount numeric not null check (amount > 0),
  method text not null check (method in ('cash', 'till', 'paybill')),
  note text
);
create index if not exists credit_payments_sale on public.credit_payments (sale_id);
create index if not exists credit_payments_loc on public.credit_payments (location_id, d);
alter table public.credit_payments enable row level security;
drop policy if exists read_loc on public.credit_payments;
create policy read_loc on public.credit_payments for select to authenticated
  using ((select is_mgmt()) or location_id = (select me_loc()));
revoke all on public.credit_payments from public, anon, authenticated;
grant select on public.credit_payments to authenticated;
grant all on public.credit_payments to service_role;
drop trigger if exists zz_bump on public.credit_payments;
create trigger zz_bump after insert or update or delete on public.credit_payments
  for each statement execute function public._bump();
drop trigger if exists owner_view_only on public.credit_payments;
create trigger owner_view_only before insert or update or delete on public.credit_payments
  for each row execute function public._owner_view_only();

-- money: a credit payment lands in the drawer of the outlet, the Till or the Paybill
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
    from money_moves where voided_at is null and to_acc is not null
  union all
  select case method when 'cash' then 'CASH:' || location_id when 'till' then 'TILL' else 'PAYBILL' end,
         d, 'credit_paid', amount, location_id
    from credit_payments where voided_at is null;

-- What a customer still owes at an outlet, sale by sale (oldest first).
create or replace function public._credit_open(p_loc text, p_customer text)
returns table (sale_id bigint, d date, customer text, owed numeric)
language sql stable security definer set search_path = public as $$
  select s.id, s.d, s.customer, s.credit - coalesce((select sum(p.amount) from credit_payments p
                                                      where p.sale_id = s.id and p.voided_at is null), 0)
    from sales s
   where s.voided_at is null and s.credit > 0 and s.location_id = p_loc
     and lower(trim(s.customer)) = lower(trim(p_customer))
     and s.credit - coalesce((select sum(p.amount) from credit_payments p
                               where p.sale_id = s.id and p.voided_at is null), 0) > 0
   order by s.d, s.id
$$;
revoke execute on function public._credit_open(text, text) from public, anon, authenticated;

-- A customer pays (part of) what they owe. The amount is set against their
-- oldest unpaid credit sales first.
create or replace function public.rpc_credit_paid(p_loc text, p_customer text, p_amount numeric, p_method text,
                                                  p_date date default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_d date; v_left numeric; v_owed numeric; o record; v_part numeric; v_cust text := nullif(trim(p_customer), '');
begin
  s := _require(array['manager','pos']::staff_role[]);
  perform _check_loc(s, p_loc);
  v_d := _day(s, p_date);
  if v_cust is null then raise exception 'Choose the customer who is paying'; end if;
  if p_method is null or p_method not in ('cash', 'till', 'paybill') then raise exception 'Choose how the customer paid'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter the amount paid'; end if;
  if length(coalesce(p_note, '')) > 200 then raise exception 'The note is too long'; end if;
  perform _lock('credit:' || p_loc);
  select coalesce(sum(x.owed), 0) into v_owed from _credit_open(p_loc, v_cust) x;
  if v_owed = 0 then raise exception '% has no credit to pay at this outlet', v_cust; end if;
  if p_amount > v_owed then raise exception '% owes %. Enter that amount or less', v_cust, _kes(v_owed); end if;
  v_left := p_amount;
  for o in select * from _credit_open(p_loc, v_cust) loop
    exit when v_left <= 0;
    v_part := least(v_left, o.owed);
    insert into credit_payments (d, sale_id, location_id, customer, amount, method, note, recorded_by)
    values (v_d, o.sale_id, p_loc, o.customer, v_part, p_method, nullif(trim(p_note), ''), s.id);
    v_left := v_left - v_part;
  end loop;
  return jsonb_build_object('paid', p_amount, 'still_owed', v_owed - p_amount, 'customer', v_cust);
end $$;
revoke execute on function public.rpc_credit_paid(text, text, numeric, text, date, text) from public, anon;
grant execute on function public.rpc_credit_paid(text, text, numeric, text, date, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Skipped days on the farm: feed, water, deaths and medicine
-- ---------------------------------------------------------------------
-- For an earlier day only (today's entries use the usual forms). Farm
-- manager only, up to 62 days back (_day enforces both).
create or replace function public.rpc_farm_record_on(p_date date, p_kind text, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_d date; v_house houses; m medicines; v_qty numeric; v_stock numeric; v_id bigint;
begin
  s := _require(array['manager']::staff_role[]);
  if p_date is null or p_date >= biz_today() then raise exception 'Choose the earlier day you are entering'; end if;
  v_d := _day(s, p_date);
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Nothing to save'; end if;
  if p_kind in ('water', 'deaths') then
    select * into v_house from houses where id = p->>'house';
    if v_house.id is null then raise exception 'Choose the house'; end if;
    if v_d < v_house.start_date then raise exception '% was not stocked on that day', v_house.name; end if;
  end if;
  case p_kind
  when 'feed_use' then
    v_qty := (p->>'kg')::numeric;
    if coalesce(v_qty, 0) <= 0 then raise exception 'Enter the feed used'; end if;
    perform _lock('feed');
    insert into feed_moves (d, kind, kg, house, note, recorded_by)
    values (v_d, 'use', v_qty, nullif(trim(p->>'house'), ''), nullif(trim(p->>'note'), ''), s.id) returning id into v_id;
  when 'water' then
    v_qty := (p->>'litres')::numeric;
    if coalesce(v_qty, 0) <= 0 then raise exception 'Enter the litres the birds drank'; end if;
    perform _lock('water');
    insert into water_logs (d, kind, house_id, litres, note, recorded_by)
    values (v_d, 'intake', v_house.id, v_qty, nullif(trim(p->>'note'), ''), s.id) returning id into v_id;
  when 'deaths' then
    v_qty := (p->>'birds')::int;
    if coalesce(v_qty, 0) <= 0 then raise exception 'Enter the number of birds'; end if;
    insert into mortality (d, house_id, birds, cause, recorded_by)
    values (v_d, v_house.id, v_qty::int, coalesce(nullif(trim(p->>'cause'), ''), 'Unknown'), s.id) returning id into v_id;
  when 'med' then
    select * into m from medicines where id = (p->>'medicine')::bigint;
    if m.id is null then raise exception 'Unknown medicine'; end if;
    if coalesce(p->>'move', '') not in ('in', 'use') then raise exception 'Unknown movement'; end if;
    v_qty := (p->>'qty')::numeric;
    if coalesce(v_qty, 0) <= 0 then raise exception 'Enter a quantity'; end if;
    perform _lock('med:' || m.id);
    select qty into v_stock from v_med_stock where medicine_id = m.id;
    if p->>'move' = 'use' and v_qty > v_stock then raise exception 'Only % % in store', v_stock, m.unit; end if;
    insert into med_moves (d, medicine_id, kind, qty, house, note, recorded_by)
    values (v_d, m.id, p->>'move', v_qty, case when p->>'move' = 'use' then nullif(trim(p->>'house'), '') end,
            nullif(trim(p->>'note'), ''), s.id) returning id into v_id;
  else
    raise exception 'Unknown farm record';
  end case;
  return jsonb_build_object('id', v_id, 'date', v_d);
end $$;
revoke execute on function public.rpc_farm_record_on(date, text, jsonb) from public, anon;
grant execute on function public.rpc_farm_record_on(date, text, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Activity, ordered by the day a record is for
-- ---------------------------------------------------------------------
-- p_cursor is the last row already shown ({"d", "at", "k", "id"}); the next
-- page carries on after it. p_before is kept for older copies of the app.
drop function if exists public.activity(int, timestamptz, text, text);
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

-- ---------------------------------------------------------------------
-- 5. Dashboard: tank after water drunk, credit on sales, outstanding credits
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
    'notifications', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]') from (
        select n.*, exists (select 1 from notification_reads r where r.notification_id = n.id and r.staff_id = auth.uid()) as read
          from notifications n where n.created_at > now() - interval '14 days' order by n.created_at desc limit 50) x)
  ) into r;
  return r;
end $$;
revoke execute on function public.dashboard(int) from public, anon;
grant execute on function public.dashboard(int) to authenticated, service_role;
