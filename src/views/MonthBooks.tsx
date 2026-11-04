// The owner's monthly outlet workbooks: the Daily Outlet Report template, one
// row per outlet per day, built from what the outlets entered. The current
// month is always up to date: every day to yesterday, and today once an
// outlet closes the day. The file is made on the phone when it is downloaded.
import { useEffect, useState } from 'react';
import { rpc } from '../lib/api';
import { dlabel } from '../lib/format';
import type { MonthBook } from '../lib/monthBook';
import type { Dashboard } from '../lib/types';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { Card, SkelList } from '../ui/widgets';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const label = (m: string) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
/** Months from the first record to this one, newest first. */
export function monthsFrom(first: string, today: string): string[] {
  const out: string[] = [];
  let y = +first.slice(0, 4), m = +first.slice(5, 7);
  const ty = +today.slice(0, 4), tm = +today.slice(5, 7);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}-01`); m++; if (m > 12) { m = 1; y++; } }
  return out.reverse().slice(0, 24);
}

export function MonthBooks({ D }: { D: Dashboard }) {
  const ui = useUI();
  const [first, setFirst] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    rpc<MonthBook>('rpc_month_book', { p_month: null }).then((b) => setFirst(b.first_month)).catch(() => setFirst(D.today.slice(0, 8) + '01'));
  }, [D.today]);
  const get = async (m: string) => {
    setBusy(m);
    try {
      const [book, mod] = await Promise.all([rpc<MonthBook>('rpc_month_book', { p_month: m }), import('../lib/monthBook')]);
      // the van has no counts; its tab says what was left on board instead
      book.locations = book.locations.map((l) => ({ ...l, kind: D.locations.find((x) => x.id === l.id)?.kind }));
      const { bytes, filename } = mod.buildMonthBook(book);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      ui.toast(`${label(m)} downloaded.`);
    } catch (e) { ui.toast((e as Error).message); } finally { setBusy(null); }
  };
  const thisMonth = D.today.slice(0, 8) + '01';
  const yest = new Date(`${D.today}T00:00:00Z`); yest.setUTCDate(yest.getUTCDate() - 1);
  return <Card title="Monthly workbooks">
    <p className="muted" style={{ margin: '0 0 10px', fontSize: 13.5 }}>The Daily Outlet Report for every outlet, one row a day, filled in from what the outlets entered. Stock, sales by payment mode, credit and the balance checks. A Store ledger tab follows the inventory clerk's ledger for the raw materials, and a Feed tab shows feed milled, bought and given to each house. The current month fills in as the outlets close each day.</p>
    {first === null ? <SkelList n={2} /> : <div className="list">{monthsFrom(first, D.today).map((m) => (
      <div className="li" key={m}>
        <span className="av" style={{ background: 'var(--l-farm)' }}><Icon name="list" /></span>
        <div className="mid"><b>{label(m)}</b><small>{m === thisMonth
          ? (D.today.slice(8) === '01' ? 'Today fills in at day close' : `Up to ${dlabel(yest.toISOString().slice(0, 10))}, and today once each outlet closes`)
          : 'Complete month'}</small></div>
        <div className="end"><button className="act" disabled={busy !== null} onClick={() => get(m)}>{busy === m ? 'Preparing…' : 'Download'}</button></div>
      </div>))}</div>}
  </Card>;
}
