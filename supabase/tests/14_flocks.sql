-- Houses and flocks from the farm (5 Nov 2026). Runs after 13_feed_mill.sql.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;

-- ---------- 1. the production clerk adds a house and places a flock ----------
select t_as('00000000-0000-0000-0000-000000000003');
do $$ declare r jsonb; d jsonb; begin
  -- houses stocked from the house list without a flock on record still count their hens
  assert exists (select 1 from farm_daily2(biz_today(), biz_today()) x join houses h on h.id = x.house_id where h.birds_at_start > 0 and x.hens > 0), 'houses without a flock record still count';
  r := rpc_flock('house_new', '{"id": "c", "name": "House C"}');
  assert r->>'id' = 'C', 'codes in capitals';
  assert (select birds_at_start from houses where id = 'C') = 0, 'a new house is empty';
  r := rpc_flock('place', jsonb_build_object('house', 'C', 'breed', 'ISA Brown', 'hens', 3000, 'placed_on', biz_today() - 10, 'age_weeks', 18, 'expected_lay', 85));
  assert (select birds_at_start = 3000 and breed = 'ISA Brown' and expected_lay = 0.85 and start_date = biz_today() - 10 from houses where id = 'C'), 'the house follows its flock';
  d := dashboard();
  assert exists (select 1 from jsonb_array_elements(d->'flocks') x where x->>'house_id' = 'C' and (x->>'hens')::int = 3000), 'flocks on the dashboard';
  assert exists (select 1 from activity(50, null, null, 'flock') a where a.kind = 'flock' and a.data->>'house' = 'House C'), 'a new flock is in the activity log';
end $$;
select t_err($$select rpc_flock('house_new', '{"id": "C", "name": "Another"}')$$, 'already a house with the code');
select t_err($$select rpc_flock('house_new', '{"id": "toolongcode", "name": "X"}')$$, 'short code');
select t_err($$select rpc_flock('place', '{"house": "C", "hens": 0, "age_weeks": 1, "expected_lay": 80}')$$, 'enter the hens');
select t_err($$select rpc_flock('place', jsonb_build_object('house', 'C', 'hens', 10, 'age_weeks', 1, 'expected_lay', 80, 'placed_on', biz_today() - 12))$$, 'must come after it');
select t_err($$select rpc_flock('end', '{"house": "C"}')$$, 'say why');
select t_err($$select rpc_flock('place', '{"house": "Z", "hens": 10, "age_weeks": 1, "expected_lay": 80}')$$, 'choose the house');

-- ---------- 2. a new flock keeps the old one's history ----------
reset role;
insert into mortality (d, house_id, birds, cause) values (biz_today() - 5, 'C', 20, 'Heat');
set role authenticated;
do $$ declare old int; r jsonb; begin
  old := (select hens from farm_daily2(biz_today() - 3, biz_today() - 3) where house_id = 'C');
  assert old = 3000 - 20, 'hens less deaths: ' || coalesce(old::text, 'none');
  r := rpc_flock('place', jsonb_build_object('house', 'C', 'breed', 'Kenbro', 'hens', 2500, 'placed_on', biz_today() - 1, 'age_weeks', 20, 'expected_lay', 0.8));
  assert (r->>'ended')::boolean, 'the old flock ended';
  assert (select hens from farm_daily2(biz_today() - 3, biz_today() - 3) where house_id = 'C') = old, 'earlier days keep the old flock';
  assert (select hens from farm_daily2(biz_today(), biz_today()) where house_id = 'C') = 2500, 'today counts the new flock';
  assert (select count(*) from flocks where house_id = 'C') = 2 and (select count(*) from flocks where house_id = 'C' and ended_on is null) = 1, 'one flock in a house at a time';
  perform rpc_flock('edit', jsonb_build_object('flock', (select id from flocks where house_id = 'C' and ended_on is null), 'expected_lay', 82, 'breed', 'Kenbro'));
  assert (select expected_lay from houses where id = 'C') = 0.82, 'editing the flock updates the house';
  perform rpc_flock('end', jsonb_build_object('house', 'C', 'note', 'Sold'));
  assert (select birds_at_start from houses where id = 'C') = 0, 'an emptied house has no hens';
  assert not exists (select 1 from farm_daily2(biz_today(), biz_today()) where house_id = 'C'), 'no hens counted after it was emptied';
end $$;
select t_err($$select rpc_flock('end', '{"house": "C", "note": "x"}')$$, 'has no flock');

-- ---------- 3. who can ----------
select t_as('00000000-0000-0000-0000-000000000009');
select t_err($$select rpc_flock('house_new', '{"id": "D", "name": "House D"}')$$, 'not available');      -- the inventory clerk does not
select t_as('00000000-0000-0000-0000-000000000006');
select t_err($$select rpc_flock('house_new', '{"id": "D", "name": "House D"}')$$, 'not available');      -- an outlet does not
select t_as('00000000-0000-0000-0000-000000000002');
do $$ begin perform rpc_flock('house_new', '{"id": "D", "name": "House D"}'); end $$;                     -- the farm manager does
select t_as(null);
reset role;
do $$ begin
  assert not has_function_privilege('anon', 'public.rpc_flock(text, jsonb)', 'execute'), 'anon cannot add flocks';
end $$;
select 'ALL FLOCK TESTS PASSED' as result;
