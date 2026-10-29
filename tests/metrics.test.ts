// Checks the dashboard arithmetic against data produced by the real database
// functions (tests/fixtures, exported from supabase/tests/02_demo_seed.sql).
import { describe, expect, it } from 'vitest';
import owner from './fixtures/owner.json';
import rayan from './fixtures/rayan.json';
import clerk from './fixtures/clerk.json';
import { addDays, eggs, range } from '../src/lib/format';
import {
  alertsFor, band, cashDay, dayLedger, feedHistory, feedInfo, intelligence, layRate, priceOf, salesOn, stockNow, tankInfo, tot, totalFunds, waterTrend,
} from '../src/lib/metrics';
import type { Dashboard } from '../src/lib/types';

const D = owner.dashboard as unknown as Dashboard;
const R = rayan.dashboard as unknown as Dashboard;
const C = clerk.dashboard as unknown as Dashboard;

describe('format', () => {
  it('shows eggs as trays and pieces', () => {
    expect(eggs(95)).toBe('3 tr 5 pc');
    expect(eggs(30)).toBe('1 tr');
    expect(eggs(7)).toBe('7 pc');
    expect(eggs(-31)).toBe('−1 tr 1 pc');
  });
  it('builds date ranges across months', () => {
    expect(range('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });
});

describe('buffer bands', () => {
  it('uses the five agreed bands', () => {
    expect(band(1.2).key).toBe('full');
    expect(band(1).key).toBe('full');
    expect(band(0.8).key).toBe('good');
    expect(band(0.55).key).toBe('watch');
    expect(band(0.3).key).toBe('low');
    expect(band(0.1).key).toBe('none');
  });
  it('rates the feed store against the weekly buffer', () => {
    const f = feedInfo(D);
    expect(f.target).toBe(315);
    expect(f.level).toBeCloseTo(D.feed_stock / 315, 6);
    expect(f.bags).toBe(Math.ceil((315 - D.feed_stock) / 50));
  });
});

describe('stock sheet', () => {
  it('closes at the stock the database reports, for every location', () => {
    for (const l of D.locations) {
      const L = dayLedger(D, l.id, D.today);
      expect(L.close).toEqual(stockNow(D, l.id));
      const recomputed = tot(L.open) + tot(L.coll) + tot(L.recv) - tot(L.out) - tot(L.sold) - tot(L.brk) + tot(L.adj);
      expect(recomputed).toBe(tot(L.close));
    }
  });
  it('chains days: yesterday closing = today opening', () => {
    for (const l of D.locations) {
      const y = dayLedger(D, l.id, addDays(D.today, -1)), t = dayLedger(D, l.id, D.today);
      expect(y.close).toEqual(t.open);
    }
  });
});

describe('money', () => {
  it('reconciles each cash drawer: opening + movements = expected', () => {
    for (const a of D.accounts.filter((x) => x.kind === 'cash')) {
      const c = cashDay(D, a.id, D.today);
      const sum = c.open + c.sales + c.moveIn - c.moveOut - c.fees - c.expenses + c.variance + c.opening;
      expect(Math.round(sum)).toBe(Math.round(c.close));
    }
  });
  it('every sale is fully allocated to cash, Till and Paybill', () => {
    for (const s of D.sales_daily) expect(Math.round(s.cash + s.till + s.paybill)).toBe(Math.round(s.value));
  });
  it('total funds equals the sum of the money lines', () => {
    const lines = D.money_daily.reduce((a, r) => a + Number(r.amount), 0);
    expect(totalFunds(D)).toBeGreaterThan(0);
    expect(Math.round(lines)).toBe(Math.round(totalFunds(D)));   // all history is inside the 45-day window
  });
  it('prices trays, loose eggs, cracked and jumbo', () => {
    expect(priceOf(D, { n: 32, c: 0, j: 1 })).toBe(450 + 2 * 16 + 20);
    expect(priceOf(D, { n: 0, c: 30, j: 0 })).toBe(300);
  });
});

describe('farm', () => {
  it('computes a plausible lay rate', () => {
    const w = range(addDays(D.today, -7), addDays(D.today, -1));
    const r = layRate(D, w);
    expect(r).toBeGreaterThan(0.7);
    expect(r).toBeLessThan(0.95);
  });
  it('tracks feed in store day by day', () => {
    const h = feedHistory(D, [D.today]);
    expect(h[0]).toBeCloseTo(D.feed_stock, 6);
  });
  it('spots the House B water drop', () => {
    const w = waterTrend(D, 'B');
    expect(w.change).toBeLessThan(-0.1);
    expect(alertsFor(D).some((a) => a.title.startsWith('House B drank'))).toBe(true);
  });
  it('reads the tank', () => {
    const t = tankInfo(D)!;
    expect(t.level).toBeCloseTo(t.litres / 1000, 6);
  });
});

describe('alerts by role', () => {
  it('owner sees feed, water, money and lay-rate alerts', () => {
    const titles = alertsFor(D).map((a) => a.title).join(' | ');
    expect(titles).toMatch(/Feed buffer/);
    expect(titles).toMatch(/lay rate down/);
    expect(titles).toMatch(/Cash short/);
    expect(titles).toMatch(/unbanked at Van/);
  });
  it('a shop attendant only sees their own location', () => {
    const A = alertsFor(R);
    expect(A.length).toBeGreaterThan(0);
    expect(A.every((a) => !a.loc || a.loc === 'RAYAN')).toBe(true);
    expect(A.some((a) => /Feed|water|Water/.test(a.title))).toBe(false);
  });
  it('the clerk gets farm alerts but not money alerts', () => {
    const A = alertsFor(C);
    expect(A.some((a) => /Feed buffer/.test(a.title))).toBe(true);
    expect(A.some((a) => /Cash|unbanked/.test(a.title))).toBe(false);
  });
});

describe('intelligence report', () => {
  it('names the struggling house and gives actions', () => {
    const I = intelligence(D);
    expect(I.lead).toMatch(/House B/);
    expect(I.findings.length).toBeGreaterThan(4);
    expect(I.actions.some((a) => /feed/i.test(a[1]))).toBe(true);
    expect(I.actions.some((a) => /House B/.test(a[1]))).toBe(true);
    expect(salesOn(D, I.W1).value).toBe(I.a.sales);
  });
});
