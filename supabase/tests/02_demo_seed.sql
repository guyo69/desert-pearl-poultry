-- 30 days of realistic demo history, for local UI testing only. Never run on production.
-- Assumes 00_supabase_shim.sql + migrations, and no staff yet.
set client_min_messages = warning;
select setseed(0.29);

insert into auth.users (id) values
 ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002'),('00000000-0000-0000-0000-000000000003'),
 ('00000000-0000-0000-0000-000000000004'),('00000000-0000-0000-0000-000000000005'),('00000000-0000-0000-0000-000000000006'),
 ('00000000-0000-0000-0000-000000000007'),('00000000-0000-0000-0000-000000000008');
insert into public.staff (id, display_name, role, location_id, must_change_pin) values
 ('00000000-0000-0000-0000-000000000001','Owner','owner',null,false),
 ('00000000-0000-0000-0000-000000000002','Farm Manager','manager','FARM',false),
 ('00000000-0000-0000-0000-000000000003','Production Clerk','clerk','FARM',true),
 ('00000000-0000-0000-0000-000000000004','Farm Counter','pos','FARM',false),
 ('00000000-0000-0000-0000-000000000005','Van Driver','pos','VAN',false),
 ('00000000-0000-0000-0000-000000000006','Tuala Egg Shop Attendant','pos','TUALA',false),
 ('00000000-0000-0000-0000-000000000007','Rayan Fedha Attendant','pos','RAYAN',false),
 ('00000000-0000-0000-0000-000000000008','Lucky Summer Attendant','pos','LUCKY',false);

update public.houses set birds_at_start = 224, start_date = biz_today() - 31, age_weeks_at_start = 30, expected_lay = 0.93 where id = 'A';
update public.houses set birds_at_start = 176, start_date = biz_today() - 31, age_weeks_at_start = 58, expected_lay = 0.80 where id = 'B';
update public.settings set go_live = biz_today() - 31 where id = 1;

do $$
#variable_conflict use_variable
declare d date; k int; h record; tot int; c int; j int; lay numeric; loc text; st record; q int; v numeric; cash numeric; till numeric; pb numeric;
        clerk uuid := '00000000-0000-0000-0000-000000000003'; own uuid := '00000000-0000-0000-0000-000000000001';
        share numeric; x bigint; who uuid; loss int;
begin
  -- opening balances
  insert into money_moves (kind, to_acc, amount, note, recorded_by, d) select 'opening', id, case kind when 'cash' then 2000 when 'till' then 8000 when 'paybill' then 12000 else 150000 end, 'Opening balance', own, biz_today() - 31 from accounts;
  insert into feed_moves (kind, kg, note, recorded_by, d) values ('adjust', 395, 'Opening balance', own, biz_today() - 31);
  insert into stock_counts (location_id, kind, cnt_n, cnt_c, cnt_j, adj_n, adj_c, adj_j, recorded_by, d) values ('FARM','opening_balance',330,12,10,330,12,10,own,biz_today()-31);
  insert into med_moves (medicine_id, kind, qty, note, recorded_by, d) values (1,'adjust',800,'Opening balance',own,biz_today()-31),(2,'adjust',2,'Opening balance',own,biz_today()-31),(3,'adjust',390,'Opening balance',own,biz_today()-31),(4,'adjust',440,'Opening balance',own,biz_today()-31);
  insert into schedule (due, house, task) values (biz_today()+3,'House A','Newcastle booster (LaSota), in drinking water'),(biz_today()+7,'House B','Deworming, Piperazine'),(biz_today()+16,'All houses','Fowl typhoid vaccination');

  for k in 0..30 loop
    d := biz_today() - 30 + k;
    -- morning dispatch from the farm
    for loc, share in select * from (values ('VAN',0.30),('TUALA',0.19),('RAYAN',0.18),('LUCKY',0.16)) t(a,b) loop
      select * into st from _stock('FARM');
      q := least(round(st.n * share / 30) * 30, floor(st.n / 30) * 30);
      if q <= 0 then continue; end if;
      c := case when loc = 'VAN' then floor(st.c * 0.45) else 0 end;
      j := case when loc in ('TUALA','RAYAN') then floor(st.j * 0.3) else 0 end;
      insert into transfers (from_loc, to_loc, sent_n, sent_c, sent_j, recorded_by, d, recorded_at)
      values ('FARM', loc, q, c, j, clerk, d, (d + time '07:30')::timestamp at time zone 'Africa/Nairobi') returning id into x;
      if k = 30 and loc = 'RAYAN' then continue; end if;   -- today's Rayan delivery still on the way
      loss := case when random() < case when loc = 'LUCKY' then 0.55 else 0.12 end then (case when loc = 'LUCKY' then 2 + floor(random()*4) else 1 + floor(random()*2) end)::int else 0 end;
      who := (select id from staff where location_id = loc and role = 'pos');
      update transfers set status = 'received', received_d = d, received_at = (d + time '08:40')::timestamp at time zone 'Africa/Nairobi', received_by = who,
             recv_n = q - loss, recv_c = c, recv_j = j where id = x;
      if loss > 0 then insert into breakages (location_id, item, qty, reason, transit, transfer_id, recorded_by, d) values (loc,'N',loss,'Transit breakage',true,x,who,d); end if;
    end loop;
    -- collections, mortality, water (today: morning only)
    for h in select * from houses loop
      lay := case when h.id = 'A' then 0.885 + random() * 0.04 when k >= 26 then 0.705 + random() * 0.03 else 0.77 + random() * 0.03 end;
      tot := round((h.birds_at_start - coalesce((select sum(birds) from mortality m where m.house_id = h.id), 0)) * lay * case when k = 30 then 0.56 else 1 end);
      c := round(tot * (0.022 + random() * 0.018)); j := round(tot * case when h.id = 'A' then 0.01 else 0.032 end);
      insert into egg_collections (house_id, n, c, j, recorded_by, d, recorded_at) values (h.id, tot - c - j, c, j, clerk, d, (d + time '16:05')::timestamp at time zone 'Africa/Nairobi');
      if (random() < (case when h.id = 'B' then 0.17 else 0.1 end) and k < 30) then
        insert into mortality (house_id, birds, cause, recorded_by, d) values (h.id, 1, 'Unknown', clerk, d);
      end if;
      insert into water_logs (kind, house_id, litres, recorded_by, d, recorded_at) values ('intake', h.id,
        round((case when h.id = 'A' then 50 else 40 end) * case when h.id = 'B' and k >= 28 then 0.82 else 1 end * (0.95 + random() * 0.1) * case when k = 30 then 0.5 else 1 end),
        clerk, d, (d + time '17:00')::timestamp at time zone 'Africa/Nairobi');
    end loop;
    -- feed
    if k in (5, 12, 19, 25) then
      insert into feed_moves (kind, kg, bags, cost, note, recorded_by, d) values ('in', case when k = 5 then 350 when k = 12 then 300 else 250 end, case when k = 5 then 7 when k = 12 then 6 else 5 end,
        (case when k = 5 then 7 when k = 12 then 6 else 5 end) * 2900, 'Layers feed', clerk, d);
      insert into money_moves (kind, from_acc, amount, category, note, recorded_by, d) values ('expense', 'BANK', (case when k = 5 then 7 when k = 12 then 6 else 5 end) * 2900, 'Feed', 'Feed supplier', own, d);
    end if;
    insert into feed_moves (kind, kg, house, note, recorded_by, d, recorded_at) values ('use', 22 + floor(random()*3), 'Both', 'Morning feed', clerk, d, (d + time '07:10')::timestamp at time zone 'Africa/Nairobi');
    if k < 30 then insert into feed_moves (kind, kg, house, note, recorded_by, d, recorded_at) values ('use', 21 + floor(random()*3), 'Both', 'Afternoon feed', clerk, d, (d + time '15:00')::timestamp at time zone 'Africa/Nairobi'); end if;
    -- tank: refilled every 3 days
    insert into water_logs (kind, litres, recorded_by, d, recorded_at) values ('tank', case when k % 3 = 0 then 1000 else 1000 - (k % 3) * 300 end - case when k = 30 then 280 else 0 end,
      clerk, d, (d + time '06:45')::timestamp at time zone 'Africa/Nairobi');
    -- sales
    for loc in select id from locations loop
      if k = 30 and loc = 'RAYAN' then continue; end if;
      select * into st from _stock(loc);
      q := case when loc = 'FARM' then round(st.n * (0.08 + random() * 0.04)) else round(st.n * (0.86 + random() * 0.11) * case when k = 30 then 0.4 else 1 end) end;
      if loc = 'LUCKY' and k >= 21 then q := round(q * 0.88); end if;
      c := round(st.c * case when loc = 'FARM' then 0.5 else 0.9 end); j := round(st.j * case when loc = 'FARM' then 0.3 else 0.9 end);
      if q + c + j <= 0 then continue; end if;
      v := _price(q, c, j);
      till := round(v * case loc when 'FARM' then 0.3 when 'VAN' then 0 when 'TUALA' then 0.5 when 'RAYAN' then 0.46 else 0.4 end / 10) * 10;
      pb := round(v * case loc when 'FARM' then 0.2 when 'VAN' then 0.42 when 'TUALA' then 0.1 when 'RAYAN' then 0.12 else 0.08 end / 10) * 10;
      cash := v - till - pb;
      insert into sales (location_id, n, c, j, value, cash, till, paybill, recorded_by, d, recorded_at)
      values (loc, q, c, j, v, cash, till, pb, (select id from staff where location_id = loc and role = 'pos'), d, (d + time '18:30')::timestamp at time zone 'Africa/Nairobi');
    end loop;
    -- banking every 3 days (van stops banking for the last week)
    for loc in select id from locations loop
      if (k + (select sort from locations where id = loc)) % 3 = 0 and not (loc = 'VAN' and k >= 24) and _balance('CASH:' || loc) > 2500 then
        insert into money_moves (kind, from_acc, to_acc, amount, note, ref, recorded_by, d) values ('move', 'CASH:' || loc, 'BANK', floor((_balance('CASH:' || loc) - 1500) / 100) * 100, 'Bank deposit', 'DEP' || (10000 + k), (select id from staff where location_id = loc and role = 'pos'), d);
      end if;
    end loop;
    if k % 7 = 6 then insert into money_moves (kind, from_acc, to_acc, amount, note, recorded_by, d) values ('move','TILL','BANK',floor(_balance('TILL') * 0.8 / 100) * 100,'Weekly till sweep',own,d); end if;
    if k % 7 = 2 then
      insert into money_moves (kind, from_acc, to_acc, amount, fee, note, ref, recorded_by, d) values ('move','PAYBILL','CASH:FARM',3000,53,'M-Pesa withdrawal to cash','QK'||k,own,d);
      insert into money_moves (kind, from_acc, amount, category, note, recorded_by, d) values ('expense','CASH:FARM',3000,'Casual labour','Weekly casual wages',own,d);
    end if;
    if k % 2 = 1 and _balance('CASH:VAN') > 600 then insert into money_moves (kind, from_acc, amount, category, note, recorded_by, d) values ('expense','CASH:VAN',600,'Fuel','Van fuel','00000000-0000-0000-0000-000000000005',d); end if;
  end loop;
  -- a cash shortfall at Lucky Summer 3 days ago
  insert into cash_counts (location_id, counted, expected, diff, recorded_by, d) values ('LUCKY', _balance('CASH:LUCKY') - 300, _balance('CASH:LUCKY'), -300, '00000000-0000-0000-0000-000000000008', biz_today() - 3) returning id into x;
  insert into money_moves (kind, to_acc, amount, note, cash_count_id, recorded_by, d) values ('variance','CASH:LUCKY',-300,'Cash count variance',x,'00000000-0000-0000-0000-000000000008',biz_today()-3);
  -- today's opening counts (Rayan not yet)
  insert into stock_counts (location_id, kind, cnt_n, cnt_c, cnt_j, adj_n, adj_c, adj_j, recorded_by, d)
  select l.id, 'open', 0, 0, 0, 0, 0, 0, (select id from staff where location_id = l.id and role = 'pos'), biz_today() from locations l where l.id <> 'RAYAN';
  update stock_counts sc set cnt_n = s.n, cnt_c = s.c, cnt_j = s.j from v_stock s where sc.kind = 'open' and sc.d = biz_today() and s.location_id = sc.location_id;
  insert into notifications (sev, title, body, to_roles, location_id, kind) values
    ('amber','Feed buffer dropped to Watch (57%)','180 kg left of the 315 kg weekly buffer. Order 3 bags to restore a full buffer.','{owner,manager,clerk}','FARM','feed'),
    ('info','Delivery on the way from Farm','2 tr sent. Confirm the count when it arrives.','{pos}','RAYAN','transfer');
end $$;

select location_id, n, c, j from v_stock order by 1;
select round(sum(balance)) funds from v_balances;
select round(_feed_stock()) feed;
