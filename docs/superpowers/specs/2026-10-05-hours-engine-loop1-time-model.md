# Motor de carga horaria · Loop 1: modelo de tiempo

**Estado:** implementado en el backend. No llama a proveedores, no genera contenido y no tiene costo.

## Qué resuelve

Cursia calcula el tiempo de estudio de un estudiante típico con **una sola fuente de verdad**: `src/modules/study-time/time-model.ts`. Las reglas son fijas y versionadas (`STUDY_TIME_RULES`, `rulesVersion: 1`). La IA nunca decide minutos.

- **Planificado:** antes de generar, se calcula desde el Manifest v3 con `studyTimeInputFromManifest(manifest, blueprint)`.
- **Medido:** al empaquetar, `buildCourseFacts` usa las palabras, diapositivas, duración del video y preguntas de los exámenes del paquete real.

## Reglas (calibradas con los cursos #542, #583 y #616 de staging)

| Recurso | Regla | Planificado |
|---|---|---|
| Página del capítulo | palabras / 150 por min | 2.200 palabras |
| Libro Guía (por capítulo) | palabras / 150 | 2.900 palabras |
| Presentación | diapositivas × 0,6 min | 10 |
| Video | duración | 600 s |
| Preguntas y pausas del video | (preguntas + pausas) × 1 min | `videoInteractionCount` y `reflectionPauseCount` de `plan.ts`, el mismo plan que usa el empaque |
| Actividad (H5P o SCORM) | preguntas × 1,2 min | 8 |
| Repaso | tarjetas × 0,5 min | 9 (solo con `reviewCards`, H5P v2 y motor h5p, como el empaque) |
| Exámenes | preguntas × 1,2 min | `examSlotSplit` y `finalExamSlotSplit` (plan del banco) |
| Bienvenida, ruta y cierre | palabras / 150 | 950 palabras |
| Audio de bienvenida | duración | 60 s |
| Apertura de módulo | palabras / 150 | 450 palabras |
| Foro | fijo | 10 min |
| Actividad de aplicación (Fase 2) | nivel fijado por Cursia | 30/60/90/120; hoy nadie lo usa |

- El audiolibro no suma: es otra forma de recorrer el Libro Guía.
- El capítulo se muestra redondeado a 5 minutos (mínimo 5).
- Solo `undefined` significa «no medido». Un `null` o cualquier otro valor inválido es una medida rota y falla fuerte.
- **Salida:**
  - por capítulo, `chapterEstimatedMinutes` (exacto) y `displayMinutes`;
  - por módulo, `moduleEstimatedMinutes`;
  - por curso, `courseEstimatedMinutes` y `courseEstimatedHours`;
  - por recurso, `minutes`, la fórmula aplicada (`basis`) y si el dato es medido o planificado.
- «Repaso» usa un solo predicado, `reviewCardsEnabledFor`. Lo comparten el modelo y el empaque (`reviewCardsApply` lo llama).
- El curso se informa en minutos exactos y en horas con un decimal.
- `byComponent` separa el tiempo en curso, contenido, práctica, repaso, aplicación y evaluación, para explicar de dónde salen las horas.

## Discrepancia corregida

Antes, el badge «Capítulo N de T · ~X min» del paquete usaba `estimateChapterMinutes`: 180 palabras/min, video fijo de 6 min, actividad de 8 min, y no contaba el Libro, las preguntas del video ni el repaso. Por eso mostraba ~30–35 min, cuando el capítulo real lleva ~70.

Esa función y `CHAPTER_MINUTES_RULES` se eliminaron. `facts` calcula el badge con el modelo único y suma `facts.studyTime`, que tampoco se imprime en el shell:

- horas del curso;
- `usesPlannedValues`.

**Valores medidos al empaquetar:**
- palabras de la página;
- diapositivas;
- duración del video;
- tarjetas de cada «Repaso»;
- preguntas de cada examen;
- duración del audio de bienvenida.

**Siguen planificados:**
- preguntas de la actividad (8): hoy el empaque no las informa por tipo;
- palabras de las aperturas de módulo y del marco del curso.

**Aproximación del Libro:** sus palabras medidas se reparten por igual entre los capítulos. Ese total incluye además la apertura, las aperturas de módulo y la bibliografía, unos cientos de palabras por capítulo.

## Dónde se ve

- **Dry-run pedagógico:** `baseline.studyTime`, `pedagogical.studyTime` y `diff.estimatedHours`.
- **Paquete:** los minutos de cada capítulo en el badge y `facts.studyTime`.

## Pruebas

- `scripts/check-study-time.js` (ST1–ST11):
  - reglas;
  - capítulo completo;
  - RCP 3×3, que da 13,6 h;
  - presencia según el Manifest;
  - medidas;
  - errores;
  - el plan del video igual al empaque;
  - el plan de exámenes;
  - **3 cursos reales de staging** (medidas de solo lectura en `scripts/fixtures/study-time/staging-courses.json`: 6,5–6,6 h por curso de 2×2, 65–75 min por capítulo). Los videos son de YouTube y su duración no está en el `.mbz`, así que se deriva de las marcas de tiempo reales de las preguntas del paquete. La prueba verifica contra el paquete que la regla de cantidad de preguntas y pausas da lo mismo;
  - dry-run;
  - la corrección del badge.
- `scripts/check-v21-shell.js` (P3): los minutos de facts son los del modelo, con las mismas medidas.
