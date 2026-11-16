// The Help panel and Search, loaded the first time either is opened so the
// screens a person starts on do not wait for them. The tips stay in Help.tsx.
import { useEffect, useMemo, useRef, useState } from 'react';
import { FAQS, TASKS, type Who } from '../lib/help';
import { ACTION_META, actionsFor, IDEAS, search, whoFor, type Go, type Hit } from '../lib/search';
import { downloadMonth } from '../views/MonthBooks';
import type { Dashboard } from '../lib/types';
import {
  breakageForm, collectForm, confirmIssueForm, countForm, creditPaidForm, dispatchForm, expenseForm, flockForm, houseDayForm, houseNewForm, millForm,
  moveForm, mortForm, rawCountForm, rawInForm, receiveForm, recipeForm, saleForm, shopDayForm, staffForm, storeFeedInForm, storeFeedIssueForm,
  storeMedInForm, storeMedIssueForm, supplyInForm, supplyOutForm, tankForm, waterIntakeForm, cashCountForm,
} from '../forms/forms';
import { Icon } from './icons';
import { openHelp, openSearch, replayTips, type TabInfo } from './Help';
import { useUI } from './ui';

type UI = ReturnType<typeof useUI>;
export interface Ctx { D: Dashboard; ui: UI; go: (t: string) => void; tabs: TabInfo[] }

// ---------------------------------------------------------------------------- actions
/** How each form in lib/search.ts ACTION_META opens. */
const LOC = (c: Ctx) => c.D.me.location_id ?? 'FARM';
const RUNS: Record<string, (c: Ctx) => void> = {
  sale: (c) => c.ui.openForm(saleForm(c.D, LOC(c))),
  count_open: (c) => c.ui.openForm(countForm(c.D, LOC(c), 'open')),
  count_close: (c) => c.ui.openForm(countForm(c.D, LOC(c), 'close')),
  cash_count: (c) => c.ui.openForm(cashCountForm(c.D, LOC(c))),
  receive: (c) => {
    const loc = LOC(c), x = c.D.transit.find((t) => t.to_loc === loc);
    if (x) c.ui.openForm(receiveForm(c.D, x)); else c.ui.toast('Nothing is on the way to you right now.');
  },
  dispatch: (c) => c.ui.openForm(dispatchForm(c.D, LOC(c))),
  leftover: (c) => c.ui.openForm(dispatchForm(c.D, LOC(c), { leftover: true })),
  damaged: (c) => c.ui.openForm(breakageForm(c.D, LOC(c))),
  shop_day: (c) => c.ui.openForm(shopDayForm(c.D, LOC(c))),
  credit_paid: (c) => c.ui.openForm(creditPaidForm(c.D, c.D.me.role === 'pos' ? LOC(c) : null)),
  expense: (c) => c.ui.openForm(expenseForm(c.D, LOC(c), c.D.me.role === 'manager')),
  move: (c) => c.ui.openForm(moveForm(c.D, c.D.me.role === 'pos' ? LOC(c) : null)),
  tank: (c) => c.ui.openForm(tankForm(c.D)),
  water: (c) => c.ui.openForm(waterIntakeForm(c.D)),
  collect: (c) => c.ui.openForm(collectForm(c.D)),
  house_day: (c) => c.ui.openForm(houseDayForm(c.D)),
  mortality: (c) => c.ui.openForm(mortForm(c.D)),
  confirm: (c) => {
    const x = (c.D.store_pending ?? [])[0];
    if (x) c.ui.openForm(confirmIssueForm(c.D, x)); else c.ui.toast('Nothing from the store is waiting to be confirmed.');
  },
  feed_in: (c) => c.ui.openForm(storeFeedInForm(c.D)),
  feed_issue: (c) => c.ui.openForm(storeFeedIssueForm(c.D)),
  med_in: (c) => c.ui.openForm(storeMedInForm(c.D)),
  med_issue: (c) => c.ui.openForm(storeMedIssueForm(c.D)),
  supply_in: (c) => c.ui.openForm(supplyInForm(c.D)),
  supply_out: (c) => c.ui.openForm(supplyOutForm(c.D)),
  mill: (c) => c.ui.openForm(millForm(c.D)),
  raw_in: (c) => c.ui.openForm(rawInForm(c.D)),
  raw_count: (c) => c.ui.openForm(rawCountForm(c.D)),
  recipe: (c) => c.ui.openForm(recipeForm(c.D)),
  flock: (c) => c.ui.openForm(flockForm(c.D)),
  house_new: (c) => c.ui.openForm(houseNewForm(c.D)),
  staff: (c) => c.ui.openForm(staffForm(c.D)),
};

export function runAction(c: Ctx, id: string) {
  if (id.startsWith('go:')) {
    const t = id.slice(3);
    if (c.tabs.some((x) => x.key === t)) { c.ui.close(); c.go(t); } else c.ui.toast('That screen is not part of your role.');
    return;
  }
  if (actionsFor(c.D, whoFor(c.D)).some((x) => x.id === id)) RUNS[id]?.(c);
}


// ---------------------------------------------------------------------------- help panel
const ROLE_LABEL: Record<Who, string> = { owner: 'Owner', manager: 'Farm manager', clerk: 'Production clerk', store: 'Inventory clerk', pos: 'Outlet attendant', van: 'Van driver' };

/** Forms that have a way to open (tests check every how-to points at one). */
export const ACTION_IDS = ACTION_META.map((a) => a.id).filter((id) => id in RUNS);

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
const RECENT = 'dpv-search-recent';
const recent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT) ?? '[]').slice(0, 5); } catch { return []; } };
const remember = (q: string) => { try { localStorage.setItem(RECENT, JSON.stringify([q, ...recent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 5))); } catch { /* storage blocked */ } };

/** Scrolls to a card on the screen by its title (or a data-tip name) and highlights it, once it has drawn. */
export function reveal(section: string, seg?: string) {
  let n = 0, switched = !seg;
  const find = () => (document.querySelector(`[data-tip="${CSS.escape(section)}"]`) as HTMLElement | null)
    ?? ([...document.querySelectorAll('main .card')].find((el) => el.querySelector(':scope > .card-h h3')?.textContent?.trim().toLowerCase() === section.toLowerCase()) as HTMLElement | undefined) ?? null;
  const tick = () => {
    if (!switched) {
      const b = [...document.querySelectorAll<HTMLButtonElement>('main .seg button')].find((x) => x.textContent?.trim() === seg);
      if (b) { switched = true; if (b.getAttribute('aria-pressed') !== 'true') { b.click(); setTimeout(tick, 80); return; } }
      else if (n > 6) switched = true;
    }
    const el = find();
    if (!el) { if (++n < 40) setTimeout(tick, 80); return; }
    el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2200);
  };
  setTimeout(tick, 60);
}

function carry(c: Ctx, g: Go) {
  const { ui, go, tabs, D } = c;
  if (g.kind === 'action') { runAction(c, g.id); return; }
  if (g.kind === 'go') {
    if (!tabs.some((t) => t.key === g.tab)) { ui.toast('That screen is not part of your role.'); return; }
    ui.close(); go(g.tab); if (g.section) reveal(g.section, g.seg); return;
  }
  if (g.kind === 'help') { ui.openPanel(g.title, <div className="help"><ol className="help-steps">{g.lines.map((s) => <li key={s}>{s}</li>)}</ol></div>); return; }
  ui.close(); ui.toast('Preparing the workbook…');
  downloadMonth(D, g.month).then((m) => ui.toast(`${m} downloaded.`)).catch((e) => ui.toast((e as Error).message));
}

const GROUP_LABEL: Record<Hit['group'], string> = { Answer: 'Answer', 'Do it': 'Form', Download: 'Download', Screen: 'Screen', Section: 'Section', Data: 'Record', Help: 'Help' };
const GROUP_COLOR: Record<Hit['group'], string> = { Answer: '--l-tuala', 'Do it': '--accent', Download: '--l-farm', Screen: '--info', Section: '--info', Data: '--l-van', Help: '--muted' };
const GROUP_VERB: Record<Hit['group'], string> = { Answer: 'Show', 'Do it': 'Open', Download: 'Download', Screen: 'Go', Section: 'Go', Data: 'Show', Help: 'Read' };

export function SearchBox(c: Ctx) {
  const { D, tabs } = c, who = whoFor(D);
  const [q, setQ] = useState(''), [sel, setSel] = useState(0), [past] = useState(recent);
  const ref = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const hits = useMemo(() => search(D, tabs, q), [D, tabs, q]);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { list.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  const pick = (h: Hit) => { if (q.trim()) remember(q.trim()); carry(c, h.go); };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    if (e.key === 'Enter' && hits[sel]) { e.preventDefault(); pick(hits[sel]); }
  };
  const ideas = IDEAS[who];
  return <div className="search">
    <div className="inp search-in"><Icon name="search" /><input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} placeholder="Search forms, screens, figures and help"
      aria-label="Search" autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="go" role="combobox" aria-expanded={hits.length > 0} aria-controls="search-results" />
      {q && <button type="button" className="eye" aria-label="Clear" onClick={() => { setQ(''); ref.current?.focus(); }}><Icon name="x" /></button>}</div>
    {!q.trim() ? <>
      {past.length > 0 && <div className="search-ideas"><small className="muted">Recent</small>{past.map((x) => <button key={x} className="lnk" onClick={() => setQ(x)}><Icon name="clock" />{x}</button>)}</div>}
      <div className="search-ideas"><small className="muted">Try</small>{ideas.map((x) => <button key={x} className="lnk" onClick={() => setQ(x)}>{x}</button>)}</div>
      <p className="muted small" style={{ margin: 0 }}>Type a word in English or Kiswahili, a name, or a day such as yesterday or 3 Nov.</p>
    </> : !hits.length ? <div className="empty"><Icon name="search" />Nothing matches "{q}". Try a shorter word, or open Help for the steps of each job.
        <button className="lnk" onClick={() => openHelp(c, '')}>Open Help</button></div>
      : <div className="list search-res" id="search-results" role="listbox" ref={list}>{hits.map((h, i) => <button key={h.key} role="option" aria-selected={i === sel}
          className={`li search-hit${i === sel ? ' sel' : ''}${i === 0 ? ' top' : ''}`} onClick={() => pick(h)} onMouseEnter={() => setSel(i)}>
          <span className="av" style={{ background: `var(${GROUP_COLOR[h.group]})` }}><Icon name={h.icon} /></span>
          <span className="mid"><b>{h.title}</b><small>{h.sub}</small><em className="crumb"><i>{GROUP_LABEL[h.group]}</i>{h.crumb && <span>{h.crumb}</span>}</em></span>
          <span className="go">{GROUP_VERB[h.group]}<Icon name="back" /></span></button>)}</div>}
    <p className="muted small search-keys">Enter opens the top result. On a computer, Ctrl+K opens Search from anywhere.</p>
  </div>;
}

