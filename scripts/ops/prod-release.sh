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
#       Restaura <dir>/.release-prev/ (copia la release fallida a .release-failed/ para
#       diagnóstico), npm install --omit=dev, recarga PM2. NO corre migraciones: el esquema
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
TTS_SNAPSHOT=gpt-4o-mini-tts-2025-03-20
STABILITY_WINDOW_S="${PROD_STABILITY_WINDOW_S:-45}"
UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
RELEASE_EXCLUDES=(--exclude node_modules --exclude .env --exclude '.env.*' --exclude '.release-*')
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
  local key="$1" new="$2" tmp before after
  tmp=".env.flags.tmp.$$"
  awk -v k="$key" -v v="$new" 'BEGIN{p=k "="} index($0,p)==1 && !d {print v; d=1; next} {print}' .env > "$tmp"
  before=$(awk 'END{print NR}' .env)
  after=$(awk 'END{print NR}' "$tmp")
  if [ ! -s "$tmp" ] || [ "$before" != "$after" ]; then
    rm -f "$tmp"
    echo "❌ ${key}: la reescritura del .env no validó — se aborta sin tocar .env"
    return 1
  fi
  cp .env .env.bak
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
  const want = rest;
  const by = Object.fromEntries(list.filter((p) => want.includes(p.name)).map((p) => [p.name, { status: p.pm2_env && p.pm2_env.status, restarts: Number(p.pm2_env && p.pm2_env.restart_time) }]));
  if (mode === "snapshot") { console.log(JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.restarts])))); return; }
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
reload_all_processes() {
  # $1 = install | rollback
  local mode="$1" entry name arg
  $PM2 reload cursia-backend --update-env || $PM2 restart cursia-backend --update-env
  for entry in "${PROD_PROCESSES_LEGACY[@]}"; do
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
  local names=() n s skip
  for n in "${PROD_ALL_NAMES[@]}"; do
    skip=0
    for s in ${STOPPED_NAMES[@]+"${STOPPED_NAMES[@]}"}; do [ "$s" = "$n" ] && skip=1; done
    [ "$skip" = 1 ] || names+=("$n")
  done
  echo "━━━ Presencia de los ${#names[@]} procesos de producción ━━━"
  pm2_check presence "${names[@]}" || die "faltan procesos de producción o no están online"
  echo "━━━ Estabilidad PM2 (ventana de ${STABILITY_WINDOW_S} s) ━━━"
  local before
  before=$(pm2_check snapshot "${names[@]}")
  sleep "$STABILITY_WINDOW_S"
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
        cp .release-sha .release-prev.tmp/.release-sha 2>/dev/null || echo "pre-r61" > .release-prev.tmp/.release-sha
        rm -rf .release-prev
        mv .release-prev.tmp .release-prev
        echo "✓ release actual ($(cat .release-prev/.release-sha)) guardada en .release-prev/ (rollback)"
        ;;
      *)
        echo "⚠️  la release actual NO quedó marcada sana (estado: ${state}) — se conserva el .release-prev existente ($(cat .release-prev/.release-sha 2>/dev/null || echo 'ninguno'))"
        ;;
    esac
  fi
  echo "deploying ${sha}" > .release-state
}

CFG_KEYS="PROD_V2_CANARY_OWNER PROD_V2_WORKERS_ENABLED PROD_V2_GENERAL_AVAILABILITY PROD_DB_POOL_MAX PROD_DB_POOL_MAX_WORKER PROD_DB_POOL_IDLE_MS_WORKER DEPLOY_SHA"
cmd_install() {
  local fit="" line key val
  local CFG_PROD_V2_CANARY_OWNER="" CFG_PROD_V2_WORKERS_ENABLED=false CFG_PROD_V2_GENERAL_AVAILABILITY=false
  local CFG_PROD_DB_POOL_MAX="" CFG_PROD_DB_POOL_MAX_WORKER="" CFG_PROD_DB_POOL_IDLE_MS_WORKER="" CFG_DEPLOY_SHA=""
  IFS= read -r fit || true
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    key="${line%%=*}"; val="${line#*=}"
    case " $CFG_KEYS " in *" $key "*) ;; *) die "clave de configuración desconocida: ${key}" ;; esac
    printf -v "CFG_${key}" "%s" "$val"
  done
  [ -n "$CFG_PROD_V2_CANARY_OWNER" ] && ! [[ "$CFG_PROD_V2_CANARY_OWNER" =~ $UUID_RE ]] && die "PROD_V2_CANARY_OWNER no es un UUID"
  for key in PROD_V2_WORKERS_ENABLED PROD_V2_GENERAL_AVAILABILITY; do
    val="CFG_${key}"; case "${!val}" in true|false) ;; *) die "${key} debe ser true|false" ;; esac
  done
  for key in PROD_DB_POOL_MAX PROD_DB_POOL_MAX_WORKER PROD_DB_POOL_IDLE_MS_WORKER; do
    val="CFG_${key}"; [ -z "${!val}" ] || [[ "${!val}" =~ ^[0-9]{1,6}$ ]] || die "${key} debe ser un entero"
  done
  [[ "$CFG_DEPLOY_SHA" =~ ^[0-9a-f]{7,40}$ ]] || die "DEPLOY_SHA inválido"

  assert_env_production

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
  if grep -q "^DYNAMIC_WORKERS_HOLD=true$" .env; then
    workers=false
    echo "⚠ DYNAMIC_WORKERS_HOLD=true: workers de proveedores y de IA quedan APAGADOS"
  fi
  # Los workers de gasto (proveedores reales + IA hospedada) se fijan SIEMPRE: encendidos solo con canario + opt-in.
  ensure_env_exact DYNAMIC_PROVIDER_WORKER_ENABLED "$workers"
  ensure_env_exact DYNAMIC_LLM_WORKER_ENABLED "$workers"
  if [ "$workers" = "true" ]; then
    ensure_env_default_if_absent DYNAMIC_LLM_WORKER_SINCE "$(now_utc)"
    ensure_env_default_if_absent DYNAMIC_LLM_WORKER_CONCURRENCY 4
  fi
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
  node scripts/prod/v2-schema-probes.js || die "la base no responde o el esquema V2 no está completo"
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
  echo "━━━ npm install --omit=dev (dependencias de la release restaurada) ━━━"
  npm install --omit=dev
  echo "━━━ SIN migraciones: el esquema V2 es aditivo (el CHECK de main fallaría con filas dynamic, N1) ━━━"
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
    *) die "subcomando desconocido: '${sub}' (preflight|snapshot|install|mark-ok|rollback)" ;;
  esac
}

# Permite `source` en los tests sin ejecutar main.
if [ "${PROD_RELEASE_SOURCE_ONLY:-}" != "1" ]; then main "$@"; fi
