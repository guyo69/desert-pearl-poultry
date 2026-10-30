-- Session gate, privileges, rate limiting and lockout.
-- Runs after 01_flows.sql on the same database.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
reset role;

create function public.t_sess(p_uid uuid) returns uuid language sql as $$
  insert into auth.sessions (user_id) values (p_uid) returning id
$$;
create function public.t_claims(p_uid uuid, p_sid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'session_id', p_sid)::text, false)
$$;
grant execute on function public.t_claims(uuid, uuid) to authenticated;

-- ---------- privileges ----------
do $$ declare bad text; begin
  -- anon can run nothing in public
  select string_agg(p.oid::regprocedure::text, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') and p.proname not like 't\_%';
  assert bad is null, 'anon can execute: ' || bad;
  -- authenticated cannot run internal helpers or service-only auth functions
  select string_agg(p.oid::regprocedure::text, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute') and p.proname not like 't\_%'
     and (p.proname like '\_%' and p.proname not in ('_me_json', '_staff_list')
          or p.proname in ('auth_check', 'auth_record', 'auth_state', 'auth_end_sessions', 'auth_unlock',
                           'auth_redeem_challenge', 'daily_checks', 'staff_directory'));
  assert bad is null, 'authenticated can execute: ' || bad;
  -- every write function checks the caller
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'rpc\_%' and p.prosrc not like '%\_require(%';
  assert bad is null, 'rpc without _require: ' || bad;
  -- no app role can read the security tables or write any table
  select string_agg(c.relname, ', ') into bad from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
          or has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update')
          or has_table_privilege('authenticated', c.oid, 'delete')
          or (c.relname in ('app_secrets','auth_counters','auth_events','mfa_factors','mfa_backup_codes','mfa_sessions','auth_challenges_used')
              and has_table_privilege('authenticated', c.oid, 'select')));
  assert bad is null, 'table privileges too wide: ' || bad;
  assert not has_column_privilege('authenticated', 'public.staff', 'must_change_password', 'select'), 'staff security columns readable';
  assert not has_column_privilege('authenticated', 'public.staff', 'username', 'select'), 'usernames readable';
  assert has_column_privilege('authenticated', 'public.staff', 'display_name', 'select'), 'names readable';
  -- every security table has row level security on
  select string_agg(c.relname, ', ') into bad from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  assert bad is null, 'tables without RLS: ' || bad;
end $$;

-- ---------- usernames ----------
do $$ begin
  assert (select count(distinct username) from staff) = 8, 'usernames unique';
  assert (select username from staff where id = '00000000-0000-0000-0000-000000000006') = 'tuala', 'pos username from location';
end $$;

-- ---------- session gate ----------
-- the clerk (no 2FA needed) with a fresh session
do $$ declare c uuid := '00000000-0000-0000-0000-000000000003'; s uuid := t_sess(c); begin
  assert _session_state(c, s) = 'ready', 'clerk ready';
  assert _session_state(c, null) = 'none', 'no session id';
  assert _session_state(c, gen_random_uuid()) = 'none', 'unknown session';
  assert _session_state('00000000-0000-0000-0000-000000000004', s) = 'none', 'session of another user';
  update staff set must_change_password = true, temp_expires_at = now() + interval '1 hour' where id = c;
  assert _session_state(c, s) = 'set_password', 'temporary password';
  update staff set temp_expires_at = now() - interval '1 minute' where id = c;
  assert _session_state(c, s) = 'temp_expired', 'temporary password expired';
  update staff set must_change_password = false, temp_expires_at = null where id = c;
  update auth.sessions set created_at = now() - interval '13 hours' where id = s;
  assert _session_state(c, s) = 'expired', '12 h absolute session limit';
  update auth.sessions set created_at = now() where id = s;
  perform auth_end_sessions(c, s);
  assert _session_state(c, s) = 'expired', 'signed out session';
  update staff set active = false where id = c;
  assert _session_state(c, s) = 'inactive', 'disabled account';
  update staff set active = true where id = c;
end $$;

-- manager: password ok but no 2FA yet -> must enrol; enrolled -> must verify in this session
do $$ declare m uuid := '00000000-0000-0000-0000-000000000002'; s uuid := t_sess(m); s2 uuid := t_sess(m); s3 uuid := t_sess(m); begin
  assert _session_state(m, s) = 'mfa_verify', 'manager new session needs code';
  insert into mfa_sessions (session_id, staff_id) values (s, m);
  assert _session_state(m, s) = 'ready', 'manager verified';
  update mfa_factors set confirmed_at = null where staff_id = m;
  assert _session_state(m, s2) = 'mfa_enroll', 'manager without factor must enrol';
  update mfa_factors set confirmed_at = now() where staff_id = m;
  -- MFA comes before the temporary-password step, so a reset password alone is not enough
  update staff set must_change_password = true, temp_expires_at = now() + interval '1 hour' where id = m;
  assert _session_state(m, s3) = 'mfa_verify', 'code before password change';
  assert _session_state(m, s) = 'set_password', 'verified session must change password';
  update staff set must_change_password = false, temp_expires_at = null where id = m;
end $$;

-- the gate applies to the API as the app sees it
set role authenticated;
reset role;
create temp table t_s as select t_sess('00000000-0000-0000-0000-000000000002') id;
grant select on t_s to authenticated;
set role authenticated;
select t_claims('00000000-0000-0000-0000-000000000002', (select id from t_s));
select t_err($$select dashboard(30)$$, 'AUTH_MFA');
select t_err($$select rpc_collect('A', 1)$$, 'AUTH_MFA');
select t_err($$select * from activity(5)$$, 'AUTH_MFA');
do $$ begin
  assert (select count(*) from sales) = 0, 'restricted session sees no sales';
  assert (select count(*) from money_moves) = 0, 'restricted session sees no money';
  assert (select count(*) from staff) = 0, 'restricted session sees no staff';
end $$;
select t_err($$select security_log()$$, 'AUTH_MFA');
select t_err($$select auth_check('login', '1.1.1.1', 'x')$$, 'permission denied');
select t_err($$select * from auth_events$$, 'permission denied');
select t_err($$select username from staff$$, 'permission denied');
select t_as('00000000-0000-0000-0000-000000000005');   -- van, normal session
do $$ declare d jsonb := dashboard(10); begin
  assert d->'me'->>'username' = 'van', 'me username';
  assert (d->'me'->>'mfa_required')::boolean = false, 'pos 2FA optional';
  assert d->'staff'->0->'username' is null, 'non-managers do not get usernames';
end $$;
select t_err($$select security_log()$$, 'not available');
select t_as('00000000-0000-0000-0000-000000000001');   -- owner, verified
do $$ declare d jsonb := dashboard(10); begin
  assert (d->'me'->>'mfa_required')::boolean, 'owner 2FA required';
  assert d->'staff'->0->>'username' is not null, 'owner sees usernames';
end $$;
reset role;

-- ---------- rate limiting ----------
do $$ declare r jsonb; i int; begin
  -- account: backoff after each failure, lockout after 5, captcha after 3
  for i in 1..4 loop
    r := auth_check('login', '10.0.0.' || i, 'Production-Clerk');
    assert (r->>'allowed')::boolean, 'attempt ' || i || ' allowed: ' || r;
    perform auth_record('login', '10.0.0.' || i, 'production-clerk', false, 'bad_password', null, null, 'test');
    update auth_counters set last_fail = now() - interval '2 minutes' where key = 'sub:login:production-clerk';  -- skip the backoff wait
  end loop;
  r := auth_check('login', '10.0.0.9', 'production-clerk');
  assert (r->>'captcha')::boolean, 'captcha after 3 failures';
  r := auth_record('login', '10.0.0.9', 'production-clerk', false, 'bad_password');
  assert (r->>'locked_for')::int between 899 and 900, 'locked 15 min: ' || r;
  r := auth_check('login', '10.0.0.10', 'production-clerk');
  assert not (r->>'allowed')::boolean and r->>'reason' = 'account_locked', 'locked account refused';
  -- the lockout doubles next time
  update auth_counters set locked_until = now() - interval '1 second', last_fail = now() - interval '2 minutes' where key = 'sub:login:production-clerk';
  r := auth_record('login', '10.0.0.11', 'production-clerk', false, 'bad_password');
  assert (r->>'locked_for')::int between 1799 and 1800, 'second lockout 30 min: ' || r;
  -- owner unlock
  perform auth_unlock('00000000-0000-0000-0000-000000000003');
  r := auth_check('login', '10.0.0.12', 'production-clerk');
  assert (r->>'allowed')::boolean, 'unlocked';

  -- backoff
  perform auth_record('login', '10.0.1.1', 'van', false, 'bad_password');
  perform auth_record('login', '10.0.1.1', 'van', false, 'bad_password');
  r := auth_check('login', '10.0.1.2', 'van');
  assert r->>'reason' = 'backoff' and (r->>'retry_after')::int <= 2, 'exponential backoff: ' || r;

  -- IP: 5 failures in 15 minutes, across different usernames
  for i in 1..5 loop perform auth_record('login', '10.9.9.9', 'nobody' || i, false, 'unknown_user'); end loop;
  r := auth_check('login', '10.9.9.9', 'someone-else');
  assert not (r->>'allowed')::boolean and r->>'reason' = 'ip_locked', 'ip limit: ' || r;
  r := auth_check('otp', '10.9.9.9', null);
  assert (r->>'allowed')::boolean, 'limits are per action';
  -- success clears the account counter but not the IP counter
  perform auth_record('login', '10.0.2.1', 'rayan', false, 'bad_password');
  perform auth_record('login', '10.0.2.1', 'rayan', true, 'ok');
  assert (select fails from auth_counters where key = 'sub:login:rayan') = 0, 'success resets account';
  assert (select fails from auth_counters where key = 'ip:login:10.0.2.1') = 1, 'success keeps ip failures';
  -- every attempt is logged
  assert (select count(*) from auth_events where kind = 'login') >= 15, 'events logged';
  -- challenges are single use
  assert auth_redeem_challenge('abc', now() + interval '2 minutes'), 'first redeem';
  assert not auth_redeem_challenge('abc', now() + interval '2 minutes'), 'replay refused';
end $$;

select 'ALL AUTH TESTS PASSED' as result;
