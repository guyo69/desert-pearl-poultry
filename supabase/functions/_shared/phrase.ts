// The phrasing layer: Claude rewrites the week's chosen insights in plain
// words. It phrases only the facts it is given; a validator checks every
// number against the facts and refuses banned phrasing. One retry, then the
// plain templates written by the database (weekly_facts) are used instead.
//
// Secrets: ANTHROPIC_API_KEY and ANTHROPIC_MODEL (no model is hard-coded;
// without both, the templates are used and nothing is sent to the API).

export interface Insight {
  kind: string; severity: string; where: string; role: string;
  numbers: Record<string, unknown>; action: string; text: string;
}
export interface Facts {
  period: { from: string; to: string; label: string };
  baseline: { comparable: boolean; reason?: string };
  provisional?: boolean;
  insights: Insight[];
  [k: string]: unknown;
}
export interface Phrased { paragraphs: string[]; subject: string; source: 'ai' | 'template'; problems: string[] }

export const SYSTEM_PROMPT = `You write the weekly report email for an egg farm and its shops in Kenya.
You receive JSON facts and an ordered list of insights. Write one short paragraph per insight, in the same order, and a subject line.

Rules:
- Phrase only the facts supplied. Do not find your own trends. Never use a number that is not in the facts.
- State the number, then what to do about it. Name the house or outlet, the day, and the role who acts.
- Keep each insight's action. Use plain "is", "are", "has". Short sentences of varied length.
- Write numbers as they appear in the facts. Thousands may have commas. Percentages keep their decimals.
- If data is missing, say exactly what is missing. Do not write around it.
- Mention a week-on-week comparison only when facts.baseline.comparable is true.
- If facts.provisional is true, say the figures are provisional in the first paragraph.
- Do not use em dashes or en dashes. Do not use exclamation marks.
- Never write: "it's worth noting", "highlights", "underscores", "showcasing", "robust", "positive trajectory",
  "continues to thrive", "overall, a solid week", "not just X but Y", "n/a".
- No lists of three adjectives, no significance inflation, no promotional tone, no stacked hedging.
- No greeting, no sign-off, no closing summary line.

Reply with JSON only: {"subject": "...", "paragraphs": ["...", "..."]}`;

const BANNED: [RegExp, string][] = [
  [/—/, 'em dash'], [/\s–\s/, 'en dash used as a dash'], [/!/, 'exclamation mark'],
  [/it(?:'|’)?s worth noting|it is worth noting/i, '"it\'s worth noting"'], [/\bhighlights?\b/i, '"highlights"'],
  [/\bunderscores?\b/i, '"underscores"'], [/\bshowcas(?:e|es|ing)\b/i, '"showcasing"'], [/\brobust\b/i, '"robust"'],
  [/positive trajectory/i, '"positive trajectory"'], [/continues to thrive/i, '"continues to thrive"'],
  [/overall,? a solid week/i, '"overall, a solid week"'], [/\bnot just\b[^.]*\bbut\b/i, '"not just X but Y"'],
  [/\bn\/a\b/i, '"n/a"'], [/^(?:overall|in summary|in conclusion|all in all)\b/im, 'closing summary line'],
];
const COMPARE = /week[- ]on[- ]week|than last week|from last week|compared (?:with|to) (?:last|the previous) week|up from|down from/i;
const NUM = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** Every number that appears anywhere in the facts, including inside strings ("Thu 15 Oct", "9am"). */
export function factNumbers(facts: unknown): Set<number> {
  const out = new Set<number>();
  const walk = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) { out.add(v); out.add(Math.abs(v)); }
    else if (typeof v === 'string') for (const m of v.match(NUM) ?? []) out.add(Number(m.replace(/,/g, '')));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(facts);
  return out;
}

/** Problems with a draft; empty when it may be sent. */
export function validate(paragraphs: string[], subject: string, facts: Facts): string[] {
  const problems: string[] = [];
  const known = factNumbers(facts);
  const all = [subject, ...paragraphs];
  if (paragraphs.length !== facts.insights.length) problems.push(`expected ${facts.insights.length} paragraphs, got ${paragraphs.length}`);
  for (const text of all) {
    for (const m of text.match(NUM) ?? []) {
      const n = Number(m.replace(/,/g, ''));
      if (![...known].some((k) => Math.abs(k - n) < 1e-9)) problems.push(`number ${m} is not in the facts`);
    }
    for (const [re, name] of BANNED) if (re.test(text)) problems.push(`uses ${name}`);
    if (!facts.baseline.comparable && COMPARE.test(text)) problems.push('compares with last week, but there is no valid prior week');
  }
  paragraphs.forEach((p, i) => { if (!p.trim()) problems.push(`paragraph ${i + 1} is empty`); });
  return [...new Set(problems)];
}

export function templateSubject(f: Facts): string {
  return `Desert Pearl weekly report, ${f.period.label}${f.provisional ? ' (provisional)' : ''}`;
}

async function ask(apiKey: string, model: string, facts: Facts, feedback: string[]): Promise<{ subject: string; paragraphs: string[] }> {
  const user = JSON.stringify({ facts, instructions: 'One paragraph per item in facts.insights, same order.' }) +
    (feedback.length ? `\n\nYour last draft was refused for: ${feedback.join('; ')}. Fix these and keep to the facts.` : '');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1200, temperature: 0.2, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}`);
  const j = await r.json();
  const text = (j.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude API: no JSON in the reply');
  const out = JSON.parse(m[0]);
  if (typeof out.subject !== 'string' || !Array.isArray(out.paragraphs) || out.paragraphs.some((p: unknown) => typeof p !== 'string')) {
    throw new Error('Claude API: reply not in the expected shape');
  }
  return { subject: out.subject.trim(), paragraphs: out.paragraphs.map((p: string) => p.trim()) };
}

/** Phrase the insights: Claude when configured and valid, else the database's templates. */
export async function phrase(facts: Facts, env: { apiKey?: string; model?: string } = {}): Promise<Phrased> {
  const template: Phrased = { paragraphs: facts.insights.map((i) => i.text), subject: templateSubject(facts), source: 'template', problems: [] };
  if (!facts.insights.length || !env.apiKey || !env.model) return template;
  let feedback: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const d = await ask(env.apiKey, env.model, facts, feedback);
      feedback = validate(d.paragraphs, d.subject, facts);
      if (!feedback.length) return { ...d, source: 'ai', problems: [] };
    } catch (e) {
      feedback = [e instanceof Error ? e.message : String(e)];
    }
  }
  return { ...template, problems: feedback };
}
