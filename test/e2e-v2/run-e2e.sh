#!/bin/bash
# Cursia V2 — Fase 9: aceptación END-TO-END local, un solo comando.
#   ./run-e2e.sh            (build del backend + corrida completa + limpieza)
#   SKIP_BUILD=1 ./run-e2e.sh
# Sin llamadas pagas/externas: PG16 descartable (127.0.0.1, sin socket unix),
# Storage/Videogen falsos en 127.0.0.1, LLM falso, Moodle 4.5 local.
# Nunca toca staging/main/producción. Worktrees bajo prueba: solo lectura
# (el único efecto sobre ellos es `npm run build` → dist/, ignorado por git).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="${E2E_SCRATCH:?define E2E_SCRATCH (directorio de trabajo descartable)}"
export REPO="${E2E_BACKEND_ROOT:?define E2E_BACKEND_ROOT (checkout de orbia-backend a probar)}"
export FE_ROOT="${E2E_FRONTEND_ROOT:?define E2E_FRONTEND_ROOT (checkout de campuscloud-gen a probar)}"
export OUT="$SCRATCH/e2e-out"
export TLS_DIR="$OUT/tls"
export MOODLE_SCRATCH="${E2E_MOODLE_DIR:?define E2E_MOODLE_DIR (Moodle 4.5 local, ver moodle-local/README)}"
export MOODLE_ROOT="$MOODLE_SCRATCH/source"
export MOODLE_PHPINI="$MOODLE_SCRATCH/php.ini"
export PHP_BIN="/opt/homebrew/opt/php@8.3/bin/php"
export LC_ALL=C
PGBIN=/opt/homebrew/bin
PORT="${E2E_PG_PORT:-55491}"
export PGPORT_T=$PORT APP_PORT="${E2E_APP_PORT:-38471}"
DATA="$SCRATCH/e2e-pgdata"
T0=$(date +%s)

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" stop -m fast >/dev/null 2>&1 || true
  rm -rf "$DATA"
  echo "PG16 descartable destruido"
  "$MOODLE_SCRATCH/teardown.sh" || true   # sin --purge: los datos de Moodle quedan en disco
  echo "total: $(( $(date +%s) - T0 )) s"
}
trap cleanup EXIT

rm -rf "$OUT"; mkdir -p "$OUT" "$TLS_DIR"
echo "== commits bajo prueba =="
echo "backend:  $(git -C "$REPO" rev-parse HEAD) ($(git -C "$REPO" rev-parse --abbrev-ref HEAD))" | tee "$OUT/commits.txt"
echo "frontend: $(git -C "$FE_ROOT" rev-parse HEAD) ($(git -C "$FE_ROOT" rev-parse --abbrev-ref HEAD))" | tee -a "$OUT/commits.txt"
git -C "$REPO" status --short | head -5 >> "$OUT/commits.txt"; git -C "$FE_ROOT" status --short | head -5 >> "$OUT/commits.txt"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "== npm run build (backend) =="
  TB=$(date +%s)
  (cd "$REPO" && npm run build) > "$OUT/build.log" 2>&1 || { echo "build falló"; tail -20 "$OUT/build.log"; exit 2; }
  echo "build OK ($(( $(date +%s) - TB )) s)"
fi

echo "== cert TLS autofirmado (download URLs https locales del Videogen falso) =="
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" -days 2 -subj "/CN=127.0.0.1" >/dev/null 2>&1 || exit 2

echo "== PG16 descartable (127.0.0.1:$PORT) =="
rm -rf "$DATA"
"$PGBIN/initdb" -D "$DATA" --locale=C -U postgres -A trust >"$OUT/initdb.log" 2>&1 || { echo "initdb falló"; exit 3; }
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c unix_socket_directories='' -c listen_addresses='127.0.0.1'" -l "$OUT/pg.log" -w start >/dev/null || { cat "$OUT/pg.log"; exit 3; }
"$PGBIN/createdb" -h 127.0.0.1 -p $PORT -U postgres v2db || exit 4
"$PGBIN/psql" -h 127.0.0.1 -p $PORT -U postgres -d v2db -qc 'create role "postgres.e2elocaltest" superuser login' || exit 4
export NODE_PATH="$REPO/node_modules" BUILD_DIR="$REPO/dist"
(cd "$HERE" && NODE_ENV=production node "$HERE/setup-schema.js" base) || exit 5
DB_HOST=127.0.0.1 DB_PORT=$PORT DB_USER=postgres DB_PASS=x DB_NAME=v2db DB_SSL=false \
  node "$REPO/scripts/migrate-production-jobs-constraints.js" > "$OUT/migrate-jobs.log" 2>&1 || { cat "$OUT/migrate-jobs.log"; exit 6; }
(cd "$HERE" && node "$HERE/setup-schema.js" sql) || exit 7
STG="MIGRATION_ENV=staging DB_HOST=127.0.0.1 DB_PORT=$PORT DB_USER=postgres.e2elocaltest DB_PASS=x DB_NAME=v2db DB_SSL=false"
env $STG node "$REPO/scripts/migrate-dynamic-generation-v2.js" > "$OUT/migrate-v2.log" 2>&1 || { cat "$OUT/migrate-v2.log"; exit 8; }
env $STG node "$REPO/scripts/migrate-invalidation.js" > "$OUT/migrate-invalidation.log" 2>&1 || { cat "$OUT/migrate-invalidation.log"; exit 9; }
# V2.1 R4: Manifest rulesVersion 3 (extiende los CHECKs de la migración v2 → corre DESPUÉS de ella).
env $STG node "$REPO/scripts/migrate-v21-manifest-v3.js" > "$OUT/migrate-v21-manifest-v3.log" 2>&1 || { cat "$OUT/migrate-v21-manifest-v3.log"; exit 9; }
env $STG node "$REPO/scripts/verify-v21-manifest-v3-schema.js" > "$OUT/verify-v21-manifest-v3.log" 2>&1 || { cat "$OUT/verify-v21-manifest-v3.log"; exit 9; }
echo "schema + migraciones reales OK"

echo "== Moodle 4.5 local =="
"$MOODLE_SCRATCH/start.sh" > "$OUT/moodle-start.log" 2>&1 || { cat "$OUT/moodle-start.log"; exit 10; }

echo "== E2E =="
node "$HERE/e2e.js" 2>&1 | tee "$OUT/e2e.log"
RC=${PIPESTATUS[0]}

echo "== verify/audit (scripts reales del backend, con runs A y B) =="
for s in verify-dynamic-generation-schema audit-generation-manifests audit-dynamic-generation audit-course-blueprints; do
  (cd "$REPO" && env $STG node "scripts/$s.js") > "$OUT/$s.log" 2>&1; rc=$?
  [ $rc -ne 0 ] && RC=1
  echo "$s exit=$rc ($(tail -1 "$OUT/$s.log"))"
done
echo "E2E exit=$RC"
exit $RC
