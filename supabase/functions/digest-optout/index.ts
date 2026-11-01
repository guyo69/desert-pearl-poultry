// Turns off the weekly digest and email nudges for one person, from the
// one-click link in an email. Called only through the gateway (route
// `optout`), which passes { staff, token } and the caller's IP.
// A wrong token counts as a failed attempt for that IP (same limits as sign-in).
import { adminClient, clientIp, clientUa, fromGateway, json, readJson, str } from '../_shared/util.ts';
import { optoutValid } from '../_shared/optout.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const db = adminClient();
  if (!await fromGateway(db, req)) return json({ error: 'Not found' }, 404);
  const body = await readJson(req);
  const staffId = str(body.staff, 40), token = str(body.token, 80), ip = clientIp(req);

  const { data: g } = await db.rpc('auth_check', { p_kind: 'optout', p_ip: ip, p_subject: null });
  if (g && !g.allowed) return json({ error: 'Too many attempts. Try again later.' }, 429);

  if (!await optoutValid(db, staffId, token)) {
    await db.rpc('auth_record', { p_kind: 'optout', p_ip: ip, p_subject: null, p_ok: false, p_reason: 'bad link',
                                  p_staff: null, p_username: null, p_ua: clientUa(req), p_count: true });
    return json({ error: 'This link is not valid.' }, 400);
  }
  const { data: s, error } = await db.from('staff')
    .update({ digest_enabled: false, digest_opted_out_at: new Date().toISOString() })
    .eq('id', staffId).select('display_name, username').maybeSingle();
  if (error) return json({ error: 'Something went wrong. Try again.' }, 500);
  if (!s) return json({ error: 'This link is not valid.' }, 400);
  await db.rpc('auth_record', { p_kind: 'optout', p_ip: ip, p_subject: null, p_ok: true, p_reason: 'digest emails turned off',
                                p_staff: staffId, p_username: s.username, p_ua: clientUa(req), p_count: false });
  return json({ ok: true, name: s.display_name });
});
