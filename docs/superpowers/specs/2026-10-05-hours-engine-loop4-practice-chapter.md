# Motor de carga horaria · Loop 4: capítulo de práctica

**Estado:** implementado de punta a punta:

- base de datos de staging;
- API y editor;
- Blueprint y Manifest;
- claim y ejecutor;
- invalidación y FinOps;
- empaque y validador;
- restauración en Moodle local.

Sin proveedores reales.

## Qué es

Un capítulo `kind: 'practice'` amplía horas con práctica y no con más texto. Comparado con un capítulo de contenido:

| | Contenido | Práctica |
|---|---|---|
| Libro Guía propio (`content`) | sí | **no** |
| Presentación (Gamma) | sí | **no** |
| Video y sus preguntas | si `videoEnabled` | **nunca** |
| Audiolibro | sí | **no** |
| Página (`experience`) | capítulo completo | **página de práctica guiada** (~900 palabras) |
| Actividad (H5P o SCORM) | si `activityEnabled` | si `activityEnabled` |
| Repaso (Dialog Cards) | si el curso lo tiene | si el curso lo tiene |
| Evaluaciones del módulo y final | lo cubren | **no** (no tiene texto propio) |
| Actividad de aplicación | Fase 2 | Fase 2 (nivel de cierre) |

- **Fuente.** La página y la actividad de práctica se generan con el texto de los capítulos de **contenido** de su módulo, en orden. El ejecutor lo recorta a 24.000 caracteres en total para no superar el límite del proxy.
- **Sin teoría nueva.** La página repasa lo indispensable, propone un caso integrador con su procedimiento, criterios de logro y preguntas de repaso del módulo.
- **Tiempo.** Una práctica dura ≈ 20 min: 900/150 + 8 × 1,2 + 9 × 0,5. Más su Actividad de aplicación cuando exista (Fase 2).

## Reglas (fallan fuerte)

- **Sin video.** Un capítulo de práctica nunca tiene video:
  - la API responde 400 `PRACTICE_CHAPTER_VIDEO`;
  - pasar un capítulo a práctica apaga su video;
  - el Blueprint, el Manifest y el plan de empaque lo rechazan;
  - el motor pedagógico no lo sugiere (regla de producto > pedagogía).
- **Módulo con contenido.** Cada módulo necesita al menos un capítulo de contenido (`PRACTICE_MODULE_WITHOUT_CONTENT`). El editor no deja eliminar el último capítulo de contenido de un módulo que tiene práctica.
- **Paquete limpio.** Un paquete que trae Libro, presentación o audiolibro para una práctica es un contrato roto (`practice_with_content`).

## Cadena

- **Base de datos (solo staging).** `course_chapters.chapter_kind text not null default 'content'`, con CHECK `('content','practice')`:
  - migración aditiva e idempotente (`supabase-migration-practice-chapters.sql`, `migrate-practice-chapters.js`);
  - verificación con sonda revertida (`verify-practice-chapters-schema.js`);
  - corre en `deploy-staging.yml` y nunca en `deploy.yml`;
  - las lecturas toleran una base sin la migración (`to_jsonb(...) ->> 'chapter_kind'`).
- **API y editor.**
  - `kind` en crear y actualizar capítulo, y en la lectura de la estructura;
  - botón «Agregar capítulo de práctica», que solo aparece con un backend que informa `kind`;
  - distintivo «Práctica», sin el toggle de video.
- **Blueprint.** `kind: 'practice'` SOLO en los capítulos de práctica: los demás conservan bytes y sha.
- **Manifest v3.**
  - La práctica produce `experience` y `activity`, con `dependsOn` = los `content` de los capítulos de contenido del módulo.
  - `modules[].chapters[].kind` solo en práctica.
  - El validador independiente recalcula lo mismo.
- **Exámenes.** `examChaptersFromManifest`, que comparten el claim y la validación del banco, y el estimador de FinOps excluyen la práctica. Agregar una práctica no cambia el costo ni la huella de los exámenes.
- **Claim.**
  - `claimPayload.practice.sourceChapterIds`;
  - `kind` en el outline y en los capítulos del módulo.
- **Invalidación.**
  - La huella de `experience`/`activity` de una práctica suma el `own` de sus fuentes.
  - El plan las regenera (`practice_sources_changed`) si cambia la práctica, el conjunto de fuentes o una fuente regenera.
  - La pertenencia de los exámenes ignora la práctica.
  - Agregar o quitar una práctica nunca regenera Libro, Gamma, video, audiolibro ni exámenes. El audio de bienvenida queda `STALE_NO_AUTO`.
- **Empaque.**
  - El plan lleva `kind`, y sus keys de content, presentación y audiolibro son `null`. Sin práctica, el JSON y el sha del plan no cambian.
  - Sección sin presentación; «Práctica guiada» en lugar de «Profundización».
  - Recorrido propio.
  - Libro y audiolibro solo con los capítulos de contenido.
  - `facts.slideCount = 0` y `kind`.
  - Badge de minutos con el modelo de tiempo.
  - El validador del `.mbz` prohíbe que la práctica nombre una presentación.

## Pruebas

- `scripts/check-practice-chapter.js` (PC1–PC9):
  - Blueprint;
  - Manifest y validador;
  - exámenes;
  - tiempo y costo;
  - invalidación;
  - empaque h5p y scorm;
  - pedagogía;
  - regresión.
- `scripts/check-pedagogy-engine.js` (DB): API con Postgres real, lock, Manifest, estructura viva = Blueprint y dry-run del curso.
- `scripts/check-v21-packaging-v3-moodle.js`: el curso `practice-chapters` se restaura en Moodle local y se inspecciona.
- Frontend:
  - `test-45-v3-items.mjs`: fuentes, recorte, falla visible y actividad;
  - `test-43-editor-add.mjs`: botón, distintivo, sin video y bloqueo de eliminación.
- Regresión:
  - todas las suites anteriores;
  - los dorados de `.mbz` legacy siguen idénticos.
