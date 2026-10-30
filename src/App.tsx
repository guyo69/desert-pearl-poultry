import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { loadDashboard, rpc, signOut } from './lib/api';
import { configured, supabase } from './lib/supabase';
import { alertsFor } from './lib/metrics';
import type { Dashboard, Role } from './lib/types';
import { changePinForm, collectForm, saleForm } from './forms/forms';
import { Icon } from './ui/icons';
import { UIProvider, useUI } from './ui/ui';
import { AlertList } from './ui/widgets';
import { Login } from './views/Login';
import { Alerts, Money, Overview, Report, Stock, type ViewProps } from './views/Management';
import { ClerkHome, Feed, Health, Records, Water } from './views/Farm';
import { PosMoney, PosSales, PosStock, PosToday } from './views/SalesPoint';
import { Account, Setup } from './views/Settings';
import { NoticeList } from './views/common';

type Tab = { label: string; icon: string; view: (p: ViewProps & { signOut: () => void }) => ReactNode };
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
const CACHE = 'dpv-dashboard';

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true), b = () => setOn(false);
    addEventListener('online', a); addEventListener('offline', b);
    return () => { removeEventListener('online', a); removeEventListener('offline', b); };
  }, []);
  return on;
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  if (!configured) return <div className="center"><div className="card" style={{ maxWidth: 480 }}><h3>App not configured</h3><p className="muted">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then rebuild. See README.md.</p></div></div>;
  if (session === undefined) return <div className="center"><div className="spinner" /></div>;
  if (!session) return <Login />;
  return <Signed key={session.user.id} />;
}

function Signed() {
  const [D, setD] = useState<Dashboard | null>(() => { try { const c = localStorage.getItem(CACHE); return c ? JSON.parse(c) : null; } catch { return null; } });
  const [err, setErr] = useState('');
  const [version, setVersion] = useState(0);
  const timer = useRef<number>();
  const reload = useCallback(async () => {
    try {
      const d = await loadDashboard(90);
      setD(d); setErr(''); setVersion((v) => v + 1);
      try { localStorage.setItem(CACHE, JSON.stringify(d)); } catch { /* storage full or blocked */ }
    } catch (e) { setErr((e as Error).message); }
  }, []);
  const soon = useCallback(() => { clearTimeout(timer.current); timer.current = window.setTimeout(reload, 600); }, [reload]);

  useEffect(() => {
    reload();
    const ch = supabase.channel('dpv-live').on('postgres_changes', { event: '*', schema: 'public' }, soon).subscribe();
    const vis = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', vis);
    const every = window.setInterval(reload, 120000);
    const msg = (e: MessageEvent) => { if (e.data?.type === 'refresh') reload(); };
    navigator.serviceWorker?.addEventListener('message', msg);
    return () => { supabase.removeChannel(ch); document.removeEventListener('visibilitychange', vis); clearInterval(every); navigator.serviceWorker?.removeEventListener('message', msg); };
  }, [reload, soon]);

  const out = async () => { try { localStorage.removeItem(CACHE); } catch { /* ignore */ } await signOut(); };
  if (!D) return <div className="center">{err ? <div className="card" style={{ maxWidth: 440 }}><h3>Cannot load the farm data</h3><p className="muted">{err}</p><div className="row-btns"><button className="btn" onClick={reload}>Try again</button><button className="btn alt" onClick={out}>Sign out</button></div></div> : <div className="spinner" />}</div>;
  return <UIProvider afterSave={reload}><Shell D={D} version={version} err={err} signOut={out} reload={reload} /></UIProvider>;
}

function Shell({ D, version, err, signOut, reload }: { D: Dashboard; version: number; err: string; signOut: () => void; reload: () => void }) {
  const ui = useUI(), online = useOnline();
  const tabs = ROLE_TABS[D.me.role];
  const [tab, setTab] = useState<string>(() => { const h = location.hash.slice(1); return tabs.includes(h) ? h : tabs[0]; });
  const [drawer, setDrawer] = useState(false);
  const promptedPin = useRef(false);
  const go = (t: string) => { setTab(t); setDrawer(false); try { history.replaceState(null, '', `#${t}`); } catch { /* ignore */ } window.scrollTo(0, 0); };
  useEffect(() => { if (!tabs.includes(tab)) setTab(tabs[0]); }, [tabs, tab]);
  useEffect(() => { if (D.me.must_change_pin && !promptedPin.current) { promptedPin.current = true; ui.openForm(changePinForm()); } }, [D.me.must_change_pin, ui]);

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
        {D.me.must_change_pin && <div className="banner warn"><div><b>You are using the default PIN 0000</b><p>Anyone who knows it can sign in as you. Choose your own PIN.</p></div><button className="btn yolk" onClick={() => ui.openForm(changePinForm())}>Change PIN</button></div>}
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
        <button onClick={() => { setDrawer(false); ui.openForm(changePinForm()); }}><Icon name="lock" />Change PIN</button>
        <button onClick={signOut}><Icon name="logout" />Sign out</button>
        <div className="note">Desert Pearl Ventures Ltd · Tuala Farm Fresh Eggs</div></nav></div>}
  </>;
}
