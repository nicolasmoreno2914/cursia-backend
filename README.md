# Orbia Backend

API REST para CampusCloud / Orbia — construida con **NestJS + TypeScript + PostgreSQL**.

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

## Estructura

```
orbia-backend/
├── src/
│   ├── main.ts                        # Bootstrap, Helmet, CORS, ValidationPipe
│   ├── app.module.ts
│   ├── app.controller.ts              # GET /health  GET /api/v1
│   ├── app.service.ts
│   ├── common/
│   │   ├── filters/
│   │   │   └── http-exception.filter.ts
│   │   └── interceptors/
│   │       └── response.interceptor.ts
│   ├── database/
│   │   └── database.module.ts         # TypeORM async config
│   └── modules/
│       ├── courses/                   # CRUD de cursos
│       └── course-versions/           # Versiones por curso (snapshot JSONB)
├── docker-compose.yml                 # PostgreSQL 16 local (puerto 5432)
├── .env.example
├── tsconfig.json
└── package.json
```

## Primeros pasos (desarrollo local)

### Opción A — PostgreSQL vía Docker (recomendado)

```bash
# 1. Levantar PostgreSQL
docker compose up -d
# → crea usuario 'orbia', contraseña 'orbia_dev', base de datos 'orbia'

# 2. Instalar dependencias
npm install

# 3. Copiar variables de entorno
cp .env.example .env
# → los valores del .env.example ya coinciden con el docker-compose

# 4. Arrancar en modo desarrollo (hot-reload)
npm run start:dev
```

### Opción B — PostgreSQL ya instalado

```bash
psql -U postgres -c "CREATE DATABASE orbia;"
cp .env.example .env
# → editar .env con tus credenciales
npm install && npm run start:dev
```

El servidor arranca en `http://localhost:3000`.  
Con `NODE_ENV=development`, TypeORM ejecuta `synchronize: true` y **crea las tablas automáticamente**.

> ⚠️ En producción, deshabilitar `synchronize` y usar migraciones explícitas.

---

## Endpoints

### Sistema

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado del servidor |
| GET | `/api/v1` | Información de la API |

### Cursos

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/v1/courses` | Crear curso |
| GET | `/api/v1/courses` | Listar todos los cursos |
| GET | `/api/v1/courses/:id` | Obtener curso por ID (incluye `versions[]`) |
| PATCH | `/api/v1/courses/:id` | Actualizar curso parcialmente |
| DELETE | `/api/v1/courses/:id` | Eliminar curso (204) |

### Versiones de curso

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/v1/courses/:courseId/versions` | Crear versión (`version_number` auto-incremental) |
| GET | `/api/v1/courses/:courseId/versions` | Listar versiones del curso |
| GET | `/api/v1/courses/:courseId/versions/:id` | Obtener versión específica |

> **404 automático**: si `courseId` no existe, todos los endpoints de versiones devuelven 404.

---

## Ejemplos curl

### Crear curso

```bash
curl -X POST http://localhost:3000/api/v1/courses \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Mi primer curso",
    "sector": "tecnología",
    "level": "básico",
    "status": "draft"
  }'
```

### Actualizar estado

```bash
curl -X PATCH http://localhost:3000/api/v1/courses/1 \
  -H "Content-Type: application/json" \
  -d '{"status": "in_review"}'
```

### Crear versión con snapshot

```bash
curl -X POST http://localhost:3000/api/v1/courses/1/versions \
  -H "Content-Type: application/json" \
  -d '{
    "snapshotJson": {
      "D": {"nombre": "Mi primer curso", "sector": "tecnología"},
      "F": {"libro_cap1.md": "Contenido capítulo 1"},
      "MEDIA": {"videos": {}},
      "VIDEO_ENGINE": {"status": "idle"},
      "metadata": {"source": "manual"}
    },
    "notes": "Versión inicial"
  }'
```

---

## Tablas PostgreSQL

### `courses`

| Columna | Tipo | Notas |
|---------|------|-------|
| id | SERIAL PK | |
| title | VARCHAR(255) | requerido |
| description | TEXT | nullable |
| sector | VARCHAR(100) | área temática del curso |
| level | VARCHAR(100) | nullable |
| status | VARCHAR | `draft` \| `in_review` \| `published` \| `archived` |
| metadata | JSONB | nullable |
| created_at | TIMESTAMP | auto |
| updated_at | TIMESTAMP | auto |

### `course_versions`

| Columna | Tipo | Notas |
|---------|------|-------|
| id | SERIAL PK | |
| course_id | INT FK | → courses.id CASCADE DELETE |
| version_number | INT | auto-incrementado por curso |
| status | VARCHAR | `draft` \| `ready` \| `exported` |
| notes | TEXT | nullable |
| snapshot_json | JSONB | `{D, F, MEDIA, VIDEO_ENGINE, metadata}` |
| created_at | TIMESTAMP | auto |

---

## Scripts

```bash
npm run start:dev    # Desarrollo con hot-reload (ts-node-dev)
npm run build        # Compilar TypeScript → dist/
npm run start:prod   # Producción (requiere build previo)
```

---

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Activa `synchronize:true` en TypeORM |
| `PORT` | `3000` | Puerto HTTP |
| `CORS_ORIGIN` | — | Orígenes permitidos, separados por coma |
| `DB_HOST` | `localhost` | Host PostgreSQL |
| `DB_PORT` | `5432` | Puerto PostgreSQL |
| `DB_USER` | `orbia` | Usuario |
| `DB_PASS` | — | Contraseña |
| `DB_NAME` | `orbia` | Base de datos |
| `DB_SSL` | `false` | SSL para conexión PG |
| `DB_LOGGING` | `false` | Log de queries SQL |

---

## Historial de fases

| Fase | Estado | Descripción |
|------|--------|-------------|
| Fase 0 | ✅ | Frontend protegido con rama y tag de backup |
| Fase 1 | ✅ | NestJS + TypeScript + estructura base |
| Fase 2 | ✅ | Módulos `courses` y `course_versions` con PostgreSQL |
| Fase 3 | ✅ | Validación local — todos los endpoints probados con PostgreSQL real |
| Fase 4 | 🔜 | Conexión opcional con frontend |
