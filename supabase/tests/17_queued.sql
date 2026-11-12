-- Entries sent from a phone that was offline (12 Nov 2026). Runs after 16_tips.sql.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;
select t_as('00000000-0000-0000-0000-000000000006');   -- Tuala attendant
do $$ declare k uuid := gen_random_uuid(); r1 jsonb; r2 jsonb; n0 int; n1 int; b0 numeric; b1 numeric; begin
  n0 := (select count(*) from cash_counts where location_id = 'TUALA');
  b0 := (select balance from v_balances where account_id = 'CASH:TUALA');
  r1 := rpc_queued(k, 'rpc_cash_count', jsonb_build_object('p_loc', 'TUALA', 'p_counted', b0 - 50), now() - interval '20 minutes');
  r2 := rpc_queued(k, 'rpc_cash_count', jsonb_build_object('p_loc', 'TUALA', 'p_counted', b0 - 50), now() - interval '20 minutes');
  n1 := (select count(*) from cash_counts where location_id = 'TUALA');
  assert n1 = n0 + 1, 'sent twice, recorded once: ' || n0 || ' -> ' || n1;
  assert r1 = r2, 'the second send gets the same answer';
  assert (r1->>'diff')::numeric = -50, 'the answer is the action''s own: ' || r1::text;
  perform set_config('t.k', k::text, false);
end $$;
-- a sale through the outbox: arguments by name, numbers and text cast to the action's types
do $$ declare k uuid := gen_random_uuid(); r jsonb; s0 int; begin
  s0 := (select count(*) from sales where location_id = 'TUALA');
  r := rpc_queued(k, 'rpc_sale_with_credit', jsonb_build_object('p_loc','TUALA','p_n',30,'p_j',0,'p_c',0,'p_cash',(select tray_n from settings),'p_till',0,'p_paybill',0,'p_credit',0));
  assert (select count(*) from sales where location_id = 'TUALA') = s0 + 1, 'the sale is recorded';
  perform rpc_queued(k, 'rpc_sale_with_credit', jsonb_build_object('p_loc','TUALA','p_n',30,'p_j',0,'p_c',0,'p_cash',(select tray_n from settings),'p_till',0,'p_paybill',0,'p_credit',0));
  assert (select count(*) from sales where location_id = 'TUALA') = s0 + 1, 'and only once';
end $$;
-- jsonb arguments pass through as they are (the inventory clerk's store)
select t_as('00000000-0000-0000-0000-000000000009');
do $$ declare r jsonb; f0 numeric; begin
  f0 := (select coalesce(sum(case kind when 'in' then kg else 0 end), 0) from feed_moves);
  r := rpc_queued(gen_random_uuid(), 'rpc_store', '{"p_action":"feed_in","p":{"bags":2}}');
  assert (select coalesce(sum(case kind when 'in' then kg else 0 end), 0) from feed_moves) > f0, 'feed received through the outbox: ' || r::text;
end $$;
select t_as('00000000-0000-0000-0000-000000000006');
-- a rejected entry leaves no key behind, so it can be fixed and sent again
select t_err($$select rpc_queued('11111111-1111-1111-1111-111111111111', 'rpc_sale_with_credit', '{"p_loc":"TUALA","p_n":30,"p_j":0,"p_c":0,"p_cash":1,"p_till":0,"p_paybill":0,"p_credit":0}')$$, 'must equal');
-- the usual role checks still apply inside
select t_err($$select rpc_queued(gen_random_uuid(), 'rpc_cash_count', '{"p_loc":"RAYAN","p_counted":5}')$$, 'location');
-- only everyday entries, only known fields
select t_err($$select rpc_queued(gen_random_uuid(), 'rpc_save_settings', '{}')$$, 'cannot be sent');
select t_err($$select rpc_queued(gen_random_uuid(), 'rpc_cash_count', '{"p_loc":"TUALA","p_counted":5,"p_evil":1}')$$, 'not valid');
select t_err($$select rpc_queued(gen_random_uuid(), 'rpc_cash_count', '{"p_loc":"TUALA","p_counted":5}', now() - interval '9 days')$$, 'more than a week');
-- someone else cannot reuse a key
select t_as('00000000-0000-0000-0000-000000000007');
select t_err($$select rpc_queued(current_setting('t.k')::uuid, 'rpc_cash_count', '{"p_loc":"RAYAN","p_counted":5}')$$, 'not valid');
-- the owner stays view-only
select t_as('00000000-0000-0000-0000-000000000001');
select t_err($$select rpc_queued(gen_random_uuid(), 'rpc_cash_count', '{"p_loc":"TUALA","p_counted":5}')$$, 'not available');
select t_as(null);
reset role;
do $$ begin
  assert not has_function_privilege('anon', 'public.rpc_queued(uuid, text, jsonb, timestamptz)', 'execute'), 'anon cannot';
  assert not has_table_privilege('authenticated', 'public.client_ops', 'select'), 'the keys are not readable directly';
  assert not exists (select 1 from client_ops where key = '11111111-1111-1111-1111-111111111111'), 'no key kept for a rejected entry';
  assert (select made_at < now() - interval '19 minutes' from client_ops where key = current_setting('t.k')::uuid), 'keeps when it was made on the phone';
end $$;
select 'ALL QUEUED TESTS PASSED' as result;
