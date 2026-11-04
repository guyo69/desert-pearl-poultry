// Every data-entry form in the app. Each returns a FormSpec; the database
// function behind it re-checks everything, so these checks are for speed only.
import { rpc, staffAdmin } from '../lib/api';
import { addDays, dlabel, eggs, kes, n0, pct } from '../lib/format';
import { ITEMS, ITEM_NAME, isVan, accName, balance, band, cashAcc, collected, damagedAtFarm, dayLedger, feedInfo, hensNow, houseAge, locName, millInfo, millNeeds, mix, priceOf, salesOn, stockNow, tankInfo, tot, waterOn } from '../lib/metrics';
import type { Credit, Dashboard, House, Item, Medicine, Q, RawMaterial, ScheduleItem, StaffLite, StorePending, Supply, Transfer } from '../lib/types';
import type { Field, FormSpec, V } from '../ui/ui';

const houseOpts = (D: Dashboard): [string, string][] => D.houses.map((h) => [h.id, h.name]);
const houseNameOpts = (D: Dashboard): [string, string][] => [['Both', 'All houses'], ...D.houses.map((h): [string, string] => [h.name, h.name])];
const Row = ({ l, r }: { l: React.ReactNode; r: React.ReactNode }) => <div><span>{l}</span><b>{r}</b></div>;
const Ok = ({ children }: { children: React.ReactNode }) => <div><span>{children}</span><b className="up">✓</b></div>;
const Bad = ({ l, r }: { l: React.ReactNode; r: React.ReactNode }) => <div><span>{l}</span><b style={{ color: 'var(--f-none)' }}>{r}</b></div>;

/* ---------------- shared pieces ---------------- */
const isMgmt = (D: Dashboard) => D.me.role === 'owner' || D.me.role === 'manager';
/** The owner and farm manager can enter a missed day (up to 62 days back); everyone else records today. */
const dateFields = (D: Dashboard, hint = 'Leave as today unless you are entering a missed day.', def = D.today): Field[] =>
  isMgmt(D) ? [{ type: 'date', id: 'date', label: 'Date', def, min: addDays(D.today, -62), max: D.today, hint }] : [];
const dayOf = (D: Dashboard, v: V): string => (isMgmt(D) && v.date ? String(v.date) : D.today);
const dateArg = (D: Dashboard, v: V) => (dayOf(D, v) === D.today ? null : dayOf(D, v));
/** For the farm forms that record one thing: the farm manager can enter a skipped day. */
const farmDateFields = (D: Dashboard): Field[] => (D.me.role === 'manager' ? dateFields(D, 'Leave as today, or choose a skipped day (up to 62 days back).') : []);
/** Saves an earlier day's farm record; returns null for today so the usual form path runs. */
async function farmOn(D: Dashboard, v: V, kind: 'feed_use' | 'water' | 'deaths' | 'med', p: Record<string, unknown>): Promise<string | null> {
  const day = dateArg(D, v);
  if (!day) return null;
  await rpc('rpc_farm_record_on', { p_date: day, p_kind: kind, p });
  return `Saved for ${dlabel(day)}.`;
}
const onDay = (D: Dashboard, v: V) => (dayOf(D, v) === D.today ? '' : ` for ${dlabel(dayOf(D, v))}`);
/** Egg inputs by grade, keyed `${p}n`, `${p}b`, `${p}j`, `${p}c` (+ `${p}dmg`). */
function gradeFields(p: string, o: { def?: Partial<Q>; dmg?: string; only?: Item[]; hint?: Partial<Record<Item, string>> } = {}): Field[] {
  const want = (i: Item) => !o.only || o.only.includes(i);
  const f: Field[] = [];
  if (want('N')) f.push({ type: 'eggs', id: `${p}n`, label: 'Normal eggs', def: o.def?.n, hint: o.hint?.N });
  // Big eggs are recorded as Normal (no separate grade since 2 Nov 2026)
  if (want('C')) f.push({ type: 'eggs', id: `${p}c`, label: 'Cracked (sellable)', def: o.def?.c, hint: o.hint?.C });
  const small: Field[] = [];
  if (want('J')) small.push({ type: 'num', id: `${p}j`, label: 'Jumbo / double yolk', suffix: 'pc', def: o.def?.j ?? '' });
  if (o.dmg) small.push({ type: 'num', id: `${p}dmg`, label: o.dmg, suffix: 'pc' });
  if (small.length) f.push({ type: 'pair', fields: small });
  return f;
}
const gradesOf = (v: V, p = ''): Q => ({ n: v[`${p}n`] || 0, b: v[`${p}b`] || 0, c: v[`${p}c`] || 0, j: v[`${p}j`] || 0 });
const neg = (q: Q) => q.n < 0 || q.b < 0 || q.c < 0 || q.j < 0;
const over = (q: Q, have: Q): string | null => {
  const names: [keyof Q, string][] = [['n', 'normal'], ['b', 'big'], ['c', 'cracked'], ['j', 'jumbo']];
  const x = names.find(([k]) => q[k] > Math.max(0, have[k]));
  return x ? `Only ${eggs(Math.max(0, have[x[0]]))} ${x[1]} in stock` : null;
};

/* ---------------- production clerk ---------------- */
export const collectForm = (D: Dashboard): FormSpec => ({
  title: 'Egg collection',
  intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Grade the eggs as you collect. Damaged / broken eggs count towards production but never go into stock.</p>,
  fields: [
    ...dateFields(D),
    { type: 'select', id: 'house', label: 'House', options: houseOpts(D) },
    ...gradeFields('', { dmg: 'Damaged / broken' }),
  ],
  calc: (v) => { const q = gradesOf(v); return <>
    <Row l="Into stock" r={eggs(tot(q))} />
    {v.dmg > 0 && <Row l="Damaged (written off)" r={`${v.dmg} pc`} />}
    <Row l="Total collected" r={eggs(tot(q) + v.dmg)} /></>; },
  onSubmit: async (v) => {
    const q = gradesOf(v);
    if (tot(q) + v.dmg <= 0) throw new Error('Enter the eggs collected.');
    await rpc('rpc_collect_eggs', { p_house: v.house, p_n: q.n, p_b: q.b, p_j: q.j, p_c: q.c, p_dmg: v.dmg, p_date: dateArg(D, v) });
    return `Collection saved${onDay(D, v)}: ${eggs(tot(q) + v.dmg)}.`;
  },
});

/**
 * The farm's daily book, one block per house. The app works out the rest of
 * the line: age, hens at the start and end of the day, production, lay rate.
 */
export function houseDayForm(D: Dashboard, day?: string): FormSpec {
  const s = D.settings;
  const fields: Field[] = [...dateFields(D, 'For a missed day, choose the date. Hens and age are worked out for that day.', day)];
  for (const h of D.houses) fields.push(
    { type: 'note', text: <div className="dest"><b>{h.name}</b></div> },
    ...gradeFields(`${h.id}_`, { dmg: 'Damaged / broken' }),
    // feed comes from the store (the inventory clerk issues it); only the farm manager enters it here, for days the store did not
    D.me.role === 'manager' ? { type: 'pair', fields: [{ type: 'num', id: `${h.id}_deaths`, label: 'Deaths', suffix: 'birds' }, { type: 'num', id: `${h.id}_feed`, label: 'Feed given (if the store did not issue it)', suffix: 'bags', step: 0.5 }] }
      : { type: 'num', id: `${h.id}_deaths`, label: 'Deaths', suffix: 'birds' },
    { type: 'num', id: `${h.id}_water`, label: 'Water drunk', suffix: 'L' },
  );
  fields.push({ type: 'select', id: 'no_deaths', label: 'Deaths', def: 'yes',
    options: [['yes', 'No deaths in houses where Deaths is blank'], ['no', 'Not checked yet']] });
  const lines = (v: V) => D.houses.map((h) => {
    const day = dayOf(D, v), q = gradesOf(v, `${h.id}_`), dmg = v[`${h.id}_dmg`] || 0, deaths = v[`${h.id}_deaths`] || 0;
    const row = D.farm_daily.find((r) => r.house_id === h.id && r.d === day);
    const before = row ? row.hens : day === D.today ? hensNow(D, h.id) : h.birds_at_start;
    const already = tot(collected(D, [day], h.id)) + damagedAtFarm(D, [day], h.id);
    const laid = already + tot(q) + dmg;
    return { h, q, dmg, deaths, feed: (v[`${h.id}_feed`] || 0) * s.bag_kg, water: v[`${h.id}_water`] || 0,
             before, close: before - (row?.deaths ?? 0) - deaths, already, laid,
             age: houseAge({ ...D, today: day }, h) };
  });
  return {
    title: 'Daily house sheet',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>The farm book in one go: eggs by grade, deaths and water for each house (feed comes from the store). Leave a house blank if nothing is new. Age, hens and lay rate fill in by themselves.</p>,
    fields, submit: 'Save the day',
    calc: (v) => <>{lines(v).map((x) => <div key={x.h.id} className="sheet-line">
      <Row l={`${x.h.name} · ${x.age} weeks`} r={`${n0(x.before)} → ${n0(x.close)} hens`} />
      <Row l={`Laid${x.already ? ` (incl. ${eggs(x.already)} already entered)` : ''}`} r={`${eggs(x.laid)} · ${x.before ? pct(x.laid / x.before) : '–'} lay`} />
      {x.before > 0 && x.laid / x.before < x.h.expected_lay - 0.05 && x.laid > 0 && <Bad l="Below the expected lay rate" r={pct(x.h.expected_lay, 0)} />}
    </div>)}
      {D.me.role === 'manager' && <Row l="Feed for the day" r={`${n0(lines(v).reduce((a, x) => a + x.feed, 0) / s.bag_kg)} bags · ${n0(lines(v).reduce((a, x) => a + x.feed, 0))} kg`} />}
      <Row l="Water for the day" r={`${n0(lines(v).reduce((a, x) => a + x.water, 0))} L`} /></>,
    onSubmit: async (v) => {
      const rows = lines(v).filter((x) => tot(x.q) + x.dmg + x.deaths + x.feed + x.water > 0)
        .map((x) => ({ house: x.h.id, ...x.q, dmg: x.dmg, deaths: x.deaths, cause: 'Unknown', feed_kg: x.feed, water_l: x.water }));
      if (!rows.length) throw new Error('Enter at least one figure.');
      if (rows.some((r) => neg(r) || r.dmg < 0 || r.deaths < 0)) throw new Error('Numbers cannot be negative.');
      const r = await rpc<{ saved: number }>('rpc_house_day', { p_date: dateArg(D, v), p_rows: rows });
      // "nothing happened" is recorded too, so the reports can tell it from "not entered"
      if (v.no_deaths === 'yes') {
        await Promise.all(lines(v).filter((x) => !x.deaths).map((x) =>
          rpc('rpc_mark_day', { p_kind: 'no_deaths', p_house: x.h.id, p_date: dateArg(D, v) }).catch(() => null)));
      }
      return `House sheet saved${onDay(D, v)}: ${r.saved} record${r.saved === 1 ? '' : 's'}.`;
    },
  };
}

export function feedUseForm(D: Dashboard): FormSpec {
  const f = feedInfo(D), kgBag = D.settings.bag_kg;
  const kgOf = (v: V) => v.bags * kgBag + v.kg;
  return {
    title: 'Feed used',
    fields: [
      { type: 'pair', fields: [{ type: 'num', id: 'bags', label: 'Bags given', suffix: 'bags', step: 0.5 }, { type: 'num', id: 'kg', label: 'Plus loose', suffix: 'kg' }] },
      { type: 'note', text: <div><span>In store: {n0(f.stockBags)} bags ({n0(f.stock)} kg) · 1 bag = {kgBag} kg</span></div> },
      { type: 'select', id: 'house', label: 'House', options: houseNameOpts(D) },
      { type: 'select', id: 'note', label: 'Feeding', options: [['Morning feed', 'Morning'], ['Afternoon feed', 'Afternoon'], ['Extra feed', 'Extra']] },
      ...farmDateFields(D),
    ],
    calc: (v) => { const left = f.stock - kgOf(v), b = band(left / f.target); return <>
      <Row l="This entry" r={`${n0(kgOf(v))} kg`} />
      <div><span>Left after this</span><b style={{ color: `var(${b.color})` }}>{n0(left / kgBag)} of {n0(f.targetBags)} bags · {pct(left / f.target, 0)}</b></div>
      <Row l="Buffer band" r={b.label} /></>; },
    onSubmit: async (v) => {
      if (kgOf(v) <= 0) throw new Error('Enter the feed given.');
      const back = await farmOn(D, v, 'feed_use', { kg: kgOf(v), house: v.house, note: v.note });
      if (back) return `${back} ${n0(kgOf(v))} kg taken off the feed store.`;
      const r = await rpc<{ band_label: string; level: number; notified: boolean }>('rpc_feed', { p_kind: 'use', p_kg: kgOf(v), p_house: v.house, p_note: v.note });
      return `Saved. Feed at ${pct(r.level, 0)} of the buffer (${r.band_label}).`;
    },
  };
}

export function feedInForm(D: Dashboard): FormSpec {
  const s = D.settings, f = feedInfo(D);
  return {
    title: 'Feed received',
    fields: [
      { type: 'pair', fields: [{ type: 'num', id: 'bags', label: 'Bags received', suffix: 'bags' }, { type: 'num', id: 'kgbag', label: 'Bag size', suffix: 'kg', def: s.bag_kg }] },
      { type: 'num', id: 'price', label: 'Price per bag', suffix: 'KES', def: s.bag_price },
      { type: 'select', id: 'paid', label: 'Paid from', options: [['none', 'Not paid yet / on account'], ['BANK', 'Bank'], ['PAYBILL', 'M-Pesa Paybill'], ['TILL', 'M-Pesa Till'], ['CASH:FARM', 'Cash at the farm']] },
    ],
    calc: (v) => { const add = v.bags * v.kgbag, b = band((f.stock + add) / f.target); return <>
      <Row l="Adds" r={`${n0(add)} kg · ${kes(v.bags * v.price)}`} />
      <div><span>Store after delivery</span><b style={{ color: `var(${b.color})` }}>{n0((f.stock + add) / s.bag_kg)} of {n0(f.targetBags)} bags · {b.label}</b></div></>; },
    onSubmit: async (v) => {
      if (v.bags <= 0) throw new Error('Enter the number of bags delivered.');
      const r = await rpc<{ stock: number; band_label: string }>('rpc_feed', { p_kind: 'in', p_kg: v.bags * v.kgbag, p_bags: v.bags, p_cost: v.bags * v.price,
        p_note: 'Layers feed', p_paid_from: v.paid === 'none' ? null : v.paid });
      return `Feed store now ${n0(r.stock / s.bag_kg)} bags (${r.band_label}).`;
    },
  };
}

export function waterIntakeForm(D: Dashboard): FormSpec {
  return {
    title: 'Water drunk',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Record the litres each house drank (meter difference, or litres put in the drinkers). Enter once a day, or after each refill.</p>,
    fields: [
      { type: 'select', id: 'house', label: 'House', options: houseOpts(D) },
      { type: 'num', id: 'l', label: 'Litres', suffix: 'L' },
      ...farmDateFields(D),
    ],
    calc: (v) => {
      const h = D.houses.find((x) => x.id === v.house), day = dayOf(D, v), t = tankInfo(D);
      const onDayL = waterOn(D, [day], v.house), counts = !!t && (day > t.readOn || day === D.today);
      return <>{h && <Row l={`${h.name} ${day === D.today ? 'today' : `on ${dlabel(day)}`} including this`} r={`${n0(onDayL + (v.l || 0))} L`} />}
        {t && counts && <Row l="Tank after this" r={`${n0(Math.max(0, t.litres - (v.l || 0)))} L · ${pct(Math.max(0, t.litres - (v.l || 0)) / t.cap, 0)}`} />}</>;
    },
    onSubmit: async (v) => {
      if (v.l <= 0) throw new Error('Enter the litres the birds drank.');
      const back = await farmOn(D, v, 'water', { house: v.house, litres: v.l });
      if (back) return back;
      await rpc('rpc_water', { p_kind: 'intake', p_litres: v.l, p_house: v.house });
      const t = tankInfo(D);
      return t ? `Water intake saved. Tank now about ${n0(Math.max(0, t.litres - v.l))} L.` : 'Water intake saved.';
    },
  };
}

export function tankForm(D: Dashboard): FormSpec {
  const cap = D.settings.tank_capacity_l, t = tankInfo(D);
  return {
    title: 'Tank level',
    fields: [{ type: 'num', id: 'l', label: 'Litres in the tank now', suffix: 'L', hint: `Tank holds ${n0(cap)} L.${t ? ` Last reading ${n0(t.reading)} L; about ${n0(t.litres)} L now after water drunk since.` : ''}` }],
    buttons: (_v, set) => <>{[1, 0.75, 0.5, 0.25].map((p) => <button key={p} type="button" className="btn sm alt" onClick={() => set({ l: Math.round(cap * p) })}>{p === 1 ? 'Full' : `${p * 100}%`}</button>)}</>,
    calc: (v) => { const b = band(v.l / cap); return <div><span>Level</span><b style={{ color: `var(${b.color})` }}>{pct(v.l / cap, 0)} · {b.label}</b></div>; },
    onSubmit: async (v) => {
      const r = await rpc<{ band_label: string; level: number; notified: boolean }>('rpc_water', { p_kind: 'tank', p_litres: v.l });
      return `Tank at ${pct(r.level, 0)} (${r.band_label}).`;
    },
  };
}

/** Categories offered for medicines; any category already in use is offered too, and a new one can be typed. */
export const MED_CATEGORIES = ['Vaccine', 'Antibiotic', 'Vitamin / supplement', 'Dewormer', 'Coccidiostat', 'Disinfectant', 'Other'];
const NEW = '__new';
function categoryOpts(D: Dashboard): [string, string][] {
  const extra = [...new Set(D.medicines.map((m) => m.category))].filter((c) => !MED_CATEGORIES.includes(c)).sort();
  return [...MED_CATEGORIES, ...extra].map((c): [string, string] => [c, c]).concat([[NEW, '+ New category…']]);
}
const categoryFields = (D: Dashboard, def?: string): Field[] => [
  { type: 'select', id: 'cat', label: 'Category', options: categoryOpts(D), def: def ?? 'Vaccine' },
  { type: 'group', show: (v) => v.cat === NEW, fields: [{ type: 'text', id: 'newcat', label: 'New category', placeholder: 'e.g. Coccidiostat, Probiotic' }] },
];
const chosenCategory = (v: V) => {
  const c = v.cat === NEW ? String(v.newcat ?? '').trim() : String(v.cat ?? '');
  if (!c) throw new Error('Type the name of the new category.');
  return c;
};

export function medForm(D: Dashboard, opts: { startNew?: boolean } = {}): FormSpec {
  const active = D.medicines.filter((m) => m.active)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const isNew = (v: V) => v.med === NEW;
  return {
    title: 'Medicine & vaccines',
    fields: [
      { type: 'select', id: 'med', label: 'Item',
        options: [...active.map((m): [string, string] => [String(m.id), `${m.category} · ${m.name} (${n0(m.stock)} ${m.unit})`]),
                  [NEW, '+ New item: first delivery of something not listed']],
        def: opts.startNew || !active.length ? NEW : String(active[0].id) },
      { type: 'group', show: (v) => !isNew(v), fields: [
        { type: 'select', id: 'kind', label: 'Movement', options: [['use', 'Used / given to birds'], ['in', 'Received into store']] },
        { type: 'num', id: 'qty', label: 'Quantity' },
        { type: 'group', show: (v) => v.kind === 'use', fields: [{ type: 'select', id: 'house', label: 'House', options: houseNameOpts(D) }] },
      ] },
      { type: 'group', show: isNew, fields: [
        { type: 'note', text: <div><span>Adds it to the medicine store with this delivery. The owner and farm manager are told.</span></div> },
        { type: 'text', id: 'name', label: 'Name', placeholder: 'e.g. Gumboro vaccine (IBD)' },
        ...categoryFields(D),
        { type: 'pair', fields: [{ type: 'text', id: 'unit', label: 'Counted in', placeholder: 'doses, ml, g, sachets' }, { type: 'num', id: 'nqty', label: 'Quantity received' }] },
        { type: 'num', id: 'reorder', label: 'Warn when stock falls to', hint: 'Optional. The store shows it as low at this level.' },
      ] },
      { type: 'text', id: 'note', label: 'Note', placeholder: 'e.g. booster dose, supplier, vet name' },
      ...farmDateFields(D),
    ],
    onSubmit: async (v) => {
      if (isNew(v) && dateArg(D, v)) throw new Error('Add a new item with today\'s date, then enter the earlier day.');
      if (isNew(v)) {
        if (!String(v.name ?? '').trim()) throw new Error('Enter the name of the medicine or vaccine.');
        const category = chosenCategory(v);
        if (!String(v.unit ?? '').trim()) throw new Error('Enter what it is counted in, e.g. doses, ml, g or sachets.');
        if (!(v.nqty > 0)) throw new Error('Enter the quantity received.');
        const r = await rpc<{ name: string; unit: string; stock: number; created: boolean }>('rpc_med_new',
          { p_name: v.name, p_category: category, p_unit: v.unit, p_qty: v.nqty, p_reorder: v.reorder || 0, p_note: v.note || null });
        return r.created ? `${r.name} added to the store with ${n0(r.stock)} ${r.unit}.` : `${r.name} was already listed. ${n0(r.stock)} ${r.unit} in store now.`;
      }
      if (!(v.qty > 0)) throw new Error('Enter the quantity.');
      const back = await farmOn(D, v, 'med', { medicine: Number(v.med), move: v.kind, qty: v.qty, house: v.kind === 'use' ? v.house : null, note: v.note || null });
      if (back) return back;
      const r = await rpc<{ stock: number; low: boolean }>('rpc_med', { p_medicine: Number(v.med), p_kind: v.kind, p_qty: v.qty, p_house: v.kind === 'use' ? v.house : null, p_note: v.note || null });
      const m = D.medicines.find((x) => String(x.id) === v.med)!;
      return `${m.name}: ${n0(r.stock)} ${m.unit} left${r.low ? ', below reorder level' : ''}.`;
    },
  };
}

export const mortForm = (D: Dashboard): FormSpec => ({
  title: 'Mortality',
  fields: [
    { type: 'select', id: 'house', label: 'House', options: houseOpts(D) },
    { type: 'num', id: 'n', label: 'Birds', suffix: 'birds', def: 1 },
    { type: 'select', id: 'cause', label: 'Cause', options: [['Unknown', 'Unknown'], ['Disease suspected', 'Disease suspected'], ['Weak / culled', 'Weak / culled'], ['Predator', 'Predator'], ['Injury', 'Injury'], ['Heat stress', 'Heat stress']] },
    ...farmDateFields(D),
  ],
  onSubmit: async (v) => {
    if (!(v.n > 0)) throw new Error('Enter the number of birds.');
    const back = await farmOn(D, v, 'deaths', { house: v.house, birds: v.n, cause: v.cause });
    if (back) return `${back} Hen count updated from that day.`;
    await rpc('rpc_mortality', { p_house: v.house, p_birds: v.n, p_cause: v.cause }); return 'Mortality recorded. Hen count updated.'; },
});

/* ---------------- the farm store (inventory clerk) ---------------- */
const houseIdOpts = (D: Dashboard): [string, string][] => [['', 'Choose a house'], ...houseOpts(D)];
const store = (action: string, p: Record<string, unknown>) => rpc<{ id: number; stock: number; unit?: string; name?: string; created?: boolean }>('rpc_store', { p_action: action, p });

/** Feed delivered to the store. Quantities only: the farm manager records any payment as an expense. */
export function storeFeedInForm(D: Dashboard): FormSpec {
  const f = feedInfo(D), kgBag = D.settings.bag_kg;
  return {
    title: 'Feed received',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Count the bags as they come off the lorry. Payment is recorded by the farm manager.</p>,
    fields: [
      { type: 'pair', fields: [{ type: 'num', id: 'bags', label: 'Bags received', suffix: 'bags' }, { type: 'num', id: 'kgbag', label: 'Bag size', suffix: 'kg', def: kgBag }] },
      { type: 'text', id: 'note', label: 'Supplier or delivery note (optional)', placeholder: 'e.g. Unga Farm Care, note 4512' },
    ],
    calc: (v) => <><Row l="In store now" r={`${n0(f.stockBags)} bags`} /><Row l="After this" r={`${n0(f.stockBags + (v.bags || 0) * (v.kgbag || kgBag) / kgBag)} bags`} /></>,
    onSubmit: async (v) => {
      if (!(v.bags > 0)) throw new Error('Enter the bags received.');
      await store('feed_in', { bags: v.bags, kg_per_bag: v.kgbag || kgBag, note: String(v.note ?? '').trim() || null });
      return `${n0(v.bags)} bags received into the store.`;
    },
  };
}

/** Feed issued to a house. The production clerk confirms what the house received. */
export function storeFeedIssueForm(D: Dashboard): FormSpec {
  const f = feedInfo(D), kgBag = D.settings.bag_kg;
  const kgOf = (v: V) => (v.bags || 0) * kgBag + (v.kg || 0);
  return {
    title: 'Issue feed to a house',
    fields: [
      { type: 'select', id: 'house', label: 'House', options: houseIdOpts(D) },
      { type: 'pair', fields: [{ type: 'num', id: 'bags', label: 'Bags', suffix: 'bags', step: 0.5 }, { type: 'num', id: 'kg', label: 'Plus loose', suffix: 'kg' }] },
      { type: 'select', id: 'note', label: 'Feeding', options: [['Morning feed', 'Morning'], ['Afternoon feed', 'Afternoon'], ['Extra feed', 'Extra']] },
    ],
    calc: (v) => { const left = f.stock - kgOf(v), b = band(left / f.target); return <>
      <Row l="This issue" r={`${n0(kgOf(v))} kg`} />
      <div><span>Left in the store</span><b style={{ color: `var(${b.color})` }}>{n0(left / kgBag)} bags · {pct(left / f.target, 0)} of the buffer</b></div>
      <Row l="Next" r="The production clerk confirms what the house received" /></>; },
    onSubmit: async (v) => {
      if (!v.house) throw new Error('Choose the house.');
      if (kgOf(v) <= 0) throw new Error('Enter the feed issued.');
      await store('feed_issue', { house: v.house, kg: kgOf(v), note: v.note });
      return `${n0(kgOf(v))} kg issued to ${D.houses.find((h) => h.id === v.house)?.name}. The production clerk confirms it.`;
    },
  };
}

/** Medicine and vaccines received into the store: a listed item, or a new one. */
export function storeMedInForm(D: Dashboard, opts: { startNew?: boolean } = {}): FormSpec {
  const active = D.medicines.filter((m) => m.active).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const isNew = (v: V) => v.med === NEW;
  return {
    title: 'Medicine received',
    fields: [
      { type: 'select', id: 'med', label: 'Item', options: [...active.map((m): [string, string] => [String(m.id), `${m.category} · ${m.name} (${n0(m.stock)} ${m.unit})`]), [NEW, '+ New item: not listed yet']],
        def: opts.startNew || !active.length ? NEW : String(active[0].id) },
      { type: 'group', show: (v) => !isNew(v), fields: [{ type: 'num', id: 'qty', label: 'Quantity received' }] },
      { type: 'group', show: isNew, fields: [
        { type: 'text', id: 'name', label: 'Name', placeholder: 'e.g. Gumboro vaccine (IBD)' },
        ...categoryFields(D),
        { type: 'pair', fields: [{ type: 'text', id: 'unit', label: 'Counted in', placeholder: 'doses, ml, g, sachets' }, { type: 'num', id: 'nqty', label: 'Quantity received' }] },
        { type: 'num', id: 'reorder', label: 'Warn when stock falls to', hint: 'Optional.' },
      ] },
      { type: 'text', id: 'note', label: 'Supplier or note (optional)' },
    ],
    onSubmit: async (v) => {
      const note = String(v.note ?? '').trim() || null;
      if (isNew(v)) {
        if (!String(v.name ?? '').trim()) throw new Error('Enter the name of the medicine or vaccine.');
        if (!String(v.unit ?? '').trim()) throw new Error('Enter what it is counted in, e.g. doses, ml, g or sachets.');
        if (!(v.nqty > 0)) throw new Error('Enter the quantity received.');
        const r = await store('med_new', { name: v.name, category: chosenCategory(v), unit: v.unit, qty: v.nqty, reorder: v.reorder || 0, note });
        return `${r.name} in the store: ${n0(r.stock)} ${r.unit}.`;
      }
      if (!(v.qty > 0)) throw new Error('Enter the quantity received.');
      const r = await store('med_in', { medicine: Number(v.med), qty: v.qty, note });
      return `${r.name}: ${n0(r.stock)} ${r.unit} in the store.`;
    },
  };
}

/** Medicine issued to a house. The production clerk confirms what the house received. */
export function storeMedIssueForm(D: Dashboard): FormSpec {
  const active = D.medicines.filter((m) => m.active && m.stock > 0).sort((a, b) => a.name.localeCompare(b.name));
  return {
    title: 'Issue medicine to a house',
    fields: [
      { type: 'select', id: 'med', label: 'Item', options: [['', 'Choose an item'], ...active.map((m): [string, string] => [String(m.id), `${m.name} (${n0(m.stock)} ${m.unit} in store)`])] },
      { type: 'select', id: 'house', label: 'House', options: houseIdOpts(D) },
      { type: 'num', id: 'qty', label: 'Quantity issued' },
      { type: 'text', id: 'note', label: 'Note (optional)', placeholder: 'e.g. booster dose, vet name' },
    ],
    calc: (v) => { const m = D.medicines.find((x) => String(x.id) === v.med); return m ? <Row l="Left in the store" r={`${n0(m.stock - (v.qty || 0))} ${m.unit}`} /> : null; },
    onSubmit: async (v) => {
      if (!v.med) throw new Error('Choose the item.');
      if (!v.house) throw new Error('Choose the house.');
      if (!(v.qty > 0)) throw new Error('Enter the quantity issued.');
      const r = await store('med_issue', { medicine: Number(v.med), house: v.house, qty: v.qty, note: String(v.note ?? '').trim() || null });
      return `Issued. ${n0(r.stock)} ${r.unit} left. The production clerk confirms it.`;
    },
  };
}

const SUPPLY_CATS = ['Packaging', 'Cleaning and disinfectant', 'Tools and equipment', 'Litter and bedding', 'Other'];
/** Other supplies received: a listed item, or a new one. */
export function supplyInForm(D: Dashboard, pick?: Supply): FormSpec {
  const list = (D.supplies ?? []).filter((x) => x.active);
  const isNew = (v: V) => v.item === NEW;
  return {
    title: 'Supplies received',
    fields: [
      { type: 'select', id: 'item', label: 'Item', options: [...list.map((x): [string, string] => [String(x.id), `${x.name} (${n0(x.stock)} ${x.unit})`]), [NEW, '+ New item: not listed yet']],
        def: pick ? String(pick.id) : list.length ? String(list[0].id) : NEW },
      { type: 'group', show: isNew, fields: [
        { type: 'text', id: 'name', label: 'Name', placeholder: 'e.g. Egg trays, Jik, wheelbarrow' },
        { type: 'select', id: 'cat', label: 'Category', options: SUPPLY_CATS.map((c): [string, string] => [c, c]) },
        { type: 'pair', fields: [{ type: 'text', id: 'unit', label: 'Counted in', placeholder: 'trays, litres, pieces' }, { type: 'num', id: 'reorder', label: 'Warn when it falls to' }] },
      ] },
      { type: 'num', id: 'qty', label: 'Quantity received' },
      { type: 'text', id: 'note', label: 'Supplier or note (optional)' },
    ],
    onSubmit: async (v) => {
      if (!(v.qty > 0)) throw new Error('Enter the quantity received.');
      const note = String(v.note ?? '').trim() || null;
      if (isNew(v)) {
        if (!String(v.name ?? '').trim()) throw new Error('Enter the name of the item.');
        if (!String(v.unit ?? '').trim()) throw new Error('Enter what it is counted in.');
        const r = await store('supply_new', { name: v.name, category: v.cat, unit: v.unit, reorder: v.reorder || 0, qty: v.qty, note });
        return `${r.name}: ${n0(r.stock)} ${r.unit} in the store.`;
      }
      const r = await store('supply_in', { supply: Number(v.item), qty: v.qty, note });
      return `Received. ${n0(r.stock)} ${r.unit} in the store.`;
    },
  };
}

/** Other supplies issued from the store, with what or where they went. */
export function supplyOutForm(D: Dashboard, pick?: Supply): FormSpec {
  const list = (D.supplies ?? []).filter((x) => x.active && x.stock > 0);
  const where: [string, string][] = [...D.houses.map((h): [string, string] => [h.name, h.name]), ...D.locations.map((l): [string, string] => [l.name, l.name]), ['Farm use', 'Farm use'], [NEW, 'Something else']];
  return {
    title: 'Issue supplies',
    fields: [
      { type: 'select', id: 'item', label: 'Item', options: [['', 'Choose an item'], ...list.map((x): [string, string] => [String(x.id), `${x.name} (${n0(x.stock)} ${x.unit} in store)`])], def: pick ? String(pick.id) : '' },
      { type: 'num', id: 'qty', label: 'Quantity issued' },
      { type: 'select', id: 'to', label: 'Issued to', options: where },
      { type: 'group', show: (v) => v.to === NEW, fields: [{ type: 'text', id: 'other', label: 'What for', placeholder: 'e.g. repairs to House B roof' }] },
      { type: 'text', id: 'note', label: 'Note (optional)' },
    ],
    calc: (v) => { const x = list.find((s) => String(s.id) === v.item); return x ? <Row l="Left in the store" r={`${n0(x.stock - (v.qty || 0))} ${x.unit}`} /> : null; },
    onSubmit: async (v) => {
      if (!v.item) throw new Error('Choose the item.');
      if (!(v.qty > 0)) throw new Error('Enter the quantity issued.');
      const purpose = v.to === NEW ? String(v.other ?? '').trim() : String(v.to ?? '');
      if (!purpose) throw new Error('Say what it was issued for.');
      const r = await store('supply_out', { supply: Number(v.item), qty: v.qty, purpose, note: String(v.note ?? '').trim() || null });
      return `Issued. ${n0(r.stock)} ${r.unit} left.`;
    },
  };
}

/** Edit a supply item (name, category, unit, reorder level, in use). */
export const supplyForm = (_D: Dashboard, x: Supply): FormSpec => ({
  title: `Edit ${x.name}`,
  fields: [
    { type: 'text', id: 'name', label: 'Name', def: x.name },
    { type: 'select', id: 'cat', label: 'Category', options: [...new Set([...SUPPLY_CATS, x.category])].map((c): [string, string] => [c, c]), def: x.category },
    { type: 'pair', fields: [{ type: 'text', id: 'unit', label: 'Counted in', def: x.unit }, { type: 'num', id: 'reorder', label: 'Warn when it falls to', def: x.reorder }] },
    { type: 'select', id: 'active', label: 'In use', options: [['true', 'Yes'], ['false', 'No longer used']], def: String(x.active) },
  ],
  onSubmit: async (v) => {
    await rpc('rpc_supply_save', { p_id: x.id, p_name: v.name, p_category: v.cat, p_unit: v.unit, p_reorder: v.reorder || 0, p_active: v.active === 'true' });
    return 'Saved.';
  },
});

/* ---------------- the feed mill ---------------- */
const mill = (action: string, p: Record<string, unknown>, day: string | null) =>
  rpc<Record<string, any>>('rpc_mill', { p_action: action, p, p_date: day });
const rawOpts = (D: Dashboard, all = false): [string, string][] => (D.raw ?? []).filter((m) => all || m.active)
  .sort((a, b) => a.sort - b.sort || a.id - b.id).map((m) => [String(m.id), `${m.name} (${n0(m.stock)} kg)`]);
const rawOf = (D: Dashboard, id: unknown) => (D.raw ?? []).find((m) => String(m.id) === String(id));
const tns = (t: number) => `${(Math.round(t * 100) / 100).toLocaleString('en-KE', { maximumFractionDigits: 2 })} tonne${t === 1 ? '' : 's'}`;

/** A delivery of a raw material, in bags of its usual size plus any loose kg. */
export function rawInForm(D: Dashboard, m?: RawMaterial): FormSpec {
  const kgOf = (v: V) => { const x = rawOf(D, v.mat); return (v.bags || 0) * (x?.bag_kg ?? 50) + (v.kg || 0); };
  return {
    title: 'Raw material received',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Count the bags as they come off the lorry. Payment is recorded by the farm manager.</p>,
    fields: [
      ...dateFields(D),
      { type: 'select', id: 'mat', label: 'Raw material', options: rawOpts(D), def: m ? String(m.id) : undefined },
      { type: 'pair', fields: [{ type: 'num', id: 'bags', label: 'Bags', suffix: 'bags' }, { type: 'num', id: 'kg', label: 'Plus loose', suffix: 'kg' }] },
      { type: 'text', id: 'note', label: 'Supplier or delivery note (optional)', placeholder: 'e.g. maize from Isiolo, note 118' },
    ],
    calc: (v) => { const x = rawOf(D, v.mat); if (!x) return null; return <>
      <Row l="This delivery" r={`${n0(kgOf(v))} kg${v.bags ? ` (bags of ${n0(x.bag_kg)} kg)` : ''}`} />
      <Row l={`${x.name} in store after this`} r={`${n0(x.stock + kgOf(v))} kg · ${n0((x.stock + kgOf(v)) / x.bag_kg)} bags`} /></>; },
    onSubmit: async (v) => {
      if (!v.mat) throw new Error('Choose the raw material.');
      if (kgOf(v) <= 0) throw new Error('Enter the bags or kg received.');
      const r = await mill('raw_in', { material: Number(v.mat), kg: kgOf(v), note: String(v.note ?? '').trim() || null }, dateArg(D, v));
      return `${n0(r.kg)} kg of ${r.name} received${onDay(D, v)}.`;
    },
  };
}

/** Feed milled: the recipe takes each raw material out of the store and the feed goes into the feed store in bags. */
export function millForm(D: Dashboard): FormSpec {
  const info = millInfo(D), bagKg = D.settings.bag_kg;
  return {
    title: 'Feed milled',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Enter the tonnes mixed. The recipe works out what each raw material used, and the feed goes into the feed store.
      {info.limit ? ` The store can make ${tns(Math.floor(info.cap * 10) / 10)} now.` : ''}</p>,
    fields: [
      ...dateFields(D),
      { type: 'num', id: 't', label: 'Tonnes mixed', suffix: 'tonnes', step: 0.5, def: info.cap >= info.batch ? info.batch : '' },
      { type: 'text', id: 'note', label: 'Note (optional)', placeholder: 'e.g. layers mash, second mixing' },
    ],
    calc: (v) => {
      if (!info.recipeOk) return <Bad l="The recipe" r={`adds up to ${n0(info.recipeKg)} kg, not 1,000. The farm manager fixes it under Feed mill.`} />;
      if (!(v.t > 0)) return null;
      const need = millNeeds(D, v.t), short = need.filter((x) => x.short > 0);
      return <>
        {need.map((x) => x.short > 0 ? <Bad key={x.id} l={x.name} r={`needs ${n0(x.need)} kg, ${n0(Math.max(0, x.stock))} in store`} />
          : <Row key={x.id} l={x.name} r={`${n0(x.need)} kg of ${n0(x.stock)}`} />)}
        {short.length ? <Bad l="Not enough in the store" r="Record the delivery or count the store first" />
          : <Row l="Into the feed store" r={`${n0(v.t * 1000)} kg · ${n0(v.t * 1000 / bagKg)} bags of ${n0(bagKg)} kg`} />}</>;
    },
    onSubmit: async (v) => {
      if (!(v.t > 0)) throw new Error('Enter the tonnes mixed.');
      const r = await mill('mill', { tonnes: v.t, note: String(v.note ?? '').trim() || null }, dateArg(D, v));
      return `${tns(v.t)} milled${onDay(D, v)}: ${n0(r.bags)} bags into the feed store.`;
    },
  };
}

/** A count of what is really in the raw material store. The difference from the book is recorded, the book follows the count. */
export function rawCountForm(D: Dashboard, m?: RawMaterial): FormSpec {
  const kgOf = (v: V) => { const x = rawOf(D, v.mat); return (v.bags || 0) * (x?.bag_kg ?? 50) + (v.kg || 0); };
  return {
    title: 'Count the raw material store',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Count full bags and weigh any loose material. The app records the difference from its book.</p>,
    fields: [
      ...dateFields(D),
      { type: 'select', id: 'mat', label: 'Raw material', options: rawOpts(D, true), def: m ? String(m.id) : undefined },
      { type: 'pair', fields: [{ type: 'num', id: 'bags', label: 'Full bags', suffix: 'bags' }, { type: 'num', id: 'kg', label: 'Plus loose', suffix: 'kg' }] },
      { type: 'text', id: 'note', label: 'Note (needed if it differs)', placeholder: 'e.g. two bags torn, rats' },
    ],
    calc: (v) => { const x = rawOf(D, v.mat); if (!x) return null; const d = kgOf(v) - x.stock; return <>
      <Row l="The book says" r={`${n0(x.stock)} kg`} /><Row l="Counted" r={`${n0(kgOf(v))} kg`} />
      {Math.abs(d) < 0.5 ? <Ok>Matches the book</Ok> : <Bad l="Difference" r={`${d > 0 ? '+' : ''}${n0(d)} kg`} />}</>; },
    onSubmit: async (v) => {
      const x = rawOf(D, v.mat);
      if (!x) throw new Error('Choose the raw material.');
      if (Math.abs(kgOf(v) - x.stock) >= 0.5 && !String(v.note ?? '').trim()) throw new Error('Say why the count differs from the book.');
      const r = await mill('raw_count', { material: x.id, counted_kg: kgOf(v), note: String(v.note ?? '').trim() || null }, dateArg(D, v));
      return Math.abs(r.difference) < 0.5 ? `${x.name} matches the book.` : `${x.name} counted: ${r.difference > 0 ? '+' : ''}${n0(r.difference)} kg against the book.`;
    },
  };
}

/** The raw material list and the recipe (kg per tonne), saved together; the materials in use must add up to 1,000 kg. */
export function recipeForm(D: Dashboard): FormSpec {
  const mats = [...(D.raw ?? [])].sort((a, b) => a.sort - b.sort || a.id - b.id);
  const EXTRA = ['x1', 'x2'];
  const rows = (v: V) => [
    ...mats.map((m) => ({ id: m.id as number | undefined, name: String(v[`n${m.id}`] ?? '').trim(), per_tonne: +v[`k${m.id}`] || 0, bag_kg: +v[`b${m.id}`] || 0, active: v[`a${m.id}`] === 'true' })),
    ...EXTRA.map((k) => ({ id: undefined, name: String(v[`n${k}`] ?? '').trim(), per_tonne: +v[`k${k}`] || 0, bag_kg: +v[`b${k}`] || 50, active: true })).filter((r) => r.name),
  ];
  const total = (v: V) => rows(v).filter((r) => r.active).reduce((a, r) => a + r.per_tonne, 0);
  const block = (k: string | number, m?: RawMaterial): Field[] => [
    { type: 'text', id: `n${k}`, label: m ? 'Name' : 'New raw material (optional)', def: m?.name ?? '', placeholder: m ? undefined : 'e.g. Fish meal' },
    { type: 'pair', fields: [{ type: 'num', id: `k${k}`, label: 'kg in a tonne of feed', suffix: 'kg', def: m ? m.per_tonne : '' },
      { type: 'num', id: `b${k}`, label: 'Bag size', suffix: 'kg', def: m ? m.bag_kg : 50 }] },
    ...(m ? [{ type: 'select', id: `a${k}`, label: 'In use', options: [['true', 'Yes'], ['false', 'No longer used']], def: String(m.active) } as Field] : []),
  ];
  return {
    title: 'Feed recipe',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>The kg of each raw material in one tonne of feed. Every milling uses this recipe, and the materials in use must add up to 1,000 kg. Earlier millings keep the recipe they used.</p>,
    fields: [...mats.flatMap((m) => [{ type: 'note', text: <b>{m.name}</b> } as Field, ...block(m.id, m)]), ...EXTRA.flatMap((k) => block(k))],
    calc: (v) => { const t = total(v); return Math.abs(t - 1000) < 0.001 ? <Ok>Adds up to 1,000 kg a tonne</Ok>
      : <Bad l="The recipe adds up to" r={`${n0(t)} kg. ${t > 1000 ? `Take off ${n0(t - 1000)} kg` : `Add ${n0(1000 - t)} kg`}`} />; },
    onSubmit: async (v) => {
      const r = rows(v);
      if (r.some((x) => !x.name)) throw new Error('Every raw material needs a name.');
      if (Math.abs(total(v) - 1000) >= 0.001) throw new Error(`The recipe adds up to ${n0(total(v))} kg. It must be 1,000 kg a tonne.`);
      await rpc('rpc_recipe_save', { p_rows: r.map((x) => (x.id ? x : { name: x.name, per_tonne: x.per_tonne, bag_kg: x.bag_kg, active: true })) });
      return 'Recipe saved. The next milling uses it.';
    },
  };
}

/** The production clerk confirms what a house received from the store. */
export function confirmIssueForm(_D: Dashboard, x: StorePending): FormSpec {
  return {
    title: `Confirm ${x.kind === 'feed' ? 'feed' : x.what} for ${x.house}`,
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>The store issued {n0(x.qty)} {x.unit}{x.by_name ? ` (${x.by_name})` : ''} on {dlabel(x.d)}. Enter what actually reached {x.house}.</p>,
    fields: [
      { type: 'num', id: 'got', label: 'Received at the house', suffix: x.unit, def: x.qty },
      { type: 'text', id: 'note', label: 'Note (needed if less arrived)', placeholder: 'e.g. one bag torn' },
    ],
    calc: (v) => (v.got < x.qty ? <Bad l="Short" r={`${n0(x.qty - v.got)} ${x.unit}. The farm manager and the store are told.`} /> : <Ok>All of it arrived</Ok>),
    onSubmit: async (v) => {
      if (!(v.got >= 0)) throw new Error('Enter what the house received.');
      if (v.got > x.qty) throw new Error(`The store issued ${n0(x.qty)} ${x.unit}. Enter that or less.`);
      if (v.got < x.qty && !String(v.note ?? '').trim()) throw new Error('Say what happened to the rest.');
      await rpc('rpc_confirm_issue', { p_kind: x.kind, p_id: x.id, p_received: v.got, p_note: String(v.note ?? '').trim() || null });
      return v.got < x.qty ? `Confirmed ${n0(v.got)} ${x.unit}. The shortfall is flagged.` : 'Confirmed.';
    },
  };
}

/* ---------------- stock movement ---------------- */
/** Issue eggs: send stock from one location to another. One destination per entry, chosen from a list. */
/** Send eggs to another location. For the van: "Deliver eggs", and `leftover` fills in everything still on board. */
export function dispatchForm(D: Dashboard, from: string, opts: { leftover?: boolean } = {}): FormSpec {
  const st = stockNow(D, from), van = isVan(D, from);
  const dests = D.locations.filter((l) => l.id !== from);
  const name = (id: unknown) => dests.find((l) => l.id === id)?.name ?? '';
  return {
    title: opts.leftover ? 'Drop off what is left' : van ? 'Deliver eggs' : 'Issue eggs',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>{opts.leftover ? 'The van ends the day empty. Leave what is on board at the farm or an outlet; they confirm the count.'
      : van ? 'Deliver eggs from the van to the farm or an outlet. They confirm the count when it arrives.'
      : `Send eggs from ${locName(D, from)} to another location. That location confirms the count when they arrive.`}</p>,
    fields: [
      { type: 'note', text: <div><span>{van ? 'On the van' : `In stock at ${locName(D, from)}`}</span><b>{mix(st)}</b></div> },
      { type: 'select', id: 'to', label: 'Send to', options: [['', 'Choose a location'], ...dests.map((l): [string, string] => [l.id, l.name])] },
      ...gradeFields('', opts.leftover ? { def: { n: Math.max(0, st.n + st.b), c: Math.max(0, st.c), j: Math.max(0, st.j) } } : {}),
      { type: 'text', id: 'note', label: 'Note (optional)', placeholder: 'e.g. vehicle or who is carrying them' },
    ],
    submit: opts.leftover ? 'Drop off' : van ? 'Deliver' : 'Issue eggs',
    calc: (v) => {
      const q = gradesOf(v);
      if (!v.to) return <div><span className="muted">Choose where the eggs are going</span></div>;
      if (!tot(q)) return <div><span className="muted">Enter the eggs you are sending to {name(v.to)}</span></div>;
      const o = over(q, st);
      return <><Row l={`To ${name(v.to)}`} r={mix(q)} />
        {o ? <Bad l={o} r="Check" /> : <Row l="Left after" r={mix({ n: st.n - q.n, b: st.b - q.b, c: st.c - q.c, j: st.j - q.j })} />}</>;
    },
    onSubmit: async (v) => {
      const q = gradesOf(v);
      if (!v.to) throw new Error('Choose where the eggs are going.');
      if (!tot(q)) throw new Error('Enter the eggs you are sending.');
      await rpc('rpc_dispatch_many', { p_from: from, p_items: [{ to: v.to, n: q.n, b: q.b, c: q.c, j: q.j }], p_note: String(v.note ?? '').trim() || null });
      return `${eggs(tot(q))} ${van ? 'delivered' : 'issued'} to ${name(v.to)}. They confirm the count on arrival.`;
    },
  };
}

const sentOf = (x: Transfer): Q => ({ n: x.sent_n, b: x.sent_b ?? 0, c: x.sent_c, j: x.sent_j });
export function receiveForm(D: Dashboard, x: Transfer): FormSpec {
  const sent = sentOf(x);
  const only = ITEMS.filter((i) => sent[i.toLowerCase() as keyof Q] > 0);
  return {
    title: `Receive from ${locName(D, x.from_loc)}`,
    intro: <div className="calc"><Row l={`Sent ${dlabel(x.d)}`} r={mix(sent)} /><div><span>Count what arrived in good condition. Broken eggs go under Damaged.</span></div></div>,
    fields: [...gradeFields('', { def: sent, only: only.length ? only : ['N'], dmg: 'Damaged on arrival' })],
    submit: 'Confirm receipt',
    calc: (v) => {
      const q = gradesOf(v), short = tot(sent) - tot(q);
      if (q.n > sent.n || q.b > sent.b || q.c > sent.c || q.j > sent.j) return <Bad l="More than was sent" r="Check the count" />;
      if (short === 0) return v.dmg ? <Bad l="Damaged eggs, but nothing is short" r="Check" /> : <Ok>Matches what was sent</Ok>;
      return <><Row l="Good eggs received" r={eggs(tot(q))} />
        {v.dmg > short ? <Bad l="Damaged is more than the shortfall" r={`${short} pc short`} /> : <>
          {v.dmg > 0 && <Row l="Damaged on arrival" r={`${v.dmg} pc`} />}
          {short - v.dmg > 0 && <Bad l="Missing" r={eggs(short - v.dmg)} />}</>}
        <div><span>Written off and reported to the Farm Manager</span></div></>;
    },
    onSubmit: async (v) => {
      const q = gradesOf(v);
      const res = await rpc<{ short: number; damaged: number; missing: number }>('rpc_receive_delivery', { p_transfer: x.id, p_n: q.n, p_b: q.b, p_j: q.j, p_c: q.c, p_dmg: v.dmg });
      return res.short > 0 ? `Received: ${res.damaged} damaged, ${eggs(res.missing)} missing. The difference is on record.` : 'Delivery received. Stock updated.';
    },
  };
}

/** Eggs leaving the outlet to someone outside the app: a customer on credit, a bulk buyer, another farm. */
export function issueForm(D: Dashboard, loc: string): FormSpec {
  const st = stockNow(D, loc);
  return {
    title: 'Eggs out, no sale',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>For eggs that leave without a sale: owner or staff use, eggs returned to a supplier. Sending to another location is <b>Issue eggs</b>; a customer paying later is a sale paid on <b>Credit</b>.</p>,
    fields: [
      ...dateFields(D),
      { type: 'note', text: <div><span>In stock</span><b>{mix(st)}</b></div> },
      ...gradeFields(''),
      { type: 'text', id: 'party', label: 'Given to', placeholder: 'Name of the person or place' },
      { type: 'select', id: 'why', label: 'Reason', options: [['Owner / staff use', 'Owner / staff use'], ['Returned to supplier', 'Returned to supplier'], ['Other', 'Other']] },
      { type: 'text', id: 'note', label: 'Note (optional)', placeholder: 'e.g. pays on Friday' },
    ],
    calc: (v) => { const q = gradesOf(v), o = over(q, st); return <>{o ? <Bad l={o} r="Check" /> : <Row l="Going out" r={mix(q)} />}</>; },
    onSubmit: async (v) => {
      const q = gradesOf(v);
      if (!tot(q)) throw new Error('Enter the eggs going out.');
      if (!String(v.party ?? '').trim()) throw new Error('Say who received the eggs.');
      await rpc('rpc_issue_out', { p_loc: loc, p_n: q.n, p_b: q.b, p_j: q.j, p_c: q.c, p_party: String(v.party).trim(),
        p_note: [v.why, v.note].filter(Boolean).join(': '), p_date: dateArg(D, v) });
      return `${eggs(tot(q))} recorded as out to ${String(v.party).trim()}${onDay(D, v)}.`;
    },
  };
}

/** Damaged at the outlet: broken in handling, spoiled, returned. Always written off. */
export function breakageForm(D: Dashboard, loc: string): FormSpec {
  const st = stockNow(D, loc);
  const have = (i: Item) => st[i.toLowerCase() as keyof Q];
  return {
    title: 'Damaged eggs',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Eggs too broken to sell. Cracked eggs that can still be sold stay in stock as <b>Cracked</b>.</p>,
    fields: [
      { type: 'select', id: 'item', label: 'Grade', options: ITEMS.map((i): [string, string] => [i, `${ITEM_NAME[i]} (${eggs(have(i))})`]) },
      { type: 'num', id: 'qty', label: 'Damaged', suffix: 'pieces' },
      { type: 'select', id: 'reason', label: 'Reason', options: [['Broken in handling', 'Broken in handling'], ['Customer return', 'Customer return'], ['Spoiled', 'Spoiled / expired'], ['Broken on the road', 'Broken on the road']] },
    ],
    onSubmit: async (v) => { await rpc('rpc_breakage', { p_loc: loc, p_item: v.item, p_qty: v.qty, p_reason: v.reason }); return 'Written off. Stock updated.'; },
  };
}

/* ---------------- sales ---------------- */
export function saleForm(D: Dashboard, loc: string): FormSpec {
  const st = stockNow(D, loc), s = D.settings;
  const list = (v: V) => priceOf(D, gradesOf(v));
  const due = (v: V) => (v.agreed > 0 ? v.agreed : list(v));
  return {
    title: 'Record sale',
    fields: [
      ...dateFields(D),
      ...gradeFields('', { hint: { N: `On the shelf: ${eggs(st.n)} · ${n0(s.tray_n)} a tray, ${s.pc_n} a piece`, B: `On the shelf: ${eggs(st.b)} · ${n0(s.tray_b)} a tray, ${s.pc_b} a piece`,
                                   C: `On the shelf: ${eggs(st.c)} · ${n0(s.tray_c)} a tray, ${s.pc_c} a piece` } }),
      { type: 'num', id: 'agreed', label: 'Agreed price (only if different)', suffix: 'KES', hint: 'Leave blank to charge the list price.' },
      { type: 'pair', fields: [{ type: 'num', id: 'cash', label: 'Cash', suffix: 'KES' }, { type: 'num', id: 'till', label: 'M-Pesa Till', suffix: 'KES' }] },
      { type: 'pair', fields: [{ type: 'num', id: 'paybill', label: 'M-Pesa Paybill', suffix: 'KES' }, { type: 'num', id: 'credit', label: 'Credit (pays later)', suffix: 'KES' }] },
      { type: 'text', id: 'customer', label: 'Customer (needed for credit)', placeholder: 'e.g. hotel or regular buyer' },
    ],
    calc: (v) => { const d = due(v), paid = v.cash + v.till + v.paybill + (v.credit || 0), rem = d - paid, o = over(gradesOf(v), st); return <>
      {o && <Bad l={o} r="Check" />}
      <div><span>Amount due</span><b className="big">{kes(d)}</b></div>
      {v.agreed > 0 && v.agreed !== list(v) && <Row l="List price" r={`${kes(list(v))} (${v.agreed < list(v) ? 'discount' : 'premium'} ${kes(Math.abs(list(v) - v.agreed))})`} />}
      {d === 0 && paid === 0 ? <div><span className="muted">Enter the eggs sold, then how the customer paid</span></div>
        : d > 0 && rem === 0 ? <Ok>Payments add up to {kes(paid)}{v.credit > 0 ? `, ${kes(v.credit)} on credit` : ''}</Ok> : <Bad l={rem > 0 ? 'Still to allocate' : 'Over-allocated'} r={kes(Math.abs(rem))} />}
      {v.credit > 0 && !String(v.customer ?? '').trim() && <Bad l="Credit needs the customer's name" r="Add it below" />}</>; },
    buttons: (v, set) => <>{(['cash', 'till', 'paybill', 'credit'] as const).map((m) => (
      <button key={m} type="button" className="btn sm alt" onClick={() => set({ cash: '', till: '', paybill: '', credit: '', [m]: due(v) })}>All {m === 'cash' ? 'cash' : m === 'till' ? 'Till' : m === 'paybill' ? 'Paybill' : 'credit'}</button>))}</>,
    onSubmit: async (v) => {
      const d = due(v), q = gradesOf(v);
      if (!tot(q)) throw new Error('Enter the eggs sold.');
      const credit = v.credit || 0, paid = v.cash + v.till + v.paybill + credit;
      if (paid !== d) throw new Error(`Payments (${kes(paid)}) must equal the amount due (${kes(d)}).`);
      if (credit > 0 && !String(v.customer ?? '').trim()) throw new Error('Enter the name of the customer who will pay later.');
      await rpc('rpc_sale_with_credit', { p_loc: loc, p_n: q.n, p_j: q.j, p_c: q.c, p_cash: v.cash, p_till: v.till, p_paybill: v.paybill, p_credit: credit,
        p_customer: String(v.customer ?? '').trim() || null, p_value: v.agreed > 0 ? v.agreed : null, p_date: dateArg(D, v) });
      return `Sale of ${kes(d)} saved${credit > 0 ? `, ${kes(credit)} on credit to ${String(v.customer).trim()}` : ''}${onDay(D, v)}.`;
    },
  };
}

/** A customer who bought on credit pays (part of) what they owe. Oldest credit sales are paid first. */
export function creditPaidForm(D: Dashboard, loc: string | null, pick?: Credit): FormSpec {
  const open = (D.credits ?? []).filter((c) => !loc || c.location_id === loc);
  const key = (c: Credit) => `${c.location_id}|${c.customer}`;
  const opts: [string, string][] = open.map((c) => [key(c), `${c.customer}${loc ? '' : ` · ${locName(D, c.location_id)}`} · owes ${kes(c.owed)}`]);
  const chosen = (v: V) => open.find((c) => key(c) === v.who);
  return {
    title: 'Credit paid',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>A customer who bought on credit pays now. The money goes into the cash drawer, Till or Paybill, and what they owe goes down.</p>,
    fields: [
      ...(open.length ? [{ type: 'select', id: 'who', label: 'Customer', options: opts, def: pick ? key(pick) : opts[0][0] } as Field]
                      : [{ type: 'note', text: <div><span>No one owes anything{loc ? ' at this outlet' : ''}.</span></div> } as Field]),
      { type: 'num', id: 'amt', label: 'Amount paid', suffix: 'KES', def: pick ? pick.owed : open[0]?.owed ?? '' },
      { type: 'select', id: 'method', label: 'Paid by', options: [['cash', 'Cash'], ['till', 'M-Pesa Till'], ['paybill', 'M-Pesa Paybill']] },
      ...dateFields(D, 'Leave as today unless the payment came on an earlier day.'),
      { type: 'text', id: 'note', label: 'Note', placeholder: 'e.g. M-Pesa code' },
    ],
    calc: (v) => { const c = chosen(v); if (!c) return null; const left = c.owed - (v.amt || 0); return <>
      <Row l={`${c.customer} owes`} r={kes(c.owed)} />
      {left < 0 ? <Bad l="More than they owe" r={kes(-left)} /> : <Row l="Still owed after this" r={kes(left)} />}</>; },
    buttons: (v, set) => { const c = chosen(v); return c ? <button type="button" className="btn sm alt" onClick={() => set({ amt: c.owed })}>Paid in full</button> : null; },
    onSubmit: async (v) => {
      const c = chosen(v);
      if (!c) throw new Error('No credit to pay.');
      if (!(v.amt > 0)) throw new Error('Enter the amount paid.');
      if (v.amt > c.owed) throw new Error(`${c.customer} owes ${kes(c.owed)}. Enter that amount or less.`);
      const r = await rpc<{ still_owed: number }>('rpc_credit_paid', { p_loc: c.location_id, p_customer: c.customer, p_amount: v.amt, p_method: v.method,
        p_date: dateArg(D, v), p_note: String(v.note ?? '').trim() || null });
      return r.still_owed > 0 ? `${kes(v.amt)} received from ${c.customer}${onDay(D, v)}. Still owes ${kes(r.still_owed)}.` : `${c.customer} has paid in full${onDay(D, v)}.`;
    },
  };
}

/**
 * The shop's daily book in one sheet, the way the paper book is kept:
 * opening + received - issued - damaged - sold = closing. Opening and
 * received fill in from the records; the closing count shows any gap.
 */
export function shopDayForm(D: Dashboard, loc: string, day?: string): FormSpec {
  const exp = balance(D, cashAcc(loc));
  const book = (v: V) => dayLedger(D, loc, dayOf(D, v));
  const all = (v: V) => v.grades === 'all';
  const sold = (v: V) => ({ n: v.s_n || 0, b: all(v) ? v.s_b || 0 : 0, c: all(v) ? v.s_c || 0 : 0, j: all(v) ? v.s_j || 0 : 0 });
  const iss = (v: V) => ({ n: v.i_n || 0, b: all(v) ? v.i_b || 0 : 0, c: all(v) ? v.i_c || 0 : 0, j: all(v) ? v.i_j || 0 : 0 });
  const dmg = (v: V) => ({ n: v.d_n || 0, b: all(v) ? v.d_b || 0 : 0, c: all(v) ? v.d_c || 0 : 0, j: all(v) ? v.d_j || 0 : 0 });
  const value = (v: V) => (v.s_value > 0 ? v.s_value : priceOf(D, sold(v)));
  const expected = (v: V): Q => { const L = book(v); const k = (g: keyof Q) => L.close[g] - iss(v)[g] - dmg(v)[g] - sold(v)[g]; return { n: k('n'), b: k('b'), c: k('c'), j: k('j') }; };
  const section = (p: string, title: string): Field[] => [
    { type: 'note', text: <div className="dest"><b>{title}</b></div> },
    { type: 'eggs', id: `${p}n`, label: 'Normal eggs' },
    { type: 'group', show: all, fields: gradeFields(p, { only: ['B', 'C', 'J'] }) },
  ];
  const today = (v: V) => dayOf(D, v) === D.today;
  const traded = (v: V) => (v.trading ?? 'open') === 'open';
  return {
    title: `Daily stock sheet · ${locName(D, loc)}`,
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Like the shop book. Opening stock and deliveries received fill in by themselves; enter what is not in the app yet, then the closing count.</p>,
    fields: [
      ...dateFields(D, undefined, day),
      { type: 'select', id: 'trading', label: 'The day', options: [['open', 'We traded'], ['closed', 'Closed all day'],
          ...(isMgmt(D) ? [] : [['closed_y', 'We were closed yesterday']] as [string, string][])] },
      { type: 'group', show: traded, fields: [
      { type: 'select', id: 'grades', label: 'Grades', options: [['normal', 'Normal eggs only'], ['all', 'All grades (cracked, jumbo)']] },
      ...section('i_', 'Issued (credit, bulk) not yet entered'),
      { type: 'text', id: 'party', label: 'Issued to', placeholder: 'Name, or "Various credit customers"' },
      ...section('d_', 'Damaged not yet entered'),
      ...section('s_', 'Sales not yet entered'),
      { type: 'pair', fields: [{ type: 'num', id: 's_cash', label: 'Cash', suffix: 'KES' }, { type: 'num', id: 's_till', label: 'M-Pesa', suffix: 'KES' }] },
      { type: 'num', id: 's_value', label: 'Total received, if not the list price', suffix: 'KES', hint: 'Leave blank to use list prices.' },
      { type: 'select', id: 'counted', label: 'Closing count', options: [['no', 'Not counted yet'], ['yes', 'I have counted the eggs left']] },
      { type: 'group', show: (v) => v.counted === 'yes', fields: [
        { type: 'eggs', id: 'c_n', label: 'Normal eggs counted' },
        { type: 'group', show: all, fields: gradeFields('c_', { only: ['B', 'C', 'J'] }) }] },
      { type: 'group', show: today, fields: [{ type: 'num', id: 'cash', label: 'Cash in the drawer (optional)', suffix: 'KES', hint: `Expected ${kes(exp)} before the cash sales above` }] },
      ] },
    ],
    submit: 'Save the day',
    calc: (v) => {
      if (!traded(v)) return <div><span>No sales or counts are expected for a closed day. The morning reminder stops asking for it.</span></div>;
      const L = book(v), sales = salesOn(D, [dayOf(D, v)], loc), e = expected(v), cnt = { n: v.c_n || 0, b: v.c_b || 0, c: v.c_c || 0, j: v.c_j || 0 };
      const counted = v.counted === 'yes', gap = tot(cnt) - tot(e), money = v.s_cash + v.s_till, val = value(v);
      return <>
        <Row l={`Opening ${dlabel(dayOf(D, v))}`} r={eggs(tot(L.open))} />
        {tot(L.recv) > 0 && <Row l="Received" r={eggs(tot(L.recv))} />}
        {tot(L.out) > 0 && <Row l="Sent to outlets" r={eggs(tot(L.out))} />}
        {tot(L.iss) + tot(iss(v)) > 0 && <Row l="Issued" r={eggs(tot(L.iss) + tot(iss(v)))} />}
        {tot(L.brk) + tot(dmg(v)) > 0 && <Row l="Damaged" r={eggs(tot(L.brk) + tot(dmg(v)))} />}
        <Row l={`Sold${sales.cnt ? ` (incl. ${sales.cnt} sale${sales.cnt === 1 ? '' : 's'} already entered)` : ''}`} r={`${eggs(tot(L.sold) + tot(sold(v)))} · ${kes(sales.value + (tot(sold(v)) ? val : 0))}`} />
        <Row l="Closing by the book" r={eggs(tot(e))} />
        {counted && (gap ? <Bad l={gap < 0 ? 'Count is short' : 'Count is over'} r={eggs(Math.abs(gap))} /> : <Ok>Count matches the book</Ok>)}
        {tot(sold(v)) > 0 && money !== val && <Bad l="Cash + M-Pesa do not match the sales" r={`${kes(money)} of ${kes(val)}`} />}
        {e.n < 0 && <Bad l="More eggs out than the book holds" r="Enter missing deliveries first" />}
      </>;
    },
    onSubmit: async (v) => {
      if (!traded(v)) {
        const date = v.trading === 'closed_y' ? addDays(D.today, -1) : dateArg(D, v);
        await rpc('rpc_mark_day', { p_kind: 'closed', p_loc: loc, p_date: date });
        return `${locName(D, loc)} marked closed for ${dlabel(date ?? D.today)}.`;
      }
      const p: Record<string, unknown> = {};
      if (tot(dmg(v))) p.damaged = dmg(v);
      if (tot(iss(v))) { if (!String(v.party ?? '').trim()) throw new Error('Say who the eggs were issued to.'); p.issued = { ...iss(v), party: String(v.party).trim(), note: 'Daily sheet' }; }
      if (tot(sold(v))) {
        if (v.s_cash + v.s_till !== value(v)) throw new Error(`Cash and M-Pesa (${kes(v.s_cash + v.s_till)}) must add up to the sales (${kes(value(v))}).`);
        p.sales = { ...sold(v), cash: v.s_cash, till: v.s_till, paybill: 0, value: v.s_value > 0 ? v.s_value : null };
      }
      const cnt = { n: v.c_n || 0, b: v.c_b || 0, c: v.c_c || 0, j: v.c_j || 0 };
      if (v.counted === 'yes') p.closing = all(v) ? cnt : { ...cnt, b: Math.max(0, expected(v).b), c: Math.max(0, expected(v).c), j: Math.max(0, expected(v).j) };
      if (today(v) && v.cash > 0) p.cash_counted = v.cash;
      if (!Object.keys(p).length) throw new Error('Enter at least one figure.');
      const r = await rpc<{ closing?: { adj_n: number; adj_b: number; adj_c: number; adj_j: number }; cash?: { diff: number } }>('rpc_shop_day', { p_loc: loc, p_date: dateArg(D, v), p });
      const msgs: string[] = [];
      if (r.closing) { const d = r.closing.adj_n + r.closing.adj_b + r.closing.adj_c + r.closing.adj_j; msgs.push(d ? `stock ${d < 0 ? 'short' : 'over'} by ${eggs(Math.abs(d))}` : 'stock matches'); }
      if (r.cash) msgs.push(r.cash.diff ? `cash ${r.cash.diff < 0 ? 'short' : 'over'} ${kes(Math.abs(r.cash.diff))}` : 'cash matches');
      return `Day saved${onDay(D, v)}${msgs.length ? `: ${msgs.join(', ')}` : ''}.`;
    },
  };
}

/* ---------------- money ---------------- */
export function expenseForm(D: Dashboard, loc: string, mgmt: boolean): FormSpec {
  const from: [string, string][] = [[cashAcc(loc), `${accName(D, cashAcc(loc))} (${kes(balance(D, cashAcc(loc)))})`], ['TILL', 'M-Pesa Till'], ['PAYBILL', 'M-Pesa Paybill']];
  if (mgmt) from.push(['BANK', 'Bank']);
  return {
    title: 'Expense',
    fields: [
      { type: 'num', id: 'amt', label: 'Amount', suffix: 'KES' },
      { type: 'select', id: 'cat', label: 'Category', options: [['Packaging', 'Trays & packaging'], ['Fuel', 'Fuel'], ['Casual labour', 'Casual labour'], ['Transport', 'Transport'], ['Repairs', 'Repairs'], ['Veterinary', 'Vet & medicine'], ['Utilities', 'Water & electricity'], ['Other', 'Other']], def: loc === 'VAN' ? 'Fuel' : 'Packaging' },
      { type: 'select', id: 'from', label: 'Paid from', options: from },
      { type: 'text', id: 'note', label: 'Description', placeholder: 'e.g. 20 egg trays' },
    ],
    onSubmit: async (v) => { await rpc('rpc_expense', { p_from: v.from, p_amount: v.amt, p_category: v.cat, p_note: v.note || null }); return `Expense of ${kes(v.amt)} recorded.`; },
  };
}

export function moveForm(D: Dashboard, loc: string | null): FormSpec {
  const accs = loc ? [cashAcc(loc), 'TILL', 'PAYBILL', 'BANK'] : D.accounts.map((a) => a.id);
  const label = (a: string) => (loc && a !== cashAcc(loc) ? accName(D, a) : `${accName(D, a)} (${kes(balance(D, a))})`);
  const presets: [string, string, string][] = loc
    ? [[cashAcc(loc), 'BANK', 'Bank my cash'], ['PAYBILL', cashAcc(loc), 'Paybill → cash'], [cashAcc(loc), 'PAYBILL', 'Cash → Paybill']]
    : [['TILL', 'BANK', 'Till to bank'], ['PAYBILL', 'BANK', 'Paybill to bank'], ['PAYBILL', 'CASH:FARM', 'Paybill → farm cash']];
  return {
    title: 'Move money',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Moving money between cash, M-Pesa and bank does not change total funds. Only charges reduce it.</p>,
    fields: [
      { type: 'select', id: 'from', label: 'From', options: accs.map((a): [string, string] => [a, label(a)]), def: loc ? cashAcc(loc) : 'TILL' },
      { type: 'select', id: 'to', label: 'To', options: accs.map((a): [string, string] => [a, label(a)]), def: 'BANK' },
      { type: 'pair', fields: [{ type: 'num', id: 'amt', label: 'Amount', suffix: 'KES' }, { type: 'num', id: 'fee', label: 'Charges', suffix: 'KES' }] },
      { type: 'text', id: 'ref', label: 'Reference', placeholder: 'M-Pesa code or deposit slip number' },
    ],
    buttons: (_v, set) => <>{presets.map(([a, b, l]) => <button key={l} type="button" className="btn sm alt" onClick={() => set({ from: a, to: b })}>{l}</button>)}</>,
    calc: (v) => v.from === v.to ? <Bad l="Choose two different accounts" r="" /> : <>
      {(!loc || v.from === cashAcc(loc)) && <Row l={accName(D, v.from)} r={`${kes(balance(D, v.from))} → ${kes(balance(D, v.from) - v.amt - v.fee)}`} />}
      {(!loc || v.to === cashAcc(loc)) && <Row l={accName(D, v.to)} r={`${kes(balance(D, v.to))} → ${kes(balance(D, v.to) + v.amt)}`} />}
      <Row l="Total funds change" r={v.fee ? `${kes(-v.fee)} (charges)` : 'none'} /></>,
    onSubmit: async (v) => {
      await rpc('rpc_move_money', { p_from: v.from, p_to: v.to, p_amount: v.amt, p_fee: v.fee, p_ref: v.ref || null });
      return `${kes(v.amt)} moved: ${accName(D, v.from)} → ${accName(D, v.to)}.`;
    },
  };
}

/* ---------------- counts ---------------- */
export function countForm(D: Dashboard, loc: string, kind: 'open' | 'close'): FormSpec {
  const st = stockNow(D, loc), acc = cashAcc(loc), exp = balance(D, acc);
  const fields: Field[] = [...gradeFields('', { def: { n: Math.max(0, st.n), b: Math.max(0, st.b), c: Math.max(0, st.c), j: Math.max(0, st.j) } })];
  if (kind === 'close') fields.push({ type: 'num', id: 'cash', label: 'Cash in the drawer', suffix: 'KES', def: Math.max(0, exp), hint: `Expected ${kes(exp)}` });
  return {
    title: kind === 'open' ? 'Opening count' : 'Close the day',
    intro: <div className="calc"><Row l="Book stock" r={mix(st)} /></div>,
    fields, submit: kind === 'open' ? 'Open the day' : 'Close the day',
    calc: (v) => { const d = tot(gradesOf(v)) - tot(st); return <>
      {d ? <Bad l="Stock variance" r={eggs(d)} /> : <Ok>Stock matches the book</Ok>}
      {kind === 'close' && (v.cash - exp ? <Bad l={`Cash ${v.cash < exp ? 'short' : 'over'}`} r={kes(Math.abs(v.cash - exp))} /> : <Ok>Cash matches</Ok>)}</>; },
    onSubmit: async (v) => {
      const q = gradesOf(v);
      if (kind === 'open') {
        const r = await rpc<{ adj_n: number; adj_b: number; adj_c: number; adj_j: number }>('rpc_count_stock', { p_loc: loc, p_kind: 'open', p_n: q.n, p_b: q.b, p_j: q.j, p_c: q.c });
        const d = r.adj_n + r.adj_b + r.adj_c + r.adj_j;
        return d ? `Day opened. Stock off by ${eggs(d)}; the manager has been told.` : 'Day opened. Stock matches.';
      }
      const r = await rpc<{ closing: { adj_n: number; adj_b: number; adj_c: number; adj_j: number }; cash: { diff: number } }>('rpc_shop_day',
        { p_loc: loc, p_date: null, p: { closing: q, cash_counted: v.cash } });
      const d = r.closing.adj_n + r.closing.adj_b + r.closing.adj_c + r.closing.adj_j, msgs = [];
      if (d) msgs.push(`stock off by ${eggs(d)}`);
      if (r.cash?.diff) msgs.push(`cash ${r.cash.diff < 0 ? 'short' : 'over'} ${kes(Math.abs(r.cash.diff))}`);
      return msgs.length ? `Day closed: ${msgs.join(', ')}.` : 'Day closed. Everything matches.';
    },
  };
}

export function cashCountForm(D: Dashboard, loc: string): FormSpec {
  const exp = balance(D, cashAcc(loc));
  return {
    title: 'Count cash',
    fields: [{ type: 'num', id: 'cash', label: 'Cash counted in the drawer', suffix: 'KES', hint: `Expected ${kes(exp)}` }],
    calc: (v) => (v.cash - exp ? <Bad l={v.cash < exp ? 'Short' : 'Over'} r={kes(Math.abs(v.cash - exp))} /> : <Ok>Matches expected cash</Ok>),
    onSubmit: async (v) => { const r = await rpc<{ diff: number }>('rpc_cash_count', { p_loc: loc, p_counted: v.cash }); return r.diff ? `Variance of ${kes(r.diff)} recorded.` : 'Cash matches.'; },
  };
}

/* ---------------- corrections ---------------- */
export const voidForm = (kind: string, id: number, what: string): FormSpec => ({
  title: 'Correct a record',
  intro: <div className="calc"><div><span>{what}</span></div><div><span>The record stays in the history, marked as corrected. Stock and money are recalculated without it.</span></div></div>,
  fields: [{ type: 'text', id: 'reason', label: 'Reason', placeholder: 'e.g. entered twice, wrong quantity' }],
  submit: 'Mark as corrected',
  onSubmit: async (v) => { await rpc('rpc_void', { p_kind: kind, p_id: id, p_reason: v.reason }); return 'Record corrected. Enter the right figures as a new record if needed.'; },
});

/* ---------------- me ---------------- */
/* ---------------- owner & manager setup ---------------- */
/* ---------------- houses and flocks (owner, farm manager, production clerk) ---------------- */
const BREEDS = ['Hy-Line Brown', 'ISA Brown', 'Lohmann Brown', 'Bovans Brown', 'Kenbro', 'Kuroiler', 'Improved Kienyeji'];
const flock = (action: string, p: Record<string, unknown>) => rpc<Record<string, any>>('rpc_flock', { p_action: action, p });
const breedFields = (def?: string | null): Field[] => {
  const known = !def || BREEDS.includes(def);
  return [
    { type: 'select', id: 'breed', label: 'Breed', options: [...BREEDS.map((b): [string, string] => [b, b]), ['', 'Not known'], [NEW, 'Other breed']], def: known ? def ?? BREEDS[0] : NEW },
    { type: 'group', show: (v) => v.breed === NEW, fields: [{ type: 'text', id: 'breed_other', label: 'Breed name', def: known ? '' : def ?? '', placeholder: 'e.g. Dekalb Brown' }] },
  ];
};
const breedOf = (v: V) => (v.breed === NEW ? String(v.breed_other ?? '').trim() : String(v.breed ?? '')) || null;

/** A new, empty house for an expansion. Its first flock is placed with New flock. */
export const houseNewForm = (D: Dashboard): FormSpec => ({
  title: 'Add a house',
  intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>For a new or newly built house. Once it is added, place its flock with New flock.</p>,
  fields: [{ type: 'pair', fields: [{ type: 'text', id: 'id', label: 'Short code', placeholder: `e.g. ${String.fromCharCode(65 + D.houses.length)}` },
    { type: 'text', id: 'name', label: 'Name', placeholder: `e.g. House ${String.fromCharCode(65 + D.houses.length)}` }] }],
  onSubmit: async (v) => {
    const r = await flock('house_new', { id: String(v.id ?? '').trim(), name: String(v.name ?? '').trim() });
    return `${r.name} added. Place its flock with New flock.`;
  },
});

/** A flock placed in a house. Any flock already there leaves on that date. */
export function flockForm(D: Dashboard, houseId?: string): FormSpec {
  const cur = (id: unknown) => (D.flocks ?? []).find((f) => f.house_id === id && !f.ended_on);
  return {
    title: 'New flock',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Hens placed in a house. If a flock is already in it, that flock leaves on this date and keeps its records.</p>,
    fields: [
      { type: 'select', id: 'house', label: 'House', options: D.houses.map((h): [string, string] => [h.id, `${h.name}${h.birds_at_start > 0 ? ` (${n0(h.birds_at_start)} hens now)` : ' (empty)'}`]), def: houseId ?? D.houses.find((h) => !h.birds_at_start)?.id },
      ...breedFields(),
      { type: 'pair', fields: [{ type: 'num', id: 'hens', label: 'Hens placed', suffix: 'hens' }, { type: 'num', id: 'age', label: 'Age when placed', suffix: 'weeks', def: 18 }] },
      { type: 'pair', fields: [{ type: 'date', id: 'date', label: 'Date placed', def: D.today, min: addDays(D.today, -62), max: D.today }, { type: 'num', id: 'exp', label: 'Expected lay rate', suffix: '%', def: 85 }] },
      { type: 'text', id: 'note', label: 'Supplier or note (optional)', placeholder: 'e.g. Kenchic, delivery 2210' },
    ],
    calc: (v) => { const f = cur(v.house); return f ? <Bad l="The flock now in the house" r={`${n0(f.hens)} hens placed ${dlabel(f.placed_on)} leave on ${dlabel(String(v.date || D.today))}`} />
      : <Ok>The house is empty</Ok>; },
    onSubmit: async (v) => {
      if (!(v.hens > 0)) throw new Error('Enter the hens placed.');
      if (!(v.exp > 0 && v.exp <= 100)) throw new Error('Enter the expected lay rate as a percentage.');
      const r = await flock('place', { house: v.house, breed: breedOf(v), hens: v.hens, age_weeks: v.age || 0, expected_lay: v.exp, placed_on: v.date || D.today, note: String(v.note ?? '').trim() || null });
      return `${n0(r.hens)} hens placed in ${r.house}.${r.ended ? ' The earlier flock is closed with its records.' : ''}`;
    },
  };
}

/** Correct the breed, age or expected lay rate of the flock in a house now. */
export function flockEditForm(D: Dashboard, houseId: string): FormSpec {
  const h = D.houses.find((x) => x.id === houseId)!, f = (D.flocks ?? []).find((x) => x.house_id === houseId && !x.ended_on);
  return {
    title: `${h.name}: the flock`,
    fields: [
      ...breedFields(f?.breed ?? h.breed),
      { type: 'pair', fields: [{ type: 'num', id: 'age', label: 'Age when placed', suffix: 'weeks', def: f?.age_weeks ?? h.age_weeks_at_start },
        { type: 'num', id: 'exp', label: 'Expected lay rate', suffix: '%', def: Math.round((f?.expected_lay ?? h.expected_lay) * 100) }] },
      { type: 'note', text: <p className="muted" style={{ margin: 0, fontSize: 13 }}>The hen count comes from the hens placed less the deaths recorded. A new batch of hens is a New flock.</p> },
    ],
    onSubmit: async (v) => {
      if (!f) throw new Error(`${h.name} has no flock on record. Place one with New flock.`);
      await flock('edit', { flock: f.id, breed: breedOf(v), age_weeks: v.age, expected_lay: v.exp });
      return 'Saved.';
    },
  };
}

/** The house is emptied: hens sold, moved or culled. */
export const flockEndForm = (D: Dashboard, houseId: string): FormSpec => {
  const h = D.houses.find((x) => x.id === houseId)!;
  return {
    title: `Empty ${h.name}`,
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Records that the flock left the house. Its records stay; the house counts no hens until a new flock is placed.</p>,
    fields: [
      { type: 'date', id: 'date', label: 'Date the house was emptied', def: D.today, max: D.today },
      { type: 'select', id: 'why', label: 'Why', options: [['Sold as spent hens', 'Sold as spent hens'], ['Moved to another house', 'Moved to another house'], ['Culled', 'Culled'], [NEW, 'Other']] },
      { type: 'group', show: (v) => v.why === NEW, fields: [{ type: 'text', id: 'other', label: 'Say what happened' }] },
    ],
    onSubmit: async (v) => {
      await flock('end', { house: h.id, ended_on: v.date || D.today, note: v.why === NEW ? String(v.other ?? '').trim() : v.why });
      return `${h.name} recorded as empty.`;
    },
  };
};

/** Owner and farm manager: rename a house or take it out of use. The flock is changed with the flock forms. */
export const houseForm = (_D: Dashboard, h: House): FormSpec => ({
  title: `Edit ${h.name}`,
  fields: [
    { type: 'text', id: 'name', label: 'Name', def: h.name },
    { type: 'select', id: 'active', label: 'Status', options: [['true', 'In use'], ['false', 'Not in use']], def: String(h.active) },
  ],
  onSubmit: async (v) => {
    await rpc('rpc_save_house', { p_id: h.id, p_name: v.name, p_birds: h.birds_at_start, p_start: h.start_date, p_age: h.age_weeks_at_start, p_expected: h.expected_lay, p_active: v.active === 'true' });
    return 'House saved.';
  },
});

export const medicineForm = (D: Dashboard, m?: Medicine): FormSpec => ({
  title: m ? `Edit ${m.name}` : 'Add a medicine or vaccine',
  intro: m ? <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Changes apply to past records too. Set it to "Not in use" to take it off the lists; its history is kept.</p> : undefined,
  fields: [
    { type: 'text', id: 'name', label: 'Name', def: m?.name ?? '' },
    ...categoryFields(D, m?.category),
    { type: 'pair', fields: [{ type: 'text', id: 'unit', label: 'Counted in', def: m?.unit ?? '', placeholder: 'doses, g, ml, sachets' }, { type: 'num', id: 'reorder', label: 'Reorder at', def: m?.reorder ?? '' }] },
    { type: 'select', id: 'active', label: 'Status', options: [['true', 'In use'], ['false', 'Not in use (hidden from lists)']], def: String(m?.active ?? true) },
  ],
  onSubmit: async (v) => {
    await rpc('rpc_medicine_save', { p_id: m?.id ?? null, p_name: v.name, p_category: chosenCategory(v), p_unit: v.unit, p_reorder: v.reorder, p_active: v.active === 'true' });
    return m ? 'Saved.' : `${v.name} added. Record its first delivery with "Record use or delivery".`;
  },
});

export const scheduleForm = (D: Dashboard, e?: ScheduleItem): FormSpec => ({
  title: e ? 'Edit task' : 'Add vaccination or treatment',
  fields: [
    { type: 'text', id: 'task', label: 'Task', def: e?.task ?? '', placeholder: 'e.g. Newcastle booster in drinking water' },
    { type: 'pair', fields: [{ type: 'date', id: 'due', label: 'Due', def: e?.due ?? D.today }, { type: 'select', id: 'house', label: 'House', options: [['All houses', 'All houses'], ...D.houses.map((h): [string, string] => [h.name, h.name])], def: e?.house ?? 'All houses' }] },
  ],
  onSubmit: async (v) => { await rpc('rpc_save_schedule', { p_id: e?.id ?? null, p_due: v.due, p_house: v.house, p_task: v.task }); return 'Schedule saved.'; },
});

const ROLE_OPTS: [string, string][] = [['pos', 'Sales point attendant / van driver'], ['clerk', 'Production clerk'], ['store', 'Inventory clerk'], ['manager', 'Farm manager'], ['owner', 'Owner']];
export const staffForm = (D: Dashboard, s?: StaffLite): FormSpec => ({
  title: s ? `Edit ${s.display_name}` : 'Add staff member',
  intro: !s ? <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>They sign in with this username and the temporary password <b>0000</b>. It works once, for 72 hours, and they must choose their own password straight away. Owners and farm managers also set up two-step sign-in.</p> : undefined,
  fields: [
    { type: 'text', id: 'name', label: 'Name', def: s?.display_name ?? '' },
    { type: 'text', id: 'username', label: 'Username (lowercase, no spaces)', def: s?.username ?? '', placeholder: 'e.g. jane.w' },
    { type: 'select', id: 'role', label: 'Role', options: D.me.role === 'owner' ? ROLE_OPTS : ROLE_OPTS.filter(([r]) => r !== 'owner'), def: s?.role ?? 'pos' },
    { type: 'select', id: 'loc', label: 'Location', options: D.locations.map((l): [string, string] => [l.id, l.name]), def: s?.location_id ?? 'FARM' },
    ...(s ? [{ type: 'select', id: 'active', label: 'Access', options: [['true', 'Active'], ['false', 'Disabled']], def: String(s.active) } as Field] : []),
  ],
  onSubmit: async (v) => {
    const username = String(v.username ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new Error('Username: 3 to 32 lowercase letters, numbers, dots or dashes.');
    if (s) await staffAdmin({ action: 'update', staff_id: s.id, username, display_name: v.name, role: v.role, location_id: v.role === 'owner' ? null : v.loc, active: v.active === 'true' });
    else await staffAdmin({ action: 'create', username, display_name: v.name, role: v.role, location_id: v.role === 'owner' ? null : v.loc });
    return s ? (v.active === 'false' && s.active ? `${v.name} is disabled and signed out.` : 'Staff member updated.') : `${v.name} added. Username ${username}, temporary password 0000 (valid 72 hours).`;
  },
});

export function openingForm(D: Dashboard): FormSpec {
  const fields: Field[] = [{ type: 'note', text: <div><span>Count everything on go-live morning and enter the real figures. Each entry replaces what the system shows now.</span></div> }];
  for (const l of D.locations) { const st = stockNow(D, l.id); fields.push({ type: 'note', text: <div className="dest"><b>{l.name}</b></div> },
    ...gradeFields(`${l.id}_`, { def: { n: Math.max(0, st.n), b: Math.max(0, st.b), c: Math.max(0, st.c), j: Math.max(0, st.j) } })); }
  for (const a of D.accounts) fields.push({ type: 'num', id: `m_${a.id}`, label: a.name, suffix: 'KES', def: balance(D, a.id) });
  fields.push({ type: 'pair', fields: [{ type: 'num', id: 'feed', label: 'Feed in store', suffix: 'bags', step: 0.5, def: Math.round(D.feed_stock / D.settings.bag_kg * 10) / 10 }, { type: 'num', id: 'tank', label: 'Water in tank', suffix: 'L', def: D.tank?.litres ?? '' }] });
  for (const m of D.medicines.filter((x) => x.active)) fields.push({ type: 'num', id: `med_${m.id}`, label: `${m.name}`, suffix: m.unit, def: m.stock });
  return {
    title: 'Opening balances', fields, submit: 'Save opening balances',
    onSubmit: async (v) => {
      const stock: Record<string, Q> = {}, money: Record<string, number> = {}, medicines: Record<string, number> = {};
      for (const l of D.locations) stock[l.id] = gradesOf(v, `${l.id}_`);
      for (const a of D.accounts) money[a.id] = v[`m_${a.id}`];
      for (const m of D.medicines.filter((x) => x.active)) medicines[String(m.id)] = v[`med_${m.id}`];
      const p: Record<string, unknown> = { stock, money, medicines, feed_kg: v.feed * D.settings.bag_kg };
      if (v.tank > 0) p.tank_l = v.tank;
      await rpc('rpc_opening_balances', { p });
      return 'Opening balances saved. Dashboards now start from these figures.';
    },
  };
}
