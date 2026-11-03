-- 3 Nov 2026, client request:
--   * the email digest is repealed completely: no weekly digest, no reminder
--     emails, no opt-out links
--   * notifications are a few fixed reminders a day, and nothing else:
--       09:00  sales points: opening count (only if not done, not on a closed day)
--              van: start of day; production clerk: tank and water (only if not
--              read yet); inventory clerk: store check (only when something
--              is low or still unconfirmed)
--       19:00  sales points: close the day (only if not closed); van: eggs still
--              on board; production clerk: eggs or water still missing
--       21:00  owner and farm manager: the day's close
--     Every other alert the functions used to send is no longer sent. The app
--     still shows live alerts on its screens.
-- Changed, not new: the internal helpers _notify and _notify_once (they now
-- send only reminders). The digest functions and the old morning checks are
-- removed with their schedules. The send logs (digest_log, nudge_log) and every
-- notification already sent are kept.

-- ---------------------------------------------------------------------
-- 1. Schedules: the digest and the 06:00 checks off, the reminders on
-- ---------------------------------------------------------------------
do $$
declare j text;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    foreach j in array array['dpv-weekly-digest', 'dpv-weekly-digest-retry', 'dpv-daily-checks',
                             'dpv-reminders-morning', 'dpv-reminders-evening', 'dpv-day-close'] loop
      if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
    end loop;
    perform cron.schedule('dpv-reminders-morning', '0 6 * * *', 'select public.reminders(''morning'')');   -- 09:00 Nairobi
    perform cron.schedule('dpv-reminders-evening', '0 16 * * *', 'select public.reminders(''evening'')');  -- 19:00 Nairobi
    perform cron.schedule('dpv-day-close', '0 18 * * *', 'select public.reminders(''close'')');            -- 21:00 Nairobi
  end if;
exception when others then
  raise notice 'reminder schedules not set: %', sqlerrm;
end $$;

drop function if exists public.digest_enqueue(date);
drop function if exists public.mail_recipients();
drop function if exists public.mail_claim(text, uuid, date);
drop function if exists public.mail_finish(text, bigint, text, text, text, int);
drop function if exists public.digest_entries(date, date, public.staff_role, text);
drop function if exists public.daily_checks();
drop function if exists public._completeness_nudges(date);
drop function if exists public._digest_post(jsonb);

-- ---------------------------------------------------------------------
-- 2. Only reminders are sent
-- ---------------------------------------------------------------------
create or replace function public._notify(p_sev text, p_title text, p_body text, p_roles public.staff_role[],
                                          p_loc text default null, p_kind text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if coalesce(p_kind, '') not in ('reminder', 'day_close') then return null; end if;   -- event alerts are no longer sent
  insert into notifications (sev, title, body, to_roles, location_id, kind)
  values (p_sev, p_title, coalesce(p_body, ''), p_roles, p_loc, p_kind) returning id into v_id;
  return v_id;
end $$;

create or replace function public._notify_once(p_key text, p_sev text, p_title text, p_body text, p_roles public.staff_role[],
                                               p_loc text default null, p_kind text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if coalesce(p_kind, '') not in ('reminder', 'day_close') then return null; end if;
  insert into notifications (sev, title, body, to_roles, location_id, kind, dedupe_key)
  values (p_sev, p_title, coalesce(p_body, ''), p_roles, p_loc, p_kind, p_key)
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public._notify(text, text, text, public.staff_role[], text, text),
  public._notify_once(text, text, text, text, public.staff_role[], text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. The reminders
-- ---------------------------------------------------------------------
-- Is a location closed today (its regular closing day, or marked closed)?
create or replace function public._closed_on(p_loc text, p_day date) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select extract(isodow from p_day)::int = any (closed_dow) from locations where id = p_loc), false)
      or exists (select 1 from day_marks k where k.location_id = p_loc and k.d = p_day and k.kind = 'closed' and k.voided_at is null)
$$;

-- p_slot: 'morning' (09:00), 'evening' (19:00) or 'close' (21:00). Sends each
-- reminder at most once a day, and only when there is something to do.
-- Returns how many were sent.
create or replace function public.reminders(p_slot text)
returns int language plpgsql security definer set search_path = public as $$
declare t date := biz_today(); l record; n int := 0; v_id bigint; v_txt text; v_left int; v_low text; v_pend int;
        v_open int; v_closed int; v_not text; v_sales numeric; v_farm text;
begin
  if p_slot = 'morning' then
    -- sales points (not the van): opening count
    for l in select * from locations where kind <> 'van' order by sort loop
      continue when _closed_on(l.id, t);
      continue when exists (select 1 from stock_counts c where c.location_id = l.id and c.d = t and c.kind in ('open', 'opening_balance') and c.voided_at is null);
      v_id := _notify_once(format('rem:morning:%s:%s', t, l.id), 'info', format('Good morning, %s: count the opening stock', l.short),
        'Count the eggs on hand before you start selling. If you are not opening today, mark the day closed.', array['pos']::staff_role[], l.id, 'reminder');
      if v_id is not null then n := n + 1; end if;
    end loop;
    -- the van: start of the day
    for l in select * from locations where kind = 'van' loop
      continue when _closed_on(l.id, t);
      v_pend := (select count(*) from transfers x where x.to_loc = l.id and x.status = 'in_transit' and x.voided_at is null);
      v_id := _notify_once(format('rem:morning:%s:%s', t, l.id), 'info', 'Good morning: start the van''s day',
        case when v_pend > 0 then format('%s load%s waiting for you. Receive %s before you set off. The van ends the day empty.', v_pend, case when v_pend > 1 then 's are' else ' is' end, case when v_pend > 1 then 'them' else 'it' end)
             else 'Receive your load before you set off. The van ends the day empty.' end,
        array['pos']::staff_role[], l.id, 'reminder');
      if v_id is not null then n := n + 1; end if;
    end loop;
    -- production clerk: the tank and water, if the tank is not read yet
    if exists (select 1 from houses where active and birds_at_start > 0)
       and not exists (select 1 from water_logs w where w.kind = 'tank' and w.d = t and w.voided_at is null) then
      v_id := _notify_once(format('rem:morning:%s:clerk', t), 'info', 'Good morning: read the water tank',
        'Record the tank level, then the water each house drinks. Confirm the feed the store issues as it reaches each house.', array['clerk']::staff_role[], 'FARM', 'reminder');
      if v_id is not null then n := n + 1; end if;
    end if;
    -- inventory clerk: only when something is low or still unconfirmed
    select string_agg(x, ', ') into v_low from (
      select m.name x from medicines m join v_med_stock v on v.medicine_id = m.id where m.active and v.qty <= m.reorder
      union all select s.name from supplies s join v_supply_stock v on v.supply_id = s.id where s.active and v.qty <= s.reorder
      union all select 'Feed' where (select coalesce(sum(kg), 0) from v_feed_lines) < (select feed_buffer_kg * 0.5 from settings where id = 1)) q;
    v_pend := (select count(*) from feed_moves f where f.need_confirm and f.voided_at is null and f.d < t
                and not exists (select 1 from issue_confirms c where c.kind = 'feed' and c.move_id = f.id and c.voided_at is null))
            + (select count(*) from med_moves x where x.need_confirm and x.voided_at is null and x.d < t
                and not exists (select 1 from issue_confirms c where c.kind = 'med' and c.move_id = x.id and c.voided_at is null));
    if v_low is not null or v_pend > 0 then
      v_id := _notify_once(format('rem:morning:%s:store', t), 'info', 'Store check',
        concat_ws(' ', case when v_low is not null then format('Running low: %s. Tell the farm manager.', v_low) end,
                       case when v_pend > 0 then format('%s issue%s from earlier days not yet confirmed by the production clerk.', v_pend, case when v_pend > 1 then 's' else '' end) end),
        array['store']::staff_role[], 'FARM', 'reminder');
      if v_id is not null then n := n + 1; end if;
    end if;

  elsif p_slot = 'evening' then
    -- sales points: close the day
    for l in select * from locations where kind <> 'van' order by sort loop
      continue when _closed_on(l.id, t);
      continue when exists (select 1 from stock_counts c where c.location_id = l.id and c.d = t and c.kind = 'close' and c.voided_at is null);
      v_id := _notify_once(format('rem:evening:%s:%s', t, l.id), 'info', format('%s: close the day', l.short),
        'Count the eggs left and the cash, and check every sale is recorded.', array['pos']::staff_role[], l.id, 'reminder');
      if v_id is not null then n := n + 1; end if;
    end loop;
    -- the van: eggs still on board
    for l in select * from locations where kind = 'van' loop
      v_left := (select coalesce(sum(m.n + m.b + m.c + m.j), 0) from v_stock_moves m where m.location_id = l.id)::int;
      continue when v_left <= 0;
      v_id := _notify_once(format('rem:evening:%s:%s', t, l.id), 'info', format('%s still on the van', _eggs(v_left)),
        'Drop them at the farm or an outlet with Drop off what is left. Then bank or send the cash.', array['pos']::staff_role[], l.id, 'reminder');
      if v_id is not null then n := n + 1; end if;
    end loop;
    -- production clerk: eggs or water still missing today
    select string_agg(format('%s (%s)', h.name, array_to_string(array_remove(array[
             case when not exists (select 1 from egg_collections e where e.house_id = h.id and e.d = t and e.voided_at is null) then 'eggs' end,
             case when not exists (select 1 from water_logs w where w.house_id = h.id and w.d = t and w.kind = 'intake' and w.voided_at is null) then 'water' end], null), ' and ')), ', ' order by h.sort)
      into v_farm
      from houses h where h.active and h.birds_at_start > 0 and h.start_date <= t
       and (not exists (select 1 from egg_collections e where e.house_id = h.id and e.d = t and e.voided_at is null)
            or not exists (select 1 from water_logs w where w.house_id = h.id and w.d = t and w.kind = 'intake' and w.voided_at is null));
    if v_farm is not null then
      v_id := _notify_once(format('rem:evening:%s:clerk', t), 'info', 'Farm records still to enter today',
        format('Not recorded yet: %s.', v_farm), array['clerk']::staff_role[], 'FARM', 'reminder');
      if v_id is not null then n := n + 1; end if;
    end if;

  elsif p_slot = 'close' then
    -- owner and farm manager: the day's close, in one notification
    select count(*) filter (where not _closed_on(o.id, t)),
           count(*) filter (where not _closed_on(o.id, t) and exists (select 1 from stock_counts c where c.location_id = o.id and c.d = t and c.kind = 'close' and c.voided_at is null)),
           string_agg(o.short, ', ' order by o.sort) filter (where not _closed_on(o.id, t)
             and not exists (select 1 from stock_counts c where c.location_id = o.id and c.d = t and c.kind = 'close' and c.voided_at is null))
      into v_open, v_closed, v_not
      from locations o where o.kind <> 'van';
    v_sales := (select coalesce(sum(value), 0) from sales where d = t and voided_at is null);
    v_left := (select coalesce(sum(m.n + m.b + m.c + m.j), 0) from v_stock_moves m join locations o on o.id = m.location_id where o.kind = 'van')::int;
    v_txt := concat_ws(' ', format('Sales today %s.', _kes(v_sales)),
                            case when v_not is not null then format('Not closed yet: %s.', v_not) end,
                            case when v_left > 0 then format('%s still on the van.', _eggs(v_left)) end);
    v_id := _notify_once(format('close:%s', t), 'info',
      case when v_open = 0 then 'Today''s close: all outlets closed for the day' else format('Today''s close: %s of %s outlets closed', v_closed, v_open) end,
      v_txt, array['owner','manager']::staff_role[], null, 'day_close');
    if v_id is not null then n := n + 1; end if;
  else
    raise exception 'Unknown reminder slot';
  end if;
  return n;
end $$;
revoke execute on function public._closed_on(text, date), public.reminders(text) from public, anon, authenticated;
grant execute on function public.reminders(text) to service_role;
