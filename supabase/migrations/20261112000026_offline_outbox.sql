-- 12 Nov 2026: entries made with no connection.
-- The app keeps an entry on the phone when the connection drops and sends it
-- when it is back. Each entry carries a key made on the phone, so sending it
-- twice (a retry after a timeout, two tabs, a slow network) records it once.
--   * client_ops: one row per key, with who sent it, which action, when it was
--     made on the phone and what the action returned.
--   * rpc_queued(key, fn, args, made_at): runs one of the everyday entry actions
--     with its usual checks (each action still calls _require for the person's
--     role), or returns the stored answer when the key was already recorded.
-- New only: no existing function or data changes.

create table if not exists public.client_ops (
  key uuid primary key,
  staff_id uuid not null references public.staff(id),
  fn text not null,
  made_at timestamptz,                         -- when it was entered on the phone
  received_at timestamptz not null default now(),
  result jsonb
);
create index if not exists client_ops_staff on public.client_ops (staff_id, received_at desc);
alter table public.client_ops enable row level security;
revoke all on public.client_ops from public, anon, authenticated;
grant all on public.client_ops to service_role;

-- the everyday entries that may wait on a phone (field staff only: no setup, no money moves by management)
create or replace function public._queueable() returns text[]
language sql immutable as $$
  select array['rpc_collect_eggs','rpc_house_day','rpc_mark_day','rpc_water','rpc_mortality','rpc_confirm_issue',
               'rpc_dispatch_many','rpc_receive_delivery','rpc_issue_out','rpc_breakage','rpc_sale_with_credit',
               'rpc_credit_paid','rpc_shop_day','rpc_expense','rpc_move_money','rpc_count_stock','rpc_cash_count',
               'rpc_store','rpc_mill']
$$;
revoke execute on function public._queueable() from public, anon, authenticated;

create or replace function public.rpc_queued(p_key uuid, p_fn text, p_args jsonb default '{}'::jsonb, p_made_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := _require(array['manager','clerk','store','pos']::staff_role[]);
  v_prev client_ops;
  v_n int;
  p record;
  v_names text[]; v_modes text[]; v_types oid[];
  v_parts text[] := '{}';
  v_call text; v_res jsonb; v_txt text;
  k text; i int; t oid; cat char;
begin
  if p_key is null then raise exception 'The entry has no key' using errcode = '22023'; end if;
  if p_fn is null or not (p_fn = any (_queueable())) then raise exception 'This entry cannot be sent from the phone later' using errcode = '42501'; end if;
  p_args := coalesce(p_args, '{}'::jsonb);
  if jsonb_typeof(p_args) <> 'object' or length(p_args::text) > 65536 then raise exception 'The entry is not valid' using errcode = '22023'; end if;
  if p_made_at is not null and (p_made_at > now() + interval '10 minutes' or p_made_at < now() - interval '7 days') then
    raise exception 'The entry was made more than a week ago. Show it to the farm manager.' using errcode = '22023';
  end if;

  -- claim the key; a second send waits here until the first has finished, then gets its answer
  insert into client_ops (key, staff_id, fn, made_at) values (p_key, s.id, p_fn, p_made_at) on conflict (key) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    select * into v_prev from client_ops where key = p_key;
    if v_prev.staff_id <> s.id or v_prev.fn <> p_fn then raise exception 'The entry is not valid' using errcode = '22023'; end if;
    return coalesce(v_prev.result, 'null'::jsonb);
  end if;

  -- the action, called with its own argument names and types
  select pr.proname, pr.proargnames, pr.proargmodes::text[], array(select unnest(coalesce(pr.proallargtypes, pr.proargtypes::oid[]))) as types,
         pr.prorettype, pr.proretset, pr.pronargs
    into p from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = 'public' and pr.proname = p_fn;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'This entry cannot be sent from the phone later' using errcode = '42501'; end if;
  v_names := p.proargnames; v_modes := p.proargmodes; v_types := p.types;

  for k in select jsonb_object_keys(p_args) loop
    if not (k = any (coalesce(v_names, '{}'))) then raise exception 'The entry is not valid' using errcode = '22023'; end if;
  end loop;
  for i in 1 .. coalesce(array_length(v_names, 1), 0) loop
    if v_modes is not null and v_modes[i] not in ('i', 'b') then continue; end if;
    if not (p_args ? v_names[i]) then continue; end if;
    t := v_types[i];
    select typcategory into cat from pg_type where oid = t;
    v_parts := v_parts || format('%I => %s', v_names[i],
      case when t = 'jsonb'::regtype then format('$1->%L', v_names[i])
           when t = 'json'::regtype then format('($1->%L)::json', v_names[i])
           when cat = 'A' then format('(case when jsonb_typeof($1->%L) = ''array'' then array(select jsonb_array_elements_text($1->%L)) end)::%s', v_names[i], v_names[i], format_type(t, null))
           else format('($1->>%L)::%s', v_names[i], format_type(t, null)) end);
  end loop;
  v_call := format('public.%I(%s)', p_fn, array_to_string(v_parts, ', '));

  if p.proretset then
    execute format('select coalesce(jsonb_agg(to_jsonb(r)), ''[]''::jsonb) from %s r', v_call) into v_res using p_args;
  elsif p.prorettype = 'void'::regtype then
    execute format('select (%s)::text', v_call) into v_txt using p_args;
    v_res := null;
  else
    execute format('select to_jsonb(%s)', v_call) into v_res using p_args;
  end if;

  update client_ops set result = v_res where key = p_key;
  return v_res;
end $$;
revoke execute on function public.rpc_queued(uuid, text, jsonb, timestamptz) from public, anon;
grant execute on function public.rpc_queued(uuid, text, jsonb, timestamptz) to authenticated;
