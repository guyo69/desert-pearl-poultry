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

// ---------- phrasing: validator, retry, template fallback ----------
import { factNumbers, phrase, validate, type Facts } from '../_shared/phrase.ts';
import { xlsx, serial } from '../_shared/xlsx.ts';
import { digestEmail, keyFigures } from '../_shared/digest_email.ts';

const FACTS: Facts = {
  period: { from: '2026-10-12', to: '2026-10-18', label: 'Mon 12 Oct to Sun 18 Oct' },
  baseline: { comparable: false, reason: 'first_week' },
  provisional: true,
  completeness: { entered: 3, expected: 5, pct: 60, gaps: [] },
  sales: { total_value: 464000, total_trays: 464, outlets: [] },
  insights: [
    { kind: 'completeness', severity: 'red', where: 'Rayan Fedha, Lucky Summer', role: 'Each outlet attendant',
      numbers: { entered: 3, expected: 5, pct: 60 }, action: "Enter the previous day's figures by 9am every day.",
      text: "Only 3 of 5 daily records were entered this week (60%). Missing: Rayan Fedha on Thu 15 Oct, Fri 16 Oct (sales). Every figure in this email is provisional. Please enter the previous day's figures by 9am every day." },
    { kind: 'baseline', severity: 'info', where: 'this week', role: 'everyone', numbers: {},
      action: 'Keep entering every day so next week can be compared with this one.',
      text: 'There is no full prior week yet, so treat this week as the baseline. Keep entering every day so next week can be compared with this one.' },
  ],
};
const GOOD = ['Only 3 of 5 outlets entered Thursday 15 and Friday 16, so the 464 trays is probably low. Please have every outlet enter the previous day\'s figures by 9am.',
              'There is no full prior week yet, so treat this as the baseline.'];

Deno.test('validator: numbers must come from the facts', () => {
  assert(factNumbers(FACTS).has(464) && factNumbers(FACTS).has(9) && factNumbers(FACTS).has(15), 'numbers inside strings count');
  assertEquals(validate(GOOD, 'Weekly report, Mon 12 Oct to Sun 18 Oct', FACTS), []);
  assert(validate(['Egg output rose 37% to 464 trays.', GOOD[1]], 's', FACTS).some((p) => p.includes('37')), 'invented 37% refused');
  assert(validate(['Sales were 464,000 shillings.', GOOD[1]], 's', FACTS).length === 0, 'thousands separators accepted');
});

Deno.test('validator: banned phrasing and false comparisons', () => {
  const bad = (t: string) => validate([t, GOOD[1]], 's', FACTS);
  for (const t of ['A robust week at 464 trays.', 'This highlights the gap.', 'It\'s worth noting that 3 of 5 entered.', 'Great week!',
                   'Sales were 464 trays — low.', 'Egg output rose n/a week on week to 464 trays.', 'Not just sales but stock.',
                   'Sales were down from last week.', 'Overall, a solid week.']) {
    assert(bad(t).length > 0, `refused: ${t}`);
  }
  assert(validate([GOOD[0]], 's', FACTS).some((p) => p.startsWith('expected 2 paragraphs')), 'one paragraph per insight');
});

function fakeClaude(replies: string[]) {
  const calls: { body: { model: string; system: string } }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)) });
    const text = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

Deno.test('phrase: a valid draft is used, the model name comes from the environment', async () => {
  const f = fakeClaude([JSON.stringify({ subject: 'Weekly report, Mon 12 Oct to Sun 18 Oct', paragraphs: GOOD })]);
  try {
    const r = await phrase(FACTS, { apiKey: 'k', model: 'model-from-secret' });
    assertEquals(r.source, 'ai'); assertEquals(r.paragraphs, GOOD);
    assertEquals(f.calls[0].body.model, 'model-from-secret');
    assert(f.calls[0].body.system.includes('Never use a number that is not in the facts'), 'rules in the system prompt');
  } finally { f.restore(); }
});

Deno.test('phrase: one retry, then the plain templates', async () => {
  const bad = JSON.stringify({ subject: 'A robust week!', paragraphs: ['Egg output rose 12% to 464 trays.', 'x'] });
  const f = fakeClaude([bad, bad]);
  try {
    const r = await phrase(FACTS, { apiKey: 'k', model: 'm' });
    assertEquals(f.calls.length, 2, 'regenerated once');
    assertEquals(r.source, 'template');
    assertEquals(r.paragraphs, FACTS.insights.map((i) => i.text));
    assert(r.subject.includes('provisional'), 'template subject marks provisional');
  } finally { f.restore(); }
  const g = fakeClaude([bad, JSON.stringify({ subject: 'Weekly report', paragraphs: GOOD })]);
  try { assertEquals((await phrase(FACTS, { apiKey: 'k', model: 'm' })).source, 'ai', 'the retry can succeed'); } finally { g.restore(); }
});

Deno.test('phrase: without a key or model nothing is sent and the templates are used', async () => {
  const f = fakeClaude(['{}']);
  try {
    assertEquals((await phrase(FACTS, { model: 'm' })).source, 'template');
    assertEquals((await phrase(FACTS, { apiKey: 'k' })).source, 'template');
    assertEquals(f.calls.length, 0);
  } finally { f.restore(); }
});

Deno.test('the templates themselves pass the validator', () => {
  assertEquals(validate(FACTS.insights.map((i) => i.text), 'Desert Pearl weekly report, Mon 12 Oct to Sun 18 Oct (provisional)', FACTS), []);
});

Deno.test('xlsx: a zip with one sheet per part and Excel dates', () => {
  const b = xlsx([{ name: 'Sales', columns: ['Date', 'Value'], rows: [['2026-10-12', 9000]] }]);
  assert(b[0] === 0x50 && b[1] === 0x4b, 'zip signature');
  assertEquals(serial('1900-03-01'), 61); assertEquals(serial('2026-10-12'), 46307);
  assert(xlsx([]).length > 0, 'an empty week still gives a workbook');
});

Deno.test('digest email: key figures from the facts, opt-out link, no raw HTML from data', () => {
  const m = digestEmail({ name: 'Jane <b>W</b>', scopeLabel: 'Rayan Fedha', facts: FACTS, paragraphs: GOOD, optout: 'https://x/api/gateway?r=optout&s=1&t=2', attachmentName: 'a.xlsx', appUrl: 'https://x' });
  assert(m.html.includes('Jane &#60;b&#62;W&#60;/b&#62;') === false && m.html.includes('Hello Jane,'), 'first name only, escaped');
  assert(m.html.includes('r=optout&#38;s=1&#38;t=2') && m.text.includes('Stop these emails: https://x/api/gateway?r=optout&s=1&t=2'), 'opt-out link');
  assert(keyFigures(FACTS).some(([a, b]) => a === 'Sales' && b.includes('464,000')), 'figures formatted');
  assert(!/—|!/.test(m.text.replace('Stop these emails', '')), 'no em dash or exclamation in the email body');
});
