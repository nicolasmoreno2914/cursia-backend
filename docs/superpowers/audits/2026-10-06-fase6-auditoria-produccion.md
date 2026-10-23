# Fase 6 — Auditoría de preparación para producción (Fases 1–5)

Fecha: 2026-10-06 · Solo lectura (análisis estático + scripts locales puros, sin DB, sin red, USD 0).
Árboles auditados: backend `r25/abe5` (rama `feat/partial-regeneration`, HEAD `8ed93a9`, `dist/` compilado del HEAD),
frontend `r25/cfe5` (rama `feat/partial-regeneration`, HEAD `984df25`). Producción = `origin/main` de cada repo.

Alcance: motor de carga horaria (modelo de tiempo, `targetHours`, distribuidor, capítulo de práctica), Actividades de
Aplicación, Contexto académico, alineación de coherencia (Fase 4) y vista previa del impacto (Fase 5).
**Esto es una auditoría, no una promoción.** Nada se tocó en repos ni entornos.

---

## 0. Resumen ejecutivo

- **Veredicto: NO LISTO para promover hoy como entrega independiente.** Las Fases 1–5 no se pueden llevar solas a
  producción: dependen de toda la plataforma V2/V2.1 (estructura dinámica, Blueprints, Manifests v3, FinOps,
  ejecutor, workers dinámicos, motor pedagógico), que **no está en producción**. `origin/main` del backend es
  `d562b15` (2026-08-13); staging le lleva **555 commits** (backend) y **493** (frontend), sin ningún commit de main
  que falte en staging.
- **Dentro de un release V2.1 completo, las Fases 1–4 quedarían LISTAS CON CONDICIONES** (código maduro, revisado
  0C/0I, gates de staging verdes, migraciones aditivas e idempotentes, todo tras el flag V2 que en producción está
  apagado por defecto). **La Fase 5 todavía no está en staging** (`origin/staging..HEAD` = 5 commits BE / 5 FE).
- Riesgos principales: (1) las 4 migraciones de estas fases están fuera del plan de producción y tienen un orden
  obligatorio; (2) no hay un kill-switch por funcionalidad: con V2 encendido para un owner, todas las Fases 1–5 se
  encienden juntas; (3) costo: con `targetHours` un curso pasa de ~USD 30 a 48–55 estimados y producción no tiene
  política de presupuesto (sin política ⇒ 409 en cada run); (4) el `.env` de producción y su plantilla no tienen
  ninguna variable V2.

---

## 1. Diferencia staging vs main

### 1.1 Estado de ramas

| Repo | main (prod) | staging | Fases 1–4 en staging | Fase 5 |
|---|---|---|---|---|
| cursia-backend | `d562b15` 2026-08-13 | `54c3ba2` (#90) | #83/#84 (motor pedagógico, prerrequisito), #85–#87 (Fase 1), #88 (Fase 2), #89 (Fase 3), #90 (Fase 4) | solo en `feat/partial-regeneration` (`3d16192`, `d21968d`, `889b57b`) |
| cursia (frontend) | — (auto-deploy Pages) | `ed897ee` (#82) | #75/#76 (pedagogía), #77–#79, #80, #81, #82 | solo en rama (`2fa5c4b`, `425cae3`, `e2aa632`) |

Producción no tiene ningún módulo V2: `git ls-tree origin/main src/modules` = `artifacts brand-profiles
content-generation course-versions courses institutions production-jobs`. Todo lo de `features/`, `course-structure/`,
`course-blueprints/`, `generation-manifests/`, `dynamic-*`, `finops/`, `invalidation/`, `coherence/`, `pedagogy/`,
`study-time/`, `academic-context/` es nuevo para producción.

El release curado `origin/release/cursia-v2` (BE `7d2c311`, FE `827cade`, 2025-09-25) está **congelado** y no contiene
nada de V2.1 ni de estas fases (memoria del proyecto: se reconstruye desde staging cuando el dueño diga
«PREPARE FOR PRODUCTION»).

### 1.2 Áreas nuevas por fase (backend)

| Fase | Áreas | Migración |
|---|---|---|
| Prerrequisito: motor pedagógico V1 | `src/modules/pedagogy/*`, `course_profiles` kind `pedagogy` | `supabase-migration-pedagogy-profiles.sql` |
| 1 · carga horaria | `src/modules/study-time/*` (time-model, target-hours, distributor, application-tiers), dry-run, `course-shell/facts.ts` (badge «~X min»), Blueprint/Manifest/claim/invalidación/FinOps/empaque para capítulo de práctica | `supabase-migration-practice-chapters.sql` |
| 2 · Actividades de Aplicación | item `application_activity`, generador LLM (actividad + solucionario), `src/package/v3/application-pdf.ts` (pdfkit), páginas Moodle, «Aplicar diseño» (`applyDistribution`) | `supabase-migration-application-activities.sql` |
| 3 · Contexto académico | `src/modules/academic-context/*` (extracción determinista PDF/DOCX, sin LLM), `course_profiles` kind `academic`, `course_chapters.outcome_ids`, brief con resultados | `supabase-migration-academic-context.sql` |
| 4 · Coherencia | `src/modules/coherence/alignment.ts` (capa A, determinista, dentro del dry-run) | ninguna |
| 5 · Impacto | `invalidation/change-impact*.ts`, `course-blueprints/lock-snapshot.ts`, `POST /courses/:id/change-impact` | ninguna |

Frontend: `47-course-profiles-panel.js`, `48-dynamic-structure-proposal.js`, `49-pedagogy-panel.js`,
`50-academic-context-panel.js` (cargados en `index.html:2379-2382`) y wrappers en `24-backend-client.js`
(p. ej. `change-impact` en `:1208`). Desde el merge del motor pedagógico (`fe7051f`) los únicos cambios en archivos
del pipeline legacy (`0*/1*/2*`, `31-course-production.js`, `35-tts-audio.js`) son 33 líneas de wrappers en
`24-backend-client.js`.

---

## 2. Migraciones

### 2.1 Migraciones solo-staging (excluidas del plan de producción)

`scripts/prod/migrate-v2-production.js:217-228` (`EXCLUDED`) excluye explícitamente las cuatro:

| # | Archivo | Paso staging (`deploy-staging.yml`) | Cambio | Depende de |
|---|---|---|---|---|
| P1 | `supabase-migration-pedagogy-profiles.sql` | 4d6/4d7 (`:574-578`) | amplía `course_profiles_kind_check` con `pedagogy` | `v21-blueprint-profiles` (falla explícito si no existe el CHECK, `:35-37`) |
| P2 | `supabase-migration-practice-chapters.sql` | 4d8/4d9 (`:580-584`) | `course_chapters.chapter_kind text not null default 'content'` + CHECK | `dynamic-course-structure` |
| P3 | `supabase-migration-application-activities.sql` | 4h5a/4h5b (`:610-614`) | `course_chapters.application_minutes smallint null` + CHECK; `gir_type_check` + `application_activity`; `course_generation_manifests.application_activity_count`; **reescribe `cgm_counts_consistent`** | `v21-manifest-v3` (debe ir DESPUÉS) |
| P4 | `supabase-migration-academic-context.sql` | 4h5c/4h5d (`:616-620`) | kind `academic`; `course_chapters.outcome_ids jsonb null` + CHECK regex | P1 (falla explícito si falta `pedagogy`, `:43-45`) |

Orden obligatorio en producción (igual a staging): `…v21-blueprint-profiles → P1 → P2 → generation-manifests →
dynamic-generation → dynamic-generation-v2 → invalidation → v21-manifest-v3 → P3 → P4 → v21-finops…`.

**Acople crítico P2↔P3** (ledger, «HALLAZGO latente»): el CHECK `cgm_counts_consistent` de `v21-manifest-v3` exige
`content = presentation = audiobook = chapter_count`; con un capítulo de práctica el INSERT del Manifest falla (500).
La corrección vive **solo** en P3 (`application-activities.sql:77-119`). ⇒ P2 nunca debe aplicarse sin P3.
Además, el orden P3-antes-de-manifest-v3 deja P3 a medias en silencio (los bloques condicionales `:46-58`, `:78-87` se
saltan) y `v21-manifest-v3` luego recrea `gir_type_check` sin `application_activity` (bug real encontrado por E7,
corregido con los pasos 4h5a/4h5b; staging no afectado).

### 2.2 Idempotencia, reversibilidad, riesgo

- **Idempotentes**: todas guardan cada ALTER con `if not exists` / inspección de `pg_get_constraintdef` (`DO $$`).
  Re-correrlas no hace nada.
- **Aditivas**: columnas nuevas nulas o con default constante; ninguna fila existente cambia de valor.
- **Bloqueos**: `set lock_timeout = '5s'` en las 4. `ADD COLUMN … NOT NULL DEFAULT 'content'` es solo metadatos en
  PG ≥ 11. Los `ADD CONSTRAINT … CHECK` (sin `NOT VALID`) toman `ACCESS EXCLUSIVE` y escanean la tabla
  (`course_chapters`, `course_profiles`, `generation_item_runs`, `course_generation_manifests`). En producción esas
  tablas **no existen aún o estarían vacías** (las crea el propio plan V2 en la misma ventana) ⇒ riesgo de bloqueo
  despreciable si se aplican junto con el esquema V2. Si se aplicaran meses después del rollout V2 con tráfico, el
  escaneo seguiría siendo pequeño (tablas de estructura, no de contenido), pero convendría `NOT VALID` + `VALIDATE`.
- **Reversibilidad**: cada `.sql` trae su rollback en la cabecera. P1 y P4 exigen **desactivar el trigger
  append-only** `course_profiles_no_direct_delete` y **borrar perfiles** (pérdida de datos). P2/P3 borran columnas
  (y P2 capítulos de práctica). Las cabeceras advierten: los Blueprints congelados con práctica/actividades/contexto
  **no se recanonicalizan con el backend anterior** ⇒ el rollback soportado es **flag OFF**, no revertir esquema ni
  código (coincide con `docs/v2-production-migrations.md:497-546`).
- **Riesgo de datos**: bajo (aditivas, CHECKs que las filas existentes cumplen por construcción).

### 2.3 Plan de migración de producción necesario

1. Agregar P1–P4 a `MIGRATION_STEPS` de `scripts/prod/migrate-v2-production.js` en el orden de 2.1 y quitarlas de
   `EXCLUDED` (`:223-226`).
2. Agregar a `VERIFY_SCRIPTS` (`:196-206`) `verify-pedagogy-profiles-schema.js`, `verify-practice-chapters-schema.js`,
   `verify-application-activities-schema.js`, `verify-academic-context-schema.js` (existen y corren en staging, pero no
   tienen modo `production-readonly` comprobado — verificar).
3. Extender `scripts/prod/test/run-local-pg-tests.js` / `run-legacy-app-compat-test.js` para que el PG16 local aplique
   el plan nuevo y el código de `main` siga funcionando sobre él (hoy esos tests no cubren P1–P4).
4. Nuevo `Plan sha256` en dry-run, aprobación del dueño, backup/PITR, apply **antes** del merge (schema-first, igual
   que el resto de V2: `docs/v2-production-migrations.md:164-180`).

---

## 3. Compatibilidad hacia atrás con datos existentes

**Contexto clave**: en producción hoy solo existen cursos **legacy** (no hay tablas V2). Los casos (b)–(f) aplican a
staging y a un eventual rollout V2.1 previo a estas fases.

| Caso | Resultado | Evidencia |
|---|---|---|
| (a) cursos legacy | **Sin cambios.** Ningún archivo del pipeline legacy cambió desde antes del motor pedagógico (`git diff 8716669..HEAD` sobre `mbz-builder.service.ts`, `package-worker.ts`, `content-worker.ts`, `audio-worker.ts`, `content-generation/` = 0 líneas). Todas las rutas nuevas son `DYNAMIC_CONTROLLERS` (`features/dynamic-routes.ts:29-45`) ⇒ 404 con el flag OFF. FE: solo wrappers en `24-backend-client.js`. | `check-dynamic-feature-gating.js` (101/0 en REVIEW-F5-2) |
| (b) dinámicos sin perfil pedagógico | Blueprint `21e04725…` y Manifest `e4a85978…` idénticos al dorado de Fase 1. | `check-design-baseline.js` BL1 (`:97-104`) — **corrido: 5/0** |
| (c) sin `targetHours` | Idéntico por enfoque (sha de Blueprint/Manifest, horas, costo); 80 casos dorados contra staging `ec2fb5b`. | BL2; `check-target-hours.js` TH2 — **corrido: 10/0** |
| (d) sin Actividades / `application_minutes` | Sin clave en snapshot, Manifest, totals, huellas y plan de empaque. | `check-application-activities.js` AA8 (`:263-273`) — **17/0**. Ojo: AA8 es estructural (ausencia de claves), no compara sha contra el código previo; la identidad por sha la da BL1. |
| (e) sin contexto académico / `outcome_ids` | Brief «byte a byte» igual; huellas de alineación solo si existe `course.academicContext` (`invalidation/fingerprints.ts:383-388`); coherencia `{available:false}`. | `check-academic-context.js:344` — **15/0**; `check-coherence-alignment.js` **7/0** |
| (f) Blueprints/Manifests congelados y runs terminados | Sha de snapshot y Manifest no se recalculan (inmutables). Huellas v3 incluyen práctica/aplicación/resultados **solo** cuando existen (`fingerprints.ts:303-305, 376-377, 383-388`) ⇒ el plan de invalidación de un run viejo da REUSE. Plan pineado: `PINNED_PLAN_SHA` en `check-v21-invalidation-v3.js:904`. | `check-v21-invalidation-v3.js` **50/0**; `check-invalidation-plan.js`, `check-generation-manifest-determinism.js`, `check-packaging-plan-determinism.js` OK; `check-change-impact.js` CI6 (sin cambios ⇒ todo intacto, costo 0) **8/0** |

**Excepción intencional (.mbz)**: la Fase 1 cambió a propósito el texto «~X min» de la apertura de cada capítulo
(`course-shell/facts.ts`, Ruling R10; dorados actualizados en `f57f085` en `check-ev6-h5p2-contracts.js` y
`check-ev6-h5p2-wire.js`: cambian solo 4 `label.xml`). Un curso V2 **re-empaquetado** después del deploy no es
byte-idéntico al anterior. Sin impacto en producción hoy (no hay cursos V2); sí lo tendría si V2.1 se promoviera antes
y estas fases después.

**Gaps de prueba**:
- G1. No hay un dorado de huellas/plan construido desde **Blueprints reales congelados de staging** anteriores a las
  fases (los dorados usan el fixture RCP). Recomendado antes de producción: exportar 2–3 snapshots reales (solo
  estructura, sin contenido) y fijar «plan v3 = todo REUSE».
- G2. Tests de compatibilidad de esquema de producción (`scripts/prod/test/*`) no incluyen P1–P4.

### 3.1 Guardas de esquema cuando falta una migración en producción

- Lecturas toleran la columna ausente: `to_jsonb(course_chapters) ->> 'chapter_kind' | 'application_minutes' |
  'outcome_ids'` (`lock-snapshot.ts:35-37`, `course-structure.service.ts:260-262, 386-391, 414-418`) ⇒ null, sin 42703.
- Escrituras ⇒ **503** con código estable: `schema_not_migrated_practice` / `_application` / `_academic`
  (`course-structure/v21-schema-guard.ts:77-146`; `applyDistribution` lo llama en `course-structure.service.ts:242-243`,
  práctica en `:313`).
- Perfil `pedagogy`/`academic` sin P1/P4: el 23514 de `course_profiles_kind_check` se traduce a 503
  (`course-profiles.service.ts:95-96, 267`).
- Fase 5 con runs v1/v2 ⇒ 400 (`change-impact.service.ts:122`).
- Conclusión: una migración faltante da **503 claro, no crash**, salvo el caso del §2.1 (P2 sin P3 ⇒ 500 al guardar el
  Manifest con práctica) — por eso P2 y P3 van juntas.
- Las guardas cachean «verificado» en memoria del proceso (`v21-schema-guard.ts:85, 110, 134`): tras migrar no hace
  falta reiniciar; tras **revertir** una migración sí (el caché seguiría diciendo OK).

---

## 4. Flags y gating

| Capa | Mecanismo | Default producción |
|---|---|---|
| Backend, todas las rutas de Fases 1–5 | `DynamicFeatureGuard` + `DYNAMIC_CONTROLLERS` (`PedagogyController`, `AcademicContextController`, `ChangeImpactController`, `CourseProfilesController`, `CoherenceController`, `InvalidationController`, …) | `DYNAMIC_COURSE_STRUCTURE` ausente ⇒ **404** (solo `'true'` exacto activa, `features/dynamic-features.ts:80-82`) |
| Backend, por cuenta | `DYNAMIC_V2_ALLOWED_OWNERS` | Flag ON + lista vacía = **todos** (comentario `dynamic-features.ts:11-12`) ⇒ siempre poner lista |
| Backend, reglas | `DYNAMIC_MANIFEST_RULES_VERSION` (ausente ⇒ 1, `manifest-rules-config.ts:35-44`) y `DYNAMIC_ACTIVITY_TYPE_RULES` | Fases 1–5 requieren **3** y **2** (staging los fija en `deploy-staging.yml:504, 508`) |
| Backend, IA de coherencia | `DYNAMIC_COHERENCE_LLM` | OFF (Fase 4 es determinista, no lo necesita) |
| Frontend, V2 | `24-backend-client.js:102-200`: en `cursia.nomaddi.com` solo si `GET /api/v1/features` responde `dynamicCourseStructure:true` en esta carga; `localStorage` no tiene efecto en prod | OFF (con el backend actual de main `/features` no existe ⇒ 404 ⇒ OFF) |
| Frontend, paneles | `pedEnabled()`/`acxEnabled()`/`cprofEnabled()` exigen `dynV21TogglesEnabled()` = `DYN.v21Rules` (rulesVersion 3) (`49-pedagogy-panel.js:48-51`, `50-academic-context-panel.js:49-52`, `43-dynamic-structure-editor.js:913-915`) | ocultos |

**¿Algo se enciende implícitamente al desplegar?** No: sin `DYNAMIC_COURSE_STRUCTURE=true` en el `.env` del VPS
(rsync excluye `.env`, `deploy.yml:80-85`) todas las rutas nuevas son 404, los workers dinámicos quedan inactivos
(`holdIdleIfDynamicDisabled`, `dynamic-item-worker.ts:1496`, `dynamic-provider-worker.ts:297`) y el FE queda en legacy.
El frontend se despliega solo al hacer push a main (Pages) pero queda inerte mientras el backend diga OFF.

**Hallazgo de gating (importante para el dueño)**: **no existe un flag por funcionalidad**. Con V2 + rulesVersion 3
encendidos para un owner, recibe a la vez motor pedagógico, horas, práctica, Actividades de Aplicación, contexto
académico, coherencia y vista previa del impacto. Si se quiere lanzar V2.1 sin alguna de ellas, hoy la única palanca
es no aplicar su migración (⇒ 503 en la UI, mala experiencia). Decidir: lanzamiento conjunto o agregar flags finos.

---

## 5. Costo y proveedores

- **Rutas pagas nuevas**: solo una — `llm.application_activity` (Anthropic `claude-sonnet-4-6`, 2 llamadas por actividad:
  actividad + solucionario), registrada en FinOps (`finops/operations.ts:17, 38`), con escala por minutos en el
  estimador (`run-budget.ts:89, 180, 228`) y prior p50 16k in / 9,5k out (`usage-model.priors.v1.json:3, 73`; es
  **prior, no medida**: reemplazar con ledger real).
- **Sin costo**: extracción del contexto académico (determinista, `pdf-parse`/JSZip, R22), coherencia (Fase 4),
  vista previa del impacto (Fase 5: sin escrituras ni proveedores; CI6 mide 0 llamadas de red), distribuidor y
  dry-run (BL5: 0 llamadas de red). PDF de la actividad con `pdfkit` local.
- **Costo indirecto grande (Fase 1)**: más horas ⇒ más capítulos ⇒ más video/Gamma/audio. Baseline RCP:
  20 h ≈ USD 31,59 · 33 h ≈ 33,25 · 50 h ≈ 48,23 · 64 h ≈ 54,70 (Videogen 16,21 + Gamma 10,35 + Anthropic 23,73 +
  TTS 4,40). Staging limita a USD 15 por run (`scripts/staging-budget-policy.js:28`, solo staging) ⇒ en staging casi
  todo curso con horas pide aprobación de admin.
- **Producción sin política**: `planNormalApproval` sin política ⇒ `blockedBy: no_budget_policy`
  (`finops/normal-approval.ts:70-75`) ⇒ `startRun` responde 409 (`runs.service.ts:1032`). El plan de producción solo
  siembra `pricing_catalog`, no `cost_budget_policies`. **Decisión del dueño**: `maxCostPerRun`, `maxCostPerCourse`,
  `monthlyCap` de producción, sabiendo que un curso de 50 h cuesta ~USD 48.
- **Doble cobro**: la Fase 5 no ejecuta nada. La regeneración real usa el plan v3: lo pagado queda `STALE_NO_AUTO`
  y exige `confirmPaid`; los cuatro conjuntos del impacto (`toRun`, `paidNew`, `paidRetry`, `paidStale`) son
  disjuntos (CI8) y el desglose por capítulo ya separa reintentos (`889b57b`, cierra M-NEW1 de REVIEW-F5-2).
  R26: cambiar vínculos a resultados solo regenera items de evidencia (texto/LLM), nunca video/Gamma/audiolibro.
  R18: cambiar resultados regenera solo las actividades. Riesgo residual bajo.
- **Ingesta FinOps**: requiere `FINOPS_INGEST_TOKEN` en el `.env` de producción (staging lo escribe desde un secreto,
  `deploy-staging.yml` paso 0c); sin él el ledger no registra el gasto LLM del navegador.

---

## 6. Operación

- **`deploy.yml` (prod) vs `deploy-staging.yml`**: el de producción solo corre `migrate-production-jobs-constraints.js`
  y `migrate-usage-events-costs.js` (`deploy.yml:113, 116`) — **no aplica ninguna migración V2** (por diseño:
  schema-first manual vía `v2-production-migrations.yml`, `workflow_dispatch` con environment protegido). El de
  staging aplica y verifica 30+ pasos, incluidas P1–P4, y además **escribe flags en el `.env`** (`[0b]`, `[0c]`,
  `deploy-staging.yml:492-540`); el de producción no toca el `.env`.
- **Workers**: no hay workers nuevos para estas fases. En el árbol de staging, `deploy.yml:127-129` ya arranca
  `dynamic-item/package/provider-worker` (inactivos con flag OFF; ≈128 MB RSS cada uno + wrapper npm, revisar
  `free -m`, `docs/v2-production-migrations.md:197-212`). `check-deploy-dynamic-workers.js` espera main + 2 líneas;
  hoy son 3 (provider-worker) — revisar el check al reconstruir el release.
- **Carga en el proceso API**: la extracción del contexto académico (`pdf-parse`, hasta 7 MB, `text-sources.ts:37,
  105`) corre dentro de `cursia-backend`; peor caso adversarial aceptado ~1,1 s de CPU bloqueante (R27). Aceptable,
  pero monitorear latencia del API.
- **Variables de entorno de producción a definir** (ninguna está en `.env.production.template`, última edición
  2026-06-15): `DYNAMIC_COURSE_STRUCTURE`, `DYNAMIC_V2_ALLOWED_OWNERS`, `DYNAMIC_MANIFEST_RULES_VERSION=3`,
  `DYNAMIC_ACTIVITY_TYPE_RULES=2`, `DYNAMIC_REAL_VIDEO_OWNERS`, `DYNAMIC_VIDEO_DELIVERY`, `FINOPS_INGEST_TOKEN`,
  `DYNAMIC_PROVIDER_WORKER_ENABLED`, `GAMMA_THEME_V21_LIGHT_DEFAULT`/`_DARK_DEFAULT`, `PRESENTATION_LIGHT_DEFAULT_SINCE`,
  `DB_POOL_MAX*`. (Varias son de V2.1, no de estas fases, pero sin ellas las fases no funcionan.)
- **Monitoreo**: existe `GET /admin/dynamic-runs/needs-attention` (SUPER_ADMIN) y el ledger FinOps; no hay métricas
  específicas de Fases 1–5 (p. ej. tasa de 503 `schema_not_migrated_*`, fallos de `APPLICATION_PDF_*`, duración de
  extracción). Recomendado: alerta por log de esos códigos.
- **Rollback**: soportado = flag OFF + `pm2 restart --update-env` de **todos** los procesos
  (`docs/v2-production-migrations.md:499-513`). No soportado: revertir código a main pre-V2 con filas dinámicas
  (`:515-534`). El mensaje de rollback de `deploy.yml:158` (`git checkout HEAD~1` en el VPS) es **engañoso**: el VPS
  recibe el código por rsync con `--exclude '.git'` (`:81`), no hay repo git ahí. Corregir el texto.

---

## 7. Minors y residuos aceptados del ledger que importan en producción

| Ref | Qué | Impacto en prod |
|---|---|---|
| R17 | «Aplicar diseño» sobrescribe los minutos de actividad fijados a mano (se avisa en UI) | UX; docentes reales lo notarán |
| R19 M4/M7 | «Énfasis» sin efecto cuando ya cumple; descubrimiento tardío de items de aplicación con `opts.rulesVersion` | UX / se resuelve en el primer claim |
| R20 N2/N3 | artifacts de aplicación generados antes del validador estricto; reintentos por regex de marcas | solo staging; en prod: más reintentos LLM ⇒ algo más de costo |
| R27 | extracción: vínculos extra, ids sin nota, mojibake intra-línea; `readText` 1,1 s peor caso | el docente revisa antes de guardar; CPU del API |
| R28 | impacto: capítulos borrados no listados aparte; lecturas sin transacción única; bloqueos del dry-run no mostrados; runs v1/v2 ⇒ 400; costo de REVIEW no contado | el costo mostrado puede quedar algo por debajo |
| F5-1 nota | `manifestB` usa el `activityTypeRules` del run A (plan A→B) | menor, no afecta «Aplicar diseño» |
| Hallazgos latentes ya corregidos | `cgm_counts_consistent` con práctica (en P3); `EXAM_BANK_PLAN` con práctica + banco (`002676c`) | refuerzan que P2+P3 y el código vayan juntos |
| Priors FinOps | `llm.application_activity` estimado con prior, no medida | recalibrar con ledger tras primeros cursos |
| Moodle | restauración verificada solo en Moodle 4.5 local (E7, cursos 2323–2327) | probar en el Moodle real del primer cliente |

---

## 8. Veredicto y checklist

### Veredicto

**NO LISTO** como promoción independiente de las Fases 1–5 (dependen de V2/V2.1 completo, ausente en producción, y la
Fase 5 aún no está en staging).
**LISTO CON CONDICIONES** como parte de un release V2.1 completo, una vez cumplidas las precondiciones siguientes.

### Precondiciones (numeradas)

1. **[Aprobación del dueño]** Decidir el alcance: lanzar V2.1 + Fases 1–5 juntas (no hay flags finos) o pedir flags
   por funcionalidad antes del release.
2. Mergear la Fase 5 a staging (BE `feat/partial-regeneration` → PR, FE ídem) con gate completo verde y deploy de
   staging exitoso; aceptación manual en `staging.orbia.pages.dev`.
3. **[Aprobación del dueño]** Reconstruir el release curado desde el staging final (el `release/cursia-v2` congelado no
   sirve) y decidir qué hacer con lo que DN-7 excluyó (rediseño de `course-setup` presente en el FE de staging).
4. Agregar P1–P4 al plan de `migrate-v2-production.js` en el orden de §2.1 (P2 y P3 inseparables), con sus verify en
   modo `production-readonly`; extender `scripts/prod/test/*` (PG16 local + compat legacy) y regenerar `Plan sha256`.
5. Cerrar el gap G1 (dorado de «plan v3 = todo REUSE» sobre 2–3 Blueprints reales congelados de staging).
6. **[Aprobación del dueño]** Política de presupuesto de producción (`maxCostPerRun`/`maxCostPerCourse`/`monthlyCap`),
   creada antes de encender V2; sin ella cada run ⇒ 409.
7. **[Aprobación del dueño]** `.env` de producción: valores de todas las variables de §6, con
   `DYNAMIC_COURSE_STRUCTURE` ausente/`false` hasta el paso C; `FINOPS_INGEST_TOKEN` como secreto. Actualizar
   `.env.production.template`.
8. Corregir el texto de rollback de `deploy.yml:158` y el check `check-deploy-dynamic-workers.js` (3 líneas).
9. Verificar memoria libre del VPS para 3 workers dinámicos inactivos.
10. Plan de monitoreo: alertas de log para `schema_not_migrated_*`, `APPLICATION_PDF_*`, `EXAM_BANK_PLAN`, 409
    `no_budget_policy`, y gasto diario del ledger.

### Secuencia de promoción propuesta (cuando se autorice)

| Paso | Acción | Quién / criterio |
|---|---|---|
| S0 | Precondiciones 1–10 cerradas; DN-6 a mano (0 filas ofensoras); backup/PITR verificado HOY | dueño |
| S1 | Dry-run del runner desde el commit de release ⇒ exit 0, anotar `Plan sha256` | cualquiera (no conecta) |
| S2 | **Migraciones primero**: `--apply --expect-plan-sha256` (esquema V2 + P1–P4) con código de main aún en producción | **dueño (muta producción)** |
| S3 | Smoke legacy con código de main sobre el esquema nuevo (biblioteca, crear curso, job corto, descarga) | dueño |
| S4 | **Backend**: merge del release a `main` del backend ⇒ `deploy.yml` success; `--verify-only` exit 0; smoke legacy; `GET /features` ⇒ `dynamicCourseStructure:false`; rutas V2 ⇒ 404 | **dueño (merge a main)** |
| S5 | **Frontend**: merge a `main` del FE (Pages) ⇒ verificar con fetch cache-busting que `49-pedagogy-panel.js`/`50-academic-context-panel.js` están en vivo; legacy intacto (V2 sigue OFF porque el backend dice OFF) | **dueño (merge a main)** |
| S6 | Flags: `DYNAMIC_V2_ALLOWED_OWNERS=<owner interno>`, `DYNAMIC_MANIFEST_RULES_VERSION=3`, `DYNAMIC_ACTIVITY_TYPE_RULES=2`, después `DYNAMIC_COURSE_STRUCTURE=true`; `pm2 restart --update-env` de todos | **dueño** |
| S7 | Smoke V2 con owner interno a costo controlado: perfil sin horas (debe dar sha base), perfil con 20 h, una Actividad de Aplicación, contexto académico desde un PDF, vista previa del impacto; un curso pequeño completo hasta `.mbz` y restauración en Moodle real | **dueño (gasto real de proveedores)** |
| S8 | Ampliar allow-list gradualmente; vigilar ledger y alertas; rollback = flag OFF | dueño |

### Ítems que requieren aprobación explícita del usuario

- Decidir alcance (conjunto vs flags finos) y release curado (incl. `course-setup`).
- Cualquier `--apply` contra la base de producción y el backup previo.
- Merges a `main` de backend y frontend (despliegan solos).
- Política de presupuesto de producción y valores del `.env` de producción.
- Encender `DYNAMIC_COURSE_STRUCTURE` y la allow-list; smoke con gasto real (Anthropic/Gamma/OpenAI/Videogen/YouTube).

---

## Anexo — verificaciones corridas en esta auditoría (locales, sin DB, sin red)

`env -i node scripts/<x>.js` sobre `r25/abe5/dist` (compilado del HEAD):
`check-design-baseline` 5/0 · `check-study-time` 12/0 · `check-target-hours` 10/0 · `check-distributor` 17/0 ·
`check-practice-chapter` 12/0 · `check-application-activities` 17/0 · `check-academic-context` 15/0 ·
`check-coherence-alignment` 7/0 · `check-change-impact` 8/0 · `check-v21-invalidation-v3` 50/0 ·
`check-invalidation-plan` OK · `check-generation-manifest-determinism` OK · `check-packaging-plan-determinism` OK ·
`migrate-v2-production.js` (dry-run, no conecta) confirma P1–P4 en «Excluido a propósito».
No corridos (necesitan Postgres/app completa): `check-pedagogy-engine` (bloque DB), `check-hours-engine-rcp`,
E2E v3 (E7–E10), QA de navegador; se toman los resultados de los gates del ledger (APP3 4499/0, CTX4, COH1) y de
REVIEW-F5-2 (0C/0I).
