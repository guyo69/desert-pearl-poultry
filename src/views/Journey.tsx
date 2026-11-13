// The day's steps for each role, and the days that still have gaps.
// Steps are worked out from the dashboard; gaps come from the server's completeness check.
import { type ReactNode, useEffect, useState } from 'react';
import { type Gap, loadGaps } from '../lib/api';
import { dlabel, dshort, eggs, kes } from '../lib/format';
import { balance, canEnter, closedToday, feedUsed, isVan, locName, mix, produced, salesOn, stockNow, tankInfo, tot, waterOn } from '../lib/metrics';
import type { Dashboard } from '../lib/types';
import {
  millForm, storeFeedInForm, storeFeedIssueForm, collectForm, confirmIssueForm, countForm, dispatchForm, houseDayForm, moveForm, mortForm, receiveForm, saleForm, shopDayForm, tankForm, waterIntakeForm,
} from '../forms/forms';
import { Icon } from '../ui/icons';
import { useUI } from '../ui/ui';
import { Card } from '../ui/widgets';
import { WORK_COLOR, type Work } from '../ui/work';

interface Step { label: string; detail: string; done: boolean; optional?: boolean; go?: () => void; act?: string; work?: Work; icon?: string }

/**
 * The one thing to do now, as a big button at the top of the home screen:
 * the first step not done yet. When the day's steps are done it says so.
 */
function NextUp({ next, left, extra }: { next?: Step; left: number; extra?: Step }) {
  if (!next) return <section className="nextup done" data-tip="next">
    <span className="nu-ic" aria-hidden="true"><Icon name="check" /></span>
    <div className="nu-t"><small>Today</small><b>All done for now</b><p>{extra?.go ? `If needed: ${extra.label.toLowerCase()}.` : 'Everything due so far is recorded.'}</p></div>
    {extra?.go && <button className="btn alt" onClick={extra.go}>{extra.act ?? 'Start'}</button>}
  </section>;
  const w = next.work ?? 'check';
  return <section className={`nextup w-${w}`} data-tip="next" style={{ ['--nu' as string]: `var(${WORK_COLOR[w]})` }}>
    <span className="nu-ic" aria-hidden="true"><Icon name={next.icon ?? 'pulse'} /></span>
    <div className="nu-t"><small>Do this next{left > 1 ? ` · ${left - 1} more after this` : ''}</small><b>{next.label}</b><p>{next.detail}</p></div>
    {next.go && <button className="btn nu-go" onClick={next.go}>{next.act ?? 'Start'}<Icon name="back" /></button>}
  </section>;
}

function Steps({ title, steps, aside }: { title: string; steps: Step[]; aside?: ReactNode }) {
  const left = steps.filter((s) => !s.done && !s.optional).length;
  const next = steps.find((s) => !s.done && !s.optional);
  return <><NextUp next={next} left={left} extra={steps.find((s) => !s.done && s.optional && s.go)} /><Card tip="steps" title={title} aside={aside ?? <span className={`chip ${left ? 'sev-info' : 'sev-ok'}`}>{left ? `${left} to do` : 'All done'}</span>}>
    <ol className="steps">{steps.map((s, i) => <li key={i} className={`${s.done ? 'done' : ''}${s === next ? ' next' : ''}`}>
      <span className="tick" aria-hidden>{s.done ? <Icon name="check" /> : i + 1}</span>
      <div className="mid"><b>{s.label}{s.optional && !s.done ? <em> · if any</em> : null}</b><small>{s.detail}</small></div>
      {s.go && <button className={`btn sm${s === next ? '' : ' alt'}`} onClick={s.go} data-tip={`step:${s.label}`}>{s.act ?? (s.done ? 'Add more' : 'Start')}</button>}
    </li>)}</ol>
  </Card></>;
}

const has = (D: Dashboard, loc: string, day: string, kind: string) => D.stock_daily.some((r) => r.location_id === loc && r.d === day && r.kind === kind);

/** Production clerk: the order the farm day is usually done in. */
export function ClerkSteps({ D }: { D: Dashboard }) {
  const ui = useUI(), t = D.today;
  const tank = tankInfo(D), feed = feedUsed(D, [t]);
  const noWater = D.houses.filter((h) => !waterOn(D, [t], h.id)), noEggs = D.houses.filter((h) => !produced(D, [t], h.id));
  const sent = has(D, 'FARM', t, 'out');
  const pendFeed = (D.store_pending ?? []).filter((x) => x.kind === 'feed');
  const steps: Step[] = [
    { label: 'Read the water tank', detail: tank && D.tank?.d === t ? `Read today: ${Math.round(tank.level * 100)}%` : 'First thing: how full is the tank?', done: D.tank?.d === t, go: () => ui.openForm(tankForm(D)), act: 'Read', work: 'check', icon: 'tank' },
    { label: 'Feed from the store', detail: pendFeed.length ? `${pendFeed.length} issue${pendFeed.length === 1 ? '' : 's'} to confirm: check what reached each house` : feed > 0 ? `${(feed / D.settings.bag_kg).toFixed(1)} bags issued today, all confirmed` : 'The inventory clerk issues feed to each house; confirm what arrives',
      done: feed > 0 && !pendFeed.length, go: pendFeed[0] ? () => ui.openForm(confirmIssueForm(D, pendFeed[0])) : undefined, act: 'Confirm', work: 'in', icon: 'sack' },
    { label: 'Water drunk', detail: noWater.length ? `Still to record: ${noWater.map((h) => h.name).join(', ')}` : 'Every house recorded', done: !noWater.length, go: () => ui.openForm(waterIntakeForm(D)), work: 'check', icon: 'drop' },
    { label: 'Collect and grade the eggs', detail: noEggs.length ? `Still to collect: ${noEggs.map((h) => h.name).join(', ')}. Normal, jumbo, cracked, damaged.` : `${eggs(produced(D, [t]))} collected today`, done: !noEggs.length, go: () => ui.openForm(collectForm(D)), work: 'make', icon: 'egg' },
    { label: 'Deaths', detail: 'Record any birds that died, by house', done: D.farm_daily.some((r) => r.d === t && r.deaths > 0), optional: true, go: () => ui.openForm(mortForm(D)), act: 'Record', work: 'loss', icon: 'bird' },
    { label: 'Send eggs to the outlets', detail: sent ? 'Sent today. Each outlet confirms on arrival.' : 'Choose an outlet, enter the eggs, repeat for the next', done: sent, go: () => ui.openForm(dispatchForm(D, 'FARM')), act: 'Send', work: 'out', icon: 'truck' },
  ];
  return <Steps title="Today on the farm" steps={steps} aside={<button className="lnk" onClick={() => ui.openForm(houseDayForm(D))}>Whole day in one sheet</button>} />;
}

/** Inventory clerk: feed to the houses first, then deliveries and milling as they happen. */
export function StoreSteps({ D }: { D: Dashboard }) {
  const ui = useUI(), t = D.today, feed = feedUsed(D, [t]);
  const low = [...D.medicines.filter((m) => m.active && m.stock <= m.reorder), ...(D.supplies ?? []).filter((x) => x.active && x.stock <= x.reorder)];
  const milled = (D.mill_daily ?? []).some((x) => x.d === t);
  const steps: Step[] = [
    { label: 'Feed for the houses', detail: feed > 0 ? `${(feed / D.settings.bag_kg).toFixed(1)} bags issued today` : 'Issue the day\'s feed to each house. The production clerk confirms it.',
      done: feed > 0, go: () => ui.openForm(storeFeedIssueForm(D)), act: 'Issue', work: 'out', icon: 'sack' },
    { label: 'Deliveries', detail: 'Count the bags or items as each delivery arrives', done: false, optional: true, go: () => ui.openForm(storeFeedInForm(D)), act: 'Feed received', work: 'in', icon: 'inbox' },
    ...((D.raw ?? []).length ? [{ label: 'Milling', detail: milled ? 'Milled today' : 'After each mixing, enter the tonnes', done: milled, optional: true, go: () => ui.openForm(millForm(D)), act: 'Feed milled', work: 'make' as Work, icon: 'scoop' }] : []),
    { label: 'Running low', detail: low.length ? `Tell the farm manager: ${low.map((x) => x.name).slice(0, 3).join(', ')}${low.length > 3 ? ` and ${low.length - 3} more` : ''}` : 'Nothing below its reorder level', done: !low.length, optional: true },
  ];
  return <Steps title="Today in the store" steps={steps} />;
}

/** Shops, van and farm counter: open, receive, sell, issue / damaged, close. */
export function ShopSteps({ D, loc }: { D: Dashboard; loc: string }) {
  if (isVan(D, loc)) return <VanSteps D={D} loc={loc} />;
  return <OutletSteps D={D} loc={loc} />;
}

/**
 * The mobile van: no opening or closing count. It loads, delivers, sells on
 * the road, and ends the day empty by dropping what is left at the farm or an
 * outlet. The driver banks or sends the cash.
 */
export function VanSteps({ D, loc }: { D: Dashboard; loc: string }) {
  const ui = useUI(), t = D.today;
  const waiting = D.transit.filter((x) => x.to_loc === loc), s = salesOn(D, [t], loc);
  const onBoard = stockNow(D, loc), left = Math.max(0, tot(onBoard));
  const moved = D.stock_daily.some((r) => r.location_id === loc && r.d === t);
  const cash = balance(D, `CASH:${loc}`);
  const steps: Step[] = [
    { label: 'Eggs loaded', detail: waiting.length ? `${waiting.length} waiting: count what you load and any damaged` : has(D, loc, t, 'recv') ? 'Loaded today' : 'Nothing waiting for the van',
      done: !waiting.length, go: waiting[0] ? () => ui.openForm(receiveForm(D, waiting[0])) : undefined, act: 'Count them', work: 'in', icon: 'inbox' },
    { label: 'Deliver to the farm or outlets', detail: has(D, loc, t, 'out') ? 'Delivered today. Each place confirms on arrival.' : 'Choose where, enter the eggs, repeat for the next stop',
      done: has(D, loc, t, 'out'), optional: true, go: () => ui.openForm(dispatchForm(D, loc)), act: 'Deliver', work: 'out', icon: 'truck' },
    { label: 'Sell on the road', detail: s.cnt ? `${s.cnt} sale${s.cnt === 1 ? '' : 's'} · ${eggs(s.pcs)}` : 'Record each sale as it happens', done: s.cnt > 0, optional: true, go: () => ui.openForm(saleForm(D, loc)), act: s.cnt ? 'New sale' : 'Record', work: 'sell', icon: 'receipt' },
    { label: 'End the day empty', detail: left ? `${mix(onBoard)} still on board: drop it at the farm or an outlet` : moved ? 'Nothing left on the van' : 'Nothing on board',
      done: !left, go: left ? () => ui.openForm(dispatchForm(D, loc, { leftover: true })) : undefined, act: 'Drop off', work: 'out', icon: 'truck' },
    { label: 'Bank or send the cash', detail: cash > 0 ? `${kes(cash)} with the driver` : 'No cash with the driver',
      done: cash <= 0, optional: cash <= 0, go: () => ui.openForm(moveForm(D, loc)), act: 'Move money', work: 'spend', icon: 'swap' },
  ];
  return <Steps title="Today on the van" steps={steps} />;
}

function OutletSteps({ D, loc }: { D: Dashboard; loc: string }) {
  const ui = useUI(), t = D.today;
  const opened = D.counts_today.some((c) => c.location_id === loc && c.kind === 'open');
  const closed = D.counts_today.some((c) => c.location_id === loc && c.kind === 'close');
  const waiting = D.transit.filter((x) => x.to_loc === loc), s = salesOn(D, [t], loc);
  const l = D.locations.find((x) => x.id === loc);
  // on the regular closing day nothing is due unless they choose to trade
  const resting = !!l && closedToday(D, l) && !opened && !s.cnt;
  const steps: Step[] = [
    { label: 'Opening count', detail: opened ? 'Done: the day started from a real count' : 'Count the eggs on hand before selling', done: opened, go: opened ? undefined : () => ui.openForm(countForm(D, loc, 'open')), act: 'Count', work: 'check', icon: 'count' },
    { label: 'Eggs arrived', detail: waiting.length ? `${waiting.length} on the way: count what arrives and any damaged` : has(D, loc, t, 'recv') ? 'Counted in today' : 'Nothing on the way', done: !waiting.length,
      go: waiting[0] ? () => ui.openForm(receiveForm(D, waiting[0])) : undefined, act: 'Count them', work: 'in', icon: 'inbox' },
    { label: 'Sales', detail: s.cnt ? `${s.cnt} sale${s.cnt === 1 ? '' : 's'} · ${eggs(s.pcs)}` : 'Record each sale as it happens', done: s.cnt > 0, go: () => ui.openForm(saleForm(D, loc)), act: s.cnt ? 'New sale' : 'Record', work: 'sell', icon: 'receipt' },
    { label: 'Send eggs', detail: has(D, loc, t, 'out') ? 'Sent to another location today' : 'To another outlet or the van', done: has(D, loc, t, 'out'), optional: true, go: () => ui.openForm(dispatchForm(D, loc)), act: 'Send', work: 'out', icon: 'truck' },
    { label: 'Close the day', detail: closed ? 'Closed: stock and cash counted' : 'Count the eggs left and the cash in the drawer', done: closed, go: () => ui.openForm(countForm(D, loc, 'close')), act: 'Close', work: 'check', icon: 'count' },
  ];
  return <Steps title={resting ? 'Closed today: regular closing day' : "Today's steps"} steps={resting ? steps.map((x) => ({ ...x, optional: true })) : steps}
    aside={<button className="lnk" onClick={() => ui.openForm(shopDayForm(D, loc))}>Daily stock sheet</button>} />;
}

/** Owner and farm manager: what was not entered on the last 62 tracked days (as far back as a skipped day can be entered), newest first. Null while loading. */
export function useGaps(version?: number): Gap[] | null {
  const [gaps, setGaps] = useState<Gap[] | null>(null);
  useEffect(() => { loadGaps(62).then((g) => setGaps(g.slice().reverse())).catch(() => setGaps([])); }, [version]);
  return gaps;
}

/** "9 records on 3 days (29 Oct to 1 Nov)": the one-line summary used on the Overview. */
export function gapSummary(gaps: Gap[]) {
  const days = [...new Set(gaps.map((g) => g.day))].sort();
  const records = gaps.reduce((a, g) => a + g.missing.length, 0);
  const span = days.length > 1 ? ` (${dshort(days[0])} to ${dshort(days[days.length - 1])})` : ` (${dlabel(days[0])})`;
  return `${records} record${records === 1 ? '' : 's'} not entered on ${days.length} day${days.length === 1 ? '' : 's'}${span}`;
}

/**
 * Owner and farm manager: days in the last two weeks with something missing,
 * from the same server check that sends the morning reminders (closed days
 * and regular closing days are already left out). Each line opens the sheet
 * that fills it. Shows the newest few; the rest open on request.
 */
export function MissingDays({ D, gaps }: { D: Dashboard; gaps: Gap[] | null }) {
  const ui = useUI();
  const [all, setAll] = useState(false);
  if (!gaps?.length) return null;
  const shown = all ? gaps : gaps.slice(0, 5);
  const open = (g: Gap) => ui.openForm(g.scope === 'outlet' ? (isVan(D, g.id) ? dispatchForm(D, g.id, { leftover: true }) : shopDayForm(D, g.id, g.day)) : houseDayForm(D, g.day));
  return <Card tip="gaps" title="Days with gaps" aside={<span className="chip sev-amber">{gaps.length}</span>}>
    <p className="muted" style={{ margin: '0 0 8px', fontSize: 13.5 }}>{gapSummary(gaps)}.{canEnter(D) ? ' Fill a missed day from the paper book, or mark an outlet closed.' : ' The farm manager or the person on duty fills these in.'}</p>
    <div className="list">{shown.map((g) => <div className="li" key={`${g.day}-${g.scope}-${g.id}`}>
      <span className="av" style={{ background: 'var(--f-watch)' }}><Icon name="clock" /></span>
      <div className="mid"><b>{dlabel(g.day)} · {g.name}</b><small>Not entered: {g.missing.join(', ')}</small></div>
      {canEnter(D) && <div className="end"><button className="act" onClick={() => open(g)}>Fill in</button></div>}</div>)}</div>
    {gaps.length > 5 && <button className="lnk" style={{ marginTop: 8 }} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${gaps.length}`}</button>}
  </Card>;
}

export const shopName = locName;
