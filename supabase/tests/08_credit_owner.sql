-- Credit sales, and the owner account being view-only (2 Nov 2026).
-- Runs after 06_staff_email.sql on the same database.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;

-- ---------- 1. a sale paid partly on credit ----------
select t_as('00000000-0000-0000-0000-000000000006');   -- Tuala attendant
do $$ declare st0 record; c0 numeric; r jsonb; begin
  st0 := t_stock('TUALA');
  c0 := (select balance from v_balances where account_id = 'CASH:TUALA');
  r := rpc_sale_with_credit('TUALA', 30, 0, 0, 200, 0, 0, (select tray_n from settings) - 200, 'Hotel Baraka');
  assert (r->>'credit')::numeric = (select tray_n from settings) - 200, 'credit returned';
  assert (t_stock('TUALA')).n = st0.n - 30, 'stock goes down by the sale';
  assert (select balance from v_balances where account_id = 'CASH:TUALA') = c0 + 200, 'only the cash part reaches the drawer';
  assert (select credit from sales where id = (r->>'id')::bigint) > 0, 'credit stored';
  assert (select customer from sales where id = (r->>'id')::bigint) = 'Hotel Baraka', 'customer stored';
end $$;
select t_err($$select rpc_sale_with_credit('TUALA', 30, 0, 0, 0, 0, 0, (select tray_n from settings), null)$$, 'name of the customer');
select t_err($$select rpc_sale_with_credit('TUALA', 30, 0, 0, 100, 0, 0, 100, 'X')$$, 'must equal');
select t_err($$select rpc_sale_with_credit('TUALA', 30, 0, 0, -1, 0, 0, 451, 'X')$$, 'negative');

-- ---------- 2. the owner views, the staff enter ----------
select t_as('00000000-0000-0000-0000-000000000001');
select t_err($$select rpc_collect_eggs('A', 30, 0, 0, 0, 0)$$, 'view-only');
select t_err($$select rpc_record_sale('TUALA', 30, 0, 0, 0, (select tray_n from settings), 0, 0)$$, 'view-only');
select t_err($$select rpc_sale_with_credit('TUALA', 30, 0, 0, (select tray_n from settings), 0, 0, 0)$$, 'not available');
-- setup is still the owner's
select rpc_save_settings('{"tray_n":450}'::jsonb);
select t_as(null);
reset role;
do $$ begin
  assert exists (select 1 from pg_trigger where tgname = 'owner_view_only' and tgrelid = 'public.sales'::regclass), 'trigger on sales';
  assert (select count(*) from pg_trigger where tgname = 'owner_view_only') = 13, 'trigger on every record table';
  assert not has_function_privilege('anon', 'public.rpc_sale_with_credit(text, integer, integer, integer, numeric, numeric, numeric, numeric, text, numeric, date)', 'execute'), 'anon cannot sell';
  assert not has_function_privilege('authenticated', 'public._owner_view_only()', 'execute'), 'trigger helper hidden';
  -- imports and scheduled jobs (no signed-in person) still write
  insert into sales (d, location_id, n, value, list_value, cash, imported) values (biz_today() - 30, 'TUALA', 30, 450, 450, 450, true);
end $$;
select 'ALL CREDIT / OWNER TESTS PASSED' as result;
