#!/usr/bin/env bash
# Runs the SQL test suite against a throwaway local Postgres database.
# Usage: PGHOST=/tmp PGPORT=5433 PGUSER=postgres supabase/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
P="psql -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "drop database if exists dpv_test" -c "create database dpv_test" >/dev/null
$P -d dpv_test -f supabase/tests/00_supabase_shim.sql >/dev/null
for f in supabase/migrations/*.sql; do $P -d dpv_test -f "$f" >/dev/null 2>&1 || { $P -d dpv_test -f "$f"; exit 1; }; done
$P -d dpv_test -f supabase/tests/01_flows.sql
$P -d dpv_test -f supabase/tests/03_auth.sql
$P -d dpv_test -f supabase/tests/04_farm_changes.sql
$P -d dpv_test -f supabase/tests/05_grades_sheets.sql
$P -d dpv_test -f supabase/tests/06_staff_email.sql
# the digest and completeness engine, on its own database with fixed fixture data (pgTAP)
$P -d postgres -c "drop database if exists dpv_facts" -c "create database dpv_facts" >/dev/null
$P -d dpv_facts -f supabase/tests/00_supabase_shim.sql >/dev/null
for f in supabase/migrations/*.sql; do $P -d dpv_facts -f "$f" >/dev/null 2>&1 || { $P -d dpv_facts -f "$f"; exit 1; }; done
psql -q -X -d dpv_facts -f supabase/tests/07_digest_pgtap.sql
