-- 2 Nov 2026, client feedback:
--   * a sale can be paid wholly or partly on credit (customer named, pays later)
--   * the owner account views and sets up, but does not enter the day's records
--   * Big eggs are recorded as Normal (the forms no longer offer Big); the weekly
--     Excel attachment folds any older big eggs into Normal
-- New functions and a trigger only: no existing rpc_* or auth function changes,
-- and no existing row is changed.

-- ---------------------------------------------------------------------
-- 1. Credit on sales
-- ---------------------------------------------------------------------
alter table public.sales add column if not exists credit numeric not null default 0 check (credit >= 0);
alter table public.sales drop constraint if exists sales_check1;
alter table public.sales drop constraint if exists sales_paid_in_full;
alter table public.sales add constraint sales_paid_in_full check (cash + till + paybill + credit = value);
grant select (credit) on public.sales to authenticated;

-- Same checks as rpc_record_sale, plus the credit part. Big eggs are not taken
-- (recorded as Normal).
create or replace function public.rpc_sale_with_credit(p_loc text, p_n int, p_j int, p_c int,
                                                       p_cash numeric, p_till numeric, p_paybill numeric, p_credit numeric,
                                                       p_customer text default null, p_value numeric default null, p_date date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_d date; v_list numeric; v_value numeric; v_id bigint; v_cust text := nullif(trim(p_customer), '');
begin
  s := _require(array['manager','pos']::staff_role[]);
  perform _check_loc(s, p_loc);
  v_d := _day(s, p_date);
  p_n := coalesce(p_n,0); p_j := coalesce(p_j,0); p_c := coalesce(p_c,0);
  p_cash := coalesce(p_cash,0); p_till := coalesce(p_till,0); p_paybill := coalesce(p_paybill,0); p_credit := coalesce(p_credit,0);
  if least(p_n, p_j, p_c) < 0 or least(p_cash, p_till, p_paybill, p_credit) < 0 then raise exception 'Numbers cannot be negative'; end if;
  if p_n + p_j + p_c = 0 then raise exception 'Enter the eggs sold'; end if;
  if p_credit > 0 and v_cust is null then raise exception 'Enter the name of the customer who will pay later'; end if;
  if length(coalesce(v_cust, '')) > 80 then raise exception 'Customer name is too long'; end if;
  perform _lock('stock:' || p_loc);
  perform _check_have(p_loc, p_n, 0, p_c, p_j, case when v_d < biz_today() then v_d end);
  v_list := _price4(p_n, 0, p_c, p_j);
  v_value := coalesce(p_value, v_list);
  if v_value <= 0 then raise exception 'Enter the amount due'; end if;
  if p_cash + p_till + p_paybill + p_credit <> v_value then
    raise exception 'Payments (%) must equal the amount due (%)', _kes(p_cash + p_till + p_paybill + p_credit), _kes(v_value);
  end if;
  insert into sales (d, location_id, n, b, c, j, value, list_value, cash, till, paybill, credit, customer, recorded_by)
  values (v_d, p_loc, p_n, 0, p_c, p_j, v_value, v_list, p_cash, p_till, p_paybill, p_credit, v_cust, s.id) returning id into v_id;
  perform _rebase(p_loc, v_d, -p_n, 0, -p_c, -p_j);
  return jsonb_build_object('id', v_id, 'value', v_value, 'list_value', v_list, 'credit', p_credit);
end $$;

-- ---------------------------------------------------------------------
-- 2. The owner account is view-only for the day's records
-- ---------------------------------------------------------------------
-- Applies to anyone signed in as an owner, whatever screen or function they
-- use. Setup stays open to the owner: houses, staff, prices and thresholds,
-- the medicine list and schedule, and the go-live opening balances. Imports
-- and scheduled jobs run without a signed-in person and are not affected.
create or replace function public._owner_view_only()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_role staff_role; r jsonb;
begin
  if auth.uid() is null then return coalesce(new, old); end if;
  select role into v_role from staff where id = auth.uid();
  if v_role is distinct from 'owner' then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    r := to_jsonb(new);
    -- go-live opening balances (rpc_opening_balances, owner only)
    if (tg_table_name = 'stock_counts' and r->>'kind' = 'opening_balance')
       or (tg_table_name = 'money_moves' and r->>'kind' = 'opening')
       or (tg_table_name in ('feed_moves', 'med_moves') and r->>'kind' = 'adjust' and r->>'note' = 'Opening balance')
       or (tg_table_name = 'water_logs' and r->>'kind' = 'tank' and r->>'note' = 'Opening balance') then
      return new;
    end if;
  end if;
  raise exception 'The owner account is view-only. The farm manager or the person on duty enters the day''s records.'
    using errcode = '42501';
end $$;
revoke execute on function public._owner_view_only() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['egg_collections','mortality','feed_moves','water_logs','med_moves','transfers','sales',
                           'breakages','stock_counts','stock_adj','cash_counts','money_moves','day_marks'] loop
    execute format('drop trigger if exists owner_view_only on public.%I', t);
    execute format('create trigger owner_view_only before insert or update or delete on public.%I
                    for each row execute function public._owner_view_only()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Weekly Excel attachment: Big folded into Normal, Credit shown
-- ---------------------------------------------------------------------
create or replace function public.digest_entries(p_from date, p_to date, p_role public.staff_role, p_loc text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_farm boolean := p_role in ('owner','manager','clerk'); v_money boolean := p_role in ('owner','manager');
        v_out text[]; sheets jsonb := '[]'::jsonb;
begin
  v_out := case when p_role in ('owner','manager') then array(select id from locations) when p_role = 'pos' then array[p_loc] else '{}'::text[] end;
  if v_farm then
    sheets := sheets || jsonb_build_object('name', 'Eggs collected', 'columns', jsonb_build_array('Date','House','Normal','Jumbo','Cracked','Damaged','Entered by'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(e.d, h.name, e.n + e.b, e.j, e.c, e.dmg, s.display_name) order by e.d, h.sort, e.id), '[]'::jsonb)
                 from egg_collections e join houses h on h.id = e.house_id left join staff s on s.id = e.recorded_by
                where e.voided_at is null and e.d between p_from and p_to));
    sheets := sheets || jsonb_build_object('name', 'Deaths', 'columns', jsonb_build_array('Date','House','Birds','Cause'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(m.d, h.name, m.birds, m.cause) order by m.d, h.sort), '[]'::jsonb)
                 from mortality m join houses h on h.id = m.house_id where m.voided_at is null and m.d between p_from and p_to));
    sheets := sheets || jsonb_build_object('name', 'Feed', 'columns', jsonb_build_array('Date','Movement','Kg','Bags','House','Note'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(f.d, f.kind, f.kg, f.bags, f.house, f.note) order by f.d, f.id), '[]'::jsonb)
                 from feed_moves f where f.voided_at is null and f.d between p_from and p_to));
    sheets := sheets || jsonb_build_object('name', 'Water', 'columns', jsonb_build_array('Date','Record','House','Litres'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(w.d, case w.kind when 'tank' then 'Tank reading' else 'Drunk' end, h.name, w.litres) order by w.d, w.id), '[]'::jsonb)
                 from water_logs w left join houses h on h.id = w.house_id where w.voided_at is null and w.d between p_from and p_to));
  end if;
  sheets := sheets || jsonb_build_object('name', 'Eggs issued', 'columns',
      jsonb_build_array('Date issued','From','To','Sent normal','Sent jumbo','Sent cracked','Status','Date received','Received normal','Received jumbo','Received cracked','Damaged on arrival'),
    'rows', (select coalesce(jsonb_agg(jsonb_build_array(t.d, lf.name, lt.name, t.sent_n + t.sent_b, t.sent_j, t.sent_c,
                     case t.status when 'received' then 'Received' else 'On the way' end, t.received_d,
                     case when t.status = 'received' then t.recv_n + t.recv_b end, t.recv_j, t.recv_c, t.recv_dmg)
                     order by t.d, t.id), '[]'::jsonb)
               from transfers t join locations lf on lf.id = t.from_loc join locations lt on lt.id = t.to_loc
              where t.voided_at is null and (t.d between p_from and p_to or t.received_d between p_from and p_to)
                and (t.to_loc = any (v_out) or t.from_loc = any (v_out) or (v_farm and t.from_loc = 'FARM'))));
  if cardinality(v_out) > 0 then
    sheets := sheets || jsonb_build_object('name', 'Sales',
      'columns', case when v_money then jsonb_build_array('Date','Outlet','Normal','Jumbo','Cracked','Value (KES)','List value (KES)','Cash','M-Pesa Till','M-Pesa Paybill','Credit','Customer','Paper book')
                 else jsonb_build_array('Date','Outlet','Normal','Jumbo','Cracked','Value (KES)','Customer') end,
      'rows', (select coalesce(jsonb_agg(case when v_money
                  then jsonb_build_array(s.d, l.name, s.n + s.b, s.j, s.c, s.value, s.list_value, s.cash, s.till, s.paybill, s.credit, s.customer, case when s.imported then 'yes' end)
                  else jsonb_build_array(s.d, l.name, s.n + s.b, s.j, s.c, s.value, s.customer) end order by s.d, l.sort, s.id), '[]'::jsonb)
                 from sales s join locations l on l.id = s.location_id
                where s.voided_at is null and s.location_id = any (v_out) and s.d between p_from and p_to));
    sheets := sheets || jsonb_build_object('name', 'Out no sale and taken in', 'columns', jsonb_build_array('Date','Outlet','Direction','Normal','Jumbo','Cracked','To or from','Note'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(a.d, l.name, case a.kind when 'out' then 'Out, no sale' else 'Taken in' end, a.n + a.b, a.j, a.c, a.party, a.note) order by a.d, a.id), '[]'::jsonb)
                 from stock_adj a join locations l on l.id = a.location_id where a.voided_at is null and a.location_id = any (v_out) and a.d between p_from and p_to));
  end if;
  sheets := sheets || jsonb_build_object('name', 'Damaged', 'columns', jsonb_build_array('Date','Where','Grade','Eggs','Reason','On arrival'),
    'rows', (select coalesce(jsonb_agg(jsonb_build_array(b.d, l.name, case b.item when 'N' then 'Normal' when 'B' then 'Normal' when 'J' then 'Jumbo' else 'Cracked' end,
                     b.qty, b.reason, case when b.transit then 'yes' end) order by b.d, b.id), '[]'::jsonb)
               from breakages b join locations l on l.id = b.location_id
              where b.voided_at is null and b.d between p_from and p_to and (b.location_id = any (v_out) or (v_farm and b.location_id = 'FARM'))));
  sheets := sheets || jsonb_build_object('name', 'Stock counts', 'columns', jsonb_build_array('Date','Where','Count','Normal','Jumbo','Cracked','Off the book (eggs)'),
    'rows', (select coalesce(jsonb_agg(jsonb_build_array(k.d, l.name, case k.kind when 'open' then 'Opening' when 'close' then 'Closing' else 'Opening balance' end,
                     k.cnt_n + coalesce(k.cnt_b, 0), k.cnt_j, k.cnt_c, k.adj_n + coalesce(k.adj_b, 0) + k.adj_c + k.adj_j) order by k.d, l.sort, k.id), '[]'::jsonb)
               from stock_counts k join locations l on l.id = k.location_id
              where k.voided_at is null and k.d between p_from and p_to and (k.location_id = any (v_out) or (v_farm and k.location_id = 'FARM'))));
  if v_money then
    sheets := sheets || jsonb_build_object('name', 'Money', 'columns', jsonb_build_array('Date','Kind','From','To','Amount (KES)','Charges','Category','Note','Reference'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(m.d, m.kind, af.name, at.name, m.amount, m.fee, m.category, m.note, m.ref) order by m.d, m.id), '[]'::jsonb)
                 from money_moves m left join accounts af on af.id = m.from_acc left join accounts at on at.id = m.to_acc
                where m.voided_at is null and m.d between p_from and p_to));
    sheets := sheets || jsonb_build_object('name', 'Cash counts', 'columns', jsonb_build_array('Date','Where','Counted','Expected','Difference'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(c.d, l.name, c.counted, c.expected, c.diff) order by c.d, c.id), '[]'::jsonb)
                 from cash_counts c join locations l on l.id = c.location_id where c.voided_at is null and c.d between p_from and p_to));
  end if;
  return jsonb_build_object('sheets', sheets);
end $$;

-- ---------------------------------------------------------------------
-- 4. Privileges
-- ---------------------------------------------------------------------
revoke execute on function public.rpc_sale_with_credit(text, int, int, int, numeric, numeric, numeric, numeric, text, numeric, date) from public, anon;
grant execute on function public.rpc_sale_with_credit(text, int, int, int, numeric, numeric, numeric, numeric, text, numeric, date) to authenticated;
revoke execute on function public.digest_entries(date, date, public.staff_role, text) from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
