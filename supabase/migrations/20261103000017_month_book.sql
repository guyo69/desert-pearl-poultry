-- 3 Nov 2026: the owner's monthly outlet workbook (the client's Daily Outlet
-- Report template, one row per outlet per day). The app builds the Excel file
-- from this on download, so it always holds what the outlets have entered so
-- far: every day up to yesterday, and today once the outlet has closed the day.
-- New function only; nothing existing changes.
create or replace function public.rpc_month_book(p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s staff; t date := biz_today(); m0 date; m1 date; v_first date; r jsonb;
begin
  s := _require(array['owner']::staff_role[]);
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
