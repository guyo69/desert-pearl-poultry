// Weekly backup, started by the database's pg_cron job (Sunday 23:00 Nairobi).
// Only the database can start it: POST with the x-dpv-trigger secret.
// The owner can also start one, list them and download them under Settings
// (staff-admin actions backup_now / backup_list / backup_url).
import { adminClient, json, safeEqual, secret } from '../_shared/util.ts';
import { runBackup } from '../_shared/backup.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const db = adminClient();
  if (!safeEqual(req.headers.get('x-dpv-trigger') ?? '', await secret(db, 'trigger_secret'))) return json({ error: 'Not found' }, 404);
  try {
    const r = await runBackup(db, 'weekly schedule');
    await db.rpc('auth_record', { p_kind: 'admin', p_ip: 'scheduler', p_subject: null, p_ok: true,
      p_reason: `weekly backup ${r.name}: ${r.rows} records, ${Math.round(r.size / 1024)} KB`, p_staff: null, p_username: null, p_ua: 'pg_cron', p_count: false });
    return json({ ok: true, ...r });
  } catch (e) {
    console.error('backup', e);
    try {
      await db.from('notifications').insert({ sev: 'orange', title: 'Weekly backup failed', to_roles: ['owner'], kind: 'backup',
        body: 'The weekly backup did not finish. Start one under Settings → Backups, or check the Supabase function logs.' });
    } catch { /* the error is in the logs either way */ }
    return json({ error: 'Backup failed' }, 500);
  }
});
