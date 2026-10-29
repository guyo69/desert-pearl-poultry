// POST { staff_id, pin } -> { session } | { error }
// Five wrong PINs lock the account for 15 minutes.
import { adminClient, anonClient, cors, isPin, json, pinPassword, readJson, staffEmail } from '../_shared/util.ts';

const MAX_TRIES = 5;
const LOCK_MINUTES = 15;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const { staff_id, pin } = await readJson(req);
  if (typeof staff_id !== 'string' || !isPin(pin)) return json({ error: 'Enter your PIN (4 to 6 digits).' }, 400);

  const db = adminClient();
  const { data: s, error } = await db.from('staff')
    .select('id, active, locked_until, failed_attempts').eq('id', staff_id).maybeSingle();
  if (error) return json({ error: 'Sign-in is unavailable right now. Try again.' }, 500);
  if (!s || !s.active) return json({ error: 'This account is not active. Ask the owner.' }, 403);
  if (s.locked_until && new Date(s.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(s.locked_until).getTime() - Date.now()) / 60000);
    return json({ error: `Too many wrong PINs. Try again in ${mins} min, or ask the owner to reset your PIN.` }, 429);
  }

  const { data, error: signInError } = await anonClient().auth.signInWithPassword({
    email: staffEmail(s.id),
    password: await pinPassword(db, s.id, pin),
  });

  if (signInError || !data.session) {
    const tries = (s.failed_attempts ?? 0) + 1;
    const lock = tries >= MAX_TRIES;
    await db.from('staff').update({
      failed_attempts: lock ? 0 : tries,
      locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null,
    }).eq('id', s.id);
    return json({
      error: lock ? `Too many wrong PINs. Locked for ${LOCK_MINUTES} minutes.`
                  : `Wrong PIN. ${MAX_TRIES - tries} ${MAX_TRIES - tries === 1 ? 'try' : 'tries'} left.`,
    }, 401);
  }

  await db.from('staff').update({ failed_attempts: 0, locked_until: null }).eq('id', s.id);
  return json({ session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } });
});
