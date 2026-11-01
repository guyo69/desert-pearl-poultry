#!/usr/bin/env node
// Turns a Desert Pearl backup (dpv-....json.gz, downloaded under Settings →
// Backups) into SQL that restores the farm records into a database that has
// the app's migrations applied.
//
//   node scripts/backup-to-sql.mjs dpv-2026-11-08-20-00.json.gz > restore.sql
//   psql "<connection string>" -v ON_ERROR_STOP=1 -f restore.sql
//
// The SQL runs in one transaction: it empties the record tables, loads the
// backup, and moves each id counter past the restored rows. Staff accounts
// are restored as records only; sign-in accounts are recreated by the owner
// (Settings → Staff), and everyone sets a new password.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/backup-to-sql.mjs <backup.json.gz>'); process.exit(1); }
const raw = readFileSync(file);
const b = JSON.parse((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
if (b.app !== 'desert-pearl-poultry' || b.format !== 1) { console.error('Not a Desert Pearl backup.'); process.exit(1); }

const lit = (v) => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {   // a Postgres array literal, e.g. '{"owner","manager"}', cast by the column type
    const inner = v.map((x) => `"${String(x).replace(/["\\]/g, '\\$&')}"`).join(',');
    return `'{${inner.replace(/'/g, "''")}}'`;
  }
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const order = Object.keys(b.tables);
const out = [`-- Desert Pearl restore from ${file} (taken ${b.created_at}, ${b.rows} records)`, 'begin;', 'set session_replication_role = replica;  -- skip triggers and foreign-key checks while loading'];
out.push(`truncate ${[...order].reverse().filter((t) => !['settings', 'locations', 'accounts', 'staff'].includes(t)).map((t) => `public.${t}`).join(', ')};`);
for (const t of order) {
  const rows = b.tables[t];
  if (!rows.length) continue;
  const cols = Object.keys(rows[0]);
  const conflict = t === 'notification_reads' ? '(notification_id, staff_id)' : '(id)';
  const update = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => `(${cols.map((c) => lit(r[c])).join(', ')})`).join(',\n  ');
    out.push(`insert into public.${t} (${cols.join(', ')}) overriding system value values\n  ${chunk}\non conflict ${conflict} do ${update && t !== 'notification_reads' ? `update set ${update}` : 'nothing'};`);
  }
}
out.push('set session_replication_role = origin;');
out.push(`do $$ declare r record; begin
  for r in select c.table_name, c.column_name from information_schema.columns c
            where c.table_schema = 'public' and c.is_identity = 'YES' loop
    execute format('select setval(pg_get_serial_sequence(%L, %L), greatest((select coalesce(max(%I), 0) from public.%I), 1))',
                   'public.' || r.table_name, r.column_name, r.column_name, r.table_name);
  end loop;
end $$;`);
out.push('commit;');
process.stdout.write(out.join('\n') + '\n');
