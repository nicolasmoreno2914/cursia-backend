#!/bin/bash
# Gate-core: la parte del gate que NO necesita el Moodle local, para correr en CI (GitHub Actions)
# o en cualquier máquina sin depender de que un portátil siga despierto. USD 0: sin claves de
# proveedores, netguard bloquea toda conexión fuera de 127.0.0.1.
#
#   GATE_FE_ROOT=<checkout del frontend> [PGBIN=<dir de PG16>] [GATE_OUT=<dir>] bash scripts/ci/gate-core.sh
#
# Corre: build, E24 (worker de IA) sobre PG16 descartable, todos los checks del backend salvo los que
# necesitan Moodle/PHP, los tests de producción contra PG local y los harnesses del frontend.
# NO reemplaza al gate completo (test/e2e-v2/run-e2e-v21.sh): los checks de Moodle se listan como
# «NO CORRIDOS» en el resumen, nunca como aprobados.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
FE="${GATE_FE_ROOT:-}"
OUT="${GATE_OUT:-$REPO/.gate-core}"
REG="$OUT/regression"
HERE="$REPO/test/e2e-v2"
export PGBIN="${PGBIN:-$(for d in /usr/lib/postgresql/16/bin /opt/homebrew/opt/postgresql@16/bin /opt/homebrew/bin; do [ -x "$d/initdb" ] && echo "$d" && break; done)}"
[ -n "$PGBIN" ] || { echo "no se encontró PG16 (initdb)"; exit 2; }
export PG_BIN="$PGBIN"
rm -rf "$OUT"; mkdir -p "$REG"
SUMMARY="$OUT/summary.md"
FAIL=0
BLOCKED_FE=0
# Checks que necesitan el Moodle 4.5 local (PHP + datos de Moodle): solo en el gate completo.
NEEDS_MOODLE="check-ev6-h5p2-contracts check-dynamic-package-worker-hardening check-ev6-pending-videos check-p2-exams-moodle check-v21-h5p-moodle check-v21-h5p check-v21-h5p-player check-v21-packaging-v3 check-v21-shell-purifier check-v21-packaging-v3-moodle check-v21-vc-moodle-filters check-v21-vc-visual check-v21-vc-purifier check-v21-video check-v21-video-moodle"

echo "== build =="
(cd "$REPO" && npm run build) > "$OUT/build.log" 2>&1 || { tail -30 "$OUT/build.log"; echo "build falló"; exit 2; }

ALLOW_CHROME="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"
: > "$REG/net.log"
CLEAN_ENV=(env -i PATH="$PATH" HOME="$HOME" USER="${USER:-}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C PG_BIN="$PGBIN"
  NODE_OPTIONS="--require $HERE/netguard.js" E2E_NET_LOG="$REG/net.log" CURSIA_CHROME_HOST_RESOLVER_RULES="$ALLOW_CHROME"
  CURSIA_FRONTEND_REPO="$FE" CHROME_BIN="${CHROME_BIN:-}")

row() { printf '%-48s rc=%s ✅%s ❌%s\n' "$1" "$2" "$(grep -cE '^[[:space:]]*✅' "$3")" "$(grep -cE '^[[:space:]]*❌' "$3")" | tee -a "$SUMMARY.rows"; }

echo "== E24 (worker de IA) sin Moodle =="
if [ -n "$FE" ]; then
  mkdir -p "$OUT/e24/e2e-out"
  (cd "$REPO" && E2E_SKIP_V2=1 E2E_NO_MOODLE=1 SKIP_BUILD=1 E2E_SCRATCH="$OUT/e24" E2E_BACKEND_ROOT="$REPO" E2E_FRONTEND_ROOT="$FE" \
    E2E_V3_ONLY=llm-worker CURSIA_FRONTEND_REPO="$FE" \
    E2E_AFTER="FE_ROOT='$FE' node '$HERE/e2e-v3.js' > '$OUT/e24/e2e-v3.log' 2>&1" \
    bash test/e2e-v2/run-e2e.sh) > "$OUT/e24.log" 2>&1
  rc=$?; [ $rc -ne 0 ] && FAIL=1
  row "e2e-e24-llm-worker" "$rc" "$OUT/e24/e2e-v3.log"
else
  echo "sin GATE_FE_ROOT: E24 NO CORRIDO"; echo "e2e-e24-llm-worker BLOCKED (sin acceso al frontend: secreto CURSIA_FE_READ_TOKEN)" >> "$SUMMARY.notrun"; BLOCKED_FE=1
fi

echo "== checks del backend (sin Moodle) =="
for f in "$REPO"/scripts/check-*.js; do
  n=$(basename "$f" .js)
  case " $NEEDS_MOODLE " in *" $n "*) echo "$n NO CORRIDO (necesita Moodle local: gate completo)" >> "$SUMMARY.notrun"; continue ;; esac
  case "$n" in
    check-rel-failure-classes) if [ -n "$FE" ]; then a=(--require-fe --fe "$FE"); else a=(); fi ;;
    *) a=() ;;
  esac
  (cd "$REPO" && "${CLEAN_ENV[@]}" node "$f" "${a[@]+"${a[@]}"}") > "$REG/$n.log" 2>&1
  rc=$?
  # Sin frontend, un check que lee el frontend y falla queda BLOCKED (nunca PASS ni se esconde): hay que re-correrlo con acceso.
  if [ $rc -ne 0 ] && [ -z "$FE" ] && grep -q "CURSIA_FRONTEND_REPO" "$f"; then
    echo "$n BLOCKED (necesita el frontend: rc=$rc sin acceso; re-correr con CURSIA_FE_READ_TOKEN)" >> "$SUMMARY.notrun"; BLOCKED_FE=1
    row "$n (BLOCKED)" "$rc" "$REG/$n.log"
    continue
  fi
  [ $rc -ne 0 ] && FAIL=1
  row "$n" "$rc" "$REG/$n.log"
done
for h in "harness-blueprint-snapshot:scripts/harness-blueprint-snapshot.js:dist" \
         "prod-run-local-pg-tests:scripts/prod/test/run-local-pg-tests.js:" \
         "prod-legacy-app-compat:scripts/prod/test/run-legacy-app-compat-test.js:"; do
  n="${h%%:*}"; rest="${h#*:}"; s="${rest%%:*}"; arg="${rest#*:}"
  if [ -n "$arg" ]; then (cd "$REPO" && "${CLEAN_ENV[@]}" node "$s" "$REPO/$arg") > "$REG/$n.log" 2>&1; else (cd "$REPO" && "${CLEAN_ENV[@]}" node "$s") > "$REG/$n.log" 2>&1; fi
  rc=$?; [ $rc -ne 0 ] && FAIL=1
  row "$n" "$rc" "$REG/$n.log"
done

echo "== harnesses del frontend =="
if [ -n "$FE" ]; then
  for f in "$FE"/src/js/__harness__/*.mjs; do
    n="fe-$(basename "$f" .mjs)"
    (cd "$FE" && "${CLEAN_ENV[@]}" NODE_PATH="${GATE_JSDOM_NODE_PATH:-}" node "$f") > "$REG/$n.log" 2>&1
    rc=$?; [ $rc -ne 0 ] && FAIL=1
    row "$n" "$rc" "$REG/$n.log"
  done
else
  echo "harnesses del frontend BLOCKED (sin acceso al frontend: secreto CURSIA_FE_READ_TOKEN)" >> "$SUMMARY.notrun"
fi

NETBLOCK=$(grep -c . "$REG/net.log" 2>/dev/null); NETBLOCK=${NETBLOCK:-0}
{
  echo "## Gate-core (sin Moodle)"
  echo
  echo "backend: $(git -C "$REPO" rev-parse HEAD 2>/dev/null)  frontend: $( [ -n "$FE" ] && git -C "$FE" rev-parse HEAD 2>/dev/null)"
  echo
  echo '```'; cat "$SUMMARY.rows"; echo '```'
  echo
  echo "Conexiones externas bloqueadas por netguard: $NETBLOCK"
  echo
  echo "### NO CORRIDO aquí (requiere el gate completo con Moodle local)"
  echo '```'; cat "$SUMMARY.notrun" 2>/dev/null; echo '```'
  echo
  if [ $FAIL -ne 0 ]; then echo "RESULTADO GATE-CORE: FAIL"
  elif [ $BLOCKED_FE -ne 0 ]; then echo "RESULTADO GATE-CORE: BLOCKED (falta acceso al frontend; lo corrido pasó, pero NO es PASS)"
  else echo "RESULTADO GATE-CORE: OK"; fi
} > "$SUMMARY"
cat "$SUMMARY"
[ $FAIL -ne 0 ] && exit 1
[ $BLOCKED_FE -ne 0 ] && exit 3
exit 0
