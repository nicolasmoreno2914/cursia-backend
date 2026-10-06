# Fase 5 — Regeneración parcial inteligente · diseño

Estado: roadmap 2026-10-05. USD 0: solo simulación (nada se regenera ni se cobra en esta fase). Solo staging.

## Qué existe y se reutiliza (no hay sistema paralelo)

- **Plan de invalidación v3** (`invalidation/plan-v3.ts`, Fase 8 + R26): huellas por item → REUSE / REVIEW / REGENERATE /
  GENERATE / STALE_NO_AUTO (pagados) / SOFT_DISABLE, con motivos. Es lo que ya usa la regeneración real
  (`POST …/manifest/runs {fromRun}`) y la regeneración por item (`…/items/:key/regenerate`, con `confirmPaid`).
- **Estimador FinOps** (`providerPlanFor`): costo por proveedor de un conjunto de items.
- **Distribuidor** (Fase 1): propuesta de estructura para otras horas, que nunca borra capítulos.

## Lo nuevo

1. `course-blueprints/lock-snapshot.ts` — `assembleLockSnapshotV2`: la composición del Blueprint que el lock congelaría HOY
   (estructura viva + perfil vigente o de vista previa + contexto académico). El lock la usa (misma salida que antes) y la
   vista previa también: lo que se previsualiza es exactamente lo que se confirmaría.
2. `invalidation/change-impact.ts` — puro: tabla de dependencias por tipo (5.1) y resumen del plan: qué se ejecutaría
   (texto), qué pagado queda marcado sin regenerarse solo (video, Gamma, audio; las preguntas del video siguen a su
   video), qué capítulos quedan intactos, horas antes/después y costo simulado (aparte, el de regenerar lo pagado).
3. `POST /courses/:id/change-impact {fromRunId?, profile?, applyDistribution?}` — sin escrituras, sin proveedores:
   «desde» = último run del curso; «hasta» = el Blueprint del lock de hoy (con el perfil de vista previa y, si se pide, la
   propuesta del distribuidor para sus horas). Sin run previo: costo de generar el curso completo.
4. Panel «Enfoque pedagógico»: «Impacto de los cambios» en el resumen (estructura actual) y en la vista previa del
   borrador (otro enfoque, otras horas).

## Casos (5.2–5.5)

- Cambiar un capítulo → solo sus items de texto; fuera de él, solo lo que lo incluye (plan, intros, exámenes); lo pagado
  del capítulo queda marcado.
- Cambiar el enfoque → todo item de texto lleva diseño, así que cambia (con su motivo); lo pagado no se regenera solo.
- 64 h → 48 h → nueva propuesta (no se borra ningún capítulo); se informa qué cambiaría.
- Costo de los cambios simulado; ejecutar requiere confirmar (fuera de esta fase).
