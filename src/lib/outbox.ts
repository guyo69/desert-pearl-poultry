// Working with no connection (12 Nov 2026), for field staff.
// * Entries: an everyday entry made with no connection is kept on the phone
//   (IndexedDB) with a key made here, and sent when the connection is back.
//   The server records each key once (rpc_queued), so a retry never doubles it.
// * Figures: the last dashboard is kept on the phone so the screens still open
//   offline. It is removed at sign-out, and only kept for field staff.
// Sending happens from the page (on reconnect, on return to the screen and
// every few seconds while something waits); Background Sync is not on iPhones.

export interface Entry {
  key: string;
  user: string;            // staff id: an entry is only ever sent by the person who made it
  fn: string; args: Record<string, unknown>;
  label: string;           // the form's title, for the waiting list
  made_at: string;         // ISO time it was made on the phone
  status: 'waiting' | 'held' | 'failed';
  error?: string;
  force?: boolean;         // an entry from an earlier day the person chose to send for today
}

/** The everyday entries that may wait on the phone (the same list as the server's _queueable()). */
export const QUEUEABLE = new Set(['rpc_collect_eggs', 'rpc_house_day', 'rpc_mark_day', 'rpc_water', 'rpc_mortality', 'rpc_confirm_issue',
  'rpc_dispatch_many', 'rpc_receive_delivery', 'rpc_issue_out', 'rpc_breakage', 'rpc_sale_with_credit', 'rpc_credit_paid', 'rpc_shop_day',
  'rpc_expense', 'rpc_move_money', 'rpc_count_stock', 'rpc_cash_count', 'rpc_store', 'rpc_mill']);

/** The business day (Nairobi, UTC+3 all year) of a moment. */
export const nairobiDay = (t: string | number | Date) => new Date(new Date(t).getTime() + 3 * 3600e3).toISOString().slice(0, 10);
/** An entry from an earlier day is not sent on its own: the server would record it for today. */
export const heldBack = (e: Entry, now: Date = new Date()) => !e.force && nairobiDay(e.made_at) < nairobiDay(now);
/** How long the figures kept on the phone stay usable. */
export const CACHE_HOURS = 36;

export const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));

// ---------------------------------------------------------------- storage
const DB = 'dpv-offline';
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbp) dbp = new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('ops')) d.createObjectStore('ops', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'user' });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => { dbp = null; bad(r.error); };
  });
  return dbp;
}
async function run<T>(store: 'ops' | 'cache', mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const d = await db();
  return new Promise<T>((ok, bad) => {
    const t = d.transaction(store, mode), req = f(t.objectStore(store));
    t.oncomplete = () => ok((req ? req.result : undefined) as T);
    t.onerror = () => bad(t.error); t.onabort = () => bad(t.error);
  });
}
export const OUTBOX_EVENT = 'dpv-outbox';
const changed = () => dispatchEvent(new Event(OUTBOX_EVENT));

export async function keep(e: Entry) { await run('ops', 'readwrite', (s) => s.put(e)); changed(); }
export async function entries(user?: string): Promise<Entry[]> {
  try {
    const all = await run<Entry[]>('ops', 'readonly', (s) => s.getAll());
    return (all ?? []).filter((e) => !user || e.user === user).sort((a, b) => a.made_at.localeCompare(b.made_at));
  } catch { return []; }
}
export async function drop(key: string) { await run('ops', 'readwrite', (s) => s.delete(key)); changed(); }
export async function update(key: string, patch: Partial<Entry>) {
  const d = await db();
  await new Promise<void>((ok, bad) => {
    const t = d.transaction('ops', 'readwrite'), s = t.objectStore('ops'), g = s.get(key);
    g.onsuccess = () => { if (g.result) s.put({ ...g.result, ...patch }); };
    t.oncomplete = () => ok(); t.onerror = () => bad(t.error);
  });
  changed();
}

export interface Cached<U, D> { user: string; who: U; data: D; at: number }
export async function saveFigures<U, D>(user: string, who: U, data: D) {
  try { await run('cache', 'readwrite', (s) => s.put({ user, who, data, at: Date.now() })); } catch { /* storage full or blocked: work online only */ }
}
/** The figures kept for a person (or the most recent for anyone), if still fresh enough. */
export async function readFigures<U, D>(user?: string): Promise<Cached<U, D> | null> {
  try {
    const all = await run<Cached<U, D>[]>('cache', 'readonly', (s) => s.getAll());
    const fresh = (all ?? []).filter((c) => (!user || c.user === user) && Date.now() - c.at < CACHE_HOURS * 3600e3).sort((a, b) => b.at - a.at);
    return fresh[0] ?? null;
  } catch { return null; }
}
export async function forgetFigures() { try { await run('cache', 'readwrite', (s) => s.clear()); } catch { /* nothing kept */ } }
