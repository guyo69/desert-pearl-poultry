// POST { current_pin, new_pin } with the staff member's access token.
import { DEFAULT_PIN, adminClient, anonClient, caller, cors, isPin, json, pinPassword, readJson, staffEmail } from '../_shared/util.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const db = adminClient();
  const me = await caller(db, req);
  if (!me) return json({ error: 'Sign in again to change your PIN.' }, 401);

  const { current_pin, new_pin } = await readJson(req);
  if (!isPin(current_pin)) return json({ error: 'Enter your current PIN.' }, 400);
  if (!isPin(new_pin)) return json({ error: 'The new PIN must be 4 to 6 digits.' }, 400);
  if (new_pin === DEFAULT_PIN) return json({ error: '0000 is the default PIN. Choose a different one.' }, 400);
  if (new_pin === current_pin) return json({ error: 'The new PIN is the same as the current one.' }, 400);
  if (/^(\d)\1+$/.test(new_pin) || '0123456789'.includes(new_pin) || '9876543210'.includes(new_pin)) {
    return json({ error: 'That PIN is too easy to guess. Avoid repeated or sequential digits.' }, 400);
  }

  const check = await anonClient().auth.signInWithPassword({ email: staffEmail(me.id), password: await pinPassword(db, me.id, current_pin) });
  if (check.error) return json({ error: 'Your current PIN is wrong.' }, 401);

  const { error } = await db.auth.admin.updateUserById(me.id, { password: await pinPassword(db, me.id, new_pin) });
  if (error) return json({ error: 'Could not change the PIN. Try again.' }, 500);
  await db.from('staff').update({ must_change_pin: false, failed_attempts: 0, locked_until: null }).eq('id', me.id);
  return json({ ok: true });
});
