// Bot check shown after 3 failed attempts.
//
// Built in: a signed proof-of-work puzzle. The phone must find a number
// whose SHA-256 (with the server's random salt) starts with N zero bits;
// that takes a phone about a second, and makes scripted password guessing
// expensive. Each puzzle is tied to the caller's IP, expires after 2
// minutes and can be redeemed once. The difficulty rises with failures.
//
// Optional: Cloudflare Turnstile. Set the edge function secrets
// TURNSTILE_SITE_KEY and TURNSTILE_SECRET and it is used instead.
import { hmacHex, randomHex, safeEqual } from './util.ts';

export interface Puzzle { type: 'pow'; token: string; salt: string; bits: number; expires: number }
export interface TurnstileChallenge { type: 'turnstile'; site_key: string }
export type Challenge = Puzzle | TurnstileChallenge;
export interface Solution { type?: string; token?: string; nonce?: string }

const b64u = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

export const difficulty = (fails: number) => 17 + Math.max(0, Math.min(4, fails - 3));

export async function makePuzzle(key: string, ip: string, bits: number, now = Date.now()): Promise<Puzzle> {
  const salt = randomHex(16);
  const expires = now + 120_000;
  const body = b64u(JSON.stringify({ id: randomHex(12), salt, bits, exp: expires, ip: (await hmacHex(key, `ip:${ip}`)).slice(0, 16) }));
  return { type: 'pow', token: `${body}.${await hmacHex(key, body)}`, salt, bits, expires };
}

export function leadingZeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) { n += 8; continue; }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
}

/** Returns the puzzle id (to redeem once) if the solution is valid, else null. */
export async function checkPuzzle(key: string, ip: string, sol: Solution, now = Date.now()): Promise<{ id: string; exp: number } | null> {
  if (typeof sol.token !== 'string' || typeof sol.nonce !== 'string' || sol.nonce.length > 32) return null;
  const [body, sig] = sol.token.split('.');
  if (!body || !sig || !safeEqual(sig, await hmacHex(key, body))) return null;
  let p: { id: string; salt: string; bits: number; exp: number; ip: string };
  try { p = JSON.parse(unb64u(body)); } catch { return null; }
  if (p.exp < now) return null;
  if (!safeEqual(p.ip, (await hmacHex(key, `ip:${ip}`)).slice(0, 16))) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${p.salt}:${sol.nonce}`)));
  if (leadingZeroBits(digest) < p.bits) return null;
  return { id: p.id, exp: p.exp };
}

export const turnstileKeys = () => {
  const site = Deno.env.get('TURNSTILE_SITE_KEY'), secret = Deno.env.get('TURNSTILE_SECRET');
  return site && secret ? { site, secret } : null;
};

export async function checkTurnstile(secret: string, token: string, ip: string): Promise<boolean> {
  if (!token || token.length > 4096) return false;
  try {
    const form = new FormData();
    form.append('secret', secret); form.append('response', token);
    if (ip !== 'unknown') form.append('remoteip', ip);
    form.append('idempotency_key', crypto.randomUUID());
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return j.success === true;
  } catch { return false; }
}

