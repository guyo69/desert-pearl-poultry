// The digest email: the phrased insights, a short table of the week's key
// figures (taken straight from the facts), the attachment note and the
// one-click opt-out. Plain HTML with inline styles, plus a text version.
import { escapeHtml as h } from './mail.ts';
import type { Facts } from './phrase.ts';

const n = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v))) ? Number(v).toLocaleString('en-KE') : '');
type Row = [string, string];

/** Key figures in the reader's scope; only what the facts contain. */
export function keyFigures(f: Facts): Row[] {
  const rows: Row[] = [];
  const c = f.completeness as { pct?: number; entered?: number; expected?: number } | undefined;
  if (c?.expected) rows.push(['Daily records entered', `${n(c.entered)} of ${n(c.expected)} (${n(c.pct)}%)`]);
  const p = f.production as { trays?: number; laid?: number; damaged?: number; houses?: { name: string; lay_pct?: number; expected_pct?: number; entered_days: number }[] } | undefined;
  if (p) {
    rows.push(['Eggs laid', `${n(p.laid)} (${n(p.trays)} trays), ${n(p.damaged)} damaged`]);
    for (const x of p.houses ?? []) if (x.lay_pct !== undefined) rows.push([`${x.name} lay rate`, `${n(x.lay_pct)}% (expected ${n(x.expected_pct)}%, ${x.entered_days} days entered)`]);
  }
  const fd = f.feed as { used_bags?: number; stock_bags?: number; buffer_bags?: number; band?: string; water_l?: number } | undefined;
  if (fd) {
    rows.push(['Feed used', `${n(fd.used_bags)} bags`]);
    rows.push(['Feed in store', `${n(fd.stock_bags)} of ${n(fd.buffer_bags)} bags (${fd.band})`]);
    rows.push(['Water drunk', `${n(fd.water_l)} L`]);
  }
  const s = f.sales as { total_value?: number; total_trays?: number; outlets?: { name: string; value: number; trays: number; trading_days: number }[] } | undefined;
  if (s) {
    rows.push(['Sales', `KES ${n(s.total_value)} (${n(s.total_trays)} trays)`]);
    for (const o of s.outlets ?? []) rows.push([o.name, `KES ${n(o.value)}, ${n(o.trays)} trays, ${o.trading_days} trading days`]);
  }
  const m = f.money as { cash_counts?: { name: string; total_diff: number; counts: number }[] } | undefined;
  for (const x of m?.cash_counts ?? []) rows.push([`Cash counts, ${x.name}`, `${x.counts} counted, KES ${n(Math.abs(x.total_diff))} ${x.total_diff < 0 ? 'short' : x.total_diff > 0 ? 'over' : 'off'}`]);
  return rows;
}

export function digestEmail(o: { name: string; scopeLabel: string; facts: Facts; paragraphs: string[]; optout: string; attachmentName: string; appUrl: string }) {
  const first = o.name.split(/\s+/)[0] || o.name;
  const rows = keyFigures(o.facts);
  const intro = `Your weekly report for ${o.scopeLabel}, ${o.facts.period.label}.`;
  const note = `The attached spreadsheet (${o.attachmentName}) has every entry for the week.`;
  const text = [`Hello ${first},`, '', intro, '', ...o.paragraphs.flatMap((p) => [p, '']),
    ...(rows.length ? ['Key figures', ...rows.map(([a, b]) => `- ${a}: ${b}`), ''] : []),
    note, `Open the app: ${o.appUrl}`, '', `Stop these emails: ${o.optout}`].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f2f2f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c1c1e">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">
<p style="margin:0 0 12px;font-size:15px">Hello ${h(first)},</p>
<p style="margin:0 0 16px;font-size:15px;color:#6e6e73">${h(intro)}</p>
${o.paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5">${h(p)}</p>`).join('\n')}
${rows.length ? `<h3 style="margin:20px 0 8px;font-size:15px">Key figures</h3><table style="width:100%;border-collapse:collapse;font-size:14px">${
  rows.map(([a, b]) => `<tr><td style="padding:6px 8px 6px 0;border-top:1px solid #e5e5ea;color:#6e6e73">${h(a)}</td><td style="padding:6px 0;border-top:1px solid #e5e5ea;text-align:right">${h(b)}</td></tr>`).join('')}</table>` : ''}
<p style="margin:18px 0 6px;font-size:14px">${h(note)}</p>
<p style="margin:0 0 18px;font-size:14px"><a href="${h(o.appUrl)}" style="color:#248a3d">Open the app</a></p>
<p style="margin:0;font-size:12px;color:#8e8e93">Desert Pearl Ventures Ltd · Tuala Farm Fresh Eggs. <a href="${h(o.optout)}" style="color:#8e8e93">Stop these emails</a></p>
</div></body></html>`;
  return { html, text };
}

export function nudgeEmail(o: { name: string; dayLabel: string; items: { title: string; body: string }[]; optout: string; appUrl: string }) {
  const first = o.name.split(/\s+/)[0] || o.name;
  const subject = `Missing entries for ${o.dayLabel}`;
  const text = [`Hello ${first},`, '', `These records for ${o.dayLabel} are not in the app yet:`, '',
    ...o.items.flatMap((i) => [`- ${i.title}. ${i.body}`]), '', `Open the app: ${o.appUrl}`, '', `Stop these emails: ${o.optout}`].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f2f2f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c1c1e">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">
<p style="margin:0 0 12px;font-size:15px">Hello ${h(first)},</p>
<p style="margin:0 0 12px;font-size:15px">These records for ${h(o.dayLabel)} are not in the app yet:</p>
<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.5">${o.items.map((i) => `<li><b>${h(i.title)}.</b> ${h(i.body)}</li>`).join('')}</ul>
<p style="margin:0 0 18px;font-size:14px"><a href="${h(o.appUrl)}" style="color:#248a3d">Open the app</a></p>
<p style="margin:0;font-size:12px;color:#8e8e93"><a href="${h(o.optout)}" style="color:#8e8e93">Stop these emails</a></p>
</div></body></html>`;
  return { subject, html, text };
}
