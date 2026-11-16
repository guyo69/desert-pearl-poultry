import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { AUTH_EVENT, RELOAD_EVENT, authStatus, dataVersion, flushOutbox, forgetLegacyStorage, loadDashboard, rpc, setOutboxUser, signOut as endSession, type AuthStatus, type AuthUser } from './lib/api';
import { forgetFigures, readFigures, saveFigures } from './lib/outbox';
import { OfflineBar } from './ui/Offline';
import { alertsFor } from './lib/metrics';
import type { Dashboard, Role } from './lib/types';
import { Icon } from './ui/icons';
import { UIProvider, useUI } from './ui/ui';
import { AlertList, AppSkeleton, Card, SkelList } from './ui/widgets';
import { ScreenGuard } from './ui/ScreenGuard';
import type { ViewProps } from './views/Management';
import { TipHost, openHelp, openSearch } from './ui/Help';
import { note, setScreen, SLOW, startTelemetry } from './lib/telemetry';

// Each screen is loaded when it is first opened, so a phone only downloads the
// screens its person uses (16 Nov 2026). The service worker keeps them all for offline use.
type AnyView = ComponentType<any>;
// after a new version goes live an old page may ask for a screen file that is gone: reload once to pick up the new version
const fresh = <T,>(p: Promise<T>) => p.catch((e) => {
  const gone = /dynamically imported module|Importing a module script failed|Failed to fetch|error loading/i.test(String(e?.message ?? e));
  if (gone && navigator.onLine) {
    let again = true; try { again = sessionStorage.getItem('dpv-reloaded') === '1'; sessionStorage.setItem('dpv-reloaded', '1'); } catch { /* storage blocked */ }
    if (!again) location.reload();
  }
  throw e;
});
const view = <K extends string>(load: () => Promise<Record<K, AnyView>>, name: K) => lazy(() => fresh(load()).then((m) => ({ default: m[name] })));
/** The screens a role starts on, fetched while its figures load. */
const FIRST: Record<Role, () => Promise<unknown>> = {
  owner: () => import('./views/Management'), manager: () => import('./views/Management'), clerk: () => import('./views/Farm'),
  store: () => import('./views/Store'), pos: () => import('./views/SalesPoint'),
};
const management = () => import('./views/Management'), farm = () => import('./views/Farm'), shop = () => import('./views/SalesPoint');
const store = () => import('./views/Store'), settings = () => import('./views/Settings'), auth = () => import('./views/Auth');
const Overview = view(management, 'Overview'), Alerts = view(management, 'Alerts'), Stock = view(management, 'Stock'), Money = view(management, 'Money'), Report = view(management, 'Report');
const ClerkHome = view(farm, 'ClerkHome'), Feed = view(farm, 'Feed'), Health = view(farm, 'Health'), Records = view(farm, 'Records'), Water = view(farm, 'Water');
const PosToday = view(shop, 'PosToday'), PosStock = view(shop, 'PosStock'), PosSales = view(shop, 'PosSales'), PosMoney = view(shop, 'PosMoney');
const StoreHome = view(store, 'StoreHome'), StoreItems = view(store, 'StoreItems'), StoreRecords = view(store, 'StoreRecords');
const Mill = view(() => import('./views/Mill'), 'Mill');
const Account = view(settings, 'Account'), Activity = view(settings, 'Activity'), Setup = view(settings, 'Setup');
const Login = view(auth, 'Login'), MfaEnroll = view(auth, 'MfaEnroll'), MfaVerify = view(auth, 'MfaVerify'), NewPassword = view(auth, 'NewPassword');
/** While a screen's code arrives (a moment on a slow connection, once). */
const ScreenLoading = () => <Card><SkelList n={4} /></Card>;

type Tab = { label: string; icon: string; view: (p: ViewProps & { signOut: (everywhere?: boolean) => void }) => ReactNode };
const TABS: Record<string, Tab> = {
  ov: { label: 'Overview', icon: 'dash', view: (p) => <Overview {...p} /> },
  alerts: { label: 'Alerts', icon: 'bell', view: (p) => <Alerts {...p} /> },
  stock: { label: 'Stock', icon: 'box', view: (p) => <Stock {...p} /> },
  money: { label: 'Money', icon: 'wallet', view: (p) => <Money {...p} /> },
  report: { label: 'Report', icon: 'report', view: (p) => <Report {...p} /> },
  activity: { label: 'Activity', icon: 'list', view: (p) => <Activity {...p} /> },
  settings: { label: 'Settings', icon: 'sliders', view: (p) => <Setup {...p} /> },
  home: { label: 'Home', icon: 'dash', view: (p) => <ClerkHome {...p} /> },
  feed: { label: 'Feed', icon: 'sack', view: (p) => <Feed {...p} /> },
  mill: { label: 'Feed mill', icon: 'scoop', view: (p) => <Mill {...p} /> },
  water: { label: 'Water', icon: 'drop', view: (p) => <Water {...p} /> },
  health: { label: 'Flock health', icon: 'syringe', view: (p) => <Health {...p} /> },
  records: { label: 'Records', icon: 'list', view: (p) => <Records {...p} /> },
  store: { label: 'Store', icon: 'box', view: (p) => <StoreHome {...p} /> },
  meds: { label: 'Store items', icon: 'syringe', view: (p) => <StoreItems {...p} /> },
  srecords: { label: 'Records', icon: 'list', view: (p) => <StoreRecords {...p} /> },
  today: { label: 'Today', icon: 'dash', view: (p) => <PosToday {...p} /> },
  pstock: { label: 'Stock', icon: 'box', view: (p) => <PosStock {...p} /> },
  psales: { label: 'Sales', icon: 'receipt', view: (p) => <PosSales {...p} /> },
  pmoney: { label: 'Money', icon: 'wallet', view: (p) => <PosMoney {...p} /> },
  me: { label: 'My account', icon: 'user', view: (p) => <Account D={p.D} signOut={p.signOut} /> },
};
/** First five go in the bottom bar on phones; all appear in the side rail and menu. */
const ROLE_TABS: Record<Role, string[]> = {
  owner: ['ov', 'stock', 'money', 'report', 'activity', 'alerts', 'feed', 'mill', 'water', 'health', 'settings'],
  manager: ['alerts', 'ov', 'stock', 'report', 'health', 'feed', 'mill', 'water', 'money', 'records', 'activity', 'settings'],
  clerk: ['home', 'feed', 'water', 'health', 'records', 'me'],
  store: ['store', 'mill', 'feed', 'meds', 'srecords', 'me'],
  pos: ['today', 'pstock', 'psales', 'pmoney', 'me'],
};
const ROLE_NAME: Record<Role, string> = { owner: 'Owner', manager: 'Farm Manager', clerk: 'Production Clerk', store: 'Inventory Clerk', pos: 'Sales point' };

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
    } catch (e) {
      // no connection: field staff carry on with the figures kept on this phone
      if (last.current === 'ready') return;
      const c = await readFigures<AuthUser, Dashboard>();
      if (c && !last.current) { last.current = 'ready'; setSt({ state: 'ready', user: c.who }); return; }
      setOffline((e as Error).message);
    }
  }, []);
  useEffect(() => {
    forgetLegacyStorage();
    check();
    const on = () => check();
    addEventListener(AUTH_EVENT, on);
    addEventListener('online', on);
    return () => { removeEventListener(AUTH_EVENT, on); removeEventListener('online', on); };
  }, [check]);
  const out = useCallback(async (everywhere = false) => { await endSession(everywhere); await forgetFigures(); setNotice(''); last.current = ''; await check(); }, [check]);

  if (!st) return <div className="center">{offline ? <div className="card" style={{ maxWidth: 440 }}><h3>Cannot reach Desert Pearl</h3><p className="muted">{offline}</p>
    <button className="btn" onClick={check}>Try again</button></div> : <div className="boot-mark" aria-label="Loading"><span /><span /><span /></div>}</div>;
  const u = st.user;
  if (st.state === 'ready' && u) return <Signed key={u.id} user={u} signOut={out} />;
  return <Suspense fallback={<div className="center"><div className="boot-mark" aria-label="Loading"><span /><span /><span /></div></div>}>{signIn(st, u, notice, setNotice, check, out)}</Suspense>;
}

function signIn(st: AuthStatus, u: AuthUser | undefined, notice: string, setNotice: (s: string) => void, check: () => void, out: (everywhere?: boolean) => void) {
  if (st.state === 'set_password' && u) return <NewPassword forced user={u} onDone={check} onSignOut={() => out()} />;
  if (st.state === 'mfa_enroll' && u) return <MfaEnroll user={u} onDone={check} onSignOut={() => out()} />;
  if (st.state === 'mfa_verify' && u) return <MfaVerify user={u} onSignOut={() => out()}
    onDone={(r: { used_backup?: boolean; backup_codes_left?: number }) => { if (r.used_backup) setNotice(`You used a backup code. ${r.backup_codes_left ?? 0} left. Make new ones under My account.`); check(); }} />;
  return <Login setupNeeded={st.setup_needed} notice={notice || (st.state === 'temp_expired' ? 'Your temporary password expired. Ask the owner to reset it.' : '')} onDone={() => { setNotice(''); check(); }} />;
}

const POLL_MS = 60_000;        // ask "has anything changed?" once a minute while the app is on screen
const MIN_GAP_MS = 120_000;    // and fetch the full dashboard at most every 2 minutes for other people's changes

/** Field staff can keep working with no connection; the owner and farm manager work online. */
const FIELD = (role: string) => role !== 'owner' && role !== 'manager';

function Signed({ user, signOut }: { user: AuthUser; signOut: (everywhere?: boolean) => void }) {
  // field staff: the last figures are kept on this phone (removed at sign-out) so the app opens offline;
  // the owner and farm manager keep them in memory only
  const field = FIELD(user.role);
  const [D, setD] = useState<Dashboard | null>(null);
  const [stale, setStale] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [version, setVersion] = useState(0);
  const seen = useRef<{ v: number; day: string; at: number }>({ v: -1, day: '', at: 0 });
  const busy = useRef(false);
  /** Fetch the full dashboard (after a save, or when the data changed). */
  const reload = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const t0 = performance.now();
    try {
      const d = await loadDashboard(90);
      const took = performance.now() - t0;
      if (took > SLOW.figuresMs) note({ kind: 'slow', message: 'Figures slow to load', metric: Math.round(took) });
      seen.current = { v: Number(d.version ?? -1), day: d.today, at: Date.now() };
      setD(d); setErr(''); setStale(null); setVersion((v) => v + 1);
      if (field) saveFigures(user.id, user, d);
    } catch (e) {
      setErr((e as Error).message);
      if (field) {
        const c = await readFigures<AuthUser, Dashboard>(user.id);
        if (c) { setD((x) => x ?? c.data); setStale((x) => x ?? c.at); }
      }
    } finally { busy.current = false; }
  }, [field, user]);

  // the first screen's code comes down while the figures load; problem notes start once signed in;
  // field staff get the forms ahead of their first tap
  useEffect(() => {
    FIRST[user.role as Role]?.().catch(() => {});
    if (field) (window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 2000)))(() => { import('./forms/forms').catch(() => {}); });
    return startTelemetry();
  }, [field, user.role]);

  // everyday entries go through the outbox, and whatever waits is sent as soon as possible
  useEffect(() => {
    setOutboxUser(field ? user.id : null);
    if (!field) return () => setOutboxUser(null);
    const go = () => { if (navigator.onLine) flushOutbox(user.id).catch(() => {}); };
    go();
    const every = window.setInterval(go, 20_000);
    const vis = () => { if (document.visibilityState === 'visible') go(); };
    addEventListener('online', go);
    document.addEventListener('visibilitychange', vis);
    return () => { setOutboxUser(null); clearInterval(every); removeEventListener('online', go); document.removeEventListener('visibilitychange', vis); };
  }, [field, user.id]);
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
  if (!D && !err) return <AppSkeleton />;
  if (!D) return <div className="center">{err ? <div className="card" style={{ maxWidth: 440 }}><h3>Cannot load the farm data</h3><p className="muted">{err}</p><div className="row-btns"><button className="btn" onClick={reload}>Try again</button><button className="btn alt" onClick={() => out()}>Sign out</button></div></div> : null}</div>;
  return <UIProvider afterSave={reload} field={D.me.role !== 'owner' && D.me.role !== 'manager'}><Shell D={D} version={version} err={err} signOut={out} reload={reload} stale={stale} user={field ? user.id : null} /></UIProvider>;
}

function Shell({ D, version, err, signOut, reload, stale, user }: { D: Dashboard; version: number; err: string; signOut: (everywhere?: boolean) => void; reload: () => void; stale: number | null; user: string | null }) {
  const ui = useUI(), online = useOnline();
  const tabs = ROLE_TABS[D.me.role];
  const [tab, setTab] = useState<string>(() => { const h = location.hash.slice(1).replace(/^setup$/, 'settings'); return tabs.includes(h) ? h : tabs[0]; });
  const [drawer, setDrawer] = useState(false);
  const go = (t: string) => { setTab(t); setDrawer(false); try { history.replaceState(null, '', `#${t}`); } catch { /* ignore */ } window.scrollTo(0, 0); };
  useEffect(() => { if (!tabs.includes(tab)) setTab(tabs[0]); }, [tabs, tab]);
  useEffect(() => { setScreen(tab); }, [tab]);
  // field roles get larger touch targets (styles.css, html[data-field])
  useEffect(() => {
    const el = document.documentElement, field = D.me.role !== 'owner' && D.me.role !== 'manager';
    el.toggleAttribute('data-field', field);
    return () => el.removeAttribute('data-field');
  }, [D.me.role]);

  // the owner is asked for a recovery email after signing in, until one is confirmed
  useEffect(() => {
    if (D.me.role !== 'owner') return;
    let later = false;
    try { later = sessionStorage.getItem('dpv-recovery-later') === '1'; } catch { /* storage blocked */ }
    if (later) return;
    authStatus().then((s) => {
      const r = s.user?.recovery;
      if (!r || r.email || !r.mail_ready) return;
      const skip = () => { try { sessionStorage.setItem('dpv-recovery-later', '1'); } catch { /* ignore */ } ui.close(); };
      import('./views/Auth').then(({ RecoveryEmail }) => ui.openPanel('Add a recovery email', <>
        <RecoveryEmail onDone={(m) => { ui.close(); ui.toast(`Recovery email confirmed: ${m}.`); }} />
        <button className="lnk center-t blockc" style={{ marginTop: 12 }} onClick={skip}>Later</button></>)).catch(() => {});
    }).catch(() => {});
    // once per sign-in
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const myAlerts = alertsFor(D);
  const unread = D.notifications.filter((n) => !n.read);
  const openBell = () => {
    const NoticeList = lazy(() => import('./views/common').then((m) => ({ default: m.NoticeList })));
    ui.openPanel('Alerts & notifications', <>
      <div><h3 style={{ marginBottom: 8 }}>Live alerts</h3><AlertList list={myAlerts} /></div>
      <div><h3 style={{ margin: '6px 0 8px' }}>Notifications</h3><Suspense fallback={<SkelList n={2} />}><NoticeList D={D} /></Suspense></div>
      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Live alerts clear on their own once fixed. Turn on phone notifications under My account to get them when the app is closed.</p></>);
    if (unread.length) rpc('rpc_mark_read', { p_ids: unread.map((n) => n.id) }).then(reload).catch(() => {});
  };
  const loc = D.locations.find((l) => l.id === D.me.location_id);
  const forms = () => import('./forms/forms');
  const fab = D.me.role === 'clerk' ? { icon: 'egg', label: 'Collection', f: () => forms().then((m) => ui.openForm(m.collectForm(D))) }
    : D.me.role === 'pos' ? { icon: 'plus', label: 'Sale', f: () => forms().then((m) => ui.openForm(m.saleForm(D, D.me.location_id!))) } : null;
  const title = TABS[tab].label === 'Home' || TABS[tab].label === 'Today' ? loc?.name ?? 'Desert Pearl' : TABS[tab].label;
  const props = { D, version, go, signOut };
  const tabInfo = [...tabs, ...(tabs.includes('me') || tabs.includes('settings') ? [] : ['me'])].map((k) => ({ key: k, label: TABS[k].label, icon: TABS[k].icon }));
  const help = { D, ui, go, tabs: tabInfo };
  // Ctrl+K (or Cmd+K) opens Search from anywhere
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(help); } };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });

  return <>
    <header className="appbar"><div className="appbar-in">
      <button className="iconbtn" onClick={() => setDrawer(true)} aria-label="Menu"><Icon name="menu" /></button>
      <div className="ttl"><b>{title}</b><small>{[D.me.display_name, D.me.display_name.includes(ROLE_NAME[D.me.role]) || D.me.display_name === ROLE_NAME[D.me.role] ? '' : ROLE_NAME[D.me.role], loc?.name].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · ')}</small></div>
      <button className="iconbtn" onClick={() => openSearch(help)} aria-label="Search" data-tip="search"><Icon name="search" /></button>
      <button className="iconbtn" onClick={() => openHelp(help, tab)} aria-label="Help" data-tip="help"><Icon name="help" /></button>
      <button className="iconbtn" onClick={openBell} aria-label="Alerts" data-tip="bell">{<Icon name="bell" />}{myAlerts.length + unread.length > 0 && <span className="badge">{myAlerts.length + unread.length}</span>}</button>
    </div></header>
    <OfflineBar online={online} stale={stale} user={user} />
    <div className="shell">
      <nav className="rail" aria-label="Sections"><div className="rail-loc">{loc?.name ?? 'All locations'}</div>
        {tabs.map((t) => <button key={t} aria-current={tab === t} onClick={() => go(t)} data-tip={`tab:${t}`}><Icon name={TABS[t].icon} />{TABS[t].label}</button>)}
        {!tabs.includes('me') && !tabs.includes('settings') && <button onClick={() => go('me')}><Icon name="user" />My account</button>}</nav>
      <main key={tab}>
        {D.me.backup_codes_left !== undefined && D.me.mfa_enabled && D.me.backup_codes_left <= 2 && tab !== 'me' && <div className="banner warn"><div><b>{D.me.backup_codes_left} backup code{D.me.backup_codes_left === 1 ? '' : 's'} left</b><p>Make a new set so you can still sign in if your phone is lost.</p></div><button className="btn sm" onClick={() => go('me')}>My account</button></div>}
        {err && online && stale == null && <div className="banner warn"><div><b>Could not refresh</b><p>{err}</p></div><button className="btn sm" onClick={reload}>Try again</button></div>}
        <ScreenGuard name={tabs.includes(tab) || tab === 'me' ? tab : tabs[0]}><Suspense fallback={<ScreenLoading />}>{(tabs.includes(tab) || tab === 'me' ? TABS[tab] : TABS[tabs[0]]).view(props)}</Suspense></ScreenGuard>
      </main>
    </div>
    {/* at most four tabs on the phone's bar, then More for the rest (all of them are in the menu) */}
    <nav className="bnav" aria-label="Sections">{tabs.slice(0, tabs.length > 4 ? 4 : 5).map((t) => <button key={t} aria-current={tab === t} onClick={() => go(t)} data-tip={`tab:${t}`}><span className="pill"><Icon name={TABS[t].icon} /></span><span>{TABS[t].label}</span></button>)}
      {tabs.length > 4 && <button aria-current={!tabs.slice(0, 4).includes(tab)} onClick={() => setDrawer(true)} data-tip="tab:more"><span className="pill"><Icon name="menu" /></span><span>More</span></button>}</nav>
    <TipHost D={D} tab={tab} paused={drawer || !online} />
    {fab && <button className="fab" onClick={fab.f} data-tip="fab"><Icon name={fab.icon} />{fab.label}</button>}
    {drawer && <div className="drawer" onClick={(e) => { if (e.target === e.currentTarget) setDrawer(false); }}>
      <nav><div className="dh"><b>{D.me.display_name}</b><small>{ROLE_NAME[D.me.role]}{loc ? ` · ${loc.name}` : ''}</small></div>
        {tabs.map((t) => <button key={t} onClick={() => go(t)}><Icon name={TABS[t].icon} />{TABS[t].label}</button>)}
        {!tabs.includes('me') && <button onClick={() => go('me')}><Icon name="user" />My account</button>}
        <button onClick={() => go('me')}><Icon name="shield" />Password &amp; two-step sign-in</button>
        <button onClick={() => signOut()}><Icon name="logout" />Sign out</button>
        <div className="note">Desert Pearl Ventures Ltd · Tuala Farm Fresh Eggs</div></nav></div>}
  </>;
}
