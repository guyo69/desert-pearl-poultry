-- Tank level after water drunk, credit paid, activity by record date, and the
-- farm manager entering a skipped day (3 Nov 2026). Runs after 08_credit_owner.sql.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
update houses set start_date = least(start_date, biz_today() - 90);
set role authenticated;

-- ---------- 1. water drunk brings the tank down ----------
select t_as('00000000-0000-0000-0000-000000000003');   -- production clerk
-- separate statements: each is its own moment, as on the phones
select rpc_water('tank', 900);
do $$ begin assert (dashboard()->'tank'->>'litres')::numeric = 900, 'level is the reading right after it'; end $$;
select rpc_water('intake', 150, 'A');
select rpc_water('intake', 100, 'B');
do $$ declare d1 jsonb := dashboard(); begin
  assert (d1->'tank'->>'litres')::numeric = 650, 'water drunk comes off the level: ' || (d1->'tank')::text;
  assert (d1->'tank'->>'reading')::numeric = 900, 'the reading itself is kept';
  assert (d1->'tank'->>'drunk_since')::numeric = 250, 'drunk since the reading';
end $$;
select rpc_water('intake', 2000, 'A');
do $$ begin assert (dashboard()->'tank'->>'litres')::numeric = 0, 'never below empty'; end $$;
select rpc_water('tank', 1000);                         -- refilled: a new reading resets it
do $$ begin assert (dashboard()->'tank'->>'litres')::numeric = 1000, 'a new reading resets the level'; end $$;
reset role;
do $$ begin assert _tank() = 1000, '_tank follows the same rule'; end $$;
set role authenticated;

-- ---------- 2. credit paid ----------
select t_as('00000000-0000-0000-0000-000000000006');   -- Tuala attendant
do $$ declare tray numeric := (select tray_n from settings); c0 numeric; t0 numeric; r jsonb; d jsonb; o jsonb; begin
  perform rpc_sale_with_credit('TUALA', 30, 0, 0, 0, 0, 0, tray, 'Mama Wanjiku');
  perform rpc_sale_with_credit('TUALA', 30, 0, 0, 100, 0, 0, tray - 100, ' mama wanjiku ');
  d := dashboard();
  select x into o from jsonb_array_elements(d->'credits') x where lower(trim(x->>'customer')) = 'mama wanjiku';
  assert (o->>'owed')::numeric = 2 * tray - 100, 'owed across both sales: ' || coalesce(o::text, 'none');
  assert (o->>'sales')::int = 2, 'two open sales';
  c0 := (select balance from v_balances where account_id = 'CASH:TUALA');
  t0 := (select balance from v_balances where account_id = 'TILL');
  r := rpc_credit_paid('TUALA', 'MAMA WANJIKU', tray + 50, 'cash');
  assert (r->>'still_owed')::numeric = tray - 150, 'still owed after part payment: ' || r::text;
  assert (select balance from v_balances where account_id = 'CASH:TUALA') = c0 + tray + 50, 'the payment reaches the drawer';
  assert (select count(*) from credit_payments where lower(customer) like '%wanjiku%') = 2, 'oldest sale first, then the next';
  r := rpc_credit_paid('TUALA', 'Mama Wanjiku', tray - 150, 'till');
  assert (r->>'still_owed')::numeric = 0, 'paid up';
  assert (select balance from v_balances where account_id = 'TILL') = t0 + tray - 150, 'Till payment reaches the Till';
  assert not exists (select 1 from jsonb_array_elements(dashboard()->'credits') x where lower(trim(x->>'customer')) = 'mama wanjiku'), 'gone from outstanding when paid';
  assert exists (select 1 from activity(50) a where a.kind = 'credit'), 'credit payments in the activity log';
  assert exists (select 1 from jsonb_array_elements(dashboard()->'money_daily') x where x->>'kind' = 'credit_paid'), 'money lines carry credit paid';
  assert (select sum((x->>'credit')::numeric) from jsonb_array_elements(dashboard()->'sales_daily') x) >= 2 * tray - 100, 'sales_daily carries credit';
end $$;
select t_err($$select rpc_credit_paid('TUALA', 'Mama Wanjiku', 10, 'cash')$$, 'no credit to pay');
select t_err($$select rpc_credit_paid('TUALA', 'Nobody', 10, 'cash')$$, 'no credit to pay');
select t_err($$select rpc_credit_paid('TUALA', 'Mama Wanjiku', 10, 'card')$$, 'how the customer paid');
select t_err($$select rpc_credit_paid('RAYAN', 'Mama Wanjiku', 10, 'cash')$$, 'own location');
do $$ begin
  perform rpc_sale_with_credit('TUALA', 30, 0, 0, 0, 0, 0, (select tray_n from settings), 'Hotel Baraka');
end $$;
select t_err($$select rpc_credit_paid('TUALA', 'Hotel Baraka', 999999, 'cash')$$, 'or less');
-- another outlet's attendant does not see Tuala's credits
select t_as('00000000-0000-0000-0000-000000000007');
do $$ begin
  assert not exists (select 1 from jsonb_array_elements(dashboard()->'credits') x where x->>'location_id' = 'TUALA'), 'credits scoped to own outlet';
end $$;
-- the owner sees all, and cannot record a payment
select t_as('00000000-0000-0000-0000-000000000001');
do $$ begin
  assert exists (select 1 from jsonb_array_elements(dashboard()->'credits') x where x->>'customer' = 'Hotel Baraka'), 'owner sees outstanding credits';
end $$;
select t_err($$select rpc_credit_paid('TUALA', 'Hotel Baraka', 10, 'cash')$$, 'not available');
-- the farm manager records a payment for any outlet
select t_as('00000000-0000-0000-0000-000000000002');
do $$ declare r jsonb; begin
  r := rpc_credit_paid('TUALA', 'hotel baraka', 100, 'paybill', biz_today() - 1, 'Paid on Monday');
  assert (select d from credit_payments order by id desc limit 1) = biz_today() - 1, 'a payment can be for an earlier day';
end $$;

-- ---------- 3. activity by the day a record is for ----------
do $$ declare a record; prev date := null; n int := 0; last jsonb; nxt record; begin
  perform rpc_farm_record_on(biz_today() - 40, 'deaths', '{"house":"A","birds":2,"cause":"Unknown"}');
  for a in select * from activity(500) loop
    if prev is not null then assert a.d <= prev, 'newest day first'; end if;
    prev := a.d; n := n + 1;
  end loop;
  assert n > 10, 'activity rows';
  -- a back-dated record entered just now sorts by its own day, not at the top
  assert (select x.d from activity(1) x) >= biz_today() - 1, 'top row is recent by date';
  -- paging carries on after the last row shown
  select * into nxt from activity(5) offset 4 limit 1;
  last := jsonb_build_object('d', nxt.d, 'at', nxt.recorded_at, 'k', nxt.kind, 'id', nxt.id);
  assert (select count(*) from activity(5, null, null, null, last) x where x.kind = nxt.kind and x.id = nxt.id) = 0, 'next page excludes the cursor row';
  assert (select max(x.d) from activity(5, null, null, null, last) x) <= nxt.d, 'next page is older or the same day';
end $$;

-- ---------- 4. skipped days on the farm ----------
do $$ declare h0 int; f0 numeric; begin
  f0 := (select coalesce(sum(kg), 0) from v_feed_lines);
  perform rpc_farm_record_on(biz_today() - 60, 'feed_use', '{"kg":50,"house":"House A","note":"From the book"}');
  assert (select coalesce(sum(kg), 0) from v_feed_lines) = f0 - 50, 'feed store goes down';
  perform rpc_farm_record_on(biz_today() - 60, 'water', '{"house":"A","litres":120}');
  assert exists (select 1 from water_logs where d = biz_today() - 60 and litres = 120), 'water on that day';
  assert (dashboard()->'tank'->>'litres')::numeric = 1000, 'water drunk before the last reading does not move the level';
  perform rpc_farm_record_on(biz_today() - 59, 'med', jsonb_build_object('medicine', (select id from medicines order by id limit 1), 'move', 'in', 'qty', 5));
  assert exists (select 1 from mortality where d = biz_today() - 40 and birds = 2), 'deaths on that day';
end $$;
select t_err($$select rpc_farm_record_on(biz_today() - 63, 'water', '{"house":"A","litres":10}')$$, '62 days');
select t_err($$select rpc_farm_record_on(biz_today(), 'water', '{"house":"A","litres":10}')$$, 'earlier day');
select t_err($$select rpc_farm_record_on(biz_today() - 2, 'water', '{"house":"A","litres":0}')$$, 'litres');
select t_err($$select rpc_farm_record_on(biz_today() - 2, 'eggs', '{}')$$, 'Unknown farm record');
select t_as('00000000-0000-0000-0000-000000000003');
select t_err($$select rpc_farm_record_on(biz_today() - 2, 'water', '{"house":"A","litres":10}')$$, 'not available');
select t_as(null);
reset role;
do $$ begin
  assert not has_function_privilege('anon', 'public.rpc_credit_paid(text, text, numeric, text, date, text)', 'execute'), 'anon cannot record payments';
  assert not has_function_privilege('anon', 'public.rpc_farm_record_on(date, text, jsonb)', 'execute'), 'anon cannot back-fill';
  assert not has_function_privilege('authenticated', 'public._credit_open(text, text)', 'execute'), 'helper hidden';
  assert not has_function_privilege('authenticated', 'public._tank()', 'execute'), 'tank helper hidden';
  assert exists (select 1 from pg_trigger where tgname = 'owner_view_only' and tgrelid = 'public.credit_payments'::regclass), 'owner view-only on credit payments';
end $$;
select 'ALL TANK / CREDIT / ACTIVITY / BACKFILL TESTS PASSED' as result;
