// Staff accounts. Owner only, and only from a fully verified session
// (password set, two-step sign-in passed). Called through the gateway.
//   { action: 'list' }
//   { action: 'create', username, display_name, role, location_id }   -> temporary password 0000 (72 h)
//   { action: 'update', staff_id, username?, display_name?, role?, location_id?, active? }
//   { action: 'reset_password', staff_id }   -> temporary password 0000 (72 h), signed out everywhere
//   { action: 'reset_mfa', staff_id }        -> two-step removed; owner/manager must set it up again
//   { action: 'unlock', staff_id }           -> clears failed-attempt lockouts
//   { action: 'sign_out', staff_id }         -> ends every session of that person
//   { action: 'backup_list' } / { action: 'backup_now' } / { action: 'backup_url', name }  -> weekly backups
import { TEMP_PASSWORD, adminClient, caller, clientIp, clientUa, derivedPassword, fromGateway, json, readJson, str } from '../_shared/util.ts';
import { ROLES, USERNAME, createStaff } from '../_shared/staff.ts';
import { downloadUrl, listBackups, runBackup } from '../_shared/backup.ts';

function checkShape(role: unknown, location_id: unknown): string | null {
  if (typeof role !== 'string' || !ROLES.includes(role)) return 'Choose a role.';
  if (role !== 'owner' && !location_id) return 'Choose a location.';
  if ((role === 'clerk' || role === 'manager') && location_id !== 'FARM') return 'Managers and clerks work at the Central Farm.';
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const db = adminClient();
  if (!await fromGateway(db, req)) return json({ error: 'Not found' }, 404);
  const body = await readJson(req);
  const action = str(body.action, 40);
  const ip = clientIp(req);

  const log = (ok: boolean, reason: string, target?: string) => db.rpc('auth_record', {
    p_kind: 'admin', p_ip: ip, p_subject: null, p_ok: ok, p_reason: `${action}${target ? ` ${target}` : ''}: ${reason}`,
    p_staff: me?.uid ?? null, p_username: me?.staff.username ?? null, p_ua: clientUa(req), p_count: false,
  });

  const me = await caller(db, req);
  try {
    if (!me || me.state !== 'ready') return json({ error: 'Sign in again.', code: 'SIGNED_OUT' }, 401);
    if (me.staff.role !== 'owner') { await log(false, 'not owner'); return json({ error: 'Only the owner can manage staff.' }, 403); }
    const { data: g } = await db.rpc('auth_check', { p_kind: 'admin', p_ip: ip, p_subject: null });
    if (g && !g.allowed) return json({ error: 'Too many requests. Wait a few minutes.' }, 429);

    if (action === 'list') {
      const [{ data: staff, error }, { data: factors }, { data: counters }] = await Promise.all([
        db.from('staff').select('id, username, display_name, role, location_id, active, must_change_password, temp_expires_at, password_changed_at, created_at').order('created_at'),
        db.from('mfa_factors').select('staff_id, confirmed_at'),
        db.from('auth_counters').select('key, locked_until').gt('locked_until', new Date().toISOString()),
      ]);
      if (error) throw error;
      const locked = (s: { id: string; username: string }) =>
        (counters ?? []).filter((c) => c.key === `sub:login:${s.username}` || c.key.startsWith('sub:') && c.key.endsWith(`:${s.id}`))
          .map((c) => c.locked_until).sort().pop() ?? null;
      return json({ staff: (staff ?? []).map((s) => ({
        ...s, mfa_enabled: (factors ?? []).some((f) => f.staff_id === s.id && f.confirmed_at),
        mfa_required: false, locked_until: locked(s),   // two-step is optional for every role
      })) });
    }

    if (action === 'backup_list') return json({ backups: await listBackups(db) });
    if (action === 'backup_now') {
      const r = await runBackup(db, me.staff.username);
      await log(true, `backup ${r.name}: ${r.rows} records`);
      return json({ ok: true, ...r });
    }
    if (action === 'backup_url') {
      const url = await downloadUrl(db, str(body.name, 80));
      await log(true, `backup downloaded ${str(body.name, 80)}`);
      return json({ url });
    }

    if (action === 'create') {
      const username = str(body.username, 40).trim().toLowerCase();
      const display_name = str(body.display_name, 80).trim();
      const role = str(body.role, 20), location_id = str(body.location_id, 20) || null;
      if (!display_name) return json({ error: 'Enter a name.' }, 400);
      if (!USERNAME.test(username)) return json({ error: 'Username: 3 to 32 lowercase letters, numbers, dots or dashes.' }, 400);
      const bad = checkShape(role, location_id);
      if (bad) return json({ error: bad }, 400);
      const id = await createStaff(db, { username, display_name, role, location_id });
      await log(true, `created ${username} (${role})`, id);
      return json({ ok: true, id, temporary_password: TEMP_PASSWORD });
    }

    const staff_id = str(body.staff_id, 40);
    const { data: target } = await db.from('staff').select('*').eq('id', staff_id).maybeSingle();
    if (!target) return json({ error: 'Staff member not found.' }, 404);

    if (action === 'reset_password') {
      if (staff_id === me.uid) return json({ error: 'Change your own password under My account.' }, 400);
      const { error } = await db.auth.admin.updateUserById(staff_id, { password: await derivedPassword(db, staff_id, TEMP_PASSWORD) });
      if (error) throw new Error(error.message);
      await db.from('staff').update({ must_change_password: true, temp_expires_at: new Date(Date.now() + 72 * 3600_000).toISOString() }).eq('id', staff_id);
      await db.rpc('auth_unlock', { p_staff: staff_id });
      await db.rpc('auth_end_sessions', { p_uid: staff_id });
      await log(true, 'temporary password issued, signed out everywhere', target.username);
      return json({ ok: true, temporary_password: TEMP_PASSWORD });
    }

    if (action === 'reset_mfa') {
      if (staff_id === me.uid) return json({ error: 'You cannot reset your own two-step sign-in. Use a backup code, or see the README for owner recovery.' }, 400);
      await db.from('mfa_backup_codes').delete().eq('staff_id', staff_id);
      await db.from('mfa_factors').delete().eq('staff_id', staff_id);
      await db.rpc('auth_end_sessions', { p_uid: staff_id });
      await log(true, 'two-step sign-in removed, signed out everywhere', target.username);
      return json({ ok: true });
    }

    if (action === 'unlock') {
      await db.rpc('auth_unlock', { p_staff: staff_id });
      await log(true, 'unlocked', target.username);
      return json({ ok: true });
    }

    if (action === 'sign_out') {
      const { data: n } = await db.rpc('auth_end_sessions', { p_uid: staff_id, p_keep: staff_id === me.uid ? me.sid : null });
      await log(true, `${n ?? 0} session(s) ended`, target.username);
      return json({ ok: true, ended: n ?? 0 });
    }

    if (action === 'update') {
      const role = str(body.role, 20) || target.role;
      const location_id = role === 'owner' ? null : (str(body.location_id, 20) || target.location_id);
      const bad = checkShape(role, location_id);
      if (bad) return json({ error: bad }, 400);
      const active = typeof body.active === 'boolean' ? body.active : target.active;
      if (staff_id === me.uid && (!active || role !== 'owner')) return json({ error: 'You cannot remove your own owner access.' }, 400);
      const username = str(body.username, 40).trim().toLowerCase() || target.username;
      if (!USERNAME.test(username)) return json({ error: 'Username: 3 to 32 lowercase letters, numbers, dots or dashes.' }, 400);
      const { error } = await db.from('staff').update({
        username,
        display_name: str(body.display_name, 80).trim() || target.display_name,
        role, location_id, active,
      }).eq('id', staff_id);
      if (error) return json({ error: error.code === '23505' ? 'That username is taken.' : error.message }, 400);
      // a disabled account, or one whose role changed, is signed out at once
      if (!active || role !== target.role || location_id !== target.location_id) await db.rpc('auth_end_sessions', { p_uid: staff_id });
      await log(true, `updated${!active && target.active ? ', disabled' : ''}${role !== target.role ? `, role ${target.role}→${role}` : ''}`, target.username);
      return json({ ok: true });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error(action, e);
    try { await log(false, 'error'); } catch { /* logging must not hide the error */ }
    return json({ error: e instanceof Error ? e.message : 'Something went wrong.' }, 500);
  }
});
