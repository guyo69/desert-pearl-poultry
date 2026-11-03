-- 3 Nov 2026, client request:
--   1. The inventory clerk (role "store") runs the farm store: receives feed,
--      medicine and other supplies (quantities only, no money), and issues
--      them. Feed and medicine are issued to a house; the production clerk
--      confirms what the house received, and any shortfall is flagged.
--   2. The mobile van is not a shop: it receives deliveries, delivers to the
--      farm or outlets, and sells on the road. It has no opening or closing
--      count; instead it should be empty at the end of each day (the driver
--      drops what is left at the farm or an outlet). The driver banks or sends
--      the cash, as the outlets do.
-- Changed, not new (all unavoidable, to let the new role in or to treat the van
-- differently): the helper can_farm() (adds the inventory clerk), rpc_mark_read
-- and rpc_save_push (notifications for the new role), completeness() and
-- _completeness_nudges() (the van check), activity() and dashboard() (store
-- data). The van is the location of kind 'van'. No existing row changes.

-- ---------------------------------------------------------------------
-- 0. The new role can read the farm and use notifications
-- ---------------------------------------------------------------------
create or replace function public.can_farm() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('owner','manager','clerk','store') or (role = 'pos' and location_id = 'FARM')
                   from staff where id = auth.uid() and active), false) and _ok()
$$;

create or replace function public.rpc_mark_read(p_ids bigint[])
returns void language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner','manager','clerk','store','pos']::staff_role[]);
  insert into notification_reads (notification_id, staff_id)
  select n.id, s.id from notifications n
   where n.id = any (p_ids) and s.role = any (n.to_roles)
  on conflict do nothing;
end $$;

create or replace function public.rpc_save_push(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare s staff;
begin
  s := _require(array['owner','manager','clerk','store','pos']::staff_role[]);
  insert into push_subscriptions (staff_id, endpoint, p256dh, auth) values (s.id, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set staff_id = excluded.staff_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

-- ---------------------------------------------------------------------
-- 1. The farm store
-- ---------------------------------------------------------------------
-- feed and medicine issued to a house wait for the production clerk's confirmation
alter table public.feed_moves add column if not exists house_id text references public.houses(id);
alter table public.feed_moves add column if not exists need_confirm boolean not null default false;
alter table public.med_moves  add column if not exists house_id text references public.houses(id);
alter table public.med_moves  add column if not exists need_confirm boolean not null default false;

-- other supplies: trays, packaging, disinfectant, tools and so on
create table if not exists public.supplies (
  id bigint generated always as identity primary key,
  name text not null,
  category text not null default 'Other',
  unit text not null,
  reorder numeric not null default 0 check (reorder >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.staff(id)
);
create unique index if not exists supplies_name on public.supplies (lower(name));
create table if not exists public.supply_moves (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  supply_id bigint not null references public.supplies(id),
  kind text not null check (kind in ('in', 'out')),
  qty numeric not null check (qty > 0),
  purpose text,
  note text
);
create index if not exists supply_moves_item on public.supply_moves (supply_id, d);
create or replace view public.v_supply_stock with (security_invoker = true) as
  select s.id as supply_id, coalesce(sum(case when x.kind = 'out' then -x.qty else x.qty end), 0) as qty
    from supplies s left join supply_moves x on x.supply_id = s.id and x.voided_at is null
   group by s.id;
revoke all on public.v_supply_stock from public, anon, authenticated;
grant select on public.v_supply_stock to authenticated, service_role;

-- what the production clerk confirmed a house received (one per issue; records are never changed)
create table if not exists public.issue_confirms (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  kind text not null check (kind in ('feed', 'med')),
  move_id bigint not null,
  issued numeric not null,
  received numeric not null check (received >= 0),
  note text
);
create unique index if not exists issue_confirms_one on public.issue_confirms (kind, move_id) where voided_at is null;

do $$ declare t text; begin
  foreach t in array array['supplies', 'supply_moves', 'issue_confirms'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists read_farm on public.%I', t);
    execute format('create policy read_farm on public.%I for select to authenticated using ((select can_farm()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop trigger if exists zz_bump on public.%I', t);
    execute format('create trigger zz_bump after insert or update or delete on public.%I for each statement execute function public._bump()', t);
  end loop;
  foreach t in array array['supply_moves', 'issue_confirms'] loop
    execute format('drop trigger if exists owner_view_only on public.%I', t);
    execute format('create trigger owner_view_only before insert or update or delete on public.%I for each row execute function public._owner_view_only()', t);
  end loop;
end $$;

-- Everything the inventory clerk records, in one place. Quantities only: the
-- farm manager records any payment as an expense.
--   feed_in      {bags, kg_per_bag?, note?}
--   feed_issue   {house, kg, note?}                 waits for the production clerk
--   med_in       {medicine, qty, note?}
--   med_new      {name, category, unit, qty, reorder?, note?}
--   med_issue    {medicine, house, qty, note?}      waits for the production clerk
--   supply_new   {name, category?, unit, qty?, reorder?, note?}
--   supply_in    {supply, qty, note?}
--   supply_out   {supply, qty, purpose, note?}
create or replace function public.rpc_store(p_action text, p jsonb, p_date date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_d date; st settings; h houses; m medicines; x supplies; c record; v_qty numeric; v_stock numeric; v_id bigint;
        v_note text := nullif(trim(coalesce(p->>'note', '')), ''); v_new boolean := false;
begin
  s := _require(array['manager','store']::staff_role[]);
  v_d := _day(s, p_date);
  select * into st from settings where id = 1;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Nothing to save'; end if;
  if length(coalesce(v_note, '')) > 200 then raise exception 'The note is too long'; end if;
  if p_action in ('feed_issue', 'med_issue') then
    select * into h from houses where id = p->>'house' and active;
    if h.id is null then raise exception 'Choose the house'; end if;
  end if;
  case p_action
  when 'feed_in' then
    v_qty := coalesce((p->>'bags')::numeric, 0) * coalesce((p->>'kg_per_bag')::numeric, st.bag_kg);
    if v_qty <= 0 then raise exception 'Enter the bags received'; end if;
    perform _lock('feed');
    insert into feed_moves (d, kind, kg, bags, note, recorded_by)
    values (v_d, 'in', v_qty, (p->>'bags')::numeric, coalesce(v_note, 'Received into the store'), s.id) returning id into v_id;
    return jsonb_build_object('id', v_id, 'stock', _feed_stock());
  when 'feed_issue' then
    v_qty := (p->>'kg')::numeric;
    if coalesce(v_qty, 0) <= 0 then raise exception 'Enter the feed issued'; end if;
    perform _lock('feed');
    v_stock := _feed_stock();
    insert into feed_moves (d, kind, kg, house, house_id, note, need_confirm, recorded_by)
    values (v_d, 'use', v_qty, h.name, h.id, coalesce(v_note, 'Issued from the store'), true, s.id) returning id into v_id;
    if v_stock - v_qty < 0 then
      perform _notify('red', 'Feed store book is below zero',
        format('%s kg was issued to %s but the store book shows %s kg. Record feed deliveries so the book is right.', round(v_qty), h.name, round(v_stock)),
        array['owner','manager','store']::staff_role[], 'FARM', 'feed');
    end if;
    return jsonb_build_object('id', v_id, 'stock', v_stock - v_qty);
  when 'med_in' then
    select * into m from medicines where id = (p->>'medicine')::bigint;
    if m.id is null then raise exception 'Unknown medicine'; end if;
    v_qty := (p->>'qty')::numeric;
    if coalesce(v_qty, 0) <= 0 then raise exception 'Enter the quantity received'; end if;
    insert into med_moves (d, medicine_id, kind, qty, note, recorded_by) values (v_d, m.id, 'in', v_qty, v_note, s.id) returning id into v_id;
    return jsonb_build_object('id', v_id, 'name', m.name, 'unit', m.unit, 'stock', (select qty from v_med_stock where medicine_id = m.id));
  when 'med_new' then
    c := _med_clean(p->>'name', p->>'category', p->>'unit');
    v_qty := (p->>'qty')::numeric;
    if coalesce(v_qty, 0) <= 0 then raise exception 'Enter the quantity received'; end if;
    if coalesce((p->>'reorder')::numeric, 0) < 0 then raise exception 'The reorder level cannot be negative'; end if;
    perform _lock('med:new:' || lower(c.o_name));
    select * into m from medicines where lower(name) = lower(c.o_name);
    if m.id is null then
      insert into medicines (name, category, unit, reorder, active, created_by)
      values (c.o_name, c.o_category, c.o_unit, coalesce((p->>'reorder')::numeric, 0), true, s.id) returning * into m;
      v_new := true;
      perform _notify('info', format('New medicine added: %s', m.name),
        format('%s added %s (%s) on delivery of %s %s.', s.display_name, m.name, m.category, v_qty, m.unit),
        array['owner','manager']::staff_role[], 'FARM', 'medicine');
    elsif not m.active then
      update medicines set active = true where id = m.id returning * into m;
    end if;
    insert into med_moves (d, medicine_id, kind, qty, note, recorded_by) values (v_d, m.id, 'in', v_qty, v_note, s.id) returning id into v_id;
    return jsonb_build_object('id', m.id, 'name', m.name, 'unit', m.unit, 'created', v_new, 'stock', (select qty from v_med_stock where medicine_id = m.id));
  when 'med_issue' then
    select * into m from medicines where id = (p->>'medicine')::bigint;
    if m.id is null then raise exception 'Unknown medicine'; end if;
    v_qty := (p->>'qty')::numeric;
    if coalesce(v_qty, 0) <= 0 then raise exception 'Enter the quantity issued'; end if;
    perform _lock('med:' || m.id);
    select qty into v_stock from v_med_stock where medicine_id = m.id;
    if v_qty > v_stock then raise exception 'Only % % in the store', v_stock, m.unit; end if;
    insert into med_moves (d, medicine_id, kind, qty, house, house_id, note, need_confirm, recorded_by)
    values (v_d, m.id, 'use', v_qty, h.name, h.id, v_note, true, s.id) returning id into v_id;
    if v_stock - v_qty <= m.reorder and v_stock > m.reorder then
      perform _notify('amber', format('%s below reorder level', m.name), format('%s %s left. Reorder level is %s.', v_stock - v_qty, m.unit, m.reorder),
                      array['owner','manager','store']::staff_role[], 'FARM', 'medicine');
    end if;
    return jsonb_build_object('id', v_id, 'stock', v_stock - v_qty, 'unit', m.unit);
  when 'supply_new' then
    c := _med_clean(p->>'name', coalesce(nullif(trim(coalesce(p->>'category', '')), ''), 'Other'), p->>'unit');
    if coalesce((p->>'reorder')::numeric, 0) < 0 then raise exception 'The reorder level cannot be negative'; end if;
    perform _lock('supply:new:' || lower(c.o_name));
    select * into x from supplies where lower(name) = lower(c.o_name);
    if x.id is null then
      insert into supplies (name, category, unit, reorder, created_by)
      values (c.o_name, c.o_category, c.o_unit, coalesce((p->>'reorder')::numeric, 0), s.id) returning * into x;
      v_new := true;
    elsif not x.active then
      update supplies set active = true where id = x.id returning * into x;
    end if;
    if coalesce((p->>'qty')::numeric, 0) > 0 then
      insert into supply_moves (d, supply_id, kind, qty, note, recorded_by) values (v_d, x.id, 'in', (p->>'qty')::numeric, v_note, s.id);
    end if;
    return jsonb_build_object('id', x.id, 'name', x.name, 'unit', x.unit, 'created', v_new, 'stock', (select qty from v_supply_stock where supply_id = x.id));
  when 'supply_in', 'supply_out' then
    select * into x from supplies where id = (p->>'supply')::bigint;
    if x.id is null then raise exception 'Unknown supply'; end if;
    v_qty := (p->>'qty')::numeric;
    if coalesce(v_qty, 0) <= 0 then raise exception 'Enter the quantity'; end if;
    perform _lock('supply:' || x.id);
    select qty into v_stock from v_supply_stock where supply_id = x.id;
    if p_action = 'supply_out' then
      if v_qty > v_stock then raise exception 'Only % % in the store', v_stock, x.unit; end if;
      if nullif(trim(coalesce(p->>'purpose', '')), '') is null then raise exception 'Say what it was issued for'; end if;
    end if;
    insert into supply_moves (d, supply_id, kind, qty, purpose, note, recorded_by)
    values (v_d, x.id, case when p_action = 'supply_in' then 'in' else 'out' end, v_qty,
            case when p_action = 'supply_out' then left(trim(p->>'purpose'), 80) end, v_note, s.id) returning id into v_id;
    v_stock := v_stock + case when p_action = 'supply_in' then v_qty else -v_qty end;
    if p_action = 'supply_out' and v_stock <= x.reorder and v_stock + v_qty > x.reorder then
      perform _notify('amber', format('%s below reorder level', x.name), format('%s %s left. Reorder level is %s.', v_stock, x.unit, x.reorder),
                      array['owner','manager','store']::staff_role[], 'FARM', 'supply');
    end if;
    return jsonb_build_object('id', v_id, 'stock', v_stock, 'unit', x.unit);
  else
    raise exception 'Unknown store record';
  end case;
end $$;

-- Owner, farm manager and inventory clerk keep the supplies list (setup, like the medicine list).
create or replace function public.rpc_supply_save(p_id bigint, p_name text, p_category text, p_unit text, p_reorder numeric, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
declare s staff; c record;
begin
  s := _require(array['owner','manager','store']::staff_role[]);
  c := _med_clean(p_name, coalesce(nullif(trim(coalesce(p_category, '')), ''), 'Other'), p_unit);
  if coalesce(p_reorder, 0) < 0 then raise exception 'The reorder level cannot be negative'; end if;
  if exists (select 1 from supplies where lower(name) = lower(c.o_name) and id is distinct from p_id) then raise exception 'There is already an item called %', c.o_name; end if;
  if p_id is null then
    insert into supplies (name, category, unit, reorder, active, created_by) values (c.o_name, c.o_category, c.o_unit, coalesce(p_reorder, 0), coalesce(p_active, true), s.id);
  else
    update supplies set name = c.o_name, category = c.o_category, unit = c.o_unit, reorder = coalesce(p_reorder, 0), active = coalesce(p_active, true) where id = p_id;
    if not found then raise exception 'Unknown supply'; end if;
  end if;
end $$;

-- The production clerk confirms what a house received from the store.
create or replace function public.rpc_confirm_issue(p_kind text, p_id bigint, p_received numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff; v_issued numeric; v_house text; v_what text; v_unit text; v_short numeric;
begin
  s := _require(array['manager','clerk']::staff_role[]);
  if p_kind = 'feed' then
    select kg, house, 'feed', 'kg' into v_issued, v_house, v_what, v_unit from feed_moves where id = p_id and need_confirm and voided_at is null
       and not exists (select 1 from issue_confirms c where c.kind = 'feed' and c.move_id = p_id and c.voided_at is null);
  elsif p_kind = 'med' then
    select x.qty, x.house, m.name, m.unit into v_issued, v_house, v_what, v_unit
      from med_moves x join medicines m on m.id = x.medicine_id where x.id = p_id and x.need_confirm and x.voided_at is null
       and not exists (select 1 from issue_confirms c where c.kind = 'med' and c.move_id = p_id and c.voided_at is null);
  else raise exception 'Unknown store issue'; end if;
  if v_issued is null then raise exception 'That issue is not waiting to be confirmed'; end if;
  if p_received is null or p_received < 0 then raise exception 'Enter what the house received'; end if;
  if p_received > v_issued then raise exception 'The store issued % %. Enter that or less', v_issued, v_unit; end if;
  if length(coalesce(p_note, '')) > 200 then raise exception 'The note is too long'; end if;
  perform _lock('confirm:' || p_kind || ':' || p_id);
  if exists (select 1 from issue_confirms where kind = p_kind and move_id = p_id and voided_at is null) then raise exception 'Already confirmed'; end if;
  insert into issue_confirms (kind, move_id, issued, received, note, recorded_by) values (p_kind, p_id, v_issued, p_received, nullif(trim(coalesce(p_note, '')), ''), s.id);
  v_short := v_issued - p_received;
  if v_short > 0 then
    perform _notify('amber', format('%s received %s %s of %s %s %s issued', v_house, p_received, v_unit, v_issued, v_unit, v_what),
      format('%s %s short between the store and the house.%s', v_short, v_unit, coalesce(' Note: ' || nullif(trim(coalesce(p_note, '')), ''), '')),
      array['owner','manager','store']::staff_role[], 'FARM', p_kind);
  end if;
  return jsonb_build_object('issued', v_issued, 'received', p_received, 'short', v_short);
end $$;

revoke execute on function public.rpc_store(text, jsonb, date), public.rpc_supply_save(bigint, text, text, text, numeric, boolean),
  public.rpc_confirm_issue(text, bigint, numeric, text) from public, anon;
grant execute on function public.rpc_store(text, jsonb, date), public.rpc_supply_save(bigint, text, text, text, numeric, boolean),
  public.rpc_confirm_issue(text, bigint, numeric, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. The mobile van
-- ---------------------------------------------------------------------
-- The van has no counts. On a day it moved eggs, it should end the day empty.
create or replace function public.completeness(p_day date)
returns jsonb language sql stable security definer set search_path = public as $$
  with st as (select * from settings where id = 1),
  hs as (select * from houses h where h.active and h.birds_at_start > 0 and h.start_date <= p_day),
  house_items as (
    select jsonb_build_object(
      'scope', 'house', 'id', h.id, 'name', h.name, 'location_id', 'FARM', 'roles', jsonb_build_array('clerk', 'manager'),
      'expected', jsonb_build_array('eggs', 'water'),
      'missing', to_jsonb(array_remove(array[
        case when not exists (select 1 from egg_collections e where e.house_id = h.id and e.d = p_day and e.voided_at is null) then 'eggs' end,
        case when not exists (select 1 from water_logs w where w.house_id = h.id and w.d = p_day and w.kind = 'intake' and w.voided_at is null) then 'water' end
      ], null)),
      'deaths', case
        when exists (select 1 from mortality m where m.house_id = h.id and m.d = p_day and m.voided_at is null) then 'recorded'
        when exists (select 1 from day_marks k where k.house_id = h.id and k.d = p_day and k.kind = 'no_deaths' and k.voided_at is null) then 'none'
        else 'unconfirmed' end) j, h.sort
    from hs h),
  farm_item as (
    select jsonb_build_object(
      'scope', 'farm', 'id', 'FEED', 'name', 'Central Farm feed', 'location_id', 'FARM', 'roles', jsonb_build_array('clerk', 'store', 'manager'),
      'expected', jsonb_build_array('feed'),
      'missing', case when exists (select 1 from feed_moves f where f.d = p_day and f.kind = 'use' and f.voided_at is null)
                      then '[]'::jsonb else jsonb_build_array('feed') end) j
    where exists (select 1 from hs)),
  outlet_items as (
    select jsonb_build_object(
      'scope', 'outlet', 'id', l.id, 'name', l.name, 'location_id', l.id, 'roles', jsonb_build_array('pos'),
      'closed', c.closed, 'closed_why', c.why, 'mobile', false,
      'expected', case when c.closed then '[]'::jsonb else jsonb_build_array('sales', 'opening count', 'closing count') end,
      'missing', case when c.closed then '[]'::jsonb else to_jsonb(array_remove(array[
        case when not exists (select 1 from sales s where s.location_id = l.id and s.d = p_day and s.voided_at is null) then 'sales' end,
        case when not exists (select 1 from stock_counts k where k.location_id = l.id and k.d = p_day and k.kind = 'open' and k.voided_at is null) then 'opening count' end,
        case when not exists (select 1 from stock_counts k where k.location_id = l.id and k.d = p_day and k.kind = 'close' and k.voided_at is null) then 'closing count' end
      ], null)) end) j, l.sort
    from locations l
    cross join lateral (select
      extract(isodow from p_day)::int = any (l.closed_dow)
        or exists (select 1 from day_marks k where k.location_id = l.id and k.d = p_day and k.kind = 'closed' and k.voided_at is null) as closed,
      case when extract(isodow from p_day)::int = any (l.closed_dow) then 'regular closed day'
           when exists (select 1 from day_marks k where k.location_id = l.id and k.d = p_day and k.kind = 'closed' and k.voided_at is null) then 'marked closed' end as why) c
    where l.kind <> 'van'),
  van_items as (
    select jsonb_build_object(
      'scope', 'outlet', 'id', l.id, 'name', l.name, 'location_id', l.id, 'roles', jsonb_build_array('pos'),
      'closed', not v.moved, 'closed_why', case when not v.moved then 'not on the road' end, 'mobile', true, 'on_board', v.left_eggs,
      'expected', case when v.moved then jsonb_build_array('empty van at day end') else '[]'::jsonb end,
      'missing', case when v.moved and v.left_eggs > 0 then jsonb_build_array('eggs left on the van') else '[]'::jsonb end) j, l.sort
    from locations l
    cross join lateral (select
      exists (select 1 from v_stock_moves m where m.location_id = l.id and m.d = p_day) as moved,
      (select coalesce(sum(m.n + m.b + m.c + m.j), 0) from v_stock_moves m where m.location_id = l.id and m.d <= p_day)::int as left_eggs) v
    where l.kind = 'van')
  select jsonb_build_object('day', p_day, 'label', to_char(p_day, 'Dy DD Mon'),
    'tracked', p_day >= coalesce((select tracking_from from st), p_day),
    'items', coalesce((select jsonb_agg(j order by g, s) from (
        select j, 0 as g, sort as s from house_items
        union all select j, 1, 0 from farm_item
        union all select j, 2, sort from outlet_items
        union all select j, 2, sort from van_items) x), '[]'::jsonb))
$$;
revoke execute on function public.completeness(date) from public, anon, authenticated;

create or replace function public._completeness_nudges(p_day date)
returns int language plpgsql security definer set search_path = public as $$
declare c jsonb := completeness(p_day); i jsonb; v_id bigint; n int := 0; v_list text[] := '{}'; v_exp int := 0; v_ok int := 0;
        v_what text;
begin
  if not (c->>'tracked')::boolean then return 0; end if;
  for i in select * from jsonb_array_elements(c->'items') loop
    v_exp := v_exp + jsonb_array_length(i->'expected');
    v_ok := v_ok + jsonb_array_length(i->'expected') - jsonb_array_length(i->'missing');
    continue when jsonb_array_length(i->'missing') = 0;
    v_what := (select string_agg(x, ', ') from jsonb_array_elements_text(i->'missing') x);
    v_list := v_list || format('%s (%s)', i->>'name', v_what);
    v_id := _notify_once(format('gap:%s:%s:%s', p_day, i->>'scope', i->>'id'), 'amber',
      case when (i->>'mobile')::boolean then format('%s: %s eggs were left on the van at the end of %s', i->>'name', i->>'on_board', c->>'label')
           else format('%s: %s not entered for %s', i->>'name', v_what, c->>'label') end,
      case when (i->>'mobile')::boolean then 'Drop them at the farm or an outlet and record it with Deliver eggs.'
           when i->>'scope' = 'outlet' then 'Enter them on the daily stock sheet today. If you did not open, mark the day closed.'
           when i->>'scope' = 'farm' then 'Enter the feed given on the daily house sheet today.'
           else 'Enter them on the daily house sheet today.' end,
      array(select jsonb_array_elements_text(i->'roles'))::staff_role[], i->>'location_id', 'gap');
    if v_id is not null then n := n + 1; end if;
  end loop;
  if cardinality(v_list) > 0 then
    v_id := _notify_once(format('gap-summary:%s', p_day), case when v_ok * 10 < v_exp * 8 then 'orange' else 'amber' end,
      format('%s of %s daily records entered for %s', v_ok, v_exp, c->>'label'),
      'Missing: ' || array_to_string(v_list, '; ') || '. Figures for that day are provisional until they are entered.',
      array['owner','manager']::staff_role[], null, 'gap');
    if v_id is not null then n := n + 1; end if;
  end if;
  return n;
end $$;
revoke execute on function public._completeness_nudges(date) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Activity: supplies and confirmations too
-- ---------------------------------------------------------------------
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


-- ---------------------------------------------------------------------
-- 3. Activity and dashboard: the store's records, supplies, and issues waiting for confirmation
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
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
    'notifications', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]') from (
        select n.*, exists (select 1 from notification_reads r where r.notification_id = n.id and r.staff_id = auth.uid()) as read
          from notifications n where n.created_at > now() - interval '14 days' order by n.created_at desc limit 50) x)
  ) into r;
  return r;
end $$;
revoke execute on function public.dashboard(int) from public, anon;
grant execute on function public.dashboard(int) to authenticated, service_role;
