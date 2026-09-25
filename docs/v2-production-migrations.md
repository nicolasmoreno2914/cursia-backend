# Migraciones V2 en producción + reporte de salud (Fase 9, gap G6)

> Herramientas **inertes hasta que alguien las dispara a mano** (ruling B). Nada
> de esto corre en `deploy.yml` ni en `deploy-staging.yml`. Ningún agente las
> ejecuta contra producción: **el owner (Nicolás) aprueba y dispara cada paso.**
>
> Contexto: `campuscloud-gen/docs/autonomous-audits/audit-9-readiness.md` (G6 y
> observabilidad) y `campuscloud-gen/docs/v2-rollout/{runbook,rollback,monitoring-and-costs}.md`.
> Este documento cubre el **Paso 4** del runbook (migraciones de tabla V2) y la
> parte automatizable de `monitoring-and-costs.md`.

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

Mismo orden que `deploy-staging.yml`. Cada archivo corre en **su propia
transacción**; el runner se detiene en el primer error (los pasos anteriores
quedan commiteados — todos son idempotentes, se puede re-correr).

| # | Archivo | Equivalente staging |
|---|---|---|
| 1 | `supabase-migration-dynamic-course-structure.sql` | paso 3 |
| 2 | `supabase-migration-course-blueprints.sql` | 4b |
| 3 | `supabase-migration-generation-manifests.sql` | 4e |
| 4 | `supabase-migration-dynamic-generation.sql` | 4h |
| 5 | `supabase-migration-dynamic-generation-v2.sql` | 4h2 |
| 6 | `supabase-migration-invalidation.sql` (**placeholder**, Fase 8 — `carried_from_item_run_id`) | 4h3 (bloque `v2/f78-backend`) |
| 7 | `supabase-migration-storage-artifacts-policies.sql` | 4k |

Después, en solo lectura: los 7 `verify-*/audit-*` de V2 en modo
`production-readonly` + chequeo de las 4 políticas de `storage.objects`.

**Excluido a propósito:** `migrate-production-jobs-constraints.js` y
`migrate-usage-events-costs.js` (ya los corre `deploy.yml` en cada push a
`main`; no se duplican — el runner exige como **precondición** que el CHECK de
`production_jobs.execution_mode` ya acepte `dynamic_generation`/`dynamic_package`),
y las migraciones legacy (`p2-content-worker`, `brand-extraction-execution-mode`,
`dashboard-course-costs`).

**Placeholder (paso 6):** mientras el bloque de Fase 8 no esté integrado en la
rama, el archivo no existe → `--apply` se niega salvo que se pase
`--skip-unresolved-placeholders`. Cuando se integre con ese nombre (y el `.sql`
mencione `carried_from_item_run_id`), el paso queda incluido solo, sin tocar el
runner. **No activar el código de Fase 8 en producción si este paso se omitió.**

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

## Precondiciones (el owner, antes de `--apply`)

1. **Backup/PITR verificado** (runbook Paso 1.3): PITR activo en el proyecto
   `hriwbakbuypaiovvvkqh` con ventana ≥ 7 días, o `pg_dump` manual guardado y
   anotado. Solo entonces `CONFIRM_BACKUP_TAKEN=yes`.
2. **El merge a `main` ya ocurrió y `deploy.yml` terminó en verde**
   (`gh run list --workflow=deploy.yml --limit=1` → `completed/success`). El
   runner lo comprueba (CHECK de `execution_mode`) y se niega si no.
3. `DYNAMIC_COURSE_STRUCTURE` sigue en `false` en el `.env` de producción: las
   tablas quedan creadas pero inertes hasta el Paso 5 del runbook.
4. Ventana de bajo tráfico: los `ALTER TABLE` sobre `courses`, `artifacts` y
   `production_jobs` piden locks fuertes con `lock_timeout = 5s`; con tráfico
   pesado un paso puede fallar por timeout (sin efecto: rollback de ese paso) —
   simplemente se reintenta.

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

El runner **nunca lee `.env` implícitamente**: las credenciales vienen del
entorno o de `--env-file <ruta>` explícito (el entorno del proceso tiene
prioridad sobre el archivo). Los verify/audit hijos corren con `cwd` en un
directorio temporal vacío, así tampoco cargan ningún `.env`.

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
  • 1. [included] supabase-migration-dynamic-course-structure.sql
       sha256 d034b197…  (4744 bytes)
  …
  ! 6. [placeholder-unresolved] supabase-migration-invalidation.sql
  • 7. [included] supabase-migration-storage-artifacts-policies.sql
…
DRY-RUN: no se conectó a ninguna base.
```

Exit 0 (1 solo si falta un `.sql` obligatorio o alguno no es transaccional).

### 2a. Apply desde el VPS (opción recomendada: usa el `.env` de producción que ya existe)

```bash
ssh cursia@167.86.98.162
cd /var/www/cursia-backend            # VPS_PATH de deploy.yml
node scripts/prod/migrate-v2-production.js --env-file .env          # dry-run primero; anotar "Plan sha256"
MIGRATION_ENV=production \
CONFIRM_PRODUCTION_REF=hriwbakbuypaiovvvkqh \
CONFIRM_BACKUP_TAKEN=yes \
DB_SSL=true \
node scripts/prod/migrate-v2-production.js --env-file .env \
  --apply --i-understand-this-mutates-production \
  --expect-plan-sha256 <sha del dry-run> \
  [--skip-unresolved-placeholders]
```

(El código en el VPS es el de `main` desplegado por `deploy.yml`; este runner
llega ahí con el mismo merge.)

### 2b. Apply desde GitHub Actions (opcional)

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
Políticas actuales en storage.objects (N): …
▶ 1. supabase-migration-dynamic-course-structure.sql (sha256 d034b1978763…)
  ✓ commit (… ms)
… (pasos 2–5, 7; el 6 "⏭️ … [placeholder-unresolved] — no se aplica" si se omitió)
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
| 4 | apply detenido: precondición no cumplida (nada aplicado) o un paso falló (ese paso revertido; los anteriores commiteados) |
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
```

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
-s` idéntico), datos legacy intactos, los 7 verify/audit en modo **staging**
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

Umbrales por env (default): `V2_HEALTH_MAX_FAILED_ITEMS_24H=5`,
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
