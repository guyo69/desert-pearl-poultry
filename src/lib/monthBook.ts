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
  locations: { id: string; name: string; short: string }[];
  rows: BookRow[];
}

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

export function dayLine(r: BookRow, today: string, tray: number): DayLine {
  const t = (eggs: number) => eggs / tray;
  const moved = r.recv_xfer + r.collected + r.taken_in + r.sent + r.broken + r.issued + r.sold + r.credit_paid;
  const counted = r.open_cnt != null || r.close_cnt != null;
  if (r.d === today && r.close_cnt == null) return { d: r.d, state: 'waiting', notes: ['Waiting for the day close'] };
  if (!moved && !counted && !r.sales) return { d: r.d, state: 'nothing', notes: ['Nothing entered'] };
  const notes: string[] = [];
  const opening = r.open_cnt ?? r.prev_close ?? r.book_open;
  if (r.open_cnt == null) notes.push(r.prev_close != null ? 'Opening is yesterday\'s closing count' : 'Opening from the app\'s stock book (no count)');
  if (r.close_cnt == null) notes.push('No closing count');
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
    const lines = b.rows.filter((r) => r.loc === l.id).map((r) => dayLine(r, b.today, b.tray || 30));
    const o = outletSheet(names[i + 1], `${l.name} · ${month}`, sub, lines);
    sheets.push(o.sheet);
    totals.push({ name: names[i + 1], row: o.total, lines });
  });
  sheets.unshift(summarySheet(b, month, sub, totals));
  return { bytes: xlsx(sheets, { title: `Desert Pearl outlets · ${month}`, creator: 'Desert Pearl Poultry Manager' }),
           filename: `Desert Pearl outlets ${month}${isCurrent ? ` to ${b.today}` : ''}.xlsx` };
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
