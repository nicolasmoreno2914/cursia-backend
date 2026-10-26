#!/bin/bash
# r75 · Agente E — suite de integración, seguridad y aislamiento (matriz (a)–(l) de 03-plan-agentes.md).
#   E2E_SCRATCH=<dir> bash test/r75/run-r75.sh            # corre con E2E_PROD_COLUMN_TYPES=0 y =1 (ítem j)
#   R75_TYPES="0" SKIP_BUILD=1 E2E_SCRATCH=<dir> bash test/r75/run-r75.sh
# PG16 descartable en 127.0.0.1 (sin socket unix), app Nest REAL (dist/main.js), Supabase falso local, JWT HS256 local.
# Sin Moodle, sin workers, sin proveedores: USD 0. Nunca toca staging/main/producción.
# Reutiliza test/e2e-v2/setup-schema.js y los MISMOS scripts de migración que run-e2e.sh; las migraciones r75
# (scripts/migrate-r75-*.js) se aplican si existen en el checkout bajo prueba (si no, los ítems que dependen quedan
# PENDIENTE, nunca PASS).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
export REPO="${E2E_BACKEND_ROOT:-$(cd "$HERE/../.." && pwd)}"
SCRATCH="${E2E_SCRATCH:?define E2E_SCRATCH (directorio descartable)}"
PGBIN="${PGBIN:-/opt/homebrew/bin}"
PORT="${R75_PG_PORT:-55493}"
export PGPORT_T=$PORT APP_PORT="${R75_APP_PORT:-38475}" LC_ALL=C
mkdir -p "$SCRATCH"
T0=$(date +%s)
DATA="$SCRATCH/r75-pgdata"

stop_pg() { "$PGBIN/pg_ctl" -D "$DATA" stop -m fast >/dev/null 2>&1 || true; rm -rf "$DATA"; }
trap 'stop_pg; echo "total: $(( $(date +%s) - T0 )) s"' EXIT

echo "backend: $(git -C "$REPO" rev-parse --short HEAD) ($(git -C "$REPO" rev-parse --abbrev-ref HEAD))"
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  (cd "$REPO" && npx tsc -p tsconfig.build.json) > "$SCRATCH/r75-build.log" 2>&1 || { echo "build falló"; tail -30 "$SCRATCH/r75-build.log"; exit 2; }
  echo "build OK"
fi
export NODE_PATH="$REPO/node_modules" BUILD_DIR="$REPO/dist"
STG="MIGRATION_ENV=staging DB_HOST=127.0.0.1 DB_PORT=$PORT DB_USER=postgres.e2elocaltest DB_PASS=x DB_NAME=v2db DB_SSL=false"
PSQL="$PGBIN/psql -h 127.0.0.1 -p $PORT -U postgres -d v2db -v ON_ERROR_STOP=1 -q"

RC=0
for TYPES in ${R75_TYPES:-0 1}; do
  export OUT="$SCRATCH/r75-out-types$TYPES" E2E_PROD_COLUMN_TYPES=$TYPES
  rm -rf "$OUT"; mkdir -p "$OUT"
  echo; echo "════════ r75 · E2E_PROD_COLUMN_TYPES=$TYPES ════════"
  stop_pg
  "$PGBIN/initdb" -D "$DATA" --locale=C -U postgres -A trust >"$OUT/initdb.log" 2>&1 || { echo "initdb falló"; exit 3; }
  "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c unix_socket_directories='' -c listen_addresses='127.0.0.1'" -l "$OUT/pg.log" -w start >/dev/null || { cat "$OUT/pg.log"; exit 3; }
  "$PGBIN/createdb" -h 127.0.0.1 -p $PORT -U postgres v2db || exit 4
  $PSQL -c 'create role "postgres.e2elocaltest" superuser login' || exit 4
  (cd "$REPO/test/e2e-v2" && NODE_ENV=production node setup-schema.js base) > "$OUT/setup-base.log" 2>&1 || { cat "$OUT/setup-base.log"; exit 5; }
  if [ "$TYPES" = "1" ]; then
    $PSQL -c 'alter table public.production_jobs alter column course_id type text using course_id::text, alter column owner_id type uuid using owner_id::uuid; alter table public.artifacts alter column owner_id type uuid using owner_id::uuid' || exit 5
    echo "tipos de producción aplicados (production_jobs.course_id text, owner_id uuid; artifacts.owner_id uuid)"
  fi
  DB_HOST=127.0.0.1 DB_PORT=$PORT DB_USER=postgres DB_PASS=x DB_NAME=v2db DB_SSL=false node "$REPO/scripts/migrate-production-jobs-constraints.js" > "$OUT/migrate-jobs.log" 2>&1 || { cat "$OUT/migrate-jobs.log"; exit 6; }
  (cd "$REPO/test/e2e-v2" && node setup-schema.js sql) > "$OUT/setup-sql.log" 2>&1 || { tail -20 "$OUT/setup-sql.log"; exit 7; }
  for s in migrate-dynamic-generation-v2 migrate-invalidation migrate-v21-manifest-v3 verify-v21-manifest-v3-schema migrate-application-activities \
           verify-application-activities-schema migrate-guided-practice verify-guided-practice-schema migrate-v21-finops verify-v21-finops-schema \
           migrate-rel-recovery verify-rel-recovery-schema migrate-llm-worker-presence; do
    [ -f "$REPO/scripts/$s.js" ] || continue
    env $STG node "$REPO/scripts/$s.js" > "$OUT/$s.log" 2>&1 || { echo "$s falló"; tail -20 "$OUT/$s.log"; exit 8; }
  done
  # Supabase local mínimo: esquema auth (auth.users + auth.uid()/auth.email()), roles anon/authenticated, y la tabla
  # authorized_users del FE (supabase-schema.sql) con el ESTADO OBSERVADO EN STAGING (H2, 2026-10-26): una política
  # que deja escribir a authenticated. La migración r75-access de A tiene que dejarla solo con «SELECT de la propia fila».
  $PSQL -f "$HERE/sql/local-supabase-shim.sql" > "$OUT/shim.log" 2>&1 || { cat "$OUT/shim.log"; exit 9; }
  for s in migrate-r75-access verify-r75-access-schema migrate-r75-budgets verify-r75-budgets-schema; do
    if [ -f "$REPO/scripts/$s.js" ]; then
      env $STG node "$REPO/scripts/$s.js" > "$OUT/$s.log" 2>&1 || { echo "$s falló"; tail -20 "$OUT/$s.log"; RC=1; }
      echo "$s: $(tail -1 "$OUT/$s.log")"
    else echo "$s: (no existe en el checkout bajo prueba)"; fi
  done
  if [ -f "$REPO/scripts/migrate-r75-backfill.js" ]; then
    env $STG R75_BACKFILL_REPORT_DIR="$OUT" node "$REPO/scripts/migrate-r75-backfill.js" --apply > "$OUT/backfill.log" 2>&1 || { echo "backfill falló"; tail -20 "$OUT/backfill.log"; RC=1; }
    echo "migrate-r75-backfill --apply: $(tail -1 "$OUT/backfill.log")"
  fi
  echo "== suite r75 =="
  node "$HERE/suite.js" 2>&1 | tee "$OUT/suite.log"
  rc=${PIPESTATUS[0]}; [ $rc -ne 0 ] && RC=1
  echo "suite (types=$TYPES) exit=$rc"
  "$PGBIN/pg_ctl" -D "$DATA" stop -m fast >/dev/null 2>&1 || true
done
node "$HERE/summarize.js" "$SCRATCH" ${R75_TYPES:-0 1} || RC=1
exit $RC
