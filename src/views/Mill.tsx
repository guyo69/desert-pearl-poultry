// The farm's feed mill (4 Nov 2026): the raw material store, the recipe that
// turns each tonne milled into feed, and the store ledger. The inventory clerk
// records deliveries, millings and counts; the owner and farm manager can
// change the recipe, which must always add up to 1,000 kg a tonne.
import { useState } from 'react';
import { n0, pct } from '../lib/format';
import { canEnter, millInfo } from '../lib/metrics';
import type { Dashboard } from '../lib/types';
import { millForm, rawCountForm, rawInForm, recipeForm } from '../forms/forms';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { Card, Empty, Seg } from '../ui/widgets';
import { MillChart } from './charts';
import { RecordList } from './common';
import type { ViewProps } from './Management';

const t1 = (t: number) => (Math.floor(t * 10) / 10).toLocaleString('en-KE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const canMill = (D: Dashboard) => canEnter(D) && (D.me.role === 'store' || D.me.role === 'manager');

/** What the raw material store can make now, material by material. `compact` for home screens. */
export function MillCard({ D, compact, go }: { D: Dashboard; compact?: boolean; go?: (t: string) => void }) {
  const ui = useUI(), m = millInfo(D);
  if (!m.mats.length) return null;
  const head = !m.started ? 'Nothing recorded in the raw material store yet'
    : m.limit && m.cap < 0.05 ? `${m.limit.name} has run out` : `Enough to mill ${t1(m.cap)} tonnes`;
  const sub = !m.started ? 'Record what is in the store with Count the store, then deliveries and millings as they happen.'
    : `${m.limit ? `${m.limit.name} runs out first` : ''}${m.days != null ? ` · about ${n0(m.days)} day${Math.round(m.days) === 1 ? '' : 's'} at ${t1(m.rate)} tonnes a day` : ''}${m.todayTonnes ? ` · ${t1(m.todayTonnes)} tonnes milled today` : ''}`;
  const low = m.started && m.cap < m.batch;
  return <Card tip={compact ? undefined : 'mill'} title="Raw material store" aside={go ? <button className="lnk" onClick={() => go('mill')}>Feed mill</button> : <span className="muted">{m.mats.length} materials</span>}>
    <div className={`banner ${low ? 'warn' : 'info'}`} style={{ margin: '0 0 10px' }}><div><b>{head}</b><p>{sub}{low && m.started ? `. A usual batch is ${t1(m.batch)} tonnes.` : ''}</p></div></div>
    {!m.recipeOk && <div className="banner warn" style={{ margin: '0 0 10px' }}><div><b>The recipe adds up to {n0(m.recipeKg)} kg</b><p>It must be 1,000 kg a tonne before anything can be milled. The farm manager fixes it under Feed mill.</p></div></div>}
    {!compact && <div className="list">{m.mats.map((x) => {
      const e = m.each.find((y) => y.id === x.id), tonnes = e?.tonnes ?? null, lim = m.limit?.id === x.id && m.started;
      const lvl = tonnes == null ? 0 : Math.min(1, tonnes / Math.max(m.batch * 3, 1));
      return <div className="li" key={x.id}><span className="av" style={{ background: `var(${lim ? '--f-low' : '--info'})` }}><Icon name="sack" /></span>
        <div className="mid"><b>{x.name}</b>
          {tonnes != null && <div className="splitbar" style={{ margin: '6px 0 2px', height: 6 }}><span style={{ width: `${lvl * 100}%`, background: `var(${tonnes < m.batch ? '--f-low' : '--f-full'})` }} /></div>}
          <small>{n0(x.per_tonne)} kg a tonne{tonnes != null ? ` · enough for ${t1(tonnes)} tonnes` : ' · not in the recipe'}</small></div>
        <div className="end">{n0(x.stock)} kg<small>{n0(x.stock / x.bag_kg)} bags of {n0(x.bag_kg)} kg</small>
          {canMill(D) && <div><button className="act" onClick={() => ui.openForm(rawCountForm(D, x))}>Count</button></div>}</div></div>;
    })}</div>}
    {canMill(D) && <div className="row-btns" style={{ marginTop: 10 }}>
      <button className="btn sm" onClick={() => ui.openForm(millForm(D))}><Icon name="scoop" />Feed milled</button>
      <button className="btn sm alt" onClick={() => ui.openForm(rawInForm(D))}><Icon name="truck" />Raw material received</button>
      {!compact && <button className="btn sm alt" onClick={() => ui.openForm(rawCountForm(D))}><Icon name="count" />Count the store</button>}</div>}
  </Card>;
}

/** The recipe: kg of each raw material in one tonne of feed. */
export function RecipeCard({ D }: { D: Dashboard }) {
  const ui = useUI(), m = millInfo(D), can = D.me.role === 'owner' || D.me.role === 'manager';
  const list = m.mats.filter((x) => x.per_tonne > 0);
  return <Card title="Recipe for a tonne of layers feed" aside={can ? <button className="lnk" onClick={() => ui.openForm(recipeForm(D))}>Change the recipe</button> : undefined}>
    {list.length ? <div className="tblw"><table>
      <thead><tr><th>Raw material</th><th>kg a tonne</th><th>Share</th><th>For a {t1(m.batch)} t batch</th></tr></thead>
      <tbody>{list.map((x) => <tr key={x.id}><td>{x.name}</td><td>{n0(x.per_tonne)}</td><td>{pct(x.per_tonne / 1000, 1)}</td><td>{n0(x.per_tonne * m.batch)} kg</td></tr>)}
        <tr><td><b>Total</b></td><td><b>{n0(m.recipeKg)}</b></td><td><b>{pct(m.recipeKg / 1000, 0)}</b></td><td><b>{n0(m.recipeKg * m.batch)} kg</b></td></tr></tbody></table></div>
      : <Empty>No recipe yet.</Empty>}
    <p className="muted" style={{ fontSize: 13, margin: '10px 0 0' }}>Every milling takes each raw material out of the store by this recipe and puts the feed into the feed store in bags of {n0(D.settings.bag_kg)} kg. A change applies to the next milling; earlier millings keep the recipe they used.</p>
  </Card>;
}

const KINDS: [string, string][] = [['all', 'All'], ['mill', 'Milling'], ['raw', 'Deliveries and counts']];
export function Mill({ D, version }: ViewProps) {
  const [k, setK] = useState('all'), m = millInfo(D);
  return <>
    <MillCard D={D} />
    <RecipeCard D={D} />
    {(D.mill_daily ?? []).length > 0 && <Card title="Feed milled" aside={<span className="muted">{t1(m.t7)} tonnes in the last 7 days</span>}><MillChart D={D} /></Card>}
    <Card title="Mill records" aside={<Seg value={k} options={KINDS} onChange={setK} />}>
      <RecordList D={D} version={version} kinds={k === 'all' ? ['mill', 'raw'] : [k]} canVoid={false} limit={k === 'all' ? 40 : 30} /></Card>
    <p className="muted" style={{ fontSize: 13, margin: '0 4px' }}>The monthly workbook has a Store ledger tab with every raw material on each day it moved, as on the inventory clerk's ledger, and a Feed tab with what was milled, bought and given to each house. The owner and farm manager download it under Settings.</p>
  </>;
}
