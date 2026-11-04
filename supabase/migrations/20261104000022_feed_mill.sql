-- 4 Nov 2026: the farm mills its own layers feed (from the inventory clerk's
-- stock ledger). Raw materials come into the store, a recipe turns each tonne
-- milled into feed, and the feed goes into the feed store in bags.
--   * raw_materials: the list and the recipe (kg per tonne of feed). The farm's
--     recipe is loaded as the standard one; the owner or farm manager can change
--     it, and it must add up to 1,000 kg.
--   * raw_moves: deliveries ('in'), what milling used ('mill') and count
--     differences ('count'). mill_batches: each milling, with the recipe used.
--   * rpc_mill(action, p, date): raw_in, mill, raw_count (inventory clerk and
--     farm manager); rpc_recipe_save(rows) (owner and farm manager).
-- Changed, not new: activity(), dashboard(), rpc_month_book() and reminders()
-- (all read or internal functions added in the last few days) to carry the
-- store ledger. No existing row changes.

create table if not exists public.raw_materials (
  id bigint generated always as identity primary key,
  name text not null,
  per_tonne numeric not null default 0 check (per_tonne >= 0),   -- kg in each tonne of feed
  bag_kg numeric not null default 50 check (bag_kg > 0),
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists raw_materials_name on public.raw_materials (lower(name));

create table if not exists public.mill_batches (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  tonnes numeric not null check (tonnes > 0),
  recipe jsonb not null,                       -- [{material, name, per_tonne}] as used
  feed_move_id bigint references public.feed_moves(id),
  note text
);

create table if not exists public.raw_moves (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  material_id bigint not null references public.raw_materials(id),
  kind text not null check (kind in ('in', 'mill', 'count')),
  kg numeric not null,                         -- in: received; mill: used (positive); count: counted minus book
  counted numeric,                             -- count: what was counted
  batch_id bigint references public.mill_batches(id),
  note text,
  check ((kind = 'count') or kg > 0)
);
create index if not exists raw_moves_mat on public.raw_moves (material_id, d);

create or replace view public.v_raw_stock with (security_invoker = true) as
  select m.id as material_id,
         coalesce(sum(case when x.kind = 'mill' then -x.kg else x.kg end), 0) as kg
    from raw_materials m left join raw_moves x on x.material_id = m.id and x.voided_at is null
   group by m.id;
revoke all on public.v_raw_stock from public, anon, authenticated;
grant select on public.v_raw_stock to authenticated, service_role;

do $$ declare t text; begin
  foreach t in array array['raw_materials', 'mill_batches', 'raw_moves'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists read_farm on public.%I', t);
    execute format('create policy read_farm on public.%I for select to authenticated using ((select can_farm()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop trigger if exists zz_bump on public.%I', t);
    execute format('create trigger zz_bump after insert or update or delete on public.%I for each statement execute function public._bump()', t);
  end loop;
  foreach t in array array['mill_batches', 'raw_moves'] loop
    execute format('drop trigger if exists owner_view_only on public.%I', t);
    execute format('create trigger owner_view_only before insert or update or delete on public.%I for each row execute function public._owner_view_only()', t);
  end loop;
end $$;

-- the farm's recipe, from the stock ledger (kg per tonne of layers feed)
insert into public.raw_materials (name, per_tonne, bag_kg, sort)
select v.name, v.kg, 50, v.sort
  from (values ('Maize', 533, 1), ('Wheat bran', 180, 2), ('Soybean', 130, 3), ('Sunflower cake', 50, 4),
               ('Limestone (white)', 50, 5), ('Chick grit', 42, 6), ('Macropack', 15, 7)) v(name, kg, sort)
 where not exists (select 1 from public.raw_materials);

-- ---------------------------------------------------------------------
-- The inventory clerk's mill records
-- ---------------------------------------------------------------------
--   raw_in     {material, kg | bags, note?}       a delivery of a raw material
--   mill       {tonnes, note?}                    feed mixed: takes each material
--                                                 by the recipe, adds the feed to the store
--   raw_count  {material, counted_kg, note?}      what is really there; the difference is recorded
create or replace function public.rpc_mill(p_action text, p jsonb, p_date date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_d date; st settings; m raw_materials; v_kg numeric; v_t numeric; v_book numeric; v_short text;
        v_batch bigint; v_feed bigint; v_recipe jsonb; v_note text := nullif(trim(coalesce(p->>'note', '')), ''); r record;
begin
  s := _require(array['manager','store']::staff_role[]);
  v_d := _day(s, p_date);
  select * into st from settings where id = 1;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Nothing to save'; end if;
  if length(coalesce(v_note, '')) > 200 then raise exception 'The note is too long'; end if;
  perform _lock('mill');
  case p_action
  when 'raw_in' then
    select * into m from raw_materials where id = (p->>'material')::bigint and active;
    if m.id is null then raise exception 'Choose the raw material'; end if;
    v_kg := coalesce((p->>'kg')::numeric, 0) + coalesce((p->>'bags')::numeric, 0) * m.bag_kg;
    if v_kg <= 0 then raise exception 'Enter the bags or kg received'; end if;
    insert into raw_moves (d, material_id, kind, kg, note, recorded_by) values (v_d, m.id, 'in', v_kg, v_note, s.id);
    return jsonb_build_object('name', m.name, 'kg', v_kg, 'stock', (select kg from v_raw_stock where material_id = m.id));
  when 'raw_count' then
    select * into m from raw_materials where id = (p->>'material')::bigint;
    if m.id is null then raise exception 'Choose the raw material'; end if;
    v_kg := (p->>'counted_kg')::numeric;
    if v_kg is null or v_kg < 0 then raise exception 'Enter what you counted'; end if;
    select kg into v_book from v_raw_stock where material_id = m.id;
    insert into raw_moves (d, material_id, kind, kg, counted, note, recorded_by) values (v_d, m.id, 'count', v_kg - v_book, v_kg, v_note, s.id);
    return jsonb_build_object('name', m.name, 'book', v_book, 'counted', v_kg, 'difference', v_kg - v_book);
  when 'mill' then
    v_t := (p->>'tonnes')::numeric;
    if coalesce(v_t, 0) <= 0 then raise exception 'Enter the tonnes mixed'; end if;
    if v_t > 50 then raise exception 'That is more than a day''s milling. Check the tonnes'; end if;
    if (select coalesce(sum(per_tonne), 0) from raw_materials where active) <> 1000 then
      raise exception 'The recipe does not add up to 1,000 kg a tonne. Ask the farm manager to fix it under Setup';
    end if;
    -- every material must be in the store
    select string_agg(format('%s (needs %s kg, %s kg in store)', x.name, round(x.per_tonne * v_t), round(coalesce(v.kg, 0))), ', ' order by x.sort)
      into v_short
      from raw_materials x left join v_raw_stock v on v.material_id = x.id
     where x.active and x.per_tonne > 0 and coalesce(v.kg, 0) < x.per_tonne * v_t;
    if v_short is not null then
      raise exception 'Not enough in the store for % tonnes: %. Record the delivery or count the store first', v_t, v_short;
    end if;
    select jsonb_agg(jsonb_build_object('material', id, 'name', name, 'per_tonne', per_tonne) order by sort) into v_recipe
      from raw_materials where active and per_tonne > 0;
    perform _lock('feed');
    insert into feed_moves (d, kind, kg, bags, note, recorded_by)
    values (v_d, 'in', v_t * 1000, round(v_t * 1000 / st.bag_kg, 1), format('Milled on the farm: %s tonnes', v_t), s.id) returning id into v_feed;
    insert into mill_batches (d, tonnes, recipe, feed_move_id, note, recorded_by) values (v_d, v_t, v_recipe, v_feed, v_note, s.id) returning id into v_batch;
    for r in select * from raw_materials where active and per_tonne > 0 order by sort loop
      insert into raw_moves (d, material_id, kind, kg, batch_id, recorded_by) values (v_d, r.id, 'mill', r.per_tonne * v_t, v_batch, s.id);
    end loop;
    return jsonb_build_object('id', v_batch, 'tonnes', v_t, 'bags', round(v_t * 1000 / st.bag_kg, 1), 'feed_stock', _feed_stock());
  else
    raise exception 'Unknown mill record';
  end case;
end $$;

-- The raw material list and the recipe, saved together so it always adds up.
-- p_rows: [{id?, name, per_tonne, bag_kg, active}]
create or replace function public.rpc_recipe_save(p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare s staff; r jsonb; v_total numeric := 0; v_name text; i int := 0;
begin
  s := _require(array['owner','manager']::staff_role[]);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'Nothing to save'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_name := nullif(trim(coalesce(r->>'name', '')), '');
    if v_name is null then raise exception 'Every raw material needs a name'; end if;
    if length(v_name) > 60 then raise exception 'The name % is too long', v_name; end if;
    if coalesce((r->>'per_tonne')::numeric, -1) < 0 then raise exception 'Enter the kg per tonne for %', v_name; end if;
    if coalesce((r->>'bag_kg')::numeric, 0) <= 0 then raise exception 'Enter the bag size for %', v_name; end if;
    if coalesce((r->>'active')::boolean, true) then v_total := v_total + (r->>'per_tonne')::numeric; end if;
  end loop;
  if v_total <> 1000 then raise exception 'The recipe adds up to % kg. It must be 1,000 kg a tonne', v_total; end if;
  perform _lock('mill');
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_name := trim(r->>'name');
    if exists (select 1 from raw_materials where lower(name) = lower(v_name) and id is distinct from (r->>'id')::bigint) then
      raise exception 'There is already a raw material called %', v_name;
    end if;
    if r->>'id' is null then
      insert into raw_materials (name, per_tonne, bag_kg, active, sort)
      values (v_name, (r->>'per_tonne')::numeric, (r->>'bag_kg')::numeric, coalesce((r->>'active')::boolean, true), i);
    else
      update raw_materials set name = v_name, per_tonne = (r->>'per_tonne')::numeric, bag_kg = (r->>'bag_kg')::numeric,
             active = coalesce((r->>'active')::boolean, true), sort = i
       where id = (r->>'id')::bigint;
      if not found then raise exception 'Unknown raw material'; end if;
    end if;
  end loop;
end $$;

revoke execute on function public.rpc_mill(text, jsonb, date), public.rpc_recipe_save(jsonb) from public, anon;
grant execute on function public.rpc_mill(text, jsonb, date), public.rpc_recipe_save(jsonb) to authenticated, service_role;

-- =====================================================================
-- Read functions extended for the store ledger
-- (latest versions from migrations 18, 20 and 21, with the feed mill added)
-- =====================================================================

create or replace function public.activity(p_limit int default 60, p_before timestamptz default null,
                                           p_loc text default null, p_kind text default null, p_cursor jsonb default null)
returns table (kind text, id bigint, d date, recorded_at timestamptz, by_name text, by_role public.staff_role,
               location_id text, voided boolean, data jsonb)
language plpgsql stable security invoker set search_path = public as $$
declare c_d date := (p_cursor->>'d')::date; c_at timestamptz := (p_cursor->>'at')::timestamptz;
        c_k text := p_cursor->>'k'; c_id bigint := (p_cursor->>'id')::bigint;
begin
  perform _me_json();
  return query
  with a as (
    select 'collect'::text k, x.id, x.d, x.recorded_at, x.recorded_by, 'FARM'::text loc, x.voided_at is not null v, to_jsonb(x) j from egg_collections x
    union all select 'mort', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null, to_jsonb(x) from mortality x
    union all select 'feed', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null, to_jsonb(x) from feed_moves x
               where not exists (select 1 from mill_batches b where b.feed_move_id = x.id)   -- milled feed shows as the milling
    union all select 'water', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null, to_jsonb(x) from water_logs x
    union all select 'med', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null,
                     to_jsonb(x) || jsonb_build_object('medicine', m.name, 'unit', m.unit) from med_moves x join medicines m on m.id = x.medicine_id
    union all select 'xfer', x.id, x.d, x.recorded_at, x.recorded_by, x.from_loc, x.voided_at is not null, to_jsonb(x) from transfers x
    union all select 'sale', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from sales x
    union all select 'brk', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from breakages x
    union all select 'count', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from stock_counts x
    union all select 'issue', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from stock_adj x
    union all select 'money', x.id, x.d, x.recorded_at, x.recorded_by, null, x.voided_at is not null, to_jsonb(x) from money_moves x
    union all select 'cash', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from cash_counts x
    union all select 'credit', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from credit_payments x
    union all select 'supply', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null,
                     to_jsonb(x) || jsonb_build_object('item', i.name, 'unit', i.unit) from supply_moves x join supplies i on i.id = x.supply_id
    union all select 'confirm', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null,
                     to_jsonb(x) || coalesce((select jsonb_build_object('house', f.house, 'what', 'feed', 'unit', 'kg') from feed_moves f where x.kind = 'feed' and f.id = x.move_id),
                                             (select jsonb_build_object('house', mm.house, 'what', md.name, 'unit', md.unit) from med_moves mm join medicines md on md.id = mm.medicine_id
                                               where x.kind = 'med' and mm.id = x.move_id), '{}'::jsonb)
      from issue_confirms x
    union all select 'raw', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null,
                     to_jsonb(x) || jsonb_build_object('material', m.name, 'bag_kg', m.bag_kg) from raw_moves x join raw_materials m on m.id = x.material_id
               where x.kind <> 'mill'                                                   -- what milling used is in the milling record
    union all select 'mill', x.id, x.d, x.recorded_at, x.recorded_by, 'FARM', x.voided_at is not null,
                     to_jsonb(x) || jsonb_build_object('bags', (select f.bags from feed_moves f where f.id = x.feed_move_id)) from mill_batches x
  )
  select a.k, a.id, a.d, a.recorded_at, s.display_name, s.role, a.loc, a.v, a.j
    from a left join staff s on s.id = a.recorded_by
   where (p_before is null or a.recorded_at < p_before)
     and (p_cursor is null or (a.d, a.recorded_at, a.k, a.id) < (c_d, c_at, c_k, c_id))
     and (p_kind is null or a.k = p_kind)
     and (p_loc is null or a.loc = p_loc
          or (a.k = 'xfer' and a.j->>'to_loc' = p_loc)
          or (a.k = 'money' and (a.j->>'from_acc' = 'CASH:' || p_loc or a.j->>'to_acc' = 'CASH:' || p_loc)))
   order by a.d desc, a.recorded_at desc, a.k desc, a.id desc
   limit least(greatest(p_limit, 1), 500);
end $$;
revoke execute on function public.activity(int, timestamptz, text, text, jsonb) from public, anon;
grant execute on function public.activity(int, timestamptz, text, text, jsonb) to authenticated, service_role;

create or replace function public.dashboard(p_days int default 45)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare t date := biz_today(); f date := biz_today() - greatest(least(p_days, 400), 7); r jsonb; v_me jsonb;
begin
  v_me := _me_json();  -- raises AUTH_* unless this session is fully signed in
  select jsonb_build_object(
    'today', t, 'from', f, 'server_time', now(), 'version', (select last_value from data_change_seq),
    'me', v_me,
    'settings', (select to_jsonb(s) - 'push_url' from settings s where id = 1),
    'locations', (select coalesce(jsonb_agg(to_jsonb(l) order by l.sort), '[]') from locations l),
    'accounts', (select coalesce(jsonb_agg(to_jsonb(a) order by a.sort), '[]') from accounts a),
    'houses', (select coalesce(jsonb_agg(to_jsonb(h) order by h.sort), '[]') from houses h where h.active),
    'medicines', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'category', m.category, 'unit', m.unit, 'reorder', m.reorder,
                         'active', m.active, 'stock', coalesce(v.qty, 0)) order by m.category, m.name), '[]')
                    from medicines m left join v_med_stock v on v.medicine_id = m.id where can_farm()),
    'schedule', (select coalesce(jsonb_agg(to_jsonb(x) order by x.due), '[]') from schedule x where not x.cancelled and (x.due >= t - 14 or not x.done)),
    'staff', _staff_list(),
    'stock', (select coalesce(jsonb_agg(to_jsonb(v)), '[]') from v_stock v),
    'stock_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select location_id, d, kind, sum(n)::int n, sum(b)::int b, sum(c)::int c, sum(j)::int j from v_stock_moves where d >= f group by 1, 2, 3) x),
    'balances', (select coalesce(jsonb_agg(to_jsonb(v)), '[]') from v_balances v),
    'money_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select account_id, d, kind, sum(amount) amount from v_money_lines where d >= f group by 1, 2, 3) x),
    'sales_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select location_id, d, count(*)::int cnt, sum(value) value, sum(coalesce(list_value, value)) list_value,
               sum(cash) cash, sum(till) till, sum(paybill) paybill, sum(credit) credit,
               sum(n)::int n, sum(b)::int b, sum(c)::int c, sum(j)::int j, bool_or(imported) imported
          from sales where voided_at is null and d >= f group by 1, 2) x),
    'breakage_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select location_id, d, transit, sum(qty)::int qty from breakages where voided_at is null and d >= f group by 1, 2, 3) x),
    'received_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select to_loc location_id, received_d d, sum(sent_n + sent_b + sent_c + sent_j)::int sent, sum(recv_n + coalesce(recv_b,0) + recv_c + recv_j)::int recv
          from transfers where voided_at is null and status = 'received' and received_d >= f group by 1, 2) x),
    'farm_daily', case when can_farm() or is_mgmt() then (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from farm_daily2(f, t) x) else '[]'::jsonb end,
    'feed_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select d, kind, sum(kg) kg from v_feed_lines where d >= f group by 1, 2) x),
    'feed_stock', (select coalesce(sum(kg), 0) from v_feed_lines),
    'water_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select d, house_id, sum(litres) litres from water_logs where kind = 'intake' and voided_at is null and d >= f group by 1, 2) x),
    -- litres: the level now (last reading less water drunk since); reading: what the tank showed
    'tank', (select jsonb_build_object('litres', greatest(x.litres - x.drunk, 0), 'reading', x.litres, 'drunk_since', x.drunk,
                                       'recorded_at', x.recorded_at, 'd', x.d)
               from (select r.litres, r.recorded_at, r.d,
                            coalesce((select sum(w.litres) from water_logs w
                                       where w.kind = 'intake' and w.voided_at is null
                                         and (w.d > r.d or (w.d = r.d and w.recorded_at > r.recorded_at))), 0) drunk
                       from (select litres, recorded_at, d from water_logs where kind = 'tank' and voided_at is null
                              order by d desc, recorded_at desc, id desc limit 1) r) x),
    'tank_daily', (select coalesce(jsonb_agg(to_jsonb(x) order by x.d), '[]') from (
        select distinct on (d) d, litres from water_logs where kind = 'tank' and voided_at is null and d >= f order by d, recorded_at desc, id desc) x),
    'transit', (select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at), '[]') from transfers x where status = 'in_transit' and voided_at is null),
    'counts_today', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from stock_counts x where d = t and voided_at is null),
    'cash_counts_today', (select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at), '[]') from cash_counts x where d = t and voided_at is null),
    -- who still owes, by outlet and customer (the outlet's own only, for the person on duty)
    'credits', (select coalesce(jsonb_agg(to_jsonb(x) order by x.owed desc, x.customer), '[]') from (
        select o.location_id, (array_agg(o.customer order by o.d desc, o.id desc))[1] customer, sum(o.owed) owed,
               min(o.d) since, count(*)::int sales,
               (select max(p.d) from credit_payments p where p.voided_at is null and p.location_id = o.location_id
                   and lower(trim(p.customer)) = o.ckey) last_paid
          from (select s.id, s.d, s.location_id, s.customer, lower(trim(s.customer)) ckey,
                       s.credit - coalesce((select sum(p.amount) from credit_payments p where p.sale_id = s.id and p.voided_at is null), 0) owed
                  from sales s where s.voided_at is null and s.credit > 0) o
         where o.owed > 0
         group by o.location_id, o.ckey) x),
    -- the farm store: other supplies, and issues waiting for the production clerk
    'supplies', case when can_farm() then (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'category', x.category, 'unit', x.unit,
                         'reorder', x.reorder, 'active', x.active, 'stock', coalesce(v.qty, 0)) order by x.category, x.name), '[]')
                    from supplies x left join v_supply_stock v on v.supply_id = x.id) else '[]'::jsonb end,
    'store_pending', case when can_farm() then (select coalesce(jsonb_agg(to_jsonb(q) order by q.recorded_at), '[]') from (
        select 'feed' kind, f.id, f.d, f.recorded_at, f.house, f.house_id, 'Feed' what, f.kg qty, 'kg' unit, s.display_name by_name
          from feed_moves f left join staff s on s.id = f.recorded_by
         where f.need_confirm and f.voided_at is null and not exists (select 1 from issue_confirms c where c.kind = 'feed' and c.move_id = f.id and c.voided_at is null)
        union all
        select 'med', x.id, x.d, x.recorded_at, x.house, x.house_id, m.name, x.qty, m.unit, s.display_name
          from med_moves x join medicines m on m.id = x.medicine_id left join staff s on s.id = x.recorded_by
         where x.need_confirm and x.voided_at is null and not exists (select 1 from issue_confirms c where c.kind = 'med' and c.move_id = x.id and c.voided_at is null)) q)
      else '[]'::jsonb end,
    -- the feed mill: raw materials with the recipe and what is in the store, and the tonnes milled each day
    'raw', case when can_farm() then (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'per_tonne', m.per_tonne, 'bag_kg', m.bag_kg,
                         'active', m.active, 'sort', m.sort, 'stock', coalesce(v.kg, 0)) order by m.sort, m.id), '[]')
                    from raw_materials m left join v_raw_stock v on v.material_id = m.id) else '[]'::jsonb end,
    'mill_daily', case when can_farm() then (select coalesce(jsonb_agg(to_jsonb(x) order by x.d), '[]') from (
        select d, sum(tonnes) tonnes, count(*)::int batches from mill_batches where voided_at is null and d >= f group by d) x) else '[]'::jsonb end,
    'notifications', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]') from (
        select n.*, exists (select 1 from notification_reads r where r.notification_id = n.id and r.staff_id = auth.uid()) as read
          from notifications n where n.created_at > now() - interval '14 days' order by n.created_at desc limit 50) x)
  ) into r;
  return r;
end $$;
revoke execute on function public.dashboard(int) from public, anon;
grant execute on function public.dashboard(int) to authenticated, service_role;

create or replace function public.rpc_month_book(p_month date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s staff; t date := biz_today(); m0 date; m1 date; v_first date; r jsonb;
begin
  s := _require(array['owner','manager']::staff_role[]);
  m0 := date_trunc('month', coalesce(p_month, t))::date;
  if m0 > t then raise exception 'That month has not started yet'; end if;
  if m0 < date_trunc('month', t - 800)::date then raise exception 'Choose a more recent month'; end if;
  m1 := least((m0 + interval '1 month' - interval '1 day')::date, t);
  select least((select min(d) from sales where voided_at is null), (select min(d) from stock_counts where voided_at is null),
               (select min(d) from transfers where voided_at is null), (select min(d) from egg_collections where voided_at is null))
    into v_first;

  with days as (select g::date d from generate_series(m0, m1, interval '1 day') g),
  grid as (select l.id loc, l.sort, x.d from locations l cross join days x),
  rows as (
    select g.loc, g.sort, g.d,
      (select c.cnt_n + c.cnt_b + c.cnt_c + c.cnt_j from stock_counts c where c.location_id = g.loc and c.d = g.d and c.voided_at is null
          and c.kind in ('open', 'opening_balance') order by c.recorded_at, c.id limit 1) open_cnt,
      (select c.cnt_n + c.cnt_b + c.cnt_c + c.cnt_j from stock_counts c where c.location_id = g.loc and c.d = g.d - 1 and c.voided_at is null
          and c.kind = 'close' order by c.recorded_at desc, c.id desc limit 1) prev_close,
      (select coalesce(sum(v.n + v.b + v.c + v.j), 0) from v_stock_moves v where v.location_id = g.loc and v.d < g.d) book_open,
      (select c.cnt_n + c.cnt_b + c.cnt_c + c.cnt_j from stock_counts c where c.location_id = g.loc and c.d = g.d and c.voided_at is null
          and c.kind = 'close' order by c.recorded_at desc, c.id desc limit 1) close_cnt,
      (select coalesce(sum(x.recv_n + coalesce(x.recv_b, 0) + x.recv_c + x.recv_j), 0) from transfers x
        where x.to_loc = g.loc and x.received_d = g.d and x.status = 'received' and x.voided_at is null) recv_xfer,
      case when g.loc = 'FARM' then (select coalesce(sum(e.n + e.b + e.c + e.j), 0) from egg_collections e where e.d = g.d and e.voided_at is null) else 0 end collected,
      (select coalesce(sum(a.n + a.b + a.c + a.j), 0) from stock_adj a where a.location_id = g.loc and a.d = g.d and a.kind = 'in' and a.voided_at is null) taken_in,
      (select coalesce(sum(x.sent_n + coalesce(x.sent_b, 0) + x.sent_c + x.sent_j), 0) from transfers x
        where x.from_loc = g.loc and x.d = g.d and x.voided_at is null) sent,
      (select coalesce(sum(b.qty), 0) from breakages b where b.location_id = g.loc and b.d = g.d and not b.transit and b.voided_at is null) broken,
      (select coalesce(sum(a.n + a.b + a.c + a.j), 0) from stock_adj a where a.location_id = g.loc and a.d = g.d and a.kind = 'out' and a.voided_at is null) issued,
      sa.*,
      (select coalesce(sum(p.amount), 0) from credit_payments p where p.location_id = g.loc and p.d = g.d and p.voided_at is null) credit_paid
    from grid g
    cross join lateral (
      select count(*)::int sales, coalesce(sum(x.n + x.b + x.c + x.j), 0) sold, coalesce(sum(x.value), 0) value,
             coalesce(sum(coalesce(x.list_value, x.value)), 0) list_value,
             coalesce(sum(x.cash), 0) cash, coalesce(sum(x.till), 0) till, coalesce(sum(x.paybill), 0) paybill, coalesce(sum(x.credit), 0) credit,
             -- eggs paid by each mode: a sale paid two ways is split by the money
             coalesce(sum(case when x.value > 0 then (x.n + x.b + x.c + x.j) * x.cash / x.value end), 0) e_cash,
             coalesce(sum(case when x.value > 0 then (x.n + x.b + x.c + x.j) * x.till / x.value end), 0) e_till,
             coalesce(sum(case when x.value > 0 then (x.n + x.b + x.c + x.j) * x.paybill / x.value end), 0) e_paybill,
             coalesce(sum(case when x.value > 0 then (x.n + x.b + x.c + x.j) * x.credit / x.value end), 0) e_credit,
             bool_or(x.imported) imported
        from sales x where x.location_id = g.loc and x.d = g.d and x.voided_at is null) sa
  )
  select jsonb_build_object(
    'month', m0, 'from', m0, 'to', m1, 'today', t, 'first_month', date_trunc('month', coalesce(v_first, t))::date,
    'generated_at', now(), 'tray', 30,
    'locations', (select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'short', l.short) order by l.sort) from locations l),
    'rows', coalesce((select jsonb_agg(to_jsonb(x) - 'sort' order by x.sort, x.d) from rows x), '[]'::jsonb),
    -- the store ledger: each raw material on each day it moved, as the inventory clerk's ledger lays it out
    'materials', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'per_tonne', m.per_tonne, 'bag_kg', m.bag_kg, 'active', m.active,
                     'open', (select coalesce(sum(case when x.kind = 'mill' then -x.kg else x.kg end), 0) from raw_moves x where x.material_id = m.id and x.voided_at is null and x.d < m0),
                     'close', (select coalesce(sum(case when x.kind = 'mill' then -x.kg else x.kg end), 0) from raw_moves x where x.material_id = m.id and x.voided_at is null and x.d <= m1))
                   order by m.sort, m.id), '[]') from raw_materials m),
    'ledger', (select coalesce(jsonb_agg(to_jsonb(q) order by q.d, q.sort, q.material_id), '[]') from (
        select x.d, x.material_id, m.sort,
               (select coalesce(sum(b.tonnes), 0) from mill_batches b where b.d = x.d and b.voided_at is null) tonnes,
               (select coalesce(sum(case when y.kind = 'mill' then -y.kg else y.kg end), 0) from raw_moves y
                 where y.material_id = x.material_id and y.voided_at is null and y.d < x.d) opening,
               coalesce(sum(x.kg) filter (where x.kind = 'in'), 0) purchase,
               coalesce(sum(x.kg) filter (where x.kind = 'mill'), 0) used,
               coalesce(sum(x.kg) filter (where x.kind = 'count'), 0) adjust
          from raw_moves x join raw_materials m on m.id = x.material_id
         where x.voided_at is null and x.d between m0 and m1
         group by x.d, x.material_id, m.sort) q),
    -- feed each day: milled, bought in, given to each house, and the eggs collected
    'feed', (select coalesce(jsonb_agg(to_jsonb(q) order by q.d), '[]') from (
        select x.d,
               (select coalesce(sum(f.kg), 0) from feed_moves f where f.d = x.d and f.voided_at is null and f.kind = 'in'
                   and exists (select 1 from mill_batches b where b.feed_move_id = f.id)) milled,
               (select coalesce(sum(f.kg), 0) from feed_moves f where f.d = x.d and f.voided_at is null and f.kind = 'in'
                   and not exists (select 1 from mill_batches b where b.feed_move_id = f.id)) bought,
               (select coalesce(sum(f.kg), 0) from feed_moves f where f.d = x.d and f.voided_at is null and f.kind = 'use') used,
               (select coalesce(jsonb_object_agg(h.house, h.kg), '{}'::jsonb) from (
                   select coalesce(f.house, 'Not given') house, sum(f.kg) kg from feed_moves f
                    where f.d = x.d and f.voided_at is null and f.kind = 'use' group by 1) h) houses,
               (select coalesce(sum(f.kg), 0) from feed_moves f where f.d = x.d and f.voided_at is null and f.kind = 'adjust') adjust,
               (select coalesce(sum(e.n + e.b + e.c + e.j), 0) from egg_collections e where e.d = x.d and e.voided_at is null) eggs
          from (select g::date d from generate_series(m0, m1, interval '1 day') g) x) q
         where q.milled > 0 or q.bought > 0 or q.used > 0 or q.adjust <> 0 or q.eggs > 0),
    'houses', (select coalesce(jsonb_agg(h.name order by h.sort), '[]') from houses h where h.active),
    'feed_open', (select coalesce(sum(kg), 0) from v_feed_lines where d < m0),
    'feed_bag_kg', (select bag_kg from settings where id = 1)
  ) into r;
  return r;
end $$;

revoke execute on function public.rpc_month_book(date) from public, anon;
grant execute on function public.rpc_month_book(date) to authenticated, service_role;

create or replace function public.reminders(p_slot text)
returns int language plpgsql security definer set search_path = public as $$
declare t date := biz_today(); l record; n int := 0; v_id bigint; v_txt text; v_left int; v_low text; v_pend int;
        v_open int; v_closed int; v_not text; v_sales numeric; v_farm text;
        v_usual numeric; v_cap numeric; v_lim text;
begin
  if p_slot = 'morning' then
    -- sales points (not the van): opening count
    for l in select * from locations where kind <> 'van' order by sort loop
      continue when _closed_on(l.id, t);
      continue when exists (select 1 from stock_counts c where c.location_id = l.id and c.d = t and c.kind in ('open', 'opening_balance') and c.voided_at is null);
      v_id := _notify_once(format('rem:morning:%s:%s', t, l.id), 'info', format('Good morning, %s: count the opening stock', l.short),
        'Count the eggs on hand before you start selling. If you are not opening today, mark the day closed.', array['pos']::staff_role[], l.id, 'reminder');
      if v_id is not null then n := n + 1; end if;
    end loop;
    -- the van: start of the day
    for l in select * from locations where kind = 'van' loop
      continue when _closed_on(l.id, t);
      v_pend := (select count(*) from transfers x where x.to_loc = l.id and x.status = 'in_transit' and x.voided_at is null);
      v_id := _notify_once(format('rem:morning:%s:%s', t, l.id), 'info', 'Good morning: start the van''s day',
        case when v_pend > 0 then format('%s load%s waiting for you. Receive %s before you set off. The van ends the day empty.', v_pend, case when v_pend > 1 then 's are' else ' is' end, case when v_pend > 1 then 'them' else 'it' end)
             else 'Receive your load before you set off. The van ends the day empty.' end,
        array['pos']::staff_role[], l.id, 'reminder');
      if v_id is not null then n := n + 1; end if;
    end loop;
    -- production clerk: the tank and water, if the tank is not read yet
    if exists (select 1 from houses where active and birds_at_start > 0)
       and not exists (select 1 from water_logs w where w.kind = 'tank' and w.d = t and w.voided_at is null) then
      v_id := _notify_once(format('rem:morning:%s:clerk', t), 'info', 'Good morning: read the water tank',
        'Record the tank level, then the water each house drinks. Confirm the feed the store issues as it reaches each house.', array['clerk']::staff_role[], 'FARM', 'reminder');
      if v_id is not null then n := n + 1; end if;
    end if;
    -- inventory clerk: only when something is low or still unconfirmed
    select string_agg(x, ', ') into v_low from (
      select m.name x from medicines m join v_med_stock v on v.medicine_id = m.id where m.active and v.qty <= m.reorder
      union all select s.name from supplies s join v_supply_stock v on v.supply_id = s.id where s.active and v.qty <= s.reorder
      union all select 'Feed' where (select coalesce(sum(kg), 0) from v_feed_lines) < (select feed_buffer_kg * 0.5 from settings where id = 1)) q;
    v_pend := (select count(*) from feed_moves f where f.need_confirm and f.voided_at is null and f.d < t
                and not exists (select 1 from issue_confirms c where c.kind = 'feed' and c.move_id = f.id and c.voided_at is null))
            + (select count(*) from med_moves x where x.need_confirm and x.voided_at is null and x.d < t
                and not exists (select 1 from issue_confirms c where c.kind = 'med' and c.move_id = x.id and c.voided_at is null));
    -- the feed mill: can the raw materials make a usual batch (the biggest in the last 30 days, else 5 tonnes)?
    if exists (select 1 from raw_moves where voided_at is null) then
      v_usual := coalesce((select max(tonnes) from mill_batches where voided_at is null and d >= t - 30), 5);
      select greatest(coalesce(v.kg, 0), 0) / m.per_tonne, m.name into v_cap, v_lim
        from raw_materials m left join v_raw_stock v on v.material_id = m.id
       where m.active and m.per_tonne > 0 order by coalesce(v.kg, 0) / m.per_tonne, m.sort limit 1;
      if v_cap is not null and v_cap < v_usual then
        v_low := concat_ws(', ', v_low, format('%s (enough to mill %s tonnes, a usual batch is %s)', v_lim, trim(to_char(floor(v_cap * 10) / 10, 'FM990.0')), trim(to_char(v_usual, 'FM990.##'))));
      end if;
    end if;
    if v_low is not null or v_pend > 0 then
      v_id := _notify_once(format('rem:morning:%s:store', t), 'info', 'Store check',
        concat_ws(' ', case when v_low is not null then format('Running low: %s. Tell the farm manager.', v_low) end,
                       case when v_pend > 0 then format('%s issue%s from earlier days not yet confirmed by the production clerk.', v_pend, case when v_pend > 1 then 's' else '' end) end),
        array['store']::staff_role[], 'FARM', 'reminder');
      if v_id is not null then n := n + 1; end if;
    end if;

  elsif p_slot = 'evening' then
    -- sales points: close the day
    for l in select * from locations where kind <> 'van' order by sort loop
      continue when _closed_on(l.id, t);
      continue when exists (select 1 from stock_counts c where c.location_id = l.id and c.d = t and c.kind = 'close' and c.voided_at is null);
      v_id := _notify_once(format('rem:evening:%s:%s', t, l.id), 'info', format('%s: close the day', l.short),
        'Count the eggs left and the cash, and check every sale is recorded.', array['pos']::staff_role[], l.id, 'reminder');
      if v_id is not null then n := n + 1; end if;
    end loop;
    -- the van: eggs still on board
    for l in select * from locations where kind = 'van' loop
      v_left := (select coalesce(sum(m.n + m.b + m.c + m.j), 0) from v_stock_moves m where m.location_id = l.id)::int;
      continue when v_left <= 0;
      v_id := _notify_once(format('rem:evening:%s:%s', t, l.id), 'info', format('%s still on the van', _eggs(v_left)),
        'Drop them at the farm or an outlet with Drop off what is left. Then bank or send the cash.', array['pos']::staff_role[], l.id, 'reminder');
      if v_id is not null then n := n + 1; end if;
    end loop;
    -- production clerk: eggs or water still missing today
    select string_agg(format('%s (%s)', h.name, array_to_string(array_remove(array[
             case when not exists (select 1 from egg_collections e where e.house_id = h.id and e.d = t and e.voided_at is null) then 'eggs' end,
             case when not exists (select 1 from water_logs w where w.house_id = h.id and w.d = t and w.kind = 'intake' and w.voided_at is null) then 'water' end], null), ' and ')), ', ' order by h.sort)
      into v_farm
      from houses h where h.active and h.birds_at_start > 0 and h.start_date <= t
       and (not exists (select 1 from egg_collections e where e.house_id = h.id and e.d = t and e.voided_at is null)
            or not exists (select 1 from water_logs w where w.house_id = h.id and w.d = t and w.kind = 'intake' and w.voided_at is null));
    if v_farm is not null then
      v_id := _notify_once(format('rem:evening:%s:clerk', t), 'info', 'Farm records still to enter today',
        format('Not recorded yet: %s.', v_farm), array['clerk']::staff_role[], 'FARM', 'reminder');
      if v_id is not null then n := n + 1; end if;
    end if;

  elsif p_slot = 'close' then
    -- owner and farm manager: the day's close, in one notification
    select count(*) filter (where not _closed_on(o.id, t)),
           count(*) filter (where not _closed_on(o.id, t) and exists (select 1 from stock_counts c where c.location_id = o.id and c.d = t and c.kind = 'close' and c.voided_at is null)),
           string_agg(o.short, ', ' order by o.sort) filter (where not _closed_on(o.id, t)
             and not exists (select 1 from stock_counts c where c.location_id = o.id and c.d = t and c.kind = 'close' and c.voided_at is null))
      into v_open, v_closed, v_not
      from locations o where o.kind <> 'van';
    v_sales := (select coalesce(sum(value), 0) from sales where d = t and voided_at is null);
    v_left := (select coalesce(sum(m.n + m.b + m.c + m.j), 0) from v_stock_moves m join locations o on o.id = m.location_id where o.kind = 'van')::int;
    v_txt := concat_ws(' ', format('Sales today %s.', _kes(v_sales)),
                            case when v_not is not null then format('Not closed yet: %s.', v_not) end,
                            case when v_left > 0 then format('%s still on the van.', _eggs(v_left)) end);
    v_id := _notify_once(format('close:%s', t), 'info',
      case when v_open = 0 then 'Today''s close: all outlets closed for the day' else format('Today''s close: %s of %s outlets closed', v_closed, v_open) end,
      v_txt, array['owner','manager']::staff_role[], null, 'day_close');
    if v_id is not null then n := n + 1; end if;
  else
    raise exception 'Unknown reminder slot';
  end if;
  return n;
end $$;
revoke execute on function public.reminders(text) from public, anon, authenticated;
grant execute on function public.reminders(text) to service_role;
