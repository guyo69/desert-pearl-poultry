-- 9 Nov 2026: in-app help. Tips point at the real buttons once, in the order each
-- role works; which tips a person has seen is kept on their account, so a new
-- phone does not start the tour again.
--   * staff.tips_seen: tip ids already shown to this person.
--   * rpc_tips(add, reset): adds ids, removes ids (Show me around), returns the list.
-- New only: nothing existing changes.

alter table public.staff add column if not exists tips_seen text[] not null default '{}';

create or replace function public.rpc_tips(p_add text[] default null, p_reset text[] default null)
returns text[] language plpgsql security definer set search_path = public as $$
declare s staff; v text[];
begin
  s := _require(array['owner','manager','clerk','store','pos']::staff_role[]);
  if coalesce(array_length(p_add, 1), 0) > 50 or coalesce(array_length(p_reset, 1), 0) > 200 then raise exception 'Too many tips'; end if;
  if exists (select 1 from unnest(coalesce(p_add, '{}') || coalesce(p_reset, '{}')) x where x !~ '^[a-z0-9:._-]{1,60}$') then raise exception 'Unknown tip'; end if;
  if p_add is null and p_reset is null then return s.tips_seen; end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v
    from unnest(s.tips_seen || coalesce(p_add, '{}')) x
   where not (x = any (coalesce(p_reset, '{}')));
  v := v[1:300];
  update staff set tips_seen = v where id = s.id;
  return v;
end $$;
revoke execute on function public.rpc_tips(text[], text[]) from public, anon;
grant execute on function public.rpc_tips(text[], text[]) to authenticated, service_role;
