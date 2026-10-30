// Password rules, enforced here on the server (the app's strength meter
// only guides people; this is what decides).
//
//  * 8 to 128 characters
//  * at least one lowercase letter, one uppercase letter, one number and one symbol
//  * not one of the 10,000 most common passwords, nor a common password
//    dressed up with capitals, numbers, symbols or look-alike characters
//    ("Password123!", "P@ssw0rd", "Qwerty2026#")
//  * no runs like 123456, abcdef or qwerty
//  * not containing the person's username or name, or the farm's name
//  * not found in a known data breach (Have I Been Pwned, k-anonymity:
//    only the first 5 characters of the SHA-1 hash ever leave the server)
import top1000 from './common-top1000.ts';

const LIST_URLS = [
  'https://cdn.jsdelivr.net/npm/@zxcvbn-ts/language-common@3.0.4/src/passwords.json',
  'https://unpkg.com/@zxcvbn-ts/language-common@3.0.4/src/passwords.json',
];
// SHA-256 of that exact file, so a tampered download is never used
const LIST_SHA256 = 'f422773d94d630f27e08b26d7017e847bb1feb2a84809340e9c0b0c47b33e3f1';
const TOP = 10_000;

let common: Set<string> | null = null;
let commonSource: 'top10000' | 'top1000' = 'top1000';
let loading: Promise<void> | null = null;

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Loads the top-10,000 list once per function instance (falls back to the built-in top 1,000). */
export function loadCommon(fetcher: typeof fetch = fetch): Promise<void> {
  if (common && commonSource === 'top10000') return Promise.resolve();
  loading ??= (async () => {
    for (const url of LIST_URLS) {
      try {
        const r = await fetcher(url, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) continue;
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (await sha256Hex(bytes) !== LIST_SHA256) continue;
        const all: string[] = JSON.parse(new TextDecoder().decode(bytes));
        common = new Set(all.slice(0, TOP));
        commonSource = 'top10000';
        return;
      } catch { /* try the next mirror */ }
    }
    common = new Set(top1000);
    commonSource = 'top1000';
    loading = null;   // try the download again next time
  })();
  return loading;
}
export const commonListSource = () => commonSource;

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '|': 'l', '+': 't' };
const unleet = (s: string) => s.replace(/[0134578@$!|+9]/g, (c) => LEET[c] ?? c);

/** The "core" of a password: lowercase, without leading/trailing digits and symbols. */
const core = (s: string) => s.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');

// a targeted guesser tries the business names first: never allowed anywhere in the password
const FARM_NAMES = ['desertpearl', 'tuala', 'kagundo'];
// generic words: not allowed as the whole "core" of a password
const FARM_WORDS = ['desert', 'pearl', 'poultry', 'eggs', 'farm', 'kuku', 'mayai', 'mpesa', 'safaricom', 'password', 'kenya', 'nairobi'];

const RUNS = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1qaz2wsx3edc'];
function hasRun(pw: string, len = 5): boolean {
  const s = pw.toLowerCase();
  for (const run of RUNS) {
    for (const r of [run, [...run].reverse().join('')]) {
      for (let i = 0; i + len <= r.length; i++) if (s.includes(r.slice(i, i + len))) return true;
    }
  }
  return /(.)\1{3,}/.test(s);   // aaaa, 1111
}

export interface PolicyContext { username?: string; displayName?: string }
export interface PolicyResult { ok: boolean; problems: string[]; breached?: number; hibp: 'checked' | 'unavailable' | 'skipped' }

/** Rules that need no network (also used to explain problems before calling HIBP). */
export function checkLocal(pw: string, ctx: PolicyContext = {}): string[] {
  const p: string[] = [];
  if (pw.length < 8) p.push('Use at least 8 characters.');
  if (pw.length > 128) p.push('Use at most 128 characters.');
  if (!/[a-z]/.test(pw)) p.push('Add a lowercase letter.');
  if (!/[A-Z]/.test(pw)) p.push('Add a capital letter.');
  if (!/[0-9]/.test(pw)) p.push('Add a number.');
  if (!/[^A-Za-z0-9]/.test(pw)) p.push('Add a symbol, like ! # * or %.');

  const set = common ?? new Set(top1000);
  const lower = pw.toLowerCase();
  const variants = new Set([lower, unleet(lower), core(pw), core(unleet(lower)), unleet(core(pw))]);
  if ([...variants].some((v) => v.length >= 3 && set.has(v))) p.push('This is one of the most common passwords. Choose something less predictable.');
  else if ([...variants].some((v) => FARM_WORDS.includes(v)) || FARM_NAMES.some((w) => unleet(lower).replace(/[^a-z]/g, '').includes(w))) {
    p.push('Do not build your password around the farm’s or business’s name.');
  }

  if (hasRun(pw)) p.push('Avoid runs and repeats like 12345, abcde, qwerty or 1111.');

  const flat = unleet(lower).replace(/[^a-z0-9]/g, '');
  const mine = [ctx.username ?? '', ...(ctx.displayName ?? '').split(/\s+/)]
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length >= 3);
  if (mine.some((w) => flat.includes(w) || lower.includes(w))) p.push('Do not use your name or username in your password.');
  return p;
}

/** Number of times the password appears in known breaches (0 = not found), or null if HIBP is unreachable. */
export async function breachCount(pw: string, fetcher: typeof fetch = fetch): Promise<number | null> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(pw));
  const h = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  try {
    const r = await fetcher(`https://api.pwnedpasswords.com/range/${h.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'DesertPearl-PoultryManager' },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    for (const line of (await r.text()).split('\n')) {
      const [suffix, count] = line.trim().split(':');
      if (suffix === h.slice(5)) return Number(count) || 0;   // padding rows have count 0
    }
    return 0;
  } catch { return null; }
}

export async function checkPassword(pw: string, ctx: PolicyContext = {}, fetcher: typeof fetch = fetch): Promise<PolicyResult> {
  await loadCommon(fetcher);
  const problems = checkLocal(pw, ctx);
  if (problems.length) return { ok: false, problems, hibp: 'skipped' };
  const n = await breachCount(pw, fetcher);
  if (n === null) return { ok: true, problems: [], hibp: 'unavailable' };   // the local rules still applied
  if (n > 0) {
    return { ok: false, breached: n, hibp: 'checked',
      problems: [`This password has appeared ${n.toLocaleString('en-KE')} time${n === 1 ? '' : 's'} in leaked password lists. Choose a different one.`] };
  }
  return { ok: true, problems: [], hibp: 'checked' };
}
