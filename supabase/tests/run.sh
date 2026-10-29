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
