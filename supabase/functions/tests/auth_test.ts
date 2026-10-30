// Unit tests for the sign-in building blocks:  deno test supabase/functions/tests
function assert(v: unknown, msg = 'assertion failed'): asserts v { if (!v) throw new Error(msg); }
function assertEquals(a: unknown, b: unknown, msg = '') {
  const j = (x: unknown) => JSON.stringify(x instanceof Uint8Array ? [...x] : x);
  if (j(a) !== j(b)) throw new Error(`${msg} expected ${j(b)}, got ${j(a)}`);
}
import { b32decode, b32encode, hotp, newBackupCodes, normaliseBackupCode, seal, totpCheck, unseal } from '../_shared/totp.ts';
import { breachCount, checkLocal, checkPassword } from '../_shared/policy.ts';
import { checkPuzzle, leadingZeroBits, makePuzzle } from '../_shared/challenge.ts';
import { safeEqual } from '../_shared/util.ts';

const RFC = new TextEncoder().encode('12345678901234567890');

Deno.test('TOTP matches RFC 6238 vectors (SHA-1)', async () => {
  assertEquals(await hotp(RFC, Math.floor(59 / 30), 8), '94287082');
  assertEquals(await hotp(RFC, Math.floor(1111111109 / 30), 8), '07081804');
  assertEquals(await hotp(RFC, Math.floor(20000000000 / 30), 8), '65353130');
});

Deno.test('TOTP accepts ±1 step, refuses replays and junk', async () => {
  const now = 1_700_000_000_000, step = Math.floor(now / 30000);
  const code = await hotp(RFC, step);
  assertEquals(await totpCheck(RFC, code, now), step);
  assertEquals(await totpCheck(RFC, await hotp(RFC, step - 1), now), step - 1);
  assertEquals(await totpCheck(RFC, await hotp(RFC, step - 2), now), null);
  assertEquals(await totpCheck(RFC, code, now, step), null, 'same step twice');
  assertEquals(await totpCheck(RFC, '12345', now), null);
  assertEquals(await totpCheck(RFC, 'abcdef', now), null);
});

Deno.test('base32 round trip and secret sealing', async () => {
  const raw = crypto.getRandomValues(new Uint8Array(20));
  assertEquals(b32decode(b32encode(raw)), raw);
  assertEquals(b32encode(RFC), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const sealed = await seal('key', raw, 'staff-1');
  assertEquals(await unseal('key', sealed, 'staff-1'), raw);
  let threw = false;
  try { await unseal('key', sealed, 'staff-2'); } catch { threw = true; }
  assert(threw, 'a secret cannot be moved to another account');
});

Deno.test('backup codes', () => {
  const codes = newBackupCodes();
  assertEquals(codes.length, 10);
  assertEquals(new Set(codes).size, 10);
  for (const c of codes) assert(/^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c), c);
  assertEquals(normaliseBackupCode(' ABCDE-fghjk '), 'abcdefghjk');
});

Deno.test('password policy: rejects weak, common and personal passwords', () => {
  const bad = ['password123', '123456789', 'Password123!', 'P@ssw0rd!', 'Qwerty2026#', 'Abc12345!', 'Short1!', 'alllowercase1!',
               'NoNumbers!!', 'NoSymbols123', 'Sunshine!88', 'Tuala#2026x', 'Aaaa1111!x', 'Van#Driver77', 'Desertpearl1!'];
  for (const pw of bad) assert(checkLocal(pw, { username: 'van', displayName: 'Van Driver' }).length > 0, `should reject ${pw}`);
  for (const pw of ['Kuku-Mbili-Rafu9!', 'Mvua#Ya-Jioni42', 'Gr33n*Tr4ys&Sun']) {
    assertEquals(checkLocal(pw, { username: 'van', displayName: 'Van Driver' }), [], pw);
  }
});

Deno.test('HIBP k-anonymity: only the 5-character prefix is sent; padding rows ignored', async () => {
  let asked = '';
  // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
  const fake = ((url: string) => {
    asked = url;
    return Promise.resolve(new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:9659365\r\n0000000000000000000000000000000000A:0'));
  }) as unknown as typeof fetch;
  assertEquals(await breachCount('password', fake), 9659365);
  assert(asked.endsWith('/range/5BAA6'), asked);
  const down = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
  assertEquals(await breachCount('x', down), null);
  const r = await checkPassword('Kuku-Mbili-Rafu9!', {}, ((u: string) =>
    u.includes('pwnedpasswords') ? Promise.resolve(new Response('ABC:1')) : Promise.reject(new Error('no list'))) as unknown as typeof fetch);
  assert(r.ok && r.hibp === 'checked', JSON.stringify(r));
});

Deno.test('proof-of-work puzzle: valid once solved, bound to IP, expires', async () => {
  const p = await makePuzzle('k', '1.2.3.4', 8, 1000);
  let nonce = 0;
  for (;; nonce++) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${p.salt}:${nonce}`)));
    if (leadingZeroBits(d) >= 8) break;
  }
  assert(await checkPuzzle('k', '1.2.3.4', { token: p.token, nonce: String(nonce) }, 2000));
  assertEquals(await checkPuzzle('k', '9.9.9.9', { token: p.token, nonce: String(nonce) }, 2000), null, 'other IP');
  assertEquals(await checkPuzzle('k', '1.2.3.4', { token: p.token, nonce: String(nonce) }, 200_000), null, 'expired');
  assertEquals(await checkPuzzle('other-key', '1.2.3.4', { token: p.token, nonce: String(nonce) }, 2000), null, 'forged');
  assertEquals(leadingZeroBits(new Uint8Array([0, 0x10])), 11);
});

Deno.test('constant-time compare', () => {
  assert(safeEqual('abc', 'abc'));
  assert(!safeEqual('abc', 'abd'));
  assert(!safeEqual('abc', 'abcd'));
});
