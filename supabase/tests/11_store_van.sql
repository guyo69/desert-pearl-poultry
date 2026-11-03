-- The inventory clerk's store, the production clerk's confirmations, and the
-- mobile van with no counts (3 Nov 2026). Runs after 10_month_book.sql.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
insert into auth.users (id) values ('00000000-0000-0000-0000-000000000009');
insert into public.staff (id, display_name, role, location_id, must_change_password)
  values ('00000000-0000-0000-0000-000000000009', 'Inventory Clerk', 'store', 'FARM', false);
insert into auth.sessions (user_id) values ('00000000-0000-0000-0000-000000000009');
set role authenticated;

-- ---------- 1. the store ----------
select t_as('00000000-0000-0000-0000-000000000009');
do $$ declare f0 numeric; r jsonb; m bigint; s bigint; d jsonb; begin
  f0 := (select coalesce(sum(kg), 0) from v_feed_lines);
  r := rpc_store('feed_in', '{"bags": 10}');
  assert (select coalesce(sum(kg), 0) from v_feed_lines) = f0 + 10 * (select bag_kg from settings), 'feed received, quantity only';
  assert (select money_move_id is null and cost is null from feed_moves order by id desc limit 1), 'no money moves for the store';
  r := rpc_store('feed_issue', '{"house": "A", "kg": 50, "note": "Morning feed"}');
  assert (select coalesce(sum(kg), 0) from v_feed_lines) = f0 + 10 * (select bag_kg from settings) - 50, 'issue takes it out of the store';
  d := dashboard();
  assert exists (select 1 from jsonb_array_elements(d->'store_pending') x where x->>'kind' = 'feed' and (x->>'qty')::numeric = 50 and x->>'house_id' = 'A'), 'waits for the production clerk';
  r := rpc_store('med_new', '{"name": "Newcastle vaccine", "category": "Vaccine", "unit": "doses", "qty": 1000, "reorder": 200}');
  m := (r->>'id')::bigint;
  r := rpc_store('med_issue', jsonb_build_object('medicine', m, 'house', 'B', 'qty', 300));
  assert (r->>'stock')::numeric = 700, 'medicine stock goes down';
  r := rpc_store('supply_new', '{"name": "Egg trays", "category": "Packaging", "unit": "trays", "qty": 500, "reorder": 100}');
  s := (r->>'id')::bigint;
  r := rpc_store('supply_out', jsonb_build_object('supply', s, 'qty', 120, 'purpose', 'Tuala Egg Shop'));
  assert (r->>'stock')::numeric = 380, 'supplies go out';
  assert exists (select 1 from jsonb_array_elements(dashboard()->'supplies') x where x->>'name' = 'Egg trays' and (x->>'stock')::numeric = 380), 'supplies on the dashboard';
  assert exists (select 1 from activity(50) a where a.kind = 'supply'), 'supplies in the activity log';
end $$;
select t_err($$select rpc_store('supply_out', jsonb_build_object('supply', (select id from supplies where name = 'Egg trays'), 'qty', 9999, 'purpose', 'x'))$$, 'only');
select t_err($$select rpc_store('supply_out', jsonb_build_object('supply', (select id from supplies where name = 'Egg trays'), 'qty', 1))$$, 'issued for');
select t_err($$select rpc_store('feed_issue', '{"kg": 5}')$$, 'choose the house');
select t_err($$select rpc_store('feed_in', '{"bags": 1}', biz_today() - 3)$$, 'earlier day');        -- only the owner or farm manager back-dates
select t_err($$select rpc_collect_eggs('A', 30, 0, 0, 0, 0)$$, 'not available');                     -- the store does not record production
select t_err($$select rpc_confirm_issue('feed', (select max(id) from feed_moves), 50)$$, 'not available');
select rpc_mark_read(array(select id from notifications));                                            -- notifications work for the new role

-- ---------- 2. the production clerk confirms ----------
select t_as('00000000-0000-0000-0000-000000000003');
do $$ declare r jsonb; f bigint := (select max(id) from feed_moves where need_confirm); m bigint := (select max(id) from med_moves where need_confirm); n0 int; begin
  select count(*) into n0 from notifications;
  r := rpc_confirm_issue('feed', f, 50);
  assert (r->>'short')::numeric = 0, 'full feed received';
  r := rpc_confirm_issue('med', m, 280, 'Some spilled');
  assert (r->>'short')::numeric = 20, 'shortfall worked out';
  assert jsonb_array_length(dashboard()->'store_pending') = 0, 'nothing left to confirm';
  assert exists (select 1 from activity(50) a where a.kind = 'confirm'), 'confirmations in the activity log';
end $$;
select t_err($$select rpc_confirm_issue('feed', (select max(id) from feed_moves where need_confirm), 50)$$, 'not waiting');
select t_err($$select rpc_store('feed_in', '{"bags": 1}')$$, 'not available');                        -- the production clerk does not run the store

-- ---------- 3. the van: no counts, empty at day end ----------
reset role;
do $$ declare c jsonb; v jsonb; begin
  -- since 3 Nov 2026 only reminders are sent: the shortfall shows in the activity log and the confirmation, not as a notification
  assert not exists (select 1 from notifications where title like 'House B received 280 doses%'), 'no event notifications';
  assert exists (select 1 from issue_confirms where received = 280 and issued = 300), 'the shortfall is on record';
  assert (select kind from locations where id = 'VAN') = 'van', 'the van is a van';
  c := completeness(biz_today());
  select i into v from jsonb_array_elements(c->'items') i where i->>'id' = 'VAN';
  assert not (v->'expected') ? 'opening count', 'no opening or closing count for the van: ' || v::text;
  if (v->>'on_board')::int > 0 and not (v->>'closed')::boolean then
    assert v->'missing' ? 'eggs left on the van', 'eggs left on board are flagged';
  end if;
  assert exists (select 1 from jsonb_array_elements(c->'items') i where i->>'id' = 'TUALA' and i->'expected' ? 'opening count'), 'shops still count';
end $$;
set role authenticated;

select t_as(null);
reset role;
do $$ begin
  assert not has_function_privilege('anon', 'public.rpc_store(text, jsonb, date)', 'execute'), 'anon cannot use the store';
  assert not has_function_privilege('anon', 'public.rpc_confirm_issue(text, bigint, numeric, text)', 'execute'), 'anon cannot confirm';
  assert not has_function_privilege('authenticated', 'public.completeness(date)', 'execute'), 'completeness stays internal';
  assert (select count(*) from pg_trigger where tgname = 'owner_view_only') >= 16, 'owner view-only covers the store tables';
end $$;
select 'ALL STORE / VAN TESTS PASSED' as result;
