import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { expectedLay, guideFits, realisticTarget, weeklyMortality } from '../src/lib/knowledge';
import { buildWeekReport } from '../src/lib/report';
import type { WeeklyReport } from '../src/lib/api';

describe('the knowledge base', () => {
  it('follows the breed guide by age, and projects past 100 weeks', () => {
    expect(expectedLay(30).rate).toBeCloseTo(0.933, 3);
    expect(expectedLay(80).rate).toBeCloseTo(0.797, 3);
    expect(expectedLay(82.5).rate).toBeCloseTo((79.7 + 77.6) / 200, 3);
    const old = expectedLay(110);
    expect(old.beyond).toBe(true);
    expect(old.rate).toBeCloseTo(0.662, 2);        // 70.8 less 0.46 a week for 10 weeks
  });
  it('knows which breeds the guide fits', () => {
    expect(guideFits('ISA Brown')).toBe('yes');
    expect(guideFits(null)).toBe('assumed');
    expect(guideFits('Kenbro')).toBe('no');
  });
  it('treats a 100% target as not set', () => {
    expect(realisticTarget(1)).toBe(false);
    expect(realisticTarget(0.85)).toBe(true);
    expect(weeklyMortality(95)).toBeGreaterThan(weeklyMortality(30));
  });
});

describe('the weekly report', () => {
  const D = JSON.parse(fs.readFileSync(new URL('./fixtures/owner.json', import.meta.url), 'utf8')).dashboard;
  const R: WeeklyReport = {
    period: { from: '2026-10-28', to: '2026-11-03', label: 'Wed 28 Oct to Tue 03 Nov' }, baseline: { comparable: false, reason: 'first_week' }, provisional: true,
    completeness: { pct: 11, entered: 8, expected: 73, gaps: [{ where: 'House A', days: ['Sat 31 Oct'], missing: ['eggs', 'water'] }] } as any,
    insights: [
      { kind: 'completeness', severity: 'red', where: 'x', role: 'x', action: 'x', text: 'Every figure in this email is provisional.' },
      { kind: 'lay_rate', severity: 'orange', where: 'House A', role: 'x', action: 'x', text: 'House A laid (provisional)' },
      { kind: 'water_feed', severity: 'amber', where: 'Central Farm', role: 'Production clerk', action: 'x', text: 'x', numbers: { ratio: 0.44, min: 1.6, max: 2.5 } } as any,
    ],
  };
  const W = buildWeekReport(D, R);
  const all = JSON.stringify(W);
  it('reads as a report: no provisional labels, no email, no em dashes', () => {
    expect(all).not.toMatch(/provisional/i);
    expect(all).not.toMatch(/email/i);
    expect(all).not.toMatch(/—/);
    expect(all).not.toMatch(/n\/a/i);
  });
  it('puts records first and reports what was not entered once', () => {
    expect(W.findings[0].area).toBe('Records');
    expect(W.findings[0].title).toBe('8 of 73 daily records entered (11%)');
    expect(W.coverage?.gaps[0].where).toBe('House A');
  });
  it('judges each flock against its age and flags a 100% target', () => {
    expect(W.flocks.length).toBeGreaterThan(0);
    expect(W.flocks.every((r) => r.guide == null || (r.guide > 0 && r.guide < 1))).toBe(true);
    if (D.houses.some((h: any) => h.expected_lay >= 0.97)) expect(W.findings.some((x) => x.area === 'Setup')).toBe(true);
    expect(W.findings.some((x) => x.title.startsWith('Water to feed ratio 0.44'))).toBe(true);
  });
  it('has a short summary and a stated basis for comparison', () => {
    expect(W.summary.length).toBeLessThanOrEqual(4);
    expect(W.reason).toMatch(/baseline/);
  });
});
