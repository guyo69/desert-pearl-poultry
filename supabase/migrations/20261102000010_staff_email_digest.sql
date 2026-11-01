-- =====================================================================
-- 2 Nov 2026: who gets the weekly digest and the data nudges by email.
--
--  * staff.email: optional, checked for shape. Only the service role
--    (the owner's staff-admin function) can read or write it: signed-in
--    users keep their column-level grant on the six public columns only.
--  * staff.digest_enabled: the owner switches it; the one-click link in
--    each email turns it off (digest_opted_out_at records when).
--  * Staff without an email are simply skipped by the senders.
-- Adds columns only: no existing row or function changes.
-- =====================================================================

alter table public.staff add column if not exists email text;
alter table public.staff add column if not exists digest_enabled boolean not null default true;
alter table public.staff add column if not exists digest_opted_out_at timestamptz;

alter table public.staff drop constraint if exists staff_email_shape;
alter table public.staff add constraint staff_email_shape check (
  email is null or (
    length(email) between 6 and 254
    and email = lower(btrim(email))
    and email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  ));

comment on column public.staff.email is 'Optional, for the weekly digest and data nudges. Owner-only (service role); never exposed to signed-in users.';
comment on column public.staff.digest_enabled is 'Weekly digest and email nudges on/off. The one-click link in each email turns it off.';

-- the grants on staff are column-level; restate them so the new columns stay private
revoke all on public.staff from anon, authenticated;
grant select (id, display_name, role, location_id, active, created_at) on public.staff to authenticated;
grant all on public.staff to service_role;
