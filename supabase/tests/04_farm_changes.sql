-- Cracked-egg loose price, medicines with categories, the clerk adding a
-- new medicine on delivery, and sending eggs to several outlets at once.
-- Runs after 01_flows.sql and 03_auth.sql on the same database.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;

-- ---------- 1. cracked eggs priced per tray and per piece ----------
select t_as('00000000-0000-0000-0000-000000000001');
select rpc_save_settings('{"tray_c":330,"pc_c":12}'::jsonb);
reset role;
do $$ begin
  assert (select pc_c from settings) = 12, 'pc_c saved';
  -- 1 tray + 5 loose cracked = 330 + 60
  assert _price(0, 35, 0) = 390, 'cracked price ' || _price(0, 35, 0);
end $$;
set role authenticated;

-- ---------- 2. owner manages the medicine list ----------
do $$ declare v bigint; begin
  v := rpc_medicine_save(null, 'Gumboro vaccine (IBD)', 'Vaccine', 'doses', 500, true);
  assert (select category from medicines where id = v) = 'Vaccine', 'category saved';
  perform rpc_medicine_save(v, 'Gumboro vaccine', 'Vaccines', 'doses', 400, true);   -- rename + recategorise
  assert (select name || '|' || category || '|' || reorder from medicines where id = v) = 'Gumboro vaccine|Vaccines|400', 'edited';
  perform rpc_medicine_save(v, 'Gumboro vaccine', 'Vaccines', 'doses', 400, false); -- retire
  assert not (select active from medicines where id = v), 'retired';
end $$;
select t_err($$select rpc_medicine_save(null, 'gumboro VACCINE', 'Vaccine', 'doses', 0, true)$$, 'already in the list');
select t_err($$select rpc_medicine_save(null, '', 'Vaccine', 'doses', 0, true)$$, 'name');
do $$ begin
  assert (select count(*) from jsonb_array_elements(dashboard(10)->'medicines') x where x ? 'category') > 0, 'dashboard has categories';
end $$;

-- the clerk cannot edit the list...
select t_as('00000000-0000-0000-0000-000000000003');
select t_err($$select rpc_medicine_save(null, 'Something', 'Other', 'g', 0, true)$$, 'not available');
-- ...but can register a new item, in a new category, when it is delivered
do $$ declare r jsonb; begin
  r := rpc_med_new('Amprolium 20%', 'Coccidiostat', 'g', 500, 100, 'From Agrovet');
  assert (r->>'created')::boolean and (r->>'stock')::numeric = 500, 'new item booked in: ' || r;
  assert (select category from medicines where name = 'Amprolium 20%') = 'Coccidiostat', 'new category';
  -- delivering it again (any spelling of case) adds stock to the same item
  r := rpc_med_new('amprolium 20%', 'Coccidiostat', 'g', 250);
  assert not (r->>'created')::boolean and (r->>'stock')::numeric = 750, 'same item: ' || r;
  -- a retired item comes back into use when delivered
  r := rpc_med_new('Gumboro vaccine', 'Vaccines', 'doses', 1000);
  assert (select active from medicines where name = 'Gumboro vaccine'), 'reactivated';
end $$;
select t_err($$select rpc_med_new('X', 'Other', 'g', 0)$$, 'quantity');
-- shop staff cannot add medicines
select t_as('00000000-0000-0000-0000-000000000006');
select t_err($$select rpc_med_new('Y', 'Other', 'g', 5)$$, 'not available');

-- ---------- 4. the clerk sends eggs to several outlets at once ----------
select t_as('00000000-0000-0000-0000-000000000003');
select rpc_collect_eggs('A', 900, 0, 20, 30, 0);
do $$ declare before record; r jsonb; begin
  select n, c, j into before from v_stock where location_id = 'FARM';
  r := rpc_dispatch_many('FARM', '[{"to":"LUCKY","n":300,"c":10,"j":5},{"to":"TUALA","n":135,"c":15,"j":10},{"to":"RAYAN","n":0,"c":0,"j":0}]'::jsonb);
  assert (r->>'outlets')::int = 2, 'two outlets: ' || r;
  assert (select n from v_stock where location_id = 'FARM') = before.n - 435, 'farm normal stock down';
  assert (select c from v_stock where location_id = 'FARM') = before.c - 25, 'farm cracked stock down';
  assert (select count(*) from transfers where status = 'in_transit' and to_loc in ('LUCKY','TUALA') and id = any (array(select jsonb_array_elements_text(r->'ids'))::bigint[])) = 2, 'two deliveries';
end $$;
-- all or nothing: asking for more than the farm holds sends nothing
do $$ declare n0 bigint := (select count(*) from transfers); begin
  begin
    perform rpc_dispatch_many('FARM', '[{"to":"LUCKY","n":100000},{"to":"TUALA","n":30}]'::jsonb);
    assert false, 'should fail';
  exception when others then
    assert sqlerrm like 'Only % normal eggs in stock%', sqlerrm;
  end;
  assert (select count(*) from transfers) = n0, 'nothing sent';
end $$;
select t_err($$select rpc_dispatch_many('FARM', '[{"to":"LUCKY","n":30},{"to":"LUCKY","n":30}]'::jsonb)$$, 'only once');
select t_err($$select rpc_dispatch_many('FARM', '[]'::jsonb)$$, 'what you are sending');
select t_err($$select rpc_dispatch_many('FARM', '[{"to":"FARM","n":30}]'::jsonb)$$, 'different destination');
-- a shop attendant can only send from their own shop
select t_as('00000000-0000-0000-0000-000000000006');
select t_err($$select rpc_dispatch_many('FARM', '[{"to":"LUCKY","n":30}]'::jsonb)$$, 'own location');

-- ---------- 5. two-step sign-in is optional for everyone ----------
reset role;
do $$ begin
  assert not _mfa_required('owner') and not _mfa_required('manager'), 'optional';
  assert exists (select 1 from notifications where title = 'New medicine added: Amprolium 20%' and 'owner' = any (to_roles)), 'owner told about the new medicine';
  assert not has_function_privilege('anon', 'public.rpc_dispatch_many(text, jsonb, text)', 'execute'), 'anon blocked';
  assert not has_function_privilege('authenticated', 'public.rpc_save_medicine(bigint, text, text, numeric, boolean)', 'execute'), 'old editor retired';
end $$;

select 'ALL FARM-CHANGE TESTS PASSED' as result;
