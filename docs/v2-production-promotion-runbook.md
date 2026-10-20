# Runbook: promoción de Cursia V2 a producción (r61)

**Estado:** preparación. **Nada de esto se ejecutó contra producción.** Cada paso que toca producción lo
dispara el owner (Nicolás), con su aprobación explícita.

**Fuentes:**
- `~/cursia-test-env/work/r60/D-quality-prod.md` §2: checklist, riesgos y plan por fases.
- `validation/r60-cursia-v2-optimizacion.md` §5.
- `docs/v2-production-migrations.md`: runner, DN-6 y backout N1. Este runbook no lo repite: lo ordena.

**Estados:**
- **READY:** está en el repo y probado (tests locales o en CI).
- **GAP:** falta código o una decisión técnica. Se describe qué falta.
- **OWNER-ACTION:** lo tiene que hacer o decidir el owner, en GitHub, Supabase, el VPS o con un proveedor.

---

## 0. Qué cambió en r61

| Pieza | Estado | Detalle |
|---|---|---|
| `.github/workflows/deploy.yml` endurecido | READY | Ver la lista debajo de la tabla. Pruebas: `scripts/ci/check-prod-deploy-hardening.js`, que ejecuta el bash con pm2/npm/sudo falsos. |
| `scripts/ops/prod-release.sh` | READY | Es el lado VPS del deploy: `preflight`, `snapshot`, `install`, `mark-ok` y `rollback`. |
| Rollback real | READY | `.release-prev/` guarda la última release **sana**; si un deploy queda a medias, el snapshot no se pisa. Se dispara con un dispatch `action=rollback`. Copia la release fallida a `.release-failed/` y **no** corre migraciones. |
| `scripts/prod/v2-schema-probes.js` | READY | Sondas de catálogo de solo lectura para **todos** los pasos del plan, incluidos los 6 de r60, y presencia de cada fila del seed de precios v1. El runner las usa en `--verify-only`; `deploy.yml` las corre por stdin antes del rsync. |
| `check-active-runs.js --legacy / --legacy-block` | READY | Informa de los jobs V1 del backend en curso. Con `PROD_DEPLOY_BLOCK_ON_V1_JOBS=true`, los que tienen lease vigente bloquean el deploy. |
| `gate-core.yml` en PRs a `main` y `release/**` | READY | Sin `CURSIA_FE_READ_TOKEN`, un PR de promoción falla de entrada. En PRs a staging sigue terminando BLOCKED (exit 3, también rojo). |
| Endpoint HTTP `/health/ready` (DB + workers + cola) | **GAP** (código de la app, fuera de r61/J) | Hoy `/health` solo indica que el proceso está vivo. El deploy compensa del lado del VPS: presencia de los 11 procesos, ventana de estabilidad y sonda de DB. Un monitor externo sigue sin poder ver si el servicio está listo. |

`deploy.yml` endurecido incluye:
- la guardia `DEPLOY_FREEZE` y el input `force_deploy`;
- la guardia de runs activos contra la base de **producción**;
- la aserción `NODE_ENV=production` del `.env`;
- los checks deterministas de staging que no necesitan Moodle;
- el gate REL R1 con el frontend, **obligatorio**;
- el drenado de los 3 workers dinámicos;
- flags V2 con defaults seguros;
- el esquema V2 verificado con fail closed (nunca se migra desde acá);
- presencia, estabilidad y sondas de la base después del deploy.

**V1 sigue igual:**
- Los mismos 8 procesos (backend más los 7 workers legacy), arrancados de la misma forma.
- Las mismas 2 migraciones: `migrate-production-jobs-constraints.js` y `migrate-usage-events-costs.js`.
- Lo verifica `check-prod-deploy-hardening.js` contra el `deploy.yml` de `origin/main`.
- Lo nuevo:
  - los 3 workers dinámicos, que no hacen nada con V2 apagado;
  - el bloque de flags;
  - las guardias.

**Qué `.env` toca el deploy.** Solo las claves de la tabla siguiente; las demás nunca. Un valor puesto a mano se respeta, salvo en las claves que el deploy fija con un valor exacto (marcadas **fija**).

| Clave | Sin canario | Con `PROD_V2_CANARY_OWNER` |
|---|---|---|
| `DYNAMIC_COURSE_STRUCTURE` | `false` si falta | **fija** `true` |
| `DYNAMIC_V2_ALLOWED_OWNERS` | no se toca | agrega el owner |
| `DYNAMIC_MANIFEST_RULES_VERSION` / `DYNAMIC_ACTIVITY_TYPE_RULES` | no se tocan | **fija** `3` / `2` |
| `DYNAMIC_VIDEO_DELIVERY`, `GAMMA_THEME_V21_*` | no se tocan | default si faltan (`youtube`, `default-light` / `default-dark`) |
| `PRESENTATION_LIGHT_DEFAULT_SINCE`, `DYNAMIC_PREBRIEF_REQUIRED_SINCE` | no se tocan | instante del primer deploy con canario; después queda congelado |
| `DYNAMIC_PROVIDER_WORKER_ENABLED`, `DYNAMIC_LLM_WORKER_ENABLED` | **fija** `false` | **fija** `true` solo con `PROD_V2_WORKERS_ENABLED=true` y sin `DYNAMIC_WORKERS_HOLD=true` |
| `DYNAMIC_LLM_WORKER_SINCE` / `_CONCURRENCY` | no se tocan | default si faltan, solo con workers encendidos |
| `OPENAI_TTS_MODEL` | **fija** `gpt-4o-mini-tts-2025-03-20` | ídem |
| `FINOPS_INGEST_TOKEN` | desde el secret `FINOPS_INGEST_TOKEN_PRODUCTION`, sin imprimirse | ídem |
| `DB_POOL_MAX`, `DB_POOL_MAX_WORKER`, `DB_POOL_IDLE_MS_WORKER` | solo si existe la variable `PROD_DB_POOL_*`; si no, aviso | ídem |

**Compuerta.** Si `DYNAMIC_COURSE_STRUCTURE=true` y `DYNAMIC_V2_ALLOWED_OWNERS` está vacío, V2 queda abierto a **todos** los owners (`isDynamicAllowedForOwner`). En ese caso:
- el deploy falla en el preflight, antes del rsync;
- y vuelve a fallar antes de `npm` y de PM2;
- salvo que exista `PROD_V2_GENERAL_AVAILABILITY=true`.

---

## 1. Secretos, environments y variables (una vez)

### 1.1 Tokens de lectura del frontend: OWNER-ACTION

| Secret | Lo usa | Hoy, sin el secret |
|---|---|---|
| `CURSIA_FE_READ_TOKEN` | `gate-core.yml`: corre E24 y los harnesses del frontend | PR a staging: BLOCKED (exit 3, rojo). PR a `main` o `release/**`: falla de entrada. |
| `FRONTEND_REPO_READ_TOKEN` | `deploy-staging.yml` (REL R1, opcional) y `deploy.yml` (REL R1, **obligatorio**) | Staging: se omite con un aviso. Producción: **el deploy falla**. |

Ambos son el mismo tipo de credencial y pueden tener el **mismo valor**. Se recomienda un PAT fine-grained:

1. GitHub (cuenta `nicolasmoreno2914`) → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → *Generate new token*.
2. Configurar:
   - **Name:** `cursia-fe-read-ci`.
   - **Expiration:** 90 a 365 días. Anotar un recordatorio de rotación; al vencer, los dos gates vuelven a fallar.
   - **Resource owner:** `nicolasmoreno2914`.
   - **Repository access:** *Only select repositories* → `nicolasmoreno2914/cursia`.
   - **Permissions → Repository → Contents: Read-only.** Metadata: Read-only se agrega solo. Nada más.
3. Repo `nicolasmoreno2914/cursia-backend` → Settings → Secrets and variables → Actions → **Repository secrets**:
   - `CURSIA_FE_READ_TOKEN` = el token;
   - `FRONTEND_REPO_READ_TOKEN` = el mismo token.

   Tienen que ser secrets de **repo**: `gate-core` no usa environment, y así los ven los jobs de los environments `staging` y `production`.
4. Verificar:
   - Actions → `gate-core` → *Run workflow*, rama `staging` → el resumen termina en `RESULTADO GATE-CORE: OK`.
   - El próximo deploy de staging ya no muestra el aviso «REL R1 gate frontend OMITIDO».

**Cómo los consumen los workflows** (verificado en r61):
- `gate-core` clona con `https://x-access-token:${TOKEN}@github.com/...`. GitHub acepta un PAT como contraseña con cualquier usuario. Después reescribe el remote sin el token.
- `deploy-staging.yml` y `deploy.yml` usan `actions/checkout` con `token:` y `persist-credentials: false`.
- `deploy.yml` hace checkout de `vars.PROD_FE_GATE_REF`, que es **obligatoria** y no tiene default. El `main` del frontend es V1: no tiene `src/js/45-dynamic-generation-executor.js`, así que el gate fallaría. El deploy también verifica que ese archivo exista.

**Alternativa: deploy key de solo lectura.**
- Pasos: `ssh-keygen -t ed25519`; la clave pública va en `cursia` → Settings → Deploy keys, **sin** permiso de escritura; la privada va como secret.
- Más acotada que un PAT (un solo repo, no vence), pero **no está cableada**: `actions/checkout` necesitaría `ssh-key:` y `gate-core` un `git clone git@github.com:…` con `GIT_SSH_COMMAND`.
- Estado: **GAP** si se elige esta opción.

### 1.2 Environment `production` (deploy.yml): OWNER-ACTION

Settings → Environments → `production` (ya lo referencia `deploy.yml`):

**Recomendado:**
- **Deployment branches:** solo `main`.
- Opcional: **required reviewers**. Haría que cada push a `main` espere aprobación; es la puerta natural para la promoción.
  - **Ojo:** el job `rollback` (y el auto-rollback, que es parte del job `deploy`) usa el mismo environment. Con reviewers, un rollback manual también espera la aprobación.
  - Si eso no es aceptable, hay dos salidas: un environment aparte `production-rollback` sin reviewers, con copias de los secrets `VPS_*`/`HEALTH_URL` (cambiar `environment:` del job `rollback`; **GAP**, no cableado), o el rollback manual 2b del §4.

**Secrets:**
- Ya existen: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_PATH`, `HEALTH_URL`.
- Nuevo: **`FINOPS_INGEST_TOKEN_PRODUCTION`**. Valor aleatorio, por ejemplo `openssl rand -hex 32`, **distinto** del de staging. Sin él, el deploy avisa y no toca la clave; con el canario encendido, el ingest de uso del navegador queda rechazado.

**Variables** (todas opcionales; el default es seguro):

| Variable | Default | Efecto |
|---|---|---|
| `DEPLOY_FREEZE` | vacío | `true` congela los deploys; el escape es un dispatch con `force_deploy=yes`. En el environment `production` congela solo producción; a nivel repo congela también staging. |
| `PROD_V2_CANARY_OWNER` | vacío (V2 apagado) | UUID del owner canario (fase 3). |
| `PROD_V2_WORKERS_ENABLED` | `false` | Con canario: worker de proveedores reales y worker de IA hospedado (**gasto**). |
| `PROD_V2_GENERAL_AVAILABILITY` | `false` | Único modo de permitir V2 con el allowlist vacío (fase 4, al final). |
| `PROD_DB_POOL_MAX`, `PROD_DB_POOL_MAX_WORKER`, `PROD_DB_POOL_IDLE_MS_WORKER` | vacío (no se toca) | Tamaño del pool por proceso (§2, capacidad). |
| `PROD_DEPLOY_BLOCK_ON_V1_JOBS` | `false` | Los jobs V1 con lease vigente bloquean el deploy (si no, solo se informan). |
| `PROD_FE_GATE_REF` | **ninguno (obligatoria)** | Rama o commit del frontend contra el que corre el gate REL R1: el frontend que se promueve (commit de release o `staging`). Después de la promoción del frontend puede pasar a `main`. Sin ella, todo deploy falla con instrucciones. |
| `PROD_SKIP_STORAGE_POLICY_PROBE` | `false` | Solo si el apply se hizo con `--skip-storage-policies` (decisión P15). Las sondas de Storage pasan a ser un aviso, pero los uploads del ejecutor V2 darían 403. |
| `PROD_AUTO_ROLLBACK` | activo | `false` desactiva el rollback automático tras un fallo **posterior** al rsync (install o health). En ese caso queda el estado `failed <sha>` y el rollback manual. |

### 1.3 Environment `production-v2-migrations`: OWNER-ACTION

Igual que en `docs/v2-production-migrations.md` §2b:
- **Required reviewers:** el owner (y nadie más).
- **Deployment branches:** solo `main`.
- **Variable de environment:** `V2_PROD_MIGRATIONS_ENV_GUARD=production-v2-migrations`.
- **Secrets de environment:** `V2_PROD_DB_HOST/PORT/USER/PASS/NAME`. Usar el pooler en modo sesión: puerto 5432, usuario `postgres.hriwbakbuypaiovvvkqh`.

**Importante.** `v2-production-migrations.yml` **todavía no está en `main`**: el `main` actual (`713a3f2`) no tiene el workflow ni el runner. Por eso:
- el workflow solo aparece en Actions **después** del merge de la promoción;
- el **apply inicial** (schema-first) se hace a mano desde un checkout del commit de release, en la fase 1;
- después del merge, el workflow sirve para `verify-only` y para re-aplicar (es idempotente).

**Lógica del workflow, revisada en r61 (READY):**
- `dry-run` corre solo el job `plan`, sin secretos ni red a la base.
- `verify-only` y `apply` esperan la aprobación del environment. El primer step exige la variable guard antes de leer cualquier secreto, y se exige `ref == main` y un `confirm_ref` de 20 caracteres.
- `apply` exige además `confirm_backup=yes` y fija el `planSha256` del job `plan`: los dos jobs hacen checkout del mismo `github.sha`, y cada `.sql` se re-hashea antes de aplicarse.
- Orden: el de staging, incluidos los 6 de r60. Lo exige `check-r60-prod-migrations-cover-staging.js`.
- Idempotencia: dos applies dejan un `pg_dump -s` idéntico (`run-local-pg-tests.js`).
- El backup **no** lo toma el workflow: `confirm_backup` es una declaración del owner (P1).
- No correrlo en paralelo con `deploy.yml`: usan grupos de concurrencia distintos. Si coinciden, la verificación del esquema del deploy puede ver el apply a medias y abortar (fail closed).

---

## 2. Precondiciones de negocio y capacidad

| # | Precondición | Estado | Qué hacer |
|---|---|---|---|
| P1 | Backup o PITR de la **base** de producción el día del apply | OWNER-ACTION | Supabase → Database → Backups: PITR con ventana de 7 días o más (es un add-on pago), o `pg_dump` fechado y guardado. Es la condición para `CONFIRM_BACKUP_TAKEN=yes`. |
| P2 | Backup de **Storage** (`cursia-artifacts`) | OWNER-ACTION / GAP | Los backups de la base no cubren Storage (r58 S4). Decidir: copia periódica del bucket, o asumir el riesgo por escrito. No hay código de retención (ni de checkpoints, snapshots o MBZ). |
| P3 | Límite de subida de Storage frente al tamaño de los paquetes | OWNER-ACTION | El límite global es de 50 MB y un `.mbz` real pesó 106 MB (Q-24). Opciones: subir el límite del proyecto (plan Pro), o esperar la externalización del audiolibro (Agente I, r61). Hasta decidir, los cursos grandes fallan al subir el paquete. |
| P4 | Cuota de YouTube | OWNER-ACTION | La cuota por defecto no cubre 9 o más videos por día (r58 O2). Pedir un aumento en Google Cloud Console → YouTube Data API v3 → Quotas antes de habilitar video real a más owners (fase 4). |
| P5 | Seed de precios v1 (41 filas) | READY | Lo inserta el hook `finops-pricing-seed` del runner, en la misma transacción del paso `v21-finops`. `deploy.yml` verifica las 41 filas (fail closed). |
| P6 | Propuesta de precios r60 verificada: 46 filas (`src/modules/finops/pricing-proposal.r60.json`). En staging ya están sembradas (sha `5757c0b73a2a6b8d`, LEDGER r61). | OWNER-ACTION + GAP | No la siembra ningún camino automático: el runner solo lee `pricing-seed.v1.json`. Ver la nota debajo de esta tabla. |
| P7 | Política de presupuesto de producción (`cost_budget_policies`) | OWNER-ACTION + GAP | Sin ninguna fila, todo run V2 va a `ADMIN_APPROVAL`. Las sondas lo avisan como información. `staging-budget-policy.js` es solo para staging. Decidir los topes por run, por curso, mensual y por owner, y crear un script de producción equivalente (pequeño, con aprobación) o insertar la fila a mano después del backup. |
| P8 | Techo diario no atribuido (`FINOPS_UNATTRIBUTED_DAILY_USD_GLOBAL` / `_PER_OWNER`), `FINOPS_KILL_SWITCH`, `FINOPS_PROVIDER_ALLOWLIST` | OWNER-ACTION | Decidir los valores y ponerlos a mano en el `.env` de producción: el deploy no los toca. |
| P9 | Pool de la base y plan de Supabase | OWNER-ACTION | Con V2 en `main` hay 11 procesos × `DB_POOL_MAX` (default 5) = 55 clientes. Staging usa 2/1/1000 contra un pooler de 15 clientes. Fijar `PROD_DB_POOL_*` según el límite real del pooler de producción **antes** de la fase 2; `check-db-pool-capacity.js` sirve de guía. El deploy solo **avisa** si falta (no lo exige, M7). En sesión con un tope bajo, los 3 procesos nuevos pueden dejar sin clientes a la API V1: decidirlo antes de la fase 2. |
| P10 | Memoria del VPS | OWNER-ACTION | Los 3 workers dinámicos nuevos ocupan unos 128 MB de RSS cada uno, aunque no hagan nada (node directo, sin el wrapper npm). Revisar `free -m` antes de la fase 2: el VPS es compartido con staging (11 procesos) y Videogen. |
| P11 | Moodle soportado | OWNER-ACTION | H5P Pack v3 necesita Moodle 4.5 o superior (Q-01/Q-02). Declararlo como requisito, o esperar el fix de compatibilidad. |
| P12 | `VIDEO_ENGINE_ENABLED` / `VIDEO_ENGINE_ALLOWED_OWNERS` (backend `.env` y Cloudflare Pages) | OWNER-ACTION | Ver `docs/ops/RELEASE-CHECKLIST.md` §1. Sin decidir, se usa el default seguro: el video V1 queda cerrado. `check-release-rollout-guard.js` avisa en cada deploy. |
| P13 | Hotfix #93 de `main` (artifacts authz) en el historial de staging | OWNER-ACTION | Mergear `main` en `staging` antes de la promoción (D §2.4 paso 1) y conservar `storagePathOwnedBy`. |
| P14 | Deprecación de TTS | OWNER-ACTION (planificar) | `gpt-4o-mini-tts`, en sus dos snapshots, se apaga el **2027-01-06** (verificado en r61). `OPENAI_TTS_MODEL` queda fijado en `-2025-03-20` hasta migrar a `gpt-realtime-2.1-mini`. |
| P15 | Decisiones DN-1..DN-6 y política de Storage UPDATE/DELETE | OWNER-ACTION | Ver `docs/v2-production-migrations.md`. |

**P6, cómo sembrar la propuesta r60 en producción.** Es append-only: filas nuevas con otro `pricing_version` y un `effective_from` posterior. Opciones:
- **(a)** Después del backup, ejecutar en el SQL editor de producción el mismo `insert … on conflict do nothing` que se usó en staging (`~/cursia-test-env/work/r60/seed-proposal.sql`).
- **(b)** Agregar al runner un hook `finops-pricing-proposal-r60` (código, con aprobación).

`deploy.yml` reporta cuántas de las 46 filas faltan, sin bloquear el deploy.

---

## 3. Fases

Todos los comandos con «producción» los corre el owner. Un agente nunca.

### Fase 0: preparar (USD 0, sin escrituras en producción)

| # | Paso | Estado | Criterio de OK |
|---|---|---|---|
| 0.1 | Tokens del frontend (§1.1) | OWNER-ACTION | `gate-core` termina en **OK** contra `staging`. |
| 0.2 | Mergear `main` en `staging` (P13) | OWNER-ACTION | `check-artifacts-authz.js` presente; gate-core OK. |
| 0.3 | Integrar r61 en staging (este cambio y los de G/H/I) | OWNER-ACTION (merge) | gate-core OK; el deploy de staging en verde. |
| 0.4 | Environments y variables (§1.2, §1.3) | OWNER-ACTION | Los environments existen con reviewers y la variable guard. |
| 0.5 | Decisiones P1–P15 anotadas | OWNER-ACTION | Anotadas en el PR de promoción. |
| 0.6 | PR de promoción `staging → main` (backend) y su par del frontend | OWNER-ACTION | `gate-core` corre en el PR a `main` (r61) con el frontend: **OK**. |

### Fase 1: esquema primero (antes del merge del código)

El código V2 todavía no está en `main`. El runner se corre desde un checkout del **commit de release**: `docs/v2-production-migrations.md` §2a, en el VPS o en la máquina del owner.

**1.1 Dry-run.** Sin red y sin secretos. Anotar el `Plan sha256`:

```bash
node scripts/prod/migrate-v2-production.js --env-file <env-solo-DB>
```

Criterio: exit 0, con 23 pasos `[included]`: el 0 builtin y los 22 `.sql`, incluidos los 6 de r60.

**1.2 DN-6.** El SQL de `docs/v2-production-migrations.md` §DN-6, de solo lectura. Los dos conteos deben dar 0.

**1.3 Verificación previa.** Solo lectura; muestra lo que falta:

```bash
MIGRATION_ENV=production CONFIRM_PRODUCTION_REF=hriwbakbuypaiovvvkqh DB_SSL=true \
  node scripts/prod/migrate-v2-production.js --env-file <env-solo-DB> --verify-only
```

Antes del apply sale con exit 5 (esperado).

**1.4 Backup (P1).** Recién después de tomarlo se usa `CONFIRM_BACKUP_TAKEN=yes`.

**1.5 Apply.** En una ventana de bajo tráfico (`lock_timeout` de 5 s):

```bash
MIGRATION_ENV=production CONFIRM_PRODUCTION_REF=hriwbakbuypaiovvvkqh CONFIRM_BACKUP_TAKEN=yes DB_SSL=true \
  node scripts/prod/migrate-v2-production.js --env-file <env-solo-DB> \
  --apply --i-understand-this-mutates-production --expect-plan-sha256 <sha de 1.1>
```

Criterio:
- termina en `✅ APPLY + verificación read-only OK.`;
- el bloque «sondas de catálogo» dice `esquema V2: COMPLETO` y `seed de precios: 41/41`.

**1.6 Smoke de V1 sobre el esquema nuevo**, con el código de `main` todavía: biblioteca, crear un curso, un job backend corto y descargar un artifact.

**1.7 (Opcional) Precios r60 (P6) y política de presupuesto (P7)**, si ya están decididos.

**Consultas de verificación** (solo lectura, en el SQL editor):

```sql
-- Los 6 pasos de r60
select (select pg_get_constraintdef(oid) from pg_constraint where conname = 'course_profiles_kind_check') as kinds,  -- incluye pedagogy y academic
       exists (select 1 from information_schema.columns where table_name='course_chapters' and column_name='chapter_kind') as practice,
       exists (select 1 from information_schema.columns where table_name='course_chapters' and column_name='application_minutes') as application,
       exists (select 1 from information_schema.columns where table_name='course_chapters' and column_name='guided_practice_minutes') as guided,
       exists (select 1 from information_schema.columns where table_name='course_chapters' and column_name='outcome_ids') as academic,
       to_regclass('public.course_prebrief_versions') is not null as prebrief;
-- Seed de precios y política de presupuesto
select pricing_version, count(*) from public.pricing_catalog group by 1 order by 1;
select count(*) as politicas from public.cost_budget_policies;
-- Nada dinámico todavía (V2 apagado)
select execution_mode, count(*) from public.production_jobs group by 1 order by 1;
```

**Rollback de la fase 1:** normalmente **ninguno**. Las migraciones son aditivas e inertes con V2 apagado. Si un paso falla, ese paso se revierte entero; se corrige y se re-corre (es idempotente). Restaurar el PITR solo ante corrupción, y es decisión del owner. Nunca hacer `DROP` como primera respuesta (`docs/v2-production-migrations.md` §Rollback).

### Fase 2: código con V2 apagado

**Precondiciones:**
- fase 1 OK;
- `PROD_V2_CANARY_OWNER` **vacío**;
- `PROD_DB_POOL_*` decididos (P9);
- `FINOPS_INGEST_TOKEN_PRODUCTION` cargado;
- `FRONTEND_REPO_READ_TOKEN` cargado;
- **`PROD_FE_GATE_REF`** = el commit de release o la rama del frontend que se promueve. Nunca el `main` V1 del frontend: el deploy falla en «Frontend del gate trae el ejecutor dinámico»;
- en el VPS, `sudo pm2 jlist` (o `pm2 status`): anotar qué workers V1 se reinician en bucle hoy. El deploy los tolera con un aviso: mide 15 s antes de tocar nada. `cursia-video-worker` con `VIDEO_WORKER_ENABLED≠true` y `cursia-gamma-worker` sin `GAMMA_API_KEY` se **detienen** en vez de reiniciarse en bucle;
- `NODE_ENV=production` como línea simple del `.env` (sin `export`). Si viene del ecosistema de PM2, el preflight falla a propósito (M9): agregar la línea;
- ventana sin runs V1 largos (`jobList()` en la consola).

**2.1 Merge.** El merge del PR de promoción a `main` dispara `deploy.yml`, en este orden:
1. Freeze.
2. Build y checks.
3. Gate REL R1 con el frontend.
4. **Preflight** en el VPS: `.env`, `NODE_ENV` y V2 no abierto a todos.
5. **Runs activos** (base de producción).
6. **Esquema V2 y seed** (fail closed).
7. Snapshot de la release actual en `.release-prev/`. Es la V1 de `main`, marcada `pre-r61`.
8. rsync.
9. `prod-release.sh install`.
10. Health.
11. `mark-ok`.

Si algo falla **antes del rsync** (pasos 1 a 6), producción **no cambia**.

Si algo falla **después** (pasos 9 o 10):
- `install` deja el estado `failed <sha>`;
- el paso **Auto-rollback** restaura `.release-prev/` (código y `node_modules`, sin npm y sin migrar);
- verifica `/health` y marca sana la release restaurada;
- el job queda en rojo igual.

Con `PROD_AUTO_ROLLBACK=false` no se restaura nada; queda el rollback manual.

**2.2 Seguimiento:**

```bash
gh run list --workflow=deploy.yml --limit=1        # completed / success
```

En el log del paso «Install…» deben aparecer:
- `✓ V2 apagado`;
- `+ OPENAI_TTS_MODEL`;
- la presencia `✓` de los 11 procesos;
- la estabilidad de 45 s;
- `esquema V2: COMPLETO`.

**2.3 Frontend.** El merge del par del frontend dispara Cloudflare Pages.

**2.4 Smoke de V1** con el código nuevo:
- todo lo de 1.6;
- `/health`;
- la ruta de audio TTS V1;
- el video V1 según P12;
- `notify.js` exige login (r58);
- `GET /api/v1/features` → `dynamicCourseStructure:false`.

**2.5 En el VPS:**
- `sudo pm2 status`: los 11 procesos de producción online;
- `cat /var/www/cursia-backend/.release-state` → `ok <sha>`.

**Rollback de la fase 2:**
- **Nivel 1 (sin deploy):** no aplica; V2 ya está apagado.
- **Nivel 2 (código):** Actions → **Deploy to Contabo VPS** → *Run workflow* → `action=rollback`. Hace lo siguiente:
  - restaura `.release-prev/` (la V1 `pre-r61`);
  - `npm install --omit=dev`;
  - recarga PM2. Como la V1 no tiene workers dinámicos, los detiene.
  - **sin migraciones**: el CHECK de `main` fallaría (N1) y el esquema es aditivo;
  - después, health y `mark-ok restored`.
- **Advertencia:** volver a la V1 **después** de que exista una fila `dynamic_*` (fase 3 en adelante) **no** es el backout soportado. Primero el nivel 1 (flags apagados); ver `docs/v2-production-migrations.md` §Backout N1.
- Pages: *Rollback to this deployment* sobre el deploy anterior del frontend.

### Fase 3: canario solo para el owner

**Precondiciones:**
- fase 2 estable al menos 24 h;
- P7 (política de presupuesto) creada;
- P3 decidido;
- frase explícita del owner «AUTORIZO …» para el gasto.

**Pasos:**
1. Variable `PROD_V2_CANARY_OWNER=<uuid del owner>`, con `PROD_V2_WORKERS_ENABLED` todavía **sin definir**. Luego *Run workflow* `action=deploy`. El log debe mostrar:
   - `DYNAMIC_COURSE_STRUCTURE: … → true`;
   - el owner en `DYNAMIC_V2_ALLOWED_OWNERS`;
   - reglas v3 y actividad 2;
   - instantes `*_SINCE` congelados;
   - workers de gasto `false`.
2. Verificar:
   - con otro owner, `GET /api/v1/features` → `dynamicCourseStructure:false`;
   - con el owner, `true`.
3. Primer curso 1×1 **sin gasto de proveedores**: video mock y workers apagados. Debe llegar a prebrief, Blueprint y Manifest.
4. Con aprobación de gasto (tope bajo): `PROD_V2_WORKERS_ENABLED=true` y redeploy. Luego un curso 1×1 real, empaquetarlo y restaurarlo en Moodle 4.5 o superior.
5. Conciliar las reservas pendientes con los endpoints de conciliación de SUPER_ADMIN (`charged_partial` de r60). El ledger es append-only.

**Rollback de la fase 3:**
- **Nivel 1, segundos:**
  1. Vaciar `PROD_V2_CANARY_OWNER` y redeployar. Los workers de gasto vuelven a `false`; `DYNAMIC_COURSE_STRUCTURE` queda en `true` con el allowlist del owner. Para apagar V2 del todo, editar el `.env`: `DYNAMIC_COURSE_STRUCTURE=false`.
  2. O, sin deploy: en el VPS, `DYNAMIC_WORKERS_HOLD=true` y/o `DYNAMIC_COURSE_STRUCTURE=false`, y después `sudo pm2 restart <los 11> --update-env`.
  3. Gasto: `FINOPS_KILL_SWITCH`.
- **Nivel 2:** `action=rollback`. Vuelve a la release V2 anterior; la V1 solo con las advertencias de N1.

### Fase 4: ampliar

1. Video real para owners listados: `DYNAMIC_REAL_VIDEO_OWNERS`, a mano en el `.env` (el deploy no la toca). Requiere P4.
2. Monitorear una semana con `scripts/ops/v2-health-report.js`, a mano o por cron (decisión del owner).
3. Agregar owners a `DYNAMIC_V2_ALLOWED_OWNERS`, a mano.
4. Disponibilidad general: `PROD_V2_GENERAL_AVAILABILITY=true` y vaciar el allowlist. Es la última decisión del owner.

**Rollback:** como en la fase 3.

---

## 4. Rollback: resumen

| Nivel | Cuándo | Cómo | Toca el esquema |
|---|---|---|---|
| 1a Gasto | Cortar el gasto V2 | `PROD_V2_CANARY_OWNER` vacío más redeploy. **Solo** apaga los workers de proveedores y de IA; V2 sigue encendido para el allowlist. Sin deploy: `DYNAMIC_WORKERS_HOLD=true` y/o `FINOPS_KILL_SWITCH` en el `.env`, más `pm2 restart --update-env`. | No |
| 1b V2 OFF | Comportamiento V2 | Editar el `.env`: `DYNAMIC_COURSE_STRUCTURE=false`, más `pm2 restart <los 11> --update-env`. El deploy no lo vuelve a encender sin canario: solo agrega `false` si falta. | No |
| 2 Código | Release rota | Automático si el fallo fue después del rsync (`PROD_AUTO_ROLLBACK`). Manual: `workflow_dispatch action=rollback`. `.release-prev/` es la última release marcada sana; la fallida queda en `.release-failed/`, sin `node_modules`. Antes de restaurar, el job normaliza el dueño de `VPS_PATH`. | No (no migra) |
| 2b Manual | Sin Actions | En el VPS, desde una **copia** del script (el rollback reescribe el árbol): `cp /var/www/cursia-backend/scripts/ops/prod-release.sh ~/prod-release.sh && bash ~/prod-release.sh rollback /var/www/cursia-backend`, verificar `/health` y luego `bash ~/prod-release.sh mark-ok /var/www/cursia-backend restored` | No |
| 3 Esquema | Solo ante corrupción | PITR (P1), decisión del owner | Sí |

**Mecánica del snapshot.**
- `snapshot` copia la release actual a `.release-prev/` **solo** si su estado es `ok <sha>` o si es la primera vez, sin estado (`pre-r61`).
- Un deploy que no llega a `mark-ok` deja el estado `deploying <sha>` o `failed <sha>`, y el próximo snapshot **conserva** la última release sana.
- El rsync del deploy excluye `.release-*`, así que nunca se borra.
- Es la release completa: código, `dist/` y **`node_modules`**, sin `.env`. Así el rollback no depende del registro de npm (M6). `dist.prev` sola no alcanzaría si cambian `package.json` o los scripts.
- Un snapshot sin `node_modules` (por ejemplo, uno anterior a este fix) cae a `npm install --omit=dev`.
- Volver a la V1 `pre-r61` **después** de que existan filas `dynamic_*` sigue sin ser el backout soportado (N1); primero el nivel 1b.

**Permisos del `.env` (I3).**
- Cada reescritura de una clave crea el temporal como copia del `.env` (`cp -p`, `umask 077`), así que el modo del archivo (por ejemplo, 0600) se conserva, y también el de `.env.bak`.
- Los valores pasan a `awk` por `ENVIRON`, no por argv: no quedan visibles en `/proc/*/cmdline` y las barras invertidas no se alteran.
- **`deploy-staging.yml` hereda el patrón viejo** (`awk -v …> "$tmp"; mv`), así que el `.env` de staging puede quedar en 0644 tras una reescritura. No se cambió en r61 para no chocar con el PR #156 (agente I, mismas líneas). Pendiente: aplicar el mismo arreglo ahí. Mientras tanto, `chmod 600 .env` a mano en staging.

---

## 5. Gates de CI

| Gate | Estado | Nota |
|---|---|---|
| `gate-core.yml` (PR a staging, `main` y `release/**`) | READY / OWNER-ACTION (token) | BLOCKED = exit 3 = **rojo**, nunca verde. En PRs de promoción falla de entrada sin `CURSIA_FE_READ_TOKEN`. Corre `scripts/ci/check-prod-deploy-hardening.js`. |
| Checks deterministas en `deploy.yml` | READY | Los de staging salvo `check-dynamic-package-worker-hardening` y `check-v21-packaging-v3` (necesitan Moodle, van en el gate completo), más los de producción. Paridad verificada por el check. |
| Gate completo con Moodle (`test/e2e-v2/run-e2e-v21.sh`) | Local | Sigue siendo local, requisito antes de la promoción. |
| Protección de ramas, CODEOWNERS, secret scanning (r58 S3) | OWNER-ACTION | Ver `docs/v2-production-migrations.md` §Protección de ramas. |

---

## 6. Observabilidad (GAP)

**Gaps:**
- `/health` solo indica que el proceso está vivo: no revisa la DB, la cola, la presencia de los workers ni los proveedores.
- No hay Sentry, Prometheus ni alertas.

**Compensación en r61 (READY):** en cada deploy y rollback se verifican del lado del VPS:
- la presencia de los 11 procesos;
- una ventana de estabilidad de 45 s: un reinicio en la ventana hace fallar el deploy, salvo para los workers V1 que ya se reiniciaban antes del deploy (aviso) y los deshabilitados por su flag (detenidos);
- una sonda de la base de solo lectura con el `.env` real.

**Pendiente (código de la app, con aprobación):**
1. `GET /health/ready`: DB (`select 1`), latido de `llm_worker_presence`, retraso de la cola y reservas trabadas.
2. Alertas mínimas:
   - worker ausente más de 5 minutos;
   - reservas pendientes de más de 1 hora (Q-06);
   - ritmo de gasto;
   - empaques fallidos;
   - cuota de YouTube.
3. Instalar el cron de `v2-health-report.js` con un canal de alerta (decisión del owner).

---

## 7. OWNER-ACTION (lista consolidada)

1. Crear el PAT fine-grained de solo lectura y cargarlo como `CURSIA_FE_READ_TOKEN` y `FRONTEND_REPO_READ_TOKEN` (repo secrets) — §1.1.
2. Environment `production`: solo `main`, reviewers opcionales, secret nuevo `FINOPS_INGEST_TOKEN_PRODUCTION` y variables — §1.2.
3. Environment `production-v2-migrations`: reviewers, `main`, variable guard y `V2_PROD_DB_*` — §1.3.
4. Backup o PITR de la base (P1) y decisión sobre el backup de Storage (P2).
5. Límite de Storage o espera de la externalización del audiolibro (P3). Cuota de YouTube (P4).
6. Aprobar la siembra de las 46 filas de precios r60 en producción (P6). Política de presupuesto de producción (P7). Techos y kill switch de FinOps (P8).
7. Pool de la base y plan del pooler: valores de `PROD_DB_POOL_*` (P9). Memoria del VPS (P10). Revisar qué workers V1 se reinician en bucle hoy (Fase 2).
7b. Variable **`PROD_FE_GATE_REF`** con el ref del frontend que se promueve (obligatoria). Decidir si los rollbacks necesitan un environment sin reviewers (§1.2).
8. Versión de Moodle soportada (P11). `VIDEO_ENGINE_*` en el backend y en Pages (P12). Merge de `main` en `staging` (P13). Plan de migración del TTS antes del 2027-01-06 (P14). DN-1..DN-6 (P15).
9. Correr la fase 1 (dry-run, DN-6, backup, apply y verify) desde un checkout del release.
10. Aprobar y mergear la promoción (fase 2). Variable `PROD_V2_CANARY_OWNER` (fase 3). `PROD_V2_WORKERS_ENABLED` con la frase AUTORIZO (fase 3.4). Ampliación (fase 4).
