// Shared helpers for the Desert Pearl edge functions.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

/** Service-role client: bypasses row level security. Never return its data unfiltered. */
export const adminClient = (): SupabaseClient => createClient(SUPABASE_URL, SERVICE_KEY, noSession);
/** Public client, used only to sign staff in with their derived password. */
export const anonClient = (): SupabaseClient => createClient(SUPABASE_URL, ANON_KEY, noSession);

export const projectUrl = SUPABASE_URL;

/** Staff never see or type an email: each account gets a synthetic, never-mailed address. */
export const staffEmail = (id: string) => `${id}@staff.example.com`;

export const isPin = (p: unknown): p is string => typeof p === 'string' && /^\d{4,6}$/.test(p);
export const DEFAULT_PIN = '0000';

/** Reads a server-side secret from app_secrets, creating it on first use. */
export async function secret(db: SupabaseClient, key: string, make?: () => string | Promise<string>): Promise<string> {
  const { data, error } = await db.from('app_secrets').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  if (data?.value) return data.value;
  if (!make) throw new Error(`Missing secret ${key}`);
  const value = await make();
  const { error: e2 } = await db.from('app_secrets').insert({ key, value });
  if (e2) {
    // another request created it first
    const again = await db.from('app_secrets').select('value').eq('key', key).single();
    if (again.error) throw e2;
    return again.data.value;
  }
  return value;
}

const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Staff sign in with a short PIN. The Supabase password is an HMAC of the
 * PIN with a server-only pepper, so the PIN cannot be guessed directly
 * against the auth API; only through pin-login, which locks after 5 tries.
 */
export async function pinPassword(db: SupabaseClient, staffId: string, pin: string): Promise<string> {
  const pepper = await secret(db, 'pin_pepper', () => randomHex(32));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${staffId}:${pin}`));
  return 'dpv1.' + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Returns the signed-in staff member for a request, or null. */
export async function caller(db: SupabaseClient, req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: s } = await db.from('staff').select('*').eq('id', data.user.id).eq('active', true).maybeSingle();
  return s as null | { id: string; role: string; location_id: string | null; display_name: string; must_change_pin: boolean };
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try { return await req.json(); } catch { return {}; }
}
