-- 8 Nov 2026: a fail-safe way back in when a password is lost.
--   * staff.recovery_email / recovery_verified_at: an email the owner adds after
--     signing in, confirmed with a code sent to it.
--   * account_codes: one-time codes, stored only as a salted SHA-256 hash.
--       purpose 'reset'        a password reset (channel 'email', or 'operator' for a
--                              code issued from the database console)
--       purpose 'verify_email' confirming a recovery email
--     Email codes last 15 minutes, console codes 24 hours; five wrong tries burn a code.
--   * issue_recovery_code(username): the break-glass path. Run in the Supabase SQL
--     editor (as the database owner); it returns a one-time code to give to the person,
--     who uses "Forgot password" on the sign-in screen with it. No API role can call it.
-- New only: nothing existing changes.

alter table public.staff add column if not exists recovery_email text;
alter table public.staff add column if not exists recovery_verified_at timestamptz;

create table if not exists public.account_codes (
  id bigint generated always as identity primary key,
  staff_id uuid not null references public.staff(id),
  purpose text not null check (purpose in ('reset', 'verify_email')),
  channel text not null check (channel in ('email', 'operator')),
  email text,                                   -- verify_email: the address being confirmed
  salt text not null,
  code_hash text not null,                      -- hex sha256(salt || ':' || code)
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz
);
create index if not exists account_codes_staff on public.account_codes (staff_id, purpose, created_at desc);
alter table public.account_codes enable row level security;
revoke all on public.account_codes from public, anon, authenticated;
grant all on public.account_codes to service_role;

-- the console code: 10 characters from an alphabet without look-alikes (no 0, O, 1, I, L)
create or replace function public.issue_recovery_code(p_username text)
returns text language plpgsql security definer set search_path = public as $$
declare s staff; v_alpha text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; v_bytes bytea; v_code text := ''; v_salt text; i int;
begin
  select * into s from staff where lower(username) = lower(trim(p_username)) and active;
  if s.id is null then raise exception 'No active account called %', p_username; end if;
  v_bytes := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  for i in 0..9 loop
    v_code := v_code || substr(v_alpha, (get_byte(v_bytes, i) % length(v_alpha)) + 1, 1);
  end loop;
  v_salt := encode(uuid_send(gen_random_uuid()), 'hex');
  update account_codes set used_at = now() where staff_id = s.id and purpose = 'reset' and used_at is null;
  insert into account_codes (staff_id, purpose, channel, salt, code_hash, expires_at)
  values (s.id, 'reset', 'operator', v_salt, encode(sha256(convert_to(v_salt || ':' || v_code, 'UTF8')), 'hex'), now() + interval '24 hours');
  insert into auth_events (kind, ok, reason, staff_id, username)
  values ('admin', true, 'recovery code issued from the database console', s.id, s.username);
  return format('Recovery code for %s: %s-%s (one use, valid 24 hours). On the sign-in screen choose Forgot password, enter the username, then this code and a new password.',
                s.username, substr(v_code, 1, 5), substr(v_code, 6, 5));
end $$;
revoke execute on function public.issue_recovery_code(text) from public, anon, authenticated, service_role;
