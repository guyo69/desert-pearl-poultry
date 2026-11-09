// In-app help: tips that point at the real buttons (once each, in the order
// people work, only when the button is on screen), the Help panel with how-to
// steps and questions for the person's role, and Search over screens, actions
// and help. Content lives in lib/help.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rpc } from '../lib/api';
import { FAQS, TASKS, TIPS, score, whoOf, words, type Tip, type Who } from '../lib/help';
import { canEnter, isVan } from '../lib/metrics';
import type { Dashboard } from '../lib/types';
import {
  breakageForm, collectForm, confirmIssueForm, countForm, creditPaidForm, dispatchForm, expenseForm, flockForm, houseDayForm, houseNewForm, millForm,
  moveForm, mortForm, rawCountForm, rawInForm, receiveForm, recipeForm, saleForm, shopDayForm, staffForm, storeFeedInForm, storeFeedIssueForm,
  storeMedInForm, storeMedIssueForm, supplyInForm, supplyOutForm, tankForm, waterIntakeForm, cashCountForm,
} from '../forms/forms';
import { Icon } from './icons';
import { useUI } from './ui';

export interface TabInfo { key: string; label: string; icon: string }
type UI = ReturnType<typeof useUI>;
interface Ctx { D: Dashboard; ui: UI; go: (t: string) => void; tabs: TabInfo[] }

export const whoFor = (D: Dashboard): Who => whoOf(D.me.role, D.me.role === 'pos' && !!D.me.location_id && isVan(D, D.me.location_id));

// ---------------------------------------------------------------------------- actions
/** Everything Search and the how-to steps can open, with who can use it. */
interface Action { id: string; label: string; keywords: string; who: Who[]; enter?: boolean; run: (c: Ctx) => void }
const LOC = (c: Ctx) => c.D.me.location_id ?? 'FARM';
const SHOP: Who[] = ['pos'], ROAD: Who[] = ['pos', 'van'];
const ACTIONS: Action[] = [
  { id: 'sale', label: 'Record a sale', keywords: 'sell sold customer cash till paybill mpesa credit', who: ROAD, enter: true, run: (c) => c.ui.openForm(saleForm(c.D, LOC(c))) },
  { id: 'count_open', label: 'Opening count', keywords: 'start morning count stock', who: SHOP, enter: true, run: (c) => c.ui.openForm(countForm(c.D, LOC(c), 'open')) },
  { id: 'count_close', label: 'Close the day: closing count', keywords: 'closing evening end count', who: SHOP, enter: true, run: (c) => c.ui.openForm(countForm(c.D, LOC(c), 'close')) },
  { id: 'cash_count', label: 'Count the cash', keywords: 'cash drawer money count', who: SHOP, enter: true, run: (c) => c.ui.openForm(cashCountForm(c.D, LOC(c))) },
  { id: 'receive', label: 'Receive a delivery', keywords: 'receive load arrive stock in transfer', who: ['pos', 'van', 'clerk', 'manager'], enter: true, run: (c) => {
    const loc = LOC(c), x = c.D.transit.find((t) => t.to_loc === loc);
    if (x) c.ui.openForm(receiveForm(c.D, x)); else c.ui.toast('Nothing is on the way to you right now.');
  } },
  { id: 'dispatch', label: 'Send eggs to another location', keywords: 'issue eggs deliver transfer send outlet van', who: ['pos', 'van', 'clerk', 'manager'], enter: true, run: (c) => c.ui.openForm(dispatchForm(c.D, LOC(c))) },
  { id: 'leftover', label: 'Drop off what is left on the van', keywords: 'left over empty end of day van', who: ['van'], enter: true, run: (c) => c.ui.openForm(dispatchForm(c.D, LOC(c), { leftover: true })) },
  { id: 'damaged', label: 'Damaged eggs', keywords: 'broken spoilt breakage loss', who: ROAD, enter: true, run: (c) => c.ui.openForm(breakageForm(c.D, LOC(c))) },
  { id: 'shop_day', label: 'Daily stock sheet', keywords: 'stock sheet book closed day', who: SHOP, enter: true, run: (c) => c.ui.openForm(shopDayForm(c.D, LOC(c))) },
  { id: 'credit_paid', label: 'Credit paid back', keywords: 'credit debt owe customer paid', who: ['pos', 'van', 'manager'], enter: true, run: (c) => c.ui.openForm(creditPaidForm(c.D, c.D.me.role === 'pos' ? LOC(c) : null)) },
  { id: 'expense', label: 'Record an expense', keywords: 'expense spend paid cost', who: ['pos', 'van', 'manager'], enter: true, run: (c) => c.ui.openForm(expenseForm(c.D, LOC(c), c.D.me.role === 'manager')) },
  { id: 'move', label: 'Bank or move money', keywords: 'bank deposit mpesa paybill move money cash', who: ['pos', 'van', 'manager'], enter: true, run: (c) => c.ui.openForm(moveForm(c.D, c.D.me.role === 'pos' ? LOC(c) : null)) },
  { id: 'tank', label: 'Tank level', keywords: 'water tank level reading refill', who: ['clerk', 'manager'], enter: true, run: (c) => c.ui.openForm(tankForm(c.D)) },
  { id: 'water', label: 'Water drunk', keywords: 'water litres drink house', who: ['clerk', 'manager'], enter: true, run: (c) => c.ui.openForm(waterIntakeForm(c.D)) },
  { id: 'collect', label: 'Egg collection', keywords: 'eggs collect grade cracked jumbo damaged house', who: ['clerk', 'manager'], enter: true, run: (c) => c.ui.openForm(collectForm(c.D)) },
  { id: 'house_day', label: 'Daily house sheet', keywords: 'house sheet whole day farm book', who: ['clerk', 'manager'], enter: true, run: (c) => c.ui.openForm(houseDayForm(c.D)) },
  { id: 'mortality', label: 'Record deaths', keywords: 'mortality dead died birds', who: ['clerk', 'manager'], enter: true, run: (c) => c.ui.openForm(mortForm(c.D)) },
  { id: 'confirm', label: 'Confirm what the store issued', keywords: 'confirm feed medicine arrived store', who: ['clerk', 'manager'], enter: true, run: (c) => {
    const x = (c.D.store_pending ?? [])[0];
    if (x) c.ui.openForm(confirmIssueForm(c.D, x)); else c.ui.toast('Nothing from the store is waiting to be confirmed.');
  } },
  { id: 'feed_in', label: 'Feed received', keywords: 'feed delivery bags supplier', who: ['store', 'manager'], enter: true, run: (c) => c.ui.openForm(storeFeedInForm(c.D)) },
  { id: 'feed_issue', label: 'Issue feed to a house', keywords: 'feed issue house bags feeding', who: ['store', 'manager'], enter: true, run: (c) => c.ui.openForm(storeFeedIssueForm(c.D)) },
  { id: 'med_in', label: 'Medicine received', keywords: 'medicine vaccine delivery', who: ['store', 'manager'], enter: true, run: (c) => c.ui.openForm(storeMedInForm(c.D)) },
  { id: 'med_issue', label: 'Issue medicine to a house', keywords: 'medicine vaccine issue house', who: ['store', 'manager'], enter: true, run: (c) => c.ui.openForm(storeMedIssueForm(c.D)) },
  { id: 'supply_in', label: 'Supplies received', keywords: 'trays packaging cleaning supplies delivery', who: ['store', 'manager'], enter: true, run: (c) => c.ui.openForm(supplyInForm(c.D)) },
  { id: 'supply_out', label: 'Issue supplies', keywords: 'trays packaging supplies issue', who: ['store', 'manager'], enter: true, run: (c) => c.ui.openForm(supplyOutForm(c.D)) },
  { id: 'mill', label: 'Feed milled', keywords: 'mill mix tonnes feed recipe', who: ['store', 'manager'], enter: true, run: (c) => c.ui.openForm(millForm(c.D)) },
  { id: 'raw_in', label: 'Raw material received', keywords: 'maize soybean bran sunflower limestone grit macropack delivery', who: ['store', 'manager'], enter: true, run: (c) => c.ui.openForm(rawInForm(c.D)) },
  { id: 'raw_count', label: 'Count the raw material store', keywords: 'count stock take raw store', who: ['store', 'manager'], enter: true, run: (c) => c.ui.openForm(rawCountForm(c.D)) },
  { id: 'recipe', label: 'Change the feed recipe', keywords: 'recipe formula mill kg tonne', who: ['owner', 'manager'], run: (c) => c.ui.openForm(recipeForm(c.D)) },
  { id: 'flock', label: 'Place a new flock', keywords: 'flock hens breed placement new birds', who: ['owner', 'manager', 'clerk'], run: (c) => c.ui.openForm(flockForm(c.D)) },
  { id: 'house_new', label: 'Add a house', keywords: 'house expansion new building', who: ['owner', 'manager', 'clerk'], run: (c) => c.ui.openForm(houseNewForm(c.D)) },
  { id: 'staff', label: 'Add a member of staff', keywords: 'staff user account employee new', who: ['owner', 'manager'], run: (c) => c.ui.openForm(staffForm(c.D)) },
];
const actionsFor = (D: Dashboard, who: Who) => ACTIONS.filter((a) => a.who.includes(who) && (!a.enter || canEnter(D)));

function runAction(c: Ctx, id: string) {
  if (id.startsWith('go:')) {
    const t = id.slice(3);
    if (c.tabs.some((x) => x.key === t)) { c.ui.close(); c.go(t); } else c.ui.toast('That screen is not part of your role.');
    return;
  }
  const a = actionsFor(c.D, whoFor(c.D)).find((x) => x.id === id);
  if (a) a.run(c);
}

// ---------------------------------------------------------------------------- tips
const visible = (el: Element) => {
  const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[aria-hidden="true"], .skel, [aria-busy="true"]');
};
const findTarget = (t: string) => [...document.querySelectorAll(`[data-tip="${CSS.escape(t)}"]`)].find(visible) as HTMLElement | undefined;

/**
 * Shows the next tip for this screen, one at a time, pointing at its button.
 * Only tips whose button is on screen are shown; the others wait their turn.
 */
export function TipHost({ D, tab, paused }: { D: Dashboard; tab: string; paused: boolean }) {
  const who = whoFor(D);
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const [tip, setTip] = useState<{ t: Tip; el: HTMLElement } | null>(null);
  const [box, setBox] = useState<DOMRect | null>(null);
  const list = useMemo(() => TIPS[who].filter((t) => t.tab === tab || t.tab === '*'), [who, tab]);

  useEffect(() => {
    rpc<string[]>('rpc_tips', {}).then((s) => setSeen(new Set(s ?? []))).catch(() => setSeen(new Set(TIPS[who].map((t) => t.id))));
    const again = (e: Event) => setSeen((e as CustomEvent<Set<string>>).detail);
    addEventListener('dpv-tips', again);
    return () => removeEventListener('dpv-tips', again);
  }, [who]);

  // look for the next tip whose button is on screen, after the page has settled
  useEffect(() => {
    if (!seen || paused) { setTip(null); return; }
    let stop = false;
    const look = () => {
      if (stop) return;
      if (document.querySelector('.scrim, .drawer')) { setTip(null); return; }
      const next = list.find((t) => !seen.has(t.id) && findTarget(t.target));
      if (next) setTip({ t: next, el: findTarget(next.target)! }); else setTip(null);
    };
    const first = window.setTimeout(look, 900);
    const every = window.setInterval(look, 1500);
    return () => { stop = true; clearTimeout(first); clearInterval(every); };
  }, [seen, list, paused]);

  // follow the button as the page scrolls or resizes
  useEffect(() => {
    if (!tip) { setBox(null); return; }
    const r = tip.el.getBoundingClientRect();
    if (r.top < 70 || r.bottom > innerHeight - 90) tip.el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    // a form, panel or menu on top hides the tip until it closes
    const place = () => setBox(tip.el.isConnected && !document.querySelector('.scrim, .drawer') ? tip.el.getBoundingClientRect() : null);
    place();
    const t = window.setInterval(place, 250);
    addEventListener('resize', place); addEventListener('scroll', place, true);
    return () => { clearInterval(t); removeEventListener('resize', place); removeEventListener('scroll', place, true); };
  }, [tip]);

  const mark = useCallback((ids: string[]) => {
    setSeen((s) => new Set([...(s ?? []), ...ids]));
    rpc('rpc_tips', { p_add: ids }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!tip) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') mark([tip.t.id]); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [tip, mark]);

  if (!tip || !box || paused) return null;
  const left = list.filter((t) => !seen!.has(t.id));
  const pad = 6, below = box.bottom + 190 < innerHeight || box.top < 200;
  const w = Math.min(320, innerWidth - 24);
  const x = Math.max(12, Math.min(innerWidth - w - 12, box.left + box.width / 2 - w / 2));
  const arrow = Math.max(18, Math.min(w - 18, box.left + box.width / 2 - x));
  return <div className="tip-layer" role="dialog" aria-modal="false" aria-labelledby="tip-t">
    <div className="tip-spot" style={{ top: box.top - pad, left: box.left - pad, width: box.width + pad * 2, height: box.height + pad * 2 }} />
    <div className={`tip-bubble ${below ? 'below' : 'above'}`} style={{ left: x, width: w, ...(below ? { top: box.bottom + 14 } : { bottom: innerHeight - box.top + 14 }) }}>
      <i className="tip-arrow" style={{ left: arrow }} />
      <b id="tip-t">{tip.t.title}</b>
      <p>{tip.t.text}</p>
      <div className="tip-foot">
        <small>{left.length > 1 ? `${left.length - 1} more tip${left.length === 2 ? '' : 's'}` : 'Last tip'}</small>
        {left.length > 1 && <button className="tip-skip" onClick={() => mark(TIPS[who].map((t) => t.id))}>Skip all</button>}
        <button className="btn sm" autoFocus onClick={() => mark([tip.t.id])}>{left.length > 1 ? 'Next' : 'Got it'}</button>
      </div>
    </div>
  </div>;
}

/** Shows this screen's tips again. */
async function replayTips(D: Dashboard, tab: string) {
  const ids = TIPS[whoFor(D)].filter((t) => t.tab === tab || t.tab === '*').map((t) => t.id);
  const left = await rpc<string[]>('rpc_tips', { p_reset: ids });
  dispatchEvent(new CustomEvent('dpv-tips', { detail: new Set(left ?? []) }));
}

// ---------------------------------------------------------------------------- help panel
const ROLE_LABEL: Record<Who, string> = { owner: 'Owner', manager: 'Farm manager', clerk: 'Production clerk', store: 'Inventory clerk', pos: 'Outlet attendant', van: 'Van driver' };

export const ACTION_IDS = ACTIONS.map((a) => a.id);

export function HelpPanel({ D, ui, go, tabs, tab }: Ctx & { tab: string }) {
  const who = whoFor(D), [sec, setSec] = useState<'how' | 'faq'>('how'), [open, setOpen] = useState<number | null>(0);
  const c: Ctx = { D, ui, go, tabs };
  const can = (id?: string) => !!id && (id.startsWith('go:') ? tabs.some((t) => `go:${t.key}` === id) : actionsFor(D, who).some((a) => a.id === id));
  return <div className="help">
    <div className="help-top">
      <p className="muted small" style={{ margin: 0 }}>Help for the {ROLE_LABEL[who].toLowerCase()}, in the order the day goes.</p>
      <div className="row-btns">
        <button className="lnk" onClick={() => { ui.close(); replayTips(D, tab).catch(() => ui.toast('Could not reload the tips.')); }}><Icon name="pulse" />Show me around</button>
        <button className="lnk" onClick={() => { ui.close(); openSearch(c); }}><Icon name="search" />Search</button>
      </div>
    </div>
    <div className="seg" role="tablist"><button aria-pressed={sec === 'how'} onClick={() => setSec('how')}>How to</button><button aria-pressed={sec === 'faq'} onClick={() => setSec('faq')}>Questions</button></div>
    {sec === 'how' ? <ol className="help-tasks">{TASKS[who].map((t, i) => <li key={t.title} className={open === i ? 'open' : ''}>
      <button className="help-q" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}><span className="n">{i + 1}</span>{t.title}<Icon name="back" /></button>
      {open === i && <div className="help-a"><ol>{t.steps.map((s) => <li key={s}>{s}</li>)}</ol>
        {can(t.action) && <button className="btn sm" onClick={() => { if (!t.action!.startsWith('go:')) ui.close(); runAction(c, t.action!); }}>{t.action!.startsWith('go:') ? 'Take me there' : 'Open it'}</button>}</div>}
    </li>)}</ol>
    : <div className="help-faq">{FAQS[who].map((f) => <details key={f.q}><summary>{f.q}</summary><p>{f.a}</p></details>)}</div>}
    <p className="muted small" style={{ margin: '12px 0 0' }}>Still stuck? Ask the farm manager first. They contact Sage Design Lab if needed.</p>
  </div>;
}

// ---------------------------------------------------------------------------- search
interface Hit { kind: 'Screen' | 'Action' | 'Help'; title: string; sub: string; icon: string; s: number; run: () => void }

function SearchBox(c: Ctx) {
  const { D, ui, go, tabs } = c, who = whoFor(D);
  const [q, setQ] = useState(''), [sel, setSel] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const hits = useMemo<Hit[]>(() => {
    const w = words(q);
    if (!w.length) return [];
    const out: Hit[] = [];
    for (const t of tabs) out.push({ kind: 'Screen', title: t.label, sub: 'Go to this screen', icon: t.icon, s: score(w, t.label, t.key), run: () => { ui.close(); go(t.key); } });
    for (const a of actionsFor(D, who)) out.push({ kind: 'Action', title: a.label, sub: 'Opens the form', icon: 'plus', s: score(w, a.label, a.keywords) + 0.5, run: () => a.run(c) });
    for (const t of TASKS[who]) out.push({ kind: 'Help', title: t.title, sub: t.steps.join(' '), icon: 'list', s: score(w, t.title, `${t.steps.join(' ')} ${t.keywords ?? ''}`),
      run: () => ui.openPanel(t.title, <div className="help"><ol className="help-steps">{t.steps.map((s) => <li key={s}>{s}</li>)}</ol></div>) });
    for (const f of FAQS[who]) out.push({ kind: 'Help', title: f.q, sub: f.a, icon: 'alert', s: score(w, f.q, f.a),
      run: () => ui.openPanel(f.q, <div className="help"><p style={{ margin: 0 }}>{f.a}</p></div>) });
    return out.filter((h) => h.s > 0).sort((a, b) => b.s - a.s).slice(0, 12);
  }, [q, D, who, tabs, ui, go, c]);
  useEffect(() => { setSel(0); }, [q]);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    if (e.key === 'Enter' && hits[sel]) { e.preventDefault(); hits[sel].run(); }
  };
  const groups = (['Action', 'Screen', 'Help'] as const).map((k) => [k, hits.filter((h) => h.kind === k)] as const).filter(([, h]) => h.length);
  const ideas = who === 'owner' ? ['report', 'staff', 'workbook', 'recipe'] : who === 'manager' ? ['missed day', 'expense', 'recipe', 'flock']
    : who === 'clerk' ? ['eggs', 'water', 'deaths', 'flock'] : who === 'store' ? ['feed', 'mill', 'medicine', 'count'] : ['sale', 'credit', 'close', 'damaged'];
  let i = -1;
  return <div className="search">
    <div className="inp search-in"><Icon name="search" /><input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} placeholder="Search screens, forms and help"
      aria-label="Search" autoComplete="off" enterKeyHint="go" /></div>
    {!q.trim() ? <div className="search-ideas"><small className="muted">Try</small>{ideas.map((x) => <button key={x} className="lnk" onClick={() => setQ(x)}>{x}</button>)}</div>
      : !hits.length ? <p className="muted small">Nothing found for "{q}". Try another word, or open Help.</p>
      : groups.map(([k, hs]) => <div key={k} className="search-g"><h4>{k === 'Action' ? 'Do it' : k === 'Screen' ? 'Screens' : 'Help'}</h4>
        <div className="list">{hs.map((h) => { i++; const me = i; return <button key={`${h.kind}${h.title}`} className={`li search-hit${me === sel ? ' sel' : ''}`} onClick={h.run} onMouseEnter={() => setSel(me)}>
          <span className="av" style={{ background: `var(${k === 'Action' ? '--accent' : k === 'Screen' ? '--info' : '--muted'})` }}><Icon name={h.icon} /></span>
          <span className="mid"><b>{h.title}</b><small>{h.sub}</small></span></button>; })}</div></div>)}
    <p className="muted small search-keys">Enter opens the top result. On a computer, Ctrl+K opens Search from anywhere.</p>
  </div>;
}

export function openSearch(c: Ctx) { c.ui.openPanel('Search', <SearchBox {...c} />); }
export function openHelp(c: Ctx, tab: string) { c.ui.openPanel('Help', <HelpPanel {...c} tab={tab} />); }
