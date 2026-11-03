-- The owner's monthly outlet workbook data (3 Nov 2026). Runs after 09.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;
select t_as('00000000-0000-0000-0000-000000000001');
do $$ declare r jsonb; x jsonb; begin
  r := rpc_month_book();
  assert (r->>'month')::date = date_trunc('month', biz_today())::date, 'this month by default';
  assert (r->>'to')::date = biz_today(), 'up to today';
  assert jsonb_array_length(r->'rows') = jsonb_array_length(r->'locations') * ((r->>'to')::date - (r->>'from')::date + 1), 'one row per outlet per day';
  select e into x from jsonb_array_elements(r->'rows') e where e->>'loc' = 'TUALA' and (e->>'d')::date = biz_today();
  assert (x->>'sold')::numeric > 0, 'today''s Tuala sales: ' || x::text;
  assert abs((x->>'e_cash')::numeric + (x->>'e_till')::numeric + (x->>'e_paybill')::numeric + (x->>'e_credit')::numeric - (x->>'sold')::numeric) < 0.001, 'modes add up to eggs sold';
  assert (x->>'cash')::numeric + (x->>'till')::numeric + (x->>'paybill')::numeric + (x->>'credit')::numeric = (x->>'value')::numeric, 'money adds up';
  assert (x->>'credit_paid')::numeric > 0, 'credit paid back shows';
  -- the book: opening + in - out = book closing
  assert (select count(*) from jsonb_array_elements(r->'rows') e where e->>'loc' = 'FARM' and (e->>'collected')::int > 0) > 0, 'farm collections count as received';
end $$;
select t_err($$select rpc_month_book(biz_today() + 40)$$, 'not started');
-- the farm manager can download it too, and save prices and thresholds
select t_as('00000000-0000-0000-0000-000000000002');
do $$ begin
  assert jsonb_array_length(rpc_month_book()->'rows') > 0, 'farm manager gets the book';
  perform rpc_save_settings('{"cash_tol": 150}'::jsonb);
  assert (select cash_tol from settings) = 150, 'farm manager saves settings';
end $$;
select t_as('00000000-0000-0000-0000-000000000003');
select t_err($$select rpc_month_book()$$, 'not available');
select t_err($$select rpc_save_settings('{"cash_tol": 1}'::jsonb)$$, 'not available');
select t_as('00000000-0000-0000-0000-000000000006');
select t_err($$select rpc_month_book()$$, 'not available');
select t_as(null);
reset role;
do $$ begin
  assert not has_function_privilege('anon', 'public.rpc_month_book(date)', 'execute'), 'anon cannot read the book';
end $$;
select 'ALL MONTH BOOK TESTS PASSED' as result;
