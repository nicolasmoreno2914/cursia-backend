# Fase 3 — Contexto académico (Context Package) · diseño

Estado: aprobado por el roadmap del 2026-10-05 («Contexto, coherencia y regeneración»). USD 0: extracción
determinista, sin proveedores; pruebas con fixtures, fakes y Moodle local. Solo staging.

## 1. Diagnóstico (Loop 3.1): qué existe y qué se reutiliza

| Pieza existente | Qué hace hoy | Uso en esta fase |
|---|---|---|
| `course_profiles` (append-only, `kind`, `version`, `sha256`, `expectedVersion`) | perfiles presentation / assessment / pedagogy | **Persistencia y versiones del contexto**: `kind = 'academic'`. Sin tabla nueva. |
| `CourseProfilesService.append/getCurrent` | valida, normaliza, idempotente por sha | mismo servicio; `validateProfile`/`normalizeProfile` ganan el kind `academic` |
| Perfil pedagógico (`learner`, `learningOutcomes`, `targetHours`, `assessmentMethods`) | entrada del motor pedagógico, del distribuidor y de las Actividades de Aplicación | el contexto **sugiere** estos campos (con procedencia); el docente los aplica al perfil → todo el motor existente los usa sin cambios |
| `course-setup/extract-from-pdf` | prefill de «Datos» con Anthropic (LLM, con costo) | no se usa (gasta). La extracción nueva es determinista |
| `pdf-parse` (dep), `jszip` (dep), `pdfkit` (dep) | Gamma PDF, `.mbz`, PDF de actividades | leer PDF con texto por página; leer DOCX (zip + `word/document.xml`); generar los fixtures PDF de prueba |
| Propuesta de estructura con IA (`48-dynamic-structure-proposal.js`, `dynAiApplyProposal`) | lleva la estructura viva a una propuesta, idempotente, solo sobre el esqueleto intacto | **misma vía de aplicación** para la propuesta desde el microcurrículo (sin IA) |
| Blueprint v2 (`course.applicationContext`, claves opcionales que no cambian el sha de los demás) | congela lo aprobado | congela `course.academicContext` (resultados + competencias con id) y `chapter.outcomeIds` |
| Brief pedagógico (`buildItemPedagogyBrief`, entregado con el claim) | indicaciones por generador | agrega el bloque «resultados que este recurso debe evidenciar» → contenido, actividades, Actividad de Aplicación y exámenes los reciben sin tocar el ejecutor |
| Huellas de invalidación (`fingerprints.ts`) | qué items cambian con cada edición | las huellas de los items que reciben resultados incluyen sus textos y vínculos |
| Coherence Engine Fase 7 (`coherence/`) | coherencia estructural y de contenido | se extiende en la Fase 4 (no aquí) |
| «Context Package» de la Fase 6/R2 (`46-dynamic-context-package.js`) | contexto **por corrida** (conceptos previos para generar) | **es otra cosa**: para no confundirlos, el nuevo se llama **Contexto académico** en código (`academic`) y en la UI («Contexto académico del curso») |

## 2. Modelo (`academicContextVersion: 1`)

Representación por secciones con tipos propios (no un JSON libre). Cada dato lleva su estado y su procedencia:

```ts
type FieldStatus = 'found' | 'inferred' | 'missing' | 'provided';
//  found     — está literalmente en un documento (sources ≥ 1, con extracto)
//  inferred  — derivado por una regla determinista declarada (basis obligatorio)
//  missing   — el documento no lo trae (value null, sources [])
//  provided  — lo escribió el docente en Cursia (sin fuente documental)
interface SourceRef { documentId: string; section: string | null; page: number | null; line: number | null; excerpt: string }
interface Field<T> { status: FieldStatus; value: T | null; sources: SourceRef[]; basis?: string }

interface AcademicContextV1 {
  academicContextVersion: 1;
  documents: { id: 'D1'…; name; mediaType; sha256; bytes; pages | null; characters; extractor: { id; version } }[];
  identity: { subjectName; program; educationLevel: Field<{ text; level: EducationLevel | null }>; generalObjective; description };
  learner:  { profile: Field<string>; priorKnowledge: Field<string[]> };
  outcomes: { id: 'RA1'…; text; level: Bloom | null; domain: 'know' | 'do'; status; sources; basis? }[];
  competencies: { id: 'CO1'…; text; status; sources }[];
  units: { id: 'U1'…; title; hours | null; outcomeIds; status; sources; basis?;
           contents: { id: 'U1.1'…; text; outcomeIds; status; sources }[] }[];
  hours: { total: Field<number>; weekly: Field<number>; weeks: Field<number>; credits: Field<number>;
           components: { id; label; kind: 'contact' | 'practice' | 'autonomous' | 'other'; hours; status; sources }[] };
  evaluation: { id: 'EV1'…; instrument; weightPct | null; outcomeIds; status; sources }[];
  bibliography: { id: 'B1'…; text; status; sources }[];
  methodology: Field<string>;
  constraints: Field<string[]>;
  additionalInfo: Field<string[]>;
}
```

- **Independiente del documento**: guarda metadatos (nombre, sha256, tamaño, páginas) y extractos ≤ 240
  caracteres, nunca el archivo. Se puede editar sin documento (estado `provided`).
- **Versionable**: cada guardado es una versión nueva en `course_profiles` (idempotente por sha canónico).
- **Validable**: claves exactas, ids únicos con formato fijo, enums cerrados, límites (≤ 5 documentos,
  ≤ 40 resultados, ≤ 30 competencias, ≤ 20 unidades, ≤ 40 contenidos por unidad, ≤ 80 referencias, textos ≤ 600,
  resultados ≤ 400, extractos ≤ 240, JSON ≤ 256 KB). Un valor inválido nunca se «arregla» en silencio.
- **Compatible con Blueprint/Manifest**: los ids (`RA1`, `CO1`, `U1.2`) son los que el Blueprint congela y los
  que la Fase 4 usa para el mapa resultado → evidencia.

## 3. Ingesta (Loop 3.3)

`POST /api/v1/courses/:courseId/academic-context/extract` (multipart, campo `files`, 1–5 archivos, ≤ 10 MB c/u;
PDF con texto, DOCX, TXT/MD). Responde `{ draft, issues, stats }` **sin guardar nada**. 0 proveedores.

1. Texto con localizadores: PDF por página (`pdf-parse`), DOCX por párrafo y fila de tabla (celdas unidas con
   « | »), TXT/MD por línea. PDF sin texto (escaneado) → issue `error DOCUMENT_WITHOUT_TEXT` (no hay OCR).
2. Limpieza: espacios colapsados, encabezados/pies repetidos en ≥ 50 % de las páginas descartados.
3. Secciones por léxico de encabezados (sin tildes ni mayúsculas; numeración «1.», «2.3», «I.» admitida;
   «Clave: valor» en la misma línea).
4. Analizadores por sección: listas (viñetas, numeración, códigos «RA1», «CE 2»), unidades («Unidad 1: … (12 h)»,
   numeración 1 / 1.1), horas (totales, componentes, semanales × semanas, créditos), evaluación (instrumento + %),
   bibliografía, textos.
5. Estados: lo leído literal → `found` con extracto; lo derivado → `inferred` con `basis` (p. ej. «total = suma
   de componentes», «verbo “aplicar” → saber hacer»); lo ausente → `missing`. Nada se inventa: si no hay unidades,
   no se crean títulos; si no hay total, no se convierte desde créditos.
6. Varios documentos: se fusionan en orden; un dato ya encontrado no se pisa; una discrepancia queda como
   advertencia `CONTRADICTION` con ambas fuentes.

## 4. Validación (Loop 3.4)

`validateAcademicContext(ctx) → { issues: { severity: 'error' | 'warning' | 'missing'; code; path; message }[]; canProceed }`

- **error** (bloquea pasar al diseño): `CONTEXT_EMPTY` (sin resultados, competencias ni contenidos),
  `UNKNOWN_OUTCOME_REF`, `DUPLICATE_ID`, `DOCUMENT_WITHOUT_TEXT` (si es el único documento).
- **warning**: `HOURS_SUM_MISMATCH` («El documento indica 64 horas, pero la suma de componentes reportada es
  48 horas»), `WEEKLY_HOURS_MISMATCH`, `UNIT_HOURS_MISMATCH`, `HOURS_OUT_OF_RANGE`, `EVALUATION_WEIGHTS_NOT_100`,
  `OUTCOME_WITHOUT_CONTENT`, `CONTENT_WITHOUT_OUTCOME` (solo si el documento vincula al menos un contenido),
  `DUPLICATE_OUTCOME`, `DUPLICATE_CONTENT`, `CONTRADICTION`, `TOO_MANY_OUTCOMES_FOR_PROFILE`.
- **missing**: cada campo clave ausente (asignatura, resultados, contenidos, horas, evaluación, bibliografía,
  perfil del estudiante, nivel, metodología, competencias).

## 5. Contexto → diseño (Loop 3.5)

```
Contexto académico ─┬─► sugerencias al perfil pedagógico (estudiante, nivel, resultados saber/saber hacer,
                    │   competencias, targetHours = horas totales, métodos de evaluación)  → motor pedagógico,
                    │   distribuidor, Actividades de Aplicación (sin cambios en esos motores)
                    ├─► propuesta de estructura determinista: unidades → módulos, contenidos → capítulos
                    │   (≤ 5 por módulo, agrupados en orden), descripción = contenidos cubiertos,
                    │   objetivo = resultado vinculado (si es un infinitivo), outcomeIds por capítulo
                    │   → se aplica con la vía existente (solo sobre el esqueleto intacto: nunca pisa trabajo)
                    └─► vínculos capítulo → resultados (course_chapters.outcome_ids) editables;
                        sugerencia léxica para estructuras existentes (inferred)
Blueprint v2: course.academicContext {version, sha256, subjectName, outcomes[{id,text,level,domain}],
              competencies[{id,text}]} y chapter.outcomeIds — claves SOLO con contexto (sha de siempre sin él)
Manifest v3: SIN cambios (R25) — los vínculos viajan en el Blueprint congelado que el Manifest referencia por sha;
             el claim ya carga y verifica ese Blueprint. Los Manifests de siempre conservan su forma y su sha.
Claim: bloque «RESULTADOS DE APRENDIZAJE QUE ESTE RECURSO DEBE EVIDENCIAR» dentro del brief, con indicaciones
       por generador (contenido: desarrollar; actividad y aplicación: producir evidencia observable;
       examen: al menos una pregunta por resultado, aplicada para saber hacer). ≤ 4000 caracteres en total.
       Por item: capítulo → sus vínculos (la práctica sin vínculos integra los de su módulo); examen y
       module_intro → unión del módulo; plan, intro y examen final → todos; proveedores (Gamma/Videogen) → nada.
Invalidación (R26): la huella incluye los resultados SOLO en los items que producen evidencia (experience,
       activity, video_interactions, application_activity, exam, final_exam). Cambiar un vínculo nunca
       regenera el content (ni su video, Gamma o audiolibro).
```

Lo que el docente ve: «Contexto académico» en el panel de diseño → subir documento → revisar (Encontrado /
Inferido / Falta, con extracto de la fuente) → advertencias → «Guardar contexto» → «Usar en el perfil» →
«Proponer estructura desde el microcurrículo» → `targetHours` → «Cursia recomienda / Ver diseño» con los
resultados por capítulo.

## 6. Datos y migración (solo staging)

`supabase-migration-academic-context.sql`: amplía `course_profiles_kind_check` con `'academic'` y agrega
`course_chapters.outcome_ids jsonb null` (CHECK: array de ≤ 8 ids `^(RA|CO)[0-9]{1,3}$`). Aditiva, idempotente,
con rollback documentado. Pasos 4h5c/4h5d de deploy-staging, después de la de Actividades de Aplicación;
excluida del plan de producción. Sin la columna, escribir vínculos responde 503 (guarda de esquema).

## 7. Fuera de alcance

OCR, document intelligence universal, LLM en la extracción, Assign, rúbricas nativas, dashboards, integraciones
BTO / Indoamérica, producción. El motor de horas no cambia (las horas por unidad son informativas).
