#!/bin/bash
# Cursia V2.1 — R13: compuerta final, un solo comando.
#   1. E2E v2 intacto (e2e.js) + fase rulesVersion 3 (e2e-v3.js: E1/E1-repack/E2/E3,
#      FinOps, restore de los 4 MBZ en Moodle 4.5 local + simulación de notas),
#      ambos sobre el mismo PG16 descartable (run-e2e.sh con E2E_AFTER).
#   2. QA de navegador (browser-qa-v3.js): servidor PHP 127.0.0.1:8099 solo durante
#      la prueba, estudiante local de prueba, forceclean=1 temporal → 0 siempre.
#   3. Regresión: todos los scripts/check-*.js del backend (incluidos los de Moodle
#      local), harness-blueprint-snapshot, runner de producción local y los
#      harnesses del frontend.
#   4. Resumen (summary-v21.js): aserciones por área, sha de los MBZ, warnings de
#      restore y contadores de proveedores (0 reales).
#
# Uso:
#   E2E_BACKEND_ROOT=… E2E_FRONTEND_ROOT=… E2E_SCRATCH=… E2E_MOODLE_DIR=… \
#   E2E_MOODLE_CREDS=<archivo username=/password=> [E2E_SHOTS=<dir>] [SKIP_BUILD=1] \
#   [E2E_JSDOM_NODE_PATH=<node_modules con jsdom>] [E2E_SKIP_REGRESSION=1] \
#     bash test/e2e-v2/run-e2e-v21.sh
# Nunca toca staging/main/producción ni hace llamadas a proveedores reales.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRATCH="${E2E_SCRATCH:?define E2E_SCRATCH}"
REPO="${E2E_BACKEND_ROOT:?define E2E_BACKEND_ROOT}"
FE="${E2E_FRONTEND_ROOT:?define E2E_FRONTEND_ROOT}"
MOODLE="${E2E_MOODLE_DIR:?define E2E_MOODLE_DIR}"
CREDS="${E2E_MOODLE_CREDS:?define E2E_MOODLE_CREDS (credenciales del estudiante local de prueba)}"
SHOTS="${E2E_SHOTS:-$SCRATCH/visual}"
PHP_BIN="${PHP_BIN:-/opt/homebrew/opt/php@8.3/bin/php}"
export PHP_BIN
OUT="$SCRATCH/e2e-out"
REG="$SCRATCH/regression"
T0=$(date +%s)
mkdir -p "$SCRATCH" "$SHOTS" "$REG"
rm -f "$REG"/*.log

MOODLE_PG_STARTED=0
forceclean_now() { (cd "$MOODLE/source" && "$PHP_BIN" -c "$MOODLE/php.ini" admin/cli/cfg.php --name=forceclean 2>/dev/null); }
finish() {
  # 1º red de seguridad de forceclean (idempotente) MIENTRAS el Postgres del Moodle sigue arriba;
  # recién después se detiene ese Postgres, y solo si lo arrancó esta corrida (nunca --purge).
  if pg_isready -h 127.0.0.1 -p 5570 >/dev/null 2>&1; then
    v=$(forceclean_now)
    if [ "$v" != "0" ]; then
      (cd "$MOODLE/source" && "$PHP_BIN" -c "$MOODLE/php.ini" admin/cli/cfg.php --name=forceclean --set=0 && "$PHP_BIN" -c "$MOODLE/php.ini" admin/cli/purge_caches.php) >/dev/null 2>&1
      v=$(forceclean_now)
    fi
    echo "forceclean al salir (leído): $v"
  fi
  lsof -tiTCP:8099 -sTCP:LISTEN >/dev/null 2>&1 && echo "ATENCIÓN: algo sigue escuchando en 127.0.0.1:8099"
  if [ "$MOODLE_PG_STARTED" = "1" ]; then "$MOODLE/teardown.sh" >/dev/null 2>&1 || true; fi
  echo "total run-e2e-v21: $(( $(date +%s) - T0 )) s"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "== npm run build (backend) =="
  (cd "$REPO" && npm run build) > "$SCRATCH/build.log" 2>&1 || { echo "build falló"; tail -20 "$SCRATCH/build.log"; exit 2; }
fi
if ! pg_isready -h 127.0.0.1 -p 5570 >/dev/null 2>&1; then
  "$MOODLE/start.sh" > "$SCRATCH/moodle-start.log" 2>&1 || { cat "$SCRATCH/moodle-start.log"; exit 10; }
  MOODLE_PG_STARTED=1
fi

echo "== 1. E2E v2 + fase rulesVersion 3 + Moodle =="
E2E_AFTER="node '$HERE/e2e-v3.js' 2>&1 | tee '$OUT/e2e-v3.log'; exit \${PIPESTATUS[0]}" SKIP_BUILD=1 \
  bash "$HERE/run-e2e.sh" > "$SCRATCH/e2e-run.log" 2>&1
E2E_RC=$?
grep -E "E2E F9:|E2E V2.1|exit=" "$SCRATCH/e2e-run.log"

echo "== 2. QA de navegador =="
QA_RC=1
if [ -f "$OUT/v3/results-v3.json" ]; then
  node "$HERE/browser-qa-v3.js" "$OUT/v3/results-v3.json" --moodle "$MOODLE" --creds "$CREDS" --shots "$SHOTS" --repo "$REPO" > "$OUT/browser-qa-v3.log" 2>&1
  QA_RC=$?
  tail -1 "$OUT/browser-qa-v3.log"
else
  echo "sin results-v3.json: QA de navegador omitido (FALLA)"
fi

REG_RC=0
# Regresión bajo netguard (toda conexión fuera de 127.0.0.1 se bloquea y se registra por
# proveedor) y con un entorno LIMPIO: sin claves ni URLs de proveedores del shell del usuario.
# Chrome (checks de reproductor/visual) con la misma red restringida que el QA.
ALLOW_CHROME="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE youtube.com, EXCLUDE *.youtube.com, EXCLUDE youtube-nocookie.com, EXCLUDE *.youtube-nocookie.com, EXCLUDE *.ytimg.com, EXCLUDE *.googlevideo.com, EXCLUDE *.ggpht.com"
env | cut -d= -f1 | grep -E 'API_KEY|ANTHROPIC|OPENAI|GAMMA|VIDEOGEN|ELEVEN|YOUTUBE|GOOGLE|SUPABASE|SECRET|TOKEN|_KEY$' | sort > "$REG/scrubbed-env-names.txt" || true
: > "$REG/net.log"
CLEAN_ENV=(env -i PATH="$PATH" HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C
  PHP_BIN="$PHP_BIN" NODE_OPTIONS="--require $HERE/netguard.js" E2E_NET_LOG="$REG/net.log" CURSIA_CHROME_HOST_RESOLVER_RULES="$ALLOW_CHROME")
if [ "${E2E_SKIP_REGRESSION:-0}" != "1" ]; then
  echo "(entorno limpio: $(wc -l < "$REG/scrubbed-env-names.txt" | tr -d ' ') variables de proveedor/credenciales del shell NO se pasan; netguard activo)"
  echo "== 3. Regresión: checks del backend =="
  for f in "$REPO"/scripts/check-*.js; do
    n=$(basename "$f" .js)
    case "$n" in
      check-v21-h5p-moodle) a=("$MOODLE/source" "$MOODLE/php.ini") ;;
      check-v21-h5p-player) a=("$MOODLE/source" "$MOODLE/php.ini" --creds "$CREDS" --shots "$SHOTS/regression-player") ;;
      check-v21-video-moodle) a=("$MOODLE/source" "$MOODLE/php.ini" --creds "$CREDS" --shots "$SHOTS/regression-video") ;;
      *) a=() ;;
    esac
    (cd "$REPO" && "${CLEAN_ENV[@]}" node "$f" "${a[@]+"${a[@]}"}") > "$REG/$n.log" 2>&1
    rc=$?
    echo "$rc" > "$REG/$n.rc"
    [ $rc -ne 0 ] && REG_RC=1
    printf '%-48s rc=%s ✅%s ❌%s\n' "$n" "$rc" "$(grep -cE '^[[:space:]]*✅' "$REG/$n.log")" "$(grep -cE '^[[:space:]]*❌' "$REG/$n.log")"
  done
  for h in "harness-blueprint-snapshot:scripts/harness-blueprint-snapshot.js:dist" \
           "prod-run-local-pg-tests:scripts/prod/test/run-local-pg-tests.js:" \
           "prod-legacy-app-compat:scripts/prod/test/run-legacy-app-compat-test.js:"; do
    n="${h%%:*}"; rest="${h#*:}"; s="${rest%%:*}"; arg="${rest#*:}"
    if [ -n "$arg" ]; then (cd "$REPO" && "${CLEAN_ENV[@]}" node "$s" "$REPO/$arg") > "$REG/$n.log" 2>&1; else (cd "$REPO" && "${CLEAN_ENV[@]}" node "$s") > "$REG/$n.log" 2>&1; fi
    rc=$?; echo "$rc" > "$REG/$n.rc"; [ $rc -ne 0 ] && REG_RC=1
    printf '%-48s rc=%s ✅%s ❌%s\n' "$n" "$rc" "$(grep -cE '^[[:space:]]*✅' "$REG/$n.log")" "$(grep -cE '^[[:space:]]*❌' "$REG/$n.log")"
  done
  echo "== 3b. Regresión: harnesses del frontend =="
  for f in "$FE"/src/js/__harness__/*.mjs; do
    n="fe-$(basename "$f" .mjs)"
    (cd "$FE" && "${CLEAN_ENV[@]}" NODE_PATH="${E2E_JSDOM_NODE_PATH:-}" node "$f") > "$REG/$n.log" 2>&1
    rc=$?; echo "$rc" > "$REG/$n.rc"; [ $rc -ne 0 ] && REG_RC=1
    printf '%-48s rc=%s ✅%s ❌%s\n' "$n" "$rc" "$(grep -cE '^[[:space:]]*✅' "$REG/$n.log")" "$(grep -cE '^[[:space:]]*❌' "$REG/$n.log")"
  done
fi

echo "== 4. forceclean final =="
FC_RC=0
FC=$(forceclean_now)
echo "forceclean (leído con admin/cli/cfg.php): $FC"
echo "$FC" > "$SCRATCH/forceclean-final.txt"
[ "$FC" != "0" ] && FC_RC=1
lsof -tiTCP:8099 -sTCP:LISTEN >/dev/null 2>&1 && { echo "servidor en 8099 sigue arriba"; FC_RC=1; }

echo "== 5. Resumen =="
node "$HERE/summary-v21.js" "$SCRATCH" | tee "$SCRATCH/summary.txt"
RC=0
[ $E2E_RC -ne 0 ] && RC=1
[ $QA_RC -ne 0 ] && RC=1
[ $REG_RC -ne 0 ] && RC=1
[ $FC_RC -ne 0 ] && RC=1
grep -q "^RESULTADO: PASS" "$SCRATCH/summary.txt" || RC=1
echo "run-e2e-v21 exit=$RC (e2e=$E2E_RC qa=$QA_RC regresión=$REG_RC forceclean/servidores=$FC_RC)"
exit $RC
