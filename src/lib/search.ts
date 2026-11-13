// Search over everything a person can reach: forms that open directly, screens
// and the sections inside them, monthly workbook downloads, quick answers from
// today's figures, farm data (outlets, people, customers who owe, houses,
// medicines, supplies, raw materials, days) and the help. Pure: it returns what
// to do as data (`Go`), and ui/Help.tsx carries it out. tests/search.test.ts
// holds the golden queries that must keep working.
import { addDays, dlabel, eggs, kes, n0, pct } from './format';
import { whoOf, FAQS, TASKS, type Who } from './help';
import { balance, canEnter, cashAcc, feedInfo, houseAge, isVan, layRate, millInfo, produced, deaths, salesOn, stockNow, tankInfo, tot, totalFunds } from './metrics';
import type { Dashboard } from './types';

// ---------------------------------------------------------------------------- what search can open
/** Forms that search and the how-to steps can open, with who can use them (ui/Help.tsx runs them). */
export interface ActionMeta { id: string; label: string; keywords: string; who: Who[]; enter?: boolean; /** the name a role knows it by */ as?: Partial<Record<Who, string>> }
const SHOP: Who[] = ['pos'], ROAD: Who[] = ['pos', 'van'];
export const ACTION_META: ActionMeta[] = [
  { id: 'sale', label: 'Record a sale', keywords: 'sell sold customer cash till paybill mpesa credit', who: ROAD, enter: true },
  { id: 'count_open', label: 'Opening count', keywords: 'start morning count stock open', who: SHOP, enter: true },
  { id: 'count_close', label: 'Close the day: closing count', keywords: 'closing evening end count close', who: SHOP, enter: true },
  { id: 'cash_count', label: 'Count the cash', keywords: 'cash drawer money count', who: SHOP, enter: true },
  { id: 'receive', label: 'Eggs arrived', keywords: 'receive load arrive arrived stock in transfer delivery count', who: ['pos', 'van', 'clerk', 'manager'], enter: true, as: { van: 'Eggs loaded' } },
  { id: 'dispatch', label: 'Send eggs to another location', keywords: 'issue eggs deliver transfer send outlet van dispatch', who: ['pos', 'van', 'clerk', 'manager'], enter: true, as: { van: 'Deliver eggs', clerk: 'Send eggs to an outlet or the van', pos: 'Send eggs' } },
  { id: 'leftover', label: 'Drop off what is left on the van', keywords: 'left over empty end of day van', who: ['van'], enter: true },
  { id: 'damaged', label: 'Damaged eggs', keywords: 'broken spoilt breakage loss damaged', who: ROAD, enter: true },
  { id: 'shop_day', label: 'Daily stock sheet', keywords: 'stock sheet book closed day', who: SHOP, enter: true },
  { id: 'credit_paid', label: 'Credit paid back', keywords: 'credit debt owe customer paid pay back', who: ['pos', 'van', 'manager'], enter: true },
  { id: 'expense', label: 'Record an expense', keywords: 'expense spend paid cost', who: ['pos', 'van', 'manager'], enter: true },
  { id: 'move', label: 'Bank or move money', keywords: 'bank deposit mpesa paybill move money cash', who: ['pos', 'van', 'manager'], enter: true },
  { id: 'tank', label: 'Tank level', keywords: 'water tank level reading refill', who: ['clerk', 'manager'], enter: true },
  { id: 'water', label: 'Water drunk', keywords: 'water litres drink house', who: ['clerk', 'manager'], enter: true },
  { id: 'collect', label: 'Egg collection', keywords: 'eggs collect collection grade cracked jumbo damaged house', who: ['clerk', 'manager'], enter: true },
  { id: 'house_day', label: 'Daily house sheet', keywords: 'house sheet whole day farm book', who: ['clerk', 'manager'], enter: true },
  { id: 'mortality', label: 'Record deaths', keywords: 'mortality dead died deaths birds', who: ['clerk', 'manager'], enter: true },
  { id: 'confirm', label: 'Confirm what the store issued', keywords: 'confirm feed medicine arrived store', who: ['clerk', 'manager'], enter: true },
  { id: 'feed_in', label: 'Feed received', keywords: 'feed delivery bags supplier received', who: ['store', 'manager'], enter: true },
  { id: 'feed_issue', label: 'Issue feed to a house', keywords: 'feed issue house bags feeding', who: ['store', 'manager'], enter: true },
  { id: 'med_in', label: 'Medicine received', keywords: 'medicine vaccine delivery received', who: ['store', 'manager'], enter: true },
  { id: 'med_issue', label: 'Issue medicine to a house', keywords: 'medicine vaccine issue house', who: ['store', 'manager'], enter: true },
  { id: 'supply_in', label: 'Supplies received', keywords: 'trays packaging cleaning supplies delivery received', who: ['store', 'manager'], enter: true },
  { id: 'supply_out', label: 'Issue supplies', keywords: 'trays packaging supplies issue', who: ['store', 'manager'], enter: true },
  { id: 'mill', label: 'Feed milled', keywords: 'mill mix tonnes feed recipe milling', who: ['store', 'manager'], enter: true },
  { id: 'raw_in', label: 'Raw material received', keywords: 'maize soybean bran sunflower limestone grit macropack delivery raw', who: ['store', 'manager'], enter: true },
  { id: 'raw_count', label: 'Count the raw material store', keywords: 'count stock take raw store', who: ['store', 'manager'], enter: true },
  { id: 'recipe', label: 'Change the feed recipe', keywords: 'recipe formula mill kg tonne', who: ['owner', 'manager'] },
  { id: 'flock', label: 'Place a new flock', keywords: 'flock hens breed placement new birds', who: ['owner', 'manager', 'clerk'] },
  { id: 'house_new', label: 'Add a house', keywords: 'house expansion new building', who: ['owner', 'manager', 'clerk'] },
  { id: 'staff', label: 'Add a member of staff', keywords: 'staff user account employee new', who: ['owner', 'manager'] },
];
export const whoFor = (D: Dashboard): Who => whoOf(D.me.role, D.me.role === 'pos' && !!D.me.location_id && isVan(D, D.me.location_id));
export const actionsFor = (D: Dashboard, who: Who) => ACTION_META.filter((a) => a.who.includes(who) && (!a.enter || canEnter(D)));

/**
 * Sections inside screens, by the title on their card. `tabs` are the screens
 * that show the card, first match wins; search goes there, scrolls to the card
 * and highlights it. tests/search.test.ts checks each title is still on a card.
 */
export interface Section { title: string; tabs: string[]; keywords: string; who?: Who[]; /** a switch on the screen that shows the card */ seg?: string }
export const SECTIONS: Section[] = [
  { seg: 'Farm setup', title: 'Monthly workbooks', tabs: ['settings', 'report'], keywords: 'workbook excel spreadsheet download month report outlet ledger xlsx', who: ['owner', 'manager'] },
  { seg: 'Farm setup', title: 'Staff', tabs: ['settings'], keywords: 'staff people users accounts employees password reset two-step', who: ['owner', 'manager'] },
  { seg: 'Farm setup', title: 'Prices & thresholds', tabs: ['settings'], keywords: 'price prices tray cost thresholds settings tank size feed buffer', who: ['owner', 'manager'] },
  { seg: 'Farm setup', title: 'Opening balances', tabs: ['settings'], keywords: 'opening balances go live start', who: ['owner'] },
  { seg: 'Sign-in security', title: 'Sign-in security log', tabs: ['settings'], keywords: 'security log sign in login attempts', who: ['owner'] },
  { title: 'My account', tabs: ['settings', 'me'], keywords: 'account password change two-step recovery email sign out' },
  { title: 'Houses and flocks', tabs: ['health', 'settings'], keywords: 'houses flocks hens breed age placement', who: ['owner', 'manager', 'clerk'] },
  { title: 'Flock health', tabs: ['health'], keywords: 'health deaths mortality lay rate hens', who: ['owner', 'manager', 'clerk'] },
  { title: 'Vaccination & treatment schedule', tabs: ['health'], keywords: 'vaccination vaccine schedule treatment due', who: ['owner', 'manager', 'clerk'] },
  { title: 'Medicine & vaccine store', tabs: ['health', 'meds'], keywords: 'medicine vaccine store stock drugs' },
  { title: 'Other supplies', tabs: ['meds'], keywords: 'supplies trays packaging cleaning', who: ['store'] },
  { title: 'Running low', tabs: ['store'], keywords: 'low stock reorder running out', who: ['store'] },
  { title: 'Feed in store', tabs: ['feed'], keywords: 'feed store bags buffer stock left', who: ['owner', 'manager', 'clerk', 'store'] },
  { title: 'Daily use vs plan', tabs: ['feed'], keywords: 'feed use plan consumption', who: ['owner', 'manager', 'clerk', 'store'] },
  { title: 'Raw material store', tabs: ['mill'], keywords: 'raw material maize soybean bran mill can make', who: ['owner', 'manager', 'store'] },
  { title: 'Recipe for a tonne of layers feed', tabs: ['mill'], keywords: 'recipe formula tonne layers feed', who: ['owner', 'manager', 'store'] },
  { title: 'Mill records', tabs: ['mill'], keywords: 'mill records milling history', who: ['owner', 'manager', 'store'] },
  { title: 'Tank level', tabs: ['water'], keywords: 'tank level water reading', who: ['owner', 'manager', 'clerk'] },
  { title: 'Drinking by house', tabs: ['water'], keywords: 'water drinking house litres', who: ['owner', 'manager', 'clerk'] },
  { title: 'Days with gaps', tabs: ['alerts'], keywords: 'missed day gap missing earlier fill in', who: ['owner', 'manager'] },
  { title: 'Deliveries not yet confirmed', tabs: ['alerts'], keywords: 'deliveries transit not confirmed on the way', who: ['owner', 'manager'] },
  { title: 'Sales points right now', tabs: ['ov'], keywords: 'outlets sales points shops today stock cash', who: ['owner', 'manager'] },
  { title: 'Egg production', tabs: ['ov'], keywords: 'eggs production lay rate collected', who: ['owner', 'manager'] },
  { title: 'On hand now', tabs: ['stock'], keywords: 'stock on hand eggs trays everywhere', who: ['owner', 'manager'] },
  { title: 'On the way', tabs: ['stock'], keywords: 'transit on the way deliveries', who: ['owner', 'manager'] },
  { title: 'Damaged eggs, last 7 days', tabs: ['stock'], keywords: 'damaged broken breakage loss', who: ['owner', 'manager'] },
  { title: 'Do the books balance?', tabs: ['money'], keywords: 'books balance funds reconcile money accounts', who: ['owner', 'manager'] },
  { title: 'Today by sales point', tabs: ['money'], keywords: 'cash per outlet sales point money expected cash count', who: ['owner', 'manager'] },
  { title: 'Outstanding credits', tabs: ['money', 'ov', 'pmoney', 'today'], keywords: 'credit owe debt customers debtors' },
  { title: 'Key findings', tabs: ['report'], keywords: 'findings weekly report attention', who: ['owner', 'manager'] },
  { title: 'Flock performance', tabs: ['report'], keywords: 'flock performance breed guide lay', who: ['owner', 'manager'] },
  { title: 'Recommended actions', tabs: ['report'], keywords: 'actions recommendations to do', who: ['owner', 'manager'] },
  { title: 'Activity log', tabs: ['activity'], keywords: 'activity records log who entered history', who: ['owner', 'manager'] },
  { title: "Today's stock sheet", tabs: ['pstock'], keywords: 'stock sheet opening received sold on hand', who: ['pos'] },
  { title: 'Recent sales', tabs: ['psales'], keywords: 'sales recent receipts', who: ['pos'] },
  { title: 'Cash drawer today', tabs: ['pmoney'], keywords: 'cash drawer money count', who: ['pos'] },
  { title: "The van's load today", tabs: ['pstock'], keywords: 'van load on board stock', who: ['van'] },
];

// ---------------------------------------------------------------------------- results
/** What a result does when chosen. */
export type Go =
  | { kind: 'action'; id: string }
  | { kind: 'go'; tab: string; section?: string; seg?: string }
  | { kind: 'help'; title: string; lines: string[] }
  | { kind: 'download'; month: string };
export type Group = 'Answer' | 'Do it' | 'Download' | 'Screen' | 'Section' | 'Data' | 'Help';
export interface Entry { key: string; group: Group; title: string; sub: string; crumb: string; icon: string; terms: string; boost: number; go: Go }
export interface Hit extends Entry { score: number }
export interface TabLite { key: string; label: string; icon: string }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (m: string) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const ROLE_NAME: Record<string, string> = { owner: 'Owner', manager: 'Farm manager', clerk: 'Production clerk', store: 'Inventory clerk', pos: 'Sales point' };

/** Everything this person can find, built from today's dashboard. */
export function catalog(D: Dashboard, tabs: TabLite[]): Entry[] {
  const who = whoFor(D), mgmt = who === 'owner' || who === 'manager', farm = mgmt || who === 'clerk';
  const tabName = (k: string) => tabs.find((t) => t.key === k)?.label ?? k;
  const has = (k: string) => tabs.some((t) => t.key === k);
  const out: Entry[] = [];
  const push = (e: Omit<Entry, 'boost'> & { boost?: number }) => out.push({ boost: 0, ...e });

  for (const a of actionsFor(D, who)) push({ key: `a:${a.id}`, group: 'Do it', title: a.as?.[who] ?? a.label, sub: 'Opens the form', crumb: '', icon: 'plus', terms: a.keywords, boost: 0.6, go: { kind: 'action', id: a.id } });
  for (const t of tabs) push({ key: `t:${t.key}`, group: 'Screen', title: t.label, sub: 'Go to this screen', crumb: '', icon: t.icon, terms: t.key, go: { kind: 'go', tab: t.key } });
  for (const s of SECTIONS) {
    if (s.who && !s.who.includes(who)) continue;
    const tab = s.tabs.find(has); if (!tab) continue;
    push({ key: `s:${s.title}`, group: 'Section', title: s.title, sub: `On ${tabName(tab)}`, crumb: `${tabName(tab)} › ${s.title}`, icon: tabs.find((t) => t.key === tab)?.icon ?? 'list', terms: s.keywords, boost: 0.3, go: { kind: 'go', tab, section: s.title, seg: tab === 'settings' ? s.seg : undefined } });
  }

  // the monthly workbooks: this month and the last two, as direct downloads
  if (mgmt) {
    const m0 = D.today.slice(0, 8) + '01';
    const prev = (m: string, n: number) => { const d = new Date(`${m}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };
    [m0, prev(m0, 1), prev(m0, 2)].forEach((m, i) => push({ key: `d:${m}`, group: 'Download', title: `${monthLabel(m)} workbook`, sub: i ? 'Complete month, Excel' : 'This month so far, Excel',
      crumb: 'Settings › Monthly workbooks', icon: 'list', terms: `workbook excel spreadsheet download month ${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)} report`, boost: 1.4 - i * 0.2, go: { kind: 'download', month: m } }));
  }

  // quick answers from today's figures
  const days7 = Array.from({ length: 7 }, (_, i) => addDays(D.today, -i));
  if (farm) {
    const p = produced(D, [D.today]), lr = layRate(D, [D.today]);
    push({ key: 'q:eggs', group: 'Answer', title: `${eggs(p)} produced today`, sub: Number.isFinite(lr) ? `Lay rate ${pct(lr)}` : 'No collection entered yet today', crumb: farm && has('ov') ? 'Overview › Egg production' : 'Home',
      icon: 'egg', terms: 'eggs today production produced collected collection lay rate trays', boost: 1, go: has('ov') ? { kind: 'go', tab: 'ov', section: 'Egg production' } : { kind: 'go', tab: tabs[0]?.key ?? 'home' } });
    const dw = deaths(D, days7);
    push({ key: 'q:deaths', group: 'Answer', title: `${n0(deaths(D, [D.today]))} deaths today`, sub: `${n0(dw)} in the last 7 days`, crumb: 'Flock health', icon: 'syringe', terms: 'deaths dead died mortality today week', boost: 0.8, go: { kind: 'go', tab: 'health', section: 'Flock health' } });
    const t = tankInfo(D);
    if (t) push({ key: 'q:tank', group: 'Answer', title: `Tank at ${pct(t.level, 0)}`, sub: `${n0(t.litres)} L of ${n0(t.cap)} L${t.cover != null ? `, about ${n0(t.cover)} days` : ''}`, crumb: 'Water › Tank level', icon: 'drop', terms: 'tank water level left litres', boost: 1, go: { kind: 'go', tab: 'water', section: 'Tank level' } });
  }
  if (farm || who === 'store') {
    const f = feedInfo(D);
    push({ key: 'q:feed', group: 'Answer', title: `${n0(f.stockBags)} bags of feed left`, sub: `About ${n0(f.cover)} days at ${n0(f.dailyBags)} bags a day`, crumb: 'Feed › Feed in store', icon: 'sack', terms: 'feed left store bags stock days remaining', boost: 1, go: { kind: 'go', tab: 'feed', section: 'Feed in store' } });
  }
  if (mgmt || who === 'store') {
    const m = millInfo(D);
    if (m.mats.length) push({ key: 'q:mill', group: 'Answer', title: m.started ? `Enough raw material to mill ${n0(m.cap)} tonnes` : 'Raw material store not counted yet', sub: m.limit && m.started ? `${m.limit.name} runs out first` : 'Count the store to start', crumb: 'Feed mill › Raw material store', icon: 'scoop', terms: 'mill can make raw material tonnes runs out', boost: 0.5, go: { kind: 'go', tab: 'mill', section: 'Raw material store' } });
  }
  if (mgmt) {
    const s = salesOn(D, [D.today]);
    push({ key: 'q:sales', group: 'Answer', title: `${kes(s.value)} sales today`, sub: `${eggs(s.pcs)} sold in ${n0(s.cnt)} sale${s.cnt === 1 ? '' : 's'}`, crumb: 'Overview › Sales', icon: 'receipt', terms: 'sales today sold revenue money', boost: 1, go: { kind: 'go', tab: 'ov', section: 'Sales' } });
    push({ key: 'q:funds', group: 'Answer', title: `${kes(totalFunds(D))} in all accounts`, sub: 'Cash, M-Pesa and bank together', crumb: 'Money › Do the books balance?', icon: 'wallet', terms: 'funds money total balance bank accounts cash', boost: 0.6, go: { kind: 'go', tab: 'money', section: 'Do the books balance?' } });
  } else if (who === 'pos' || who === 'van') {
    const loc = D.me.location_id ?? '', s = salesOn(D, [D.today], loc);
    push({ key: 'q:sales', group: 'Answer', title: `${kes(s.value)} sales today`, sub: `${eggs(s.pcs)} sold in ${n0(s.cnt)} sale${s.cnt === 1 ? '' : 's'}`, crumb: 'Sales', icon: 'receipt', terms: 'sales today sold money', boost: 0.8, go: { kind: 'go', tab: 'psales' } });
  }

  // outlets
  const shops = D.locations.filter((l) => l.kind !== 'farm' && (mgmt || l.id === D.me.location_id));
  for (const l of shops) {
    const s = salesOn(D, [D.today], l.id), on = tot(stockNow(D, l.id));
    const cash = mgmt && l.kind !== 'van' ? `, cash ${kes(balance(D, cashAcc(l.id)))}` : '';
    push({ key: `l:${l.id}`, group: 'Data', title: l.name, sub: `${eggs(on)} on hand, ${kes(s.value)} sales today${cash}`, crumb: mgmt ? 'Overview › Sales points right now' : 'Today',
      icon: l.kind === 'van' ? 'truck' : 'box', terms: `${l.short} outlet shop sales point ${l.kind === 'van' ? 'van' : ''} cash stock`, boost: 0.5,
      go: mgmt ? { kind: 'go', tab: 'ov', section: 'Sales points right now' } : { kind: 'go', tab: tabs[0]?.key ?? 'today' } });
  }
  // people
  if (mgmt) for (const p of D.staff.filter((x) => x.active)) push({ key: `p:${p.id}`, group: 'Data', title: p.display_name, sub: `${ROLE_NAME[p.role] ?? p.role}${p.location_id ? `, ${D.locations.find((l) => l.id === p.location_id)?.name ?? ''}` : ''}`,
    crumb: 'Settings › Staff', icon: 'user', terms: `${p.username ?? ''} staff person ${ROLE_NAME[p.role] ?? ''}`, go: { kind: 'go', tab: 'settings', section: 'Staff', seg: 'Farm setup' } });
  // customers who owe
  const creditTab = ['money', 'pmoney', 'ov', 'today'].find(has);
  if (creditTab) for (const c of (D.credits ?? []).filter((x) => mgmt || x.location_id === D.me.location_id)) push({ key: `c:${c.location_id}:${c.customer}`, group: 'Data', title: c.customer,
    sub: `Owes ${kes(c.owed)} at ${D.locations.find((l) => l.id === c.location_id)?.short ?? ''}, since ${dlabel(c.since)}`, crumb: `${tabName(creditTab)} › Outstanding credits`, icon: 'wallet',
    terms: 'customer owes owe credit debt debtor', boost: 0.4, go: actionsFor(D, who).some((a) => a.id === 'credit_paid') ? { kind: 'action', id: 'credit_paid' } : { kind: 'go', tab: creditTab, section: 'Outstanding credits' } });
  // houses
  if (farm) for (const h of D.houses.filter((x) => x.active)) {
    const fl = (D.flocks ?? []).find((f) => f.house_id === h.id && !f.ended_on);
    push({ key: `h:${h.id}`, group: 'Data', title: h.name, sub: `${n0(fl?.hens ?? h.birds_at_start)} hens${h.breed ? `, ${h.breed}` : ''}, ${n0(houseAge(D, h))} weeks old`, crumb: 'Flock health › Houses and flocks',
      icon: 'egg', terms: `house flock hens ${h.breed ?? ''}`, go: { kind: 'go', tab: 'health', section: 'Houses and flocks' } });
  }
  // medicines, supplies and raw materials
  const storeTab = has('meds') ? 'meds' : has('health') ? 'health' : null;
  if (storeTab) for (const m of D.medicines.filter((x) => x.active)) push({ key: `m:${m.id}`, group: 'Data', title: m.name, sub: `${n0(m.stock)} ${m.unit} in store${m.stock <= m.reorder ? ', running low' : ''}`,
    crumb: `${tabName(storeTab)} › Medicine & vaccine store`, icon: 'syringe', terms: `medicine vaccine drug ${m.category}`, go: { kind: 'go', tab: storeTab, section: 'Medicine & vaccine store' } });
  if (has('meds')) for (const s of (D.supplies ?? []).filter((x) => x.active)) push({ key: `u:${s.id}`, group: 'Data', title: s.name, sub: `${n0(s.stock)} ${s.unit} in store`, crumb: `${tabName('meds')} › Other supplies`,
    icon: 'box', terms: `supply supplies ${s.category}`, go: { kind: 'go', tab: 'meds', section: 'Other supplies' } });
  if (has('mill')) for (const r of (D.raw ?? []).filter((x) => x.active)) push({ key: `r:${r.id}`, group: 'Data', title: r.name, sub: `${n0(r.stock)} kg in store, ${n0(r.per_tonne)} kg a tonne`, crumb: 'Feed mill › Raw material store',
    icon: 'sack', terms: 'raw material mill ingredient', go: { kind: 'go', tab: 'mill', section: 'Raw material store' } });

  // help
  for (const t of TASKS[who]) push({ key: `k:${t.title}`, group: 'Help', title: t.title, sub: t.steps.join(' '), crumb: 'Help › How to', icon: 'list', terms: `${t.steps.join(' ')} ${t.keywords ?? ''}`, boost: -0.3, go: { kind: 'help', title: t.title, lines: t.steps } });
  for (const f of FAQS[who]) push({ key: `f:${f.q}`, group: 'Help', title: f.q, sub: f.a, crumb: 'Help › Questions', icon: 'help', terms: f.a, boost: -0.5, go: { kind: 'help', title: f.q, lines: [f.a] } });
  return out;
}

/** A day named in the query ("yesterday", "jana", "3 nov", "2026-11-03", "monday"), within the last 62 days. */
export function dayIn(q: string, today: string): string | null {
  const s = q.toLowerCase().trim();
  if (/\b(today|leo)\b/.test(s) && !/\w+ today/.test(s) && s.split(/\s+/).length === 1) return today;
  if (/\b(yesterday|jana)\b/.test(s)) return addDays(today, -1);
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const MO = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const a = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*${MON}\\b`).exec(s), b = a ? null : new RegExp(`\\b${MON}\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(s);
  if (a || b) {
    const day = +(a ? a[1] : b![2]), mon = MO.indexOf((a ? a[2] : b![1]).slice(0, 3)) + 1;
    if (day < 1 || day > 31) return null;
    let y = +today.slice(0, 4);
    if (`${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}` > today) y--;
    return `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const W = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const w = W.findIndex((x) => new RegExp(`\\b${x}\\b`).test(s));
  if (w >= 0) { for (let i = 1; i <= 7; i++) { const d = addDays(today, -i); if (new Date(`${d}T00:00:00Z`).getUTCDay() === w) return d; } }
  return null;
}

/** The day's figures as one result, for a date in the query. */
function dayEntry(D: Dashboard, tabs: TabLite[], d: string): Entry | null {
  const who = whoFor(D), mgmt = who === 'owner' || who === 'manager';
  const tab = ['activity', 'records', 'srecords', 'psales'].find((k) => tabs.some((t) => t.key === k));
  if (!tab || d < addDays(D.today, -62) || d > D.today) return null;
  const parts: string[] = [];
  if (mgmt || who === 'clerk') parts.push(`${eggs(produced(D, [d]))} produced`);
  if (mgmt) parts.push(`${kes(salesOn(D, [d]).value)} sales`);
  if (who === 'pos' || who === 'van') parts.push(`${kes(salesOn(D, [d], D.me.location_id ?? '').value)} sales`);
  return { key: `day:${d}`, group: 'Answer', title: dlabel(d), sub: parts.join(', ') || 'Records for this day', crumb: tabs.find((t) => t.key === tab)!.label, icon: 'list', terms: '', boost: 2, go: { kind: 'go', tab } };
}

// ---------------------------------------------------------------------------- matching
/** Words people use, English and Kiswahili, for what the app calls something else. */
export const SYNONYMS: Record<string, string[]> = {
  sell: ['sale'], sold: ['sale'], selling: ['sale'], buy: ['sale'], customer: ['sale', 'credit'],
  dead: ['mortality', 'deaths'], died: ['mortality', 'deaths'], death: ['mortality', 'deaths'], die: ['mortality'],
  broken: ['damaged'], spoilt: ['damaged'], spoiled: ['damaged'], breakage: ['damaged'],
  excel: ['workbook'], spreadsheet: ['workbook'], xlsx: ['workbook'], book: ['workbook', 'sheet'], download: ['workbook'],
  owe: ['credit'], owes: ['credit'], owing: ['credit'], debt: ['credit'], debtor: ['credit'], debtors: ['credit'], loan: ['credit'],
  deposit: ['bank'], banking: ['bank'], login: ['password', 'account'], signin: ['password', 'account'],
  deliver: ['dispatch'], delivery: ['receive', 'dispatch'], arrive: ['receive', 'delivery'], arrived: ['receive'], transfer: ['dispatch'], send: ['dispatch'],
  vaccine: ['medicine'], drug: ['medicine'], drugs: ['medicine'], medication: ['medicine'], treatment: ['medicine'],
  layers: ['flock', 'hens', 'feed'], birds: ['hens', 'flock'], chicken: ['hens', 'flock'], chickens: ['hens', 'flock'], hen: ['hens'],
  money: ['cash'], mpesa: ['till', 'paybill'], employee: ['staff'], user: ['staff'], worker: ['staff'], workers: ['staff'],
  drink: ['water'], drank: ['water'], drinking: ['water'], mix: ['mill'], mixing: ['mill'], formula: ['recipe'], stocktake: ['count'],
  shop: ['outlet'], outlets: ['outlet'], production: ['eggs', 'collection'], laid: ['eggs'], lay: ['eggs', 'lay'],
  // medicines, feed and supplies by the names people use for them (diseases, local and brand names)
  worm: ['dewormer', 'piperazine'], worms: ['dewormer', 'piperazine'], deworm: ['dewormer'], vitamins: ['multivitamin', 'vitamin'], vitamin: ['multivitamin'],
  electrolyte: ['multivitamin', 'electrolytes'], stress: ['multivitamin', 'electrolytes'], ncd: ['newcastle'], lasota: ['newcastle'],
  gumboro: ['gumboro', 'vaccine'], ibd: ['gumboro'], fowlpox: ['pox', 'vaccine'], pox: ['pox', 'vaccine'], antibiotic: ['oxytetracycline', 'antibiotic'], antibiotics: ['oxytetracycline', 'antibiotic'],
  otc: ['oxytetracycline'], oxy: ['oxytetracycline'], tetracycline: ['oxytetracycline'], cocci: ['coccidiostat', 'amprolium'], coccidiosis: ['coccidiostat', 'amprolium'],
  mash: ['feed'], growers: ['feed'], chick: ['feed', 'chick'], crate: ['tray'], crates: ['tray'], carton: ['packaging', 'box'], cartons: ['packaging', 'box'],
  sawdust: ['litter', 'bedding'], shavings: ['litter', 'bedding'], fishmeal: ['fish'], premix: ['macropack'], lime: ['limestone'], sunflower: ['sunflower'],
  // Kiswahili
  minyoo: ['dewormer', 'piperazine'], vitamini: ['multivitamin'], kideri: ['newcastle'], ndui: ['pox', 'vaccine'], kuhara: ['coccidiostat', 'amprolium'], kuharisha: ['coccidiostat', 'amprolium'],
  sabuni: ['disinfectant', 'cleaning'], katoni: ['packaging', 'box'], maranda: ['litter', 'bedding'], gunia: ['sack', 'bag'], magunia: ['sack', 'bag'],
  alizeti: ['sunflower'], chokaa: ['limestone'], mawe: ['grit'], omena: ['fish'], dagaa: ['fish'],
  mayai: ['eggs'], yai: ['eggs'], kuku: ['hens', 'flock'], maji: ['water'], tanki: ['tank'], chakula: ['feed'], lishe: ['feed'],
  dawa: ['medicine'], chanjo: ['vaccine', 'medicine'], pesa: ['cash', 'money'], mauzo: ['sale', 'sales'], uza: ['sale'], kuuza: ['sale'], nunua: ['sale'],
  deni: ['credit'], mkopo: ['credit'], lipa: ['paid'], kulipa: ['paid'], malipo: ['paid', 'payment'], vifo: ['deaths', 'mortality'], kufa: ['deaths', 'mortality'], wamekufa: ['deaths', 'mortality'],
  nyumba: ['house'], banda: ['house'], trei: ['trays'], vunjika: ['damaged'], yamevunjika: ['damaged'], hesabu: ['count'], funga: ['close'], fungua: ['open'],
  leo: ['today'], jana: ['yesterday'], gari: ['van'], duka: ['outlet', 'shop'], stoo: ['store'], mahindi: ['maize'], soya: ['soybean'], pumba: ['bran'],
  mfanyakazi: ['staff'], wafanyakazi: ['staff'], ripoti: ['report'], matumizi: ['expense'], benki: ['bank'], kiwanda: ['mill'], saga: ['mill'], kusaga: ['mill'],
};
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'my', 'how', 'do', 'i', 'is', 'what', 'where', 'for', 'on', 'in', 'at', 'and', 'can', 'me', 'show', 'find', 'open', 'go', 'please', 'there', 'much', 'many', 'who', 'which', 'when', 'why', 'does', 'did', 'are', 'was', 'any', 'all', 'with', 'from', 'by', 'it', 'this', 'that']);

/** Lower-case, plain letters, simple plurals folded ("eggs" and "egg" match). */
export const norm = (w: string) => {
  let x = w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  if (x.length > 4 && x.endsWith('ies')) x = x.slice(0, -3) + 'y';
  else if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss')) x = x.slice(0, -1);
  return x;
};
const split = (s: string) => s.toLowerCase().split(/[^a-z0-9À-ɏ]+/).map(norm).filter(Boolean);

/** Edit distance with swaps (Damerau), stopping early past `max`. */
export function dist(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let low = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      low = Math.min(low, d[i][j]);
    }
    if (low > max) return max + 1;
  }
  return d[a.length][b.length];
}

/** How well one query word matches one word of an entry: 1 exact, then prefix, part of the word, a typo. */
function wordMatch(q: string, w: string): number {
  if (q === w) return 1;
  if (q.length >= 2 && w.startsWith(q)) return 0.85;
  if (q.length >= 4 && w.length >= 4 && (w.includes(q) || q.startsWith(w))) return 0.6;
  if (q.length >= 4 && w.length >= 3) {
    const k = dist(q, w, q.length >= 7 ? 2 : 1);
    if (k <= (q.length >= 7 ? 2 : 1)) return 0.7 - 0.1 * (k - 1);
  }
  return 0;
}

/** A query word, the words it may also mean, and whether it may be left unmatched ("a", "the"). */
export interface QWord { alts: string[]; optional: boolean }
/** The query as words, each with the words it may also mean. */
export function queryWords(q: string): QWord[] {
  const raw = q.toLowerCase().split(/[^a-z0-9\u00c0-\u024f]+/).filter(Boolean);
  const allStop = raw.every((w) => STOP.has(w));
  return raw.map((w) => { const n = norm(w); return { alts: [...new Set([n, ...(SYNONYMS[w] ?? SYNONYMS[n] ?? []).map(norm)])], optional: !allStop && STOP.has(w) }; }).filter((x) => x.alts[0]);
}

/** Score one entry for the query words; 0 means it does not match. */
export function scoreEntry(qw: QWord[], e: Entry): number {
  const need = qw.filter((x) => !x.optional);
  if (!need.length) return 0;
  // an answer's title is a figure; it is found by what it answers, not by its wording
  const tw = split(e.title), bw = split(`${e.terms} ${e.crumb}`), sw = split(e.sub), tW = e.group === 'Answer' ? 1.6 : 3, bW = e.group === 'Answer' ? 2.4 : 1.6;
  let s = 0, hit = 0;
  for (const x of qw) {
    let best = 0;
    if (x.optional) { if (tw.includes(x.alts[0])) s += 0.8; continue; }
    for (const [i, a] of x.alts.entries()) {
      const f = i === 0 ? 1 : 0.9;
      for (const w of tw) best = Math.max(best, tW * f * wordMatch(a, w));
      for (const w of bw) best = Math.max(best, bW * f * wordMatch(a, w));
      for (const w of sw) best = Math.max(best, 0.8 * f * wordMatch(a, w));
    }
    if (best > 0) hit++;
    s += best;
  }
  if (!hit) return 0;
  const cover = hit / need.length;
  if (need.length > 1 && cover < 0.5) return 0;
  // the whole title typed, or every word found, counts for more
  const whole = norm(e.title.replace(/\s+/g, '')) === qw.map((x) => x.alts[0]).join('') ? 1.5 : 0;
  const all = need.length > 1 && cover === 1 ? 0.4 * (need.length - 1) : 0;
  return (s / need.length) * cover * cover + e.boost * cover + whole + all;
}

/** The best results for a query, best first. */
export function search(D: Dashboard, tabs: TabLite[], q: string, limit = 14): Hit[] {
  const qw = queryWords(q);
  if (!qw.length) return [];
  const all = catalog(D, tabs);
  const day = dayIn(q, D.today), de = day ? dayEntry(D, tabs, day) : null;
  const hits: Hit[] = all.map((e) => ({ ...e, score: scoreEntry(qw, e) })).filter((h) => h.score > 0.9);
  if (de) hits.push({ ...de, score: 99 });
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

/** Starting points when the box is empty, by role. */
export const IDEAS: Record<Who, string[]> = {
  owner: ['workbook', 'sales today', 'report', 'staff'], manager: ['missed day', 'feed left', 'workbook', 'who owes'],
  clerk: ['eggs today', 'tank', 'deaths', 'flock'], store: ['feed left', 'mill', 'medicine', 'maize'],
  pos: ['sale', 'credit', 'close', 'damaged'], van: ['sale', 'deliver', 'left over', 'bank'],
};
