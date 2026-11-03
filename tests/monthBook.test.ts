import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { type BookRow, type MonthBook, K, buildMonthBook, dayLine, expected } from '../src/lib/monthBook';

const z: Omit<BookRow, 'loc' | 'd'> = {
  open_cnt: null, prev_close: null, book_open: 0, close_cnt: null, recv_xfer: 0, collected: 0, taken_in: 0, sent: 0, broken: 0, issued: 0,
  sales: 0, sold: 0, value: 0, list_value: 0, cash: 0, till: 0, paybill: 0, credit: 0, e_cash: 0, e_till: 0, e_paybill: 0, e_credit: 0,
  imported: null, credit_paid: 0,
};
// three days shaped like the Tuala October book
const rows: BookRow[] = [
  { ...z, loc: 'TUALA', d: '2026-10-01', open_cnt: 9270, close_cnt: 2295, sold: 900, broken: 15, issued: 7860, sales: 1, value: 12560, list_value: 13500,
    cash: 3000, till: 9560, e_cash: 900 * 3000 / 12560, e_till: 900 * 9560 / 12560, imported: true },
  { ...z, loc: 'TUALA', d: '2026-10-02', prev_close: 2295, book_open: 2295, close_cnt: 7875, taken_in: 32550, sold: 15930, broken: 720, issued: 10320,
    sales: 1, value: 229450, list_value: 238950, cash: 200250, till: 29200, e_cash: 15930 * 200250 / 229450, e_till: 15930 * 29200 / 229450, imported: true },
  { ...z, loc: 'TUALA', d: '2026-10-03', book_open: 7875 },
  { ...z, loc: 'RAYAN', d: '2026-10-01' }, { ...z, loc: 'RAYAN', d: '2026-10-02', open_cnt: 13320, sold: 30, sales: 1, value: 480, list_value: 480,
    credit: 480, e_credit: 30, credit_paid: 200 },
  { ...z, loc: 'RAYAN', d: '2026-10-03' },
];
const book: MonthBook = {
  month: '2026-10-01', from: '2026-10-01', to: '2026-10-03', today: '2026-10-03', first_month: '2026-10-01', generated_at: '2026-10-03T10:00:00Z', tray: 30,
  locations: [{ id: 'TUALA', name: 'Tuala Egg Shop', short: 'Tuala' }, { id: 'RAYAN', name: 'Rayan Fedha', short: 'Rayan Fedha' }],
  rows,
};

describe('monthly outlet workbook', () => {
  it('fills a day from what was entered', () => {
    const l = dayLine(rows[0], '2026-11-03', 30);
    expect(l.state).toBe('filled');
    expect(l.opening).toBe(309);           // 9270 eggs
    expect(l.sold).toBe(30);
    expect(l.out).toBe(262);
    expect(l.closing).toBeCloseTo(76.5);
    expect(l.closing! - expected(l)).toBeCloseTo(60);   // the count was 1,800 eggs over the book
    expect(l.cash![0] + l.mpesa![0]).toBeCloseTo(30);    // modes add up to trays sold
    expect(l.price! * l.sold! - l.discount!).toBeCloseTo(12560, 0);  // trays x price - discounts = money taken
  });
  it('uses yesterday\'s closing count when there is no opening count', () => {
    const l = dayLine(rows[1], '2026-11-03', 30);
    expect(l.opening).toBeCloseTo(2295 / 30);
    expect(l.notes.join()).toMatch(/yesterday/);
  });
  it('leaves today blank until the day is closed, and says when nothing was entered', () => {
    expect(dayLine(rows[2], '2026-10-03', 30).state).toBe('waiting');
    expect(dayLine(rows[5], '2026-11-03', 30).state).toBe('nothing');
  });
  it('writes a workbook with a summary and one tab per outlet, formulas and their values', () => {
    const { bytes, filename } = buildMonthBook(book);
    expect(filename).toBe('Desert Pearl outlets October 2026 to 2026-10-03.xlsx');
    const files = unzipSync(bytes);
    const wb = strFromU8(files['xl/workbook.xml']);
    expect(wb).toContain('name="Summary"');
    expect(wb).toContain('name="Tuala Egg Shop"');
    expect(wb).toContain('name="Rayan Fedha"');
    const tuala = strFromU8(files['xl/worksheets/sheet2.xml']);
    expect(tuala).toContain(`<f>IF(OR(${K.open}6=&quot;&quot;,${K.sold}6=&quot;&quot;),`);
    expect(tuala).toContain('BALANCED');                 // 2 Oct balances
    expect(tuala).toContain('CHECK: recount');           // 1 Oct does not
    expect(tuala).toContain('Waiting for the day close');
    const sum = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(sum).toContain("&apos;Tuala Egg Shop&apos;!".replace(/&apos;/g, "'"));
    expect(sum).not.toMatch(/—/);
  });
});

// writes the sample workbook for a visual check when asked: DPV_WRITE_SAMPLE=/path.xlsx
if (process.env.DPV_WRITE_SAMPLE) {
  const fs = await import('node:fs');
  fs.writeFileSync(process.env.DPV_WRITE_SAMPLE, buildMonthBook(book).bytes);
}

describe('the van in the monthly workbook', () => {
  it('has no counts and says what was left on board', () => {
    const r: BookRow = { ...z, loc: 'VAN', d: '2026-10-02', book_open: 0, recv_xfer: 900, sold: 600, sent: 240, sales: 3, value: 9600, list_value: 9600, cash: 9600, e_cash: 600 };
    const l = dayLine(r, '2026-11-03', 30, true);
    expect(l.state).toBe('filled');
    expect(l.closing).toBeNull();
    expect(l.notes.join()).toMatch(/60 eggs still on board/);
    expect(dayLine({ ...r, sent: 300 }, '2026-11-03', 30, true).notes.join()).toMatch(/ended the day empty/);
  });
});
