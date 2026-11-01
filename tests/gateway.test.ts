// The gateway: cookies, CSRF checks, refresh, routing and error mapping,
// against a fake Supabase.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, { badOrigin } from '../api/gateway';

const ORIGIN = 'https://farm.example.com';
const jwt = (expSecondsFromNow: number) =>
  `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, session_id: 's1' })).replace(/=+$/, '')}.sig`;

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let upstream: (url: string, init: RequestInit) => Response;

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://proj.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.DPV_GATEWAY_SECRET = 'gw-secret';
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return upstream(url, init); });
});
afterEach(() => vi.unstubAllGlobals());

const req = (route: string, body: unknown = {}, headers: Record<string, string> = {}, method = 'POST') =>
  new Request(`${ORIGIN}/api/gateway?r=${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-dpv': '1', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-real-ip': '41.90.1.2', ...headers },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
const setCookies = (r: Response) => (r.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
const hdr = (c: Call, k: string) => (c.init.headers as Record<string, string>)[k];

describe('CSRF and origin checks', () => {
  it('refuses requests without the X-DPV header, cross-origin or cross-site', async () => {
    expect(badOrigin(req('auth/login', {}, { 'x-dpv': '' }))).toMatch(/X-DPV/);
    expect(badOrigin(req('auth/login', {}, { origin: 'https://evil.example' }))).toMatch(/cross-origin/);
    expect(badOrigin(req('auth/login', {}, { 'sec-fetch-site': 'cross-site' }))).toMatch(/cross-site/);
    expect(badOrigin(req('auth/login', {}, { 'content-type': 'text/plain' }))).toMatch(/JSON/);
    const r = await handler(req('rpc/dashboard', {}, { origin: 'https://evil.example' }));
    expect(r.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('sign-in', () => {
  it('moves tokens into HttpOnly, Secure, SameSite=Strict cookies and never returns them', async () => {
    upstream = () => ok({ state: 'ready', session: { access_token: jwt(3600), refresh_token: 'rt1', expires_in: 3600 } });
    const r = await handler(req('auth/login', { username: 'van', password: 'x' }));
    const j = await r.json();
    expect(j).toEqual({ state: 'ready' });
    expect(JSON.stringify(j)).not.toContain('rt1');
    const c = setCookies(r);
    expect(c).toHaveLength(2);
    for (const x of c) expect(x).toMatch(/^__Host-dpv_(at|rt)=.+; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$/);
    // the auth function got the gateway secret, the real IP and the action
    expect(calls[0].url).toBe('https://proj.supabase.co/functions/v1/auth');
    expect(hdr(calls[0], 'x-dpv-gateway')).toBe('gw-secret');
    expect(hdr(calls[0], 'x-dpv-client-ip')).toBe('41.90.1.2');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ action: 'login', username: 'van' });
    expect(hdr(calls[0], 'Authorization')).toBeUndefined();
  });

  it('clears the cookies on sign-out', async () => {
    upstream = () => ok({ ok: true, clear_session: true });
    const r = await handler(req('auth/logout', {}, { cookie: `__Host-dpv_at=${jwt(3600)}; __Host-dpv_rt=rt1` }));
    expect(await r.json()).toEqual({ ok: true });
    expect(setCookies(r).every((c) => c.includes('Max-Age=0'))).toBe(true);
    expect(hdr(calls[0], 'Authorization')).toMatch(/^Bearer h\./);
  });

  it('passes rate-limit answers through with Retry-After', async () => {
    upstream = () => new Response(JSON.stringify({ error: 'Too many', code: 'RATE_LIMITED' }), { status: 429, headers: { 'retry-after': '900' } });
    const r = await handler(req('auth/login', { username: 'van', password: 'x' }));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('900');
  });

  it('rejects unknown auth actions without calling Supabase', async () => {
    const r = await handler(req('auth/delete_everything'));
    expect(r.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('data calls', () => {
  it('needs a session', async () => {
    const r = await handler(req('rpc/dashboard', { p_days: 90 }));
    expect(r.status).toBe(401);
    expect((await r.json()).code).toBe('SIGNED_OUT');
    expect(calls).toHaveLength(0);
  });

  it('only allows the app\'s own database functions', async () => {
    for (const bad of ['rpc/auth_check', 'rpc/_require', 'rpc/staff_directory', 'rpc/../staff', 'rest/staff']) {
      const r = await handler(req(bad, {}, { cookie: `__Host-dpv_at=${jwt(3600)}` }));
      expect(r.status, bad).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it('forwards the change counter and the shop sheet, but not internal helpers', async () => {
    upstream = () => ok({ v: 3, day: '2026-11-01' });
    for (const good of ['rpc/data_version', 'rpc/shop_day', 'rpc/gaps', 'rpc/rpc_mark_day']) {
      const r = await handler(req(good, {}, { cookie: `__Host-dpv_at=${jwt(3600)}` }));
      expect(r.status, good).toBe(200);
    }
    for (const bad of ['rpc/_stock4', 'rpc/_rebase', 'rpc/farm_daily2', 'rpc/completeness', 'rpc/weekly_facts', 'rpc/digest_entries',
                       'rpc/mail_claim', 'rpc/mail_finish', 'rpc/digest_enqueue', 'rpc/mail_recipients', 'rpc/daily_checks']) {
      const r = await handler(req(bad, {}, { cookie: `__Host-dpv_at=${jwt(3600)}` }));
      expect(r.status, bad).toBe(404);
    }
    expect(calls).toHaveLength(4);
  });

  it('calls PostgREST with the cookie token', async () => {
    upstream = () => ok({ today: '2026-10-30' });
    const r = await handler(req('rpc/dashboard', { p_days: 90 }, { cookie: `__Host-dpv_at=${jwt(3600)}; __Host-dpv_rt=rt1` }));
    expect(r.status).toBe(200);
    expect(calls[0].url).toBe('https://proj.supabase.co/rest/v1/rpc/dashboard');
    expect(hdr(calls[0], 'Authorization')).toMatch(/^Bearer /);
    expect(setCookies(r)).toHaveLength(0);
  });

  it('refreshes an expiring token and sets new cookies', async () => {
    upstream = (url) => url.includes('/auth/v1/token') ? ok({ access_token: jwt(3600), refresh_token: 'rt2' }) : ok([]);
    const r = await handler(req('rpc/activity', {}, { cookie: `__Host-dpv_at=${jwt(30)}; __Host-dpv_rt=rt1` }));
    expect(r.status).toBe(200);
    expect(calls[0].url).toContain('grant_type=refresh_token');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ refresh_token: 'rt1' });
    expect(setCookies(r).some((c) => c.startsWith('__Host-dpv_rt=rt2;'))).toBe(true);
  });

  it('signs out when the refresh token is refused', async () => {
    upstream = () => ok({ error: 'invalid' }, 400);
    const r = await handler(req('rpc/dashboard', {}, { cookie: '__Host-dpv_rt=old' }));
    expect(r.status).toBe(401);
    expect(setCookies(r).every((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('turns the database session gate into codes the app acts on', async () => {
    upstream = () => ok({ code: '42501', message: 'AUTH_MFA: Enter the code from your authenticator app.' }, 403);
    let r = await handler(req('rpc/dashboard', {}, { cookie: `__Host-dpv_at=${jwt(3600)}` }));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ code: 'AUTH_MFA', error: 'Enter the code from your authenticator app.' });
    expect(setCookies(r)).toHaveLength(0);
    upstream = () => ok({ code: '42501', message: 'AUTH_SIGNED_OUT: Your session has ended. Sign in again.' }, 403);
    r = await handler(req('rpc/dashboard', {}, { cookie: `__Host-dpv_at=${jwt(3600)}` }));
    expect(setCookies(r).every((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('passes ordinary validation errors as plain messages', async () => {
    upstream = () => ok({ code: 'P0001', message: 'Only 30 eggs in stock' }, 400);
    const r = await handler(req('rpc/rpc_sale', {}, { cookie: `__Host-dpv_at=${jwt(3600)}` }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('Only 30 eggs in stock');
  });

  it('refuses oversized bodies', async () => {
    const r = await handler(req('rpc/rpc_sale', { x: 'a'.repeat(70_000) }, { cookie: `__Host-dpv_at=${jwt(3600)}` }));
    expect(r.status).toBe(413);
  });
});

describe('one-click opt-out link (no sign-in, no X-DPV)', () => {
  const S = '0b5d8c9e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', T = `v1.${'a'.repeat(64)}`;
  const link = (s = S, t = T) => `${ORIGIN}/api/gateway?r=optout&s=${s}&t=${t}`;

  it('GET only shows a confirm button, so a mail scanner opening the link changes nothing', async () => {
    const r = await handler(new Request(link(), { method: 'GET' }));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    const html = await r.text();
    expect(html).toContain('method="post"');
    expect(html).toContain(`s=${S}`);
    expect(calls).toHaveLength(0);
  });

  it('POST (the button, or a mail app\'s RFC 8058 one-click) forwards with the gateway secret and the client IP', async () => {
    upstream = () => ok({ ok: true, name: 'Jane' });
    const r = await handler(new Request(link(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': '41.90.1.9' },
                                                  body: 'List-Unsubscribe=One-Click' }));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Emails stopped');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://proj.supabase.co/functions/v1/digest-optout');
    expect(hdr(calls[0], 'x-dpv-gateway')).toBe('gw-secret');
    expect(hdr(calls[0], 'x-dpv-client-ip')).toBe('41.90.1.9');
    expect(hdr(calls[0], 'Authorization')).toBeUndefined();
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ staff: S, token: T });
  });

  it('refuses malformed links without calling Supabase, and passes on a refused token', async () => {
    for (const [s, t] of [['x', T], [S, 'v1.zz'], [S, 'a'.repeat(64)], [`${S}'`, T]]) {
      const r = await handler(new Request(link(s, t), { method: 'POST', body: '' }));
      expect(r.status, `${s} ${t}`).toBe(400);
    }
    expect(calls).toHaveLength(0);
    upstream = () => ok({ error: 'This link is not valid.' }, 400);
    const r = await handler(new Request(link(), { method: 'POST', body: '' }));
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('not valid');
  });

  it('never sets or reads session cookies', async () => {
    upstream = () => ok({ ok: true });
    const r = await handler(new Request(link(), { method: 'POST', headers: { cookie: '__Host-dpv_at=abc' }, body: '' }));
    expect(setCookies(r)).toHaveLength(0);
    expect(hdr(calls[0], 'Authorization')).toBeUndefined();
  });
});
