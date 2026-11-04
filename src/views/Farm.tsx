// Production clerk screens: home tiles, feed, water, flock health, records.
import { useState } from 'react';
import { rpc } from '../lib/api';
import { addDays, daysBetween, dlabel, eggs, n0, pct, range } from '../lib/format';
import { canEnter, collected, damagedAtFarm, deaths, hensNow, houseAge, layRate, mix, produced, stockNow, tankInfo, waterFeedRatio, waterOn, waterTrend } from '../lib/metrics';
import {
  collectForm, confirmIssueForm, dispatchForm, feedInForm, feedUseForm, houseDayForm, medForm, millForm, medicineForm, mortForm, scheduleForm, storeFeedInForm, storeFeedIssueForm,
  storeMedInForm, storeMedIssueForm, tankForm, waterIntakeForm,
} from '../forms/forms';
import type { Dashboard } from '../lib/types';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { Card, Delta, Empty, FeedCard, Seg, TankCard, Tile } from '../ui/widgets';
import { FeedStockChart, FeedUseChart, TankChart, WaterChart, houseColor } from './charts';
import { RecordList } from './common';
import { ClerkSteps } from './Journey';
import { MillCard } from './Mill';
import type { ViewProps } from './Management';

export function ClerkHome({ D, version, go }: ViewProps) {
  const ui = useUI(), farm = stockNow(D, 'FARM');
  if (!D.houses.some((h) => h.birds_at_start > 0)) return <div className="banner warn"><div><b>No hens set up yet</b><p>The owner or farm manager needs to enter each house's hen count under Settings → Houses.</p></div></div>;
  return <>
    <ClerkSteps D={D} />
    <StorePending D={D} />
    <FeedCard D={D} />
    <div className="tiles">
      <Tile icon="egg" label="Egg collection" color="--l-van" onClick={() => ui.openForm(collectForm(D))} />
      <Tile icon="list" label="Daily house sheet" color="--l-rayan" onClick={() => ui.openForm(houseDayForm(D))} />
      <Tile icon="drop" label="Water drunk" color="--info" onClick={() => ui.openForm(waterIntakeForm(D))} />
      <Tile icon="tank" label="Tank level" color="--l-tuala" onClick={() => ui.openForm(tankForm(D))} />
      <Tile icon="bird" label="Mortality" color="--muted" onClick={() => ui.openForm(mortForm(D))} />
      <Tile icon="truck" label="Issue eggs" color="--l-farm" onClick={() => ui.openForm(dispatchForm(D, 'FARM'))} />
    </div>
    <div className="grid2">
      <Card title="Today by house" aside={<span className="muted">{dlabel(D.today)}</span>}><div className="list">{D.houses.map((h, i) => {
        const q = collected(D, [D.today], h.id), dmg = damagedAtFarm(D, [D.today], h.id), laid = produced(D, [D.today], h.id), hens = hensNow(D, h.id), w = waterTrend(D, h.id);
        return <div className="li" key={h.id}><span className="av" style={{ background: `var(${houseColor(i)})` }}><Icon name="egg" /></span>
          <div className="mid"><b>{h.name}</b><small>{n0(hens)} hens · {mix(q)}{dmg ? ` · ${dmg} damaged` : ''}</small><small>Water today {n0(w.today)} L{w.avg ? ` · usual ${n0(w.avg)} L/day` : ''}</small></div>
          <div className="end">{eggs(laid)}<small>{hens ? pct(laid / hens) : '–'} so far</small></div></div>; })}</div></Card>
      <TankCard D={D} actions={<button className="btn sm alt" onClick={() => ui.openForm(tankForm(D))}><Icon name="tank" />Record tank level</button>} />
    </div>
    <Card title="Farm egg store" aside={<span className="muted">available to send</span>}>
      <div className="kpis">
        <div className="kpi"><div className="lbl">Normal</div><div className="val">{eggs(farm.n)}</div></div>
        <div className="kpi"><div className="lbl">Jumbo</div><div className="val">{farm.j} pc</div></div>
        <div className="kpi"><div className="lbl">Cracked</div><div className="val">{eggs(farm.c)}</div></div>
      </div></Card>
    <Card title="Recent records" aside={<button className="lnk" onClick={() => go('records')}>All records</button>}>
      <RecordList D={D} version={version} loc="FARM" canVoid={false} limit={8} /></Card>
  </>;
}

/**
 * Feed and medicine waiting for the production clerk: the store issued them
 * to a house, and the clerk confirms what arrived. The store and the farm
 * manager see the same list, so they know what is outstanding.
 */
export function StorePending({ D }: { D: Dashboard }) {
  const ui = useUI(), list = D.store_pending ?? [];
  if (!list.length) return null;
  const can = D.me.role === 'clerk' || D.me.role === 'manager';
  return <Card title={D.me.role === 'clerk' ? 'Confirm what the store issued' : 'Waiting for the production clerk'} aside={<span className="chip sev-info">{list.length}</span>}>
    <div className="list">{list.map((x) => <div className="li" key={`${x.kind}${x.id}`}>
      <span className="av" style={{ background: `var(${x.kind === 'feed' ? '--f-low' : '--l-rayan'})` }}><Icon name={x.kind === 'feed' ? 'sack' : 'syringe'} /></span>
      <div className="mid"><b>{x.kind === 'feed' ? 'Feed' : x.what} for {x.house}</b><small>{n0(x.qty)} {x.unit} issued {x.d === D.today ? 'today' : dlabel(x.d)}{x.by_name ? ` by ${x.by_name}` : ''}</small></div>
      {can && <div className="end"><button className="act" onClick={() => ui.openForm(confirmIssueForm(D, x))}>Confirm</button></div>}</div>)}</div>
  </Card>;
}

/** Feed buttons by role: the store receives and issues; the farm manager can also record use directly. */
function feedActions(D: Dashboard, ui: ReturnType<typeof useUI>) {
  const mill = (D.raw ?? []).length > 0 && canEnter(D) ? <button className="btn sm alt" onClick={() => ui.openForm(millForm(D))}><Icon name="pulse" />Feed milled</button> : null;
  if (D.me.role === 'store') return <><button className="btn sm" onClick={() => ui.openForm(storeFeedIssueForm(D))}><Icon name="scoop" />Issue to a house</button>{mill}
    <button className="btn sm alt" onClick={() => ui.openForm(storeFeedInForm(D))}><Icon name="sack" />Feed received</button></>;
  if (D.me.role === 'manager') return <><button className="btn sm" onClick={() => ui.openForm(storeFeedIssueForm(D))}><Icon name="scoop" />Issue to a house</button>
    <button className="btn sm alt" onClick={() => ui.openForm(feedInForm(D))}><Icon name="sack" />Feed received</button>
    <button className="btn sm alt" onClick={() => ui.openForm(feedUseForm(D))}><Icon name="list" />Feed used (no confirm)</button>{mill}</>;
  return undefined;
}

export function Feed({ D, version, go }: ViewProps) {
  const ui = useUI();
  return <>
    <StorePending D={D} />
    <FeedCard D={D} actions={feedActions(D, ui)} />
    <Card title="Feed in store" aside={<span className="muted">shaded by buffer band</span>}><FeedStockChart D={D} /></Card>
    <Card title="Daily use vs plan"><FeedUseChart D={D} /></Card>
    {(D.raw ?? []).length > 0 && (D.me.role !== 'clerk') && <MillCard D={D} compact go={go} />}
    <Card title="Feed records"><RecordList D={D} version={version} kinds={['feed', 'mill']} canVoid={false} limit={20} /></Card>
  </>;
}

export function Water({ D, version }: ViewProps) {
  const ui = useUI(), s = D.settings, y = addDays(D.today, -1);
  const ratio = waterFeedRatio(D, range(addDays(D.today, -7), y));
  const t = tankInfo(D);
  return <>
    {canEnter(D) && <div className="row-btns"><button className="btn" onClick={() => ui.openForm(waterIntakeForm(D))}><Icon name="drop" />Water drunk</button>
      <button className="btn alt" onClick={() => ui.openForm(tankForm(D))}><Icon name="tank" />Tank level</button></div>}
    <div className="grid2">
      <TankCard D={D} />
      <Card title="Drinking by house" aside={<span className="muted">yesterday vs 7-day average</span>}><div className="list">{D.houses.map((h, i) => {
        const w = waterTrend(D, h.id), hens = hensNow(D, h.id);
        return <div className="li" key={h.id}><span className="av" style={{ background: `var(${houseColor(i)})` }}><Icon name="drop" /></span>
          <div className="mid"><b>{h.name}</b><small>{hens ? `${n0((w.yesterday / hens) * 1000)} ml per bird` : ''}{w.avg ? ` · average ${n0(w.avg)} L` : ''}</small><small>Today so far {n0(w.today)} L</small></div>
          <div className="end">{n0(w.yesterday)} L<small>{w.days >= 3 ? <Delta a={w.yesterday} b={w.avg} /> : 'building history'}</small></div></div>; })}</div>
        <div className="ok-line" style={{ background: 'var(--surface-2)' }}><Icon name="pulse" />Water to feed, last 7 days: {ratio ? `${ratio.toFixed(2)} L per kg` : 'not enough records'} (normal {s.water_ratio_min}–{s.water_ratio_max})</div>
      </Card>
    </div>
    <Card title="Water drunk per day">
      <WaterChart D={D} />
      <p className="muted" style={{ fontSize: 13, margin: '10px 0 0' }}>Laying hens normally drink about {s.water_ratio_min}–{s.water_ratio_max} litres for every kg of feed, more in hot weather. A drop of {s.water_drop_pct}% or more below the usual level raises an alert: it often shows a blocked line or sick birds a day before egg numbers fall.</p></Card>
    {t && D.tank_daily.length > 1 && <Card title="Tank level"><TankChart D={D} /></Card>}
    <Card title="Water records"><RecordList D={D} version={version} kinds={['water']} canVoid={false} limit={20} /></Card>
  </>;
}

export function Health({ D }: ViewProps) {
  const ui = useUI(), mgmt = D.me.role === 'owner' || D.me.role === 'manager';
  const W = range(addDays(D.today, -7), addDays(D.today, -1)), M = range(addDays(D.today, -30), D.today);
  const done = async (id: number, v: boolean) => { try { await rpc('rpc_schedule_done', { p_id: id, p_done: v }); ui.toast(v ? 'Marked done.' : 'Marked not done.'); } catch (e) { ui.toast((e as Error).message); } };
  return <>
    <Card title="Flocks" aside={canEnter(D) ? <button className="lnk" onClick={() => ui.openForm(mortForm(D))}>Record mortality</button> : undefined}><div className="tblw"><table>
      <thead><tr><th>House</th><th>Hens</th><th>Age</th><th>Lay 7d</th><th>Expected</th><th>Water/bird</th><th>Deaths 30d</th></tr></thead>
      <tbody>{D.houses.map((h) => { const lay = layRate(D, W, h.id), hens = hensNow(D, h.id), wpb = hens ? (waterOn(D, W, h.id) / 7 / hens) * 1000 : NaN;
        return <tr key={h.id}><td>{h.name}</td><td>{n0(hens)}</td><td>{houseAge(D, h)} wks</td>
          <td><span className={`chip ${lay < h.expected_lay - 0.04 ? 'sev-orange' : 'sev-ok'}`}>{pct(lay)}</span></td><td>{pct(h.expected_lay, 0)}</td>
          <td>{Number.isFinite(wpb) && wpb > 0 ? `${n0(wpb)} ml` : '–'}</td><td>{deaths(D, M, h.id)}</td></tr>; })}</tbody></table></div></Card>
    <MedicineStore D={D} mgmt={mgmt} />
    <Card title="Vaccination & treatment schedule" aside={mgmt ? <button className="lnk" onClick={() => ui.openForm(scheduleForm(D))}>Add task</button> : undefined}>
      {D.schedule.length ? <div>{D.schedule.map((e) => { const n = daysBetween(D.today, e.due);
        return <div className="check" key={e.id}><button className={`tick ${e.done ? 'ok' : ''}`} style={{ border: 0, cursor: 'pointer' }} aria-label={e.done ? 'Mark not done' : 'Mark done'} disabled={!canEnter(D)} onClick={() => canEnter(D) && done(e.id, !e.done)}>{e.done && <Icon name="check" />}</button>
          <div style={{ flex: 1, minWidth: 0 }}><b style={{ display: 'block', fontSize: 14.5 }}>{e.task}</b><small className="muted">{e.house} · {dlabel(e.due)}{!e.done && (n < 0 ? ` · ${-n} days overdue` : n === 0 ? ' · today' : ` · in ${n} days`)}</small></div>
          {mgmt && <button className="act" style={{ background: 'none', border: 0, color: 'var(--muted)' }} onClick={() => ui.openForm(scheduleForm(D, e))}>Edit</button>}</div>; })}</div>
        : <Empty>No vaccinations or treatments scheduled.</Empty>}</Card>
  </>;
}

const REC_KINDS: [string, string][] = [['all', 'All'], ['collect', 'Eggs'], ['feed', 'Feed'], ['water', 'Water'], ['med', 'Medicine'], ['confirm', 'From the store'], ['mort', 'Mortality'], ['xfer', 'Sent']];
export function Records({ D, version }: ViewProps) {
  const [k, setK] = useState('all');
  return <Card title="Farm records" aside={<Seg value={k} options={REC_KINDS} onChange={setK} />}>
    <RecordList D={D} version={version} loc={k === 'all' || k === 'xfer' ? 'FARM' : null} kinds={k === 'all' ? ['collect', 'feed', 'water', 'med', 'confirm', 'mort', 'xfer'] : [k]}
      canVoid={false} limit={k === 'all' ? 60 : 30} /></Card>;
}

export function MedicineStore({ D, mgmt }: { D: ViewProps['D']; mgmt: boolean }) {
  const ui = useUI();
  const [showOld, setShowOld] = useState(false);
  const list = D.medicines.filter((m) => m.active || showOld);
  const retired = D.medicines.filter((m) => !m.active).length;
  const groups = [...new Set(list.map((m) => m.category))].sort((a, b) => a.localeCompare(b));
  return <Card title="Medicine & vaccine store" aside={<div className="row-btns">
      {(D.me.role === 'store' || D.me.role === 'manager') && <button className="lnk" onClick={() => ui.openForm(storeMedIssueForm(D))}>Issue to a house</button>}
      {(D.me.role === 'store' || D.me.role === 'manager') && <button className="lnk" onClick={() => ui.openForm(storeMedInForm(D))}>Received</button>}
      {D.me.role === 'manager' && <button className="lnk" onClick={() => ui.openForm(medForm(D))}>Use (no confirm)</button>}
      {mgmt && <button className="lnk" onClick={() => ui.openForm(medicineForm(D))}>Add item</button>}</div>}>
    {list.length ? groups.map((g) => <div key={g} className="medgroup">
      <h4>{g}</h4>
      <div className="list">{list.filter((m) => m.category === g).sort((a, b) => a.name.localeCompare(b.name)).map((m) => {
        const low = m.active && m.stock <= m.reorder, lvl = Math.min(1, m.stock / Math.max(1, m.reorder * 2.5));
        return <div className={`li${m.active ? '' : ' void'}`} key={m.id}><span className="av" style={{ background: `var(${!m.active ? '--muted' : low ? '--f-low' : '--info'})` }}><Icon name="syringe" /></span>
          <div className="mid"><b>{m.name}</b>{m.active && <div className="splitbar" style={{ margin: '6px 0 2px', height: 6 }}><span style={{ width: `${lvl * 100}%`, background: `var(${low ? '--f-low' : '--f-full'})` }} /></div>}
            <small>{m.active ? `Reorder at ${n0(m.reorder)} ${m.unit}` : 'Not in use'}</small></div>
          <div className="end">{n0(m.stock)} {m.unit}{low && <small style={{ color: 'var(--f-low)' }}>Low</small>}{mgmt && <div><button className="act" onClick={() => ui.openForm(medicineForm(D, m))}>Edit</button></div>}</div></div>; })}</div>
    </div>) : <Empty>No medicines yet. The inventory clerk adds each item when its first delivery arrives.</Empty>}
    {mgmt && retired > 0 && <button className="lnk" style={{ marginTop: 8 }} onClick={() => setShowOld(!showOld)}>{showOld ? 'Hide items not in use' : `Show ${retired} item${retired === 1 ? '' : 's'} not in use`}</button>}
  </Card>;
}
