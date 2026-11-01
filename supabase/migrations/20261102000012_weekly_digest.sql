-- =====================================================================
-- 2 Nov 2026: the weekly digest.
--
--  * weekly_facts(from, to, role, location): everything the digest says, as
--    numbers, worked out from the farm's own settings and history, scoped to
--    the reader. Ranked insights (at most five), completeness first; no
--    week-on-week figure unless the prior week is a valid comparison.
--  * digest_entries(...): that week's records for the Excel attachment, same scope.
--  * digest_log / nudge_log: one row per person per week (per day for nudges),
--    so a retry never sends twice.
--  * digest_enqueue(): queues one call per recipient to the weekly-digest
--    edge function (pg_net + the trigger secret). Scheduled Monday 06:30 and
--    08:30 Nairobi (03:30 and 05:30 UTC), clear of the Sunday 20:00 UTC backup.
-- Scope: owner everything; manager farm and outlets, money too (the app's
-- Money screen already shows it to managers); clerk the farm; a sales point
-- only its own outlet's sales and stock, never cash.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Send logs
-- ---------------------------------------------------------------------
create table if not exists public.digest_log (
  id bigint generated always as identity primary key,
  staff_id uuid not null references public.staff(id),
  week_start date not null,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','held','skipped')),
  attempts int not null default 0,
  error text, provider_id text, insights int,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), sent_at timestamptz,
  unique (staff_id, week_start)
);
comment on table public.digest_log is 'Weekly digest sends. held = email or AI not configured yet (retried later); skipped = no email or opted out.';
create table if not exists public.nudge_log (
  id bigint generated always as identity primary key,
  staff_id uuid not null references public.staff(id),
  day date not null,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','held','skipped')),
  attempts int not null default 0,
  error text, provider_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), sent_at timestamptz,
  unique (staff_id, day)
);
alter table public.digest_log enable row level security;
alter table public.nudge_log enable row level security;
revoke all on public.digest_log, public.nudge_log from public, anon, authenticated;
grant all on public.digest_log, public.nudge_log to service_role;

-- claim one send: only one worker at a time, never after it was sent
create or replace function public.mail_claim(p_kind text, p_staff uuid, p_period date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if p_kind = 'digest' then
    insert into digest_log (staff_id, week_start) values (p_staff, p_period) on conflict do nothing;
    update digest_log set status = 'sending', attempts = attempts + 1, updated_at = now()
     where staff_id = p_staff and week_start = p_period and attempts < 5
       and (status in ('pending','failed','held') or (status = 'sending' and updated_at < now() - interval '15 minutes'))
    returning to_jsonb(digest_log.*) into r;
  elsif p_kind = 'nudge' then
    insert into nudge_log (staff_id, day) values (p_staff, p_period) on conflict do nothing;
    update nudge_log set status = 'sending', attempts = attempts + 1, updated_at = now()
     where staff_id = p_staff and day = p_period and attempts < 5
       and (status in ('pending','failed','held') or (status = 'sending' and updated_at < now() - interval '15 minutes'))
    returning to_jsonb(nudge_log.*) into r;
  else
    raise exception 'Unknown mail kind';
  end if;
  return r;  -- null: already sent, in progress, or out of attempts
end $$;

create or replace function public.mail_finish(p_kind text, p_id bigint, p_status text, p_error text default null,
                                              p_provider_id text default null, p_insights int default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('sent','failed','held','skipped') then raise exception 'Unknown status'; end if;
  if p_kind = 'digest' then
    update digest_log set status = p_status, error = left(p_error, 500), provider_id = p_provider_id, insights = p_insights,
           updated_at = now(), sent_at = case when p_status = 'sent' then now() end where id = p_id;
  else
    update nudge_log set status = p_status, error = left(p_error, 500), provider_id = p_provider_id,
           updated_at = now(), sent_at = case when p_status = 'sent' then now() end where id = p_id;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Completeness over a period, in one reader's scope
-- ---------------------------------------------------------------------
create or replace function public._completeness_span(p_from date, p_to date, p_farm boolean, p_outlets text[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d date; c jsonb; i jsonb; v_exp int := 0; v_ok int := 0; v_days int := 0; v_untracked int := 0;
        g jsonb := '{}'::jsonb; k text;
begin
  for d in select generate_series(p_from, p_to, interval '1 day')::date loop
    c := completeness(d);
    if not (c->>'tracked')::boolean then v_untracked := v_untracked + 1; continue; end if;
    v_days := v_days + 1;
    for i in select * from jsonb_array_elements(c->'items') loop
      continue when not ((i->>'scope' in ('house','farm') and p_farm) or (i->>'scope' = 'outlet' and i->>'id' = any (p_outlets)));
      v_exp := v_exp + jsonb_array_length(i->'expected');
      v_ok := v_ok + jsonb_array_length(i->'expected') - jsonb_array_length(i->'missing');
      continue when jsonb_array_length(i->'missing') = 0;
      k := i->>'scope' || ':' || (i->>'id');
      g := jsonb_set(g, array[k], coalesce(g->k, jsonb_build_object('where', i->>'name', 'scope', i->>'scope', 'id', i->>'id',
                                                                     'days', '[]'::jsonb, 'missing', '[]'::jsonb, 'count', 0)));
      g := jsonb_set(g, array[k, 'days'], (g->k->'days') || to_jsonb(c->>'label'));
      g := jsonb_set(g, array[k, 'count'], to_jsonb((g->k->>'count')::int + 1));
      g := jsonb_set(g, array[k, 'missing'], (select coalesce(jsonb_agg(x order by array_position(
                                                  array['eggs','water','feed','sales','opening count','closing count'], x)), '[]'::jsonb)
                                                from (select jsonb_array_elements_text(g->k->'missing') x
                                                      union select jsonb_array_elements_text(i->'missing')) q));
    end loop;
  end loop;
  return jsonb_build_object('tracked_days', v_days, 'untracked_days', v_untracked, 'expected', v_exp, 'entered', v_ok,
    'pct', case when v_exp > 0 then round(v_ok * 100.0 / v_exp) end,
    'low', v_exp > 0 and v_ok * 100 < v_exp * 80,
    'gaps', coalesce((select jsonb_agg(x order by (x->>'count')::int desc, x->>'where') from jsonb_each(g) e(k, x)), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- 3. The insight engine
-- ---------------------------------------------------------------------
-- 13500 -> '13,500'; 70.0 -> '70'; 66.70 -> '66.7'
create or replace function public._num(p numeric) returns text language sql immutable as $$
  select case when p is null then null when p = trunc(p) then to_char(p, 'FM999,999,999,990')
              else to_char(trim_scale(round(p, 1)), 'FM999,999,999,990.0') end
$$;
-- who answers for a location: the van driver, the farm counter, or the shop attendant
create or replace function public._who(p_loc text) returns text language sql stable security definer set search_path = public as $$
  select case kind when 'van' then 'Van driver' when 'farm' then 'Farm counter' else name || ' attendant' end from locations where id = p_loc
$$;

create or replace function public.weekly_facts(p_from date, p_to date, p_role public.staff_role, p_loc text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  st settings; tf date; v_farm boolean; v_money boolean; v_outlets text[]; v_prov boolean;
  comp jsonb; prior jsonb; base jsonb; j_prod jsonb := null; j_feed jsonb := null; j_sales jsonb := null; j_dmg jsonb := null;
  j_counts jsonb := '[]'::jsonb; j_transit jsonb := '[]'::jsonb; j_money jsonb := null; ins jsonb := '[]'::jsonb;
  r record; v_txt text; v_n int; v_lab text; v_days int := p_to - p_from + 1;
  v_laid int; v_prior_laid int; v_stock numeric; v_lvl numeric; v_band text; v_used numeric; v_water numeric; v_ratio numeric;
  v_sales numeric; v_prior_sales numeric; v_tol numeric;
begin
  select * into st from settings where id = 1;
  tf := coalesce(st.tracking_from, p_from);
  v_farm := p_role in ('owner','manager','clerk');
  v_money := p_role in ('owner','manager');
  v_outlets := case when p_role in ('owner','manager') then array(select id from locations order by sort)
                    when p_role = 'pos' then array[p_loc] else '{}'::text[] end;
  v_tol := st.break_tol;

  -- completeness, and whether last week is a fair comparison
  comp := _completeness_span(p_from, p_to, v_farm, v_outlets);
  v_prov := coalesce((comp->>'low')::boolean, false);
  if p_from - 7 < tf then
    base := jsonb_build_object('comparable', false, 'reason', 'first_week');
  else
    prior := _completeness_span(p_from - 7, p_to - 7, v_farm, v_outlets);
    base := jsonb_build_object('comparable', not coalesce((prior->>'low')::boolean, true) and (prior->>'expected')::int > 0,
                               'reason', case when coalesce((prior->>'low')::boolean, true) then 'prior_incomplete' else 'ok' end,
                               'prior_pct', prior->'pct');
  end if;
  base := base || jsonb_build_object('prior_from', p_from - 7, 'prior_to', p_to - 7);

  -- production, by house, on entered days only
  if v_farm then
    with f as (select * from farm_daily2(p_from, p_to)),
    hh as (
      select h.id, h.name, h.expected_lay, h.sort,
             coalesce(sum(f.n + f.b + f.c + f.j + f.dmg), 0)::int laid,
             coalesce(sum(f.hens) filter (where f.n + f.b + f.c + f.j + f.dmg > 0), 0)::int hen_days,
             count(*) filter (where f.n + f.b + f.c + f.j + f.dmg > 0)::int entered_days,
             coalesce(sum(f.deaths), 0)::int deaths,
             coalesce(max(f.hens - f.deaths) filter (where f.d = p_to), max(f.hens))::int hens
        from houses h left join f on f.house_id = h.id
       where h.active and h.birds_at_start > 0 group by h.id, h.name, h.expected_lay, h.sort)
    select jsonb_build_object(
      'laid', coalesce(sum(f2.n + f2.b + f2.c + f2.j + f2.dmg), 0), 'trays', round(coalesce(sum(f2.n + f2.b + f2.c + f2.j + f2.dmg), 0) / 30.0),
      'normal', coalesce(sum(f2.n), 0), 'big', coalesce(sum(f2.b), 0), 'jumbo', coalesce(sum(f2.j), 0),
      'cracked', coalesce(sum(f2.c), 0), 'damaged', coalesce(sum(f2.dmg), 0),
      'houses', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'laid', laid, 'entered_days', entered_days,
                   'lay_pct', case when hen_days > 0 then round(laid * 100.0 / hen_days, 1) end,
                   'expected_pct', round(expected_lay * 100, 1), 'deaths', deaths, 'hens', hens) order by sort), '[]'::jsonb) from hh),
      'provisional', v_prov)
      into j_prod from f f2;
    v_laid := (j_prod->>'laid')::int;
    if (base->>'comparable')::boolean then
      select coalesce(sum(n + b + c + j + dmg), 0) into v_prior_laid from farm_daily2(p_from - 7, p_to - 7);
      j_prod := j_prod || jsonb_build_object('prior_laid', v_prior_laid, 'prior_trays', round(v_prior_laid / 30.0),
        'change_pct', case when v_prior_laid > 0 then round((v_laid - v_prior_laid) * 100.0 / v_prior_laid, 1) end);
    end if;
    -- deaths not confirmed (no record and no "no deaths" mark) on tracked days
    j_prod := j_prod || jsonb_build_object('deaths_unconfirmed', (
      select count(*) from houses h cross join generate_series(greatest(p_from, tf), p_to, interval '1 day') g(day)
       where h.active and h.birds_at_start > 0 and h.start_date <= g.day::date
         and not exists (select 1 from mortality m where m.house_id = h.id and m.d = g.day::date and m.voided_at is null)
         and not exists (select 1 from day_marks k where k.house_id = h.id and k.d = g.day::date and k.kind = 'no_deaths' and k.voided_at is null)));

    -- feed and water
    select coalesce(sum(kg), 0) into v_used from feed_moves where kind = 'use' and voided_at is null and d between p_from and p_to;
    select coalesce(sum(litres), 0) into v_water from water_logs where kind = 'intake' and voided_at is null and d between p_from and p_to;
    select sum(w.l) / nullif(sum(fd.kg), 0) into v_ratio
      from (select d, sum(kg) kg from feed_moves where kind = 'use' and voided_at is null and d between p_from and p_to group by d) fd
      join (select d, sum(litres) l from water_logs where kind = 'intake' and voided_at is null and d between p_from and p_to group by d) w using (d);
    v_stock := _feed_stock();
    v_lvl := v_stock / nullif(st.feed_buffer_kg, 0);
    v_band := buffer_band(v_lvl);
    j_feed := jsonb_build_object('used_kg', round(v_used), 'used_bags', round(v_used / st.bag_kg, 1), 'water_l', round(v_water),
      'ratio', round(v_ratio, 2), 'ratio_min', st.water_ratio_min, 'ratio_max', st.water_ratio_max,
      'stock_bags', round(v_stock / st.bag_kg), 'buffer_bags', round(st.feed_buffer_bags), 'level_pct', round(v_lvl * 100),
      'band', band_label(v_band), 'order_bags', ceil(greatest(st.feed_buffer_kg - v_stock, 0) / st.bag_kg));
  end if;

  -- sales per outlet, against the outlet's own last four weeks
  if cardinality(v_outlets) > 0 then
    with s as (select location_id, d, sum(value) v, sum(n + b + c + j) e from sales
                where voided_at is null and location_id = any (v_outlets) and d between p_from - 28 and p_to group by 1, 2),
    o as (
      select l.id, l.name, l.sort,
             coalesce(sum(s.v) filter (where s.d between p_from and p_to), 0) value,
             coalesce(sum(s.e) filter (where s.d between p_from and p_to), 0)::int eggs,
             count(*) filter (where s.d between p_from and p_to)::int trading_days,
             coalesce(sum(s.v) filter (where s.d between p_from - 28 and p_from - 1), 0) hist_value,
             count(*) filter (where s.d between p_from - 28 and p_from - 1)::int hist_days,
             coalesce(sum(s.v) filter (where s.d between p_from - 7 and p_to - 7), 0) prior_value
        from locations l left join s on s.location_id = l.id
       where l.id = any (v_outlets) group by l.id, l.name, l.sort)
    select jsonb_build_object(
      'total_value', round(coalesce(sum(value), 0)), 'total_eggs', coalesce(sum(eggs), 0), 'total_trays', round(coalesce(sum(eggs), 0) / 30.0),
      'prior_value', case when (base->>'comparable')::boolean then round(coalesce(sum(prior_value), 0)) end,
      'outlets', coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'value', round(value), 'eggs', eggs, 'trays', round(eggs / 30.0),
          'trading_days', trading_days,
          'per_day', case when trading_days > 0 then round(value / trading_days) end,
          'pattern_per_day', case when hist_days >= 6 then round(hist_value / hist_days) end, 'pattern_days', hist_days,
          'change_pct', case when hist_days >= 6 and trading_days >= 2 and hist_value > 0
                             then round(((value / trading_days) - (hist_value / hist_days)) * 100.0 / (hist_value / hist_days), 1) end)
          order by sort), '[]'::jsonb),
      'provisional', v_prov)
      into j_sales from o;
    v_sales := (j_sales->>'total_value')::numeric;
    if (base->>'comparable')::boolean and (j_sales->>'prior_value')::numeric > 0 then
      j_sales := j_sales || jsonb_build_object('change_pct', round((v_sales - (j_sales->>'prior_value')::numeric) * 100.0 / (j_sales->>'prior_value')::numeric, 1));
    end if;
  end if;

  -- damaged eggs by stage: at collection, in transit, at the outlets
  j_dmg := jsonb_build_object('tol_pct', v_tol,
    'collection', case when v_farm then jsonb_build_object('eggs', coalesce((j_prod->>'damaged')::int, 0),
      'pct', case when v_laid > 0 then round((j_prod->>'damaged')::int * 100.0 / v_laid, 1) end) end,
    'transit', (select jsonb_build_object('eggs', coalesce(sum(b.qty), 0)::int,
                 'sent', coalesce((select sum(t.sent_n + t.sent_b + t.sent_c + t.sent_j) from transfers t where t.voided_at is null
                                    and t.received_d between p_from and p_to and (v_farm and t.from_loc = 'FARM' or t.to_loc = any (v_outlets))), 0)::int)
                from breakages b join transfers t on t.id = b.transfer_id
               where b.voided_at is null and b.transit and b.d between p_from and p_to and (v_farm and t.from_loc = 'FARM' or t.to_loc = any (v_outlets))),
    'outlets', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'eggs', x.q, 'received', x.recv,
                  'pct', case when x.recv > 0 then round(x.q * 100.0 / x.recv, 1) end) order by l.sort), '[]'::jsonb)
                from locations l cross join lateral (select
                  coalesce((select sum(qty) from breakages b where b.location_id = l.id and not b.transit and b.voided_at is null and b.d between p_from and p_to), 0)::int q,
                  coalesce((select sum(recv_n + coalesce(recv_b, 0) + recv_c + recv_j) from transfers t where t.to_loc = l.id and t.status = 'received'
                              and t.voided_at is null and t.received_d between p_from and p_to), 0)
                  + coalesce((select sum(n + b + c + j) from stock_adj a where a.location_id = l.id and a.kind = 'in' and a.voided_at is null
                              and a.d between p_from and p_to), 0)::int recv) x
               where l.id = any (v_outlets) and x.q > 0));
  if j_dmg->'transit' is not null and (j_dmg->'transit'->>'sent')::int > 0 then
    j_dmg := jsonb_set(j_dmg, '{transit,pct}', to_jsonb(round((j_dmg->'transit'->>'eggs')::int * 100.0 / (j_dmg->'transit'->>'sent')::int, 1)));
  end if;

  -- stock count variances
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'counts', x.cnt, 'variance_eggs', x.net, 'abs_eggs', x.abs_,
           'abs_trays', round(x.abs_ / 30.0, 1)) order by l.sort), '[]'::jsonb) into j_counts
    from locations l cross join lateral (
      select count(*)::int cnt, coalesce(sum(adj_n + coalesce(adj_b, 0) + adj_c + adj_j), 0)::int net,
             coalesce(sum(abs(adj_n + coalesce(adj_b, 0) + adj_c + adj_j)), 0)::int abs_
        from stock_counts k where k.location_id = l.id and k.kind in ('open','close') and k.voided_at is null
         and k.recorded_by is not null and k.d between p_from and p_to) x
   where (l.id = any (v_outlets) or (v_farm and l.id = 'FARM')) and x.cnt > 0;

  -- deliveries still not confirmed at the end of the week
  select coalesce(jsonb_agg(jsonb_build_object('to', x.to_loc, 'name', x.name, 'count', x.cnt, 'eggs', x.eggs,
           'oldest', to_char(x.oldest, 'Dy DD Mon'))), '[]'::jsonb) into j_transit
    from (select t.to_loc, l.name, count(*)::int cnt, sum(t.sent_n + t.sent_b + t.sent_c + t.sent_j)::int eggs, min(t.d) oldest
            from transfers t join locations l on l.id = t.to_loc
           where t.status = 'in_transit' and t.voided_at is null and t.d < p_to
             and (t.to_loc = any (v_outlets) or (v_farm and t.from_loc = 'FARM'))
           group by t.to_loc, l.name) x;

  -- money: cash counts and unbanked cash (owner and manager only)
  if v_money then
    j_money := jsonb_build_object('cash_tol', st.cash_tol, 'unbanked_max', st.unbanked_max,
      'cash_counts', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'counts', x.cnt, 'total_diff', x.tot, 'max_abs', x.mx)), '[]'::jsonb)
                        from locations l cross join lateral (select count(*)::int cnt, round(coalesce(sum(diff), 0)) tot, round(coalesce(max(abs(diff)), 0)) mx
                                                               from cash_counts c where c.location_id = l.id and c.voided_at is null and c.d between p_from and p_to) x
                       where x.cnt > 0),
      'unbanked', case when st.go_live is not null then (
                    select coalesce(jsonb_agg(jsonb_build_object('id', a.location_id, 'name', l.name, 'balance', round(_balance(a.id)))), '[]'::jsonb)
                      from accounts a join locations l on l.id = a.location_id
                     where a.kind = 'cash' and _balance(a.id) > st.unbanked_max) else '[]'::jsonb end);
  end if;

  -- ------------------------------------------------------------------
  -- Insights, ranked: completeness, comparability, then anomalies.
  -- Each one names a place and a role and ends with an action.
  -- ------------------------------------------------------------------
  -- 1. completeness
  if (comp->>'expected')::int > 0 and jsonb_array_length(comp->'gaps') > 0 then
    select string_agg(format('%s on %s (%s)', g->>'where',
             case when jsonb_array_length(g->'days') <= 3 then (select string_agg(x, ', ') from jsonb_array_elements_text(g->'days') x)
                  else format('%s days', jsonb_array_length(g->'days')) end,
             (select string_agg(x, ', ') from jsonb_array_elements_text(g->'missing') x)), '; ')
      into v_txt from (select g from jsonb_array_elements(comp->'gaps') g limit 4) q;
    ins := ins || jsonb_build_object('kind', 'completeness', 'severity', case when v_prov then 'red' else 'amber' end, 'rank', 1,
      'where', (select string_agg(g->>'where', ', ') from (select g from jsonb_array_elements(comp->'gaps') g limit 4) q),
      'role', case when p_role = 'pos' then 'you' when p_role = 'clerk' then 'Production clerk' else 'Each outlet attendant and the production clerk' end,
      'numbers', jsonb_build_object('entered', comp->'entered', 'expected', comp->'expected', 'pct', comp->'pct', 'places', jsonb_array_length(comp->'gaps')),
      'action', 'Enter the previous day''s figures by 9am every day.',
      'text', format('%s%s of %s daily records were entered this week (%s%%). Missing: %s.%s Please enter the previous day''s figures by 9am every day.',
                     case when v_prov then 'Only ' else '' end, comp->>'entered', comp->>'expected', comp->>'pct', v_txt,
                     case when v_prov then ' Every figure in this email is provisional.' else '' end));
  elsif (comp->>'tracked_days')::int = 0 then
    ins := ins || jsonb_build_object('kind', 'completeness', 'severity', 'amber', 'rank', 1, 'where', 'all places', 'role', 'Owner',
      'numbers', jsonb_build_object('tracked_days', 0),
      'action', 'Start entering daily figures so next week has a full record.',
      'text', 'No days in this week fall inside the tracking period, so there is nothing to compare yet. Start entering daily figures so next week has a full record.');
  end if;

  -- 2. comparability
  if not (base->>'comparable')::boolean then
    ins := ins || jsonb_build_object('kind', 'baseline', 'severity', 'info', 'rank', 2, 'where', 'this week', 'role', 'everyone',
      'numbers', jsonb_build_object(),
      'action', 'Keep entering every day so next week can be compared with this one.',
      'text', case base->>'reason'
        when 'first_week' then 'There is no full prior week yet, so treat this week as the baseline. Keep entering every day so next week can be compared with this one.'
        else 'Last week had too many missing days to compare against, so treat this week as the baseline. Keep entering every day so next week can be compared with this one.' end);
  end if;

  -- 3. anomalies against the farm's own settings and history
  if v_farm then
    for r in select h from jsonb_array_elements(j_prod->'houses') h
              where (h->>'lay_pct') is not null and (h->>'expected_pct')::numeric - (h->>'lay_pct')::numeric > st.lay_drop_pts loop
      ins := ins || jsonb_build_object('kind', 'lay_rate', 'severity', 'orange', 'rank', 3, 'where', r.h->>'name', 'role', 'Farm manager',
        'numbers', jsonb_build_object('lay_pct', r.h->'lay_pct', 'expected_pct', r.h->'expected_pct', 'entered_days', r.h->'entered_days', 'laid', r.h->'laid'),
        'action', format('Farm manager: check water, feed and signs of disease in %s this week.', r.h->>'name'),
        'text', format('%s laid at %s%% against %s%% expected over %s entered days%s. Farm manager: check water, feed and signs of disease in %s this week.',
                       r.h->>'name', _num((r.h->>'lay_pct')::numeric), _num((r.h->>'expected_pct')::numeric), r.h->>'entered_days', case when v_prov then ' (provisional)' else '' end, r.h->>'name'));
    end loop;
    if (j_dmg->'collection'->>'pct')::numeric > v_tol then
      ins := ins || jsonb_build_object('kind', 'damaged_collection', 'severity', 'amber', 'rank', 4, 'where', 'Central Farm', 'role', 'Production clerk',
        'numbers', jsonb_build_object('eggs', j_dmg->'collection'->'eggs', 'pct', j_dmg->'collection'->'pct', 'tol_pct', v_tol),
        'action', 'Production clerk: check how eggs are collected and stacked in both houses.',
        'text', format('%s eggs were damaged at collection, %s%% of eggs laid, above the %s%% limit. Production clerk: check how eggs are collected and stacked in both houses.',
                       _num((j_dmg->'collection'->>'eggs')::numeric), _num((j_dmg->'collection'->>'pct')::numeric), _num(v_tol)));
    end if;
    if j_feed->>'ratio' is not null and ((j_feed->>'ratio')::numeric < st.water_ratio_min or (j_feed->>'ratio')::numeric > st.water_ratio_max) then
      ins := ins || jsonb_build_object('kind', 'water_feed', 'severity', 'amber', 'rank', 4, 'where', 'Central Farm', 'role', 'Production clerk',
        'numbers', jsonb_build_object('ratio', j_feed->'ratio', 'min', st.water_ratio_min, 'max', st.water_ratio_max),
        'action', 'Production clerk: check the drinkers and water lines, and that water and feed are both entered every day.',
        'text', format('Water to feed was %s litres per kg this week, outside the normal %s to %s. Production clerk: check the drinkers and water lines, and that water and feed are both entered every day.',
                       j_feed->>'ratio', st.water_ratio_min, st.water_ratio_max));
    end if;
    if band_rank(v_band) >= 3 then
      ins := ins || jsonb_build_object('kind', 'feed_buffer', 'severity', band_sev(v_band), 'rank', case when band_rank(v_band) >= 4 then 2 else 4 end,
        'where', 'Central Farm', 'role', 'Farm manager',
        'numbers', jsonb_build_object('stock_bags', j_feed->'stock_bags', 'buffer_bags', j_feed->'buffer_bags', 'level_pct', j_feed->'level_pct', 'order_bags', j_feed->'order_bags'),
        'action', format('Farm manager: order %s bags.', j_feed->>'order_bags'),
        'text', format('The feed store has %s bags, %s%% of the %s-bag weekly buffer. Farm manager: order %s bags.',
                       _num((j_feed->>'stock_bags')::numeric), j_feed->>'level_pct', _num((j_feed->>'buffer_bags')::numeric), _num((j_feed->>'order_bags')::numeric)));
    end if;
  end if;
  if (j_dmg->'transit'->>'pct')::numeric > v_tol then
    ins := ins || jsonb_build_object('kind', 'damaged_transit', 'severity', 'amber', 'rank', 4, 'where', 'deliveries', 'role', 'Farm manager',
      'numbers', jsonb_build_object('eggs', j_dmg->'transit'->'eggs', 'pct', j_dmg->'transit'->'pct', 'sent', j_dmg->'transit'->'sent', 'tol_pct', v_tol),
      'action', 'Farm manager: check packing and the van run for the deliveries that arrived short.',
      'text', format('%s eggs were damaged or missing on arrival, %s%% of %s sent, above the %s%% limit. Farm manager: check packing and the van run for the deliveries that arrived short.',
                     _num((j_dmg->'transit'->>'eggs')::numeric), _num((j_dmg->'transit'->>'pct')::numeric), _num((j_dmg->'transit'->>'sent')::numeric), _num(v_tol)));
  end if;
  for r in select o from jsonb_array_elements(j_dmg->'outlets') o where (o->>'pct')::numeric > v_tol loop
    ins := ins || jsonb_build_object('kind', 'damaged_outlet', 'severity', 'amber', 'rank', 4, 'where', r.o->>'name', 'role', _who(r.o->>'id'),
      'numbers', jsonb_build_object('eggs', r.o->'eggs', 'pct', r.o->'pct', 'received', r.o->'received', 'tol_pct', v_tol),
      'action', format('%s: check how trays are stored and handled.', _who(r.o->>'id')),
      'text', format('%s wrote off %s damaged eggs, %s%% of the %s it received, above the %s%% limit. %s: check how trays are stored and handled.',
                     r.o->>'name', _num((r.o->>'eggs')::numeric), _num((r.o->>'pct')::numeric), _num((r.o->>'received')::numeric), _num(v_tol), _who(r.o->>'id')));
  end loop;
  for r in select t from jsonb_array_elements(j_transit) t loop
    ins := ins || jsonb_build_object('kind', 'transit', 'severity', 'amber', 'rank', 3, 'where', r.t->>'name', 'role', _who(r.t->>'to'),
      'numbers', jsonb_build_object('count', r.t->'count', 'eggs', r.t->'eggs', 'oldest', r.t->'oldest'),
      'action', format('%s: count the delivery and confirm it in the app today.', _who(r.t->>'to')),
      'text', case when (r.t->>'count')::int = 1
        then format('The delivery of %s eggs to %s sent %s is still not confirmed. %s: count it and confirm it in the app today.',
                    _num((r.t->>'eggs')::numeric), r.t->>'name', r.t->>'oldest', _who(r.t->>'to'))
        else format('%s deliveries to %s are still not confirmed, the oldest sent %s. %s: count them and confirm them in the app today.',
                    r.t->>'count', r.t->>'name', r.t->>'oldest', _who(r.t->>'to')) end);
  end loop;
  for r in select o from jsonb_array_elements(j_sales->'outlets') o where (o->>'change_pct')::numeric <= -20 loop
    ins := ins || jsonb_build_object('kind', 'sales_pattern', 'severity', 'amber', 'rank', 4, 'where', r.o->>'name', 'role', 'Owner',
      'numbers', jsonb_build_object('per_day', r.o->'per_day', 'pattern_per_day', r.o->'pattern_per_day', 'change_pct', r.o->'change_pct',
                                    'drop_pct', abs((r.o->>'change_pct')::numeric), 'trading_days', r.o->'trading_days', 'pattern_days', r.o->'pattern_days'),
      'action', format('Owner: ask the %s what changed this week.', lower(_who(r.o->>'id'))),
      'text', format('%s sold KES %s a trading day over %s days, %s%% below its usual KES %s over the previous %s trading days%s. Owner: ask the %s what changed this week.',
                     r.o->>'name', _num((r.o->>'per_day')::numeric), r.o->>'trading_days', _num(abs((r.o->>'change_pct')::numeric)),
                     _num((r.o->>'pattern_per_day')::numeric), r.o->>'pattern_days',
                     case when v_prov then ' (provisional)' else '' end, case when _who(r.o->>'id') like '% attendant' then _who(r.o->>'id') else lower(_who(r.o->>'id')) end));
  end loop;
  for r in select c from jsonb_array_elements(j_counts) c where (c->>'abs_eggs')::int >= 30 loop
    ins := ins || jsonb_build_object('kind', 'count_variance', 'severity', 'amber', 'rank', 4, 'where', r.c->>'name', 'role', _who(r.c->>'id'),
      'numbers', jsonb_build_object('abs_eggs', r.c->'abs_eggs', 'abs_trays', r.c->'abs_trays', 'counts', r.c->'counts'),
      'action', format('%s: record damaged eggs, issues and sales as they happen so the count matches the book.', _who(r.c->>'id')),
      'text', format('Stock counts at %s were %s eggs (%s trays) off the book across %s %s. %s: record damaged eggs, issues and sales as they happen so the count matches the book.',
                     r.c->>'name', _num((r.c->>'abs_eggs')::numeric), _num((r.c->>'abs_trays')::numeric), r.c->>'counts',
                     case when (r.c->>'counts')::int = 1 then 'count' else 'counts' end, _who(r.c->>'id')));
  end loop;
  if v_money then
    for r in select c from jsonb_array_elements(j_money->'cash_counts') c where abs((c->>'total_diff')::numeric) >= st.cash_tol loop
      ins := ins || jsonb_build_object('kind', 'cash_variance', 'severity', 'orange', 'rank', 3, 'where', r.c->>'name', 'role', 'Owner',
        'numbers', jsonb_build_object('total_diff', r.c->'total_diff', 'counts', r.c->'counts', 'cash_tol', st.cash_tol),
        'action', format('Owner: go through the cash counts at %s with the attendant.', r.c->>'name'),
        'text', format('Cash counts at %s were KES %s %s across %s %s, beyond the KES %s tolerance. Owner: go through the cash counts at %s with the %s.',
                       r.c->>'name', _num(abs((r.c->>'total_diff')::numeric)), case when (r.c->>'total_diff')::numeric < 0 then 'short' else 'over' end,
                       r.c->>'counts', case when (r.c->>'counts')::int = 1 then 'count' else 'counts' end, _num(st.cash_tol), r.c->>'name',
                       lower(regexp_replace(_who(r.c->>'id'), '^.* attendant$', 'attendant'))));
    end loop;
    for r in select u from jsonb_array_elements(j_money->'unbanked') u loop
      ins := ins || jsonb_build_object('kind', 'unbanked', 'severity', 'amber', 'rank', 4, 'where', r.u->>'name', 'role', _who(r.u->>'id'),
        'numbers', jsonb_build_object('balance', r.u->'balance', 'unbanked_max', st.unbanked_max),
        'action', format('%s: bank the cash or move it to Paybill.', _who(r.u->>'id')),
        'text', format('KES %s cash is held at %s, above the KES %s limit. %s: bank the cash or move it to Paybill.',
                       _num((r.u->>'balance')::numeric), r.u->>'name', _num(st.unbanked_max), _who(r.u->>'id')));
    end loop;
  end if;

  -- rank: completeness, baseline, then by severity; at most five
  select coalesce(jsonb_agg(x order by (x->>'rank')::int,
           case x->>'severity' when 'red' then 0 when 'orange' then 1 when 'amber' then 2 else 3 end, x->>'where'), '[]'::jsonb)
    into ins from (select x from jsonb_array_elements(ins) x
                    order by (x->>'rank')::int, case x->>'severity' when 'red' then 0 when 'orange' then 1 when 'amber' then 2 else 3 end, x->>'where'
                    limit 5) q;

  return jsonb_strip_nulls(jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days,
                                 'label', format('%s to %s', to_char(p_from, 'Dy DD Mon'), to_char(p_to, 'Dy DD Mon'))),
    'scope', jsonb_build_object('role', p_role, 'location_id', p_loc, 'location', (select name from locations where id = p_loc),
                                'farm', v_farm, 'money', v_money,
                                'outlets', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort), '[]'::jsonb)
                                              from locations where id = any (v_outlets))),
    'completeness', comp, 'baseline', base, 'provisional', v_prov,
    'production', j_prod, 'feed', j_feed, 'sales', j_sales, 'damage', j_dmg, 'counts', j_counts, 'transit', j_transit, 'money', j_money,
    'thresholds', jsonb_build_object('lay_drop_pts', st.lay_drop_pts, 'break_tol', st.break_tol, 'cash_tol', st.cash_tol, 'unbanked_max', st.unbanked_max),
    'insights', ins));
end $$;

-- ---------------------------------------------------------------------
-- 4. The week's records for the Excel attachment, same scope rules
-- ---------------------------------------------------------------------
create or replace function public.digest_entries(p_from date, p_to date, p_role public.staff_role, p_loc text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_farm boolean := p_role in ('owner','manager','clerk'); v_money boolean := p_role in ('owner','manager');
        v_out text[]; sheets jsonb := '[]'::jsonb;
begin
  v_out := case when p_role in ('owner','manager') then array(select id from locations) when p_role = 'pos' then array[p_loc] else '{}'::text[] end;
  if v_farm then
    sheets := sheets || jsonb_build_object('name', 'Eggs collected', 'columns', jsonb_build_array('Date','House','Normal','Big','Jumbo','Cracked','Damaged','Entered by'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(e.d, h.name, e.n, e.b, e.j, e.c, e.dmg, s.display_name) order by e.d, h.sort, e.id), '[]'::jsonb)
                 from egg_collections e join houses h on h.id = e.house_id left join staff s on s.id = e.recorded_by
                where e.voided_at is null and e.d between p_from and p_to));
    sheets := sheets || jsonb_build_object('name', 'Deaths', 'columns', jsonb_build_array('Date','House','Birds','Cause'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(m.d, h.name, m.birds, m.cause) order by m.d, h.sort), '[]'::jsonb)
                 from mortality m join houses h on h.id = m.house_id where m.voided_at is null and m.d between p_from and p_to));
    sheets := sheets || jsonb_build_object('name', 'Feed', 'columns', jsonb_build_array('Date','Movement','Kg','Bags','House','Note'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(f.d, f.kind, f.kg, f.bags, f.house, f.note) order by f.d, f.id), '[]'::jsonb)
                 from feed_moves f where f.voided_at is null and f.d between p_from and p_to));
    sheets := sheets || jsonb_build_object('name', 'Water', 'columns', jsonb_build_array('Date','Record','House','Litres'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(w.d, case w.kind when 'tank' then 'Tank reading' else 'Drunk' end, h.name, w.litres) order by w.d, w.id), '[]'::jsonb)
                 from water_logs w left join houses h on h.id = w.house_id where w.voided_at is null and w.d between p_from and p_to));
  end if;
  sheets := sheets || jsonb_build_object('name', 'Deliveries', 'columns',
      jsonb_build_array('Date sent','From','To','Sent normal','Sent big','Sent jumbo','Sent cracked','Status','Date received','Received normal','Received big','Received jumbo','Received cracked','Damaged on arrival'),
    'rows', (select coalesce(jsonb_agg(jsonb_build_array(t.d, lf.name, lt.name, t.sent_n, t.sent_b, t.sent_j, t.sent_c,
                     case t.status when 'received' then 'Received' else 'On the way' end, t.received_d, t.recv_n, t.recv_b, t.recv_j, t.recv_c, t.recv_dmg)
                     order by t.d, t.id), '[]'::jsonb)
               from transfers t join locations lf on lf.id = t.from_loc join locations lt on lt.id = t.to_loc
              where t.voided_at is null and (t.d between p_from and p_to or t.received_d between p_from and p_to)
                and (t.to_loc = any (v_out) or t.from_loc = any (v_out) or (v_farm and t.from_loc = 'FARM'))));
  if cardinality(v_out) > 0 then
    sheets := sheets || jsonb_build_object('name', 'Sales',
      'columns', case when v_money then jsonb_build_array('Date','Outlet','Normal','Big','Jumbo','Cracked','Value (KES)','List value (KES)','Cash','M-Pesa Till','M-Pesa Paybill','Customer','Paper book')
                 else jsonb_build_array('Date','Outlet','Normal','Big','Jumbo','Cracked','Value (KES)','Customer') end,
      'rows', (select coalesce(jsonb_agg(case when v_money
                  then jsonb_build_array(s.d, l.name, s.n, s.b, s.j, s.c, s.value, s.list_value, s.cash, s.till, s.paybill, s.customer, case when s.imported then 'yes' end)
                  else jsonb_build_array(s.d, l.name, s.n, s.b, s.j, s.c, s.value, s.customer) end order by s.d, l.sort, s.id), '[]'::jsonb)
                 from sales s join locations l on l.id = s.location_id
                where s.voided_at is null and s.location_id = any (v_out) and s.d between p_from and p_to));
    sheets := sheets || jsonb_build_object('name', 'Issued and taken in', 'columns', jsonb_build_array('Date','Outlet','Direction','Normal','Big','Jumbo','Cracked','To or from','Note'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(a.d, l.name, case a.kind when 'out' then 'Issued out' else 'Taken in' end, a.n, a.b, a.j, a.c, a.party, a.note) order by a.d, a.id), '[]'::jsonb)
                 from stock_adj a join locations l on l.id = a.location_id where a.voided_at is null and a.location_id = any (v_out) and a.d between p_from and p_to));
  end if;
  sheets := sheets || jsonb_build_object('name', 'Damaged', 'columns', jsonb_build_array('Date','Where','Grade','Eggs','Reason','On arrival'),
    'rows', (select coalesce(jsonb_agg(jsonb_build_array(b.d, l.name, case b.item when 'N' then 'Normal' when 'B' then 'Big' when 'J' then 'Jumbo' else 'Cracked' end,
                     b.qty, b.reason, case when b.transit then 'yes' end) order by b.d, b.id), '[]'::jsonb)
               from breakages b join locations l on l.id = b.location_id
              where b.voided_at is null and b.d between p_from and p_to and (b.location_id = any (v_out) or (v_farm and b.location_id = 'FARM'))));
  sheets := sheets || jsonb_build_object('name', 'Stock counts', 'columns', jsonb_build_array('Date','Where','Count','Normal','Big','Jumbo','Cracked','Off the book (eggs)'),
    'rows', (select coalesce(jsonb_agg(jsonb_build_array(k.d, l.name, case k.kind when 'open' then 'Opening' when 'close' then 'Closing' else 'Opening balance' end,
                     k.cnt_n, k.cnt_b, k.cnt_j, k.cnt_c, k.adj_n + coalesce(k.adj_b, 0) + k.adj_c + k.adj_j) order by k.d, l.sort, k.id), '[]'::jsonb)
               from stock_counts k join locations l on l.id = k.location_id
              where k.voided_at is null and k.d between p_from and p_to and (k.location_id = any (v_out) or (v_farm and k.location_id = 'FARM'))));
  if v_money then
    sheets := sheets || jsonb_build_object('name', 'Money', 'columns', jsonb_build_array('Date','Kind','From','To','Amount (KES)','Charges','Category','Note','Reference'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(m.d, m.kind, af.name, at.name, m.amount, m.fee, m.category, m.note, m.ref) order by m.d, m.id), '[]'::jsonb)
                 from money_moves m left join accounts af on af.id = m.from_acc left join accounts at on at.id = m.to_acc
                where m.voided_at is null and m.d between p_from and p_to));
    sheets := sheets || jsonb_build_object('name', 'Cash counts', 'columns', jsonb_build_array('Date','Where','Counted','Expected','Difference'),
      'rows', (select coalesce(jsonb_agg(jsonb_build_array(c.d, l.name, c.counted, c.expected, c.diff) order by c.d, c.id), '[]'::jsonb)
                 from cash_counts c join locations l on l.id = c.location_id where c.voided_at is null and c.d between p_from and p_to));
  end if;
  return jsonb_build_object('sheets', sheets);
end $$;

-- ---------------------------------------------------------------------
-- 5. Who gets what, and the weekly queue
-- ---------------------------------------------------------------------
-- people who can get emails: active, an address, emails on
create or replace function public.mail_recipients()
returns table (staff_id uuid, display_name text, role public.staff_role, location_id text, email text)
language sql stable security definer set search_path = public as $$
  select id, display_name, role, location_id, email from staff where active and email is not null and digest_enabled
$$;

-- last week (Monday to Sunday) unless a Monday is given; one call per recipient
create or replace function public.digest_enqueue(p_week date default null)
returns int language plpgsql security definer set search_path = public as $$
declare v_week date := coalesce(p_week, date_trunc('week', biz_today())::date - 7); r record; n int := 0;
begin
  if extract(isodow from v_week) <> 1 then raise exception 'The week must start on a Monday'; end if;
  insert into digest_log (staff_id, week_start) select staff_id, v_week from mail_recipients() on conflict do nothing;
  for r in select l.staff_id from digest_log l join staff s on s.id = l.staff_id
            where l.week_start = v_week and s.active and l.attempts < 5
              and (l.status in ('pending','failed','held') or (l.status = 'sending' and l.updated_at < now() - interval '15 minutes')) loop
    if _digest_post(jsonb_build_object('mode', 'weekly', 'staff', r.staff_id, 'week', v_week)) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('dpv-weekly-digest', '30 3 * * 1', 'select public.digest_enqueue()');
    perform cron.schedule('dpv-weekly-digest-retry', '30 5 * * 1', 'select public.digest_enqueue()');
  end if;
exception when others then
  raise notice 'weekly digest not scheduled: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 6. Privileges: all of this is for the edge function (service role) only
-- ---------------------------------------------------------------------
revoke execute on function
  public.mail_claim(text, uuid, date), public.mail_finish(text, bigint, text, text, text, int),
  public._completeness_span(date, date, boolean, text[]), public.weekly_facts(date, date, public.staff_role, text),
  public.digest_entries(date, date, public.staff_role, text), public.mail_recipients(), public.digest_enqueue(date),
  public._num(numeric), public._who(text)
from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
