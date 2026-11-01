// Every data-entry form in the app. Each returns a FormSpec; the database
// function behind it re-checks everything, so these checks are for speed only.
import { rpc, staffAdmin } from '../lib/api';
import { addDays, dlabel, eggs, kes, n0, pct } from '../lib/format';
import { ITEMS, ITEM_NAME, Z, accName, balance, band, cashAcc, collected, damagedAtFarm, dayLedger, feedInfo, hensNow, houseAge, locName, mix, priceOf, salesOn, stockNow, tankInfo, tot, waterOn } from '../lib/metrics';
import type { Dashboard, House, Item, Medicine, Q, ScheduleItem, StaffLite, Transfer } from '../lib/types';
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
const onDay = (D: Dashboard, v: V) => (dayOf(D, v) === D.today ? '' : ` for ${dlabel(dayOf(D, v))}`);
/** Egg inputs by grade, keyed `${p}n`, `${p}b`, `${p}j`, `${p}c` (+ `${p}dmg`). */
function gradeFields(p: string, o: { def?: Partial<Q>; dmg?: string; only?: Item[]; hint?: Partial<Record<Item, string>> } = {}): Field[] {
  const want = (i: Item) => !o.only || o.only.includes(i);
  const f: Field[] = [];
  if (want('N')) f.push({ type: 'eggs', id: `${p}n`, label: 'Normal eggs', def: o.def?.n, hint: o.hint?.N });
  if (want('B')) f.push({ type: 'eggs', id: `${p}b`, label: 'Big eggs', def: o.def?.b, hint: o.hint?.B });
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
    { type: 'pair', fields: [{ type: 'num', id: `${h.id}_deaths`, label: 'Deaths', suffix: 'birds' }, { type: 'num', id: `${h.id}_feed`, label: 'Feed given', suffix: 'bags', step: 0.5 }] },
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
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>The farm book in one go: eggs by grade, deaths, feed and water for each house. Leave a house blank if nothing is new. Age, hens and lay rate fill in by themselves.</p>,
    fields, submit: 'Save the day',
    calc: (v) => <>{lines(v).map((x) => <div key={x.h.id} className="sheet-line">
      <Row l={`${x.h.name} · ${x.age} weeks`} r={`${n0(x.before)} → ${n0(x.close)} hens`} />
      <Row l={`Laid${x.already ? ` (incl. ${eggs(x.already)} already entered)` : ''}`} r={`${eggs(x.laid)} · ${x.before ? pct(x.laid / x.before) : '–'} lay`} />
      {x.before > 0 && x.laid / x.before < x.h.expected_lay - 0.05 && x.laid > 0 && <Bad l="Below the expected lay rate" r={pct(x.h.expected_lay, 0)} />}
    </div>)}
      <Row l="Feed for the day" r={`${n0(lines(v).reduce((a, x) => a + x.feed, 0) / s.bag_kg)} bags · ${n0(lines(v).reduce((a, x) => a + x.feed, 0))} kg`} />
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
    ],
    calc: (v) => { const left = f.stock - kgOf(v), b = band(left / f.target); return <>
      <Row l="This entry" r={`${n0(kgOf(v))} kg`} />
      <div><span>Left after this</span><b style={{ color: `var(${b.color})` }}>{n0(left / kgBag)} of {n0(f.targetBags)} bags · {pct(left / f.target, 0)}</b></div>
      <Row l="Buffer band" r={b.label} /></>; },
    onSubmit: async (v) => {
      if (kgOf(v) <= 0) throw new Error('Enter the feed given.');
      const r = await rpc<{ band_label: string; level: number; notified: boolean }>('rpc_feed', { p_kind: 'use', p_kg: kgOf(v), p_house: v.house, p_note: v.note });
      return `Saved. Feed at ${pct(r.level, 0)} of the buffer (${r.band_label}).${r.notified ? ' Farm Manager notified.' : ''}`;
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
    ],
    calc: (v) => { const h = D.houses.find((x) => x.id === v.house); const today = waterOn(D, [D.today], v.house); return h ? <Row l={`${h.name} today including this`} r={`${n0(today + v.l)} L`} /> : null; },
    onSubmit: async (v) => {
      if (v.l <= 0) throw new Error('Enter the litres the birds drank.');
      await rpc('rpc_water', { p_kind: 'intake', p_litres: v.l, p_house: v.house });
      return 'Water intake saved.';
    },
  };
}

export function tankForm(D: Dashboard): FormSpec {
  const cap = D.settings.tank_capacity_l, t = tankInfo(D);
  return {
    title: 'Tank level',
    fields: [{ type: 'num', id: 'l', label: 'Litres in the tank now', suffix: 'L', hint: `Tank holds ${n0(cap)} L.${t ? ` Last reading ${n0(t.litres)} L.` : ''}` }],
    buttons: (_v, set) => <>{[1, 0.75, 0.5, 0.25].map((p) => <button key={p} type="button" className="btn sm alt" onClick={() => set({ l: Math.round(cap * p) })}>{p === 1 ? 'Full' : `${p * 100}%`}</button>)}</>,
    calc: (v) => { const b = band(v.l / cap); return <div><span>Level</span><b style={{ color: `var(${b.color})` }}>{pct(v.l / cap, 0)} · {b.label}</b></div>; },
    onSubmit: async (v) => {
      const r = await rpc<{ band_label: string; level: number; notified: boolean }>('rpc_water', { p_kind: 'tank', p_litres: v.l });
      return `Tank at ${pct(r.level, 0)} (${r.band_label}).${r.notified ? ' Farm Manager notified.' : ''}`;
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
    ],
    onSubmit: async (v) => {
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
  ],
  onSubmit: async (v) => { await rpc('rpc_mortality', { p_house: v.house, p_birds: v.n, p_cause: v.cause }); return 'Mortality recorded. Hen count updated.'; },
});

/* ---------------- stock movement ---------------- */
export function dispatchForm(D: Dashboard, from: string): FormSpec {
  const st = stockNow(D, from);
  const dests = D.locations.filter((l) => l.id !== from);
  const lines = (v: V) => dests.map((l) => ({ to: l.id, name: l.name, ...gradesOf(v, `${l.id}_`) })).filter((x) => tot(x) > 0);
  const fields: Field[] = [{ type: 'note', text: <div><span>In stock at {locName(D, from)}</span><b>{mix(st)}</b></div> }];
  for (const l of dests) fields.push({ type: 'note', text: <div className="dest"><b>To {l.name}</b></div> }, ...gradeFields(`${l.id}_`));
  return {
    title: 'Send eggs',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Fill in only the outlets you are sending to. Everything is sent together, and each outlet confirms its count on arrival.</p>,
    fields, submit: 'Send',
    calc: (v) => {
      const L = lines(v), all = L.reduce((a, x) => ({ n: a.n + x.n, b: a.b + x.b, c: a.c + x.c, j: a.j + x.j }), Z());
      if (!L.length) return <div><span className="muted">Enter the eggs for at least one outlet</span></div>;
      const o = over(all, st);
      return <>{L.map((x) => <Row key={x.to} l={x.name} r={mix(x)} />)}
        {o ? <Bad l={o} r="Check" /> : <Row l="Left after" r={mix({ n: st.n - all.n, b: st.b - all.b, c: st.c - all.c, j: st.j - all.j })} />}</>;
    },
    onSubmit: async (v) => {
      const L = lines(v);
      if (!L.length) throw new Error('Enter the eggs for at least one outlet.');
      await rpc('rpc_dispatch_many', { p_from: from, p_items: L.map(({ to, n, b, c, j }) => ({ to, n, b, c, j })) });
      return L.length === 1 ? `${eggs(tot(L[0]))} on the way to ${L[0].name}. They confirm the count on arrival.`
        : `Sent to ${L.length} outlets: ${L.map((x) => x.name).join(', ')}. Each confirms its count on arrival.`;
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
      return res.short > 0 ? `Received: ${res.damaged} damaged, ${eggs(res.missing)} missing. Farm Manager notified.` : 'Delivery received. Stock updated.';
    },
  };
}

/** Eggs leaving the outlet to someone outside the app: a customer on credit, a bulk buyer, another farm. */
export function issueForm(D: Dashboard, loc: string): FormSpec {
  const st = stockNow(D, loc);
  return {
    title: 'Issue eggs out',
    intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>For eggs that leave without a sale today: customers on credit, bulk orders collected, eggs returned to a supplier. Sending to another outlet is under <b>Send eggs</b> instead.</p>,
    fields: [
      ...dateFields(D),
      { type: 'note', text: <div><span>In stock</span><b>{mix(st)}</b></div> },
      ...gradeFields(''),
      { type: 'text', id: 'party', label: 'Issued to', placeholder: 'Name of the customer or place' },
      { type: 'select', id: 'why', label: 'Reason', options: [['Customer on credit', 'Customer on credit'], ['Bulk order collected', 'Bulk order collected'], ['Owner / staff use', 'Owner / staff use'], ['Other', 'Other']] },
      { type: 'text', id: 'note', label: 'Note (optional)', placeholder: 'e.g. pays on Friday' },
    ],
    calc: (v) => { const q = gradesOf(v), o = over(q, st); return <>{o ? <Bad l={o} r="Check" /> : <Row l="Issuing" r={mix(q)} />}
      {v.why === 'Customer on credit' && tot(q) > 0 && <Row l="Value at list price" r={kes(priceOf(D, q))} />}</>; },
    onSubmit: async (v) => {
      const q = gradesOf(v);
      if (!tot(q)) throw new Error('Enter the eggs issued.');
      if (!String(v.party ?? '').trim()) throw new Error('Say who received the eggs.');
      await rpc('rpc_issue_out', { p_loc: loc, p_n: q.n, p_b: q.b, p_j: q.j, p_c: q.c, p_party: String(v.party).trim(),
        p_note: [v.why, v.note].filter(Boolean).join(': '), p_date: dateArg(D, v) });
      return `${eggs(tot(q))} issued to ${String(v.party).trim()}${onDay(D, v)}.`;
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
      { type: 'num', id: 'paybill', label: 'M-Pesa Paybill', suffix: 'KES' },
      { type: 'text', id: 'customer', label: 'Customer (optional)', placeholder: 'e.g. hotel or regular buyer' },
    ],
    calc: (v) => { const d = due(v), paid = v.cash + v.till + v.paybill, rem = d - paid, o = over(gradesOf(v), st); return <>
      {o && <Bad l={o} r="Check" />}
      <div><span>Amount due</span><b className="big">{kes(d)}</b></div>
      {v.agreed > 0 && v.agreed !== list(v) && <Row l="List price" r={`${kes(list(v))} (${v.agreed < list(v) ? 'discount' : 'premium'} ${kes(Math.abs(list(v) - v.agreed))})`} />}
      {d === 0 && paid === 0 ? <div><span className="muted">Enter the eggs sold, then how the customer paid</span></div>
        : d > 0 && rem === 0 ? <Ok>Payments add up to {kes(paid)}</Ok> : <Bad l={rem > 0 ? 'Still to allocate' : 'Over-allocated'} r={kes(Math.abs(rem))} />}</>; },
    buttons: (v, set) => <>{(['cash', 'till', 'paybill'] as const).map((m) => (
      <button key={m} type="button" className="btn sm alt" onClick={() => set({ cash: '', till: '', paybill: '', [m]: due(v) })}>All {m === 'cash' ? 'cash' : m === 'till' ? 'Till' : 'Paybill'}</button>))}</>,
    onSubmit: async (v) => {
      const d = due(v), q = gradesOf(v);
      if (!tot(q)) throw new Error('Enter the eggs sold.');
      if (v.cash + v.till + v.paybill !== d) throw new Error(`Payments (${kes(v.cash + v.till + v.paybill)}) must equal the amount due (${kes(d)}).`);
      await rpc('rpc_record_sale', { p_loc: loc, p_n: q.n, p_b: q.b, p_j: q.j, p_c: q.c, p_cash: v.cash, p_till: v.till, p_paybill: v.paybill,
        p_customer: v.customer || null, p_value: v.agreed > 0 ? v.agreed : null, p_date: dateArg(D, v) });
      return `Sale of ${kes(d)} saved${onDay(D, v)}.`;
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
      { type: 'select', id: 'grades', label: 'Grades', options: [['normal', 'Normal eggs only'], ['all', 'All grades (big, cracked, jumbo)']] },
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
export const houseForm = (D: Dashboard, h?: House): FormSpec => ({
  title: h ? `Edit ${h.name}` : 'Add a house',
  intro: <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Enter the hens in the house on the start date. Deaths recorded after that date are subtracted automatically. When a new flock is placed, set the new count and date.</p>,
  fields: [
    { type: 'pair', fields: [{ type: 'text', id: 'id', label: 'Code', def: h?.id ?? '', placeholder: 'e.g. C' }, { type: 'text', id: 'name', label: 'Name', def: h?.name ?? '', placeholder: 'e.g. House C' }] },
    { type: 'pair', fields: [{ type: 'num', id: 'birds', label: 'Hens on start date', def: h?.birds_at_start ?? '' }, { type: 'date', id: 'start', label: 'Start date', def: h?.start_date ?? D.today }] },
    { type: 'pair', fields: [{ type: 'num', id: 'age', label: 'Age on start date', suffix: 'weeks', def: h?.age_weeks_at_start ?? '' }, { type: 'num', id: 'exp', label: 'Expected lay rate', suffix: '%', def: h ? Math.round(h.expected_lay * 100) : 90 }] },
    { type: 'select', id: 'active', label: 'Status', options: [['true', 'In use'], ['false', 'Not in use']], def: String(h?.active ?? true) },
  ],
  onSubmit: async (v) => {
    await rpc('rpc_save_house', { p_id: v.id, p_name: v.name, p_birds: v.birds, p_start: v.start, p_age: v.age, p_expected: v.exp, p_active: v.active === 'true' });
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

const ROLE_OPTS: [string, string][] = [['pos', 'Sales point attendant / van driver'], ['clerk', 'Production clerk'], ['manager', 'Farm manager'], ['owner', 'Owner']];
export const staffForm = (D: Dashboard, s?: StaffLite & { email?: string | null; digest_enabled?: boolean; digest_opted_out_at?: string | null }): FormSpec => ({
  title: s ? `Edit ${s.display_name}` : 'Add staff member',
  intro: !s ? <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>They sign in with this username and the temporary password <b>0000</b>. It works once, for 72 hours, and they must choose their own password straight away. Owners and farm managers also set up two-step sign-in.</p> : undefined,
  fields: [
    { type: 'text', id: 'name', label: 'Name', def: s?.display_name ?? '' },
    { type: 'text', id: 'username', label: 'Username (lowercase, no spaces)', def: s?.username ?? '', placeholder: 'e.g. jane.w' },
    { type: 'select', id: 'role', label: 'Role', options: ROLE_OPTS, def: s?.role ?? 'pos' },
    { type: 'select', id: 'loc', label: 'Location', options: D.locations.map((l): [string, string] => [l.id, l.name]), def: s?.location_id ?? 'FARM' },
    ...(s ? [{ type: 'select', id: 'active', label: 'Access', options: [['true', 'Active'], ['false', 'Disabled']], def: String(s.active) } as Field] : []),
    { type: 'text', id: 'email', label: 'Email (optional, for the weekly digest)', def: s?.email ?? '', placeholder: 'name@example.com' },
    { type: 'select', id: 'digest', label: 'Weekly digest and reminder emails', options: [['true', 'On'], ['false', 'Off']], def: String(s?.digest_enabled ?? true) },
    ...(s?.digest_opted_out_at && !s.digest_enabled ? [{ type: 'note', text: <div><span>They turned the emails off from the link in an email. Only switch them back on if they ask.</span></div> } as Field] : []),
  ],
  onSubmit: async (v) => {
    const username = String(v.username ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new Error('Username: 3 to 32 lowercase letters, numbers, dots or dashes.');
    const email = String(v.email ?? '').trim().toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That email address does not look right.');
    const mail = { email, digest_enabled: v.digest === 'true' };
    if (s) await staffAdmin({ action: 'update', staff_id: s.id, username, display_name: v.name, role: v.role, location_id: v.role === 'owner' ? null : v.loc, active: v.active === 'true', ...mail });
    else await staffAdmin({ action: 'create', username, display_name: v.name, role: v.role, location_id: v.role === 'owner' ? null : v.loc, ...mail });
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
