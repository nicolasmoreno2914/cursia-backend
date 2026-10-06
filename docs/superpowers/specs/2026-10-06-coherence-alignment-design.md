# Fase 4 — Coherence Engine: alineación resultado → evidencia · diseño

Estado: roadmap 2026-10-05. USD 0, determinista, sin proveedores. Solo staging. Extiende el Coherence Engine de la
Fase 7 (`src/modules/coherence/`) con una capa nueva **A** (alineación); no es un sistema paralelo.

## 1. Diagnóstico (qué existe)

| Pieza | Hoy | Uso |
|---|---|---|
| Coherence Engine (S1–S4 estructural, C1–C7 contenido, reportes versionados) | títulos, objetivos, conceptos | nueva capa A sobre el MISMO Blueprint v2 |
| Blueprint v2 congelado | `course.academicContext` (RA/CO con nivel y dominio), `chapter.outcomeIds`, `applicationMinutes`, `kind: 'practice'`, `activityEnabled`, `examEnabled`, `finalExam`, `course.pedagogy` (diseño) | entradas del mapa de alineación |
| Modelo de tiempo (`study-time`, `studyTimeInputFromManifest`) | minutos por recurso y componente | minutos de práctica y aplicación por resultado |
| Motor pedagógico (dimensiones por enfoque: practice, evidence, problemFirst, reflection, priorKnowledge, conceptualDepth, selfRegulation…) | reglas de diseño | **umbrales y severidades** de la capa A: el enfoque cambia lo que se exige sin reglas por nombre de enfoque |
| Bloom (`academic-context/bloom.ts`) | nivel → dominio | qué evidencia pide cada resultado |
| Brief del claim (Fase 3) | resultados por item | mismo cálculo de «qué item evidencia qué» (`itemOutcomeIds`) |

## 2. Mapa de alineación (`alignmentVersion: 1`)

Por resultado (RA/CO): evidencias **tipadas**, nunca «texto relacionado».

```
outcome RA3 → [
  { kind: 'instruction', itemKey: 'content:<ch>', chapterId, moduleId },
  { kind: 'practice',    itemKey: 'activity:<ch>', minutes: 6 },            // H5P / SCORM / escenario
  { kind: 'practice',    itemKey: 'video_interactions:<ch>', minutes: 4 },
  { kind: 'application', itemKey: 'application_activity:<ch>', minutes: 60 },
  { kind: 'assessment',  itemKey: 'exam:<module>', style: 'situational_cases' | 'conceptual' },
  { kind: 'assessment',  itemKey: 'final_exam:<course>', style: … },
]
```

- Fuente única: `itemOutcomeIds(snapshot, item)` (la misma del brief): capítulo → sus vínculos; práctica sin vínculos →
  los del módulo; examen → unión del módulo; examen final → todos.
- Minutos por resultado: minutos del recurso repartidos en partes iguales entre los resultados que el item evidencia
  (sin doble conteo).
- Estado por resultado: `covered` (instrucción + práctica/aplicación según su nivel + evaluación), `partial`, `uncovered`.

## 3. Reglas (`alignment-rules@1`) — severidad crítico / advertencia / sugerencia

| Regla | Condición | Severidad |
|---|---|---|
| A1 OUTCOME_UNCOVERED | resultado sin ningún capítulo | crítico |
| A2 OUTCOME_NOT_ASSESSED | resultado sin evaluación (ni examen que lo cubra ni Actividad de Aplicación) | advertencia |
| A3 PRACTICE_EVIDENCE_INSUFFICIENT | resultado de saber hacer (aplicar+) o competencia sin práctica ni aplicación | advertencia; crítico si `evidence ≥ 0,85` |
| A4 CHAPTER_WITHOUT_OUTCOME | capítulo de contenido sin vínculo (con contexto guardado) | advertencia |
| A5 ASSESSMENT_MISALIGNED | resultado de saber hacer cuya única evaluación es conceptual (estilo `conceptual_relations` / `self_check_bank` o sin diseño) y sin Actividad de Aplicación | advertencia |
| A6 PRACTICE_TIME_INSUFFICIENT | resultado de alta complejidad (analizar/evaluar/crear o competencia) con minutos de práctica + aplicación < umbral | advertencia |
| A7 OUTCOME_LEVEL_UNKNOWN | resultado sin verbo observable reconocido | sugerencia |
| P1 (problemFirst ≥ 0,7) | módulo sin evidencia de problema/decisión (escenario ramificado, intención `decide`, aplicación) | sugerencia |
| P2 (priorKnowledge ≥ 0,7) | el contexto no declara conocimientos previos | sugerencia |
| P3 (reflection ≥ 0,7 / selfRegulation ≥ 0,7) | módulo sin autoevaluación ni reflexión (sin Actividad de Aplicación ni cierre reflexivo) | sugerencia |

Umbral de A6: `round5(30 + 90 × practice)` minutos (competencias 0,85 → 105; significativo 0,45 → 70; sin enfoque 0,5 → 75).

## 4. Dónde se ve

- `POST /courses/:id/coherence/alignment {blueprintNumber?}` (Coherence controller): sobre la estructura viva (Blueprint
  v2 en memoria con contexto + perfil) o un Blueprint congelado. No persiste.
- Dry-run pedagógico: `alignment` del diseño propuesto (materializado) → «Cursia verifica coherencia» antes de aprobar.
- Panel «Contexto académico»: paso 4 «Coherencia» (críticos / advertencias / sugerencias + mapa por resultado).
- Sin contexto académico: `{ available: false }` (nada cambia para los cursos de siempre).

## 5. Pruebas (4.5)

Caso correcto (todo cubierto), incompleto (RA sin evidencia → A1/A3), desalineado (saber hacer con solo examen
conceptual → A5), pedagógico (mismo curso, competencias vs significativo → severidades y umbrales distintos).
