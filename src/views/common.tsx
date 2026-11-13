// Pieces shared by several screens: activity rows, the record list, notices.
import { useEffect, useState } from 'react';
import { loadActivity } from '../lib/api';
import { dlabel, eggs, kes, n0, timeOf } from '../lib/format';
import { ITEM_NAME, accName, canEnter, locName, locShort, mix } from '../lib/metrics';
import type { ActivityRow, Dashboard } from '../lib/types';
import { creditPaidForm, voidForm } from '../forms/forms';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { Card, Empty, SkelList, sevVar } from '../ui/widgets';

const META: Record<ActivityRow['kind'], { icon: string; col: string }> = {
  collect: { icon: 'egg', col: '--l-van' }, feed: { icon: 'sack', col: '--f-low' }, water: { icon: 'drop', col: '--info' },
  med: { icon: 'syringe', col: '--l-rayan' }, mort: { icon: 'bird', col: '--muted' }, xfer: { icon: 'truck', col: '--l-tuala' },
  sale: { icon: 'receipt', col: '--l-farm' }, brk: { icon: 'crack', col: '--f-none' }, count: { icon: 'count', col: '--l-rayan' },
  money: { icon: 'swap', col: '--l-lucky' }, cash: { icon: 'cash', col: '--l-lucky' }, issue: { icon: 'truck', col: '--l-lucky' },
  credit: { icon: 'wallet', col: '--l-farm' }, supply: { icon: 'box', col: '--l-tuala' }, confirm: { icon: 'check', col: '--f-full' },
  raw: { icon: 'sack', col: '--info' }, mill: { icon: 'scoop', col: '--f-full' },
  flock: { icon: 'bird', col: '--l-van' },
};
const PAID_BY: Record<string, string> = { cash: 'Cash', till: 'M-Pesa Till', paybill: 'M-Pesa Paybill' };
const q = (x: any, p = '') => ({ n: +x[`${p}n`] || 0, b: +x[`${p}b`] || 0, c: +x[`${p}c`] || 0, j: +x[`${p}j`] || 0 });
const t4 = (v: { n: number; b: number; c: number; j: number }) => v.n + v.b + v.c + v.j;

export function describe(D: Dashboard, r: ActivityRow): { title: string; sub: string; end: string } {
  const x = r.data, house = (id: string) => D.houses.find((h) => h.id === id)?.name ?? id;
  switch (r.kind) {
    case 'collect': return { title: `${house(x.house_id)} collection`, sub: `${mix(q(x))}${+x.dmg ? ` · ${x.dmg} damaged` : ''}`, end: eggs(t4(q(x)) + (+x.dmg || 0)) };
    case 'mort': return { title: `Deaths · ${house(x.house_id)}`, sub: x.cause, end: `${x.birds} bird${x.birds > 1 ? 's' : ''}` };
    case 'feed': return x.kind === 'in' ? { title: `Feed received${x.bags ? ` · ${x.bags} bags` : ''}`, sub: x.cost ? kes(x.cost) : '', end: `+${n0(x.kg)} kg` }
      : x.kind === 'use' ? { title: x.need_confirm ? `Feed issued to ${x.house}` : `Feed used · ${x.note ?? ''}`, sub: x.need_confirm ? `From the store · ${x.note ?? ''}` : x.house ?? '', end: `−${n0(x.kg)} kg` }
      : { title: 'Feed store adjusted', sub: x.note ?? '', end: `${x.kg > 0 ? '+' : ''}${n0(x.kg)} kg` };
    case 'water': return x.kind === 'tank' ? { title: 'Tank level reading', sub: x.note ?? '', end: `${n0(x.litres)} L` }
      : { title: `Water drunk · ${house(x.house_id)}`, sub: x.note ?? '', end: `${n0(x.litres)} L` };
    case 'med': return { title: x.medicine, sub: `${x.kind === 'in' ? 'Received' : x.kind === 'use' ? 'Used' : 'Adjusted'}${x.house ? ` · ${x.house}` : ''}${x.note ? ` · ${x.note}` : ''}`, end: `${x.kind === 'use' ? '−' : '+'}${n0(Math.abs(x.qty))} ${x.unit}` };
    case 'xfer': return { title: `${locShort(D, x.from_loc)} → ${locShort(D, x.to_loc)}`,
      sub: x.status === 'received' ? `Received ${timeOf(x.received_at)}${t4(q(x, 'recv_')) < t4(q(x, 'sent_')) ? ` · ${eggs(t4(q(x, 'sent_')) - t4(q(x, 'recv_')))} short${+x.recv_dmg ? ` (${x.recv_dmg} damaged)` : ''}` : ''}` : `In transit · ${mix(q(x, 'sent_'))}`,
      end: eggs(t4(q(x, 'sent_'))) };
    case 'issue': return { title: `${x.kind === 'out' ? 'Given away to' : 'Taken in from'} ${x.party ?? 'outside'}`, sub: `${locShort(D, x.location_id)} · ${mix(q(x))}${x.note ? ` · ${x.note}` : ''}`, end: `${x.kind === 'out' ? '−' : '+'}${eggs(t4(q(x)))}` };
    case 'sale': return { title: `${x.imported ? 'Sales (paper book)' : 'Sale'} · ${eggs(t4(q(x)))}`, sub: `${locShort(D, x.location_id)} · ${[['cash', 'Cash'], ['till', 'Till'], ['paybill', 'Paybill'], ['credit', 'Credit']].filter(([k]) => +x[k]).map(([k, l]) => `${l} ${n0(+x[k])}`).join(' + ')}${x.customer ? ` · ${x.customer}` : ''}${x.list_value != null && +x.list_value !== +x.value ? ` · list ${n0(+x.list_value)}` : ''}`, end: kes(+x.value) };
    case 'brk': return { title: x.reason, sub: `${locShort(D, x.location_id)} · ${ITEM_NAME[x.item as 'N'] ?? x.item}`, end: `−${x.qty} pc` };
    case 'count': { const adj = t4(q(x, 'adj_')); return { title: `${x.kind === 'open' ? 'Opening count' : x.kind === 'close' ? 'Closing count' : 'Opening balance'} · ${locShort(D, x.location_id)}`, sub: adj ? `Variance ${eggs(adj)}` : 'Matched book stock', end: eggs(t4(q(x, 'cnt_'))) }; }
    case 'money': return x.kind === 'expense' ? { title: `Expense · ${x.category ?? ''}`, sub: `${accName(D, x.from_acc)}${x.note ? ` · ${x.note}` : ''}`, end: `−${kes(+x.amount)}` }
      : x.kind === 'move' ? { title: x.note ?? 'Money moved', sub: `${accName(D, x.from_acc)} → ${accName(D, x.to_acc)}${+x.fee ? ` · charges ${n0(+x.fee)}` : ''}${x.ref ? ` · ${x.ref}` : ''}`, end: kes(+x.amount) }
      : { title: x.kind === 'opening' ? 'Opening balance' : 'Cash count variance', sub: accName(D, x.to_acc), end: kes(+x.amount) };
    case 'cash': return { title: `Cash count · ${locShort(D, x.location_id)}`, sub: `Expected ${kes(+x.expected)}`, end: +x.diff ? kes(+x.diff) : 'Matched' };
    case 'credit': return { title: `Credit paid · ${x.customer}`, sub: `${locShort(D, x.location_id)} · ${PAID_BY[x.method] ?? x.method}${x.note ? ` · ${x.note}` : ''}`, end: kes(+x.amount) };
    case 'supply': return x.kind === 'in' ? { title: `${x.item} received`, sub: x.note ?? 'Into the store', end: `+${n0(+x.qty)} ${x.unit}` }
      : { title: `${x.item} issued`, sub: `${x.purpose ?? ''}${x.note ? ` · ${x.note}` : ''}`, end: `−${n0(+x.qty)} ${x.unit}` };
    case 'confirm': return { title: `${x.house ?? 'House'} received ${x.what === 'feed' ? 'feed' : x.what ?? ''}`,
      sub: +x.received < +x.issued ? `${n0(+x.issued - +x.received)} ${x.unit ?? ''} short of what the store issued${x.note ? ` · ${x.note}` : ''}` : 'All of it arrived',
      end: `${n0(+x.received)} of ${n0(+x.issued)} ${x.unit ?? ''}` };
    case 'flock': return { title: `New flock in ${x.house}${x.breed ? ` · ${x.breed}` : ''}`,
      sub: `${+x.age_weeks} weeks old when placed · expected lay ${Math.round(+x.expected_lay * 100)}%${x.ended_on ? ` · left ${dlabel(x.ended_on)}${x.end_note ? ` (${x.end_note})` : ''}` : ''}${x.note ? ` · ${x.note}` : ''}`,
      end: `${n0(+x.hens)} hens` };
    case 'mill': return { title: `Feed milled · ${+x.tonnes} tonne${+x.tonnes === 1 ? '' : 's'}`,
      sub: `${x.bags != null ? `${n0(+x.bags)} bags into the feed store` : 'Into the feed store'}${x.note ? ` · ${x.note}` : ''}`, end: `+${n0(+x.tonnes * 1000)} kg` };
    case 'raw': return x.kind === 'count'
      ? { title: `${x.material} counted`, sub: `${Math.abs(+x.kg) < 0.5 ? 'Matched the book' : `${+x.kg > 0 ? '+' : '−'}${n0(Math.abs(+x.kg))} kg against the book`}${x.note ? ` · ${x.note}` : ''}`, end: `${n0(+x.counted)} kg` }
      : { title: `${x.material} received`, sub: `${n0(+x.kg / (+x.bag_kg || 50))} bags${x.note ? ` · ${x.note}` : ''}`, end: `+${n0(+x.kg)} kg` };
    default: return { title: 'Record', sub: '', end: '' };
  }
}

/** The Nairobi day a record was entered on (UTC+3, no daylight saving). */
const enteredOn = (r: ActivityRow) => new Date(new Date(r.recorded_at).getTime() + 3 * 3600e3).toISOString().slice(0, 10);

export function RecordRow({ D, r, canVoid }: { D: Dashboard; r: ActivityRow; canVoid: boolean }) {
  const ui = useUI(), m = META[r.kind] ?? META.money, t = describe(D, r);
  const voidable = canVoid && !r.voided && !(r.kind === 'money' && r.data.kind === 'variance') && !(r.kind === 'brk' && r.data.transit);
  return (
    <div className={`li${r.voided ? ' void' : ''}`}>
      <span className="av" style={{ background: `var(${m.col})` }}><Icon name={m.icon} /></span>
      <div className="mid"><b>{t.title}</b>{t.sub && <small>{t.sub}</small>}<small>{enteredOn(r) === r.d ? `${dlabel(r.d)} · ${timeOf(r.recorded_at)}` : `For ${dlabel(r.d)} · entered ${dlabel(enteredOn(r))} ${timeOf(r.recorded_at)}`} · {r.by_name ?? 'System'}{r.voided ? ` · corrected: ${r.data.void_reason}` : ''}</small></div>
      <div className="end">{t.end}{voidable && <div><button className="act" onClick={() => ui.openForm(voidForm(r.kind, r.id, `${t.title} · ${t.end}`))}>Correct</button></div>}</div>
    </div>
  );
}

/** Paged list of records, newest day first (the day a record is for, not when it was entered). Reloads when `version` changes. */
export function RecordList({ D, version, loc, kinds, canVoid, limit = 30 }: { D: Dashboard; version: number; loc?: string | null; kinds?: string[]; canVoid: boolean; limit?: number }) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [err, setErr] = useState('');
  const [more, setMore] = useState(true);
  const kind = kinds?.length === 1 ? kinds[0] : null;
  useEffect(() => {
    let live = true;
    loadActivity({ limit, loc: loc ?? null, kind }).then((r) => { if (live) { setRows(r); setMore(r.length === limit); } }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [version, loc, kind, limit]);
  const loadMore = async () => {
    if (!rows?.length) return;
    const r = await loadActivity({ limit, loc: loc ?? null, kind, after: rows[rows.length - 1] });
    setRows([...rows, ...r]); setMore(r.length === limit);
  };
  if (err) return <Empty>{err}</Empty>;
  if (!rows) return <SkelList n={Math.min(limit, 5)} />;
  const shown = kinds && kinds.length > 1 ? rows.filter((r) => kinds.includes(r.kind)) : rows;
  if (!shown.length) return <Empty icon="list">Nothing recorded here yet. What you save shows up here straight away, newest first.</Empty>;
  const out: React.ReactNode[] = [];
  shown.forEach((r, i) => {
    if (i === 0 || shown[i - 1].d !== r.d) out.push(<div key={`d${r.d}`} className="day-head">{r.d === D.today ? 'Today' : dlabel(r.d)}</div>);
    out.push(<RecordRow key={`${r.kind}${r.id}`} D={D} r={r} canVoid={canVoid} />);
  });
  return <div className="list">{out}
    {more && <button className="btn sm alt more-btn" style={{ marginTop: 10 }} onClick={loadMore}>Show older</button>}</div>;
}

/** Who still owes money for eggs bought on credit, with a button to record a payment. */
export function OutstandingCredits({ D, loc, limit = 6 }: { D: Dashboard; loc?: string | null; limit?: number }) {
  const ui = useUI(), [all, setAll] = useState(false);
  const list = (D.credits ?? []).filter((c) => !loc || c.location_id === loc);
  const total = list.reduce((a, c) => a + Number(c.owed), 0);
  const can = canEnter(D) && (D.me.role === 'manager' || D.me.role === 'pos');
  const shown = all ? list : list.slice(0, limit);
  return <Card title="Outstanding credits" aside={<span className="muted">{list.length ? `${kes(total)} owed` : ''}</span>}>
    {list.length ? <div className="list">{shown.map((c) => {
      const days = Math.round((Date.parse(D.today) - Date.parse(c.since)) / 864e5);
      return <div className="li" key={`${c.location_id}|${c.customer}`}>
        <span className="av" style={{ background: 'var(--l-lucky)' }}><Icon name="wallet" /></span>
        <div className="mid"><b>{c.customer}</b><small>{loc ? '' : `${locName(D, c.location_id)} · `}{c.sales} sale{c.sales === 1 ? '' : 's'} since {dlabel(c.since)}{days > 0 ? ` (${days} day${days === 1 ? '' : 's'})` : ''}{c.last_paid ? ` · last paid ${dlabel(c.last_paid)}` : ''}</small></div>
        <div className="end">{kes(Number(c.owed))}{can && <div><button className="act" onClick={() => ui.openForm(creditPaidForm(D, loc ?? null, c))}>Record payment</button></div>}</div>
      </div>; })}
      {list.length > limit && <button className="btn sm alt more-btn" style={{ marginTop: 10 }} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${list.length}`}</button>}
    </div> : <Empty icon="wallet">No one owes anything{loc ? ' at this outlet' : ''}. A sale paid with Credit shows here with the customer's name until it is paid.</Empty>}
  </Card>;
}

export function NoticeList({ D }: { D: Dashboard }) {
  if (!D.notifications.length) return <Empty icon="bell">No reminders in the last 14 days. Reminders come only when something is still to do.</Empty>;
  return <div className="alerts">{D.notifications.slice(0, 20).map((n) => (
    <div className="alert" key={n.id} style={n.read ? { opacity: 0.7 } : undefined}><span className="stripe" style={{ background: sevVar(n.sev) }} />
      <div style={{ minWidth: 0 }}><b>{n.title}</b><p>{n.body}{n.body ? ' · ' : ''}{dlabel(n.created_at.slice(0, 10))} {timeOf(n.created_at)}</p></div></div>))}</div>;
}
