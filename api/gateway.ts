// Desert Pearl API gateway (Vercel Edge Function at /api/gateway).
//
// The browser never holds a token. Sign-in tokens live in two cookies the
// page's JavaScript cannot read:
//   __Host-dpv_at  access token    HttpOnly; Secure; SameSite=Strict; Path=/
//   __Host-dpv_rt  refresh token   HttpOnly; Secure; SameSite=Strict; Path=/
// This gateway attaches them to calls to Supabase, refreshes them before
// they expire, and clears them on sign-out or when the database ends the
// session. Requests must be same-origin and carry the X-DPV header (CSRF).
//
// Routes (?r=...):
//   auth/<action>   POST  sign-in, passwords, two-step   -> edge function `auth`
//   rpc/<name>      POST  dashboard, data_version, shop_day, gaps, activity, rpc_*, security_log -> database
//   admin           POST  owner's staff tools             -> edge function `staff-admin`
//   push-key        GET   public key for phone notifications
//   optout          GET   confirm page for the one-click link in digest emails (no sign-in)
//                   POST  turn the emails off -> edge function `digest-optout`; also the
//                         RFC 8058 one-click POST that mail apps send. Exempt from the
//                         X-DPV / same-origin checks: the signed link is the permission,
//                         and it can only switch emails off.
//
// Environment: SUPABASE_URL, SUPABASE_ANON_KEY, DPV_GATEWAY_SECRET
// (the value of app_secrets.gateway_secret in the database).

export const config = { runtime: 'edge' };

const AT = '__Host-dpv_at';
const RT = '__Host-dpv_rt';
const MAX_AGE = 12 * 3600;          // matches the database's 12-hour session limit
const MAX_BODY = 64 * 1024;
const AUTH_ACTIONS = new Set(['challenge', 'login', 'status', 'set_password', 'mfa_enroll', 'mfa_confirm', 'mfa_verify',
  'backup_codes', 'mfa_disable', 'logout', 'logout_all', 'bootstrap']);
const PUBLIC_AUTH = new Set(['challenge', 'login', 'bootstrap']);
const RPC = /^(rpc_[a-z_]{1,40}|dashboard|activity|security_log|data_version|shop_day|gaps)$/;

interface Env { url: string; anon: string; secret: string }
type Tokens = { access_token: string; refresh_token: string };

const env = (): Env | null => {
  const e = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  const url = e.SUPABASE_URL, anon = e.SUPABASE_ANON_KEY, secret = e.DPV_GATEWAY_SECRET;
  return url && anon && secret ? { url: url.replace(/\/$/, ''), anon, secret } : null;
};

function reply(status: number, body: unknown, cookies: string[] = [], extra: Record<string, string> = {}): Response {
  const h = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers: h });
}

const cookie = (name: string, value: string, maxAge = MAX_AGE) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
const setTokens = (t: Tokens) => [cookie(AT, t.access_token), cookie(RT, t.refresh_token)];
const clearTokens = () => [cookie(AT, '', 0), cookie(RT, '', 0)];

function readCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function expiresAt(jwt: string): number {
  try {
    const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return Number(JSON.parse(atob(p + '='.repeat((4 - (p.length % 4)) % 4))).exp) * 1000 || 0;
  } catch { return 0; }
}

export function clientIp(req: Request): string {
  // Vercel sets x-real-ip / x-forwarded-for itself; client-supplied values are overwritten
  return (req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown').trim().slice(0, 64);
}

/** CSRF and origin checks. Returns an error message, or null when the request is acceptable. */
export function badOrigin(req: Request): string | null {
  const self = new URL(req.url).origin;
  if (req.headers.get('x-dpv') !== '1') return 'missing X-DPV header';
  const origin = req.headers.get('origin');
  if (origin && origin !== self) return 'cross-origin request';
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site request';
  if (req.method === 'POST' && !(req.headers.get('content-type') ?? '').startsWith('application/json')) return 'JSON only';
  return null;
}

async function refresh(e: Env, rt: string): Promise<Tokens | null> {
  const r = await fetch(`${e.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { apikey: e.anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: rt }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.access_token && j.refresh_token ? { access_token: j.access_token, refresh_token: j.refresh_token } : null;
}

/** A usable access token (refreshed if it expires within a minute), plus any cookies to set. */
async function access(e: Env, req: Request): Promise<{ token: string | null; cookies: string[] }> {
  const c = readCookies(req);
  const at = c[AT], rt = c[RT];
  if (at && expiresAt(at) > Date.now() + 60_000) return { token: at, cookies: [] };
  if (!rt) return { token: null, cookies: at ? clearTokens() : [] };
  const t = await refresh(e, rt);
  if (!t) return { token: null, cookies: clearTokens() };
  return { token: t.access_token, cookies: setTokens(t) };
}

const upstreamHeaders = (e: Env, req: Request, token: string | null) => {
  const h: Record<string, string> = {
    apikey: e.anon, 'Content-Type': 'application/json',
    'x-dpv-gateway': e.secret, 'x-dpv-client-ip': clientIp(req), 'x-dpv-client-ua': (req.headers.get('user-agent') ?? '').slice(0, 200),
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
};

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (req.method !== 'POST') return {};
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  if (!text) return {};
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

const OPTOUT_STAFF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPTOUT_TOKEN = /^v1\.[0-9a-f]{64}$/;

function page(status: number, title: string, body: string): Response {
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(title)}</title></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/** The one-click opt-out link from digest emails. GET only shows a button, so link scanners cannot unsubscribe anyone. */
async function optout(e: Env, req: Request, url: URL): Promise<Response> {
  const staff = url.searchParams.get('s') ?? '', token = url.searchParams.get('t') ?? '';
  if (!OPTOUT_STAFF.test(staff) || !OPTOUT_TOKEN.test(token)) return page(400, 'This link is not valid', '<p>Ask the owner to change your email settings.</p>');
  if (req.method === 'GET') {
    const action = `/api/gateway?r=optout&amp;s=${staff}&amp;t=${token}`;
    return page(200, 'Stop Desert Pearl emails?', '<p>You will no longer get the weekly digest or reminder emails. The owner can turn them back on.</p>' +
      `<form method="post" action="${action}"><input type="hidden" name="confirm" value="1"><button type="submit">Stop the emails</button></form>`);
  }
  if (req.method !== 'POST') return reply(405, { error: 'Use GET or POST' });
  if ((await req.text()).length > 1024) return reply(413, { error: 'Request too large.' });
  const r = await fetch(`${e.url}/functions/v1/digest-optout`, {
    method: 'POST', headers: upstreamHeaders(e, req, null), body: JSON.stringify({ staff, token }),
  });
  if (r.ok) return page(200, 'Emails stopped', '<p>You will no longer get Desert Pearl emails. The owner can turn them back on.</p>');
  return page(r.status === 429 ? 429 : 400, r.status === 429 ? 'Too many attempts' : 'This link is not valid',
    '<p>Try again later, or ask the owner to change your email settings.</p>');
}

export default async function handler(req: Request): Promise<Response> {
  const e = env();
  if (!e) return reply(500, { error: 'The server is not configured. See README: Vercel environment variables.' });
  const reqUrl = new URL(req.url);
  const route = reqUrl.searchParams.get('r') ?? '';
  if (route === 'optout') return optout(e, req, reqUrl);
  const bad = badOrigin(req);
  if (bad) return reply(403, { error: 'Request refused.', detail: bad });

  // ------------------------------------------------------------------ push key (public)
  if (route === 'push-key' && req.method === 'GET') {
    const r = await fetch(`${e.url}/functions/v1/push-notify`, { headers: { apikey: e.anon, Authorization: `Bearer ${e.anon}` } });
    return reply(r.ok ? 200 : 502, r.ok ? await r.json() : { error: 'Notifications are unavailable.' });
  }
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });
  const body = await readBody(req);
  if (!body) return reply(413, { error: 'Request too large or not JSON.' });

  // ------------------------------------------------------------------ sign-in and account security
  if (route.startsWith('auth/')) {
    const action = route.slice(5);
    if (!AUTH_ACTIONS.has(action)) return reply(404, { error: 'Unknown action.' });
    const { token, cookies } = PUBLIC_AUTH.has(action) ? { token: null, cookies: [] as string[] } : await access(e, req);
    if (!token && !PUBLIC_AUTH.has(action) && action !== 'status') {
      return reply(401, { error: 'Your session has ended. Sign in again.', code: 'SIGNED_OUT' }, cookies);
    }
    const r = await fetch(`${e.url}/functions/v1/auth`, {
      method: 'POST', headers: upstreamHeaders(e, req, token), body: JSON.stringify({ ...body, action }),
    });
    let j: Record<string, unknown>;
    try { j = await r.json(); } catch { return reply(502, { error: 'Sign-in is unavailable right now.' }, cookies); }
    let out = cookies;
    if (j.session && typeof j.session === 'object') {
      const s = j.session as Tokens;
      out = setTokens(s);         // a new sign-in replaces whatever was there
      delete j.session;
    }
    if (j.clear_session) { out = clearTokens(); delete j.clear_session; }
    const extra: Record<string, string> = {};
    const ra = r.headers.get('retry-after');
    if (ra) extra['Retry-After'] = ra;
    return reply(r.status, j, out, extra);
  }

  // ------------------------------------------------------------------ database and staff tools
  const isRpc = route.startsWith('rpc/') && RPC.test(route.slice(4));
  if (!isRpc && route !== 'admin') return reply(404, { error: 'Not found.' });
  const { token, cookies } = await access(e, req);
  if (!token) return reply(401, { error: 'Your session has ended. Sign in again.', code: 'SIGNED_OUT' }, cookies);

  const target = isRpc ? `${e.url}/rest/v1/rpc/${route.slice(4)}` : `${e.url}/functions/v1/staff-admin`;
  const r = await fetch(target, { method: 'POST', headers: upstreamHeaders(e, req, token), body: JSON.stringify(body) });
  const text = await r.text();
  let j: unknown = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = null; }
  if (r.ok) return reply(200, j, cookies);

  // PostgREST errors -> { error, code }. AUTH_* come from the database's session gate.
  const err = (j ?? {}) as { message?: string; error?: string; code?: string };
  const msg = String(err.message ?? err.error ?? 'Something went wrong. Try again.');
  const m = /^(AUTH_[A-Z_]+): (.*)$/.exec(msg);
  if (m) {
    const signedOut = m[1] === 'AUTH_SIGNED_OUT' || m[1] === 'AUTH_INACTIVE';
    return reply(401, { error: m[2], code: m[1] }, signedOut ? clearTokens() : cookies);
  }
  if (r.status === 401 || err.code === 'PGRST301' || err.code === 'PGRST303') {
    return reply(401, { error: 'Your session has ended. Sign in again.', code: 'SIGNED_OUT' }, clearTokens());
  }
  return reply(r.status >= 500 ? 502 : 400, { error: msg, code: err.code }, cookies);
}
