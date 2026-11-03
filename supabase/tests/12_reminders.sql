-- Notifications are reminders only, sent at most once a day each (3 Nov 2026). Runs after 11.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
delete from notification_reads; delete from notifications where kind in ('reminder', 'day_close');   -- 01_flows already ran them once today
do $$ declare t date := biz_today(); n int; begin
  n := reminders('morning');
  -- every open sales point without an opening count got one reminder, the others none
  assert not exists (select 1 from locations l where l.kind <> 'van' and not _closed_on(l.id, t)
                      and (exists (select 1 from stock_counts c where c.location_id = l.id and c.d = t and c.kind in ('open', 'opening_balance') and c.voided_at is null))
                        = exists (select 1 from notifications x where x.dedupe_key = format('rem:morning:%s:%s', t, l.id))), 'opening reminders only where needed';
  assert (select to_roles::text from notifications where dedupe_key like 'rem:morning:%' and location_id = 'TUALA' limit 1) is distinct from '{owner}', 'sent to the sales point';
  assert reminders('morning') = 0, 'not twice';
  n := reminders('evening');
  assert not exists (select 1 from locations l where l.kind <> 'van' and not _closed_on(l.id, t)
                      and (exists (select 1 from stock_counts c where c.location_id = l.id and c.d = t and c.kind = 'close' and c.voided_at is null))
                        = exists (select 1 from notifications x where x.dedupe_key = format('rem:evening:%s:%s', t, l.id))), 'closing reminders only where needed';
  assert ((select coalesce(sum(m.n + m.b + m.c + m.j), 0) from v_stock_moves m where m.location_id = 'VAN') > 0)
         = exists (select 1 from notifications x where x.dedupe_key = format('rem:evening:%s:VAN', t)), 'the van is reminded only with eggs on board';
  assert reminders('evening') = 0, 'not twice';
  assert reminders('close') = 1 and reminders('close') = 0, 'one day close';
  assert (select count(*) from notifications where kind not in ('reminder', 'day_close') and created_at > now() - interval '1 minute') = 0, 'nothing else is sent';
  -- per person per day: at most two
  assert (select max(c) from (select count(*) c from notifications where created_at > now() - interval '1 minute'
                               group by to_roles, location_id) q) <= 2, 'at most two a day for anyone';
end $$;
select t_err($$select reminders('noon')$$, 'unknown reminder slot');
select 'ALL REMINDER TESTS PASSED' as result;
