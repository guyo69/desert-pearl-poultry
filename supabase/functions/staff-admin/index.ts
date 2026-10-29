// Staff accounts. Owner only, except "bootstrap", which works once on an empty system.
//   { action: 'bootstrap' }                                   -> creates the default team, all with PIN 0000
//   { action: 'list' }
//   { action: 'create', display_name, role, location_id }     -> new account with PIN 0000
//   { action: 'update', staff_id, display_name?, role?, location_id?, active? }
//   { action: 'reset_pin', staff_id }                         -> back to 0000 and unlocked
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { DEFAULT_PIN, adminClient, caller, cors, json, pinPassword, readJson, staffEmail } from '../_shared/util.ts';

const ROLES = ['owner', 'manager', 'clerk', 'pos'];

const DEFAULT_TEAM = [
  { display_name: 'Owner', role: 'owner', location_id: null },
  { display_name: 'Farm Manager', role: 'manager', location_id: 'FARM' },
  { display_name: 'Production Clerk', role: 'clerk', location_id: 'FARM' },
  { display_name: 'Farm Counter', role: 'pos', location_id: 'FARM' },
  { display_name: 'Van Driver', role: 'pos', location_id: 'VAN' },
  { display_name: 'Tuala Egg Shop Attendant', role: 'pos', location_id: 'TUALA' },
  { display_name: 'Rayan Fedha Attendant', role: 'pos', location_id: 'RAYAN' },
  { display_name: 'Lucky Summer Attendant', role: 'pos', location_id: 'LUCKY' },
];

function checkShape(role: unknown, location_id: unknown): string | null {
  if (typeof role !== 'string' || !ROLES.includes(role)) return 'Choose a role.';
  if (role !== 'owner' && !location_id) return 'Choose a location.';
  if ((role === 'clerk' || role === 'manager') && location_id !== 'FARM') return 'Managers and clerks work at the Central Farm.';
  return null;
}

async function createStaff(db: SupabaseClient, p: { display_name: string; role: string; location_id: string | null }) {
  const id = crypto.randomUUID();
  const { error } = await db.auth.admin.createUser({
    id, email: staffEmail(id), email_confirm: true,
    password: await pinPassword(db, id, DEFAULT_PIN),
    app_metadata: { dpv_role: p.role },
  });
  if (error) throw new Error(error.message);
  const { error: e2 } = await db.from('staff').insert({
    id, display_name: p.display_name.trim(), role: p.role,
    location_id: p.role === 'owner' ? null : p.location_id, must_change_pin: true,
  });
  if (e2) { await db.auth.admin.deleteUser(id); throw new Error(e2.message); }
  return id;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const db = adminClient();
  const body = await readJson(req);
  const action = body.action;

  try {
    if (action === 'bootstrap') {
      const { count, error } = await db.from('staff').select('id', { count: 'exact', head: true });
      if (error) throw error;
      if ((count ?? 0) > 0) return json({ error: 'The team is already set up. Sign in as the owner to add staff.' }, 409);
      for (const p of DEFAULT_TEAM) await createStaff(db, p);
      return json({ ok: true, created: DEFAULT_TEAM.length });
    }

    const me = await caller(db, req);
    if (!me) return json({ error: 'Sign in again.' }, 401);
    if (me.role !== 'owner') return json({ error: 'Only the owner can manage staff.' }, 403);

    if (action === 'list') {
      const { data, error } = await db.from('staff')
        .select('id, display_name, role, location_id, active, must_change_pin, locked_until, failed_attempts, created_at')
        .order('created_at');
      if (error) throw error;
      return json({ staff: data });
    }

    if (action === 'create') {
      const { display_name, role, location_id } = body as Record<string, string>;
      if (!display_name?.trim()) return json({ error: 'Enter a name.' }, 400);
      const bad = checkShape(role, location_id);
      if (bad) return json({ error: bad }, 400);
      const id = await createStaff(db, { display_name, role, location_id: location_id ?? null });
      return json({ ok: true, id });
    }

    const staff_id = body.staff_id as string;
    const { data: target } = await db.from('staff').select('*').eq('id', staff_id ?? '').maybeSingle();
    if (!target) return json({ error: 'Staff member not found.' }, 404);

    if (action === 'reset_pin') {
      const { error } = await db.auth.admin.updateUserById(staff_id, { password: await pinPassword(db, staff_id, DEFAULT_PIN) });
      if (error) throw new Error(error.message);
      await db.from('staff').update({ must_change_pin: true, failed_attempts: 0, locked_until: null }).eq('id', staff_id);
      return json({ ok: true });
    }

    if (action === 'update') {
      const role = (body.role as string) ?? target.role;
      const location_id = role === 'owner' ? null : ((body.location_id as string) ?? target.location_id);
      const bad = checkShape(role, location_id);
      if (bad) return json({ error: bad }, 400);
      const active = typeof body.active === 'boolean' ? body.active : target.active;
      if (staff_id === me.id && (!active || role !== 'owner')) return json({ error: 'You cannot remove your own owner access.' }, 400);
      const { error } = await db.from('staff').update({
        display_name: typeof body.display_name === 'string' && body.display_name.trim() ? body.display_name.trim() : target.display_name,
        role, location_id, active,
      }).eq('id', staff_id);
      if (error) throw error;
      // a disabled account loses access at once: every database rule checks staff.active
      return json({ ok: true });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Something went wrong.' }, 500);
  }
});
