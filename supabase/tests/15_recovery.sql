-- Account recovery (8 Nov 2026). Runs after 14_flocks.sql.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
reset role;
do $$ declare t text; code text; r account_codes; n int; begin
  t := issue_recovery_code('OWNER');
  code := replace(substring(t from ': ([A-Z0-9]{5}-[A-Z0-9]{5})'), '-', '');
  assert code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$', 'a 10-character code without look-alikes: ' || t;
  select * into r from account_codes where staff_id = (select id from staff where username = 'owner') and used_at is null;
  assert r.channel = 'operator' and r.purpose = 'reset' and r.expires_at > now() + interval '23 hours', 'a console reset code for 24 hours';
  assert r.code_hash = encode(sha256(convert_to(r.salt || ':' || code, 'UTF8')), 'hex'), 'stored only as a salted hash';
  assert position(code in r.code_hash) = 0, 'the code itself is not stored';
  perform issue_recovery_code('owner');
  select count(*) into n from account_codes where staff_id = (select id from staff where username = 'owner') and used_at is null;
  assert n = 1, 'a new code replaces the old one';
  assert exists (select 1 from auth_events where reason = 'recovery code issued from the database console'), 'issuing is logged';
  begin perform issue_recovery_code('nobody'); assert false, 'unknown user'; exception when others then assert sqlerrm like 'No active account%', sqlerrm; end;
  assert not has_function_privilege('authenticated', 'public.issue_recovery_code(text)', 'execute'), 'no signed-in user can issue codes';
  assert not has_function_privilege('anon', 'public.issue_recovery_code(text)', 'execute'), 'nor anyone else';
  assert not has_function_privilege('service_role', 'public.issue_recovery_code(text)', 'execute'), 'nor the API';
  assert not has_table_privilege('authenticated', 'public.account_codes', 'select'), 'codes cannot be read through the API';
end $$;
select 'ALL RECOVERY TESTS PASSED' as result;
