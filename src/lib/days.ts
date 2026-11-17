// Days complete (17 Nov 2026): the words shown with each person's week and the
// farm manager's list. Pure, so the tests can check every case.
import { daysBetween, dlabel, timeOf } from './format';
import type { MyWeek, RankPerson } from './api';

/** "eggs, water and sales". */
export const andList = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

const VAN_LEFT = 'eggs left on the van';
/** "Mon 16 Nov: sales and closing count not entered", or for the van "Mon 16 Nov: eggs were left on the van". */
export function missedLine(day: string, missing: string[]): string {
  const rest = missing.filter((m) => m !== VAN_LEFT);
  const left = missing.includes(VAN_LEFT) ? 'eggs were left on the van' : '';
  return `${dlabel(day)}: ${[rest.length ? `${andList(rest)} not entered` : '', left].filter(Boolean).join('; ')}`;
}

/** The short count in the corner of the week: "3 of 4 days complete". */
export function weekCount(w: MyWeek): string {
  if (!w.counted) return w.days.some((d) => d.state === 'done') ? 'Today is complete' : 'No full day yet';
  return `${w.done} of ${w.counted} day${w.counted === 1 ? '' : 's'} complete`;
}

/** One line under the week: a streak, the last day something was missed, or what finishes today. */
export function weekNote(w: MyWeek, van = false): string {
  const today = w.days.find((d) => d.day === w.today);
  const missed = [...w.days].reverse().find((d) => d.state === 'missed' && d.day < w.today);
  if (w.streak >= 2) return `${w.streak} complete days in a row. Keep it going.`;
  if (missed?.missing?.length) return `${missedLine(missed.day, missed.missing)}.`;
  if (today?.state === 'done') return 'Today is complete. Thank you.';
  if (today?.state === 'today') return today.missing?.length ? `To complete today: ${andList(today.missing.map((m) => m === VAN_LEFT ? 'end the day with the van empty' : m))}.` : 'Finish the steps above to complete today.';
  if (van && w.days.every((d) => d.state !== 'done' && d.state !== 'missed')) return 'No road days yet this week.';
  return 'Each day with every step entered counts as complete.';
}

const ROLE: Record<RankPerson['role'], string> = { clerk: 'Production clerk', store: 'Inventory clerk', pos: 'Outlet attendant' };
/** "Outlet attendant, Tuala Egg Shop", "Van driver", "Production clerk". */
export const whoIs = (p: RankPerson) => p.van ? 'Van driver' : p.role === 'pos' ? `${ROLE.pos}${p.place ? `, ${p.place}` : ''}` : ROLE[p.role];

/** "Today 09:14", "Yesterday", "Mon 16 Nov". */
export function when(iso: string | null, today: string): string {
  if (!iso) return '';
  const day = new Date(new Date(iso).getTime() + 3 * 3600e3).toISOString().slice(0, 10);
  const n = daysBetween(day, today);
  return n <= 0 ? `today ${timeOf(iso)}` : n === 1 ? 'yesterday' : dlabel(day);
}

/** The line under a person: what they last missed, and when they last entered something or signed in. */
export function rankNote(p: RankPerson, today: string): string {
  const parts: string[] = [];
  if (p.last_missed) parts.push(`${missedLine(p.last_missed.day, p.last_missed.missing)}`);
  else if (!p.counted) parts.push(p.van ? 'The van did not go out' : 'No days to count yet');
  if (p.last_entry) parts.push(`last entry ${when(p.last_entry, today)}`);
  else if (p.last_signin) parts.push(`signed in ${when(p.last_signin, today)}, no entries since 12 Nov`);
  else parts.push('has not signed in');
  return parts.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join('. ');
}

/** 0 to 1, or null when there was no day to count. */
export const rate = (p: RankPerson) => p.counted ? p.done / p.counted : null;
