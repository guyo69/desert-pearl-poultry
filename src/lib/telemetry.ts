// Problems seen on this phone, sent as short notes for the owner and farm
// manager (Settings, App problems): errors, a screen that could not open, a
// slow first screen or a slow tap. Only what went wrong and where: never form
// values or farm figures; emails and long numbers are blanked here and again
// on the server. At most one note of each kind per visit, sent in small batches.
import { rpcPlain } from './api';

declare const __APP_VERSION__: string;
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'local';

export interface Note { kind: 'error' | 'slow'; message: string; screen?: string; detail?: string; metric?: number }

/** Limits worth a note on a mid-range phone (web-vitals "poor" thresholds). */
export const SLOW = { firstScreenMs: 4000, tapMs: 500, figuresMs: 8000 };

export const scrub = (t: string, n: number) => t
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
  .replace(/\+?\d[\d\s-]{8,}\d/g, '[number]')
  .replace(/\d{5,}/g, '[number]')
  .slice(0, n);

export const deviceOf = (ua: string) => (/iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) ? 'iPad' : /android/i.test(ua) ? 'Android'
  : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Linux' : 'other');

/** Messages that are not faults of the app: no connection, signed out, the person's own mistakes the server explained. */
const ignore = (m: string) => /No connection|Failed to fetch|NetworkError|Load failed|session has ended|ResizeObserver loop|AbortError|The operation was aborted/i.test(m);

let screen = '', on = false, timer: number | undefined;
const seen = new Set<string>(), queue: Note[] = [];
export const setScreen = (s: string) => { screen = s; };

/** Keep a note to send; the same note is kept once per visit. */
export function note(n: Note) {
  if (!on || !n.message || ignore(n.message)) return;
  const k = `${n.kind}|${n.screen ?? screen}|${n.message.slice(0, 80)}`;
  if (seen.has(k) || seen.size > 40) return;
  seen.add(k);
  queue.push({ ...n, screen: n.screen ?? screen, message: scrub(n.message, 300), detail: n.detail ? scrub(n.detail, 1500) : undefined });
  clearTimeout(timer);
  timer = window.setTimeout(send, 5000);
}

function send() {
  if (!queue.length || !navigator.onLine) return;
  const batch = queue.splice(0, 10).map((n) => ({ ...n, app: APP_VERSION, device: deviceOf(navigator.userAgent) }));
  rpcPlain('rpc_log_client', { p: batch }).catch(() => {});
  if (queue.length) timer = window.setTimeout(send, 5000);
}

/** Start watching once someone is signed in (the notes need a session). Returns a stop function. */
export function startTelemetry(): () => void {
  if (on) return () => {};
  on = true;
  const err = (e: ErrorEvent) => note({ kind: 'error', message: String(e.message || e.error || 'Error'), detail: e.error?.stack ?? `${e.filename}:${e.lineno}` });
  const rej = (e: PromiseRejectionEvent) => { const r = e.reason; note({ kind: 'error', message: String(r?.message ?? r ?? 'Unhandled rejection'), detail: r?.stack }); };
  const hide = () => { if (document.visibilityState === 'hidden') send(); };
  addEventListener('error', err); addEventListener('unhandledrejection', rej); document.addEventListener('visibilitychange', hide);
  const obs: PerformanceObserver[] = [];
  try {
    // the first screen: largest paint after loading (LCP)
    let lcp = 0;
    const o1 = new PerformanceObserver((l) => { for (const e of l.getEntries()) lcp = e.startTime; });
    o1.observe({ type: 'largest-contentful-paint', buffered: true }); obs.push(o1);
    window.setTimeout(() => { if (lcp > SLOW.firstScreenMs) note({ kind: 'slow', message: 'First screen slow to show', metric: Math.round(lcp) }); o1.disconnect(); }, 15000);
    // taps: how long from the tap to the screen answering (as INP measures it)
    const o2 = new PerformanceObserver((l) => {
      for (const e of l.getEntries() as (PerformanceEventTiming & { interactionId?: number })[]) if (e.interactionId && e.duration > SLOW.tapMs) note({ kind: 'slow', message: 'Slow to answer a tap', metric: Math.round(e.duration), detail: `${e.name} on ${(e.target as Element | null)?.closest('button, a, input, select')?.textContent?.trim().slice(0, 40) ?? 'the screen'}` });
    });
    o2.observe({ type: 'event', buffered: true, durationThreshold: 104 } as PerformanceObserverInit); obs.push(o2);
  } catch { /* an older phone without these measures */ }
  return () => { on = false; removeEventListener('error', err); removeEventListener('unhandledrejection', rej); document.removeEventListener('visibilitychange', hide); obs.forEach((o) => o.disconnect()); send(); };
}
