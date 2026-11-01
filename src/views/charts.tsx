// Every time chart in the app, built on the adaptive TimeChart.
import { addDays, kes, kesS, n0, range } from '../lib/format';
import { collected, feedHistory, feedUsed, layRate, locColor, salesOn, tot, waterOn } from '../lib/metrics';
import type { Dashboard } from '../lib/types';
import { TimeChart } from '../ui/TimeChart';

const HOUSE_COLORS = ['--l-farm', '--l-van', '--l-tuala', '--l-rayan', '--l-lucky'];
export const houseColor = (i: number) => HOUSE_COLORS[i % HOUSE_COLORS.length];
const allDays = (D: Dashboard) => range(D.from, D.today);
/** Days up to yesterday, for measures where today is still being recorded. */
const fullDays = (D: Dashboard) => range(D.from, addDays(D.today, -1));
const fin = (v: number) => (Number.isFinite(v) ? v : null);
const tr = (v: number) => (v >= 10 ? n0(v) : v.toFixed(1));

export function ProductionChart({ D }: { D: Dashboard }) {
  const days = fullDays(D);
  return <TimeChart label="Egg production by house" days={days} summary="avg" unit="trays / day" height={240}
    series={D.houses.map((h, i) => ({ key: h.id, label: h.name, color: houseColor(i),
      values: days.map((d) => { const q = collected(D, [d], h.id), t = q.n + (q.b ?? 0) + q.c + q.j; return t > 0 ? t / 30 : null; }) }))}
    overlay={{ label: 'Lay rate', color: '--fg', min: 50, max: 100, format: (v) => `${Math.round(v * 10) / 10}%`,
      values: days.map((d) => (tot(collected(D, [d])) > 0 ? fin(layRate(D, [d]) * 100) : null)) }}
    format={tr} tick={(v) => n0(v)} />;
}

export function SalesChart({ D, loc }: { D: Dashboard; loc?: string }) {
  const days = allDays(D);
  const locs = loc ? D.locations.filter((l) => l.id === loc) : D.locations;
  return <TimeChart label="Sales by location" days={days} summary="sum" height={230}
    series={locs.map((l) => ({ key: l.id, label: l.short, color: locColor(l.id), values: days.map((d) => salesOn(D, [d], l.id).value) }))}
    format={kes} tick={kesS} />;
}

export function PayChart({ D, loc }: { D: Dashboard; loc?: string }) {
  const days = allDays(D);
  const s = (k: 'cash' | 'till' | 'paybill') => days.map((d) => salesOn(D, [d], loc)[k]);
  return <TimeChart label="Receipts by payment method" days={days} summary="sum" height={220} initialDays={14}
    series={[{ key: 'cash', label: 'Cash', color: '--l-farm', values: s('cash') }, { key: 'till', label: 'Till', color: '--l-tuala', values: s('till') },
      { key: 'paybill', label: 'Paybill', color: '--l-van', values: s('paybill') }]}
    format={kes} tick={kesS} />;
}

export function FeedStockChart({ D }: { D: Dashboard }) {
  const days = allDays(D), kg = D.settings.bag_kg, t = D.settings.feed_buffer_kg / kg;
  return <TimeChart label="Feed in store" days={days} summary="last" unit="bags" height={250} bands={t}
    series={[{ key: 'feed', label: 'Feed in store (end of day)', color: '--fg', values: feedHistory(D, days).map((x) => x / kg) }]}
    refLines={[{ value: t, label: `Full buffer ${n0(t)} bags`, color: '--f-full' }]}
    format={n0} />;
}

export function FeedUseChart({ D }: { D: Dashboard }) {
  const days = fullDays(D), kg = D.settings.bag_kg, plan = D.settings.feed_buffer_kg / kg / 7;
  return <TimeChart label="Daily feed use" days={days} summary="avg" unit="bags / day" height={200}
    series={[{ key: 'use', label: 'Feed used', color: '--f-low', values: days.map((d) => feedUsed(D, [d]) / kg) }]}
    refLines={[{ value: plan, label: `Plan ${plan.toFixed(1)} bags/day` }]}
    format={n0} />;
}

export function WaterChart({ D }: { D: Dashboard }) {
  const days = fullDays(D);
  return <TimeChart label="Water drunk by house" days={days} summary="avg" unit="L / day" height={230}
    series={D.houses.map((h, i) => ({ key: h.id, label: h.name, color: houseColor(i), values: days.map((d) => waterOn(D, [d], h.id) || null) }))}
    overlay={{ label: 'Litres per kg of feed', color: '--fg', min: 0, max: 3, format: (v) => `${Math.round(v * 100) / 100} L/kg`,
      values: days.map((d) => { const f = feedUsed(D, [d]), w = waterOn(D, [d]); return f > 0 && w > 0 ? w / f : null; }) }}
    format={n0} />;
}

export function TankChart({ D }: { D: Dashboard }) {
  const days = allDays(D), cap = D.settings.tank_capacity_l;
  return <TimeChart label="Water tank level" days={days} summary="last" unit="L" height={210} bands={cap} yMaxFixed={Math.ceil(cap * 1.05)}
    series={[{ key: 'tank', label: 'Last reading of the day', color: '--info', values: days.map((d) => D.tank_daily.find((x) => x.d === d)?.litres ?? null) }]}
    format={n0} />;
}

export function HouseLayChart({ D }: { D: Dashboard }) {
  const days = range(D.from, addDays(D.today, -1));
  return <TimeChart label="Lay rate by house" days={days} summary="avg" height={220} lineOnly stacked={false} yMin={50} yMaxFixed={100}
    series={D.houses.map((h, i) => ({ key: h.id, label: h.name, color: houseColor(i), values: days.map((d) => (tot(collected(D, [d], h.id)) > 0 ? fin(layRate(D, [d], h.id) * 100) : null)) }))}
    refLines={D.houses.map((h, i) => ({ value: h.expected_lay * 100, label: `${h.name} expected`, color: houseColor(i) }))}
    format={(v) => `${v.toFixed(1)}%`} tick={(v) => `${v}%`} />;
}
