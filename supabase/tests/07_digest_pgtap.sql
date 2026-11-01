-- pgTAP: completeness, nudges sent once, the insight engine, scope rules and
-- the send log. Runs on its own database (dpv_facts) with fixed fixture data:
--   week 1  Mon 5 Oct to Sun 11 Oct 2026: everything entered (the baseline)
--   week 2  Mon 12 Oct to Sun 18 Oct: Rayan Fedha missed Thu 15 and Fri 16,
--           House B missed Fri 16, House A laid 70% against 90% expected,
--           a van delivery is still on the way, Tuala cash was KES 500 short,
--           Tuala wrote off 60 of 600 eggs received, Lucky Summer sold a third
--           of its usual.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
create extension if not exists pgtap;

-- capture the database's calls to edge functions instead of making them
create schema if not exists net;
create table net.calls (id bigint generated always as identity, url text, body jsonb, headers jsonb);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}',
                              timeout_milliseconds int default 5000) returns bigint
language sql as $$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $$;
grant usage on schema net to public;

-- ---------- fixture ----------
insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000a3'), ('00000000-0000-0000-0000-0000000000a4'), ('00000000-0000-0000-0000-0000000000a5');
insert into staff (id, display_name, role, location_id, email, username) values
  ('00000000-0000-0000-0000-0000000000a1', 'Owner', 'owner', null, 'owner@example.com', 'owner'),
  ('00000000-0000-0000-0000-0000000000a2', 'Farm Manager', 'manager', 'FARM', 'manager@example.com', 'manager'),
  ('00000000-0000-0000-0000-0000000000a3', 'Production Clerk', 'clerk', 'FARM', null, 'clerk'),
  ('00000000-0000-0000-0000-0000000000a4', 'Rayan Attendant', 'pos', 'RAYAN', 'rayan@example.com', 'rayan'),
  ('00000000-0000-0000-0000-0000000000a5', 'Lucky Attendant', 'pos', 'LUCKY', 'lucky@example.com', 'lucky');
update staff set digest_enabled = false where id = '00000000-0000-0000-0000-0000000000a5';   -- opted out
insert into app_secrets (key, value) values ('trigger_secret', 'test-trigger') on conflict (key) do nothing;
update settings set tracking_from = '2026-10-05', go_live = '2026-10-05', feed_buffer_bags = 50, feed_buffer_kg = 2500, bag_kg = 50,
                    lay_drop_pts = 4, break_tol = 1.5, cash_tol = 200, unbanked_max = 1000000, water_ratio_min = 1.6, water_ratio_max = 2.5,
                    tray_n = 450, push_url = 'https://proj.supabase.co/functions/v1/push-notify' where id = 1;
update houses set birds_at_start = 1000, start_date = '2026-09-01', expected_lay = 0.90, active = true where id = 'A';
update houses set birds_at_start = 800, start_date = '2026-09-01', expected_lay = 0.80, active = true where id = 'B';
update locations set closed_dow = '{1,2,3,4,5,6,7}' where id = 'FARM';   -- the farm counter does not trade in this fixture
insert into feed_moves (d, kind, kg) values ('2026-10-01', 'in', 5000);

do $$ declare d date; w2 boolean; begin
  -- four weeks of history at Lucky Summer before week 2 (30 trays a day)
  for d in select generate_series('2026-09-14'::date, '2026-10-04'::date, '1 day')::date loop
    continue when extract(isodow from d) = 7;
    insert into sales (d, location_id, n, value, list_value, cash, till, paybill, imported) values (d, 'LUCKY', 900, 13500, 13500, 0, 13500, 0, true);
  end loop;
  for d in select generate_series('2026-10-05'::date, '2026-10-18'::date, '1 day')::date loop
    w2 := d >= '2026-10-12';
    -- houses: A lays 90% in week 1, 70% in week 2; B 80%; House B missed Fri 16 Oct
    insert into egg_collections (d, house_id, n) values (d, 'A', case when w2 then 700 else 900 end);
    insert into water_logs (d, kind, house_id, litres) values (d, 'intake', 'A', 100);
    if d <> '2026-10-16' then
      insert into egg_collections (d, house_id, n) values (d, 'B', 640);
      insert into water_logs (d, kind, house_id, litres) values (d, 'intake', 'B', 90);
    end if;
    insert into feed_moves (d, kind, kg, house) values (d, 'use', 110, 'Both');
    insert into day_marks (d, kind, house_id) values (d, 'no_deaths', 'A');
    continue when extract(isodow from d) = 7;   -- outlets closed on Sunday
    -- outlets: opening count, sales, closing count; Rayan Fedha missed Thu 15 and Fri 16 Oct
    insert into stock_counts (d, location_id, kind, cnt_n, cnt_c, cnt_j, adj_n, adj_c, adj_j, recorded_by)
      select d, l, k, 0, 0, 0, 0, 0, 0, '00000000-0000-0000-0000-0000000000a1'
        from unnest(array['VAN','TUALA','LUCKY'] || case when d not in ('2026-10-15', '2026-10-16') then array['RAYAN'] else '{}'::text[] end) l,
             unnest(array['open','close']) k;
    insert into sales (d, location_id, n, value, list_value, cash, till, paybill) values
      (d, 'VAN', 300, 4500, 4500, 4500, 0, 0), (d, 'TUALA', 600, 9000, 9000, 9000, 0, 0),
      (d, 'LUCKY', case when w2 then 300 else 900 end, case when w2 then 4500 else 13500 end, case when w2 then 4500 else 13500 end, 0, case when w2 then 4500 else 13500 end, 0);
    if d not in ('2026-10-15', '2026-10-16') then
      insert into sales (d, location_id, n, value, list_value, cash, till, paybill) values (d, 'RAYAN', 450, 6750, 6750, 6750, 0, 0);
    end if;
  end loop;
  -- week 2 problems
  insert into transfers (d, from_loc, to_loc, sent_n, status, received_d, recv_n, recv_c, recv_j)
    values ('2026-10-13', 'FARM', 'TUALA', 600, 'received', '2026-10-13', 600, 0, 0);
  insert into breakages (d, location_id, item, qty, reason) values ('2026-10-14', 'TUALA', 'N', 60, 'Dropped trays');
  insert into transfers (d, from_loc, to_loc, sent_n) values ('2026-10-14', 'FARM', 'VAN', 300);
  insert into cash_counts (d, location_id, counted, expected, diff) values ('2026-10-13', 'TUALA', 8500, 9000, -500);
end $$;

select plan(50);

-- ---------- 1. completeness for one day ----------
select is((completeness('2026-10-11')->'items'->0->>'scope'), 'house', 'houses come first');
select ok(not exists (select 1 from jsonb_array_elements(completeness('2026-10-11')->'items') i
                       where i->>'scope' = 'outlet' and not (i->>'closed')::boolean), 'every outlet is closed on Sunday');
select is((select i->'missing' from jsonb_array_elements(completeness('2026-10-16')->'items') i where i->>'id' = 'B'),
          '["eggs", "water"]'::jsonb, 'House B missing eggs and water on Fri 16 Oct');
select is((select i->'missing' from jsonb_array_elements(completeness('2026-10-15')->'items') i where i->>'id' = 'RAYAN'),
          '["sales", "opening count", "closing count"]'::jsonb, 'Rayan Fedha missing everything on Thu 15 Oct');
select is((select i->>'deaths' from jsonb_array_elements(completeness('2026-10-15')->'items') i where i->>'id' = 'A'), 'none', 'House A: no deaths confirmed');
select is((select i->>'deaths' from jsonb_array_elements(completeness('2026-10-15')->'items') i where i->>'id' = 'B'), 'unconfirmed', 'House B: deaths not confirmed');
select is((select i->'expected' from jsonb_array_elements(completeness('2026-10-15')->'items') i where i->>'id' = 'FARM'), '[]'::jsonb,
          'a location closed every day expects nothing');
select ok(not (completeness('2026-10-01')->>'tracked')::boolean, 'days before tracking_from are not tracked');

-- ---------- 2. nudges are sent once ----------
select ok(_completeness_nudges('2026-10-15') > 0, 'gaps on Thu 15 Oct are nudged');
select is(_completeness_nudges('2026-10-15'), 0, 'a second run sends nothing');
select is((select count(*)::int from notifications where dedupe_key = 'gap:2026-10-15:outlet:RAYAN'), 1, 'one nudge to Rayan Fedha');
select is((select to_roles::text from notifications where dedupe_key = 'gap:2026-10-15:outlet:RAYAN'), '{pos}', 'sent to the sales point role');
select is((select location_id from notifications where dedupe_key = 'gap:2026-10-15:outlet:RAYAN'), 'RAYAN', 'at its own location');
select is((select count(*)::int from notifications where dedupe_key = 'gap-summary:2026-10-15'), 1, 'one summary to management');
select is(_completeness_nudges('2026-10-14'), 0, 'a complete day sends nothing');
select ok(_notify_once('t:1', 'info', 'x', 'y', array['owner']::staff_role[]) is not null and _notify_once('t:1', 'info', 'x', 'y', array['owner']::staff_role[]) is null,
          '_notify_once inserts once per key');

-- daily_checks: the same morning twice sends nothing new and asks for nudge emails once
delete from net.calls;
select ok(daily_checks() >= 0, 'daily_checks runs before go-live data exists for yesterday');
select is(daily_checks(), 0, 'a retry of the morning checks sends nothing');
select cmp_ok((select count(*)::int from net.calls where body->>'mode' = 'nudges'), '<=', 1, 'nudge emails requested at most once');

-- ---------- 3. week 1: the baseline ----------
select is(weekly_facts('2026-10-05', '2026-10-11', 'owner')->'baseline'->>'reason', 'first_week', 'week 1 has no prior week');
select is((weekly_facts('2026-10-05', '2026-10-11', 'owner')->'completeness'->>'pct')::int, 100, 'week 1 fully entered');
select ok(weekly_facts('2026-10-05', '2026-10-11', 'owner')->'production'->'change_pct' is null, 'no week-on-week figure for the first week');
select ok(weekly_facts('2026-10-05', '2026-10-11', 'owner')->'sales'->'change_pct' is null, 'no sales comparison for the first week');
select is((select x->>'kind' from jsonb_array_elements(weekly_facts('2026-10-05', '2026-10-11', 'owner')->'insights') x limit 1), 'baseline',
          'week 1 leads with the baseline');

-- ---------- 4. week 2: completeness first, then anomalies, at most five ----------
select is(weekly_facts('2026-10-12', '2026-10-18', 'owner')->'baseline'->>'comparable', 'true', 'week 1 is a valid comparison');
select ok(weekly_facts('2026-10-12', '2026-10-18', 'owner')->'production'->'change_pct' is not null, 'week-on-week shown when valid');
select is((weekly_facts('2026-10-12', '2026-10-18', 'owner')->'completeness'->>'entered')::int, 99, '99 records entered');
select is((weekly_facts('2026-10-12', '2026-10-18', 'owner')->'completeness'->>'expected')::int, 107, 'of 107 expected');
select is((select g->'days' from jsonb_array_elements(weekly_facts('2026-10-12', '2026-10-18', 'owner')->'completeness'->'gaps') g where g->>'id' = 'RAYAN'),
          '["Thu 15 Oct", "Fri 16 Oct"]'::jsonb, 'Rayan Fedha gaps named by day');
select is((select jsonb_agg(x->>'kind') from jsonb_array_elements(weekly_facts('2026-10-12', '2026-10-18', 'owner')->'insights') x),
          '["completeness", "lay_rate", "cash_variance", "transit", "sales_pattern"]'::jsonb, 'ranked and capped at five');
select is((select x->>'where' from jsonb_array_elements(weekly_facts('2026-10-12', '2026-10-18', 'owner')->'insights') x where x->>'kind' = 'lay_rate'),
          'House A', 'lay rate names the house');
select is((select (x->'numbers'->>'lay_pct')::numeric from jsonb_array_elements(weekly_facts('2026-10-12', '2026-10-18', 'owner')->'insights') x where x->>'kind' = 'lay_rate'),
          70.0, 'House A laid 70%');
select ok(not exists (select 1 from jsonb_array_elements(weekly_facts('2026-10-12', '2026-10-18', 'owner')->'insights') x
                       where coalesce(x->>'action', '') = '' or coalesce(x->>'where', '') = ''), 'every insight has an action and a place');
select ok(not exists (select 1 from jsonb_array_elements(weekly_facts('2026-10-12', '2026-10-18', 'owner')->'insights') x
                       where x->>'text' ~ '(n/a|—|!)'), 'no n/a, em dashes or exclamation marks');
select is((select (o->>'change_pct')::numeric from jsonb_array_elements(weekly_facts('2026-10-12', '2026-10-18', 'owner')->'sales'->'outlets') o where o->>'id' = 'LUCKY'),
          -66.7, 'Lucky Summer against its own pattern');

-- ---------- 5. scope ----------
select ok(weekly_facts('2026-10-12', '2026-10-18', 'pos', 'RAYAN')->'money' is null, 'a sales point gets no money figures');
select ok(weekly_facts('2026-10-12', '2026-10-18', 'pos', 'RAYAN')->'production' is null, 'nor farm production');
select is((select jsonb_agg(o->>'id') from jsonb_array_elements(weekly_facts('2026-10-12', '2026-10-18', 'pos', 'RAYAN')->'sales'->'outlets') o),
          '["RAYAN"]'::jsonb, 'only its own outlet');
select is(weekly_facts('2026-10-12', '2026-10-18', 'pos', 'RAYAN')->>'provisional', 'true', 'Rayan Fedha''s own week is provisional (12 of 18)');
select ok(not exists (select 1 from jsonb_array_elements(digest_entries('2026-10-12', '2026-10-18', 'pos', 'RAYAN')->'sheets') s
                       where s->>'name' in ('Money', 'Cash counts', 'Eggs collected', 'Feed')), 'no money or farm sheets for a sales point');
select ok(not ((select s->'columns' from jsonb_array_elements(digest_entries('2026-10-12', '2026-10-18', 'pos', 'RAYAN')->'sheets') s where s->>'name' = 'Sales') ? 'Cash'),
          'sales sheet without the cash column');
select ok(weekly_facts('2026-10-12', '2026-10-18', 'clerk', 'FARM')->'sales' is null and weekly_facts('2026-10-12', '2026-10-18', 'clerk', 'FARM')->'production' is not null,
          'the clerk gets the farm, not outlet sales');
select ok(weekly_facts('2026-10-12', '2026-10-18', 'manager', 'FARM')->'money' is not null, 'the manager gets money, as on the Money screen');

-- ---------- 6. the send log and the queue ----------
select ok(mail_claim('digest', '00000000-0000-0000-0000-0000000000a1', '2026-10-12') is not null
          and mail_claim('digest', '00000000-0000-0000-0000-0000000000a1', '2026-10-12') is null, 'one worker per person and week');
delete from net.calls;
select is(digest_enqueue('2026-10-12'), 2, 'queued for the manager and Rayan; owner already in progress; no email or opted out skipped');

-- ---------- 7. privileges: the engine and the send log are for the edge function only ----------
select ok(not has_function_privilege('authenticated', 'public.weekly_facts(date, date, public.staff_role, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.digest_entries(date, date, public.staff_role, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.completeness(date)', 'execute'), 'signed-in users cannot call the engine directly');
select ok(not has_function_privilege('authenticated', 'public.mail_claim(text, uuid, date)', 'execute')
          and not has_function_privilege('authenticated', 'public.digest_enqueue(date)', 'execute')
          and not has_function_privilege('authenticated', 'public._notify_once(text, text, text, text, public.staff_role[], text, text)', 'execute'),
          'nor the send log, the queue or the alert writer');
select ok(has_function_privilege('authenticated', 'public.gaps(integer)', 'execute')
          and has_function_privilege('authenticated', 'public.rpc_mark_day(text, text, text, date, boolean)', 'execute'), 'gaps and day marks are callable');
select ok(not has_function_privilege('anon', 'public.gaps(integer)', 'execute') and not has_function_privilege('anon', 'public.rpc_mark_day(text, text, text, date, boolean)', 'execute'),
          'anonymous users can call none of it');
select ok(not has_table_privilege('authenticated', 'public.digest_log', 'select') and not has_table_privilege('authenticated', 'public.day_marks', 'insert'),
          'logs hidden, marks only through rpc_mark_day');

select * from finish();
