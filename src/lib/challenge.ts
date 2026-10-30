// The bot check shown after 3 failed sign-in attempts: the built-in puzzle
// (solved by this device in about a second) or Cloudflare Turnstile when the
// server is set up for it.
import { auth } from './api';

export type Challenge = { type: 'pow'; token: string; salt: string; bits: number; expires: number } | { type: 'turnstile'; site_key: string };
export interface Solution { type: string; token: string; nonce?: string }

export const getChallenge = (username: string) => auth<{ challenge: Challenge }>('challenge', { username }).then((r) => r.challenge);

export function solvePuzzle(c: Extract<Challenge, { type: 'pow' }>, onProgress?: (p: number) => void): Promise<Solution> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' });
    const stop = setTimeout(() => { w.terminate(); reject(new Error('The security check took too long. Try again.')); }, 90_000);
    w.onmessage = (e) => {
      if (e.data.progress !== undefined) { onProgress?.(Math.min(0.95, e.data.progress)); return; }
      clearTimeout(stop); w.terminate();
      resolve({ type: 'pow', token: c.token, nonce: e.data.nonce });
    };
    w.onerror = () => { clearTimeout(stop); w.terminate(); reject(new Error('The security check could not run on this browser.')); };
    w.postMessage({ salt: c.salt, bits: c.bits });
  });
}

declare global {
  interface Window { turnstile?: { render: (el: HTMLElement, o: Record<string, unknown>) => string; remove: (id: string) => void } }
}
let turnstileScript: Promise<void> | null = null;
export function loadTurnstile(): Promise<void> {
  turnstileScript ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { turnstileScript = null; reject(new Error('Could not load the security check. Check the connection.')); };
    document.head.appendChild(s);
  });
  return turnstileScript;
}
