// Everything the dashboards show is derived here from the dashboard payload.
// Pure functions: easy to test, no network.
import { addDays, daysBetween, dlabel, dshort, eggs, kes, n0, pct, range } from './format';
import type { Dashboard, Item, Q, Role, Sev, StockKind } from './types';

export const ITEMS: Item[] = ['N', 'C', 'J'];
export const ITEM_NAME: Record<Item, string> = { N: 'Normal eggs', C: 'Cracked eggs', J: 'Jumbo eggs' };
export const Z = (): Q => ({ n: 0, c: 0, j: 0 });
export const tot = (q: Q) => q.n + q.c + q.j;
const add = (a: Q, b: Q, k = 1): Q => ({ n: a.n + k * b.n, c: a.c + k * b.c, j: a.j + k * b.j });
const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + (Number(f(x)) || 0), 0);

/* ---------------- buffer bands (feed & water tank) ---------------- */
export type BandKey = 'full' | 'good' | 'watch' | 'low' | 'none';
export interface Band { key: BandKey; min: number; label: string; color: string; sev: Sev | 'ok' }
export const BANDS: Band[] = [
  { key: 'full', min: 1, label: 'Full buffer', color: '--f-full', sev: 'ok' },
  { key: 'good', min: 0.75, label: 'Good', color: '--f-good', sev: 'ok' },
  { key: 'watch', min: 0.5, label: 'Watch', color: '--f-watch', sev: 'amber' },
  { key: 'low', min: 0.25, label: 'Low', color: '--f-low', sev: 'orange' },
  { key: 'none', min: -Infinity, label: 'No buffer', color: '--f-none', sev: 'red' },
];
export const band = (level: number) => BANDS.find((b) => level >= b.min)!;

/* ---------------- locations, accounts ---------------- */
export const locName = (D: Dashboard, id: string | null | undefined) => D.locations.find((l) => l.id === id)?.name ?? '';
export const locShort = (D: Dashboard, id: string | null | undefined) => D.locations.find((l) => l.id === id)?.short ?? '';
export const accName = (D: Dashboard, id: string) => D.accounts.find((a) => a.id === id)?.name ?? id;
export const cashAcc = (loc: string) => `CASH:${loc}`;
export const LOC_COLORS: Record<string, string> = { FARM: '--l-farm', VAN: '--l-van', TUALA: '--l-tuala', RAYAN: '--l-rayan', LUCKY: '--l-lucky' };
export const locColor = (id: string) => LOC_COLORS[id] ?? '--muted';

/* ---------------- stock ---------------- */
export function stockNow(D: Dashboard, loc: string): Q {
  const r = D.stock.find((s) => s.location_id === loc);
  return r ? { n: r.n, c: r.c, j: r.j } : Z();
}
export interface Ledger { open: Q; coll: Q; recv: Q; out: Q; sold: Q; brk: Q; adj: Q; close: Q }
/** Opening → closing stock sheet for one location and day. Moves out are returned as positive numbers. */
export function dayLedger(D: Dashboard, loc: string, day: string): Ledger {
  const rows = D.stock_daily.filter((r) => r.location_id === loc);
  const after = rows.filter((r) => r.d >= day).reduce((a, r) => add(a, r), Z());
  const open = add(stockNow(D, loc), after, -1);
  const k = (kind: StockKind, sign = 1) => rows.filter((r) => r.d === day && r.kind === kind).reduce((a, r) => add(a, r, sign), Z());
  const L = { open, coll: k('coll'), recv: k('recv'), out: k('out', -1), sold: k('sold', -1), brk: k('brk', -1), adj: k('adj') };
  const close = add(add(add(add(add(add(L.open, L.coll), L.recv), L.out, -1), L.sold, -1), L.brk, -1), L.adj);
  return { ...L, close };
}

/* ---------------- money ---------------- */
export const balance = (D: Dashboard, acc: string) => D.balances.find((b) => b.account_id === acc)?.balance ?? 0;
export const totalFunds = (D: Dashboard) => sum(D.balances, (b) => b.balance);
export function cashDay(D: Dashboard, acc: string, day: string) {
  const rows = D.money_daily.filter((r) => r.account_id === acc);
  const after = sum(rows.filter((r) => r.d >= day), (r) => r.amount);
  const k = (kind: string) => sum(rows.filter((r) => r.d === day && r.kind === kind), (r) => r.amount);
  const open = balance(D, acc) - after;
  return { open, sales: k('sale'), moveIn: k('move_in'), moveOut: -k('move_out'), fees: -k('fee'), expenses: -k('expense'),
           variance: k('variance'), opening: k('opening'), close: balance(D, acc) - sum(rows.filter((r) => r.d > day), (r) => r.amount) };
}
export function salesOn(D: Dashboard, days: string[], loc?: string) {
  const set = new Set(days);
  const rows = D.sales_daily.filter((r) => set.has(r.d) && (!loc || r.location_id === loc));
  return { value: sum(rows, (r) => r.value), cash: sum(rows, (r) => r.cash), till: sum(rows, (r) => r.till), paybill: sum(rows, (r) => r.paybill),
           cnt: sum(rows, (r) => r.cnt), pcs: sum(rows, (r) => r.n + r.c + r.j), q: { n: sum(rows, (r) => r.n), c: sum(rows, (r) => r.c), j: sum(rows, (r) => r.j) } };
}
export function priceOf(D: Dashboard, q: Q) {
  const s = D.settings;
  return Math.round(Math.floor(q.n / 30) * s.tray_n + (q.n % 30) * s.pc_n + q.c * s.tray_c / 30 + q.j * s.pc_j);
}

/* ---------------- feed ---------------- */
export function feedUsed(D: Dashboard, days: string[]) {
  const set = new Set(days);
  return -sum(D.feed_daily.filter((r) => r.kind === 'use' && set.has(r.d)), (r) => r.kg);
}
export function feedInfo(D: Dashboard) {
  const s = D.settings, stock = D.feed_stock, target = s.feed_buffer_kg, level = stock / target, b = band(level);
  const last7 = range(addDays(D.today, -7), addDays(D.today, -1));
  const used7 = feedUsed(D, last7);
  const daily = used7 > 0 ? used7 / 7 : target / 7;
  const cover = stock / daily;
  const shortKg = Math.max(0, target - stock), bags = Math.ceil(shortKg / s.bag_kg);
  const toNone = Math.max(0, (stock - 0.25 * target) / daily);
  return { stock, target, level, band: b, daily, cover, shortKg, bags, noneDate: addDays(D.today, Math.floor(toNone)), usedToday: feedUsed(D, [D.today]), estimated: used7 <= 0 };
}
/** Feed in store at the end of each day. */
export function feedHistory(D: Dashboard, days: string[]) {
  return days.map((day) => D.feed_stock - sum(D.feed_daily.filter((r) => r.d > day), (r) => r.kg));
}

/* ---------------- water ---------------- */
export function waterOn(D: Dashboard, days: string[], house?: string) {
  const set = new Set(days);
  return sum(D.water_daily.filter((r) => set.has(r.d) && (!house || r.house_id === house)), (r) => r.litres);
}
export function tankInfo(D: Dashboard) {
  const cap = D.settings.tank_capacity_l;
  if (!D.tank) return null;
  const level = D.tank.litres / cap, last7 = range(addDays(D.today, -7), addDays(D.today, -1));
  const daily = waterOn(D, last7) / 7;
  return { litres: D.tank.litres, cap, level, band: band(level), at: D.tank.recorded_at, daily, cover: daily > 0 ? D.tank.litres / daily : null };
}
/** Yesterday's intake for a house against its average over the 7 days before. */
export function waterTrend(D: Dashboard, house: string) {
  const y = addDays(D.today, -1);
  const prior = range(addDays(y, -7), addDays(y, -1)).map((d) => waterOn(D, [d], house)).filter((v) => v > 0);
  const avg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
  const yest = waterOn(D, [y], house);
  return { yesterday: yest, avg, days: prior.length, change: avg ? yest / avg - 1 : 0, today: waterOn(D, [D.today], house) };
}
export function waterFeedRatio(D: Dashboard, days: string[]) {
  const f = feedUsed(D, days), w = waterOn(D, days);
  return f > 0 && w > 0 ? w / f : null;
}

/* ---------------- flock ---------------- */
export function collected(D: Dashboard, days: string[], house?: string): Q {
  const set = new Set(days);
  return D.farm_daily.filter((r) => set.has(r.d) && (!house || r.house_id === house)).reduce((a, r) => add(a, r), Z());
}
export function layRate(D: Dashboard, days: string[], house?: string) {
  const set = new Set(days);
  const rows = D.farm_daily.filter((r) => set.has(r.d) && (!house || r.house_id === house));
  const hens = sum(rows, (r) => r.hens);
  return hens ? sum(rows, (r) => r.n + r.c + r.j) / hens : NaN;
}
export function hensNow(D: Dashboard, house?: string) {
  return sum(D.houses.filter((h) => !house || h.id === house), (h) => {
    const r = D.farm_daily.find((x) => x.house_id === h.id && x.d === D.today);
    return r ? r.hens - r.deaths : h.birds_at_start;
  });
}
export const houseAge = (D: Dashboard, h: { start_date: string; age_weeks_at_start: number }) =>
  Math.floor(h.age_weeks_at_start + daysBetween(h.start_date, D.today) / 7);
export const deaths = (D: Dashboard, days: string[], house?: string) => {
  const set = new Set(days);
  return sum(D.farm_daily.filter((r) => set.has(r.d) && (!house || r.house_id === house)), (r) => r.deaths);
};

/* ---------------- breakage ---------------- */
export function outletLoss(D: Dashboard, days: string[]) {
  const set = new Set(days);
  return D.locations.map((l) => {
    const loss = sum(D.breakage_daily.filter((r) => r.location_id === l.id && set.has(r.d)), (r) => r.qty);
    const base = l.id === 'FARM' ? tot(collected(D, days)) : sum(D.received_daily.filter((r) => r.location_id === l.id && set.has(r.d)), (r) => r.sent);
    return { loc: l.id, loss, base, rate: base ? loss / base : 0, sales: salesOn(D, days, l.id) };
  });
}

/* ---------------- live alerts ---------------- */
export interface Alert { sev: Sev; icon: string; title: string; body: string; to: Role[]; loc?: string }
const SEVR: Record<Sev, number> = { red: 0, orange: 1, amber: 2, info: 3 };
const bandSev = (b: Band): Sev => (b.sev === 'ok' ? 'info' : b.sev);

export function alerts(D: Dashboard): Alert[] {
  const A: Alert[] = [], s = D.settings, y = addDays(D.today, -1);
  const farmReady = D.houses.some((h) => h.birds_at_start > 0);
  // feed
  const f = feedInfo(D);
  if (farmReady && f.level < 1) A.push({ sev: bandSev(f.band), icon: 'sack', to: ['owner', 'manager', 'clerk'],
    title: `Feed buffer: ${f.band.label} (${pct(f.level, 0)})`,
    body: `${n0(f.stock)} kg in store against a ${n0(f.target)} kg weekly buffer. About ${f.cover.toFixed(1)} days left. Order ${f.bags} bag${f.bags === 1 ? '' : 's'} (${n0(f.bags * s.bag_kg)} kg).` });
  // water tank
  const t = tankInfo(D);
  if (t && t.level < 0.75) A.push({ sev: bandSev(t.band), icon: 'drop', to: ['owner', 'manager', 'clerk'],
    title: `Water tank ${pct(t.level, 0)} (${t.band.label})`, body: `${n0(t.litres)} of ${n0(t.cap)} L${t.cover != null ? `, about ${t.cover.toFixed(1)} days of drinking water` : ''}. Refill and record the new level.` });
  // water intake per house
  for (const h of D.houses) {
    const w = waterTrend(D, h.id);
    if (w.days >= 3 && w.yesterday === 0) A.push({ sev: 'amber', icon: 'drop', to: ['manager', 'clerk'], title: `No water intake recorded for ${h.name} yesterday`, body: 'Record the litres drunk so a drop can be spotted early.' });
    else if (w.days >= 3 && w.change < -s.water_drop_pct / 100) A.push({ sev: 'orange', icon: 'drop', to: ['owner', 'manager', 'clerk'],
      title: `${h.name} drank ${pct(-w.change, 0)} less water yesterday`, body: `${n0(w.yesterday)} L against a 7-day average of ${n0(w.avg)} L. Water intake often drops before egg output does: check drinkers, lines and the birds.` });
  }
  const ratio = waterFeedRatio(D, [y]);
  if (ratio != null && (ratio < s.water_ratio_min || ratio > s.water_ratio_max)) A.push({ sev: 'amber', icon: 'drop', to: ['owner', 'manager'],
    title: `Water to feed ratio ${ratio.toFixed(2)} : 1 yesterday`, body: `Normal range is ${s.water_ratio_min} to ${s.water_ratio_max} litres per kg of feed.` });
  // lay rate drop
  for (const h of D.houses) {
    const r3 = layRate(D, range(addDays(D.today, -3), y), h.id), r7 = layRate(D, range(addDays(D.today, -10), addDays(D.today, -4)), h.id);
    if (Number.isFinite(r3) && Number.isFinite(r7) && (r7 - r3) * 100 > s.lay_drop_pts) A.push({ sev: 'orange', icon: 'pulse', to: ['owner', 'manager'],
      title: `${h.name} lay rate down ${((r7 - r3) * 100).toFixed(1)} pts`, body: `Last 3 days ${pct(r3)} against ${pct(r7)} the week before. Check water, feed intake and signs of disease.` });
  }
  // medicines and schedule
  for (const m of D.medicines.filter((x) => x.active && x.stock <= x.reorder)) A.push({ sev: m.stock <= m.reorder / 2 ? 'orange' : 'amber', icon: 'syringe', to: ['owner', 'manager', 'clerk'],
    title: `${m.name} low`, body: `${n0(m.stock)} ${m.unit} left. Reorder level is ${n0(m.reorder)} ${m.unit}.` });
  for (const e of D.schedule.filter((x) => !x.done)) {
    const n = daysBetween(D.today, e.due);
    if (n < 0) A.push({ sev: 'amber', icon: 'clock', to: ['manager', 'clerk'], title: `Overdue: ${e.task}`, body: `${e.house}, was due ${dlabel(e.due)}. Mark it done when finished.` });
    else if (n <= 3) A.push({ sev: 'info', icon: 'clock', to: ['manager', 'clerk'], title: `${e.task} due ${n === 0 ? 'today' : `in ${n} day${n > 1 ? 's' : ''}`}`, body: `${e.house}, ${dlabel(e.due)}.` });
  }
  // deliveries and counts
  for (const x of D.transit) A.push({ sev: 'info', icon: 'truck', loc: x.to_loc, to: ['owner', 'manager', 'pos'],
    title: `Delivery to ${locShort(D, x.to_loc)} not yet confirmed`, body: `${eggs(x.sent_n + x.sent_c + x.sent_j)} sent from ${locShort(D, x.from_loc)} on ${dlabel(x.d)}.` });
  if (s.go_live) for (const l of D.locations) {
    if (!D.counts_today.some((c) => c.location_id === l.id && c.kind === 'open')) A.push({ sev: 'amber', icon: 'count', loc: l.id, to: ['owner', 'manager', 'pos'],
      title: `${l.name}: opening count not done`, body: 'Count the eggs on hand before selling.' });
  }
  // money
  const wk = range(addDays(D.today, -7), D.today);
  for (const v of D.money_daily.filter((r) => r.kind === 'variance' && wk.includes(r.d) && Math.abs(r.amount) >= s.cash_tol)) A.push({ sev: 'orange', icon: 'cash', to: ['owner'],
    title: `Cash ${v.amount < 0 ? 'short' : 'over'} ${kes(Math.abs(v.amount))} at ${accName(D, v.account_id).replace('Cash · ', '')}`, body: `Cash count on ${dlabel(v.d)} did not match the expected cash.` });
  for (const a of D.accounts.filter((x) => x.kind === 'cash')) {
    const b = balance(D, a.id);
    if (b > s.unbanked_max) A.push({ sev: 'amber', icon: 'wallet', loc: a.location_id ?? undefined, to: ['owner', 'pos'],
      title: `${kes(b)} cash unbanked at ${locShort(D, a.location_id)}`, body: `Above the ${kes(s.unbanked_max)} limit. Bank it or move it to Paybill.` });
  }
  // breakage
  for (const o of outletLoss(D, range(addDays(D.today, -7), y))) if (o.base > 0 && o.rate * 100 > s.break_tol) A.push({ sev: 'amber', icon: 'crack', loc: o.loc, to: ['owner', 'manager'],
    title: `Breakage ${pct(o.rate)} at ${locShort(D, o.loc)} this week`, body: `${eggs(o.loss)} lost of ${eggs(o.base)}. Tolerance is ${s.break_tol}%.` });
  return A.sort((a, b) => SEVR[a.sev] - SEVR[b.sev]);
}
/** Alerts for the signed-in person: their role, and for sales points only their own location. */
export function alertsFor(D: Dashboard): Alert[] {
  const me = D.me;
  return alerts(D).filter((a) => a.to.includes(me.role) && (me.role !== 'pos' || !a.loc || a.loc === me.location_id));
}

/* ---------------- weekly intelligence ---------------- */
export function weekMetrics(D: Dashboard, days: string[]) {
  const col = collected(D, days), e = tot(col), feed = feedUsed(D, days), water = waterOn(D, days);
  const sales = salesOn(D, days);
  const set = new Set(days);
  const brk = sum(D.breakage_daily.filter((r) => set.has(r.d)), (r) => r.qty);
  const kgPrice = D.settings.bag_price / D.settings.bag_kg;
  const cv = sum(D.money_daily.filter((r) => r.kind === 'variance' && set.has(r.d)), (r) => r.amount);
  const hens = sum(D.farm_daily.filter((r) => set.has(r.d)), (r) => r.hens) / Math.max(days.length, 1);
  return {
    eggs: e, lay: layRate(D, days), feed, water, gpe: e ? (feed * 1000) / e : NaN, costTray: e ? (feed / e) * 30 * kgPrice : NaN,
    waterPerBird: hens ? water / hens / days.length : NaN, ratio: feed ? water / feed : NaN,
    sales: sales.value, pcsSold: sales.pcs, perEgg: sales.pcs ? sales.value / sales.pcs : NaN, cracked: e ? col.c / e : NaN,
    brk, mort: deaths(D, days), cv, mix: sales,
  };
}

export interface Finding { sev: Sev | 'ok'; title: string; text: string }
export function intelligence(D: Dashboard) {
  const y = addDays(D.today, -1), W1 = range(addDays(D.today, -7), y), W0 = range(addDays(D.today, -14), addDays(D.today, -8));
  const a = weekMetrics(D, W1), b = weekMetrics(D, W0), f = feedInfo(D), t = tankInfo(D), s = D.settings;
  const houses = D.houses.map((h) => ({ h, r3: layRate(D, range(addDays(D.today, -3), y), h.id), r1: layRate(D, W1, h.id), r0: layRate(D, W0, h.id), w: waterTrend(D, h.id) }));
  const worst = houses.filter((x) => Number.isFinite(x.r3)).sort((p, q) => (p.r3 - p.h.expected_lay) - (q.r3 - q.h.expected_lay))[0];
  const o1 = outletLoss(D, W1), o0 = outletLoss(D, W0);
  const outlets = o1.map((o, i) => ({ ...o, prev: o0[i].sales.value, chg: o0[i].sales.value ? o.sales.value / o0[i].sales.value - 1 : 0 }));
  const byValue = outlets.slice().sort((p, q) => q.sales.value - p.sales.value);
  const fall = outlets.filter((o) => o.prev > 0).sort((p, q) => p.chg - q.chg)[0];
  const brk = outlets.filter((o) => o.base > 0).sort((p, q) => q.rate - p.rate)[0];
  const unb = D.accounts.filter((x) => x.kind === 'cash').map((x) => ({ loc: x.location_id!, bal: balance(D, x.id) })).sort((p, q) => q.bal - p.bal)[0];
  const lowMeds = D.medicines.filter((m) => m.active && m.stock <= m.reorder);
  const due = D.schedule.filter((e) => !e.done && daysBetween(D.today, e.due) >= -7 && daysBetween(D.today, e.due) <= 7);
  const margin = a.perEgg * 30 - a.costTray;
  const chg = (x: number, z: number) => (z ? `${x >= z ? '+' : '−'}${Math.abs((x / z - 1) * 100).toFixed(1)}%` : 'n/a');
  const waterDrop = houses.filter((x) => x.w.days >= 3 && x.w.change < -s.water_drop_pct / 100);

  const lead = [
    a.eggs ? `Egg output ${a.eggs >= b.eggs ? 'rose' : 'fell'} ${chg(a.eggs, b.eggs).replace(/^[+−]/, '')} week on week to ${n0(a.eggs / 30)} trays, with the flock laying at ${pct(a.lay)}.` : 'No egg collections were recorded last week.',
    worst && worst.r3 < worst.h.expected_lay - 0.03 ? `${worst.h.name} is the concern: ${pct(worst.r3)} over the last three days against about ${pct(worst.h.expected_lay, 0)} expected.` : '',
    `Sales came to ${kes(a.sales)} (${chg(a.sales, b.sales)}).`,
    `Feed covers ${f.cover.toFixed(1)} days${f.level < 1 ? `; it reaches No buffer around ${dlabel(f.noneDate)} unless ${f.bags} bags are ordered` : ''}.`,
    waterDrop.length ? `Water intake dropped in ${waterDrop.map((x) => x.h.name).join(' and ')}.` : '',
  ].filter(Boolean).join(' ');

  const findings: Finding[] = [];
  if (worst) findings.push({
    sev: worst.r3 < worst.h.expected_lay - 0.04 ? 'orange' : 'ok', title: `${worst.h.name}: lay rate ${pct(worst.r3)}`,
    text: `Two weeks ago ${pct(worst.r0)}, last week ${pct(worst.r1)}, last three days ${pct(worst.r3)}. Expected for ${houseAge(D, worst.h)}-week hens is about ${pct(worst.h.expected_lay, 0)}.${worst.w.days >= 3 ? ` Water yesterday ${n0(worst.w.yesterday)} L against ${n0(worst.w.avg)} L average.` : ''}`,
  });
  findings.push({ sev: f.band.sev, title: `Feed buffer at ${pct(f.level, 0)} (${f.band.label})`,
    text: `${n0(f.stock)} kg in store, using ${n0(f.daily)} kg a day.${f.bags ? ` Order ${f.bags} bags (${kes(f.bags * s.bag_price)}) by ${dlabel(addDays(D.today, Math.max(0, Math.floor(f.cover) - 2)))}.` : ''} Feed cost per tray is ${Number.isFinite(a.costTray) ? kes(a.costTray) : 'n/a'}${Number.isFinite(margin) ? `, leaving ${kes(margin)} per tray before labour and transport` : ''}.` });
  findings.push({ sev: waterDrop.length ? 'orange' : t && t.level < 0.5 ? t.band.sev : 'ok', title: `Water: ${n0(a.water)} L drunk last week`,
    text: `${Number.isFinite(a.ratio) ? `${a.ratio.toFixed(2)} litres per kg of feed (normal ${s.water_ratio_min}–${s.water_ratio_max}). ` : ''}${Number.isFinite(a.waterPerBird) ? `${(a.waterPerBird * 1000).toFixed(0)} ml per bird per day. ` : ''}${t ? `Tank at ${pct(t.level, 0)}.` : 'No tank reading yet.'}` });
  if (brk) findings.push({ sev: brk.rate * 100 > s.break_tol ? 'amber' : 'ok', title: `${locName(D, brk.loc)} loses the most eggs`,
    text: `${brk.loss} pieces lost last week, ${pct(brk.rate)} of what it received. Tolerance is ${s.break_tol}%.` });
  if (fall && byValue[0]) findings.push({ sev: fall.chg < -0.05 ? 'amber' : 'ok', title: `${locName(D, fall.loc)} sales ${fall.chg < 0 ? 'down' : 'up'} ${Math.abs(fall.chg * 100).toFixed(1)}%`,
    text: `${kes(fall.sales.value)} last week against ${kes(fall.prev)}. ${locName(D, byValue[0].loc)} sold the most: ${kes(byValue[0].sales.value)}${a.sales ? `, ${pct(byValue[0].sales.value / a.sales, 0)} of the total` : ''}.` });
  if (unb) findings.push({ sev: unb.bal > s.unbanked_max ? 'amber' : 'ok', title: `${kes(unb.bal)} cash held at ${locName(D, unb.loc)}`,
    text: `${unb.bal > s.unbanked_max ? 'Above' : 'Within'} the ${kes(s.unbanked_max)} unbanked limit. Cash count variance last week: ${kes(a.cv)}.${a.sales ? ` Cash ${pct(a.mix.cash / a.sales, 0)}, Till ${pct(a.mix.till / a.sales, 0)}, Paybill ${pct(a.mix.paybill / a.sales, 0)} of sales.` : ''}` });
  findings.push({ sev: lowMeds.length ? 'amber' : 'ok', title: `Flock health: ${due.length} task${due.length === 1 ? '' : 's'} due`,
    text: `${due.map((e) => `${e.task} (${e.house}, ${dshort(e.due)})`).join('; ') || 'Nothing scheduled this week'}. ${lowMeds.map((m) => `${m.name} is below reorder level`).join('; ')}${lowMeds.length ? '.' : ''} ${a.mort} bird${a.mort === 1 ? '' : 's'} died last week.` });

  const actions: [string, string, string][] = [];
  if (f.bags) actions.push([f.level < 0.5 ? 'High' : 'Medium', `Order ${f.bags} bags of layers feed`, 'Farm Manager']);
  if (worst && worst.r3 < worst.h.expected_lay - 0.04) actions.push(['High', `Investigate ${worst.h.name} lay rate; vet visit if it does not recover`, 'Farm Manager']);
  for (const x of waterDrop) actions.push(['High', `Check drinkers and water lines in ${x.h.name}`, 'Production Clerk']);
  if (t && t.level < 0.5) actions.push(['High', 'Refill the water tank', 'Production Clerk']);
  if (unb && unb.bal > s.unbanked_max) actions.push(['Medium', `Bank cash held at ${locShort(D, unb.loc)}`, 'Sales point']);
  if (brk && brk.rate * 100 > s.break_tol) actions.push(['Medium', `Review egg handling for ${locShort(D, brk.loc)}`, 'Farm Manager']);
  for (const m of lowMeds) actions.push(['Medium', `Restock ${m.name}`, 'Production Clerk']);

  return { W1, W0, a, b, lead, findings, actions, outlets, houses };
}
