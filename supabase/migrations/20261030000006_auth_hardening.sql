-- =====================================================================
-- Auth hardening (security audit, 30 Oct 2026)
--
-- * Passwords replace PINs. Every account starts on a one-time temporary
--   password that only allows setting a new one, and expires after 72 h.
-- * Two-step sign-in (TOTP authenticator app + backup codes), required
--   for the owner and the farm manager, optional for everyone else.
-- * The database itself decides whether a session may do anything:
--   _session_state() checks the session is live (and under 12 h old),
--   the account is active, the password is not temporary and, where
--   needed, that this exact session passed two-step verification.
--   Every rpc_* (through _require) and every row-level policy uses it.
-- * Failed-attempt counters (per IP and per account), exponential
--   backoff, lockout and a full sign-in log. Only the service role (the
--   `auth` edge function) can touch them.
-- * Staff security columns are no longer readable by app users.
--
-- Nothing is removed from the database. Staff are disabled, never removed,
-- so the security tables keep their history. Sessions are ended by
-- setting auth.sessions.not_after, which both Supabase Auth (on refresh)
-- and _session_state() (on every request) honour.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Staff: usernames, temporary passwords
-- ---------------------------------------------------------------------
alter table public.staff add column if not exists username text;
alter table public.staff add column if not exists must_change_password boolean not null default true;
alter table public.staff add column if not exists temp_expires_at timestamptz;
alter table public.staff add column if not exists password_changed_at timestamptz;
comment on column public.staff.must_change_pin is 'Deprecated (PIN sign-in removed 30 Oct 2026). Use must_change_password.';
comment on column public.staff.failed_attempts is 'Deprecated. Counters live in auth_counters.';
comment on column public.staff.locked_until is 'Deprecated. Lockouts live in auth_counters.';

-- usernames: short, lowercase, unique. Existing accounts get one from their role / location.
create or replace function public._slug(p text) returns text
language sql immutable set search_path = public as $$
  select left(trim(both '-' from regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '-', 'g')), 24)
$$;

create or replace function public._staff_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text; cand text; i int := 1;
begin
  if new.username is null or new.username = '' then
    base := case when new.role = 'pos' then lower(new.location_id) else _slug(new.display_name) end;
    if length(base) < 3 then base := base || '-user'; end if;
    cand := base;
    while exists (select 1 from staff where username = cand and id <> new.id) loop
      i := i + 1; cand := base || i;
    end loop;
    new.username := cand;
  else
    new.username := lower(trim(new.username));
  end if;
  if tg_op = 'INSERT' and new.must_change_password and new.temp_expires_at is null then
    new.temp_expires_at := now() + interval '72 hours';
  end if;
  return new;
end $$;
create trigger staff_defaults before insert or update of username on public.staff
  for each row execute function public._staff_defaults();

update public.staff s set username = x.u from (
  select id, case when n = 1 then b else b || n end u from (
    select id, b, row_number() over (partition by b order by created_at) n from (
      select id, created_at, case role when 'owner' then 'owner' when 'manager' then 'manager' when 'clerk' then 'clerk'
                                  else lower(location_id) end b from public.staff) a) a2) x
 where x.id = s.id and s.username is null;

-- everyone re-sets their credential: old PINs work once, as a temporary password, for 72 hours
update public.staff set must_change_password = true, temp_expires_at = now() + interval '72 hours';

alter table public.staff alter column username set not null;
alter table public.staff add constraint staff_username_key unique (username);
alter table public.staff add constraint staff_username_format check (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');

-- ---------------------------------------------------------------------
-- 2. Security tables (service role only)
-- ---------------------------------------------------------------------
create table public.auth_counters (
  key          text primary key,          -- 'ip:<kind>:<ip>' or 'sub:<kind>:<username or id>'
  fails        int not null default 0,
  hits         int not null default 0,
  window_start timestamptz not null default now(),
  last_fail    timestamptz,
  locked_until timestamptz,
  lock_count   int not null default 0,
  updated_at   timestamptz not null default now()
);

create table public.auth_events (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  kind       text not null,               -- login, otp, set_password, mfa_enroll, logout, admin, captcha ...
  ok         boolean not null,
  reason     text,
  staff_id   uuid references public.staff(id),
  username   text,                        -- only stored when it matches a real account
  ip         text,
  user_agent text
);
create index auth_events_at on public.auth_events (at desc);
create index auth_events_staff on public.auth_events (staff_id, at desc);

create table public.mfa_factors (
  staff_id     uuid primary key references public.staff(id),
  secret_enc   text not null,             -- AES-GCM encrypted TOTP secret
  confirmed_at timestamptz,
  last_step    bigint not null default 0, -- last accepted 30 s step: a code works once
  created_at   timestamptz not null default now()
);

create table public.mfa_backup_codes (
  id         bigint generated always as identity primary key,
  staff_id   uuid not null references public.staff(id),
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index on public.mfa_backup_codes (staff_id) where used_at is null;

-- sessions (Supabase auth session ids) that passed two-step verification
create table public.mfa_sessions (
  session_id  uuid primary key,
  staff_id    uuid not null references public.staff(id),
  verified_at timestamptz not null default now()
);

-- built-in CAPTCHA challenges already redeemed (single use)
create table public.auth_challenges_used (
  id         text primary key,
  expires_at timestamptz not null
);

do $$ declare t text; begin
  foreach t in array array['auth_counters','auth_events','mfa_factors','mfa_backup_codes','mfa_sessions','auth_challenges_used'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- staff: app users may read the directory columns only, never the security ones
revoke select on public.staff from anon, authenticated;
grant select (id, display_name, role, location_id, active, created_at) on public.staff to authenticated;

-- ---------------------------------------------------------------------
-- 3. Server secrets
-- ---------------------------------------------------------------------
-- gateway_secret: shared with the Vercel gateway (DPV_GATEWAY_SECRET); the
--   auth edge functions refuse calls without it, so IP limits cannot be bypassed.
-- trigger_secret: lets only the database trigger call push-notify.
insert into public.app_secrets (key, value)
select k, encode(sha256((gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text)::bytea), 'hex')
  from unnest(array['gateway_secret', 'trigger_secret']) k
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 4. The session gate
-- ---------------------------------------------------------------------
create or replace function public._sid() returns uuid
language sql stable set search_path = public as $$
  select nullif(auth.jwt() ->> 'session_id', '')::uuid
$$;

create or replace function public._mfa_required(p_role public.staff_role) returns boolean
language sql immutable set search_path = public as $$ select p_role in ('owner', 'manager') $$;

-- none | expired | inactive | mfa_verify | set_password | temp_expired | mfa_enroll | ready
create or replace function public._session_state(p_uid uuid, p_sid uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare s staff; v_created timestamptz; v_not_after timestamptz; v_factor boolean;
begin
  if p_uid is null or p_sid is null then return 'none'; end if;
  select * into s from staff where id = p_uid;
  if s.id is null or not s.active then return 'inactive'; end if;
  select x.created_at, x.not_after into v_created, v_not_after from auth.sessions x where x.id = p_sid and x.user_id = p_uid;
  if v_created is null then return 'none'; end if;
  if v_created < now() - interval '12 hours' or (v_not_after is not null and v_not_after <= now()) then return 'expired'; end if;
  v_factor := exists (select 1 from mfa_factors f where f.staff_id = p_uid and f.confirmed_at is not null);
  if v_factor and not exists (select 1 from mfa_sessions m where m.session_id = p_sid and m.staff_id = p_uid) then
    return 'mfa_verify';
  end if;
  if s.must_change_password then
    return case when s.temp_expires_at is not null and s.temp_expires_at < now() then 'temp_expired' else 'set_password' end;
  end if;
  if _mfa_required(s.role) and not v_factor then return 'mfa_enroll'; end if;
  return 'ready';
end $$;

create or replace function public._ok() returns boolean
language sql stable security definer set search_path = public as $$
  select _session_state(auth.uid(), _sid()) = 'ready'
$$;

-- the signed-in, fully verified staff member, or a clear error the app can act on
create or replace function public._me() returns public.staff
language plpgsql stable security definer set search_path = public as $$
declare st text := _session_state(auth.uid(), _sid()); s staff;
begin
  if st <> 'ready' then
    raise exception '%', case st
      when 'inactive'     then 'AUTH_INACTIVE: This account is disabled. Ask the owner.'
      when 'mfa_verify'   then 'AUTH_MFA: Enter the code from your authenticator app.'
      when 'set_password' then 'AUTH_PASSWORD: Set your own password before continuing.'
      when 'temp_expired' then 'AUTH_SIGNED_OUT: Your temporary password has expired. Ask the owner to reset it.'
      when 'mfa_enroll'   then 'AUTH_MFA_ENROLL: Set up two-step sign-in before continuing.'
      else 'AUTH_SIGNED_OUT: Your session has ended. Sign in again.' end
      using errcode = '42501';
  end if;
  select * into s from staff where id = auth.uid();
  return s;
end $$;

create or replace function public._require(p_roles public.staff_role[]) returns public.staff
language plpgsql stable security definer set search_path = public as $$
declare s staff := _me();
begin
  if not (s.role = any (p_roles)) then raise exception 'This action is not available to your role' using errcode = '42501'; end if;
  return s;
end $$;

-- helpers used by row-level policies: nothing is visible until the session is fully verified
create or replace function public.me_role() returns public.staff_role
language sql stable security definer set search_path = public as $$
  select role from staff where id = auth.uid() and active and _ok()
$$;
create or replace function public.me_loc() returns text
language sql stable security definer set search_path = public as $$
  select location_id from staff where id = auth.uid() and active and _ok()
$$;
create or replace function public.is_mgmt() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('owner','manager') from staff where id = auth.uid() and active), false) and _ok()
$$;
create or replace function public.can_farm() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('owner','manager','clerk') or (role = 'pos' and location_id = 'FARM')
                   from staff where id = auth.uid() and active), false) and _ok()
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid() and active) and _ok()
$$;

alter policy read_own on public.notification_reads using (staff_id = auth.uid() and (select is_staff()));
alter policy read_own on public.push_subscriptions using (staff_id = auth.uid() and (select is_staff()));
alter policy read_loc on public.money_moves using (
  (select is_mgmt()) or (recorded_by = auth.uid() and (select is_staff()))
  or from_acc = 'CASH:' || (select me_loc()) or to_acc = 'CASH:' || (select me_loc()));

-- ---------------------------------------------------------------------
-- 5. What the app may know about people
-- ---------------------------------------------------------------------
create or replace function public._me_json() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s staff := _me();
begin
  return jsonb_build_object('id', s.id, 'display_name', s.display_name, 'role', s.role, 'location_id', s.location_id,
    'username', s.username, 'password_changed_at', s.password_changed_at,
    'mfa_enabled', exists (select 1 from mfa_factors f where f.staff_id = s.id and f.confirmed_at is not null),
    'mfa_required', _mfa_required(s.role),
    'backup_codes_left', (select count(*) from mfa_backup_codes b where b.staff_id = s.id and b.used_at is null));
end $$;

create or replace function public._staff_list() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not _ok() then '[]'::jsonb else coalesce(jsonb_agg(
    jsonb_build_object('id', s.id, 'display_name', s.display_name, 'role', s.role, 'location_id', s.location_id, 'active', s.active)
    || case when is_mgmt() then jsonb_build_object(
         'username', s.username,
         'must_change_password', s.must_change_password,
         'mfa_enabled', exists (select 1 from mfa_factors f where f.staff_id = s.id and f.confirmed_at is not null),
         'locked', exists (select 1 from auth_counters c where c.key in ('sub:login:' || s.username, 'sub:otp:' || s.id::text)
                                                         and c.locked_until > now()))
       else '{}'::jsonb end order by s.display_name), '[]'::jsonb) end
    from staff s
$$;

-- who am I (used by the staff-admin edge function with the caller's own token)
create or replace function public.auth_whoami() returns jsonb
language sql stable security definer set search_path = public as $$ select _me_json() $$;

-- ---------------------------------------------------------------------
-- 6. Rate limiting, backoff, lockout and the sign-in log
--    (called by the auth edge function with the service role)
-- ---------------------------------------------------------------------
-- Limits, per 15-minute window:
--   per IP + action:      5 failures, 40 requests in total
--   per account + action: exponential backoff (1, 2, 4, 8 s) after each failure,
--                         then a lockout after 5 failures: 15 min, doubling on
--                         every further lockout, capped at 24 h
--   CAPTCHA:              required once the IP or the account has 3 failures
create or replace function public._counter(p_key text) returns public.auth_counters
language plpgsql security definer set search_path = public as $$
declare c auth_counters;
begin
  insert into auth_counters (key) values (p_key) on conflict (key) do nothing;
  select * into c from auth_counters where key = p_key for update;
  if c.window_start < now() - interval '15 minutes' and (c.locked_until is null or c.locked_until < now()) then
    c.fails := 0; c.hits := 0; c.window_start := now();
    if c.last_fail is null or c.last_fail < now() - interval '24 hours' then c.lock_count := 0; end if;
  end if;
  return c;
end $$;

create or replace function public._counter_save(c public.auth_counters) returns void
language sql security definer set search_path = public as $$
  update auth_counters set fails = c.fails, hits = c.hits, window_start = c.window_start, last_fail = c.last_fail,
         locked_until = c.locked_until, lock_count = c.lock_count, updated_at = now()
   where key = c.key
$$;

create or replace function public.auth_check(p_kind text, p_ip text, p_subject text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ci auth_counters; cs auth_counters; wait int := 0; why text := null; backoff int;
begin
  ci := _counter('ip:' || p_kind || ':' || coalesce(p_ip, 'unknown'));
  ci.hits := ci.hits + 1;
  perform _counter_save(ci);
  if p_subject is not null then cs := _counter('sub:' || p_kind || ':' || lower(p_subject)); end if;

  if ci.locked_until > now() then
    wait := ceil(extract(epoch from ci.locked_until - now())); why := 'ip_locked';
  elsif ci.hits > 40 then
    wait := ceil(extract(epoch from ci.window_start + interval '15 minutes' - now())); why := 'ip_rate';
  elsif cs.key is not null and cs.locked_until > now() then
    wait := ceil(extract(epoch from cs.locked_until - now())); why := 'account_locked';
  elsif cs.key is not null and cs.fails > 0 then
    backoff := least(power(2, cs.fails - 1)::int, 60);
    if cs.last_fail + make_interval(secs => backoff) > now() then
      wait := ceil(extract(epoch from cs.last_fail + make_interval(secs => backoff) - now())); why := 'backoff';
    end if;
  end if;

  return jsonb_build_object('allowed', why is null, 'reason', why, 'retry_after', greatest(wait, 1),
    'captcha', greatest(ci.fails, coalesce(cs.fails, 0), case when coalesce(cs.lock_count, 0) > 0 then 3 else 0 end) >= 3);
end $$;

create or replace function public.auth_record(p_kind text, p_ip text, p_subject text, p_ok boolean, p_reason text,
                                              p_staff uuid default null, p_username text default null, p_ua text default null,
                                              p_count boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ci auth_counters; cs auth_counters; locked_for int := 0;
begin
  insert into auth_events (kind, ok, reason, staff_id, username, ip, user_agent)
  values (p_kind, p_ok, left(p_reason, 200), p_staff, left(p_username, 40), left(p_ip, 64), left(p_ua, 200));
  if not p_count then return jsonb_build_object('locked_for', 0); end if;

  if p_subject is not null then cs := _counter('sub:' || p_kind || ':' || lower(p_subject)); end if;
  if p_ok then
    -- success clears the account's counter; the IP counter is kept so an attacker
    -- cannot reset it by signing in to an account of their own in between guesses
    if cs.key is not null then
      cs.fails := 0; cs.locked_until := null; cs.lock_count := 0; cs.last_fail := null;
      perform _counter_save(cs);
    end if;
    return jsonb_build_object('locked_for', 0);
  end if;

  ci := _counter('ip:' || p_kind || ':' || coalesce(p_ip, 'unknown'));
  ci.fails := ci.fails + 1; ci.last_fail := now();
  if ci.fails >= 5 then ci.locked_until := ci.window_start + interval '15 minutes'; end if;
  perform _counter_save(ci);

  if cs.key is not null then
    cs.fails := cs.fails + 1; cs.last_fail := now();
    if cs.fails >= 5 then
      cs.lock_count := cs.lock_count + 1;
      cs.locked_until := now() + least(interval '15 minutes' * power(2, cs.lock_count - 1), interval '24 hours');
      cs.fails := 4;              -- one more failure after the lockout locks again, for longer
      locked_for := ceil(extract(epoch from cs.locked_until - now()));
    end if;
    perform _counter_save(cs);
  end if;
  return jsonb_build_object('locked_for', locked_for,
    'captcha', greatest(ci.fails, coalesce(cs.fails, 0), case when coalesce(cs.lock_count, 0) > 0 then 3 else 0 end) >= 3,
    'left', case when cs.key is null or locked_for > 0 then 0 else 5 - cs.fails end);
end $$;

-- the owner unlocks an account (clears its counters without deleting them)
create or replace function public.auth_unlock(p_staff uuid) returns void
language sql security definer set search_path = public as $$
  update auth_counters set fails = 0, locked_until = null, lock_count = 0, last_fail = null, updated_at = now()
   where split_part(key, ':', 1) = 'sub'
     and split_part(key, ':', 3) in (p_staff::text, (select username from staff where id = p_staff))
$$;

-- built-in CAPTCHA: a challenge can be redeemed once
create or replace function public.auth_redeem_challenge(p_id text, p_expires timestamptz) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  insert into auth_challenges_used (id, expires_at) values (p_id, p_expires);
  return true;
exception when unique_violation then
  return false;
end $$;

-- state of a session, for the edge functions
create or replace function public.auth_state(p_uid uuid, p_sid uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('state', _session_state(p_uid, p_sid),
    'staff', (select jsonb_build_object('id', s.id, 'username', s.username, 'display_name', s.display_name, 'role', s.role,
                     'location_id', s.location_id, 'active', s.active, 'must_change_password', s.must_change_password,
                     'temp_expires_at', s.temp_expires_at) from staff s where s.id = p_uid),
    'mfa_enabled', exists (select 1 from mfa_factors f where f.staff_id = p_uid and f.confirmed_at is not null),
    'mfa_required', coalesce((select _mfa_required(role) from staff where id = p_uid), false))
$$;

-- end sessions: one (sign out), all but one (after a password change) or all (sign out everywhere, reset, disable)
create or replace function public.auth_end_sessions(p_uid uuid, p_only uuid default null, p_keep uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update auth.sessions set not_after = now()
   where user_id = p_uid and (p_only is null or id = p_only) and (p_keep is null or id <> p_keep)
     and (not_after is null or not_after > now());
  get diagnostics n = row_count;
  return n;
end $$;

-- the owner's sign-in log
create or replace function public.security_log(p_limit int default 200, p_staff uuid default null)
returns table (at timestamptz, kind text, ok boolean, reason text, staff_id uuid, display_name text, username text, ip text, user_agent text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require(array['owner']::staff_role[]);
  return query
    select e.at, e.kind, e.ok, e.reason, e.staff_id, s.display_name, coalesce(s.username, e.username), e.ip, e.user_agent
      from auth_events e left join staff s on s.id = e.staff_id
     where p_staff is null or e.staff_id = p_staff
     order by e.at desc, e.id desc
     limit least(greatest(p_limit, 1), 1000);
end $$;

-- ---------------------------------------------------------------------
-- 7. Push notifications: only the database trigger may call push-notify
-- ---------------------------------------------------------------------
create or replace function public._push_notification() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text;
begin
  select push_url into v_url from settings where id = 1;
  select value into v_secret from app_secrets where key = 'trigger_secret';
  if v_url is not null then
    begin
      perform net.http_post(url := v_url, body := jsonb_build_object('id', new.id),
                            headers := jsonb_build_object('Content-Type', 'application/json', 'x-dpv-trigger', coalesce(v_secret, '')));
    exception when others then
      null;  -- never block the action that raised the notification
    end;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 8. Reads that now go through the session gate
-- ---------------------------------------------------------------------
-- Same as before except: 'me' and 'staff' come from definer helpers (the
-- security columns are no longer readable directly) and a session that is
-- not fully signed in gets an AUTH_* error instead of an empty dashboard.
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
    'medicines', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'unit', m.unit, 'reorder', m.reorder,
                         'active', m.active, 'stock', coalesce(v.qty, 0)) order by m.name), '[]')
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

-- Activity feed: unchanged except for the session gate.
create or replace function public.activity(p_limit int default 60, p_before timestamptz default null,
                                           p_loc text default null, p_kind text default null)
returns table (kind text, id bigint, d date, recorded_at timestamptz, by_name text, by_role public.staff_role,
               location_id text, voided boolean, data jsonb)
language plpgsql stable security invoker set search_path = public as $$
begin
  perform _me_json();  -- AUTH_* error unless this session is fully signed in
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
    union all select 'money', x.id, x.d, x.recorded_at, x.recorded_by, null, x.voided_at is not null, to_jsonb(x) from money_moves x
    union all select 'cash', x.id, x.d, x.recorded_at, x.recorded_by, x.location_id, x.voided_at is not null, to_jsonb(x) from cash_counts x
  )
  select a.k, a.id, a.d, a.recorded_at, s.display_name, s.role, a.loc, a.v, a.j
    from a left join staff s on s.id = a.recorded_by
   where (p_before is null or a.recorded_at < p_before)
     and (p_kind is null or a.k = p_kind)
     and (p_loc is null or a.loc = p_loc
          or (a.k = 'xfer' and a.j->>'to_loc' = p_loc)
          or (a.k = 'money' and (a.j->>'from_acc' = 'CASH:' || p_loc or a.j->>'to_acc' = 'CASH:' || p_loc)))
   order by a.recorded_at desc, a.id desc
   limit least(greatest(p_limit, 1), 500);
end $$;

-- ---------------------------------------------------------------------
-- 9. Privileges, restated in full
-- ---------------------------------------------------------------------
-- Supabase grants EXECUTE on new functions to anon and authenticated by
-- default, so start from nothing and grant exactly what the app needs.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.activity(int, timestamptz, text, text), public.dashboard(int), public.farm_daily(date, date),
  public.band_label(text), public.band_rank(text), public.band_sev(text), public.buffer_band(numeric), public.biz_today(),
  public.can_farm(), public.is_mgmt(), public.is_staff(), public.me_loc(), public.me_role(),
  public._me_json(), public._staff_list(), public.auth_whoami(), public.security_log(int, uuid)
to authenticated;
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'rpc\_%' loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
