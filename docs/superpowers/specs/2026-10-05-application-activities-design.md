# Fase 2 · Actividades de Aplicación — diagnóstico y diseño

**Estado:** diseño aprobado por regla de trabajo (decisiones técnicas normales sin esperar aprobación, directiva 2026-10-05). USD 0; staging; producción intacta.

## 1. Diagnóstico: qué se reutiliza (nada paralelo)

| Pieza existente | Qué aporta | Cómo se usa |
|---|---|---|
| **Modelo de tiempo** (`study-time/time-model.ts`) | Ya tiene `applicationMinutes` por capítulo con niveles 30/60/90/120 y el componente `application`. | Fuente única: los minutos entran en `chapterEstimatedMinutes` → `courseEstimatedHours`. Solo hay que alimentarlo desde el Manifest y desde los facts del paquete. |
| **Distribuidor** (`study-time/distributor.ts`) | Ya reserva niveles de aplicación por rol del capítulo y política pedagógica (topes 90/120, share cap). | Las actividades pasan de «reservadas» a **generables**: `generableHours = estimatedHours` cuando el curso las tiene. |
| **Capítulo de práctica** (Loop 4) | Capítulo sin video/Gamma/audiolibro/Libro; fuentes = capítulos de contenido del módulo. | Una práctica puede llevar Actividad de Aplicación; sus fuentes son las mismas (`moduleContentKeys`). Ninguna regla de video/Gamma/audiolibro cambia. |
| **Blueprint v2** | Claves opcionales solo cuando aplican (`kind`, `targetHours`) → sha idéntico en cursos que no las usan. | Nueva clave opcional por capítulo `applicationMinutes` (solo si está fijada). |
| **Manifest v3** + validador independiente | Items por capítulo con `dependsOn`, totales, exclusión de exámenes. | Nuevo item `application_activity:<capítulo>` (ruling R16) tipo `application_activity`, `dependsOn` = `content` del capítulo (o del módulo en práctica). Sin la clave, el Manifest es byte-idéntico. |
| **Motor pedagógico** (perfil, reglas, `generator-directives`) | Enfoque, `learningOutcomes` (hoy guardados pero no usados), learner, diseño por capítulo. | Bloque pedagógico del prompt + directivas por enfoque para la actividad. `learningOutcomes` entra por primera vez en un generador. |
| **Ejecutor del navegador** (`45-dynamic-generation-executor.js`) | `_dynV3JsonWithRetry`, artifacts JSON, validación espejo, fuentes del capítulo/práctica. | Nuevo `_dynRunApplicationActivity`, mismo patrón que `experience` (JSON + reintento dirigido + artifact). |
| **Validación servidor** (`course-shell/v3-validation.ts`) | El backend re-valida cada artifact al completar el item. | Validador `validateApplicationActivityV1` espejo del cliente (fallar fuerte). |
| **FinOps** (`operations.ts`, priors, seed) | Costo por operación con priors p10/p50/p90. | `application_activity → llm.application_activity` (Anthropic). Costo pequeño: 2 llamadas de texto. |
| **Invalidación / cascada** | Huellas `own` + dependencias; regeneración por item. | Huella propia: título, objetivo, tipo, minutos, diseño pedagógico, resultados de aprendizaje; dependencias: los `content`. Regenerar una actividad = regenerar su item. |
| **Empaque v3** | `mod_page` con HTML inline (páginas «Respuestas explicadas»), `label` oculto `visible=0` para docentes, `resource` PDF con pdfkit (Libro Guía). | Página de la actividad + PDF imprimible; solucionario como página **oculta** + su PDF. |
| **Validador .mbz** | Reglas por capítulo (práctica sin presentación, tokens). | Reglas nuevas: la actividad y su solucionario existen, el solucionario está oculto, el estudiante nunca recibe la solución. |
| **Panel pedagógico** (49) | Vista previa con horas, propuesta, costo (dry-run, USD 0). | «Cursia recomienda», «Ver diseño», «Ajustar», «Aplicar diseño». |

Faltaba (confirmado por grep): la columna/clave por capítulo, el item del Manifest, el generador, el empaque, el solucionario y la forma de pasar la propuesta del distribuidor a la estructura real (hoy era solo una vista).

## 2. Formato: HTML en Moodle + PDF (evaluado, no asumido)

| Criterio | HTML (`mod_page`) | PDF (`resource`) | HTML + PDF |
|---|---|---|---|
| Experiencia en Moodle (escritorio, móvil, app Moodle) | ✅ nativa, responsive, accesible, buscable | ⚠️ visor/descarga; en móvil se pierde el zoom de texto | ✅ |
| Restricciones de Moodle (`format_text` quita `<style>`/`<script>`) | ✅ ya resuelto: estilos inline como las páginas de exámenes | n/a | ✅ |
| Imprimir / resolver en papel con espacios para respuestas | ⚠️ impresión del navegador sin control de saltos ni renglones | ✅ maquetación fija, renglones para responder | ✅ |
| Costo | 0 (render determinista del JSON) | 0 (pdfkit, ya en el backend) | 0 |
| Riesgo | bajo | medio (fuentes/caracteres, ya resuelto en el Libro) | medio |

**Decisión:** el HTML es la experiencia principal (es donde el estudiante trabaja y donde Moodle registra la vista), y el PDF va como **descarga opcional generada del mismo JSON**, con renglones para responder. Una sola fuente (JSON) produce las dos salidas, así que no pueden divergir. El PDF se adjunta dentro de la misma página (filearea `content` de `mod_page`), sin otro recurso en la sección.

## 3. Solucionario docente: página oculta (mecanismo existente)

- Moodle no deja a un estudiante abrir una actividad con `visible=0`, ni siquiera por URL directa: hace falta `moodle/course:viewhiddenactivities`, que tienen el profesor y el gestor. El restore conserva `visible=0`.
- Cursia ya lo usa (nota de exámenes y paso de la insignia para docentes).
- **Solucionario** = `mod_page` con `visible=0` en la misma sección, justo después de la actividad, con su PDF. Lleva respuestas, explicación, solución esperada del taller, criterios de corrección (reutilizables como rúbrica en una fase posterior) y observaciones para el docente.
- La página del estudiante nunca incluye las respuestas, y el validador del `.mbz` lo comprueba.
- Riesgo conocido, documentado en el propio solucionario: si un docente lo hace visible, los estudiantes lo ven. No se usan rúbricas nativas (fase posterior).

## 4. Modelo

- **DB (solo staging):** `course_chapters.application_minutes smallint null`, con `CHECK (application_minutes in (30,60,90,120))`. La migración es aditiva e idempotente, va en `deploy-staging.yml` y queda en EXCLUDED del plan de producción. Las lecturas son tolerantes (`to_jsonb(ch)->>'application_minutes'`). Si se escribe sin la columna, responde 503 `schema_not_migrated_application`.
- **API:** `applicationMinutes: 30|60|90|120|null` en crear y actualizar capítulo. La lectura de la estructura lo informa solo si la columna existe.
- **Blueprint v2:** `chapters[].applicationMinutes` existe solo cuando está fijada. Se valida con `INVALID_APPLICATION_MINUTES`.
- **Manifest v3:** `application_activity:<id>` con `type: 'application_activity'` y `applicationMinutes`. `dependsOn` = `content:<id>` en contenido, o los `content` de los capítulos de contenido del módulo en práctica. Agrega `modules[].chapters[].applicationMinutes` y `totals.applicationActivityCount`, este último solo si hay alguna. Queda fuera de exámenes y nunca agrega video, presentación ni audiolibro.
- **Tiempo:**
  - `studyTimeInputFromManifest` y `facts` pasan `applicationMinutes`;
  - el badge de minutos del capítulo la incluye;
  - `generableHours` la incluye.
- **FinOps:** `application_activity: ['llm.application_activity']`, con prior de 2 llamadas (alumno y solucionario).

## 5. Generación (ejecutor del navegador, proveedores falsos en las pruebas)

El item hace dos pasadas, y las dos validan fuerte:

1. **Actividad del estudiante.** JSON `application_activity_v1` con estas partes:
   - `genre`: lista cerrada, la elige la IA según la disciplina — `calculation`, `case_analysis`, `procedure`, `production`, `design_build`, `decision`, `inquiry`;
   - `objective`;
   - `context`;
   - `examples`: 0–2. Al menos uno en `calculation`, `procedure` y `design_build`;
   - `exercises`: 6–10, con `id`, `prompt`, `difficulty` (básico/intermedio/avanzado, en orden no decreciente cuando hay gradación), y `answerLines` (renglones para el PDF, 1–15; implementado sin `kind`: el género de la actividad ya fija la forma);
   - `workshop`: situación, consignas y tiempo;
   - `deliverable`: producto o evidencia, formato y extensión;
   - `selfCheck`: checklist de 4–8 ítems;
   - `criteria`: 3–4, con nombre, descripción y peso que suma 100;
   - `minutesBySection`: la suma va a ±20 % del nivel.
2. **Solucionario.** JSON `application_solution_v1`:
   - `answers[]`: uno por cada `exercise.id`, con respuesta y explicación;
   - `workshopSolution`;
   - `correctionGuide[]`: por criterio, los niveles logrado, en proceso e insuficiente;
   - `teacherNotes`.

   Se valida que cubra exactamente los ids de la actividad.

**Adaptación.** El prompt recibe tema, objetivo del capítulo, resultados de aprendizaje del perfil, enfoque y directivas, tipo de capítulo, nivel y dificultad del learner, disciplina o sector, perfil del estudiante, minutos del nivel y el texto fuente del capítulo (recortado como en la práctica).

| Nivel | Ejercicios | Ejemplos | Taller |
|---|---|---|---|
| 30 min | 6–7 | 0–1 | breve |
| 60 min | 6–8 | 0–2 | estándar |
| 90 min | 8–10 | 0–2 | extendido |
| 120 min | 9–10 | 0–2 | extendido |

(Tabla implementada = `EXERCISES_BY_MINUTES` de `course-shell/application-activity.ts`; los géneros calculation, procedure y design_build exigen al menos 1 ejemplo.)

**Artifact:** `dynamic_application_json` con `{ activity, solution }`. Un item genera las dos partes, así que la regeneración nunca las desincroniza.

## 6. Diseño: «Cursia recomienda», «Ver diseño», «Ajustar», «Aplicar diseño»

- **Dry-run (USD 0).** La propuesta del distribuidor trae los minutos de aplicación por capítulo. Desde ahora son generables.
- **«Cursia recomienda»:** módulos · capítulos, capítulos de práctica, capítulos audiovisuales, Actividades de Aplicación, evaluaciones, tiempo y costo. Todo se deriva de la propuesta materializada.
- **«Ver diseño»:** cada capítulo muestra sus piezas y lo que cada una aporta a las horas (desglose del modelo de tiempo por componente).
- **«Ajustar»**, controles mínimos útiles. Se guardan en el perfil pedagógico como claves opcionales; si faltan, aplica lo de siempre.
  - Carga horaria objetivo (`targetHours`).
  - Énfasis, que fija la proporción entre práctica y contenido y la profundidad: «Más aplicación» / «Equilibrado» (lo que dice el enfoque) / «Más profundidad». Se mapea a la política del distribuidor.
  - Actividades de Aplicación: «Donde el diseño las necesite» (por defecto) / «Solo en capítulos de práctica» / «Ninguna».

  Cada cambio recalcula diseño, horas y costo con un dry-run. No genera nada.
- **«Aplicar diseño»:** `POST /courses/:id/modules/apply-distribution` con `expectedCounter` y el `proposalSha256` que vio el usuario.
  - El servidor recalcula la propuesta y, si el sha no coincide, responde 409.
  - En una transacción crea los capítulos propuestos y fija `applicationMinutes`. No toca títulos ni capítulos existentes, salvo los minutos de aplicación.
  - Después corre el flujo de siempre: confirmar Blueprint (lock) → presupuesto → generar. El Blueprint confirmado es exactamente el diseño, y el Manifest se construye desde él.

## 7. Fuera de alcance

Assign, rúbricas nativas, grupos y tutores, dashboards, Investigación Formativa, contextualización por programa.

## 8. Loops

| Loop | Alcance |
|---|---|
| A1 | Modelo: DB, API, Blueprint, Manifest + validador, tiempo, FinOps, invalidación y cascada, editor (selector de minutos), dry-run (generable). |
| A2 | Generación: prompts adaptativos, validadores (cliente y servidor), ejecutor, artifact, proveedores falsos, regeneración. |
| A3 | Empaque: página HTML + PDF, solucionario oculto + PDF, validador `.mbz`, restauración en Moodle local (estudiante sin acceso). |
| A4 | Diseño: «Cursia recomienda», «Ver diseño», «Ajustar», «Aplicar diseño». |
| Final | Validación RCP, las 14 pruebas pedidas, gate y staging. |
