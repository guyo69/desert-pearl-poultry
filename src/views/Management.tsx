// Owner and Farm Manager screens: overview, alerts, stock, money, report.
import { addDays, dlabel, dnum, eggs, kes, kesS, n0, pct, range } from '../lib/format';
import {
  alertsFor, canEnter, closedToday, mix, produced, balance, collected, dayLedger, feedInfo, hensNow, intelligence, layRate, outletLoss, salesOn, stockNow, tankInfo, tot,
  totalFunds, waterOn, waterTrend,
} from '../lib/metrics';
import type { Dashboard } from '../lib/types';
import { feedInForm, moveForm, receiveForm, tankForm, expenseForm } from '../forms/forms';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { useEffect, useState } from 'react';
import { loadWeeklyReport, type WeeklyReport } from '../lib/api';
import { AlertList, BarList, Card, Delta, Empty, FeedCard, Kpi, LocDot, Skel, SkelList, TankCard, sevClass, sevVar } from '../ui/widgets';
import { HouseLayChart, PayChart, ProductionChart, SalesChart, WaterChart, houseColor } from './charts';
import { NoticeList, OutstandingCredits } from './common';
import { MonthBooks } from './MonthBooks';
import { buildWeekReport } from '../lib/report';
import { GUIDE } from '../lib/knowledge';
import { MissingDays, gapSummary, useGaps } from './Journey';

export interface ViewProps { D: Dashboard; version: number; go: (tab: string) => void }

export function Overview({ D, go, version }: ViewProps) {
  const ui = useUI();
  const y = addDays(D.today, -1), w1 = range(addDays(D.today, -7), y), w0 = range(addDays(D.today, -14), addDays(D.today, -8));
  const cT = produced(D, [D.today]), cY = produced(D, [y]);
  const sT = salesOn(D, [D.today]), sY = salesOn(D, [y]);
  const wY = waterOn(D, [y]), wPrev = waterOn(D, range(addDays(y, -7), addDays(y, -1))) / 7;
  const A = alertsFor(D), gaps = useGaps(version);
  const nGaps = gaps?.length ? 1 : 0;
  return <>
    <div className="sample"><div><h2>{dlabel(D.today)}</h2><div className="muted">{D.me.role === 'owner' ? 'All five sales points' : 'Central Farm and sales points'} · {n0(hensNow(D))} hens</div></div></div>
    <div className="kpis" data-tip="today">
      <Kpi label="Eggs collected today" value={eggs(cT)} sub={`Yesterday ${eggs(cY)}`} />
      <Kpi label="Lay rate · 7 days" value={pct(layRate(D, w1))} sub={<><Delta a={layRate(D, w1)} b={layRate(D, w0)} pts /> vs week before</>} />
      <Kpi label="Sales today" value={kes(sT.value)} sub={`Yesterday ${kes(sY.value)}`} />
      <Kpi label={D.me.role === 'owner' ? 'Total funds' : 'Water drunk yesterday'} value={D.me.role === 'owner' ? kes(totalFunds(D)) : `${n0(wY)} L`}
        sub={D.me.role === 'owner' ? 'Cash + M-Pesa + bank' : <><Delta a={wY} b={wPrev} /> vs 7-day average</>} />
    </div>
    <div className="grid2">
      <FeedCard D={D} actions={canEnter(D) ? <button className="btn sm alt" onClick={() => ui.openForm(feedInForm(D))}><Icon name="sack" />Feed received</button> : undefined} />
      <TankCard D={D} actions={canEnter(D) ? <button className="btn sm alt" onClick={() => ui.openForm(tankForm(D))}><Icon name="tank" />Tank level</button> : undefined} />
    </div>
    <Card title="Needs attention" aside={<button className="lnk" onClick={() => go('alerts')}>See all {A.length + nGaps}</button>}>
      {gaps?.length ? <div className="alerts" style={{ marginBottom: A.length ? 8 : 0 }}>
        <button className="alert" style={{ border: 0, width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => go('alerts')}>
          <span className="stripe" style={{ background: sevVar('amber') }} />
          <div style={{ minWidth: 0 }}><b>Days with gaps</b><p>{gapSummary(gaps)}. See all to fill them in.</p></div>
        </button></div> : null}
      {A.length || !gaps?.length ? <AlertList list={A} limit={gaps?.length ? 3 : 4} /> : null}
    </Card>
    <OutstandingCredits D={D} limit={5} />
    <Card title="Egg production"><ProductionChart D={D} /></Card>
    <Card title="Water drunk"><WaterChart D={D} /></Card>
    <Card title="Sales"><SalesChart D={D} /></Card>
    <Card title="Sales points right now" aside={<button className="lnk" onClick={() => go('stock')}>Stock detail</button>}>
      <div className="locs">{D.locations.map((l) => {
        const st = stockNow(D, l.id), s = salesOn(D, [D.today], l.id), it = D.transit.filter((x) => x.to_loc === l.id);
        const opened = D.counts_today.some((c) => c.location_id === l.id && c.kind === 'open');
        return <div className="loc" key={l.id}><div className="t"><span><LocDot id={l.id} />{l.name}</span>
          {it.length ? <span className="chip sev-info">{eggs(it.reduce((a, x) => a + x.sent_n + (x.sent_b ?? 0) + x.sent_c + x.sent_j, 0))} on the way</span>
            : l.kind === 'van' ? <span className={`chip ${tot(st) > 0 ? 'sev-info' : ''}`}>{tot(st) > 0 ? 'Loaded' : 'Empty'}</span>
            : opened ? <span className="chip sev-ok">Open</span> : closedToday(D, l) ? <span className="chip">Closed today</span> : <span className="chip sev-amber">Not opened</span>}</div>
          <dl><div><dt>Stock</dt><dd>{eggs(tot(st))}</dd></div><div><dt>Sales today</dt><dd>{kesS(s.value)}</dd></div><div><dt>Cash at hand</dt><dd>{kesS(balance(D, `CASH:${l.id}`))}</dd></div></dl></div>;
      })}</div>
    </Card>
  </>;
}

export function Alerts({ D, version }: ViewProps) {
  const ui = useUI(), A = alertsFor(D), gaps = useGaps(version);
  const houses = D.houses.map((h) => ({ h, q: collected(D, [D.today], h.id), hens: hensNow(D, h.id), w: waterTrend(D, h.id) }));
  return <>
    <div className="sample"><div><h2>{D.me.role === 'manager' ? `Hello, ${D.me.display_name}` : 'Alerts'}</h2><div className="muted">{dlabel(D.today)} · Central Farm · {n0(hensNow(D))} hens</div></div></div>
    <MissingDays D={D} gaps={gaps} />
    <Card title="Alerts" aside={<span className={`chip ${A.some((a) => a.sev === 'red' || a.sev === 'orange') ? 'sev-orange' : 'sev-info'}`}>{A.length} open</span>}><AlertList list={A} /></Card>
    <div className="grid2"><FeedCard D={D} /><TankCard D={D} /></div>
    <div className="grid2">
      <Card title="Today at the farm"><div className="list">{houses.map((x, i) => (
        <div className="li" key={x.h.id}><span className="av" style={{ background: `var(${houseColor(i)})` }}><Icon name="egg" /></span>
          <div className="mid"><b>{x.h.name}</b><small>{n0(x.hens)} hens · {mix({ ...x.q, n: 0 }) === 'none' ? 'all normal' : mix({ ...x.q, n: 0 })}</small><small>Water today {n0(x.w.today)} L · yesterday {n0(x.w.yesterday)} L</small></div>
          <div className="end">{eggs(tot(x.q))}</div></div>))}</div></Card>
      <Card title="Deliveries not yet confirmed">{D.transit.length ? <div className="list">{D.transit.map((x) => (
        <div className="li" key={x.id}><span className="av" style={{ background: 'var(--l-tuala)' }}><Icon name="truck" /></span>
          <div className="mid"><b>{D.locations.find((l) => l.id === x.from_loc)?.short} → {D.locations.find((l) => l.id === x.to_loc)?.short}</b><small>Sent {dlabel(x.d)}</small></div>
          <div className="end">{eggs(x.sent_n + (x.sent_b ?? 0) + x.sent_c + x.sent_j)}{canEnter(D) && <div><button className="act" onClick={() => ui.openForm(receiveForm(D, x))}>Receive</button></div>}</div></div>))}</div>
        : <Empty>All deliveries confirmed.</Empty>}</Card>
    </div>
    <Card title="Notifications" aside={<span className="muted">last 14 days</span>}><NoticeList D={D} /></Card>
  </>;
}

export function Stock({ D }: ViewProps) {
  const ui = useUI();
  const rows = D.locations.map((l) => ({ l, s: stockNow(D, l.id), it: D.transit.filter((x) => x.to_loc === l.id).reduce((a, x) => a + x.sent_n + (x.sent_b ?? 0) + x.sent_c + x.sent_j, 0) }));
  const T = rows.reduce((a, r) => ({ n: a.n + r.s.n, b: a.b + r.s.b, c: a.c + r.s.c, j: a.j + r.s.j, it: a.it + r.it }), { n: 0, b: 0, c: 0, j: 0, it: 0 });
  const loss = outletLoss(D, range(addDays(D.today, -7), addDays(D.today, -1)));
  const v = (x: number) => (x ? n0(x) : '–');
  return <>
    <div className="sample"><div><h2>Stock across locations</h2><div className="muted">Normal eggs in trays of 30 and pieces</div></div></div>
    <Card title="On hand now"><div className="tblw"><table>
      <thead><tr><th>Location</th><th>Normal</th><th>Jumbo</th><th>Cracked</th><th>On the way</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.l.id}><td><LocDot id={r.l.id} />{r.l.name}</td><td>{eggs(r.s.n + r.s.b)}</td><td>{r.s.j ? `${r.s.j} pc` : '–'}</td><td>{r.s.c ? eggs(r.s.c) : '–'}</td><td>{r.it ? eggs(r.it) : '–'}</td></tr>)}</tbody>
      <tfoot><tr><td>All locations</td><td>{eggs(T.n + T.b)}</td><td>{T.j} pc</td><td>{eggs(T.c)}</td><td>{T.it ? eggs(T.it) : '–'}</td></tr></tfoot></table></div></Card>
    <Card title="Today's stock movement" aside={<span className="muted">pieces</span>}><div className="tblw"><table>
      <thead><tr><th>Location</th><th>Opening</th><th>+ Collected</th><th>+ Received</th><th>− Issued (sent)</th><th>− Out, no sale</th><th>− Sold</th><th>− Damaged</th><th>± Count</th><th>On hand</th></tr></thead>
      <tbody>{D.locations.map((l) => { const L = dayLedger(D, l.id, D.today); return <tr key={l.id}><td><LocDot id={l.id} />{l.short}</td><td>{n0(tot(L.open))}</td><td>{v(tot(L.coll))}</td><td>{v(tot(L.recv))}</td><td>{v(tot(L.out))}</td><td>{v(tot(L.iss))}</td><td>{v(tot(L.sold))}</td><td>{v(tot(L.brk))}</td><td>{v(tot(L.adj))}</td><td><b>{n0(tot(L.close))}</b></td></tr>; })}</tbody></table></div>
      <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>Each row balances: opening + collected + received − issued (sent) − out, no sale − sold − damaged ± count = on hand. Damaged at collection never enters stock.</p></Card>
    <div className="grid2">
      <Card title="On the way">{D.transit.length ? <div className="list">{D.transit.map((x) => <div className="li" key={x.id}><span className="av" style={{ background: 'var(--l-tuala)' }}><Icon name="truck" /></span>
        <div className="mid"><b>{D.locations.find((l) => l.id === x.from_loc)?.short} → {D.locations.find((l) => l.id === x.to_loc)?.short}</b><small>Sent {dlabel(x.d)}</small></div>
        <div className="end">{eggs(x.sent_n + (x.sent_b ?? 0) + x.sent_c + x.sent_j)}{canEnter(D) && <div><button className="act" onClick={() => ui.openForm(receiveForm(D, x))}>Receive</button></div>}</div></div>)}</div> : <Empty>Nothing in transit.</Empty>}</Card>
      <Card title="Damaged eggs, last 7 days" aside={<span className="muted">collection, transit, shops</span>}>
        <BarList format={(v) => pct(v)} rows={loss.map((o) => ({ key: o.loc, label: <><LocDot id={o.loc} />{D.locations.find((l) => l.id === o.loc)?.short}</>, value: o.rate,
          color: o.rate * 100 > D.settings.break_tol ? '--f-low' : '--f-full', note: `${o.loss} pc lost of ${eggs(o.base)}` }))} /></Card>
    </div>
  </>;
}

export function Money({ D }: ViewProps) {
  const ui = useUI();
  const cash = D.accounts.filter((a) => a.kind === 'cash');
  const sumK = (k: string) => D.money_daily.filter((r) => r.kind === k).reduce((a, r) => a + Number(r.amount), 0);
  const total = totalFunds(D), inWindow = D.money_daily.reduce((a, r) => a + Number(r.amount), 0), start = total - inWindow;
  const sales = sumK('sale'), credPaid = sumK('credit_paid'), exp = -sumK('expense'), fees = -sumK('fee'), vari = sumK('variance'), open = sumK('opening'), net = sumK('move_in') + sumK('move_out');
  const expected = start + sales + credPaid - exp - fees + vari + open + net;
  const ok = Math.round(expected) === Math.round(total) && Math.round(net) === 0;
  const Acc = ({ name, col, v, sub }: { name: string; col: string; v: number; sub?: string }) =>
    <div className="acc"><div className="h"><i style={{ background: `var(${col})` }} />{name}</div><div className="v">{kes(v)}</div>{sub && <div className="s">{sub}</div>}</div>;
  return <>
    <div className="sample"><div><h2>Money position</h2><div className="muted">Every shilling sits in one of four places</div></div>
      {canEnter(D) && <div className="row-btns"><button className="btn sm" onClick={() => ui.openForm(moveForm(D, null))}><Icon name="swap" />Move money</button>
        <button className="btn sm alt" onClick={() => ui.openForm(expenseForm(D, 'FARM', true))}><Icon name="wallet" />Expense</button></div>}</div>
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
          {credPaid !== 0 && <div><span>+ Credit paid by customers</span><span>{kes(credPaid)}</span></div>}
          <div><span>− Expenses paid</span><span>{kes(-exp)}</span></div>
          <div><span>− M-Pesa and bank charges</span><span>{kes(-fees)}</span></div>
          <div><span>± Cash count variances</span><span>{kes(vari)}</span></div>
          <div><span>Transfers between accounts (net)</span><span>{kes(net)}</span></div>
          <div className="tot"><span>Expected funds</span><span>{kes(expected)}</span></div>
          <div><span>Funds in the four places</span><span>{kes(total)}</span></div>
        </div>
        <div className={`ok-line ${ok ? 'sev-ok' : 'sev-red'}`}><Icon name={ok ? 'check' : 'alert'} />{ok ? 'Balanced. Moving money between accounts nets to zero.' : `Out of balance by ${kes(total - expected)}`}</div>
      </Card>
      <Card title="Receipts by payment method"><PayChart D={D} /></Card>
    </div>
    <OutstandingCredits D={D} />
    <Card title="Today by sales point" aside={<span className="muted">sales must equal cash + Till + Paybill + credit</span>}><div className="tblw"><table>
      <thead><tr><th>Location</th><th>Sales</th><th>Cash</th><th>Till</th><th>Paybill</th><th>Credit</th><th>Check</th><th>Expected cash</th><th>Last count</th></tr></thead>
      <tbody>{D.locations.map((l) => { const s = salesOn(D, [D.today], l.id), m = Math.round(s.value) === Math.round(s.cash + s.till + s.paybill + s.credit);
        const cc = D.cash_counts_today.filter((c) => c.location_id === l.id).pop();
        return <tr key={l.id}><td><LocDot id={l.id} />{l.short}</td><td>{n0(s.value)}</td><td>{n0(s.cash)}</td><td>{n0(s.till)}</td><td>{n0(s.paybill)}</td><td>{s.credit ? n0(s.credit) : '–'}</td>
          <td><span className={`chip ${m ? 'sev-ok' : 'sev-red'}`}>{m ? 'Matches' : 'Mismatch'}</span></td><td>{n0(balance(D, `CASH:${l.id}`))}</td>
          <td>{cc ? <span className={`chip ${cc.diff ? 'sev-orange' : 'sev-ok'}`}>{cc.diff ? kes(cc.diff) : 'Matched'}</span> : '–'}</td></tr>; })}</tbody></table></div></Card>
  </>;
}

export function Report({ D, version }: ViewProps) {
  const I = intelligence(D), a = I.a, b = I.b;
  const [R, setR] = useState<WeeklyReport | null>(null);
  const [err, setErr] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { loadWeeklyReport().then((r) => { setR(r); setErr(''); }).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load the report.')).finally(() => setLoaded(true)); }, [version]);
  if (!loaded) return <ReportSkeleton />;
  const W = buildWeekReport(D, R);
  const cmp = W.comparable;
  const laying = W.flocks.filter((r) => r.days > 0 && r.guide != null);
  const gHens = laying.reduce((t, r) => t + r.hens, 0);
  const gLay = gHens ? laying.reduce((t, r) => t + r.guide! * r.hens, 0) / gHens : NaN;
  const gDeaths = W.flocks.reduce((t, r) => t + r.mortGuide * r.hens, 0);
  const s = D.settings;
  const rows: [string, string, string, string, number, number, boolean | null, boolean?][] = [
    ['Eggs collected', `${n0(a.eggs / 30)} trays`, '', `${n0(b.eggs / 30)} trays`, a.eggs, b.eggs, false],
    ['Lay rate (days entered)', pct(a.lay), Number.isFinite(gLay) ? pct(gLay, 0) : '', pct(b.lay), a.lay, b.lay, false, true],
    ['Cracked at collection', pct(a.cracked), `under ${GUIDE.crackedPct}%`, pct(b.cracked), a.cracked, b.cracked, true, true],
    ['Feed used', `${n0(a.feed / s.bag_kg)} bags`, '', `${n0(b.feed / s.bag_kg)} bags`, a.feed, b.feed, null],
    ['Feed per egg', Number.isFinite(a.gpe) ? `${n0(a.gpe)} g` : '', `${n0(GUIDE.feedPerEggG[0])} to ${n0(GUIDE.feedPerEggG[1])} g`, Number.isFinite(b.gpe) ? `${n0(b.gpe)} g` : '', a.gpe, b.gpe, true],
    ['Feed cost per tray', Number.isFinite(a.costTray) ? kes(a.costTray) : '', '', Number.isFinite(b.costTray) ? kes(b.costTray) : '', a.costTray, b.costTray, true],
    ['Water drunk', `${n0(a.water)} L`, '', `${n0(b.water)} L`, a.water, b.water, null],
    ['Water per kg of feed', Number.isFinite(a.ratio) ? `${a.ratio.toFixed(2)} L` : '', `${s.water_ratio_min} to ${s.water_ratio_max} L`, Number.isFinite(b.ratio) ? `${b.ratio.toFixed(2)} L` : '', a.ratio, b.ratio, null],
    ['Sales', kes(a.sales), '', kes(b.sales), a.sales, b.sales, false],
    ['Average price per egg', Number.isFinite(a.perEgg) ? `KES ${a.perEgg.toFixed(2)}` : '', '', Number.isFinite(b.perEgg) ? `KES ${b.perEgg.toFixed(2)}` : '', a.perEgg, b.perEgg, false],
    ['Eggs lost to breakage', `${n0(a.brk)} eggs`, '', `${n0(b.brk)} eggs`, a.brk, b.brk, true],
    ['Bird deaths', n0(a.mort), gDeaths ? `about ${n0(gDeaths)}` : '', n0(b.mort), a.mort, b.mort, true],
    ['Cash count difference', kes(a.cv), '', kes(b.cv), a.cv, b.cv, null],
  ];
  const ol = I.outlets.slice().sort((p, q) => q.sales.value - p.sales.value);
  const dash = <span className="muted">–</span>;
  const SEVC: Record<string, Parameters<typeof sevVar>[0]> = { red: 'red', orange: 'orange', amber: 'amber', info: 'info', ok: 'ok' };
  return <div className="rep">
    <Card>
      <div className="rep-eyebrow">Weekly farm report</div>
      <h2>Desert Pearl Ventures · Tuala Farm Fresh Eggs</h2>
      <div className="rep-meta">
        <span><b>Period</b>{W.period}</span><span><b>Prepared</b>{dlabel(D.today)}</span>
        {W.coverage && <span><b>Records entered</b>{W.coverage.pct}% ({W.coverage.entered} of {W.coverage.expected})</span>}
        <span><b>Comparison</b>{cmp ? 'With the week before' : 'Baseline week'}</span>
      </div>
      {err ? <p className="lead">{err}</p> : W.summary.map((t, i) => <p className="lead" key={i}>{t}</p>)}
    </Card>
    <Card tip="findings" title="Key findings" aside={<span className="muted">{W.findings.filter((x) => x.sev !== 'ok' && x.sev !== 'info').length} need attention</span>}>
      {W.findings.length ? W.findings.map((x, i) => <div className="finding" key={i}>
        <span style={{ background: sevVar(SEVC[x.sev] ?? 'ok') }} />
        <b>{x.title}<em className="area">{x.area}</em></b>
        <p>{x.text}{x.action && <span className="todo"><Icon name="check" />{x.action}{x.who ? ` · ${x.who}` : ''}</span>}</p></div>)
        : <p className="lead">Every measure is within its normal range this week.</p>}
    </Card>
    {W.flocks.length > 0 && <Card title="Flock performance" aside={<span className="muted">last 7 days, days entered</span>}><div className="tblw"><table>
      <thead><tr><th>House</th><th>Breed</th><th>Hens</th><th>Age</th><th>Stage</th><th>Lay rate</th><th>Guide for age</th><th>Farm target</th><th>Deaths</th><th>Water per hen</th></tr></thead>
      <tbody>{W.flocks.map((r) => { const bench = r.target ?? r.guide; return <tr key={r.id}><td>{r.name}</td><td>{r.breed || <span className="muted">Not set</span>}</td><td>{n0(r.hens)}</td><td>{r.age} wks</td><td>{r.stage}</td>
        <td>{r.days ? <span className={`chip ${bench != null && r.lay < bench - 0.03 ? 'sev-orange' : 'sev-ok'}`}>{pct(r.lay)}</span> : dash}</td>
        <td>{r.guide != null ? `${pct(r.guide, 0)}${r.beyond ? ' (projected)' : ''}` : dash}</td><td>{r.target != null ? pct(r.target, 0) : dash}</td>
        <td>{n0(r.deaths)}<small className="muted"> ({pct(r.mortPct, 2)})</small></td><td>{Number.isFinite(r.waterMl) ? `${n0(r.waterMl)} ml` : dash}</td></tr>; })}</tbody></table></div>
      <p className="rep-note">Guide: {n0(GUIDE.feedG[0])} to {n0(GUIDE.feedG[1])} g of feed and {n0(GUIDE.waterMl[0])} to {n0(GUIDE.waterMl[1])} ml of water per hen a day in lay, more in hot weather.</p></Card>}
    <Card title="Scorecard" aside={<span className="muted">{cmp ? 'last 7 days and the 7 before' : 'last 7 days'}</span>}><div className="tblw"><table>
      <thead><tr><th>Measure</th><th>Last 7 days</th><th>Guide</th>{cmp && <><th>Week before</th><th>Change</th></>}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r[0]}><td>{r[0]}</td><td><b>{r[1] || dash}</b></td><td>{r[2] || dash}</td>
        {cmp && <><td>{r[3] || dash}</td><td>{r[6] === null ? dash : <Delta a={r[4]} b={r[5]} invert={r[6]} pts={r[7]} />}</td></>}</tr>)}</tbody></table></div>
      <p className="rep-note">{W.reason}</p></Card>
    <div className="grid2">
      <Card title="Lay rate by house" aside={<span className="muted">dashed: expected</span>}><HouseLayChart D={D} /></Card>
      <Card title="Sales by location" aside={<span className="muted">last 7 days{cmp ? ', faint bar: week before' : ''}</span>}>
        <BarList format={kes} rows={ol.map((o) => ({ key: o.loc, label: <><LocDot id={o.loc} />{D.locations.find((l) => l.id === o.loc)?.short}</>,
          value: o.sales.value, prev: cmp ? o.prev : undefined, color: `--l-${o.loc.toLowerCase()}`, note: cmp && o.prev ? `${o.chg >= 0 ? '▲' : '▼'} ${Math.abs(o.chg * 100).toFixed(1)}% on the week before` : undefined }))} /></Card>
    </div>
    <Card title="Sales by outlet"><div className="tblw"><table>
      <thead><tr><th>Location</th><th>Sales</th>{cmp && <th>Change</th>}<th>Share</th><th>Eggs sold</th><th>Breakage</th></tr></thead>
      <tbody>{ol.map((o) => <tr key={o.loc}><td><LocDot id={o.loc} />{D.locations.find((l) => l.id === o.loc)?.short}</td><td>{kes(o.sales.value)}</td>
        {cmp && <td>{o.prev ? <span className={o.chg >= 0 ? 'up' : 'down'}>{o.chg >= 0 ? '▲' : '▼'} {Math.abs(o.chg * 100).toFixed(1)}%</span> : dash}</td>}
        <td>{a.sales ? pct(o.sales.value / a.sales, 0) : dash}</td><td>{eggs(o.sales.pcs)}</td><td>{o.base ? pct(o.rate) : dash}</td></tr>)}</tbody></table></div></Card>
    <Card title="Recommended actions">{W.actions.length ? <div className="tblw"><table className="actions-tbl">
      <thead><tr><th>Priority</th><th>Action</th><th>Who</th></tr></thead>
      <tbody>{W.actions.map((r, i) => <tr key={i}><td><span className={`chip ${sevClass(r.priority === 'High' ? 'orange' : r.priority === 'Medium' ? 'amber' : 'info')}`}>{r.priority}</span></td><td>{r.text}</td><td>{r.who}</td></tr>)}</tbody></table></div>
      : <Empty>No actions needed this week.</Empty>}</Card>
    {W.coverage && W.coverage.gaps.length > 0 && <Card title="Data coverage" aside={<span className="muted">{W.coverage.entered} of {W.coverage.expected} daily records</span>}>
      <div className="cov"><span style={{ width: `${Math.min(100, W.coverage.pct)}%` }} /></div>
      <div className="tblw"><table><thead><tr><th>Place</th><th>Not entered</th><th>Days</th></tr></thead>
        <tbody>{W.coverage.gaps.map((g) => <tr key={g.where}><td>{g.where}</td><td>{g.missing.join(', ')}</td><td>{g.days.join(', ')}</td></tr>)}</tbody></table></div>
      <p className="rep-note">Days that were not entered are left out of every figure above rather than counted as zero. Days with gaps, under Alerts, opens each one to fill in.</p></Card>}
    <p className="rep-note" style={{ margin: '0 4px' }}>{W.guideNote} Source: Hy-Line Brown Commercial Layers performance standards.</p>
    {(D.me.role === 'owner' || D.me.role === 'manager') && <MonthBooks D={D} />}
  </div>;
}

function ReportSkeleton() {
  return <div className="rep" aria-busy="true"><div className="card"><Skel w="30%" h={12} /><Skel w="70%" h={26} mt={10} /><Skel w="90%" mt={16} /><Skel w="80%" mt={8} /><Skel w="60%" mt={8} /></div>
    <div className="card"><Skel w="25%" h={16} /><SkelList n={4} /></div><div className="card"><Skel w="25%" h={16} /><SkelList n={6} /></div></div>;
}

/** Small helper for the tank and feed facts on management screens. */
export const feedAndTank = (D: Dashboard) => ({ f: feedInfo(D), t: tankInfo(D) });
