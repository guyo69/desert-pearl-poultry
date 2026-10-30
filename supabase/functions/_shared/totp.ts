// Time-based one-time passwords (RFC 6238: SHA-1, 6 digits, 30 s), as used
// by Google Authenticator, Microsoft Authenticator, Authy, 1Password etc.
// Secrets are stored encrypted (AES-256-GCM); backup codes as HMAC hashes.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function b32encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function b32decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export async function hotp(secret: Uint8Array, counter: number, digits = 6): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8), v = new DataView(msg);
  v.setUint32(0, Math.floor(counter / 2 ** 32)); v.setUint32(4, counter >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const STEP = 30;
export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP);

/**
 * Checks a 6-digit code, allowing one step of clock drift either way.
 * Returns the matching step (store it: a step may only be used once), or null.
 */
export async function totpCheck(secret: Uint8Array, code: string, now = Date.now(), lastStep = 0): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const t = stepAt(now);
  let found: number | null = null;
  for (const s of [t - 1, t, t + 1]) {
    // compare every candidate so timing does not reveal which one matched
    const c = await hotp(secret, s);
    let diff = 0;
    for (let i = 0; i < 6; i++) diff |= c.charCodeAt(i) ^ code.charCodeAt(i);
    if (diff === 0 && s > lastStep && found === null) found = s;
  }
  return found;
}

export const newSecret = () => crypto.getRandomValues(new Uint8Array(20));

export function otpauthUri(secretB32: string, account: string, issuer = 'Desert Pearl'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

// ---- encryption of stored secrets -------------------------------------------------
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(material: string) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(material: string, plain: Uint8Array, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, await aesKey(material), plain);
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}
export async function unseal(material: string, sealed: string, aad: string): Promise<Uint8Array> {
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(aad) }, await aesKey(material), unb64(ct));
  return new Uint8Array(pt);
}

// ---- backup codes --------------------------------------------------------------------
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';   // no 0/o, 1/l/i
export function newBackupCodes(n = 10): string[] {
  const codes: string[] = [];
  while (codes.length < n) {
    const r = crypto.getRandomValues(new Uint8Array(10));
    const s = [...r].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');  // 248 % 31 == 0: unbiased
    codes.push(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return codes;
}
export const normaliseBackupCode = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
