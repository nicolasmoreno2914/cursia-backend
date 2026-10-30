#!/usr/bin/env bash
# r79.2 · prodcompat del árbol r79 + r79.1 contra un Postgres descartable con el esquema de PRODUCCIÓN:
# V2 (22 pasos) + r75-access + r75-budgets (aplicadas en Orbia el 2026-10-27) y SIN r79.1 (EXCLUDED), salvo R79_WITH_MIGRATION=1.
#
# Necesita:
#   - REPO   = árbol COMPILADO del candidato (checkout de origin/staging o de la rama de release; `npm ci && npm run build`).
#              Usa REPO/dist/main.js, REPO/node_modules, REPO/test/r75/lib/{env,fake-supabase}.js, REPO/test/e2e-v2/setup-schema.js,
#              REPO/test/r75/sql/local-supabase-shim.sql y los scripts/migrate-*.js del mismo árbol.
#   - SCRATCH = directorio de trabajo descartable.  PGBIN = binarios de PostgreSQL 16/17 (initdb, pg_ctl, psql, createdb).
#   - Puertos libres 55499 (PG) y 38482 (app). Sin red externa (netguard de test/e2e-v2), sin IA, USD 0.
# Uso:
#   npm run build && REPO=$PWD SCRATCH=$(mktemp -d) PGBIN=/opt/homebrew/opt/postgresql@16/bin bash test/r75/prodcompat/prodcompat-r79.sh
# Corre 4 variantes: flag off/on × sin/con la migración r79.1 (la de «con» prueba el estado DESPUÉS de 30-migration).
# Esperado: todas en verde. Sin la migración: el diseño con tipos → 503 schema_not_migrated_application_kind; nada da 500.
set -u; HERE="$(cd "$(dirname "$0")" && pwd)"; PGBIN="${PGBIN:-/opt/homebrew/bin}"; PORT=55499
export PGPORT_T=$PORT APP_PORT=38482 LC_ALL=C LANG=C NODE_PATH="$REPO/node_modules" BUILD_DIR="$REPO/dist"
DATA="$SCRATCH/pc79-pgdata"; stop_pg() { "$PGBIN/pg_ctl" -D "$DATA" stop -m fast >/dev/null 2>&1 || true; [ -n "$SCRATCH" ] && [ -d "$DATA" ] && rm -rf -- "$DATA"; }; trap stop_pg EXIT
STG="MIGRATION_ENV=staging DB_HOST=127.0.0.1 DB_PORT=$PORT DB_USER=postgres.e2elocaltest DB_PASS=x DB_NAME=v2db DB_SSL=false"
PSQL="$PGBIN/psql -h 127.0.0.1 -p $PORT -U postgres -d v2db -v ON_ERROR_STOP=1 -q"; RC=0
JS="$HERE/prodcompat-r79.js"
for MIG in 0 1; do for FLAG in off on; do
  export OUT="$SCRATCH/pc79-out-mig$MIG-$FLAG" R79_FLAG=$FLAG R79_WITH_MIGRATION=$MIG; mkdir -p "$OUT"; stop_pg
  echo "════ r79 · DYNAMIC_BUDGET_FIT=$FLAG · migración r79.1: $([ $MIG = 1 ] && echo aplicada || echo AUSENTE) ════"
  "$PGBIN/initdb" -D "$DATA" --locale=C -U postgres -A trust >"$OUT/initdb.log" 2>&1 || exit 3
  "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c unix_socket_directories='' -c listen_addresses='127.0.0.1'" -l "$OUT/pg.log" -w start >/dev/null || exit 3
  "$PGBIN/createdb" -h 127.0.0.1 -p $PORT -U postgres v2db; $PSQL -c 'create role "postgres.e2elocaltest" superuser login'
  (cd "$REPO/test/e2e-v2" && NODE_ENV=production node setup-schema.js base) > "$OUT/setup-base.log" 2>&1 || { cat "$OUT/setup-base.log"; exit 5; }
  # Tipos de columna de prod (production_jobs.course_id text, owner_id uuid), como la variante TYPES=1 de r78.
  $PSQL -c 'alter table public.production_jobs alter column course_id type text using course_id::text, alter column owner_id type uuid using owner_id::uuid; alter table public.artifacts alter column owner_id type uuid using owner_id::uuid'
  DB_HOST=127.0.0.1 DB_PORT=$PORT DB_USER=postgres DB_PASS=x DB_NAME=v2db DB_SSL=false node "$REPO/scripts/migrate-production-jobs-constraints.js" > "$OUT/migrate-jobs.log" 2>&1 || exit 6
  (cd "$REPO/test/e2e-v2" && node setup-schema.js sql) > "$OUT/setup-sql.log" 2>&1 || exit 7
  for s in migrate-dynamic-generation-v2 migrate-invalidation migrate-v21-manifest-v3 verify-v21-manifest-v3-schema migrate-application-activities \
           verify-application-activities-schema migrate-guided-practice verify-guided-practice-schema migrate-academic-context migrate-prebrief \
           migrate-v21-finops verify-v21-finops-schema migrate-rel-recovery verify-rel-recovery-schema migrate-llm-worker-presence; do
    [ -f "$REPO/scripts/$s.js" ] || continue; env $STG node "$REPO/scripts/$s.js" > "$OUT/$s.log" 2>&1 || { echo "$s falló"; exit 8; }
  done
  $PSQL -f "$REPO/test/r75/sql/local-supabase-shim.sql" > "$OUT/shim.log" 2>&1 || exit 9
  # Prod (2026-10-27): r75-access + r75-budgets aplicadas (60-/70- de window-2026-10-27). El backfill necesita datos: no hace falta aquí.
  for s in migrate-r75-access verify-r75-access-schema migrate-r75-budgets verify-r75-budgets-schema; do
    [ -f "$REPO/scripts/$s.js" ] || continue; env $STG node "$REPO/scripts/$s.js" > "$OUT/$s.log" 2>&1 || { echo "$s falló"; exit 8; }
  done
  if [ "$MIG" = "1" ]; then env $STG node "$REPO/scripts/migrate-r79-1-application-kinds.js" > "$OUT/migrate-r79-1.log" 2>&1 || { echo "migrate-r79-1 falló"; exit 8; }; fi
  node "$JS" || RC=1
done; done
exit $RC
