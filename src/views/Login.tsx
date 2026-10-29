import { useEffect, useState } from 'react';
import { pinLogin, staffAdmin, staffDirectory, type DirectoryEntry } from '../lib/api';
import { Icon } from '../ui/icons';
import { LOC_COLORS } from '../lib/metrics';

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', manager: 'Farm Manager', clerk: 'Production Clerk', pos: 'Sales point' };
const roleIcon = (s: DirectoryEntry) => (s.role === 'owner' ? 'crown' : s.role === 'manager' ? 'users' : s.role === 'clerk' ? 'egg' : s.location_id === 'VAN' ? 'truck' : 'store');
const roleColor = (s: DirectoryEntry) => (s.role === 'owner' ? '--primary' : LOC_COLORS[s.location_id ?? ''] ?? '--l-farm');

export function Login() {
  const [list, setList] = useState<DirectoryEntry[] | null>(null);
  const [err, setErr] = useState('');
  const [who, setWho] = useState<DirectoryEntry | null>(() => null);
  const [busy, setBusy] = useState(false);

  const load = () => staffDirectory().then(setList).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const bootstrap = async () => {
    setBusy(true); setErr('');
    try { await staffAdmin({ action: 'bootstrap' }); await load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (who) return <PinPad who={who} onBack={() => setWho(null)} />;

  const groups: [string, DirectoryEntry[]][] = list ? [
    ['Management', list.filter((s) => s.role === 'owner' || s.role === 'manager')],
    ['Central Farm', list.filter((s) => s.role === 'clerk' || (s.role === 'pos' && s.location_id === 'FARM'))],
    ['Sales points', list.filter((s) => s.role === 'pos' && s.location_id !== 'FARM')],
  ] : [];

  return (
    <div className="login">
      <div className="hero"><div className="hero-in">
        <div className="brand"><span className="egg"><Icon name="egg" /></span><div><h1>Desert Pearl Poultry Manager</h1><div style={{ opacity: 0.85 }}>Tuala Farm Fresh Eggs · Kagundo</div></div></div>
        <p>Tap your name, then enter your PIN.</p>
      </div></div>
      <div className="body"><div className="body-in">
        {err && <div className="banner warn" style={{ marginTop: 16 }}><div><b>Cannot load the staff list</b><p>{err}</p></div><button className="btn sm" onClick={load}>Try again</button></div>}
        {!list && !err && <div className="center" style={{ minHeight: 200 }}><div className="spinner" /></div>}
        {list && list.length === 0 && (
          <div className="card" style={{ marginTop: 18 }}>
            <h3>First-time setup</h3>
            <p className="muted" style={{ fontSize: 14 }}>Create the team: Owner, Farm Manager, Production Clerk, Farm Counter, Van Driver and one attendant for each shop. Everyone starts with PIN <b>0000</b> and is asked to change it. The owner can rename and add staff afterwards.</p>
            <button className="btn" disabled={busy} onClick={bootstrap}>{busy ? 'Creating…' : 'Create the team'}</button>
          </div>
        )}
        {groups.map(([title, ss]) => ss.length > 0 && (
          <div key={title}><h2>{title}</h2>
            <div className="roles">{ss.map((s) => (
              <button key={s.id} className="role" onClick={() => setWho(s)}>
                <span className="av" style={{ background: `var(${roleColor(s)})` }}><Icon name={roleIcon(s)} /></span>
                <span><b>{s.display_name}</b><small>{ROLE_LABEL[s.role]}{s.location_name ? ` · ${s.location_name}` : ''}</small></span>
              </button>))}</div>
          </div>
        ))}
      </div></div>
    </div>
  );
}

function PinPad({ who, onBack }: { who: DirectoryEntry; onBack: () => void }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (p: string) => {
    if (p.length < 4 || busy) return;
    setBusy(true); setErr('');
    try { await pinLogin(who.id, p); } catch (e) { setErr((e as Error).message); setPin(''); } finally { setBusy(false); }
  };
  const press = (k: string) => {
    if (busy) return;
    if (k === 'del') { setPin((p) => p.slice(0, -1)); return; }
    const next = (pin + k).slice(0, 6);
    setPin(next); setErr('');
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter') submit(pin);
      else if (e.key === 'Escape') onBack();
    };
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey);
  });
  return (
    <div className="login">
      <div className="hero"><div className="hero-in">
        <button className="btn sm alt" onClick={onBack} style={{ marginBottom: 14 }}><Icon name="back" />Back</button>
        <div className="who" style={{ justifyContent: 'flex-start' }}><span className="av" style={{ background: `var(${roleColor(who)})` }}><Icon name={roleIcon(who)} /></span>
          <div><h1 style={{ fontSize: 21 }}>{who.display_name}</h1><div style={{ opacity: 0.85 }}>{ROLE_LABEL[who.role]}{who.location_name ? ` · ${who.location_name}` : ''}</div></div></div>
      </div></div>
      <div className="body"><div className="body-in" style={{ maxWidth: 360 }}>
        <p className="muted" style={{ textAlign: 'center', margin: '8px 0 0' }}>Enter your PIN</p>
        <div className="pindots" aria-label={`${pin.length} digits entered`}>{Array.from({ length: Math.max(4, pin.length) }, (_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}</div>
        <div className="pin-err" role="alert">{err}</div>
        <div className="pinpad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => <button key={k} onClick={() => press(k)}>{k}</button>)}
          <button className="ghost" onClick={() => press('del')} aria-label="Delete">Delete</button>
          <button onClick={() => press('0')}>0</button>
          <button className="ghost" onClick={() => submit(pin)} disabled={pin.length < 4 || busy} style={{ color: 'var(--primary)', fontWeight: 700 }}>{busy ? '…' : 'Sign in'}</button>
        </div>
        <p className="muted" style={{ textAlign: 'center', fontSize: 13 }}>New staff start with PIN 0000. Forgot your PIN? Ask the owner to reset it.</p>
      </div></div>
    </div>
  );
}
