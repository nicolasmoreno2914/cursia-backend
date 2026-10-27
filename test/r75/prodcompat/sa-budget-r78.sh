#!/usr/bin/env bash
# Uso: npm run build && REPO=<árbol compilado> SCRATCH=<dir> PGBIN=<PG16 bin> bash test/r75/prodcompat/sa-budget-r78.sh   (PG descartable CON migraciones r75)
set -u; HERE="$(cd "$(dirname "$0")" && pwd)"; PGBIN="${PGBIN:-/opt/homebrew/bin}"; PORT=55499
export PGPORT_T=$PORT APP_PORT=38483 LC_ALL=C NODE_PATH="$REPO/node_modules" BUILD_DIR="$REPO/dist"
DATA="$SCRATCH/sa-pgdata"; stop_pg() { "$PGBIN/pg_ctl" -D "$DATA" stop -m fast >/dev/null 2>&1 || true; rm -rf "$DATA"; }; trap stop_pg EXIT
STG="MIGRATION_ENV=staging DB_HOST=127.0.0.1 DB_PORT=$PORT DB_USER=postgres.e2elocaltest DB_PASS=x DB_NAME=v2db DB_SSL=false"
PSQL="$PGBIN/psql -h 127.0.0.1 -p $PORT -U postgres -d v2db -v ON_ERROR_STOP=1 -q"; RC=0
for TYPES in 1; do
  export OUT="$SCRATCH/sa-out-types$TYPES" E2E_PROD_COLUMN_TYPES=$TYPES; rm -rf "$OUT"; mkdir -p "$OUT"; stop_pg
  echo "════ SuperAdmin y presupuestos · con r75 · E2E_PROD_COLUMN_TYPES=$TYPES ════"
  "$PGBIN/initdb" -D "$DATA" --locale=C -U postgres -A trust >"$OUT/initdb.log" 2>&1 || exit 3
  "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c unix_socket_directories='' -c listen_addresses='127.0.0.1'" -l "$OUT/pg.log" -w start >/dev/null || exit 3
  "$PGBIN/createdb" -h 127.0.0.1 -p $PORT -U postgres v2db; $PSQL -c 'create role "postgres.e2elocaltest" superuser login'
  (cd "$REPO/test/e2e-v2" && NODE_ENV=production node setup-schema.js base) > "$OUT/setup-base.log" 2>&1 || { cat "$OUT/setup-base.log"; exit 5; }
  [ "$TYPES" = "1" ] && $PSQL -c 'alter table public.production_jobs alter column course_id type text using course_id::text, alter column owner_id type uuid using owner_id::uuid; alter table public.artifacts alter column owner_id type uuid using owner_id::uuid'
  DB_HOST=127.0.0.1 DB_PORT=$PORT DB_USER=postgres DB_PASS=x DB_NAME=v2db DB_SSL=false node "$REPO/scripts/migrate-production-jobs-constraints.js" > "$OUT/migrate-jobs.log" 2>&1 || exit 6
  (cd "$REPO/test/e2e-v2" && node setup-schema.js sql) > "$OUT/setup-sql.log" 2>&1 || exit 7
  for s in migrate-dynamic-generation-v2 migrate-invalidation migrate-v21-manifest-v3 verify-v21-manifest-v3-schema migrate-application-activities \
           verify-application-activities-schema migrate-guided-practice verify-guided-practice-schema migrate-v21-finops verify-v21-finops-schema \
           migrate-rel-recovery verify-rel-recovery-schema migrate-llm-worker-presence; do
    [ -f "$REPO/scripts/$s.js" ] || continue; env $STG node "$REPO/scripts/$s.js" > "$OUT/$s.log" 2>&1 || { echo "$s falló"; exit 8; }
  done
  $PSQL -f "$REPO/test/r75/sql/local-supabase-shim.sql" > "$OUT/shim.log" 2>&1 || exit 9
  for s in migrate-r75-access verify-r75-access-schema migrate-r75-budgets verify-r75-budgets-schema; do env $STG node "$REPO/scripts/$s.js" > "$OUT/$s.log" 2>&1 || { echo "$s falló"; tail -5 "$OUT/$s.log"; exit 8; }; done
  echo "(CON migraciones r75: escenario «el owner aplica r75 en Orbia»)"
  node "$HERE/sa-budget-r78.js" || RC=1
done
exit $RC
