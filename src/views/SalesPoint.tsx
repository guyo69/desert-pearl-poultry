// Farm counter, van and shop screens. Each person sees only their own location.
import { addDays, dlabel, eggs, kes, n0, range, timeOf } from '../lib/format';
import { alertsFor, balance, cashDay, dayLedger, salesOn, stockNow, tot } from '../lib/metrics';
import type { Q } from '../lib/types';
import { breakageForm, cashCountForm, countForm, dispatchForm, expenseForm, moveForm, receiveForm, saleForm } from '../forms/forms';
import { ChartBox } from '../ui/Chart';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { AlertList, Card, Empty, Kpi, Legend, Tile } from '../ui/widgets';
import { payChart } from './charts';
import { RecordList } from './common';
import type { ViewProps } from './Management';

const myLoc = (p: ViewProps) => p.D.me.location_id!;

export function PosToday(p: ViewProps) {
  const { D } = p, ui = useUI(), loc = myLoc(p), st = stockNow(D, loc), s = salesOn(D, [D.today], loc);
  const it = D.transit.filter((x) => x.to_loc === loc);
  const opened = D.counts_today.some((c) => c.location_id === loc && c.kind === 'open');
  const closed = D.counts_today.some((c) => c.location_id === loc && c.kind === 'close');
  const A = alertsFor(D).filter((a) => !a.loc || a.loc === loc);
  const bar = (k: 'cash' | 'till' | 'paybill', c: string) => (s.value ? <span style={{ width: `${(s[k] / s.value) * 100}%`, background: `var(${c})` }} /> : null);
  return <>
    {!opened && <div className="banner warn"><div><b>Start the day</b><p>Count the eggs on hand before selling.</p></div><button className="btn yolk" onClick={() => ui.openForm(countForm(D, loc, 'open'))}><Icon name="count" />Opening count</button></div>}
    {it.map((x) => <div className="banner info" key={x.id}><div><b>Delivery on the way from {D.locations.find((l) => l.id === x.from_loc)?.short}</b>
      <p>{eggs(x.sent_n)} normal{x.sent_c ? ` · ${x.sent_c} cracked` : ''}{x.sent_j ? ` · ${x.sent_j} jumbo` : ''} · sent {timeOf(x.recorded_at)}</p></div>
      <button className="btn" onClick={() => ui.openForm(receiveForm(D, x))}><Icon name="inbox" />Receive</button></div>)}
    <div className="kpis">
      <Kpi label="Sales today" value={kes(s.value)} sub={`${s.cnt} sale${s.cnt === 1 ? '' : 's'}`} />
      <Kpi label="Eggs sold" value={eggs(s.pcs)} />
      <Kpi label="On hand" value={eggs(tot(st))} sub={`${eggs(st.n)} normal`} />
      <Kpi label="Cash in drawer" value={kes(balance(D, `CASH:${loc}`))} sub="expected" />
    </div>
    <Card title="How customers paid" aside={<span className="muted">{kes(s.value)}</span>}>
      <div className="splitbar">{bar('cash', '--l-farm')}{bar('till', '--l-tuala')}{bar('paybill', '--l-van')}</div>
      <Legend items={[['--l-farm', `Cash ${n0(s.cash)}`], ['--l-tuala', `Till ${n0(s.till)}`], ['--l-van', `Paybill ${n0(s.paybill)}`]]} /></Card>
    <div className="tiles">
      <Tile icon="receipt" label="Record sale" color="--l-farm" onClick={() => ui.openForm(saleForm(D, loc))} />
      <Tile icon="inbox" label="Receive stock" color="--info" onClick={() => it[0] ? ui.openForm(receiveForm(D, it[0])) : ui.toast('No deliveries waiting for you.')} />
      <Tile icon="crack" label="Breakage" color="--f-none" onClick={() => ui.openForm(breakageForm(D, loc))} />
      <Tile icon="wallet" label="Expense" color="--l-lucky" onClick={() => ui.openForm(expenseForm(D, loc, false))} />
      <Tile icon="swap" label="Move money" color="--l-rayan" onClick={() => ui.openForm(moveForm(D, loc))} />
      <Tile icon="count" label={closed ? 'Closed ✓' : 'Close the day'} color="--l-van" onClick={() => ui.openForm(countForm(D, loc, 'close'))} />
      {loc === 'VAN' && <Tile icon="truck" label="Deliver to shop" color="--l-tuala" onClick={() => ui.openForm(dispatchForm(D, loc))} />}
    </div>
    {A.length > 0 && <Card title="For your attention"><AlertList list={A} /></Card>}
  </>;
}

export function PosStock(p: ViewProps) {
  const { D } = p, ui = useUI(), loc = myLoc(p), L = dayLedger(D, loc, D.today);
  const row = (label: string, q: Q, sign = '') => <tr><td>{label}</td>{(['n', 'c', 'j'] as const).map((k) => <td key={k}>{q[k] ? `${sign}${k === 'n' ? eggs(q[k]) : `${q[k]} pc`}` : '–'}</td>)}</tr>;
  return <>
    <Card title="Today's stock sheet" aside={<span className="muted">{D.locations.find((l) => l.id === loc)?.name}</span>}>
      <div className="tblw"><table><thead><tr><th></th><th>Normal</th><th>Cracked</th><th>Jumbo</th></tr></thead>
        <tbody>{row('Opening', L.open)}{loc === 'FARM' && row('+ Collected', L.coll, '+')}{row('+ Received', L.recv, '+')}{row('− Sent out', L.out, '−')}{row('− Sold', L.sold, '−')}{row('− Broken', L.brk, '−')}{row('± Count variance', L.adj)}</tbody>
        <tfoot>{row('On hand (expected)', L.close)}</tfoot></table></div>
      <div className="row-btns" style={{ marginTop: 12 }}><button className="btn sm alt" onClick={() => ui.openForm(countForm(D, loc, 'open'))}><Icon name="count" />Opening count</button>
        <button className="btn sm" onClick={() => ui.openForm(countForm(D, loc, 'close'))}><Icon name="count" />Close the day</button>
        {loc !== 'FARM' && <button className="btn sm alt" onClick={() => ui.openForm(dispatchForm(D, loc))}><Icon name="truck" />Send eggs</button>}</div></Card>
    <Card title="Last 7 days" aside={<span className="muted">pieces</span>}><div className="tblw"><table>
      <thead><tr><th>Day</th><th>Opening</th><th>In</th><th>Sold</th><th>Broken</th><th>Closing</th></tr></thead>
      <tbody>{range(addDays(D.today, -6), D.today).reverse().map((d) => { const x = dayLedger(D, loc, d);
        return <tr key={d}><td>{dlabel(d)}</td><td>{n0(tot(x.open))}</td><td>{n0(tot(x.recv) + tot(x.coll))}</td><td>{n0(tot(x.sold))}</td><td>{tot(x.brk) || '–'}</td><td>{n0(tot(x.close))}</td></tr>; })}</tbody></table></div></Card>
  </>;
}

export function PosSales(p: ViewProps) {
  const { D, version } = p, ui = useUI(), loc = myLoc(p);
  return <>
    <Card title="Sales, last 14 days" aside={<span className="muted">KES by payment method</span>}><ChartBox label="Sales by payment method" config={payChart(D, 13, loc)} />
      <Legend items={[['--l-farm', 'Cash'], ['--l-tuala', 'Till'], ['--l-van', 'Paybill']]} /></Card>
    <Card title="Recent sales" aside={<button className="lnk" onClick={() => ui.openForm(saleForm(D, loc))}>New sale</button>}>
      <RecordList D={D} version={version} loc={loc} kinds={['sale']} canVoid={false} limit={25} /></Card>
  </>;
}

export function PosMoney(p: ViewProps) {
  const { D, version } = p, ui = useUI(), loc = myLoc(p), acc = `CASH:${loc}`, c = cashDay(D, acc, D.today), s = salesOn(D, [D.today], loc);
  const match = s.value === s.cash + s.till + s.paybill;
  const counted = D.cash_counts_today.filter((x) => x.location_id === loc).pop();
  return <>
    <Card title="Cash drawer today" aside={<span className="muted">{D.locations.find((l) => l.id === loc)?.name}</span>}>
      <div className="recon">
        <div><span>Opening cash</span><span>{kes(c.open)}</span></div>
        <div><span>+ Cash sales</span><span>{kes(c.sales)}</span></div>
        <div><span>+ Money moved in (e.g. Paybill withdrawn to cash)</span><span>{kes(c.moveIn)}</span></div>
        <div><span>− Money moved out (banked, sent to Paybill)</span><span>{kes(-c.moveOut)}</span></div>
        <div><span>− Charges</span><span>{kes(-c.fees)}</span></div>
        <div><span>− Expenses paid in cash</span><span>{kes(-c.expenses)}</span></div>
        {(c.variance !== 0 || c.opening !== 0) && <div><span>± Count variance / opening balance</span><span>{kes(c.variance + c.opening)}</span></div>}
        <div className="tot"><span>Expected cash in drawer</span><span>{kes(balance(D, acc))}</span></div>
      </div>
      {counted && <div className={`ok-line ${counted.diff ? 'sev-orange' : 'sev-ok'}`}><Icon name={counted.diff ? 'alert' : 'check'} />Counted {kes(counted.counted)} at {timeOf(counted.recorded_at)}{counted.diff ? ` · ${counted.diff < 0 ? 'short' : 'over'} ${kes(Math.abs(counted.diff))}` : ' · matched'}</div>}
      <div className="row-btns" style={{ marginTop: 14 }}><button className="btn sm" onClick={() => ui.openForm(cashCountForm(D, loc))}><Icon name="cash" />Count cash</button>
        <button className="btn sm alt" onClick={() => ui.openForm(moveForm(D, loc))}><Icon name="swap" />Move money</button>
        <button className="btn sm alt" onClick={() => ui.openForm(expenseForm(D, loc, false))}><Icon name="wallet" />Expense</button></div></Card>
    <Card title="Sales vs payments">
      <div className="recon"><div><span>Egg sales today</span><span>{kes(s.value)}</span></div><div><span>Cash</span><span>{kes(s.cash)}</span></div>
        <div><span>M-Pesa Till</span><span>{kes(s.till)}</span></div><div><span>M-Pesa Paybill</span><span>{kes(s.paybill)}</span></div>
        <div className="tot"><span>Total received</span><span>{kes(s.cash + s.till + s.paybill)}</span></div></div>
      <div className={`ok-line ${match ? 'sev-ok' : 'sev-red'}`}><Icon name={match ? 'check' : 'alert'} />{match ? 'Every sale is fully paid and allocated.' : 'Payments do not match sales.'}</div></Card>
    <Card title="Money records"><RecordList D={D} version={version} loc={loc} kinds={['money', 'cash']} canVoid={false} limit={25} /></Card>
    {s.cnt === 0 && c.moveIn === 0 && c.moveOut === 0 && <Empty>No money activity yet today.</Empty>}
  </>;
}
