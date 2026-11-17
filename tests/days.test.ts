// The words shown with each person's week and the farm manager's list (17 Nov 2026).
import { describe, expect, it } from 'vitest';
import { andList, missedLine, rankNote, weekCount, weekNote, whoIs } from '../src/lib/days';
import type { MyWeek, RankPerson } from '../src/lib/api';

const day = (d: string, state: MyWeek['days'][number]['state'], missing?: string[]) => ({ day: d, label: d, state, missing });
const week = (days: MyWeek['days'], done: number, counted: number, streak = 0): MyWeek => ({ from: '2026-11-16', today: '2026-11-18', days, done, counted, streak });
const later = ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'].map((d) => day(d, 'later'));

describe('the week', () => {
  it('counts complete days', () => {
    expect(weekCount(week([day('2026-11-16', 'done'), day('2026-11-17', 'done'), day('2026-11-18', 'today'), ...later], 2, 2))).toBe('2 of 2 days complete');
    expect(weekCount(week([day('2026-11-16', 'before'), day('2026-11-17', 'before'), day('2026-11-18', 'today'), ...later], 0, 0))).toBe('No full day yet');
    expect(weekCount(week([day('2026-11-16', 'missed'), day('2026-11-17', 'before'), day('2026-11-18', 'today'), ...later], 0, 1))).toBe('0 of 1 day complete');
  });
  it('says one useful thing', () => {
    expect(weekNote(week([day('2026-11-16', 'done'), day('2026-11-17', 'done'), day('2026-11-18', 'today'), ...later], 2, 2, 2))).toBe('2 complete days in a row. Keep it going.');
    expect(weekNote(week([day('2026-11-16', 'done'), day('2026-11-17', 'missed', ['sales', 'closing count']), day('2026-11-18', 'today'), ...later], 1, 2)))
      .toBe('Tue 17 Nov: sales and closing count not entered.');
    expect(weekNote(week([day('2026-11-16', 'closed'), day('2026-11-17', 'closed'), day('2026-11-18', 'today', ['eggs left on the van']), ...later], 0, 0), true))
      .toBe('To complete today: end the day with the van empty.');
    expect(weekNote(week([day('2026-11-16', 'closed'), day('2026-11-17', 'closed'), day('2026-11-18', 'closed'), ...later], 0, 0), true)).toBe('No road days yet this week.');
    expect(weekNote(week([day('2026-11-16', 'before'), day('2026-11-17', 'before'), day('2026-11-18', 'done'), ...later], 1, 1, 1))).toBe('Today is complete. Thank you.');
  });
  it('writes plain words', () => {
    const all = [weekNote(week([day('2026-11-16', 'missed', ['eggs and water for House A']), day('2026-11-17', 'missed', ['eggs left on the van']), day('2026-11-18', 'today'), ...later], 0, 2))];
    for (const t of all) { expect(t).not.toMatch(/[—!]|n\/a/); }
    expect(missedLine('2026-11-17', ['eggs left on the van'])).toBe('Tue 17 Nov: eggs were left on the van');
    expect(andList(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('the farm manager list', () => {
  const p = (x: Partial<RankPerson>): RankPerson => ({ id: '1', name: 'Amina', role: 'pos', location_id: 'TUALA', place: 'Tuala Egg Shop', van: false, days: [], done: 0, counted: 0, last_missed: null, last_entry: null, last_signin: null, ...x });
  it('names each person by their job', () => {
    expect(whoIs(p({}))).toBe('Outlet attendant, Tuala Egg Shop');
    expect(whoIs(p({ van: true, place: 'Van' }))).toBe('Van driver');
    expect(whoIs(p({ role: 'clerk' }))).toBe('Production clerk');
  });
  it('says what was missed and when they last used the app', () => {
    expect(rankNote(p({ counted: 3, done: 2, last_missed: { day: '2026-11-16', label: '', missing: ['closing count'] }, last_entry: '2026-11-17T06:12:00Z' }), '2026-11-17'))
      .toBe('Mon 16 Nov: closing count not entered. Last entry today 09:12');
    expect(rankNote(p({ van: true }), '2026-11-17')).toBe('The van did not go out. Has not signed in');
    expect(rankNote(p({ counted: 2, done: 2, last_signin: '2026-11-15T05:00:00Z' }), '2026-11-17')).toBe('Signed in Sun 15 Nov, no entries since 12 Nov');
  });
});
