import { xmlEsc } from '../mbz-common';
import { GradeMethod } from '../../modules/course-profiles/course-profiles';

/**
 * Cursia V2.1 — R6: generadores XML de evaluación para el backup Moodle 4.5.
 *
 * Verdad de referencia: backups reales hechos por Moodle 4.5.14+ en R0
 * (`scratchpad/v21audit/r0/bk*`): `module.xml`, `grades.xml`,
 * `h5pactivity.xml`, `gradebook.xml` y `completion.xml`. Funciones PURAS:
 * el `ts` entra por parámetro, nada de reloj ni aleatoriedad.
 *
 * Todo ítem calificable tiene grademin 0 y grademax 100 (§K.1).
 */

const NULL = '$@NULL@$';

function assertInt(v: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts v is number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`ASSESSMENT_XML_INVALID: ${name} debe ser un entero en [${min}, ${max}] (recibido ${String(v)})`);
  }
}

function assertGrade(v: unknown, name: string): asserts v is number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
    throw new Error(`ASSESSMENT_XML_INVALID: ${name} debe estar en [0, 100] (recibido ${String(v)})`);
  }
}

/** Formato decimal de Moodle en backups (5 decimales). */
export function moodleDecimal(n: number): string {
  return n.toFixed(5);
}

// ── Grade methods (constantes reales de Moodle 4.5) ─────────────────────────

/** mod/quiz/lib.php: QUIZ_GRADEHIGHEST=1, QUIZ_GRADEAVERAGE=2, QUIZ_ATTEMPTFIRST=3, QUIZ_ATTEMPTLAST=4. */
export const QUIZ_GRADE_METHOD: Readonly<Record<GradeMethod, number>> = Object.freeze({
  highest: 1, average: 2, first: 3, last: 4,
});
/** mod/scorm/locallib.php (whatgrade, entre intentos): HIGHESTATTEMPT=0, AVERAGEATTEMPT=1, FIRSTATTEMPT=2, LASTATTEMPT=3. */
export const SCORM_WHATGRADE: Readonly<Record<GradeMethod, number>> = Object.freeze({
  highest: 0, average: 1, first: 2, last: 3,
});
/** mod/scorm/locallib.php (grademethod, entre SCOs): GRADESCOES=0, GRADEHIGHEST=1, GRADEAVERAGE=2, GRADESUM=3. */
export const SCORM_SCO_GRADEMETHOD: Readonly<Record<'scoes' | 'highest' | 'average' | 'sum', number>> = Object.freeze({
  scoes: 0, highest: 1, average: 2, sum: 3,
});
/** mod/h5pactivity/classes/local/manager.php: GRADEHIGHESTATTEMPT=1, GRADEAVERAGEATTEMPT=2, GRADELASTATTEMPT=3, GRADEFIRSTATTEMPT=4. */
export const H5PACTIVITY_GRADE_METHOD: Readonly<Record<GradeMethod, number>> = Object.freeze({
  highest: 1, average: 2, last: 3, first: 4,
});

function gradeMethodCode(table: Readonly<Record<string, number>>, m: unknown, name: string): number {
  if (typeof m !== 'string' || !(m in table)) {
    throw new Error(`ASSESSMENT_XML_INVALID: ${name} desconocido (${String(m)}); válidos: ${Object.keys(table).join(', ')}`);
  }
  return table[m];
}

// ── module.xml ──────────────────────────────────────────────────────────────

export type GradedModname = 'quiz' | 'scorm' | 'h5pactivity';
const GRADED_MODNAMES: readonly GradedModname[] = ['quiz', 'scorm', 'h5pactivity'];

export interface GradedModuleXmlInput {
  mid: number;
  modname: GradedModname;
  secnum: number;
  ts: number;
  bv: string;
  /** true → completion por nota aprobatoria (`completionpassgrade=1`); false → basta con recibir nota. */
  passGradeRequired: boolean;
  /** `<sectionid>`; por defecto = secnum (convención de `dynamic-mbz-builder.ts`). */
  sectionId?: number;
}

/**
 * `module.xml` de un ítem calificable: `completion=2` (automática),
 * `completiongradeitemnumber=0` (= "requiere nota"), `completionpassgrade=1`,
 * `completionview=0`, `showdescription=1` (el intro lleva el embed inline,
 * HD-V21-2). Forma idéntica a `activities/{scorm,h5pactivity}_N/module.xml` de R0.
 */
export function gradedModuleXml(p: GradedModuleXmlInput): string {
  assertInt(p.mid, 'mid', 1);
  assertInt(p.secnum, 'secnum', 0);
  if (!GRADED_MODNAMES.includes(p.modname)) {
    throw new Error(`ASSESSMENT_XML_INVALID: modname no calificable (${String(p.modname)})`);
  }
  assertInt(p.ts, 'ts', 0);
  if (typeof p.bv !== 'string' || !/^\d{10}$/.test(p.bv)) {
    throw new Error(`ASSESSMENT_XML_INVALID: bv debe ser un backup_version de 10 dígitos (recibido ${String(p.bv)})`);
  }
  if (typeof p.passGradeRequired !== 'boolean') {
    throw new Error('ASSESSMENT_XML_INVALID: passGradeRequired debe ser boolean');
  }
  const sectionId = p.sectionId ?? p.secnum;
  assertInt(sectionId, 'sectionId', 0);
  return `<?xml version="1.0" encoding="UTF-8"?>
<module id="${p.mid}" version="${p.bv}">
  <modulename>${p.modname}</modulename>
  <sectionid>${sectionId}</sectionid>
  <sectionnumber>${p.secnum}</sectionnumber>
  <idnumber></idnumber>
  <added>${p.ts}</added>
  <score>0</score>
  <indent>0</indent>
  <visible>1</visible>
  <visibleoncoursepage>1</visibleoncoursepage>
  <visibleold>1</visibleold>
  <groupmode>0</groupmode>
  <groupingid>0</groupingid>
  <completion>2</completion>
  <completiongradeitemnumber>0</completiongradeitemnumber>
  <completionpassgrade>${p.passGradeRequired ? 1 : 0}</completionpassgrade>
  <completionview>0</completionview>
  <completionexpected>0</completionexpected>
  <availability>${NULL}</availability>
  <showdescription>1</showdescription>
  <downloadcontent>1</downloadcontent>
  <lang>${NULL}</lang>
  <tags>
  </tags>
</module>`;
}

// ── grades.xml (actividad) ──────────────────────────────────────────────────

export interface GradeItemXmlInput {
  gradeItemId: number;
  itemName: string;
  itemModule: GradedModname;
  /** id de la instancia (activity id, `<activity id>`). */
  aid: number;
  ts: number;
  /** Siempre 100 (§K.1). */
  grademax: 100;
  gradepass: number;
  /** id de la categoría del `gradebook.xml` que contiene este ítem. */
  categoryId: number;
  /** Orden dentro del libro de calificaciones (Moodle corrige duplicados al restaurar). */
  sortorder?: number;
}

/**
 * `grades.xml` de una actividad calificable, con `categoryid`, `grademax=100`,
 * `grademin=0` y `gradepass` efectivo. Forma de `activities/scorm_4602/grades.xml`
 * de R0 (sin `grade_grades`: el paquete no lleva datos de usuarios).
 */
export function gradeItemXml(p: GradeItemXmlInput): string {
  assertInt(p.gradeItemId, 'gradeItemId', 1);
  assertInt(p.aid, 'aid', 1);
  assertInt(p.ts, 'ts', 0);
  assertInt(p.categoryId, 'categoryId', 1);
  if (!GRADED_MODNAMES.includes(p.itemModule)) {
    throw new Error(`ASSESSMENT_XML_INVALID: itemModule no calificable (${String(p.itemModule)})`);
  }
  if (p.grademax !== 100) throw new Error(`ASSESSMENT_XML_INVALID: grademax debe ser 100 (recibido ${String(p.grademax)})`);
  assertGrade(p.gradepass, 'gradepass');
  if (typeof p.itemName !== 'string' || !p.itemName.trim()) {
    throw new Error('ASSESSMENT_XML_INVALID: itemName vacío');
  }
  const sortorder = p.sortorder ?? 1;
  assertInt(sortorder, 'sortorder', 1);
  return `<?xml version="1.0" encoding="UTF-8"?>
<activity_gradebook>
  <grade_items>
    <grade_item id="${p.gradeItemId}">
      <categoryid>${p.categoryId}</categoryid>
      <itemname>${xmlEsc(p.itemName)}</itemname>
      <itemtype>mod</itemtype>
      <itemmodule>${p.itemModule}</itemmodule>
      <iteminstance>${p.aid}</iteminstance>
      <itemnumber>0</itemnumber>
      <iteminfo>${NULL}</iteminfo>
      <idnumber></idnumber>
      <calculation>${NULL}</calculation>
      <gradetype>1</gradetype>
      <grademax>${moodleDecimal(100)}</grademax>
      <grademin>${moodleDecimal(0)}</grademin>
      <scaleid>${NULL}</scaleid>
      <outcomeid>${NULL}</outcomeid>
      <gradepass>${moodleDecimal(p.gradepass)}</gradepass>
      <multfactor>1.00000</multfactor>
      <plusfactor>0.00000</plusfactor>
      <aggregationcoef>0.00000</aggregationcoef>
      <aggregationcoef2>0.00000</aggregationcoef2>
      <weightoverride>0</weightoverride>
      <sortorder>${sortorder}</sortorder>
      <display>0</display>
      <decimals>${NULL}</decimals>
      <hidden>0</hidden>
      <locked>0</locked>
      <locktime>0</locktime>
      <needsupdate>0</needsupdate>
      <timecreated>${p.ts}</timecreated>
      <timemodified>${p.ts}</timemodified>
      <grade_grades>
      </grade_grades>
    </grade_item>
  </grade_items>
  <grade_letters>
  </grade_letters>
</activity_gradebook>`;
}

// ── gradebook.xml ───────────────────────────────────────────────────────────

/** lib/grade/constants.php */
export const GRADE_AGGREGATE_MEAN = 0;
export const GRADE_AGGREGATE_WEIGHTED_MEAN = 10;

export interface GradebookCategoryInput {
  /** id de la grade_category (debe coincidir con `categoryId` de los `grades.xml`). */
  id: number;
  fullname: string;
  /** Peso en la media ponderada del curso (`aggregationcoef` del ítem de categoría). */
  weight: number;
  /** id del grade_item de tipo `category` de esta categoría. */
  gradeItemId: number;
}

export interface GradebookXmlInput {
  ts: number;
  categories: GradebookCategoryInput[];
  courseGradepass: number;
  aggregation: 'weighted_mean';
  /** id de la categoría raíz del curso (default 1). */
  courseCategoryId?: number;
  /** id del grade_item `course` (default 1). */
  courseItemId?: number;
}

function gradeCategoryXml(id: number, parent: number | null, path: string, fullname: string, aggregation: number, ts: number): string {
  return `    <grade_category id="${id}">
      <parent>${parent === null ? NULL : parent}</parent>
      <depth>${parent === null ? 1 : 2}</depth>
      <path>${path}</path>
      <fullname>${xmlEsc(fullname)}</fullname>
      <aggregation>${aggregation}</aggregation>
      <keephigh>0</keephigh>
      <droplow>0</droplow>
      <aggregateonlygraded>0</aggregateonlygraded>
      <aggregateoutcomes>0</aggregateoutcomes>
      <timecreated>${ts}</timecreated>
      <timemodified>${ts}</timemodified>
      <hidden>0</hidden>
    </grade_category>
`;
}

function gradebookItemXml(p: {
  id: number; itemtype: 'course' | 'category'; iteminstance: number; gradepass: number;
  aggregationcoef: number; sortorder: number; ts: number;
}): string {
  return `    <grade_item id="${p.id}">
      <categoryid>${NULL}</categoryid>
      <itemname>${NULL}</itemname>
      <itemtype>${p.itemtype}</itemtype>
      <itemmodule>${NULL}</itemmodule>
      <iteminstance>${p.iteminstance}</iteminstance>
      <itemnumber>${NULL}</itemnumber>
      <iteminfo>${NULL}</iteminfo>
      <idnumber>${NULL}</idnumber>
      <calculation>${NULL}</calculation>
      <gradetype>1</gradetype>
      <grademax>${moodleDecimal(100)}</grademax>
      <grademin>${moodleDecimal(0)}</grademin>
      <scaleid>${NULL}</scaleid>
      <outcomeid>${NULL}</outcomeid>
      <gradepass>${moodleDecimal(p.gradepass)}</gradepass>
      <multfactor>1.00000</multfactor>
      <plusfactor>0.00000</plusfactor>
      <aggregationcoef>${moodleDecimal(p.aggregationcoef)}</aggregationcoef>
      <aggregationcoef2>0.00000</aggregationcoef2>
      <weightoverride>0</weightoverride>
      <sortorder>${p.sortorder}</sortorder>
      <display>0</display>
      <decimals>${NULL}</decimals>
      <hidden>0</hidden>
      <locked>0</locked>
      <locktime>0</locktime>
      <needsupdate>1</needsupdate>
      <timecreated>${p.ts}</timecreated>
      <timemodified>${p.ts}</timemodified>
      <grade_grades>
      </grade_grades>
    </grade_item>
`;
}

/**
 * `gradebook.xml` completo (forma de `bk3/gradebook.xml` de R0):
 * - categoría del curso con media ponderada (`aggregation=10`);
 * - una categoría hija por entrada, con media simple (`aggregation=0`) de sus
 *   ítems (en media ponderada los ítems con `aggregationcoef=0` se ignorarían);
 * - `aggregateonlygraded=0`: una nota vacía cuenta como 0 (lo no hecho no
 *   "aprueba" el curso por omisión);
 * - ítem del curso con `gradepass` = nota aprobatoria del curso;
 * - un ítem de categoría por categoría hija, con `aggregationcoef` = peso.
 */
export function gradebookXml(p: GradebookXmlInput): string {
  assertInt(p.ts, 'ts', 0);
  if (p.aggregation !== 'weighted_mean') {
    throw new Error(`ASSESSMENT_XML_INVALID: aggregation debe ser 'weighted_mean' (recibido ${String(p.aggregation)})`);
  }
  assertGrade(p.courseGradepass, 'courseGradepass');
  const courseCategoryId = p.courseCategoryId ?? 1;
  const courseItemId = p.courseItemId ?? 1;
  assertInt(courseCategoryId, 'courseCategoryId', 1);
  assertInt(courseItemId, 'courseItemId', 1);
  if (!Array.isArray(p.categories) || p.categories.length === 0) {
    throw new Error('ASSESSMENT_XML_INVALID: categories vacío');
  }
  const catIds = new Set<number>([courseCategoryId]);
  const itemIds = new Set<number>([courseItemId]);
  const names = new Set<string>();
  let sum = 0;
  for (const c of p.categories) {
    assertInt(c.id, 'categories[].id', 1);
    assertInt(c.gradeItemId, 'categories[].gradeItemId', 1);
    assertInt(c.weight, 'categories[].weight', 0, 100);
    if (typeof c.fullname !== 'string' || !c.fullname.trim()) {
      throw new Error('ASSESSMENT_XML_INVALID: categories[].fullname vacío');
    }
    if (catIds.has(c.id)) throw new Error(`ASSESSMENT_XML_INVALID: id de categoría repetido (${c.id})`);
    if (itemIds.has(c.gradeItemId)) throw new Error(`ASSESSMENT_XML_INVALID: id de grade_item repetido (${c.gradeItemId})`);
    if (names.has(c.fullname)) throw new Error(`ASSESSMENT_XML_INVALID: nombre de categoría repetido (${c.fullname})`);
    catIds.add(c.id);
    itemIds.add(c.gradeItemId);
    names.add(c.fullname);
    sum += c.weight;
  }
  if (sum !== 100) throw new Error(`ASSESSMENT_WEIGHTS_SUM_NOT_100: los pesos suman ${sum}`);

  let cats = '';
  for (const c of p.categories) {
    cats += gradeCategoryXml(c.id, courseCategoryId, `/${courseCategoryId}/${c.id}/`, c.fullname, GRADE_AGGREGATE_MEAN, p.ts);
  }
  cats += gradeCategoryXml(courseCategoryId, null, `/${courseCategoryId}/`, '?', GRADE_AGGREGATE_WEIGHTED_MEAN, p.ts);

  let items = gradebookItemXml({
    id: courseItemId, itemtype: 'course', iteminstance: courseCategoryId,
    gradepass: p.courseGradepass, aggregationcoef: 0, sortorder: 1, ts: p.ts,
  });
  p.categories.forEach((c, i) => {
    items += gradebookItemXml({
      id: c.gradeItemId, itemtype: 'category', iteminstance: c.id,
      gradepass: 0, aggregationcoef: c.weight, sortorder: 2 + i, ts: p.ts,
    });
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<gradebook>
  <attributes>
  </attributes>
  <grade_categories>
${cats}  </grade_categories>
  <grade_items>
${items}  </grade_items>
  <grade_letters>
  </grade_letters>
  <grade_settings>
    <grade_setting id="">
      <name>minmaxtouse</name>
      <value>1</value>
    </grade_setting>
  </grade_settings>
</gradebook>`;
}

// ── completion.xml (curso) ──────────────────────────────────────────────────

/** lib/completionlib.php */
export const COMPLETION_CRITERIA_TYPE_ACTIVITY = 4;
export const COMPLETION_CRITERIA_TYPE_GRADE = 6;
export const COMPLETION_AGGREGATION_ALL = 1;

export interface CourseCompletionXmlInput {
  /** Criterios de actividad: `moduleId` = id del course_module (`<module id>` del module.xml). */
  criteria: Array<{ moduleId: number; modname: GradedModname }>;
  aggregation: 'all';
  requireCourseGradePass: boolean;
  courseGradepass: number;
  /** `<course>` del backup (Moodle lo reemplaza por el curso destino al restaurar). Default 1. */
  courseId?: number;
}

/**
 * `completion.xml` raíz (forma de `bk3/completion.xml` de R0): un criterio
 * `activity` (tipo 4) por módulo, más un criterio `grade` (tipo 6) con el
 * `gradepass` del curso si se exige, y el método de agregación global.
 * Sin criterios devuelve un `<course_completion>` vacío (el curso no tiene
 * completion configurada).
 */
export function courseCompletionXml(p: CourseCompletionXmlInput): string {
  if (p.aggregation !== 'all') throw new Error(`ASSESSMENT_XML_INVALID: aggregation debe ser 'all' (recibido ${String(p.aggregation)})`);
  if (typeof p.requireCourseGradePass !== 'boolean') throw new Error('ASSESSMENT_XML_INVALID: requireCourseGradePass debe ser boolean');
  assertGrade(p.courseGradepass, 'courseGradepass');
  const courseId = p.courseId ?? 1;
  assertInt(courseId, 'courseId', 1);
  if (!Array.isArray(p.criteria)) throw new Error('ASSESSMENT_XML_INVALID: criteria debe ser un array');
  const seen = new Set<number>();
  for (const c of p.criteria) {
    assertInt(c.moduleId, 'criteria[].moduleId', 1);
    if (!GRADED_MODNAMES.includes(c.modname)) throw new Error(`ASSESSMENT_XML_INVALID: criteria[].modname (${String(c.modname)})`);
    if (seen.has(c.moduleId)) throw new Error(`ASSESSMENT_XML_INVALID: criterio repetido para el módulo ${c.moduleId}`);
    seen.add(c.moduleId);
  }
  if (p.criteria.length === 0 && !p.requireCourseGradePass) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<course_completion>\n</course_completion>';
  }

  let id = 1;
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<course_completion>\n';
  const crit = (type: number, module: string | null, moduleinstance: number | null, gradepass: number | null): string =>
    `  <course_completion_criteria id="${id++}">
    <course>${courseId}</course>
    <criteriatype>${type}</criteriatype>
    <module>${module === null ? NULL : module}</module>
    <moduleinstance>${moduleinstance === null ? NULL : moduleinstance}</moduleinstance>
    <courseinstanceshortname>${NULL}</courseinstanceshortname>
    <enrolperiod>${NULL}</enrolperiod>
    <timeend>${NULL}</timeend>
    <gradepass>${gradepass === null ? NULL : moodleDecimal(gradepass)}</gradepass>
    <role>${NULL}</role>
    <roleshortname>${NULL}</roleshortname>
    <course_completion_crit_completions>
    </course_completion_crit_completions>
  </course_completion_criteria>
`;
  for (const c of p.criteria) out += crit(COMPLETION_CRITERIA_TYPE_ACTIVITY, c.modname, c.moduleId, null);
  if (p.requireCourseGradePass) out += crit(COMPLETION_CRITERIA_TYPE_GRADE, null, null, p.courseGradepass);
  out += `  <course_completion_aggr_methd id="1">
    <course>${courseId}</course>
    <criteriatype>${NULL}</criteriatype>
    <method>${COMPLETION_AGGREGATION_ALL}</method>
    <value>${NULL}</value>
  </course_completion_aggr_methd>
</course_completion>`;
  return out;
}

// ── Campos específicos por módulo ───────────────────────────────────────────

/**
 * Campos de evaluación de `quiz.xml` (§K.3). En el backup el campo de
 * intentos se llama `attempts_number` (mod/quiz/backup/moodle2). `sumgrades`
 * y `grade` = 100: los `maxmark` de las preguntas deben sumar 100.
 */
export function quizAttemptsXmlFields(p: { attempts: number; grademethod: GradeMethod }): Record<string, string> {
  assertInt(p.attempts, 'attempts', 0);
  return {
    preferredbehaviour: 'deferredfeedback',
    attempts_number: String(p.attempts),
    grademethod: String(gradeMethodCode(QUIZ_GRADE_METHOD, p.grademethod, 'grademethod')),
    sumgrades: moodleDecimal(100),
    grade: moodleDecimal(100),
  };
}

/**
 * Campos de evaluación de `scorm.xml`. `whatgrade` es el método entre
 * intentos (el del perfil); `grademethod` es entre SCOs. La nota aprobatoria
 * NO vive aquí (va en `gradepass` + `completionpassgrade`, §X.4): se anulan
 * `completionstatusrequired` y `completionscorerequired` para que la
 * completion dependa solo de la nota aprobatoria.
 */
export function scormAssessmentFields(p: {
  maxgrade: 100;
  grademethod: 'highest';
  whatgrade: GradeMethod;
  maxattempt: number;
  masteryoverride: 1;
}): Record<string, string> {
  if (p.maxgrade !== 100) throw new Error(`ASSESSMENT_XML_INVALID: maxgrade debe ser 100 (recibido ${String(p.maxgrade)})`);
  if (p.masteryoverride !== 1) throw new Error('ASSESSMENT_XML_INVALID: masteryoverride debe ser 1');
  assertInt(p.maxattempt, 'maxattempt', 0);
  return {
    maxgrade: '100',
    grademethod: String(gradeMethodCode(SCORM_SCO_GRADEMETHOD, p.grademethod, 'grademethod')),
    whatgrade: String(gradeMethodCode(SCORM_WHATGRADE, p.whatgrade, 'whatgrade')),
    maxattempt: String(p.maxattempt),
    masteryoverride: '1',
    completionstatusrequired: NULL,
    completionscorerequired: NULL,
  };
}

/**
 * Reemplaza el valor de cada `<campo>…</campo>` en un XML de actividad ya
 * generado (p.ej. la salida de `quizActivityXml`/`scormActivityXml` del
 * builder). Falla fuerte si un campo no aparece exactamente una vez.
 */
export function applyXmlFields(xml: string, fields: Record<string, string>): string {
  let out = xml;
  for (const [tag, value] of Object.entries(fields)) {
    if (!/^[a-z_]+$/.test(tag)) throw new Error(`ASSESSMENT_XML_INVALID: nombre de campo inválido (${tag})`);
    const re = new RegExp(`<${tag}>[^<]*</${tag}>`, 'g');
    const n = (out.match(re) || []).length;
    if (n !== 1) throw new Error(`ASSESSMENT_XML_FIELD_NOT_FOUND: <${tag}> aparece ${n} veces (se esperaba 1)`);
    out = out.replace(re, () => `<${tag}>${value}</${tag}>`);
  }
  return out;
}

// ── h5pactivity.xml ─────────────────────────────────────────────────────────

/** Opciones visibles del reproductor H5P (true = se muestra). */
export interface H5pDisplayOptions {
  frame: boolean;
  download: boolean;
  embed: boolean;
  copyright: boolean;
}

/**
 * Codifica como `\core_h5p\helper::get_display_options` (bitmask de lo
 * DESACTIVADO: FRAME=1, DOWNLOAD=2, EMBED=4, COPYRIGHT=8). Si download,
 * embed o copyright se muestran, el marco se fuerza visible.
 */
export function h5pDisplayOptionsInt(o: H5pDisplayOptions): number {
  for (const k of ['frame', 'download', 'embed', 'copyright'] as const) {
    if (typeof o?.[k] !== 'boolean') throw new Error(`ASSESSMENT_XML_INVALID: displayoptions.${k} debe ser boolean`);
  }
  const frame = o.frame || o.download || o.embed || o.copyright;
  return (frame ? 0 : 1) | (o.download ? 0 : 2) | (o.embed ? 0 : 4) | (o.copyright ? 0 : 8);
}

export interface H5pactivityXmlInput {
  aid: number;
  mid: number;
  ctx: number;
  name: string;
  /** HTML del intro (ya con `@@PLUGINFILE@@` si lleva el embed inline). */
  intro: string;
  grade: 100;
  grademethod: GradeMethod;
  enabletracking: 1;
  reviewmode: 1;
  displayoptions: H5pDisplayOptions;
  ts: number;
}

/** `h5pactivity.xml` (forma de `activities/h5pactivity_4575/h5pactivity.xml` de R0). */
export function h5pactivityXml(p: H5pactivityXmlInput): string {
  assertInt(p.aid, 'aid', 1);
  assertInt(p.mid, 'mid', 1);
  assertInt(p.ctx, 'ctx', 1);
  assertInt(p.ts, 'ts', 0);
  if (p.grade !== 100) throw new Error(`ASSESSMENT_XML_INVALID: grade debe ser 100 (recibido ${String(p.grade)})`);
  if (p.enabletracking !== 1) throw new Error('ASSESSMENT_XML_INVALID: enabletracking debe ser 1');
  if (p.reviewmode !== 1) throw new Error('ASSESSMENT_XML_INVALID: reviewmode debe ser 1');
  if (typeof p.name !== 'string' || !p.name.trim()) throw new Error('ASSESSMENT_XML_INVALID: name vacío');
  if (typeof p.intro !== 'string') throw new Error('ASSESSMENT_XML_INVALID: intro debe ser string');
  const gm = gradeMethodCode(H5PACTIVITY_GRADE_METHOD, p.grademethod, 'grademethod');
  const disp = h5pDisplayOptionsInt(p.displayoptions);
  return `<?xml version="1.0" encoding="UTF-8"?>
<activity id="${p.aid}" moduleid="${p.mid}" modulename="h5pactivity" contextid="${p.ctx}">
  <h5pactivity id="${p.aid}">
    <name>${xmlEsc(p.name)}</name>
    <timecreated>${p.ts}</timecreated>
    <timemodified>${p.ts}</timemodified>
    <intro>${xmlEsc(p.intro)}</intro>
    <introformat>1</introformat>
    <grade>100</grade>
    <displayoptions>${disp}</displayoptions>
    <enabletracking>1</enabletracking>
    <grademethod>${gm}</grademethod>
    <reviewmode>1</reviewmode>
    <attempts>
    </attempts>
  </h5pactivity>
</activity>`;
}

