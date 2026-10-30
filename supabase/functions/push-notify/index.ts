// Phone notifications (Web Push).
//   GET                -> { public_key } for the app to subscribe with
//   POST { id }        -> sends notification <id> to every subscribed phone of the people it is addressed to.
// POST is only accepted from the database trigger (x-dpv-trigger secret).
// It sends each notification once, and only within 5 minutes of it being created.
// GET returns the public VAPID key (public by design) and is fetched through the gateway.
import webpush from 'npm:web-push@3.6.7';
import { adminClient, json, projectUrl, readJson, safeEqual, secret } from '../_shared/util.ts';

async function vapid(db: ReturnType<typeof adminClient>) {
  let made: { publicKey: string; privateKey: string } | null = null;
  const gen = () => (made ??= webpush.generateVAPIDKeys());
  const publicKey = await secret(db, 'vapid_public', () => gen().publicKey);
  const privateKey = await secret(db, 'vapid_private', () => gen().privateKey);
  return { publicKey, privateKey };
}

Deno.serve(async (req) => {
  const db = adminClient();
  const keys = await vapid(db);
  if (req.method === 'GET') return json({ public_key: keys.publicKey });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  if (!safeEqual(req.headers.get('x-dpv-trigger') ?? '', await secret(db, 'trigger_secret'))) return json({ error: 'Not found' }, 404);

  const { id } = await readJson(req);
  if (typeof id !== 'number') return json({ error: 'id required' }, 400);

  // claim the notification so it is sent once
  const { data: n } = await db.from('notifications')
    .update({ pushed_at: new Date().toISOString() })
    .eq('id', id).is('pushed_at', null)
    .gt('created_at', new Date(Date.now() - 5 * 60000).toISOString())
    .select('*').maybeSingle();
  if (!n) return json({ skipped: true });

  const { data: people } = await db.from('staff').select('id, role, location_id').eq('active', true).in('role', n.to_roles);
  const recipients = (people ?? []).filter((p) =>
    !n.location_id || ['owner', 'manager', 'clerk'].includes(p.role) || p.location_id === n.location_id);
  if (!recipients.length) return json({ sent: 0 });

  const { data: subs } = await db.from('push_subscriptions').select('*').in('staff_id', recipients.map((r) => r.id));
  webpush.setVapidDetails(projectUrl, keys.publicKey, keys.privateKey);
  const payload = JSON.stringify({ title: n.title, body: n.body, sev: n.sev, tag: `dpv-${n.id}`, url: '/' });
  let sent = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600, urgency: n.sev === 'red' ? 'high' : 'normal' });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('id', s.id);  // phone unsubscribed
    }
  }));
  return json({ sent });
});
