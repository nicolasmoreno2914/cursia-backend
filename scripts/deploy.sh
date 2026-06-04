#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# deploy.sh — Deploy manual en VPS Contabo
# Uso: bash scripts/deploy.sh
# Ejecutar desde el VPS como usuario cursia, en /var/www/cursia-backend
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

APP_DIR="/var/www/cursia-backend"
APP_NAME="cursia-backend"
HEALTH_URL="https://api.cursia.nomaddi.com/health"
BRANCH="main"

# ── Colores ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

ensure_pm2_process() {
  local name="$1"
  local start_script="$2"

  if pm2 describe "$name" > /dev/null 2>&1; then
    pm2 restart "$name" --update-env
    success "PM2 restart OK: $name"
  else
    pm2 start npm --name "$name" -- run "$start_script"
    success "PM2 start OK: $name"
  fi
}

# ── Verificar directorio ──────────────────────────────────────────────────────
cd "$APP_DIR" || error "No se puede entrar a $APP_DIR"
info "Directorio: $(pwd)"

# ── 1. Verificar rama ─────────────────────────────────────────────────────────
CURRENT_BRANCH=$(git branch --show-current)
info "Rama actual: $CURRENT_BRANCH"
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  warn "No estás en $BRANCH. Cambiando..."
  git checkout "$BRANCH"
fi

# ── 2. Git pull ───────────────────────────────────────────────────────────────
info "[1/5] git pull origin $BRANCH..."
git pull origin "$BRANCH"
success "Código actualizado."

# ── 3. Instalar dependencias ──────────────────────────────────────────────────
info "[2/6] npm install..."
npm install
success "Dependencias instaladas (incluyendo devDeps para build)."

# ── 4. Build ──────────────────────────────────────────────────────────────────
info "[3/6] npm run build..."
npm run build
[ -f dist/main.js ] || error "dist/main.js no encontrado. Build falló."
success "Build OK."

# ── 5. Limpiar devDeps ────────────────────────────────────────────────────────
info "[4/6] npm ci --omit=dev..."
npm ci --omit=dev
success "Dependencias de producción listas."

# ── 6. Reiniciar PM2 ─────────────────────────────────────────────────────────
info "[5/6] Reiniciando PM2..."
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  pm2 reload "$APP_NAME" --update-env
  success "PM2 reload OK (graceful)."
else
  warn "Proceso PM2 no encontrado. Iniciando desde cero..."
  pm2 start dist/main.js --name "$APP_NAME" --env production --max-memory-restart 512M
  success "PM2 iniciado."
fi

ensure_pm2_process "cursia-content-worker" "start:content-worker"
ensure_pm2_process "cursia-video-worker" "start:video-worker"
ensure_pm2_process "cursia-audio-worker" "start:audio-worker"
ensure_pm2_process "cursia-h5p-worker" "start:h5p-worker"
ensure_pm2_process "cursia-package-worker" "start:package-worker"
ensure_pm2_process "cursia-full-worker" "start:full-worker"

pm2 save

# ── 7. Health check ───────────────────────────────────────────────────────────
info "[6/6] Health check en $HEALTH_URL..."
sleep 5
RESPONSE=$(curl -sf --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "FAILED")
if echo "$RESPONSE" | grep -q '"status":"ok"'; then
  success "Health check OK: $RESPONSE"
else
  error "Health check FALLÓ. Respuesta: $RESPONSE\nRevisar: pm2 logs $APP_NAME"
fi

echo ""
success "═══ Deploy completado correctamente ═══"
echo ""
pm2 status
