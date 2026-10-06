# LOOP 7 · 7.8 — Preparación para producción (documento final, sin cambios en producción)

Fecha: 2026-10-06. **Nada de esto se ejecutó**: no hubo cambios en producción ni merge a `main`. Este documento es
el plan exacto, y lo que exige decisión del dueño está marcado.

## Actualizaciones del LOOP 7 sobre el plan de abajo (léase primero)

1. **Seguridad: corregir en `main` ANTES y POR SEPARADO del release V2.1 (requiere aprobación del dueño).**
   `POST /artifacts` acepta cualquier `storage_path`/`storage_bucket`; luego `GET /artifacts/:id/download-url` lo
   firma y `DELETE` lo borra con la service role (ignora RLS). Cualquier usuario autenticado que conozca la ruta de
   otro puede descargar o borrar sus archivos. El mismo patrón está en `main` (`src/modules/artifacts/`). El arreglo
   de staging (commit `4a2a866` de `chore/loop7-hardening`: `storagePathOwnedBy` en `create()`, firma y borrado + tope
   de `expires`) es pequeño y aislado: candidato a un PR propio contra `main` (hotfix) sin esperar el release.
2. **Presupuesto (§6.2 corregido).** La política bloquea cuando el costo **esperado** del run supera el límite
   (`normal-approval.ts`), y el monto autorizado es `min(máximo estimado, límite restante)`. Estimados reales del
   microcurrículo de 64 h (los dos diseños posibles según el enfoque):

   | Diseño a 64 h | Capítulos (video) | Esperado | Rango | Videogen · Gamma · TTS · Anthropic |
   |---|---|---|---|---|
   | Aplicación primero (competencias, ABP) | 23 (18) | ≈ USD 64 | 41–157 | 19,46 · 12,42 · 5,28 · 27,28 |
   | Profundidad primero (significativo, o «Ajustar» → profundidad) | 26 (25) | ≈ USD 84 | 55–204 | 27,03 · 17,25 · 7,32 · 32,77 |

   (Los 54,70 de la Fase 6 eran el curso RCP de 3×3.) Con `maxCostPerRun = 60` cualquiera de los dos quedaría
   bloqueado. Propuesta corregida:
   - Validación real (1 curso, owner interno): `maxCostPerRun = 100`, `maxCostPerCourse = 130` (run + una
     regeneración parcial), `monthlyCap = 200`, `on_exceed = ADMIN_APPROVAL`, `require_human_approval_for_real_spend = true`.
   - Lanzamiento acotado: `maxCostPerRun = 110`, `maxCostPerCourse = 150`, `monthlyCap` = cursos esperados × 90 USD,
     recalibrado con 2–4 semanas de ledger real.
3. **Restauración en Moodle con override del solucionario.** Cada solucionario lleva `mod/page:view` = PROHIBIT para
   el rol estudiante. Un restore web (admin o docente con edición) lo aplica; el CLI `admin/cli/restore_backup.php`
   NO (no tiene sesión) y deja solo el ocultamiento. Si un cliente restaura por CLI, debe hacerlo con sesión de admin
   (ver `scripts/moodle/restore-as-admin.php`) o verificar el override después.
4. **Smoke post-deploy (§9) — agregar:** con el flag ON para el owner interno, un curso pequeño con Actividades de
   Aplicación restaurado en el Moodle del cliente, con un estudiante de prueba: ve la actividad, no ve el
   solucionario, y tampoco puede abrirlo si el docente lo «muestra» por error (mismo chequeo que
   `scripts/moodle/v21-application-visibility.php`).
5. **Variables (§4) — agregar:** `ALLOW_UNOWNED_COURSES` debe quedar `false` en producción (con `true`, cualquier
   usuario lee y escribe cursos sin dueño). `SUPER_ADMIN_EMAILS`: el rol se decide por el email del JWT; usar solo
   correos de cuentas con email verificado.
6. **Costo mostrado vs autorizado.** El panel estima con los precios de referencia del seed (rotulados como
   estimación, con rango y supuestos); la pantalla de aprobación usa `pricing_catalog` de la base y palabras medidas.
   Si un admin cambia una tarifa en producción, actualizar también el seed para que coincidan.
7. **Divergencia staging/main (§10):** sin cambios en la recomendación (opción B, release curado). El LOOP 7 suma
   ~15 commits de hardening en `chore/loop7-hardening` que deben entrar al release (todos V2 salvo el hotfix de
   seguridad, que va antes y por separado).

---

# A5 — Documento final de preparación para producción (Cursia V2/V2.1)

Fecha: 2026-10-06 · Solo lectura (sin servidores, sin DB, sin red salvo `git fetch`). No se tocó ningún repo.
Basado en `docs/superpowers/audits/2026-10-06-fase6-auditoria-produccion.md` (backend, no se redujo ni se repitió su
análisis) + lectura directa de `docs/v2-production-migrations.md`, `scripts/prod/migrate-v2-production.js`,
`.github/workflows/{deploy,deploy-staging,v2-production-migrations}.yml`, `.env.production.template`,
`src/modules/features/dynamic-features.ts`, `src/modules/finops/{normal-approval,finops-budget.service,run-budget}.ts`,
`scripts/staging-budget-policy.js`, `docs/v2-rollout/*` (frontend) y `docs/autonomous-audits/dn7-closure-analysis.md`
(frontend), más mediciones `git` directas sobre los worktrees `$S/r26/be` (HEAD `ce6bf25`) y `$S/r26/fe` (HEAD `bc684e4`).

**Hallazgo que actualiza la auditoría Fase 6 (importante):** la Fase 6 se escribió sobre backend HEAD `8ed93a9` y
decía *"la Fase 5 todavía no está en staging"*. Desde entonces, el mismo commit de la auditoría (`5927396`) se
mergeó a `origin/staging` junto con el PR #91 (`feat/partial-regeneration`, Fase 5) en el merge `ce6bf25`. Verificado
con `git merge-base --is-ancestor`: los tres commits de Fase 5 que la auditoría citaba (`3d16192`, `d21968d`,
`889b57b`) **ya son ancestros de `origin/staging`**. Conclusión: a hoy, **las Fases 1–5 completas ya están en
staging** (backend). El frontend no tiene una Fase 5 equivalente documentada aparte (su rama de trabajo era
`feat/partial-regeneration` también, ya en `origin/staging` del frontend). Esto no cambia el veredicto NO LISTO de
la Fase 6 (sigue dependiendo de V2/V2.1 completo, ausente en `main`), pero sí cierra la precondición 2 de esa
auditoría ("mergear la Fase 5 a staging").

---

## 0. Resumen ejecutivo

- `main` del backend está en `d562b15` (2026-08-13); `origin/staging` en `ce6bf256` — **562 commits** por delante,
  cero commits de `main` que falten en staging. `main` del frontend está en `2d0793e`; `origin/staging` en
  `bc684e4` — **499 commits** por delante, cero commits exclusivos de `main`.
- `main` no tiene nada de V2: ni tablas, ni módulos, ni flags, ni variables de entorno.
- El plan de migraciones de producción (`migrate-v2-production.js`) ya cubre 14 pasos del V2/V2.1 "núcleo", pero
  **excluye a propósito** las 4 migraciones de las Fases 1–5 auditadas (pedagogía, carga horaria/práctica,
  Actividades de Aplicación, Contexto académico) — hay que añadirlas en el orden que impone el acople P2↔P3.
- No hay política de presupuesto de producción (`cost_budget_policies` vacía) ⇒ todo run real daría 409
  `no_budget_policy`. Hay que crearla antes de encender el flag.
- El `.env.production.template` no tiene **ninguna** variable V2 — hace falta extenderlo.
- Riesgo mayor de la promoción: el frontend de staging incluye un rediseño completo de "Datos del curso"
  (`41-course-setup.js`, backend `course-setup` con Anthropic Opus) que la decisión DN-7 del owner **excluyó** del
  release curado. Si se promueve por fusión directa (fast-forward/merge), ese código entra igual.

---

## 1. Migraciones requeridas

### 1.1 Ya en el plan de producción (`scripts/prod/migrate-v2-production.js`, 14 pasos + paso 0)

| # | Archivo | Qué agrega |
|---|---|---|
| 0 | `scripts/lib/production-jobs-constraints.js` (no es `.sql`; CHECK de `production_jobs`) | amplía `execution_mode`/`worker_status` con `dynamic_generation`/`dynamic_package`/`preview` |
| 1 | `supabase-migration-dynamic-course-structure.sql` | `course_modules`, `course_chapters`; `structure_version`, `locked_at`, `blueprint_version_id` |
| 2 | `supabase-migration-course-blueprints.sql` | `course_blueprints` inmutable + `courses.current_blueprint_id` |
| 3 | `supabase-migration-v21-blueprint-profiles.sql` | V2.1 R3: toggles de curso/capítulo, `course_profiles` append-only |
| 4 | `supabase-migration-generation-manifests.sql` | `course_generation_manifests` inmutable |
| 5 | `supabase-migration-dynamic-generation.sql` | `generation_item_runs`, `generation_run_contexts` |
| 6 | `supabase-migration-dynamic-generation-v2.sql` | rulesVersion 2: `scope`, tipos `course_plan`/`course_intro`/`module_intro` |
| 7 | `supabase-migration-invalidation.sql` | Fase 8: `carried_from_item_run_id` (ya integrada, `[included]`) |
| 8 | `supabase-migration-v21-manifest-v3.sql` | V2.1 R4: tipos/conteos rulesVersion 3 |
| 9 | `supabase-migration-v21-finops.sql` | V2.1 RF: `pricing_catalog`, `generation_cost_events`, `cost_estimates`, **`cost_budget_policies`**, `cost_budget_authorizations`, `cost_avoidance_events` + seed de precios (hook `finops-pricing-seed`) |
| 10 | `supabase-migration-v21-finops-rls.sql` | RLS + REVOKE anon/authenticated en tablas FinOps y `course_profiles` |
| 11 | `supabase-migration-ev6-h5p2.sql` | `courses.review_cards_enabled` (nullable, default false) |
| 12 | `supabase-migration-rel-recovery.sql` | `generation_item_attempts` + columnas de recuperación en `generation_item_runs` |
| 13 | `supabase-migration-rel-exec-lease.sql` | `production_jobs.executor_lease_holder/expires_at` + trigger de liberación |
| 14 | `supabase-migration-storage-artifacts-policies.sql` | políticas RLS mínimas de `storage.objects` para `cursia-artifacts` (decisión: **SÍ** aplicar — el ejecutor V2 sube desde el navegador al mismo proyecto Supabase de producción) |

### 1.2 Excluidas hoy del plan — las que esta promoción necesitaría agregar (Fases 1–5 auditadas)

| # | Archivo | Paso staging | Depende de | Nota de acople |
|---|---|---|---|---|
| P1 | `supabase-migration-pedagogy-profiles.sql` | `deploy-staging.yml` [4d6]/[4d7] | Paso 3 (`v21-blueprint-profiles`, exige el CHECK con `pedagogy`) | — |
| P2 | `supabase-migration-practice-chapters.sql` | [4d8]/[4d9] | Paso 1 (`dynamic-course-structure`) | **debe entrar junto con P3, nunca sola** |
| P3 | `supabase-migration-application-activities.sql` | [4h5a]/[4h5b] | Paso 8 (`v21-manifest-v3`), debe ir **después** | reescribe `cgm_counts_consistent` — sin esto, un capítulo de práctica (P2) rompe el INSERT del Manifest con 500 |
| P4 | `supabase-migration-academic-context.sql` | [4h5c]/[4h5d] | P1 (exige `pedagogy` en el CHECK de `course_profiles`) | — |

**Acople crítico P2↔P3** (ya documentado en la auditoría Fase 6, §2.1): el CHECK `cgm_counts_consistent` que
instala el paso 8 (`v21-manifest-v3`) exige `content = presentation = audiobook = chapter_count`; con un capítulo
de práctica (P2) el INSERT del Manifest falla con 500 hasta que P3 reescribe ese CHECK. **P2 nunca debe aplicarse
sin P3 en la misma ventana.**

Las 4 son idempotentes (`if not exists` / inspección de `pg_get_constraintdef`), aditivas (columnas nulas o con
default constante) y traen su rollback en la cabecera del `.sql`. `set lock_timeout='5s'` en las 4.

---

## 2. Orden exacto, numerado, con dependencias y verify script

Mismo principio schema-first de `docs/v2-production-migrations.md`: todo el esquema se aplica **antes** del merge
a `main` (con el código de `main` corriendo encima, inerte). Orden final propuesto (inserta P1–P4 en los huecos que
impone su dependencia):

| Orden | Paso | Verify / audit (modo `production-readonly`) |
|---|---|---|
| 0 | `scripts/lib/production-jobs-constraints.js` (CHECK `production_jobs`, con pre-chequeo DN-6 de solo lectura) | el propio runner lo verifica en la misma transacción |
| 1 | `supabase-migration-dynamic-course-structure.sql` | `scripts/verify-dynamic-course-structure-schema.js` |
| 2 | `supabase-migration-course-blueprints.sql` | `scripts/verify-course-blueprints-schema.js` + `scripts/audit-course-blueprints.js` |
| 3 | `supabase-migration-v21-blueprint-profiles.sql` | `scripts/verify-v21-blueprint-profiles-schema.js` |
| **P1** | `supabase-migration-pedagogy-profiles.sql` | `scripts/verify-pedagogy-profiles-schema.js` *(falta confirmar modo `production-readonly`)* |
| **P2** | `supabase-migration-practice-chapters.sql` | `scripts/verify-practice-chapters-schema.js` *(idem)* |
| 4 | `supabase-migration-generation-manifests.sql` | `scripts/verify-generation-manifests-schema.js` + `scripts/audit-generation-manifests.js` |
| 5 | `supabase-migration-dynamic-generation.sql` | `scripts/verify-dynamic-generation-schema.js` + `scripts/audit-dynamic-generation.js` |
| 6 | `supabase-migration-dynamic-generation-v2.sql` | (cubierto por el verify del paso 5/8) |
| 7 | `supabase-migration-invalidation.sql` | `scripts/check-v21-invalidation-v3.js` (ya corrido en Fase 6, 50/0) |
| 8 | `supabase-migration-v21-manifest-v3.sql` | `scripts/verify-v21-manifest-v3-schema.js` |
| **P3** | `supabase-migration-application-activities.sql` (DESPUÉS del 8: reescribe `cgm_counts_consistent`) | `scripts/verify-application-activities-schema.js` *(idem, confirmar modo prod)* |
| **P4** | `supabase-migration-academic-context.sql` (DESPUÉS de P1) | `scripts/verify-academic-context-schema.js` *(idem)* |
| 9 | `supabase-migration-v21-finops.sql` (+ hook `finops-pricing-seed`) | verificación propia del runner (políticas/precio) |
| 10 | `supabase-migration-v21-finops-rls.sql` | — |
| 11 | `supabase-migration-ev6-h5p2.sql` | `scripts/verify-ev6-h5p2-schema.js` |
| 12 | `supabase-migration-rel-recovery.sql` | — |
| 13 | `supabase-migration-rel-exec-lease.sql` | — |
| 14 | `supabase-migration-storage-artifacts-policies.sql` (o `--skip-storage-policies` si el owner decide lo contrario) | verificación de políticas del propio runner |

**Trabajo previo obligatorio** antes de poder ejecutar este orden en producción (no está hecho hoy):

1. Añadir P1–P4 a `MIGRATION_STEPS` de `scripts/prod/migrate-v2-production.js` en las posiciones de la tabla y
   quitarlas de `EXCLUDED` (líneas 223–226 del script).
2. Añadir sus 4 verify a `VERIFY_SCRIPTS`, confirmando primero que soportan `V2_VERIFY_MODE=production-readonly`
   (los 9 verify actuales ya lo soportan; los de P1–P4 no están confirmados — revisar antes).
3. Extender `scripts/prod/test/run-local-pg-tests.js` y `run-legacy-app-compat-test.js` para que el PG16 local
   desechable incluya P1–P4 y el código de `main` siga funcionando encima (no las cubren hoy).
4. Regenerar el `Plan sha256` del dry-run con el plan ya extendido, antes de pedir aprobación del owner.

Comandos (una vez extendido el runner, ver §9 de `docs/v2-production-migrations.md` para el detalle completo):

```bash
# A3 — dry-run, anotar Plan sha256
node scripts/prod/migrate-v2-production.js --env-file <env-solo-DB>

# A4 — apply (código de main todavía en producción)
MIGRATION_ENV=production CONFIRM_PRODUCTION_REF=hriwbakbuypaiovvvkqh CONFIRM_BACKUP_TAKEN=yes DB_SSL=true \
  node scripts/prod/migrate-v2-production.js --env-file <env-solo-DB> \
  --apply --i-understand-this-mutates-production --expect-plan-sha256 <sha de A3>

# B2 — re-verificación read-only tras el merge
MIGRATION_ENV=production CONFIRM_PRODUCTION_REF=hriwbakbuypaiovvvkqh DB_SSL=true \
  node scripts/prod/migrate-v2-production.js --env-file <env-solo-DB> --verify-only
```

---

## 3. Cambios necesarios en `main`

`main` del backend (`d562b15`) no tiene ningún módulo V2: `git ls-tree origin/main src/modules` solo lista
`artifacts brand-profiles content-generation course-versions courses institutions production-jobs`. Todo lo de
`features/`, `course-structure/`, `course-blueprints/`, `generation-manifests/`, `dynamic-*/`, `finops/`,
`invalidation/`, `coherence/`, `pedagogy/`, `study-time/`, `academic-context/` falta.

**Qué código entra:**

- Backend: los módulos de arriba + `src/package/{dynamic-mbz-builder,mbz-common}.ts`, `src/workers/{dynamic-item-worker,dynamic-package-worker,dynamic-provider-worker,dynamic-worker-gate,finops-worker-hooks,provider-real/**,video-duration,worker-drain}.ts`, `src/common/db/returning-rows.ts`, `src/app.module.ts` (registrar los módulos V2), las 18 `supabase-migration-*.sql` nuevas, los `scripts/migrate-*.js`/`verify-*.js`/`audit-*.js` de V2, `scripts/prod/**`, `scripts/ops/v2-health-report.js`, `.github/workflows/v2-production-migrations.yml`.
- **Decisión explícita del owner (DN-7, confirmada en memoria del proyecto):** el release curado **excluye**
  `src/modules/course-setup/**` (extracción de "Datos del curso" desde PDF con `@anthropic-ai/sdk` / Opus) — es el
  único consumidor nuevo de Anthropic además de `brand-profiles` (que ya está en `main`). Si se incluyera, el
  check "importadores de Anthropic = los de `main`" fallaría.
- Frontend: `43-dynamic-structure-editor.js`, `44-…`, `45-…`, `46-…`, `06b-scorm-templates.js` (motor SCORM v2),
  `42-scorm-templates-ui.js` (solo la función `sv2ResolveActiveTemplateIds`), hunks V2 de `24-backend-client.js`,
  `19-library.js` (`dynGetOrCreateBackendCourseId`), `src/styles/cursia-structure-redesign.css` (126 líneas, solo
  los tokens `--cc-*` con scope `#panel-estructura`, NO el resto del rediseño visual). **Excluido por DN-7**:
  `41-course-setup.js`, `cursia-course-setup.css`, el rediseño de navegación (`40-workspace-nav`, Home, sidebar),
  el flujo "nombre primero", el rediseño visual completo de Estructura (`18-cursia-structure.js`), fixes UX legacy
  posteriores y `203c7de` (SCORM v2 conectado a la generación legacy). El `dn7-closure-analysis.md` del repo
  frontend trae la clasificación commit-por-commit completa (97 commits en ese momento; staging avanzó desde
  entonces y requiere repetir el closure antes de cortar el release).

**Cómo construir el release (opción recomendada, B — ver §10):**

1. Repetir el `dn7-closure-analysis.md` sobre el estado actual de staging (el documento existente se hizo sobre
   backend `main` `2d0793e`/staging `4a11a6a` y frontend `main` `2d0793e`/staging `4a11a6a`; staging avanzó 562/499
   commits desde ese punto — hay que re-correr la clasificación commit-por-commit).
2. Construir una rama `release/cursia-v2-<fecha>` por repo: partir de `main`, aplicar los commits V2/V2-DEP/READINESS
   en orden topológico (no hacer cherry-pick de los commits "Merge"), excluyendo course-setup, el rediseño de
   navegación/Home/Estructura y los fixes UX legacy posteriores a la rama de integración.
3. Validar: backend `tsc --noEmit` + `npm run build` + los `scripts/check-*.js` relevantes; frontend `node --check`
   sobre `src/js` + los harness `.mjs` de 06b/42 (16/16 + 4/5 esperados — `test-42-picker-render-hooks` queda fuera
   a propósito, depende de un hook NON-V2).
4. Correr `scripts/prod/test/run-local-pg-tests.js` y `run-legacy-app-compat-test.js` contra el plan de migración
   ya extendido con P1–P4, desde el commit de release.
5. PR del release curado → revisión 0 Critical/0 Important → merge a `staging` de cada repo primero (para que el
   gate completo de `deploy-staging.yml` lo valide en un entorno real) → luego, con aprobación del owner, merge a
   `main`.

---

## 4. Variables de entorno

### 4.1 Ya en `.env.production.template` (sin cambios)

`NODE_ENV`, `PORT`, `DB_HOST/PORT/USER/PASS/NAME/SSL/LOGGING`, `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `CORS_ORIGIN`,
`FRONTEND_URL`, `BACKEND_PUBLIC_URL`, `YOUTUBE_CLIENT_ID/SECRET/REDIRECT_URI/TOKEN_SECRET/DEFAULT_PRIVACY`,
`VIDEO_WORKER_*` (8 vars), `YOUTUBE_UPLOAD_*` (4 vars), `VIDEOGEN_API_URL/API_KEY/SHARED_SECRET/WEBHOOK_SECRET`,
`SUPER_ADMIN_EMAILS`, `ALLOW_UNOWNED_COURSES=false`.

### 4.2 Variables V2/V2.1 a añadir al template (ninguna existe hoy)

| Variable | Valor recomendado de producción | ¿Secreto? | Justificación |
|---|---|---|---|
| `DYNAMIC_COURSE_STRUCTURE` | **ausente / `false`** hasta el paso C de la secuencia de promoción (único string que activa: `'true'` exacto) | no | fail-closed por diseño; activar último |
| `DYNAMIC_V2_ALLOWED_OWNERS` | ausente al inicio (flag OFF ⇒ nadie); al activar: **lista explícita** con el/los UUID del owner interno — nunca dejar vacía con el flag ON (vacía + ON = todos) | no (son UUIDs, no credenciales) | §4 de la Fase 6: "flag ON + lista vacía = todos" |
| `DYNAMIC_REAL_VIDEO_OWNERS` | ausente hasta decidir qué cuentas pueden gastar en Videogen real | no | fail-closed (ausente/vacía ⇒ nadie) |
| `DYNAMIC_REAL_VIDEO_ALL_OWNERS` | ausente/`false` (no activar rollout comercial de video real sin decisión aparte) | no | — |
| `DYNAMIC_ALLOW_VIDEO_PREVIEW` | ausente/`false` en producción (es un escape de QA) | no | — |
| `DYNAMIC_COHERENCE_LLM` | ausente/`false` hasta decidir activar la revisión de coherencia con IA | no | fail-closed |
| `DYNAMIC_MANIFEST_RULES_VERSION` | `3` (staging ya corre en 3; 1/2 producirían un Blueprint que P1–P4 ignorarían) | no | obligatorio ANTES de dejar entrar tráfico V2 — un valor fuera de 1/2/3 hace fallar `GET /features` y el lock del Blueprint |
| `DYNAMIC_ACTIVITY_TYPE_RULES` | `2` (EV6 H5P v2; staging ya en 2) | no | — |
| `DYNAMIC_VIDEO_DELIVERY` | `youtube` (igual que staging) | no | — |
| `DYNAMIC_PROVIDER_WORKER_ENABLED` | `true` solo cuando se decida que el worker de proveedores reales (Gamma/TTS) debe correr en producción; hasta entonces `false`/ausente | no | gasto real de proveedores |
| `GAMMA_THEME_V21_LIGHT_DEFAULT` / `_DARK_DEFAULT` | ids públicos de Gamma de la cuenta de producción (`GET /themes`), no son secretos | no | V2.1, requerido por las presentaciones nuevas |
| `PRESENTATION_LIGHT_DEFAULT_SINCE` | se autoasigna al primer deploy que lo necesite si falta (`ensure_env_default_if_absent`); no fijar a mano salvo que se quiera congelar el instante | no | — |
| `DB_POOL_MAX` / `DB_POOL_MAX_WORKER` / `DB_POOL_IDLE_MS_WORKER` | calcular contra el límite real del pooler de producción en modo sesión (staging usa `2`/`1`/`1000` para 15 clientes totales; producción puede tener más headroom — revisar el límite del plan Supabase antes de copiar el valor de staging) | no | evitar `EMAXCONNSESSION` |
| `FINOPS_INGEST_TOKEN` | generar un valor aleatorio nuevo específico de producción (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) | **sí, secreto** | sin él el ledger FinOps no registra gasto LLM del navegador |

**Regla general:** ninguna de estas variables existe hoy en `.env.production.template`; hay que agregarlas con sus
valores por defecto seguros (todo lo `DYNAMIC_*` ausente/`false` salvo `DYNAMIC_MANIFEST_RULES_VERSION=3` y
`DYNAMIC_ACTIVITY_TYPE_RULES=2`, que si están ausentes caen a 1/0 y producen Blueprints que P1–P4 no entenderían —
fijarlas ANTES de que cualquier owner use V2, aunque el flag maestro siga en `false`).

---

## 5. Feature flags por etapa de promoción

| Etapa | `DYNAMIC_COURSE_STRUCTURE` | `DYNAMIC_V2_ALLOWED_OWNERS` | `DYNAMIC_MANIFEST_RULES_VERSION` | `DYNAMIC_ACTIVITY_TYPE_RULES` | `DYNAMIC_REAL_VIDEO_OWNERS` | `DYNAMIC_COHERENCE_LLM` | `DYNAMIC_PROVIDER_WORKER_ENABLED` |
|---|---|---|---|---|---|---|---|
| Esquema aplicado, código aún en `main` (entre A4 y B1) | ausente/`false` | ausente | puede fijarse ya (no tiene efecto con el flag maestro OFF) | idem | ausente | ausente | `false` |
| Tras el merge a `main` (B1–B3), antes de C | `false` | ausente | `3` | `2` | ausente | ausente/`false` | `false` |
| C — owner interno únicamente | `true` | `<uuid del owner>` (nunca vacía) | `3` | `2` | ausente (sin video real todavía) | decisión aparte | `true` solo si se va a probar Gamma/TTS reales en el smoke |
| Ampliación gradual | `true` | se agregan UUIDs de a uno, vigilando el ledger | `3` | `2` | se agrega cuenta por cuenta tras aceptar el costo de Videogen | según decisión | `true` |
| General (todas las cuentas) | `true` | vacía (**== todos**, decisión explícita del owner) o lista completa | `3` | `2` | según política comercial de video | según decisión | `true` |

**No existe un flag por funcionalidad separado para las Fases 1–5** (pedagogía, horas, práctica, Actividades de
Aplicación, contexto académico, coherencia, vista previa del impacto): con `DYNAMIC_COURSE_STRUCTURE` + rulesVersion
3 encendidos para un owner, las recibe todas juntas. La única palanca fina hoy es **no aplicar la migración
correspondiente** (⇒ 503 `schema_not_migrated_*` en la UI, degradación visible pero no silenciosa). Si se quiere un
lanzamiento por partes, hay que decidirlo y construir flags finos antes del release (no existen hoy).

---

## 6. Política de presupuesto (FinOps)

### 6.1 Estructura de la tabla (`cost_budget_policies`, `supabase-migration-v21-finops.sql`)

Fila versionada e inmutable: `scope` (`global`|`institution`|`owner`|`course`), `scope_id`, `version`, `limits`
jsonb (`{maxCostPerRun, maxCostPerCourse, monthlyCap, maxCostPerProvider:{...}, maxCostPerItemType:{...}}`, `null`
= sin límite), `require_human_approval_for_real_spend` (bool), `on_exceed` (`BLOCK`|`ADMIN_APPROVAL`). La
resolución (`FinopsBudgetService.policyFor`) prioriza `scope='course'` > `scope='owner'` > `scope='global'`.
`normal-approval.ts` lee `limits.monthlyCap` (la clave de staging es distinta: `monthlyCapStaging` — **en
producción usar `monthlyCap`**, no esa clave de staging).

### 6.2 Números propuestos y justificación

Baseline de costo medido en la auditoría Fase 6 (RCP, por curso, con `targetHours` activo):

| Horas del curso | Costo estimado |
|---|---|
| 20 h | ≈ USD 31,59 |
| 33 h | ≈ USD 33,25 |
| 50 h | ≈ USD 48,23 |
| 64 h | ≈ USD 54,70 (Videogen 16,21 + Gamma 10,35 + Anthropic 23,73 + TTS 4,40) |

Propuesta de producción (sujeta a aprobación del owner — es un ítem explícito de la lista de §4 de la Fase 6):

| Límite | Valor propuesto | Justificación |
|---|---|---|
| `maxCostPerRun` (scope `global`) | **USD 60** | cubre el peor caso medido (64 h ≈ 54,70) con ~10% de margen para variación de proveedor, sin dejar pasar un run fuera de rango por error de configuración (p. ej. horas mal calculadas) |
| `maxCostPerCourse` | **USD 70** | un curso puede necesitar una regeneración parcial después del run inicial (Fase 5, reintentos `paidRetry`); el tope por curso debe cubrir el run inicial + al menos una vuelta de ajuste razonable sin igualar el tope mensual |
| `monthlyCap` | **USD 1.500** (ajustar cuando haya 2–4 semanas de ledger real) | a ritmo de ~25 cursos de 50–64 h/mes (estimación inicial conservadora para el lanzamiento con allow-list acotada), 25 × ~55 ≈ USD 1.375; USD 1.500 da margen sin ser tan alto que no actúe como freno real. Recalibrar con el ledger FinOps real tras las primeras 2–4 semanas (los priors de `usage-model.priors.v1.json` son estimaciones, no medidas) |
| `on_exceed` | `ADMIN_APPROVAL` (no `BLOCK`) para `scope=global`, al menos en el lanzamiento inicial | permite que el owner revise y apruebe manualmente un run que excede el límite en vez de bloquear duro una generación legítima pero más cara de lo previsto |
| `require_human_approval_for_real_spend` | `true` | mantiene el gate de aprobación humana para gasto real de proveedores (Videogen/Gamma/Anthropic/TTS) durante el periodo de owner-interno-únicamente |

Nota de riesgo: estos números son una **propuesta de punto de partida**, no una decisión tomada — el ledger FinOps
de staging (`scripts/staging-v21-calibration.js`, `staging-budget-policy.js`) usa USD 15 por run, pero ese límite es
deliberadamente bajo para forzar aprobación de admin en casi todo curso de staging; no es una referencia de
producción. Recalibrar `monthlyCap` en cuanto haya datos reales (`v2-health-report.js` ya reporta gasto real de
Videogen 24h/7d vs. tarifa activa).

### 6.3 Cómo crear la política — script/SQL concreto

No existe un script de producción dedicado hoy (el único existente, `scripts/staging-budget-policy.js`, **rechaza
explícitamente el ref de producción** por diseño: `refusal()` comprueba `dbProjectRef(env) === KNOWN_PRODUCTION_SUPABASE_REF`
y aborta). Dos caminos:

1. **Recomendado**: escribir un script hermano `scripts/prod/seed-budget-policy.js` siguiendo el mismo patrón de
   guardas que `migrate-v2-production.js` (exige `MIGRATION_ENV=production`, `CONFIRM_PRODUCTION_REF`, rechaza el
   ref de staging, no lee `.env` implícito) que inserte una fila `scope='global'`, `scope_id=null`, `version=1`,
   con los `limits` de §6.2 — nunca editar/borrar una versión existente (las filas son inmutables; un cambio de
   política es una fila **nueva** con `version` incrementado).
2. Alternativa manual (solo si no se construye el script, y revisado por el owner antes de correr):
   ```sql
   insert into public.cost_budget_policies (scope, scope_id, version, limits, require_human_approval_for_real_spend, on_exceed, created_by)
   values ('global', null, 1,
     '{"maxCostPerRun": "60", "maxCostPerCourse": "70", "monthlyCap": "1500"}'::jsonb,
     true, 'ADMIN_APPROVAL', 'owner (nicolas@nomaddi.com) — producción, propuesta inicial A5');
   ```
   Correr dentro de la misma ventana de migración (paso 9, después de que exista la tabla `cost_budget_policies`),
   nunca antes de que el esquema V2.1 FinOps esté aplicado.

Sin esta política, `planNormalApproval` (`normal-approval.ts`) devuelve `blockedBy: no_budget_policy` y
`startRun` responde **409** en cada intento de generación V2 — el flag puede estar `true` y aun así nadie puede
generar nada hasta que la política exista.

---

## 7. Backup requerido

Según `docs/v2-production-migrations.md` (precondición 1, sección DN-6/A2):

- **PITR** (Point-in-Time Recovery) activo en el proyecto Supabase de producción `hriwbakbuypaiovvvkqh`, con
  ventana **≥ 7 días**. Verificar en Supabase Dashboard → Database → Backups.
- Si no hay PITR disponible en el plan: `pg_dump` manual completo, guardado con fecha y anotado junto al registro
  de DN-6 (no basta con "se hizo"; el runner exige `CONFIRM_BACKUP_TAKEN=yes` como atestación textual, pero la
  verificación real del backup es responsabilidad del owner, fuera del runner).
- **Qué verificar además del backup en sí:**
  - Chequeo DN-6 de solo lectura (SQL en `docs/v2-production-migrations.md`, sección "OBLIGATORIO antes de migrar"):
    `would_violate_execution_mode = 0` y `would_violate_worker_status = 0` sobre `production_jobs` — si alguno es
    > 0 (típicamente filas `brand_extraction`), **no migrar ni mergear** hasta resolverlo.
  - Confirmar que el backup es restaurable (no solo que "corrió sin error") — un ensayo de restore en un proyecto
    Supabase de prueba, si el tiempo lo permite, da más garantía que solo mirar el dashboard.
  - Anotar fecha + ambos conteos de DN-6 junto al registro del backup, antes de A4.

---

## 8. Rollback por etapa

| Etapa | Rollback soportado |
|---|---|
| Tras A4 (esquema aplicado, código aún `main`) | Las tablas V2 existen vacías; no afectan a `main`. No hace falta revertir nada — si hubo que detener el apply a mitad, los pasos ya commiteados son idempotentes y pueden re-correrse o dejarse (inertes). |
| Tras B1 (merge a `main`) | **Flag OFF** (el que ya estaba, `DYNAMIC_COURSE_STRUCTURE` ausente/`false`) + `pm2 restart --update-env` de **todos** los procesos. El código V2 con el flag OFF es exactamente el legacy de siempre + rutas escondidas (404). No hay que tocar el esquema. |
| Tras C (flag ON para owner interno, sin filas `dynamic_*` todavía) | Mismo: flag OFF + restart. Un `git revert` del merge **también funcionaría** en este punto (lo cubre `run-legacy-app-compat-test.js`), pero no es el camino recomendado. |
| Después de que exista ≥1 fila `dynamic_generation`/`dynamic_package` en `production_jobs` | **NO soportado: revertir el código a `main` pre-V2.** Reproducido en PG16 local: el `deploy.yml` del commit revertido reconstruye el CHECK de `execution_mode` sin `dynamic_*`, el `ADD CONSTRAINT` falla con `23514`, el deploy aborta **antes** de `pm2 reload` — pero el rollback no ocurre: el VPS queda con el código V2 en disco (rsync ya hecho) y los procesos viejos corriendo. El único backout soportado desde este punto es **flag OFF**, nunca revertir código. |
| Si hace falta sacar el código V2 del VPS por completo | **Forward-revert** revisado que conserve `scripts/lib/production-jobs-constraints.js` y el `migrate-production-jobs-constraints.js` actual (con `dynamic_*` en la lista) — o, alternativa destructiva, borrar antes las filas `dynamic_*` de `production_jobs` (pérdida de datos, decisión D del owner con backup a mano). Nunca como primera respuesta. |
| Rollback de esquema completo (DROP de tablas V2) | Decisión C/D del owner únicamente, con el backup del paso 7 a mano. Nunca como primera respuesta — el principio por defecto es "las tablas V2 vacías no afectan a legacy". |
| Políticas de Storage | `drop policy if exists cursia_artifacts_{insert,select,delete,update}_own_folder on storage.objects;` — solo si se decide explícitamente; rompe los uploads del ejecutor V2. |
| Corrección pendiente conocida | El texto de `deploy.yml:158` ("rollback manual: `git checkout HEAD~1`") es **engañoso** — el VPS recibe el código por `rsync --exclude '.git'`, no hay repo git ahí. Corregir el texto antes o junto con este release. |

**`lock_timeout` en el deploy**: `migrate-production-jobs-constraints.js` usa `lock_timeout='5s'`/`statement_timeout='300s'`;
si un `ALTER` choca con tráfico pesado, el paso falla con `55P03` sin efecto (rollback automático de ese paso) — se
reintenta el deploy, no queda nada a medio aplicar.

---

## 9. Pruebas post-deploy (smoke list)

Basado en `docs/v2-rollout/post-deploy-validation.md` (frontend) y `docs/v2-production-migrations.md` (backend).

### Tras A4 (esquema aplicado, código aún `main`)

```bash
MIGRATION_ENV=production CONFIRM_PRODUCTION_REF=hriwbakbuypaiovvvkqh DB_SSL=true \
  node scripts/prod/migrate-v2-production.js --env-file <env-solo-DB> --verify-only
```
Esperado: exit 0. Confirma además que las tablas V2 están vacías.

### Tras A5 / B3 (smoke legacy)

- Biblioteca de cursos, crear un curso nuevo, un job backend corto, descargar un artifact — igual que antes de
  tocar nada.
- `jobList({courseId: <frontendCourseId>})` (UUID, nunca el id numérico a secas) sin errores nuevos en el
  historial.

### Tras B1 (merge del backend a `main`)

```bash
cd orbia-backend && gh run list --workflow=deploy.yml --limit=1   # esperar completed/success
curl -s https://api.cursia.nomaddi.com/health                     # esperado: {"status":"ok"}
```
Revisar en el log del workflow que `pm2 status` muestra los 7-8 procesos legacy `online` sin reinicios anómalos.

### Tras B1 del frontend (deploy automático a Cloudflare Pages)

Desde una pestaña ya logueada en `cursia.nomaddi.com` (vía `mcp__claude-in-chrome__javascript_tool` o equivalente,
siempre con `navigate`/reload antes para evitar JS viejo en memoria):

```js
const r = await fetch('/src/js/24-backend-client.js?nocache=' + Date.now());
const t = await r.text();
t.includes('DYNAMIC_COURSE_STRUCTURE_ENABLED')   // esperado: true (confirma build nuevo en vivo)
```

```js
window.DYNAMIC_COURSE_STRUCTURE_ENABLED   // esperado: false (flag backend todavía OFF)
window.CURSIA_V2_GATE                     // esperado: source 'off'
await backendGetFeatures()                // esperado: {ok:true, data:{dynamicCourseStructure:false, realVideo:false, coherenceLlm:false}}
```

Rutas dynamic con flag OFF: `GET /api/v1/courses/:id/blueprints` y similares deben responder **404**, nunca 500
"relation does not exist" (si aparece 500, es una regresión de C1 — el esquema debía estar completo antes del
merge).

### Tras C (flag activo solo para el owner interno)

```bash
curl -s https://api.cursia.nomaddi.com/health
sudo pm2 status   # sin reinicios en loop
```

En consola, logueado como la cuenta de prueba (recargar antes):

```js
await backendGetFeatures()               // {ok:true, data:{dynamicCourseStructure:true, realVideo:false, coherenceLlm:<según flag>}}
window.DYNAMIC_COURSE_STRUCTURE_ENABLED  // true
go('estructura')                          // debe abrir el editor dinámico, no el legacy
```

Con otra cuenta no listada (ventana privada): `dynamicCourseStructure:false` ⇒ legacy intacto.

Generar un curso V2 mínimo (sin video real) y confirmar:
- `artifactList({courseId: <frontendCourseId>})` muestra los artifacts esperados.
- El `.mbz` final se genera y **restaura correctamente en un Moodle real** (la auditoría Fase 6 solo lo validó en
  Moodle 4.5 local — probar en el Moodle del primer cliente real antes de considerar esto cerrado).

Primeras 24 h: revisar `pm2 logs cursia-backend --lines 500`, correr
`node scripts/ops/v2-health-report.js --env-file .env --expect-ref hriwbakbuypaiovvvkqh` (sin leases vencidos, sin
runs atascados), revisar `usage_events`/gasto real vs. estimado de la cuenta de prueba.

Primeros 7 días: confirmar cero regresión en cursos legacy de otras cuentas, cero 500 nuevo no-V2, crecimiento de
Storage acorde a 1 curso (no un múltiplo, señal de reintentos duplicando artifacts).

---

## 10. Divergencia staging/main: cuantificación, opciones y recomendación

### 10.1 Cuantificación (medida ahora, con `git fetch` + `git diff --stat` sobre los worktrees)

| Repo | `main` | `staging` | `main..staging` | `staging..main` | Archivos distintos | Líneas |
|---|---|---|---|---|---|---|
| cursia-backend | `d562b15` | `ce6bf256` | **562 commits** | **0** | 2415 | +466.661 / −134 |
| cursia (frontend) | `2d0793e` | `bc684e4` | **499 commits** | **0** | 247 | +107.217 / −3.052 |

**`main` no tiene ningún commit que falte en staging** en ninguno de los dos repos (`staging..main` = 0) —
confirma lo que decía la Fase 6: no hay hotfixes de producción que staging se esté perdiendo.

Áreas backend más afectadas (por nº de archivos): `assets/h5p-libs` (1746 — librería H5P vendorizada, no es
código de producto), `src/modules` (225 — todos los módulos V2 nuevos), `test/fixtures`/`src/package` (66 c/u),
`test/e2e-v2` (29), `scripts/fixtures`/`scripts/lib` (26/23), `docs/superpowers` (16), `src/workers` (12),
`.github/workflows` (3).

Áreas frontend: `src/js` (118 — incluye tanto V2 como todo el rediseño NON-V2), `docs/autonomous-audits` (46),
`src/styles` (21), `public/brand` (13), `docs/v2-rollout` (6), `.github/CODEOWNERS` (1).

### 10.2 Archivos legacy del pipeline — ¿cambiaron entre `main` y `staging`?

Sí, y de forma sustancial — pero por dos motivos distintos que hay que separar:

**Backend** (`src/modules/content-generation`, `src/package/mbz-builder.service.ts`, `src/workers/*`):
```
src/package/mbz-builder.service.ts            |    4 +-
src/workers/audio-worker.ts                   |   33 +-
+ 11 archivos nuevos (dynamic-item-worker.ts, dynamic-package-worker.ts, provider-real/*, …)
13 files changed, 6602 insertions(+), 9 deletions(-)
```
`mbz-builder.service.ts` y `audio-worker.ts` (los dos archivos legacy compartidos) tienen cambios mínimos (4 y 33
líneas) — consistente con la Fase 6 ("0 líneas desde el merge del motor pedagógico" se refería a una ventana más
corta; contra todo `main` hay fixes legacy anteriores a esa ventana). El resto son archivos **nuevos** (workers
dynamic), no modificaciones de los legacy.

**Frontend** (`0*`, `1*`, `2*`, `31-course-production.js`, `35-tts-audio.js`):
```
27 files changed, 5590 insertions(+), 1104 deletions(-)
```
Aquí sí hay cambios de fondo en archivos legacy activos: `24-backend-client.js` (+1340/−, los wrappers V2 más
meses de fixes legacy), `31-course-production.js` (+789), `02-run.js` (+326), `19-library.js` (+319),
`20-supabase.js` (+190), `01-state.js` (+160), `27-admin-dashboard.js` (+175). **Importante**: estos no son solo
"33 líneas de wrappers" — son meses de fixes y features legacy genuinos (audio, SCORM, biblioteca) que los
usuarios de producción actuales **sí necesitan** y que una promoción basada en un release curado "solo V2" dejaría
fuera si no se construye con cuidado. La opción de release elegida (§10.3) debe preservar estos commits legacy,
no solo los V2.

### 10.3 Opciones

**(A) Fast-forward / merge directo de `staging` a `main`**

- Pros: cero trabajo de reconstrucción; `main` queda exactamente igual a lo validado en staging; ningún commit se
  pierde.
- Contras / riesgos: trae **todo** lo que staging acumuló, incluido lo que DN-7 decidió **excluir** explícitamente
  del release de producción — el rediseño completo de `course-setup` (consumidor nuevo de Anthropic Opus, sin
  aprobación de costo/UX para producción), el rediseño de navegación/Home/Estructura, y `203c7de` (SCORM v2
  conectado a la generación legacy, fuera de alcance). También trae las 4 migraciones excluidas (P1–P4) sin que el
  plan de producción las tenga preparadas, y trae `deploy-staging.yml`/flags de staging mezclados con el código.
- Veredicto: **no recomendado** — contradice una decisión ya tomada por el owner (DN-7) y no respeta el gate
  schema-first (el merge llevaría código V2.1 completo a `main` sin que el esquema P1–P4 ni la política de
  presupuesto existan en producción).

**(B) Rama de release curada, reconstruida desde staging**

- Pros: permite aplicar exactamente la decisión DN-7 (excluir course-setup y los rediseños NON-V2), permite
  secuenciar schema-first con el plan de migraciones extendido, es auditable commit-por-commit (ya existe un
  precedente metodológico: `dn7-closure-analysis.md`).
- Contras: trabajo de reconstrucción no trivial (la clasificación debe repetirse sobre el estado actual de
  staging, 562/499 commits más que cuando se hizo el análisis original), riesgo de divergencia futura entre
  staging y el release curado si no se sincronizan ambos hacia adelante.
- Veredicto: **recomendada**. Es la continuación directa del trabajo ya hecho (DN-1..DN-7 resueltos, release
  `release/cursia-v2` ya existió una vez — congelado y desactualizado hoy — y debe reconstruirse desde el staging
  final, como ya anotaba la Fase 6 en su precondición 3).

**(C) Promoción por etapas detrás de flags, sin curar una rama separada**

- Pros: evita el trabajo de reconstrucción de (B); todo el código (incluido course-setup) llega a `main` pero
  queda inerte detrás de flags hasta que se decida activarlo función por función.
- Contras: **no existe hoy un flag por funcionalidad** (hallazgo central de la Fase 6, §4) — con
  `DYNAMIC_COURSE_STRUCTURE` + rulesVersion 3 encendidos, las Fases 1–5 se activan todas juntas; course-setup no
  tiene flag propio en absoluto (es una ruta `DYNAMIC_CONTROLLERS` nueva, pero su backend en Anthropic Opus
  consumiría presupuesto en cuanto el controlador esté montado y alguien lo llame, incluso con V2 apagado, si
  course-setup no depende del mismo guard). Construir esos flags finos es trabajo nuevo no estimado.
- Veredicto: viable como complemento de (B) a mediano plazo (flags finos por Fase 1–5), pero **no sustituye** la
  necesidad de excluir course-setup del primer release — ese es un criterio de alcance de producto (Opus sin
  aprobación de costo para el flujo de "Datos del curso"), no solo un interruptor técnico.

### 10.4 Recomendación y pasos git (no ejecutar — solo plan)

**Recomendación: Opción B**, repitiendo el closure DN-7 sobre el estado actual, con esta secuencia (todo revisado
por PR, nada se ejecuta aquí):

```bash
# 1. Repetir el closure sobre el estado actual (por repo)
git fetch origin
git log --oneline origin/main..origin/staging | wc -l     # confirmar 562 / 499 aún vigente
git diff --stat origin/main..origin/staging -- src/modules/course-setup   # backend: tamaño exacto a excluir
git diff --stat origin/main..origin/staging -- 'src/js/41-course-setup.js' 'src/styles/cursia-course-setup.css'  # frontend

# 2. Crear la rama de release desde main (por repo), NO desde staging
git checkout -b release/cursia-v2-2026-10 origin/main

# 3. Aplicar los commits V2/V2-DEP/READINESS en orden topológico (no las fusiones),
#    excluyendo course-setup y los rediseños NON-V2 — usar `git cherry-pick <sha>` por
#    commit clasificado INCLUDE en el closure, o `git apply` de los hunks PARTIAL
#    (24-backend-client.js, 19-library.js, app.module.ts) como hizo el closure original.

# 4. Validar (por repo) antes de abrir PR:
npm run build && node scripts/prod/test/run-local-pg-tests.js && node scripts/prod/test/run-legacy-app-compat-test.js   # backend
node --check src/js/*.js   # frontend, + harness .mjs de 06b/42

# 5. PR → revisión 0 Critical/0 Important → merge primero a staging (gate completo real)
#    → con aprobación explícita del owner, merge a main (deploy automático)
```

**Ítems que exigen aprobación explícita del owner antes de cualquier paso real** (no son técnicos, son decisiones
de producto/costo que ya exigía la Fase 6 y siguen vigentes): alcance del release (conjunto vs. flags finos),
qué hacer con el rediseño de `course-setup` (¿queda para un release posterior con su propio flag y presupuesto de
Opus?), la política de presupuesto de producción de §6.2, los valores finales del `.env` de §4, y cualquier
`--apply` contra la base de datos de producción.
