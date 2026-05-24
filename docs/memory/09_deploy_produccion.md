# 09 — Deploy en producción

---

## Arquitectura de deploy

```
Cloudflare Pages          Contabo VPS              Supabase
cursia.nomaddi.com   →   api.cursia.nomaddi.com   →  PostgreSQL
(frontend estático)       (NestJS / PM2 / Nginx)       (DB + Auth)
```

---

## Frontend

- **Plataforma**: Cloudflare Pages
- **URL**: `https://cursia.nomaddi.com`
- **Repo**: `campuscloud-gen`
- **Deploy**: automático en cada push a `main`
- **Estado**: ✅ activo

---

## Backend

- **Plataforma**: VPS Contabo (Ubuntu)
- **URL objetivo**: `https://api.cursia.nomaddi.com`
- **Repo**: `orbia-backend` (branch `main`)
- **Path en VPS**: `/var/www/cursia-backend`
- **Process manager**: PM2 (`cursia-backend`)
- **Reverse proxy**: Nginx
- **SSL**: Certbot / Let's Encrypt
- **Estado**: 🔄 pendiente de ejecutar

---

## Pasos de deploy (resumen)

### Paso 0 — Pre-requisito: SQL en Supabase
Ejecutar `docs/SCHEMA_SUPABASE.sql` en Supabase SQL Editor **antes** de arrancar el backend.

### Paso 1 — VPS
```bash
ssh root@IP_VPS
apt update && apt upgrade -y
adduser cursia && usermod -aG sudo cursia
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
apt install -y curl git build-essential nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
npm install -g pm2
```

### Paso 2 — DNS
Crear registro A en panel DNS:
- Nombre: `api.cursia`
- Valor: `IP_DEL_VPS`
- Verificar con `dig api.cursia.nomaddi.com`

### Paso 3 — Código y configuración
```bash
su - cursia
sudo mkdir -p /var/www/cursia-backend && sudo chown cursia:cursia /var/www/cursia-backend
cd /var/www/cursia-backend
git clone https://github.com/nicolasmoreno2914/cursia-backend.git .
# Crear .env desde .env.production.template con valores reales
nano .env && chmod 600 .env
npm install --omit=dev && npm run build
```

### Paso 4 — PM2
```bash
pm2 start dist/main.js --name cursia-backend --env production --max-memory-restart 512M
pm2 save && pm2 startup  # seguir instrucciones que muestre
curl http://localhost:3000/health  # debe responder {"status":"ok"}
```

### Paso 5 — Nginx
Crear `/etc/nginx/sites-available/api.cursia.nomaddi.com`:
```nginx
server {
    listen 80;
    server_name api.cursia.nomaddi.com;
    client_max_body_size 100M;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/api.cursia.nomaddi.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Paso 6 — SSL
```bash
sudo certbot --nginx -d api.cursia.nomaddi.com
curl https://api.cursia.nomaddi.com/health  # debe funcionar
```

---

## CI/CD con GitHub Actions

Archivo: `.github/workflows/deploy.yml`

**Secrets requeridos en GitHub** (Settings → Secrets → Actions):

| Secret | Valor |
|---|---|
| `VPS_HOST` | IP pública del VPS |
| `VPS_USER` | `cursia` |
| `VPS_SSH_KEY` | Clave privada SSH completa |
| `VPS_PATH` | `/var/www/cursia-backend` |
| `HEALTH_URL` | `https://api.cursia.nomaddi.com/health` |

Flujo del workflow: build check → SSH al VPS → `git pull` → `npm ci` → `npm run build` → `pm2 reload` → health check.

**Activar CI/CD solo después de que el deploy manual esté funcionando.**

---

## Deploy manual futuro (sin CI/CD)
```bash
cd /var/www/cursia-backend && bash scripts/deploy.sh
```
O manualmente:
```bash
git pull origin main && npm ci --omit=dev && npm run build && pm2 reload cursia-backend
```

---

## Checklist de validación producción

- [ ] DNS propagado: `dig api.cursia.nomaddi.com` → IP del VPS
- [ ] PM2: `pm2 status` → cursia-backend online
- [ ] `GET /health` → `{"status":"ok","environment":"production"}`
- [ ] `GET /api/v1/auth/me` sin token → 401
- [ ] `GET /api/v1/auth/me` con token válido → 200
- [ ] `POST /api/v1/courses` → crea curso
- [ ] `NODE_ENV=production` en proceso
- [ ] `ALLOW_UNOWNED_COURSES=false`
- [ ] `.env` con permisos 600
- [ ] No hay secretos en el repo Git
- [ ] CORS: request desde `cursia.nomaddi.com` funciona sin error
- [ ] YouTube OAuth: flujo completo sin `redirect_uri_mismatch`
- [ ] Frontend activa backend con `localStorage` y Cloud Save funciona

---

## Advertencias críticas

- ⚠️ No usar `synchronize:true` permanentemente en producción
- ⚠️ Ejecutar `SCHEMA_SUPABASE.sql` antes de arrancar el backend por primera vez
- ⚠️ No commitear `.env` con valores reales a GitHub
- ⚠️ Usar Direct connection o Session Pooler de Supabase (puerto 5432), NO Transaction Pooler (6543)
- ⚠️ Activar GitHub Actions solo después de deploy manual exitoso y validado

---

## Troubleshooting rápido

| Error | Causa probable | Fix |
|---|---|---|
| 502 Bad Gateway | PM2 caído o puerto 3000 no responde | `pm2 restart cursia-backend; pm2 logs` |
| 401 en todos los endpoints | `SUPABASE_URL` incorrecto | Verificar JWKS accesible; `pm2 restart` |
| CORS error | `CORS_ORIGIN` no coincide | Actualizar `.env`, `pm2 restart` |
| DB connection error | Credenciales o SSL | `psql` manual para probar; revisar `DB_SSL=true` |
| `redirect_uri_mismatch` YT | URI Google Cloud ≠ `YOUTUBE_REDIRECT_URI` | Editar Google Cloud Console exactamente |
| PM2 no arranca tras reboot | Startup no configurado | `pm2 startup` + copiar el comando que muestre |
