# Orbia Backend

API REST para CampusCloud / Orbia — construida con **NestJS + TypeScript + PostgreSQL**.

## Stack

| Capa | Tecnología |
|------|------------|
| Runtime | Node.js 18+ |
| Framework | NestJS 10 |
| Lenguaje | TypeScript |
| ORM | TypeORM |
| Base de datos | PostgreSQL 14+ |
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
├── .env.example
├── tsconfig.json
└── package.json
```

## Primeros pasos

```bash
# 1. Instalar dependencias
npm install

# 2. Copiar variables de entorno
cp .env.example .env
# → editar .env con tus credenciales de PostgreSQL

# 3. Crear base de datos (si no existe)
psql -U postgres -c "CREATE DATABASE orbia;"

# 4. Arrancar en modo desarrollo (hot-reload)
npm run start:dev
```

El servidor arranca en `http://localhost:3000`.  
Con `NODE_ENV=development`, TypeORM ejecuta `synchronize: true` y crea las tablas automáticamente.

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
| GET | `/api/v1/courses/:id` | Obtener curso por ID (incluye versiones) |
| PATCH | `/api/v1/courses/:id` | Actualizar curso |
| DELETE | `/api/v1/courses/:id` | Eliminar curso |

### Versiones de curso

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/v1/courses/:courseId/versions` | Crear versión (auto-incrementa version_number) |
| GET | `/api/v1/courses/:courseId/versions` | Listar versiones del curso |
| GET | `/api/v1/courses/:courseId/versions/:id` | Obtener versión específica |

> **404 automático**: si el `courseId` no existe, todos los endpoints de versiones devuelven 404.

## Tablas PostgreSQL

### `courses`

| Columna | Tipo | Notas |
|---------|------|-------|
| id | SERIAL PK | |
| title | VARCHAR(255) | requerido |
| description | TEXT | nullable |
| subject | VARCHAR(100) | nullable |
| level | VARCHAR(100) | nullable |
| status | VARCHAR | `draft` \| `published` \| `archived` |
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

## Scripts

```bash
npm run start:dev    # Desarrollo con hot-reload (ts-node-dev)
npm run build        # Compilar TypeScript → dist/
npm run start:prod   # Producción (requiere build previo)
```
