// Shared helpers for the Desert Pearl edge functions.
//
// The browser never talks to these functions directly: every call comes
// through the Vercel gateway (api/gateway.ts), which holds the session in
// HttpOnly cookies, adds the caller's real IP and proves itself with the
// gateway secret. Calls without that secret are refused.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/** Service-role client: bypasses row level security. Never return its data unfiltered. */
export const adminClient = (): SupabaseClient => createClient(SUPABASE_URL, SERVICE_KEY, noSession);
/** Public client, used only to sign staff in with their derived password. */
export const anonClient = (): SupabaseClient => createClient(SUPABASE_URL, ANON_KEY, noSession);
/** A client acting as the signed-in user, so the database applies their rights. */
export const userClient = (token: string): SupabaseClient =>
  createClient(SUPABASE_URL, ANON_KEY, { ...noSession, global: { headers: { Authorization: `Bearer ${token}` } } });

export const projectUrl = SUPABASE_URL;

/** Staff never see or type an email: each account gets a synthetic, never-mailed address. */
export const staffEmail = (id: string) => `${id}@staff.example.com`;

/** The one-time temporary password given to new and reset accounts (valid 72 h, must be replaced). */
export const TEMP_PASSWORD = '0000';

const cache = new Map<string, string>();
/** Reads a server-side secret from app_secrets, creating it on first use. */
export async function secret(db: SupabaseClient, key: string, make?: () => string | Promise<string>): Promise<string> {
  const hit = cache.get(key);
  if (hit) return hit;
  const { data, error } = await db.from('app_secrets').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  if (data?.value) { cache.set(key, data.value); return data.value; }
  if (!make) throw new Error(`Missing secret ${key}`);
  const value = await make();
  const { error: e2 } = await db.from('app_secrets').insert({ key, value });
  if (e2) {
    // another request created it first
    const again = await db.from('app_secrets').select('value').eq('key', key).single();
    if (again.error) throw e2;
    cache.set(key, again.data.value);
    return again.data.value;
  }
  cache.set(key, value);
  return value;
}

export const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const hex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * The Supabase password is an HMAC of the staff password with a server-only
 * pepper, so it can never be guessed directly against the Supabase Auth API
 * (which has no lockout of its own): only through the `auth` function, with
 * its rate limits, CAPTCHA and lockout. Same derivation as the old PINs, so
 * an old PIN works once as a temporary password.
 */
export async function derivedPassword(db: SupabaseClient, staffId: string, password: string): Promise<string> {
  const pepper = await secret(db, 'pin_pepper', () => randomHex(32));
  return 'dpv1.' + await hmacHex(pepper, `${staffId}:${password}`);
}

/** Only the gateway may call us; it also tells us the caller's real IP. */
export async function fromGateway(db: SupabaseClient, req: Request): Promise<boolean> {
  const given = req.headers.get('x-dpv-gateway') ?? '';
  if (!given) return false;
  return safeEqual(given, await secret(db, 'gateway_secret'));
}
export const clientIp = (req: Request) => (req.headers.get('x-dpv-client-ip') ?? 'unknown').slice(0, 64);
export const clientUa = (req: Request) => (req.headers.get('x-dpv-client-ua') ?? '').slice(0, 200);

export const bearer = (req: Request) => (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');

/** Decodes a JWT payload. Only use after the token was verified (auth.getUser). */
export function jwtPayload(token: string): Record<string, unknown> {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(p + '='.repeat((4 - (p.length % 4)) % 4)));
  } catch { return {}; }
}

export type SessionState = 'none' | 'expired' | 'inactive' | 'mfa_verify' | 'set_password' | 'temp_expired' | 'mfa_enroll' | 'ready';
export interface StaffRow { id: string; username: string; display_name: string; role: string; location_id: string | null; active: boolean; must_change_password: boolean; temp_expires_at: string | null }
export interface Caller { uid: string; sid: string; state: SessionState; staff: StaffRow; mfa_enabled: boolean; mfa_required: boolean }

/** The verified caller and the database's view of their session, or null. */
export async function caller(db: SupabaseClient, req: Request): Promise<Caller | null> {
  const token = bearer(req);
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;
  const sid = String(jwtPayload(token).session_id ?? '');
  if (!sid) return null;
  const { data: st, error: e2 } = await db.rpc('auth_state', { p_uid: data.user.id, p_sid: sid });
  if (e2 || !st?.staff) return null;
  return { uid: data.user.id, sid, ...st } as Caller;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (text.length > 16384) return {};
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Waits so that every reply to a sign-in takes about the same time (no user enumeration by timing). */
export async function settle(started: number, ms = 600) {
  const left = ms + Math.random() * 150 - (Date.now() - started);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}
