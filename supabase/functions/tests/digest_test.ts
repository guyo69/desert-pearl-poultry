// Unit tests for staff emails and the one-click opt-out:  deno test supabase/functions/tests
function assert(v: unknown, msg = 'assertion failed'): asserts v { if (!v) throw new Error(msg); }
function assertEquals(a: unknown, b: unknown, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
import { emailOf } from '../_shared/staff.ts';
import { optoutToken, optoutUrl, optoutValid } from '../_shared/optout.ts';

/** A stand-in for the service-role client: just enough of app_secrets for secret(). */
function fakeDb(store: Record<string, string> = {}) {
  return {
    store,
    from: () => ({
      select: () => ({ eq: (_c: string, key: string) => ({
        maybeSingle: async () => ({ data: store[key] ? { value: store[key] } : null, error: null }),
        single: async () => ({ data: { value: store[key] }, error: null }),
      }) }),
      insert: async (row: { key: string; value: string }) => { store[row.key] = row.value; return { error: null }; },
    }),
  } as unknown as Parameters<typeof optoutToken>[0];
}

Deno.test('staff email: trimmed, lowercased, blank clears, junk refused', () => {
  assertEquals(emailOf('  Jane.W@Example.CO.KE '), 'jane.w@example.co.ke');
  assertEquals(emailOf(''), null);
  assertEquals(emailOf(null), null);
  assertEquals(emailOf(undefined), undefined, 'not sent = keep');
  for (const bad of ['jane', 'jane@', '@x.co', 'jane@localhost', 'a b@x.co', 'jane@x..co', 42]) {
    let threw = false;
    try { emailOf(bad); } catch { threw = true; }
    assert(threw, `refused ${bad}`);
  }
});

Deno.test('opt-out link: stable per person, different between people, tamper-proof', async () => {
  const db = fakeDb();
  const a = '0b5d8c9e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', b = '1b5d8c9e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
  const ta = await optoutToken(db, a);
  assert(/^v1\.[0-9a-f]{64}$/.test(ta), 'token shape');
  assertEquals(await optoutToken(db, a), ta, 'same person, same link');
  assert(ta !== await optoutToken(db, b), 'different people, different links');
  assert(await optoutValid(db, a, ta), 'valid');
  assert(!await optoutValid(db, b, ta), 'cannot be reused for someone else');
  assert(!await optoutValid(db, a, ta.slice(0, -1) + (ta.endsWith('0') ? '1' : '0')), 'one changed character');
  assert(!await optoutValid(db, 'not-a-uuid', ta), 'bad id');
  const url = await optoutUrl(db, a);
  assert(url.endsWith(`/api/gateway?r=optout&s=${a}&t=${ta}`), url);
});
