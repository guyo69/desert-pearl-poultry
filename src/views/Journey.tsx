// The day's steps for each role, and the days that still have gaps.
// Steps are worked out from the dashboard; gaps come from the server's completeness check.
import { type ReactNode, useEffect, useState } from 'react';
import { type Gap, loadGaps } from '../lib/api';
import { dlabel, eggs } from '../lib/format';
import { feedUsed, locName, produced, salesOn, tankInfo, waterOn } from '../lib/metrics';
import type { Dashboard } from '../lib/types';
import {
  collectForm, countForm, dispatchForm, feedUseForm, houseDayForm, issueForm, mortForm, receiveForm, saleForm, shopDayForm, tankForm, waterIntakeForm,
} from '../forms/forms';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { Card } from '../ui/widgets';

interface Step { label: string; detail: string; done: boolean; optional?: boolean; go?: () => void; act?: string }

function Steps({ title, steps, aside }: { title: string; steps: Step[]; aside?: ReactNode }) {
  const left = steps.filter((s) => !s.done && !s.optional).length;
  const next = steps.find((s) => !s.done && !s.optional);
  return <Card title={title} aside={aside ?? <span className={`chip ${left ? 'sev-info' : 'sev-ok'}`}>{left ? `${left} to do` : 'All done'}</span>}>
    <ol className="steps">{steps.map((s, i) => <li key={i} className={`${s.done ? 'done' : ''}${s === next ? ' next' : ''}`}>
      <span className="tick" aria-hidden>{s.done ? <Icon name="check" /> : i + 1}</span>
      <div className="mid"><b>{s.label}{s.optional && !s.done ? <em> · if any</em> : null}</b><small>{s.detail}</small></div>
      {s.go && <button className={`btn sm${s === next ? '' : ' alt'}`} onClick={s.go}>{s.act ?? (s.done ? 'Add more' : 'Start')}</button>}
    </li>)}</ol>
  </Card>;
}

const has = (D: Dashboard, loc: string, day: string, kind: string) => D.stock_daily.some((r) => r.location_id === loc && r.d === day && r.kind === kind);

/** Production clerk: the order the farm day is usually done in. */
export function ClerkSteps({ D }: { D: Dashboard }) {
  const ui = useUI(), t = D.today;
  const tank = tankInfo(D), feed = feedUsed(D, [t]);
  const noWater = D.houses.filter((h) => !waterOn(D, [t], h.id)), noEggs = D.houses.filter((h) => !produced(D, [t], h.id));
  const sent = has(D, 'FARM', t, 'out');
  const steps: Step[] = [
    { label: 'Read the water tank', detail: tank && D.tank?.d === t ? `Read today: ${Math.round(tank.level * 100)}%` : 'First thing: how full is the tank?', done: D.tank?.d === t, go: () => ui.openForm(tankForm(D)), act: 'Read' },
    { label: 'Feed the birds', detail: feed > 0 ? `${(feed / D.settings.bag_kg).toFixed(1)} bags recorded today` : 'Record the bags given at each feeding', done: feed > 0, go: () => ui.openForm(feedUseForm(D)) },
    { label: 'Water drunk', detail: noWater.length ? `Still to record: ${noWater.map((h) => h.name).join(', ')}` : 'Every house recorded', done: !noWater.length, go: () => ui.openForm(waterIntakeForm(D)) },
    { label: 'Collect and grade the eggs', detail: noEggs.length ? `Still to collect: ${noEggs.map((h) => h.name).join(', ')}. Normal, big, jumbo, cracked, damaged.` : `${eggs(produced(D, [t]))} collected today`, done: !noEggs.length, go: () => ui.openForm(collectForm(D)) },
    { label: 'Deaths', detail: 'Record any birds that died, by house', done: D.farm_daily.some((r) => r.d === t && r.deaths > 0), optional: true, go: () => ui.openForm(mortForm(D)), act: 'Record' },
    { label: 'Send eggs to the outlets', detail: sent ? 'Sent today. Each outlet confirms on arrival.' : 'One entry for all outlets', done: sent, go: () => ui.openForm(dispatchForm(D, 'FARM')), act: 'Send' },
  ];
  return <Steps title="Today on the farm" steps={steps} aside={<button className="lnk" onClick={() => ui.openForm(houseDayForm(D))}>Whole day in one sheet</button>} />;
}

/** Shops, van and farm counter: open, receive, sell, issue / damaged, close. */
export function ShopSteps({ D, loc }: { D: Dashboard; loc: string }) {
  const ui = useUI(), t = D.today;
  const opened = D.counts_today.some((c) => c.location_id === loc && c.kind === 'open');
  const closed = D.counts_today.some((c) => c.location_id === loc && c.kind === 'close');
  const waiting = D.transit.filter((x) => x.to_loc === loc), s = salesOn(D, [t], loc);
  const steps: Step[] = [
    { label: 'Opening count', detail: opened ? 'Done: the day started from a real count' : 'Count the eggs on hand before selling', done: opened, go: opened ? undefined : () => ui.openForm(countForm(D, loc, 'open')), act: 'Count' },
    { label: 'Receive deliveries', detail: waiting.length ? `${waiting.length} on the way: count what arrives and any damaged` : has(D, loc, t, 'recv') ? 'Received today' : 'Nothing waiting', done: !waiting.length,
      go: waiting[0] ? () => ui.openForm(receiveForm(D, waiting[0])) : undefined, act: 'Receive' },
    { label: 'Sales', detail: s.cnt ? `${s.cnt} sale${s.cnt === 1 ? '' : 's'} · ${eggs(s.pcs)}` : 'Record each sale as it happens', done: s.cnt > 0, go: () => ui.openForm(saleForm(D, loc)), act: s.cnt ? 'New sale' : 'Record' },
    { label: 'Eggs issued out', detail: has(D, loc, t, 'issue') ? 'Recorded today' : 'Credit customers, bulk orders collected', done: has(D, loc, t, 'issue'), optional: true, go: () => ui.openForm(issueForm(D, loc)), act: 'Issue' },
    { label: 'Close the day', detail: closed ? 'Closed: stock and cash counted' : 'Count the eggs left and the cash in the drawer', done: closed, go: () => ui.openForm(countForm(D, loc, 'close')), act: 'Close' },
  ];
  return <Steps title="Today's steps" steps={steps} aside={<button className="lnk" onClick={() => ui.openForm(shopDayForm(D, loc))}>Daily stock sheet</button>} />;
}

/**
 * Owner and farm manager: days in the last two weeks with something missing,
 * from the same server check that sends the morning reminders (closed days
 * and regular closing days are already left out). Each line opens the sheet
 * that fills it.
 */
export function MissingDays({ D, version }: { D: Dashboard; version?: number }) {
  const ui = useUI();
  const [gaps, setGaps] = useState<Gap[] | null>(null);
  useEffect(() => { loadGaps(14).then((g) => setGaps(g.slice().reverse())).catch(() => setGaps([])); }, [version]);
  if (!gaps?.length) return null;
  const shown = gaps.slice(0, 12);
  const open = (g: Gap) => ui.openForm(g.scope === 'outlet' ? shopDayForm(D, g.id, g.day) : houseDayForm(D, g.day));
  return <Card title="Days with gaps" aside={<span className="chip sev-amber">{gaps.length}</span>}>
    <p className="muted" style={{ margin: '0 0 8px', fontSize: 13.5 }}>Fill a missed day from the paper book, or mark an outlet closed. The app works out opening stock, hens, age and lay rate for that day.</p>
    <div className="list">{shown.map((g) => <div className="li" key={`${g.day}-${g.scope}-${g.id}`}>
      <span className="av" style={{ background: 'var(--f-watch)' }}><Icon name="clock" /></span>
      <div className="mid"><b>{dlabel(g.day)} · {g.name}</b><small>Not entered: {g.missing.join(', ')}</small></div>
      <div className="end"><button className="act" onClick={() => open(g)}>Fill in</button></div></div>)}</div>
    {gaps.length > shown.length && <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>{gaps.length - shown.length} more, further back.</p>}
  </Card>;
}

export const shopName = locName;
