// Creating staff accounts (used by bootstrap and by the owner's staff tools).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { TEMP_PASSWORD, derivedPassword, staffEmail } from './util.ts';

export const ROLES = ['owner', 'manager', 'clerk', 'pos'];
export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** Same rule as the staff_email_shape check in the database. */
export const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** undefined = not sent (keep), null = clear, string = set. Throws a plain sentence when the address is not usable. */
export function emailOf(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new Error('Enter an email address or leave it blank.');
  const e = v.trim().toLowerCase();
  if (!e) return null;
  if (e.length < 6 || e.length > 254 || !EMAIL.test(e)) throw new Error('That email address does not look right.');
  return e;
}

export const DEFAULT_TEAM = [
  { username: 'owner', display_name: 'Owner', role: 'owner', location_id: null },
  { username: 'manager', display_name: 'Farm Manager', role: 'manager', location_id: 'FARM' },
  { username: 'clerk', display_name: 'Production Clerk', role: 'clerk', location_id: 'FARM' },
  { username: 'farm', display_name: 'Farm Counter', role: 'pos', location_id: 'FARM' },
  { username: 'van', display_name: 'Van Driver', role: 'pos', location_id: 'VAN' },
  { username: 'tuala', display_name: 'Tuala Egg Shop Attendant', role: 'pos', location_id: 'TUALA' },
  { username: 'rayan', display_name: 'Rayan Fedha Attendant', role: 'pos', location_id: 'RAYAN' },
  { username: 'lucky', display_name: 'Lucky Summer Attendant', role: 'pos', location_id: 'LUCKY' },
];

export async function createStaff(db: SupabaseClient, p: { username: string; display_name: string; role: string; location_id: string | null }) {
  const id = crypto.randomUUID();
  const { error } = await db.auth.admin.createUser({
    id, email: staffEmail(id), email_confirm: true,
    password: await derivedPassword(db, id, TEMP_PASSWORD),
    app_metadata: { dpv_role: p.role },
  });
  if (error) throw new Error(error.message);
  const { error: e2 } = await db.from('staff').insert({
    id, username: p.username, display_name: p.display_name.trim(), role: p.role,
    location_id: p.role === 'owner' ? null : p.location_id,
    must_change_password: true, temp_expires_at: new Date(Date.now() + 72 * 3600_000).toISOString(),
  });
  if (e2) { await db.auth.admin.deleteUser(id); throw new Error(e2.code === '23505' ? 'That username is taken.' : e2.message); }
  return id;
}

