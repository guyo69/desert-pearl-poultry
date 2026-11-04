// The weekly farm report: the last 7 days to yesterday, written as a report a
// manager can act on. Figures come from the records; each flock is judged
// against the breed guide for its age (knowledge.ts) and the farm's own target
// when that target is realistic. Days nobody entered are reported once, in the
// data coverage section, and never stand in as zero.
import type { WeeklyInsight, WeeklyReport } from './api';
import { addDays, dshort, kes, n0, pct, range } from './format';
import { GUIDE, expectedLay, guideFits, realisticTarget, stage, weeklyMortality } from './knowledge';
import { feedInfo, houseAge, layRate, locName, tot, weekMetrics } from './metrics';
import type { Dashboard, House } from './types';

export type Sev = 'red' | 'orange' | 'amber' | 'ok' | 'info';
export interface ReportFinding { sev: Sev; title: string; text: string; action?: string; who?: string; area: string }
export interface FlockRow {
  id: string; name: string; breed: string; hens: number; age: number; stage: string;
  lay: number; days: number; guide: number | null; target: number | null; beyond: boolean;
  deaths: number; mortPct: number; mortGuide: number; waterMl: number;
}
export interface Coverage { entered: number; expected: number; pct: number; gaps: { where: string; days: string[]; missing: string[] }[] }
export interface WeekReport {
  period: string; from: string; to: string; comparable: boolean; reason: string;
  coverage: Coverage | null; summary: string[]; findings: ReportFinding[]; flocks: FlockRow[];
  actions: { priority: 'High' | 'Medium' | 'Low'; text: string; who: string }[];
  guideNote: string;
}

const pts = (a: number, b: number) => `${Math.abs(Math.round((a - b) * 1000) / 10)} points`;
const plural = (n: number, one: string, many = `${one}s`) => `${n0(n)} ${n === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const SEV_RANK: Record<Sev, number> = { red: 0, orange: 1, amber: 2, info: 3, ok: 4 };

/** One flock's week: lay on the days entered, deaths, water, against the guide for its age. */
export function flockWeek(D: Dashboard, h: House, days: string[]): FlockRow {
  const set = new Set(days);
  const rows = D.farm_daily.filter((r) => r.house_id === h.id && set.has(r.d));
  const laidDays = rows.filter((r) => tot(r) + (r.dmg ?? 0) > 0);
  const hens = rows.length ? rows[rows.length - 1].hens - rows[rows.length - 1].deaths : h.birds_at_start;
  const age = houseAge(D, h);
  const fit = guideFits(h.breed);
  const g = fit === 'no' ? null : expectedLay(age);
  const deaths = rows.reduce((a, r) => a + r.deaths, 0);
  const avgHens = rows.length ? rows.reduce((a, r) => a + r.hens, 0) / rows.length : hens;
  const waterDays = new Set(D.water_daily.filter((w) => w.house_id === h.id && set.has(w.d) && w.litres > 0).map((w) => w.d));
  const water = D.water_daily.filter((w) => w.house_id === h.id && waterDays.has(w.d)).reduce((a, w) => a + w.litres, 0);
  return {
    id: h.id, name: h.name, breed: h.breed?.trim() || '', hens, age, stage: stage(age),
    lay: layRate(D, days, h.id), days: laidDays.length, guide: g ? g.rate : null, beyond: !!g?.beyond,
    target: realisticTarget(h.expected_lay) ? h.expected_lay : null,
    deaths, mortPct: avgHens ? deaths / avgHens : 0, mortGuide: weeklyMortality(age),
    waterMl: waterDays.size && avgHens ? (water / waterDays.size / avgHens) * 1000 : NaN,
  };
}

/** Rewrites one finding from the server's insight engine in report language. Returns null for those the report covers itself. */
function fromEngine(x: WeeklyInsight & { numbers?: Record<string, any> }): ReportFinding | null {
  const n = x.numbers ?? {}, sev = (['red', 'orange', 'amber', 'ok', 'info'].includes(x.severity) ? x.severity : 'amber') as Sev;
  switch (x.kind) {
    case 'completeness': case 'baseline': case 'lay_rate': return null;
    case 'feed_buffer': return { sev, area: 'Feed', title: `Feed store at ${n.level_pct}% of the weekly buffer`,
      text: `${n0(n.stock_bags)} bags in store against a buffer of ${n0(n.buffer_bags)} bags.`, action: n.order_bags ? `Order or mill ${n0(n.order_bags)} bags to restore the buffer` : undefined, who: 'Farm manager' };
    case 'water_feed': return { sev, area: 'Water', title: `Water to feed ratio ${Number(n.ratio).toFixed(2)} litres per kg`,
      text: `Laying hens normally drink ${n.min} to ${n.max} litres for every kg of feed. A low ratio usually means water or feed was not recorded every day; if both were, check drinkers and water lines.`,
      action: 'Confirm water and feed are recorded for every house every day, then check drinkers and lines', who: 'Production clerk' };
    case 'damaged_collection': return { sev, area: 'Production', title: `${n.pct}% of eggs damaged at collection`,
      text: `${n0(n.eggs)} eggs were damaged before reaching stock, above the ${n.tol_pct}% the farm allows. Shell quality falls as hens age; collection frequency, tray handling and calcium in the feed are the usual causes.`,
      action: 'Collect more often and check calcium sources in the feed recipe', who: 'Farm manager' };
    case 'damaged_transit': return { sev, area: 'Deliveries', title: `${n.pct}% of eggs damaged on the road`,
      text: `${n0(n.eggs)} of ${n0(n.sent)} eggs sent arrived damaged, above the ${n.tol_pct}% allowed.`, action: 'Review loading and tray stacking on the van', who: 'Farm manager' };
    case 'damaged_outlet': return { sev, area: 'Outlets', title: `${x.where}: ${n.pct}% of eggs lost to breakage`,
      text: `${n0(n.eggs)} eggs broken out of ${n0(n.received)} received, above the ${n.tol_pct}% allowed.`, action: `Review egg handling at ${x.where}`, who: x.role };
    case 'transit': return { sev, area: 'Deliveries', title: `${plural(n.count, 'delivery', 'deliveries')} to ${x.where} not yet received`,
      text: `${n0(n.eggs)} eggs are still shown on the way${n.oldest ? `, the oldest sent ${n.oldest}` : ''}. Stock at both ends is uncertain until they are received.`, action: `Receive the deliveries at ${x.where}`, who: x.role };
    case 'sales_pattern': return { sev, area: 'Sales', title: `${x.where}: sales ${Number(n.change_pct) < 0 ? 'below' : 'above'} its usual level`,
      text: `${kes(Number(n.per_day))} a trading day this week against ${kes(Number(n.pattern_per_day))} usually (${Math.abs(Number(n.change_pct))}% ${Number(n.change_pct) < 0 ? 'lower' : 'higher'}).`,
      action: Number(n.change_pct) < 0 ? `Find out why sales fell at ${x.where}: supply, price or customers` : undefined, who: 'Owner' };
    case 'count_variance': return { sev, area: 'Stock', title: `${x.where}: counts differ from the book by ${n0(n.abs_trays)} trays`,
      text: `Across ${plural(n.counts, 'count')} the physical count and the book differed by ${n0(n.abs_eggs)} eggs. Unrecorded deliveries, sales or breakage are the usual reasons.`,
      action: `Recount ${x.where} and check every delivery and sale was entered`, who: x.role };
    case 'cash_variance': return { sev, area: 'Money', title: `${x.where}: cash differs from the book by ${kes(Number(n.total_diff))}`,
      text: `Across ${plural(n.counts, 'cash count')}, beyond the ${kes(Number(n.cash_tol))} the farm tolerates.`, action: `Reconcile cash at ${x.where}`, who: 'Owner' };
    case 'unbanked': return { sev, area: 'Money', title: `${kes(Number(n.balance))} cash held at ${x.where}`,
      text: `Above the ${kes(Number(n.unbanked_max))} limit for cash kept at an outlet.`, action: `Bank the cash at ${x.where}`, who: x.role };
    default: return { sev, area: 'Other', title: x.where, text: x.text.replace(/\s*\(provisional\)/g, '') };
  }
}

export function buildWeekReport(D: Dashboard, R: WeeklyReport | null): WeekReport {
  const y = addDays(D.today, -1), W1 = range(addDays(D.today, -7), y);
  const a = weekMetrics(D, W1), s = D.settings, f = feedInfo(D);
  const comparable = !!R?.baseline.comparable;
  const reason = comparable ? 'Compared with the 7 days before.'
    : R?.baseline.reason === 'first_week' ? 'There is no complete earlier week to compare with yet, so this week sets the baseline.'
    : 'The week before was not fully entered, so no comparison is made.';
  const comp = (R as any)?.completeness;
  const coverage: Coverage | null = comp && comp.expected ? {
    entered: comp.entered, expected: comp.expected, pct: comp.pct,
    gaps: (comp.gaps ?? []).map((g: any) => ({ where: g.where, days: g.days ?? [], missing: g.missing ?? [] })),
  } : null;

  const flocks = D.houses.filter((h) => h.birds_at_start > 0).map((h) => flockWeek(D, h, W1));
  const findings: ReportFinding[] = [];
  const actions: WeekReport['actions'] = [];

  // records first: everything else rests on them
  if (coverage && coverage.pct < 95) {
    const top = coverage.gaps.slice(0, 4).map((g) => `${g.where} (${g.missing.join(', ')}, ${plural(g.days.length, 'day')})`);
    findings.push({ sev: coverage.pct < 60 ? 'red' : 'amber', area: 'Records', title: `${coverage.entered} of ${coverage.expected} daily records entered (${coverage.pct}%)`,
      text: `The figures in this report cover the days that were entered. Not entered: ${list(top)}${coverage.gaps.length > 4 ? `, and ${plural(coverage.gaps.length - 4, 'more place')}` : ''}.`,
      action: 'Enter each day\'s records by 9 am the next morning; the farm manager fills older gaps from Days with gaps', who: 'All staff' });
  }

  // each flock against its guide
  for (const r of flocks) {
    if (!r.days) continue;
    const bench = r.target ?? r.guide;
    if (bench == null) {
      findings.push({ sev: 'info', area: 'Flock', title: `${r.name}: laying at ${pct(r.lay)}`,
        text: `${r.breed} has no breed guide in the app, and no realistic target is set for this house.`, action: `Set an expected lay rate for ${r.name}`, who: 'Farm manager' });
      continue;
    }
    const basis = r.target != null ? `the farm's target of ${pct(r.target, 0)}` : `the guide of ${pct(bench, 0)} for ${r.age}-week hens${r.beyond ? ' (projected past the published guide)' : ''}`;
    const days = r.days < 7 ? ` on the ${plural(r.days, 'day')} entered` : '';
    if (r.lay >= bench - 0.03) {
      findings.push({ sev: 'ok', area: 'Flock', title: `${r.name}: laying at ${pct(r.lay)}, in line with its age`,
        text: `${n0(r.hens)} hens, ${r.age} weeks old, laid at ${pct(r.lay)}${days}, against ${basis}.${r.lay > bench + 0.03 ? ` That is ${pts(r.lay, bench)} better than expected.` : ''}` });
    } else {
      findings.push({ sev: r.lay < bench - 0.08 ? 'orange' : 'amber', area: 'Flock', title: `${r.name}: laying ${pts(r.lay, bench)} below what its age should give`,
        text: `${n0(r.hens)} hens, ${r.age} weeks old, laid at ${pct(r.lay)}${days}, against ${basis}. The usual causes, in order: water supply, feed intake and quality, day length (16 hours of light in lay), heat, and disease.`,
        action: `Check water, feed, lighting and bird health in ${r.name}; call the vet if it does not recover within a week`, who: 'Farm manager' });
    }
    if (r.deaths >= 3 && r.mortPct > Math.max(2 * r.mortGuide, 0.003)) {
      findings.push({ sev: r.mortPct > 0.01 ? 'red' : 'orange', area: 'Flock', title: `${r.name}: ${plural(r.deaths, 'bird')} died this week`,
        text: `${pct(r.mortPct, 2)} of the flock in a week, against about ${pct(r.mortGuide, 2)} the guide expects at this age. Look at the causes recorded with each death.`,
        action: `Post-mortem on the next deaths in ${r.name}`, who: 'Farm manager' });
    }
  }
  // flocks past the usual laying cycle: one finding for all of them
  const old = flocks.filter((r) => r.days > 0 && r.age > GUIDE.usualEndWeeks[1]);
  if (old.length) {
    const egg = a.perEgg, feedKg = s.bag_price / s.bag_kg, cost = (GUIDE.feedG[0] / 1000) * feedKg;
    const each = Number.isFinite(egg) && feedKg > 0
      ? ` At this week's average price of ${kes(egg)} an egg, each hen brings in about ${list(old.map((r) => `${kes(r.lay * egg)} a day in ${r.name}`))}, against about ${kes(cost)} of feed.` : '';
    const ages = [...new Set(old.map((r) => r.age))];
    findings.push({ sev: 'amber', area: 'Flock', title: `${list(old.map((r) => r.name))}: hens ${ages.length === 1 ? `are ${ages[0]}` : `are ${list(ages.map(String))}`} weeks old, past the usual laying cycle`,
      text: `Most commercial flocks are replaced between ${GUIDE.usualEndWeeks[0]} and ${GUIDE.usualEndWeeks[1]} weeks, as lay rate and shell quality fall.${each} Pullets take about ${GUIDE.rearWeeks} weeks to reach point of lay, so day-old chicks bought now would start laying around ${dshort(addDays(D.today, GUIDE.rearWeeks * 7))}.`,
      action: `Plan the replacement flock${old.length > 1 ? 's' : ''}; sell the hens when egg income per hen stops covering feed`, who: 'Owner' });
  }
  const unrealistic = D.houses.filter((h) => h.birds_at_start > 0 && !realisticTarget(h.expected_lay));
  if (unrealistic.length) {
    const g = flocks.filter((r) => unrealistic.some((h) => h.id === r.id) && r.guide != null);
    findings.push({ sev: 'info', area: 'Setup', title: `Expected lay rate set at ${pct(unrealistic[0].expected_lay, 0)} for ${list(unrealistic.map((h) => h.name))}`,
      text: `No flock lays at that rate, so this report uses the breed guide instead${g.length ? `: ${list(g.map((r) => `${pct(r.guide!, 0)} for ${r.name}`))}` : ''}.`,
      action: `Set each house's expected lay rate with Edit flock under Houses and flocks`, who: 'Farm manager' });
  }

  // feed per egg against the guide
  if (Number.isFinite(a.gpe) && a.feed > 0) {
    const [lo, hi] = GUIDE.feedPerEggG;
    if (a.gpe > hi * 1.1) findings.push({ sev: 'amber', area: 'Feed', title: `${n0(a.gpe)} g of feed for each egg`,
      text: `The breed guide implies about ${n0(lo)} to ${n0(hi)} g. Feed spilt or wasted, feed recorded but not eaten, or low lay all raise this figure.`,
      action: 'Check feeders for spillage and that feed issued matches what each house eats', who: 'Farm manager' });
  }

  // the rest from the server's insight engine (sales, stock, money, damage)
  for (const x of (R?.insights ?? []) as any[]) { const r = fromEngine(x); if (r) findings.push(r); }
  findings.sort((p, q) => SEV_RANK[p.sev] - SEV_RANK[q.sev]);
  for (const x of findings) if (x.action && x.sev !== 'ok') {
    actions.push({ priority: x.sev === 'red' || x.sev === 'orange' ? 'High' : x.sev === 'amber' ? 'Medium' : 'Low', text: x.action, who: x.who ?? 'Farm manager' });
  }

  // the summary: four sentences at most
  const laying = flocks.filter((r) => r.days > 0);
  const hens = laying.reduce((t, r) => t + r.hens, 0);
  const guideW = laying.filter((r) => r.guide != null);
  const gAvg = guideW.length ? guideW.reduce((t, r) => t + r.guide! * r.hens, 0) / Math.max(1, guideW.reduce((t, r) => t + r.hens, 0)) : NaN;
  const sales = a.sales;
  const top = D.locations.map((l) => ({ l, v: D.sales_daily.filter((x) => x.location_id === l.id && W1.includes(x.d)).reduce((t, x) => t + x.value, 0) }))
    .sort((p, q) => q.v - p.v)[0];
  const summary = [
    laying.length ? `${n0(hens)} hens in ${plural(laying.length, 'house')} laid ${n0(a.eggs / 30)} trays at an average of ${pct(a.lay)}${Number.isFinite(gAvg) ? `, against ${pct(gAvg, 0)} the breed guide expects for their age` : ''}.`
      : 'No egg collections were entered this week.',
    sales ? `Sales came to ${kes(sales)}${top && top.v ? `, ${pct(top.v / sales, 0)} of it at ${locName(D, top.l.id)}` : ''}.` : 'No sales were entered this week.',
    `Feed in store covers about ${n0(f.cover)} days at the current rate of use.`,
    coverage && coverage.pct < 95 ? `${coverage.pct}% of the expected daily records were entered, so the figures describe the days recorded.` : '',
  ].filter(Boolean);

  return {
    period: R?.period.label ?? `${dshort(W1[0])} to ${dshort(W1[6])}`, from: W1[0], to: W1[6], comparable, reason,
    coverage, summary, findings, flocks, actions: actions.slice(0, 8),
    guideNote: `Flocks are judged against the ${GUIDE.name}, using the low end of each published range, unless the farm has set its own realistic target for a house. Past 100 weeks the guide is projected at its last published rate of decline. Local and dual-purpose breeds have no guide in the app.`,
  };
}
