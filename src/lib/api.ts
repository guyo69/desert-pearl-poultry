// Every write goes through a database function (rpc_*) that checks the
// person's role and validates the numbers; errors come back as plain sentences.
import { supabase } from './supabase';
import type { ActivityRow, Dashboard, Role } from './types';

export class AppError extends Error {}

function clean(msg: string | undefined): string {
  if (!msg) return 'Something went wrong. Try again.';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'No connection. Check the internet and try again.';
  if (/JWT|token/i.test(msg)) return 'Your session ended. Sign in again.';
  return msg;
}

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new AppError(clean(error.message));
  return data as T;
}

/** Calls an edge function and turns its { error } replies into AppErrors. */
export async function callFn<T = any>(name: string, body?: Record<string, unknown>, method: 'POST' | 'GET' = 'POST'): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body, method });
  if (error) {
    let msg = error.message;
    const res = (error as { context?: Response }).context;
    if (res && typeof res.json === 'function') {
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* not json */ }
    }
    throw new AppError(clean(msg));
  }
  if (data && typeof data === 'object' && 'error' in data && data.error) throw new AppError(String(data.error));
  return data as T;
}

export const loadDashboard = (days = 45) => rpc<Dashboard>('dashboard', { p_days: days });
export const loadActivity = (p: { limit?: number; before?: string | null; loc?: string | null; kind?: string | null }) =>
  rpc<ActivityRow[]>('activity', { p_limit: p.limit ?? 60, p_before: p.before ?? null, p_loc: p.loc ?? null, p_kind: p.kind ?? null });

export interface DirectoryEntry { id: string; display_name: string; role: Role; location_id: string | null; location_name: string | null }
export const staffDirectory = () => rpc<DirectoryEntry[]>('staff_directory');

export async function pinLogin(staffId: string, pin: string) {
  const r = await callFn<{ session: { access_token: string; refresh_token: string } }>('pin-login', { staff_id: staffId, pin });
  const { error } = await supabase.auth.setSession(r.session);
  if (error) throw new AppError(clean(error.message));
}
export const changePin = (current: string, next: string) => callFn('change-pin', { current_pin: current, new_pin: next });
export const staffAdmin = <T = any>(body: Record<string, unknown>) => callFn<T>('staff-admin', body);
export const signOut = () => supabase.auth.signOut();
