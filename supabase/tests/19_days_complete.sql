-- Days complete for each person (17 Nov 2026). Runs after 18_client_errors.sql.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- one person's part of a completeness() day
do $$ declare c jsonb := '{"items":[
    {"scope":"house","id":"A","name":"House A","expected":["eggs","water"],"missing":["water"]},
    {"scope":"house","id":"C","name":"House C","expected":["eggs","water"],"missing":["eggs","water"]},
    {"scope":"house","id":"B","name":"House B","expected":["eggs","water"],"missing":[]},
    {"scope":"farm","id":"FEED","name":"Central Farm feed","expected":["feed"],"missing":[]},
    {"scope":"outlet","id":"TUALA","name":"Tuala","closed":false,"expected":["sales"],"missing":[]},
    {"scope":"outlet","id":"LUCKY","name":"Lucky","closed":false,"expected":["sales","opening count","closing count"],"missing":["sales","closing count"]},
    {"scope":"outlet","id":"RAYAN","name":"Rayan","closed":true,"expected":[],"missing":[]},
    {"scope":"outlet","id":"VAN","name":"Van","closed":false,"mobile":true,"expected":["empty van at day end"],"missing":["eggs left on the van"]}]}';
  r jsonb;
begin
  r := _my_day('clerk', 'FARM', c);
  assert r->>'state' = 'missed' and r->'missing' = '["water for House A", "eggs and water for House C"]', 'clerk: every house ' || r;
  assert _my_day('store', 'FARM', c)->>'state' = 'done', 'store: the farm feed';
  assert _my_day('pos', 'TUALA', c)->>'state' = 'done', 'outlet done';
  r := _my_day('pos', 'LUCKY', c);
  assert r->'missing' = '["sales", "closing count"]', 'outlet: each thing missing ' || r;
  assert _my_day('pos', 'RAYAN', c)->>'state' = 'closed', 'a closed day is left out';
  r := _my_day('pos', 'VAN', c);
  assert r->>'state' = 'missed' and r->'missing' = '["eggs left on the van"]', 'van ' || r;
  assert _my_day('pos', 'NOWHERE', c)->>'state' = 'none', 'nothing of theirs';
  assert _my_day('manager', 'FARM', c)->>'state' = 'none', 'only field staff';
end $$;

set role authenticated;
select t_as('00000000-0000-0000-0000-000000000006');   -- Tuala attendant
do $$ declare w jsonb; d jsonb; t date := biz_today(); begin
  w := rpc_my_week();
  assert jsonb_array_length(w->'days') = 7, 'Monday to Sunday';
  assert (w->>'from')::date = t - (extract(isodow from t)::int - 1), 'starts on Monday';
  assert (w->'days'->0->>'day')::date = (w->>'from')::date, 'in order';
  for d in select * from jsonb_array_elements(w->'days') loop
    assert d->>'state' in ('done', 'missed', 'today', 'closed', 'none', 'later', 'before'), 'known state ' || d;
    if (d->>'day')::date > t then assert d->>'state' = 'later', 'days to come'; end if;
  end loop;
  assert (w->>'done')::int <= (w->>'counted')::int and (w->>'counted')::int <= 7, 'counts';
  assert (w->>'streak')::int >= 0, 'streak';
end $$;
select t_err($$select rpc_day_ranking()$$, 'not available');
select t_as('00000000-0000-0000-0000-000000000003');   -- production clerk
do $$ begin assert jsonb_array_length(rpc_my_week()->'days') = 7, 'the clerk too'; end $$;
select t_err($$select rpc_day_ranking()$$, 'not available');

select t_as('00000000-0000-0000-0000-000000000002');   -- farm manager
select t_err($$select rpc_my_week()$$, 'not available');
do $$ declare r jsonb; p jsonb; n int; begin
  r := rpc_day_ranking(7);
  assert (r->>'to')::date = biz_today() - 1, 'to yesterday';
  n := (r->>'to')::date - (r->>'from')::date + 1;
  assert n between 0 and 7, 'at most 7 days';
  assert not exists (select 1 from jsonb_array_elements(r->'people') x where x->>'role' in ('owner', 'manager')), 'field staff only';
  assert exists (select 1 from jsonb_array_elements(r->'people') x where x->>'name' = 'Tuala Attendant' and x->>'place' is not null), 'with their place';
  assert exists (select 1 from jsonb_array_elements(r->'people') x where x->>'location_id' = 'VAN' and (x->>'van')::boolean), 'the van is marked';
  for p in select * from jsonb_array_elements(r->'people') loop
    assert jsonb_array_length(p->'days') = n, 'a state for every day';
    assert (p->>'done')::int <= (p->>'counted')::int, 'done within counted';
  end loop;
  assert jsonb_array_length(rpc_day_ranking(500)->'people'->0->'days') <= 62, 'at most 62 days';
end $$;
select t_as('00000000-0000-0000-0000-000000000001');   -- owner, view only
do $$ begin assert jsonb_typeof(rpc_day_ranking(14)->'people') = 'array', 'the owner sees it too'; end $$;
select t_as(null);
reset role;
do $$ begin
  assert not has_function_privilege('anon', 'public.rpc_my_week()', 'execute'), 'anon: my week';
  assert not has_function_privilege('anon', 'public.rpc_day_ranking(int)', 'execute'), 'anon: ranking';
  assert not has_function_privilege('authenticated', 'public._my_day(public.staff_role, text, jsonb)', 'execute'), 'helper is internal';
end $$;
select 'ALL DAYS COMPLETE TESTS PASSED' as result;
