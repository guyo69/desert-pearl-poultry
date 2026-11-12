// Working with no connection: what waits on the phone, and how it is sent.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kept: unknown[] = [];
vi.mock('../src/lib/outbox', async (orig) => {
  const real = await orig<typeof import('../src/lib/outbox')>();
  return { ...real, keep: vi.fn(async (e: unknown) => { kept.push(e); }) };
});
import { heldBack, nairobiDay, QUEUEABLE, type Entry } from '../src/lib/outbox';
import { QueuedError, rpc, setEntryLabel, setOutboxUser } from '../src/lib/api';

describe('the business day', () => {
  it('is the Nairobi date', () => {
    expect(nairobiDay('2026-11-11T20:59:00Z')).toBe('2026-11-11');
    expect(nairobiDay('2026-11-11T21:00:00Z')).toBe('2026-11-12');
  });
  it('holds back entries from an earlier day unless the person says send', () => {
    const e = { made_at: '2026-11-10T15:00:00Z' } as Entry, now = new Date('2026-11-11T06:00:00Z');
    expect(heldBack(e, now)).toBe(true);
    expect(heldBack({ ...e, force: true }, now)).toBe(false);
    expect(heldBack({ ...e, made_at: '2026-11-11T05:00:00Z' }, now)).toBe(false);
  });
});

describe('the list of entries that may wait', () => {
  it('matches the server', () => {
    const sql = readFileSync('supabase/migrations/20261112000026_offline_outbox.sql', 'utf8');
    const server = new Set([...sql.split('_queueable()')[1].split('$$')[1].matchAll(/'(rpc_[a-z_]+)'/g)].map((m) => m[1]));
    expect([...server].sort()).toEqual([...QUEUEABLE].sort());
  });
});

describe('sending an entry', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    kept.length = 0;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', { onLine: true });
    setOutboxUser('u-1'); setEntryLabel('Record sale');
  });
  afterEach(() => { setOutboxUser(null); vi.unstubAllGlobals(); });
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  it('goes through the keyed path for field staff', async () => {
    fetchMock.mockResolvedValue(ok({ diff: 0 }));
    await expect(rpc('rpc_cash_count', { p_loc: 'TUALA', p_counted: 5 })).resolves.toEqual({ diff: 0 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('r=rpc/rpc_queued');
    const body = JSON.parse(init.body);
    expect(body.p_fn).toBe('rpc_cash_count');
    expect(body.p_args).toEqual({ p_loc: 'TUALA', p_counted: 5 });
    expect(body.p_key).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('leaves other calls alone', async () => {
    fetchMock.mockResolvedValue(ok([]));
    await rpc('rpc_tips', {});
    expect(fetchMock.mock.calls[0][0]).toContain('r=rpc/rpc_tips');
  });
  it('keeps the entry on the phone when there is no connection', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const e = await rpc('rpc_sale_with_credit', { p_loc: 'TUALA' }).catch((x) => x);
    expect(e).toBeInstanceOf(QueuedError);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ user: 'u-1', fn: 'rpc_sale_with_credit', label: 'Record sale', status: 'waiting' });
  });
  it('keeps it without trying when the phone knows it is offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await expect(rpc('rpc_collect_eggs', {})).rejects.toBeInstanceOf(QueuedError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kept).toHaveLength(1);
  });
  it('shows a refusal at once instead of keeping it', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'Payments must equal the amount due' }) });
    await expect(rpc('rpc_sale_with_credit', {})).rejects.toThrow('must equal');
    expect(kept).toHaveLength(0);
  });
});
