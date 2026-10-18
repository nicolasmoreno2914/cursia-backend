# r58 · Matriz de validación (Fase A, USD 0)

Fecha 2026-10-18 · rama `feat/incremental-validation-r58` (BE) · builder 3.15.1 · autor I6.
Sin red, sin proveedores, sin DB compartida. Datos sintéticos (courseId 9700–9999, clientes genéricos A/B/C).

**Raíces de evidencia**

| Alias | Ruta | Qué contiene |
|---|---|---|
| `O` | `~/cursia-test-env/work/r58/out/i6` | Corridas de I6 |
| `O/checks/<check>.log` | | Checks puros y con PG desechable, corridos por I6 sobre el código integrado de r58 |
| `O/finops/<check>.log` | | Checks de FinOps |
| `O/sim/commercial-simulation-summary.json` | | Simulación comercial: 17 cursos + CS2–CS9 |
| `O/one-by-one/one-by-one-evidence.json` | | Supuesto de la Fase B |
| `O/moodle-4.5/` | | Moodle 4.5 local (moodle-local, PG 5570) |
| `O/moodle-4.1-4.4/` | | Moodle 4.1–4.4 (moodle-versions, PG 5580) |
| `R57` | `~/cursia-test-env/work/r57` | r57: `ACCEPTANCE-MATRIX.md`, `t7-moodle-out/` con los 10 cursos de r57 en 4.1–4.5 |
| `W1…W5` | `~/cursia-test-env/work/r58w{1..5}` | Informes I1, I5a, I3, I5b, I2+I4 |

**Niveles de validación.** Cada fila indica el nivel **alcanzado** y lo que **falta**.

| Nivel | Significado |
|---|---|
| **R** · validado por reglas | Funciones puras con entradas construidas. |
| **F** · validado por fixtures | Camino completo de producto (perfiles → dry-run → Blueprint → Manifest → builder → `validateMbzV3`) con artifacts sintéticos o un LLM falso. |
| **M** · validado en Moodle local | Restauración real del paquete, aceptación y nota con estudiantes ficticios en Moodle locales desechables. |
| **IA** · pendiente IA real | Nada se generó con IA ni con proveedores reales. |
| **AC** · pendiente revisión académica | Ninguna persona experta revisó el contenido ni las decisiones pedagógicas. |
| **MC** · pendiente Moodle cliente | No se probó en el Moodle del cliente (temas, plugins, filtros y permisos propios). |

> Un PASS técnico **no es calidad comercial**. Los textos, preguntas, H5P y videos de estas pruebas son fixtures o salidas de un LLM falso: prueban que la estructura, las reglas y Moodle funcionan, no que el curso sea bueno. Toda fila queda en **IA + AC** como mínimo hasta un piloto real con revisión.

---

## 1. Pipeline, dry-run, generación parcial, replay, red

| Capacidad | Evidencia (test → resultado) | Ruta | Nivel |
|---|---|---|---|
| Etapas del pipeline (configuración → Prebrief → Blueprint → Manifest → briefs → claim → generación → validación por item → empaque → validador) | `check-offline-driver.js` 10/0 (OD2 sub-DAG + validador de completeItem; OD3 claim = scheduler); `check-commercial-simulation.js` CS1 ×17 cursos (25/0 en total); gate base r57g3 7038/0 | `O/checks/check-offline-driver.log`, `O/sim/…summary.json` | R, F · falta IA, AC |
| Dry-run (diseño + horas + costo estimado, sin gastar) | `check-offline-driver.js` OD7 (informe JSON/MD); `check-distributor.js` 21/0; `check-composition-formats.js` 14/0; CS4 (FinOps estimado = Manifest) | `O/checks/` | R, F |
| Generación parcial (selección por clave/tipo/capítulo, aprobados preservados) | OD2, OD4 (aprobados byte a byte, `APPROVED_HASH_MISMATCH`), OD10 (cascada); `check-run-stop-after.js` (r57) | `O/checks/check-offline-driver.log` | R, F · falta IA |
| Replay (fixtures saneadas con el mismo hash que el worker) | `check-replay.js` 7/0 | `O/checks/check-replay.log` | R · **falta IA** (solo hay fixtures sintéticas; las reales se graban en la Fase B) |
| Netguard (barrera de red del driver y del gate) | `check-netguard.js` 4/0; `net.log` = 0 líneas (I1) | `O/checks/check-netguard.log`, `W1/I1-REPORT.md` | R |
| Determinismo (mismo curso → mismo `.mbz`) | CS5; OD5; `check-generation-manifest-determinism.js`; `check-packaging-plan-determinism.js` | `O/checks/`, `O/sim/` | R, F |
| **Supuesto de la Fase B: curso NUEVO 1×1 sin exámenes** | `check-r58-one-by-one.js` 7/0, detalle en §8 | `O/one-by-one/one-by-one-evidence.json` | R, F, M · falta IA |

## 2. Calidad, horas y diseño

| Capacidad | Evidencia | Ruta | Nivel |
|---|---|---|---|
| Informe de calidad E1–E4 (formato común, severidades, entrega) | `check-quality-report.js` 10/0: 7 tipos limpios con 0 BLOCKER/MAJOR/MINOR y un fixture de defectos con los códigos exactos. **Nuevo CS1:** 0 BLOCKER en los 17 cursos de la simulación. **Nuevo CS8:** defectos sembrados en un curso real de la simulación → COUNT_CLAIM_MISMATCH, PRACTICE_FILE_REFERENCE_UNKNOWN, NUMERIC_WINDOW_CONFLICT, PREMATURE_COURSE_CLOSURE; `.mbz` sin un blob → FILES_INTEGRITY → BLOCKER | `O/checks/check-quality-report.log`, `O/sim/…summary.json` (`_seeded`) | R, F · falta AC (los umbrales de E2/E3 son heurísticos y `needs_human_review`) |
| Registro de horas (líneas, gap reportado, nunca rellenado) | `check-hours-model.js` 9/0; `check-study-time.js` 12/0; `check-target-hours.js` 10/0. **Nuevo CS1 (relaciones):** en los 17 cursos, Σ líneas = total, gap = objetivo − total, HOURS_TARGET_GAP ⇔ fuera de tolerancia, capítulos del paquete = Blueprint (sin relleno). CS7 prueba que la regla falla si se quita el hallazgo | `O/checks/`, `O/sim/` (`relations.hours`) | R, F · falta IA, AC (§9 hallazgo H1) |
| Duraciones 16 / 32 / 64 / 96 h (y 1–2 h) | CS1 [teorico-16] 16,2 h · [practico-32] 31,7 h · [casos-64] 62,1 h · [mixto-96] 92,1 h · [1x1-sin-examenes] 1,5 h, todos `within_tolerance` en el diseño | `O/sim/` | R, F, M |
| Tipos de curso: teórico, muy práctico, protocolos, por casos, metodología mixta | CS1 [teorico-16] (solo conceptual, profundidad, «Repaso»); [practico-32] (aplicación, video en los 9 capítulos, 11 AA); [protocolo-20] (solo protocolo, `vid.need.protocol`, rótulos de fase); [casos-64] (BranchingScenario, GIFT); [mixto-96] (Gagné, 5 tipos de capítulo, 34 Tareas formativas, pdf+docx); más los 10 de r57 | `O/sim/` | R, F, M · falta AC |
| Composición por necesidad (cantidad de videos) | **Nuevo CS9:** misma estructura con prioridad menos/recomendado/más → 3 / 4 / 9 videos; los 3 necesarios (`vid.need.*`) se mantienen siempre; Prebrief = Manifest. CS1 `videoRulePrefix`; CS4 videogen = videos | `O/sim/` (`_audiovisual`) | R, F · falta AC (§9 H2) |
| Objetivos ↔ actividades ↔ evaluaciones | **Nuevo CS1 (relaciones):** todo capítulo de contenido tiene objetivo, content y experience; actividad ⇒ item + H5P; examen ⇔ `examEnabled`; el banco evalúa **cada** capítulo del módulo; final ⇔ `finalExam`. CS7 prueba que la regla falla si se quitan preguntas de un capítulo. `check-coherence-alignment.js` | `O/sim/` (`relations`) | R, F · falta AC (alineación declarada por el LLM, sin medir) |
| Verificación del diseño / gate R68 / Prebrief | `check-r68-generation-gate.js`, `check-loop84-verification.js`, `check-prebrief.js`; OB3 (1×1: sin críticos, «sin evaluaciones» = advertencia) | `O/checks/` | R |

## 3. H5P y actividades

| Capacidad | Evidencia | Ruta | Nivel |
|---|---|---|---|
| H5P evaluativo (tracking, ítem de nota, completion por nota) | CS1 en cada `h5pactivity`; aceptación R2; escenarios con xAPI real | `O/moodle-*/acceptance-*.json`, `grades-*.json` | R, F, M · falta IA, MC |
| H5P pedagógico / Dialog Cards («Repaso», sin nota, completion por vista) | CS1 + `check-review-cards-content-only.js`; aceptación R2; escenarios s5a/s5b (misma nota con y sin vista) | idem | R, F, M · falta IA |
| QuestionSet, DragText, Blanks | `check-v21-activity-type-rules.js` 31/0; CS1 `activityTypesOnly` / `h5pLibrariesInclude` [multi-h5p] | `O/checks/`, `O/sim/` | R, F, M |
| BranchingScenario | CS1 [normativo], [casos-64], [multi-h5p]; `check-ev6-h5p2-wire.js` 25/0; `check-ev6-h5p2-contracts.js` 29/0 | idem | R, F, M · falta IA (estructura generada por el LLM falso) y reproductor en navegador (`check-v21-h5p-player.js` no se corrió) |
| Video interactivo (InteractiveVideo + interacciones) | `check-ev6-h5p2-wire.js`; CS1 [multi-h5p]. Video **mock** en el driver (vista previa omitida) | idem | R, F · falta IA (Videogen real), MC |
| Actividad de Aplicación + solucionario oculto | CS1 (un solucionario oculto por AA); aceptación R8; `check-application-activities.js` | `O/sim/`, `O/moodle-*/` | R, F, M · falta AC |
| Archivos de práctica (xlsx/docx/pptx/pdf/csv) | CS1 [ofimatica], [entrega-rubrica], [mixto-96] (pdf+docx); relación «archivo de AA ⇒ capítulo con AA»; aceptación R7 (nombre, mimetype, sha256); I4-2 validación al adjuntar | idem | R, F, M |
| Tarea (assign): calificada vs **formativa**, rúbrica, adjuntos | CS1 [ofimatica] (calificada, sin rúbrica); [entrega-rubrica] (rúbrica, categoría «Actividades de Aplicación»); **nuevo** [mixto-96] (34 Tareas formativas sin nota, categoría null, pdf/docx); `check-application-deliverables.js`; `check-application-deliverables.php` en Moodle | idem | R, F, M · falta MC |
| Libro Guía (recurso) | CS1: recurso = 1 Libro + archivos de práctica; sin nota → completion por vista del Libro (OB6) | idem | F, M · falta IA |

## 4. Evaluaciones

| Capacidad | Evidencia | Ruta | Nivel |
|---|---|---|---|
| Bancos de examen (contrato, regla de conjunto, híbrido, XML) | `check-p2-exam-validators.js`, `check-p2-exam-bank-contract.js`, `check-exam-bank-set-rule.js`, `check-exam-bank-hybrid.js`, `check-p2-bank-xml.js` | `O/checks/` | R, F · falta IA (r57/#1353: bancos reales caros y frágiles) |
| Aleatorización (slots aleatorios resolubles) | CS1 (todos los slots aleatorios en modo banco; 0 en GIFT); aceptación R3 | `O/sim/`, `O/moodle-*/` | F, M |
| Sesgo de longitud: examen | `check-t6-answer-bias-pool.js` | `O/checks/` | R |
| Sesgo de longitud: video (servidor) | `check-quality-report.js` (VIDEO_MC_COURSE_LENGTH_BIAS en `prevalidateV3`, I4-1) | `W5/I2I4-REPORT.md` | R · falta IA |
| Intentos, retroalimentación, «Respuestas explicadas», restricciones de acceso | `check-p2-explanations.js`; aceptación R3 (página con acceso restringido por la completion del quiz); escenarios s2/s4/s6 (intentos agotados abren la página) | `O/checks/`, `O/moodle-*/grades-*.json` | R, F, M · falta MC |
| Curso sin exámenes (Fase B) | OB2, OB6; CS1 [1x1-sin-examenes] en Moodle 4.1–4.5 (modo `no_final` de los escenarios) | `O/one-by-one/`, `O/moodle-*/` | R, F, M |

## 5. Nota, aprobación, insignia, completion

| Capacidad | Evidencia | Ruta | Nivel |
|---|---|---|---|
| Gradebook (categorías, pesos, Tarea en su categoría) | aceptación R6; **nuevo CS1:** con nota ⇒ Σ pesos = 100 y toda categoría con peso tiene ítems calificables | `O/moodle-*/acceptance-*.json`, `O/sim/` | R, F, M |
| Aprobación por nota final | escenarios s1–s7 (completo ⇔ nota ≥ nota mínima del curso) en cursos con evaluación final; **nuevo modo `no_final`** (s1/s3/s5a/s5b) en [1x1-sin-examenes]; Tareas: `check-application-deliverables.php` | `O/moodle-*/grades-*.json` | M · falta MC |
| Insignia-certificado | aceptación R5; escenarios (insignia ⇔ curso completo). **Nuevo:** sin evaluación final ⇒ 0 insignias restauradas y 0 emitidas; CS1 (insignia ⇔ final con nota) | idem | R, F, M |
| Completion del curso | aceptación R4 (un criterio tipo 6 = nota del curso). **Nuevo:** curso sin ítems calificables ⇒ un criterio de actividad (vista del Libro), nota mínima 0 ([1x1-sin-nota], escenarios n1/n2) | idem | R, F, M |
| Guía del docente oculta | CS1 [A-S], [entrega-rubrica]; aceptación R8; `check-t6-teacher-guide.js` | idem | F, M |

## 6. Moodle 4.1–4.5

| Versión | Cursos | Resultado | Evidencia |
|---|---|---|---|
| 4.5 local (4.5.14+) | 7 nuevos de r58 + regresión [A-S] (modo `full`) y [ofimatica] (Tareas) | **18/18 PASS** (9 builds + 9 restauraciones; 1055 aserciones de aceptación + 1022 de nota) | `O/moodle-4.5/summary.json` |
| 4.1, 4.2, 4.3, 4.4 (moodle-versions) | 7 nuevos de r58 (todos, en cada versión) | **28/28 PASS** (35/35 con los 7 builds) | `O/moodle-4.1-4.4/summary.json`, `O/moodle-4.1-4.4.log` |
| 4.1–4.5 (10 cursos de r57) | A-S … multi-h5p | PASS en r57; no se re-corrieron (el builder solo cambió en r58 por horas/calidad, ya re-validado en 4.5 local con [A-S] y [ofimatica]) | `R57/t7-moodle-out/summary.json` |

Cambios del harness (no del paquete): `check-grading-scenarios.php` reconoce tres formas de curso (`full` sin cambios; `no_final`; `without_grades`). `check-commercial-acceptance.php` R4 acepta `withoutGrades` (criterio de vista del Libro). `check-commercial-simulation-moodle.js` acepta `--out=`.

### 6.1 Resultado 4.1–4.4
- **Versiones:** 4.1.22+, 4.2.11, 4.3.12, 4.4.12+. En cada una, los 7 cursos nuevos dan 840 aserciones de aceptación y 674 de nota, todas OK.
- **Avisos:** 0 avisos de PHP del paquete. Hay 7 deprecations del núcleo de 4.1 con PHP 8.3, una por curso; vienen del entorno y se cuentan en `phpCoreDeprecations`.
- **Limpieza:** verificada en los 28 casos (curso borrado y 0 usuarios de prueba).
- **Cluster:** el cluster 5580 lo levantó el runner y lo apagó al terminar (`pg_isready` 5580 = sin respuesta).
- **Escenarios de nota por forma de curso:**
  - `full` (con evaluación final): s1–s7.
  - `no_final` ([1x1-sin-examenes]): aprueba con 85, reprueba con 40, «Repaso» sin efecto y sin insignia.
  - `without_grades` ([1x1-sin-nota]): completo solo si se vio el Libro y sin nota.

## 7. FinOps y seguridad

| Escenario (AU3 §H5) | Test que lo cubre | Resultado (I6) | Nivel |
|---|---|---|---|
| Presupuesto cero | `check-finops-atomic-cap.js` [AT] «BLOCKED = tope 0»; `check-v21-finops.js` «runtime guard … sin autorización ⇒ block»; `check-v21-finops-wiring.js` (todo run de approve-and-start queda con autorización) | 13/0 · 37/0 · 63/0 | R (PG desechable) · **hueco abierto §9 H4** |
| Presupuesto insuficiente | [AT] 60 reservas en paralelo contra USD 1,00; [WK] 8 llamadas, tope para 3; wiring «presupuesto excedido → item blocked»; `check-recovery-budget.js` | 13/0 · 19/0 | R |
| Sub-consumo | `check-commercial-finops.js` FA3 (liquidadas netean 0); wiring «proxy-reserva → LIQUIDA» | 8/0 · 63/0 | R |
| Sobre-consumo | [AT] red de seguridad M3 (cargo real > reserva → pausa al liquidar); [UB] cota ≥ todo cargo real (1000 mezclas) | 13/0 | R · pendiente: prompt con tokens > caracteres/2,5 (CJK/emoji) |
| Reintentos múltiples | FA5; recovery-budget escenarios 6, 8, C2; `check-llm-worker-server-api.js` (un reintento por llamada; tope por parte) | 8/0 · 19/0 · 11/0 | R |
| Falla del proveedor | llm-worker-server-api I2 (503/400 liberan, 504 desconocido); `check-llm-worker-stream.js`; wiring 429/529 | 11/0 · 10/0 | R · política 400 worker ≠ proxy sigue abierta (AU3) |
| Run interrumpido / lease | `check-rel-exec-lease.js`; `check-run-pause.js`; llm-worker-server-api I3. **Nuevo `check-r58-lease-midcall.js`**, detalle abajo | 16/0 · 15/0 · **6/0** | R |
| **Lease que vence a mitad de una llamada** (faltaba) | `check-r58-lease-midcall.js`: LM1 (A en vuelo, B repite → 2 reservas a1/a2, ambas liquidadas con su cargo real, 0 pendientes, ledger = cobros del proveedor); LM2 (ventana conocida fijada: A pagó y no pudo guardar → B paga 1 vez más, ambas registradas); LM3 (A guardó → B 0 pedidos); LM4 (tope con la reserva de A en vuelo → B no llama, run pausado `run_budget_cap`); LM5 (respuesta perdida → reserva pendiente que cuenta; sin bucle); LM6 | 6/0 | R (ledger falso con tope; createServerApi y hooks reales) |
| Reserva abierta | recovery-budget escenario 4; wiring «respuesta PERDIDA → pendiente» y conciliación; LM5 | 19/0 · 63/0 · 6/0 | R · pendiente: alarma por antigüedad |
| Doble ejecución | v21-finops «misma idempotency_key 5× ⇒ 1 fila»; wiring Videogen re-claim ⇒ 1 cargo; doble clic ⇒ un run; exec-lease claims simultáneos; LM1/LM3 | 37/0 · 63/0 · 16/0 · 6/0 | R |
| Componente sin atribuir | `check-r58-finops-security.js` [PX] (id inventado → 409 sin reservar; techo por dueño y global; 20 en paralelo) | 17/0 | R · valores de techo sin decidir |
| Intento de bypass | [VE] video-engine 403/503 con 0 llamadas; [LJ] legacy 503; [SC] llamadas directas 503 con 0 llamadas; [PJ] PATCH de run V2 403; [AD] admin verificado; FE `test-r58-functions-security.mjs` 9 (I5a) | 17/0 | R |
| Consumo concurrente | [AT] 60 reservas / 3 procesos; lotes todo-o-nada; [PX] 20 en paralelo; wiring «dos clics simultáneos»; [OM] tope mensual por dueño bajo `MONTH_CAP_LOCK` | 13/0 · 17/0 · 63/0 | R |
| Kill switch / allow-list de proveedores | [KS] (proxy 409, worker/lote rechazados, cargo posterior registrado; allow-list anthropic) | 17/0 | R · falta ensayo en staging (§12 del plan B) |
| Ledger veraz (p0) | `check-finops-p0-ledger-truth.js` | 19/0 | R |
| Fixes de seguridad r58 (SSRF, notify, admin, artifacts) | [YT], [AD]; `check-artifact-storage-ownership.js`; `check-r58-pipeline-hardening.js` (I5b); FE `test-r58-functions-security.mjs` | ver `O/checks/` | R · falta despliegue y prueba en staging |
| Factory mode (freeze, hold de empaque, workers) | `check-deploy-freeze-guard.js`, `check-deploy-dynamic-workers.js`, `check-run-stop-after.js` (r57), `check-ev6-dod-autopkg.js` (I5a) | ver `O/checks/` | R · falta ensayo operativo |

## 8. Supuesto de la Fase B (1 módulo × 1 capítulo, sin exámenes)

`check-r58-one-by-one.js` 7/0. Curso `1x1-sin-examenes` (2 h, `designPreferences {applicationActivities:'none', guidedPractice:'none'}`, `examEnabled=false`, `finalExam=false`).

| # | Qué prueba | Resultado |
|---|---|---|
| OB1 | Perfiles reales con `finalExam=false`; el Blueprint congela ambos flags | PASS |
| OB2 | Manifest = lista blanca de 11 ítems; `validateGenerationManifestV3` sin errores; Prebrief y `previewCounts` dan 0 exámenes y 0 AA | PASS |
| OB3 | `verifyDesign` sin críticos (con 2 advertencias: «sin evaluaciones» y «sin resultados»); `prebriefReadiness` sin bloqueos | PASS |
| OB4 | Driver offline: los 11 ítems se reclaman y generan en orden topológico; `qa_preview` válido; 0 quiz; calidad 0 BLOCKER | PASS. El único MAJOR es HOURS_TARGET_GAP, porque el contenido falso es corto; el gap se reporta y no se rellena |
| OB5 | Video, presentación y audio en mock: solo 7 ítems de IA, 0 proveedores pagados reales | PASS. Esperado USD 0,85, máximo USD 2,63 [E] |
| OB6 | Nota: con H5P calificable hay criterio de nota y no hay insignia; sin ítems calificables, completion por el Libro | PASS. Moodle 4.1–4.5 en §6 |
| OB7 | Límites de la forma | Con `examEnabled=true` aparece `exam`. Con AA en `auto` aparece una AA. Con 3 h aparecen capítulos de práctica. Entre 1 y 2,5 h se mantiene la lista blanca |

**Producto:** no se necesitó ningún cambio. **Condiciones para la Fase B:** las dos preferencias en `none`, `targetHours` ≤ 2,5 h y `DYNAMIC_ALLOW_PROVIDER_MOCK=true`. Quedan registradas en `r58-phase-b-plan.md` §2.3.

## 9. Hallazgos (para decidir; ninguno bloquea la Fase A)

- **H1.** Todos los cursos de fixtures dan HOURS_TARGET_GAP MAJOR en el paquete. El diseño cae dentro de la tolerancia, pero los artifacts sintéticos miden menos horas: por ejemplo, [mixto-96] mide 80,5 h contra 96 h. Es esperable con fixtures y muestra que el gap se reporta sin rellenarse. Con IA real hay que medirlo de nuevo antes de prometer horas. **Pendiente IA y AC.**
- **H2.** [teorico-16] con prioridad «menos video» y composición por necesidad queda con **0 videos** (`vid.optional.less`). Es coherente con las reglas, porque en un curso conceptual el video es opcional. Aun así, que un curso comercial de 16 h no tenga ningún video merece una **decisión académica**.
- **H3.** Ventana de doble cobro en la toma de una parte, fijada por LM2. El guardado de la llamada se rechaza cuando el worker ya perdió la lease (`dynamic-llm-worker.ts` `recordCheckpoint`: `worker_id = $2`), así que el nuevo dueño paga esa llamada otra vez. Está acotado a una llamada y el ledger registra ambos cargos. **Mejora posible, no aplicada:** aceptar el guardado del worker anterior, ya que es la misma parte, la misma generación y el mismo hash de pedido. Necesita decisión y revisión.
- **H4.** Presupuesto cero. Un run **sin ninguna fila de autorización** no tiene tope para el LLM (`finops-ledger.service.ts` y `guardLlmCallForRun`: «runs previos a FinOps»). Hoy todo run de approve-and-start la crea (wiring 63/0), pero no hay un invariante que falle cerrado para los otros caminos de creación. **Recomendación:** fallar cerrado para runs V2 creados después de una fecha de corte. Decisión pendiente.
- **H5.** Fixtures de calidad: en los cursos de la simulación aparecen MINOR de ACTIVITY_LENGTH_DISPROPORTIONATE y FORMULAIC_OPENING. Vienen del contenido sintético (textos repetidos) y no son del producto. No se calibraron umbrales con contenido real. **Pendiente IA y AC.**
