// The app's help, in one place: the tips that point at real buttons, the
// how-to steps and the questions for each role, and the search over all of it.
// The tips, the Help panel, Search and the user guide read from here, so they
// stay in step. Plain words: one short line per tip, in the order people work.
import type { Role } from './types';

/** Who a piece of help is for. 'van' is the sales point role on the mobile van. */
export type Who = Role | 'van';

/**
 * A tip points at an element tagged data-tip="<target>" on the screen named by
 * `tab` ('*' for any screen), and only shows once that element is on screen.
 */
export interface Tip { id: string; tab: string; target: string; title: string; text: string }

export const TIPS: Record<Who, Tip[]> = {
  pos: [
    { id: 'pos.steps', tab: 'today', target: 'steps', title: 'Your day, in order', text: 'Work down this list. Each step turns green when it is done.' },
    { id: 'pos.open', tab: 'today', target: 'step:Opening count', title: 'Start with the opening count', text: 'Count the eggs on hand before the first sale.' },
    { id: 'pos.sale', tab: 'today', target: 'tile:Record sale', title: 'Record every sale', text: 'Cash, M-Pesa, Paybill or credit, as it happens.' },
    { id: 'pos.close', tab: 'today', target: 'step:Close the day', title: 'Close the day', text: 'At closing time, count the eggs left and the cash.' },
    { id: 'pos.help', tab: '*', target: 'help', title: 'Help is here', text: 'Steps for each job and answers to common questions.' },
  ],
  van: [
    { id: 'van.steps', tab: 'today', target: 'steps', title: 'Your day on the van', text: 'Work down this list. Each step turns green when it is done.' },
    { id: 'van.load', tab: 'today', target: 'tile:Receive a load', title: 'Receive your load', text: 'Count what was loaded before you leave the farm.' },
    { id: 'van.deliver', tab: 'today', target: 'tile:Deliver eggs', title: 'Deliver at each stop', text: 'Record what you leave. The outlet confirms it.' },
    { id: 'van.sale', tab: 'today', target: 'tile:Record sale', title: 'Sales on the road', text: 'Record each sale as it happens.' },
    { id: 'van.help', tab: '*', target: 'help', title: 'Help is here', text: 'Steps for each job and answers to common questions.' },
  ],
  clerk: [
    { id: 'clerk.steps', tab: 'home', target: 'steps', title: 'Your farm day, in order', text: 'Work down this list. Each step turns green when it is done.' },
    { id: 'clerk.tank', tab: 'home', target: 'tile:Tank level', title: 'First thing: the tank', text: 'Read the water tank before anything else.' },
    { id: 'clerk.water', tab: 'home', target: 'tile:Water drunk', title: 'Water for each house', text: 'Record the litres each house drank.' },
    { id: 'clerk.eggs', tab: 'home', target: 'tile:Egg collection', title: 'Collect and grade', text: 'Normal, cracked, jumbo and damaged, house by house.' },
    { id: 'clerk.send', tab: 'home', target: 'tile:Issue eggs', title: 'Send eggs out', text: 'To an outlet or the van. They confirm on arrival.' },
    { id: 'clerk.flocks', tab: 'health', target: 'houses', title: 'New hens or a new house', text: 'Add them here. Earlier flocks keep their records.' },
    { id: 'clerk.help', tab: '*', target: 'help', title: 'Help is here', text: 'Steps for each job and answers to common questions.' },
  ],
  store: [
    { id: 'store.in', tab: 'store', target: 'tile:Feed received', title: 'Deliveries first', text: 'Count the bags as they come off the lorry.' },
    { id: 'store.issue', tab: 'store', target: 'tile:Issue feed', title: 'Feed for a house', text: 'The production clerk confirms what arrived.' },
    { id: 'store.mill', tab: 'store', target: 'tile:Feed milled', title: 'After each mixing', text: 'Enter the tonnes. The recipe works out the rest.' },
    { id: 'store.raw', tab: 'store', target: 'tile:Raw material received', title: 'Raw materials in', text: 'Maize, soybean and the rest, in bags or kg.' },
    { id: 'store.millcard', tab: 'mill', target: 'mill', title: 'What you can mill', text: 'Tonnes the store can make now, and what runs out first.' },
    { id: 'store.help', tab: '*', target: 'help', title: 'Help is here', text: 'Steps for each job and answers to common questions.' },
  ],
  manager: [
    { id: 'manager.gaps', tab: 'alerts', target: 'gaps', title: 'Days not entered', text: 'Fill each one from the paper book, or mark it closed.' },
    { id: 'manager.ov', tab: 'alerts', target: 'tab:ov', title: 'The whole business today', text: 'Eggs, sales and every outlet on one screen.' },
    { id: 'manager.report', tab: 'alerts', target: 'tab:report', title: 'Weekly farm report', text: 'What needs attention this week, and who should act.' },
    { id: 'manager.settings', tab: 'alerts', target: 'tab:settings', title: 'Settings', text: 'Houses, staff, prices and the monthly workbooks.' },
    { id: 'manager.search', tab: '*', target: 'search', title: 'Search', text: 'Find any screen, form or answer by typing a word.' },
    { id: 'manager.help', tab: '*', target: 'help', title: 'Help is here', text: 'Steps for each job and answers to common questions.' },
  ],
  owner: [
    { id: 'owner.today', tab: 'ov', target: 'today', title: 'Today at a glance', text: 'Eggs, lay rate, sales and funds, live.' },
    { id: 'owner.report', tab: 'ov', target: 'tab:report', title: 'Weekly farm report', text: 'Findings, flock performance and recommended actions.' },
    { id: 'owner.activity', tab: 'ov', target: 'tab:activity', title: 'Every record', text: 'Who entered what, and when. Nothing is ever changed.' },
    { id: 'owner.settings', tab: 'ov', target: 'tab:settings', title: 'Settings', text: 'Houses, staff, prices and the monthly workbooks.' },
    { id: 'owner.findings', tab: 'report', target: 'findings', title: 'Start here each week', text: 'What needs attention, with who should act.' },
    { id: 'owner.search', tab: '*', target: 'search', title: 'Search', text: 'Find any screen, form or answer by typing a word.' },
    { id: 'owner.help', tab: '*', target: 'help', title: 'Help is here', text: 'Steps for each job and answers to common questions.' },
  ],
};

/** A job, in the order people do it: short steps, and an action that opens the right form or screen. */
export interface Task { title: string; steps: string[]; action?: string; keywords?: string }

export const TASKS: Record<Who, Task[]> = {
  pos: [
    { title: 'Start the day', steps: ['Count the eggs on hand: normal, cracked and jumbo.', 'Save the opening count before the first sale.'], action: 'count_open', keywords: 'opening open morning' },
    { title: 'Receive a delivery', steps: ['When eggs arrive, open the delivery.', 'Count what came, and any damaged on the way.', 'Save. The difference stays on record.'], action: 'receive', keywords: 'arrive delivery stock in' },
    { title: 'Record a sale', steps: ['Enter the trays and pieces sold.', 'Split the money: cash, Till, Paybill or credit.', 'Credit needs the customer\'s name.'], action: 'sale', keywords: 'sell customer money mpesa till paybill credit' },
    { title: 'Credit paid back', steps: ['Choose the customer.', 'Enter the amount and how they paid.', 'Their oldest credit sales are cleared first.'], action: 'credit_paid', keywords: 'debt owe pay back' },
    { title: 'Damaged eggs', steps: ['Enter the broken or spoilt eggs and why.'], action: 'damaged', keywords: 'broken spoilt breakage loss' },
    { title: 'Close the day', steps: ['Count the eggs left.', 'Count the cash in the drawer.', 'Bank the cash or move it to Paybill.'], action: 'count_close', keywords: 'closing evening end cash' },
  ],
  van: [
    { title: 'Receive your load', steps: ['At the farm, open the load waiting for you.', 'Count what was loaded and any damaged.'], action: 'receive', keywords: 'load morning farm' },
    { title: 'Deliver eggs', steps: ['At each stop, choose the farm or the outlet.', 'Enter the eggs you leave. They confirm on arrival.'], action: 'dispatch', keywords: 'drop deliver outlet' },
    { title: 'Record a sale', steps: ['Enter what you sold and how you were paid.'], action: 'sale', keywords: 'sell customer money' },
    { title: 'End the day empty', steps: ['Drop what is left at the farm or the nearest outlet.', 'The van keeps no eggs overnight.'], action: 'leftover', keywords: 'left over empty evening' },
    { title: 'Bank or send the cash', steps: ['Record the money moved, with any charges.'], action: 'move', keywords: 'bank mpesa money cash' },
  ],
  clerk: [
    { title: 'Read the water tank', steps: ['First thing in the morning, read the tank level.', 'Record a new reading after every refill.'], action: 'tank', keywords: 'water level morning' },
    { title: 'Confirm what the store issued', steps: ['As feed or medicine reaches a house, open it.', 'Enter what actually arrived. Say what happened if less.'], action: 'confirm', keywords: 'feed medicine store arrived' },
    { title: 'Water drunk', steps: ['Enter the litres each house drank.'], action: 'water', keywords: 'litres drink' },
    { title: 'Collect and grade the eggs', steps: ['Choose the house.', 'Enter normal, cracked, jumbo and damaged.', 'Or use the Daily house sheet for every house at once.'], action: 'collect', keywords: 'eggs collection grade' },
    { title: 'Record deaths', steps: ['Enter the birds that died, the house and the cause.'], action: 'mortality', keywords: 'dead died mortality birds' },
    { title: 'Send eggs out', steps: ['Choose an outlet or the van, enter the eggs, save.', 'They confirm the count on arrival.'], action: 'dispatch', keywords: 'issue send transfer outlet' },
    { title: 'New hens or a new house', steps: ['Open Flock health, Houses and flocks.', 'New flock: house, breed, hens, age and date.', 'Add house first for a new building.'], action: 'flock', keywords: 'flock breed placement expansion' },
  ],
  store: [
    { title: 'Record a delivery', steps: ['Count the bags or items as they arrive.', 'Note the supplier. Payment is for the farm manager.'], action: 'feed_in', keywords: 'received delivery supplier bags' },
    { title: 'Issue feed to a house', steps: ['Choose the house and the bags.', 'The production clerk confirms what arrived.'], action: 'feed_issue', keywords: 'feeding house bags' },
    { title: 'Record a milling', steps: ['After mixing, enter the tonnes.', 'The recipe takes each raw material out of the store.', 'The feed goes into the feed store in bags.'], action: 'mill', keywords: 'mill mix tonnes recipe' },
    { title: 'Raw material received', steps: ['Choose the material and enter the bags or kg.'], action: 'raw_in', keywords: 'maize soybean bran limestone' },
    { title: 'Count the store', steps: ['Count each raw material.', 'The app records the difference from its book.'], action: 'raw_count', keywords: 'stock take count' },
    { title: 'Medicine and supplies', steps: ['Record what came in, and issue to a house or for a purpose.'], action: 'med_issue', keywords: 'vaccine medicine trays supplies' },
  ],
  manager: [
    { title: 'Check Alerts', steps: ['Start on Alerts: days with gaps, deliveries on the way and store issues waiting.'], action: 'go:alerts', keywords: 'morning start' },
    { title: 'Fill a missed day', steps: ['Open Days with gaps and choose Fill in.', 'Enter it from the paper book, up to 62 days back.', 'Or mark an outlet closed for that day.'], action: 'go:alerts', keywords: 'gap missing earlier day' },
    { title: 'Record an expense or move money', steps: ['Expenses and banking are under Money.'], action: 'expense', keywords: 'expense money bank pay' },
    { title: 'Add a member of staff', steps: ['Settings, Staff, Add staff.', 'They sign in with 0000 once and choose a password.'], action: 'staff', keywords: 'user account staff new' },
    { title: 'Change the feed recipe', steps: ['Feed mill, Change the recipe.', 'It must add up to 1,000 kg a tonne.'], action: 'recipe', keywords: 'recipe mill feed formula' },
    { title: 'Place a new flock', steps: ['Houses and flocks, New flock.', 'The flock already in the house is closed with its records.'], action: 'flock', keywords: 'flock hens breed' },
    { title: 'Download a monthly workbook', steps: ['Settings or Report, Monthly workbooks, Download.'], action: 'go:settings', keywords: 'excel workbook month' },
  ],
  owner: [
    { title: 'See today', steps: ['Overview shows eggs, lay rate, sales and funds, live.'], action: 'go:ov', keywords: 'today overview' },
    { title: 'Read the weekly report', steps: ['Report: findings first, then flock performance and actions.'], action: 'go:report', keywords: 'week report findings' },
    { title: 'Check a figure', steps: ['Activity: pick the location. Each record shows who entered it and when.'], action: 'go:activity', keywords: 'record check who' },
    { title: 'Add or remove staff', steps: ['Settings, Staff. Add staff, or Manage then Edit to disable an account.'], action: 'staff', keywords: 'user account staff' },
    { title: 'Download a monthly workbook', steps: ['Settings or Report, Monthly workbooks, Download.'], action: 'go:settings', keywords: 'excel workbook month' },
    { title: 'Add a recovery email', steps: ['Settings, My account, Recovery email.', 'A code is sent to confirm it.'], action: 'go:settings', keywords: 'password forgot email reset' },
  ],
};

export interface Faq { q: string; a: string }
const COMMON: Faq[] = [
  { q: 'I forgot my password.', a: 'The owner and farm manager can use Forgot password on the sign-in screen. Everyone else: ask the owner or farm manager to reset it.' },
  { q: 'The app says Offline.', a: 'Nothing typed while offline is saved. Check data or Wi-Fi, reopen the app and enter it again.' },
  { q: 'I entered something wrong.', a: 'Records cannot be changed or deleted. Tell the farm manager the same day so it can be accounted for.' },
  { q: 'A button I expect is missing.', a: 'Your role does not include it. Each person only sees what their job needs.' },
];
export const FAQS: Record<Who, Faq[]> = {
  pos: [
    { q: 'A customer will pay later.', a: 'Put the amount under Credit (pays later) with the customer\'s name. When they pay, use Credit paid.' },
    { q: 'The sale will not save.', a: 'Cash, Till, Paybill and credit must add up to the amount due.' },
    { q: 'A delivery is not showing.', a: 'The sender has not recorded it yet. Ask them to, then refresh.' },
    { q: 'Why does the count not show what I should have?', a: 'So the count is honest. Enter what you see. The app shows any difference after you save.' },
    { q: 'My closing count does not match.', a: 'Count again. If it is still different, save the real count. The difference is recorded.' },
    { q: 'We are not opening today.', a: 'On the Daily stock sheet choose Closed all day. Sundays are already a closing day.' },
    ...COMMON,
  ],
  van: [
    { q: 'Why no opening or closing count?', a: 'The van keeps no stock overnight. The app works out what is on board from loads, deliveries and sales.' },
    { q: 'A reminder says eggs are on the van.', a: 'Drop them at the farm or an outlet and record it.' },
    { q: 'An outlet says fewer arrived.', a: 'They record what arrived. The difference stays on record for the farm manager.' },
    ...COMMON,
  ],
  clerk: [
    { q: 'Where do I record feed and medicine?', a: 'The inventory clerk issues them. You confirm what reached each house.' },
    { q: 'Cracked or damaged?', a: 'Cracked eggs can still be sold. Damaged or broken eggs are written off.' },
    { q: 'I forgot to record yesterday.', a: 'You can only record today. The farm manager can enter yesterday.' },
    { q: 'New hens arrived.', a: 'Houses and flocks, New flock. The flock already in the house keeps its records.' },
    ...COMMON,
  ],
  store: [
    { q: 'Where do I record payments?', a: 'You record quantities only. Give the delivery note to the farm manager.' },
    { q: 'An item is not in the list.', a: 'On the Received form choose New item. It is added with its first delivery.' },
    { q: 'The milling will not save.', a: 'It names the material that is short. Record the delivery or count that material, then try again.' },
    { q: 'The store shows less than I can see.', a: 'A delivery was not recorded. Record it, or count the store.' },
    ...COMMON,
  ],
  manager: [
    { q: 'A day was missed.', a: 'Days with gaps opens the right sheet. You can enter up to 62 days back.' },
    { q: 'I changed a price. What about old sales?', a: 'New prices apply from now. Earlier sales keep their price.' },
    { q: 'The tank keeps showing low.', a: 'Check the tank size under Settings, then record a fresh tank reading.' },
    { q: 'Why can I not see the owner in Staff?', a: 'Only the owner manages owner accounts.' },
    { q: 'The report says the lay target is not realistic.', a: 'Use Edit flock to set each house\'s breed and a realistic expected lay rate.' },
    ...COMMON,
  ],
  owner: [
    { q: 'Why can I not enter a record?', a: 'The owner account is view-only, so every figure comes from the person who did the work.' },
    { q: 'A figure looks wrong.', a: 'Open Activity and pick the location. Each record shows who entered it and when.' },
    { q: 'Someone lost their two-step phone.', a: 'Settings, Staff, Manage, Reset two-step sign-in.' },
    { q: 'What is the breed guide in the report?', a: 'Each flock is judged against the Hy-Line Brown standard for its age, unless a realistic target is set.' },
    ...COMMON,
  ],
};

/** Words people use for things the app names differently. */
const SYNONYMS: Record<string, string> = {
  sell: 'sale', sold: 'sale', mpesa: 'till', money: 'cash', dead: 'mortality', died: 'mortality', broken: 'damaged', count: 'count',
  deliver: 'delivery', receive: 'delivery', water: 'water', feed: 'feed', password: 'password', excel: 'workbook',
};

/** Lower-case words, synonyms added. */
export function words(q: string): string[] {
  const w = q.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((x) => x.length > 1);
  return [...new Set(w.flatMap((x) => (SYNONYMS[x] ? [x, SYNONYMS[x]] : [x])))];
}
/** How well a query matches a title and some body text: title words count three times. 0 means no match. */
export function score(q: string[], title: string, body = ''): number {
  if (!q.length) return 0;
  const t = title.toLowerCase(), b = body.toLowerCase();
  let s = 0, hit = 0;
  for (const w of q) {
    const inT = t.includes(w), inB = b.includes(w);
    if (inT) s += t.split(/[^a-z0-9]+/).some((x) => x.startsWith(w)) ? 4 : 3;
    else if (inB) s += 1;
    if (inT || inB) hit++;
  }
  return hit ? s * (hit / q.length) : 0;
}

export const whoOf = (role: Role, isVan: boolean): Who => (role === 'pos' && isVan ? 'van' : role);
