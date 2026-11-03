-- 3 Nov 2026, at the client's request: remove test data from production.
--   * everything at Abdihakim Lucky Summer (LUCKY) was test data
--   * everything entered on 3 Nov 2026 (Nairobi time) was test data, including
--     the Rayan Fedha October book import and the 29 Oct farm sheet re-entry
--   * the clerk's 30 Oct farm records, voided on 3 Nov for that re-entry, are
--     restored, and the Rayan Fedha opening count on 2 Nov goes back to its
--     original adjustment
-- Rows are pinned by id. The block only runs on the production database: it
-- checks that the exact rows are there first, so a fresh or test database is
-- left alone.
do $$
declare
  v_today_sales    bigint[] := array[27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54];
  v_today_brk      bigint[] := array[22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40];
  v_today_counts   bigint[] := array[32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61];
  v_today_adj      bigint[] := array[18,19,20,21,22];
  v_today_cash     bigint[] := array[1,2];
  v_today_eggs     bigint[] := array[3,4];
  v_today_mort     bigint[] := array[1,2];
  v_today_water    bigint[] := array[4,5,6,7];
  v_today_feed     bigint[] := array[4,5,6];
  v_today_xfer     bigint[] := array[1];
begin
  -- production fingerprint: the Rayan Fedha import and the Rayan to Lucky Summer test transfer
  if not exists (select 1 from transfers where id = 1 and from_loc = 'RAYAN' and to_loc = 'LUCKY' and sent_n = 3600)
     or (select count(*) from sales where id = any (v_today_sales) and location_id = 'RAYAN' and imported) <> 25
     or not exists (select 1 from stock_counts where id = 31 and location_id = 'RAYAN' and d = '2026-11-02' and cnt_n = 13320) then
    raise notice 'Test data clean-up skipped: not the production database';
    return;
  end if;

  -- today's records (pinned ids, all entered on 3 Nov 2026)
  delete from breakages      where id = any (v_today_brk);
  delete from cash_counts    where id = any (v_today_cash);
  delete from sales          where id = any (v_today_sales);
  delete from stock_counts   where id = any (v_today_counts);
  delete from stock_adj      where id = any (v_today_adj);
  delete from transfers      where id = any (v_today_xfer);
  delete from egg_collections where id = any (v_today_eggs);
  delete from mortality      where id = any (v_today_mort);
  delete from water_logs     where id = any (v_today_water);
  delete from feed_moves     where id = any (v_today_feed);

  -- all of Lucky Summer (test outlet data)
  delete from breakages    where location_id = 'LUCKY';
  delete from cash_counts  where location_id = 'LUCKY';
  delete from sales        where location_id = 'LUCKY';
  delete from stock_counts where location_id = 'LUCKY';
  delete from stock_adj    where location_id = 'LUCKY';
  delete from day_marks    where location_id = 'LUCKY';
  delete from transfers    where from_loc = 'LUCKY' or to_loc = 'LUCKY';

  -- restore the clerk's 30 Oct farm records voided for the re-entry
  update egg_collections set voided_at = null, voided_by = null, void_reason = null
   where id in (1, 2) and void_reason like 'Re-entered from the 29 Oct farm sheet%';
  update water_logs set voided_at = null, voided_by = null, void_reason = null
   where id in (2, 3) and void_reason like 'Re-entered from the 29 Oct farm sheet%';
  update feed_moves set voided_at = null, voided_by = null, void_reason = null
   where id in (2, 3) and void_reason like 'Re-entered from the 29 Oct farm sheet%';

  -- the Rayan Fedha opening count on 2 Nov: back to its original adjustment
  update stock_counts set adj_n = cnt_n where id = 31 and location_id = 'RAYAN' and d = '2026-11-02';
end $$;
