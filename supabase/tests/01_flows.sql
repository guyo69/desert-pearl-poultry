-- End-to-end checks of roles, validation and the money/stock arithmetic.
-- Run on a database that has 00_supabase_shim.sql + the migration applied.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create function public.t_err(q text, expect text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then
    if position(lower(expect) in lower(sqlerrm)) = 0 then raise exception 'Wrong error for %: %', q, sqlerrm; end if;
    return;
  end;
  raise exception 'Expected an error (%) from: %', expect, q;
end $$;
grant execute on function public.t_err(text, text) to authenticated, anon;

-- act as a staff member, in their (fully verified) test session
create function public.t_as(p uuid) returns void language sql security definer set search_path = public as $$
  select set_config('request.jwt.claims', case when p is null then '' else json_build_object('sub', p,
           'session_id', (select id from auth.sessions where user_id = p order by created_at limit 1))::text end, false);
$$;
grant execute on function public.t_as(uuid) to authenticated, anon;

insert into auth.users (id) values
 ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002'),('00000000-0000-0000-0000-000000000003'),
 ('00000000-0000-0000-0000-000000000004'),('00000000-0000-0000-0000-000000000005'),('00000000-0000-0000-0000-000000000006'),
 ('00000000-0000-0000-0000-000000000007'),('00000000-0000-0000-0000-000000000008');
insert into public.staff (id, display_name, role, location_id) values
 ('00000000-0000-0000-0000-000000000001','Owner','owner',null),
 ('00000000-0000-0000-0000-000000000002','Farm Manager','manager','FARM'),
 ('00000000-0000-0000-0000-000000000003','Production Clerk','clerk','FARM'),
 ('00000000-0000-0000-0000-000000000004','Farm Counter','pos','FARM'),
 ('00000000-0000-0000-0000-000000000005','Van Driver','pos','VAN'),
 ('00000000-0000-0000-0000-000000000006','Tuala Attendant','pos','TUALA'),
 ('00000000-0000-0000-0000-000000000007','Rayan Fedha Attendant','pos','RAYAN'),
 ('00000000-0000-0000-0000-000000000008','Lucky Summer Attendant','pos','LUCKY');

-- every test account has set its own password and has a live session;
-- owner and manager have two-step sign-in and passed it in that session
update public.staff set must_change_password = false, temp_expires_at = null;
insert into auth.sessions (user_id) select id from public.staff;
insert into public.mfa_factors (staff_id, secret_enc, confirmed_at) select id, 'test', now() from public.staff where role in ('owner','manager');
insert into public.mfa_sessions (session_id, staff_id)
  select x.id, x.user_id from auth.sessions x join public.staff s on s.id = x.user_id where s.role in ('owner','manager');

set role authenticated;

-- ---------- owner sets up ----------
select t_as('00000000-0000-0000-0000-000000000001');
select rpc_save_house('A','House A',224,biz_today()-30,30,93);
select rpc_save_house('B','House B',176,biz_today()-30,58,0.80);
select rpc_opening_balances('{"stock":{"FARM":{"n":300,"c":10,"j":6}},
  "money":{"CASH:FARM":2000,"CASH:VAN":2000,"CASH:TUALA":2000,"CASH:RAYAN":2000,"CASH:LUCKY":2000,"TILL":8000,"PAYBILL":12000,"BANK":150000},
  "feed_kg":200,"tank_l":800,"medicines":{"2":2}}'::jsonb);
do $$ begin
  assert (select n from v_stock where location_id='FARM') = 300, 'opening farm stock';
  assert (select sum(balance) from v_balances) = 180000, 'opening funds';
  assert (select coalesce(sum(kg),0) from v_feed_lines) = 200, 'opening feed';
  assert (select go_live from settings) is not null, 'go-live set';
end $$;

-- ---------- clerk ----------
select t_as('00000000-0000-0000-0000-000000000003');
select rpc_collect('A',180,6,2);
select rpc_collect('B',120,4,4);
select t_err($$select rpc_collect('A',0,0,0)$$, 'Enter the number');
select t_err($$select rpc_sale('FARM',30,0,0,450,0,0)$$, 'not available to your role');
-- 200 kg = 63% (watch). Using 50 kg -> 150 kg = 48% (low): band drop must notify
do $$ declare r jsonb; begin
  r := rpc_feed('use', 50, 'Both', 'Morning feed');
  assert r->>'band' = 'low', 'feed band low: ' || r::text;
  assert (r->>'notified')::boolean, 'feed drop notified';
end $$;
select t_err($$select rpc_feed('use', 999)$$, 'Only 150 kg');
select rpc_water('intake', 60, 'A');
do $$ declare r jsonb; begin
  r := rpc_water('tank', 200);
  assert r->>'band' = 'none', 'tank band none: ' || r::text;
  assert (r->>'notified')::boolean, 'tank drop notified';
end $$;
select t_err($$select rpc_water('tank', 5000)$$, 'tank holds');
select t_err($$select rpc_med(2,'use',5)$$, 'Only 2');
select rpc_med(2,'use',1,'House A','Deworming');
select rpc_dispatch('FARM','RAYAN',60,0,1);
select rpc_dispatch('FARM','VAN',90,10,0);
select t_err($$select rpc_dispatch('FARM','TUALA',9999)$$, 'Only');
select t_err($$select rpc_dispatch('VAN','TUALA',30)$$, 'own location');
do $$ begin assert (select n from v_stock where location_id='FARM') = 300+180+120-60-90, 'farm stock after dispatch'; end $$;

-- ---------- Rayan Fedha attendant ----------
select t_as('00000000-0000-0000-0000-000000000007');
do $$ begin
  assert (select count(*) from egg_collections) = 0, 'shop cannot see farm records';
  assert (select count(*) from transfers) = 1, 'shop sees only its own deliveries';
  assert (select count(*) from notifications) = 1, 'shop sees its delivery notice only';
end $$;
select rpc_receive((select id from transfers where to_loc='RAYAN'), 58, 0, 1);
do $$ begin
  assert (select n from v_stock where location_id='RAYAN') = 58, 'received stock';
  assert (select qty from breakages where location_id='RAYAN' and transit) = 2, 'transit breakage logged';
end $$;
select t_err($$select rpc_receive((select id from transfers where to_loc='RAYAN'), 58)$$, 'already received');
select rpc_stock_count('RAYAN','open',58,0,1);
select t_err($$select rpc_sale('RAYAN',30,0,0,400,0,0)$$, 'must equal');
select t_err($$select rpc_sale('TUALA',30,0,0,450,0,0)$$, 'own location');
select t_err($$select rpc_sale('RAYAN',90,0,0,1350,0,0)$$, 'Only 1 tr');
-- 1 tray + 2 loose + 1 jumbo = 450 + 32 + 20 = 502
do $$ declare r jsonb; begin
  r := rpc_sale('RAYAN',32,0,1,200,302,0);
  assert (r->>'value')::numeric = 502, 'price: ' || r::text;
end $$;
select rpc_move_money('CASH:RAYAN','BANK',1000,0,'DEP123');
select t_err($$select rpc_move_money('TILL','BANK',100)$$, 'own cash');
select t_err($$select rpc_move_money('CASH:RAYAN','CASH:VAN',100)$$, 'another location');
select t_err($$select rpc_move_money('CASH:RAYAN','BANK',999999)$$, 'has only');
select rpc_move_money('PAYBILL','CASH:RAYAN',500,13,'QK1');
select rpc_expense('CASH:RAYAN',50,'Packaging','Trays');
select t_err($$select rpc_expense('BANK',50,'Other')$$, 'management');
-- expected cash = 2000 + 200 - 1000 + 500 - 50 = 1650; count 1600 -> short 50
do $$ declare r jsonb; begin
  assert (select balance from v_balances where account_id='CASH:RAYAN') = 1650, 'expected cash';
  r := rpc_close_day('RAYAN', 26, 0, 0, 1600);
  assert (r->>'diff')::numeric = -50, 'cash diff ' || r::text;
  assert (r->>'adj_n')::int = 0, 'stock matched';
  assert (select balance from v_balances where account_id='CASH:RAYAN') = 1600, 'cash after count';
  assert (select count(*) from sales where location_id <> 'RAYAN') = 0, 'only own sales visible';
end $$;

-- ---------- van ----------
select t_as('00000000-0000-0000-0000-000000000005');
select rpc_receive((select id from transfers where to_loc='VAN'), 90, 10, 0);
-- van delivers to a shop
select rpc_dispatch('VAN','TUALA',30,0,0);
select rpc_sale('VAN',30,10,0,0,0,550);

-- ---------- Tuala ----------
select t_as('00000000-0000-0000-0000-000000000006');
select rpc_receive((select id from transfers where to_loc='TUALA'), 30, 0, 0);
do $$ begin assert (select n from v_stock where location_id='TUALA') = 30, 'tuala stock from van'; end $$;

-- ---------- anon ----------
select t_as(null);
set role anon;
select t_err($$select * from staff_directory()$$, 'permission denied');  -- names are no longer public
select t_err($$select dashboard()$$, 'permission denied');
select t_err($$select * from sales$$, 'permission denied');
set role authenticated;

-- ---------- owner checks everything ----------
select t_as('00000000-0000-0000-0000-000000000001');
do $$ declare d jsonb; v_open numeric; v_sales numeric; v_exp numeric; v_fee numeric; v_var numeric; v_tot numeric; begin
  d := dashboard(30);
  assert jsonb_array_length(d->'locations') = 5, 'locations';
  assert jsonb_array_length(d->'farm_daily') > 0, 'farm daily';
  assert (d->>'feed_stock')::numeric = 150, 'feed stock';
  assert (d->'tank'->>'litres')::numeric = 200, 'tank';
  -- books balance: openings + sales - expenses - fees + variances = funds in accounts
  select coalesce(sum(amount),0) into v_open from money_moves where kind='opening' and voided_at is null;
  select coalesce(sum(value),0) into v_sales from sales where voided_at is null;
  select coalesce(sum(amount),0) into v_exp from money_moves where kind='expense' and voided_at is null;
  select coalesce(sum(fee),0) into v_fee from money_moves where voided_at is null;
  select coalesce(sum(amount),0) into v_var from money_moves where kind='variance' and voided_at is null;
  select sum(balance) into v_tot from v_balances;
  assert v_open + v_sales - v_exp - v_fee + v_var = v_tot, format('books %s %s %s %s %s = %s', v_open, v_sales, v_exp, v_fee, v_var, v_tot);
  assert v_tot = 180000 + 502 + 550 - 50 - 13 - 50, 'total funds ' || v_tot;
end $$;
select count(*) as activity_rows from activity(100);
-- void the Rayan sale: stock and cash come back
select rpc_void('sale', (select id from sales where location_id='RAYAN'), 'Entered twice');
do $$ begin
  assert (select n from v_stock where location_id='RAYAN') = 58, 'stock restored after void';
  assert (select balance from v_balances where account_id='CASH:RAYAN') = 1400, 'cash after void';
end $$;
select t_err($$select rpc_void('sale', (select id from sales where location_id='RAYAN'), 'again')$$, 'already corrected');
select rpc_save_settings('{"feed_buffer_kg":2205,"tray_n":480}'::jsonb);
do $$ begin assert (select feed_buffer_kg from settings) = 2205, 'settings'; end $$;

-- ---------- manager ----------
select t_as('00000000-0000-0000-0000-000000000002');
select t_err($$select rpc_save_settings('{}'::jsonb)$$, 'not available');
select rpc_mark_read(array(select id from notifications));
do $$ begin assert (select count(*) from notification_reads) > 0, 'reads'; end $$;

-- ---------- morning checks ----------
reset role;
select public.daily_checks() as daily_notifications;
select sev, title from notifications order by id;
select 'ALL TESTS PASSED' as result;
