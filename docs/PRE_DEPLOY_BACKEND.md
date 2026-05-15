# Pre-Deploy Backend — Checklist V1

> Completar este documento antes de desplegar `orbia-backend` a producción.

---

## 1. Variables de entorno requeridas

Todas las variables siguientes deben estar configuradas en el entorno de producción antes de arrancar.

### Aplicación

| Variable | Valor producción | Notas |
|----------|-----------------|-------|
| `NODE_ENV` | `production` | Activa modo estricto en TypeORM |
| `PORT` | `3000` (o el que asigne la plataforma) | Railway/Render lo asignan automáticamente |

### CORS

| Variable | Valor producción | Notas |
|----------|-----------------|-------|
| `CORS_ORIGIN` | `https://orbia.pages.dev,https://tu-dominio-final.com` | Lista separada por comas, sin espacios, sin trailing slash |

> En producción NUNCA usar `*`. Solo dominios explícitos del frontend.

### Base de datos PostgreSQL

| Variable | Descripción |
|----------|-------------|
| `DB_HOST` | Host del servidor PostgreSQL de producción |
| `DB_PORT` | Puerto (normalmente `5432`) |
| `DB_USER` | Usuario de la base de datos |
| `DB_PASS` | Contraseña del usuario |
| `DB_NAME` | Nombre de la base de datos |
| `DB_SSL` | `true` en producción (la mayoría de proveedores lo requieren) |
| `DB_LOGGING` | `false` en producción (no loguear queries SQL) |

> Alternativa: si la plataforma de hosting proporciona una `DATABASE_URL` como connection string completa, verificar que `database.module.ts` la soporte (actualmente usa variables individuales).

### Supabase JWT Auth

| Variable | Requerido | Notas |
|----------|-----------|-------|
| `SUPABASE_URL` | **Sí** (si el proyecto usa ES256/JWKS) | `https://tu-project-ref.supabase.co` |
| `SUPABASE_JWT_SECRET` | Solo si usas HS256 legacy | Dejar vacío para proyectos nuevos con ES256 |
| `ALLOW_UNOWNED_COURSES` | **Sí** | **Debe ser `false` en producción** |

> **IMPORTANTE**: El proyecto actual usa ES256 (asimétrico via JWKS). Solo se necesita `SUPABASE_URL`. El guard verifica tokens automáticamente desde el endpoint JWKS público de Supabase.

> **PELIGRO**: `ALLOW_UNOWNED_COURSES=true` en producción permitiría a cualquier usuario ver cursos sin owner. Debe ser `false`.

---

## 2. Verificación de Supabase ES256/JWKS

Antes de deploy, confirmar que el proyecto Supabase usa ES256:

```bash
# Verificar que el JWKS endpoint responde y tiene claves EC
curl https://TU_PROJECT_REF.supabase.co/auth/v1/.well-known/jwks.json
# Debe devolver: {"keys": [{"alg": "ES256", "kty": "EC", ...}]}
```

Si la respuesta incluye `"alg": "ES256"` → usar `SUPABASE_URL` (no `SUPABASE_JWT_SECRET`).
Si la respuesta incluye `"alg": "HS256"` o falla → usar `SUPABASE_JWT_SECRET`.

El guard `SupabaseJwtGuard` selecciona automáticamente el modo:
- `SUPABASE_JWT_SECRET` presente → HS256
- `SUPABASE_URL` presente y `SUPABASE_JWT_SECRET` vacío → ES256/JWKS

---

## 3. CORS — Configuración

Verificar que `CORS_ORIGIN` incluye todos los orígenes del frontend:

```bash
# Ejemplo de producción
CORS_ORIGIN=https://orbia.pages.dev,https://www.cursia.com
```

Comprobación post-deploy desde el browser:
```javascript
fetch('https://tu-backend.com/health')
  .then(r => r.json())
  .then(console.log)
// No debe haber errores de CORS en la consola
```

---

## 4. Base de datos — Preparación para producción

### synchronize: false en producción

El backend usa `synchronize: true` en desarrollo (TypeORM crea/altera tablas automáticamente).
**En producción esto debe estar desactivado.**

Verificar en `src/database/database.module.ts`:
```typescript
synchronize: process.env.NODE_ENV !== 'production',
```

Con `NODE_ENV=production` y la base de datos vacía en el primer deploy, las tablas NO se crean automáticamente. **Opciones**:

**Opción A (recomendada para v1)**: Primer deploy con `synchronize: true` para crear tablas, luego cambiar a `false`.
- Riesgo: moderado. Solo hacerlo una vez en BD vacía nueva.

**Opción B**: Ejecutar el SQL de creación de tablas manualmente antes del deploy:
```sql
-- Ejecutar en la BD de producción
CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  sector VARCHAR(100),
  level VARCHAR(100),
  status VARCHAR DEFAULT 'draft',
  metadata JSONB,
  storage_provider VARCHAR(50),
  storage_folder_id VARCHAR(255),
  storage_folder_url TEXT,
  owner_id VARCHAR(36),
  owner_email VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_courses_owner_id ON courses (owner_id);

CREATE TABLE IF NOT EXISTS course_versions (
  id SERIAL PRIMARY KEY,
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  version_number INT NOT NULL DEFAULT 1,
  status VARCHAR DEFAULT 'draft',
  notes TEXT,
  snapshot_json JSONB,
  storage_provider VARCHAR(50),
  storage_file_id VARCHAR(255),
  storage_file_url TEXT,
  storage_folder_id VARCHAR(255),
  storage_path VARCHAR(500),
  snapshot_strategy VARCHAR(50),
  snapshot_size_bytes INT,
  snapshot_size_human VARCHAR(30),
  manifest_json JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Opción C (futuro)**: Implementar TypeORM Migrations para gestión formal de esquema.

### Backups
- Configurar backups automáticos diarios en el proveedor de PostgreSQL
- Retener al menos 7 días de backups
- Probar un restore de backup antes del go-live

---

## 5. Seguridad

- [ ] No hay secrets en el repositorio Git (`.env` en `.gitignore`)
- [ ] `.env.example` no contiene valores reales, solo placeholders
- [ ] `DB_LOGGING=false` en producción (no loguear queries con datos)
- [ ] Helmet activo (ya configurado en `main.ts`)
- [ ] CORS restringido a dominios específicos (no `*`)
- [ ] `/health` es el único endpoint público (sin token)
- [ ] Todos los endpoints `/api/v1/**` requieren token válido
- [ ] `ALLOW_UNOWNED_COURSES=false` en producción
- [ ] La contraseña de PostgreSQL es fuerte y única
- [ ] El servidor de BD no está expuesto públicamente (solo acceso desde backend)

---

## 6. Pruebas previas al go-live

Ejecutar estas pruebas desde un entorno externo (no localhost) contra el backend de staging/producción:

### Endpoints públicos
```bash
# Health check
curl https://tu-backend.com/health
# Esperado: {"data":{"status":"ok",...}}

# Info API
curl https://tu-backend.com/api/v1
# Esperado: {"data":{"name":"Orbia Backend",...}}
```

### Endpoints sin token → 401
```bash
curl https://tu-backend.com/api/v1/courses
# Esperado: {"statusCode":401,"error":"Token de acceso requerido"}

curl https://tu-backend.com/api/v1/auth/me
# Esperado: {"statusCode":401,...}
```

### Con token válido de Supabase
Obtener token desde el frontend logueado:
```javascript
// En consola del browser, logueado en orbia.pages.dev
const { data } = await window.SB.auth.getSession();
console.log(data.session.access_token); // copiar este valor
```

```bash
TOKEN="eyJhbGci..."

# Auth/me
curl -H "Authorization: Bearer $TOKEN" https://tu-backend.com/api/v1/auth/me
# Esperado: {"data":{"id":"uuid...","email":"user@...","role":"authenticated"}}

# Crear curso
curl -X POST https://tu-backend.com/api/v1/courses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Curso de prueba deploy"}'
# Esperado: {"data":{"id":1,"ownerId":"...","title":"Curso de prueba deploy",...}}

# Listar cursos
curl -H "Authorization: Bearer $TOKEN" https://tu-backend.com/api/v1/courses
# Esperado: {"data":[{"id":1,...}]}

# Crear versión
curl -X POST https://tu-backend.com/api/v1/courses/1/versions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"notes":"test deploy","snapshotJson":{"D":{"nombre":"test"},"F":{}},"storageProvider":"postgres_json"}'
# Esperado: {"data":{"id":1,"versionNumber":1,...}}

# Token inválido
curl -H "Authorization: Bearer token-invalido" https://tu-backend.com/api/v1/courses
# Esperado: {"statusCode":401,"error":"Token inválido o expirado"}
```

---

## 7. Checklist de deploy (paso a paso)

### Plataformas soportadas: Railway, Render, Fly.io, VPS con Docker

**Preparación:**
- [ ] Repositorio `orbia-backend` en `feature/auth-jwt` está limpio (`git status`)
- [ ] Build local pasa sin errores: `npm run build`
- [ ] TypeScript compila sin errores: `npx tsc -p tsconfig.build.json --noEmit`
- [ ] Base de datos PostgreSQL de producción creada y accesible

**Deploy:**
- [ ] Conectar el repo a la plataforma de hosting
- [ ] Configurar todas las variables de entorno (sección 1)
- [ ] Verificar que `NODE_ENV=production`
- [ ] Ejecutar build en la plataforma: `npm run build`
- [ ] Arrancar con: `npm run start:prod`
- [ ] Revisar logs de arranque — no debe haber errores de conexión a BD
- [ ] Revisar que las tablas `courses` y `course_versions` existen en la BD

**Verificación post-deploy:**
- [ ] `GET /health` → 200 con `"status":"ok"`
- [ ] `GET /api/v1/courses` sin token → 401
- [ ] `GET /api/v1/auth/me` con token válido → 200 con datos del usuario
- [ ] Crear curso desde el frontend real (no curl)
- [ ] Verificar que `owner_id` se guarda en la BD
- [ ] Listar cursos desde el frontend → solo aparecen los del usuario
- [ ] CORS no da errores en consola del browser

**Conectar frontend:**
- [ ] Actualizar `BACKEND_URL` en el frontend (si está hardcodeado) al dominio de producción
- [ ] Asegurar que `CORS_ORIGIN` incluye el dominio de producción del frontend
- [ ] Probar el flujo completo desde `orbia.pages.dev`

---

## 8. Pendiente para versiones futuras (no v1)

Estos puntos NO son bloqueantes para el deploy v1 pero deben abordarse después:

- **TypeORM Migrations**: reemplazar `synchronize: true` por migraciones formales
- **DATABASE_URL connection string**: soporte para proveedores que dan URL completa
- **Rate limiting**: protección contra abuso de endpoints de creación
- **Paginación**: `GET /courses` devuelve todos los cursos; en producción con muchos usuarios necesitará paginación
- **Logs estructurados**: Winston o similar para observabilidad en producción
- **Health check con DB**: el endpoint `/health` actual no verifica la conexión a PostgreSQL
- **Merge a main**: las ramas `feature/auth-jwt` y `feature/backend-cloud-save` deben mergearse a `main` después del primer deploy exitoso
