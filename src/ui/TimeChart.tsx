// Adaptive time chart, in the style of Apple Health.
//
// When many days are squeezed into the width (e.g. 30 or 90 days on a
// phone) it draws smooth lines/areas. Zooming in (pinch, ctrl/⌘ + scroll,
// the range buttons, or + / − keys) widens each day; once a day is wide
// enough the lines morph into (stacked) bars and the chart scrolls
// sideways through earlier days with native momentum scrolling.
// Tap or hover a day to read its exact values in the header.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { dlabel, dshort } from '../lib/format';

export interface TSeries { key: string; label: string; color: string; values: (number | null)[] }
export interface TOverlay { label: string; color: string; values: (number | null)[]; format: (v: number) => string; min: number; max: number }
export interface TRef { value: number; label: string; color?: string }

export interface TimeChartProps {
  label: string;
  days: string[];                       // ISO dates, oldest first
  series: TSeries[];
  stacked?: boolean;                    // stack series in bar mode (default when >1 series)
  lineOnly?: boolean;                   // never morph to bars (e.g. rates)
  overlay?: TOverlay;                   // second measure drawn as a line on its own scale
  refLines?: TRef[];                    // dashed horizontal references (plan, expected)
  bands?: number;                       // buffer target: shade the five colour bands
  format: (v: number) => string;        // header value
  tick?: (v: number) => string;         // axis labels
  summary?: 'avg' | 'sum' | 'last';
  unit?: string;
  height?: number;
  initialDays?: number;
  yMin?: number;                        // fixed axis floor (rates)
  yMaxFixed?: number;                   // fixed axis ceiling (rates)
}

const AXIS_W = 46, PAD = 6, TOP = 10, XLAB = 24;
const BAR_ON = 18, BAR_OFF = 14;        // px per day: switch to bars at 18, back to lines below 14

const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

/** Smoothly animates a number towards `target`. */
function useTween(target: number, ms: number) {
  const [v, setV] = useState(target);
  const cur = useRef(target), raf = useRef(0);
  useEffect(() => {
    const from = cur.current;
    if (from === target) return;
    if (ms <= 0 || reduceMotion()) { cur.current = target; setV(target); return; }
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - p, 3);
      cur.current = from + (target - from) * e; setV(cur.current);
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);
  return v;
}

function niceScale(max: number, ticks = 4) {
  if (!(max > 0)) return { max: 1, step: 0.25 };
  const raw = max / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { max: step * Math.ceil(max / step - 1e-9), step };
}

/** Monotone cubic path through points (no overshoot). `join` continues an existing path. */
function monotone(pts: [number, number][], join = false): string {
  const n = pts.length;
  if (!n) return '';
  let d = `${join ? 'L' : 'M'}${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  if (n === 1) return d;
  const dx: number[] = [], m: number[] = [], t: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / (dx[i] || 1); }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + t[i] * h).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - t[i + 1] * h).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

/** Splits indexes into runs where every series has a value. */
function runs(n: number, ok: (i: number) => boolean): number[][] {
  const out: number[][] = []; let cur: number[] = [];
  for (let i = 0; i < n; i++) { if (ok(i)) cur.push(i); else if (cur.length) { out.push(cur); cur = []; } }
  if (cur.length) out.push(cur);
  return out;
}

const BAND_ZONES: [number, number, string][] = [[0, 0.25, '--f-none'], [0.25, 0.5, '--f-low'], [0.5, 0.75, '--f-watch'], [0.75, 1, '--f-good'], [1, 99, '--f-full']];
const css = (c: string) => (c.startsWith('--') ? `var(${c})` : c);

export function TimeChart(props: TimeChartProps) {
  // drop leading days before any records exist (e.g. before go-live)
  const p = useMemo(() => {
    const has = (i: number) => props.series.some((s) => s.values[i] != null && s.values[i] !== 0) || (props.overlay?.values[i] != null);
    let first = 0; while (first < props.days.length - 1 && !has(first)) first++;
    if (first === 0) return props;
    return { ...props, days: props.days.slice(first), series: props.series.map((s) => ({ ...s, values: s.values.slice(first) })),
      overlay: props.overlay && { ...props.overlay, values: props.overlay.values.slice(first) } };
  }, [props]);
  const n = p.days.length;
  const H = p.height ?? 220;
  const stacked = p.stacked ?? p.series.length > 1;
  const wrap = useRef<HTMLDivElement>(null), sc = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null);
  const [plotW, setPlotW] = useState(0);
  const [ppd, setPpd] = useState(0);
  const ppdRef = useRef(0); ppdRef.current = ppd;
  const [scroll, setScroll] = useState(0);
  const [sel, setSel] = useState<number | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const atEndOnMount = useRef(true);
  const [bars, setBars] = useState(false);

  const minPpd = plotW > 0 ? (plotW - PAD * 2) / Math.max(n, 1) : 1;
  const maxPpd = Math.max(56, plotW / 7);
  const clamp = useCallback((v: number) => Math.min(maxPpd, Math.max(minPpd, v)), [minPpd, maxPpd]);

  // measure
  useLayoutEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setPlotW(Math.max(0, Math.floor(e.contentRect.width) - AXIS_W)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  // first layout: start at `initialDays` showing the latest days
  useLayoutEffect(() => {
    if (plotW <= 0 || ppd > 0) return;
    const d = Math.min(p.initialDays ?? 30, n);
    setPpd(Math.min(Math.max(56, plotW / 7), Math.max((plotW - PAD * 2) / Math.max(n, 1), (plotW - PAD * 2) / Math.max(d, 1))));
  }, [plotW, ppd, n, p.initialDays]);
  // keep within limits when the width changes
  useEffect(() => { if (ppd > 0) setPpd((v) => clamp(v)); }, [clamp, ppd]);
  // apply scroll after a zoom, or jump to the latest day on first render
  useLayoutEffect(() => {
    const el = sc.current; if (!el || ppd <= 0) return;
    if (pendingScroll.current != null) { el.scrollLeft = pendingScroll.current; pendingScroll.current = null; }
    else if (atEndOnMount.current) { el.scrollLeft = el.scrollWidth; atEndOnMount.current = false; }
    setScroll(el.scrollLeft);
  }, [ppd, plotW]);

  // line ↔ bar decision with hysteresis
  useEffect(() => {
    if (p.lineOnly) return;
    if (!bars && ppd >= BAR_ON) setBars(true);
    else if (bars && ppd > 0 && ppd < BAR_OFF) setBars(false);
  }, [ppd, bars, p.lineOnly]);
  const m = useTween(bars && !p.lineOnly ? 1 : 0, 340);

  /** Zoom to `next` px/day keeping the day under `anchorX` (px from the plot's left edge) in place. */
  const zoomTo = useCallback((next: number, anchorX: number) => {
    const el = sc.current; if (!el) return;
    const cur = ppdRef.current, nv = clamp(next);
    if (Math.abs(nv - cur) < 0.01) return;
    const day = (el.scrollLeft + anchorX - PAD) / cur;
    pendingScroll.current = Math.max(0, day * nv + PAD - anchorX);
    setPpd(nv);
  }, [clamp]);

  const animRaf = useRef(0);
  const animateTo = useCallback((target: number) => {
    cancelAnimationFrame(animRaf.current);
    const from = ppdRef.current, to = clamp(target), t0 = performance.now(), ms = reduceMotion() ? 0 : 380;
    const el = sc.current; if (!el) return;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
    const anchor = atEnd ? plotW : plotW / 2;
    const step = (t: number) => {
      const q = ms ? Math.min(1, (t - t0) / ms) : 1, e = 1 - Math.pow(1 - q, 3);
      zoomTo(from + (to - from) * e, anchor);
      if (q < 1) animRaf.current = requestAnimationFrame(step);
    };
    animRaf.current = requestAnimationFrame(step);
  }, [clamp, plotW, zoomTo]);

  // pinch (touch), ctrl/⌘ + wheel or trackpad pinch (desktop)
  useEffect(() => {
    const el = sc.current, host = body.current; if (!el || !host) return;
    let pinch: { d0: number; p0: number; x: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const r = el.getBoundingClientRect();
        setSel(null);
        pinch = { d0: dist(e.touches), p0: ppdRef.current, x: Math.min(r.width, Math.max(0, (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left)) };
        e.preventDefault();
      }
    };
    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) { e.preventDefault(); zoomTo(pinch.p0 * (dist(e.touches) / pinch.d0), pinch.x); }
    };
    const onEnd = (e: TouchEvent) => { if (e.touches.length < 2) pinch = null; };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomTo(ppdRef.current * Math.exp(-e.deltaY * 0.012), e.clientX - r.left);
    };
    const stopGesture = (e: Event) => e.preventDefault();   // iOS Safari page zoom
    host.addEventListener('touchstart', onStart, { passive: false });
    host.addEventListener('touchmove', onMove, { passive: false });
    host.addEventListener('touchend', onEnd);
    host.addEventListener('touchcancel', onEnd);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('gesturestart', stopGesture as EventListener);
    host.addEventListener('gesturechange', stopGesture as EventListener);
    return () => {
      host.removeEventListener('touchstart', onStart); host.removeEventListener('touchmove', onMove);
      host.removeEventListener('touchend', onEnd); host.removeEventListener('touchcancel', onEnd);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('gesturestart', stopGesture as EventListener); host.removeEventListener('gesturechange', stopGesture as EventListener);
    };
  }, [zoomTo]);

  const raf = useRef(0);
  const onScroll = () => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(() => sc.current && setScroll(sc.current.scrollLeft)); };

  // ---- data ------------------------------------------------------------
  const cum = useMemo(() => {
    const out: (number | null)[][] = [];
    let prev: (number | null)[] = p.days.map(() => 0);
    for (const s of p.series) {
      const row = p.days.map((_, i) => (s.values[i] == null ? null : (stacked ? (prev[i] ?? 0) : 0) + (s.values[i] as number)));
      out.push(row); if (stacked) prev = row.map((v, i) => (v == null ? prev[i] : v));
    }
    return out;
  }, [p.days, p.series, stacked]);
  const totalAt = useCallback((i: number) => {
    const vals = p.series.map((s) => s.values[i]);
    if (vals.every((v) => v == null)) return null;
    if (stacked) return vals.reduce<number>((a, v) => a + (v ?? 0), 0);
    const ok = vals.filter((v): v is number => v != null);
    return ok.reduce((a, v) => a + v, 0) / ok.length;        // side by side: header shows the mean
  }, [p.series, stacked]);

  // visible days (scroll can briefly lag a zoom, so clamp both ends)
  const vis0 = ppd > 0 ? Math.min(n - 1, Math.max(0, Math.floor((scroll - PAD) / ppd))) : 0;
  const vis1 = ppd > 0 ? Math.max(vis0, Math.min(n - 1, Math.ceil((scroll + plotW - PAD) / ppd) - 1)) : n - 1;
  const visMax = useMemo(() => {
    let mx = 0;
    for (let i = vis0; i <= vis1; i++) {
      if (stacked) { const t = totalAt(i); if (t != null) mx = Math.max(mx, t); }
      else for (const s of p.series) { const v = s.values[i]; if (v != null) mx = Math.max(mx, v); }
    }
    for (const r of p.refLines ?? []) mx = Math.max(mx, r.value);
    if (p.bands) mx = Math.max(mx, p.bands * 1.2);
    return mx;
  }, [vis0, vis1, stacked, totalAt, p.series, p.refLines, p.bands]);
  const scale = p.yMaxFixed != null ? { max: p.yMaxFixed, step: (p.yMaxFixed - (p.yMin ?? 0)) / 4 } : niceScale(visMax * 1.04);
  const yMax = useTween(scale.max, 260);
  const y0 = p.yMin ?? 0;
  const plotH = H - TOP - XLAB;
  const Y = (v: number) => TOP + plotH - ((v - y0) / Math.max(1e-9, yMax - y0)) * plotH;
  const W = Math.max(plotW, n * ppd + PAD * 2);
  const X = (i: number) => PAD + (i + 0.5) * ppd;

  // header numbers
  const head = useMemo(() => {
    if (sel != null) return null;
    const vals: number[] = [];
    for (let i = vis0; i <= vis1; i++) { const t = totalAt(i); if (t != null) vals.push(t); }
    const kind = p.summary ?? 'avg';
    const v = !vals.length ? null : kind === 'sum' ? vals.reduce((a, b) => a + b, 0) : kind === 'last' ? vals[vals.length - 1] : vals.reduce((a, b) => a + b, 0) / vals.length;
    return { v, kicker: kind === 'sum' ? 'Total' : kind === 'last' ? 'Latest' : 'Daily average' };
  }, [sel, vis0, vis1, totalAt, p.summary]);

  // x-axis ticks: label every k days so labels stay ≥ 44px apart
  const k = [1, 2, 7, 14, 28].find((s) => s * ppd >= 44) ?? 28;
  const ticks: number[] = [];
  for (let i = n - 1; i >= 0; i -= k) ticks.push(i);

  const presets = [7, 14, 30, 90].filter((d) => d <= n);
  if (n > 7 && !presets.includes(n)) presets.push(n);          // "All" when history is longer than the last preset
  const presetOn = (d: number) => ppd > 0 && Math.abs(clamp((plotW - PAD * 2) / Math.min(d, n)) - ppd) / ppd < 0.04;

  const pick = (clientX: number) => {
    const el = sc.current; if (!el || ppd <= 0) return null;
    const r = el.getBoundingClientRect();
    const i = Math.floor((clientX - r.left + el.scrollLeft - PAD) / ppd);
    return i >= 0 && i < n ? i : null;
  };
  const onKey = (e: KeyboardEvent) => {
    const base = sel ?? vis1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const i = Math.max(0, Math.min(n - 1, base + (e.key === 'ArrowLeft' ? -1 : 1)));
      setSel(i);
      const el = sc.current;
      if (el) { const x = X(i); if (x < el.scrollLeft + ppd) el.scrollLeft = x - ppd * 2; else if (x > el.scrollLeft + plotW - ppd) el.scrollLeft = x - plotW + ppd * 2; }
    } else if (e.key === '+' || e.key === '=') { e.preventDefault(); animateTo(ppd * 1.6); }
    else if (e.key === '-') { e.preventDefault(); animateTo(ppd / 1.6); }
    else if (e.key === 'Escape') setSel(null);
  };

  // ---- drawing -------------------------------------------------------------
  const bw = Math.min(ppd * 0.62, 28);
  const lineAlpha = 1 - m, barAlpha = Math.min(1, m * 1.4);
  const allOk = (i: number) => p.series.every((s) => s.values[i] != null);
  const segs = runs(n, allOk);
  const fmtTick = p.tick ?? p.format;
  const yTicks: number[] = [];
  for (let v = y0; v <= scale.max + 1e-9; v += scale.step) yTicks.push(v);

  const sv = sel != null && sel < n ? { day: p.days[sel], total: totalAt(sel) } : null;
  const multi = p.series.length > 1;

  return (
    <div className="tc" ref={wrap}>
      <div className="tc-top">
        <div className="tc-head" aria-live="polite">
          <div className="tc-kicker">{sv ? dlabel(sv.day) : head?.kicker}</div>
          <div className="tc-big">
            {sv ? (sv.total == null ? <span className="tc-none">No records</span> : p.format(sv.total)) : head?.v == null ? <span className="tc-none">No records</span> : p.format(head.v)}
            {p.unit && (sv ? sv.total != null : head?.v != null) && <span className="tc-unit">{p.unit}</span>}
          </div>
          <div className="tc-sub">
            {sv ? (
              <span className="tc-break">
                {multi && p.series.map((s) => s.values[sel!] != null && <span key={s.key}><i style={{ background: css(s.color) }} />{s.label} {p.format(s.values[sel!] as number)}</span>)}
                {p.overlay && p.overlay.values[sel!] != null && <span><i style={{ background: css(p.overlay.color) }} />{p.overlay.label} {p.overlay.format(p.overlay.values[sel!] as number)}</span>}
              </span>
            ) : n ? `${dshort(p.days[vis0])} – ${dshort(p.days[vis1])}` : ''}
          </div>
        </div>
        <div className="seg tc-seg" role="group" aria-label={`${p.label} range`}>
          {presets.map((d) => <button key={d} aria-pressed={presetOn(d)} onClick={() => animateTo((plotW - PAD * 2) / Math.min(d, n))}>{[7, 14, 30, 90].includes(d) ? `${d}D` : 'All'}</button>)}
        </div>
      </div>

      <div className="tc-body" ref={body} style={{ height: H }}>
        <div ref={sc} className={`tc-scroll${scroll > 2 ? ' fade-l' : ''}`} style={{ width: plotW }} onScroll={onScroll}
          tabIndex={0} role="img" aria-label={`${p.label}. ${n} days. Use arrow keys to inspect days, plus and minus to zoom.`} onKeyDown={onKey}
          onPointerMove={(e) => { if (e.pointerType === 'mouse') setSel(pick(e.clientX)); }}
          onPointerLeave={(e) => { if (e.pointerType === 'mouse') setSel(null); }}
          onClick={(e) => { if ((e.nativeEvent as PointerEvent).pointerType !== 'mouse') { const i = pick(e.clientX); setSel(i === sel ? null : i); } }}>
          {plotW > 0 && ppd > 0 && (
            <svg width={W} height={H} className="tc-svg" aria-hidden="true">
              {p.bands && BAND_ZONES.map(([lo, hi, c]) => {
                const t = Math.max(TOP, Y(Math.min(hi * p.bands!, yMax))), b = Math.min(TOP + plotH, Y(lo * p.bands!));
                return b > t ? <rect key={c} x={0} y={t} width={W} height={b - t} style={{ fill: `var(${c})` }} opacity={0.1} /> : null;
              })}
              {yTicks.map((v) => <line key={v} x1={0} x2={W} y1={Y(v)} y2={Y(v)} className={v === y0 ? 'tc-base' : 'tc-grid'} />)}

              {/* lines / areas */}
              {lineAlpha > 0.01 && segs.map((run, ri) => {
                const g = <g key={ri} opacity={lineAlpha}>{p.series.map((s, si) => {
                  const top = run.map((i): [number, number] => [X(i), Y(cum[si][i] as number)]);
                  const below = stacked && si > 0 ? run.slice().reverse().map((i): [number, number] => [X(i), Y(cum[si - 1][i] as number)])
                    : [[X(run[run.length - 1]), Y(y0)], [X(run[0]), Y(y0)]] as [number, number][];
                  const areaD = monotone(top) + (stacked && si > 0 ? monotone(below, true) : `L${below[0][0]},${below[0][1]}L${below[1][0]},${below[1][1]}`) + 'Z';
                  return <g key={s.key}>
                    {(stacked || p.series.length === 1) && <path d={areaD} style={{ fill: css(s.color) }} opacity={stacked ? 0.22 : 0.14} />}
                    <path d={monotone(top)} fill="none" style={{ stroke: css(s.color) }} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
                  </g>;
                })}</g>;
                return g;
              })}
              {lineAlpha > 0.01 && segs.map((run) => run.length === 1 ? p.series.map((s, si) => <circle key={s.key + run[0]} cx={X(run[0])} cy={Y(cum[si][run[0]] as number)} r={2.5} style={{ fill: css(s.color) }} opacity={lineAlpha} />) : null)}

              {/* bars: collapse onto the line at m=0, grow downwards to full height at m=1 */}
              {barAlpha > 0.01 && p.days.map((_, i) => {
                const t = totalAt(i); if (t == null) return null;
                const topV = stacked ? t : null;
                return <g key={i} opacity={barAlpha * (sel != null && sel !== i ? 0.4 : 1)}>
                  {p.series.map((s, si) => {
                    const v = s.values[i]; if (v == null || v === 0) return null;
                    const hi = cum[si][i] as number, lo = stacked && si > 0 ? (cum[si - 1][i] ?? 0) : y0;
                    const anchor = Y(topV ?? hi);
                    const yHi = anchor + (Y(hi) - anchor) * m, yLo = anchor + (Y(lo) - anchor) * m;
                    const w = stacked ? bw : bw / p.series.length, x = stacked ? X(i) - bw / 2 : X(i) - bw / 2 + si * w;
                    const h = Math.max(0, yLo - yHi), isTop = !stacked || si === p.series.length - 1 || p.series.slice(si + 1).every((q) => !q.values[i]);
                    const r = isTop ? Math.min(4, w / 2.5, h) : 0;
                    return <path key={s.key} style={{ fill: css(s.color) }}
                      d={`M${x},${yLo}V${yHi + r}Q${x},${yHi} ${x + r},${yHi}H${x + w - r}Q${x + w},${yHi} ${x + w},${yHi + r}V${yLo}Z`} />;
                  })}
                </g>;
              })}

              {(p.refLines ?? []).map((r) => <line key={r.label} x1={0} x2={W} y1={Y(r.value)} y2={Y(r.value)} className="tc-ref" style={r.color ? { stroke: css(r.color) } : undefined} />)}

              {p.overlay && (() => {
                const o = p.overlay, OY = (v: number) => TOP + plotH - ((Math.min(o.max, Math.max(o.min, v)) - o.min) / (o.max - o.min)) * plotH;
                return runs(n, (i) => o.values[i] != null).map((run, ri) => <g key={ri}>
                  <path d={monotone(run.map((i) => [X(i), OY(o.values[i] as number)]))} fill="none" style={{ stroke: css(o.color) }} strokeWidth={2} />
                  {m > 0.3 && run.map((i) => <circle key={i} cx={X(i)} cy={OY(o.values[i] as number)} r={2.6 * m} style={{ fill: 'var(--surface)', stroke: css(o.color) }} strokeWidth={1.6} />)}
                </g>);
              })()}

              {sel != null && <g>
                <line x1={X(sel)} x2={X(sel)} y1={TOP - 4} y2={TOP + plotH} className="tc-cursor" />
                {lineAlpha > 0.3 && p.series.map((s, si) => cum[si][sel] != null && <circle key={s.key} cx={X(sel)} cy={Y(cum[si][sel] as number)} r={4.5} style={{ fill: css(s.color), stroke: 'var(--surface)' }} strokeWidth={2} />)}
              </g>}

              {ticks.map((i) => {
                const d = p.days[i], day = Number(d.slice(8));
                const showMonth = i === ticks[ticks.length - 1] || day <= k;
                return <text key={i} x={X(i)} y={H - 7} textAnchor="middle" className={`tc-x${i === sel ? ' on' : ''}`}>{showMonth ? dshort(d) : day}</text>;
              })}
            </svg>
          )}
        </div>
        <div className="tc-axis" style={{ width: AXIS_W }} aria-hidden="true">
          {plotW > 0 && yTicks.map((v) => <span key={v} style={{ top: Y(v) - 7 }}>{fmtTick(v)}</span>)}
        </div>
      </div>

      <div className="tc-foot">
        <div className="legend">
          {p.series.map((s) => <span key={s.key}><i style={{ background: css(s.color) }} />{s.label}</span>)}
          {p.overlay && <span><i className="ln" style={{ background: css(p.overlay.color) }} />{p.overlay.label} <span className="tc-scale">({p.overlay.format(p.overlay.min)}–{p.overlay.format(p.overlay.max)} scale)</span></span>}
          {(p.refLines ?? []).map((r) => <span key={r.label}><i className="ln dash" style={{ borderColor: css(r.color ?? '--muted') }} />{r.label}</span>)}
        </div>
        <span className="tc-hint">{coarse() ? 'Pinch to zoom · swipe for earlier days · tap a day' : 'Ctrl/⌘ + scroll to zoom · scroll sideways for earlier days'}</span>
      </div>
    </div>
  );
}
