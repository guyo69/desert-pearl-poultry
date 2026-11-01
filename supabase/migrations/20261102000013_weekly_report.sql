-- 2 Nov 2026: the Report screen uses the same insight engine as the weekly email.
-- New function only; nothing existing changes.
-- The last 7 days to yesterday (or to p_to), in the caller's scope. Owner and farm manager only,
-- the same people who see the Report screen.
create or replace function public.rpc_weekly_report(p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s staff; v_to date;
begin
  s := _require(array['owner','manager']::staff_role[]);
  v_to := least(coalesce(p_to, biz_today() - 1), biz_today() - 1);
  if v_to < biz_today() - 400 then raise exception 'Choose a more recent week'; end if;
  return weekly_facts(v_to - 6, v_to, s.role, s.location_id);
end $$;

revoke execute on function public.rpc_weekly_report(date) from public, anon;
grant execute on function public.rpc_weekly_report(date) to authenticated, service_role;
