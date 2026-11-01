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

-- ---------- day marks: "closed" and "no deaths" ----------
set role authenticated;
select t_as('00000000-0000-0000-0000-000000000006');
select t_err($$select rpc_mark_day('closed', 'TUALA')$$, 'Sales are recorded');
select t_as('00000000-0000-0000-0000-000000000008');
do $$ begin
  perform rpc_mark_day('closed', 'LUCKY', null, biz_today() - 1);
  perform rpc_mark_day('closed', 'LUCKY', null, biz_today() - 1);   -- twice: still one mark
end $$;
select t_err($$select rpc_mark_day('closed', 'RAYAN', null, biz_today() - 1)$$, 'own location');
select t_err($$select rpc_mark_day('closed', 'LUCKY', null, biz_today() - 3)$$, 'owner or farm manager');
select t_err($$select rpc_mark_day('no_deaths', null, 'A')$$, 'farm staff');
select t_err($$select gaps()$$, 'owner or farm manager');
select t_as('00000000-0000-0000-0000-000000000003');
select t_err($$select rpc_mark_day('no_deaths', null, 'A')$$, 'already recorded');
select rpc_mark_day('no_deaths', null, 'A', biz_today() - 1);
select t_as('00000000-0000-0000-0000-000000000001');
do $$ begin assert jsonb_typeof(gaps(7)) = 'array', 'owner sees gaps'; end $$;
reset role;
do $$ begin
  assert (select count(*) from day_marks where kind = 'closed' and location_id = 'LUCKY' and voided_at is null) = 1, 'one closed mark';
  assert (select (i->>'closed')::boolean from jsonb_array_elements(completeness(biz_today() - 1)->'items') i where i->>'id' = 'LUCKY'), 'Lucky closed yesterday';
  assert (select i->>'deaths' from jsonb_array_elements(completeness(biz_today() - 1)->'items') i where i->>'id' = 'A') = 'none', 'no deaths confirmed';
end $$;
-- taking a mark back
set role authenticated;
select t_as('00000000-0000-0000-0000-000000000008');
select rpc_mark_day('closed', 'LUCKY', null, biz_today() - 1, false);
reset role;
do $$ begin assert (select count(*) from day_marks where kind = 'closed' and location_id = 'LUCKY' and voided_at is null) = 0, 'mark taken back'; end $$;

select 'ALL STAFF EMAIL TESTS PASSED' as result;
