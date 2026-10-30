-- =====================================================================
-- Farm changes requested 30 Oct 2026
--  1. Cracked eggs get a loose (per piece) price as well as a tray price.
--  2. Medicines: any number of items, each with a category; the owner and
--     manager add, rename, re-categorise and retire them.
--  3. The production clerk can register a new medicine (and a new
--     category) when a delivery of something not yet in the list arrives.
--  4. One "send eggs" entry can split stock across several outlets.
--  5. Two-step sign-in is optional for every role, the owner and farm
--     manager included (they can turn it off under My account).
-- Nothing is removed: items are retired (active = false), never deleted.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Cracked eggs: price per tray of 30 and per loose piece
-- ---------------------------------------------------------------------
alter table public.settings add column if not exists pc_c numeric not null default 10 check (pc_c >= 0);
comment on column public.settings.pc_c is 'Cracked eggs, price per loose piece (KES)';

create or replace function public._price(p_n int, p_c int, p_j int) returns numeric
language sql stable security definer set search_path = public as $$
  select round((p_n / 30) * tray_n + (p_n % 30) * pc_n
             + (p_c / 30) * tray_c + (p_c % 30) * pc_c
             + p_j * pc_j)
    from settings where id = 1
$$;

create or replace function public.rpc_save_settings(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner']::staff_role[]);
  update settings t set
    tray_n          = coalesce((p->>'tray_n')::numeric, t.tray_n),
    pc_n            = coalesce((p->>'pc_n')::numeric, t.pc_n),
    tray_c          = coalesce((p->>'tray_c')::numeric, t.tray_c),
    pc_c            = coalesce((p->>'pc_c')::numeric, t.pc_c),
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

-- ---------------------------------------------------------------------
-- 2. Medicines: categories and a list the farm controls
-- ---------------------------------------------------------------------
alter table public.medicines add column if not exists category text not null default 'Other';
alter table public.medicines add column if not exists created_at timestamptz not null default now();
alter table public.medicines add column if not exists created_by uuid references public.staff(id);

update public.medicines set category = case
    when name ilike '%vaccine%' then 'Vaccine'
    when name ilike '%dewormer%' or name ilike '%piperazine%' then 'Dewormer'
    when name ilike '%vitamin%' or name ilike '%electrolyte%' then 'Vitamin / supplement'
    when name ilike '%tetracycline%' then 'Antibiotic'
    else category end
 where category = 'Other';

create unique index if not exists medicines_name_unique on public.medicines (lower(trim(name)));

create or replace function public._med_clean(p_name text, p_category text, p_unit text,
                                             out o_name text, out o_category text, out o_unit text)
language plpgsql immutable set search_path = public as $$
begin
  o_name := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  o_category := regexp_replace(trim(coalesce(p_category, '')), '\s+', ' ', 'g');
  o_unit := regexp_replace(trim(coalesce(p_unit, '')), '\s+', ' ', 'g');
  if o_name = '' then raise exception 'Enter the medicine or vaccine name'; end if;
  if length(o_name) > 80 then raise exception 'The name is too long (80 characters at most)'; end if;
  if o_unit = '' then raise exception 'Enter the unit it is counted in, e.g. doses, ml, g, sachets'; end if;
  if length(o_unit) > 20 then raise exception 'The unit is too long'; end if;
  if o_category = '' then o_category := 'Other'; end if;
  if length(o_category) > 40 then raise exception 'The category is too long (40 characters at most)'; end if;
end $$;

-- owner and manager: add or change any item, including retiring it
create or replace function public.rpc_medicine_save(p_id bigint, p_name text, p_category text, p_unit text,
                                                    p_reorder numeric, p_active boolean)
returns bigint language plpgsql security definer set search_path = public as $$
declare s staff; c record; v_id bigint;
begin
  s := _require(array['owner','manager']::staff_role[]);
  c := _med_clean(p_name, p_category, p_unit);
  if coalesce(p_reorder, 0) < 0 then raise exception 'The reorder level cannot be negative'; end if;
  if exists (select 1 from medicines where lower(name) = lower(c.o_name) and id is distinct from p_id) then
    raise exception '% is already in the list', c.o_name;
  end if;
  if p_id is null then
    insert into medicines (name, category, unit, reorder, active, created_by)
    values (c.o_name, c.o_category, c.o_unit, coalesce(p_reorder, 0), coalesce(p_active, true), s.id) returning id into v_id;
  else
    update medicines set name = c.o_name, category = c.o_category, unit = c.o_unit,
                         reorder = coalesce(p_reorder, 0), active = coalesce(p_active, true)
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Unknown medicine'; end if;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 3. A delivery of something new: the clerk registers it and books it in
-- ---------------------------------------------------------------------
create or replace function public.rpc_med_new(p_name text, p_category text, p_unit text, p_qty numeric,
                                              p_reorder numeric default 0, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; c record; m medicines; v_new boolean := false;
begin
  s := _require(array['owner','manager','clerk']::staff_role[]);
  c := _med_clean(p_name, p_category, p_unit);
  if coalesce(p_qty, 0) <= 0 then raise exception 'Enter the quantity received'; end if;
  if coalesce(p_reorder, 0) < 0 then raise exception 'The reorder level cannot be negative'; end if;
  perform _lock('med:new:' || lower(c.o_name));
  select * into m from medicines where lower(name) = lower(c.o_name);
  if m.id is null then
    insert into medicines (name, category, unit, reorder, active, created_by)
    values (c.o_name, c.o_category, c.o_unit, coalesce(p_reorder, 0), true, s.id) returning * into m;
    v_new := true;
    perform _notify('info', format('New medicine added: %s', m.name),
                    format('%s added %s (%s) on delivery of %s %s.', s.display_name, m.name, m.category, p_qty, m.unit),
                    array['owner','manager']::staff_role[], 'FARM', 'medicine');
  elsif not m.active then
    update medicines set active = true where id = m.id returning * into m;   -- back in use
  end if;
  insert into med_moves (medicine_id, kind, qty, note, recorded_by) values (m.id, 'in', p_qty, p_note, s.id);
  return jsonb_build_object('id', m.id, 'name', m.name, 'unit', m.unit, 'created', v_new,
                            'stock', (select qty from v_med_stock where medicine_id = m.id));
end $$;

-- the old editor is replaced by rpc_medicine_save (categories)
revoke execute on function public.rpc_save_medicine(bigint, text, text, numeric, boolean) from authenticated;

-- ---------------------------------------------------------------------
-- 4. Send eggs to several outlets in one entry (all or nothing)
-- ---------------------------------------------------------------------
create or replace function public.rpc_dispatch_many(p_from text, p_items jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; it jsonb; st record; v_to text; v_seen text[] := '{}';
        tn int := 0; tc int := 0; tj int := 0; n int; c int; j int; r jsonb; v_ids bigint[] := '{}';
begin
  s := _require(array['owner','manager','clerk','pos']::staff_role[]);
  perform _check_loc(s, p_from);
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Enter what you are sending';
  end if;
  if jsonb_array_length(p_items) > 10 then raise exception 'Too many destinations in one entry'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_to := it->>'to';
    if v_to is null or not exists (select 1 from locations where id = v_to) then raise exception 'Unknown destination'; end if;
    if v_to = any (v_seen) then raise exception 'Each outlet can appear only once'; end if;
    v_seen := v_seen || v_to;
    n := coalesce((it->>'n')::int, 0); c := coalesce((it->>'c')::int, 0); j := coalesce((it->>'j')::int, 0);
    if n < 0 or c < 0 or j < 0 then raise exception 'Quantities cannot be negative'; end if;
    tn := tn + n; tc := tc + c; tj := tj + j;
  end loop;
  if tn + tc + tj = 0 then raise exception 'Enter what you are sending'; end if;
  perform _lock('stock:' || p_from);
  st := _stock(p_from);
  if tn > st.n then raise exception 'Only % normal eggs in stock at %, and % are being sent in total', _eggs(st.n), _loc_short(p_from), _eggs(tn); end if;
  if tc > st.c then raise exception 'Only % cracked eggs in stock, and % are being sent in total', st.c, tc; end if;
  if tj > st.j then raise exception 'Only % jumbo eggs in stock, and % are being sent in total', st.j, tj; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    n := coalesce((it->>'n')::int, 0); c := coalesce((it->>'c')::int, 0); j := coalesce((it->>'j')::int, 0);
    if n + c + j > 0 then
      r := rpc_dispatch(p_from, it->>'to', n, c, j, p_note);
      v_ids := v_ids || (r->>'id')::bigint;
    end if;
  end loop;
  return jsonb_build_object('ids', to_jsonb(v_ids), 'outlets', cardinality(v_ids), 'n', tn, 'c', tc, 'j', tj);
end $$;

-- ---------------------------------------------------------------------
-- 5. Two-step sign-in: optional for every role
-- ---------------------------------------------------------------------
create or replace function public._mfa_required(p_role public.staff_role) returns boolean
language sql immutable set search_path = public as $$ select false $$;
comment on function public._mfa_required(public.staff_role) is
  'Two-step sign-in is optional for every role (owner''s decision, 30 Oct 2026). Return p_role in (''owner'',''manager'') to require it again.';

-- ---------------------------------------------------------------------
-- Dashboard: medicines now carry their category
-- ---------------------------------------------------------------------
create or replace function public.dashboard(p_days int default 45)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare t date := biz_today(); f date := biz_today() - greatest(least(p_days, 400), 7); r jsonb; v_me jsonb;
begin
  v_me := _me_json();  -- raises AUTH_* unless this session is fully signed in
  select jsonb_build_object(
    'today', t, 'from', f, 'server_time', now(),
    'me', v_me,
    'settings', (select to_jsonb(s) from settings s where id = 1),
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
        select location_id, d, kind, sum(n)::int n, sum(c)::int c, sum(j)::int j from v_stock_moves where d >= f group by 1, 2, 3) x),
    'balances', (select coalesce(jsonb_agg(to_jsonb(v)), '[]') from v_balances v),
    'money_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select account_id, d, kind, sum(amount) amount from v_money_lines where d >= f group by 1, 2, 3) x),
    'sales_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select location_id, d, count(*)::int cnt, sum(value) value, sum(cash) cash, sum(till) till, sum(paybill) paybill,
               sum(n)::int n, sum(c)::int c, sum(j)::int j
          from sales where voided_at is null and d >= f group by 1, 2) x),
    'breakage_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select location_id, d, transit, sum(qty)::int qty from breakages where voided_at is null and d >= f group by 1, 2, 3) x),
    'received_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select to_loc location_id, received_d d, sum(sent_n + sent_c + sent_j)::int sent, sum(recv_n + recv_c + recv_j)::int recv
          from transfers where voided_at is null and status = 'received' and received_d >= f group by 1, 2) x),
    'farm_daily', case when can_farm() or is_mgmt() then (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from farm_daily(f, t) x) else '[]'::jsonb end,
    'feed_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (select d, kind, sum(kg) kg from v_feed_lines where d >= f group by 1, 2) x),
    'feed_stock', (select coalesce(sum(kg), 0) from v_feed_lines),
    'water_daily', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
        select d, house_id, sum(litres) litres from water_logs where kind = 'intake' and voided_at is null and d >= f group by 1, 2) x),
    'tank', (select to_jsonb(x) from (select litres, recorded_at, d from water_logs where kind = 'tank' and voided_at is null
                                       order by recorded_at desc, id desc limit 1) x),
    'tank_daily', (select coalesce(jsonb_agg(to_jsonb(x) order by x.d), '[]') from (
        select distinct on (d) d, litres from water_logs where kind = 'tank' and voided_at is null and d >= f order by d, recorded_at desc, id desc) x),
    'transit', (select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at), '[]') from transfers x where status = 'in_transit' and voided_at is null),
    'counts_today', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from stock_counts x where d = t and voided_at is null),
    'cash_counts_today', (select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at), '[]') from cash_counts x where d = t and voided_at is null),
    'notifications', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]') from (
        select n.*, exists (select 1 from notification_reads r where r.notification_id = n.id and r.staff_id = auth.uid()) as read
          from notifications n where n.created_at > now() - interval '14 days' order by n.created_at desc limit 50) x)
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- Privileges for the new functions (default privileges grant nothing)
-- ---------------------------------------------------------------------
-- Postgres gives PUBLIC execute on every new function, and a per-schema
-- default privilege cannot take that away, so revoke explicitly and also
-- change the global default for functions created later.
revoke execute on function
  public._med_clean(text, text, text), public.rpc_medicine_save(bigint, text, text, text, numeric, boolean),
  public.rpc_med_new(text, text, text, numeric, numeric, text), public.rpc_dispatch_many(text, jsonb, text)
from public, anon;
revoke execute on function public._med_clean(text, text, text) from authenticated;
alter default privileges revoke execute on functions from public;
grant execute on function
  public.rpc_medicine_save(bigint, text, text, text, numeric, boolean),
  public.rpc_med_new(text, text, text, numeric, numeric, text),
  public.rpc_dispatch_many(text, jsonb, text)
to authenticated;
grant execute on all functions in schema public to service_role;
