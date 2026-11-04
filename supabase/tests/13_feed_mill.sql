-- The farm's feed mill (4 Nov 2026): raw materials, the recipe, milling and the
-- store ledger in the monthly workbook. Runs after 12_reminders.sql.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;

-- ---------- 1. the recipe is loaded and adds up ----------
select t_as('00000000-0000-0000-0000-000000000009');
do $$ declare d jsonb; begin
  assert (select sum(per_tonne) from raw_materials where active) = 1000, 'the farm recipe adds up to a tonne';
  assert (select per_tonne from raw_materials where name = 'Maize') = 533, 'maize 533 kg a tonne';
  d := dashboard();
  assert jsonb_array_length(d->'raw') = 7, 'raw materials on the dashboard';
end $$;
-- nothing in the store yet: milling is refused and says what is short
select t_err($$select rpc_mill('mill', '{"tonnes": 1}')$$, 'not enough in the store');

-- ---------- 2. deliveries, milling and a count ----------
do $$ declare r jsonb; f0 numeric; b0 numeric; mz bigint := (select id from raw_materials where name = 'Maize'); begin
  -- 6 t worth of everything, maize by bags
  r := rpc_mill('raw_in', jsonb_build_object('material', mz, 'bags', 64));                    -- 3,200 kg
  assert (r->>'kg')::numeric = 3200 and (r->>'stock')::numeric = 3200, 'bags turned into kg';
  perform rpc_mill('raw_in', jsonb_build_object('material', id, 'kg', per_tonne * 6)) from raw_materials where name <> 'Maize';
  f0 := (select coalesce(sum(kg), 0) from v_feed_lines);
  b0 := (select count(*) from mill_batches);
  r := rpc_mill('mill', '{"tonnes": 5, "note": "Layers mash"}');
  assert (r->>'tonnes')::numeric = 5 and (r->>'bags')::numeric = 5000 / (select bag_kg from settings), 'feed bags made';
  assert (select coalesce(sum(kg), 0) from v_feed_lines) = f0 + 5000, 'five tonnes into the feed store';
  assert (select kg from v_raw_stock where material_id = mz) = 3200 - 533 * 5, 'maize used by the recipe';
  assert (select kg from v_raw_stock v join raw_materials m on m.id = v.material_id where m.name = 'Macropack') = 15, 'macropack used by the recipe';
  assert (select count(*) from raw_moves where batch_id = (r->>'id')::bigint) = 7, 'one line per material';
  assert (select jsonb_array_length(recipe) from mill_batches where id = (r->>'id')::bigint) = 7, 'the recipe used is kept with the batch';
  -- a count: 30 kg less maize than the book
  r := rpc_mill('raw_count', jsonb_build_object('material', mz, 'counted_kg', 3200 - 533 * 5 - 30));
  assert (r->>'difference')::numeric = -30, 'the count difference';
  assert (select kg from v_raw_stock where material_id = mz) = 3200 - 533 * 5 - 30, 'the book follows the count';
  -- the log: the milling and the raw moves, not the milled feed twice
  assert exists (select 1 from activity(80) a where a.kind = 'mill'), 'milling in the activity log';
  assert exists (select 1 from activity(80) a where a.kind = 'raw' and a.data->>'kind' = 'count'), 'counts in the activity log';
  assert not exists (select 1 from activity(80) a where a.kind = 'raw' and a.data->>'kind' = 'mill'), 'the milling lines stay inside the batch';
  assert not exists (select 1 from activity(80) a where a.kind = 'feed' and a.id = (select feed_move_id from mill_batches order by id desc limit 1)), 'milled feed shows once';
  assert exists (select 1 from jsonb_array_elements(dashboard()->'mill_daily') x where (x->>'tonnes')::numeric = 5), 'tonnes milled each day';
end $$;
-- maize now covers only one more tonne
select t_err($$select rpc_mill('mill', '{"tonnes": 2}')$$, 'maize (needs 1066 kg');
select t_err($$select rpc_mill('mill', '{"tonnes": 0}')$$, 'enter the tonnes');
select t_err($$select rpc_mill('mill', '{"tonnes": 80}')$$, 'more than a day');
select t_err($$select rpc_mill('raw_in', '{"material": 999999, "kg": 5}')$$, 'choose the raw material');
select t_err($$select rpc_mill('raw_count', jsonb_build_object('material', (select id from raw_materials limit 1), 'counted_kg', -1))$$, 'what you counted');
select t_err($$select rpc_recipe_save('[{"name": "Maize", "per_tonne": 1000, "bag_kg": 50}]')$$, 'not available');  -- the inventory clerk does not change the recipe

-- ---------- 3. the recipe can be changed, but only to a full tonne ----------
select t_as('00000000-0000-0000-0000-000000000002');
select t_err($$select rpc_recipe_save((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'per_tonne', per_tonne + 1, 'bag_kg', bag_kg)) from raw_materials))$$, 'must be 1,000 kg');
select t_err($$select rpc_recipe_save('[{"name": " ", "per_tonne": 1000, "bag_kg": 50}]')$$, 'needs a name');
select t_err($$select rpc_recipe_save((select jsonb_agg(jsonb_build_object('id', id, 'name', case when name = 'Soybean' then 'Maize' else name end, 'per_tonne', per_tonne, 'bag_kg', bag_kg)) from raw_materials))$$, 'already a raw material');
do $$ begin
  -- less maize, a new material, same tonne
  perform rpc_recipe_save((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'per_tonne', case when name = 'Maize' then 523 else per_tonne end,
                                                               'bag_kg', bag_kg, 'active', active) order by sort) from raw_materials)
                          || '[{"name": "Salt", "per_tonne": 10, "bag_kg": 25}]'::jsonb);
  assert (select per_tonne from raw_materials where name = 'Salt') = 10 and (select sort from raw_materials where name = 'Salt') = 8, 'a new material at the end';
  assert (select sum(per_tonne) from raw_materials where active) = 1000, 'still a tonne';
  perform rpc_mill('raw_in', jsonb_build_object('material', (select id from raw_materials where name = 'Salt'), 'bags', 2));
  perform rpc_mill('raw_in', jsonb_build_object('material', (select id from raw_materials where name = 'Maize'), 'kg', 600));
  perform rpc_mill('mill', '{"tonnes": 1}');
  assert (select (recipe @> '[{"name": "Salt", "per_tonne": 10}]') from mill_batches order by id desc limit 1), 'the new recipe is used';
end $$;

-- ---------- 4. the monthly workbook carries the store ledger ----------
do $$ declare b jsonb; mz bigint := (select id from raw_materials where name = 'Maize'); l jsonb; begin
  b := rpc_month_book();
  select x into l from jsonb_array_elements(b->'ledger') x where (x->>'material_id')::bigint = mz and (x->>'d')::date = biz_today();
  assert (l->>'opening')::numeric = 0 and (l->>'purchase')::numeric = 3800 and (l->>'used')::numeric = 533 * 5 + 523
     and (l->>'adjust')::numeric = -30 and (l->>'tonnes')::numeric = 6, 'one ledger line per material per day: ' || l::text;
  assert (select (x->>'close')::numeric from jsonb_array_elements(b->'materials') x where (x->>'id')::bigint = mz) = 3800 - 533 * 5 - 30 - 523, 'month-end closing';
  assert exists (select 1 from jsonb_array_elements(b->'feed') x where (x->>'d')::date = biz_today() and (x->>'milled')::numeric = 6000), 'feed milled in the workbook';
end $$;

-- ---------- 5. the owner looks, the store morning check counts the mill ----------
select t_as('00000000-0000-0000-0000-000000000001');
select t_err($$select rpc_mill('raw_in', jsonb_build_object('material', (select id from raw_materials limit 1), 'kg', 5))$$, 'not available');
do $$ begin assert jsonb_array_length(rpc_month_book()->'ledger') > 0, 'the owner sees the ledger'; end $$;
select t_as(null);
reset role;
do $$ declare t date := biz_today(); begin
  delete from notifications where dedupe_key = format('rem:morning:%s:store', t);
  perform reminders('morning');
  assert (select body from notifications where dedupe_key = format('rem:morning:%s:store', t)) like '%Wheat bran (enough to mill 0.0 tonnes, a usual batch is 5)%',
         'the store is told when it cannot make a usual batch: ' || coalesce((select body from notifications where dedupe_key = format('rem:morning:%s:store', t)), 'none');
  assert not has_function_privilege('anon', 'public.rpc_mill(text, jsonb, date)', 'execute'), 'anon cannot mill';
  assert not has_function_privilege('anon', 'public.rpc_recipe_save(jsonb)', 'execute'), 'anon cannot change the recipe';
  assert (select count(*) from pg_trigger where tgname = 'owner_view_only') >= 18, 'owner view-only covers the mill tables';
end $$;
select 'ALL FEED MILL TESTS PASSED' as result;
