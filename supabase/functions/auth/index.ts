// Sign-in, passwords and two-step verification for Desert Pearl.
// Called only by the Vercel gateway (see _shared/util.ts). POST { action, ... }
//
//   challenge                         -> a bot check to solve (built-in puzzle or Turnstile)
//   login { username, password, captcha? }
//                                     -> { session, state } ; the gateway moves the session into HttpOnly cookies
//   status                            -> { state, user } for the current session, or { state: 'none', setup_needed }
//   set_password { new_password, current_password? }
//   mfa_enroll                        -> { secret, uri }      (authenticator app set-up)
//   mfa_confirm { code }              -> { backup_codes }     (shown once)
//   mfa_verify { code } | { backup_code }
//   backup_codes { code }             -> { backup_codes }     (new set; old ones stop working)
//   mfa_disable { code }              (only where two-step is optional)
//   logout | logout_all
//   bootstrap                         (only on an empty system: creates the default team)
//
// Every attempt is logged in auth_events. Limits (database: auth_check / auth_record):
// per IP and action 5 failures per 15 minutes; per account exponential backoff,
// then a lockout after 5 failures (15 min, doubling each time, max 24 h);
// a bot check after 3 failures.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import {
  adminClient, anonClient, caller, clientIp, clientUa, derivedPassword, fromGateway, hmacHex,
  json, jwtPayload, randomHex, readJson, secret, settle, staffEmail, str, type Caller,
} from '../_shared/util.ts';
import { checkPassword, commonListSource } from '../_shared/policy.ts';
import { b32encode, newBackupCodes, newSecret, normaliseBackupCode, otpauthUri, seal, totpCheck, unseal } from '../_shared/totp.ts';
import { DEFAULT_TEAM, createStaff } from '../_shared/staff.ts';
import { checkPuzzle, checkTurnstile, difficulty, makePuzzle, turnstileKeys, type Solution } from '../_shared/challenge.ts';

type Gate = { allowed: boolean; reason: string | null; retry_after: number; captcha: boolean };

const mins = (s: number) => (s >= 3600 ? `${Math.ceil(s / 3600)} h` : s >= 90 ? `${Math.ceil(s / 60)} min` : `${s} s`);
const refuse = (g: Gate) => json({
  error: g.reason === 'backoff' ? `Please wait ${mins(g.retry_after)} before trying again.`
    : g.reason === 'account_locked' ? `Too many failed attempts. This account is locked for ${mins(g.retry_after)}. The owner can unlock it sooner.`
    : `Too many attempts from this network. Try again in ${mins(g.retry_after)}.`,
  retry_after: g.retry_after, captcha_required: g.captcha, code: 'RATE_LIMITED',
}, 429, { 'Retry-After': String(g.retry_after) });

async function gate(db: SupabaseClient, kind: string, ip: string, subject: string | null): Promise<Gate> {
  const { data, error } = await db.rpc('auth_check', { p_kind: kind, p_ip: ip, p_subject: subject });
  if (error) throw error;
  return data as Gate;
}
async function record(db: SupabaseClient, req: Request, kind: string, subject: string | null, ok: boolean, reason: string,
                      who?: { id?: string; username?: string }, count = true) {
  const { data, error } = await db.rpc('auth_record', {
    p_kind: kind, p_ip: clientIp(req), p_subject: subject, p_ok: ok, p_reason: reason,
    p_staff: who?.id ?? null, p_username: who?.username ?? null, p_ua: clientUa(req), p_count: count,
  });
  if (error) throw error;
  return data as { locked_for: number; captcha?: boolean; left?: number };
}

const mfaKey = async (db: SupabaseClient) => Deno.env.get('DPV_MFA_KEY') || await secret(db, 'mfa_key', () => randomHex(32));
const backupHash = async (db: SupabaseClient, staffId: string, code: string) =>
  hmacHex(await secret(db, 'backup_pepper', () => randomHex(32)), `${staffId}:${normaliseBackupCode(code)}`);

async function issueBackupCodes(db: SupabaseClient, staffId: string): Promise<string[]> {
  const codes = newBackupCodes();
  const { error: e1 } = await db.from('mfa_backup_codes').delete().eq('staff_id', staffId);
  if (e1) throw e1;
  const rows = await Promise.all(codes.map(async (c) => ({ staff_id: staffId, code_hash: await backupHash(db, staffId, c) })));
  const { error } = await db.from('mfa_backup_codes').insert(rows);
  if (error) throw error;
  return codes;
}

/** Checks a TOTP code (once per 30 s step) or, if allowed, a backup code. */
async function verifySecondFactor(db: SupabaseClient, staffId: string, code: string, allowBackup: boolean): Promise<'totp' | 'backup' | null> {
  const { data: f } = await db.from('mfa_factors').select('secret_enc, last_step, confirmed_at').eq('staff_id', staffId).maybeSingle();
  if (!f) return null;
  const digits = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) {
    const sec = await unseal(await mfaKey(db), f.secret_enc, staffId);
    const step = await totpCheck(sec, digits, Date.now(), Number(f.last_step));
    if (step === null) return null;
    // claim the step atomically, so the same code cannot be used twice
    const { data: claimed } = await db.from('mfa_factors').update({ last_step: step })
      .eq('staff_id', staffId).lt('last_step', step).select('staff_id').maybeSingle();
    return claimed ? 'totp' : null;
  }
  if (allowBackup && f.confirmed_at && normaliseBackupCode(code).length === 10) {
    const { data: used } = await db.from('mfa_backup_codes').update({ used_at: new Date().toISOString() })
      .eq('staff_id', staffId).eq('code_hash', await backupHash(db, staffId, code)).is('used_at', null)
      .select('id').maybeSingle();
    return used ? 'backup' : null;
  }
  return null;
}

async function solveOk(db: SupabaseClient, ip: string, sol: Solution | undefined): Promise<boolean> {
  if (!sol || typeof sol !== 'object') return false;
  const ts = turnstileKeys();
  if (ts) return checkTurnstile(ts.secret, str(sol.token, 4096), ip);
  const ok = await checkPuzzle(await secret(db, 'challenge_key', () => randomHex(32)), ip, sol);
  if (!ok) return false;
  const { data } = await db.rpc('auth_redeem_challenge', { p_id: ok.id, p_expires: new Date(ok.exp).toISOString() });
  return data === true;
}

const userOf = (c: Caller) => ({
  id: c.staff.id, username: c.staff.username, display_name: c.staff.display_name, role: c.staff.role,
  location_id: c.staff.location_id, mfa_enabled: c.mfa_enabled, mfa_required: c.mfa_required,
  temp_expires_at: c.staff.must_change_password ? c.staff.temp_expires_at : null,
});

async function stateOf(db: SupabaseClient, uid: string, sid: string) {
  const { data } = await db.rpc('auth_state', { p_uid: uid, p_sid: sid });
  return data as { state: string };
}

// ----------------------------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const db = adminClient();
  if (!await fromGateway(db, req)) return json({ error: 'Not found' }, 404);
  const ip = clientIp(req);
  const body = await readJson(req);
  const action = str(body.action, 40);

  try {
    // ---------------------------------------------------------------- bot check
    if (action === 'challenge') {
      const g = await gate(db, 'challenge', ip, null);
      if (!g.allowed) return refuse(g);
      const ts = turnstileKeys();
      if (ts) return json({ challenge: { type: 'turnstile', site_key: ts.site } });
      return json({ challenge: await makePuzzle(await secret(db, 'challenge_key', () => randomHex(32)), ip, difficulty(g.captcha ? 5 : 3)) });
    }

    // ---------------------------------------------------------------- sign in
    if (action === 'login') {
      const started = Date.now();
      const username = str(body.username, 64).trim().toLowerCase();
      const password = str(body.password, 200);
      if (username.length < 3 || !password || password.length > 128) {
        await settle(started);
        return json({ error: 'Enter your username and password.' }, 400);
      }
      const g = await gate(db, 'login', ip, username);
      if (!g.allowed) { await record(db, req, 'login', null, false, `refused_${g.reason}`, undefined, false); await settle(started); return refuse(g); }
      if (g.captcha && !await solveOk(db, ip, body.captcha as Solution)) {
        const r = await record(db, req, 'login', username, false, body.captcha ? 'captcha_failed' : 'captcha_missing');
        await settle(started);
        return json({ error: body.captcha ? 'The security check failed. Try again.' : 'Complete the security check to continue.',
          captcha_required: true, code: 'CAPTCHA', locked_for: r.locked_for }, 401);
      }

      const { data: s } = await db.from('staff').select('id, username, active, must_change_password, temp_expires_at')
        .eq('username', username).maybeSingle();
      const fail = async (reason: string, who?: { id: string; username: string }) => {
        const r = await record(db, req, 'login', username, false, reason, who);
        await settle(started);
        if (r.locked_for > 0) return json({ error: `Too many failed attempts. This account is locked for ${mins(r.locked_for)}.`, code: 'LOCKED', captcha_required: true }, 429);
        const left = r.left ?? 0;
        return json({ error: `Wrong username or password.${left > 0 && left <= 2 ? ` ${left} ${left === 1 ? 'try' : 'tries'} left before a lock.` : ''}`,
          captcha_required: Boolean(r.captcha), code: 'BAD_CREDENTIALS' }, 401);
      };
      if (!s || !s.active) {
        await derivedPassword(db, crypto.randomUUID(), password);   // same work as a real check
        return fail(s ? 'inactive' : 'unknown_user', s ? { id: s.id, username: s.username } : undefined);
      }

      const { data, error } = await anonClient().auth.signInWithPassword({ email: staffEmail(s.id), password: await derivedPassword(db, s.id, password) });
      if (error || !data.session) return fail('bad_password', { id: s.id, username: s.username });

      const sid = String(jwtPayload(data.session.access_token).session_id ?? '');
      if (s.must_change_password && s.temp_expires_at && new Date(s.temp_expires_at) < new Date()) {
        await db.rpc('auth_end_sessions', { p_uid: s.id, p_only: sid });
        await record(db, req, 'login', username, false, 'temp_expired', { id: s.id, username: s.username }, false);
        await settle(started);
        return json({ error: 'Your temporary password has expired. Ask the owner to reset it.', code: 'TEMP_EXPIRED' }, 403);
      }
      await record(db, req, 'login', username, true, s.must_change_password ? 'ok_temporary' : 'ok', { id: s.id, username: s.username });
      const st = await stateOf(db, s.id, sid);
      await settle(started);
      return json({
        state: st.state,
        session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_in: data.session.expires_in },
      });
    }

    // ---------------------------------------------------------------- first-time set-up
    if (action === 'bootstrap') {
      const g = await gate(db, 'bootstrap', ip, null);
      if (!g.allowed) return refuse(g);
      const { count, error } = await db.from('staff').select('id', { count: 'exact', head: true });
      if (error) throw error;
      if ((count ?? 0) > 0) {
        await record(db, req, 'bootstrap', null, false, 'already_set_up');
        return json({ error: 'The team is already set up. Sign in as the owner to add staff.' }, 409);
      }
      for (const p of DEFAULT_TEAM) await createStaff(db, p);
      await record(db, req, 'bootstrap', null, true, `created ${DEFAULT_TEAM.length}`, undefined, false);
      return json({ ok: true, created: DEFAULT_TEAM.map((p) => ({ username: p.username, display_name: p.display_name })) });
    }

    // ---------------------------------------------------------------- everything below needs a session
    const me = await caller(db, req);
    if (action === 'status') {
      if (!me) {
        const { count } = await db.from('staff').select('id', { count: 'exact', head: true });
        return json({ state: 'none', setup_needed: (count ?? 0) === 0 });
      }
      if (['none', 'expired', 'inactive', 'temp_expired'].includes(me.state)) return json({ state: me.state, clear_session: true });
      return json({ state: me.state, user: userOf(me) });
    }
    if (!me || ['none', 'expired', 'inactive'].includes(me.state)) return json({ error: 'Your session has ended. Sign in again.', code: 'SIGNED_OUT', clear_session: true }, 401);
    const who = { id: me.uid, username: me.staff.username };

    if (action === 'logout' || action === 'logout_all') {
      const { data: n } = await db.rpc('auth_end_sessions', { p_uid: me.uid, p_only: action === 'logout' ? me.sid : null });
      await record(db, req, action, null, true, `${n ?? 0} session(s) ended`, who, false);
      return json({ ok: true, clear_session: true });
    }

    // ------------------------------------------------------------ password
    if (action === 'set_password') {
      if (!['set_password', 'ready', 'mfa_enroll'].includes(me.state)) return json({ error: 'Finish signing in first.', code: 'AUTH_' + me.state.toUpperCase() }, 403);
      const g = await gate(db, 'set_password', ip, me.uid);
      if (!g.allowed) return refuse(g);
      const next = str(body.new_password, 200);
      if (!me.staff.must_change_password) {
        // a voluntary change: prove the current password (checked against Supabase Auth, then that test session is ended)
        const current = str(body.current_password, 200);
        const { data: chk, error } = current ? await anonClient().auth.signInWithPassword({ email: staffEmail(me.uid), password: await derivedPassword(db, me.uid, current) }) : { data: null, error: true };
        if (chk?.session) await db.rpc('auth_end_sessions', { p_uid: me.uid, p_only: String(jwtPayload(chk.session.access_token).session_id) });
        if (error || !chk?.session) {
          const r = await record(db, req, 'set_password', me.uid, false, 'bad_current_password', who);
          if (r.locked_for > 0) {
            await db.rpc('auth_end_sessions', { p_uid: me.uid, p_only: me.sid });
            return json({ error: 'Too many wrong passwords. You have been signed out.', code: 'SIGNED_OUT', clear_session: true }, 401);
          }
          return json({ error: 'Your current password is not right.', code: 'BAD_CURRENT' }, 400);
        }
        if (current === next) return json({ error: 'Choose a password different from your current one.', problems: ['Choose a new password, not your current one.'] }, 400);
      }
      const verdict = await checkPassword(next, { username: me.staff.username, displayName: me.staff.display_name });
      if (!verdict.ok) {
        await record(db, req, 'set_password', me.uid, false, `policy: ${verdict.problems[0]}`, who, false);
        return json({ error: verdict.problems[0], problems: verdict.problems, code: 'WEAK_PASSWORD' }, 400);
      }
      const { error: e1 } = await db.auth.admin.updateUserById(me.uid, { password: await derivedPassword(db, me.uid, next) });
      if (e1) throw e1;
      const { error: e2 } = await db.from('staff').update({ must_change_password: false, temp_expires_at: null, password_changed_at: new Date().toISOString() }).eq('id', me.uid);
      if (e2) throw e2;
      const { data: ended } = await db.rpc('auth_end_sessions', { p_uid: me.uid, p_keep: me.sid });   // sign out every other device
      await record(db, req, 'set_password', me.uid, true, `ok (breach check ${verdict.hibp}, list ${commonListSource()}, ${ended ?? 0} other session(s) ended)`, who);
      return json({ ok: true, state: (await stateOf(db, me.uid, me.sid)).state });
    }

    // ------------------------------------------------------------ two-step: set up
    if (action === 'mfa_enroll') {
      if (!['mfa_enroll', 'ready'].includes(me.state)) return json({ error: 'Finish signing in first.', code: 'AUTH_' + me.state.toUpperCase() }, 403);
      if (me.mfa_enabled) return json({ error: 'Two-step sign-in is already on. Turn it off first, or ask the owner to reset it.' }, 409);
      const g = await gate(db, 'mfa_enroll', ip, null);
      if (!g.allowed) return refuse(g);
      const raw = newSecret();
      const { error } = await db.from('mfa_factors').upsert({
        staff_id: me.uid, secret_enc: await seal(await mfaKey(db), raw, me.uid), confirmed_at: null, last_step: 0, created_at: new Date().toISOString(),
      });
      if (error) throw error;
      await record(db, req, 'mfa_enroll', null, true, 'secret issued', who, false);
      const b32 = b32encode(raw);
      return json({ secret: b32.replace(/(.{4})/g, '$1 ').trim(), uri: otpauthUri(b32, me.staff.username) });
    }

    if (action === 'mfa_confirm') {
      if (!['mfa_enroll', 'ready'].includes(me.state) || me.mfa_enabled) return json({ error: 'Start the set-up again.' }, 409);
      const g = await gate(db, 'otp', ip, me.uid);
      if (!g.allowed) return refuse(g);
      const ok = await verifySecondFactor(db, me.uid, str(body.code, 20), false);
      if (!ok) {
        const r = await record(db, req, 'otp', me.uid, false, 'enroll_bad_code', who);
        return json({ error: r.locked_for ? `Too many wrong codes. Try again in ${mins(r.locked_for)}.` : 'That code is not right. Check the phone’s clock is automatic and use the newest code.', code: 'BAD_CODE' }, r.locked_for ? 429 : 400);
      }
      const { error } = await db.from('mfa_factors').update({ confirmed_at: new Date().toISOString() }).eq('staff_id', me.uid);
      if (error) throw error;
      await db.from('mfa_sessions').upsert({ session_id: me.sid, staff_id: me.uid });
      const codes = await issueBackupCodes(db, me.uid);
      await record(db, req, 'otp', me.uid, true, 'two-step sign-in turned on', who);
      return json({ ok: true, backup_codes: codes, state: (await stateOf(db, me.uid, me.sid)).state });
    }

    // ------------------------------------------------------------ two-step: sign in
    if (action === 'mfa_verify') {
      if (me.state !== 'mfa_verify') return json({ ok: true, state: me.state });
      const g = await gate(db, 'otp', ip, me.uid);
      if (!g.allowed) return refuse(g);
      const code = str(body.code, 20) || str(body.backup_code, 20);
      const ok = await verifySecondFactor(db, me.uid, code, true);
      if (!ok) {
        const r = await record(db, req, 'otp', me.uid, false, 'bad_code', who);
        if (r.locked_for > 0) {
          // locked: this half-signed-in session is ended; the password is needed again later
          await db.rpc('auth_end_sessions', { p_uid: me.uid, p_only: me.sid });
          return json({ error: `Too many wrong codes. Two-step sign-in is locked for ${mins(r.locked_for)}.`, code: 'SIGNED_OUT', clear_session: true }, 429);
        }
        return json({ error: `That code is not right.${r.left && r.left <= 2 ? ` ${r.left} ${r.left === 1 ? 'try' : 'tries'} left.` : ''}`, code: 'BAD_CODE' }, 400);
      }
      const { error } = await db.from('mfa_sessions').upsert({ session_id: me.sid, staff_id: me.uid });
      if (error) throw error;
      await record(db, req, 'otp', me.uid, true, ok === 'backup' ? 'ok_backup_code' : 'ok', who);
      const { count } = await db.from('mfa_backup_codes').select('id', { count: 'exact', head: true }).eq('staff_id', me.uid).is('used_at', null);
      return json({ ok: true, used_backup: ok === 'backup', backup_codes_left: count ?? 0, state: (await stateOf(db, me.uid, me.sid)).state });
    }

    // ------------------------------------------------------------ two-step: manage (fully signed in)
    if (action === 'backup_codes' || action === 'mfa_disable') {
      if (me.state !== 'ready') return json({ error: 'Finish signing in first.', code: 'AUTH_' + me.state.toUpperCase() }, 403);
      if (!me.mfa_enabled) return json({ error: 'Two-step sign-in is off.' }, 409);
      if (action === 'mfa_disable' && me.mfa_required) return json({ error: 'Two-step sign-in is required for your role and cannot be turned off.' }, 403);
      const g = await gate(db, 'otp', ip, me.uid);
      if (!g.allowed) return refuse(g);
      if (await verifySecondFactor(db, me.uid, str(body.code, 20), false) !== 'totp') {
        const r = await record(db, req, 'otp', me.uid, false, `${action}_bad_code`, who);
        return json({ error: r.locked_for ? `Too many wrong codes. Try again in ${mins(r.locked_for)}.` : 'That code is not right.', code: 'BAD_CODE' }, r.locked_for ? 429 : 400);
      }
      if (action === 'backup_codes') {
        const codes = await issueBackupCodes(db, me.uid);
        await record(db, req, 'otp', me.uid, true, 'new backup codes', who);
        return json({ ok: true, backup_codes: codes });
      }
      await db.from('mfa_backup_codes').delete().eq('staff_id', me.uid);
      await db.from('mfa_factors').delete().eq('staff_id', me.uid);
      await record(db, req, 'otp', me.uid, true, 'two-step sign-in turned off', who);
      return json({ ok: true });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error(action, e);
    return json({ error: 'Sign-in is unavailable right now. Try again in a minute.' }, 500);
  }
});
