-- Problems seen on phones (16 Nov 2026). Runs after 17_queued.sql.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;
select t_as('00000000-0000-0000-0000-000000000006');   -- Tuala attendant
do $$ declare n int; begin
  n := rpc_log_client('[{"kind":"error","screen":"today","message":"TypeError: x is undefined for 0712345678 jane@example.com 1234567","detail":"at f (index.js:1:2)","app":"8920ab0","device":"Android"},
                        {"kind":"slow","screen":"today","message":"Slow tap","metric":812,"device":"Android"},
                        {"kind":"nonsense","message":"x"},{"kind":"error","message":"  "},
                        {"kind":"error","screen":"<script>","message":"Bad screen name","device":"Nokia"}]');
  assert n = 3, 'kept the three valid notes: ' || n;
end $$;
select t_err($$select rpc_client_errors()$$, 'not available');      -- attendants cannot read them
select t_as('00000000-0000-0000-0000-000000000002');                  -- farm manager
do $$ declare r record; begin
  select * into r from rpc_client_errors() where kind = 'error' and screen = 'today';
  assert r.message not like '%0712345678%' and r.message not like '%jane@%' and r.message not like '%1234567%', 'personal details blanked: ' || r.message;
  assert r.people = 1 and r.roles = array['pos'], 'who and which role';
  select * into r from rpc_client_errors() where kind = 'slow';
  assert r.slowest = 812, 'the measured time';
  select * into r from rpc_client_errors() where message = 'Bad screen name';
  assert r.screen is null and r.devices = array['other'], 'odd screen and device names are not kept';
end $$;
-- at most 30 an hour per person
select t_as('00000000-0000-0000-0000-000000000003');
do $$ declare i int; t int := 0; begin
  for i in 1..5 loop t := t + rpc_log_client((select jsonb_agg(jsonb_build_object('kind','error','message','Loop '||g)) from generate_series(1,10) g)); end loop;
  assert t = 30, 'capped at 30 an hour: ' || t;
end $$;
select t_as(null);
reset role;
do $$ begin
  assert not has_function_privilege('anon', 'public.rpc_log_client(jsonb)', 'execute'), 'anon cannot log';
  assert not has_table_privilege('authenticated', 'public.client_errors', 'select'), 'notes are not readable directly';
end $$;
select 'ALL CLIENT ERROR TESTS PASSED' as result;
