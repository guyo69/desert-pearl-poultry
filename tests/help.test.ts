import { describe, expect, it } from 'vitest';
import { FAQS, TASKS, TIPS, score, words } from '../src/lib/help';
import { ACTION_IDS } from '../src/ui/Help';

const ALL = Object.values(TIPS).flat();
const TEXT = JSON.stringify({ TIPS, TASKS, FAQS });
describe('help content', () => {
  it('keeps tips short and unique', () => {
    expect(new Set(ALL.map((t) => t.id)).size).toBe(ALL.length);
    for (const t of ALL) {
      expect(t.text.split(/\s+/).length, t.id).toBeLessThanOrEqual(12);
      expect(t.id).toMatch(/^[a-z0-9:._-]{1,60}$/);         // what the database accepts
    }
    for (const list of Object.values(TIPS)) expect(list.length).toBeLessThanOrEqual(7);
  });
  it('points every how-to at something that exists', () => {
    for (const t of Object.values(TASKS).flat()) if (t.action && !t.action.startsWith('go:')) expect(ACTION_IDS, t.title).toContain(t.action);
  });
  it('follows the house style', () => {
    expect(TEXT).not.toMatch(/—|!|n\/a/i);
  });
});

describe('search', () => {
  it('finds by title first, then by the words inside', () => {
    const q = words('sale');
    expect(score(q, 'Record a sale')).toBeGreaterThan(score(q, 'Credit paid back', 'customer sale money'));
    expect(score(q, 'Tank level', 'water')).toBe(0);
  });
  it('understands everyday words', () => {
    expect(words('sold')).toContain('sale');
    expect(score(words('dead birds'), 'Record deaths', 'mortality dead died birds')).toBeGreaterThan(0);
  });
});
