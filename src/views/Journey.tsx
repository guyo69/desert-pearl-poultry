// The day's steps for each role, and the days that still have gaps.
// Everything is worked out from the dashboard: nothing extra is stored.
import type { ReactNode } from 'react';
import { addDays, dlabel, eggs, range } from '../lib/format';
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

/** Owner and farm manager: days in the last two weeks with something missing, each one tap away from the sheet that fills it. */
export function MissingDays({ D }: { D: Dashboard }) {
  const ui = useUI();
  const start = [D.settings.go_live ?? D.from, addDays(D.today, -14), D.from].sort().pop()!;
  const days = start < D.today ? range(start, addDays(D.today, -1)).reverse() : [];
  const gaps: { day: string; where: string; what: string; open: () => void }[] = [];
  for (const d of days) {
    const houses = D.houses.filter((h) => h.start_date <= d && !produced(D, [d], h.id));
    const noFeed = D.houses.some((h) => h.start_date <= d) && feedUsed(D, [d]) <= 0;
    if (houses.length || noFeed) gaps.push({ day: d, where: 'Central Farm',
      what: [houses.length && `no eggs for ${houses.map((h) => h.name).join(', ')}`, noFeed && 'no feed used'].filter(Boolean).join(' · '), open: () => ui.openForm(houseDayForm(D, d)) });
    for (const l of D.locations.filter((x) => x.id !== 'FARM')) {
      const sold = salesOn(D, [d], l.id).cnt > 0, counted = has(D, l.id, d, 'adj');
      if (!sold && !counted) gaps.push({ day: d, where: l.name, what: 'no sales or count (closed?)', open: () => ui.openForm(shopDayForm(D, l.id, d)) });
      else if (!counted) gaps.push({ day: d, where: l.name, what: 'no closing count', open: () => ui.openForm(shopDayForm(D, l.id, d)) });
    }
  }
  if (!gaps.length) return null;
  const shown = gaps.slice(0, 12);
  return <Card title="Days with gaps" aside={<span className="chip sev-amber">{gaps.length}</span>}>
    <p className="muted" style={{ margin: '0 0 8px', fontSize: 13.5 }}>Fill a missed day from the paper book. The app works out opening stock, hens, age and lay rate for that day.</p>
    <div className="list">{shown.map((g, i) => <div className="li" key={i}>
      <span className="av" style={{ background: 'var(--f-watch)' }}><Icon name="clock" /></span>
      <div className="mid"><b>{dlabel(g.day)} · {g.where}</b><small>{g.what}</small></div>
      <div className="end"><button className="act" onClick={g.open}>Fill in</button></div></div>)}</div>
    {gaps.length > shown.length && <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>{gaps.length - shown.length} more, further back.</p>}
  </Card>;
}

export const shopName = locName;
