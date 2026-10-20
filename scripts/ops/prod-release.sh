#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# prod-release.sh — r61: lado VPS del deploy de PRODUCCIÓN (.github/workflows/deploy.yml).
#
# Subcomandos (todos corren EN el VPS, en el directorio de producción = VPS_PATH):
#
#   preflight <dir> [canary_owner] [v2_ga]          (por stdin: bash -s -- preflight …)
#       Solo lectura. .env presente, NODE_ENV=production (sin él TypeORM synchronize
#       quedaría activo y podría borrar columnas — I5, Fase 5A) y la compuerta «V2 abierto
#       a TODOS» (DYNAMIC_COURSE_STRUCTURE=true con DYNAMIC_V2_ALLOWED_OWNERS vacío) con la
#       configuración que el deploy va a escribir. Falla → el deploy se aborta ANTES del rsync.
#
#   snapshot <dir> <sha>                            (por stdin)
#       Guarda la release ACTUAL (código + dist, sin node_modules ni .env) en
#       <dir>/.release-prev/ — SOLO si la release actual quedó marcada sana
#       (.release-state = "ok …") o es la release anterior a r61 (sin .release-state).
#       Si un deploy previo quedó a medias (state "deploying …"), conserva el
#       .release-prev existente (la última release SANA). Luego state = "deploying <sha>".
#
#   install                                          (desde el disco, tras el rsync; cwd = dir)
#       stdin: línea 1 = FINOPS_INGEST_TOKEN de producción (secreto, nunca se imprime);
#       líneas siguientes = KEY=VALUE no secretos (ver CFG_KEYS). Flags V2 con defaults
#       SEGUROS (V2 apagado salvo canario explícito), npm install, las 2 migraciones de
#       siempre de producción (constraints de production_jobs + usage_events; las de V2 van
#       SOLO por v2-production-migrations.yml), recarga PM2 (V1 igual que antes; los 3
#       workers dinámicos con drenado), presencia + ventana de estabilidad de los 11
#       procesos y conectividad a la base (sondas de solo lectura).
#
#   mark-ok <dir> <sha|restored>                     (por stdin)
#       state = "ok <sha>" (lo llama el workflow DESPUÉS del health check; «restored» = la
#       release que dejó un rollback, que puede ser anterior a r61 y no tener este script).
#
#   rollback <dir>                                   (por stdin: bash -s -- rollback …)
#       Restaura <dir>/.release-prev/ (código + node_modules del snapshot; copia la release fallida,
#       sin node_modules, a .release-failed/ para diagnóstico), recarga PM2. NO corre migraciones: el esquema
#       V2 es aditivo y el CHECK de main fallaría con filas dynamic (N1). No toca el .env.
#
# Nunca imprime valores del .env: solo nombres de clave y valores NO secretos que este
# script mismo decide. `pm2 jlist` (trae el entorno de cada proceso) solo se lee por pipe
# y se reduce a nombre/estado/reinicios.
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROD_PROCESSES_LEGACY=(
  "cursia-content-worker start:content-worker"
  "cursia-video-worker start:video-worker"
  "cursia-audio-worker start:audio-worker"
  "cursia-h5p-worker start:h5p-worker"
  "cursia-gamma-worker start:gamma-worker"
  "cursia-package-worker start:package-worker"
  "cursia-full-worker start:full-worker"
)
PROD_PROCESSES_DRAIN=(
  "cursia-dynamic-item-worker dist/workers/dynamic-item-worker.js"
  "cursia-dynamic-package-worker dist/workers/dynamic-package-worker.js"
  "cursia-dynamic-provider-worker dist/workers/dynamic-provider-worker.js"
)
PROD_ALL_NAMES=(cursia-backend cursia-content-worker cursia-video-worker cursia-audio-worker cursia-h5p-worker
  cursia-gamma-worker cursia-package-worker cursia-full-worker cursia-dynamic-item-worker
  cursia-dynamic-package-worker cursia-dynamic-provider-worker)
# R16 (#1): kill_timeout de los workers dinámicos (drenado interno 270 s < 300 s).
DRAIN_KILL_TIMEOUT_MS=300000
DRAIN_TIMEOUT_MS=270000
# r62 d9/d11: con el worker de IA hospedado encendido, una llamada larga de Anthropic puede durar hasta
# DYNAMIC_LLM_WORKER_CALL_TIMEOUT_MS (default 15 min) y el drenado NUNCA corta una llamada pagada ya enviada:
# el kill_timeout de PM2 sube a llamada + 90 s y el tope interno de drenado a kill_timeout − 30 s (siempre
# por debajo). Sin el worker de IA: 300 s / 270 s (los cuelgues del TTS terminan a los 125–172 s).
compute_drain_timeouts() {
  local call
  DRAIN_KILL_TIMEOUT_MS=300000
  if [ "$(env_val DYNAMIC_LLM_WORKER_ENABLED)" = "true" ]; then
    # Misma lectura que readPositiveInt del worker (dynamic-llm-worker.ts): número finito > 0, floor; si no, 15 min.
    call=$(node -e 'const v=Number(process.argv[1]);process.stdout.write(String(Number.isFinite(v)&&v>0?Math.floor(v):900000))' "$(env_val DYNAMIC_LLM_WORKER_CALL_TIMEOUT_MS)")
    if [ $((call + 90000)) -gt "$DRAIN_KILL_TIMEOUT_MS" ]; then DRAIN_KILL_TIMEOUT_MS=$((call + 90000)); fi
  fi
  DRAIN_TIMEOUT_MS=$((DRAIN_KILL_TIMEOUT_MS - 30000))
}
TTS_SNAPSHOT=gpt-4o-mini-tts-2025-03-20
STABILITY_WINDOW_S="${PROD_STABILITY_WINDOW_S:-45}"
UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
RELEASE_EXCLUDES=(--exclude node_modules --exclude .env --exclude '.env.*' --exclude '.release-*')
# Workers V1 que salen A PROPÓSITO al arrancar si están deshabilitados (r61 fix I1): con la condición
# cumplida se DETIENEN (no se reinician en bucle) y no cuentan en la presencia/estabilidad.
#   cursia-video-worker: sale con 0 si VIDEO_WORKER_ENABLED != true (video-worker.ts)
#   cursia-gamma-worker: sale con 1 si GAMMA_API_KEY está vacío (gamma-worker.ts)
PRELOOP_WINDOW_S="${PROD_PRELOOP_WINDOW_S:-15}"
PM2="${PM2_BIN:-sudo pm2}"

die() { echo "❌ $*"; exit 1; }
now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ── .env (mismo criterio que deploy-staging.yml) ─────────────────────────────
# Valor pelado: sin CR final, sin comentario fuera de comillas, sin comillas que envuelvan todo.
_strip_value() {
  local v="$1"
  v="${v%$'\r'}"
  case "$v" in
    \"*\"|\'*\') ;;
    *) v="${v%%#*}" ;;
  esac
  while [ -n "$v" ] && { [ "${v: -1}" = " " ] || [ "${v: -1}" = $'\t' ]; }; do v="${v%?}"; done
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf "%s" "$v"
}
# Valor efectivo de una clave (última línea, como dotenv); vacío si no está.
env_val() {
  local k="$1" raw
  raw=$(grep "^${k}=" .env 2>/dev/null | tail -n 1 || true)
  [ -n "$raw" ] && _strip_value "${raw#"${k}"=}"
  return 0
}
_atomic_replace_line() {
  # $1 clave, $2 línea nueva: reemplaza la ÚNICA línea KEY=… (validado por el caller).
  # r61 fix I3: el temporal nace como COPIA del .env (cp -p: mismo modo, p. ej. 0600) con umask 077 y se
  # sobrescribe en su lugar, así el mv atómico nunca deja el .env de producción legible por otros (0644).
  # Fix M1: clave y línea viajan por ENVIRON (no por argv de awk: sin exposición en /proc/*/cmdline y sin
  # procesar escapes \ de -v, que corromperían un token con barras).
  local key="$1" new="$2" tmp before after
  tmp=".env.flags.tmp.$$"
  (umask 077 && cp -p .env "$tmp") || { echo "❌ ${key}: no se pudo crear el temporal del .env"; return 1; }
  if ! _K="$key" _V="$new" awk 'BEGIN{p=ENVIRON["_K"] "="; v=ENVIRON["_V"]} index($0,p)==1 && !d {print v; d=1; next} {print}' .env > "$tmp"; then
    rm -f "$tmp"; echo "❌ ${key}: la reescritura del .env falló — se aborta sin tocar .env"; return 1
  fi
  before=$(awk 'END{print NR}' .env)
  after=$(awk 'END{print NR}' "$tmp")
  if [ ! -s "$tmp" ] || [ "$before" != "$after" ]; then
    rm -f "$tmp"
    echo "❌ ${key}: la reescritura del .env no validó — se aborta sin tocar .env"
    return 1
  fi
  (umask 077 && cp -p .env .env.bak)
  mv "$tmp" .env
}
# Fija una clave NO secreta a un valor exacto (imprime clave y valores: solo se usa con valores no secretos).
ensure_env_exact() {
  local key="$1" value="$2" count before
  count=$(grep -c "^${key}=" .env || true)
  if [ "$count" -eq 0 ]; then printf "\n%s=%s\n" "$key" "$value" >> .env; echo "+ ${key}: (ausente) → ${value}"; return 0; fi
  if [ "$count" -gt 1 ]; then echo "❌ ${key} aparece más de una vez en el .env — no se toca (revisar a mano)"; return 1; fi
  before=$(env_val "$key")
  if [ "$before" = "$value" ]; then echo "✓ ${key}: ya vale ${value}"; return 0; fi
  _atomic_replace_line "$key" "${key}=${value}" || return 1
  echo "+ ${key}: ${before} → ${value} (backup: .env.bak)"
}
# Default SOLO si la clave no existe (nunca pisa un valor puesto a mano; imprime solo el nombre).
ensure_env_default_if_absent() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then echo "✓ ${key} ya presente — no se toca"; else printf "\n%s=%s\n" "$key" "$value" >> .env; echo "+ ${key} agregado"; fi
}
# Agrega un id a una lista separada por comas (crea la clave si falta).
ensure_env_list_contains() {
  local key="$1" item="$2" count raw val
  count=$(grep -c "^${key}=" .env || true)
  if [ "$count" -eq 0 ]; then printf "\n%s=%s\n" "$key" "$item" >> .env; echo "+ ${key} agregado"; return 0; fi
  if [ "$count" -gt 1 ]; then echo "❌ ${key} aparece más de una vez en el .env — no se toca (revisar a mano)"; return 1; fi
  raw=$(grep "^${key}=" .env)
  val="${raw#"${key}"=}"
  case "$val" in *$'\r'|*\"*|*\'*|*"#"*) echo "❌ ${key} tiene CRLF, comillas o comentario — no se toca (agregar el owner a mano)"; return 1 ;; esac
  if [ -n "$val" ] && printf "%s" "$val" | tr "," "\n" | grep -qix "$item"; then echo "✓ ${key} ya incluye el owner canario"; return 0; fi
  if [ -z "$val" ]; then _atomic_replace_line "$key" "${key}=${item}" || return 1
  else _atomic_replace_line "$key" "${raw},${item}" || return 1; fi
  echo "+ owner canario agregado a ${key} (backup: .env.bak)"
}
# Secreto: se escribe sin imprimirse.
ensure_env_secret() {
  local key="$1" value="$2" count cur
  if [ -z "$value" ]; then echo "⚠️  ${key}: sin valor (falta el secret de GitHub) — no se toca"; return 0; fi
  count=$(grep -c "^${key}=" .env || true)
  if [ "$count" -gt 1 ]; then echo "❌ ${key} aparece más de una vez en el .env — no se toca"; return 1; fi
  cur=$(env_val "$key")
  if [ "$cur" = "$value" ]; then echo "✓ ${key}: sin cambios"; return 0; fi
  if [ "$count" -eq 0 ]; then printf "\n%s=%s\n" "$key" "$value" >> .env; echo "+ ${key}: configurado"; return 0; fi
  _atomic_replace_line "$key" "${key}=${value}" || return 1
  echo "+ ${key}: actualizado (backup: .env.bak)"
}

assert_env_production() {
  [ -f .env ] || die "Falta .env en $(pwd) — el .env de producción se crea a mano en el VPS (nunca por rsync)."
  if [ "$(env_val NODE_ENV)" = "production" ]; then
    echo "✓ NODE_ENV=production en el .env de producción"
  else
    die "El .env de producción NO tiene NODE_ENV=production — TypeORM synchronize quedaría activo y podría borrar columnas (I5, Fase 5A)."
  fi
}

# Compuerta: V2 encendido con allowlist vacía = V2 para TODOS los owners (isDynamicAllowedForOwner).
# $1 = owner canario que el deploy va a agregar ('' = ninguno), $2 = 'true' si el owner aprobó GA.
assert_v2_not_open_to_all() {
  local canary="$1" ga="$2" dcs allow
  dcs=$(env_val DYNAMIC_COURSE_STRUCTURE)
  allow=$(env_val DYNAMIC_V2_ALLOWED_OWNERS | tr -d '[:space:],')
  [ -n "$canary" ] && dcs=true && allow="$canary"
  if [ "$dcs" = "true" ] && [ -z "$allow" ]; then
    if [ "$ga" = "true" ]; then
      echo "⚠️  V2 ENCENDIDO PARA TODOS LOS OWNERS (PROD_V2_GENERAL_AVAILABILITY=true, decisión del owner)"
    else
      die "DYNAMIC_COURSE_STRUCTURE=true con DYNAMIC_V2_ALLOWED_OWNERS vacío = V2 abierto a TODOS los owners. Fijar el allowlist (o PROD_V2_CANARY_OWNER), o PROD_V2_GENERAL_AVAILABILITY=true si es una decisión explícita."
    fi
  elif [ "$dcs" = "true" ]; then
    echo "✓ V2 encendido SOLO para el allowlist ($(printf "%s" "$allow" | tr "," "\n" | grep -c . || true) owner(s))"
  else
    echo "✓ V2 apagado (DYNAMIC_COURSE_STRUCTURE ≠ 'true')"
  fi
  if [ "$(env_val DYNAMIC_REAL_VIDEO_ALL_OWNERS)" = "true" ]; then
    echo "⚠️  DYNAMIC_REAL_VIDEO_ALL_OWNERS=true en el .env: video real para todo owner con V2 (revisar)"
  fi
}

# ── PM2 ──────────────────────────────────────────────────────────────────────
ensure_pm2_process() {
  local name="$1"
  local start_script="$2"
  if $PM2 describe "$name" > /dev/null 2>&1; then
    $PM2 restart "$name" --update-env
  else
    $PM2 start npm --name "$name" -- run "$start_script"
  fi
}
# R16 (#1), mismo patrón que deploy-staging.yml: node directo (la señal llega a Node) + kill_timeout 300 s; un proceso
# heredado (npm run, kill_timeout 1,6 s) se recrea UNA vez; los deploys siguientes recargan (SIGINT → drenado).
ensure_pm2_drain_worker() {
  local name="$1"
  local script="$2"
  local rc=0
  if $PM2 describe "$name" > /dev/null 2>&1; then
    $PM2 jlist | node scripts/pm2-drain-config.js check "$name" "$script" "$DRAIN_KILL_TIMEOUT_MS" || rc=$?
    if [ "$rc" = "1" ]; then
      $PM2 delete "$name"
      $PM2 start "$script" --name "$name" --kill-timeout "$DRAIN_KILL_TIMEOUT_MS"
    else
      [ "$rc" = "0" ] || echo "⚠️ ${name}: no se pudo leer pm2 jlist (rc=${rc}); se recarga sin recrear"
      $PM2 reload "$name" --update-env
    fi
  else
    $PM2 start "$script" --name "$name" --kill-timeout "$DRAIN_KILL_TIMEOUT_MS"
  fi
}

# Lee `pm2 jlist` por stdin y SOLO imprime nombre/estado/reinicios de los procesos de producción.
#   snapshot <names…>          → JSON {name: restarts}
#   presence <names…>          → exit 1 si alguno falta o no está online
#   compare <snapshotJSON> <names…> → exit 1 si alguno no está online o se reinició (crash loop)
PM2_CHECK_JS='
const [mode, ...rest] = process.argv.slice(1);
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let list; try { list = JSON.parse(s); } catch (e) { console.log("pm2 jlist ilegible"); process.exit(2); }
  const snap = mode === "compare" ? JSON.parse(rest.shift()) : null;
  const snap0 = mode === "increased" ? JSON.parse(rest.shift()) : null;
  const want = rest;
  const by = Object.fromEntries(list.filter((p) => want.includes(p.name)).map((p) => [p.name, { status: p.pm2_env && p.pm2_env.status, restarts: Number(p.pm2_env && p.pm2_env.restart_time) }]));
  if (mode === "snapshot") { console.log(JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.restarts])))); return; }
  if (mode === "increased") { console.log(want.filter((n) => by[n] && snap0[n] !== undefined && by[n].restarts > snap0[n]).join(" ")); return; }
  let bad = 0;
  for (const n of want) {
    const p = by[n];
    let why = "";
    if (!p) why = "NO EXISTE";
    else if (p.status !== "online") why = "estado " + p.status;
    else if (snap && snap[n] !== undefined && p.restarts > snap[n]) why = "se reinició " + (p.restarts - snap[n]) + " vez/veces en la ventana";
    if (why) bad++;
    console.log((why ? "  ❌ " : "  ✓ ") + n.padEnd(34) + (p ? p.status + " restarts=" + p.restarts : "") + (why ? "  ← " + why : ""));
  }
  process.exit(bad ? 1 : 0);
});'
pm2_check() { $PM2 jlist | node -e "$PM2_CHECK_JS" "$@"; }

STOPPED_NAMES=()
ADVISORY_NAMES=()
_in_list() { local x="$1" y; shift; for y in "$@"; do [ "$y" = "$x" ] && return 0; done; return 1; }
# r61 fix I1: motivo por el que un worker V1 está deshabilitado por su propio flag (vacío = habilitado).
legacy_disabled_reason() {
  case "$1" in
    cursia-video-worker) [ "$(env_val VIDEO_WORKER_ENABLED | tr '[:upper:]' '[:lower:]')" = "true" ] || echo "VIDEO_WORKER_ENABLED ≠ true (el worker sale al arrancar)" ;;
    cursia-gamma-worker) [ -n "$(env_val GAMMA_API_KEY)" ] || echo "GAMMA_API_KEY vacío (el worker sale al arrancar)" ;;
  esac
  return 0
}
# r61 fix I1: workers V1 que YA se reiniciaban en bucle ANTES de este deploy (ventana corta, sin tocar nada) →
# su estabilidad es solo informativa: un problema preexistente no debe tumbar el deploy después del rsync.
PRELOOP_FILE=.release-preloop
detect_preexisting_loops() {
  local names=() entry n a inc age
  # r62 (re-review m2): la medición se hace en el PREFLIGHT, antes del rsync y sin tocar nada; install usa ese
  # resultado (si tiene menos de 1 h) y solo mide acá como respaldo.
  if [ "${1:-}" = "use-preflight" ] && [ -f "$PRELOOP_FILE" ]; then
    age=$(( $(date +%s) - $(stat -c %Y "$PRELOOP_FILE" 2>/dev/null || stat -f %m "$PRELOOP_FILE") ))
    if [ "$age" -lt 3600 ]; then
      for n in $(cat "$PRELOOP_FILE"); do
        _in_list "$n" "${PROD_ALL_NAMES[@]}" || continue
        ADVISORY_NAMES+=("$n")
        echo "⚠️  ${n} ya se reiniciaba en bucle ANTES del deploy (medido en el preflight): su estabilidad queda como aviso."
      done
      rm -f "$PRELOOP_FILE"
      echo "  (medición del preflight, hace ${age} s)"
      return 0
    fi
    rm -f "$PRELOOP_FILE"
  fi
  for entry in "${PROD_PROCESSES_LEGACY[@]}"; do
    n="${entry%% *}"
    [ -n "$(legacy_disabled_reason "$n")" ] || names+=("$n")
  done
  [ "${#names[@]}" -gt 0 ] || return 0
  a=$(pm2_check snapshot "${names[@]}") || return 0
  sleep "$PRELOOP_WINDOW_S"
  inc=$(pm2_check increased "$a" "${names[@]}") || inc=""
  for n in $inc; do
    ADVISORY_NAMES+=("$n")
    echo "⚠️  ${n} ya se reiniciaba en bucle ANTES del deploy: su estabilidad queda como aviso (no bloquea). Revisar su .env/logs."
  done
  if [ "${1:-}" = "save" ]; then
    { printf "%s\n" "$inc" > "$PRELOOP_FILE"; } 2>/dev/null || echo "⚠️  no se pudo guardar ${PRELOOP_FILE}: install mide como respaldo"
  fi
  return 0
}
reload_all_processes() {
  # $1 = install | rollback
  local mode="$1" entry name arg why
  $PM2 reload cursia-backend --update-env || $PM2 restart cursia-backend --update-env
  for entry in "${PROD_PROCESSES_LEGACY[@]}"; do
    name="${entry%% *}"
    why=$(legacy_disabled_reason "$name")
    if [ -n "$why" ]; then
      echo "⏸  ${name}: deshabilitado (${why}) — se detiene en vez de reiniciarse en bucle"
      if $PM2 describe "$name" > /dev/null 2>&1; then $PM2 stop "$name" || true; fi
      STOPPED_NAMES+=("$name")
      continue
    fi
    # shellcheck disable=SC2086
    ensure_pm2_process $entry
  done
  for entry in "${PROD_PROCESSES_DRAIN[@]}"; do
    name="${entry%% *}"; arg="${entry#* }"
    if [ "$mode" = "rollback" ] && [ ! -f scripts/pm2-drain-config.js ]; then
      # Release restaurada anterior al drenado (V1 de main): recargar el proceso existente tal cual.
      if [ ! -f "$arg" ]; then echo "⚠️ ${name}: ${arg} no existe en la release restaurada — se detiene"; $PM2 stop "$name" || true; STOPPED_NAMES+=("$name")
      elif $PM2 describe "$name" > /dev/null 2>&1; then $PM2 reload "$name" --update-env
      else $PM2 start "$arg" --name "$name" --kill-timeout "$DRAIN_KILL_TIMEOUT_MS"; fi
    else
      ensure_pm2_drain_worker "$name" "$arg"
    fi
  done
  $PM2 save
}

verify_processes() {
  local names=() adv=() n
  for n in "${PROD_ALL_NAMES[@]}"; do
    _in_list "$n" ${STOPPED_NAMES[@]+"${STOPPED_NAMES[@]}"} && continue
    if _in_list "$n" ${ADVISORY_NAMES[@]+"${ADVISORY_NAMES[@]}"}; then adv+=("$n"); else names+=("$n"); fi
  done
  [ "${#STOPPED_NAMES[@]}" -eq 0 ] || echo "  (detenidos a propósito, fuera de la presencia: ${STOPPED_NAMES[*]})"
  echo "━━━ Presencia de los ${#names[@]} procesos de producción esperados ━━━"
  pm2_check presence "${names[@]}" || die "faltan procesos de producción o no están online"
  echo "━━━ Estabilidad PM2 (ventana de ${STABILITY_WINDOW_S} s) ━━━"
  local before before_adv=""
  before=$(pm2_check snapshot "${names[@]}")
  [ "${#adv[@]}" -eq 0 ] || before_adv=$(pm2_check snapshot "${adv[@]}")
  sleep "$STABILITY_WINDOW_S"
  if [ "${#adv[@]}" -gt 0 ]; then
    pm2_check compare "$before_adv" "${adv[@]}" || echo "⚠️  inestables ya antes del deploy (aviso, no bloquea): ${adv[*]}"
  fi
  pm2_check compare "$before" "${names[@]}" || die "procesos inestables tras el deploy (crash loop) — evaluar rollback (workflow_dispatch action=rollback)"
}

# ── subcomandos ──────────────────────────────────────────────────────────────
cmd_preflight() {
  local dir="$1" canary="${2:-}" ga="${3:-false}"
  exec < /dev/null  # por stdin: ningún hijo debe leer el resto del script
  [ -n "$canary" ] && ! [[ "$canary" =~ $UUID_RE ]] && die "PROD_V2_CANARY_OWNER no es un UUID"
  case "$ga" in true|false) ;; *) die "PROD_V2_GENERAL_AVAILABILITY debe ser true|false" ;; esac
  cd "$dir" || die "no existe $dir"
  echo "━━━ Preflight de producción (solo lectura) ━━━"
  assert_env_production
  assert_v2_not_open_to_all "$canary" "$ga"
  echo "  release actual: $(cat .release-sha 2>/dev/null || echo '(anterior a r61, sin .release-sha)')  estado: $(cat .release-state 2>/dev/null || echo '(sin estado)')"
  echo "━━━ Workers V1 que ya se reinician en bucle (ventana de ${PRELOOP_WINDOW_S} s, ANTES del rsync) ━━━"
  if $PM2 jlist > /dev/null 2>&1; then detect_preexisting_loops save; else echo "⚠️  pm2 jlist no disponible: install mide como respaldo"; fi
  echo "  snapshot de rollback: $( [ -f .release-prev/dist/main.js ] && echo "presente ($(cat .release-prev/.release-sha 2>/dev/null || echo '?'))" || echo 'ninguno todavía')"
}

cmd_snapshot() {
  local dir="$1" sha="$2" state
  exec < /dev/null
  [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || die "sha inválido"
  cd "$dir" || die "no existe $dir"
  state=$(cat .release-state 2>/dev/null || echo none)
  if [ ! -f dist/main.js ]; then
    echo "⚠️  no hay release actual (sin dist/main.js): nada que guardar"
  else
    case "$state" in
      ok\ *|none)
        rm -rf .release-prev.tmp
        rsync -a --checksum --delete "${RELEASE_EXCLUDES[@]}" ./ .release-prev.tmp/
        # r61 fix M6: también node_modules (rollback sin depender del registro de npm). Comparación por
        # tamaño+mtime: npm reescribe lo que cambia.
        if [ -d node_modules ]; then rsync -a --delete node_modules/ .release-prev.tmp/node_modules/; fi
        cp .release-sha .release-prev.tmp/.release-sha 2>/dev/null || echo "pre-r61" > .release-prev.tmp/.release-sha
        rm -rf .release-prev
        mv .release-prev.tmp .release-prev
        echo "✓ release actual ($(cat .release-prev/.release-sha)) guardada en .release-prev/ (rollback)"
        ;;
      *)
        # deploying / failed / rolledback: la release en disco no está probada → no pisar el último snapshot sano.
        echo "⚠️  la release actual NO quedó marcada sana (estado: ${state}) — se conserva el .release-prev existente ($(cat .release-prev/.release-sha 2>/dev/null || echo 'ninguno'))"
        ;;
    esac
  fi
  echo "deploying ${sha}" > .release-state
}

CFG_KEYS="PROD_V2_CANARY_OWNER PROD_V2_WORKERS_ENABLED PROD_V2_LLM_WORKER_ENABLED PROD_V2_GENERAL_AVAILABILITY PROD_DB_POOL_MAX PROD_DB_POOL_MAX_WORKER PROD_DB_POOL_IDLE_MS_WORKER PROD_SKIP_STORAGE_POLICY_PROBE DEPLOY_SHA"
cmd_install() {
  local fit="" line key val
  local CFG_PROD_V2_CANARY_OWNER="" CFG_PROD_V2_WORKERS_ENABLED=false CFG_PROD_V2_GENERAL_AVAILABILITY=false
  local CFG_PROD_DB_POOL_MAX="" CFG_PROD_DB_POOL_MAX_WORKER="" CFG_PROD_DB_POOL_IDLE_MS_WORKER="" CFG_DEPLOY_SHA=""
  local CFG_PROD_SKIP_STORAGE_POLICY_PROBE=false CFG_PROD_V2_LLM_WORKER_ENABLED=false
  IFS= read -r fit || true
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    key="${line%%=*}"; val="${line#*=}"
    case " $CFG_KEYS " in *" $key "*) ;; *) die "clave de configuración desconocida: ${key}" ;; esac
    printf -v "CFG_${key}" "%s" "$val"
  done
  [ -n "$CFG_PROD_V2_CANARY_OWNER" ] && ! [[ "$CFG_PROD_V2_CANARY_OWNER" =~ $UUID_RE ]] && die "PROD_V2_CANARY_OWNER no es un UUID"
  for key in PROD_V2_WORKERS_ENABLED PROD_V2_LLM_WORKER_ENABLED PROD_V2_GENERAL_AVAILABILITY PROD_SKIP_STORAGE_POLICY_PROBE; do
    val="CFG_${key}"; case "${!val}" in true|false) ;; *) die "${key} debe ser true|false" ;; esac
  done
  for key in PROD_DB_POOL_MAX PROD_DB_POOL_MAX_WORKER PROD_DB_POOL_IDLE_MS_WORKER; do
    val="CFG_${key}"; [ -z "${!val}" ] || [[ "${!val}" =~ ^[0-9]{1,6}$ ]] || die "${key} debe ser un entero"
  done
  [[ "$CFG_DEPLOY_SHA" =~ ^[0-9a-f]{7,40}$ ]] || die "DEPLOY_SHA inválido"

  assert_env_production
  # r61 fix I1: si algo falla de acá en adelante (el código nuevo ya está en disco), el estado queda
  # «failed <sha>» — explícito para el operador y para el auto-rollback del workflow; el próximo snapshot
  # conserva la última release sana.
  trap 'rc=$?; if [ "$rc" -ne 0 ]; then echo "failed ${CFG_DEPLOY_SHA}" > .release-state; echo "❌ install falló (rc=${rc}): estado failed ${CFG_DEPLOY_SHA}; los procesos siguen como quedaron — rollback: workflow_dispatch action=rollback (o el auto-rollback del workflow)"; fi' EXIT

  echo "━━━ [0a] Flags V2 de producción (defaults SEGUROS: V2 apagado salvo canario explícito) ━━━"
  local canary="$CFG_PROD_V2_CANARY_OWNER" workers=false
  if [ -n "$canary" ]; then
    echo "  canario V2 configurado (PROD_V2_CANARY_OWNER): V2 SOLO para el allowlist"
    ensure_env_exact DYNAMIC_COURSE_STRUCTURE true
    ensure_env_list_contains DYNAMIC_V2_ALLOWED_OWNERS "$canary"
    ensure_env_exact DYNAMIC_MANIFEST_RULES_VERSION 3
    ensure_env_exact DYNAMIC_ACTIVITY_TYPE_RULES 2
    ensure_env_default_if_absent DYNAMIC_VIDEO_DELIVERY youtube
    ensure_env_default_if_absent PRESENTATION_LIGHT_DEFAULT_SINCE "$(now_utc)"
    ensure_env_default_if_absent DYNAMIC_PREBRIEF_REQUIRED_SINCE "$(now_utc)"
    ensure_env_default_if_absent GAMMA_THEME_V21_LIGHT_DEFAULT default-light
    ensure_env_default_if_absent GAMMA_THEME_V21_DARK_DEFAULT default-dark
    [ "$CFG_PROD_V2_WORKERS_ENABLED" = "true" ] && workers=true
  else
    echo "  sin PROD_V2_CANARY_OWNER: V2 queda como esté en el .env (default: apagado)"
    ensure_env_default_if_absent DYNAMIC_COURSE_STRUCTURE false
  fi
  if [ "$(env_val DYNAMIC_WORKERS_HOLD | tr '[:upper:]' '[:lower:]')" = "true" ]; then
    workers=false
    echo "⚠ DYNAMIC_WORKERS_HOLD=true: workers de proveedores y de IA quedan APAGADOS"
  fi
  # Los workers de gasto (proveedores reales + IA hospedada) se fijan SIEMPRE: encendidos solo con canario + opt-in.
  ensure_env_exact DYNAMIC_PROVIDER_WORKER_ENABLED "$workers"
  # r62 d9: worker de IA HOSPEDADO en cursia-dynamic-provider-worker (como staging, sin un 12.º proceso ni otra
  # conexión al pooler): las partes LLM ya no dependen de una pestaña abierta. Variable propia, apagada por
  # defecto; requiere el worker de proveedores encendido (el anfitrión queda inactivo sin él).
  local llm=false llm_before
  llm_before=$(env_val DYNAMIC_LLM_WORKER_ENABLED)
  if [ "$CFG_PROD_V2_LLM_WORKER_ENABLED" = "true" ]; then
    if [ "$workers" = "true" ]; then llm=true
    else echo "⚠️  PROD_V2_LLM_WORKER_ENABLED=true sin el worker de proveedores encendido (canario + PROD_V2_WORKERS_ENABLED, sin DYNAMIC_WORKERS_HOLD): el worker de IA hospedado queda APAGADO"; fi
  fi
  ensure_env_exact DYNAMIC_LLM_WORKER_ENABLED "$llm"
  if [ "$llm" = "true" ]; then
    # Instante de activación: solo los runs creados desde acá van al worker (ninguno anterior cambia). Se fija de
    # nuevo en cada transición apagado → encendido: un instante viejo le pasaría al worker los runs creados mientras
    # estuvo apagado (que ya ejecuta el navegador). Encendido → encendido: se conserva.
    if [ "$llm_before" = "true" ]; then ensure_env_default_if_absent DYNAMIC_LLM_WORKER_SINCE "$(now_utc)"
    else ensure_env_exact DYNAMIC_LLM_WORKER_SINCE "$(now_utc)"; fi
    # Default 4 como staging; un ajuste manual (1..6) se respeta.
    ensure_env_default_if_absent DYNAMIC_LLM_WORKER_CONCURRENCY 4
  fi
  compute_drain_timeouts
  ensure_env_exact DYNAMIC_WORKER_DRAIN_TIMEOUT_MS "$DRAIN_TIMEOUT_MS"
  echo "  drenado de los workers dinámicos: kill_timeout ${DRAIN_KILL_TIMEOUT_MS} ms, tope interno ${DRAIN_TIMEOUT_MS} ms"
  if grep -q "^DYNAMIC_COHERENCE_LLM=" .env; then echo "⚠️  DYNAMIC_COHERENCE_LLM está en el .env — no se toca"; else echo "✓ DYNAMIC_COHERENCE_LLM ausente (OFF)"; fi
  assert_v2_not_open_to_all "" "$CFG_PROD_V2_GENERAL_AVAILABILITY"

  echo "━━━ [0b] TTS, FinOps y pool de la base ━━━"
  # r59: el alias gpt-4o-mini-tts se cuelga ~45 % de las veces; el snapshot fijo no.
  ensure_env_exact OPENAI_TTS_MODEL "$TTS_SNAPSHOT"
  ensure_env_secret FINOPS_INGEST_TOKEN "$fit"
  if [ -n "$canary" ] && [ -z "$(env_val FINOPS_INGEST_TOKEN)" ]; then
    echo "⚠️  canario V2 sin FINOPS_INGEST_TOKEN: el ingest de uso del navegador queda rechazado (secret FINOPS_INGEST_TOKEN_PRODUCTION)"
  fi
  local pk pv
  for pk in DB_POOL_MAX DB_POOL_MAX_WORKER DB_POOL_IDLE_MS_WORKER; do
    pv="CFG_PROD_${pk}"
    if [ -n "${!pv}" ]; then ensure_env_exact "$pk" "${!pv}"
    elif grep -q "^${pk}=" .env; then echo "✓ ${pk} presente (valor manual) — no se toca"
    else echo "⚠️  ${pk} ausente: default del código (DB_POOL_MAX=5 por proceso × ${#PROD_ALL_NAMES[@]} procesos) — dimensionar contra el pooler de producción (variable PROD_${pk})"; fi
  done

  echo "━━━ [0c] poppler-utils (pdftoppm — portadas de Gamma) ━━━"
  command -v pdftoppm > /dev/null 2>&1 || sudo apt-get install -y poppler-utils

  echo "━━━ [0d] Procesos V1 que ya se reiniciaban en bucle ANTES del deploy (ventana de ${PRELOOP_WINDOW_S} s, solo lectura) ━━━"
  detect_preexisting_loops use-preflight

  echo "━━━ [1/4] Instalar dependencias de producción ━━━"
  npm install --omit=dev

  echo "━━━ [2/4] Alinear restricciones de production_jobs ━━━"
  node scripts/migrate-production-jobs-constraints.js

  echo "━━━ [3/4] Migrar usage_events y cost_rates ━━━"
  node scripts/migrate-usage-events-costs.js

  echo "━━━ [4/4] Recargar PM2 (backend zero-downtime; V1 igual que antes; workers dinámicos con drenado) ━━━"
  printf "%s\n" "$CFG_DEPLOY_SHA" > .release-sha
  reload_all_processes install
  verify_processes

  echo "━━━ Base: conectividad + esquema V2 (sondas de solo lectura, .env de producción) ━━━"
  local probe_args=()
  if [ "$CFG_PROD_SKIP_STORAGE_POLICY_PROBE" = "true" ]; then
    probe_args=(--skip-storage-policies)
    echo "⚠️  PROD_SKIP_STORAGE_POLICY_PROBE=true: no se verifican las políticas de storage.objects (apply con --skip-storage-policies)"
  fi
  node scripts/prod/v2-schema-probes.js ${probe_args[@]+"${probe_args[@]}"} || die "la base no responde o el esquema V2 no está completo"
  echo "✅ Deploy de producción instalado (${CFG_DEPLOY_SHA})."
}

cmd_mark_ok() {
  local dir="$1" sha="$2"
  exec < /dev/null
  cd "$dir" || die "no existe $dir"
  # «restored»: tras un rollback, la release restaurada (su .release-sha; pre-r61 si era anterior a r61).
  [ "$sha" = "restored" ] && sha=$(cat .release-sha 2>/dev/null || echo pre-r61)
  [[ "$sha" =~ ^([0-9a-f]{7,40}|pre-r61)$ ]] || die "sha inválido"
  echo "ok ${sha}" > .release-state
  echo "✓ release ${sha} marcada sana (base del próximo snapshot de rollback)"
}

# r62 (review I2): antes del auto-rollback con ítems en vuelo, los 3 workers dinámicos se DETIENEN con drenado
# (SIGINT: dejan de reclamar; lo en vuelo termina o se devuelve en un punto sin gasto; PM2 espera su
# kill_timeout). El workflow vuelve a consultar y solo revierte si ya no queda nada reclamado.
cmd_drain_dynamic() {
  local dir="$1" entry name
  exec < /dev/null
  cd "$dir" || die "no existe $dir"
  compute_drain_timeouts
  echo "━━━ Drenado de los workers dinámicos antes del rollback (kill_timeout hasta ${DRAIN_KILL_TIMEOUT_MS} ms) ━━━"
  for entry in "${PROD_PROCESSES_DRAIN[@]}"; do
    name="${entry%% *}"
    if $PM2 describe "$name" > /dev/null 2>&1; then $PM2 stop "$name"; echo "  ⏸ ${name} drenado y detenido"; fi
  done
}

cmd_rollback() {
  local dir="$1" prev
  exec < /dev/null
  cd "$dir" || die "no existe $dir"
  [ -f .release-prev/dist/main.js ] || die "no hay snapshot de rollback (.release-prev/dist/main.js). Rollback manual: ver docs/v2-production-promotion-runbook.md §Rollback."
  assert_env_production
  prev=$(cat .release-prev/.release-sha 2>/dev/null || echo unknown)
  echo "━━━ Rollback de producción → ${prev} (actual: $(cat .release-sha 2>/dev/null || echo '?')) ━━━"
  rm -rf .release-failed
  rsync -a --checksum --delete "${RELEASE_EXCLUDES[@]}" ./ .release-failed/
  cp .release-sha .release-failed/.release-sha 2>/dev/null || true
  echo "  release fallida copiada a .release-failed/ (diagnóstico)"
  rsync -a --checksum --delete "${RELEASE_EXCLUDES[@]}" .release-prev/ ./
  cp .release-prev/.release-sha .release-sha
  echo "rolledback ${prev}" > .release-state
  if [ -d .release-prev/node_modules ]; then
    echo "━━━ node_modules de la release restaurada (desde el snapshot, sin npm) ━━━"
    rsync -a --delete .release-prev/node_modules/ ./node_modules/
  else
    echo "━━━ npm install --omit=dev (snapshot sin node_modules: depende del registro de npm) ━━━"
    npm install --omit=dev
  fi
  echo "━━━ SIN migraciones: el esquema V2 es aditivo (el CHECK de main fallaría con filas dynamic, N1) ━━━"
  compute_drain_timeouts
  detect_preexisting_loops
  reload_all_processes rollback
  verify_processes
  echo "✅ Rollback instalado (${prev}). El workflow marca la release sana tras el health check."
}

main() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    preflight) [ $# -ge 1 ] || die "uso: preflight <dir> [canary] [ga]"; cmd_preflight "$@" ;;
    snapshot) [ $# -eq 2 ] || die "uso: snapshot <dir> <sha>"; cmd_snapshot "$@" ;;
    install) cmd_install ;;
    mark-ok) [ $# -eq 2 ] || die "uso: mark-ok <dir> <sha|restored>"; cmd_mark_ok "$@" ;;
    rollback) [ $# -eq 1 ] || die "uso: rollback <dir>"; cmd_rollback "$1" ;;
    drain-dynamic) [ $# -eq 1 ] || die "uso: drain-dynamic <dir>"; cmd_drain_dynamic "$1" ;;
    *) die "subcomando desconocido: '${sub}' (preflight|snapshot|install|mark-ok|rollback|drain-dynamic)" ;;
  esac
}

# Permite `source` en los tests sin ejecutar main.
if [ "${PROD_RELEASE_SOURCE_ONLY:-}" != "1" ]; then main "$@"; fi
