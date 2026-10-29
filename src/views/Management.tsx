// Owner and Farm Manager screens: overview, alerts, stock, money, report.
import { useState } from 'react';
import { addDays, dlabel, dnum, dshort, eggs, kes, kesS, n0, pct, range } from '../lib/format';
import {
  alertsFor, balance, collected, dayLedger, feedInfo, hensNow, intelligence, layRate, outletLoss, salesOn, stockNow, tankInfo, tot,
  totalFunds, waterOn, waterTrend,
} from '../lib/metrics';
import type { Dashboard } from '../lib/types';
import { feedInForm, moveForm, receiveForm, tankForm, expenseForm } from '../forms/forms';
import { ChartBox } from '../ui/Chart';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { AlertList, Card, Delta, Empty, FeedCard, Kpi, Legend, LocDot, RangeSeg, TankCard, sevClass, sevVar } from '../ui/widgets';
import { breakageChart, houseColor, houseLayChart, outletWeekChart, payChart, productionChart, salesChart, waterChart } from './charts';
import { NoticeList } from './common';

export interface ViewProps { D: Dashboard; version: number; go: (tab: string) => void }

export function Overview({ D, go }: ViewProps) {
  const [n, setN] = useState(14);
  const ui = useUI();
  const y = addDays(D.today, -1), w1 = range(addDays(D.today, -7), y), w0 = range(addDays(D.today, -14), addDays(D.today, -8));
  const cT = tot(collected(D, [D.today])), cY = tot(collected(D, [y]));
  const sT = salesOn(D, [D.today]), sY = salesOn(D, [y]);
  const wY = waterOn(D, [y]), wPrev = waterOn(D, range(addDays(y, -7), addDays(y, -1))) / 7;
  const A = alertsFor(D);
  return <>
    <div className="sample"><div><h2>{dlabel(D.today)}</h2><div className="muted">{D.me.role === 'owner' ? 'All five sales points' : 'Central Farm and sales points'} · {hensNow(D)} hens</div></div><RangeSeg value={n} onChange={setN} /></div>
    <div className="kpis">
      <Kpi label="Eggs collected today" value={eggs(cT)} sub={`Yesterday ${eggs(cY)}`} />
      <Kpi label="Lay rate · 7 days" value={pct(layRate(D, w1))} sub={<><Delta a={layRate(D, w1)} b={layRate(D, w0)} pts /> vs week before</>} />
      <Kpi label="Sales today" value={kes(sT.value)} sub={`Yesterday ${kes(sY.value)}`} />
      <Kpi label={D.me.role === 'owner' ? 'Total funds' : 'Water drunk yesterday'} value={D.me.role === 'owner' ? kes(totalFunds(D)) : `${n0(wY)} L`}
        sub={D.me.role === 'owner' ? 'Cash + M-Pesa + bank' : <><Delta a={wY} b={wPrev} /> vs 7-day average</>} />
    </div>
    <div className="grid2">
      <FeedCard D={D} actions={<button className="btn sm alt" onClick={() => ui.openForm(feedInForm(D))}><Icon name="sack" />Feed received</button>} />
      <TankCard D={D} actions={<button className="btn sm alt" onClick={() => ui.openForm(tankForm(D))}><Icon name="tank" />Tank level</button>} />
    </div>
    <Card title="Needs attention" aside={<button className="lnk" onClick={() => go('alerts')}>See all {A.length}</button>}><AlertList list={A} limit={4} /></Card>
    <Card title="Egg production by house" aside={<span className="muted">trays per day · lay rate</span>}>
      <ChartBox height={280} label="Egg production by house" config={productionChart(D, n)} />
      <Legend items={[...D.houses.map((h, i): [string, string] => [houseColor(i), h.name]), ['--fg', 'Lay rate %']]} />
    </Card>
    <Card title="Water drunk by house" aside={<span className="muted">litres per day · litres per kg of feed</span>}>
      <ChartBox label="Water drunk by house" config={waterChart(D, n)} />
      <Legend items={[...D.houses.map((h, i): [string, string] => [houseColor(i), h.name]), ['--fg', 'L per kg feed']]} />
    </Card>
    <Card title="Sales by location" aside={<span className="muted">KES per day</span>}>
      <ChartBox label="Sales by location" config={salesChart(D, n)} />
      <Legend items={D.locations.map((l): [string, string] => [`--l-${l.id.toLowerCase()}`, l.short])} />
    </Card>
    <Card title="Sales points right now" aside={<button className="lnk" onClick={() => go('stock')}>Stock detail</button>}>
      <div className="locs">{D.locations.map((l) => {
        const st = stockNow(D, l.id), s = salesOn(D, [D.today], l.id), it = D.transit.filter((x) => x.to_loc === l.id);
        const opened = D.counts_today.some((c) => c.location_id === l.id && c.kind === 'open');
        return <div className="loc" key={l.id}><div className="t"><span><LocDot id={l.id} />{l.name}</span>
          {it.length ? <span className="chip sev-info">{eggs(it.reduce((a, x) => a + x.sent_n + x.sent_c + x.sent_j, 0))} on the way</span>
            : opened ? <span className="chip sev-ok">Open</span> : <span className="chip sev-amber">Not opened</span>}</div>
          <dl><div><dt>Stock</dt><dd>{eggs(tot(st))}</dd></div><div><dt>Sales today</dt><dd>{kesS(s.value)}</dd></div><div><dt>Cash at hand</dt><dd>{kesS(balance(D, `CASH:${l.id}`))}</dd></div></dl></div>;
      })}</div>
    </Card>
  </>;
}

export function Alerts({ D }: ViewProps) {
  const ui = useUI(), A = alertsFor(D);
  const houses = D.houses.map((h) => ({ h, q: collected(D, [D.today], h.id), hens: hensNow(D, h.id), w: waterTrend(D, h.id) }));
  return <>
    <div className="sample"><div><h2>{D.me.role === 'manager' ? `Hello, ${D.me.display_name}` : 'Alerts'}</h2><div className="muted">{dlabel(D.today)} · Central Farm · {hensNow(D)} hens</div></div></div>
    <Card title="Alerts" aside={<span className={`chip ${A.some((a) => a.sev === 'red' || a.sev === 'orange') ? 'sev-orange' : 'sev-info'}`}>{A.length} open</span>}><AlertList list={A} /></Card>
    <div className="grid2"><FeedCard D={D} /><TankCard D={D} /></div>
    <div className="grid2">
      <Card title="Today at the farm"><div className="list">{houses.map((x, i) => (
        <div className="li" key={x.h.id}><span className="av" style={{ background: `var(${houseColor(i)})` }}><Icon name="egg" /></span>
          <div className="mid"><b>{x.h.name}</b><small>{x.hens} hens · {x.q.c} cracked · {x.q.j} jumbo</small><small>Water today {n0(x.w.today)} L · yesterday {n0(x.w.yesterday)} L</small></div>
          <div className="end">{eggs(tot(x.q))}</div></div>))}</div></Card>
      <Card title="Deliveries not yet confirmed">{D.transit.length ? <div className="list">{D.transit.map((x) => (
        <div className="li" key={x.id}><span className="av" style={{ background: 'var(--l-tuala)' }}><Icon name="truck" /></span>
          <div className="mid"><b>{D.locations.find((l) => l.id === x.from_loc)?.short} → {D.locations.find((l) => l.id === x.to_loc)?.short}</b><small>Sent {dlabel(x.d)}</small></div>
          <div className="end">{eggs(x.sent_n + x.sent_c + x.sent_j)}<div><button className="act" onClick={() => ui.openForm(receiveForm(D, x))}>Receive</button></div></div></div>))}</div>
        : <Empty>All deliveries confirmed.</Empty>}</Card>
    </div>
    <Card title="Notifications" aside={<span className="muted">last 14 days</span>}><NoticeList D={D} /></Card>
  </>;
}

export function Stock({ D }: ViewProps) {
  const ui = useUI();
  const rows = D.locations.map((l) => ({ l, s: stockNow(D, l.id), it: D.transit.filter((x) => x.to_loc === l.id).reduce((a, x) => a + x.sent_n + x.sent_c + x.sent_j, 0) }));
  const T = rows.reduce((a, r) => ({ n: a.n + r.s.n, c: a.c + r.s.c, j: a.j + r.s.j, it: a.it + r.it }), { n: 0, c: 0, j: 0, it: 0 });
  const loss = outletLoss(D, range(addDays(D.today, -7), addDays(D.today, -1)));
  const v = (x: number) => (x ? n0(x) : '–');
  return <>
    <div className="sample"><div><h2>Stock across locations</h2><div className="muted">Normal eggs in trays of 30 and pieces</div></div></div>
    <Card title="On hand now"><div className="tblw"><table>
      <thead><tr><th>Location</th><th>Normal</th><th>Cracked</th><th>Jumbo</th><th>On the way</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.l.id}><td><LocDot id={r.l.id} />{r.l.name}</td><td>{eggs(r.s.n)}</td><td>{r.s.c} pc</td><td>{r.s.j} pc</td><td>{r.it ? eggs(r.it) : '–'}</td></tr>)}</tbody>
      <tfoot><tr><td>All locations</td><td>{eggs(T.n)}</td><td>{T.c} pc</td><td>{T.j} pc</td><td>{T.it ? eggs(T.it) : '–'}</td></tr></tfoot></table></div></Card>
    <Card title="Today's stock movement" aside={<span className="muted">pieces</span>}><div className="tblw"><table>
      <thead><tr><th>Location</th><th>Opening</th><th>+ Collected</th><th>+ Received</th><th>− Sent</th><th>− Sold</th><th>− Broken</th><th>± Count</th><th>On hand</th></tr></thead>
      <tbody>{D.locations.map((l) => { const L = dayLedger(D, l.id, D.today); return <tr key={l.id}><td><LocDot id={l.id} />{l.short}</td><td>{n0(tot(L.open))}</td><td>{v(tot(L.coll))}</td><td>{v(tot(L.recv))}</td><td>{v(tot(L.out))}</td><td>{v(tot(L.sold))}</td><td>{v(tot(L.brk))}</td><td>{v(tot(L.adj))}</td><td><b>{n0(tot(L.close))}</b></td></tr>; })}</tbody></table></div>
      <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>Each row balances: opening + collected + received − sent − sold − broken ± count = on hand.</p></Card>
    <div className="grid2">
      <Card title="On the way">{D.transit.length ? <div className="list">{D.transit.map((x) => <div className="li" key={x.id}><span className="av" style={{ background: 'var(--l-tuala)' }}><Icon name="truck" /></span>
        <div className="mid"><b>{D.locations.find((l) => l.id === x.from_loc)?.short} → {D.locations.find((l) => l.id === x.to_loc)?.short}</b><small>Sent {dlabel(x.d)}</small></div>
        <div className="end">{eggs(x.sent_n + x.sent_c + x.sent_j)}<div><button className="act" onClick={() => ui.openForm(receiveForm(D, x))}>Receive</button></div></div></div>)}</div> : <Empty>Nothing in transit.</Empty>}</Card>
      <Card title="Breakage, last 7 days" aside={<span className="muted">transit + handling</span>}>
        <ChartBox height={190} label="Breakage rate by location" config={breakageChart(D, loss)} />
        <div className="tblw" style={{ marginTop: 8 }}><table><thead><tr><th>Location</th><th>Lost</th><th>Of</th><th>Rate</th></tr></thead>
          <tbody>{loss.map((o) => <tr key={o.loc}><td><LocDot id={o.loc} />{D.locations.find((l) => l.id === o.loc)?.short}</td><td>{o.loss} pc</td><td>{eggs(o.base)}</td>
            <td><span className={`chip ${o.rate * 100 > D.settings.break_tol ? 'sev-amber' : 'sev-ok'}`}>{pct(o.rate)}</span></td></tr>)}</tbody></table></div></Card>
    </div>
  </>;
}

export function Money({ D }: ViewProps) {
  const ui = useUI(), [n, setN] = useState(14);
  const cash = D.accounts.filter((a) => a.kind === 'cash');
  const sumK = (k: string) => D.money_daily.filter((r) => r.kind === k).reduce((a, r) => a + Number(r.amount), 0);
  const total = totalFunds(D), inWindow = D.money_daily.reduce((a, r) => a + Number(r.amount), 0), start = total - inWindow;
  const sales = sumK('sale'), exp = -sumK('expense'), fees = -sumK('fee'), vari = sumK('variance'), open = sumK('opening'), net = sumK('move_in') + sumK('move_out');
  const expected = start + sales - exp - fees + vari + open + net;
  const ok = Math.round(expected) === Math.round(total) && Math.round(net) === 0;
  const Acc = ({ name, col, v, sub }: { name: string; col: string; v: number; sub?: string }) =>
    <div className="acc"><div className="h"><i style={{ background: `var(${col})` }} />{name}</div><div className="v">{kes(v)}</div>{sub && <div className="s">{sub}</div>}</div>;
  return <>
    <div className="sample"><div><h2>Money position</h2><div className="muted">Every shilling sits in one of four places</div></div>
      <div className="row-btns"><button className="btn sm" onClick={() => ui.openForm(moveForm(D, null))}><Icon name="swap" />Move money</button>
        <button className="btn sm alt" onClick={() => ui.openForm(expenseForm(D, 'FARM', true))}><Icon name="wallet" />Expense</button></div></div>
    <div className="accs">
      <Acc name="Cash at hand" col="--l-farm" v={cash.reduce((a, c) => a + balance(D, c.id), 0)} sub={cash.map((c) => `${D.locations.find((l) => l.id === c.location_id)?.short} ${kesS(balance(D, c.id))}`).join(' · ')} />
      <Acc name="M-Pesa Till" col="--l-tuala" v={balance(D, 'TILL')} sub="Buy Goods, all outlets" />
      <Acc name="M-Pesa Paybill" col="--l-van" v={balance(D, 'PAYBILL')} sub="Business number" />
      <Acc name="Bank" col="--l-rayan" v={balance(D, 'BANK')} sub="Current account" />
    </div>
    <div className="grid2">
      <Card title="Do the books balance?" aside={<span className="muted">since {dnum(D.from)}</span>}>
        <div className="recon">
          <div><span>Funds on {dnum(D.from)}</span><span>{kes(start)}</span></div>
          {open !== 0 && <div><span>± Opening balances entered</span><span>{kes(open)}</span></div>}
          <div><span>+ Egg sales (cash, Till, Paybill)</span><span>{kes(sales)}</span></div>
          <div><span>− Expenses paid</span><span>{kes(-exp)}</span></div>
          <div><span>− M-Pesa and bank charges</span><span>{kes(-fees)}</span></div>
          <div><span>± Cash count variances</span><span>{kes(vari)}</span></div>
          <div><span>Transfers between accounts (net)</span><span>{kes(net)}</span></div>
          <div className="tot"><span>Expected funds</span><span>{kes(expected)}</span></div>
          <div><span>Funds in the four places</span><span>{kes(total)}</span></div>
        </div>
        <div className={`ok-line ${ok ? 'sev-ok' : 'sev-red'}`}><Icon name={ok ? 'check' : 'alert'} />{ok ? 'Balanced. Moving money between accounts nets to zero.' : `Out of balance by ${kes(total - expected)}`}</div>
      </Card>
      <Card title="Receipts by payment method" aside={<RangeSeg value={n} onChange={setN} />}>
        <ChartBox label="Receipts by payment method" config={payChart(D, n)} />
        <Legend items={[['--l-farm', 'Cash'], ['--l-tuala', 'Till'], ['--l-van', 'Paybill']]} />
      </Card>
    </div>
    <Card title="Today by sales point" aside={<span className="muted">sales must equal cash + Till + Paybill</span>}><div className="tblw"><table>
      <thead><tr><th>Location</th><th>Sales</th><th>Cash</th><th>Till</th><th>Paybill</th><th>Check</th><th>Expected cash</th><th>Last count</th></tr></thead>
      <tbody>{D.locations.map((l) => { const s = salesOn(D, [D.today], l.id), m = s.value === s.cash + s.till + s.paybill;
        const cc = D.cash_counts_today.filter((c) => c.location_id === l.id).pop();
        return <tr key={l.id}><td><LocDot id={l.id} />{l.short}</td><td>{n0(s.value)}</td><td>{n0(s.cash)}</td><td>{n0(s.till)}</td><td>{n0(s.paybill)}</td>
          <td><span className={`chip ${m ? 'sev-ok' : 'sev-red'}`}>{m ? 'Matches' : 'Mismatch'}</span></td><td>{n0(balance(D, `CASH:${l.id}`))}</td>
          <td>{cc ? <span className={`chip ${cc.diff ? 'sev-orange' : 'sev-ok'}`}>{cc.diff ? kes(cc.diff) : 'Matched'}</span> : '–'}</td></tr>; })}</tbody></table></div></Card>
  </>;
}

export function Report({ D }: ViewProps) {
  const I = intelligence(D), a = I.a, b = I.b;
  const rows: [string, string, string, number, number, boolean | null, boolean?][] = [
    ['Eggs collected', `${n0(a.eggs / 30)} tr`, `${n0(b.eggs / 30)} tr`, a.eggs, b.eggs, false],
    ['Lay rate', pct(a.lay), pct(b.lay), a.lay, b.lay, false, true],
    ['Cracked at collection', pct(a.cracked), pct(b.cracked), a.cracked, b.cracked, true, true],
    ['Feed used', `${n0(a.feed)} kg`, `${n0(b.feed)} kg`, a.feed, b.feed, null],
    ['Feed per egg', `${n0(a.gpe)} g`, `${n0(b.gpe)} g`, a.gpe, b.gpe, true],
    ['Feed cost per tray', kes(a.costTray), kes(b.costTray), a.costTray, b.costTray, true],
    ['Water drunk', `${n0(a.water)} L`, `${n0(b.water)} L`, a.water, b.water, null],
    ['Water per kg of feed', Number.isFinite(a.ratio) ? `${a.ratio.toFixed(2)} L` : '–', Number.isFinite(b.ratio) ? `${b.ratio.toFixed(2)} L` : '–', a.ratio, b.ratio, null],
    ['Sales', kes(a.sales), kes(b.sales), a.sales, b.sales, false],
    ['Average price per egg', Number.isFinite(a.perEgg) ? `KES ${a.perEgg.toFixed(2)}` : '–', Number.isFinite(b.perEgg) ? `KES ${b.perEgg.toFixed(2)}` : '–', a.perEgg, b.perEgg, false],
    ['Eggs lost to breakage', `${a.brk} pc`, `${b.brk} pc`, a.brk, b.brk, true],
    ['Bird deaths', String(a.mort), String(b.mort), a.mort, b.mort, true],
    ['Cash count variance', kes(a.cv), kes(b.cv), a.cv, b.cv, null],
  ];
  const ol = I.outlets.slice().sort((p, q) => q.sales.value - p.sales.value);
  return <div className="rep" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <Card><div className="muted" style={{ fontSize: 12.5, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 650 }}>Weekly intelligence report · {dshort(I.W1[0])} – {dshort(I.W1[6])}</div>
      <h2 style={{ marginTop: 6 }}>Desert Pearl Ventures · Tuala Farm Fresh Eggs</h2><p className="lead">{I.lead}</p></Card>
    <Card title="Scorecard" aside={<span className="muted">last 7 days vs the 7 before</span>}><div className="tblw"><table>
      <thead><tr><th>Measure</th><th>Last 7 days</th><th>Week before</th><th>Change</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r[0]}><td>{r[0]}</td><td><b>{r[1]}</b></td><td>{r[2]}</td><td>{r[5] === null ? <span className="muted">–</span> : <Delta a={r[3]} b={r[4]} invert={r[5]} pts={r[6]} />}</td></tr>)}</tbody></table></div></Card>
    <Card title="Findings">{I.findings.map((f, i) => <div className="finding" key={i}><span style={{ width: 4, borderRadius: 2, background: sevVar(f.sev), gridRow: 'span 2' }} /><b>{f.title}</b><p>{f.text}</p></div>)}</Card>
    <div className="grid2">
      <Card title="Lay rate by house" aside={<span className="muted">30 days vs expected (dashed)</span>}><ChartBox label="Lay rate by house" config={houseLayChart(D)} />
        <Legend items={D.houses.map((h, i): [string, string] => [houseColor(i), h.name])} /></Card>
      <Card title="Sales by location" aside={<span className="muted">week on week</span>}><ChartBox label="Sales by location week on week" config={outletWeekChart(D, I.outlets)} />
        <Legend items={[['--l-farm', 'Last 7 days'], ['--line', 'Week before']]} /></Card>
    </div>
    <Card title="Sales point league"><div className="tblw"><table>
      <thead><tr><th>Location</th><th>Sales</th><th>Change</th><th>Share</th><th>Eggs sold</th><th>Breakage</th></tr></thead>
      <tbody>{ol.map((o) => <tr key={o.loc}><td><LocDot id={o.loc} />{D.locations.find((l) => l.id === o.loc)?.short}</td><td>{kes(o.sales.value)}</td>
        <td>{o.prev ? <span className={o.chg >= 0 ? 'up' : 'down'}>{o.chg >= 0 ? '▲' : '▼'} {Math.abs(o.chg * 100).toFixed(1)}%</span> : '–'}</td>
        <td>{a.sales ? pct(o.sales.value / a.sales, 0) : '–'}</td><td>{eggs(o.sales.pcs)}</td><td>{pct(o.rate)}</td></tr>)}</tbody></table></div></Card>
    <Card title="Recommended actions">{I.actions.length ? <div className="tblw"><table className="actions-tbl">
      <thead><tr><th>Priority</th><th>Action</th><th>Who</th></tr></thead>
      <tbody>{I.actions.map((r, i) => <tr key={i}><td><span className={`chip ${sevClass(r[0] === 'High' ? 'orange' : 'amber')}`}>{r[0]}</span></td><td>{r[1]}</td><td>{r[2]}</td></tr>)}</tbody></table></div>
      : <Empty>No actions needed this week.</Empty>}
      <p className="muted" style={{ fontSize: 12.5, margin: '12px 0 0' }}>Built from staff records. Expected lay rates come from each house's settings; use the figures in the breed guide the farm follows.</p></Card>
  </div>;
}

/** Small helper for the tank and feed facts on management screens. */
export const feedAndTank = (D: Dashboard) => ({ f: feedInfo(D), t: tankInfo(D) });
