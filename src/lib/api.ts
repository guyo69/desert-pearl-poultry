// Every call goes to the app's own gateway (/api/gateway). The session lives
// in HttpOnly cookies the page cannot read; nothing about it is stored here.
// Every write goes through a database function (rpc_*) that checks the
// person's role and validates the numbers; errors come back as plain sentences.
import type { ActivityRow, Dashboard } from './types';
import { drop, entries, heldBack, keep, newKey, QUEUEABLE, update, type Entry } from './outbox';

export class AppError extends Error {
  constructor(message: string, public code?: string, public status = 0, public data: Record<string, any> = {}) { super(message); }
}

/** Codes that mean "this session cannot be used for data now": the app re-checks its sign-in state. */
const AUTH_CODES = new Set(['SIGNED_OUT', 'AUTH_SIGNED_OUT', 'AUTH_INACTIVE', 'AUTH_MFA', 'AUTH_PASSWORD', 'AUTH_MFA_ENROLL']);
export const AUTH_EVENT = 'dpv-auth';
/** Ask the signed-in screen to reload the dashboard. */
export const RELOAD_EVENT = 'dpv-reload';
export const requestReload = () => dispatchEvent(new Event(RELOAD_EVENT));

async function call<T>(route: string, body?: Record<string, unknown>, method: 'POST' | 'GET' = 'POST', timeoutMs = 0): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/gateway?r=${route}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-DPV': '1' } : { 'X-DPV': '1' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: timeoutMs && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch {
    throw new AppError('No connection. Check the internet and try again.', 'OFFLINE');
  }
  let j: any = null;
  try { j = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new AppError(j?.error ?? 'Something went wrong. Try again.', j?.code, res.status, j ?? {});
    if (err.code && AUTH_CODES.has(err.code)) dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: err.code }));
    throw err;
  }
  return j as T;
}

// ---------------------------------------------------------------- entries that can wait on the phone
/** Thrown when an entry was kept on the phone to be sent later; forms show it as saved. */
export class QueuedError extends Error {
  constructor(public entry: Entry) { super('Saved on this phone. It will be sent as soon as there is a connection.'); }
}
let outboxUser: string | null = null, entryLabel = '';
/** Field staff only: their everyday entries go through the outbox. null turns it off. */
export const setOutboxUser = (id: string | null) => { outboxUser = id; };
/** The form being saved, so the waiting list can say what each entry is. */
export const setEntryLabel = (l: string) => { entryLabel = l; };
/** No connection, a timeout or the gateway not answering: worth sending again later. */
const unreachable = (e: unknown) => e instanceof AppError && (e.code === 'OFFLINE' || e.status >= 500);
/** Signed out in the meantime: keep the entry; it goes once the same person signs in again. */
const signedOut = (e: unknown) => e instanceof AppError && !!e.code && AUTH_CODES.has(e.code);
const send = (e: Entry) => call<unknown>('rpc/rpc_queued', { p_key: e.key, p_fn: e.fn, p_args: e.args, p_made_at: e.made_at }, 'POST', 25_000);

async function sendOrKeep<T>(fn: string, args: Record<string, unknown>, user: string): Promise<T> {
  const e: Entry = { key: newKey(), user, fn, args, label: entryLabel || 'Entry', made_at: new Date().toISOString(), status: 'waiting' };
  if (navigator.onLine) {
    try { return await send(e) as T; } catch (x) { if (!unreachable(x) && !signedOut(x)) throw x; }
  }
  try { await keep(e); } catch { throw new AppError('No connection, and this phone could not keep the entry. Write it down and enter it later.', 'OFFLINE'); }
  throw new QueuedError(e);
}

export const rpc = <T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> =>
  (outboxUser && QUEUEABLE.has(fn) ? sendOrKeep<T>(fn, args, outboxUser) : call<T>(`rpc/${fn}`, args));

let flushing: Promise<number> | null = null;
/**
 * Sends what waits on the phone for this person, oldest first. Stops at the
 * first sign of no connection; an entry the server refuses is marked with the
 * reason and kept for the person to see. Returns how many were recorded.
 */
export function flushOutbox(user: string): Promise<number> {
  if (!flushing) flushing = (async () => {
    let sent = 0;
    try {
      for (const e of await entries(user)) {
        if (e.status === 'failed') continue;
        if (heldBack(e)) { if (e.status !== 'held') await update(e.key, { status: 'held' }); continue; }
        try { await send(e); await drop(e.key); sent++; }
        catch (x) {
          if (unreachable(x) || signedOut(x)) break;
          await update(e.key, { status: 'failed', error: (x as Error).message });
        }
      }
    } finally { flushing = null; }
    if (sent) requestReload();
    return sent;
  })();
  return flushing;
}
export const auth = <T = any>(action: string, body: Record<string, unknown> = {}) => call<T>(`auth/${action}`, body);
export const staffAdmin = <T = any>(body: Record<string, unknown>) => call<T>('admin', body);
export const pushKey = () => call<{ public_key: string }>('push-key', undefined, 'GET');

export const loadDashboard = (days = 90) => rpc<Dashboard>('dashboard', { p_days: days });
/** A few bytes: the change counter and the business day. The dashboard is fetched only when they move. */
export const dataVersion = () => rpc<{ v: number; day: string }>('data_version');
/** Owner and farm manager: what was not entered on the last tracked days (the same check as the morning reminders). */
export interface Gap { day: string; label: string; scope: 'house' | 'farm' | 'outlet'; id: string; name: string; location_id: string; missing: string[] }
export const loadGaps = (days = 14) => rpc<Gap[]>('gaps', { p_days: days });
/** Owner and farm manager: the last 7 days to yesterday, from the weekly insight engine. */
export interface WeeklyInsight { kind: string; severity: 'red' | 'orange' | 'amber' | 'ok' | string; where: string; role: string; action: string; text: string }
export interface WeeklyReport {
  period: { from: string; to: string; label: string };
  baseline: { comparable: boolean; reason?: string };
  provisional?: boolean;
  completeness?: { pct?: number; entered?: number; expected?: number };
  insights: WeeklyInsight[];
}
export const loadWeeklyReport = () => rpc<WeeklyReport>('rpc_weekly_report');
/** Records newest day first (by the day they are for). `after` is the last row already shown. */
export const loadActivity = (p: { limit?: number; after?: ActivityRow | null; loc?: string | null; kind?: string | null }) =>
  rpc<ActivityRow[]>('activity', { p_limit: p.limit ?? 60, p_before: null, p_loc: p.loc ?? null, p_kind: p.kind ?? null,
    p_cursor: p.after ? { d: p.after.d, at: p.after.recorded_at, k: p.after.kind, id: p.after.id } : null });

export type AuthState = 'none' | 'expired' | 'inactive' | 'temp_expired' | 'set_password' | 'mfa_enroll' | 'mfa_verify' | 'ready';
export interface AuthUser { id: string; username: string; display_name: string; role: string; location_id: string | null; mfa_enabled: boolean; mfa_required: boolean; temp_expires_at: string | null;
  /** owner and farm manager: the confirmed recovery email (masked), and whether the server can send email */
  recovery?: { email: string | null; mail_ready: boolean } | null }
export interface AuthStatus { state: AuthState; user?: AuthUser; setup_needed?: boolean }
export const authStatus = () => auth<AuthStatus>('status');
export const signOut = (everywhere = false) => auth(everywhere ? 'logout_all' : 'logout').catch(() => null);

export interface SecurityEvent { at: string; kind: string; ok: boolean; reason: string | null; staff_id: string | null; display_name: string | null; username: string | null; ip: string | null; user_agent: string | null }
export const securityLog = (limit = 200, staff: string | null = null) => rpc<SecurityEvent[]>('security_log', { p_limit: limit, p_staff: staff });

/** Tokens and data from older versions of the app were kept in browser storage: remove them. */
export function forgetLegacyStorage() {
  try {
    for (const k of Object.keys(localStorage)) if (k === 'dpv-session' || k === 'dpv-dashboard' || k.startsWith('sb-')) localStorage.removeItem(k);
  } catch { /* storage blocked */ }
}
