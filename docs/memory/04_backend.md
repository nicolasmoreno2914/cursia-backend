# 04 — Backend (cursia-backend / orbia-backend)

---

## Stack

| Tecnología | Versión | Rol |
|---|---|---|
| Node.js | 22 LTS | Runtime |
| NestJS | 11 | Framework |
| TypeScript | 5 | Lenguaje |
| TypeORM | 0.3 | ORM |
| PostgreSQL | vía Supabase | Base de datos |
| Supabase Auth | ES256/JWKS | Autenticación |
| PM2 | latest | Process manager en VPS |
| Nginx | latest | Reverse proxy + TLS |
| Certbot | latest | SSL Let's Encrypt |

---

## Repositorio y ramas

- **Repo**: `orbia-backend` (GitHub: `nicolasmoreno2914/cursia-backend`)
- **Rama de producción**: `main`
- **Rama de desarrollo actual**: `main` (ya mergeado todo)
- **Build**: `npm run build` → genera `dist/`
- **Start producción**: `npm run start:prod` o `pm2 start dist/main.js`

---

## Módulos y tablas

### `courses`
CRUD de cursos. Ownership por `owner_id` (UUID de Supabase auth). `GET /api/v1/courses` devuelve solo cursos del usuario autenticado.

### `course_versions`
Snapshots del estado del curso. FK → `courses.id` CASCADE. Guarda `snapshot_json` (JSONB) con `{D, F, MEDIA, VIDEO_ENGINE}`.

### `youtube_connections`
Una fila por usuario. `user_id` UNIQUE. `encrypted_refresh_token` con AES-256-GCM + `token_iv`. OAuth gestionado por `YoutubeModule`.

### `usage_events`
Append-only. UUID PK. Registra cada acción de IA, export, video, auth. Para analytics y billing futuro.

### `cost_rates`
Tabla de tarifas viva. `provider`, `service`, `model`, `unit_type`, `rate_usd`. Actualizar filas = actualizar precios sin tocar código.

### `traditional_cost_benchmarks`
Coste de los métodos tradicionales para calcular el ahorro que genera Cursia.

---

## Endpoints principales

### Públicos (sin JWT)
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | `{"status":"ok","environment":"production"}` |
| GET | `/api/v1` | Info de la API |

### Protegidos (requieren `Authorization: Bearer <supabase_jwt>`)
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/v1/auth/me` | Perfil del usuario del token |
| POST | `/api/v1/courses` | Crear curso |
| GET | `/api/v1/courses` | Listar cursos del usuario |
| GET | `/api/v1/courses/:id` | Obtener curso (404 si no es del usuario) |
| PATCH | `/api/v1/courses/:id` | Actualizar curso |
| DELETE | `/api/v1/courses/:id` | Eliminar curso |
| POST | `/api/v1/courses/:id/versions` | Guardar versión/snapshot |
| GET | `/api/v1/courses/:id/versions` | Listar versiones |
| GET | `/api/v1/youtube/oauth/start` | Iniciar OAuth YouTube |
| GET | `/api/v1/youtube/oauth/callback` | Callback de Google |
| GET | `/api/v1/youtube/connection` | Estado de conexión YT |
| DELETE | `/api/v1/youtube/connection` | Desconectar YouTube |
| POST | `/api/v1/events` | Registrar evento de uso |

### Super admin (requieren JWT + `SUPER_ADMIN_EMAILS`)
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/v1/admin/dashboard/summary` | Resumen de costos y KPIs |

---

## Autenticación JWT

```
1. Supabase emite JWT firmado con ES256 (clave privada Supabase)
2. Frontend envía: Authorization: Bearer <token>
3. SupabaseJwtGuard descarga JWKS de:
   https://<project>.supabase.co/auth/v1/.well-known/jwks.json
4. Verifica firma, extrae { sub, email, role }
5. Inyecta en req.user como AuthUser
6. Owner_id siempre viene del JWT (sub), nunca del body
```

---

## Variables de entorno requeridas en producción

```dotenv
NODE_ENV=production
PORT=3000
DB_HOST=db.<PROJECT_REF>.supabase.co
DB_PORT=5432
DB_USER=postgres
DB_PASS=<password>
DB_NAME=postgres
DB_SSL=true
DB_LOGGING=false
SUPABASE_URL=https://<PROJECT_REF>.supabase.co
SUPABASE_JWT_SECRET=                    # vacío para ES256
CORS_ORIGIN=https://cursia.nomaddi.com
FRONTEND_URL=https://cursia.nomaddi.com
BACKEND_PUBLIC_URL=https://api.cursia.nomaddi.com
YOUTUBE_CLIENT_ID=<...>
YOUTUBE_CLIENT_SECRET=<...>
YOUTUBE_REDIRECT_URI=https://api.cursia.nomaddi.com/api/v1/youtube/oauth/callback
YOUTUBE_TOKEN_SECRET=<64_chars_random>
YOUTUBE_DEFAULT_PRIVACY=unlisted
SUPER_ADMIN_EMAILS=nicolas@nomaddi.com
ALLOW_UNOWNED_COURSES=false
```

Plantilla completa: `.env.production.template`

---

## Estrategia de ownership

- `owner_id` en `courses` = `req.user.id` (UUID de Supabase auth)
- `GET /courses` aplica `WHERE owner_id = :userId` siempre
- Acceso a curso ajeno devuelve **404** (no revela existencia)
- `ALLOW_UNOWNED_COURSES=false` en producción — nunca `true`

---

## Estado del schema

- SQL: `docs/SCHEMA_SUPABASE.sql` (v1.1, corregido y probado)
- 6 tablas: courses, course_versions, youtube_connections, usage_events, cost_rates, traditional_cost_benchmarks
- Idempotente: `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`
- Rollback disponible en la Sección 0 del SQL (comentado)
- Verificación: query al final devuelve 6 filas con column counts

---

## Deploy actual

- **Objetivo**: `https://api.cursia.nomaddi.com`
- **Estado**: 🔄 pendiente de ejecutar en VPS Contabo
- **Guía completa**: `docs/DEPLOY_CONTABO_SUPABASE.md`
- **Checklist**: sección 18 de la guía de deploy
- **CI/CD**: `.github/workflows/deploy.yml` listo — requiere 5 secrets en GitHub
