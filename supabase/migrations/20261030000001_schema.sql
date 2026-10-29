-- =====================================================================
-- Desert Pearl Poultry Manager — database
-- One ledger of events (collections, feed, water, transfers, sales,
-- money moves, counts...). Stock, balances and buffers are always
-- computed from the ledger, never stored. Records are never deleted:
-- managers void them with a reason.
-- All writes go through SECURITY DEFINER functions (rpc_*) that check
-- the caller's role and location and validate the numbers.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Reference tables
-- ---------------------------------------------------------------------
create type public.staff_role as enum ('owner','manager','clerk','pos');

create table public.locations (
  id    text primary key,
  name  text not null,
  short text not null,
  kind  text not null check (kind in ('farm','van','shop')),
  sort  int  not null default 0
);

create table public.accounts (
  id          text primary key,             -- 'CASH:FARM', 'TILL', 'PAYBILL', 'BANK'
  name        text not null,
  kind        text not null check (kind in ('cash','till','paybill','bank')),
  location_id text references public.locations(id),
  sort        int  not null default 0
);

create table public.staff (
  id              uuid primary key references auth.users(id) on delete cascade,
  display_name    text not null,
  role            public.staff_role not null,
  location_id     text references public.locations(id),
  active          boolean not null default true,
  must_change_pin boolean not null default true,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  constraint staff_location_required check (role = 'owner' or location_id is not null),
  constraint staff_clerk_at_farm check (role not in ('clerk','manager') or location_id = 'FARM')
);

create table public.settings (
  id               int primary key default 1 check (id = 1),
  -- prices (KES)
  tray_n           numeric not null default 450 check (tray_n >= 0),   -- normal eggs, tray of 30
  pc_n             numeric not null default 16  check (pc_n >= 0),    -- normal eggs, loose
  tray_c           numeric not null default 300 check (tray_c >= 0),   -- cracked eggs, tray of 30
  pc_j             numeric not null default 20  check (pc_j >= 0),     -- jumbo / double yolk, each
  -- feed
  feed_buffer_kg   numeric not null default 315  check (feed_buffer_kg > 0),  -- weekly requirement = full buffer
  bag_kg           numeric not null default 50   check (bag_kg > 0),
  bag_price        numeric not null default 2900 check (bag_price >= 0),
  -- water
  tank_capacity_l  numeric not null default 1000 check (tank_capacity_l > 0),
  water_drop_pct   numeric not null default 10   check (water_drop_pct > 0),
  water_ratio_min  numeric not null default 1.6  check (water_ratio_min > 0),
  water_ratio_max  numeric not null default 2.5  check (water_ratio_max > 0),
  -- controls
  cash_tol         numeric not null default 200,
  unbanked_max     numeric not null default 5000,
  break_tol        numeric not null default 1.5,   -- % of eggs received
  lay_drop_pts     numeric not null default 4,     -- percentage points
  timezone         text    not null default 'Africa/Nairobi',
  go_live          date,
  updated_at       timestamptz not null default now()
);

create or replace function public.biz_today() returns date
language sql stable set search_path = public as $$
  select (now() at time zone coalesce((select timezone from settings where id = 1), 'Africa/Nairobi'))::date
$$;

create table public.houses (
  id                 text primary key,           -- short code, e.g. 'A'
  name               text not null,
  birds_at_start     int  not null default 0 check (birds_at_start >= 0),
  start_date         date not null default current_date,
  age_weeks_at_start numeric not null default 0 check (age_weeks_at_start >= 0),
  expected_lay       numeric not null default 0.9 check (expected_lay between 0 and 1),
  active             boolean not null default true,
  sort               int not null default 0
);

create table public.medicines (
  id      bigint generated always as identity primary key,
  name    text not null,
  unit    text not null,
  reorder numeric not null default 0 check (reorder >= 0),
  active  boolean not null default true
);

create table public.schedule (
  id      bigint generated always as identity primary key,
  due     date not null,
  house   text not null,
  task    text not null,
  done    boolean not null default false,
  done_at timestamptz,
  done_by uuid references public.staff(id)
);

-- ---------------------------------------------------------------------
-- 2. Ledger tables (common columns: d, recorded_at, recorded_by, void*)
-- ---------------------------------------------------------------------
create table public.egg_collections (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  house_id text not null references public.houses(id),
  n int not null default 0 check (n >= 0),
  c int not null default 0 check (c >= 0),
  j int not null default 0 check (j >= 0),
  check (n + c + j > 0)
);

create table public.mortality (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  house_id text not null references public.houses(id),
  birds int not null check (birds > 0),
  cause text not null default 'Unknown'
);

create table public.money_moves (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  kind      text not null check (kind in ('move','expense','variance','opening')),
  from_acc  text references public.accounts(id),
  to_acc    text references public.accounts(id),
  amount    numeric not null,
  fee       numeric not null default 0 check (fee >= 0),
  ref       text,
  category  text,
  note      text,
  cash_count_id bigint,
  check (
    (kind = 'move'     and from_acc is not null and to_acc is not null and from_acc <> to_acc and amount > 0) or
    (kind = 'expense'  and from_acc is not null and to_acc is null and amount > 0) or
    (kind in ('variance','opening') and from_acc is null and to_acc is not null)
  )
);

create table public.feed_moves (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  kind  text not null check (kind in ('in','use','adjust')),
  kg    numeric not null,
  bags  numeric,
  cost  numeric,
  house text,
  note  text,
  money_move_id bigint references public.money_moves(id),
  check (kind = 'adjust' or kg > 0)
);

create table public.water_logs (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  kind     text not null check (kind in ('intake','tank')),   -- intake: litres drunk by a house; tank: level reading
  house_id text references public.houses(id),
  litres   numeric not null check (litres >= 0),
  note     text,
  check (kind = 'tank' or house_id is not null)
);

create table public.med_moves (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  medicine_id bigint not null references public.medicines(id),
  kind  text not null check (kind in ('in','use','adjust')),
  qty   numeric not null,
  house text,
  note  text,
  check (kind = 'adjust' or qty > 0)
);

create table public.transfers (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  from_loc text not null references public.locations(id),
  to_loc   text not null references public.locations(id),
  sent_n int not null default 0 check (sent_n >= 0),
  sent_c int not null default 0 check (sent_c >= 0),
  sent_j int not null default 0 check (sent_j >= 0),
  status text not null default 'in_transit' check (status in ('in_transit','received')),
  received_at timestamptz, received_d date, received_by uuid references public.staff(id),
  recv_n int, recv_c int, recv_j int,
  note text,
  check (from_loc <> to_loc),
  check (sent_n + sent_c + sent_j > 0),
  check (status = 'in_transit' or (recv_n between 0 and sent_n and recv_c between 0 and sent_c and recv_j between 0 and sent_j))
);

create table public.sales (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  location_id text not null references public.locations(id),
  n int not null default 0 check (n >= 0),
  c int not null default 0 check (c >= 0),
  j int not null default 0 check (j >= 0),
  value   numeric not null check (value >= 0),
  cash    numeric not null default 0 check (cash >= 0),
  till    numeric not null default 0 check (till >= 0),
  paybill numeric not null default 0 check (paybill >= 0),
  customer text,
  check (n + c + j > 0),
  check (cash + till + paybill = value)          -- every sale is fully paid and allocated
);

create table public.breakages (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  location_id text not null references public.locations(id),
  item   text not null check (item in ('N','C','J')),
  qty    int  not null check (qty > 0),
  reason text not null,
  transit boolean not null default false,          -- transit losses are already reflected in the received quantity
  transfer_id bigint references public.transfers(id)
);

create table public.stock_counts (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  location_id text not null references public.locations(id),
  kind text not null check (kind in ('open','close','opening_balance')),
  cnt_n int not null check (cnt_n >= 0), cnt_c int not null check (cnt_c >= 0), cnt_j int not null check (cnt_j >= 0),
  adj_n int not null, adj_c int not null, adj_j int not null
);

create table public.cash_counts (
  id bigint generated always as identity primary key,
  d date not null default public.biz_today(), recorded_at timestamptz not null default now(),
  recorded_by uuid references public.staff(id),
  voided_at timestamptz, voided_by uuid references public.staff(id), void_reason text,
  location_id text not null references public.locations(id),
  counted  numeric not null check (counted >= 0),
  expected numeric not null,
  diff     numeric not null
);
alter table public.money_moves add constraint money_moves_cash_count_fk foreign key (cash_count_id) references public.cash_counts(id);

create table public.notifications (
  id bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  sev         text not null check (sev in ('red','orange','amber','info')),
  title       text not null,
  body        text not null default '',
  to_roles    public.staff_role[] not null,
  location_id text references public.locations(id),
  kind        text
);
create table public.notification_reads (
  notification_id bigint references public.notifications(id) on delete cascade,
  staff_id uuid references public.staff(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, staff_id)
);
create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  staff_id uuid not null references public.staff(id) on delete cascade,
  endpoint text not null unique,
  p256dh   text not null,
  auth     text not null,
  created_at timestamptz not null default now()
);

-- indexes
create index on public.egg_collections (d, house_id);
create index on public.egg_collections (recorded_at);
create index on public.mortality (house_id, d);
create index on public.mortality (recorded_at);
create index on public.feed_moves (d);
create index on public.feed_moves (recorded_at);
create index on public.water_logs (kind, d, house_id);
create index on public.water_logs (recorded_at);
create index on public.med_moves (medicine_id);
create index on public.med_moves (recorded_at);
create index on public.transfers (to_loc, status);
create index on public.transfers (from_loc, d);
create index on public.transfers (recorded_at);
create index on public.sales (location_id, d);
create index on public.sales (recorded_at);
create index on public.breakages (location_id, d);
create index on public.breakages (recorded_at);
create index on public.stock_counts (location_id, d);
create index on public.stock_counts (recorded_at);
create index on public.money_moves (from_acc, d);
create index on public.money_moves (to_acc, d);
create index on public.money_moves (recorded_at);
create index on public.cash_counts (location_id, d);
create index on public.cash_counts (recorded_at);
create index on public.notifications (created_at desc);

-- ---------------------------------------------------------------------
-- 3. Who is calling?
-- ---------------------------------------------------------------------
create or replace function public.me_role() returns public.staff_role
language sql stable security definer set search_path = public as $$
  select role from staff where id = auth.uid() and active
$$;
create or replace function public.me_loc() returns text
language sql stable security definer set search_path = public as $$
  select location_id from staff where id = auth.uid() and active
$$;
create or replace function public.is_mgmt() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('owner','manager') from staff where id = auth.uid() and active), false)
$$;
create or replace function public.can_farm() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('owner','manager','clerk') or (role = 'pos' and location_id = 'FARM')
                   from staff where id = auth.uid() and active), false)
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid() and active)
$$;

-- ---------------------------------------------------------------------
-- 4. Computed views (security_invoker: callers only see rows RLS allows)
-- ---------------------------------------------------------------------
create view public.v_stock_moves with (security_invoker = true) as
  select 'FARM'::text as location_id, d, 'coll'::text as kind, n, c, j
    from egg_collections where voided_at is null
  union all
  select from_loc, d, 'out', -sent_n, -sent_c, -sent_j
    from transfers where voided_at is null
  union all
  select to_loc, received_d, 'recv', recv_n, recv_c, recv_j
    from transfers where voided_at is null and status = 'received'
  union all
  select location_id, d, 'sold', -n, -c, -j
    from sales where voided_at is null
  union all
  select location_id, d, 'brk',
         -(case when item = 'N' then qty else 0 end),
         -(case when item = 'C' then qty else 0 end),
         -(case when item = 'J' then qty else 0 end)
    from breakages where voided_at is null and not transit
  union all
  select location_id, d, 'adj', adj_n, adj_c, adj_j
    from stock_counts where voided_at is null;

create view public.v_stock with (security_invoker = true) as
  select l.id as location_id,
         coalesce(sum(m.n), 0)::int as n, coalesce(sum(m.c), 0)::int as c, coalesce(sum(m.j), 0)::int as j
    from locations l left join v_stock_moves m on m.location_id = l.id
   group by l.id;

create view public.v_money_lines with (security_invoker = true) as
  select 'CASH:' || location_id as account_id, d, 'sale'::text as kind, cash as amount, location_id
    from sales where voided_at is null and cash <> 0
  union all select 'TILL', d, 'sale', till, location_id from sales where voided_at is null and till <> 0
  union all select 'PAYBILL', d, 'sale', paybill, location_id from sales where voided_at is null and paybill <> 0
  union all
  select from_acc, d, case when kind = 'expense' then 'expense' else 'move_out' end, -amount, null
    from money_moves where voided_at is null and from_acc is not null
  union all
  select from_acc, d, 'fee', -fee, null
    from money_moves where voided_at is null and from_acc is not null and fee <> 0
  union all
  select to_acc, d, case kind when 'move' then 'move_in' else kind end, amount, null
    from money_moves where voided_at is null and to_acc is not null;

create view public.v_balances with (security_invoker = true) as
  select a.id as account_id, coalesce(sum(m.amount), 0) as balance
    from accounts a left join v_money_lines m on m.account_id = a.id
   group by a.id;

create view public.v_feed_lines with (security_invoker = true) as
  select d, kind, case when kind = 'use' then -kg else kg end as kg
    from feed_moves where voided_at is null;

create view public.v_med_stock with (security_invoker = true) as
  select m.id as medicine_id,
         coalesce(sum(case when x.kind = 'use' then -x.qty else x.qty end), 0) as qty
    from medicines m left join med_moves x on x.medicine_id = m.id and x.voided_at is null
   group by m.id;

create or replace function public.farm_daily(p_from date, p_to date)
returns table (house_id text, d date, n int, c int, j int, deaths int, hens int)
language sql stable security invoker set search_path = public as $$
  select h.id, g.day::date,
    coalesce((select sum(e.n) from egg_collections e where e.house_id = h.id and e.d = g.day and e.voided_at is null), 0)::int,
    coalesce((select sum(e.c) from egg_collections e where e.house_id = h.id and e.d = g.day and e.voided_at is null), 0)::int,
    coalesce((select sum(e.j) from egg_collections e where e.house_id = h.id and e.d = g.day and e.voided_at is null), 0)::int,
    coalesce((select sum(m.birds) from mortality m where m.house_id = h.id and m.d = g.day and m.voided_at is null), 0)::int,
    (h.birds_at_start - coalesce((select sum(m.birds) from mortality m
        where m.house_id = h.id and m.d >= h.start_date and m.d < g.day and m.voided_at is null), 0))::int
  from houses h
  cross join generate_series(p_from, p_to, interval '1 day') as g(day)
  where g.day::date >= h.start_date
$$;

