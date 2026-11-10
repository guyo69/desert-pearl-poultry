// Bottom-sheet forms, info panels and toasts, shared by every screen.
import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons';

export type V = Record<string, any>;
export type Field =
  | { type: 'num'; id: string; label: string; suffix?: string; hint?: string; step?: number; def?: number | '' }
  | { type: 'eggs'; id: string; label: string; hint?: string; def?: number }
  | { type: 'select'; id: string; label: string; options: [string, string][]; def?: string }
  | { type: 'text'; id: string; label: string; placeholder?: string; def?: string }
  | { type: 'date'; id: string; label: string; def?: string; min?: string; max?: string; hint?: string }
  | { type: 'pair'; fields: Field[] }
  /** Fields shown only while show(values) is true (e.g. "new item" details). */
  | { type: 'group'; show: (v: V) => boolean; fields: Field[] }
  | { type: 'note'; text: ReactNode }
  /** Several questions that belong on one page when the form goes step by step, under a heading;
   *  `live` shows the form's running total there, `quick` its quick-fill buttons. */
  | { type: 'step'; title: string; fields: Field[]; live?: boolean; quick?: boolean };

export interface FormSpec {
  title: string;
  fields: Field[];
  submit?: string;
  /** false keeps the form on one page even for field staff (long sheets, tables of rows) */
  steps?: boolean;
  /** offer "Add another" after saving (sales, collections, deliveries) */
  again?: boolean;
  intro?: ReactNode;
  calc?: (v: V) => ReactNode;
  buttons?: (v: V, set: (patch: V) => void) => ReactNode;
  /** Return a toast message on success; throw to show an error in the form. */
  onSubmit: (v: V) => Promise<string | void>;
}

interface UI {
  openForm: (f: FormSpec) => void;
  /** forms go one question at a time, with a check page and a tick after saving */
  stepped: boolean;
  setStepped: (on: boolean) => void;
  openPanel: (title: string, body: ReactNode) => void;
  close: () => void;
  toast: (msg: string) => void;
}
const Ctx = createContext<UI>(null as unknown as UI);
export const useUI = () => useContext(Ctx);

function initial(fields: Field[], v: V = {}): V {
  for (const f of fields) {
    if (f.type === 'pair' || f.type === 'group' || f.type === 'step') initial(f.fields, v);
    else if (f.type === 'eggs' || f.type === 'num') v[f.id] = f.def ?? '';
    else if (f.type === 'select') v[f.id] = f.def ?? f.options[0]?.[0] ?? '';
    else if (f.type === 'text' || f.type === 'date') v[f.id] = f.def ?? '';
  }
  return v;
}
/** Form values with empty numbers read as 0. */
export function values(fields: Field[], raw: V): V {
  const out: V = { ...raw };
  const walk = (fs: Field[]) => fs.forEach((f) => {
    if (f.type === 'pair' || f.type === 'group' || f.type === 'step') walk(f.fields);
    else if (f.type === 'num' || f.type === 'eggs') out[f.id] = raw[f.id] === '' || raw[f.id] == null ? 0 : Number(raw[f.id]);
  });
  walk(fields);
  return out;
}

/** A number box with − and + either side, for counts typed on a phone. */
function Stepper({ id, value, onChange, label, unit, step = 1 }: { id: string; value: string; onChange: (v: string) => void; label: string; unit?: string; step?: number }) {
  const n = Number(value) || 0;
  const bump = (d: number) => onChange(String(Math.max(0, Math.round((n + d) * 1000) / 1000)));
  return <div className="inp stepper">
    <button type="button" className="stp" aria-label={`${label}: one less`} onClick={() => bump(-step)} disabled={n <= 0}><Icon name="minus" /></button>
    <input id={id} type="number" inputMode="numeric" min={0} placeholder="0" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} />
    {unit && <em>{unit}</em>}
    <button type="button" className="stp" aria-label={`${label}: one more`} onClick={() => bump(step)}><Icon name="plus" /></button>
  </div>;
}

function EggsInput({ f, v, set, big }: { f: Extract<Field, { type: 'eggs' }>; v: V; set: (p: V) => void; big?: boolean }) {
  const p = v[f.id] === '' ? 0 : Number(v[f.id]);
  const [t, setT] = useState(p ? String(Math.floor(p / 30)) : '');
  const [r, setR] = useState(p % 30 ? String(p % 30) : '');
  const upd = (tt: string, rr: string) => { setT(tt); setR(rr); set({ [f.id]: (Number(tt) || 0) * 30 + (Number(rr) || 0) }); };
  if (big) return (
    <div className="fld"><span>{f.label}</span>
      <Stepper id={`f_${f.id}_t`} value={t} label={`${f.label}, trays`} unit="trays" onChange={(x) => upd(x, r)} />
      <Stepper id={`f_${f.id}_p`} value={r} label={`${f.label}, pieces`} unit="pieces" onChange={(x) => upd(t, x)} />
      <small>{f.hint ?? 'A tray holds 30 eggs.'}</small>
    </div>);
  return (
    <div className="fld"><span>{f.label}</span>
      <div className="pair">
        <div className="inp"><input id={`f_${f.id}_t`} type="number" inputMode="numeric" min={0} placeholder="0" value={t} aria-label={`${f.label}, trays`} onChange={(e) => upd(e.target.value, r)} /><em>trays</em></div>
        <div className="inp"><input id={`f_${f.id}_p`} type="number" inputMode="numeric" min={0} placeholder="0" value={r} aria-label={`${f.label}, pieces`} onChange={(e) => upd(t, e.target.value)} /><em>pieces</em></div>
      </div>
      {f.hint && <small>{f.hint}</small>}
    </div>
  );
}

/** Counts get − and + buttons in step-by-step forms; money, weights and readings do not. */
const COUNTED = new Set(['pc', 'bags', 'birds', 'hens', 'trays', 'pieces', 'doses', 'items']);

function FieldView({ f, v, set, big }: { f: Field; v: V; set: (p: V) => void; big?: boolean }) {
  switch (f.type) {
    case 'group': return f.show(v) ? <>{f.fields.map((x, i) => <FieldView key={i} f={x} v={v} set={set} big={big} />)}</> : null;
    case 'step': return <>{big && <h3 className="step-q">{f.title}</h3>}{f.fields.map((x, i) => <FieldView key={i} f={x} v={v} set={set} big={big} />)}</>;
    case 'pair': return <div className={big ? 'pair-big' : 'pair'}>{f.fields.map((x, i) => <FieldView key={i} f={x} v={v} set={set} big={big} />)}</div>;
    case 'note': return <div className="calc">{f.text}</div>;
    case 'eggs': return <EggsInput f={f} v={v} set={set} big={big} />;
    case 'num': return big && f.suffix && COUNTED.has(f.suffix) ? (
      <div className="fld"><span>{f.label}</span>
        <Stepper id={`f_${f.id}`} value={v[f.id]} label={f.label} unit={f.suffix} step={f.step} onChange={(x) => set({ [f.id]: x })} />
        {f.hint && <small>{f.hint}</small>}</div>) : (
      <label className="fld"><span>{f.label}</span>
        <div className="inp"><input id={`f_${f.id}`} type="number" inputMode="decimal" min={0} step={f.step ?? 'any'} value={v[f.id]} onChange={(e) => set({ [f.id]: e.target.value })} />{f.suffix && <em>{f.suffix}</em>}</div>
        {f.hint && <small>{f.hint}</small>}</label>);
    case 'select': return big && f.options.length <= 5 ? (
      <fieldset className="fld choices"><legend>{f.label}</legend>
        {f.options.map(([k, l]) => <button key={k} type="button" id={k === v[f.id] ? `f_${f.id}` : undefined} className="choice" aria-pressed={v[f.id] === k} onClick={() => set({ [f.id]: k })}>
          <i aria-hidden="true">{v[f.id] === k && <Icon name="check" />}</i>{l}</button>)}</fieldset>) : (
      <label className="fld"><span>{f.label}</span>
        <div className="inp"><select id={`f_${f.id}`} value={v[f.id]} onChange={(e) => set({ [f.id]: e.target.value })}>{f.options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div></label>);
    case 'text': return (
      <label className="fld"><span>{f.label}</span>
        <div className="inp"><input id={`f_${f.id}`} type="text" value={v[f.id]} placeholder={f.placeholder} onChange={(e) => set({ [f.id]: e.target.value })} /></div></label>);
    case 'date': return (
      <label className="fld"><span>{f.label}</span>
        <div className="inp"><input id={`f_${f.id}`} type="date" value={v[f.id]} min={f.min} max={f.max} onChange={(e) => set({ [f.id]: e.target.value })} /></div>
        {f.hint && <small>{f.hint}</small>}</label>);
  }
}

// ---------------------------------------------------------------- step by step
/** One question on its own page: a field (or a pair), with any note that leads into it. */
interface Page { key: string; fields: Field[]; live?: boolean; quick?: boolean }
const fieldKey = (f: Field): string => (f.type === 'pair' ? f.fields.map(fieldKey).join('+') : f.type === 'step' ? `step:${f.title}` : 'id' in f ? f.id : '');
/** The pages for the answers so far: groups open up as their condition is met. */
export function pagesOf(fields: Field[], v: V): Page[] {
  const out: Page[] = []; let lead: Field[] = [];
  const walk = (fs: Field[]) => { for (const f of fs) {
    if (f.type === 'group') { if (f.show(v)) walk(f.fields); }
    else if (f.type === 'note') lead.push(f);
    else { out.push({ key: fieldKey(f), fields: [...lead, f], ...(f.type === 'step' ? { live: f.live, quick: f.quick } : {}) }); lead = []; }
  } };
  walk(fields);
  if (lead.length) { if (out.length) out[out.length - 1].fields.push(...lead); else out.push({ key: 'note', fields: lead }); }
  return out;
}
/** At most this many questions go one at a time; longer sheets stay on one page. */
const MAX_STEPS = 8;

/** The answers in plain words, for the check page. */
function answers(fs: Field[], raw: V, v: V): { label: string; text: string; key: string }[] {
  const out: { label: string; text: string; key: string }[] = [];
  const walk = (list: Field[], key?: string) => { for (const f of list) {
    const k = key ?? fieldKey(f);
    if (f.type === 'group') { if (f.show(v)) walk(f.fields); continue; }
    if (f.type === 'pair' || f.type === 'step') { walk(f.fields, k); continue; }
    if (f.type === 'note') continue;
    const r = raw[f.id];
    if (r === '' || r == null) continue;
    let text = String(r);
    if (f.type === 'eggs') { const n = Number(r) || 0; if (!n) continue; const t = Math.floor(n / 30), p = n % 30; text = [t && `${t} tray${t === 1 ? '' : 's'}`, p && `${p} piece${p === 1 ? '' : 's'}`].filter(Boolean).join(' and '); }
    else if (f.type === 'num') { if (Number(r) === 0 && f.suffix !== 'KES') continue; text = f.suffix === 'KES' ? `KES ${Number(r).toLocaleString('en-KE')}` : `${Number(r).toLocaleString('en-KE')}${f.suffix ? ` ${f.suffix}` : ''}`; }
    else if (f.type === 'select') text = f.options.find(([o]) => o === r)?.[1] ?? text;
    else if (f.type === 'date') { const d = new Date(`${r}T00:00:00Z`); text = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
    out.push({ label: f.label, text, key: k });
  } };
  walk(fs);
  return out;
}

function FormSheet({ spec, stepped, onSaved, onDone, onClose, onAgain }: { spec: FormSpec; stepped: boolean; onSaved: () => void; onDone: (msg?: string) => void; onClose: () => void; onAgain: () => void }) {
  const [raw, setRaw] = useState<V>(() => initial(spec.fields));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [cur, setCur] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const set = useCallback((p: V) => setRaw((r) => ({ ...r, ...p })), []);
  const v = values(spec.fields, raw);
  const pages = pagesOf(spec.fields, raw);
  const steps = stepped && spec.steps !== false && pages.length > 1 && pages.length <= MAX_STEPS;
  const last = pages.length;                 // the check page comes after the questions
  const at = Math.min(cur, last);
  useEffect(() => {
    if (!steps) return;
    body.current?.scrollTo({ top: 0 });
    const el = body.current?.querySelector<HTMLElement>('input, select, .choice[aria-pressed="true"], .choice');
    if (el && at < last) el.focus({ preventScroll: true });
  }, [at, steps, last]);
  const save = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const msg = await spec.onSubmit(v);
      if (steps) { setDone(msg || 'Saved.'); onSaved(); } else onDone(msg || 'Saved.');
    } catch (x) { setErr(x instanceof Error ? x.message : String(x)); if (steps) setCur(last); }
    finally { setBusy(false); }
  };
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (steps && at < last) setCur(at + 1); else save(); };

  if (done !== null) return (
    <div className="sheet done" role="dialog" aria-label="Saved">
      <div className="sheet-b done-b">
        <span className="done-tick" aria-hidden="true"><Icon name="check" /></span>
        <h2>Saved</h2>
        <p>{done}</p>
      </div>
      <div className="sheet-f">
        {spec.again && <button type="button" className="btn alt" onClick={onAgain}><Icon name="plus" />Add another</button>}
        <button type="button" className="btn" autoFocus onClick={() => onDone()}>Done</button>
      </div>
    </div>);

  return (
    <form className={`sheet${steps ? ' stepped' : ''}`} onSubmit={submit} noValidate>
      <div className="sheet-h"><h2>{spec.title}</h2><button type="button" className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
      {steps && <div className="steps-bar" aria-hidden="true"><span style={{ transform: `scaleX(${(at + 1) / (last + 1)})` }} /></div>}
      <div className="sheet-b" ref={body}>
        {steps && <small className="step-n">{at < last ? `Question ${at + 1} of ${last}` : 'Check and save'}</small>}
        {(!steps || at === 0) && spec.intro}
        {steps ? (at < last
          ? <div className="step-page" key={pages[at].key}>{pages[at].fields.map((f, i) => f.type === 'step' ? <Fragment key={i}>
                <h3 className="step-q">{f.title}</h3>
                {pages[at].live && spec.calc && <div className="calc">{spec.calc(v)}</div>}
                {pages[at].quick && spec.buttons && <div className="row-btns">{spec.buttons(v, set)}</div>}
                {f.fields.map((x, j) => <FieldView key={j} f={x} v={raw} set={set} big />)}</Fragment>
              : <FieldView key={i} f={f} v={raw} set={set} big />)}</div>
          : <div className="step-page" key="check">
              <dl className="answers">{answers(spec.fields, raw, v).map((a) => <button type="button" key={a.label + a.key} onClick={() => setCur(Math.max(0, pages.findIndex((p) => p.key === a.key)))}>
                <dt>{a.label}</dt><dd>{a.text}</dd><Icon name="back" /></button>)}</dl>
              {spec.calc && <div className="calc">{spec.calc(v)}</div>}
              {spec.buttons && !pages.some((p) => p.quick) && <div className="row-btns">{spec.buttons(v, set)}</div>}
            </div>)
        : <>
          {spec.fields.map((f, i) => <FieldView key={i} f={f} v={raw} set={set} />)}
          {spec.calc && <div className="calc">{spec.calc(v)}</div>}
          {spec.buttons && <div className="row-btns">{spec.buttons(v, set)}</div>}
        </>}
      </div>
      <div className="sheet-f">
        {err && <span className="err" role="alert">{err}</span>}
        {steps && at > 0
          ? <button type="button" className="btn alt" onClick={() => setCur(at - 1)}><Icon name="back" />Back</button>
          : <button type="button" className="btn alt" onClick={onClose}>Cancel</button>}
        <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : steps && at < last ? 'Next' : spec.submit ?? 'Save'}</button>
      </div>
    </form>
  );
}

const MODE = 'dpv-form-mode';
export function UIProvider({ children, afterSave, field }: { children: ReactNode; afterSave: () => void; /** field staff: step by step unless they turn it off */ field: boolean }) {
  const [form, setForm] = useState<FormSpec | null>(null);
  const [mode, setMode] = useState<string | null>(() => { try { return localStorage.getItem(MODE); } catch { return null; } });
  const stepped = mode ? mode === 'steps' : field;
  const setStepped = useCallback((on: boolean) => { setMode(on ? 'steps' : 'all'); try { localStorage.setItem(MODE, on ? 'steps' : 'all'); } catch { /* storage blocked */ } }, []);
  const [formKey, setFormKey] = useState(0);
  const [panel, setPanel] = useState<{ title: string; body: ReactNode } | null>(null);
  const [msg, setMsg] = useState('');
  const timer = useRef<number>();
  const toast = useCallback((m: string) => { setMsg(m); clearTimeout(timer.current); timer.current = window.setTimeout(() => setMsg(''), 4500); }, []);
  const close = useCallback(() => { setForm(null); setPanel(null); }, []);
  const ui: UI = {
    openForm: (f) => { setPanel(null); setForm(f); setFormKey((k) => k + 1); },
    stepped, setStepped,
    openPanel: (title, body) => { setForm(null); setPanel({ title, body }); },
    close, toast,
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, [close]);
  return (
    <Ctx.Provider value={ui}>
      {children}
      {(form || panel) && (
        <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          {form && <FormSheet key={formKey} spec={form} stepped={stepped} onClose={close} onSaved={afterSave}
            onAgain={() => setFormKey((k) => k + 1)} onDone={(m) => { close(); if (m) { afterSave(); toast(m); } }} />}
          {panel && (
            <div className="sheet" role="dialog" aria-label={panel.title}>
              <div className="sheet-h"><h2>{panel.title}</h2><button className="iconbtn" onClick={close} aria-label="Close"><Icon name="x" /></button></div>
              <div className="sheet-b">{panel.body}</div>
            </div>
          )}
        </div>
      )}
      {msg && <div className="toast" role="status">{msg}</div>}
    </Ctx.Provider>
  );
}
