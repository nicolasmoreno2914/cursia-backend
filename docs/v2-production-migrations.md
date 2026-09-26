# Migraciones V2 en producción + reporte de salud (Fase 9, gap G6)

> Herramientas **inertes hasta que alguien las dispara a mano** (ruling B). Nada
> de esto corre en `deploy.yml` ni en `deploy-staging.yml`. Ningún agente las
> ejecuta contra producción: **el owner (Nicolás) aprueba y dispara cada paso.**
>
> Contexto: `campuscloud-gen/docs/autonomous-audits/audit-9-readiness.md` (G6 y
> observabilidad) y `campuscloud-gen/docs/v2-rollout/{runbook,rollback,monitoring-and-costs}.md`.
> Este documento cubre las migraciones de tabla V2 en producción y la parte
> automatizable de `monitoring-and-costs.md`.
>
> **Release-fix C1 — SCHEMA-FIRST.** Las entities de este código mapean
> columnas V2 en tablas COMPARTIDAS con legacy (`courses`, `course_versions`,
> `artifacts`, `production_jobs`). Si el código V2 llega a `main` (deploy.yml →
> `pm2 reload`) antes que el esquema, **todo el legacy** falla con `42703
> column … does not exist` hasta migrar. Por eso el orden es: **primero el
> runner (esquema completo), después el merge**. El runner ya no exige que
> `deploy.yml` haya corrido: ensancha él mismo el CHECK de
> `production_jobs.execution_mode` (paso 0). Ver [Orden de rollout](#orden-de-rollout-en-producción-schema-first).
> El `runbook.md` del frontend (Paso 2 merge → Paso 4 migraciones) queda
> **superado** por este orden.

## Qué hay

| Archivo | Qué hace |
|---|---|
| `scripts/prod/migrate-v2-production.js` | Runner de migraciones V2 para producción. DRY-RUN por defecto. |
| `scripts/lib/v2-production-target.js` | Guardarraíl **positivo** de producción (compartido por runner y verify/audit). |
| `scripts/verify-*.js`, `scripts/audit-*.js` (7 de V2) | Modo nuevo **opt-in** `V2_VERIFY_MODE=production-readonly`. Sin esa env var se comportan exactamente como antes (solo staging). |
| `.github/workflows/v2-production-migrations.yml` | Workflow manual opcional (`workflow_dispatch` únicamente, environment con aprobación). |
| `scripts/ops/v2-health-report.js` | Reporte de salud V2 de solo lectura, con exit code para alertas. |
| `scripts/prod/test/run-local-pg-tests.js` | Tests de todo lo anterior contra un Postgres 16 local desechable. |

Los `scripts/migrate-*.js` de staging **no cambiaron** (siguen exigiendo
`MIGRATION_ENV=staging` y rechazando el ref de producción).

## Plan fijo (qué se aplica y en qué orden)

Mismo orden que `deploy-staging.yml`. Cada paso corre en **su propia
transacción**; el runner se detiene en el primer error (los pasos anteriores
quedan commiteados — todos son idempotentes, se puede re-correr).

| # | Archivo | Equivalente staging |
|---|---|---|
| 0 | `scripts/lib/production-jobs-constraints.js` — CHECK de `production_jobs.execution_mode` (+ `dynamic_generation`, `dynamic_package`) y `worker_status`. **Mismo SQL** que `scripts/migrate-production-jobs-constraints.js` (ambos usan esa lib). Pre-chequeo DN-6 de solo lectura antes de mutar nada; se omite (sin lock) si el CHECK ya está al día | `deploy.yml` / `deploy-staging.yml` |
| 1 | `supabase-migration-dynamic-course-structure.sql` | paso 3 |
| 2 | `supabase-migration-course-blueprints.sql` | 4b |
| 3 | `supabase-migration-v21-blueprint-profiles.sql` (V2.1 R3 — toggles de curso/capítulo, `course_profiles`; backfill de legado: cursos dinámicos existentes → `scorm`, sin examen final) | 4d2 |
| 4 | `supabase-migration-generation-manifests.sql` | 4e |
| 5 | `supabase-migration-dynamic-generation.sql` | 4h |
| 6 | `supabase-migration-dynamic-generation-v2.sql` | 4h2 |
| 7 | `supabase-migration-invalidation.sql` (Fase 8 — `carried_from_item_run_id`; ya integrado: `[included]`) | 4h3 |
| 8 | `supabase-migration-v21-manifest-v3.sql` (V2.1 R4 — tipos y conteos rulesVersion 3; va después de la v2) | 4h4 |
| 9 | `supabase-migration-storage-artifacts-policies.sql` | 4k |

Después, en solo lectura: el CHECK de `production_jobs` al día, los 9
`verify-*/audit-*` de V2/V2.1 en modo `production-readonly` y las 4 políticas de
`storage.objects`.

**V2.1 (fix round 1, review G2 I5):** el código V2.1 lee las columnas del paso 3
en las rutas de estructura. Si llega a una base sin ellas responde **503
`schema_not_migrated_v21`** (y lo loguea al arrancar), nunca un 500 crudo.
`scripts/prod/test/run-local-pg-tests.js` falla si algún
`supabase-migration-*.sql` no está ni en el plan ni en `EXCLUDED`. Migraciones
de bloques V2.1 posteriores (RF ledger, R6…) se agregan a este plan en su
propio bloque, con la misma regla.

**Config (review G2 M12):** con V2.1, un `DYNAMIC_MANIFEST_RULES_VERSION`
inválido (fuera de 1/2/3) hace fallar también el **confirmar estructura**
(lock del Blueprint) y `GET /features`, no solo la creación del Manifest
(fail loud). Revisar la variable antes de desplegar.

**Excluido a propósito:** el *script* `migrate-production-jobs-constraints.js`
no se invoca (su SQL es el paso 0; `deploy.yml` lo vuelve a correr en el merge,
idempotente, con la misma lista), `migrate-usage-events-costs.js` (no es V2;
lo sigue corriendo `deploy.yml`) y las migraciones legacy
(`p2-content-worker`, `brand-extraction-execution-mode`, `dashboard-course-costs`).

**Paso 6:** el bloque de Fase 8 ya está integrado, así que el paso queda
`[included]` y **no** hace falta `--skip-unresolved-placeholders`. (El
mecanismo de placeholder sigue en el runner por si se reutiliza: un paso
`[placeholder-unresolved]` hace que `--apply` se niegue salvo ese flag.)

**¿Políticas de Storage en producción? Sí.** El ejecutor dynamic de V2 (y el
`artifactUpload` legacy de `39-brandkit.js`/`41-course-setup.js`) sube a
`cursia-artifacts` desde el navegador con el JWT del usuario, y el frontend de
producción usa el mismo proyecto Supabase que esta base
(`hriwbakbuypaiovvvkqh`, `20-supabase.js`). Sin políticas, cada upload de un
item devuelve 403. Son mínimas (rol `authenticated`, bucket `cursia-artifacts`,
primer segmento del path = `auth.uid()`) y aditivas (políticas permisivas: si
producción ya tiene otras, solo se suman dentro de la carpeta propia). El
runner **imprime las políticas existentes** antes de aplicar. Si el owner
decide no aplicarlas: `--skip-storage-policies`.

## OBLIGATORIO antes de migrar y de mergear: chequeo de `production_jobs` (DN-6)

El paso 0 del runner **y** `deploy.yml` (que corre
`scripts/migrate-production-jobs-constraints.js` bajo `set -e` en **cada** push
a `main`) reconstruyen los CHECK de `production_jobs.execution_mode` y
`worker_status` con una lista fija que **no incluye `brand_extraction`** (nunca
la incluyó; la agregó a mano
`supabase-migration-brand-extraction-execution-mode.sql`). Si producción tiene
cualquier fila fuera de esas listas, el `ADD CONSTRAINT` falla (23514).

- **El runner lo chequea solo** (solo lectura, antes de mutar nada): si
  alguna fila violaría el CHECK, sale con **exit 4 sin aplicar NADA** y
  reporta `would_violate_execution_mode=N (valor=cantidad, …)` y
  `would_violate_worker_status=N (…)`.
- En `deploy.yml` el mismo fallo aborta el deploy **después** del rsync y
  **antes** del `pm2 reload` (código nuevo en disco con procesos viejos).

El owner igual corre esto a mano (solo lectura) con `psql` antes del Paso A
del rollout, para decidir DN-6 con tiempo:

```sql
begin transaction read only;
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.production_jobs'::regclass
   and conname in ('production_jobs_execution_mode_check','production_jobs_worker_status_check');
select execution_mode, count(*), max(created_at) from public.production_jobs group by 1 order by 1;
select count(*) as would_violate_execution_mode from public.production_jobs
 where execution_mode not in ('frontend','backend_content','backend_audio','backend_videos','backend_h5p',
   'backend_gamma','backend_package','backend_package_base','course_full_generation','backend_full_future',
   'dynamic_generation','dynamic_package');
select count(*) as would_violate_worker_status from public.production_jobs
 where worker_status is not null and worker_status not in ('queued','running','waiting_external','retrying',
   'paused','pausing','cancelling','completed','failed','failed_recoverable','failed_retryable',
   'needs_reconnect','blocked_quota','cancelled');
rollback;
```

Filas con `execution_mode` **NULL** no cuentan: el CHECK `execution_mode in
(…)` las acepta (evalúa a NULL, y PostgreSQL solo rechaza FALSE) y el `not in`
de arriba tampoco las cuenta. El runner usa exactamente el mismo criterio
(re-review N2).

**Resultado esperado: `would_violate_execution_mode = 0` y
`would_violate_worker_status = 0`.** Si alguno es > 0 (típicamente filas
`brand_extraction`), **no migrar ni mergear**: resolver DN-6 primero (opción
A: agregar `'brand_extraction'` a la lista de
`scripts/lib/production-jobs-constraints.js` — la usan el runner y el script
de `deploy.yml` — y decidir el worker) en un PR revisado. Anotar el resultado
(fecha + ambos conteos) junto al registro del backup. El histograma de
`execution_mode` también lo imprime el runner al hacer `--apply`.

## Precondiciones (el owner, antes de `--apply`)

1. **Backup/PITR verificado** (runbook Paso 1.3): PITR activo en el proyecto
   `hriwbakbuypaiovvvkqh` con ventana ≥ 7 días, o `pg_dump` manual guardado y
   anotado. Solo entonces `CONFIRM_BACKUP_TAKEN=yes`.
2. **El código V2 todavía NO está en `main`** (schema-first, release-fix C1).
   El runner se corre desde un checkout del **commit de release** (el mismo que
   después se mergea), no desde el VPS (que tiene el código de `main`, sin este
   runner). Ya **no** hace falta que `deploy.yml` haya corrido: el paso 0
   ensancha el CHECK. Si el runner se corre después del merge (re-apply o
   verificación), también funciona: todo es idempotente.
3. `DYNAMIC_COURSE_STRUCTURE` sigue en `false` (o ausente) en el `.env` de
   producción: las tablas quedan creadas pero inertes hasta activar el flag.
4. Ventana de bajo tráfico: los `ALTER TABLE` sobre `courses`, `artifacts` y
   `production_jobs` piden locks fuertes con `lock_timeout = 5s`; con tráfico
   pesado un paso puede fallar por timeout (sin efecto: rollback de ese paso) —
   simplemente se reintenta.

## Orden de rollout en producción (schema-first)

Reemplaza el orden "Paso 2 merge → Paso 3 smoke → Paso 4 migraciones" del
`runbook.md` del frontend. Cada paso lo dispara **el owner**; ningún agente
corre nada contra producción.

| Paso | Qué | Comando / criterio de OK |
|---|---|---|
| A0 | Decisiones previas: DN-1..DN-6, política de Storage (sección de abajo), `.env` de producción con `DYNAMIC_COURSE_STRUCTURE` ausente/`false` | anotado |
| A1 | DN-6 a mano (solo lectura) | SQL de la sección DN-6 → ambos conteos `0` |
| A2 | Backup | PITR ≥ 7 días o `pg_dump` fechado → anotado |
| A3 | Dry-run del runner desde el commit de release | `node scripts/prod/migrate-v2-production.js --env-file <env-solo-DB>` → exit 0, pasos 0..7 `[included]`, anotar `Plan sha256` |
| A4 | **Apply** (esquema V2 completo, código todavía de `main`) | `MIGRATION_ENV=production CONFIRM_PRODUCTION_REF=hriwbakbuypaiovvvkqh CONFIRM_BACKUP_TAKEN=yes DB_SSL=true node scripts/prod/migrate-v2-production.js --env-file <env-solo-DB> --apply --i-understand-this-mutates-production --expect-plan-sha256 <sha de A3>` → `✅ APPLY + verificación read-only OK.` (exit 0) |
| A5 | Smoke **legacy** con el código de `main` sobre el esquema nuevo | biblioteca de cursos, crear curso, un job backend corto, descargar un artifact → todo OK (esperado: solo cambios aditivos) |
| B1 | Merge del release a `main` | `deploy.yml` → `gh run list --workflow=deploy.yml --limit=1` = `completed/success` (su `migrate-production-jobs-constraints.js` re-aplica el mismo CHECK: idempotente) |
| B2 | Re-verificación (solo lectura) | `MIGRATION_ENV=production CONFIRM_PRODUCTION_REF=hriwbakbuypaiovvvkqh DB_SSL=true node scripts/prod/migrate-v2-production.js --env-file <env-solo-DB> --verify-only` → exit 0 |
| B3 | Smoke legacy con el código nuevo | mismo smoke que A5 |
| C | Allow-list y flag (Paso 5/6 del runbook) | primero `DYNAMIC_V2_ALLOWED_OWNERS` / `DYNAMIC_REAL_VIDEO_OWNERS`, después `DYNAMIC_COURSE_STRUCTURE=true`, `pm2 restart --update-env` de **todos** los procesos |

Notas:

- Entre A4 y B1 el esquema V2 existe con el código de `main`: inerte (tablas
  V2 vacías, columnas nuevas nulas o con default). Si A4 falla a mitad, los
  pasos commiteados son igual de inertes; se corrige y se re-corre.
- **Si hay un push a `main` entre A4 y B1** (p. ej. un hotfix), su
  `deploy.yml` corre el `migrate-production-jobs-constraints.js` de `main`, que
  vuelve a **angostar** el CHECK (sin `dynamic_*`). Es inofensivo con el flag
  OFF (no hay filas dynamic) y B1 lo vuelve a ensanchar; `--verify-only`
  antes de B1 lo reporta como "CHECK de production_jobs … NO coinciden".
- No mergear si A4 no terminó en exit 0: con el código V2 en `main` y el
  esquema viejo, el legacy entero falla con 42703.
- **HD-6 (decisión del owner):** desde B1, `deploy.yml` arranca/recarga
  también `cursia-dynamic-item-worker` y `cursia-dynamic-package-worker` con
  PM2 (mismo `ensure_pm2_process` y mismo `.env` que los demás workers). Con
  `DYNAMIC_COURSE_STRUCTURE` ausente/`false` quedan **inactivos**: no abren
  conexión a la DB, no reclaman jobs, no entran en loop de restart y salen con
  `0` ante SIGTERM. En el paso C, el `pm2 restart --update-env` de todos los
  procesos los activa. Lo prueba `scripts/check-deploy-dynamic-workers.js`
  (workers compilados contra un Postgres falso + `deploy.yml` = `origin/main`
  + exactamente esas 2 líneas; base configurable con `DEPLOY_YML_BASE_REF`).
  - **Flag antes de A4 (M5):** nunca poner `DYNAMIC_COURSE_STRUCTURE=true`
    antes de que A4 termine en exit 0. Si pasa igual, los workers ya no entran
    en crash-loop: ante `42P01` (tabla V2 inexistente) loguean UN error claro
    ("esquema V2 ausente …"), quedan inactivos y re-chequean cada
    `DYNAMIC_WORKER_SCHEMA_RECHECK_MS` (default 5 min); al aparecer el esquema
    retoman solos. El backend HTTP sí fallaría en las rutas V2 → corregir el
    orden igual.
  - **Memoria en reposo (M1):** cada worker dinámico inactivo ocupa ≈128 MB
    de RSS (importa `AppModule` antes del gate) + ≈40-50 MB del wrapper `npm`
    de `pm2 start npm` → ≈350 MB en total sin hacer nada. Revisar `free -m`
    en el VPS antes de B1. Si sobra poco: leer el flag antes de importar
    `AppModule`, o arrancar con `pm2 start dist/workers/…js` (sin npm).
  - **Check estricto de `deploy.yml` (M7):** `check-deploy-dynamic-workers.js`
    exige `deploy.yml` = `origin/main` + las 2 líneas (+ IPs de comentarios
    reemplazadas por `<VPS_HOST>`). Cualquier cambio legítimo posterior de
    `deploy.yml` (p. ej. un hotfix) necesita `DEPLOY_YML_BASE_REF=<ref>` o
    actualizar el check; tras el merge, la comparación pasa a ser identidad.

## Guardas (todas antes de conectar)

`--apply` exige **todo**; falta cualquiera → exit 3 y no se abre ninguna conexión:

- `MIGRATION_ENV=production`
- `CONFIRM_PRODUCTION_REF=<ref>` igual al ref parseado de `DB_HOST`
  (`db.<ref>.supabase.co`) o `DB_USER` (pooler `postgres.<ref>`); si ambos dan
  ref y difieren → rechazo
- el ref es el de producción conocido `hriwbakbuypaiovvvkqh` (cualquier otro →
  rechazo); el de **staging `ljdtmkwuhkvtmlhugjrv` → rechazo explícito** ("entorno equivocado")
- `CONFIRM_BACKUP_TAKEN=yes` (literal)
- flag `--i-understand-this-mutates-production`
- `DB_SSL=true`
- sin placeholders sin resolver (o `--skip-unresolved-placeholders`)
- opcional `--expect-plan-sha256 <hex>`: el plan revisado en el dry-run tiene
  que ser idéntico (el workflow lo usa automáticamente)

Ya conectado: el servidor debe tener el rol `supabase_admin` (es Supabase); se
verifican precondiciones en una transacción READ ONLY antes de mutar nada.

`--verify-only` exige lo mismo **menos** backup y el flag de mutación.

El runner **nunca lee `.env` implícitamente**. `--env-file <ruta>` es
explícito y **solo puede aportar claves de conexión**: `DB_HOST`, `DB_PORT`,
`DB_USER`, `DB_PASS`, `DB_NAME`, `DB_SSL` (el entorno del proceso tiene
prioridad). Cualquier otra clave del archivo — `MIGRATION_ENV`, `CONFIRM_*`,
`NODE_ENV`, `V2_TEST_*`, `V2_VERIFY_MODE`, `V2_DB_SSL_CA`, `V2_HEALTH_*` — se
**ignora** con un aviso que lista los nombres: aunque alguien ponga
`CONFIRM_BACKUP_TAKEN=yes` en el `.env` del VPS, la confirmación sigue
teniendo que escribirse en cada corrida. Los verify/audit hijos corren con
`cwd` en un directorio temporal vacío, así tampoco cargan ningún `.env`.

**TLS:** con `DB_SSL=true` y `V2_DB_SSL_CA=<ruta a un PEM>` (el CA de
Supabase, descargable desde el dashboard: Database → SSL) se verifican los
certificados (`rejectUnauthorized: true`). Sin CA, se mantiene el
comportamiento de los scripts existentes (`rejectUnauthorized=false`) y se
imprime un aviso explícito antes de conectar. `V2_DB_SSL_CA` inexistente →
rechazo antes de conectar. Recomendado para producción: definir el CA.

**Timeouts por paso:** antes de cada `.sql` el runner hace
`SET LOCAL lock_timeout = '5s'` y `SET LOCAL statement_timeout = '300s'` (el
`.sql` puede endurecerlos).

**Pooler:** para el apply usar conexión directa o el pooler en **modo
sesión** (5432). La verificación read-only funciona también detrás del modo
transacción: es una única `BEGIN TRANSACTION READ ONLY` por conexión (no un
setting de sesión) y el cliente rechaza cualquier `COMMIT`/`BEGIN`/`SET
SESSION`/`RESET`/`DISCARD` mientras dura.

## Comandos

### 1. Dry-run (cualquiera, no conecta)

```bash
node scripts/prod/migrate-v2-production.js
node scripts/prod/migrate-v2-production.js --plan-json > plan.json   # para adjuntar al runbook
```

Salida esperada (abreviada):

```
 Cursia V2 — migraciones de PRODUCCIÓN  [modo: DRY-RUN]
Plan sha256: <64 hex>
Pasos (en este orden, cada uno en su propia transacción):
  • 0. [included] scripts/lib/production-jobs-constraints.js
  • 1. [included] supabase-migration-dynamic-course-structure.sql
       sha256 d034b197…  (4744 bytes)
  …
  • 7. [included] supabase-migration-invalidation.sql
  • 8. [included] supabase-migration-v21-manifest-v3.sql
  • 9. [included] supabase-migration-storage-artifacts-policies.sql
…
DRY-RUN: no se conectó a ninguna base.
```

Exit 0 (1 solo si falta un `.sql` obligatorio o alguno no es transaccional).

### 2a. Apply ANTES del merge, desde un checkout del commit de release (recomendado)

El VPS tiene el código de `main` (sin este runner). Se usa un directorio
**aparte** — nunca `/var/www/cursia-backend` (lo pisa `deploy.yml` con
`rsync --delete`). Opción VPS (la red ya llega a la DB; reutiliza solo las
claves `DB_*` del `.env` de producción vía `--env-file`):

```bash
ssh cursia@<VPS_HOST>
git clone --branch <rama-de-release> --single-branch <url del repo orbia-backend> ~/cursia-v2-migrate
cd ~/cursia-v2-migrate && git checkout <sha de release> && npm ci --omit=dev
node scripts/prod/migrate-v2-production.js --env-file /var/www/cursia-backend/.env   # dry-run; anotar "Plan sha256"
MIGRATION_ENV=production \
CONFIRM_PRODUCTION_REF=hriwbakbuypaiovvvkqh \
CONFIRM_BACKUP_TAKEN=yes \
DB_SSL=true \
node scripts/prod/migrate-v2-production.js --env-file /var/www/cursia-backend/.env \
  --apply --i-understand-this-mutates-production \
  --expect-plan-sha256 <sha del dry-run>
```

Alternativa: la misma secuencia desde la máquina del owner (checkout del sha
de release, `npm ci`), con un archivo que tenga **solo** `DB_HOST`, `DB_PORT`,
`DB_USER`, `DB_PASS`, `DB_NAME` de producción (conexión directa o pooler en
modo sesión, 5432) pasado con `--env-file`.

### 2b. Apply desde GitHub Actions (opcional, SOLO después del merge)

El workflow corre únicamente desde `main`, así que **no sirve para el apply
inicial schema-first** (el código V2 todavía no está en `main`). Sirve para
re-verificar o re-aplicar (idempotente) después del merge.

**Setup del owner (una vez, antes del primer uso — decisión D):** GitHub
auto-crea un environment referenciado que no existe **sin** reviewers ni
política de ramas, y `secrets.*` también resuelve secretos del repo. Por eso:

1. Settings → Environments → **New environment** `production-v2-migrations`.
2. **Required reviewers:** el owner (y nadie más).
3. **Deployment branches:** solo `main` (rama protegida).
4. **Environment variable** `V2_PROD_MIGRATIONS_ENV_GUARD = production-v2-migrations`
   — **solo** en el environment, nunca como variable de repo u organización.
   El primer step del job `migrate` falla si no la ve; es la prueba de que el
   environment protegido existe (si GitHub lo auto-creara, no la tendría).
5. **Environment secrets** `V2_PROD_DB_HOST`, `V2_PROD_DB_PORT`,
   `V2_PROD_DB_USER`, `V2_PROD_DB_PASS`, `V2_PROD_DB_NAME` — **solo** en el
   environment; no crear secretos de repo/organización con esos nombres. Los
   secretos se leen únicamente en el último step, después del guard.

Workflow **V2 production migrations (manual, owner approval)** → *Run workflow*
desde `main`:
`mode=apply`, `confirm_ref=hriwbakbuypaiovvvkqh`, `confirm_backup=yes`
(+ `skip_unresolved_placeholders` si corresponde). El job `plan` corre sin
secretos; el job `migrate` espera la **aprobación del owner** en el environment
`production-v2-migrations` (ver cabecera del YAML: el owner debe crearlo con
required reviewers, branch `main` y los secretos `V2_PROD_DB_*`; usar el pooler
de Supabase en modo sesión, puerto 5432, usuario `postgres.<ref>`). Un
`workflow_dispatch` solo aparece en la UI cuando el archivo existe en `main`.

### 3. Verificación sola (read-only, repetible)

```bash
MIGRATION_ENV=production CONFIRM_PRODUCTION_REF=hriwbakbuypaiovvvkqh DB_SSL=true \
  node scripts/prod/migrate-v2-production.js --env-file .env --verify-only
```

### Salida esperada de un apply correcto

```
🎯 Objetivo: ref hriwbakbuypaiovvvkqh (DB_HOST)
Estado actual de tablas V2: course_modules=no, … generation_run_contexts=no
production_jobs por execution_mode: backend_content=…, frontend=…
CHECK de production_jobs: desactualizado (el paso 0 lo reconstruye)
  DN-6: would_violate_execution_mode = 0, would_violate_worker_status = 0
Políticas actuales en storage.objects (N): …
▶ 0. scripts/lib/production-jobs-constraints.js (sha256 …)
  ✓ commit (… ms)
▶ 1. supabase-migration-dynamic-course-structure.sql (sha256 d034b1978763…)
  ✓ commit (… ms)
… (pasos 2–7)
── verify: CHECK de production_jobs (read-only) ──
  ✓ execution_mode/worker_status coinciden con scripts/lib/production-jobs-constraints.js
── verify: políticas de storage.objects (read-only) ──
  ✓ cursia_artifacts_insert_own_folder (INSERT, roles={authenticated}) …
── verify: scripts/verify-dynamic-course-structure-schema.js ──
🔒 Modo production-readonly — ref hriwbakbuypaiovvvkqh; sesión READ ONLY, se omiten las sondas con escritura revertida.
⏭️  [production-readonly] sonda omitida (…)
✅ Esquema de estructura dinámica verificado correctamente …
… (los 7 verify/audit)
✅ APPLY + verificación read-only OK.
```

### Códigos de salida del runner

| Código | Significado |
|---|---|
| 0 | OK (dry-run, apply+verify o verify-only) |
| 1 | error inesperado (p. ej. no se pudo conectar) o plan con archivo obligatorio faltante |
| 2 | argumentos inválidos |
| 3 | **rechazado por las guardas** (no se conectó, o se conectó y el servidor no es el esperado) |
| 4 | apply detenido: precondición no cumplida — incluido DN-6 — (nada aplicado) o un paso falló (ese paso revertido; los anteriores commiteados) |
| 5 | migraciones aplicadas pero la **verificación falló** → no activar el flag |

## Modo `production-readonly` de los verify/audit

Solo si `V2_VERIFY_MODE=production-readonly` (lo pone el runner). Entonces el
script, en vez de sus guards de staging: aplica las mismas guardas de
objetivo (sin backup), verifica `supabase_admin`, pone la sesión en
`default_transaction_read_only = on` (cualquier escritura falla con 25006) y
**omite** las sondas que escriben dentro de una transacción revertida (inserts
de cursos/blueprints/manifests/runs de prueba y los UPDATE no-op de
inmutabilidad), anunciándolo con `⏭️ … sonda omitida`. Los chequeos de
catálogo (tablas, columnas, constraints, triggers, índices) y los invariantes
de datos sí corren. Esas sondas ya se validan en staging en cada deploy.

## Override solo-tests (documentado a propósito)

Para probar contra un Postgres local con un ref "falso tipo producción" hacen
falta **todas** a la vez:

1. `NODE_ENV=test`
2. el flag de CLI `--test-allow-local-target` (el runner **ignora** la env var
   `V2_TEST_ALLOW_LOCAL_TARGET`; solo se la pasa a sus hijos verify/audit)
3. `V2_TEST_FAKE_PROJECT_REF=<[a-z0-9]{6,40}>` (si es el ref de staging → rechazo)
4. `DB_HOST` loopback (`127.0.0.1`/`::1`/`localhost`)
5. ya conectado: el servidor **no** tiene el rol `supabase_admin` — aunque
   alguien tunelara producción a localhost, el override se rechaza.

Con el override solo se relajan "el ref debe ser el de producción conocido" y
`DB_SSL=true`; `MIGRATION_ENV`, `CONFIRM_PRODUCTION_REF`,
`CONFIRM_BACKUP_TAKEN` y el flag de mutación siguen siendo obligatorios. Un
override pedido pero incompleto es un rechazo (nunca cae silenciosamente al
modo normal). El workflow fija `NODE_ENV=production`.

## Tests

```bash
npm ci
node scripts/prod/test/run-local-pg-tests.js
npm run build && node scripts/prod/test/run-legacy-app-compat-test.js   # release-fix C1
```

`run-legacy-app-compat-test.js` (PG16 desechable, `127.0.0.1:55491`) es la
regresión de C1 que el E2E (esquema por `synchronize`) no puede detectar:
bootea las **entities compiladas** de esta rama contra
`legacy-baseline.sql` (= producción pre-V2; comprueba que coincide con las
entities de `main`), exige que las consultas legacy de
`courses`/`course_versions`/`artifacts`/`production_jobs` **fallen con 42703**
antes del runner y **pasen** después (sin correr antes el script de
`deploy.yml`), que el cambio en esas tablas sea **solo aditivo** (ninguna
columna nueva NOT NULL sin default; nada borrado ni cambiado) y que
INSERT/UPDATE con solo las columnas de `main` sigan funcionando (código viejo
contra esquema nuevo).

Levanta un Postgres 16 desechable (`initdb --locale=C`, `127.0.0.1:55481`,
data dir temporal, se destruye al final), carga un esquema legacy pre-V2
(`scripts/prod/test/fixtures/legacy-baseline.sql`) y corre el script **real**
`migrate-production-jobs-constraints.js` (lo que haría `deploy.yml`). Cubre
(40 casos): dry-run sin red (preload que prohíbe sockets y la carga de `pg` +
listener que cuenta conexiones + puerto cerrado), `--plan-json`, cada
confirmación faltante → exit 3 sin conectar, ref de staging rechazado (runner,
verify-only, override y verify directo), guards originales de staging intactos,
override contra un servidor con `supabase_admin` rechazado, precondición de
`deploy.yml`, apply limpio + verificación, segundo apply idempotente (`pg_dump
-s` idéntico), paso 0 schema-first (base con el CHECK de `main` → el runner lo
ensancha, CHECK idéntico al del script de `deploy.yml`, no-op si ya está al
día, `deploy.yml` después sin cambios, DN-6 con una fila `brand_extraction` →
exit 4 sin aplicar nada, `--verify-only` falla si el CHECK no está al día),
datos legacy intactos, los 7 verify/audit en modo **staging**
con todas sus sondas de escritura pasando sobre el esquema del runner, sesión
read-only (25006), stop en el primer error (paso 1 commiteado, paso 2 revertido
entero, 3+ sin aplicar), y el health report (rol solo-SELECT, alertas y umbrales).

No corre en CI (necesita Postgres); no es un `check-*.js`.

## Si algo falla

- **Exit 3/4 por precondición**: no se tocó nada (o solo los pasos listados en
  "Resumen apply"). Corregir y re-correr; todo es idempotente.
- **Exit 4 en un paso**: ese paso se revirtió entero. Si fue `lock_timeout`,
  reintentar en otra ventana. Si es otra cosa, **no improvisar SQL a mano**:
  guardar la salida y abrir un PR con el arreglo, revisado por el owner.
- **Exit 5 (verificación)**: no activar `DYNAMIC_COURSE_STRUCTURE`. Las tablas
  quedan inertes mientras el flag esté en `false`.

## Rollback (punteros)

- Principio (frontend `docs/v2-rollout/rollback.md` §Paso 4): el backout por
  defecto es **no activar el flag**; las tablas V2 vacías no afectan a legacy.
  Nunca `DROP TABLE` como primera respuesta.
- rulesVersion 2: `supabase-migration-dynamic-generation-v2.rollback.md`
  (orden, qué restaurar y por qué con filas v2 el rollback de esquema borra datos).
- Fase 8 (`carried_from_item_run_id`): SQL de rollback en la cabecera de
  `supabase-migration-invalidation.sql` (bloque `v2/f78-backend`).
- Políticas de Storage: `drop policy if exists cursia_artifacts_{insert,select,delete,update}_own_folder on storage.objects;`
  (solo si se decide explícitamente; rompe los uploads del ejecutor V2).
- **Código — el backout soportado es FLAG OFF, no un revert.** Ver la
  sección siguiente.

## Backout del código V2 en producción (re-review N1)

**Procedimiento soportado (siempre):**

1. En el `.env` de producción: `DYNAMIC_COURSE_STRUCTURE=false` (o borrar la
   línea). Para cortar solo el gasto de video, alcanza con sacar al owner de
   `DYNAMIC_REAL_VIDEO_OWNERS` (el worker lo re-chequea antes de cada submit
   a Videogen, release-fix I1). Opcional: vaciar `DYNAMIC_V2_ALLOWED_OWNERS`.
2. `pm2 restart <cada proceso> --update-env` — **todos**: API, workers legacy
   y `dynamic-item-worker`/`dynamic-package-worker` (los workers leen el flag
   al arrancar; uno sin reiniciar sigue reclamando items).
3. Verificar: `GET /api/v1/features` → `dynamicCourseStructure:false`; las
   rutas V2 devuelven 404; el legacy funciona igual (el código V2 con el flag
   OFF es el legacy de siempre + rutas V2 escondidas).

No hay que tocar el esquema: tablas y columnas V2 quedan inertes.

**NO soportado: revertir el código a `main` pre-V2 (git revert del merge) una
vez que existe cualquier fila `dynamic_generation`/`dynamic_package` en
`production_jobs`** (es decir, apenas alguien usó V2 con el flag ON).
Reproducido en local (PG16, `run-local-pg-tests.js`, caso "N1 reproducido"):
el push del revert hace que `deploy.yml` corra en `[2/4]` el
`migrate-production-jobs-constraints.js` de `main`, que reconstruye el CHECK
de `execution_mode` **sin** `dynamic_*`; el `ADD CONSTRAINT` falla con
**23514** (`check constraint … is violated by some row`), el script sale con
rc 1, `set -e` aborta el deploy **antes** de `pm2 reload`. Resultado: sin
daño de datos (la transacción revierte y el CHECK queda ancho), pero **el
rollback no ocurre** — siguen corriendo los procesos V2 con el código nuevo
en disco a medias (rsync ya hecho). Antes de cualquier fila dynamic el revert
sí pasaría (lo cubre `run-legacy-app-compat-test.js`: el código de `main`
funciona sobre el esquema migrado), pero no es el camino recomendado.

Si alguna vez hace falta sacar el código V2 del VPS (no solo apagarlo), la
única forma que no rompe `deploy.yml` es un **forward-revert** revisado que
quite el código de la app pero **conserve** `scripts/lib/production-jobs-constraints.js`
y el `scripts/migrate-production-jobs-constraints.js` actual (con
`dynamic_generation`/`dynamic_package`) — o, alternativamente, borrar antes
las filas dynamic de `production_jobs`, lo que es destrucción de datos
(decisión D del owner, con backup). Nunca hacerlo como primera respuesta.

**`lock_timeout` en `deploy.yml`** (release review Minor 5):
`migrate-production-jobs-constraints.js` ahora hace `SET LOCAL
lock_timeout = '5s'` y `statement_timeout = '300s'` antes de reconstruir los
CHECK. El SQL de las constraints no cambió (probado en PG16 contra la copia
verbatim del script de `main`, `fixtures/main-migrate-production-jobs-constraints.js`:
`pg_get_constraintdef` idéntico salvo los dos valores dynamic). Con tráfico
que retenga un lock sobre `production_jobs` más de 5 s, el paso `[2/4]` falla
con 55P03 (sin efecto, rollback) y el deploy aborta antes de `pm2 reload`:
**re-correr el deploy** (en vez de quedar encolado bloqueando a todos los
writers, como antes).

## Decisión del owner: políticas UPDATE/DELETE de Storage (release review, Minor 3)

`cursia_artifacts_update_own_folder` y `cursia_artifacts_delete_own_folder`
dejan que el navegador de un usuario (JWT `authenticated`) **sobreescriba o
borre cualquier objeto de su propia carpeta** de `cursia-artifacts` — incluidos
los artifacts dynamic inmutables (`<uid>/dynamic/…`) y los `dynamic_mbz` que
filas "carried" (REUSE, Fase 8) siguen referenciando. Eso **esquiva** la
protección de rutas compartidas de `ArtifactsService.remove()` (que solo cubre
el borrado vía API). Alcance: solo el contenido del propio usuario; el
empaquetado falla ruidoso si falta una fuente (no produce un `.mbz` roto en
silencio).

Opciones (no se cambió nada; decide el owner antes del Paso A):

1. **Aceptar** tal cual (estado actual; el legacy `artifactUpload` con
   `x-upsert:true` necesita UPDATE en su carpeta).
2. **Acotar** UPDATE/DELETE a los prefijos legacy (excluir
   `(storage.foldername(name))[2] = 'dynamic'`), dejando INSERT/SELECT como
   están. Requiere un `.sql` nuevo revisado y re-correr el runner.
3. **Quitar** DELETE del rol `authenticated` (los borrados pasan solo por la
   API con service role).

Anotar la decisión junto a DN-1..DN-6.
- Revertir el esquema completo es una decisión C/D del owner, con el backup
  del Paso 1.3 a mano.

## Observabilidad: `scripts/ops/v2-health-report.js`

Solo lectura (sesión `default_transaction_read_only = on` + `begin transaction
read only` + rollback; funciona con un rol que solo tenga `SELECT`). Reporta:

1. items dynamic **fallidos** 24 h por `type` y error (ids enmascarados);
2. **leases vencidos**: items y jobs `dynamic_generation`/`dynamic_package` en
   `running` con `lease_until` + margen en el pasado;
3. fallos de **`dynamic_package`** 24 h, y runs con >1 empaquetado activo (M9);
4. runs `dynamic_generation` activos hace más de N horas;
5. gasto **real de Videogen** (`output_summary.costUsd` de items `video` con
   `mode=real`) 24 h/7 d vs. estimación con la tarifa activa de `cost_rates`
   (`video_engine/video_generation/per_video`), + videos reales sin costo
   (subestimación) + gasto legacy informativo de `usage_events`;
6. bytes de **Storage** de artifacts dynamic (`item_run_id`/`manifest_id` no nulo).

Los textos de error (items fallidos y `error_message` de `dynamic_package`,
y los errores de conexión/consulta) se **redactan** antes de imprimirse: JWT
(`eyJ…`), `Bearer …`, parámetros `token=`/`sig=`/`key=`/…, URLs completas y
emails. `--env-file` solo aporta `DB_*` (igual que el runner): umbrales y
`V2_HEALTH_EXPECTED_REF` deben venir del entorno real o de la CLI. Para un rol
de mínimo privilegio en el pooler se acepta `DB_USER=<rol>.<ref de 20>` (p.
ej. `health_ro.hriwbakbuypaiovvvkqh`).

Umbrales por env (default; se aceptan fraccionarios, p. ej. `V2_HEALTH_LONG_RUN_HOURS=0.5`): `V2_HEALTH_MAX_FAILED_ITEMS_24H=5`,
`V2_HEALTH_LEASE_GRACE_MINUTES=10`, `V2_HEALTH_MAX_STUCK_LEASES=0`,
`V2_HEALTH_MAX_PACKAGE_FAILURES_24H=0`, `V2_HEALTH_LONG_RUN_HOURS=6`,
`V2_HEALTH_MAX_LONG_RUNS=0`, `V2_HEALTH_MAX_VIDEOGEN_USD_24H=25`,
`V2_HEALTH_MAX_VIDEOGEN_USD_7D=100`, `V2_HEALTH_MAX_SPEND_RATIO_7D=1.5`,
`V2_HEALTH_MAX_DYNAMIC_STORAGE_GB=20`. Los de gasto son placeholders: el owner
fija el presupuesto real antes del Paso 5 del runbook.

Exit: 0 OK · 2 umbral superado · 1 error · 3 ref distinto de `--expect-ref`.

```bash
# manual (VPS)
node scripts/ops/v2-health-report.js --env-file .env --expect-ref hriwbakbuypaiovvvkqh
node scripts/ops/v2-health-report.js --env-file .env --expect-ref hriwbakbuypaiovvvkqh --json
# cron sugerido (NO instalado; decisión del owner, igual que el canal de alerta)
*/30 * * * * cd /var/www/cursia-backend && node scripts/ops/v2-health-report.js --env-file .env --expect-ref hriwbakbuypaiovvvkqh >> /var/log/cursia-v2-health.log 2>&1 || <comando de alerta>
```

Antes de migrar, el reporte no falla: marca las métricas de items como n/a.

## Protección de ramas y CODEOWNERS (pre-aceptación V2)

`.github/CODEOWNERS` asigna a `@nicolasmoreno2914` los archivos de
release/producción: `.github/workflows/**`, `scripts/prod/**`,
`scripts/lib/**`, `scripts/migrate-*.js`, `scripts/ops/**`,
`scripts/deploy.sh`, `scripts/check-*.js`, `package.json`,
`package-lock.json`, `supabase-migration-*.sql`,
`docs/v2-production-migrations.md`, `test/e2e-v2/**` (y el propio
CODEOWNERS). `scripts/release/**` no existe todavía; se agrega cuando exista.

**Estado verificado (solo lectura, 2026-09-25):**

```bash
gh api repos/nicolasmoreno2914/cursia-backend/rulesets            # → 200 []  (ningún ruleset)
gh api repos/nicolasmoreno2914/cursia-backend/branches/main/protection  # → 404 "Branch not protected"
gh repo view nicolasmoreno2914/cursia-backend --json visibility   # → PUBLIC (plan de la cuenta: free)
```

- La premisa de que el repo es privado y que los rulesets no están
  disponibles en el plan actual **no se cumple**: el repo es **público**, y
  en repos públicos los rulesets y la branch protection **sí** están
  disponibles en el plan free (la API respondió 200, lista vacía). Si el repo
  pasa a privado en el plan free, esas APIs dejan de estar disponibles
  (requieren Pro/Team) y vale la nota original.
- Hoy **no hay ninguna regla** en `main` ni en `staging`: CODEOWNERS solo pide
  review automáticamente; no bloquea ningún merge ni push. Nada de esto se
  cambió desde acá: aplicar (o no) el ruleset es decisión del owner.
- Límite importante: los agentes operan con la cuenta del owner. Cualquier
  regla que el owner pueda saltear (admin bypass) también la pueden saltear
  esos agentes; y "require review from Code Owners" bloquea los PRs que abre
  la misma cuenta (nadie puede aprobar su propio PR). Por eso el ruleset
  recomendado exige PR + checks + sin force-push/borrado, y deja la review
  de Code Owners en `false` mientras haya un único colaborador.

**Ruleset recomendado** (aplicar cuando el owner lo decida, p. ej.
`gh api -X POST repos/nicolasmoreno2914/cursia-backend/rulesets --input ruleset.json`):

```json
{
  "name": "protect-main-staging",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["refs/heads/main", "refs/heads/staging"], "exclude": [] }
  },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    }
  ]
}
```

Ojo: la regla `pull_request` también prohíbe el push directo a `staging`
(hoy el flujo de aceptación pushea a `staging` directo); si se quiere
conservar ese flujo, dejar `staging` solo con `deletion` + `non_fast_forward`
en un segundo ruleset.

Con un segundo colaborador con permisos de escritura, subir
`required_approving_review_count` a `1` y `require_code_owner_review` a
`true` (ahí CODEOWNERS pasa a bloquear). Un check de estado requerido
(`required_status_checks`) solo tiene sentido cuando exista un workflow de CI
en PRs (hoy los `scripts/check-*.js` corren en `deploy-staging.yml`, al
pushear a `staging`, no en PRs).

### Exposición del repo público (M6)

La IP del VPS se quitó de los comentarios y docs de esta rama (placeholder
`<VPS_HOST>`; los workflows toman el host del secret `VPS_HOST`, sin cambio
de comportamiento). **Sigue en el historial de git** (commits anteriores y
`main` hasta el merge). Recomendado al owner: correr una vez un escaneo de
secretos sobre TODO el historial (p. ej. `gitleaks detect --source . --log-opts="--all"`),
confirmar SSH solo con clave + fail2ban en el VPS, y decidir la visibilidad
(privado en plan free = sin rulesets; público = aplicar el ruleset de arriba).

## Allow-list de staging (M2)

El paso [0b] de `deploy-staging.yml` agrega el owner de prueba
`aa2fa9a1-afb1-4b01-8646-94a0cb272b57` a `DYNAMIC_V2_ALLOWED_OWNERS`. Si la
clave NO existía, staging pasa de "V2 para todas las cuentas" a "V2 SOLO para
ese owner": cualquier otra cuenta (segundo tester,
`scripts/verify-course-structure-fase2.js` con su `TEST_OWNER_ID` por
defecto) recibe 403 en las rutas V2 y vuelve a ver solo legacy. Para
habilitar otra cuenta: agregar su UUID a mano a la lista en el `.env` de
staging y `pm2 restart --update-env`. Sus cursos legacy con gemelo V2 (abiertos
alguna vez en «Estructura») conservan el audio legacy (fix I1).
