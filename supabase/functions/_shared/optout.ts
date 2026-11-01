// One-click opt-out links for the weekly digest and email nudges.
//
// The link carries the staff id and an HMAC of it under a server-only key
// (app_secrets.digest_optout_key, made on first use). Knowing the link is
// the permission: no sign-in is needed, and it can only switch emails OFF.
// Links do not expire, so an old email still unsubscribes.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { hmacHex, randomHex, safeEqual, secret } from './util.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TOKEN = /^v1\.[0-9a-f]{64}$/;

export async function optoutToken(db: SupabaseClient, staffId: string): Promise<string> {
  const key = await secret(db, 'digest_optout_key', () => randomHex(32));
  return 'v1.' + await hmacHex(key, `optout:${staffId}`);
}

export async function optoutValid(db: SupabaseClient, staffId: string, token: string): Promise<boolean> {
  if (!UUID.test(staffId) || !TOKEN.test(token)) return false;
  return safeEqual(token, await optoutToken(db, staffId));
}

/** The link put in every email; DPV_APP_URL is the app's public address (edge function secret). */
export async function optoutUrl(db: SupabaseClient, staffId: string): Promise<string> {
  const base = (Deno.env.get('DPV_APP_URL') ?? 'https://desert-pearl-poultry.vercel.app').replace(/\/$/, '');
  return `${base}/api/gateway?r=optout&s=${staffId}&t=${await optoutToken(db, staffId)}`;
}
