// Account (everyone), plus owner setup: staff, prices & thresholds, houses, opening balances, activity log.
import { useEffect, useState } from 'react';
import { rpc, staffAdmin } from '../lib/api';
import { dnum, n0 } from '../lib/format';
import { disablePush, enablePush, pushStatus } from '../lib/push';
import type { Settings as S, StaffLite } from '../lib/types';
import { changePinForm, houseForm, openingForm, staffForm } from '../forms/forms';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { Card, Empty, Seg } from '../ui/widgets';
import { RecordList } from './common';
import type { ViewProps } from './Management';

const ROLE: Record<string, string> = { owner: 'Owner', manager: 'Farm Manager', clerk: 'Production Clerk', pos: 'Sales point' };

export function Account({ D, signOut }: { D: ViewProps['D']; signOut: () => void }) {
  const ui = useUI();
  const [push, setPush] = useState<string>('…');
  useEffect(() => { pushStatus().then(setPush).catch(() => setPush('unsupported')); }, []);
  const togglePush = async () => {
    try { if (push === 'on') { await disablePush(); ui.toast('Phone notifications turned off.'); } else { await enablePush(); ui.toast('Phone notifications are on.'); } setPush(await pushStatus()); }
    catch (e) { ui.toast((e as Error).message); }
  };
  return <Card title="My account" aside={<span className="muted">{D.me.display_name} · {ROLE[D.me.role]}</span>}>
    <div className="list">
      <div className="li"><span className="av" style={{ background: 'var(--primary)' }}><Icon name="lock" /></span><div className="mid"><b>PIN</b><small>{D.me.must_change_pin ? 'You are still using the default PIN 0000.' : 'Your own PIN is set.'}</small></div>
        <button className={`btn sm ${D.me.must_change_pin ? 'yolk' : 'alt'}`} onClick={() => ui.openForm(changePinForm())}>Change PIN</button></div>
      <div className="li"><span className="av" style={{ background: 'var(--info)' }}><Icon name="bell" /></span><div className="mid"><b>Phone notifications</b>
        <small>{push === 'on' ? 'On for this phone.' : push === 'denied' ? 'Blocked in the browser settings.' : push === 'unsupported' ? 'Not available here. On iPhone, add the app to the Home Screen first.' : 'Alerts such as low feed arrive even when the app is closed.'}</small></div>
        {push !== 'unsupported' && push !== 'denied' && <button className="btn sm alt" onClick={togglePush}>{push === 'on' ? 'Turn off' : 'Turn on'}</button>}</div>
      <div className="li"><span className="av" style={{ background: 'var(--muted)' }}><Icon name="logout" /></span><div className="mid"><b>Sign out</b><small>Use this on a shared phone.</small></div>
        <button className="btn sm alt" onClick={signOut}>Sign out</button></div>
    </div></Card>;
}

function Staff({ D }: ViewProps) {
  const ui = useUI();
  const [rows, setRows] = useState<(StaffLite & { locked_until?: string })[] | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => { staffAdmin<{ staff: any[] }>({ action: 'list' }).then((r) => setRows(r.staff)).catch((e) => ui.toast(e.message)); }, [n, D]);
  const reset = async (s: StaffLite) => {
    try { await staffAdmin({ action: 'reset_pin', staff_id: s.id }); ui.toast(`${s.display_name}'s PIN is now 0000. Ask them to change it.`); setN(n + 1); }
    catch (e) { ui.toast((e as Error).message); }
  };
  return <Card title="Staff" aside={<button className="lnk" onClick={() => ui.openForm(staffForm(D))}>Add staff</button>}>
    {!rows ? <div className="center" style={{ minHeight: 100 }}><div className="spinner" /></div> : <div className="list">{rows.map((s) => {
      const locked = s.locked_until && new Date(s.locked_until) > new Date();
      return <div className="li" key={s.id} style={s.active ? undefined : { opacity: 0.55 }}>
        <span className="av" style={{ background: 'var(--surface-2)', color: 'var(--fg)' }}><Icon name="user" /></span>
        <div className="mid"><b>{s.display_name}</b><small>{ROLE[s.role]}{s.location_id ? ` · ${D.locations.find((l) => l.id === s.location_id)?.name}` : ''}{!s.active ? ' · disabled' : ''}</small>
          <small>{locked ? 'Locked after wrong PINs' : s.must_change_pin ? 'Still on default PIN 0000' : 'Own PIN set'}</small></div>
        <div className="end"><button className="act" onClick={() => ui.openForm(staffForm(D, s))}>Edit</button><button className="act" onClick={() => reset(s)}>Reset PIN</button></div></div>; })}</div>}
    <p className="muted" style={{ fontSize: 13, margin: '10px 0 0' }}>Reset PIN sets it back to 0000 and unlocks the account. Five wrong PINs lock an account for 15 minutes.</p></Card>;
}

const FIELDS: [keyof S, string, string][] = [
  ['tray_n', 'Normal eggs, per tray of 30', 'KES'], ['pc_n', 'Normal eggs, loose', 'KES each'], ['tray_c', 'Cracked eggs, per tray', 'KES'], ['pc_j', 'Jumbo eggs', 'KES each'],
  ['feed_buffer_kg', 'Feed buffer (weekly need)', 'kg'], ['bag_kg', 'Feed bag size', 'kg'], ['bag_price', 'Feed price per bag', 'KES'],
  ['tank_capacity_l', 'Water tank size', 'L'], ['water_drop_pct', 'Water drop alert', '%'], ['water_ratio_min', 'Water per kg feed, lowest normal', 'L'], ['water_ratio_max', 'Water per kg feed, highest normal', 'L'],
  ['unbanked_max', 'Unbanked cash limit', 'KES'], ['cash_tol', 'Cash variance alert', 'KES'], ['break_tol', 'Breakage tolerance', '%'], ['lay_drop_pts', 'Lay rate drop alert', 'points'],
];
function Thresholds({ D }: ViewProps) {
  const ui = useUI();
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map(([k]) => [k, String(D.settings[k] ?? '')])));
  const save = async () => {
    const p: Record<string, number> = {};
    for (const [k, l] of FIELDS) { const x = Number(v[k]); if (!(x > 0)) { ui.toast(`${l} must be more than 0.`); return; } p[k] = x; }
    try { await rpc('rpc_save_settings', { p }); ui.toast('Settings saved. Dashboards recalculated.'); } catch (e) { ui.toast((e as Error).message); }
  };
  return <Card title="Prices & thresholds">
    <div className="pair">{FIELDS.map(([k, l, suf]) => <label className="fld" key={k}><span>{l}</span><div className="inp"><input id={`set_${k}`} type="number" min={0} step="any" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /><em>{suf}</em></div></label>)}</div>
    <div className="row-btns" style={{ marginTop: 14 }}><button className="btn" onClick={save}><Icon name="check" />Save settings</button></div>
    <p className="muted" style={{ fontSize: 13, margin: '10px 0 0' }}>The feed buffer and tank size drive the colour scale: Full at 100% or more, Good 75–99%, Watch 50–74%, Low 25–49%, No buffer below 25%.</p></Card>;
}

function Houses({ D }: ViewProps) {
  const ui = useUI();
  return <Card title="Houses" aside={<button className="lnk" onClick={() => ui.openForm(houseForm(D))}>Add house</button>}>
    {D.houses.length ? <div className="tblw"><table><thead><tr><th>House</th><th>Hens at start</th><th>Start date</th><th>Expected lay</th><th></th></tr></thead>
      <tbody>{D.houses.map((h) => <tr key={h.id}><td>{h.name}</td><td>{n0(h.birds_at_start)}</td><td>{dnum(h.start_date)}</td><td>{Math.round(h.expected_lay * 100)}%</td>
        <td><button className="btn sm alt" onClick={() => ui.openForm(houseForm(D, h))}>Edit</button></td></tr>)}</tbody></table></div> : <Empty>No houses yet.</Empty>}</Card>;
}

export function Setup(p: ViewProps & { signOut: () => void }) {
  const { D, version } = p, ui = useUI();
  const [sec, setSec] = useState<'activity' | 'setup'>('activity');
  const [loc, setLoc] = useState<string>('all');
  const owner = D.me.role === 'owner';
  return <>
    {owner && <Seg value={sec} options={[['activity', 'Activity log'], ['setup', 'Setup']]} onChange={setSec} />}
    {sec === 'activity' ? <Card title="Activity log" aside={<Seg value={loc} options={[['all', 'All'], ...D.locations.map((l): [string, string] => [l.id, l.short])]} onChange={setLoc} />}>
      <RecordList D={D} version={version} loc={loc === 'all' ? null : loc} canVoid limit={40} />
      <p className="muted" style={{ fontSize: 13, margin: '10px 0 0' }}>Records are never deleted. Correct marks a record as wrong; stock and money are recalculated without it.</p></Card>
    : <>
      {!D.settings.go_live && <div className="banner warn"><div><b>Enter opening balances</b><p>On go-live morning, count eggs at every location, cash, M-Pesa and bank balances, feed and water, then enter them here.</p></div>
        <button className="btn yolk" onClick={() => ui.openForm(openingForm(D))}>Opening balances</button></div>}
      <Houses {...p} />
      <Staff {...p} />
      <Thresholds {...p} />
      {D.settings.go_live && <Card title="Opening balances" aside={<span className="muted">went live {dnum(D.settings.go_live)}</span>}>
        <p className="muted" style={{ margin: '0 0 10px', fontSize: 14 }}>Re-entering counts adds a correction for the difference. Use the daily counts for routine checks.</p>
        <button className="btn sm alt" onClick={() => ui.openForm(openingForm(D))}>Re-enter opening balances</button></Card>}
    </>}
    <Account D={D} signOut={p.signOut} />
  </>;
}
