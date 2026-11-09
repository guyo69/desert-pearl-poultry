-- Help tips seen, per person (9 Nov 2026). Runs after 15_recovery.sql.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;
select t_as('00000000-0000-0000-0000-000000000006');
do $$ declare v text[]; begin
  assert rpc_tips() = '{}', 'nothing seen yet';
  v := rpc_tips(array['pos.steps', 'pos.sale', 'pos.steps']);
  assert v = array['pos.sale', 'pos.steps'], 'added once each: ' || v::text;
  v := rpc_tips(null, array['pos.sale']);
  assert v = array['pos.steps'], 'Show me around takes a tip back';
  assert rpc_tips() = array['pos.steps'], 'kept on the account';
end $$;
select t_err($$select rpc_tips(array['<script>'])$$, 'unknown tip');
select t_as('00000000-0000-0000-0000-000000000001');
do $$ begin assert rpc_tips() = '{}', 'each person has their own'; perform rpc_tips(array['owner.ov']); end $$;   -- the owner can use help
select t_as(null);
reset role;
do $$ begin assert not has_function_privilege('anon', 'public.rpc_tips(text[], text[])', 'execute'), 'anon cannot'; end $$;
select 'ALL TIP TESTS PASSED' as result;
