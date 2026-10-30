// Every call goes to the app's own gateway (/api/gateway). The session lives
// in HttpOnly cookies the page cannot read; nothing about it is stored here.
// Every write goes through a database function (rpc_*) that checks the
// person's role and validates the numbers; errors come back as plain sentences.
import type { ActivityRow, Dashboard } from './types';

export class AppError extends Error {
  constructor(message: string, public code?: string, public status = 0, public data: Record<string, any> = {}) { super(message); }
}

/** Codes that mean "this session cannot be used for data now": the app re-checks its sign-in state. */
const AUTH_CODES = new Set(['SIGNED_OUT', 'AUTH_SIGNED_OUT', 'AUTH_INACTIVE', 'AUTH_MFA', 'AUTH_PASSWORD', 'AUTH_MFA_ENROLL']);
export const AUTH_EVENT = 'dpv-auth';
/** Ask the signed-in screen to reload the dashboard. */
export const RELOAD_EVENT = 'dpv-reload';
export const requestReload = () => dispatchEvent(new Event(RELOAD_EVENT));

async function call<T>(route: string, body?: Record<string, unknown>, method: 'POST' | 'GET' = 'POST'): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/gateway?r=${route}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-DPV': '1' } : { 'X-DPV': '1' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
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

export const rpc = <T = unknown>(fn: string, args: Record<string, unknown> = {}) => call<T>(`rpc/${fn}`, args);
export const auth = <T = any>(action: string, body: Record<string, unknown> = {}) => call<T>(`auth/${action}`, body);
export const staffAdmin = <T = any>(body: Record<string, unknown>) => call<T>('admin', body);
export const pushKey = () => call<{ public_key: string }>('push-key', undefined, 'GET');

export const loadDashboard = (days = 90) => rpc<Dashboard>('dashboard', { p_days: days });
export const loadActivity = (p: { limit?: number; before?: string | null; loc?: string | null; kind?: string | null }) =>
  rpc<ActivityRow[]>('activity', { p_limit: p.limit ?? 60, p_before: p.before ?? null, p_loc: p.loc ?? null, p_kind: p.kind ?? null });

export type AuthState = 'none' | 'expired' | 'inactive' | 'temp_expired' | 'set_password' | 'mfa_enroll' | 'mfa_verify' | 'ready';
export interface AuthUser { id: string; username: string; display_name: string; role: string; location_id: string | null; mfa_enabled: boolean; mfa_required: boolean; temp_expires_at: string | null }
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
