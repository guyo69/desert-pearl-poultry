// Production clerk screens: home tiles, feed, water, flock health, records.
import { useState } from 'react';
import { rpc } from '../lib/api';
import { addDays, daysBetween, dlabel, eggs, n0, pct, range } from '../lib/format';
import { collected, deaths, feedInfo, hensNow, houseAge, layRate, stockNow, tankInfo, tot, waterFeedRatio, waterOn, waterTrend } from '../lib/metrics';
import {
  collectForm, dispatchForm, feedInForm, feedUseForm, medForm, medicineForm, mortForm, scheduleForm, tankForm, waterIntakeForm,
} from '../forms/forms';
import { ChartBox } from '../ui/Chart';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { Card, Delta, Empty, FeedCard, Legend, RangeSeg, Seg, TankCard, Tile } from '../ui/widgets';
import { feedStockChart, feedUseChart, houseColor, tankChart, waterChart } from './charts';
import { RecordList } from './common';
import type { ViewProps } from './Management';

export function ClerkHome({ D, version, go }: ViewProps) {
  const ui = useUI(), farm = stockNow(D, 'FARM');
  if (!D.houses.some((h) => h.birds_at_start > 0)) return <div className="banner warn"><div><b>No hens set up yet</b><p>The owner or farm manager needs to enter each house's hen count under Settings → Houses.</p></div></div>;
  return <>
    <FeedCard D={D} actions={<><button className="btn sm" onClick={() => ui.openForm(feedUseForm(D))}><Icon name="scoop" />Feed used</button>
      <button className="btn sm alt" onClick={() => ui.openForm(feedInForm(D))}><Icon name="sack" />Feed received</button></>} />
    <div className="tiles">
      <Tile icon="egg" label="Egg collection" color="--l-van" onClick={() => ui.openForm(collectForm(D))} />
      <Tile icon="scoop" label="Feed used" color="--f-low" onClick={() => ui.openForm(feedUseForm(D))} />
      <Tile icon="drop" label="Water drunk" color="--info" onClick={() => ui.openForm(waterIntakeForm(D))} />
      <Tile icon="tank" label="Tank level" color="--l-tuala" onClick={() => ui.openForm(tankForm(D))} />
      <Tile icon="syringe" label="Medicine & vaccines" color="--l-rayan" onClick={() => ui.openForm(medForm(D))} />
      <Tile icon="bird" label="Mortality" color="--muted" onClick={() => ui.openForm(mortForm(D))} />
      <Tile icon="truck" label="Send eggs" color="--l-farm" onClick={() => ui.openForm(dispatchForm(D, 'FARM'))} />
      <Tile icon="sack" label="Feed received" color="--l-lucky" onClick={() => ui.openForm(feedInForm(D))} />
    </div>
    <div className="grid2">
      <Card title="Today by house" aside={<span className="muted">{dlabel(D.today)}</span>}><div className="list">{D.houses.map((h, i) => {
        const q = collected(D, [D.today], h.id), hens = hensNow(D, h.id), w = waterTrend(D, h.id);
        return <div className="li" key={h.id}><span className="av" style={{ background: `var(${houseColor(i)})` }}><Icon name="egg" /></span>
          <div className="mid"><b>{h.name}</b><small>{hens} hens · {q.c} cracked · {q.j} jumbo</small><small>Water today {n0(w.today)} L{w.avg ? ` · usual ${n0(w.avg)} L/day` : ''}</small></div>
          <div className="end">{eggs(tot(q))}<small>{hens ? pct(tot(q) / hens) : '–'} so far</small></div></div>; })}</div></Card>
      <TankCard D={D} actions={<button className="btn sm alt" onClick={() => ui.openForm(tankForm(D))}><Icon name="tank" />Record tank level</button>} />
    </div>
    <Card title="Farm egg store" aside={<span className="muted">available to send</span>}>
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
        <div className="kpi"><div className="lbl">Normal</div><div className="val">{eggs(farm.n)}</div></div>
        <div className="kpi"><div className="lbl">Cracked</div><div className="val">{farm.c} pc</div></div>
        <div className="kpi"><div className="lbl">Jumbo</div><div className="val">{farm.j} pc</div></div>
      </div></Card>
    <Card title="Recent records" aside={<button className="lnk" onClick={() => go('records')}>All records</button>}>
      <RecordList D={D} version={version} loc="FARM" canVoid={false} limit={8} /></Card>
  </>;
}

export function Feed({ D, version }: ViewProps) {
  const ui = useUI(), [n, setN] = useState(30), f = feedInfo(D);
  return <>
    <FeedCard D={D} actions={<><button className="btn sm" onClick={() => ui.openForm(feedUseForm(D))}><Icon name="scoop" />Feed used</button>
      <button className="btn sm alt" onClick={() => ui.openForm(feedInForm(D))}><Icon name="sack" />Feed received</button></>} />
    <Card title="Feed in store" aside={<RangeSeg value={n} onChange={setN} />}>
      <ChartBox height={280} label="Feed in store, coloured by buffer band" config={feedStockChart(D, n)} />
      <Legend items={[['--f-full', 'Full buffer'], ['--f-good', 'Good'], ['--f-watch', 'Watch'], ['--f-low', 'Low'], ['--f-none', 'No buffer']]} /></Card>
    <Card title="Daily use vs plan" aside={<span className="muted">kg · plan {n0(f.target / 7)} kg/day</span>}><ChartBox height={190} label="Daily feed use" config={feedUseChart(D, n)} /></Card>
    <Card title="Feed records"><RecordList D={D} version={version} kinds={['feed']} canVoid={D.me.role === 'owner' || D.me.role === 'manager'} limit={20} /></Card>
  </>;
}

export function Water({ D, version }: ViewProps) {
  const ui = useUI(), [n, setN] = useState(14), s = D.settings, y = addDays(D.today, -1);
  const ratio = waterFeedRatio(D, range(addDays(D.today, -7), y));
  const t = tankInfo(D);
  return <>
    <div className="row-btns"><button className="btn" onClick={() => ui.openForm(waterIntakeForm(D))}><Icon name="drop" />Water drunk</button>
      <button className="btn alt" onClick={() => ui.openForm(tankForm(D))}><Icon name="tank" />Tank level</button></div>
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
    <Card title="Water drunk per day" aside={<RangeSeg value={n} onChange={setN} />}>
      <ChartBox height={260} label="Water drunk per day by house" config={waterChart(D, n)} />
      <Legend items={[...D.houses.map((h, i): [string, string] => [houseColor(i), h.name]), ['--fg', 'L per kg feed']]} />
      <p className="muted" style={{ fontSize: 13, margin: '10px 0 0' }}>Laying hens normally drink about {s.water_ratio_min}–{s.water_ratio_max} litres for every kg of feed, more in hot weather. A drop of {s.water_drop_pct}% or more below the usual level raises an alert: it often shows a blocked line or sick birds a day before egg numbers fall.</p></Card>
    {t && D.tank_daily.length > 1 && <Card title="Tank level readings" aside={<span className="muted">last reading each day</span>}><ChartBox height={200} label="Tank level readings" config={tankChart(D)} /></Card>}
    <Card title="Water records"><RecordList D={D} version={version} kinds={['water']} canVoid={D.me.role === 'owner' || D.me.role === 'manager'} limit={20} /></Card>
  </>;
}

export function Health({ D }: ViewProps) {
  const ui = useUI(), mgmt = D.me.role === 'owner' || D.me.role === 'manager';
  const W = range(addDays(D.today, -7), addDays(D.today, -1)), M = range(addDays(D.today, -30), D.today);
  const done = async (id: number, v: boolean) => { try { await rpc('rpc_schedule_done', { p_id: id, p_done: v }); ui.toast(v ? 'Marked done.' : 'Marked not done.'); } catch (e) { ui.toast((e as Error).message); } };
  return <>
    <Card title="Flocks" aside={<button className="lnk" onClick={() => ui.openForm(mortForm(D))}>Record mortality</button>}><div className="tblw"><table>
      <thead><tr><th>House</th><th>Hens</th><th>Age</th><th>Lay 7d</th><th>Expected</th><th>Water/bird</th><th>Deaths 30d</th></tr></thead>
      <tbody>{D.houses.map((h) => { const lay = layRate(D, W, h.id), hens = hensNow(D, h.id), wpb = hens ? (waterOn(D, W, h.id) / 7 / hens) * 1000 : NaN;
        return <tr key={h.id}><td>{h.name}</td><td>{n0(hens)}</td><td>{houseAge(D, h)} wks</td>
          <td><span className={`chip ${lay < h.expected_lay - 0.04 ? 'sev-orange' : 'sev-ok'}`}>{pct(lay)}</span></td><td>{pct(h.expected_lay, 0)}</td>
          <td>{Number.isFinite(wpb) && wpb > 0 ? `${n0(wpb)} ml` : '–'}</td><td>{deaths(D, M, h.id)}</td></tr>; })}</tbody></table></div></Card>
    <Card title="Medicine & vaccine store" aside={<div className="row-btns"><button className="lnk" onClick={() => ui.openForm(medForm(D))}>Record use or delivery</button>{mgmt && <button className="lnk" onClick={() => ui.openForm(medicineForm())}>Add item</button>}</div>}>
      {D.medicines.length ? <div className="list">{D.medicines.filter((m) => m.active).map((m) => { const low = m.stock <= m.reorder, lvl = Math.min(1, m.stock / Math.max(1, m.reorder * 2.5));
        return <div className="li" key={m.id}><span className="av" style={{ background: `var(${low ? '--f-low' : '--info'})` }}><Icon name="syringe" /></span>
          <div className="mid"><b>{m.name}</b><div className="splitbar" style={{ margin: '6px 0 2px', height: 6 }}><span style={{ width: `${lvl * 100}%`, background: `var(${low ? '--f-low' : '--f-full'})` }} /></div><small>Reorder at {n0(m.reorder)} {m.unit}</small></div>
          <div className="end">{n0(m.stock)} {m.unit}{low && <small style={{ color: 'var(--f-low)' }}>Low</small>}{mgmt && <div><button className="act" onClick={() => ui.openForm(medicineForm(m))}>Edit</button></div>}</div></div>; })}</div>
        : <Empty>No medicines set up yet.</Empty>}</Card>
    <Card title="Vaccination & treatment schedule" aside={mgmt ? <button className="lnk" onClick={() => ui.openForm(scheduleForm(D))}>Add task</button> : undefined}>
      {D.schedule.length ? <div>{D.schedule.map((e) => { const n = daysBetween(D.today, e.due);
        return <div className="check" key={e.id}><button className={`tick ${e.done ? 'ok' : ''}`} style={{ border: 0, cursor: 'pointer' }} aria-label={e.done ? 'Mark not done' : 'Mark done'} onClick={() => done(e.id, !e.done)}>{e.done && <Icon name="check" />}</button>
          <div style={{ flex: 1, minWidth: 0 }}><b style={{ display: 'block', fontSize: 14.5 }}>{e.task}</b><small className="muted">{e.house} · {dlabel(e.due)}{!e.done && (n < 0 ? ` · ${-n} days overdue` : n === 0 ? ' · today' : ` · in ${n} days`)}</small></div>
          {mgmt && <button className="act" style={{ background: 'none', border: 0, color: 'var(--muted)' }} onClick={() => ui.openForm(scheduleForm(D, e))}>Edit</button>}</div>; })}</div>
        : <Empty>No vaccinations or treatments scheduled.</Empty>}</Card>
  </>;
}

const REC_KINDS: [string, string][] = [['all', 'All'], ['collect', 'Eggs'], ['feed', 'Feed'], ['water', 'Water'], ['med', 'Medicine'], ['mort', 'Mortality'], ['xfer', 'Sent']];
export function Records({ D, version }: ViewProps) {
  const [k, setK] = useState('all');
  return <Card title="Farm records" aside={<Seg value={k} options={REC_KINDS} onChange={setK} />}>
    <RecordList D={D} version={version} loc={k === 'all' || k === 'xfer' ? 'FARM' : null} kinds={k === 'all' ? ['collect', 'feed', 'water', 'med', 'mort', 'xfer'] : [k]}
      canVoid={D.me.role === 'owner' || D.me.role === 'manager'} limit={k === 'all' ? 60 : 30} /></Card>;
}
