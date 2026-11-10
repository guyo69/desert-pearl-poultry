// Farm counter, van and shop screens. Each person sees only their own location.
import { addDays, dlabel, eggs, kes, n0, range, timeOf } from '../lib/format';
import { alertsFor, balance, cashDay, dayLedger, isVan, mix, salesOn, stockNow, tot } from '../lib/metrics';
import type { Q } from '../lib/types';
import { breakageForm, cashCountForm, countForm, creditPaidForm, dispatchForm, expenseForm, issueForm, moveForm, receiveForm, saleForm, shopDayForm } from '../forms/forms';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { AlertList, Card, Empty, Kpi, Legend, Tile } from '../ui/widgets';
import { PayChart } from './charts';
import { OutstandingCredits, RecordList } from './common';
import { ShopSteps, VanSteps } from './Journey';
import type { ViewProps } from './Management';

const myLoc = (p: ViewProps) => p.D.me.location_id!;

export function PosToday(p: ViewProps) {
  return isVan(p.D, myLoc(p)) ? <VanToday {...p} /> : <OutletToday {...p} />;
}

/** The mobile van: what is on board, deliveries, road sales, and ending the day empty. */
function VanToday(p: ViewProps) {
  const { D } = p, ui = useUI(), loc = myLoc(p), st = stockNow(D, loc), s = salesOn(D, [D.today], loc);
  const it = D.transit.filter((x) => x.to_loc === loc), left = Math.max(0, tot(st));
  const out = D.transit.filter((x) => x.from_loc === loc);
  const A = alertsFor(D).filter((a) => !a.loc || a.loc === loc);
  return <>
    <VanSteps D={D} loc={loc} />
    {it.map((x) => <div className="banner info" key={x.id}><div><b>Load waiting at {D.locations.find((l) => l.id === x.from_loc)?.short}</b>
      <p>{mix({ n: x.sent_n, b: x.sent_b ?? 0, c: x.sent_c, j: x.sent_j })} · sent {timeOf(x.recorded_at)}</p></div>
      <button className="btn" onClick={() => ui.openForm(receiveForm(D, x))}><Icon name="inbox" />Receive</button></div>)}
    <div className="kpis">
      <Kpi label="On board now" value={eggs(left)} sub={left ? mix(st) : 'Van is empty'} />
      <Kpi label="Sold on the road" value={kes(s.value)} sub={`${s.cnt} sale${s.cnt === 1 ? '' : 's'}`} />
      <Kpi label="Delivered, not yet confirmed" value={String(out.length)} sub={out.length ? out.map((x) => D.locations.find((l) => l.id === x.to_loc)?.short).join(', ') : 'All confirmed'} />
      <Kpi label="Cash with the driver" value={kes(balance(D, `CASH:${loc}`))} sub="bank it or send it" />
    </div>
    <div className="tiles">
      <Tile icon="inbox" label="Receive a load" color="--info" onClick={() => it[0] ? ui.openForm(receiveForm(D, it[0])) : ui.toast('No loads waiting for the van.')} />
      <Tile icon="truck" label="Deliver eggs" color="--l-tuala" onClick={() => ui.openForm(dispatchForm(D, loc))} />
      <Tile icon="receipt" label="Record sale" color="--l-farm" onClick={() => ui.openForm(saleForm(D, loc))} />
      <Tile icon="crack" label="Damaged eggs" color="--f-none" onClick={() => ui.openForm(breakageForm(D, loc))} />
      <Tile icon="count" label={left ? 'Drop off what is left' : 'Van is empty ✓'} color="--l-van" onClick={() => left ? ui.openForm(dispatchForm(D, loc, { leftover: true })) : ui.toast('Nothing on board.')} />
      <Tile icon="cash" label="Credit paid" color="--l-farm" onClick={() => ui.openForm(creditPaidForm(D, loc))} />
      <Tile icon="swap" label="Bank or send cash" color="--l-rayan" onClick={() => ui.openForm(moveForm(D, loc))} />
      <Tile icon="wallet" label="Expense" color="--l-lucky" onClick={() => ui.openForm(expenseForm(D, loc, false))} />
    </div>
    {(D.credits ?? []).some((c) => c.location_id === loc) && <OutstandingCredits D={D} loc={loc} limit={4} />}
    {A.length > 0 && <Card title="For your attention"><AlertList list={A} /></Card>}
  </>;
}

function OutletToday(p: ViewProps) {
  const { D } = p, ui = useUI(), loc = myLoc(p), st = stockNow(D, loc), s = salesOn(D, [D.today], loc);
  const it = D.transit.filter((x) => x.to_loc === loc);
  const closed = D.counts_today.some((c) => c.location_id === loc && c.kind === 'close');
  const A = alertsFor(D).filter((a) => !a.loc || a.loc === loc);
  const credit = s.credit;
  const bar = (k: 'cash' | 'till' | 'paybill' | 'credit', c: string) => { const v = k === 'credit' ? credit : s[k]; return s.value && v ? <span style={{ width: `${(v / s.value) * 100}%`, background: `var(${c})` }} /> : null; };
  return <>
    <ShopSteps D={D} loc={loc} />
    {it.map((x) => <div className="banner info" key={x.id}><div><b>Delivery on the way from {D.locations.find((l) => l.id === x.from_loc)?.short}</b>
      <p>{mix({ n: x.sent_n, b: x.sent_b ?? 0, c: x.sent_c, j: x.sent_j })} · sent {timeOf(x.recorded_at)}</p></div>
      <button className="btn" onClick={() => ui.openForm(receiveForm(D, x))}><Icon name="inbox" />Receive</button></div>)}
    <Card title="Issue eggs"><div className="li" style={{ border: 0, padding: 0 }}>
      <span className="av" style={{ background: 'var(--l-tuala)' }}><Icon name="truck" /></span>
      <div className="mid"><b>Send to another location</b><small>They confirm the count on arrival.</small></div>
      <button className="btn sm" onClick={() => ui.openForm(dispatchForm(D, loc))}>Issue eggs</button></div></Card>
    <div className="kpis">
      <Kpi label="Sales today" value={kes(s.value)} sub={`${s.cnt} sale${s.cnt === 1 ? '' : 's'}`} />
      <Kpi label="Eggs sold" value={eggs(s.pcs)} />
      <Kpi label="On hand" value={eggs(tot(st))} sub={`${eggs(st.n + st.b)} normal`} />
      {D.me.role === 'pos' ? <CashCountKpi D={D} loc={loc} /> : <Kpi label="Cash in drawer" value={kes(balance(D, `CASH:${loc}`))} sub="expected" />}
    </div>
    <Card title="How customers paid" aside={<span className="muted">{kes(s.value)}</span>}>
      <div className="splitbar">{bar('cash', '--l-farm')}{bar('till', '--l-tuala')}{bar('paybill', '--l-van')}{bar('credit', '--l-lucky')}</div>
      <Legend items={[['--l-farm', `Cash ${n0(s.cash)}`], ['--l-tuala', `Till ${n0(s.till)}`], ['--l-van', `Paybill ${n0(s.paybill)}`], ...(credit ? [['--l-lucky', `Credit ${n0(credit)}`] as [string, string]] : [])]} /></Card>
    {(D.credits ?? []).some((c) => c.location_id === loc) && <OutstandingCredits D={D} loc={loc} limit={4} />}
    <div className="tiles">
      <Tile icon="receipt" label="Record sale" color="--l-farm" onClick={() => ui.openForm(saleForm(D, loc))} />
      <Tile icon="inbox" label="Receive stock" color="--info" onClick={() => it[0] ? ui.openForm(receiveForm(D, it[0])) : ui.toast('No deliveries waiting for you.')} />
      <Tile icon="truck" label="Issue eggs" color="--l-tuala" onClick={() => ui.openForm(dispatchForm(D, loc))} />
      <Tile icon="crack" label="Damaged eggs" color="--f-none" onClick={() => ui.openForm(breakageForm(D, loc))} />
      <Tile icon="list" label="Daily stock sheet" color="--l-rayan" onClick={() => ui.openForm(shopDayForm(D, loc))} />
      <Tile icon="cash" label="Credit paid" color="--l-farm" onClick={() => ui.openForm(creditPaidForm(D, loc))} />
      <Tile icon="wallet" label="Expense" color="--l-lucky" onClick={() => ui.openForm(expenseForm(D, loc, false))} />
      <Tile icon="swap" label="Move money" color="--l-rayan" onClick={() => ui.openForm(moveForm(D, loc))} />
      <Tile icon="count" label={closed ? 'Closed ✓' : 'Close the day'} color="--l-van" onClick={() => ui.openForm(countForm(D, loc, 'close'))} />
    </div>
    {A.length > 0 && <Card title="For your attention"><AlertList list={A} /></Card>}
  </>;
}

export function PosStock(p: ViewProps) {
  return isVan(p.D, myLoc(p)) ? <VanStock {...p} /> : <OutletStock {...p} />;
}

/** The van's load: no counts. What came on, what went off, and what is left. */
function VanStock(p: ViewProps) {
  const { D } = p, ui = useUI(), loc = myLoc(p), L = dayLedger(D, loc, D.today), st = stockNow(D, loc);
  const row = (label: string, q: Q, sign = '') => <tr><td>{label}</td>{(['n', 'j', 'c'] as const).map((k) => { const v = k === 'n' ? q.n + (q.b ?? 0) : q[k]; return <td key={k}>{v ? `${sign}${k === 'j' ? `${v} pc` : eggs(v)}` : '–'}</td>; })}</tr>;
  return <>
    <Card title="The van's load today" aside={<span className="muted">no counts: it ends the day empty</span>}>
      <div className="tblw"><table><thead><tr><th></th><th>Normal</th><th>Jumbo</th><th>Cracked</th></tr></thead>
        <tbody>{row('On board this morning', L.open)}{row('+ Loaded (received)', L.recv, '+')}{row('− Delivered', L.out, '−')}{row('− Sold', L.sold, '−')}{row('− Damaged', L.brk, '−')}{row('− Out, no sale', L.iss, '−')}</tbody>
        <tfoot>{row('On board now', L.close)}</tfoot></table></div>
      <div className="row-btns" style={{ marginTop: 12 }}>
        <button className="btn sm" onClick={() => ui.openForm(dispatchForm(D, loc))}><Icon name="truck" />Deliver eggs</button>
        {tot(st) > 0 && <button className="btn sm alt" onClick={() => ui.openForm(dispatchForm(D, loc, { leftover: true }))}><Icon name="count" />Drop off what is left</button>}
        <button className="btn sm alt" onClick={() => ui.openForm(breakageForm(D, loc))}><Icon name="crack" />Damaged</button></div></Card>
    <Card title="Last 7 days" aside={<span className="muted">pieces</span>}><div className="tblw"><table>
      <thead><tr><th>Day</th><th>Loaded</th><th>Delivered</th><th>Sold</th><th>Damaged</th><th>Left on board</th></tr></thead>
      <tbody>{range(addDays(D.today, -6), D.today).reverse().map((d) => { const x = dayLedger(D, loc, d);
        return <tr key={d}><td>{dlabel(d)}</td><td>{n0(tot(x.recv))}</td><td>{tot(x.out) ? n0(tot(x.out)) : '–'}</td><td>{n0(tot(x.sold))}</td><td>{tot(x.brk) || '–'}</td>
          <td>{tot(x.close) > 0 ? <span className="chip sev-amber">{n0(tot(x.close))}</span> : '0'}</td></tr>; })}</tbody></table></div></Card>
  </>;
}

function OutletStock(p: ViewProps) {
  const { D } = p, ui = useUI(), loc = myLoc(p), L = dayLedger(D, loc, D.today);
  const row = (label: string, q: Q, sign = '') => <tr><td>{label}</td>{(['n', 'j', 'c'] as const).map((k) => { const v = k === 'n' ? q.n + (q.b ?? 0) : q[k]; return <td key={k}>{v ? `${sign}${k === 'j' ? `${v} pc` : eggs(v)}` : '–'}</td>; })}</tr>;
  return <>
    <Card title="Today's stock sheet" aside={<span className="muted">{D.locations.find((l) => l.id === loc)?.name}</span>}>
      <div className="tblw"><table><thead><tr><th></th><th>Normal</th><th>Jumbo</th><th>Cracked</th></tr></thead>
        <tbody>{row('Opening', L.open)}{loc === 'FARM' && row('+ Collected', L.coll, '+')}{row('+ Received', L.recv, '+')}{row('− Issued (sent)', L.out, '−')}{row('− Out, no sale', L.iss, '−')}{row('− Sold', L.sold, '−')}{row('− Damaged', L.brk, '−')}{row('± Count variance', L.adj)}</tbody>
        <tfoot>{row('On hand (expected)', L.close)}</tfoot></table></div>
      <div className="row-btns" style={{ marginTop: 12 }}><button className="btn sm alt" onClick={() => ui.openForm(countForm(D, loc, 'open'))}><Icon name="count" />Opening count</button>
        <button className="btn sm" onClick={() => ui.openForm(countForm(D, loc, 'close'))}><Icon name="count" />Close the day</button>
        <button className="btn sm alt" onClick={() => ui.openForm(dispatchForm(D, loc))}><Icon name="truck" />Issue eggs</button>
        <button className="btn sm alt" onClick={() => ui.openForm(issueForm(D, loc))}><Icon name="box" />Out, no sale</button>
        <button className="btn sm alt" onClick={() => ui.openForm(shopDayForm(D, loc))}><Icon name="list" />Daily stock sheet</button></div></Card>
    <Card title="Last 7 days" aside={<span className="muted">pieces</span>}><div className="tblw"><table>
      <thead><tr><th>Day</th><th>Opening</th><th>In</th><th>Issued / out</th><th>Damaged</th><th>Sold</th><th>Closing</th></tr></thead>
      <tbody>{range(addDays(D.today, -6), D.today).reverse().map((d) => { const x = dayLedger(D, loc, d);
        return <tr key={d}><td>{dlabel(d)}</td><td>{n0(tot(x.open))}</td><td>{n0(tot(x.recv) + tot(x.coll))}</td><td>{tot(x.iss) + tot(x.out) ? n0(tot(x.iss) + tot(x.out)) : '–'}</td><td>{tot(x.brk) || '–'}</td><td>{n0(tot(x.sold))}</td><td>{n0(tot(x.close))}</td></tr>; })}</tbody></table></div></Card>
  </>;
}

/** For the outlet attendant: whether the cash has been counted today, never the expected figure (blind count). */
function CashCountKpi({ D, loc }: { D: ViewProps['D']; loc: string }) {
  const c = D.cash_counts_today.filter((x) => x.location_id === loc).pop();
  return c ? <Kpi label="Cash counted" value={kes(c.counted)} sub={c.diff ? `${c.diff < 0 ? 'short' : 'over'} ${kes(Math.abs(c.diff))}` : `matched at ${timeOf(c.recorded_at)}`} />
    : <Kpi label="Cash counted" value="Not yet" sub="count it on Money" />;
}

export function PosSales(p: ViewProps) {
  const { D, version } = p, ui = useUI(), loc = myLoc(p);
  return <>
    <Card title="Sales by payment method"><PayChart D={D} loc={loc} /></Card>
    <Card title="Recent sales" aside={<button className="lnk" onClick={() => ui.openForm(saleForm(D, loc))}>New sale</button>}>
      <RecordList D={D} version={version} loc={loc} kinds={['sale']} canVoid={false} limit={25} /></Card>
  </>;
}

export function PosMoney(p: ViewProps) {
  const { D, version } = p, ui = useUI(), loc = myLoc(p), acc = `CASH:${loc}`, c = cashDay(D, acc, D.today), s = salesOn(D, [D.today], loc);
  const match = Math.round(s.value) === Math.round(s.cash + s.till + s.paybill + s.credit);
  const counted = D.cash_counts_today.filter((x) => x.location_id === loc).pop();
  return <>
    <Card title={isVan(D, loc) ? 'Cash with the driver' : 'Cash drawer today'} aside={<span className="muted">{D.locations.find((l) => l.id === loc)?.name}</span>}>
      <div className="recon">
        <div><span>Opening cash</span><span>{kes(c.open)}</span></div>
        <div><span>+ Cash sales</span><span>{kes(c.sales)}</span></div>
        {c.creditPaid !== 0 && <div><span>+ Credit paid in cash</span><span>{kes(c.creditPaid)}</span></div>}
        <div><span>+ Money moved in (e.g. Paybill withdrawn to cash)</span><span>{kes(c.moveIn)}</span></div>
        <div><span>− Money moved out (banked, sent to Paybill)</span><span>{kes(-c.moveOut)}</span></div>
        <div><span>− Charges</span><span>{kes(-c.fees)}</span></div>
        <div><span>− Expenses paid in cash</span><span>{kes(-c.expenses)}</span></div>
        {(c.variance !== 0 || c.opening !== 0) && <div><span>± Count variance / opening balance</span><span>{kes(c.variance + c.opening)}</span></div>}
        {(D.me.role !== 'pos' || isVan(D, loc) || counted) ? <div className="tot"><span>Expected cash in drawer</span><span>{kes(balance(D, acc))}</span></div>
          : <div className="tot"><span>Expected cash in drawer</span><span className="muted">after you count</span></div>}
      </div>
      {counted && <div className={`ok-line ${counted.diff ? 'sev-orange' : 'sev-ok'}`}><Icon name={counted.diff ? 'alert' : 'check'} />Counted {kes(counted.counted)} at {timeOf(counted.recorded_at)}{counted.diff ? ` · ${counted.diff < 0 ? 'short' : 'over'} ${kes(Math.abs(counted.diff))}` : ' · matched'}</div>}
      <div className="row-btns" style={{ marginTop: 14 }}>{!isVan(D, loc) && <button className="btn sm" onClick={() => ui.openForm(cashCountForm(D, loc))}><Icon name="cash" />Count cash</button>}
        <button className="btn sm alt" onClick={() => ui.openForm(moveForm(D, loc))}><Icon name="swap" />Move money</button>
        <button className="btn sm alt" onClick={() => ui.openForm(expenseForm(D, loc, false))}><Icon name="wallet" />Expense</button></div></Card>
    <Card title="Sales vs payments">
      <div className="recon"><div><span>Egg sales today</span><span>{kes(s.value)}</span></div><div><span>Cash</span><span>{kes(s.cash)}</span></div>
        <div><span>M-Pesa Till</span><span>{kes(s.till)}</span></div><div><span>M-Pesa Paybill</span><span>{kes(s.paybill)}</span></div>
        {s.credit > 0 && <div><span>On credit (pays later)</span><span>{kes(s.credit)}</span></div>}
        <div className="tot"><span>Total received and on credit</span><span>{kes(s.cash + s.till + s.paybill + s.credit)}</span></div></div>
      <div className={`ok-line ${match ? 'sev-ok' : 'sev-red'}`}><Icon name={match ? 'check' : 'alert'} />{match ? 'Every sale is paid or on credit to a named customer.' : 'Payments do not match sales.'}</div></Card>
    <OutstandingCredits D={D} loc={loc} />
    <Card title="Money records"><RecordList D={D} version={version} loc={loc} kinds={['money', 'cash', 'credit']} canVoid={false} limit={25} /></Card>
    {s.cnt === 0 && c.moveIn === 0 && c.moveOut === 0 && <Empty>No money activity yet today.</Empty>}
  </>;
}
