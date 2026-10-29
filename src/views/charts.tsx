// Chart configurations shared across screens.
import type { ChartConfiguration } from 'chart.js';
import { addDays, dshort, kes, kesS, n0, range } from '../lib/format';
import { band, collected, feedHistory, feedUsed, layRate, locColor, salesOn, waterOn } from '../lib/metrics';
import type { Dashboard } from '../lib/types';
import { bandPlugin, baseOptions, cssv } from '../ui/Chart';

const HOUSE_COLORS = ['--l-farm', '--l-van', '--l-tuala', '--l-rayan', '--l-lucky'];
export const houseColor = (i: number) => HOUSE_COLORS[i % HOUSE_COLORS.length];
const lastDays = (D: Dashboard, n: number, includeToday = false) => range(addDays(D.today, -n), addDays(D.today, includeToday ? 0 : -1));

export const productionChart = (D: Dashboard, n: number) => (): ChartConfiguration => {
  const days = lastDays(D, n);
  return {
    type: 'bar',
    data: { labels: days.map(dshort), datasets: [
      { type: 'line', label: 'Lay rate %', data: days.map((d) => +(layRate(D, [d]) * 100).toFixed(1)), yAxisID: 'y1', borderColor: cssv('--fg'), backgroundColor: cssv('--fg'), borderWidth: 2, pointRadius: 0, tension: 0.3, order: 0 } as any,
      ...D.houses.map((h, i) => ({ label: h.name, data: days.map((d) => { const q = collected(D, [d], h.id); return +((q.n + q.c + q.j) / 30).toFixed(1); }), backgroundColor: cssv(houseColor(i)), stack: 's', borderRadius: 2, order: 1 })),
    ] },
    options: baseOptions({ scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, title: { display: true, text: 'Trays' } },
      y1: { position: 'right', min: 50, max: 100, grid: { display: false }, ticks: { callback: (v: number) => `${v}%` } } } }) as any,
  };
};

export const salesChart = (D: Dashboard, n: number) => (): ChartConfiguration => {
  const days = lastDays(D, n, true);
  return {
    type: 'bar',
    data: { labels: days.map(dshort), datasets: D.locations.map((l) => ({ label: l.short, data: days.map((d) => salesOn(D, [d], l.id).value), backgroundColor: cssv(locColor(l.id)), stack: 's' })) },
    options: baseOptions({ scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: (v: number) => kesS(v) } } },
      plugins: { tooltip: { callbacks: { label: (c: any) => `${c.dataset.label}: ${kes(c.raw)}` } } } }) as any,
  };
};

export const payChart = (D: Dashboard, n: number, loc?: string) => (): ChartConfiguration => {
  const days = lastDays(D, n, true);
  const ds = (k: 'cash' | 'till' | 'paybill', label: string, col: string) => ({ label, data: days.map((d) => salesOn(D, [d], loc)[k]), backgroundColor: cssv(col), stack: 's', borderRadius: 2 });
  return {
    type: 'bar',
    data: { labels: days.map(dshort), datasets: [ds('cash', 'Cash', '--l-farm'), ds('till', 'Till', '--l-tuala'), ds('paybill', 'Paybill', '--l-van')] },
    options: baseOptions({ scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: (v: number) => kesS(v) } } } }) as any,
  };
};

export const feedStockChart = (D: Dashboard, n: number) => (): ChartConfiguration => {
  const days = lastDays(D, n - 1, true), t = D.settings.feed_buffer_kg, stock = feedHistory(D, days);
  return {
    type: 'line',
    data: { labels: days.map(dshort), datasets: [{ data: stock, borderColor: cssv('--fg'), borderWidth: 2, pointRadius: days.map((_, i) => (i === days.length - 1 ? 4 : 0)), pointBackgroundColor: cssv('--fg'), tension: 0.15 }] },
    plugins: [bandPlugin],
    options: baseOptions({ plugins: { bands: { target: t }, tooltip: { callbacks: { label: (c: any) => `${n0(c.raw)} kg · ${band(c.raw / t).label}` } } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { min: 0, suggestedMax: t * 1.4, title: { display: true, text: 'kg' } } } }) as any,
  };
};

export const feedUseChart = (D: Dashboard, n: number) => (): ChartConfiguration => {
  const days = lastDays(D, n - 1, true), plan = D.settings.feed_buffer_kg / 7;
  return {
    type: 'bar',
    data: { labels: days.map(dshort), datasets: [
      { data: days.map((d) => feedUsed(D, [d])), backgroundColor: cssv('--f-low'), borderRadius: 2 },
      { type: 'line', data: days.map(() => plan), borderColor: cssv('--muted'), borderDash: [5, 4], borderWidth: 1.3, pointRadius: 0 } as any,
    ] },
    options: baseOptions({ scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { title: { display: true, text: 'kg' } } } }) as any,
  };
};

export const waterChart = (D: Dashboard, n: number) => (): ChartConfiguration => {
  const days = lastDays(D, n - 1, true);
  return {
    type: 'bar',
    data: { labels: days.map(dshort), datasets: [
      ...D.houses.map((h, i) => ({ label: h.name, data: days.map((d) => waterOn(D, [d], h.id)), backgroundColor: cssv(houseColor(i)), stack: 's', borderRadius: 2, yAxisID: 'y' })),
      { type: 'line', label: 'Litres per kg feed', data: days.map((d) => { const f = feedUsed(D, [d]), w = waterOn(D, [d]); return f && w ? +(w / f).toFixed(2) : null; }),
        yAxisID: 'y1', borderColor: cssv('--fg'), borderWidth: 2, pointRadius: 2, spanGaps: true } as any,
    ] },
    options: baseOptions({ scales: { x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { stacked: true, title: { display: true, text: 'Litres' } },
      y1: { position: 'right', min: 0, suggestedMax: 3, grid: { display: false }, title: { display: true, text: 'L per kg feed' } } } }) as any,
  };
};

export const tankChart = (D: Dashboard) => (): ChartConfiguration => {
  const cap = D.settings.tank_capacity_l, pts = D.tank_daily;
  return {
    type: 'line',
    data: { labels: pts.map((p) => dshort(p.d)), datasets: [{ data: pts.map((p) => p.litres), borderColor: cssv('--info'), borderWidth: 2, pointRadius: 3, tension: 0.15 }] },
    plugins: [bandPlugin],
    options: baseOptions({ plugins: { bands: { target: cap }, tooltip: { callbacks: { label: (c: any) => `${n0(c.raw)} L · ${band(c.raw / cap).label}` } } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { min: 0, max: Math.ceil(cap * 1.05), title: { display: true, text: 'Litres' } } } }) as any,
  };
};

export const houseLayChart = (D: Dashboard) => (): ChartConfiguration => {
  const days = lastDays(D, 30);
  return {
    type: 'line',
    data: { labels: days.map(dshort), datasets: [
      ...D.houses.map((h, i) => ({ label: h.name, data: days.map((d) => { const r = layRate(D, [d], h.id); return Number.isFinite(r) ? +(r * 100).toFixed(1) : null; }), borderColor: cssv(houseColor(i)), backgroundColor: cssv(houseColor(i)), pointRadius: 0, borderWidth: 2, tension: 0.3, spanGaps: true })),
      ...D.houses.map((h) => ({ label: `${h.name} expected`, data: days.map(() => h.expected_lay * 100), borderColor: cssv('--muted'), borderDash: [5, 4], borderWidth: 1.2, pointRadius: 0 })),
    ] },
    options: baseOptions({ scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { min: 50, max: 100, ticks: { callback: (v: number) => `${v}%` } } } }) as any,
  };
};

export const outletWeekChart = (D: Dashboard, o: { loc: string; sales: { value: number }; prev: number }[]) => (): ChartConfiguration => ({
  type: 'bar',
  data: { labels: o.map((x) => D.locations.find((l) => l.id === x.loc)?.short ?? x.loc), datasets: [
    { label: 'Last 7 days', data: o.map((x) => x.sales.value), backgroundColor: cssv('--l-farm'), borderRadius: 4 },
    { label: 'Week before', data: o.map((x) => x.prev), backgroundColor: cssv('--line'), borderRadius: 4 },
  ] },
  options: baseOptions({ indexAxis: 'y', scales: { x: { ticks: { callback: (v: number) => kesS(v) } }, y: { grid: { display: false } } },
    plugins: { tooltip: { callbacks: { label: (c: any) => `${c.dataset.label}: ${kes(c.raw)}` } } } }) as any,
});

export const breakageChart = (D: Dashboard, rows: { loc: string; rate: number }[]) => (): ChartConfiguration => ({
  type: 'bar',
  data: { labels: rows.map((r) => D.locations.find((l) => l.id === r.loc)?.short ?? r.loc), datasets: [{ data: rows.map((r) => +(r.rate * 100).toFixed(2)),
    backgroundColor: rows.map((r) => cssv(r.rate * 100 > D.settings.break_tol ? '--f-low' : '--f-full')), borderRadius: 4 }] },
  options: baseOptions({ indexAxis: 'y', plugins: { tooltip: { callbacks: { label: (c: any) => `${c.raw}%` } } }, scales: { x: { ticks: { callback: (v: number) => `${v}%` } }, y: { grid: { display: false } } } }) as any,
});
