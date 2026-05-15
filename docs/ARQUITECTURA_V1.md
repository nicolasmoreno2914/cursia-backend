# Orbia / Cursia — Arquitectura V1

> Documento de referencia técnica. Fecha: Mayo 2026.

---

## 1. Qué es Orbia / Cursia v1

Orbia (también llamada Cursia en la interfaz de usuario) es una plataforma SaaS de generación de contenido educativo asistida por IA. La v1 es una plataforma **cerrada**: solo pueden acceder usuarios explícitamente autorizados por el super admin.

**Capacidades principales v1:**
- Generación de cursos completos con IA (Claude de Anthropic)
- Exportación a SCORM, MBZ (Moodle), H5P
- Generación de audio/video con Video Engine
- Guardado y restauración de versiones en la nube
- Google Drive como almacenamiento de archivos pesados
- Gestión de usuarios y configuración por cuenta

**Lo que NO tiene v1** (decidido conscientemente, no es un olvido):
- Planes o billing
- Instituciones multi-nivel
- Roles avanzados (solo admin/usuario)
- Registro público libre
- Marketplace

---

## 2. Qué maneja el Frontend

El frontend es una Single Page Application (SPA) en **vanilla JavaScript**, alojada en Cloudflare Pages (`orbia.pages.dev`). No usa ningún framework frontend.

### Generación de contenido
- Interfaz principal de creación de cursos (estructura, capítulos, actividades)
- Llamadas directas a la API de Anthropic (Claude) con la API key del usuario
- Estado de generación persistido en **IndexedDB** (sobrevive recargas y cierres de pestaña)
- Navegación de secciones con función `go()`

### Exportación
- **SCORM**: generación de paquete .zip con actividades y mecánicas premium (score, vidas, timer)
- **MBZ**: exportación de paquete Moodle con módulos y recursos
- **H5P**: contenido interactivo embebido

### Audio / Video
- Procesamiento de URLs de medios (`processMedia`)
- Integración con **Video Engine** (servicio externo) — solo UI, no lógica de procesamiento
- Subida de archivos de audio/video

### Almacenamiento local
- **IndexedDB**: estado de generación en curso (`generation-job`)
- **localStorage**: configuración de usuario, temas, preferencias, feature flags (`ORBIA_BACKEND_ENABLED`)
- **Backup local**: archivo JSON descargable manualmente como seguridad

### Paneles de usuario
- Panel de configuración (API key Anthropic, logo, tema visual, datos de cuenta)
- Panel admin (gestión de `authorized_users`)
- Panel Google Drive
- Panel Cloud Save (backend)
- Librería de cursos

### Google Drive (UI)
- OAuth de Google, conexión/desconexión de cuenta
- Subida de archivos pesados (snapshots grandes, MBZ)
- Descarga y restauración desde Drive

### Cloud Save (UI)
- Guardado de snapshots en backend Orbia
- Listado de cursos guardados en la nube
- Listado de versiones por curso
- Restauración de versiones (`postgres_json` o `google_drive`)

---

## 3. Qué maneja Supabase

Supabase es la capa de **auth y base de datos del usuario** (no de los cursos guardados en backend). El proyecto es `hriwbakbuypaiovvvkqh.supabase.co`.

### Auth (Supabase Auth)
- Login con email/password
- Registro de nuevos usuarios
- Confirmación de email
- Reset de contraseña
- Gestión de sesión (tokens JWT, refresh automático)
- Algoritmo JWT: **ES256** (asimétrico, JWKS)

### Control de acceso — `authorized_users`
- Tabla personalizada en Supabase que actúa como whitelist
- El frontend verifica en cada login si el email está en `authorized_users`
- El super admin añade/elimina emails desde el panel admin del frontend
- Campo `is_admin` controla quién puede gestionar usuarios

### Configuración de usuario — `user_settings`
- API key de Anthropic por usuario (cifrada o almacenada en Supabase)
- Logo del usuario
- Datos de cuenta (nombre, organización)
- Tema visual seleccionado (`theme_id`)
- `drive_connected` (boolean): si el usuario tiene Drive conectado
- `oca_data` (JSONB): datos de configuración OCA y otros

### Librería de cursos — `courses` (Supabase)
- Metadatos ligeros de cursos (título, fecha, ID de Drive)
- URL del MBZ en Drive (`drive_url_mbz`)
- **No es lo mismo** que la tabla `courses` del backend de Orbia
- Historial accesible desde la librería del frontend

### Panel admin actual
- Gestionado 100% desde el frontend + Supabase
- No hay panel admin separado en el backend

> **IMPORTANTE**: Supabase gestiona auth e identidad del usuario.
> El backend de Orbia **NO tiene tabla de usuarios propia**. Reutiliza el JWT de Supabase.

---

## 4. Qué maneja el Backend (orbia-backend)

El backend es una API REST construida con **NestJS + TypeScript + PostgreSQL**, alojada en un servidor separado (pendiente de deploy). Repo: `orbia-backend` en rama `feature/auth-jwt`.

### Cursos — tabla `courses` (PostgreSQL)
- Registro de cada curso guardado en la nube
- Campos clave: `id`, `title`, `description`, `sector`, `level`, `status`
- **Ownership**: `owner_id` (UUID de Supabase), `owner_email`
- Storage metadata: `storage_provider`, `storage_folder_id`, `storage_folder_url`

### Versiones — tabla `course_versions` (PostgreSQL)
- Historial de snapshots por curso
- `version_number` auto-incremental por curso
- `snapshot_json` (JSONB): estado completo del curso `{D, F, MEDIA, VIDEO_ENGINE}`
- `storage_provider`: `postgres_json` | `google_drive` | `external_url`
- `storage_file_id`, `storage_file_url`: referencia al archivo en Drive si aplica
- `snapshot_strategy`: `full_json` | `external_file` | `hybrid`

### Validación JWT — Supabase ES256
- Guard `SupabaseJwtGuard` verifica el token de Supabase en cada request
- Soporta **ES256 via JWKS** (proyectos nuevos Supabase) — configurable con `SUPABASE_URL`
- Soporta HS256 vía `SUPABASE_JWT_SECRET` (proyectos legacy)
- Extrae `sub` → `owner_id`, `email` → `owner_email` del JWT
- El cliente **no puede falsificar su `owner_id`**; siempre viene del JWT

### Endpoints protegidos
- Todos los endpoints de `/api/v1/courses/**` requieren `Authorization: Bearer <token>`
- `/health` es público
- `/api/v1` (info) es público
- `/api/v1/auth/me` devuelve el perfil del token actual

### Aislamiento por usuario
- `GET /api/v1/courses` → solo cursos del `owner_id` del token
- `ALLOW_UNOWNED_COURSES=true` en dev incluye cursos legacy sin owner (backward compat)
- `ALLOW_UNOWNED_COURSES=false` en producción: estricto, solo cursos propios
- Acceso a curso ajeno devuelve **404** (no revela existencia del recurso)

---

## 5. Qué maneja Google Drive

Google Drive es el **almacenamiento de archivos pesados** del usuario. No es gestionado por el backend de Orbia; el frontend interactúa directamente con la API de Google.

### Archivos que van a Drive
- **MBZ** (paquetes Moodle): archivos grandes generados al exportar
- **Snapshots grandes**: cuando el estado del curso supera el umbral de PostgreSQL (~500KB estimado), el snapshot se sube a Drive y se guarda solo la referencia (`storage_file_id`, `storage_file_url`) en el backend
- Archivos de audio y video del usuario

### Flujo de routing por tamaño
```
snapshot pequeño (<= umbral)  → storage_provider = 'postgres_json'  → snapshot_json en BD
snapshot grande (> umbral)    → storage_provider = 'google_drive'   → subir a Drive, guardar URL en BD
```

### Restauración desde Drive
1. Frontend lee `storage_file_url` del backend
2. Frontend descarga el archivo de Drive con credenciales OAuth del usuario
3. Frontend restaura el estado local desde el JSON descargado

---

## 6. Qué queda local (en el navegador del usuario)

| Dato | Dónde | Por qué |
|------|-------|---------|
| Estado de generación en curso | IndexedDB (`generation-job`) | Persiste recargas y cierres |
| Estado `D`, `F`, `SEL`, `MEDIA` | `window.D/F/SEL` + IndexedDB | Edición activa, acceso inmediato |
| Backup local descargado | Archivo `.json` del usuario | Seguridad offline |
| Tema visual, preferencias UI | localStorage | No necesitan ir a servidor |
| `ORBIA_BACKEND_ENABLED` flag | localStorage | Feature flag de Cloud Save |
| Token OAuth de Google | localStorage (Supabase) | Gestionado por Supabase JS |

---

## 7. Qué NO se debe duplicar

Estas responsabilidades ya están implementadas y **no deben recrearse** en el backend ni en ninguna otra capa:

| Responsabilidad | Dueño | No duplicar en |
|-----------------|-------|----------------|
| Autenticación de usuarios | Supabase Auth | Backend, frontend |
| Panel de administración | Frontend + Supabase | Backend |
| `user_settings` (API key, logo, tema) | Supabase | Backend, localStorage |
| API keys de Anthropic | Supabase `user_settings` | Backend, código fuente |
| Whitelist `authorized_users` | Supabase | Backend |
| Librería de cursos Supabase | Supabase `courses` | Backend (son tablas distintas) |
| OAuth Google Drive | Frontend + Google API | Backend |

---

## 8. Decisión de arquitectura v1

La v1 es deliberadamente simple:

- **Plataforma cerrada**: el super admin autoriza manualmente cada usuario por email
- **Sin planes ni billing**: todos los usuarios autorizados tienen acceso completo
- **Sin instituciones**: no hay jerarquía de organizaciones
- **Sin roles avanzados**: admin (puede gestionar usuarios) o usuario regular
- **Sin self-service de registro**: el flujo es: admin añade email → usuario se registra → confirma → entra
- **Una sola instancia**: un proyecto Supabase, un backend, un PostgreSQL

Esta simplicidad es intencional. Las capas de complejidad (planes, instituciones, roles, marketplace) se añadirán en versiones futuras si el producto lo requiere.

---

## 9. Diagrama de flujo

```
┌─────────────────────────────────────────────────────────┐
│                    USUARIO (Navegador)                   │
│                                                          │
│  Genera curso  →  SCORM / MBZ / H5P  →  Exporta         │
│  IndexedDB (estado local)  →  Backup local               │
└──────────────────────┬──────────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
┌─────────────────┐       ┌─────────────────────┐
│  SUPABASE       │       │  BACKEND ORBIA      │
│                 │       │  (NestJS + PG)       │
│  Auth (ES256)   │──JWT──▶                     │
│  authorized_    │       │  courses             │
│  users          │       │  course_versions     │
│  user_settings  │       │  owner_id            │
│  API keys       │       │  storage metadata    │
│  courses (meta) │       │  JWT guard (JWKS)    │
└─────────────────┘       └──────────┬──────────┘
                                     │
                          ┌──────────▼──────────┐
                          │  POSTGRESQL         │
                          │  (producción)        │
                          │  courses             │
                          │  course_versions     │
                          └─────────────────────┘
                                     │
                    ┌────────────────┘
                    ▼
          ┌─────────────────┐
          │  GOOGLE DRIVE   │
          │                 │
          │  MBZ            │
          │  Snapshots >    │
          │  umbral         │
          │  Archivos media │
          └─────────────────┘
```

---

## 10. Estado de ramas (Mayo 2026)

| Repo | Rama | Estado |
|------|------|--------|
| `orbia` (frontend) | `main` | Producción estable (sin Cloud Save) |
| `orbia` (frontend) | `feature/backend-cloud-save` | Cloud Save + JWT — pendiente de merge |
| `orbia-backend` | `feature/auth-jwt` | Backend v1 completo — pendiente de deploy |

**No mergeado todavía:**
- Cloud Save UI al `main` del frontend
- Backend auth al `main` del backend (no existe main con código aún)

**Backup de seguridad:** `backup/pre-backend-orbia-20260514-1805` en frontend
