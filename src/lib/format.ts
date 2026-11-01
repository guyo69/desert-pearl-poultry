// Dates are business days as 'YYYY-MM-DD' strings (Nairobi time, set by the server).
const W = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toDate = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const addDays = (s: string, n: number) => { const t = toDate(s); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 864e5);
export function range(a: string, b: string): string[] { const out: string[] = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; }
export const dlabel = (s: string) => { const t = toDate(s); return `${W[t.getUTCDay()]} ${t.getUTCDate()} ${MO[t.getUTCMonth()]}`; };
export const dshort = (s: string) => { const t = toDate(s); return `${t.getUTCDate()} ${MO[t.getUTCMonth()]}`; };
export const dnum = (s: string) => s.split('-').reverse().join('/');
export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' });

export const n0 = (v: number) => (Number.isFinite(v) ? (Math.round(v) || 0).toLocaleString('en-KE') : '–');
export const kes = (v: number) => (!Number.isFinite(v) ? '–' : (Math.round(v) < 0 ? '−' : '') + 'KES ' + Math.abs(Math.round(v)).toLocaleString('en-KE'));
export const kesS = (v: number) => {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  return s + (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'k' : Math.round(a).toLocaleString('en-KE'));
};
export const pct = (v: number, dp = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(dp)}%` : '–');
/** Eggs as trays (of 30) and pieces: 95 -> "3 tr 5 pc". */
export function eggs(p: number): string {
  p = Math.round(p); const s = p < 0 ? '−' : ''; p = Math.abs(p);
  const t = Math.floor(p / 30), r = p % 30;
  return !t ? `${s}${r} pc` : `${s}${t} tr${r ? ` ${r} pc` : ''}`;
}
export const litres = (v: number) => `${n0(v)} L`;
