-- ---------------------------------------------------------------------
-- 5. Internal helpers (not callable by app users)
-- ---------------------------------------------------------------------
create or replace function public._require(p_roles public.staff_role[]) returns public.staff
language plpgsql stable security definer set search_path = public as $$
declare s staff;
begin
  select * into s from staff where id = auth.uid() and active;
  if s.id is null then raise exception 'You are not signed in, or your account is disabled' using errcode = '42501'; end if;
  if not (s.role = any (p_roles)) then raise exception 'This action is not available to your role' using errcode = '42501'; end if;
  return s;
end $$;

-- may this person act for this sales point / location?
create or replace function public._check_loc(s public.staff, p_loc text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from locations where id = p_loc) then raise exception 'Unknown location %', p_loc; end if;
  if s.role in ('owner','manager') then return; end if;
  if s.role = 'clerk' and p_loc = 'FARM' then return; end if;
  if s.role = 'pos' and s.location_id = p_loc then return; end if;
  raise exception 'You can only record for your own location' using errcode = '42501';
end $$;

create or replace function public._stock(p_loc text, out n int, out c int, out j int)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(m.n), 0)::int, coalesce(sum(m.c), 0)::int, coalesce(sum(m.j), 0)::int
    from v_stock_moves m where m.location_id = p_loc
$$;
create or replace function public._balance(p_acc text) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0) from v_money_lines where account_id = p_acc
$$;
create or replace function public._feed_stock() returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(kg), 0) from v_feed_lines
$$;
create or replace function public._tank() returns numeric
language sql stable security definer set search_path = public as $$
  select litres from water_logs where kind = 'tank' and voided_at is null order by recorded_at desc, id desc limit 1
$$;
create or replace function public._lock(p_key text) returns void
language sql security definer set search_path = public as $$
  select pg_advisory_xact_lock(hashtext(p_key))
$$;

create or replace function public.buffer_band(p_level numeric) returns text
language sql immutable as $$
  select case when p_level is null then 'none'
              when p_level >= 1    then 'full'
              when p_level >= 0.75 then 'good'
              when p_level >= 0.5  then 'watch'
              when p_level >= 0.25 then 'low'
              else 'none' end
$$;
create or replace function public.band_rank(p_band text) returns int
language sql immutable as $$ select array_position(array['full','good','watch','low','none'], p_band) $$;
create or replace function public.band_label(p_band text) returns text
language sql immutable as $$
  select case p_band when 'full' then 'Full buffer' when 'good' then 'Good' when 'watch' then 'Watch'
                     when 'low' then 'Low' else 'No buffer' end
$$;
create or replace function public.band_sev(p_band text) returns text
language sql immutable as $$
  select case p_band when 'none' then 'red' when 'low' then 'orange' when 'watch' then 'amber' else 'info' end
$$;

create or replace function public._price(p_n int, p_c int, p_j int) returns numeric
language sql stable security definer set search_path = public as $$
  select round((p_n / 30) * tray_n + (p_n % 30) * pc_n + p_c * tray_c / 30.0 + p_j * pc_j)
    from settings where id = 1
$$;

create or replace function public._notify(p_sev text, p_title text, p_body text, p_roles public.staff_role[],
                                          p_loc text default null, p_kind text default null) returns bigint
language sql security definer set search_path = public as $$
  insert into notifications (sev, title, body, to_roles, location_id, kind)
  values (p_sev, p_title, coalesce(p_body, ''), p_roles, p_loc, p_kind) returning id
$$;

create or replace function public._loc_short(p_loc text) returns text
language sql stable security definer set search_path = public as $$ select short from locations where id = p_loc $$;
create or replace function public._acc_name(p_acc text) returns text
language sql stable security definer set search_path = public as $$ select name from accounts where id = p_acc $$;

create or replace function public._kes(p numeric) returns text
language sql immutable as $$ select case when p < 0 then '-' else '' end || 'KES ' || to_char(abs(round(p)), 'FM999,999,999,990') $$;
create or replace function public._eggs(p int) returns text
language sql immutable as $$
  select case when abs(p) >= 30 then (abs(p) / 30)::text || ' tr' || case when abs(p) % 30 > 0 then ' ' || (abs(p) % 30)::text || ' pc' else '' end
              else abs(p)::text || ' pc' end
$$;

-- who may spend / move from which account
create or replace function public._check_acc(s public.staff, p_acc text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from accounts where id = p_acc) then raise exception 'Unknown account %', p_acc; end if;
  if s.role in ('owner','manager') then return; end if;
  if p_acc like 'CASH:%' and p_acc <> 'CASH:' || s.location_id then
    raise exception 'You can only use the cash at your own location' using errcode = '42501';
  end if;
  if s.role = 'pos' and p_acc = 'BANK' then raise exception 'Only management can pay from the bank' using errcode = '42501'; end if;
end $$;

create or replace function public._spend(s public.staff, p_acc text, p_amount numeric, p_category text, p_note text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_bal numeric;
begin
  perform _check_acc(s, p_acc);
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter the amount'; end if;
  perform _lock('acc:' || p_acc);
  v_bal := _balance(p_acc);
  if p_amount > v_bal then raise exception '% has only %', _acc_name(p_acc), _kes(v_bal); end if;
  insert into money_moves (kind, from_acc, amount, category, note, recorded_by)
  values ('expense', p_acc, p_amount, p_category, p_note, s.id) returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 6. App actions (RPC)
-- ---------------------------------------------------------------------

-- Production clerk ----------------------------------------------------
create or replace function public.rpc_collect(p_house text, p_n int, p_c int default 0, p_j int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_id bigint;
begin
  s := _require(array['owner','manager','clerk']::staff_role[]);
  if not exists (select 1 from houses where id = p_house and active) then raise exception 'Unknown house'; end if;
  if coalesce(p_n,0) < 0 or coalesce(p_c,0) < 0 or coalesce(p_j,0) < 0 then raise exception 'Egg numbers cannot be negative'; end if;
  if coalesce(p_n,0) + coalesce(p_c,0) + coalesce(p_j,0) = 0 then raise exception 'Enter the number of eggs collected'; end if;
  insert into egg_collections (house_id, n, c, j, recorded_by)
  values (p_house, coalesce(p_n,0), coalesce(p_c,0), coalesce(p_j,0), s.id) returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.rpc_mortality(p_house text, p_birds int, p_cause text default 'Unknown')
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_id bigint; v_name text;
begin
  s := _require(array['owner','manager','clerk']::staff_role[]);
  select name into v_name from houses where id = p_house;
  if v_name is null then raise exception 'Unknown house'; end if;
  if coalesce(p_birds,0) <= 0 then raise exception 'Enter the number of birds'; end if;
  insert into mortality (house_id, birds, cause, recorded_by) values (p_house, p_birds, coalesce(p_cause,'Unknown'), s.id) returning id into v_id;
  if p_birds >= 3 or p_cause = 'Disease suspected' then
    perform _notify('orange', format('%s bird%s died in %s', p_birds, case when p_birds > 1 then 's' else '' end, v_name),
                    format('Cause: %s.', coalesce(p_cause,'Unknown')), array['owner','manager']::staff_role[], 'FARM', 'mortality');
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.rpc_feed(p_kind text, p_kg numeric, p_house text default null, p_note text default null,
                                           p_bags numeric default null, p_cost numeric default null, p_paid_from text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; st settings; v_before numeric; v_after numeric; b0 text; b1 text; v_money bigint; v_notified boolean := false;
begin
  s := _require(array['owner','manager','clerk']::staff_role[]);
  select * into st from settings where id = 1;
  if p_kind not in ('in','use') then raise exception 'Unknown feed movement'; end if;
  if coalesce(p_kg, 0) <= 0 then raise exception 'Enter the kilograms of feed'; end if;
  perform _lock('feed');
  v_before := _feed_stock();
  if p_kind = 'use' and p_kg > v_before then raise exception 'Only % kg of feed is in store', trim_scale(round(v_before, 1)); end if;
  if p_kind = 'in' and p_paid_from is not null then
    if coalesce(p_cost, 0) <= 0 then raise exception 'Enter the cost to record the payment'; end if;
    v_money := _spend(s, p_paid_from, p_cost, 'Feed', coalesce(p_note, 'Feed purchase') ||
                      case when p_bags is not null then format(', %s bags', p_bags) else '' end);
  end if;
  insert into feed_moves (kind, kg, bags, cost, house, note, money_move_id, recorded_by)
  values (p_kind, p_kg, p_bags, p_cost, p_house, p_note, v_money, s.id);
  v_after := v_before + case when p_kind = 'in' then p_kg else -p_kg end;
  b0 := buffer_band(v_before / st.feed_buffer_kg);
  b1 := buffer_band(v_after / st.feed_buffer_kg);
  if band_rank(b1) > band_rank(b0) and band_rank(b1) >= 3 then
    v_notified := true;
    perform _notify(band_sev(b1),
      format('Feed buffer dropped to %s (%s%%)', band_label(b1), round(v_after / st.feed_buffer_kg * 100)),
      format('%s kg left of the %s kg weekly buffer. Order %s bags to restore a full buffer.',
             round(v_after), round(st.feed_buffer_kg), ceil(greatest(st.feed_buffer_kg - v_after, 0) / st.bag_kg)),
      array['owner','manager','clerk']::staff_role[], 'FARM', 'feed');
  end if;
  return jsonb_build_object('stock', v_after, 'level', v_after / st.feed_buffer_kg, 'band', b1,
                            'band_label', band_label(b1), 'notified', v_notified);
end $$;

create or replace function public.rpc_water(p_kind text, p_litres numeric, p_house text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; st settings; v_prev numeric; b0 text; b1 text; v_notified boolean := false;
begin
  s := _require(array['owner','manager','clerk']::staff_role[]);
  select * into st from settings where id = 1;
  if p_kind not in ('intake','tank') then raise exception 'Unknown water record'; end if;
  if p_litres is null or p_litres < 0 then raise exception 'Enter the litres'; end if;
  if p_kind = 'intake' then
    if not exists (select 1 from houses where id = p_house and active) then raise exception 'Choose the house'; end if;
    if p_litres = 0 then raise exception 'Enter the litres the birds drank'; end if;
  else
    if p_litres > st.tank_capacity_l then
      raise exception 'The tank holds % litres. Check the reading or update the tank size in settings', round(st.tank_capacity_l);
    end if;
  end if;
  perform _lock('water');
  v_prev := _tank();
  insert into water_logs (kind, house_id, litres, note, recorded_by)
  values (p_kind, case when p_kind = 'intake' then p_house end, p_litres, p_note, s.id);
  if p_kind = 'tank' then
    b0 := buffer_band(coalesce(v_prev, st.tank_capacity_l) / st.tank_capacity_l);
    b1 := buffer_band(p_litres / st.tank_capacity_l);
    if band_rank(b1) > band_rank(b0) and band_rank(b1) >= 3 then
      v_notified := true;
      perform _notify(band_sev(b1), format('Water tank at %s%% (%s)', round(p_litres / st.tank_capacity_l * 100), band_label(b1)),
        format('%s of %s litres left. Refill the tank.', round(p_litres), round(st.tank_capacity_l)),
        array['owner','manager','clerk']::staff_role[], 'FARM', 'water');
    end if;
    return jsonb_build_object('litres', p_litres, 'level', p_litres / st.tank_capacity_l, 'band', b1,
                              'band_label', band_label(b1), 'notified', v_notified);
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.rpc_med(p_medicine bigint, p_kind text, p_qty numeric, p_house text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; m medicines; v_stock numeric;
begin
  s := _require(array['owner','manager','clerk']::staff_role[]);
  select * into m from medicines where id = p_medicine;
  if m.id is null then raise exception 'Unknown medicine'; end if;
  if p_kind not in ('in','use') then raise exception 'Unknown movement'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'Enter a quantity'; end if;
  perform _lock('med:' || p_medicine);
  select qty into v_stock from v_med_stock where medicine_id = p_medicine;
  if p_kind = 'use' and p_qty > v_stock then raise exception 'Only % % in store', v_stock, m.unit; end if;
  insert into med_moves (medicine_id, kind, qty, house, note, recorded_by)
  values (p_medicine, p_kind, p_qty, case when p_kind = 'use' then p_house end, p_note, s.id);
  v_stock := v_stock + case when p_kind = 'in' then p_qty else -p_qty end;
  if p_kind = 'use' and v_stock <= m.reorder and v_stock + p_qty > m.reorder then
    perform _notify('amber', format('%s below reorder level', m.name), format('%s %s left. Reorder level is %s.', v_stock, m.unit, m.reorder),
                    array['owner','manager','clerk']::staff_role[], 'FARM', 'medicine');
  end if;
  return jsonb_build_object('stock', v_stock, 'low', v_stock <= m.reorder);
end $$;

create or replace function public.rpc_schedule_done(p_id bigint, p_done boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner','manager','clerk']::staff_role[]);
  update schedule set done = p_done, done_at = case when p_done then now() end, done_by = case when p_done then s.id end where id = p_id;
end $$;

-- Stock movement --------------------------------------------------------
create or replace function public.rpc_dispatch(p_from text, p_to text, p_n int, p_c int default 0, p_j int default 0, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; st record; v_id bigint;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  perform _check_loc(s, p_from);
  if not exists (select 1 from locations where id = p_to) then raise exception 'Unknown destination'; end if;
  if p_from = p_to then raise exception 'Choose a different destination'; end if;
  p_n := coalesce(p_n,0); p_c := coalesce(p_c,0); p_j := coalesce(p_j,0);
  if p_n < 0 or p_c < 0 or p_j < 0 then raise exception 'Quantities cannot be negative'; end if;
  if p_n + p_c + p_j = 0 then raise exception 'Enter what you are sending'; end if;
  perform _lock('stock:' || p_from);
  st := _stock(p_from);
  if p_n > st.n then raise exception 'Only % normal eggs in stock at %', _eggs(st.n), _loc_short(p_from); end if;
  if p_c > st.c then raise exception 'Only % cracked eggs in stock', st.c; end if;
  if p_j > st.j then raise exception 'Only % jumbo eggs in stock', st.j; end if;
  insert into transfers (from_loc, to_loc, sent_n, sent_c, sent_j, note, recorded_by)
  values (p_from, p_to, p_n, p_c, p_j, p_note, s.id) returning id into v_id;
  perform _notify('info', format('Delivery on the way from %s', _loc_short(p_from)),
                  format('%s sent. Confirm the count when it arrives.', _eggs(p_n + p_c + p_j)), array['pos']::staff_role[], p_to, 'transfer');
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.rpc_receive(p_transfer bigint, p_n int, p_c int default null, p_j int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; x transfers; v_short int;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  select * into x from transfers where id = p_transfer and voided_at is null for update;
  if x.id is null then raise exception 'Delivery not found'; end if;
  if x.status <> 'in_transit' then raise exception 'This delivery was already received'; end if;
  perform _check_loc(s, x.to_loc);
  p_c := coalesce(p_c, x.sent_c); p_j := coalesce(p_j, x.sent_j);
  if p_n < 0 or p_c < 0 or p_j < 0 then raise exception 'Quantities cannot be negative'; end if;
  if p_n > x.sent_n or p_c > x.sent_c or p_j > x.sent_j then raise exception 'You cannot receive more than was sent'; end if;
  update transfers set status = 'received', received_at = now(), received_d = biz_today(), received_by = s.id,
                       recv_n = p_n, recv_c = p_c, recv_j = p_j where id = x.id;
  insert into breakages (location_id, item, qty, reason, transit, transfer_id, recorded_by)
  select x.to_loc, i.item, i.q, 'Transit breakage', true, x.id, s.id
    from (values ('N', x.sent_n - p_n), ('C', x.sent_c - p_c), ('J', x.sent_j - p_j)) as i(item, q)
   where i.q > 0;
  v_short := (x.sent_n + x.sent_c + x.sent_j) - (p_n + p_c + p_j);
  if v_short > 0 then
    perform _notify('amber', format('%s short on delivery to %s', _eggs(v_short), _loc_short(x.to_loc)),
                    format('Sent %s, received %s. Logged as transit breakage.', _eggs(x.sent_n + x.sent_c + x.sent_j), _eggs(p_n + p_c + p_j)),
                    array['owner','manager']::staff_role[], x.to_loc, 'transfer');
  end if;
  return jsonb_build_object('short', v_short);
end $$;

create or replace function public.rpc_breakage(p_loc text, p_item text, p_qty int, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; st record; v_have int;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  perform _check_loc(s, p_loc);
  if p_item not in ('N','C','J') then raise exception 'Choose the type of egg'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'Enter how many eggs were lost'; end if;
  perform _lock('stock:' || p_loc);
  st := _stock(p_loc);
  v_have := case p_item when 'N' then st.n when 'C' then st.c else st.j end;
  if p_qty > v_have then raise exception 'Only % on hand', v_have; end if;
  insert into breakages (location_id, item, qty, reason, recorded_by) values (p_loc, p_item, p_qty, coalesce(p_reason, 'Breakage'), s.id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public._do_stock_count(s public.staff, p_loc text, p_kind text, p_n int, p_c int, p_j int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare st record; a_n int; a_c int; a_j int;
begin
  perform _check_loc(s, p_loc);
  if p_kind not in ('open','close','opening_balance') then raise exception 'Unknown count'; end if;
  if p_n < 0 or p_c < 0 or p_j < 0 then raise exception 'Counts cannot be negative'; end if;
  perform _lock('stock:' || p_loc);
  st := _stock(p_loc);
  a_n := p_n - st.n; a_c := p_c - st.c; a_j := p_j - st.j;
  insert into stock_counts (location_id, kind, cnt_n, cnt_c, cnt_j, adj_n, adj_c, adj_j, recorded_by)
  values (p_loc, p_kind, p_n, p_c, p_j, a_n, a_c, a_j, s.id);
  if p_kind <> 'opening_balance' and (a_n <> 0 or a_c <> 0 or a_j <> 0) then
    perform _notify('amber', format('Stock count variance at %s', _loc_short(p_loc)),
      format('%s count differs from the book by %s%s pieces (normal %s, cracked %s, jumbo %s).',
             case p_kind when 'open' then 'Opening' else 'Closing' end,
             case when a_n + a_c + a_j > 0 then '+' else '' end, a_n + a_c + a_j, a_n, a_c, a_j),
      array['owner','manager']::staff_role[], p_loc, 'count');
  end if;
  return jsonb_build_object('adj_n', a_n, 'adj_c', a_c, 'adj_j', a_j, 'book_n', st.n, 'book_c', st.c, 'book_j', st.j);
end $$;

create or replace function public._do_cash_count(s public.staff, p_loc text, p_counted numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_acc text := 'CASH:' || p_loc; v_exp numeric; v_diff numeric; v_id bigint; st settings;
begin
  perform _check_loc(s, p_loc);
  if p_counted is null or p_counted < 0 then raise exception 'Enter the cash counted'; end if;
  select * into st from settings where id = 1;
  perform _lock('acc:' || v_acc);
  v_exp := _balance(v_acc);
  v_diff := p_counted - v_exp;
  insert into cash_counts (location_id, counted, expected, diff, recorded_by) values (p_loc, p_counted, v_exp, v_diff, s.id) returning id into v_id;
  if v_diff <> 0 then
    insert into money_moves (kind, to_acc, amount, note, cash_count_id, recorded_by)
    values ('variance', v_acc, v_diff, 'Cash count variance', v_id, s.id);
    if abs(v_diff) >= st.cash_tol then
      perform _notify('orange', format('Cash %s %s at %s', case when v_diff < 0 then 'short' else 'over' end, _kes(abs(v_diff)), _loc_short(p_loc)),
                      format('Counted %s, expected %s.', _kes(p_counted), _kes(v_exp)), array['owner']::staff_role[], p_loc, 'cash');
    end if;
  end if;
  return jsonb_build_object('expected', v_exp, 'diff', v_diff);
end $$;

create or replace function public.rpc_stock_count(p_loc text, p_kind text, p_n int, p_c int, p_j int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  if p_kind = 'opening_balance' and s.role <> 'owner' then raise exception 'Only the owner sets opening balances'; end if;
  return _do_stock_count(s, p_loc, p_kind, p_n, p_c, p_j);
end $$;

create or replace function public.rpc_cash_count(p_loc text, p_counted numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  return _do_cash_count(s, p_loc, p_counted);
end $$;

create or replace function public.rpc_close_day(p_loc text, p_n int, p_c int, p_j int, p_cash numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; a jsonb; b jsonb;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  a := _do_stock_count(s, p_loc, 'close', p_n, p_c, p_j);
  b := _do_cash_count(s, p_loc, p_cash);
  return a || b;
end $$;

-- Sales ----------------------------------------------------------------
create or replace function public.rpc_sale(p_loc text, p_n int, p_c int, p_j int,
                                           p_cash numeric, p_till numeric, p_paybill numeric, p_customer text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; st record; v_value numeric; v_id bigint;
begin
  s := _require(array['owner','manager','pos']::staff_role[]);
  perform _check_loc(s, p_loc);
  p_n := coalesce(p_n,0); p_c := coalesce(p_c,0); p_j := coalesce(p_j,0);
  p_cash := coalesce(p_cash,0); p_till := coalesce(p_till,0); p_paybill := coalesce(p_paybill,0);
  if p_n < 0 or p_c < 0 or p_j < 0 or p_cash < 0 or p_till < 0 or p_paybill < 0 then raise exception 'Numbers cannot be negative'; end if;
  if p_n + p_c + p_j = 0 then raise exception 'Enter the eggs sold'; end if;
  perform _lock('stock:' || p_loc);
  st := _stock(p_loc);
  if p_n > st.n then raise exception 'Only % normal eggs on the shelf', _eggs(st.n); end if;
  if p_c > st.c then raise exception 'Only % cracked eggs on the shelf', st.c; end if;
  if p_j > st.j then raise exception 'Only % jumbo eggs on the shelf', st.j; end if;
  v_value := _price(p_n, p_c, p_j);
  if p_cash + p_till + p_paybill <> v_value then
    raise exception 'Payments (%) must equal the amount due (%)', _kes(p_cash + p_till + p_paybill), _kes(v_value);
  end if;
  insert into sales (location_id, n, c, j, value, cash, till, paybill, customer, recorded_by)
  values (p_loc, p_n, p_c, p_j, v_value, p_cash, p_till, p_paybill, nullif(trim(p_customer), ''), s.id) returning id into v_id;
  return jsonb_build_object('id', v_id, 'value', v_value);
end $$;

-- Money ----------------------------------------------------------------
create or replace function public.rpc_expense(p_from text, p_amount numeric, p_category text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  return jsonb_build_object('id', _spend(s, p_from, p_amount, coalesce(p_category, 'Other'), p_note));
end $$;

create or replace function public.rpc_move_money(p_from text, p_to text, p_amount numeric, p_fee numeric default 0,
                                                 p_ref text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_bal numeric; v_id bigint;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  if p_from = p_to then raise exception 'Choose two different accounts'; end if;
  if not exists (select 1 from accounts where id = p_from) or not exists (select 1 from accounts where id = p_to) then
    raise exception 'Unknown account';
  end if;
  if s.role not in ('owner','manager') then
    -- staff may only move money in or out of their own cash drawer
    if p_from <> 'CASH:' || s.location_id and p_to <> 'CASH:' || s.location_id then
      raise exception 'You can only move money in or out of your own cash' using errcode = '42501';
    end if;
    if (p_from like 'CASH:%' and p_from <> 'CASH:' || s.location_id) or (p_to like 'CASH:%' and p_to <> 'CASH:' || s.location_id) then
      raise exception 'You cannot move money into another location''s cash' using errcode = '42501';
    end if;
  end if;
  p_fee := coalesce(p_fee, 0);
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter the amount'; end if;
  if p_fee < 0 then raise exception 'Charges cannot be negative'; end if;
  -- lock both accounts in a fixed order to avoid deadlocks
  perform _lock('acc:' || least(p_from, p_to)); perform _lock('acc:' || greatest(p_from, p_to));
  v_bal := _balance(p_from);
  if p_amount + p_fee > v_bal then raise exception '% has only %', _acc_name(p_from), _kes(v_bal); end if;
  insert into money_moves (kind, from_acc, to_acc, amount, fee, ref, note, recorded_by)
  values ('move', p_from, p_to, p_amount, p_fee, nullif(trim(p_ref), ''),
          coalesce(nullif(trim(p_note), ''),
            case when p_to = 'BANK' then 'Bank deposit'
                 when p_to like 'CASH:%' and p_from in ('TILL','PAYBILL') then 'M-Pesa withdrawal to cash'
                 when p_to like 'CASH:%' and p_from = 'BANK' then 'Bank withdrawal to cash'
                 when p_to = 'PAYBILL' then 'Deposit to Paybill'
                 else 'Transfer' end), s.id)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- Corrections ------------------------------------------------------------
create or replace function public.rpc_void(p_kind text, p_id bigint, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare s staff; v_table text; v_n int;
begin
  s := _require(array['owner','manager']::staff_role[]);
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason for the correction'; end if;
  v_table := case p_kind
    when 'collect' then 'egg_collections' when 'mort' then 'mortality' when 'feed' then 'feed_moves'
    when 'water' then 'water_logs' when 'med' then 'med_moves' when 'xfer' then 'transfers'
    when 'sale' then 'sales' when 'brk' then 'breakages' when 'count' then 'stock_counts'
    when 'money' then 'money_moves' when 'cash' then 'cash_counts' end;
  if v_table is null then raise exception 'Unknown record type'; end if;
  execute format('update %I set voided_at = now(), voided_by = $1, void_reason = $2 where id = $3 and voided_at is null', v_table)
    using s.id, p_reason, p_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'Record not found or already corrected'; end if;
  -- linked records go with it
  if p_kind = 'xfer' then
    update breakages set voided_at = now(), voided_by = s.id, void_reason = 'Delivery voided: ' || p_reason where transfer_id = p_id and voided_at is null;
  elsif p_kind = 'cash' then
    update money_moves set voided_at = now(), voided_by = s.id, void_reason = 'Cash count voided: ' || p_reason where cash_count_id = p_id and voided_at is null;
  elsif p_kind = 'feed' then
    update money_moves set voided_at = now(), voided_by = s.id, void_reason = 'Feed record voided: ' || p_reason
     where id = (select money_move_id from feed_moves where id = p_id) and voided_at is null;
  end if;
end $$;

-- Owner setup --------------------------------------------------------------
create or replace function public.rpc_save_settings(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner']::staff_role[]);
  update settings t set
    tray_n          = coalesce((p->>'tray_n')::numeric, t.tray_n),
    pc_n            = coalesce((p->>'pc_n')::numeric, t.pc_n),
    tray_c          = coalesce((p->>'tray_c')::numeric, t.tray_c),
    pc_j            = coalesce((p->>'pc_j')::numeric, t.pc_j),
    feed_buffer_kg  = coalesce((p->>'feed_buffer_kg')::numeric, t.feed_buffer_kg),
    bag_kg          = coalesce((p->>'bag_kg')::numeric, t.bag_kg),
    bag_price       = coalesce((p->>'bag_price')::numeric, t.bag_price),
    tank_capacity_l = coalesce((p->>'tank_capacity_l')::numeric, t.tank_capacity_l),
    water_drop_pct  = coalesce((p->>'water_drop_pct')::numeric, t.water_drop_pct),
    water_ratio_min = coalesce((p->>'water_ratio_min')::numeric, t.water_ratio_min),
    water_ratio_max = coalesce((p->>'water_ratio_max')::numeric, t.water_ratio_max),
    cash_tol        = coalesce((p->>'cash_tol')::numeric, t.cash_tol),
    unbanked_max    = coalesce((p->>'unbanked_max')::numeric, t.unbanked_max),
    break_tol       = coalesce((p->>'break_tol')::numeric, t.break_tol),
    lay_drop_pts    = coalesce((p->>'lay_drop_pts')::numeric, t.lay_drop_pts),
    updated_at      = now()
  where id = 1;
end $$;

create or replace function public.rpc_save_house(p_id text, p_name text, p_birds int, p_start date, p_age numeric,
                                                 p_expected numeric, p_active boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner','manager']::staff_role[]);
  if coalesce(trim(p_id), '') = '' or coalesce(trim(p_name), '') = '' then raise exception 'Give the house a code and a name'; end if;
  if p_expected > 1 then p_expected := p_expected / 100; end if;  -- accept 93 or 0.93
  insert into houses (id, name, birds_at_start, start_date, age_weeks_at_start, expected_lay, active, sort)
  values (upper(trim(p_id)), trim(p_name), coalesce(p_birds, 0), coalesce(p_start, biz_today()), coalesce(p_age, 0),
          coalesce(p_expected, 0.9), coalesce(p_active, true), (select coalesce(max(sort), 0) + 1 from houses))
  on conflict (id) do update set name = excluded.name, birds_at_start = excluded.birds_at_start, start_date = excluded.start_date,
     age_weeks_at_start = excluded.age_weeks_at_start, expected_lay = excluded.expected_lay, active = excluded.active;
end $$;

create or replace function public.rpc_save_medicine(p_id bigint, p_name text, p_unit text, p_reorder numeric, p_active boolean default true)
returns bigint language plpgsql security definer set search_path = public as $$
declare s staff; v_id bigint;
begin
  s := _require(array['owner','manager']::staff_role[]);
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_unit), '') = '' then raise exception 'Enter a name and unit'; end if;
  if p_id is null then
    insert into medicines (name, unit, reorder, active) values (trim(p_name), trim(p_unit), coalesce(p_reorder, 0), coalesce(p_active, true)) returning id into v_id;
  else
    update medicines set name = trim(p_name), unit = trim(p_unit), reorder = coalesce(p_reorder, 0), active = coalesce(p_active, true)
     where id = p_id returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.rpc_save_schedule(p_id bigint, p_due date, p_house text, p_task text)
returns bigint language plpgsql security definer set search_path = public as $$
declare s staff; v_id bigint;
begin
  s := _require(array['owner','manager']::staff_role[]);
  if p_due is null or coalesce(trim(p_task), '') = '' then raise exception 'Enter the date and the task'; end if;
  if p_id is null then
    insert into schedule (due, house, task) values (p_due, coalesce(nullif(trim(p_house), ''), 'All houses'), trim(p_task)) returning id into v_id;
  else
    update schedule set due = p_due, house = coalesce(nullif(trim(p_house), ''), 'All houses'), task = trim(p_task) where id = p_id returning id into v_id;
  end if;
  return v_id;
end $$;

-- tasks are never deleted; a cancelled task drops off the schedule but stays on record
alter table public.schedule add column if not exists cancelled boolean not null default false;
create or replace function public.rpc_cancel_schedule(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require(array['owner','manager']::staff_role[]);
  update schedule set cancelled = true where id = p_id;
end $$;

-- Opening balances: owner enters the physical counts on go-live day. Each is
-- recorded as an adjustment from whatever the system currently shows.
create or replace function public.rpc_opening_balances(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; k text; v jsonb; v_cur numeric; v_feed numeric;
begin
  s := _require(array['owner']::staff_role[]);
  for k, v in select * from jsonb_each(coalesce(p->'stock', '{}')) loop
    perform _do_stock_count(s, k, 'opening_balance', coalesce((v->>'n')::int, 0), coalesce((v->>'c')::int, 0), coalesce((v->>'j')::int, 0));
  end loop;
  for k, v in select * from jsonb_each(coalesce(p->'money', '{}')) loop
    if not exists (select 1 from accounts where id = k) then raise exception 'Unknown account %', k; end if;
    perform _lock('acc:' || k);
    v_cur := _balance(k);
    if (v #>> '{}')::numeric <> v_cur then
      insert into money_moves (kind, to_acc, amount, note, recorded_by) values ('opening', k, (v #>> '{}')::numeric - v_cur, 'Opening balance', s.id);
    end if;
  end loop;
  if p ? 'feed_kg' then
    perform _lock('feed');
    v_feed := _feed_stock();
    if (p->>'feed_kg')::numeric <> v_feed then
      insert into feed_moves (kind, kg, note, recorded_by) values ('adjust', (p->>'feed_kg')::numeric - v_feed, 'Opening balance', s.id);
    end if;
  end if;
  if p ? 'tank_l' then
    insert into water_logs (kind, litres, note, recorded_by) values ('tank', (p->>'tank_l')::numeric, 'Opening balance', s.id);
  end if;
  for k, v in select * from jsonb_each(coalesce(p->'medicines', '{}')) loop
    select qty into v_cur from v_med_stock where medicine_id = k::bigint;
    if (v #>> '{}')::numeric <> v_cur then
      insert into med_moves (medicine_id, kind, qty, note, recorded_by) values (k::bigint, 'adjust', (v #>> '{}')::numeric - v_cur, 'Opening balance', s.id);
    end if;
  end loop;
  update settings set go_live = coalesce(go_live, biz_today()) where id = 1;
  return jsonb_build_object('ok', true);
end $$;

-- Notifications ---------------------------------------------------------------
create or replace function public.rpc_mark_read(p_ids bigint[])
returns void language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  insert into notification_reads (notification_id, staff_id)
  select n.id, s.id from notifications n
   where n.id = any (p_ids) and s.role = any (n.to_roles)
  on conflict do nothing;
end $$;

create or replace function public.rpc_save_push(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  insert into push_subscriptions (staff_id, endpoint, p256dh, auth) values (s.id, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set staff_id = excluded.staff_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

-- A phone that unsubscribes is removed by push-notify the next time a send to it fails.

