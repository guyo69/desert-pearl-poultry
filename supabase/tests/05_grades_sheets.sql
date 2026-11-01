-- Big eggs and damaged eggs, issuing stock out, agreed-price sales, the daily
-- sheets, records for an earlier day, the feed buffer in bags and the change
-- counter. Runs after 04_farm_changes.sql on the same database.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
-- the stock helper is internal; tests read it through this wrapper
create function public.t_stock(p_loc text, p_upto date default null, out n int, out b int, out c int, out j int)
language sql stable security definer set search_path = public as $$ select * from _stock4(p_loc, p_upto) $$;
grant execute on function public.t_stock(text, date) to authenticated;
set role authenticated;

-- ---------- 1. prices for big eggs, buffer in bags ----------
select t_as('00000000-0000-0000-0000-000000000001');
select rpc_save_settings('{"tray_b":510,"pc_b":18,"feed_buffer_bags":315}'::jsonb);
reset role;
do $$ begin
  assert (select feed_buffer_kg from settings) = 315 * 50, 'buffer = bags x bag weight';
  -- 1 tray + 2 loose big = 510 + 36; agreed-price helper prices all four grades
  assert _price4(0, 32, 0, 0) = 546, 'big price ' || _price4(0, 32, 0, 0);
  assert _price4(30, 30, 30, 1) = (select tray_n + tray_b + tray_c + pc_j from settings), 'four grades';
end $$;
set role authenticated;

-- ---------- 2. change counter ----------
do $$ declare v0 bigint; v1 bigint; begin
  perform t_as('00000000-0000-0000-0000-000000000003');
  v0 := (data_version()->>'v')::bigint;
  perform rpc_collect_eggs('A', 300, 60, 4, 6, 9);   -- normal, big, jumbo, cracked, damaged
  v1 := (data_version()->>'v')::bigint;
  assert v1 > v0, 'a write moves the counter';
  assert (dashboard(10)->>'version')::bigint = v1, 'dashboard carries the version';
end $$;
select t_as(null);
select t_err($$select data_version()$$, 'AUTH_SIGNED_OUT');

-- ---------- 3. collection by grade; damaged is production, not stock ----------
select t_as('00000000-0000-0000-0000-000000000003');
do $$ declare st record; f record; begin
  st := t_stock('FARM');
  assert st.b = 60, 'big eggs in farm stock: ' || st.b;
  select * into f from farm_daily2(biz_today(), biz_today()) x where x.house_id = 'A';
  assert f.dmg = 9 and f.b = 60, 'farm daily shows big and damaged';
end $$;
select t_err($$select rpc_collect_eggs('A', -1, 0, 0, 0, 0)$$, 'negative');
select t_err($$select rpc_collect_eggs('A', 0, 0, 0, 0, 0)$$, 'Enter the number');
-- a clerk records today only
select t_err($$select rpc_collect_eggs('A', 30, 0, 0, 0, 0, biz_today() - 1)$$, 'owner or farm manager');

-- the daily house sheet: eggs by grade, deaths, feed and water in one go
do $$ declare r jsonb; d0 int; begin
  d0 := (select coalesce(sum(birds), 0) from mortality where voided_at is null);
  r := rpc_house_day(null, '[{"house":"A","n":600,"b":30,"j":2,"c":10,"dmg":5,"deaths":4,"cause":"Unknown","feed_kg":100,"water_l":300},
                             {"house":"B","n":540,"deaths":6,"feed_kg":120}]'::jsonb);
  assert (r->>'saved')::int = 7, 'seven records: ' || r;
  assert (select coalesce(sum(birds), 0) from mortality where voided_at is null) = d0 + 10, 'deaths saved';
end $$;
select t_err($$select rpc_house_day(null, '[{"house":"A"}]'::jsonb)$$, 'Nothing to save');
select t_err($$select rpc_house_day(null, '[{"house":"Z","n":1}]'::jsonb)$$, 'Unknown house');
reset role;
do $$ begin
  -- feed use beyond the store book is recorded, with a red notice to fix the book
  assert exists (select 1 from notifications where title = 'Feed store book is below zero'), 'negative feed book flagged';
end $$;
set role authenticated;

-- ---------- 4. the farm manager fills in a missed day ----------
select t_as('00000000-0000-0000-0000-000000000002');
do $$ declare r jsonb; begin
  r := rpc_house_day(biz_today() - 3, '[{"house":"B","n":510,"b":12,"dmg":3,"deaths":2}]'::jsonb);
  assert (r->>'date')::date = biz_today() - 3, 'dated three days back';
  assert (select dmg from farm_daily2(biz_today() - 3, biz_today() - 3) x where x.house_id = 'B') = 3, 'missed day in the farm book';
end $$;
select t_err($$select rpc_collect_eggs('A', 30, 0, 0, 0, 0, biz_today() + 1)$$, 'future');
select t_err($$select rpc_collect_eggs('A', 30, 0, 0, 0, 0, biz_today() - 63)$$, '62 days');

-- ---------- 5. sending big eggs; damaged on arrival ----------
select t_as('00000000-0000-0000-0000-000000000003');
select rpc_dispatch_many('FARM', '[{"to":"TUALA","n":300,"b":60,"c":5,"j":2}]'::jsonb);
select t_err($$select rpc_dispatch_many('FARM', '[{"to":"TUALA","b":100000}]'::jsonb)$$, 'big eggs in stock');
select t_as('00000000-0000-0000-0000-000000000006');
do $$ declare x bigint; r jsonb; st0 record; st1 record; begin
  -- the earlier delivery from 04 (no big eggs) arrives complete
  select id into x from transfers where to_loc = 'TUALA' and status = 'in_transit' and sent_b = 0 order by id limit 1;
  perform rpc_receive_delivery(x, null, null, null, null, 0);
  st0 := t_stock('TUALA');
  select id into x from transfers where to_loc = 'TUALA' and status = 'in_transit' and sent_b = 60;
  begin
    perform rpc_receive_delivery(x, 300, 60, 2, 5, 1);
    assert false, 'damaged more than short must fail';
  exception when others then assert sqlerrm like 'Damaged eggs (1) are more than%', sqlerrm; end;
  -- 6 normal arrived broken, 2 more are missing, 1 big egg missing
  r := rpc_receive_delivery(x, 292, 59, 2, 5, 6);
  assert (r->>'short')::int = 9 and (r->>'damaged')::int = 6 and (r->>'missing')::int = 3, 'short split: ' || r;
  st1 := t_stock('TUALA');
  assert st1.n = st0.n + 292 and st1.b = st0.b + 59, 'good eggs into stock';
  assert (select reason from breakages where transfer_id = x and item = 'N') = 'Damaged or missing on arrival', 'reason';
  assert (select recv_dmg from transfers where id = x) = 6, 'damaged on arrival kept';
end $$;

-- ---------- 6. issuing eggs out of the shop ----------
do $$ declare st0 record; st1 record; r jsonb; begin
  st0 := t_stock('TUALA');
  r := rpc_issue_out('TUALA', 120, 20, 0, 0, 'Mama Wanjiku (credit)', 'Pays Friday');
  st1 := t_stock('TUALA');
  assert st1.n = st0.n - 120 and st1.b = st0.b - 20, 'issued stock leaves';
  assert (select party from stock_adj where id = (r->>'id')::bigint) = 'Mama Wanjiku (credit)', 'party kept';
end $$;
select t_err($$select rpc_issue_out('TUALA', 30, 0, 0, 0, '  ')$$, 'who received');
select t_err($$select rpc_issue_out('TUALA', 9999999, 0, 0, 0, 'X')$$, 'normal eggs in stock');
select t_err($$select rpc_issue_out('LUCKY', 30, 0, 0, 0, 'X')$$, 'own location');

-- ---------- 7. sales at the agreed price ----------
select t_err($$select rpc_record_sale('TUALA', 30, 0, 0, 0, 400, 0, 0)$$, 'must equal');
do $$ declare r jsonb; begin
  -- a tray sold at 420 instead of 480: allowed, list price kept beside it
  r := rpc_record_sale('TUALA', 30, 0, 0, 0, 0, 420, 0, 'Hotel', 420);
  assert (r->>'value')::numeric = 420 and (r->>'list_value')::numeric = 480, 'agreed price: ' || r;
  -- big eggs at list price
  r := rpc_record_sale('TUALA', 0, 30, 0, 0, 510, 0, 0);
  assert (r->>'value')::numeric = 510, 'big tray: ' || r;
end $$;
select t_err($$select rpc_record_sale('TUALA', 30, 0, 0, 0, 0, 0, 0, null, 0)$$, 'amount the customer paid');
select t_err($$select rpc_record_sale('TUALA', 30, 0, 0, 0, 450, 0, 0, null, null, biz_today() - 1)$$, 'owner or farm manager');

-- ---------- 8. damaged at the shop, written off by grade ----------
do $$ declare st0 record; begin
  st0 := t_stock('TUALA');
  perform rpc_breakage('TUALA', 'B', 2, 'Dropped tray');
  assert (t_stock('TUALA')).b = st0.b - 2, 'big eggs written off';
end $$;
select t_err($$select rpc_breakage('TUALA', 'X', 2, 'x')$$, 'type of egg');

-- ---------- 9. the shop's daily sheet ----------
do $$ declare r jsonb; d jsonb; st record; begin
  st := t_stock('TUALA');
  r := rpc_shop_day('TUALA', null, jsonb_build_object(
         'damaged', '{"n":3}'::jsonb,
         'issued',  '{"n":60,"party":"School (credit)"}'::jsonb,
         'sales',   '{"n":90,"cash":700,"till":740}'::jsonb,
         'closing', jsonb_build_object('n', st.n - 3 - 60 - 90 - 1, 'b', st.b, 'c', st.c, 'j', st.j)));
  assert (r->'closing'->>'adj_n')::int = -1, 'one egg unaccounted: ' || r;
  d := shop_day('TUALA', biz_today());
  assert (d->'issued'->>'n')::int = 180, 'issued today (120 + 60): ' || d;
  assert (d->'damaged'->>'n')::int = 3 and (d->'damaged'->>'b')::int = 2, 'damaged today: ' || d;
  assert (d->'sales'->>'value')::numeric = 420 + 510 + 1440, 'sales today: ' || d;
  assert (d->'received'->>'dmg')::int = 6, 'damaged on arrival today';
  assert (d->'counted'->>'kind') = 'close', 'closing count shown';
  assert (d->'book_closing'->>'n')::int = st.n - 3 - 60 - 90 - 1, 'book closing after count';
end $$;
select t_err($$select rpc_shop_day('TUALA', null, '{"sales":{"n":30,"cash":1}}'::jsonb)$$, 'must equal');

-- ---------- 10. a missed day entered after a later count ----------
reset role;
-- stock the shop held two days ago (as an earlier delivery would have)
insert into stock_adj (d, location_id, kind, n, party) values (biz_today() - 2, 'TUALA', 'in', 90, 'Earlier stock');
select _rebase('TUALA', biz_today() - 2, 90, 0, 0, 0);
set role authenticated;
select t_as('00000000-0000-0000-0000-000000000001');
do $$ declare st0 record; st1 record; c0 int; begin
  st0 := t_stock('TUALA');
  c0 := (select adj_n from stock_counts where location_id = 'TUALA' and d = biz_today() and kind = 'close' and voided_at is null);
  -- yesterday's sale of 2 trays was never entered; today's closing count already absorbed it
  perform rpc_record_sale('TUALA', 60, 0, 0, 0, 960, 0, 0, null, null, biz_today() - 1);
  st1 := t_stock('TUALA');
  assert st1.n = st0.n, 'stock after the later count does not move';
  assert (select adj_n from stock_counts where location_id = 'TUALA' and d = biz_today() and kind = 'close' and voided_at is null) = c0 + 60,
         'the later variance is explained';
  -- a count for an earlier day is measured against that day's book
  perform rpc_count_stock('TUALA', 'close', 0, 0, 0, 0, biz_today() - 1);   -- 30 eggs short that evening
  assert (t_stock('TUALA', biz_today() - 1)).n = 0, 'that day''s book follows its count';
  assert (t_stock('TUALA')).n = st0.n, 'earlier count leaves today alone';
end $$;

-- ---------- 11. imported paper-book sales stay out of the balances ----------
reset role;
do $$ declare b0 numeric := (select sum(balance) from v_balances); begin
  insert into sales (d, location_id, n, value, list_value, till, imported) values (biz_today() - 20, 'TUALA', 0 + 30, 450, 450, 450, true);
  insert into stock_adj (d, location_id, kind, n, party, imported) values (biz_today() - 21, 'TUALA', 'in', 30, 'October book', true);
  assert (select sum(balance) from v_balances) = b0, 'imported money is history, not a balance';
end $$;

-- ---------- 12. corrections and privileges ----------
set role authenticated;
select t_as('00000000-0000-0000-0000-000000000001');
do $$ declare x bigint; st0 record; begin
  select id into x from stock_adj where party = 'Mama Wanjiku (credit)';
  st0 := t_stock('TUALA');
  perform rpc_void('issue', x, 'Customer returned the eggs');
  assert (t_stock('TUALA')).n = st0.n + 120, 'voided issue comes back';
  assert exists (select 1 from activity(200) a where a.kind = 'issue'), 'issues in activity';
end $$;
reset role;
do $$ declare f text; begin
  foreach f in array array['public._stock4(text, date)', 'public._price4(integer, integer, integer, integer)', 'public._day(public.staff, date)',
                           'public._rebase(text, date, integer, integer, integer, integer, boolean)', 'public._bump()',
                           'public._do_count4(public.staff, text, text, integer, integer, integer, integer, date)',
                           'public._check_have(text, integer, integer, integer, integer, date)'] loop
    assert not has_function_privilege('authenticated', f, 'execute'), 'helper exposed: ' || f;
  end loop;
  foreach f in array array['public.data_version()', 'public.rpc_collect_eggs(text, integer, integer, integer, integer, integer, date)',
                           'public.rpc_issue_out(text, integer, integer, integer, integer, text, text, date)', 'public.shop_day(text, date)',
                           'public.rpc_shop_day(text, date, jsonb)', 'public.rpc_house_day(date, jsonb)'] loop
    assert has_function_privilege('authenticated', f, 'execute'), 'not callable: ' || f;
    assert not has_function_privilege('anon', f, 'execute'), 'anon can call: ' || f;
  end loop;
  assert not has_function_privilege('authenticated', 'public.rpc_collect(text, integer, integer, integer)', 'execute'), 'grade-blind collect retired';
  assert not has_table_privilege('authenticated', 'public.stock_adj', 'insert'), 'stock_adj read-only';
  assert not has_sequence_privilege('authenticated', 'public.data_change_seq', 'usage'), 'counter cannot be moved';
end $$;

select 'ALL GRADE / SHEET TESTS PASSED' as result;
