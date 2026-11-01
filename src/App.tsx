import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AUTH_EVENT, RELOAD_EVENT, authStatus, dataVersion, forgetLegacyStorage, loadDashboard, rpc, signOut as endSession, type AuthStatus } from './lib/api';
import { alertsFor } from './lib/metrics';
import type { Dashboard, Role } from './lib/types';
import { collectForm, saleForm } from './forms/forms';
import { Icon } from './ui/icons';
import { UIProvider, useUI } from './ui/ui';
import { AlertList } from './ui/widgets';
import { Login, MfaEnroll, MfaVerify, NewPassword } from './views/Auth';
import { Alerts, Money, Overview, Report, Stock, type ViewProps } from './views/Management';
import { ClerkHome, Feed, Health, Records, Water } from './views/Farm';
import { PosMoney, PosSales, PosStock, PosToday } from './views/SalesPoint';
import { Account, Setup } from './views/Settings';
import { NoticeList } from './views/common';

type Tab = { label: string; icon: string; view: (p: ViewProps & { signOut: (everywhere?: boolean) => void }) => ReactNode };
const TABS: Record<string, Tab> = {
  ov: { label: 'Overview', icon: 'dash', view: (p) => <Overview {...p} /> },
  alerts: { label: 'Alerts', icon: 'bell', view: (p) => <Alerts {...p} /> },
  stock: { label: 'Stock', icon: 'box', view: (p) => <Stock {...p} /> },
  money: { label: 'Money', icon: 'wallet', view: (p) => <Money {...p} /> },
  report: { label: 'Report', icon: 'report', view: (p) => <Report {...p} /> },
  setup: { label: 'Activity', icon: 'list', view: (p) => <Setup {...p} /> },
  home: { label: 'Home', icon: 'dash', view: (p) => <ClerkHome {...p} /> },
  feed: { label: 'Feed', icon: 'sack', view: (p) => <Feed {...p} /> },
  water: { label: 'Water', icon: 'drop', view: (p) => <Water {...p} /> },
  health: { label: 'Flock health', icon: 'syringe', view: (p) => <Health {...p} /> },
  records: { label: 'Records', icon: 'list', view: (p) => <Records {...p} /> },
  today: { label: 'Today', icon: 'dash', view: (p) => <PosToday {...p} /> },
  pstock: { label: 'Stock', icon: 'box', view: (p) => <PosStock {...p} /> },
  psales: { label: 'Sales', icon: 'receipt', view: (p) => <PosSales {...p} /> },
  pmoney: { label: 'Money', icon: 'wallet', view: (p) => <PosMoney {...p} /> },
  me: { label: 'My account', icon: 'user', view: (p) => <Account D={p.D} signOut={p.signOut} /> },
};
/** First five go in the bottom bar on phones; all appear in the side rail and menu. */
const ROLE_TABS: Record<Role, string[]> = {
  owner: ['ov', 'stock', 'money', 'report', 'setup', 'alerts', 'feed', 'water', 'health'],
  manager: ['alerts', 'ov', 'stock', 'report', 'health', 'feed', 'water', 'money', 'records', 'setup'],
  clerk: ['home', 'feed', 'water', 'health', 'records', 'me'],
  pos: ['today', 'pstock', 'psales', 'pmoney', 'me'],
};
const ROLE_NAME: Record<Role, string> = { owner: 'Owner', manager: 'Farm Manager', clerk: 'Production Clerk', pos: 'Sales point' };

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true), b = () => setOn(false);
    addEventListener('online', a); addEventListener('offline', b);
    return () => { removeEventListener('online', a); removeEventListener('offline', b); };
  }, []);
  return on;
}

/**
 * Sign-in state comes from the server (the session itself is in HttpOnly
 * cookies this page cannot read). Any AUTH_* answer from the server makes
 * the app ask again, so a session ended elsewhere (password change, owner
 * reset, 12-hour limit) drops back to the right screen at once.
 */
export default function App() {
  const [st, setSt] = useState<AuthStatus | null>(null);
  const [notice, setNotice] = useState('');
  const [offline, setOffline] = useState('');
  const last = useRef<string>('');
  const check = useCallback(async () => {
    try {
      const s = await authStatus();
      if (last.current === 'ready' && s.state !== 'ready') {
        setNotice(s.state === 'expired' ? 'Your session reached its 12-hour limit. Sign in again.' : s.state === 'inactive' ? 'This account was disabled.' : s.state === 'none' ? 'You were signed out.' : '');
      }
      last.current = s.state;
      setOffline(''); setSt(s);
    } catch (e) { setOffline((e as Error).message); }
  }, []);
  useEffect(() => {
    forgetLegacyStorage();
    check();
    const on = () => check();
    addEventListener(AUTH_EVENT, on);
    return () => removeEventListener(AUTH_EVENT, on);
  }, [check]);
  const out = useCallback(async (everywhere = false) => { await endSession(everywhere); setNotice(''); last.current = ''; await check(); }, [check]);

  if (!st) return <div className="center">{offline ? <div className="card" style={{ maxWidth: 440 }}><h3>Cannot reach Desert Pearl</h3><p className="muted">{offline}</p>
    <button className="btn" onClick={check}>Try again</button></div> : <div className="spinner" />}</div>;
  const u = st.user;
  if (st.state === 'ready' && u) return <Signed key={u.id} signOut={out} />;
  if (st.state === 'set_password' && u) return <NewPassword forced user={u} onDone={check} onSignOut={() => out()} />;
  if (st.state === 'mfa_enroll' && u) return <MfaEnroll user={u} onDone={check} onSignOut={() => out()} />;
  if (st.state === 'mfa_verify' && u) return <MfaVerify user={u} onSignOut={() => out()}
    onDone={(r) => { if (r.used_backup) setNotice(`You used a backup code. ${r.backup_codes_left ?? 0} left. Make new ones under My account.`); check(); }} />;
  return <Login setupNeeded={st.setup_needed} notice={notice || (st.state === 'temp_expired' ? 'Your temporary password expired. Ask the owner to reset it.' : '')} onDone={() => { setNotice(''); check(); }} />;
}

const POLL_MS = 60_000;        // ask "has anything changed?" once a minute while the app is on screen
const MIN_GAP_MS = 120_000;    // and fetch the full dashboard at most every 2 minutes for other people's changes

function Signed({ signOut }: { signOut: (everywhere?: boolean) => void }) {
  // farm data is kept in memory only: nothing is left on the device after sign-out
  const [D, setD] = useState<Dashboard | null>(null);
  const [err, setErr] = useState('');
  const [version, setVersion] = useState(0);
  const seen = useRef<{ v: number; day: string; at: number }>({ v: -1, day: '', at: 0 });
  const busy = useRef(false);
  /** Fetch the full dashboard (after a save, or when the data changed). */
  const reload = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const d = await loadDashboard(90);
      seen.current = { v: Number(d.version ?? -1), day: d.today, at: Date.now() };
      setD(d); setErr(''); setVersion((v) => v + 1);
    } catch (e) { setErr((e as Error).message); } finally { busy.current = false; }
  }, []);
  /** Cheap check: download the dashboard only if something changed since the last one. */
  const check = useCallback(async (soon = false) => {
    if (document.visibilityState !== 'visible') return;
    try {
      const x = await dataVersion();
      const changed = Number(x.v) !== seen.current.v || x.day !== seen.current.day;
      if (changed && (soon || x.day !== seen.current.day || Date.now() - seen.current.at >= MIN_GAP_MS)) await reload();
    } catch (e) { setErr((e as Error).message); }
  }, [reload]);

  useEffect(() => {
    reload();
    const every = window.setInterval(() => check(), POLL_MS);
    const vis = () => { if (document.visibilityState === 'visible') check(true); };
    document.addEventListener('visibilitychange', vis);
    const msg = (e: MessageEvent) => { if (e.data?.type === 'refresh') check(true); };
    navigator.serviceWorker?.addEventListener('message', msg);
    addEventListener(RELOAD_EVENT, reload);
    return () => { clearInterval(every); document.removeEventListener('visibilitychange', vis); navigator.serviceWorker?.removeEventListener('message', msg); removeEventListener(RELOAD_EVENT, reload); };
  }, [reload, check]);

  const out = (everywhere = false) => { setD(null); signOut(everywhere); };
  if (!D) return <div className="center">{err ? <div className="card" style={{ maxWidth: 440 }}><h3>Cannot load the farm data</h3><p className="muted">{err}</p><div className="row-btns"><button className="btn" onClick={reload}>Try again</button><button className="btn alt" onClick={() => out()}>Sign out</button></div></div> : <div className="spinner" />}</div>;
  return <UIProvider afterSave={reload}><Shell D={D} version={version} err={err} signOut={out} reload={reload} /></UIProvider>;
}

function Shell({ D, version, err, signOut, reload }: { D: Dashboard; version: number; err: string; signOut: (everywhere?: boolean) => void; reload: () => void }) {
  const ui = useUI(), online = useOnline();
  const tabs = ROLE_TABS[D.me.role];
  const [tab, setTab] = useState<string>(() => { const h = location.hash.slice(1); return tabs.includes(h) ? h : tabs[0]; });
  const [drawer, setDrawer] = useState(false);
  const go = (t: string) => { setTab(t); setDrawer(false); try { history.replaceState(null, '', `#${t}`); } catch { /* ignore */ } window.scrollTo(0, 0); };
  useEffect(() => { if (!tabs.includes(tab)) setTab(tabs[0]); }, [tabs, tab]);

  const myAlerts = alertsFor(D);
  const unread = D.notifications.filter((n) => !n.read);
  const openBell = () => {
    ui.openPanel('Alerts & notifications', <>
      <div><h3 style={{ marginBottom: 8 }}>Live alerts</h3><AlertList list={myAlerts} /></div>
      <div><h3 style={{ margin: '6px 0 8px' }}>Notifications</h3><NoticeList D={D} /></div>
      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Live alerts clear on their own once fixed. Turn on phone notifications under My account to get them when the app is closed.</p></>);
    if (unread.length) rpc('rpc_mark_read', { p_ids: unread.map((n) => n.id) }).then(reload).catch(() => {});
  };
  const loc = D.locations.find((l) => l.id === D.me.location_id);
  const fab = D.me.role === 'clerk' ? { icon: 'egg', label: 'Collection', f: () => ui.openForm(collectForm(D)) }
    : D.me.role === 'pos' ? { icon: 'plus', label: 'Sale', f: () => ui.openForm(saleForm(D, D.me.location_id!)) } : null;
  const title = TABS[tab].label === 'Home' || TABS[tab].label === 'Today' ? loc?.name ?? 'Desert Pearl' : TABS[tab].label;
  const props = { D, version, go, signOut };

  return <>
    {!online && <div className="offline">Offline: showing the last figures loaded. Records can be saved again once the connection is back.</div>}
    <header className="appbar"><div className="appbar-in">
      <button className="iconbtn" onClick={() => setDrawer(true)} aria-label="Menu"><Icon name="menu" /></button>
      <div className="ttl"><b>{title}</b><small>{[D.me.display_name, D.me.display_name.includes(ROLE_NAME[D.me.role]) || D.me.display_name === ROLE_NAME[D.me.role] ? '' : ROLE_NAME[D.me.role], loc?.name].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · ')}</small></div>
      <button className="iconbtn" onClick={openBell} aria-label="Alerts">{<Icon name="bell" />}{myAlerts.length + unread.length > 0 && <span className="badge">{myAlerts.length + unread.length}</span>}</button>
    </div></header>
    <div className="shell">
      <nav className="rail" aria-label="Sections"><div className="rail-loc">{loc?.name ?? 'All locations'}</div>
        {tabs.map((t) => <button key={t} aria-current={tab === t} onClick={() => go(t)}><Icon name={TABS[t].icon} />{TABS[t].label}</button>)}
        {!tabs.includes('me') && !tabs.includes('setup') && <button onClick={() => go('me')}><Icon name="user" />My account</button>}</nav>
      <main key={tab}>
        {D.me.backup_codes_left !== undefined && D.me.mfa_enabled && D.me.backup_codes_left <= 2 && tab !== 'me' && <div className="banner warn"><div><b>{D.me.backup_codes_left} backup code{D.me.backup_codes_left === 1 ? '' : 's'} left</b><p>Make a new set so you can still sign in if your phone is lost.</p></div><button className="btn sm" onClick={() => go('me')}>My account</button></div>}
        {err && online && <div className="banner warn"><div><b>Could not refresh</b><p>{err}</p></div><button className="btn sm" onClick={reload}>Try again</button></div>}
        {(tabs.includes(tab) || tab === 'me' ? TABS[tab] : TABS[tabs[0]]).view(props)}
      </main>
    </div>
    <nav className="bnav" aria-label="Sections">{tabs.slice(0, 5).map((t) => <button key={t} aria-current={tab === t} onClick={() => go(t)}><span className="pill"><Icon name={TABS[t].icon} /></span><span>{TABS[t].label}</span></button>)}</nav>
    {fab && <button className="fab" onClick={fab.f}><Icon name={fab.icon} />{fab.label}</button>}
    {drawer && <div className="drawer" onClick={(e) => { if (e.target === e.currentTarget) setDrawer(false); }}>
      <nav><div className="dh"><b>{D.me.display_name}</b><small>{ROLE_NAME[D.me.role]}{loc ? ` · ${loc.name}` : ''}</small></div>
        {tabs.map((t) => <button key={t} onClick={() => go(t)}><Icon name={TABS[t].icon} />{TABS[t].label}</button>)}
        {!tabs.includes('me') && <button onClick={() => go('me')}><Icon name="user" />My account</button>}
        <button onClick={() => go('me')}><Icon name="shield" />Password &amp; two-step sign-in</button>
        <button onClick={() => signOut()}><Icon name="logout" />Sign out</button>
        <div className="note">Desert Pearl Ventures Ltd · Tuala Farm Fresh Eggs</div></nav></div>}
  </>;
}
