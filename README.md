# Orbia Backend

API REST para Orbia / Cursia — construida con **NestJS + TypeScript + PostgreSQL**.

> **Estado actual**: `feature/auth-jwt` — Fase 6 completa con autenticación Supabase JWT (ES256/JWKS). Deploy pendiente.

---

## Stack

| Capa | Tecnología |
|------|------------|
| Runtime | Node.js 18+ |
| Framework | NestJS 10 |
| Lenguaje | TypeScript 5 |
| ORM | TypeORM |
| Base de datos | PostgreSQL 16 |
| Validación | class-validator + class-transformer |
| Seguridad | Helmet + CORS |
| Auth | Supabase JWT (ES256/JWKS) via `jose` |

---

## Arquitectura V1

El backend gestiona **cursos y versiones** del usuario. No gestiona auth (eso lo hace Supabase) ni la generación de contenido (eso lo hace el frontend directamente con Claude AI).

```
Frontend Orbia
  → Supabase Auth (ES256 JWT)
  → Backend Orbia ←── este repo
  → PostgreSQL
  → Google Drive (referenciado, no gestionado aquí)
```

Ver [docs/ARQUITECTURA_V1.md](docs/ARQUITECTURA_V1.md) para el diagrama completo.

---

## Estructura

```
orbia-backend/
├── src/
│   ├── main.ts                        # Bootstrap, Helmet, CORS, ValidationPipe
│   ├── app.module.ts
│   ├── app.controller.ts              # GET /health  GET /api/v1
│   ├── auth/
│   │   ├── auth.types.ts              # Interfaz AuthUser
│   │   ├── auth.controller.ts         # GET /api/v1/auth/me
│   │   ├── auth.module.ts
│   │   ├── current-user.decorator.ts  # @CurrentUser()
│   │   └── supabase-jwt.guard.ts      # SupabaseJwtGuard (ES256/JWKS + HS256)
│   ├── common/
│   │   ├── filters/http-exception.filter.ts
│   │   └── interceptors/response.interceptor.ts
│   ├── database/database.module.ts    # TypeORM async config
│   └── modules/
│       ├── courses/                   # CRUD cursos con ownership
│       └── course-versions/           # Versiones por curso (snapshot JSONB)
├── docs/
│   ├── ARQUITECTURA_V1.md
│   ├── QA_V1_CHECKLIST.md
│   ├── OPERACION_V1.md
│   ├── PRE_DEPLOY_BACKEND.md
│   └── DEPLOY_CONTABO_SUPABASE.md
├── docker-compose.yml                 # PostgreSQL 16 local (puerto 5432)
├── .env.example
└── package.json
```

---

## Primeros pasos (desarrollo local)

### Opción A — PostgreSQL vía Docker (recomendado)

```bash
# 1. Levantar PostgreSQL
docker compose up -d
# → crea usuario 'orbia', contraseña 'orbia_dev', base de datos 'orbia'

# 2. Instalar dependencias
npm install

# 3. Copiar y completar variables de entorno
cp .env.example .env
# → editar .env: añadir SUPABASE_URL de tu proyecto

# 4. Arrancar en modo desarrollo (hot-reload)
npm run start:dev
```

### Opción B — PostgreSQL ya instalado

```bash
psql -U postgres -c "CREATE DATABASE orbia;"
cp .env.example .env
# → editar .env con tus credenciales de BD y SUPABASE_URL
npm install && npm run start:dev
```

El servidor arranca en `http://localhost:3000`.
Con `NODE_ENV=development`, TypeORM ejecuta `synchronize: true` y crea las tablas automáticamente.

> **Producción**: desactivar `synchronize` y usar migraciones. Ver [docs/PRE_DEPLOY_BACKEND.md](docs/PRE_DEPLOY_BACKEND.md).

---

## Auth — Supabase JWT (ES256/JWKS)

Todos los endpoints `/api/v1/courses/**` requieren un token JWT válido de Supabase en el header:

```
Authorization: Bearer <token>
```

### El backend soporta dos modos

| Modo | Variable | Proyectos |
|------|----------|-----------|
| **ES256 (JWKS)** | `SUPABASE_URL` | Proyectos nuevos Supabase (por defecto desde ~2024) |
| HS256 (legacy) | `SUPABASE_JWT_SECRET` | Proyectos Supabase anteriores |

Si `SUPABASE_JWT_SECRET` está vacío, el guard usa JWKS automáticamente.

### Verificar el modo de tu proyecto Supabase

```bash
curl https://TU_PROJECT_REF.supabase.co/auth/v1/.well-known/jwks.json
# Si responde con "alg":"ES256" → usar SUPABASE_URL
# Si no hay JWKS → usar SUPABASE_JWT_SECRET
```

### Obtener un token para pruebas

```javascript
// En la consola del browser, con sesión activa en el frontend
const { data } = await window.SB.auth.getSession();
console.log(data.session.access_token);
```

---

## Endpoints

### Sistema (públicos)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado del servidor |
| GET | `/api/v1` | Información de la API |

### Auth (protegido)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/v1/auth/me` | Perfil del usuario del token actual |

### Cursos (protegidos — requieren token)

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/v1/courses` | Crear curso (owner asignado desde JWT) |
| GET | `/api/v1/courses` | Listar cursos del usuario autenticado |
| GET | `/api/v1/courses/:id` | Obtener curso (404 si no es del usuario) |
| PATCH | `/api/v1/courses/:id` | Actualizar curso |
| DELETE | `/api/v1/courses/:id` | Eliminar curso (204) |

### Versiones (protegidos)

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/v1/courses/:courseId/versions` | Crear versión |
| GET | `/api/v1/courses/:courseId/versions` | Listar versiones del curso |
| GET | `/api/v1/courses/:courseId/versions/:id` | Obtener versión específica |

> El `owner_id` se extrae siempre del JWT. El body no puede falsificarlo.
> Acceso a curso ajeno devuelve **404** (no revela existencia).

---

## Ejemplos curl (con token)

### Probar /auth/me

```bash
TOKEN="eyJhbGci..."  # token de Supabase

curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/auth/me
# → {"data":{"id":"uuid","email":"user@example.com","role":"authenticated"}}
```

### Crear curso

```bash
curl -X POST http://localhost:3000/api/v1/courses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Mi primer curso",
    "sector": "tecnología",
    "level": "básico"
  }'
# → {"data":{"id":1,"ownerId":"uuid","ownerEmail":"user@example.com",...}}
```

### Crear versión con snapshot

```bash
curl -X POST http://localhost:3000/api/v1/courses/1/versions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "notes": "Versión inicial",
    "storageProvider": "postgres_json",
    "snapshotJson": {
      "D": {"nombre": "Mi curso", "sector": "tecnología"},
      "F": {"libro_cap1.md": "Contenido capítulo 1"},
      "MEDIA": {"videos": {}},
      "VIDEO_ENGINE": {"status": "idle"}
    }
  }'
```

### Listar cursos

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/courses
# → solo devuelve cursos del usuario del token
```

---

## Tablas PostgreSQL

### `courses`

| Columna | Tipo | Notas |
|---------|------|-------|
| id | SERIAL PK | |
| title | VARCHAR(255) | requerido |
| description | TEXT | nullable |
| sector | VARCHAR(100) | nullable |
| level | VARCHAR(100) | nullable |
| status | VARCHAR | `draft` \| `in_review` \| `published` \| `archived` |
| metadata | JSONB | nullable |
| storage_provider | VARCHAR(50) | nullable |
| storage_folder_id | VARCHAR(255) | nullable |
| storage_folder_url | TEXT | nullable |
| **owner_id** | VARCHAR(36) | UUID de Supabase Auth (indexed) |
| **owner_email** | VARCHAR(255) | Email del dueño |
| created_at | TIMESTAMP | auto |
| updated_at | TIMESTAMP | auto |

### `course_versions`

| Columna | Tipo | Notas |
|---------|------|-------|
| id | SERIAL PK | |
| course_id | INT FK | → courses.id CASCADE DELETE |
| version_number | INT | auto-incremental por curso |
| status | VARCHAR | `draft` \| `ready` \| `exported` |
| notes | TEXT | nullable |
| snapshot_json | JSONB | `{D, F, MEDIA, VIDEO_ENGINE}` |
| storage_provider | VARCHAR | `postgres_json` \| `google_drive` \| `external_url` |
| storage_file_id | VARCHAR(255) | ID del archivo en Drive |
| storage_file_url | TEXT | URL pública o webViewLink |
| storage_folder_id | VARCHAR(255) | nullable |
| storage_path | VARCHAR(500) | nullable |
| snapshot_strategy | VARCHAR(50) | `full_json` \| `external_file` \| `hybrid` |
| snapshot_size_bytes | INT | nullable |
| snapshot_size_human | VARCHAR(30) | nullable |
| manifest_json | JSONB | nullable |
| created_at | TIMESTAMP | auto |

---

## Scripts

```bash
npm run start:dev    # Desarrollo con hot-reload (ts-node-dev)
npm run build        # Compilar TypeScript → dist/
npm run start:prod   # Producción (requiere build previo)
npx tsc -p tsconfig.build.json --noEmit  # Verificar tipos sin compilar
```

---

## Variables de entorno

Ver `.env.example` para la lista completa con comentarios.

| Variable | Prod | Descripción |
|----------|------|-------------|
| `NODE_ENV` | `production` | Desactiva `synchronize` en TypeORM |
| `PORT` | asignado por plataforma | Puerto HTTP |
| `CORS_ORIGIN` | dominios reales | Sin `*` en producción |
| `DB_HOST/PORT/USER/PASS/NAME` | BD producción | Credenciales PostgreSQL |
| `DB_SSL` | `true` | SSL obligatorio en producción |
| `DB_LOGGING` | `false` | No loguear queries en producción |
| `SUPABASE_URL` | requerido (ES256) | URL del proyecto Supabase |
| `SUPABASE_JWT_SECRET` | opcional (HS256) | Solo para proyectos legacy |
| `ALLOW_UNOWNED_COURSES` | **`false`** | **Nunca `true` en producción** |

---

## Deploy en Contabo

Guía completa para desplegar en un VPS Contabo con Supabase como base de datos PostgreSQL (sin PostgreSQL local), Nginx, PM2 y SSL vía Certbot.

Ver [docs/DEPLOY_CONTABO_SUPABASE.md](docs/DEPLOY_CONTABO_SUPABASE.md) para el proceso completo paso a paso.

---

## Documentación

| Archivo | Contenido |
|---------|-----------|
| [docs/ARQUITECTURA_V1.md](docs/ARQUITECTURA_V1.md) | Qué hace cada capa del sistema |
| [docs/QA_V1_CHECKLIST.md](docs/QA_V1_CHECKLIST.md) | Checklist de 81 puntos para validar v1 |
| [docs/OPERACION_V1.md](docs/OPERACION_V1.md) | Cómo operar la plataforma |
| [docs/PRE_DEPLOY_BACKEND.md](docs/PRE_DEPLOY_BACKEND.md) | Checklist de deploy paso a paso |
| [docs/DEPLOY_CONTABO_SUPABASE.md](docs/DEPLOY_CONTABO_SUPABASE.md) | Deploy completo en Contabo VPS + Supabase |

---

## Historial de fases

| Fase | Estado | Descripción |
|------|--------|-------------|
| Fase 1 | ✅ | NestJS + TypeScript + estructura base |
| Fase 2 | ✅ | Módulos `courses` y `course_versions` con PostgreSQL |
| Fase 3 | ✅ | Validación local con PostgreSQL real |
| Fase 4 | ✅ | Conexión con frontend (Cloud Save UI) |
| Fase 5 | ✅ | Drive unificado — routing por tamaño, storage metadata |
| Fase 6 | ✅ | Supabase JWT auth — owner_id, guard ES256/JWKS |
| **Deploy** | 🔜 | Pendiente — ver `docs/DEPLOY_CONTABO_SUPABASE.md` |

---

> **Deploy pendiente**: la rama `feature/auth-jwt` está lista para producción una vez completadas las verificaciones de `docs/PRE_DEPLOY_BACKEND.md`.
