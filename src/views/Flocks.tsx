// Houses and the flocks in them (5 Nov 2026). The owner, farm manager and
// production clerk can add a house for an expansion, place a new flock,
// correct the breed, age or target of the flock in a house, or record that a
// house was emptied. Earlier flocks keep their records.
import { useState } from 'react';
import { dlabel, n0 } from '../lib/format';
import { houseAge, hensNow } from '../lib/metrics';
import type { Dashboard } from '../lib/types';
import { flockEditForm, flockEndForm, flockForm, houseForm, houseNewForm } from '../forms/forms';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { Card, Empty } from '../ui/widgets';

export const canFlock = (D: Dashboard) => ['owner', 'manager', 'clerk'].includes(D.me.role);

export function HousesFlocks({ D }: { D: Dashboard }) {
  const ui = useUI(), [old, setOld] = useState(false), can = canFlock(D), mgmt = D.me.role === 'owner' || D.me.role === 'manager';
  const past = (D.flocks ?? []).filter((f) => f.ended_on).sort((a, b) => b.placed_on.localeCompare(a.placed_on));
  const houseName = (id: string) => D.houses.find((h) => h.id === id)?.name ?? id;
  return <Card title="Houses and flocks" aside={can ? <div className="row-btns">
      <button className="lnk" onClick={() => ui.openForm(flockForm(D))}><Icon name="bird" />New flock</button>
      <button className="lnk" onClick={() => ui.openForm(houseNewForm(D))}><Icon name="plus" />Add house</button></div> : undefined}>
    {D.houses.length ? <div className="list">{D.houses.map((h) => { const empty = !(h.birds_at_start > 0);
      return <div className="li house-li" key={h.id}><span className="av" style={{ background: `var(${empty ? '--muted' : '--l-van'})` }}><Icon name="bird" /></span>
        <div className="mid"><b>{h.name}{empty ? '' : ` · ${h.breed || 'breed not set'}`}</b>
          <small>{empty ? 'Empty' : `${n0(hensNow(D, h.id))} hens · ${houseAge(D, h)} weeks old · placed ${dlabel(h.start_date)} · expected lay ${Math.round(h.expected_lay * 100)}%`}</small>
          {can && <div className="row-btns" style={{ marginTop: 8 }}>
            <button className="lnk" onClick={() => ui.openForm(flockForm(D, h.id))}>New flock</button>
            {!empty && <button className="lnk" onClick={() => ui.openForm(flockEditForm(D, h.id))}>Edit flock</button>}
            {!empty && <button className="lnk" onClick={() => ui.openForm(flockEndForm(D, h.id))}>Empty</button>}
            {mgmt && <button className="lnk" onClick={() => ui.openForm(houseForm(D, h))}>Rename</button>}</div>}</div></div>; })}</div>
      : <Empty>No houses yet. Add the first house, then place its flock.</Empty>}
    {past.length > 0 && <>
      <button className="lnk" style={{ marginTop: 12 }} onClick={() => setOld(!old)}>{old ? 'Hide earlier flocks' : `Earlier flocks (${past.length})`}</button>
      {old && <div className="list" style={{ marginTop: 8 }}>{past.map((f) => <div className="li" key={f.id}>
        <span className="av" style={{ background: 'var(--muted)' }}><Icon name="bird" /></span>
        <div className="mid"><b>{houseName(f.house_id)}{f.breed ? ` · ${f.breed}` : ''}</b><small>{dlabel(f.placed_on)} to {dlabel(f.ended_on!)}{f.end_note ? ` · ${f.end_note}` : ''}</small></div>
        <div className="end">{n0(f.hens)} hens<small>{n0(f.age_weeks)} wks when placed</small></div></div>)}</div>}</>}
  </Card>;
}
