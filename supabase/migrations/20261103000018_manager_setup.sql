-- 3 Nov 2026, client request: the farm manager gets a Setup tab (houses,
-- prices and thresholds, staff other than owners) and the monthly outlet
-- workbooks. Opening balances stay with the owner.
-- Changed, not new: rpc_save_settings (now owner or farm manager; the body is
-- unchanged) and rpc_month_book (added in 17, now owner or farm manager).
-- Staff accounts are handled by the staff-admin edge function, which keeps
-- owner accounts out of the farm manager's reach.
create or replace function public.rpc_save_settings(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner','manager']::staff_role[]);
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
revoke execute on function public.rpc_save_settings(jsonb) from public, anon;
grant execute on function public.rpc_save_settings(jsonb) to authenticated, service_role;

-- the monthly outlet workbooks, for the owner and the farm manager
create or replace function public.rpc_month_book(p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s staff; t date := biz_today(); m0 date; m1 date; v_first date; r jsonb;
begin
  s := _require(array['owner','manager']::staff_role[]);
  m0 := date_trunc('month', coalesce(p_month, t))::date;
  if m0 > t then raise exception 'That month has not started yet'; end if;
  if m0 < date_trunc('month', t - 800)::date then raise exception 'Choose a more recent month'; end if;
  m1 := least((m0 + interval '1 month' - interval '1 day')::date, t);
  select least((select min(d) from sales where voided_at is null), (select min(d) from stock_counts where voided_at is null),
               (select min(d) from transfers where voided_at is null), (select min(d) from egg_collections where voided_at is null))
    into v_first;

  with days as (select g::date d from generate_series(m0, m1, interval '1 day') g),
  grid as (select l.id loc, l.sort, x.d from locations l cross join days x),
  rows as (
    select g.loc, g.sort, g.d,
      (select c.cnt_n + c.cnt_b + c.cnt_c + c.cnt_j from stock_counts c where c.location_id = g.loc and c.d = g.d and c.voided_at is null
          and c.kind in ('open', 'opening_balance') order by c.recorded_at, c.id limit 1) open_cnt,
      (select c.cnt_n + c.cnt_b + c.cnt_c + c.cnt_j from stock_counts c where c.location_id = g.loc and c.d = g.d - 1 and c.voided_at is null
          and c.kind = 'close' order by c.recorded_at desc, c.id desc limit 1) prev_close,
      (select coalesce(sum(v.n + v.b + v.c + v.j), 0) from v_stock_moves v where v.location_id = g.loc and v.d < g.d) book_open,
      (select c.cnt_n + c.cnt_b + c.cnt_c + c.cnt_j from stock_counts c where c.location_id = g.loc and c.d = g.d and c.voided_at is null
          and c.kind = 'close' order by c.recorded_at desc, c.id desc limit 1) close_cnt,
      (select coalesce(sum(x.recv_n + coalesce(x.recv_b, 0) + x.recv_c + x.recv_j), 0) from transfers x
        where x.to_loc = g.loc and x.received_d = g.d and x.status = 'received' and x.voided_at is null) recv_xfer,
      case when g.loc = 'FARM' then (select coalesce(sum(e.n + e.b + e.c + e.j), 0) from egg_collections e where e.d = g.d and e.voided_at is null) else 0 end collected,
      (select coalesce(sum(a.n + a.b + a.c + a.j), 0) from stock_adj a where a.location_id = g.loc and a.d = g.d and a.kind = 'in' and a.voided_at is null) taken_in,
      (select coalesce(sum(x.sent_n + coalesce(x.sent_b, 0) + x.sent_c + x.sent_j), 0) from transfers x
        where x.from_loc = g.loc and x.d = g.d and x.voided_at is null) sent,
      (select coalesce(sum(b.qty), 0) from breakages b where b.location_id = g.loc and b.d = g.d and not b.transit and b.voided_at is null) broken,
      (select coalesce(sum(a.n + a.b + a.c + a.j), 0) from stock_adj a where a.location_id = g.loc and a.d = g.d and a.kind = 'out' and a.voided_at is null) issued,
      sa.*,
      (select coalesce(sum(p.amount), 0) from credit_payments p where p.location_id = g.loc and p.d = g.d and p.voided_at is null) credit_paid
    from grid g
    cross join lateral (
      select count(*)::int sales, coalesce(sum(x.n + x.b + x.c + x.j), 0) sold, coalesce(sum(x.value), 0) value,
             coalesce(sum(coalesce(x.list_value, x.value)), 0) list_value,
             coalesce(sum(x.cash), 0) cash, coalesce(sum(x.till), 0) till, coalesce(sum(x.paybill), 0) paybill, coalesce(sum(x.credit), 0) credit,
             -- eggs paid by each mode: a sale paid two ways is split by the money
             coalesce(sum(case when x.value > 0 then (x.n + x.b + x.c + x.j) * x.cash / x.value end), 0) e_cash,
             coalesce(sum(case when x.value > 0 then (x.n + x.b + x.c + x.j) * x.till / x.value end), 0) e_till,
             coalesce(sum(case when x.value > 0 then (x.n + x.b + x.c + x.j) * x.paybill / x.value end), 0) e_paybill,
             coalesce(sum(case when x.value > 0 then (x.n + x.b + x.c + x.j) * x.credit / x.value end), 0) e_credit,
             bool_or(x.imported) imported
        from sales x where x.location_id = g.loc and x.d = g.d and x.voided_at is null) sa
  )
  select jsonb_build_object(
    'month', m0, 'from', m0, 'to', m1, 'today', t, 'first_month', date_trunc('month', coalesce(v_first, t))::date,
    'generated_at', now(), 'tray', 30,
    'locations', (select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'short', l.short) order by l.sort) from locations l),
    'rows', coalesce((select jsonb_agg(to_jsonb(x) - 'sort' order by x.sort, x.d) from rows x), '[]'::jsonb)
  ) into r;
  return r;
end $$;

revoke execute on function public.rpc_month_book(date) from public, anon;
grant execute on function public.rpc_month_book(date) to authenticated, service_role;
