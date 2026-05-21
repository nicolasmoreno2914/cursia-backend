# Guía de despliegue — Cursia Backend en Contabo + Supabase

> **Versión**: 1.0 — Mayo 2026  
> **Stack**: NestJS 11 · TypeORM · Supabase PostgreSQL · Nginx · PM2 · Certbot  
> **Dominio backend**: `https://api.cursia.nomaddi.com`  
> **Dominio frontend**: `https://cursia.nomaddi.com`

---

## Tabla de contenidos

1. [Arquitectura](#1-arquitectura)
2. [Requisitos previos](#2-requisitos-previos)
3. [Preparar el VPS en Contabo](#3-preparar-el-vps-en-contabo)
4. [DNS — Crear el subdominio](#4-dns--crear-el-subdominio)
5. [Instalar Node.js, Nginx y herramientas](#5-instalar-nodejs-nginx-y-herramientas)
6. [Clonar el repositorio](#6-clonar-el-repositorio)
7. [Variables de entorno en producción](#7-variables-de-entorno-en-producción)
8. [Conexión a Supabase PostgreSQL](#8-conexión-a-supabase-postgresql)
9. [Synchronize vs Migraciones](#9-synchronize-vs-migraciones)
10. [Build y arranque con PM2](#10-build-y-arranque-con-pm2)
11. [Configurar Nginx (reverse proxy)](#11-configurar-nginx-reverse-proxy)
12. [SSL con Certbot](#12-ssl-con-certbot)
13. [CORS](#13-cors)
14. [YouTube OAuth — Google Cloud Console](#14-youtube-oauth--google-cloud-console)
15. [Supabase Auth / JWT](#15-supabase-auth--jwt)
16. [Seguridad básica](#16-seguridad-básica)
17. [Activar el backend desde el frontend](#17-activar-el-backend-desde-el-frontend)
18. [Checklist de validación producción](#18-checklist-de-validación-producción)
19. [Actualizaciones futuras](#19-actualizaciones-futuras)
20. [Troubleshooting](#20-troubleshooting)
21. [Opción Docker (alternativa)](#21-opción-docker-alternativa)

---

## 1. Arquitectura

```
Usuario
  │
  ▼
https://cursia.nomaddi.com        ← Frontend (Cloudflare Pages)
  │
  │  Llama a la API con JWT de Supabase
  ▼
https://api.cursia.nomaddi.com    ← Nginx (HTTPS, reverse proxy)
  │
  ▼
http://127.0.0.1:3000             ← NestJS en PM2 (VPS Contabo)
  │
  ├──▶ Supabase Auth JWKS         ← Valida tokens JWT (ES256)
  │     https://<project>.supabase.co/auth/v1/.well-known/jwks.json
  │
  └──▶ Supabase PostgreSQL        ← Base de datos
        db.<project>.supabase.co:5432
```

**Responsabilidades de cada capa:**

| Capa | Responsabilidad |
|---|---|
| **Cloudflare Pages** | Sirve el frontend estático |
| **Contabo VPS** | Ejecuta el backend NestJS |
| **Nginx** | Termina TLS, reverse proxy al puerto 3000 |
| **PM2** | Mantiene vivo el proceso Node.js, auto-restart |
| **Supabase Auth** | Emite y valida tokens JWT (JWKS/ES256) |
| **Supabase PostgreSQL** | Almacena cursos, versiones, conexiones YouTube, eventos |

> **El VPS de Contabo NO es la base de datos.** Solo ejecuta la API.  
> **Supabase sigue siendo la única base de datos.**

---

## 2. Requisitos previos

Antes de empezar necesitas tener:

- [ ] Acceso SSH al VPS Contabo (IP pública conocida)
- [ ] Dominio `nomaddi.com` con acceso al panel DNS
- [ ] Proyecto Supabase activo (`hriwbakbuypaiovvvkqh.supabase.co`)
- [ ] Credenciales de la DB Supabase (en Supabase Dashboard → Project Settings → Database)
- [ ] Credenciales de YouTube OAuth (Google Cloud Console)
- [ ] Token de acceso a GitHub (o repo público)

---

## 3. Preparar el VPS en Contabo

### 3.1 Conectarse por SSH

```bash
ssh root@IP_DEL_SERVIDOR
```

Reemplaza `IP_DEL_SERVIDOR` con la IP pública de tu VPS en Contabo.

### 3.2 Actualizar el sistema

```bash
apt update && apt upgrade -y
```

### 3.3 Crear usuario no-root (recomendado)

No corras el backend como `root`. Crea un usuario dedicado:

```bash
adduser cursia
usermod -aG sudo cursia
# Copiar clave SSH si ya la tienes configurada para root
rsync --archive --chown=cursia:cursia ~/.ssh /home/cursia
```

A partir de aquí, puedes trabajar como `cursia`:

```bash
su - cursia
# o en una nueva sesión SSH:
ssh cursia@IP_DEL_SERVIDOR
```

### 3.4 Configurar firewall (UFW)

```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw enable
ufw status
```

> **Solo expones 22, 80 y 443.** El puerto 3000 del backend NO debe ser público.
> Nginx actúa como intermediario — el backend solo escucha en `127.0.0.1:3000`.

### 3.5 Instalar herramientas base

```bash
sudo apt install -y curl git build-essential nginx certbot python3-certbot-nginx
```

### 3.6 Configurar swap (si el VPS tiene ≤ 2 GB RAM)

El build de TypeScript puede consumir bastante memoria. Con poca RAM, configura swap:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Verifica:

```bash
free -h
```

---

## 4. DNS — Crear el subdominio

### 4.1 Crear registro A

En tu panel DNS (Cloudflare, Namecheap, etc.) para el dominio `nomaddi.com`:

| Tipo | Nombre | Valor | TTL |
|---|---|---|---|
| A | `api.cursia` | `IP_DEL_VPS` | Auto |

Esto crea `api.cursia.nomaddi.com → IP_DEL_VPS`.

### 4.2 Si usas Cloudflare

Para el subdominio `api.cursia.nomaddi.com`:

- **Para Certbot con Nginx**: desactiva el proxy de Cloudflare (nube gris) temporalmente mientras instalas el certificado. Luego puedes reactivarlo si lo deseas.
- **Con proxy activado (nube naranja)**: Certbot puede fallar porque Cloudflare termina el TLS. En ese caso usa el modo DNS challenge de Certbot o deja el proxy desactivado.

**Recomendación para empezar**: déjalo en **DNS only** (nube gris). Si luego quieres el proxy de Cloudflare, actívalo después de que SSL funcione.

### 4.3 Verificar propagación DNS

```bash
ping api.cursia.nomaddi.com
dig api.cursia.nomaddi.com
```

El resultado de `dig` debe mostrar la IP del VPS. La propagación puede tardar de 1 a 30 minutos.

---

## 5. Instalar Node.js, Nginx y herramientas

### 5.1 Instalar Node.js 22 LTS (via NodeSource)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # debe mostrar v22.x.x
npm --version
```

> **¿Por qué Node 22?** Es la versión LTS activa. El backend usa NestJS 11 y es compatible.
> Si prefieres nvm para gestionar versiones múltiples, ver al final de esta sección.

### 5.2 Alternativa con nvm (opcional)

Si quieres manejar múltiples versiones de Node:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
nvm alias default 22
node --version
```

### 5.3 Instalar PM2 globalmente

```bash
sudo npm install -g pm2
pm2 --version
```

### 5.4 Verificar Nginx

```bash
sudo systemctl status nginx
# Si no está activo:
sudo systemctl start nginx
sudo systemctl enable nginx
```

---

## 6. Clonar el repositorio

### 6.1 Crear el directorio de trabajo

```bash
sudo mkdir -p /var/www/cursia-backend
sudo chown cursia:cursia /var/www/cursia-backend
cd /var/www/cursia-backend
```

### 6.2 Clonar el repo

```bash
git clone https://github.com/nicolasmoreno2914/orbia-backend.git .
```

Si el repo es privado, necesitarás autenticación. Opciones:
- **HTTPS con token**: `git clone https://<TOKEN>@github.com/nicolasmoreno2914/orbia-backend.git .`
- **SSH key**: genera una clave SSH para el servidor y agrégala a GitHub como Deploy Key.

### 6.3 Seleccionar la rama de producción

```bash
git checkout main
git log --oneline -5    # verificar commits recientes
```

> **Regla de oro**: producción siempre corre desde `main`. Nunca despliegues ramas de feature directamente.

### 6.4 Instalar dependencias

```bash
npm install --omit=dev
```

> `--omit=dev` evita instalar dependencias de desarrollo (jest, ts-node-dev, etc.), reduciendo el tamaño del directorio.

### 6.5 Build de producción

```bash
npm run build
```

Esto ejecuta `tsc -p tsconfig.build.json` y genera el directorio `dist/`.

### 6.6 Verificar el build

```bash
ls dist/
# Debe existir: dist/main.js (punto de entrada)
```

---

## 7. Variables de entorno en producción

### 7.1 Crear el archivo `.env`

```bash
nano /var/www/cursia-backend/.env
```

### 7.2 Contenido del `.env` de producción

Copia el siguiente template y rellena cada valor:

```dotenv
# ══ ENTORNO ══════════════════════════════════════════
NODE_ENV=production
PORT=3000

# ══ BASE DE DATOS (Supabase PostgreSQL) ══════════════
# Ver Sección 8 para obtener estos valores
DB_HOST=db.hriwbakbuypaiovvvkqh.supabase.co
DB_PORT=5432
DB_USER=postgres
DB_PASS=TU_PASSWORD_SUPABASE_DB
DB_NAME=postgres
DB_SSL=true
DB_LOGGING=false

# ══ SUPABASE AUTH ════════════════════════════════════
# SUPABASE_URL es obligatorio para validar JWT con ES256/JWKS
SUPABASE_URL=https://hriwbakbuypaiovvvkqh.supabase.co
# SUPABASE_JWT_SECRET solo si usas HS256 (proyectos legacy)
# Déjalo vacío si tu proyecto usa ES256 (es el caso actual)
SUPABASE_JWT_SECRET=

# ══ CORS ════════════════════════════════════════════
CORS_ORIGIN=https://cursia.nomaddi.com

# ══ URLs ════════════════════════════════════════════
FRONTEND_URL=https://cursia.nomaddi.com
BACKEND_PUBLIC_URL=https://api.cursia.nomaddi.com

# ══ YOUTUBE OAUTH ════════════════════════════════════
YOUTUBE_CLIENT_ID=TU_YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET=TU_YOUTUBE_CLIENT_SECRET
YOUTUBE_REDIRECT_URI=https://api.cursia.nomaddi.com/api/v1/youtube/oauth/callback
YOUTUBE_TOKEN_SECRET=UNA_CADENA_ALEATORIA_SEGURA_LARGA
YOUTUBE_DEFAULT_PRIVACY=unlisted

# ══ VIDEO ENGINE (si aplica) ════════════════════════
VIDEOGEN_API_URL=
VIDEOGEN_SHARED_SECRET=
VIDEOGEN_WEBHOOK_SECRET=

# ══ ADMIN ════════════════════════════════════════════
SUPER_ADMIN_EMAILS=nicolas@nomaddi.com

# ══ SEGURIDAD ════════════════════════════════════════
ALLOW_UNOWNED_COURSES=false
```

### 7.3 Proteger el archivo `.env`

```bash
chmod 600 /var/www/cursia-backend/.env
```

> **NUNCA subas `.env` a GitHub.** Verifica que `.gitignore` incluya `.env`.

### 7.4 Variables críticas explicadas

| Variable | Descripción |
|---|---|
| `NODE_ENV=production` | Desactiva `synchronize:true` en TypeORM, activa optimizaciones |
| `DB_SSL=true` | Obligatorio para conectar a Supabase desde VPS externo |
| `DB_LOGGING=false` | No imprimir queries en producción (seguridad + performance) |
| `SUPABASE_URL` | El backend la usa para obtener el JWKS de validación JWT |
| `SUPABASE_JWT_SECRET` | Solo para proyectos Supabase con HS256. Déjalo vacío si usas ES256 |
| `CORS_ORIGIN` | Solo el dominio del frontend — sin wildcard `*` |
| `ALLOW_UNOWNED_COURSES=false` | **Crítico**: evita que usuarios vean cursos de otros |
| `YOUTUBE_REDIRECT_URI` | Debe coincidir exactamente con Google Cloud Console |

---

## 8. Conexión a Supabase PostgreSQL

### 8.1 Dónde encontrar las credenciales

En **Supabase Dashboard**:

```
Project Settings → Database → Connection info
```

Los valores que necesitas:

| Campo Supabase | Variable `.env` |
|---|---|
| Host | `DB_HOST` |
| Port | `DB_PORT` |
| Database name | `DB_NAME` (generalmente `postgres`) |
| User | `DB_USER` (generalmente `postgres`) |
| Password | `DB_PASS` (tu contraseña de DB) |

### 8.2 Tipos de conexión en Supabase

Supabase ofrece tres modos de conexión:

| Modo | Puerto | Cuándo usarlo |
|---|---|---|
| **Direct** | 5432 | Conexiones persistentes, servidores dedicados (como este VPS) |
| **Session Pooler** | 5432 | Compatible con TypeORM, menos problemas con conexiones persistentes |
| **Transaction Pooler** | 6543 | Serverless (Vercel, Cloudflare Workers) — NO usar con TypeORM |

**Recomendación para este backend NestJS / TypeORM:**

Usa la **conexión directa** (puerto 5432) o el **Session Pooler** (también puerto 5432 en Supabase reciente).

> **No uses el Transaction Pooler** (puerto 6543). TypeORM usa conexiones persistentes con `BEGIN/COMMIT` y el transaction pooler rompe ese comportamiento.

### 8.3 Verificar la conexión desde el VPS

Instala `psql` (cliente de PostgreSQL) para probar la conexión:

```bash
sudo apt install -y postgresql-client
psql "postgresql://postgres:TU_PASSWORD@db.hriwbakbuypaiovvvkqh.supabase.co:5432/postgres?sslmode=require"
```

Si conecta correctamente verás el prompt `postgres=#`. Escribe `\q` para salir.

Si da error SSL, intenta con:

```bash
psql "postgresql://postgres:TU_PASSWORD@db.hriwbakbuypaiovvvkqh.supabase.co:5432/postgres?sslmode=no-verify"
```

> El backend ya usa `ssl: { rejectUnauthorized: false }` cuando `DB_SSL=true`, que equivale a `sslmode=no-verify`. Esto es seguro para Supabase managed ya que el tráfico va cifrado por TLS.

---

## 9. Synchronize vs Migraciones

### Estado actual del proyecto

El backend usa:

```typescript
synchronize: configService.get('NODE_ENV') === 'development'
```

Esto significa:
- `NODE_ENV=development` → TypeORM crea/altera tablas automáticamente ✅
- `NODE_ENV=production` → `synchronize: false` → TypeORM NO toca el esquema ✅

### Opciones para el primer deploy

#### Opción A — Primera vez con base de datos vacía (más simple)

Si la base de datos Supabase está vacía (no tiene las tablas del backend todavía), puedes hacer un arranque inicial con `synchronize: true` **temporalmente**, que crea las tablas, y luego revertir.

Pasos:
1. Edita el `.env`: agrega `DB_SYNC_ONCE=true` (si el código lo soporta)
2. O temporalmente en el servidor: cambia `NODE_ENV=development` en el `.env`
3. Arranca el backend una vez — TypeORM crea las tablas
4. Detén el backend
5. Restaura `NODE_ENV=production`
6. Vuelve a arrancar

> **Riesgo**: si la DB tiene datos reales, `synchronize: true` puede alterar columnas. Solo úsalo si la DB está vacía.

#### Opción B — Crear las tablas manualmente (recomendado para producción)

Conecta al dashboard de Supabase → SQL Editor y ejecuta el SQL de creación de tablas.

Obtén el esquema actual del backend inspeccionando las entidades TypeORM. Las tablas principales son:

```sql
-- Ejecutar en Supabase SQL Editor

CREATE TABLE IF NOT EXISTS courses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID NOT NULL,
  nombre TEXT NOT NULL,
  datos JSONB,
  files JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS course_versions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  version_number INT NOT NULL DEFAULT 1,
  snapshot JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS youtube_connections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  channel_id TEXT,
  channel_title TEXT,
  connected_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID,
  event_type TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cost_rates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  model TEXT,
  input_cost_per_1m NUMERIC,
  output_cost_per_1m NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS traditional_cost_benchmarks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  item_type TEXT,
  cost_usd NUMERIC,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

> **Nota**: Verifica el esquema exacto contra las entidades TypeORM del repo. Este SQL es aproximado. Para el esquema exacto, revisa `src/modules/*/entities/*.entity.ts` y `src/events/entities/`.

#### Estrategia a largo plazo — Migraciones TypeORM

Para producciones maduras, configura migraciones TypeORM:

```bash
# Generar migración desde entidades
npm run typeorm -- migration:generate src/migrations/InitialSchema -- -d src/database/data-source.ts

# Ejecutar migraciones
npm run typeorm -- migration:run -d src/database/data-source.ts
```

Agrega a `package.json`:
```json
"migration:run": "typeorm migration:run -d dist/database/data-source.js",
"migration:generate": "typeorm migration:generate"
```

---

## 10. Build y arranque con PM2

### 10.1 Build de producción

```bash
cd /var/www/cursia-backend
npm run build
ls dist/main.js   # verificar
```

### 10.2 Arrancar con PM2

```bash
pm2 start dist/main.js \
  --name cursia-backend \
  --env production \
  --max-memory-restart 512M
```

> `--max-memory-restart 512M`: si el proceso supera 512 MB RAM, PM2 lo reinicia automáticamente. Ajusta según la RAM de tu VPS.

### 10.3 Hacer que PM2 arranque con el sistema

```bash
pm2 save
pm2 startup
# Copia y ejecuta el comando que PM2 muestra (algo como: sudo env PATH=...)
```

### 10.4 Verificar que el proceso corre

```bash
pm2 status
pm2 logs cursia-backend --lines 50
```

### 10.5 Probar el backend localmente en el VPS

```bash
curl http://localhost:3000/health
# Respuesta esperada: {"status":"ok","timestamp":"...","environment":"production"}

curl http://localhost:3000/api/v1
# Respuesta esperada: {"status":"ok","version":"1.0.0",...}
```

### 10.6 Comandos útiles de PM2

```bash
pm2 restart cursia-backend    # reiniciar
pm2 reload cursia-backend     # reload sin downtime (graceful)
pm2 stop cursia-backend       # detener
pm2 delete cursia-backend     # eliminar del registro PM2
pm2 logs cursia-backend       # ver logs en tiempo real
pm2 monit                     # monitor visual en terminal
```

---

## 11. Configurar Nginx (reverse proxy)

### 11.1 Crear el archivo de configuración

```bash
sudo nano /etc/nginx/sites-available/api.cursia.nomaddi.com
```

Pega esta configuración:

```nginx
server {
    listen 80;
    server_name api.cursia.nomaddi.com;

    # Redirección a HTTPS (Certbot la modificará automáticamente)
    # Por ahora, proxy directo para que Certbot pueda verificar el dominio
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSockets (para futuras features de tiempo real)
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;

        # Buffer para respuestas grandes
        proxy_buffer_size        128k;
        proxy_buffers            4 256k;
        proxy_busy_buffers_size  256k;
    }
}
```

### 11.2 Activar el sitio

```bash
sudo ln -s /etc/nginx/sites-available/api.cursia.nomaddi.com \
           /etc/nginx/sites-enabled/

sudo nginx -t          # verificar sintaxis
sudo systemctl reload nginx
```

### 11.3 Probar antes de SSL

```bash
curl http://api.cursia.nomaddi.com/health
```

Si el DNS ya propagó y Nginx está correcto, deberías ver la respuesta JSON del backend.

---

## 12. SSL con Certbot

### 12.1 Obtener el certificado

```bash
sudo certbot --nginx -d api.cursia.nomaddi.com
```

Certbot:
1. Verificará que el dominio apunta a este servidor
2. Solicitará tu email para notificaciones de renovación
3. Aceptará los términos (responde `Y`)
4. Modificará automáticamente el config de Nginx para usar HTTPS
5. Configurará redirección HTTP → HTTPS

### 12.2 Verificar el certificado

```bash
sudo certbot certificates
```

### 12.3 Probar renovación automática

```bash
sudo certbot renew --dry-run
```

Los certificados de Let's Encrypt se renuevan automáticamente cada 60 días via cron/systemd timer.

### 12.4 Verificar el resultado final

```bash
curl https://api.cursia.nomaddi.com/health
```

Respuesta esperada:
```json
{
  "status": "ok",
  "timestamp": "2026-05-21T...",
  "environment": "production"
}
```

### 12.5 Configuración Nginx final (tras Certbot)

Certbot modifica el config automáticamente. El resultado final será similar a:

```nginx
server {
    listen 80;
    server_name api.cursia.nomaddi.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name api.cursia.nomaddi.com;

    ssl_certificate     /etc/letsencrypt/live/api.cursia.nomaddi.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.cursia.nomaddi.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        # ... mismo proxy_set_header que antes
    }
}
```

---

## 13. CORS

### 13.1 Configuración en el backend

El backend ya está configurado para leer `CORS_ORIGIN` del `.env`:

```typescript
// src/main.ts
app.enableCors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
});
```

### 13.2 Valor en producción

```dotenv
CORS_ORIGIN=https://cursia.nomaddi.com
```

Si necesitas acceso desde localhost durante debugging:

```dotenv
CORS_ORIGIN=https://cursia.nomaddi.com,http://localhost:5173
```

> **En producción pura**: solo `https://cursia.nomaddi.com`. No dejes `*`.

### 13.3 Verificar CORS desde el navegador

Abre las DevTools del navegador en `https://cursia.nomaddi.com` y ejecuta:

```javascript
fetch('https://api.cursia.nomaddi.com/health')
  .then(r => r.json())
  .then(console.log)
  .catch(console.error)
```

Debe responder con el JSON de health sin error CORS.

Para un endpoint protegido:

```javascript
// Con un token JWT válido de Supabase
fetch('https://api.cursia.nomaddi.com/api/v1/auth/me', {
  headers: { 'Authorization': 'Bearer ' + supabaseToken }
})
.then(r => r.json())
.then(console.log)
```

---

## 14. YouTube OAuth — Google Cloud Console

### 14.1 Actualizar las URIs en Google Cloud Console

Entra a [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → selecciona tu OAuth 2.0 Client ID.

**Authorized JavaScript origins** (agrega):
```
https://cursia.nomaddi.com
```

**Authorized redirect URIs** (agrega):
```
https://api.cursia.nomaddi.com/api/v1/youtube/oauth/callback
```

Guarda los cambios (puede tardar unos minutos en propagar).

### 14.2 Verificar variables de entorno

En el `.env` del servidor:

```dotenv
YOUTUBE_CLIENT_ID=TU_CLIENT_ID.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=TU_CLIENT_SECRET
YOUTUBE_REDIRECT_URI=https://api.cursia.nomaddi.com/api/v1/youtube/oauth/callback
YOUTUBE_TOKEN_SECRET=UNA_CADENA_ALEATORIA_LARGA_Y_SEGURA
FRONTEND_URL=https://cursia.nomaddi.com
```

> **`YOUTUBE_TOKEN_SECRET`** se usa para cifrar los tokens OAuth guardados en la DB. Genera una cadena aleatoria segura:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

### 14.3 Flujo de autenticación YouTube

1. Usuario logueado en `cursia.nomaddi.com` hace click en "Conectar YouTube"
2. Frontend llama a `GET /api/v1/youtube/oauth/start` con JWT
3. Backend genera la URL de autorización de Google y responde
4. Frontend redirige al usuario a Google OAuth
5. Google redirige a `https://api.cursia.nomaddi.com/api/v1/youtube/oauth/callback`
6. Backend procesa el callback, guarda tokens cifrados en `youtube_connections`
7. Backend redirige al usuario a `https://cursia.nomaddi.com` con parámetro de éxito
8. Frontend muestra el canal conectado

---

## 15. Supabase Auth / JWT

### 15.1 Cómo funciona

El backend usa **ES256 con JWKS** (el modo moderno de Supabase):

1. Usuario se autentica en el frontend via Supabase Auth
2. Supabase devuelve un JWT firmado con clave privada ES256
3. Frontend envía el JWT en el header `Authorization: Bearer <token>`
4. El backend descarga el JWKS público de Supabase (se cachea en memoria)
5. El guard `SupabaseJwtGuard` verifica la firma del JWT
6. Si es válido, extrae `sub`, `email`, `role` y los pone en `req.user`

### 15.2 Variable crítica

```dotenv
SUPABASE_URL=https://hriwbakbuypaiovvvkqh.supabase.co
```

Esta URL es la que el backend usa para obtener el JWKS:
```
https://hriwbakbuypaiovvvkqh.supabase.co/auth/v1/.well-known/jwks.json
```

> El campo `SUPABASE_JWT_SECRET` puede dejarse vacío. Solo se necesita si el proyecto Supabase usa HS256 (legacy). El proyecto actual usa ES256.

### 15.3 Probar la autenticación desde curl

```bash
# Sin token → debe dar 401
curl https://api.cursia.nomaddi.com/api/v1/auth/me
# Respuesta: {"statusCode":401,"message":"Unauthorized"}

# Con token válido → debe dar 200
TOKEN="eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9..."  # token real de Supabase
curl -H "Authorization: Bearer $TOKEN" \
     https://api.cursia.nomaddi.com/api/v1/auth/me
# Respuesta: {"id":"...","email":"...","role":"authenticated"}
```

---

## 16. Seguridad básica

### 16.1 Checklist de seguridad del servidor

```bash
# 1. Permisos del .env
chmod 600 /var/www/cursia-backend/.env
ls -la /var/www/cursia-backend/.env
# Debe mostrar: -rw------- 1 cursia cursia

# 2. Verificar que el puerto 3000 no es público
sudo ufw status
# Debe mostrar solo 22/tcp, 80/tcp, 443/tcp como ALLOW

# 3. No exponer el puerto 3000 directamente
curl http://IP_DEL_VPS:3000/health
# Debe fallar (connection refused o timeout)
# Solo debe funcionar: https://api.cursia.nomaddi.com/health
```

### 16.2 fail2ban (opcional pero recomendado)

Protege contra ataques de fuerza bruta al SSH:

```bash
sudo apt install -y fail2ban
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

### 16.3 Nginx rate limiting (recomendado)

Agrega al bloque `http` en `/etc/nginx/nginx.conf`:

```nginx
# Dentro del bloque http {}
limit_req_zone $binary_remote_addr zone=api:10m rate=30r/m;
```

Y en el config del sitio, dentro de `location /`:

```nginx
limit_req zone=api burst=20 nodelay;
```

Esto limita a 30 requests por minuto por IP, con un burst de 20.

### 16.4 Actualización de dependencias

```bash
# Actualizar sistema operativo mensualmente
sudo apt update && sudo apt upgrade -y

# Auditar dependencias del backend
cd /var/www/cursia-backend
npm audit
```

### 16.5 Backups de Supabase

Supabase Pro incluye backups automáticos diarios. Si estás en el plan gratuito, considera exportar la DB periódicamente:

```bash
# Desde cualquier máquina con psql instalado
pg_dump "postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres" \
  --no-acl --no-owner \
  -f backup_$(date +%Y%m%d).sql
```

---

## 17. Activar el backend desde el frontend

### 17.1 Activación manual (temporal)

Para probar el backend recién desplegado, abre `https://cursia.nomaddi.com` en el navegador, ve a la consola de DevTools y ejecuta:

```javascript
localStorage.setItem('ORBIA_BACKEND_ENABLED', 'true')
localStorage.setItem('ORBIA_BACKEND_URL', 'https://api.cursia.nomaddi.com')
location.reload()
```

### 17.2 Verificar desde el frontend

Con el backend activado, prueba en orden:

1. **Health check**: el panel "Backend / Nube" debe mostrar el backend como activo
2. **Cloud Save**: guarda un curso — debe aparecer en Supabase DB
3. **Restore**: recarga la página — el curso debe restaurarse
4. **YouTube**: intenta conectar una cuenta de YouTube

### 17.3 Configuración permanente (futuro)

Para producción real, el `ORBIA_BACKEND_URL` debe configurarse en el panel de configuración del frontend, no manualmente por cada usuario. Esto se hará en una iteración futura del producto.

---

## 18. Checklist de validación producción

Completa este checklist antes de abrir el backend a usuarios reales:

### Infraestructura

- [ ] **DNS**: `api.cursia.nomaddi.com` apunta a la IP del VPS
- [ ] **Nginx**: responde en HTTP y HTTPS
- [ ] **SSL**: certificado válido, sin warnings en el navegador
- [ ] **PM2**: proceso `cursia-backend` en estado `online`
- [ ] **Firewall**: solo puertos 22, 80, 443 abiertos

### Endpoints básicos

- [ ] `GET https://api.cursia.nomaddi.com/health` → `{"status":"ok"}`
- [ ] `GET https://api.cursia.nomaddi.com/api/v1` → respuesta JSON
- [ ] `GET https://api.cursia.nomaddi.com/api/v1/auth/me` sin token → 401
- [ ] `GET https://api.cursia.nomaddi.com/api/v1/auth/me` con token → 200

### Base de datos

- [ ] Backend arranca sin errores de DB en `pm2 logs`
- [ ] Las tablas existen en Supabase (verifica en Table Editor)
- [ ] Course creation funciona: `POST /api/v1/courses` con token válido
- [ ] Course versions funciona: `GET /api/v1/course-versions` con token
- [ ] Cloud Save funciona desde el frontend

### Autenticación y seguridad

- [ ] `ALLOW_UNOWNED_COURSES=false` — usuarios no ven cursos de otros
- [ ] `NODE_ENV=production` — synchronize desactivado
- [ ] `DB_SSL=true` — conexión Supabase cifrada
- [ ] `DB_LOGGING=false` — sin queries en logs
- [ ] `.env` tiene permisos 600
- [ ] No hay secretos en el repositorio Git

### Funcionalidades específicas

- [ ] **CORS**: requests desde `cursia.nomaddi.com` funcionan; otros orígenes bloqueados
- [ ] **YouTube OAuth**: flujo completo funciona (start → Google → callback → redirect a frontend)
- [ ] **Admin dashboard**: solo emails en `SUPER_ADMIN_EMAILS` acceden a `/api/v1/admin/*`
- [ ] **Logs**: `pm2 logs` no muestra errores de inicialización

### Frontend

- [ ] El panel "Backend / Nube" en Cursia muestra el backend como activo
- [ ] `ORBIA_BACKEND_URL=https://api.cursia.nomaddi.com` configurado
- [ ] Frontend sigue funcionando con todas sus funciones (generación, SCORM, MBZ)

---

## 19. Actualizaciones futuras

### Procedimiento de deploy estándar

```bash
# 1. Conectarse al VPS
ssh cursia@IP_DEL_VPS

# 2. Ir al directorio del backend
cd /var/www/cursia-backend

# 3. Obtener cambios
git pull origin main

# 4. Instalar nuevas dependencias (si las hay)
npm install --omit=dev

# 5. Rebuild
npm run build

# 6. Ejecutar migraciones (si existen)
# npm run migration:run

# 7. Reiniciar el proceso
pm2 reload cursia-backend    # reload sin downtime
# o
pm2 restart cursia-backend   # restart con breve downtime

# 8. Verificar
pm2 logs cursia-backend --lines 30
curl https://api.cursia.nomaddi.com/health
```

### Rollback básico

Si algo falla después de un deploy:

```bash
# Ver commits recientes
git log --oneline -10

# Volver al commit anterior
git checkout <commit-hash>

# Rebuild y restart
npm install --omit=dev
npm run build
pm2 restart cursia-backend

# Verificar
curl https://api.cursia.nomaddi.com/health
```

### Estrategia de zero-downtime (PM2)

`pm2 reload` hace un graceful reload: levanta las nuevas instancias antes de cerrar las viejas. Para backends NestJS esto funciona bien con una sola instancia.

Si quieres cluster mode (múltiples instancias):

```bash
pm2 start dist/main.js --name cursia-backend -i 2
pm2 reload cursia-backend    # zero-downtime en cluster
```

---

## 20. Troubleshooting

### El backend no arranca

```bash
# Ver logs detallados
pm2 logs cursia-backend --lines 100

# Errores comunes:
# - "connect ETIMEDOUT db.xxx.supabase.co" → DB_SSL o credenciales incorrectas
# - "Cannot read properties of undefined (reading 'split')" → falta variable de entorno
# - "EADDRINUSE 3000" → otro proceso usa el puerto (pm2 stop + start)
```

### Error de conexión a Supabase DB

```bash
# Probar conexión manualmente
psql "postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres?sslmode=no-verify"

# Si falla: revisar
# 1. DB_HOST correcto en .env (sin puerto)
# 2. DB_PASS correcto (cuidado con caracteres especiales — escapar en URL)
# 3. DB_SSL=true en .env
# 4. IP del VPS no bloqueada en Supabase (ver Network restrictions en Dashboard)
```

### JWT inválido / 401 con token correcto

```bash
# Verificar SUPABASE_URL en .env
# El backend descarga JWKS de: ${SUPABASE_URL}/auth/v1/.well-known/jwks.json

curl https://hriwbakbuypaiovvvkqh.supabase.co/auth/v1/.well-known/jwks.json
# Debe devolver un objeto JSON con "keys"

# Si el backend no puede alcanzar esa URL, hay un problema de DNS/conectividad del VPS
```

### Error CORS desde el frontend

```bash
# Verificar CORS_ORIGIN en .env del servidor
cat /var/www/cursia-backend/.env | grep CORS_ORIGIN
# Debe ser: CORS_ORIGIN=https://cursia.nomaddi.com

# Reiniciar el backend tras cambiar .env
pm2 restart cursia-backend
```

### YouTube OAuth callback falla

```bash
# Verificar:
# 1. YOUTUBE_REDIRECT_URI en .env == URI registrada en Google Cloud Console
# 2. La URI debe ser exactamente: https://api.cursia.nomaddi.com/api/v1/youtube/oauth/callback
# 3. FRONTEND_URL apunta al frontend correcto para la redirección final
```

### Nginx da 502 Bad Gateway

```bash
# El proceso Node.js no está corriendo
pm2 status
pm2 restart cursia-backend

# Verificar que el backend escucha en el puerto correcto
ss -tlnp | grep 3000
# Debe mostrar: 127.0.0.1:3000

# Revisar logs de Nginx
sudo tail -f /var/log/nginx/error.log
```

### Certificado SSL caducado

```bash
sudo certbot renew
sudo systemctl reload nginx
```

### PM2 no arranca tras reinicio del servidor

```bash
# Verificar que la startup está configurada
pm2 startup
# Ejecutar el comando que muestre

pm2 save
```

---

## 21. Opción Docker (alternativa)

> Esta sección es opcional. Se recomienda **PM2 para la primera versión** por su simplicidad. Solo considera Docker si necesitas reproducibilidad exacta entre entornos o tienes múltiples servicios.

### Dockerfile

Crea `Dockerfile` en la raíz del proyecto:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

### docker-compose.yml para producción

```yaml
version: '3.9'
services:
  api:
    build: .
    container_name: cursia-backend
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"    # Solo local, Nginx hace el proxy
    env_file:
      - .env
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### Deploy con Docker

```bash
# Build y arranque
docker compose up -d --build

# Logs
docker compose logs -f api

# Reinicio tras nuevo deploy
git pull origin main
docker compose up -d --build
docker compose restart api
```

### Diferencias con PM2

| Aspecto | PM2 | Docker |
|---|---|---|
| Simplicidad | ✅ Más simple | Más complejo |
| Reproducibilidad | ⚠️ Depende del OS | ✅ Exacta |
| Logs | PM2 logs | docker logs |
| Recursos | Menos overhead | Más overhead |
| Actualizaciones | `git pull + build + pm2 reload` | `docker compose up --build` |
| Zero-downtime | `pm2 reload` | Requiere configuración extra |

**Recomendación**: empieza con PM2. Migra a Docker cuando necesites orquestar múltiples servicios (API + workers + cron jobs).

---

## Resumen de comandos rápidos

```bash
# Estado general
pm2 status
pm2 logs cursia-backend --lines 50
curl https://api.cursia.nomaddi.com/health

# Actualizar
cd /var/www/cursia-backend
git pull origin main && npm install --omit=dev && npm run build && pm2 reload cursia-backend

# Ver .env (sin mostrar secrets)
cat /var/www/cursia-backend/.env | sed 's/=.*/=***/' | grep -v '^#' | grep -v '^$'

# Nginx
sudo nginx -t && sudo systemctl reload nginx
sudo tail -f /var/log/nginx/error.log

# SSL
sudo certbot certificates
sudo certbot renew --dry-run

# PM2
pm2 startup
pm2 save
pm2 monit
```

---

*Guía creada en Mayo 2026 para el proyecto Cursia / orbia-backend.*  
*Stack: NestJS 11 · TypeORM 0.3 · Supabase PostgreSQL · Nginx · PM2 · Let's Encrypt*
