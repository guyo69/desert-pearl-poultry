// Every data-entry form in the app. Each returns a FormSpec; the database
// function behind it re-checks everything, so these checks are for speed only.
import { rpc, staffAdmin } from '../lib/api';
import { eggs, kes, n0, pct } from '../lib/format';
import { ITEMS, ITEM_NAME, accName, balance, band, cashAcc, feedInfo, locName, priceOf, stockNow, tankInfo, tot, waterOn } from '../lib/metrics';
import type { Dashboard, House, Medicine, Q, ScheduleItem, StaffLite, Transfer } from '../lib/types';
import type { Field, FormSpec, V } from '../ui/ui';

const houseOpts = (D: Dashboard): [string, string][] => D.houses.map((h) => [h.id, h.name]);
const houseNameOpts = (D: Dashboard): [string, string][] => [['Both', 'All houses'], ...D.houses.map((h): [string, string] => [h.name, h.name])];
const Row = ({ l, r }: { l: React.ReactNode; r: React.ReactNode }) => <div><span>{l}</span><b>{r}</b></div>;
const Ok = ({ children }: { children: React.ReactNode }) => <div><span>{children}</span><b className="up">✓</b></div>;
const Bad = ({ l, r }: { l: React.ReactNode; r: React.ReactNode }) => <div><span>{l}</span><b style={{ color: 'var(--f-none)' }}>{r}</b></div>;

/* ---------------- production clerk ---------------- */
export const collectForm = (D: Dashboard): FormSpec => ({
  title: 'Egg collection',
  fields: [
    { type: 'select', id: 'house', label: 'House', options: houseOpts(D) },
    { type: 'eggs', id: 'n', label: 'Normal eggs' },
    { type: 'pair', fields: [{ type: 'num', id: 'c', label: 'Cracked', suffix: 'pieces' }, { type: 'num', id: 'j', label: 'Jumbo / double yolk', suffix: 'pieces' }] },
  ],
  calc: (v) => <Row l="This entry" r={eggs(v.n + v.c + v.j)} />,
  onSubmit: async (v) => {
    await rpc('rpc_collect', { p_house: v.house, p_n: v.n, p_c: v.c, p_j: v.j });
    return `Collection saved: ${eggs(v.n + v.c + v.j)}.`;
  },
});

export function feedUseForm(D: Dashboard): FormSpec {
  const f = feedInfo(D);
  return {
    title: 'Feed used',
    fields: [
      { type: 'num', id: 'kg', label: 'Feed given', suffix: 'kg', hint: `In store: ${n0(f.stock)} kg` },
      { type: 'select', id: 'house', label: 'House', options: houseNameOpts(D) },
      { type: 'select', id: 'note', label: 'Feeding', options: [['Morning feed', 'Morning'], ['Afternoon feed', 'Afternoon'], ['Extra feed', 'Extra']] },
    ],
    calc: (v) => { const left = f.stock - v.kg, b = band(left / f.target); return <>
      <div><span>Left after this</span><b style={{ color: `var(${b.color})` }}>{n0(left)} kg · {pct(left / f.target, 0)}</b></div>
      <Row l="Buffer band" r={b.label} /></>; },
    onSubmit: async (v) => {
      const r = await rpc<{ band_label: string; level: number; notified: boolean }>('rpc_feed', { p_kind: 'use', p_kg: v.kg, p_house: v.house, p_note: v.note });
      return `Saved. Feed at ${pct(r.level, 0)} (${r.band_label}).${r.notified ? ' Farm Manager notified.' : ''}`;
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
      <div><span>Store after delivery</span><b style={{ color: `var(${b.color})` }}>{n0(f.stock + add)} kg · {b.label}</b></div></>; },
    onSubmit: async (v) => {
      if (v.bags <= 0) throw new Error('Enter the number of bags delivered.');
      const r = await rpc<{ stock: number; band_label: string }>('rpc_feed', { p_kind: 'in', p_kg: v.bags * v.kgbag, p_bags: v.bags, p_cost: v.bags * v.price,
        p_note: 'Layers feed', p_paid_from: v.paid === 'none' ? null : v.paid });
      return `Feed store now ${n0(r.stock)} kg (${r.band_label}).`;
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

export const medForm = (D: Dashboard): FormSpec => ({
  title: 'Medicine & vaccines',
  fields: [
    { type: 'select', id: 'med', label: 'Item', options: D.medicines.filter((m) => m.active).map((m): [string, string] => [String(m.id), `${m.name} (${n0(m.stock)} ${m.unit})`]) },
    { type: 'select', id: 'kind', label: 'Movement', options: [['use', 'Used / given to birds'], ['in', 'Received into store']] },
    { type: 'num', id: 'qty', label: 'Quantity' },
    { type: 'select', id: 'house', label: 'House', options: houseNameOpts(D) },
    { type: 'text', id: 'note', label: 'Note', placeholder: 'e.g. booster dose, vet name' },
  ],
  onSubmit: async (v) => {
    const r = await rpc<{ stock: number; low: boolean }>('rpc_med', { p_medicine: Number(v.med), p_kind: v.kind, p_qty: v.qty, p_house: v.house, p_note: v.note || null });
    const m = D.medicines.find((x) => String(x.id) === v.med)!;
    return `${m.name}: ${n0(r.stock)} ${m.unit} left${r.low ? ', below reorder level' : ''}.`;
  },
});

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
  return {
    title: 'Send eggs',
    fields: [
      { type: 'select', id: 'to', label: 'Send to', options: D.locations.filter((l) => l.id !== from).map((l): [string, string] => [l.id, l.name]) },
      { type: 'eggs', id: 'n', label: 'Normal eggs', hint: `In stock: ${eggs(st.n)}` },
      { type: 'pair', fields: [{ type: 'num', id: 'c', label: 'Cracked', suffix: 'pc' }, { type: 'num', id: 'j', label: 'Jumbo', suffix: 'pc' }] },
      { type: 'note', text: <div><span>Cracked in stock {st.c} · jumbo {st.j}</span></div> },
    ],
    submit: 'Send',
    onSubmit: async (v) => {
      await rpc('rpc_dispatch', { p_from: from, p_to: v.to, p_n: v.n, p_c: v.c, p_j: v.j });
      return `${eggs(v.n + v.c + v.j)} on the way to ${locName(D, v.to)}. They confirm the count on arrival.`;
    },
  };
}

export function receiveForm(D: Dashboard, x: Transfer): FormSpec {
  const fields: Field[] = [{ type: 'eggs', id: 'n', label: 'Normal eggs received', def: x.sent_n }];
  if (x.sent_c || x.sent_j) fields.push({ type: 'pair', fields: [
    ...(x.sent_c ? [{ type: 'num', id: 'c', label: 'Cracked received', suffix: 'pc', def: x.sent_c } as Field] : []),
    ...(x.sent_j ? [{ type: 'num', id: 'j', label: 'Jumbo received', suffix: 'pc', def: x.sent_j } as Field] : []),
  ] });
  const recv = (v: V): Q => ({ n: v.n, c: x.sent_c ? v.c : 0, j: x.sent_j ? v.j : 0 });
  const sent = x.sent_n + x.sent_c + x.sent_j;
  return {
    title: `Receive from ${locName(D, x.from_loc)}`,
    intro: <div className="calc"><Row l="Sent" r={`${eggs(x.sent_n)} normal${x.sent_c ? ` · ${x.sent_c} cracked` : ''}${x.sent_j ? ` · ${x.sent_j} jumbo` : ''}`} /></div>,
    fields, submit: 'Confirm receipt',
    calc: (v) => { const d = sent - tot(recv(v)); return d > 0 ? <><Bad l="Short" r={eggs(d)} /><div><span>Logged as transit breakage and reported to the Farm Manager</span></div></>
      : d < 0 ? <Bad l="More than was sent" r="Check the count" /> : <Ok>Matches what was sent</Ok>; },
    onSubmit: async (v) => {
      const r = recv(v);
      const res = await rpc<{ short: number }>('rpc_receive', { p_transfer: x.id, p_n: r.n, p_c: r.c, p_j: r.j });
      return res.short > 0 ? `Received with ${eggs(res.short)} short. Farm Manager notified.` : 'Delivery received. Stock updated.';
    },
  };
}

export function breakageForm(D: Dashboard, loc: string): FormSpec {
  const st = stockNow(D, loc);
  return {
    title: 'Breakage / spoilage',
    fields: [
      { type: 'select', id: 'item', label: 'Eggs', options: ITEMS.map((i): [string, string] => [i, `${ITEM_NAME[i]} (${eggs(i === 'N' ? st.n : i === 'C' ? st.c : st.j)})`]) },
      { type: 'num', id: 'qty', label: 'Eggs lost', suffix: 'pieces' },
      { type: 'select', id: 'reason', label: 'Reason', options: [['Handling breakage', 'Broken while handling'], ['Customer return', 'Customer return'], ['Spoilage', 'Spoiled / expired'], ['Transport breakage', 'Broken on the road']] },
    ],
    onSubmit: async (v) => { await rpc('rpc_breakage', { p_loc: loc, p_item: v.item, p_qty: v.qty, p_reason: v.reason }); return 'Written off. Stock updated.'; },
  };
}

/* ---------------- sales ---------------- */
export function saleForm(D: Dashboard, loc: string): FormSpec {
  const st = stockNow(D, loc), s = D.settings;
  const due = (v: V) => priceOf(D, { n: v.n, c: v.c, j: v.j });
  return {
    title: 'Record sale',
    fields: [
      { type: 'eggs', id: 'n', label: 'Normal eggs', hint: `On the shelf: ${eggs(st.n)} · ${n0(s.tray_n)} per tray, ${s.pc_n} per loose egg` },
      { type: 'pair', fields: [{ type: 'num', id: 'c', label: 'Cracked', suffix: 'pc' }, { type: 'num', id: 'j', label: 'Jumbo', suffix: 'pc' }] },
      { type: 'note', text: <div><span>Cracked {st.c} · jumbo {st.j} on the shelf. Cracked {n0(s.tray_c)}/tray, jumbo {s.pc_j} each.</span></div> },
      { type: 'pair', fields: [{ type: 'num', id: 'cash', label: 'Cash', suffix: 'KES' }, { type: 'num', id: 'till', label: 'M-Pesa Till', suffix: 'KES' }] },
      { type: 'num', id: 'paybill', label: 'M-Pesa Paybill', suffix: 'KES' },
      { type: 'text', id: 'customer', label: 'Customer (optional)', placeholder: 'e.g. hotel or regular buyer' },
    ],
    calc: (v) => { const d = due(v), paid = v.cash + v.till + v.paybill, rem = d - paid; return <>
      <div><span>Amount due</span><b className="big">{kes(d)}</b></div>
      {d === 0 && paid === 0 ? <div><span className="muted">Enter the eggs sold, then how the customer paid</span></div>
        : d > 0 && rem === 0 ? <Ok>Payments add up to {kes(paid)}</Ok> : <Bad l={rem > 0 ? 'Still to allocate' : 'Over-allocated'} r={kes(Math.abs(rem))} />}</>; },
    buttons: (v, set) => <>{(['cash', 'till', 'paybill'] as const).map((m) => (
      <button key={m} type="button" className="btn sm alt" onClick={() => set({ cash: '', till: '', paybill: '', [m]: due(v) })}>All {m === 'cash' ? 'cash' : m === 'till' ? 'Till' : 'Paybill'}</button>))}</>,
    onSubmit: async (v) => {
      const d = due(v);
      if (v.cash + v.till + v.paybill !== d) throw new Error(`Payments (${kes(v.cash + v.till + v.paybill)}) must equal the amount due (${kes(d)}).`);
      await rpc('rpc_sale', { p_loc: loc, p_n: v.n, p_c: v.c, p_j: v.j, p_cash: v.cash, p_till: v.till, p_paybill: v.paybill, p_customer: v.customer || null });
      return `Sale of ${kes(d)} saved.`;
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
  const fields: Field[] = [
    { type: 'eggs', id: 'n', label: 'Normal eggs counted', def: Math.max(0, st.n) },
    { type: 'pair', fields: [{ type: 'num', id: 'c', label: 'Cracked counted', suffix: 'pc', def: Math.max(0, st.c) }, { type: 'num', id: 'j', label: 'Jumbo counted', suffix: 'pc', def: Math.max(0, st.j) }] },
  ];
  if (kind === 'close') fields.push({ type: 'num', id: 'cash', label: 'Cash in the drawer', suffix: 'KES', def: Math.max(0, exp), hint: `Expected ${kes(exp)}` });
  return {
    title: kind === 'open' ? 'Opening count' : 'Close the day',
    intro: <div className="calc"><Row l="Book stock" r={`${eggs(st.n)} normal · ${st.c} cracked · ${st.j} jumbo`} /></div>,
    fields, submit: kind === 'open' ? 'Open the day' : 'Close the day',
    calc: (v) => { const d = v.n + v.c + v.j - tot(st); return <>
      {d ? <Bad l="Stock variance" r={eggs(d)} /> : <Ok>Stock matches the book</Ok>}
      {kind === 'close' && (v.cash - exp ? <Bad l={`Cash ${v.cash < exp ? 'short' : 'over'}`} r={kes(Math.abs(v.cash - exp))} /> : <Ok>Cash matches</Ok>)}</>; },
    onSubmit: async (v) => {
      if (kind === 'open') {
        const r = await rpc<{ adj_n: number; adj_c: number; adj_j: number }>('rpc_stock_count', { p_loc: loc, p_kind: 'open', p_n: v.n, p_c: v.c, p_j: v.j });
        const d = r.adj_n + r.adj_c + r.adj_j;
        return d ? `Day opened. Stock off by ${eggs(d)}; the manager has been told.` : 'Day opened. Stock matches.';
      }
      const r = await rpc<{ adj_n: number; adj_c: number; adj_j: number; diff: number }>('rpc_close_day', { p_loc: loc, p_n: v.n, p_c: v.c, p_j: v.j, p_cash: v.cash });
      const d = r.adj_n + r.adj_c + r.adj_j, msgs = [];
      if (d) msgs.push(`stock off by ${eggs(d)}`);
      if (r.diff) msgs.push(`cash ${r.diff < 0 ? 'short' : 'over'} ${kes(Math.abs(r.diff))}`);
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

export const medicineForm = (m?: Medicine): FormSpec => ({
  title: m ? `Edit ${m.name}` : 'Add a medicine or vaccine',
  fields: [
    { type: 'text', id: 'name', label: 'Name', def: m?.name ?? '' },
    { type: 'pair', fields: [{ type: 'text', id: 'unit', label: 'Unit', def: m?.unit ?? '', placeholder: 'doses, g, ml, sachets' }, { type: 'num', id: 'reorder', label: 'Reorder at', def: m?.reorder ?? '' }] },
    { type: 'select', id: 'active', label: 'Status', options: [['true', 'In use'], ['false', 'Not in use']], def: String(m?.active ?? true) },
  ],
  onSubmit: async (v) => { await rpc('rpc_save_medicine', { p_id: m?.id ?? null, p_name: v.name, p_unit: v.unit, p_reorder: v.reorder, p_active: v.active === 'true' }); return 'Saved.'; },
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
export const staffForm = (D: Dashboard, s?: StaffLite): FormSpec => ({
  title: s ? `Edit ${s.display_name}` : 'Add staff member',
  intro: !s ? <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>They sign in with this username and the temporary password <b>0000</b>. It works once, for 72 hours, and they must choose their own password straight away. Owners and farm managers also set up two-step sign-in.</p> : undefined,
  fields: [
    { type: 'text', id: 'name', label: 'Name', def: s?.display_name ?? '' },
    { type: 'text', id: 'username', label: 'Username (lowercase, no spaces)', def: s?.username ?? '', placeholder: 'e.g. jane.w' },
    { type: 'select', id: 'role', label: 'Role', options: ROLE_OPTS, def: s?.role ?? 'pos' },
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
  for (const l of D.locations) fields.push({ type: 'eggs', id: `n_${l.id}`, label: `${l.name}: normal eggs`, def: Math.max(0, stockNow(D, l.id).n) },
    { type: 'pair', fields: [{ type: 'num', id: `c_${l.id}`, label: 'Cracked', suffix: 'pc', def: Math.max(0, stockNow(D, l.id).c) }, { type: 'num', id: `j_${l.id}`, label: 'Jumbo', suffix: 'pc', def: Math.max(0, stockNow(D, l.id).j) }] });
  for (const a of D.accounts) fields.push({ type: 'num', id: `m_${a.id}`, label: a.name, suffix: 'KES', def: balance(D, a.id) });
  fields.push({ type: 'pair', fields: [{ type: 'num', id: 'feed', label: 'Feed in store', suffix: 'kg', def: D.feed_stock }, { type: 'num', id: 'tank', label: 'Water in tank', suffix: 'L', def: D.tank?.litres ?? '' }] });
  for (const m of D.medicines.filter((x) => x.active)) fields.push({ type: 'num', id: `med_${m.id}`, label: `${m.name}`, suffix: m.unit, def: m.stock });
  return {
    title: 'Opening balances', fields, submit: 'Save opening balances',
    onSubmit: async (v) => {
      const stock: Record<string, Q> = {}, money: Record<string, number> = {}, medicines: Record<string, number> = {};
      for (const l of D.locations) stock[l.id] = { n: v[`n_${l.id}`], c: v[`c_${l.id}`], j: v[`j_${l.id}`] };
      for (const a of D.accounts) money[a.id] = v[`m_${a.id}`];
      for (const m of D.medicines.filter((x) => x.active)) medicines[String(m.id)] = v[`med_${m.id}`];
      const p: Record<string, unknown> = { stock, money, medicines, feed_kg: v.feed };
      if (v.tank > 0) p.tank_l = v.tank;
      await rpc('rpc_opening_balances', { p });
      return 'Opening balances saved. Dashboards now start from these figures.';
    },
  };
}
