import type { ReactNode } from 'react';
import { BANDS, band, feedInfo, locColor, tankInfo, type Alert, type Band } from '../lib/metrics';
import { dshort, n0, pct, timeOf } from '../lib/format';
import type { Dashboard, Sev } from '../lib/types';
import { Icon } from './icons';

export const sevVar = (s: Sev | 'ok') => `var(${s === 'red' ? '--f-none' : s === 'orange' ? '--f-low' : s === 'amber' ? '--f-watch' : s === 'ok' ? '--f-full' : '--info'})`;
export const sevClass = (s: Sev | 'ok') => `sev-${s}`;

export function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return <div className="kpi"><div className="lbl">{label}</div><div className="val">{value}</div>{sub != null && <div className="sub">{sub}</div>}</div>;
}
export function Card({ title, aside, children, style }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return <section className="card" style={style}>{(title || aside) && <div className="card-h"><h3>{title}</h3>{aside}</div>}{children}</section>;
}
export const LocDot = ({ id }: { id: string }) => <span className="locdot" style={{ background: `var(${locColor(id)})` }} />;
export function Legend({ items }: { items: [string, string][] }) {
  return <div className="legend">{items.map(([c, l]) => <span key={l}><i style={{ background: c.startsWith('--') ? `var(${c})` : c }} />{l}</span>)}</div>;
}
export function Tile({ icon, label, color, onClick }: { icon: string; label: string; color: string; onClick: () => void }) {
  return <button className="tile" onClick={onClick}><span className="ic" style={{ background: `var(${color})` }}><Icon name={icon} /></span>{label}</button>;
}
export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
export function Delta({ a, b, invert, pts }: { a: number; b: number; invert?: boolean; pts?: boolean }) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || (!pts && !b)) return <span className="muted">–</span>;
  const d = pts ? a - b : (a - b) / Math.abs(b);
  if (Math.abs(d) < (pts ? 0.002 : 0.005)) return <span className="muted">steady</span>;
  const good = invert ? d < 0 : d > 0;
  return <span className={good ? 'up' : 'down'}>{d > 0 ? '▲' : '▼'} {pts ? `${(Math.abs(d) * 100).toFixed(1)} pts` : pct(Math.abs(d))}</span>;
}
export function RangeSeg({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return <div className="seg" role="group" aria-label="Chart range">{[7, 14, 30].map((n) => <button key={n} aria-pressed={value === n} onClick={() => onChange(n)}>{n} days</button>)}</div>;
}
export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return <div className="seg">{options.map(([k, l]) => <button key={k} aria-pressed={value === k} onClick={() => onChange(k)}>{l}</button>)}</div>;
}

export function AlertList({ list, limit }: { list: Alert[]; limit?: number }) {
  if (!list.length) return <Empty><Icon name="check" /><br />Nothing needs attention.</Empty>;
  return <div className="alerts">{list.slice(0, limit ?? 99).map((a, i) => (
    <div className="alert" key={i}><span className="stripe" style={{ background: sevVar(a.sev) }} /><div style={{ minWidth: 0 }}><b>{a.title}</b><p>{a.body}</p></div></div>
  ))}</div>;
}

/** Five-band gauge used for both the feed store and the water tank. */
function Gauge({ level, b, label }: { level: number; b: Band; label: string }) {
  const pos = (Math.max(0, Math.min(1.25, level)) / 1.25) * 100;
  const order = [4, 3, 2, 1, 0];
  return (
    <div className="gauge" role="img" aria-label={`${label} ${pct(level, 0)}, ${b.label}`}>
      <div className="bands">{order.map((k) => <i key={k} className={BANDS[k] === b ? 'on' : ''} style={{ background: `var(${BANDS[k].color})` }} />)}</div>
      <div className="mark" style={{ left: `${pos}%`, borderColor: `var(${b.color})` }} />
      <div className="scale"><span>No buffer &lt;25%</span><span>Low 25–49</span><span>Watch 50–74</span><span>Good 75–99</span><span>Full 100%+</span></div>
    </div>
  );
}

export function FeedCard({ D, actions }: { D: Dashboard; actions?: ReactNode }) {
  const f = feedInfo(D);
  return (
    <section className="card feed" aria-label="Feed buffer">
      <div className="head">
        <div><div className="muted" style={{ fontSize: 13, fontWeight: 600 }}>Feed buffer · Layers feed</div>
          <div className="bigpct" style={{ color: `var(${f.band.color})` }}>{pct(f.level, 0)}</div>
          <div className="kg">{n0(f.stock)} kg in store of {n0(f.target)} kg weekly buffer</div></div>
        <span className={`chip ${sevClass(f.band.sev)}`}><span className="dot" />{f.band.label}</span>
      </div>
      <Gauge level={f.level} b={f.band} label="Feed level" />
      <div className="facts">
        <div><b>{f.cover.toFixed(1)} days</b><span>of feed at {n0(f.daily)} kg/day{f.estimated ? ' (plan)' : ''}</span></div>
        <div><b>{f.bags ? `${f.bags} bags` : 'None'}</b><span>to order for full buffer</span></div>
        <div><b>{f.level < 0.25 ? 'Now' : dshort(f.noneDate)}</b><span>reaches No buffer if not restocked</span></div>
      </div>
      {actions && <div className="row-btns" style={{ marginTop: 14 }}>{actions}</div>}
    </section>
  );
}

export function TankCard({ D, actions }: { D: Dashboard; actions?: ReactNode }) {
  const t = tankInfo(D);
  if (!t) return (
    <section className="card"><div className="card-h" style={{ margin: 0 }}><div><h3>Water tank</h3><div className="muted" style={{ fontSize: 13.5 }}>No reading yet. Record the tank level to start tracking.</div></div>{actions}</div></section>
  );
  const b = band(t.level);
  return (
    <section className="card feed" aria-label="Water tank">
      <div className="head">
        <div><div className="muted" style={{ fontSize: 13, fontWeight: 600 }}>Water tank · read {dshort(t.at.slice(0, 10)) === dshort(D.today) ? `today ${timeOf(t.at)}` : dshort(t.at.slice(0, 10))}</div>
          <div className="bigpct" style={{ color: `var(${b.color})` }}>{pct(t.level, 0)}</div>
          <div className="kg">{n0(t.litres)} L of {n0(t.cap)} L</div></div>
        <span className={`chip ${sevClass(b.sev)}`}><span className="dot" />{b.label}</span>
      </div>
      <Gauge level={t.level} b={b} label="Tank level" />
      <div className="facts">
        <div><b>{t.cover != null ? `${t.cover.toFixed(1)} days` : '–'}</b><span>of drinking water{t.daily ? ` at ${n0(t.daily)} L/day` : ''}</span></div>
        <div><b>{n0(Math.max(0, t.cap - t.litres))} L</b><span>to fill the tank</span></div>
        <div><b>{n0(t.daily)} L</b><span>average daily intake</span></div>
      </div>
      {actions && <div className="row-btns" style={{ marginTop: 14 }}>{actions}</div>}
    </section>
  );
}

/** Horizontal comparison bars (categories), with an optional faint "previous" bar. */
export function BarList({ rows, format }: { rows: { key: string; label: React.ReactNode; value: number; prev?: number; color: string; note?: React.ReactNode }[]; format: (v: number) => string }) {
  const max = Math.max(1e-9, ...rows.map((r) => Math.max(r.value, r.prev ?? 0)));
  return <div className="barlist">{rows.map((r) => (
    <div className="br" key={r.key}>
      <div className="br-h"><span>{r.label}</span><b>{format(r.value)}</b></div>
      <div className="br-track"><span style={{ width: `${(r.value / max) * 100}%`, background: r.color.startsWith('--') ? `var(${r.color})` : r.color }} /></div>
      {r.prev != null && <div className="br-track prev"><span style={{ width: `${(r.prev / max) * 100}%` }} /></div>}
      {r.note && <div className="br-note">{r.note}</div>}
    </div>))}</div>;
}
