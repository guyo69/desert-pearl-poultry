// The owner's monthly outlet workbook: the client's Daily Outlet Report
// template, one row per outlet per day, filled in from what the outlets
// entered. A Summary tab adds up each outlet's month. Figures the staff
// entered are yellow, sums the sheet works out are grey (as on the template).
import { type Cell, type Sheet, S, col, serial, sheetNames, xlsx } from './xlsx';

export interface BookRow {
  loc: string; d: string;
  open_cnt: number | null; prev_close: number | null; book_open: number; close_cnt: number | null;
  recv_xfer: number; collected: number; taken_in: number; sent: number; broken: number; issued: number;
  sales: number; sold: number; value: number; list_value: number; cash: number; till: number; paybill: number; credit: number;
  e_cash: number; e_till: number; e_paybill: number; e_credit: number; imported: boolean | null; credit_paid: number;
}
export interface MonthBook {
  month: string; from: string; to: string; today: string; first_month: string; generated_at: string; tray: number;
  locations: { id: string; name: string; short: string; kind?: string }[];
  rows: BookRow[];
  /** the feed mill (absent on an older server) */
  materials?: { id: number; name: string; per_tonne: number; bag_kg: number; active: boolean; open: number; close: number }[];
  ledger?: LedgerRow[];
  feed?: FeedRow[]; houses?: string[]; feed_open?: number; feed_bag_kg?: number;
}
/** One raw material on one day it moved (kg). `tonnes` is everything milled that day. */
export interface LedgerRow { d: string; material_id: number; tonnes: number; opening: number; purchase: number; used: number; adjust: number }
/** Feed on one day (kg): milled on the farm, bought in, given to houses (by house name), store adjustments, and eggs collected. */
export interface FeedRow { d: string; milled: number; bought: number; used: number; houses: Record<string, number>; adjust: number; eggs: number }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const monthName = (iso: string) => `${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
const dayName = (iso: string) => `${DAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]} ${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1].slice(0, 3)}`;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** What one day at one outlet looks like on the sheet, with the reason when it is blank. */
export interface DayLine {
  d: string; state: 'filled' | 'waiting' | 'nothing';
  opening?: number; received?: number; sold?: number; loss?: number; out?: number; sent?: number; closing?: number | null;
  cash?: [number, number]; mpesa?: [number, number]; paybill?: [number, number]; credit?: [number, number];
  price?: number | null; discount?: number; creditPaid?: number; notes: string[];
}
export const expected = (l: DayLine) => l.opening! + l.received! - l.sold! - l.loss! - l.out! - l.sent!;

/** One outlet day. The van has no counts: its opening is what was on board, and the note says what was left at day end. */
export function dayLine(r: BookRow, today: string, tray: number, van = false): DayLine {
  const t = (eggs: number) => eggs / tray;
  const moved = r.recv_xfer + r.collected + r.taken_in + r.sent + r.broken + r.issued + r.sold + r.credit_paid;
  const counted = r.open_cnt != null || r.close_cnt != null;
  if (r.d === today && r.close_cnt == null && !van) return { d: r.d, state: 'waiting', notes: ['Waiting for the day close'] };
  if (!moved && !counted && !r.sales) return { d: r.d, state: 'nothing', notes: ['Nothing entered'] };
  const notes: string[] = [];
  const opening = van ? r.book_open : r.open_cnt ?? r.prev_close ?? r.book_open;
  if (van) {
    const left = r.book_open + r.recv_xfer + r.taken_in - r.sold - r.broken - r.issued - r.sent;
    notes.push(left > 0 ? `Van, no counts: ${Math.round(left)} eggs still on board at the end of the day` : 'Van, no counts: ended the day empty');
  } else if (r.open_cnt == null) notes.push(r.prev_close != null ? 'Opening is yesterday\'s closing count' : 'Opening from the app\'s stock book (no count)');
  if (r.close_cnt == null && !van) notes.push('No closing count');
  if (r.imported) notes.push('Sales from the paper book');
  if (r.collected) notes.push('Received = eggs collected at the farm');
  const pair = (eggs: number, ksh: number): [number, number] => [t(eggs), ksh];
  return {
    d: r.d, state: 'filled', notes,
    opening: t(opening), received: t(r.recv_xfer + r.collected + r.taken_in), sold: t(r.sold), loss: t(r.broken), out: t(r.issued), sent: t(r.sent),
    closing: r.close_cnt == null ? null : t(r.close_cnt),
    cash: pair(r.e_cash, r.cash), mpesa: pair(r.e_till, r.till), paybill: pair(r.e_paybill, r.paybill), credit: pair(r.e_credit, r.credit),
    price: r.sold > 0 ? r2(r.list_value / t(r.sold)) : null, discount: r.list_value - r.value, creditPaid: r.credit_paid,
  };
}

type St = (typeof S)[keyof typeof S];
// columns of an outlet sheet: key, heading, width
const COLS = [
  ['date', 'Date', 12], ['open', 'Opening trays', 10], ['recv', 'Trays received', 10], ['sold', 'Trays sold (all payment modes)', 11],
  ['loss', 'Stock loss (broken, spoilt)', 10], ['out', 'Out, no sale (gifts, own use, issued)', 11], ['sent', 'Sent to other outlets', 10],
  ['close', 'Physical closing count', 10], ['exp', 'Expected closing (auto)', 10], ['var', 'Variance: physical minus expected (auto)', 11], ['status', 'Stock status (auto)', 15],
  ['cashT', 'Cash trays', 9], ['cashK', 'Cash KSh', 11], ['tillT', 'M-Pesa Till trays', 9], ['tillK', 'M-Pesa Till KSh', 11],
  ['payT', 'Paybill trays', 9], ['payK', 'Paybill KSh', 11], ['credT', 'Credit trays', 9], ['credK', 'Credit KSh', 11],
  ['price', 'Price per tray (KSh)', 10], ['disc', 'Discounts / refunds (KSh)', 11],
  ['alloc', 'Trays allocated to modes (auto)', 11], ['tcheck', 'Tray check (auto)', 14], ['money', 'Money from all modes (auto)', 12],
  ['expM', 'Expected money: trays x price - discounts (auto)', 13], ['mcheck', 'Money check (auto)', 13],
  ['paid', 'Credit paid back by customers (KSh)', 12], ['notes', 'Notes', 46],
] as const;
type Key = (typeof COLS)[number][0];
export const K = Object.fromEntries(COLS.map(([k], i) => [k, col(i)])) as Record<Key, string>;
const FIRST = 6, HEADROW = 5;

function outletSheet(name: string, title: string, sub: string, lines: DayLine[]): { sheet: Sheet; total: number } {
  const n = COLS.length;
  const rows: (Cell | null)[][] = [];
  rows.push([{ v: title, s: S.title }, ...Array(n - 1).fill({ s: S.title })]);
  rows.push([{ v: sub, s: S.note }]);
  rows.push([]);
  const g = (label: string, span: number): Cell[] => [{ v: label, s: S.group }, ...Array(span - 1).fill({ s: S.group })];
  rows.push([{ s: S.group }, ...g('STOCK (trays of 30 eggs)', 10), ...g('MONEY: how customers paid (trays and KSh)', 15), ...g('CREDIT', 1), ...g('', 1)]);
  rows.push(COLS.map(([, h]) => ({ v: h, s: S.head })));
  lines.forEach((x, i) => {
    const R = FIRST + i, c = (k: Key) => `${K[k]}${R}`;
    const has = x.state === 'filled';
    const num = (v: number | null | undefined, s: St): Cell => ({ v: has && v != null ? v : null, s });
    // the values the formulas give, so phone previewers show figures too
    const exp = has ? expected(x) : null;
    const vari = has && x.closing != null ? x.closing - exp! : null;
    const alloc = has ? x.cash![0] + x.mpesa![0] + x.paybill![0] + x.credit![0] : null;
    const money = has ? x.cash![1] + x.mpesa![1] + x.paybill![1] + x.credit![1] : null;
    const expMoney = has && x.price != null ? x.sold! * x.price - (x.discount ?? 0) : null;
    const cells: Record<Key, Cell> = {
      date: { v: serial(x.d), s: S.date },
      open: num(x.opening, S.inTrays), recv: num(x.received, S.inTrays), sold: num(x.sold, S.inTrays), loss: num(x.loss, S.inTrays),
      out: num(x.out, S.inTrays), sent: num(x.sent, S.inTrays), close: num(x.closing, S.inTrays),
      exp: { f: `IF(OR(${c('open')}="",${c('sold')}=""),"",${c('open')}+N(${c('recv')})-${c('sold')}-N(${c('loss')})-N(${c('out')})-N(${c('sent')}))`, v: exp, s: S.autoTrays },
      var: { f: `IF(OR(${c('exp')}="",${c('close')}=""),"",${c('close')}-${c('exp')})`, v: vari, s: S.autoTrays },
      status: { f: `IF(${c('var')}="","",IF(ABS(${c('var')})<0.01,"BALANCED","CHECK: recount"))`, v: vari == null ? '' : Math.abs(vari) < 0.01 ? 'BALANCED' : 'CHECK: recount', s: S.autoText },
      cashT: num(x.cash?.[0], S.inTrays), cashK: num(x.cash?.[1], S.inMoney), tillT: num(x.mpesa?.[0], S.inTrays), tillK: num(x.mpesa?.[1], S.inMoney),
      payT: num(x.paybill?.[0], S.inTrays), payK: num(x.paybill?.[1], S.inMoney), credT: num(x.credit?.[0], S.inTrays), credK: num(x.credit?.[1], S.inMoney),
      price: num(x.price, S.inMoney), disc: num(x.discount, S.inMoney),
      alloc: { f: `IF(${c('sold')}="","",N(${c('cashT')})+N(${c('tillT')})+N(${c('payT')})+N(${c('credT')}))`, v: alloc, s: S.autoTrays },
      tcheck: { f: `IF(${c('sold')}="","",IF(ABS(${c('alloc')}-${c('sold')})>0.01,"MODE TRAYS <> TRAYS SOLD","OK"))`, v: alloc == null ? '' : Math.abs(alloc - x.sold!) > 0.01 ? 'MODE TRAYS <> TRAYS SOLD' : 'OK', s: S.autoText },
      money: { f: `IF(${c('sold')}="","",N(${c('cashK')})+N(${c('tillK')})+N(${c('payK')})+N(${c('credK')}))`, v: money, s: S.autoMoney },
      expM: { f: `IF(OR(${c('sold')}="",${c('price')}=""),"",${c('sold')}*${c('price')}-N(${c('disc')}))`, v: expMoney, s: S.autoMoney },
      mcheck: { f: `IF(${c('expM')}="","",IF(ABS(${c('money')}-${c('expM')})>1,"MONEY CHECK","OK"))`, v: expMoney == null ? '' : Math.abs(money! - expMoney) > 1 ? 'MONEY CHECK' : 'OK', s: S.autoText },
      paid: num(x.creditPaid, S.inMoney),
      notes: { v: x.notes.join('. '), s: S.text },
    };
    rows.push(COLS.map(([k]) => cells[k]));
  });
  const last = FIRST + Math.max(lines.length, 1) - 1, T = last + 1;
  const filled = lines.filter((l) => l.state === 'filled');
  const add = (f: (l: DayLine) => number | null | undefined) => filled.reduce((a, l) => a + (f(l) ?? 0), 0);
  const sum = (k: Key, s: St, v: number): Cell => ({ f: `SUM(${K[k]}${FIRST}:${K[k]}${last})`, v, s });
  const counted = filled.filter((l) => l.closing != null);
  const bal = counted.filter((l) => Math.abs(l.closing! - expected(l)) < 0.01).length;
  const lastClose = [...filled].reverse().find((l) => l.closing != null);
  const rng = (k: Key) => `${K[k]}${FIRST}:${K[k]}${last}`;
  const tot: Record<Key, Cell> = {
    date: { v: 'Month total', s: S.totLabel },
    open: { f: `IFERROR(INDEX(${rng('open')},MATCH(TRUE,INDEX(${rng('open')}<>"",0),0)),"")`, v: filled[0]?.opening ?? '', s: S.totTrays },
    recv: sum('recv', S.totTrays, add((l) => l.received)), sold: sum('sold', S.totTrays, add((l) => l.sold)), loss: sum('loss', S.totTrays, add((l) => l.loss)),
    out: sum('out', S.totTrays, add((l) => l.out)), sent: sum('sent', S.totTrays, add((l) => l.sent)),
    close: { f: `IFERROR(LOOKUP(2,1/(${rng('close')}<>""),${rng('close')}),"")`, v: lastClose?.closing ?? '', s: S.totTrays },
    exp: { s: S.totTrays }, var: sum('var', S.totTrays, add((l) => (l.closing == null ? 0 : l.closing - expected(l)))),
    status: { f: `COUNTIF(${rng('status')},"BALANCED")&" of "&COUNT(${rng('close')})&" counted days balanced"`, v: `${bal} of ${counted.length} counted days balanced`, s: S.totLabel },
    cashT: sum('cashT', S.totTrays, add((l) => l.cash?.[0])), cashK: sum('cashK', S.totMoney, add((l) => l.cash?.[1])),
    tillT: sum('tillT', S.totTrays, add((l) => l.mpesa?.[0])), tillK: sum('tillK', S.totMoney, add((l) => l.mpesa?.[1])),
    payT: sum('payT', S.totTrays, add((l) => l.paybill?.[0])), payK: sum('payK', S.totMoney, add((l) => l.paybill?.[1])),
    credT: sum('credT', S.totTrays, add((l) => l.credit?.[0])), credK: sum('credK', S.totMoney, add((l) => l.credit?.[1])),
    price: { s: S.totMoney }, disc: sum('disc', S.totMoney, add((l) => l.discount)),
    alloc: sum('alloc', S.totTrays, add((l) => (l.cash ? l.cash[0] + l.mpesa![0] + l.paybill![0] + l.credit![0] : 0))), tcheck: { s: S.totLabel },
    money: sum('money', S.totMoney, add((l) => (l.cash ? l.cash[1] + l.mpesa![1] + l.paybill![1] + l.credit![1] : 0))),
    expM: sum('expM', S.totMoney, add((l) => (l.price != null ? l.sold! * l.price - (l.discount ?? 0) : 0))), mcheck: { s: S.totLabel },
    paid: sum('paid', S.totMoney, add((l) => l.creditPaid)), notes: { s: S.totLabel },
  };
  rows.push(COLS.map(([k]) => tot[k]));
  rows.push([]);
  rows.push([{ v: 'Yellow: what the outlet entered in the app. Grey: worked out by the sheet, as on the Daily Outlet Report. A tray is 30 eggs; jumbo eggs are counted as eggs. Credit trays count as sold; the money arrives when the customer pays (Credit paid back). A sale paid two ways is split across the modes by the money paid.', s: S.note }]);
  return {
    sheet: { name, rows, widths: COLS.map(([, , w]) => w), freeze: `B${FIRST}`, heights: { 1: 24, 2: 30, [HEADROW]: 62, [T + 2]: 30 },
      merges: [`A1:${col(n - 1)}1`, `A2:${col(n - 1)}2`, `${K.open}4:${K.status}4`, `${K.cashT}4:${K.mcheck}4`, `A${T + 2}:${col(n - 1)}${T + 2}`] },
    total: T,
  };
}
type Val = string | number | null;

export function buildMonthBook(b: MonthBook): { bytes: Uint8Array; filename: string } {
  const month = monthName(b.month);
  const isCurrent = b.month.slice(0, 7) === b.today.slice(0, 7);
  const made = new Date(b.generated_at);
  const nbo = new Date(made.getTime() + 3 * 3600e3).toISOString();
  const madeAt = `${dayName(nbo.slice(0, 10))} ${nbo.slice(0, 4)} at ${nbo.slice(11, 16)}`;
  const names = sheetNames(['Summary', ...b.locations.map((l) => l.name)]);
  const sub = isCurrent
    ? `Filled in from the app as the outlets enter it: every day to ${dayName(addDay(b.today, -1))}, and today once the outlet closes the day. Made ${madeAt}.`
    : `The whole month as the outlets entered it in the app. Made ${madeAt}.`;
  const sheets: Sheet[] = [];
  const totals: { name: string; row: number; lines: DayLine[] }[] = [];
  b.locations.forEach((l, i) => {
    const lines = b.rows.filter((r) => r.loc === l.id).map((r) => dayLine(r, b.today, b.tray || 30, l.kind === 'van'));
    const o = outletSheet(names[i + 1], `${l.name} · ${month}`, sub, lines);
    sheets.push(o.sheet);
    totals.push({ name: names[i + 1], row: o.total, lines });
  });
  sheets.unshift(summarySheet(b, month, sub, totals));
  if (b.materials) {
    const subFarm = isCurrent ? `Filled in from the app as the farm enters it, to today. Made ${madeAt}.` : `The whole month as entered in the app. Made ${madeAt}.`;
    const [ln, fn] = sheetNames([...names, 'Store ledger', 'Feed']).slice(-2);
    sheets.push(ledgerSheet(b, ln, `Store ledger · ${month}`, subFarm));
    sheets.push(feedSheet(b, fn, `Feed · ${month}`, subFarm));
  }
  return { bytes: xlsx(sheets, { title: `Desert Pearl · ${month}`, creator: 'Desert Pearl Poultry Manager' }),
           filename: `Desert Pearl ${month}${isCurrent ? ` to ${b.today}` : ''}.xlsx` };
}

function addDay(iso: string, n: number) { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }

function summarySheet(b: MonthBook, month: string, sub: string, totals: { name: string; row: number; lines: DayLine[] }[]): Sheet {
  const heads: [string, Key | '', St, number][] = [
    ['Outlet', '', S.text, 26], ['Trays received', 'recv', S.autoTrays, 11], ['Trays sold', 'sold', S.autoTrays, 11], ['Stock loss (trays)', 'loss', S.autoTrays, 11],
    ['Out, no sale (trays)', 'out', S.autoTrays, 11], ['Sent to other outlets (trays)', 'sent', S.autoTrays, 12], ['Variance (trays)', 'var', S.autoTrays, 11],
    ['Counted days balanced', 'status', S.autoText, 26],
    ['Cash KSh', 'cashK', S.autoMoney, 12], ['M-Pesa Till KSh', 'tillK', S.autoMoney, 12], ['Paybill KSh', 'payK', S.autoMoney, 12], ['Credit KSh', 'credK', S.autoMoney, 12],
    ['Sales KSh (all modes)', 'money', S.autoMoney, 13], ['Discounts KSh', 'disc', S.autoMoney, 11], ['Credit paid back KSh', 'paid', S.autoMoney, 12],
  ];
  const n = heads.length;
  const rows: (Cell | null)[][] = [
    [{ v: `Desert Pearl outlets · ${month}`, s: S.title }, ...Array(n - 1).fill({ s: S.title })],
    [{ v: sub, s: S.note }],
    [],
    heads.map(([h]) => ({ v: h, s: S.head })),
  ];
  totals.forEach((t, i) => {
    const f = t.lines.filter((l) => l.state === 'filled');
    const add = (g: (l: DayLine) => number | null | undefined) => f.reduce((a, l) => a + (g(l) ?? 0), 0);
    const counted = f.filter((l) => l.closing != null);
    const val: Partial<Record<Key, Val>> = {
      recv: add((l) => l.received), sold: add((l) => l.sold), loss: add((l) => l.loss), out: add((l) => l.out), sent: add((l) => l.sent),
      var: add((l) => (l.closing == null ? 0 : l.closing - expected(l))),
      status: `${counted.filter((l) => Math.abs(l.closing! - expected(l)) < 0.01).length} of ${counted.length} counted days balanced`,
      cashK: add((l) => l.cash?.[1]), tillK: add((l) => l.mpesa?.[1]), payK: add((l) => l.paybill?.[1]), credK: add((l) => l.credit?.[1]),
      money: add((l) => (l.cash ? l.cash[1] + l.mpesa![1] + l.paybill![1] + l.credit![1] : 0)), disc: add((l) => l.discount), paid: add((l) => l.creditPaid),
    };
    rows.push(heads.map(([, k, s]) => (k === '' ? { v: b.locations[i].name, s: S.text } : { f: `'${t.name}'!${K[k]}${t.row}`, v: val[k] ?? null, s })));
  });
  const a = 5, z = 4 + totals.length;
  rows.push(heads.map(([, k, s], j) => {
    if (j === 0) return { v: 'All outlets', s: S.totLabel };
    if (k === 'status') return { s: S.totLabel };
    const v = rows.slice(4).reduce((acc, r) => acc + (Number((r[j] as Cell).v) || 0), 0);
    return { f: `SUM(${col(j)}${a}:${col(j)}${z})`, v, s: s === S.autoMoney ? S.totMoney : S.totTrays };
  }));
  rows.push([]);
  rows.push([{ v: 'Each outlet has its own tab with one row per day, laid out like the Daily Outlet Report. A day is blank when nothing was entered, or when today has not been closed yet.', s: S.note }]);
  return { name: 'Summary', rows, widths: heads.map((h) => h[3]), freeze: 'B5', heights: { 1: 24, 2: 30, 4: 46, [z + 3]: 30 }, merges: [`A1:${col(n - 1)}1`, `A2:${col(n - 1)}2`, `A${z + 3}:${col(n - 1)}${z + 3}`] };
}

/* ---------------- the farm: store ledger and feed ---------------- */
/**
 * The inventory clerk's stock ledger: a summary per raw material for the month
 * (KPIs that cover every row), then one row per material per day it moved.
 * Closing = Opening + Purchase - Used + Count adjustment; each opening after the
 * first is the same material's previous closing, so the sheet carries itself.
 */
export function ledgerSheet(b: MonthBook, name: string, title: string, sub: string): Sheet {
  const mats = (b.materials ?? []).filter((m) => m.active || m.open || m.close || (b.ledger ?? []).some((l) => l.material_id === m.id));
  const lines = [...(b.ledger ?? [])].sort((x, y) => x.d.localeCompare(y.d) || mats.findIndex((m) => m.id === x.material_id) - mats.findIndex((m) => m.id === y.material_id));
  const nameOf = (id: number) => mats.find((m) => m.id === id)?.name ?? `Material ${id}`;
  const bagOf = (id: number) => mats.find((m) => m.id === id)?.bag_kg ?? 50;
  const W = 11;
  const rows: (Cell | null)[][] = [
    [{ v: title, s: S.title }, ...Array(W - 1).fill({ s: S.title })],
    [{ v: sub, s: S.note }],
    [],
  ];
  // the daily ledger starts below the material summary
  const sumHead = 7, sumFirst = sumHead + 1, sumLast = sumHead + Math.max(mats.length, 1);
  const dHead = sumLast + 4, dFirst = dHead + 1, dLast = dHead + Math.max(lines.length, 1);
  const L = { date: 'A', mat: 'B', t: 'C', open: 'D', buy: 'E', used: 'F', adj: 'G', close: 'H', bag: 'I', bags: 'J', note: 'K' };
  const rng = (c: string) => `$${c}$${dFirst}:$${c}$${dLast}`;
  const tonnes = lines.reduce((a, l, i) => a + (i === 0 || lines[i - 1].d !== l.d ? Number(l.tonnes) : 0), 0);
  const usedKg = lines.reduce((a, l) => a + Number(l.used), 0), boughtKg = lines.reduce((a, l) => a + Number(l.purchase), 0);
  const closeKg = mats.reduce((a, m) => a + Number(m.close), 0);
  // KPIs: rows 4 to 6
  rows.push([{ v: 'Tonnes milled', s: S.head }, { v: 'Raw material used (kg)', s: S.head }, { v: 'Raw material bought (kg)', s: S.head },
             { v: 'In store at month end (kg)', s: S.head }, { v: 'Raw materials', s: S.head }]);
  rows.push([{ f: `SUM(${rng(L.t)})`, v: tonnes, s: S.totTrays }, { f: `SUM(${rng(L.used)})`, v: usedKg, s: S.totMoney },
             { f: `SUM(${rng(L.buy)})`, v: boughtKg, s: S.totMoney }, { f: `SUM(F${sumFirst}:F${sumLast})`, v: closeKg, s: S.totMoney },
             { f: `COUNTA(A${sumFirst}:A${sumLast})`, v: mats.length, s: S.totInt }]);
  rows.push([]);
  // material summary
  rows.push(['Raw material', 'Opening at month start (kg)', 'Bought (kg)', 'Used (kg)', 'Count adjustments (kg)', 'Closing at month end (kg)', 'Bags remaining', 'kg in a tonne of feed', 'Tonnes it can mill']
    .map((h) => ({ v: h, s: S.head })));
  mats.forEach((m, i) => {
    const R = sumFirst + i, my = lines.filter((l) => l.material_id === m.id);
    const add = (f: (l: LedgerRow) => number) => my.reduce((a, l) => a + Number(f(l)), 0);
    const crit = `$A${R}`;
    rows.push([
      { v: m.name, s: S.text }, { v: Number(m.open), s: S.inMoney },
      { f: `SUMIF(${rng(L.mat)},${crit},${rng(L.buy)})`, v: add((l) => l.purchase), s: S.autoMoney },
      { f: `SUMIF(${rng(L.mat)},${crit},${rng(L.used)})`, v: add((l) => l.used), s: S.autoMoney },
      { f: `SUMIF(${rng(L.mat)},${crit},${rng(L.adj)})`, v: add((l) => l.adjust), s: S.autoMoney },
      { f: `B${R}+C${R}-D${R}+E${R}`, v: Number(m.close), s: S.autoMoney },
      { f: `F${R}/${Number(m.bag_kg) || 50}`, v: Number(m.close) / (Number(m.bag_kg) || 50), s: S.autoTrays },
      { v: Number(m.per_tonne), s: S.inMoney },
      { f: `IF(H${R}>0,MAX(F${R},0)/H${R},"")`, v: Number(m.per_tonne) > 0 ? Math.max(Number(m.close), 0) / Number(m.per_tonne) : '', s: S.autoTrays },
    ]);
  });
  if (!mats.length) rows.push([{ v: 'No raw materials set up', s: S.text }]);
  rows.push([]);
  rows.push([{ v: 'Every day a raw material moved', s: S.group }, ...Array(W - 1).fill({ s: S.group })]);
  rows.push([]);
  rows.push(['Date', 'Raw material', 'Tonnes milled that day', 'Opening (kg)', 'Purchase (kg)', 'Used (kg)', 'Count adjustment (kg)', 'Closing (kg) (auto)', 'Bag size (kg)', 'Bags remaining (auto)', 'Notes']
    .map((h) => ({ v: h, s: S.head })));
  const lastRow: Record<number, number> = {};
  lines.forEach((l, i) => {
    const R = dFirst + i, first = i === 0 || lines[i - 1].d !== l.d, prev = lastRow[l.material_id];
    const close = Number(l.opening) + Number(l.purchase) - Number(l.used) + Number(l.adjust);
    const notes = [first && Number(l.tonnes) ? `${Number(l.tonnes)} t milled` : '', Number(l.adjust) ? 'Store counted' : ''].filter(Boolean).join('. ');
    rows.push([
      { v: serial(l.d), s: S.date }, { v: nameOf(l.material_id), s: S.text },
      first ? { v: Number(l.tonnes) || null, s: S.inTrays } : { s: S.autoTrays },
      prev ? { f: `H${prev}`, v: Number(l.opening), s: S.autoMoney } : { v: Number(l.opening), s: S.inMoney },
      { v: Number(l.purchase) || null, s: S.inMoney }, { v: Number(l.used) || null, s: S.inMoney }, { v: Number(l.adjust) || null, s: S.inMoney },
      { f: `D${R}+N(E${R})-N(F${R})+N(G${R})`, v: close, s: S.autoMoney },
      { v: bagOf(l.material_id), s: S.inMoney }, { f: `IF(I${R}>0,H${R}/I${R},"")`, v: close / bagOf(l.material_id), s: S.autoTrays },
      { v: notes, s: S.text },
    ]);
    lastRow[l.material_id] = R;
  });
  if (!lines.length) rows.push([{ v: 'No raw material moved this month', s: S.text }]);
  rows.push([]);
  rows.push([{ v: 'Yellow: what the inventory clerk entered in the app (deliveries, millings and counts). Used is worked out by the app from the recipe in force on the day of each milling. Grey: worked out by the sheet. Closing = Opening + Purchase - Used + Count adjustment; a count adjustment is what was counted less what the book said. Each opening is the same material\'s previous closing.', s: S.note }]);
  const noteRow = rows.length;
  return { name, rows, widths: [13, 20, 12, 13, 13, 13, 13, 14, 10, 12, 30], heights: { 1: 24, 2: 30, 4: 32, [sumHead]: 46, [dHead]: 46, [noteRow]: 44 },
    merges: [`A1:${col(W - 1)}1`, `A2:${col(W - 1)}2`, `A${dHead - 2}:${col(W - 1)}${dHead - 2}`, `A${noteRow}:${col(W - 1)}${noteRow}`] };
}

/** Feed each day: milled on the farm, bought, given to each house, what is left in the feed store, and the feed per egg. */
export function feedSheet(b: MonthBook, name: string, title: string, sub: string): Sheet {
  const lines = b.feed ?? [];
  const houses = [...(b.houses ?? [])];
  for (const l of lines) for (const h of Object.keys(l.houses ?? {})) if (!houses.includes(h)) houses.push(h);
  const bag = Number(b.feed_bag_kg) || 50;
  const heads = ['Date', 'Milled on the farm (kg)', 'Bought in (kg)', ...houses.map((h) => `Given to ${h} (kg)`), 'Feed used (kg) (auto)', 'Store adjustment (kg)',
                 'Feed in store at day end (kg) (auto)', `Bags in store (${bag} kg) (auto)`, 'Eggs collected', 'Feed per egg (g) (auto)'];
  const n = heads.length, H = houses.length;
  const c = { date: 0, milled: 1, bought: 2, house0: 3, used: 3 + H, adj: 4 + H, store: 5 + H, bags: 6 + H, eggs: 7 + H, per: 8 + H };
  const rows: (Cell | null)[][] = [
    [{ v: title, s: S.title }, ...Array(n - 1).fill({ s: S.title })],
    [{ v: sub, s: S.note }],
    [{ v: 'Feed in store at the start of the month (kg)', s: S.totLabel }, null, null, { v: Number(b.feed_open ?? 0), s: S.inMoney }],
    [],
    heads.map((h) => ({ v: h, s: S.head })),
  ];
  const FIRST = 6, OPEN = `$D$3`;
  let store = Number(b.feed_open ?? 0);
  lines.forEach((l, i) => {
    const R = FIRST + i, C = (k: number) => `${col(k)}${R}`;
    const used = Number(l.used); store += Number(l.milled) + Number(l.bought) - used + Number(l.adjust);
    const prev = i === 0 ? OPEN : `${col(c.store)}${R - 1}`;
    rows.push([
      { v: serial(l.d), s: S.date }, { v: Number(l.milled) || null, s: S.inMoney }, { v: Number(l.bought) || null, s: S.inMoney },
      ...houses.map((h) => ({ v: Number(l.houses?.[h] ?? 0) || null, s: S.inMoney })),
      H ? { f: `SUM(${C(c.house0)}:${col(c.house0 + H - 1)}${R})`, v: used, s: S.autoMoney } : { v: used, s: S.autoMoney },
      { v: Number(l.adjust) || null, s: S.inMoney },
      { f: `${prev}+N(${C(c.milled)})+N(${C(c.bought)})-N(${C(c.used)})+N(${C(c.adj)})`, v: store, s: S.autoMoney },
      { f: `${C(c.store)}/${bag}`, v: store / bag, s: S.autoTrays },
      { v: Number(l.eggs) || null, s: S.inMoney },
      { f: `IF(N(${C(c.eggs)})>0,${C(c.used)}*1000/${C(c.eggs)},"")`, v: Number(l.eggs) > 0 ? used * 1000 / Number(l.eggs) : '', s: S.autoTrays },
    ]);
  });
  const last = FIRST + Math.max(lines.length, 1) - 1;
  if (!lines.length) rows.push([{ v: 'No feed recorded this month', s: S.text }]);
  const sumOf = (k: number, v: number): Cell => ({ f: `SUM(${col(k)}${FIRST}:${col(k)}${last})`, v, s: S.totMoney });
  const tot = (f: (l: FeedRow) => number) => lines.reduce((a, l) => a + Number(f(l)), 0);
  const eggsT = tot((l) => l.eggs), usedT = tot((l) => l.used), T = last + 1;
  rows.push([{ v: 'Month total', s: S.totLabel }, sumOf(c.milled, tot((l) => l.milled)), sumOf(c.bought, tot((l) => l.bought)),
    ...houses.map((h, j) => sumOf(c.house0 + j, tot((l) => l.houses?.[h] ?? 0))), sumOf(c.used, usedT), sumOf(c.adj, tot((l) => l.adjust)),
    { f: lines.length ? `${col(c.store)}${last}` : OPEN, v: store, s: S.totMoney }, { f: `${col(c.store)}${T}/${bag}`, v: store / bag, s: S.totTrays },
    sumOf(c.eggs, eggsT), { f: `IF(${col(c.eggs)}${T}>0,${col(c.used)}${T}*1000/${col(c.eggs)}${T},"")`, v: eggsT > 0 ? usedT * 1000 / eggsT : '', s: S.totTrays }]);
  rows.push([]);
  rows.push([{ v: 'Yellow: what was entered in the app. Milled is the feed made from the store ledger\'s raw materials; given to a house is what the store issued or the farm manager recorded. Grey: worked out by the sheet. Feed per egg is the grams of feed used for each good egg collected that day.', s: S.note }]);
  return { name, rows, widths: [13, 13, 12, ...houses.map(() => 13), 13, 12, 15, 12, 12, 12], freeze: `B${FIRST}`, heights: { 1: 24, 2: 30, 5: 58, [T + 2]: 32 },
    merges: [`A1:${col(n - 1)}1`, `A2:${col(n - 1)}2`, `A3:C3`, `A${T + 2}:${col(n - 1)}${T + 2}`] };
}
