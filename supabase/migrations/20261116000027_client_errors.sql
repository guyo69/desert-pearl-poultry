-- 16 Nov 2026: problems seen on people's phones.
-- When a screen fails, the app hits an error, or something is slow for the
-- person (a screen that takes long to show, a tap that takes long to answer),
-- the app sends a short note: what kind, which screen, the error message, a
-- measured time, the app version and the kind of device. No form values, no
-- figures from the farm: long numbers, phone numbers and emails are blanked
-- before saving. At most 30 notes a person an hour.
--   * rpc_log_client(p): every signed-in person (their own notes only)
--   * rpc_client_errors(days): the owner and farm manager, grouped for the
--     App problems card in Settings
-- New only: nothing existing changes.

create table if not exists public.client_errors (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  staff_id uuid not null references public.staff(id),
  role public.staff_role not null,
  kind text not null check (kind in ('error', 'slow')),
  screen text,
  message text not null,
  detail text,
  metric numeric,                 -- milliseconds, for 'slow'
  app text,                       -- app version (commit)
  device text                     -- Android, iPhone, Windows, Mac, other
);
create index if not exists client_errors_at on public.client_errors (at desc);
create index if not exists client_errors_staff on public.client_errors (staff_id, at desc);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from public, anon, authenticated;
grant all on public.client_errors to service_role;

-- blank anything that could be personal: emails, phone numbers and long digit runs
create or replace function public._scrub(t text, n int) returns text
language sql immutable as $$
  select left(regexp_replace(regexp_replace(regexp_replace(coalesce(t, ''),
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'),
    '\+?\d[\d\s-]{8,}\d', '[number]', 'g'),
    '\d{5,}', '[number]', 'g'), n)
$$;
revoke execute on function public._scrub(text, int) from public, anon, authenticated;

create or replace function public.rpc_log_client(p jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  s staff := _require(array['owner','manager','clerk','store','pos']::staff_role[]);
  room int; x jsonb; n int := 0;
begin
  if p is null or jsonb_typeof(p) <> 'array' or length(p::text) > 32768 then return 0; end if;
  room := 30 - (select count(*) from client_errors where staff_id = s.id and at > now() - interval '1 hour');
  for x in select value from jsonb_array_elements(p) limit 10 loop
    exit when n >= room;
    continue when coalesce(x->>'kind', '') not in ('error', 'slow') or coalesce(trim(x->>'message'), '') = '';
    insert into client_errors (staff_id, role, kind, screen, message, detail, metric, app, device)
    values (s.id, s.role, x->>'kind',
            case when x->>'screen' ~ '^[a-z_]{1,20}$' then x->>'screen' end,
            _scrub(x->>'message', 300),
            nullif(_scrub(x->>'detail', 1500), ''),
            case when x->>'metric' ~ '^\d{1,7}(\.\d+)?$' then round((x->>'metric')::numeric) end,
            left(regexp_replace(coalesce(x->>'app', ''), '[^A-Za-z0-9._-]', '', 'g'), 20),
            case when x->>'device' in ('Android', 'iPhone', 'iPad', 'Windows', 'Mac', 'Linux') then x->>'device' else 'other' end);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.rpc_log_client(jsonb) from public, anon;
grant execute on function public.rpc_log_client(jsonb) to authenticated;

create or replace function public.rpc_client_errors(p_days int default 14)
returns table (kind text, screen text, message text, times bigint, people bigint, roles text[], first_at timestamptz, last_at timestamptz,
               slowest numeric, devices text[], app text, detail text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require(array['owner','manager']::staff_role[]);
  return query
    select e.kind, e.screen, e.message, count(*), count(distinct e.staff_id),
           array_agg(distinct e.role::text), min(e.at), max(e.at), max(e.metric),
           array_agg(distinct e.device), (array_agg(e.app order by e.at desc))[1], (array_agg(e.detail order by e.at desc))[1]
      from client_errors e
     where e.at > now() - make_interval(days => least(greatest(coalesce(p_days, 14), 1), 90))
     group by e.kind, e.screen, e.message
     order by max(e.at) desc
     limit 50;
end $$;
revoke execute on function public.rpc_client_errors(int) from public, anon;
grant execute on function public.rpc_client_errors(int) to authenticated;
