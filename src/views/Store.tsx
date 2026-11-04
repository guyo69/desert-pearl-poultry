// The inventory clerk's screens: the farm store (feed, medicine, other
// supplies), what still waits for the production clerk, and the store records.
import { useState } from 'react';
import { n0 } from '../lib/format';
import { feedInfo } from '../lib/metrics';
import type { Dashboard } from '../lib/types';
import { storeFeedInForm, storeFeedIssueForm, millForm, rawInForm, storeMedInForm, storeMedIssueForm, supplyForm, supplyInForm, supplyOutForm } from '../forms/forms';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { Card, Empty, FeedCard, Seg, Tile } from '../ui/widgets';
import { RecordList } from './common';
import { MedicineStore, StorePending } from './Farm';
import { MillCard } from './Mill';
import type { ViewProps } from './Management';

export function StoreHome({ D, version, go }: ViewProps) {
  const ui = useUI(), f = feedInfo(D);
  const lowMeds = D.medicines.filter((m) => m.active && m.stock <= m.reorder);
  const lowSup = (D.supplies ?? []).filter((x) => x.active && x.stock <= x.reorder);
  return <>
    <div className="tiles">
      <Tile icon="scoop" label="Issue feed" color="--f-low" onClick={() => ui.openForm(storeFeedIssueForm(D))} />
      {(D.raw ?? []).length > 0 && <Tile icon="pulse" label="Feed milled" color="--f-full" onClick={() => ui.openForm(millForm(D))} />}
      {(D.raw ?? []).length > 0 && <Tile icon="truck" label="Raw material received" color="--l-lucky" onClick={() => ui.openForm(rawInForm(D))} />}
      <Tile icon="sack" label="Feed received" color="--l-lucky" onClick={() => ui.openForm(storeFeedInForm(D))} />
      <Tile icon="syringe" label="Issue medicine" color="--l-rayan" onClick={() => ui.openForm(storeMedIssueForm(D))} />
      <Tile icon="inbox" label="Medicine received" color="--info" onClick={() => ui.openForm(storeMedInForm(D))} />
      <Tile icon="box" label="Issue supplies" color="--l-tuala" onClick={() => ui.openForm(supplyOutForm(D))} />
      <Tile icon="truck" label="Supplies received" color="--l-farm" onClick={() => ui.openForm(supplyInForm(D))} />
    </div>
    <StorePending D={D} />
    <MillCard D={D} compact go={go} />
    <FeedCard D={D} actions={<><button className="btn sm" onClick={() => ui.openForm(storeFeedIssueForm(D))}><Icon name="scoop" />Issue to a house</button>
      <button className="btn sm alt" onClick={() => ui.openForm(storeFeedInForm(D))}><Icon name="sack" />Feed received</button></>} />
    {(lowMeds.length > 0 || lowSup.length > 0) && <Card title="Running low" aside={<button className="lnk" onClick={() => go('meds')}>Store items</button>}>
      <div className="list">{[...lowMeds.map((m) => ({ k: `m${m.id}`, name: m.name, stock: m.stock, unit: m.unit, reorder: m.reorder })),
        ...lowSup.map((x) => ({ k: `s${x.id}`, name: x.name, stock: x.stock, unit: x.unit, reorder: x.reorder }))].map((x) =>
        <div className="li" key={x.k}><span className="av" style={{ background: 'var(--f-low)' }}><Icon name="alert" /></span>
          <div className="mid"><b>{x.name}</b><small>Reorder at {n0(x.reorder)} {x.unit}. Tell the farm manager.</small></div>
          <div className="end">{n0(x.stock)} {x.unit}</div></div>)}</div></Card>}
    {f.stock <= 0 && <div className="banner warn"><div><b>The feed book shows no feed</b><p>Record the bags in the store with Feed received so the book matches what is there.</p></div></div>}
    <Card title="Recent store records" aside={<button className="lnk" onClick={() => go('srecords')}>All records</button>}>
      <RecordList D={D} version={version} kinds={['feed', 'mill', 'raw', 'med', 'supply', 'confirm']} canVoid={false} limit={12} /></Card>
  </>;
}

export function Supplies({ D }: { D: Dashboard }) {
  const ui = useUI(), [old, setOld] = useState(false);
  const all = D.supplies ?? [], list = all.filter((x) => x.active || old), retired = all.filter((x) => !x.active).length;
  const canMove = D.me.role === 'store' || D.me.role === 'manager';
  const canEdit = canMove || D.me.role === 'owner';
  const groups = [...new Set(list.map((x) => x.category))].sort();
  return <Card title="Other supplies" aside={canMove ? <div className="row-btns">
      <button className="lnk" onClick={() => ui.openForm(supplyOutForm(D))}>Issue</button>
      <button className="lnk" onClick={() => ui.openForm(supplyInForm(D))}>Received</button></div> : undefined}>
    {list.length ? groups.map((g) => <div key={g} className="medgroup"><h4>{g}</h4>
      <div className="list">{list.filter((x) => x.category === g).map((x) => {
        const low = x.active && x.stock <= x.reorder;
        return <div className={`li${x.active ? '' : ' void'}`} key={x.id}><span className="av" style={{ background: `var(${!x.active ? '--muted' : low ? '--f-low' : '--l-tuala'})` }}><Icon name="box" /></span>
          <div className="mid"><b>{x.name}</b><small>{x.active ? `Reorder at ${n0(x.reorder)} ${x.unit}` : 'Not in use'}</small></div>
          <div className="end">{n0(x.stock)} {x.unit}{low && <small style={{ color: 'var(--f-low)' }}>Low</small>}
            {canEdit && <div><button className="act" onClick={() => ui.openForm(supplyForm(D, x))}>Edit</button></div>}</div></div>; })}</div></div>)
      : <Empty>No supplies yet. Use Received when the first delivery of trays, packaging or cleaning items arrives.</Empty>}
    {retired > 0 && <button className="lnk" style={{ marginTop: 8 }} onClick={() => setOld(!old)}>{old ? 'Hide items not in use' : `Show ${retired} not in use`}</button>}
  </Card>;
}

/** Medicine and other supplies in one screen. */
export function StoreItems({ D }: ViewProps) {
  return <><MedicineStore D={D} mgmt={D.me.role === 'owner' || D.me.role === 'manager'} /><Supplies D={D} /></>;
}

const KINDS: [string, string][] = [['all', 'All'], ['feed', 'Feed'], ['mill', 'Milling'], ['raw', 'Raw materials'], ['med', 'Medicine'], ['supply', 'Supplies'], ['confirm', 'Confirmed']];
export function StoreRecords({ D, version }: ViewProps) {
  const [k, setK] = useState('all');
  return <Card title="Store records" aside={<Seg value={k} options={KINDS} onChange={setK} />}>
    <RecordList D={D} version={version} kinds={k === 'all' ? ['feed', 'mill', 'raw', 'med', 'supply', 'confirm'] : [k]} canVoid={false} limit={k === 'all' ? 60 : 30} /></Card>;
}
