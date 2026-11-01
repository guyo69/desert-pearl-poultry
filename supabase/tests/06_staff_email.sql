-- Staff emails for the digest: shape check, and only the service role can see them.
-- Runs after 05_grades_sheets.sql on the same database.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

do $$ begin
  update staff set email = 'jane.w@example.co.ke' where id = '00000000-0000-0000-0000-000000000006';
  assert (select digest_enabled from staff where id = '00000000-0000-0000-0000-000000000006'), 'digest on by default';
  assert (select email is null from staff where id = '00000000-0000-0000-0000-000000000007'), 'email optional';
end $$;
select t_err($$update staff set email = 'Jane@Example.com' where id = '00000000-0000-0000-0000-000000000005'$$, 'staff_email_shape');
select t_err($$update staff set email = 'not-an-email' where id = '00000000-0000-0000-0000-000000000005'$$, 'staff_email_shape');
select t_err($$update staff set email = ' x@y.co' where id = '00000000-0000-0000-0000-000000000005'$$, 'staff_email_shape');

do $$ begin
  assert not has_column_privilege('authenticated', 'public.staff', 'email', 'select'), 'email hidden from signed-in users';
  assert not has_column_privilege('authenticated', 'public.staff', 'digest_enabled', 'select'), 'digest flag hidden';
  assert not has_column_privilege('anon', 'public.staff', 'email', 'select'), 'email hidden from anon';
  assert has_column_privilege('authenticated', 'public.staff', 'display_name', 'select'), 'names still readable';
  assert not has_table_privilege('authenticated', 'public.staff', 'update'), 'staff not writable';
end $$;

-- the owner's own staff list (security definer) does not carry emails either
set role authenticated;
select t_as('00000000-0000-0000-0000-000000000001');
do $$ begin
  assert not exists (select 1 from jsonb_array_elements(_staff_list()) x where x ? 'email'), 'no email in the staff list';
  assert not exists (select 1 from jsonb_array_elements(dashboard(10)->'staff') x where x ? 'email'), 'no email in the dashboard';
end $$;
select t_err($$select email from staff$$, 'permission denied');
reset role;

select 'ALL STAFF EMAIL TESTS PASSED' as result;
