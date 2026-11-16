// In-app help: tips that point at the real buttons (once each, in the order
// people work, only when the button is on screen). The Help panel and Search
// live in HelpPanels.tsx and load when first opened. Content lives in lib/help.ts.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { rpc } from '../lib/api';
import { TIPS, whoFor, type Tip } from '../lib/help';
import type { Dashboard } from '../lib/types';
import type { Ctx } from './HelpPanels';

export interface TabInfo { key: string; label: string; icon: string }
export { whoFor };

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
export async function replayTips(D: Dashboard, tab: string) {
  const ids = TIPS[whoFor(D)].filter((t) => t.tab === tab || t.tab === '*').map((t) => t.id);
  const left = await rpc<string[]>('rpc_tips', { p_reset: ids });
  dispatchEvent(new CustomEvent('dpv-tips', { detail: new Set(left ?? []) }));
}


// ---------------------------------------------------------------------------- opening the panels
const panels = () => import('./HelpPanels');
export function openSearch(c: Ctx) { panels().then((m) => c.ui.openPanel('Search', <m.SearchBox {...c} />)).catch(() => c.ui.toast('Search could not open. Check the connection.')); }
export function openHelp(c: Ctx, tab: string) { panels().then((m) => c.ui.openPanel('Help', <m.HelpPanel {...c} tab={tab} />)).catch(() => c.ui.toast('Help could not open. Check the connection.')); }
