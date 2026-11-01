// Account (everyone), plus owner setup: staff, prices & thresholds, houses, opening balances,
// activity log and the sign-in security log.
import { useCallback, useEffect, useState } from 'react';
import { auth, requestReload, rpc, securityLog, staffAdmin, type SecurityEvent } from '../lib/api';
import { dnum, n0 } from '../lib/format';
import { disablePush, enablePush, pushStatus } from '../lib/push';
import type { Settings as S, StaffAdminRow, StaffLite } from '../lib/types';
import { houseForm, openingForm, staffForm } from '../forms/forms';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { Card, Empty, Seg } from '../ui/widgets';
import { BackupCodes, MfaEnroll, NewPassword } from './Auth';
import { RecordList } from './common';
import type { ViewProps } from './Management';

const ROLE: Record<string, string> = { owner: 'Owner', manager: 'Farm Manager', clerk: 'Production Clerk', pos: 'Sales point' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** Asks for a current authenticator code, then runs an action that needs it. */
function CodePrompt({ label, action, onDone }: { label: string; action: (code: string) => Promise<void>; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return <form className="authform" onSubmit={async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await action(code); onDone(); } catch (x) { setErr((x as Error).message); setCode(''); } finally { setBusy(false); }
  }}>
    <label className="fld" htmlFor="otp2"><span>Code from your authenticator app</span><div className="inp"><input id="otp2" className="otp" inputMode="numeric" autoComplete="one-time-code"
      maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus /></div></label>
    <div className="form-err" role="alert">{err}</div>
    <button className="btn wide" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : label}</button>
  </form>;
}

export function Account({ D, signOut }: { D: ViewProps['D']; signOut: (everywhere?: boolean) => void }) {
  const ui = useUI();
  const me = D.me;
  const [push, setPush] = useState<string>('…');
  useEffect(() => { pushStatus().then(setPush).catch(() => setPush('unsupported')); }, []);
  const togglePush = async () => {
    try { if (push === 'on') { await disablePush(); ui.toast('Phone notifications turned off.'); } else { await enablePush(); ui.toast('Phone notifications are on.'); } setPush(await pushStatus()); }
    catch (e) { ui.toast((e as Error).message); }
  };
  const user = { username: me.username, display_name: me.display_name, mfa_required: me.mfa_required };
  const changePassword = () => ui.openPanel('Change password',
    <NewPassword forced={false} user={user} onDone={() => { ui.close(); ui.toast('Password changed. Other devices were signed out.'); }} />);
  const setUp2fa = () => ui.openPanel('Set up two-step sign-in', <MfaEnroll inline user={user} onDone={() => { ui.close(); ui.toast('Two-step sign-in is on.'); requestReload(); }} />);
  const newCodes = () => ui.openPanel('New backup codes', <CodePrompt label="Make new backup codes" onDone={() => {}} action={async (code) => {
    const r = await auth<{ backup_codes: string[] }>('backup_codes', { code });
    ui.openPanel('New backup codes', <BackupCodes inline codes={r.backup_codes} onDone={() => { ui.close(); requestReload(); }} />);
  }} />);
  const turnOff = () => ui.openPanel('Turn off two-step sign-in', <>
    <p className="muted small">Your account will be protected by your password only.</p>
    <CodePrompt label="Turn off" onDone={() => { ui.close(); ui.toast('Two-step sign-in is off.'); requestReload(); }} action={(code) => auth('mfa_disable', { code })} /></>);

  return <Card title="My account" aside={<span className="muted">{me.display_name}{me.display_name === ROLE[me.role] ? '' : ` · ${ROLE[me.role]}`}</span>}>
    <div className="list">
      <div className="li"><span className="av" style={{ background: 'var(--surface-2)', color: 'var(--fg)' }}><Icon name="user" /></span><div className="mid"><b>Username</b><small>{me.username}</small></div></div>
      <div className="li"><span className="av" style={{ background: 'var(--primary)' }}><Icon name="key" /></span><div className="mid"><b>Password</b>
        <small>{me.password_changed_at ? `Last changed ${when(me.password_changed_at)}` : 'Set when you first signed in.'}</small></div>
        <button className="btn sm alt" onClick={changePassword}>Change</button></div>
      <div className="li"><span className="av" style={{ background: me.mfa_enabled ? 'var(--f-full)' : 'var(--f-low)' }}><Icon name="shield" /></span><div className="mid"><b>Two-step sign-in</b>
        <small>{me.mfa_enabled ? `On · ${me.backup_codes_left} backup code${me.backup_codes_left === 1 ? '' : 's'} left` : 'Off. Adds a code from your phone to every sign-in.'}{me.mfa_required ? ' · required for your role' : ''}</small></div>
        {me.mfa_enabled ? <div className="end"><button className="act" onClick={newCodes}>New codes</button>{!me.mfa_required && <button className="act" onClick={turnOff}>Turn off</button>}</div>
          : <button className="btn sm" onClick={setUp2fa}>Set up</button>}</div>
      <div className="li"><span className="av" style={{ background: 'var(--info)' }}><Icon name="bell" /></span><div className="mid"><b>Phone notifications</b>
        <small>{push === 'on' ? 'On for this phone.' : push === 'denied' ? 'Blocked in the browser settings.' : push === 'unsupported' ? 'Not available here. On iPhone, add the app to the Home Screen first.' : 'Alerts such as low feed arrive even when the app is closed.'}</small></div>
        {push !== 'unsupported' && push !== 'denied' && <button className="btn sm alt" onClick={togglePush}>{push === 'on' ? 'Turn off' : 'Turn on'}</button>}</div>
      <div className="li"><span className="av" style={{ background: 'var(--muted)' }}><Icon name="logout" /></span><div className="mid"><b>Sign out</b><small>Sessions end by themselves after 12 hours.</small></div>
        <div className="end"><button className="act" onClick={() => signOut(false)}>This device</button><button className="act" onClick={() => signOut(true)}>Everywhere</button></div></div>
    </div></Card>;
}

function Staff({ D }: ViewProps) {
  const ui = useUI();
  const [rows, setRows] = useState<StaffAdminRow[] | null>(null);
  const load = useCallback(() => staffAdmin<{ staff: StaffAdminRow[] }>({ action: 'list' }).then((r) => setRows(r.staff)).catch((e) => ui.toast(e.message)), [ui]);
  useEffect(() => { load(); }, [load, D]);
  const run = (s: StaffLite, action: string, done: string, confirmText?: string) => async () => {
    if (confirmText && !window.confirm(confirmText)) return;
    try { await staffAdmin({ action, staff_id: s.id }); ui.toast(done); load(); } catch (e) { ui.toast((e as Error).message); }
  };
  const manage = (s: StaffAdminRow) => {
    const locked = s.locked_until && new Date(s.locked_until) > new Date();
    ui.openPanel(s.display_name, <div className="list">
      <div className="li"><div className="mid"><b>Edit name, username, role or access</b><small>Disabling an account signs it out at once.</small></div><button className="btn sm alt" onClick={() => ui.openForm(staffForm(D, s))}>Edit</button></div>
      {s.id !== D.me.id && <div className="li"><div className="mid"><b>Reset password</b><small>Temporary password 0000 for 72 hours; they choose a new one. Signs them out everywhere.</small></div>
        <button className="btn sm alt" onClick={run(s, 'reset_password', `${s.display_name} can sign in with 0000 for 72 hours and must choose a new password.`, `Reset ${s.display_name}'s password to the temporary 0000?`)}>Reset</button></div>}
      {s.id !== D.me.id && s.mfa_enabled && <div className="li"><div className="mid"><b>Reset two-step sign-in</b><small>For a lost phone. {s.mfa_required ? 'They must set it up again at their next sign-in.' : ''}</small></div>
        <button className="btn sm alt" onClick={run(s, 'reset_mfa', `Two-step sign-in removed for ${s.display_name}.`, `Remove ${s.display_name}'s two-step sign-in?`)}>Reset</button></div>}
      {locked && <div className="li"><div className="mid"><b>Unlock</b><small>Locked until {when(s.locked_until)} after failed attempts.</small></div><button className="btn sm" onClick={run(s, 'unlock', `${s.display_name} is unlocked.`)}>Unlock</button></div>}
      <div className="li"><div className="mid"><b>Sign out everywhere</b><small>Ends every session on every device{s.id === D.me.id ? ' except this one' : ''}.</small></div><button className="btn sm alt" onClick={run(s, 'sign_out', 'Signed out.')}>Sign out</button></div>
    </div>);
  };
  return <Card title="Staff" aside={<button className="lnk" onClick={() => ui.openForm(staffForm(D))}>Add staff</button>}>
    {!rows ? <div className="center" style={{ minHeight: 100 }}><div className="spinner" /></div> : <div className="list">{rows.map((s) => {
      const locked = s.locked_until && new Date(s.locked_until) > new Date();
      const tempOver = s.must_change_password && s.temp_expires_at && new Date(s.temp_expires_at) < new Date();
      return <div className="li" key={s.id} style={s.active ? undefined : { opacity: 0.55 }}>
        <span className="av" style={{ background: 'var(--surface-2)', color: 'var(--fg)' }}><Icon name="user" /></span>
        <div className="mid"><b>{s.display_name}</b><small>{s.username} · {ROLE[s.role]}{s.location_id ? ` · ${D.locations.find((l) => l.id === s.location_id)?.short}` : ''}{!s.active ? ' · disabled' : ''}</small>
          <div className="chips">
            {locked && <span className="chip sev-red">Locked</span>}
            {s.must_change_password && <span className={`chip ${tempOver ? 'sev-red' : 'sev-amber'}`}>{tempOver ? 'Temporary password expired' : 'Temporary password'}</span>}
            {s.mfa_enabled ? <span className="chip sev-ok">Two-step on</span> : <span className={`chip ${s.mfa_required ? 'sev-red' : ''}`}>{s.mfa_required ? 'Two-step not set up' : 'Two-step off'}</span>}
          </div></div>
        <div className="end"><button className="act" onClick={() => manage(s)}>Manage</button></div></div>; })}</div>}
    <p className="muted small" style={{ marginTop: 10 }}>Five failed sign-ins lock an account for 15 minutes, longer each time it happens again. Two-step sign-in is optional, but recommended for the owner and farm manager.</p></Card>;
}

const REASON: Record<string, string> = {
  ok: 'Signed in', ok_temporary: 'Signed in with a temporary password', bad_password: 'Wrong password', unknown_user: 'Unknown username',
  inactive: 'Disabled account', temp_expired: 'Temporary password had expired', captcha_failed: 'Failed the security check',
  captcha_missing: 'Security check required', refused_backoff: 'Blocked: too fast after a failure', refused_account_locked: 'Blocked: account locked',
  refused_ip_locked: 'Blocked: too many failures from this network', refused_ip_rate: 'Blocked: too many requests from this network',
  bad_code: 'Wrong code', ok_backup_code: 'Used a backup code', enroll_bad_code: 'Wrong code while setting up', bad_current_password: 'Wrong current password',
};
const reasonText = (r: string | null) => (r ? REASON[r] ?? r.replace(/^policy: /, 'Refused: ') : '');
const KIND: Record<string, string> = { login: 'Sign-in', otp: 'Two-step code', set_password: 'Password change', mfa_enroll: 'Two-step set-up', logout: 'Sign-out', logout_all: 'Signed out everywhere', admin: 'Staff admin', bootstrap: 'First-time setup' };
function SecurityLog() {
  const [rows, setRows] = useState<SecurityEvent[] | null>(null);
  const [only, setOnly] = useState<'all' | 'fail'>('all');
  const [err, setErr] = useState('');
  useEffect(() => { securityLog(300).then(setRows).catch((e) => setErr(e.message)); }, []);
  const list = (rows ?? []).filter((r) => only === 'all' || !r.ok);
  const fails24 = (rows ?? []).filter((r) => !r.ok && Date.now() - new Date(r.at).getTime() < 86400000).length;
  return <Card title="Sign-in security log" aside={<Seg value={only} options={[['all', 'All'], ['fail', 'Failed']]} onChange={setOnly} />}>
    {err ? <p className="form-err">{err}</p> : !rows ? <div className="center" style={{ minHeight: 100 }}><div className="spinner" /></div> : <>
      <p className="muted small">{fails24} failed attempt{fails24 === 1 ? '' : 's'} in the last 24 hours. Every sign-in, code, password change and staff change is recorded here.</p>
      {list.length ? <div className="list seclog">{list.slice(0, 150).map((r, i) => <div className="li" key={i}>
        <span className="av" style={{ background: r.ok ? 'var(--f-full)' : 'var(--f-none)' }}><Icon name={r.ok ? 'check' : 'x'} /></span>
        <div className="mid"><b>{KIND[r.kind] ?? r.kind}{r.display_name ? ` · ${r.display_name}` : r.username ? ` · ${r.username}` : ''}</b>
          <small className={r.ok ? '' : 'sec-bad'}>{reasonText(r.reason)}</small><small className="ua">{r.ip} · {(r.user_agent ?? '').slice(0, 70)}</small></div>
        <div className="end"><small>{when(r.at)}</small></div></div>)}</div> : <Empty>Nothing to show.</Empty>}</>}
  </Card>;
}

const FIELDS: [keyof S, string, string][] = [
  ['tray_n', 'Normal eggs, per tray of 30', 'KES'], ['pc_n', 'Normal eggs, loose', 'KES each'], ['tray_b', 'Big eggs, per tray of 30', 'KES'], ['pc_b', 'Big eggs, loose', 'KES each'],
  ['tray_c', 'Cracked eggs, per tray', 'KES'], ['pc_c', 'Cracked eggs, loose', 'KES each'], ['pc_j', 'Jumbo / double yolk', 'KES each'],
  ['feed_buffer_bags', 'Feed buffer (weekly need)', 'bags'], ['bag_kg', 'Feed bag size', 'kg'], ['bag_price', 'Feed price per bag', 'KES'],
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

interface BackupFile { name: string; size: number; created_at: string }
/** Weekly backups (Sunday night), kept for 12 weeks in private storage. Owner only. */
function Backups() {
  const ui = useUI();
  const [list, setList] = useState<BackupFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => staffAdmin<{ backups: BackupFile[] }>({ action: 'backup_list' }).then((r) => setList(r.backups)).catch((e) => { setList([]); ui.toast(e.message); }), [ui]);
  useEffect(() => { load(); }, [load]);
  const now = async () => {
    setBusy(true);
    try { const r = await staffAdmin<{ rows: number; size: number }>({ action: 'backup_now' }); ui.toast(`Backup made: ${n0(r.rows)} records, ${Math.max(1, Math.round(r.size / 1024))} KB.`); load(); }
    catch (e) { ui.toast((e as Error).message); } finally { setBusy(false); }
  };
  const get = async (name: string) => {
    try { const r = await staffAdmin<{ url: string }>({ action: 'backup_url', name }); location.assign(r.url); } catch (e) { ui.toast((e as Error).message); }
  };
  return <Card title="Backups" aside={<button className="lnk" disabled={busy} onClick={now}>{busy ? 'Backing up…' : 'Back up now'}</button>}>
    <p className="muted" style={{ margin: '0 0 10px', fontSize: 13.5 }}>Every Sunday at 23:00 the farm records are copied to private storage. The last 12 weeks are kept. Download one now and then and keep it off the phone too.</p>
    {list === null ? <div className="spinner" /> : list.length ? <div className="list">{list.map((f) => <div className="li" key={f.name}>
      <span className="av" style={{ background: 'var(--info)' }}><Icon name="box" /></span>
      <div className="mid"><b>{when(f.created_at) || f.name}</b><small>{Math.max(1, Math.round(f.size / 1024))} KB</small></div>
      <div className="end"><button className="act" onClick={() => get(f.name)}>Download</button></div></div>)}</div>
      : <Empty>No backups yet. The first runs on Sunday night, or press Back up now.</Empty>}
  </Card>;
}

export function Setup(p: ViewProps & { signOut: (everywhere?: boolean) => void }) {
  const { D, version } = p, ui = useUI();
  const [sec, setSec] = useState<'activity' | 'setup' | 'security'>('activity');
  const [loc, setLoc] = useState<string>('all');
  const owner = D.me.role === 'owner';
  return <>
    {owner && <Seg value={sec} options={[['activity', 'Activity log'], ['setup', 'Setup'], ['security', 'Security']]} onChange={setSec} />}
    {sec === 'security' ? <SecurityLog /> : sec === 'activity' ? <Card title="Activity log" aside={<Seg value={loc} options={[['all', 'All'], ...D.locations.map((l): [string, string] => [l.id, l.short])]} onChange={setLoc} />}>
      <RecordList D={D} version={version} loc={loc === 'all' ? null : loc} canVoid limit={40} />
      <p className="muted" style={{ fontSize: 13, margin: '10px 0 0' }}>Records are never deleted. Correct marks a record as wrong; stock and money are recalculated without it.</p></Card>
    : <>
      {!D.settings.go_live && <div className="banner warn"><div><b>Enter opening balances</b><p>On go-live morning, count eggs at every location, cash, M-Pesa and bank balances, feed and water, then enter them here.</p></div>
        <button className="btn yolk" onClick={() => ui.openForm(openingForm(D))}>Opening balances</button></div>}
      <Houses {...p} />
      <Staff {...p} />
      <Thresholds {...p} />
      <Backups />
      {D.settings.go_live && <Card title="Opening balances" aside={<span className="muted">went live {dnum(D.settings.go_live)}</span>}>
        <p className="muted" style={{ margin: '0 0 10px', fontSize: 14 }}>Re-entering counts adds a correction for the difference. Use the daily counts for routine checks.</p>
        <button className="btn sm alt" onClick={() => ui.openForm(openingForm(D))}>Re-enter opening balances</button></Card>}
    </>}
    <Account D={D} signOut={p.signOut} />
  </>;
}
