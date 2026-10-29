// Pieces shared by several screens: activity rows, the record list, notices.
import { useEffect, useState } from 'react';
import { loadActivity } from '../lib/api';
import { dlabel, eggs, kes, n0, timeOf } from '../lib/format';
import { accName, locShort } from '../lib/metrics';
import type { ActivityRow, Dashboard } from '../lib/types';
import { voidForm } from '../forms/forms';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { Empty, sevVar } from '../ui/widgets';

const META: Record<ActivityRow['kind'], { icon: string; col: string }> = {
  collect: { icon: 'egg', col: '--l-van' }, feed: { icon: 'sack', col: '--f-low' }, water: { icon: 'drop', col: '--info' },
  med: { icon: 'syringe', col: '--l-rayan' }, mort: { icon: 'bird', col: '--muted' }, xfer: { icon: 'truck', col: '--l-tuala' },
  sale: { icon: 'receipt', col: '--l-farm' }, brk: { icon: 'crack', col: '--f-none' }, count: { icon: 'count', col: '--l-rayan' },
  money: { icon: 'swap', col: '--l-lucky' }, cash: { icon: 'cash', col: '--l-lucky' },
};

export function describe(D: Dashboard, r: ActivityRow): { title: string; sub: string; end: string } {
  const x = r.data, house = (id: string) => D.houses.find((h) => h.id === id)?.name ?? id;
  switch (r.kind) {
    case 'collect': return { title: `${house(x.house_id)} collection`, sub: `${eggs(x.n)} normal · ${x.c} cracked · ${x.j} jumbo`, end: eggs(x.n + x.c + x.j) };
    case 'mort': return { title: `Mortality · ${house(x.house_id)}`, sub: x.cause, end: `${x.birds} bird${x.birds > 1 ? 's' : ''}` };
    case 'feed': return x.kind === 'in' ? { title: `Feed received${x.bags ? ` · ${x.bags} bags` : ''}`, sub: x.cost ? kes(x.cost) : '', end: `+${n0(x.kg)} kg` }
      : x.kind === 'use' ? { title: `Feed used · ${x.note ?? ''}`, sub: x.house ?? '', end: `−${n0(x.kg)} kg` }
      : { title: 'Feed store adjusted', sub: x.note ?? '', end: `${x.kg > 0 ? '+' : ''}${n0(x.kg)} kg` };
    case 'water': return x.kind === 'tank' ? { title: 'Tank level reading', sub: x.note ?? '', end: `${n0(x.litres)} L` }
      : { title: `Water drunk · ${house(x.house_id)}`, sub: x.note ?? '', end: `${n0(x.litres)} L` };
    case 'med': return { title: x.medicine, sub: `${x.kind === 'in' ? 'Received' : x.kind === 'use' ? 'Used' : 'Adjusted'}${x.house ? ` · ${x.house}` : ''}${x.note ? ` · ${x.note}` : ''}`, end: `${x.kind === 'use' ? '−' : '+'}${n0(Math.abs(x.qty))} ${x.unit}` };
    case 'xfer': return { title: `${locShort(D, x.from_loc)} → ${locShort(D, x.to_loc)}`,
      sub: x.status === 'received' ? `Received ${timeOf(x.received_at)}${x.recv_n + x.recv_c + x.recv_j < x.sent_n + x.sent_c + x.sent_j ? ` · ${eggs(x.sent_n + x.sent_c + x.sent_j - x.recv_n - x.recv_c - x.recv_j)} short` : ''}` : 'In transit',
      end: eggs(x.sent_n + x.sent_c + x.sent_j) };
    case 'sale': return { title: `Sale · ${eggs(x.n + x.c + x.j)}`, sub: `${locShort(D, x.location_id)} · ${[['cash', 'Cash'], ['till', 'Till'], ['paybill', 'Paybill']].filter(([k]) => +x[k]).map(([k, l]) => `${l} ${n0(+x[k])}`).join(' + ')}${x.customer ? ` · ${x.customer}` : ''}`, end: kes(+x.value) };
    case 'brk': return { title: x.reason, sub: `${locShort(D, x.location_id)} · ${x.item === 'N' ? 'Normal' : x.item === 'C' ? 'Cracked' : 'Jumbo'} eggs`, end: `−${x.qty} pc` };
    case 'count': { const adj = x.adj_n + x.adj_c + x.adj_j; return { title: `${x.kind === 'open' ? 'Opening count' : x.kind === 'close' ? 'Closing count' : 'Opening balance'} · ${locShort(D, x.location_id)}`, sub: adj ? `Variance ${eggs(adj)}` : 'Matched book stock', end: eggs(x.cnt_n + x.cnt_c + x.cnt_j) }; }
    case 'money': return x.kind === 'expense' ? { title: `Expense · ${x.category ?? ''}`, sub: `${accName(D, x.from_acc)}${x.note ? ` · ${x.note}` : ''}`, end: `−${kes(+x.amount)}` }
      : x.kind === 'move' ? { title: x.note ?? 'Money moved', sub: `${accName(D, x.from_acc)} → ${accName(D, x.to_acc)}${+x.fee ? ` · charges ${n0(+x.fee)}` : ''}${x.ref ? ` · ${x.ref}` : ''}`, end: kes(+x.amount) }
      : { title: x.kind === 'opening' ? 'Opening balance' : 'Cash count variance', sub: accName(D, x.to_acc), end: kes(+x.amount) };
    case 'cash': return { title: `Cash count · ${locShort(D, x.location_id)}`, sub: `Expected ${kes(+x.expected)}`, end: +x.diff ? kes(+x.diff) : 'Matched' };
  }
}

export function RecordRow({ D, r, canVoid }: { D: Dashboard; r: ActivityRow; canVoid: boolean }) {
  const ui = useUI(), m = META[r.kind], t = describe(D, r);
  const voidable = canVoid && !r.voided && !(r.kind === 'money' && r.data.kind === 'variance') && !(r.kind === 'brk' && r.data.transit);
  return (
    <div className={`li${r.voided ? ' void' : ''}`}>
      <span className="av" style={{ background: `var(${m.col})` }}><Icon name={m.icon} /></span>
      <div className="mid"><b>{t.title}</b>{t.sub && <small>{t.sub}</small>}<small>{dlabel(r.d)} · {timeOf(r.recorded_at)} · {r.by_name ?? 'System'}{r.voided ? ` · corrected: ${r.data.void_reason}` : ''}</small></div>
      <div className="end">{t.end}{voidable && <div><button className="act" onClick={() => ui.openForm(voidForm(r.kind, r.id, `${t.title} · ${t.end}`))}>Correct</button></div>}</div>
    </div>
  );
}

/** Paged list of records, newest first. Reloads when `version` changes. */
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
    const r = await loadActivity({ limit, loc: loc ?? null, kind, before: rows[rows.length - 1].recorded_at });
    setRows([...rows, ...r]); setMore(r.length === limit);
  };
  if (err) return <Empty>{err}</Empty>;
  if (!rows) return <div className="center" style={{ minHeight: 120 }}><div className="spinner" /></div>;
  const shown = kinds && kinds.length > 1 ? rows.filter((r) => kinds.includes(r.kind)) : rows;
  if (!shown.length) return <Empty>Nothing recorded yet.</Empty>;
  return <div className="list">{shown.map((r) => <RecordRow key={`${r.kind}${r.id}`} D={D} r={r} canVoid={canVoid} />)}
    {more && <button className="btn sm alt more-btn" style={{ marginTop: 10 }} onClick={loadMore}>Show older</button>}</div>;
}

export function NoticeList({ D }: { D: Dashboard }) {
  if (!D.notifications.length) return <Empty>No notifications in the last 14 days.</Empty>;
  return <div className="alerts">{D.notifications.slice(0, 20).map((n) => (
    <div className="alert" key={n.id} style={n.read ? { opacity: 0.7 } : undefined}><span className="stripe" style={{ background: sevVar(n.sev) }} />
      <div style={{ minWidth: 0 }}><b>{n.title}</b><p>{n.body}{n.body ? ' · ' : ''}{dlabel(n.created_at.slice(0, 10))} {timeOf(n.created_at)}</p></div></div>))}</div>;
}
