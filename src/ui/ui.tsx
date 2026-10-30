// Bottom-sheet forms, info panels and toasts, shared by every screen.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons';

export type V = Record<string, any>;
export type Field =
  | { type: 'num'; id: string; label: string; suffix?: string; hint?: string; step?: number; def?: number | '' }
  | { type: 'eggs'; id: string; label: string; hint?: string; def?: number }
  | { type: 'select'; id: string; label: string; options: [string, string][]; def?: string }
  | { type: 'text'; id: string; label: string; placeholder?: string; def?: string }
  | { type: 'date'; id: string; label: string; def?: string }
  | { type: 'pair'; fields: Field[] }
  | { type: 'note'; text: ReactNode };

export interface FormSpec {
  title: string;
  fields: Field[];
  submit?: string;
  intro?: ReactNode;
  calc?: (v: V) => ReactNode;
  buttons?: (v: V, set: (patch: V) => void) => ReactNode;
  /** Return a toast message on success; throw to show an error in the form. */
  onSubmit: (v: V) => Promise<string | void>;
}

interface UI {
  openForm: (f: FormSpec) => void;
  openPanel: (title: string, body: ReactNode) => void;
  close: () => void;
  toast: (msg: string) => void;
}
const Ctx = createContext<UI>(null as unknown as UI);
export const useUI = () => useContext(Ctx);

function initial(fields: Field[], v: V = {}): V {
  for (const f of fields) {
    if (f.type === 'pair') initial(f.fields, v);
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
    if (f.type === 'pair') walk(f.fields);
    else if (f.type === 'num' || f.type === 'eggs') out[f.id] = raw[f.id] === '' || raw[f.id] == null ? 0 : Number(raw[f.id]);
  });
  walk(fields);
  return out;
}

function EggsInput({ f, v, set }: { f: Extract<Field, { type: 'eggs' }>; v: V; set: (p: V) => void }) {
  const p = v[f.id] === '' ? 0 : Number(v[f.id]);
  const [t, setT] = useState(p ? String(Math.floor(p / 30)) : '');
  const [r, setR] = useState(p % 30 ? String(p % 30) : '');
  const upd = (tt: string, rr: string) => { setT(tt); setR(rr); set({ [f.id]: (Number(tt) || 0) * 30 + (Number(rr) || 0) }); };
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

function FieldView({ f, v, set }: { f: Field; v: V; set: (p: V) => void }) {
  switch (f.type) {
    case 'pair': return <div className="pair">{f.fields.map((x, i) => <FieldView key={i} f={x} v={v} set={set} />)}</div>;
    case 'note': return <div className="calc">{f.text}</div>;
    case 'eggs': return <EggsInput f={f} v={v} set={set} />;
    case 'num': return (
      <label className="fld"><span>{f.label}</span>
        <div className="inp"><input id={`f_${f.id}`} type="number" inputMode="decimal" min={0} step={f.step ?? 'any'} value={v[f.id]} onChange={(e) => set({ [f.id]: e.target.value })} />{f.suffix && <em>{f.suffix}</em>}</div>
        {f.hint && <small>{f.hint}</small>}</label>);
    case 'select': return (
      <label className="fld"><span>{f.label}</span>
        <div className="inp"><select id={`f_${f.id}`} value={v[f.id]} onChange={(e) => set({ [f.id]: e.target.value })}>{f.options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div></label>);
    case 'text': return (
      <label className="fld"><span>{f.label}</span>
        <div className="inp"><input id={`f_${f.id}`} type="text" value={v[f.id]} placeholder={f.placeholder} onChange={(e) => set({ [f.id]: e.target.value })} /></div></label>);
    case 'date': return (
      <label className="fld"><span>{f.label}</span>
        <div className="inp"><input id={`f_${f.id}`} type="date" value={v[f.id]} onChange={(e) => set({ [f.id]: e.target.value })} /></div></label>);
  }
}

function FormSheet({ spec, onDone, onClose }: { spec: FormSpec; onDone: (msg?: string) => void; onClose: () => void }) {
  const [raw, setRaw] = useState<V>(() => initial(spec.fields));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = useCallback((p: V) => setRaw((r) => ({ ...r, ...p })), []);
  const v = values(spec.fields, raw);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (busy) return;
    setBusy(true); setErr('');
    try { const msg = await spec.onSubmit(v); onDone(msg || 'Saved.'); }
    catch (x) { setErr(x instanceof Error ? x.message : String(x)); }
    finally { setBusy(false); }
  };
  return (
    <form className="sheet" onSubmit={submit} noValidate>
      <div className="sheet-h"><h2>{spec.title}</h2><button type="button" className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
      <div className="sheet-b">
        {spec.intro}
        {spec.fields.map((f, i) => <FieldView key={i} f={f} v={raw} set={set} />)}
        {spec.calc && <div className="calc">{spec.calc(v)}</div>}
        {spec.buttons && <div className="row-btns">{spec.buttons(v, set)}</div>}
      </div>
      <div className="sheet-f">
        {err && <span className="err" role="alert">{err}</span>}
        <button type="button" className="btn alt" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : spec.submit ?? 'Save'}</button>
      </div>
    </form>
  );
}

export function UIProvider({ children, afterSave }: { children: ReactNode; afterSave: () => void }) {
  const [form, setForm] = useState<FormSpec | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [panel, setPanel] = useState<{ title: string; body: ReactNode } | null>(null);
  const [msg, setMsg] = useState('');
  const timer = useRef<number>();
  const toast = useCallback((m: string) => { setMsg(m); clearTimeout(timer.current); timer.current = window.setTimeout(() => setMsg(''), 4500); }, []);
  const close = useCallback(() => { setForm(null); setPanel(null); }, []);
  const ui: UI = {
    openForm: (f) => { setPanel(null); setForm(f); setFormKey((k) => k + 1); },
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
          {form && <FormSheet key={formKey} spec={form} onClose={close} onDone={(m) => { close(); afterSave(); if (m) toast(m); }} />}
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
