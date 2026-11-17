-- 17 Nov 2026: days complete, for each person.
-- Read-only, from the same completeness() check that feeds Days with gaps and
-- the morning reminders. No new reminders, no email, nothing stored.
--   * A person's part of a day: the production clerk has every house (eggs and
--     water), the inventory clerk has the farm's feed issued to the houses, an
--     outlet attendant or the van driver has their own place. A day is
--     complete when nothing of theirs is missing; a closed outlet day, or a day
--     the van did not go out, is left out. Days before tracking began or before
--     the person's account existed are left out too.
--   * rpc_my_week(): field staff, their own Monday to Sunday, how many days
--     were complete and how many complete days in a row.
--   * rpc_day_ranking(days): the owner and farm manager, each field person's
--     complete days over the last days to yesterday, with their last entry
--     from the app and their last sign-in.
-- New only: nothing existing changes.

-- one person's part of one completeness() day
create or replace function public._my_day(p_role public.staff_role, p_loc text, c jsonb)
returns jsonb language sql immutable set search_path = public as $$
  with mine as (
    select i from jsonb_array_elements(coalesce(c->'items', '[]'::jsonb)) i
     where case p_role when 'pos' then i->>'scope' = 'outlet' and i->>'id' = p_loc
                       when 'clerk' then i->>'scope' = 'house'
                       when 'store' then i->>'scope' = 'farm'
                       else false end),
  opn as (select i from mine where not coalesce((i->>'closed')::boolean, false)),
  miss as (select i->>'name' as name, i->'missing' as list,
                  regexp_replace((select string_agg(x, ', ') from jsonb_array_elements_text(i->'missing') x), ', ([^,]*)$', ' and \1') as what
             from opn where jsonb_array_length(coalesce(i->'missing', '[]'::jsonb)) > 0)
  select jsonb_build_object(
    'state', case when not exists (select 1 from mine) then 'none'
                  when not exists (select 1 from opn) then 'closed'
                  when exists (select 1 from miss) then 'missed'
                  else 'done' end,
    'missing', case p_role
      when 'clerk' then coalesce((select jsonb_agg(format('%s for %s', what, name)) from miss), '[]'::jsonb)
      when 'store' then case when exists (select 1 from miss) then '["feed issued to the houses"]'::jsonb else '[]'::jsonb end
      else coalesce((select jsonb_agg(x) from miss, jsonb_array_elements(list) x), '[]'::jsonb) end)
$$;
revoke execute on function public._my_day(public.staff_role, text, jsonb) from public, anon, authenticated;

-- the first day a person's records are expected (Nairobi day of their account, not before tracking began)
create or replace function public._counted_from(p staff)
returns date language sql stable set search_path = public as $$
  select greatest(coalesce((select tracking_from from settings where id = 1), biz_today()),
                  (p.created_at at time zone 'Africa/Nairobi')::date)
$$;
revoke execute on function public._counted_from(staff) from public, anon, authenticated;

create or replace function public.rpc_my_week()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s staff := _require(array['clerk','store','pos']::staff_role[]);
  t date := biz_today();
  mon date := t - (extract(isodow from t)::int - 1);
  v_from date := _counted_from(s);
  d date; r jsonb; seen jsonb := '{}'::jsonb; days jsonb := '[]'::jsonb;
  n_done int := 0; n_count int := 0; streak int := 0; v_broken boolean := false;
begin
  -- newest first: this week's days, and complete days in a row (at most four weeks back)
  for d in select generate_series(t, least(mon, t - 27), interval '-1 day')::date loop
    exit when d < v_from or (v_broken and d < mon);
    r := _my_day(s.role, s.location_id, completeness(d));
    if d >= mon then seen := seen || jsonb_build_object(d::text, r); end if;
    if not v_broken then
      if r->>'state' = 'done' then streak := streak + 1;
      elsif r->>'state' = 'missed' and d < t then v_broken := true;   -- today is not over yet
      end if;
    end if;
  end loop;
  for d in select generate_series(mon, mon + 6, interval '1 day')::date loop
    if d > t then r := jsonb_build_object('state', 'later');
    elsif d < v_from then r := jsonb_build_object('state', 'before');
    else
      r := seen->(d::text);
      if r->>'state' = 'done' then n_done := n_done + 1; n_count := n_count + 1;
      elsif r->>'state' = 'missed' and d < t then n_count := n_count + 1;
      elsif r->>'state' = 'missed' then r := r || '{"state":"today"}'::jsonb;
      end if;
    end if;
    days := days || (r || jsonb_build_object('day', d, 'label', to_char(d, 'Dy DD Mon')));
  end loop;
  return jsonb_build_object('from', mon, 'today', t, 'days', days, 'done', n_done, 'counted', n_count, 'streak', streak);
end $$;
revoke execute on function public.rpc_my_week() from public, anon;
grant execute on function public.rpc_my_week() to authenticated;

create or replace function public.rpc_day_ranking(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  t date := biz_today();
  v_to date := t - 1;
  v_from date;
  cs jsonb := '{}'::jsonb; d date; p staff; v_place text; v_kind text; r jsonb; arr jsonb; rows jsonb := '[]'::jsonb;
  n_done int; n_count int; v_miss jsonb; v_first date;
begin
  perform _require(array['owner','manager']::staff_role[]);
  v_from := greatest(v_to - (least(greatest(coalesce(p_days, 7), 1), 62) - 1),
                     coalesce((select tracking_from from settings where id = 1), t));
  for d in select generate_series(v_from, v_to, interval '1 day')::date loop
    cs := cs || jsonb_build_object(d::text, completeness(d));
  end loop;
  for p in select * from staff s where s.active and s.role in ('clerk', 'store', 'pos') order by s.display_name loop
    select l.name, l.kind::text into v_place, v_kind from locations l where l.id = p.location_id;
    arr := '[]'::jsonb; n_done := 0; n_count := 0; v_miss := null;
    v_first := _counted_from(p);
    for d in select generate_series(v_from, v_to, interval '1 day')::date loop
      if d < v_first then r := jsonb_build_object('state', 'before');
      else r := _my_day(p.role, p.location_id, cs->(d::text)); end if;
      if r->>'state' = 'done' then n_done := n_done + 1; n_count := n_count + 1;
      elsif r->>'state' = 'missed' then n_count := n_count + 1;
        v_miss := jsonb_build_object('day', d, 'label', to_char(d, 'Dy DD Mon'), 'missing', r->'missing');
      end if;
      arr := arr || jsonb_build_object('day', d, 'state', r->>'state');
    end loop;
    rows := rows || jsonb_build_object(
      'id', p.id, 'name', p.display_name, 'role', p.role, 'location_id', p.location_id, 'place', v_place,
      'van', coalesce(v_kind = 'van', false), 'days', arr, 'done', n_done, 'counted', n_count, 'last_missed', v_miss,
      'last_entry', (select max(o.received_at) from client_ops o where o.staff_id = p.id),
      'last_signin', (select max(a.at) from auth_events a where a.staff_id = p.id and a.kind = 'login' and a.ok));
  end loop;
  return jsonb_build_object('from', v_from, 'to', v_to, 'people', coalesce((
    select jsonb_agg(x order by ((x->>'counted')::int > 0) desc,
                                case when (x->>'counted')::int > 0 then (x->>'done')::numeric / (x->>'counted')::int end desc nulls last,
                                (x->>'done')::int desc, x->>'name')
      from jsonb_array_elements(rows) x), '[]'::jsonb));
end $$;
revoke execute on function public.rpc_day_ranking(int) from public, anon;
grant execute on function public.rpc_day_ranking(int) to authenticated;
