#!/usr/bin/env bash
# Applies the shim + every migration to a fresh database and runs the RLS isolation test.
# Usage: PGHOST=... PGPORT=... PGUSER=... scripts/test-db.sh
set -euo pipefail
DB="git2app_test_$$"
createdb "$DB"
trap 'dropdb --if-exists "$DB" >/dev/null 2>&1 || true' EXIT
run() { psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$1"; }
run supabase/tests/00_supabase_shim.sql
for f in supabase/migrations/*.sql; do run "$f"; done
run supabase/tests/10_rls_isolation.sql
run supabase/tests/20_artifact_types.sql
