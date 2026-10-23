# Estructura dinámica de cursos — Fase 0 + Fase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dejar preparado (Fase 0) y crear el modelo de datos relacional aditivo (Fase 1) para la estructura dinámica de cursos, sin tocar producción ni ningún camino de generación existente.

**Architecture:** Fase 0 no toca código — es verificación operativa de la infraestructura de staging ya existente y documentación de cómo usarla. Fase 1 agrega tablas (`course_modules`, `course_chapters`) y columnas nuevas (todas nullable o con default) a tablas existentes del backend (`courses`, `course_versions`, `artifacts`, `production_jobs`), vía una migración SQL idempotente aplicada solo contra la base de datos de Supabase de **staging**, más las entidades TypeORM correspondientes. Nada de esto tiene todavía un lector o escritor real — eso es trabajo de fases posteriores (2 en adelante), ya especificadas pero no planificadas en este documento.

**Tech Stack:** `orbia-backend` — NestJS 11, TypeORM, PostgreSQL (Supabase), Node 22, TypeScript 5.9. Sin Jest configurado en este repo (`"test": "echo 'no tests yet'"` en `package.json` — no hay `jest.config` ni `@nestjs/testing` en uso real todavía). La verificación de este plan sigue la convención real que ya usa el repo para cambios de esquema: scripts Node ad-hoc con `pg` (ver `scripts/migrate-production-jobs-constraints.js`) + `npx tsc --noEmit` para TypeScript, no un framework de test.

**Spec:** `docs/superpowers/specs/2026-09-23-dynamic-course-structure-design.md` (secciones -1, 0, A, G, y "Fase 0"/"Fase 1" dentro de la sección J).

## Global Constraints

- Todo este plan corre exclusivamente contra la base de datos de Supabase de **staging** — nunca contra producción. El script de migración (Tarea 2) debe leer sus credenciales del `.env` local del ejecutor (que debe apuntar a staging) y no debe existir ningún paso que lo ejecute contra producción como parte de este plan.
- Todas las migraciones son **aditivas**: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, con `DEFAULT` en toda columna `NOT NULL` sobre una tabla con filas existentes. Cero `DROP`, cero `RENAME`, cero reescritura de datos existentes (spec, sección -1, "Migraciones: solo aditivas").
- Ningún archivo de producción (código que hoy ejecuta un curso real, ej. `content-generation.service.ts`) se modifica en este plan — Fase 1 es solo esquema y entidades sin consumidores.
- Todas las claves foráneas nuevas usan `ON DELETE` explícito (`CASCADE` para hijos que no tienen sentido sin su padre — capítulos sin módulo, módulos sin curso — y `SET NULL` para referencias opcionales de trazabilidad — `generated_with_version_id`, `blueprint_version_id`).
- IDs de `course_modules`/`course_chapters` son `uuid` (vía `gen_random_uuid()`, ya usado en `docs/SCHEMA_SUPABASE.sql:165` para `artifacts.id` — la extensión ya está disponible en el proyecto de Supabase). `course_id` en las tablas nuevas es `integer`, igual tipo que `courses.id` (`SERIAL`).

## Review Focus

- **Migración corrida dos veces seguidas no debe fallar ni duplicar nada** — el spec exige idempotencia (`IF NOT EXISTS` en todo); el harness de la Tarea 2 corre la migración dos veces consecutivas como parte de su verificación, no una sola.
- **Ninguna fila existente de `courses`/`artifacts`/`production_jobs`/`course_versions` cambia de valor tras la migración** — solo se agregan columnas con default; el harness debe leer una fila existente antes y después y comparar que las columnas viejas no cambiaron.
- **Las nuevas columnas `NOT NULL` sobre tablas con filas existentes no pueden romper la migración** — `structure_version` en `courses` es `NOT NULL DEFAULT 'legacy'` justamente por esto; el harness verifica que cursos existentes (creados antes de esta migración) terminan con `structure_version='legacy'` sin haber sido tocados a mano.
- **Las FK nuevas no deben poder dejar huérfanos silenciosos** — insertar un `course_chapter` con un `module_id` inexistente debe fallar por la FK, no aceptarse; el harness prueba explícitamente este caso de error.
- **El script de migración no debe poder ejecutarse por accidente contra producción** — no hay una prueba de código para esto (es un límite operativo, no de software), así que la Tarea 2 documenta explícitamente, en el propio script, una comprobación de seguridad: si el `DB_HOST`/`DB_NAME` resuelto no contiene `staging` en ningún dato disponible del `.env`, el script exige una confirmación explícita por variable de entorno (`I_KNOW_WHAT_IM_DOING=yes`) antes de conectar — ver Tarea 2, Paso 3.

---

## Fase 0 — Preparación segura (verificación, sin código)

Fase 0, según el spec, **no tiene cambios de código** — `_resolveConfig()` en `campuscloud-gen/src/js/24-backend-client.js` ya hace lo correcto (backend OFF por defecto fuera de `cursia.nomaddi.com`). Es una sola tarea de verificación operativa + documentación.

### Task 1: Verificar infraestructura de staging y documentar cómo usarla

**Files:**
- Modify: `campuscloud-gen/CLAUDE.md` (agregar la nota de cómo apuntar el frontend de staging a su propio backend)

**Interfaces:**
- Consumes: nada (no depende de código de otras tareas).
- Produces: confirmación operativa de que el entorno de staging está sano, y una nota en `CLAUDE.md` que las tareas futuras (Fase 3 en adelante) pueden citar cuando necesiten probar el modo "backend + sesión" en staging.

- [ ] **Step 1: Confirmar que el backend de staging responde**

Run: `curl -sf https://api-staging.cursia.nomaddi.com/health`
Expected: JSON con `"status":"ok"`. Si falla, este plan se detiene acá — no tiene sentido seguir preparando Fase 1 contra una DB de staging cuyo backend no levanta. Reportar el fallo y parar.

- [ ] **Step 2: Confirmar que el pipeline de deploy de staging está verde**

Run (desde `orbia-backend`, requiere `gh` autenticado): `gh run list --workflow=deploy-staging.yml --limit=1`
Expected: última corrida `completed` / `success`. Si está `in_progress`, esperar y reintentar cada 15-20s en vez de asumir que ya terminó (regla ya documentada en `CLAUDE.md` del proyecto).

- [ ] **Step 3: Confirmar en Cloudflare Pages que `main` es la única rama con dominio custom**

Esto es una verificación manual en el dashboard de Cloudflare (Pages → proyecto → Settings → Custom domains / Branch deployments), no un comando. Confirmar: (a) el "Production branch" configurado es `main`, (b) `cursia.nomaddi.com` está asociado únicamente a ese branch, (c) `staging` cae en un deployment de preview sin dominio custom asociado.
Expected: los tres puntos confirmados. Si alguno no se cumple, anotarlo y NO continuar con fases posteriores de este spec hasta corregirlo — sería la única forma en que este trabajo podría alcanzar producción sin un merge explícito.

- [ ] **Step 4: Escribir la nota de uso en `CLAUDE.md`**

Agregar, en la sección de "Metodología de verificación en vivo (browser)" de `campuscloud-gen/CLAUDE.md`, el siguiente bloque:

```markdown
### Probar el modo "backend + sesión" en staging

Por defecto, el frontend de staging (`staging.orbia.pages.dev`) NO habla con
ningún backend — `_resolveConfig()` en `24-backend-client.js` solo activa el
backend automáticamente en `cursia.nomaddi.com` (producción). Para probar el
modo "backend + sesión" en staging, pegar en la consola del navegador:

    localStorage.setItem('CURSIA_BACKEND_ENABLED', 'true');
    localStorage.setItem('CURSIA_BACKEND_URL', 'https://api-staging.cursia.nomaddi.com');

y recargar. Sin estas dos líneas, staging opera en modo 100% local (sin
backend), que es el default seguro.
```

- [ ] **Step 5: Commit**

```bash
cd "/Users/nicolas/Documents/Claude course gen/campuscloud-gen"
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: documentar cómo apuntar staging a su propio backend

Fase 0 del plan de estructura dinámica de cursos — verificación de que
el entorno de staging (backend, deploy pipeline, dominio) está sano
antes de empezar Fase 1, y nota de uso para quien necesite probar el
modo "backend + sesión" ahí sin arriesgar hablar con producción.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Fase 1 — Modelo de datos (aditivo, solo staging)

### Task 2: Migración SQL aditiva + script de aplicación

**Files:**
- Create: `orbia-backend/supabase-migration-dynamic-course-structure.sql`
- Create: `orbia-backend/scripts/migrate-dynamic-course-structure.js`

**Interfaces:**
- Consumes: nada.
- Produces: tablas `course_modules`, `course_chapters`; columnas `courses.structure_version` (`text`, default `'legacy'`), `courses.structure_version_counter` (`integer`, default `0`), `course_versions.locked_at` (`timestamptz`, nullable), `artifacts.module_id`/`artifacts.chapter_id` (`uuid`, nullable), `artifacts.status` (`text`, nullable), `artifacts.generated_with_version_id` (`integer`, nullable), `production_jobs.blueprint_version_id` (`integer`, nullable). Estos nombres exactos son los que consumen las Tareas 3 y 4.

- [ ] **Step 1: Escribir la migración SQL**

Crear `orbia-backend/supabase-migration-dynamic-course-structure.sql`:

```sql
-- ══════════════════════════════════════════════════════════════════════════
-- Dynamic course structure — Fase 1 (modelo de datos, 100% aditivo)
-- Ver docs/superpowers/specs/2026-09-23-dynamic-course-structure-design.md
--
-- Esta migración SOLO agrega tablas/columnas nuevas. No modifica ni borra
-- ninguna fila existente. Corre exclusivamente contra la base de datos de
-- Supabase de STAGING — ver scripts/migrate-dynamic-course-structure.js
-- para el guardarraíl que lo exige.
-- ══════════════════════════════════════════════════════════════════════════

create table if not exists public.course_modules (
  id            uuid primary key default gen_random_uuid(),
  course_id     integer not null references public.courses(id) on delete cascade,
  position      integer not null,
  title         text not null,
  objective     text,
  exam_enabled  boolean not null default true,
  status        text not null default 'draft',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (course_id, position)
);

create table if not exists public.course_chapters (
  id                          uuid primary key default gen_random_uuid(),
  course_id                   integer not null references public.courses(id) on delete cascade,
  module_id                   uuid not null references public.course_modules(id) on delete cascade,
  position                    integer not null,
  title                       text not null,
  objective                   text,
  video_enabled               boolean not null default false,
  status                      text not null default 'not_generated',
  context_summary             jsonb,
  generated_with_version_id   integer references public.course_versions(id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (module_id, position)
);

alter table if exists public.courses
  add column if not exists structure_version text not null default 'legacy',
  add column if not exists structure_version_counter integer not null default 0;

alter table if exists public.course_versions
  add column if not exists locked_at timestamptz;

alter table if exists public.artifacts
  add column if not exists module_id uuid references public.course_modules(id) on delete set null,
  add column if not exists chapter_id uuid references public.course_chapters(id) on delete set null,
  add column if not exists status text,
  add column if not exists generated_with_version_id integer references public.course_versions(id) on delete set null;

alter table if exists public.production_jobs
  add column if not exists blueprint_version_id integer references public.course_versions(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'courses_structure_version_check') then
    alter table public.courses
      add constraint courses_structure_version_check
      check (structure_version in ('legacy', 'dynamic'));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'course_modules_status_check') then
    alter table public.course_modules
      add constraint course_modules_status_check
      check (status in ('draft', 'locked'));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'course_chapters_status_check') then
    alter table public.course_chapters
      add constraint course_chapters_status_check
      check (status in ('not_generated', 'generating', 'ready', 'stale', 'failed'));
  end if;
end $$;

create index if not exists idx_course_modules_course on public.course_modules(course_id);
create index if not exists idx_course_chapters_course on public.course_chapters(course_id);
create index if not exists idx_course_chapters_module on public.course_chapters(module_id);
create index if not exists idx_artifacts_module on public.artifacts(module_id);
create index if not exists idx_artifacts_chapter on public.artifacts(chapter_id);
create index if not exists idx_production_jobs_blueprint_version on public.production_jobs(blueprint_version_id);
```

- [ ] **Step 2: Escribir el script de aplicación, modelado en el patrón existente**

`scripts/migrate-production-jobs-constraints.js` ya establece el patrón (leer `.env`, conectar con `pg.Client`, `begin`/`commit`, rollback en error). Crear `orbia-backend/scripts/migrate-dynamic-course-structure.js`:

```js
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function assertLooksLikeStaging() {
  if (process.env.I_KNOW_WHAT_IM_DOING === 'yes') return;
  const host = String(process.env.DB_HOST || '');
  const name = String(process.env.DB_NAME || '');
  const looksLikeStaging = host.includes('staging') || name.includes('staging');
  if (!looksLikeStaging) {
    console.error(
      '❌ DB_HOST/DB_NAME no contienen "staging" — esta migración es para el\n' +
      '   entorno de staging únicamente (spec: 2026-09-23-dynamic-course-structure-design.md).\n' +
      '   Si estás seguro de que este .env apunta a staging bajo otro nombre,\n' +
      '   volvé a correr con I_KNOW_WHAT_IM_DOING=yes.'
    );
    process.exit(1);
  }
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  assertLooksLikeStaging();

  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true'
      ? { rejectUnauthorized: false }
      : false,
  });

  await client.connect();
  try {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../supabase-migration-dynamic-course-structure.sql'),
      'utf8',
    );
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    console.log('✅ Migración dynamic-course-structure aplicada (o ya estaba aplicada — es idempotente).');
  } catch (err) {
    await client.query('rollback');
    console.error('❌ Migración falló, rollback aplicado:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
```

- [ ] **Step 3: Correr el script contra staging por primera vez**

Run (desde `orbia-backend`, con un `.env` local apuntando a las credenciales de staging — las mismas que usa `deploy-staging.yml`, obtenidas del `.env` ya existente en `VPS_PATH_STAGING`):
`node scripts/migrate-dynamic-course-structure.js`
Expected: `✅ Migración dynamic-course-structure aplicada...`. Si el `.env` local no tiene `staging` en `DB_HOST`/`DB_NAME` y no se pasó `I_KNOW_WHAT_IM_DOING=yes`, el script debe rechazar correr — verificar este caso también corriendo el script una vez con un `.env` de prueba que no contenga "staging" en esos campos y confirmando que sale con el mensaje de error y código de salida 1, sin conectar a ninguna base.

- [ ] **Step 4: Correr el script una segunda vez (verificación de idempotencia)**

Run: `node scripts/migrate-dynamic-course-structure.js`
Expected: mismo mensaje de éxito, sin errores de "already exists" — confirma que todo el SQL usa `IF NOT EXISTS`/`DO $$ ... END $$` correctamente.

- [ ] **Step 5: Commit**

```bash
cd "/Users/nicolas/Documents/Claude course gen/orbia-backend"
git add supabase-migration-dynamic-course-structure.sql scripts/migrate-dynamic-course-structure.js
git commit -m "$(cat <<'EOF'
feat(db): modelo aditivo de estructura dinámica de cursos (Fase 1)

Agrega course_modules/course_chapters + columnas nullable/con-default en
courses, course_versions, artifacts y production_jobs. 100% aditivo, sin
lectores/escritores todavía (eso es Fase 2+). Corre solo contra staging
— el script rechaza correr si DB_HOST/DB_NAME no sugieren ese entorno.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

### Task 3: Harness de verificación de esquema contra staging

**Files:**
- Create: `orbia-backend/scripts/verify-dynamic-course-structure-schema.js`

**Interfaces:**
- Consumes: las tablas/columnas creadas por la Tarea 2 (nombres exactos listados en su bloque "Produces").
- Produces: un script reutilizable (`node scripts/verify-dynamic-course-structure-schema.js`) que las Fases 2+ pueden volver a correr como smoke test después de cualquier cambio de esquema relacionado.

- [ ] **Step 1: Escribir el harness — primero contra un esquema SIN la migración (paso RED)**

Antes de haber corrido la Tarea 2 en una base de datos limpia de prueba, este mismo script debe fallar de forma clara. Como ya corrimos la migración contra staging en la Tarea 2, este paso se verifica revirtiendo temporalmente: correr el harness (Step 3 de esta tarea) contra una base sin las tablas nuevas se puede simular apuntando `DB_NAME` a una base de Postgres local vacía (`createdb cursia_schema_check_temp`) — confirmar que el harness reporta claramente qué tabla/columna falta, nunca un stack trace crudo de `pg`.

- [ ] **Step 2: Escribir el harness completo**

```js
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const EXPECTED_COLUMNS = {
  course_modules: ['id', 'course_id', 'position', 'title', 'objective', 'exam_enabled', 'status', 'created_at', 'updated_at'],
  course_chapters: ['id', 'course_id', 'module_id', 'position', 'title', 'objective', 'video_enabled', 'status', 'context_summary', 'generated_with_version_id', 'created_at', 'updated_at'],
};

const EXPECTED_ADDED_COLUMNS = {
  courses: ['structure_version', 'structure_version_counter'],
  course_versions: ['locked_at'],
  artifacts: ['module_id', 'chapter_id', 'status', 'generated_with_version_id'],
  production_jobs: ['blueprint_version_id'],
};

async function tableColumns(client, table) {
  const res = await client.query(
    `select column_name from information_schema.columns where table_schema='public' and table_name=$1`,
    [table],
  );
  return res.rows.map((r) => r.column_name);
}

async function main() {
  loadEnvFile(path.resolve(process.cwd(), '.env'));

  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true'
      ? { rejectUnauthorized: false }
      : false,
  });

  await client.connect();
  const failures = [];

  try {
    // 1. Tablas nuevas y sus columnas
    for (const [table, expectedCols] of Object.entries(EXPECTED_COLUMNS)) {
      const cols = await tableColumns(client, table);
      if (cols.length === 0) {
        failures.push(`Tabla "${table}" no existe.`);
        continue;
      }
      for (const col of expectedCols) {
        if (!cols.includes(col)) failures.push(`Tabla "${table}" no tiene la columna "${col}".`);
      }
    }

    // 2. Columnas agregadas a tablas existentes
    for (const [table, expectedCols] of Object.entries(EXPECTED_ADDED_COLUMNS)) {
      const cols = await tableColumns(client, table);
      for (const col of expectedCols) {
        if (!cols.includes(col)) failures.push(`Tabla "${table}" no tiene la columna nueva "${col}".`);
      }
    }

    if (failures.length > 0) {
      console.error('❌ Verificación de esquema FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    // 3. Cursos existentes no fueron tocados: structure_version debe ser 'legacy' por default
    const existing = await client.query(
      `select id, structure_version from public.courses order by id limit 5`,
    );
    for (const row of existing.rows) {
      if (row.structure_version !== 'legacy') {
        failures.push(`Curso id=${row.id} tiene structure_version="${row.structure_version}", esperado "legacy" (no debería haber sido tocado por esta migración).`);
      }
    }

    // 4. FK real: insertar course_chapter con module_id inexistente debe fallar
    if (existing.rows.length === 0) {
      console.warn('⚠️  No hay cursos existentes en esta base — se omiten los checks 3 y 5 (requieren un curso real).');
    } else {
      const courseId = existing.rows[0].id;
      let fkRejected = false;
      try {
        await client.query(
          `insert into public.course_chapters (course_id, module_id, position, title) values ($1, gen_random_uuid(), 1, 'test')`,
          [courseId],
        );
      } catch (e) {
        fkRejected = /foreign key/i.test(e.message);
      }
      if (!fkRejected) failures.push('Insertar un course_chapter con module_id inexistente NO fue rechazado por la FK — se insertó un huérfano.');

      // 5. Insert real válido + lectura de vuelta + limpieza
      await client.query('begin');
      try {
        const mod = await client.query(
          `insert into public.course_modules (course_id, position, title) values ($1, 999, 'Módulo de verificación (borrar)') returning id`,
          [courseId],
        );
        const moduleId = mod.rows[0].id;
        const chap = await client.query(
          `insert into public.course_chapters (course_id, module_id, position, title) values ($1, $2, 1, 'Capítulo de verificación (borrar)') returning id, status`,
          [courseId, moduleId],
        );
        if (chap.rows[0].status !== 'not_generated') {
          failures.push(`Default de status en course_chapters vino "${chap.rows[0].status}", esperado "not_generated".`);
        }
      } finally {
        await client.query('rollback'); // nunca deja basura en la tabla, sea cual sea el resultado
      }
    }

    if (failures.length > 0) {
      console.error('❌ Verificación de esquema FALLÓ:');
      failures.forEach((f) => console.error('  - ' + f));
      process.exitCode = 1;
      return;
    }

    console.log('✅ Esquema de estructura dinámica verificado correctamente contra', process.env.DB_NAME);
  } finally {
    await client.end();
  }
}

main();
```

- [ ] **Step 3: Correr el harness contra staging (paso GREEN)**

Run: `node scripts/verify-dynamic-course-structure-schema.js`
Expected: `✅ Esquema de estructura dinámica verificado correctamente contra <nombre de la DB de staging>`. Si aparece cualquier `❌`, volver a la Tarea 2 y corregir la migración antes de seguir — no continuar a la Tarea 4 con un esquema no verificado.

- [ ] **Step 4: Confirmar que no quedó basura en la base**

Run: `psql "$DATABASE_URL" -c "select count(*) from course_modules where title like '%verificación%'"` (o el cliente que corresponda con las credenciales del `.env` de staging)
Expected: `0` — el harness hace su insert de prueba dentro de una transacción que siempre revierte (`rollback` en el `finally`), así que no debe quedar ninguna fila de prueba persistida.

- [ ] **Step 5: Commit**

```bash
cd "/Users/nicolas/Documents/Claude course gen/orbia-backend"
git add scripts/verify-dynamic-course-structure-schema.js
git commit -m "$(cat <<'EOF'
test: harness de verificación del esquema de estructura dinámica

Sin Jest configurado en este repo, se sigue el patrón ya usado para
migraciones (scripts/migrate-*.js): un script Node que verifica tablas,
columnas, defaults, e integridad referencial contra la base de datos
real de staging, sin dejar datos de prueba persistidos.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

### Task 4: Entidades TypeORM nuevas (`CourseModule`, `CourseChapter`)

**Files:**
- Create: `orbia-backend/src/modules/course-structure/entities/course-module.entity.ts`
- Create: `orbia-backend/src/modules/course-structure/entities/course-chapter.entity.ts`
- Create: `orbia-backend/src/modules/course-structure/course-structure.module.ts`
- Modify: `orbia-backend/src/database/database.module.ts`
- Modify: `orbia-backend/src/app.module.ts`

**Interfaces:**
- Consumes: tablas `course_modules`/`course_chapters` de la Tarea 2 (nombres de columna exactos del SQL).
- Produces: clases `CourseModule` y `CourseChapter` (exportadas desde sus archivos de entidad), y `CourseStructureModule` (exportado desde `course-structure.module.ts`, registrando ambas entidades vía `TypeOrmModule.forFeature`) — este es el punto de entrada que la Fase 3 (endpoints CRUD) va a importar para inyectar sus repositorios.

- [ ] **Step 1: Crear la entidad `CourseModule`**

`orbia-backend/src/modules/course-structure/entities/course-module.entity.ts`:

```ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { CourseChapter } from './course-chapter.entity';

@Entity('course_modules')
export class CourseModule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'course_id' })
  courseId: number;

  @Column()
  position: number;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  objective: string;

  @Column({ name: 'exam_enabled', default: true })
  examEnabled: boolean;

  @Column({ default: 'draft' })
  status: string; // draft | locked

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => CourseChapter, (chapter) => chapter.module)
  chapters: CourseChapter[];
}
```

- [ ] **Step 2: Crear la entidad `CourseChapter`**

`orbia-backend/src/modules/course-structure/entities/course-chapter.entity.ts`:

```ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { CourseModule } from './course-module.entity';

@Entity('course_chapters')
export class CourseChapter {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'course_id' })
  courseId: number;

  @Index()
  @Column({ name: 'module_id' })
  moduleId: string;

  @ManyToOne(() => CourseModule, (module) => module.chapters, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'module_id' })
  module: CourseModule;

  @Column()
  position: number;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  objective: string;

  @Column({ name: 'video_enabled', default: false })
  videoEnabled: boolean;

  @Column({ default: 'not_generated' })
  status: string; // not_generated | generating | ready | stale | failed

  /**
   * { concepts_introduced: string[], concepts_assumed: string[], key_terms: string[] }
   * Ver spec, sección C (Context Package).
   */
  @Column({ name: 'context_summary', type: 'jsonb', nullable: true })
  contextSummary: Record<string, any>;

  @Column({ name: 'generated_with_version_id', nullable: true })
  generatedWithVersionId: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

- [ ] **Step 3: Crear el módulo `CourseStructureModule`**

`orbia-backend/src/modules/course-structure/course-structure.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CourseModule as CourseModuleEntity } from './entities/course-module.entity';
import { CourseChapter } from './entities/course-chapter.entity';

@Module({
  imports: [TypeOrmModule.forFeature([CourseModuleEntity, CourseChapter])],
  exports: [TypeOrmModule],
})
export class CourseStructureModule {}
```

Nota: la entidad se importa como `CourseModule as CourseModuleEntity` porque `CourseModule` colisiona de nombre con el decorador `@Module` de NestJS en el mismo archivo — mismo tipo de colisión que hay que evitar en cualquier archivo que use ambos.

- [ ] **Step 4: Registrar las entidades en `DatabaseModule`**

Modificar `orbia-backend/src/database/database.module.ts` — agregar el import y sumarlas al arreglo `entities`:

```ts
import { CourseModule as CourseModuleEntity } from '../modules/course-structure/entities/course-module.entity';
import { CourseChapter } from '../modules/course-structure/entities/course-chapter.entity';
```

y en `entities: [...]`, agregar `CourseModuleEntity, CourseChapter` al final del arreglo existente (línea 28 actual).

- [ ] **Step 5: Importar `CourseStructureModule` en `AppModule`**

Modificar `orbia-backend/src/app.module.ts` — agregar el import
`import { CourseStructureModule } from './modules/course-structure/course-structure.module';`
y sumar `CourseStructureModule` al arreglo `imports` de `@Module({...})`.

- [ ] **Step 6: Verificar que compila**

Run: `cd "/Users/nicolas/Documents/Claude course gen/orbia-backend" && npx tsc --noEmit -p tsconfig.build.json`
Expected: sin errores. Si TypeORM se queja de la colisión de nombres `CourseModule`, confirmar que el alias `as CourseModuleEntity` se usó consistentemente en los 3 archivos que la importan (`course-structure.module.ts`, `database.module.ts`, y `course-chapter.entity.ts` si llegara a necesitarla — no debería, `course-chapter.entity.ts` importa `CourseModule` sin alias porque ahí no hay colisión con el decorador `@Module`).

- [ ] **Step 7: Verificar en runtime contra staging que TypeORM mapea correctamente**

Con el `.env` local apuntando a staging (mismo usado en la Tarea 2/3), arrancar el backend en modo desarrollo apuntando a esa base:
Run: `npm run start:dev` (esperar a que loguee que Nest arrancó sin errores de conexión ni de mapeo de entidades)
Expected: el log de arranque no debe mostrar ningún error de TypeORM sobre `course_modules`/`course_chapters` (columna faltante, tipo incompatible, etc.) — como `synchronize` está en `false` fuera de `NODE_ENV=development`, si `NODE_ENV` local es `development` prestar atención a que no intente alterar el esquema de staging; si el `.env` local no fija `NODE_ENV`, exportar `NODE_ENV=production` antes de este paso para evitar cualquier auto-sync accidental contra la base de staging real. Detener el proceso (`Ctrl+C`) apenas confirmado el arranque limpio — este paso es solo de verificación, no deja el servidor corriendo.

- [ ] **Step 8: Commit**

```bash
cd "/Users/nicolas/Documents/Claude course gen/orbia-backend"
git add src/modules/course-structure src/database/database.module.ts src/app.module.ts
git commit -m "$(cat <<'EOF'
feat(course-structure): entidades TypeORM CourseModule/CourseChapter

Mapean las tablas aditivas de la migración anterior. Sin controlador ni
service todavía — CourseStructureModule solo expone los repositorios
vía TypeOrmModule.forFeature, listo para que Fase 2/3 los consuma.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

### Task 5: Extender entidades existentes con las columnas nuevas

**Files:**
- Modify: `orbia-backend/src/modules/artifacts/entities/artifact.entity.ts`
- Modify: `orbia-backend/src/modules/production-jobs/entities/production-job.entity.ts`
- Modify: `orbia-backend/src/modules/courses/entities/course.entity.ts`
- Modify: `orbia-backend/src/modules/course-versions/entities/course-version.entity.ts`

**Interfaces:**
- Consumes: columnas creadas por la Tarea 2 sobre estas 4 tablas.
- Produces: campos nuevos en las 4 entidades (`moduleId`, `chapterId`, `status`, `generatedWithVersionId` en `Artifact`; `blueprintVersionId` en `ProductionJob`; `structureVersion`, `structureVersionCounter` en `Course`; `lockedAt` en `CourseVersion`) — nombres que las Fases 2+ van a leer/escribir directamente, así que deben coincidir exacto con esto.

- [ ] **Step 1: Extender `Artifact`**

En `orbia-backend/src/modules/artifacts/entities/artifact.entity.ts`, agregar después del campo `metadata` existente:

```ts
  @Column({ name: 'module_id', type: 'uuid', nullable: true })
  moduleId: string;

  @Column({ name: 'chapter_id', type: 'uuid', nullable: true })
  chapterId: string;

  @Column({ type: 'text', nullable: true })
  status: string; // ready | stale | disabled — null para artifacts legacy sin este concepto

  @Column({ name: 'generated_with_version_id', nullable: true })
  generatedWithVersionId: number;
```

- [ ] **Step 2: Extender `ProductionJob`**

En `orbia-backend/src/modules/production-jobs/entities/production-job.entity.ts`, agregar después de `contentSnapshotArtifactId`:

```ts
  @Index()
  @Column({ name: 'blueprint_version_id', nullable: true })
  blueprintVersionId: number;
```

- [ ] **Step 3: Extender `Course`**

En `orbia-backend/src/modules/courses/entities/course.entity.ts`, agregar después de `status`:

```ts
  @Column({ name: 'structure_version', default: 'legacy' })
  structureVersion: string; // legacy | dynamic

  @Column({ name: 'structure_version_counter', default: 0 })
  structureVersionCounter: number; // optimistic concurrency para ediciones de estructura
```

- [ ] **Step 4: Extender `CourseVersion`**

En `orbia-backend/src/modules/course-versions/entities/course-version.entity.ts`, agregar después de `createdAt`:

```ts
  @Column({ name: 'locked_at', type: 'timestamptz', nullable: true })
  lockedAt: Date;
```

- [ ] **Step 5: Verificar que compila**

Run: `cd "/Users/nicolas/Documents/Claude course gen/orbia-backend" && npx tsc --noEmit -p tsconfig.build.json`
Expected: sin errores.

- [ ] **Step 6: Re-correr el harness de la Tarea 3 para confirmar que nada se rompió**

Run: `node scripts/verify-dynamic-course-structure-schema.js`
Expected: mismo resultado en verde que en la Tarea 3 — este cambio es solo del lado TypeScript, la base de datos no cambió.

- [ ] **Step 7: Commit**

```bash
cd "/Users/nicolas/Documents/Claude course gen/orbia-backend"
git add src/modules/artifacts/entities/artifact.entity.ts src/modules/production-jobs/entities/production-job.entity.ts src/modules/courses/entities/course.entity.ts src/modules/course-versions/entities/course-version.entity.ts
git commit -m "$(cat <<'EOF'
feat(entities): agregar columnas de estructura dinámica a entidades existentes

Artifact, ProductionJob, Course y CourseVersion ganan los campos
nullable/con-default que la migración de Fase 1 ya agregó a sus tablas.
Sin ningún consumidor todavía — deja las entidades en sincronía con el
esquema real para que Fase 2+ pueda leer/escribir estos campos.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Al terminar

Con las 5 tareas completas: el esquema relacional de la Fase 1 existe y está verificado en staging, ningún curso existente cambió de comportamiento, y no hay ningún camino de código (frontend ni backend) que lea o escriba estas tablas todavía — eso es exactamente el objetivo de Fase 1 según el spec ("que exista el modelo relacional real, sin cambiar todavía ningún flujo de generación"). El plan de Fase 2 (dispatcher backend) se escribe como documento separado una vez esto esté mergeado a `staging` (nunca a `main`) y confirmado sano ahí.
