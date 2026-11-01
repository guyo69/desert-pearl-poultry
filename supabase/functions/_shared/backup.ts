// Weekly backup of the farm records to private Supabase Storage.
//
// One gzipped JSON file per run in the private bucket `backups`, newest 12
// kept (about three months). Sign-in secrets, two-step keys, rate-limit
// counters and phone push addresses are left out: a restore needs staff to
// set their passwords again, which is the safe default.
// scripts/backup-to-sql.mjs turns a file into SQL for a restore.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export const BUCKET = 'backups';
export const KEEP = 12;
/** Parents before children, so the SQL restore can run top to bottom. */
export const TABLES: [string, string][] = [
  ['settings', 'id'], ['locations', 'id'], ['accounts', 'id'], ['houses', 'id'], ['staff', 'id'], ['medicines', 'id'], ['schedule', 'id'],
  ['egg_collections', 'id'], ['mortality', 'id'], ['feed_moves', 'id'], ['water_logs', 'id'], ['med_moves', 'id'],
  ['transfers', 'id'], ['sales', 'id'], ['breakages', 'id'], ['stock_counts', 'id'], ['stock_adj', 'id'],
  ['cash_counts', 'id'], ['money_moves', 'id'], ['notifications', 'id'], ['notification_reads', 'notification_id'],
];
const PAGE = 1000;

async function dumpTable(db: SupabaseClient, table: string, order: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select('*').order(order).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function ensureBucket(db: SupabaseClient) {
  const { data } = await db.storage.getBucket(BUCKET);
  if (data) return;
  const { error } = await db.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 50 * 1024 * 1024 });
  if (error && !/exists/i.test(error.message)) throw new Error(`bucket: ${error.message}`);
}

export interface BackupFile { name: string; size: number; created_at: string }

export async function listBackups(db: SupabaseClient): Promise<BackupFile[]> {
  await ensureBucket(db);
  const { data, error } = await db.storage.from(BUCKET).list('', { limit: 100, sortBy: { column: 'name', order: 'desc' } });
  if (error) throw new Error(error.message);
  return (data ?? []).filter((f) => f.name.endsWith('.json.gz'))
    .map((f) => ({ name: f.name, size: Number((f.metadata as { size?: number } | null)?.size ?? 0), created_at: f.created_at ?? '' }));
}

export async function runBackup(db: SupabaseClient, by: string): Promise<{ name: string; size: number; rows: number; removed: number }> {
  await ensureBucket(db);
  const tables: Record<string, unknown[]> = {};
  let rows = 0;
  for (const [t, order] of TABLES) { tables[t] = await dumpTable(db, t, order); rows += tables[t].length; }
  const at = new Date();
  const body = JSON.stringify({ app: 'desert-pearl-poultry', format: 1, created_at: at.toISOString(), by, rows, tables });
  const gz = await gzip(body);
  const name = `dpv-${at.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json.gz`;
  const { error } = await db.storage.from(BUCKET).upload(name, gz, { contentType: 'application/gzip', upsert: true });
  if (error) throw new Error(`upload: ${error.message}`);
  const all = await listBackups(db);
  const old = all.slice(KEEP).map((f) => f.name);
  if (old.length) await db.storage.from(BUCKET).remove(old);
  return { name, size: gz.length, rows, removed: old.length };
}

export async function downloadUrl(db: SupabaseClient, name: string): Promise<string> {
  if (!/^dpv-[0-9-]+\.json\.gz$/.test(name)) throw new Error('Unknown backup.');
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(name, 300, { download: name });
  if (error || !data) throw new Error(error?.message ?? 'Could not prepare the download.');
  return data.signedUrl;
}
