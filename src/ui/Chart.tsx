import { useEffect, useRef } from 'react';
import { Chart, registerables, type ChartConfiguration, type Plugin } from 'chart.js';

Chart.register(...registerables);

export const cssv = (k: string) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();

type Opts = Record<string, any>;
const merge = (a: Opts, b: Opts): Opts => {
  for (const k in b) a[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? merge(a[k] ?? {}, b[k]) : b[k];
  return a;
};
/** Chart options in the app's look: theme colours, faint grid, shared tooltips. */
export function baseOptions(extra: Opts = {}): Opts {
  const g = cssv('--line'), m = cssv('--muted');
  const o: Opts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: cssv('--fg'), titleColor: cssv('--bg'), bodyColor: cssv('--bg'), padding: 10, cornerRadius: 8 } },
    scales: {},
  };
  merge(o, extra);
  for (const k in o.scales) o.scales[k] = merge({ grid: { color: g }, border: { display: false }, ticks: { color: m, font: { size: 11 } }, title: { color: m } }, o.scales[k]);
  return o;
}

/** Coloured background bands for buffer charts (feed store, water tank). */
export const bandPlugin: Plugin = {
  id: 'bands',
  beforeDatasetsDraw(c, _a, o: any) {
    if (!o?.target) return;
    const { ctx, chartArea: a, scales: { y } } = c as any; const t = o.target;
    const zones: [number, number, string][] = [[0, 0.25, '--f-none'], [0.25, 0.5, '--f-low'], [0.5, 0.75, '--f-watch'], [0.75, 1, '--f-good'], [1, 99, '--f-full']];
    ctx.save();
    for (const [lo, hi, col] of zones) {
      const top = Math.max(a.top, y.getPixelForValue(hi * t)), bot = Math.min(a.bottom, y.getPixelForValue(lo * t));
      if (bot > top) { ctx.globalAlpha = 0.16; ctx.fillStyle = cssv(col); ctx.fillRect(a.left, top, a.right - a.left, bot - top); }
    }
    ctx.restore();
  },
};

export function ChartBox({ config, height = 240, label }: { config: () => ChartConfiguration; height?: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = cssv('--muted');
    const chart = new Chart(ref.current, config());
    return () => chart.destroy();
  }); // redrawn on every render, so data and theme changes always show
  return <div className="chart" style={{ height }}><canvas ref={ref} role="img" aria-label={label} /></div>;
}
