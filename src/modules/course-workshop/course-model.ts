/**
 * r107 B2 · Taller de cursos — modelo único `WorkshopCourse` (diseño §4 «normalize» / «inventory»), independiente del
 * formato de origen. Funciones PURAS sobre un paquete ya abierto con el lector seguro (`mbz-reader.ts`): sin base, sin
 * red, sin escribir a disco, sin ejecutar nada del paquete (los JS del SCORM ni se leen).
 *
 *   readRawCourse(pkg)        → lo que el paquete DICE, tal cual: moodle_backup.xml, sections/*, activities/* (módulo +
 *                               XML del tipo), files.xml, questions.xml y las entradas «extra» que dejaron builders viejos
 *                               (libro_guia/*.md, gift_exams/*.gift, archivos_raw/*). Cada cosa guarda la ENTRADA exacta
 *                               de la que salió: el motor de parches de B4 edita los bytes del paquete original con esas
 *                               referencias, nunca un paquete regenerado.
 *   buildWorkshopCourse(raw)  → el adaptador de la familia (adapters/) asigna a cada actividad su ROL (dentro de un
 *                               capítulo) o su CLASE (fuera de capítulos), con la regla que lo decidió como evidencia; acá
 *                               se arman capítulos, módulos, exámenes, tokens resueltos y referencias inversas.
 *
 * Reglas duras:
 *   - nada se inventa: un capítulo existe solo si alguna actividad lo nombra (número explícito o clave del builder); un
 *     rol que no se puede decidir con certeza queda `unknown` CON el motivo;
 *   - HTML desescapado con `xmlUnescape` (inversa exacta de `xmlEsc`: & < > " — sin apóstrofes, más &#39;);
 *   - determinista: dos corridas sobre los mismos bytes dan el mismo JSON byte a byte (`stableStringify`); no hay
 *     fechas ni nada que dependa del reloj o del orden de un Map.
 */
import { createHash } from 'crypto';
import { MbzPackage } from './mbz-reader';
import { xmlUnescape } from '../visual-design/preview-extract';
import { WorkshopFamily } from './identify';

export const WORKSHOP_INVENTORY_SCHEMA = 1;

// ─── Tipos del modelo ───────────────────────────────────────────────────────

/** Rol de una actividad DENTRO de un capítulo. */
export type ChapterRole = 'presentation' | 'text' | 'video' | 'cta' | 'game' | 'activity' | 'audio' | 'unknown';
export const CHAPTER_ROLES: readonly ChapterRole[] = Object.freeze(['presentation', 'text', 'video', 'cta', 'game', 'activity', 'audio', 'unknown']) as readonly ChapterRole[];

/**
 * Clase de una actividad del curso FUERA de los capítulos (bienvenida, Libro Guía, audiolibro, exámenes, foro, guía
 * docente…). Abierta (string) porque el builder v3 tiene claves propias (`shell:*`); `unknown` = no se pudo decidir.
 */
export type CourseKind =
  | 'welcome' | 'welcome_audio' | 'competencies' | 'methodology' | 'course_start' | 'course_info' | 'route' | 'route_start'
  | 'libro' | 'libro_info' | 'libro_mobile' | 'audiobook' | 'module_intro' | 'module_next' | 'exam_info' | 'exam'
  | 'final_exam_info' | 'final_exam' | 'exam_answers' | 'exam_next' | 'closing' | 'certificate' | 'teacher_guide' | 'forum'
  | 'unknown' | (string & {});

export interface WorkshopHtmlField {
  /** `intro` | `content` | `chapter:<id>` (book) | `externalurl`… */
  field: string;
  /** Entrada exacta del paquete que contiene el campo. */
  entry: string;
  html: string;
  sha1: string;
  length: number;
  /** Archivos referenciados con `@@PLUGINFILE@@/<nombre>` (decodificados, en orden, sin repetir). */
  pluginfiles: string[];
}

export interface WorkshopFile {
  fileId: number;
  contenthash: string;
  /** `files/<hh>/<sha1>` — la entrada del blob (puede faltar: `blobPresent`). */
  blobEntry: string;
  blobPresent: boolean;
  component: string;
  filearea: string;
  itemid: number;
  filepath: string;
  filename: string;
  filesize: number;
  mimetype: string | null;
}

/**
 * ok: el destino existe y es del tipo que el token exige · orphan: no existe nada con ese id · wrong_type: existe pero
 * es de otro tipo · external: id de CURSO que no es el de este backup (enlace a otro curso del sitio original; Moodle no
 * lo mapea al restaurar) · malformed: empieza como token pero no cierra en `@$` (Moodle lo deja literal: enlace roto) ·
 * unchecked: tipo de token que el Taller no sabe verificar.
 */
export type TokenStatus = 'ok' | 'orphan' | 'wrong_type' | 'external' | 'malformed' | 'unchecked';
export interface WorkshopToken {
  /** Texto exacto del token (`$@SCORMVIEWBYID*1063@$`). */
  token: string;
  kind: string;
  /** Primer id del token (moduleid, instancia, sección, contexto o curso según el tipo); null si no trae. */
  targetId: number | null;
  /** moduleid de la actividad destino, si el token apunta a una que existe (también por id de instancia). */
  targetModuleId: number | null;
  /** modname que el token exige (`scorm` para SCORMVIEWBYID), `section` / `course` / `context`, o null si no se sabe. */
  expected: string | null;
  /** Lo que hay de verdad con ese id en el paquete (modname / `section` / `course`), o null si nada. */
  actual: string | null;
  status: TokenStatus;
  /** Campo y entrada donde aparece. */
  field: string;
  entry: string;
  count: number;
  /** `#module-N` / `#section-N` que sigue al token (enlaces «al curso» que apuntan a una actividad), resuelto aparte. */
  anchor: { type: 'module' | 'section'; id: number; actual: string | null; status: 'ok' | 'orphan' } | null;
}

export interface WorkshopQuestionAnswer {
  id: number | null;
  html: string;
  fraction: number | null;
}
export interface WorkshopQuestion {
  id: number;
  name: string;
  qtype: string;
  html: string;
  defaultmark: number | null;
  categoryId: number | null;
  category: string | null;
  /** Capítulo que declara la categoría del banco (`Capítulo N: …`), si lo declara. */
  chapterNumber: number | null;
  answers: WorkshopQuestionAnswer[];
  /** Emparejamiento: pares enunciado → respuesta. */
  matches: Array<{ html: string; answer: string }>;
}

export interface WorkshopExam {
  final: boolean;
  /** Unidad / módulo que evalúa (null en el final o si no se sabe). */
  unit: number | null;
  /** Ranuras del examen (question_instances del quiz.xml). */
  slots: number;
  /** Preguntas del banco del examen (questions.xml, por contexto del quiz o por referencia directa). */
  questions: WorkshopQuestion[];
  /** GIFT fuente DENTRO del paquete (builders viejos: gift_exams/*.gift, archivos_raw/*.gift), si hay. */
  giftEntry: string | null;
}

/** Referencia a la fuente que el generador guardó en la base (B2 §3): solo referencia + tipo, nunca el contenido. */
export interface WorkshopSourceRef {
  artifactId: string;
  type: string;
  scope: 'chapter' | 'module' | 'course';
  /** Cómo se enganchó: id de capítulo/módulo del builder (exacto), posición, clave del item, o snapshot del curso. */
  matchedBy: 'chapter_uuid' | 'chapter_position' | 'module_uuid' | 'module_position' | 'item_key' | 'course';
  itemKey: string | null;
  /** Para un snapshot del curso entero: la clave del archivo que corresponde (p. ej. `libro_cap3.md`). */
  entryHint: string | null;
  createdAt: string | null;
}

export interface ActivityPlacement {
  scope: 'chapter' | 'course';
  chapterNumber: number | null;
  /** Cómo se ubicó: número explícito, clave del builder, o posición (hereda el capítulo de la sección / vecino). */
  by: 'number' | 'builder_key' | 'section' | 'position' | 'none';
}

export interface WorkshopActivity {
  moduleId: number;
  modname: string;
  /** `activities/<modname>_<id>` (carpeta en el paquete). */
  dir: string;
  /** Índice en la lista <activities> de moodle_backup.xml (orden del manifiesto). */
  backupIndex: number;
  sectionId: number | null;
  sectionNumber: number | null;
  /** Posición dentro del <sequence> de su sección (null si no está en ninguna). */
  position: number | null;
  title: string;
  idnumber: string | null;
  visible: boolean | null;
  contextId: number | null;
  placement: ActivityPlacement;
  /** Rol en el capítulo (solo scope = chapter). */
  role: ChapterRole | null;
  /** Clase detallada: dentro del capítulo (opening, review_cards…) o fuera (welcome, libro, exam…). */
  kind: CourseKind;
  /** Regla que decidió rol/clase (para auditar), o el motivo de `unknown`. */
  evidence: string;
  unknownReason: string | null;
  /** Unidad / módulo al que se refiere (exámenes, presentación de módulo…), si se sabe. */
  unit: number | null;
  /** Placeholder «⚠️ Pendiente: <archivo>» de un builder viejo: el archivo que NO se generó. */
  pending: string | null;
  /** Clave del builder v3 (`cv3:ch:<uuid>:presentation`), si la tiene. */
  builderKey: { kind: string; uuid: string | null; key: string | null } | null;
  html: WorkshopHtmlField[];
  files: WorkshopFile[];
  tokens: WorkshopToken[];
  /** moduleids de las actividades cuyos tokens apuntan a esta (B4 `remove_activity`). */
  referencedBy: number[];
  exam: WorkshopExam | null;
  /** Fuente del generador en la base (null = no hay o el curso no se identificó). */
  source: WorkshopSourceRef[] | null;
  /** Entradas exactas del paquete de esta actividad (para el motor de parches). */
  entries: string[];
  /** La carpeta listada en moodle_backup.xml no existe en el paquete. */
  missingFolder: boolean;
}

export interface WorkshopSection {
  id: number;
  number: number | null;
  name: string;
  dir: string;
  entry: string | null;
  sequence: number[];
  visible: boolean | null;
  /** Qué es la sección según el adaptador. */
  kind: 'welcome' | 'route' | 'module' | 'chapter' | 'exam' | 'final' | 'closing' | 'other';
  moduleNumber: number | null;
  chapterNumber: number | null;
}

export interface WorkshopChapter {
  number: number;
  title: string | null;
  /** De dónde salió el título (regla). */
  titleEvidence: string | null;
  /** Módulo / unidad al que pertenece (null si el paquete no lo dice). */
  moduleNumber: number | null;
  /** Id del capítulo en el builder (v2/v3: uuid de la clave `cv3:ch:<uuid>:…`), si lo hay. */
  builderUuid: string | null;
  sectionNumbers: number[];
  /** moduleids en orden de aparición. */
  activities: number[];
  roles: Record<ChapterRole, number[]>;
  /** Roles que la familia espera en todo capítulo y que faltan (cada grupo: al menos uno de ellos). */
  missingRoles: string[];
  /** Entradas del paquete que son fuente de este capítulo (libro_guia/libro_capN.md, archivos_raw/capN_*). */
  packageSources: string[];
  source: WorkshopSourceRef[] | null;
}

export interface WorkshopModule {
  number: number;
  title: string | null;
  builderUuid: string | null;
  sectionNumbers: number[];
  chapterNumbers: number[];
  /** moduleids de los exámenes de la unidad. */
  examModuleIds: number[];
}

export interface WorkshopIssue {
  code: 'listed_missing_folder' | 'unlisted_folder' | 'moduleid_mismatch' | 'duplicate_moduleid' | 'not_in_sequence'
    | 'sequence_unknown_module' | 'section_missing' | 'xml_unreadable' | 'files_xml_missing' | 'questions_xml_unreadable';
  target: string;
  detail: string;
}

export interface WorkshopCourse {
  schema: number;
  family: WorkshopFamily;
  container: 'zip' | 'tar.gz';
  course: {
    title: string | null;
    shortname: string | null;
    originalCourseId: number | null;
    backupName: string | null;
    builder: { line: string; version: string | null };
    moodle: { release: string | null; backupRelease: string | null; minimum: string | null };
    originalWwwroot: string | null;
  };
  sections: WorkshopSection[];
  modules: WorkshopModule[];
  chapters: WorkshopChapter[];
  /** moduleids de las actividades fuera de capítulos, en orden. */
  courseActivities: number[];
  activities: WorkshopActivity[];
  exams: Array<{ moduleId: number; final: boolean; unit: number | null; slots: number; questions: number }>;
  libro: Array<{ moduleId: number; format: 'html' | 'pdf' | 'book' | 'other' | 'none'; filename: string | null }>;
  audiobook: number[];
  /** Entradas del paquete fuera del formato Moodle que dejaron builders viejos (fuente embebida). */
  packageExtras: string[];
  /** Archivos de files.xml que no son de ninguna actividad, contados por componente/área. */
  otherFiles: Record<string, number>;
  issues: WorkshopIssue[];
  stats: {
    activities: number;
    chapters: number;
    byRole: Record<ChapterRole, number>;
    unknownChapterRoles: number;
    unknownCourseKinds: number;
    tokens: Record<TokenStatus, number>;
  };
  /** Fuente recuperada de la base: estado de la búsqueda (para no confundir «no hay» con «no se buscó»). */
  sourceLookup: { status: 'not_identified' | 'found' | 'none' | 'error'; courseId: number | null; artifacts: number; detail: string | null };
}

// ─── Lectura cruda ──────────────────────────────────────────────────────────

const XML_MAX = 64 * 1024 * 1024;

export interface RawSection {
  id: number;
  number: number | null;
  name: string;
  title: string;
  dir: string;
  entry: string | null;
  sequence: number[];
  visible: boolean | null;
}

export interface RawActivity {
  moduleId: number;
  modname: string;
  dir: string;
  backupIndex: number;
  listedSectionId: number | null;
  title: string;
  /** Nombre del XML del tipo (`<name>`), si se leyó. */
  name: string | null;
  moduleXmlId: number | null;
  sectionId: number | null;
  sectionNumber: number | null;
  idnumber: string | null;
  visible: boolean | null;
  contextId: number | null;
  /** Id de instancia (`<activity id=…>` del XML del tipo). */
  instanceId: number | null;
  html: WorkshopHtmlField[];
  /** quiz.xml: cantidad de question_instances + ids referenciados directamente (questionid / questionbankentryid). */
  quizSlots: number;
  quizRefs: { questionIds: number[]; entryIds: number[] };
  missingFolder: boolean;
  entries: string[];
}

export interface RawQuestionCategory {
  id: number;
  name: string;
  contextId: number | null;
  contextInstanceId: number | null;
  questions: WorkshopQuestion[];
  /** question_bank_entry id → question ids (Moodle ≥ 4). */
  entries: Map<number, number[]>;
}

export interface RawCourse {
  container: 'zip' | 'tar.gz';
  family: WorkshopFamily;
  builderLine: string;
  builderVersion: string | null;
  title: string | null;
  shortname: string | null;
  backupName: string | null;
  originalCourseId: number | null;
  /** `<course id>` de course/course.xml (Moodle lo escribe igual que original_course_id; se aceptan los dos). */
  courseXmlId: number | null;
  originalCourseContextId: number | null;
  moodleRelease: string | null;
  backupRelease: string | null;
  originalWwwroot: string | null;
  sections: RawSection[];
  activities: RawActivity[];
  filesByContext: Map<number, WorkshopFile[]>;
  /** Todos los <file> de files.xml con su contextid. */
  allFiles: Array<{ contextId: number | null; file: WorkshopFile }>;
  categories: RawQuestionCategory[];
  extras: string[];
  issues: WorkshopIssue[];
}

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
};
const tagText = (xml: string, name: string): string | null => {
  const v = tag(xml, name);
  return v === null ? null : xmlUnescape(v);
};
const int = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!/^-?\d{1,15}$/.test(s)) return null;
  return Number(s);
};
const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).trim());
  return String(v).trim() !== '' && Number.isFinite(n) ? n : null;
};
export const sha1Hex = (s: string | Buffer): string => createHash('sha1').update(s).digest('hex');

/** Archivos `@@PLUGINFILE@@/x` de un HTML (decodificados, únicos, en orden). */
export function pluginfileRefs(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/@@PLUGINFILE@@\/([^"'\s)<>?#]+)/g)) {
    let n = m[1];
    try { n = decodeURIComponent(n); } catch { /* queda crudo */ }
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

function htmlField(field: string, entry: string, escaped: string | null): WorkshopHtmlField | null {
  if (escaped === null) return null;
  const html = xmlUnescape(escaped);
  return { field, entry, html, sha1: sha1Hex(html), length: html.length, pluginfiles: pluginfileRefs(html) };
}

/** Campos HTML de la actividad según su tipo (el primer <intro> / <content> del XML del tipo; capítulos del book). */
function htmlFieldsOf(modname: string, entry: string, xml: string): WorkshopHtmlField[] {
  const out: WorkshopHtmlField[] = [];
  const push = (f: WorkshopHtmlField | null) => { if (f) out.push(f); };
  push(htmlField('intro', entry, tag(xml, 'intro')));
  if (modname === 'page') push(htmlField('content', entry, tag(xml, 'content')));
  if (modname === 'book') {
    for (const c of (tag(xml, 'chapters') ?? '').matchAll(/<chapter id="(\d+)">([\s\S]*?)<\/chapter>/g)) push(htmlField(`chapter:${c[1]}`, entry, tag(c[2], 'content')));
  }
  if (modname === 'assign') push(htmlField('activity', entry, tag(xml, 'activity')));
  if (modname === 'url') push(htmlField('externalurl', entry, tag(xml, 'externalurl')));
  return out;
}

/** Entradas de nivel superior que son parte del formato Moodle (todo lo demás fuera de activities/sections/files es «extra»). */
const MOODLE_TOP = /^(moodle_backup\.(xml|log)|files\.xml|questions\.xml|users\.xml|roles\.xml|scales\.xml|outcomes\.xml|groups\.xml|gradebook\.xml|grade_history\.xml|completion\.xml|badges\.xml|competencies\.xml|calendar\.xml|\.ARCHIVE_INDEX|course\/.*)$/;

function parseFilesXml(xml: string, has: (n: string) => boolean): Array<{ contextId: number | null; file: WorkshopFile }> {
  const out: Array<{ contextId: number | null; file: WorkshopFile }> = [];
  for (const m of xml.matchAll(/<file id="(\d+)">([\s\S]*?)<\/file>/g)) {
    const b = m[2];
    const contenthash = (tag(b, 'contenthash') ?? '').trim();
    const blobEntry = /^[0-9a-f]{40}$/.test(contenthash) ? `files/${contenthash.slice(0, 2)}/${contenthash}` : '';
    const mime = tagText(b, 'mimetype');
    out.push({ contextId: int(tag(b, 'contextid')), file: {
      fileId: Number(m[1]),
      contenthash,
      blobEntry,
      blobPresent: !!blobEntry && has(blobEntry),
      component: tagText(b, 'component') ?? '',
      filearea: tagText(b, 'filearea') ?? '',
      itemid: int(tag(b, 'itemid')) ?? 0,
      filepath: tagText(b, 'filepath') ?? '/',
      filename: tagText(b, 'filename') ?? '',
      filesize: int(tag(b, 'filesize')) ?? 0,
      mimetype: mime && mime !== '$@NULL@$' ? mime : null,
    } });
  }
  return out;
}

function parseQuestion(id: number, b: string, cat: { id: number; name: string } | null): WorkshopQuestion {
  const answers: WorkshopQuestionAnswer[] = [];
  for (const a of b.matchAll(/<answer id="(\d+)">([\s\S]*?)<\/answer>/g)) {
    answers.push({ id: Number(a[1]), html: xmlUnescape(tag(a[2], 'answertext') ?? ''), fraction: num(tag(a[2], 'fraction')) });
  }
  const matches: Array<{ html: string; answer: string }> = [];
  for (const mm of b.matchAll(/<match id="\d+">([\s\S]*?)<\/match>/g)) {
    matches.push({ html: xmlUnescape(tag(mm[1], 'questiontext') ?? ''), answer: xmlUnescape(tag(mm[1], 'answertext') ?? '') });
  }
  const ch = cat ? /^Cap[ií]tulo\s+(\d{1,3})\b/i.exec(cat.name) : null;
  return {
    id,
    name: tagText(b, 'name') ?? '',
    qtype: (tag(b, 'qtype') ?? '').trim(),
    html: xmlUnescape(tag(b, 'questiontext') ?? ''),
    defaultmark: num(tag(b, 'defaultmark')),
    categoryId: cat ? cat.id : null,
    category: cat ? cat.name : null,
    chapterNumber: ch ? Number(ch[1]) : null,
    answers,
    matches,
  };
}

/** questions.xml (Moodle 3.x y 4.x): categorías con su contexto, preguntas y entradas del banco. */
export function parseQuestionsXml(xml: string): RawQuestionCategory[] {
  const out: RawQuestionCategory[] = [];
  for (const c of xml.matchAll(/<question_category id="(\d+)">([\s\S]*?)<\/question_category>/g)) {
    const body = c[2];
    const cat: RawQuestionCategory = {
      id: Number(c[1]),
      name: tagText(body, 'name') ?? '',
      contextId: int(tag(body, 'contextid')),
      contextInstanceId: int(tag(body, 'contextinstanceid')),
      questions: [],
      entries: new Map(),
    };
    for (const e of body.matchAll(/<question_bank_entry id="(\d+)">([\s\S]*?)<\/question_bank_entry>/g)) {
      const ids: number[] = [];
      for (const q of e[2].matchAll(/<question id="(\d+)">([\s\S]*?)<\/question>/g)) {
        ids.push(Number(q[1]));
        cat.questions.push(parseQuestion(Number(q[1]), q[2], cat));
      }
      cat.entries.set(Number(e[1]), ids);
    }
    if (!cat.entries.size) {
      // Moodle 3.x: <questions><question id> directo en la categoría.
      for (const q of body.matchAll(/<question id="(\d+)">([\s\S]*?)<\/question>/g)) cat.questions.push(parseQuestion(Number(q[1]), q[2], cat));
    }
    out.push(cat);
  }
  return out;
}

/** Lee del paquete todo lo que el inventario necesita. No falla por piezas faltantes: las registra como `issues`. */
export async function readRawCourse(
  pkg: MbzPackage,
  meta: { family: WorkshopFamily; builderLine: string; builderVersion?: string | null },
): Promise<RawCourse> {
  const issues: WorkshopIssue[] = [];
  const mb = (await pkg.readText('moodle_backup.xml', { maxBytes: XML_MAX })) ?? '';
  const contents = /<contents>([\s\S]*?)<\/contents>/.exec(mb)?.[1] ?? '';
  const actBlock = /<activities>([\s\S]*?)<\/activities>/.exec(contents)?.[1] ?? '';
  const secBlock = /<sections>([\s\S]*?)<\/sections>/.exec(contents)?.[1] ?? '';
  const listedActs = [...actBlock.matchAll(/<activity>([\s\S]*?)<\/activity>/g)].map((m, i) => ({
    i,
    moduleId: int(tag(m[1], 'moduleid')),
    sectionId: int(tag(m[1], 'sectionid')),
    modname: (tag(m[1], 'modulename') ?? '').trim(),
    title: tagText(m[1], 'title') ?? '',
    dir: (tag(m[1], 'directory') ?? '').trim(),
  }));
  const listedSecs = [...secBlock.matchAll(/<section>([\s\S]*?)<\/section>/g)].map((m) => ({
    id: int(tag(m[1], 'sectionid')),
    title: tagText(m[1], 'title') ?? '',
    dir: (tag(m[1], 'directory') ?? '').trim(),
  }));

  // Una sola pasada por todos los XML que hacen falta (clave en tar.gz).
  const want = new Set<string>(['files.xml', 'questions.xml', 'course/course.xml']);
  for (const s of listedSecs) if (s.dir) want.add(`${s.dir}/section.xml`);
  for (const a of listedActs) {
    if (!a.dir || !a.modname) continue;
    want.add(`${a.dir}/module.xml`);
    want.add(`${a.dir}/${a.modname}.xml`);
  }
  const names = [...want].filter((n) => pkg.has(n)).sort();
  const texts = new Map<string, string>();
  const bufs = await pkg.readEntries(names, { maxBytes: XML_MAX });
  for (const n of names) {
    const b = bufs.get(n);
    if (b) texts.set(n, b.toString('utf8'));
  }

  // Secciones.
  const sections: RawSection[] = [];
  for (const s of listedSecs) {
    const entry = s.dir ? `${s.dir}/section.xml` : null;
    const x = entry ? texts.get(entry) : undefined;
    if (!x) issues.push({ code: 'section_missing', target: s.dir || `section ${s.id}`, detail: 'sección listada en moodle_backup.xml sin section.xml' });
    const seq = (x ? tag(x, 'sequence') ?? '' : '').split(',').map((v) => int(v)).filter((v): v is number => v !== null);
    sections.push({
      id: int(x ? /<section id="(\d+)"/.exec(x)?.[1] : null) ?? s.id ?? -1,
      number: x ? int(tag(x, 'number')) : null,
      name: x ? tagText(x, 'name') ?? '' : '',
      title: s.title,
      dir: s.dir,
      entry: x ? entry : null,
      sequence: seq,
      visible: x ? (tag(x, 'visible') ?? '').trim() !== '0' : null,
    });
  }

  // Actividades.
  const entryNames = pkg.entries.map((e) => e.name);
  const byDir = new Map<string, string[]>();
  for (const n of entryNames) {
    const m = /^activities\/([^/]+)\//.exec(n);
    if (m) {
      const d = `activities/${m[1]}`;
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d)!.push(n);
    }
  }
  const activities: RawActivity[] = [];
  const seenMid = new Map<number, string>();
  const listedDirs = new Set<string>();
  for (const a of listedActs) {
    if (a.moduleId === null || !a.dir || !a.modname) {
      issues.push({ code: 'xml_unreadable', target: a.dir || `activity #${a.i}`, detail: 'actividad de moodle_backup.xml sin moduleid / carpeta / tipo' });
      continue;
    }
    listedDirs.add(a.dir);
    if (seenMid.has(a.moduleId)) issues.push({ code: 'duplicate_moduleid', target: a.dir, detail: `moduleid ${a.moduleId} ya usado por ${seenMid.get(a.moduleId)}` });
    else seenMid.set(a.moduleId, a.dir);
    const modX = texts.get(`${a.dir}/module.xml`) ?? null;
    const typX = texts.get(`${a.dir}/${a.modname}.xml`) ?? null;
    const entries = (byDir.get(a.dir) ?? []).slice().sort();
    const missingFolder = entries.length === 0;
    if (missingFolder) issues.push({ code: 'listed_missing_folder', target: a.dir, detail: 'listada en moodle_backup.xml, la carpeta no está en el paquete' });
    else if (!modX || !typX) issues.push({ code: 'xml_unreadable', target: a.dir, detail: `falta ${!modX ? 'module.xml' : `${a.modname}.xml`}` });
    const moduleXmlId = modX ? int(/<module id="(\d+)"/.exec(modX)?.[1]) : null;
    if (moduleXmlId !== null && moduleXmlId !== a.moduleId) issues.push({ code: 'moduleid_mismatch', target: a.dir, detail: `module.xml dice ${moduleXmlId}, moodle_backup.xml dice ${a.moduleId}` });
    const typeEntry = `${a.dir}/${a.modname}.xml`;
    let quizSlots = 0;
    const quizRefs = { questionIds: [] as number[], entryIds: [] as number[] };
    if (typX && a.modname === 'quiz') {
      const qi = tag(typX, 'question_instances') ?? '';
      quizSlots = (qi.match(/<question_instance id=/g) || []).length;
      for (const m of qi.matchAll(/<questionid>(\d+)<\/questionid>/g)) quizRefs.questionIds.push(Number(m[1]));
      for (const m of qi.matchAll(/<questionbankentryid>(\d+)<\/questionbankentryid>/g)) quizRefs.entryIds.push(Number(m[1]));
    }
    activities.push({
      moduleId: a.moduleId,
      modname: a.modname,
      dir: a.dir,
      backupIndex: a.i,
      listedSectionId: a.sectionId,
      title: a.title,
      name: typX ? tagText(typX, 'name') : null,
      moduleXmlId,
      sectionId: modX ? int(tag(modX, 'sectionid')) : a.sectionId,
      sectionNumber: modX ? int(tag(modX, 'sectionnumber')) : null,
      idnumber: modX ? (tagText(modX, 'idnumber') ?? '').trim() || null : null,
      visible: modX ? (tag(modX, 'visible') ?? '').trim() !== '0' : null,
      contextId: typX ? int(/<activity [^>]*contextid="(\d+)"/.exec(typX)?.[1]) : null,
      instanceId: typX ? int(/<activity id="(\d+)"/.exec(typX)?.[1]) : null,
      html: typX ? htmlFieldsOf(a.modname, typeEntry, typX) : [],
      quizSlots,
      quizRefs,
      missingFolder,
      entries,
    });
  }
  for (const d of [...byDir.keys()].sort()) {
    if (!listedDirs.has(d)) issues.push({ code: 'unlisted_folder', target: d, detail: 'carpeta en el paquete que moodle_backup.xml no lista (Moodle no la restaura)' });
  }

  // Archivos.
  const filesXml = texts.get('files.xml') ?? null;
  if (filesXml === null) issues.push({ code: 'files_xml_missing', target: 'files.xml', detail: 'el paquete no trae files.xml' });
  const allFiles = filesXml ? parseFilesXml(filesXml, (n) => pkg.has(n)) : [];
  const filesByContext = new Map<number, WorkshopFile[]>();
  for (const { contextId, file } of allFiles) {
    if (contextId === null) continue;
    if (!filesByContext.has(contextId)) filesByContext.set(contextId, []);
    filesByContext.get(contextId)!.push(file);
  }

  // Preguntas (solo si hay exámenes: questions.xml puede pesar MB).
  let categories: RawQuestionCategory[] = [];
  if (activities.some((a) => a.modname === 'quiz')) {
    const qx = texts.get('questions.xml');
    if (qx) categories = parseQuestionsXml(qx);
    else if (pkg.has('questions.xml')) issues.push({ code: 'questions_xml_unreadable', target: 'questions.xml', detail: 'no se pudo leer questions.xml' });
  }

  const extras = entryNames.filter((n) => !/^(activities|sections|files)\//.test(n) && !MOODLE_TOP.test(n)).sort();

  return {
    container: pkg.container,
    family: meta.family,
    builderLine: meta.builderLine,
    builderVersion: meta.builderVersion ?? null,
    title: tagText(mb, 'original_course_fullname'),
    shortname: tagText(mb, 'original_course_shortname'),
    backupName: tagText(mb, 'name'),
    originalCourseId: int(tag(mb, 'original_course_id')),
    courseXmlId: int(/<course id="(\d+)"/.exec(texts.get('course/course.xml') ?? '')?.[1]),
    originalCourseContextId: int(tag(mb, 'original_course_contextid')),
    moodleRelease: tagText(mb, 'moodle_release'),
    backupRelease: tagText(mb, 'backup_release'),
    originalWwwroot: tagText(mb, 'original_wwwroot'),
    sections,
    activities,
    filesByContext,
    allFiles,
    categories,
    extras,
    issues,
  };
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

/**
 * r107 B2 fix round 1 — ESPACIO DE IDS de cada token `$@KIND*id[*id2]@$` (auditado contra los builders y contra lo que
 * escribe Moodle al exportar: `encode_content_links` de cada módulo, y el censo completo de 259 paquetes):
 *   <MOD>VIEWBYID*cmid             moduleid (cm) de una actividad de tipo <mod> (SCORM, QUIZ, RESOURCE, PAGE, URL, H5PACTIVITY,
 *                                  HVP, LABEL, FORUM, BOOK, ASSIGN, FOLDER, …)
 *   HVPEMBEDBYID*cmid              moduleid del hvp (16-mbz-patch.js `makeH5PEmbed`: `$@HVPEMBEDBYID*<hvpMid>@$` en el iframe)
 *   BOOKVIEWBYIDCH*cmid*chapterid  moduleid del book + id de un capítulo de ESE libro
 *   <MOD>VIEWBY<L>*instanceid      id de INSTANCIA (`<activity id=…>` del XML del tipo): FORUMVIEWBYF, QUIZVIEWBYQ,
 *                                  RESOURCEVIEWBYR, PAGEVIEWBYP, URLVIEWBYU, BOOKVIEWBYB, SCORMVIEWBYS, HVPVIEWBYH…
 *   <MOD>INDEX*courseid            id del CURSO (índice de actividades del tipo)
 *   COURSEVIEWBYID / BADGESVIEWBYID / GRADEINDEXBYID / …BYCOURSE*courseid   id del CURSO (original_course_id de
 *                                  moodle_backup.xml = `<course id>` de course/course.xml). Otro id = un curso que NO es
 *                                  este (texto pegado desde otro curso del sitio): Moodle no lo puede mapear al restaurar →
 *                                  `external` (no es un moduleid huérfano). El `#module-N` / `#section-N` que lo sigue se
 *                                  resuelve aparte (`anchor`).
 *   COURSESECTIONBYID*sectionid    sección del paquete
 *   PLUGINFILEBYCONTEXT*contextid  contexto de una actividad del paquete o el del curso (original_course_contextid)
 *   WWWROOT, USER…, otros          sin id que verificar → `unchecked`
 */
export const TOKEN_MODNAME: Readonly<Record<string, string>> = Object.freeze({
  SCORM: 'scorm', QUIZ: 'quiz', RESOURCE: 'resource', PAGE: 'page', URL: 'url', H5PACTIVITY: 'h5pactivity', HVP: 'hvp',
  LABEL: 'label', FORUM: 'forum', BOOK: 'book', ASSIGN: 'assign', FOLDER: 'folder', CHOICE: 'choice', FEEDBACK: 'feedback',
  GLOSSARY: 'glossary', LESSON: 'lesson', WIKI: 'wiki', WORKSHOP: 'workshop', DATA: 'data', CHAT: 'chat', IMSCP: 'imscp',
  LTI: 'lti', SURVEY: 'survey', BIGBLUEBUTTONBN: 'bigbluebuttonbn',
});
const COURSE_TOKENS = new Set(['COURSEVIEWBYID', 'BADGESVIEWBYID', 'GRADEINDEXBYID', 'GRADEREPORTBYID', 'COURSECOMPLETIONBYID', 'COURSEPARTICIPANTSBYID']);

export interface TokenContext {
  modnameByMid: Map<number, string>;
  sectionIds: Set<number>;
  sectionNumbers: Set<number>;
  /** Ids del curso del backup: original_course_id y `<course id>` de course/course.xml. */
  courseIds: Set<number>;
  contextIds: Set<number>;
  /** `<modname>:<instanceid>` → moduleid. */
  instances: Map<string, number>;
  /** moduleid del book → ids de sus capítulos. */
  bookChapters: Map<number, Set<number>>;
}

export function extractTokens(html: string, where: { field: string; entry: string }, ctx: TokenContext): WorkshopToken[] {
  const byText = new Map<string, WorkshopToken>();
  for (const m of html.matchAll(/\$@([A-Z0-9_]+)(?:\*(\d+))?(?:\*(\d+))?@\$/g)) {
    const kind = m[1];
    if (kind === 'NULL') continue; // `$@NULL@$` es el nulo de Moodle, no un enlace
    const after = html.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40);
    const am = /^#(module|section)-(\d+)/.exec(after);
    const key = am ? `${m[0]}${am[0]}` : m[0];
    const prev = byText.get(key);
    if (prev) { prev.count++; continue; }
    const id = m[2] !== undefined ? Number(m[2]) : null;
    const id2 = m[3] !== undefined ? Number(m[3]) : null;
    let expected: string | null = null;
    let actual: string | null = null;
    let status: TokenStatus = 'unchecked';
    let base: string | null;
    let letter: RegExpExecArray | null;
    if (kind === 'COURSESECTIONBYID') {
      expected = 'section';
      actual = id !== null && (ctx.sectionIds.has(id) || ctx.sectionNumbers.has(id)) ? 'section' : null;
      status = actual ? 'ok' : 'orphan';
    } else if (/^PLUGINFILEBYCONTEXT/.test(kind)) {
      expected = 'context';
      actual = id !== null && ctx.contextIds.has(id) ? 'context' : null;
      status = actual ? 'ok' : 'orphan';
    } else if (COURSE_TOKENS.has(kind) || /INDEX$/.test(kind) || /BYCOURSE$/.test(kind)) {
      expected = 'course';
      actual = id !== null && ctx.courseIds.has(id) ? 'course' : null;
      status = !ctx.courseIds.size || id === null ? 'unchecked' : actual ? 'ok' : 'external';
    } else if (kind === 'BOOKVIEWBYIDCH') {
      expected = 'book';
      actual = id !== null ? ctx.modnameByMid.get(id) ?? null : null;
      status = actual === null ? 'orphan' : actual !== 'book' ? 'wrong_type' : id2 !== null && ctx.bookChapters.get(id as number)?.has(id2) ? 'ok' : 'orphan';
    } else if ((base = /^(.+?)(?:VIEWBYID|EMBEDBYID)$/.exec(kind)?.[1] ?? null) !== null) {
      expected = TOKEN_MODNAME[base] ?? null;
      if (expected && id !== null) {
        actual = ctx.modnameByMid.get(id) ?? null;
        status = actual === null ? 'orphan' : actual === expected ? 'ok' : 'wrong_type';
      }
    } else if ((letter = /^(.+?)VIEWBY([A-Z])$/.exec(kind)) && TOKEN_MODNAME[letter[1]]) {
      // Por id de INSTANCIA (FORUMVIEWBYF, QUIZVIEWBYQ…): existe una actividad de ese tipo con esa instancia.
      expected = TOKEN_MODNAME[letter[1]];
      actual = id !== null && ctx.instances.has(`${expected}:${id}`) ? expected : null;
      status = id === null ? 'unchecked' : actual ? 'ok' : 'orphan';
    }
    let targetModuleId: number | null = null;
    if (actual !== null && expected !== 'course' && expected !== 'section' && expected !== 'context') {
      targetModuleId = letter && TOKEN_MODNAME[letter[1]] === expected && !/(?:VIEWBYID|EMBEDBYID)$/.test(kind) ? ctx.instances.get(`${expected}:${id}`) ?? null : id;
    }
    let anchor: WorkshopToken['anchor'] = null;
    if (am) {
      const aid = Number(am[2]);
      const ok = am[1] === 'module' ? ctx.modnameByMid.has(aid) : ctx.sectionIds.has(aid) || ctx.sectionNumbers.has(aid);
      anchor = { type: am[1] as 'module' | 'section', id: aid, actual: am[1] === 'module' ? ctx.modnameByMid.get(aid) ?? null : ok ? 'section' : null, status: ok ? 'ok' : 'orphan' };
    }
    byText.set(key, { token: m[0], kind, targetId: id, targetModuleId, expected, actual, status, field: where.field, entry: where.entry, count: 1, anchor });
  }
  // Tokens rotos: `$@KIND*id@` sin el `$` final (p. ej. un String.replace que expandió `$&`): Moodle los deja literales.
  for (const m of html.matchAll(/\$@([A-Z0-9_]+)(?:\*(\d+))?(?:\*(\d+))?@(?!\$)/g)) {
    const text = html.slice(m.index ?? 0, (m.index ?? 0) + m[0].length + 12);
    const prev = byText.get(text);
    if (prev) { prev.count++; continue; }
    byText.set(text, { token: text, kind: m[1], targetId: m[2] !== undefined ? Number(m[2]) : null, expected: null, actual: null, targetModuleId: null, status: 'malformed', field: where.field, entry: where.entry, count: 1, anchor: null });
  }
  return [...byText.values()];
}

// ─── Clasificación (contrato con los adaptadores) ───────────────────────────

/** Lo que el adaptador ve de una actividad para clasificarla. */
export interface ClassifyInput {
  a: RawActivity;
  section: RawSection | null;
  sectionInfo: SectionInfo | null;
  /** Texto plano del HTML principal (sin etiquetas, espacios colapsados), primeros 600 caracteres. */
  plain: string;
}

export interface Classified {
  scope: 'chapter' | 'course';
  /** Número explícito del capítulo (null → se ubica por la sección o el vecino anterior). */
  chapter?: number | null;
  role?: ChapterRole;
  kind: CourseKind;
  unit?: number | null;
  /** Título del capítulo que deja ver esta actividad, con su prioridad (mayor gana). */
  chapterTitle?: { text: string; priority: number } | null;
  /** Clave del builder: uuid del capítulo (v2/v3). */
  chapterUuid?: string | null;
  moduleUuid?: string | null;
  /** Título del módulo que deja ver esta actividad (p. ej. «Evaluación del módulo N: <título>»). */
  moduleTitle?: string | null;
  pending?: string | null;
  evidence: string;
  unknownReason?: string | null;
  placementBy?: ActivityPlacement['by'];
}

export interface SectionInfo {
  kind: WorkshopSection['kind'];
  module: number | null;
  chapter: number | null;
  chapterTitle: string | null;
  moduleTitle: string | null;
}

export interface FamilyAdapter {
  family: WorkshopFamily;
  /** Grupos de roles que todo capítulo de la familia debe tener (cada grupo: al menos uno). */
  expectedChapterRoles: ChapterRole[][];
  section(s: RawSection): SectionInfo;
  classify(i: ClassifyInput): Classified;
}

/** Texto plano de un HTML (para reglas por contenido): sin comentarios, estilos, scripts ni etiquetas. */
export function plainText(html: string, max = 600): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// ─── Construcción del modelo ────────────────────────────────────────────────

const emptyRoles = (): Record<ChapterRole, number[]> => ({ presentation: [], text: [], video: [], cta: [], game: [], activity: [], audio: [], unknown: [] });

function libroFormat(files: WorkshopFile[]): { format: 'html' | 'pdf' | 'other' | 'none'; filename: string | null } {
  const main = files.filter((f) => f.filearea === 'content' && f.filename && f.filename !== '.');
  const f = main.find((x) => /\.html?$/i.test(x.filename)) ?? main.find((x) => /\.pdf$/i.test(x.filename)) ?? main[0];
  if (!f) return { format: 'none', filename: null };
  return { format: /\.html?$/i.test(f.filename) ? 'html' : /\.pdf$/i.test(f.filename) ? 'pdf' : 'other', filename: f.filename };
}

export function buildWorkshopCourse(raw: RawCourse, adapter: FamilyAdapter): WorkshopCourse {
  const issues = raw.issues.slice();
  // Orden: secciones por número (y por orden del manifiesto), actividades por su <sequence>; luego las que no están en
  // ninguna secuencia, en el orden de moodle_backup.xml.
  const secs = raw.sections
    .map((s, i) => ({ s, i }))
    .sort((x, y) => ((x.s.number ?? 1e9) - (y.s.number ?? 1e9)) || (x.i - y.i))
    .map((x) => x.s);
  const sectionInfo = new Map<RawSection, SectionInfo>();
  for (const s of secs) sectionInfo.set(s, adapter.section(s));
  const byMid = new Map<number, RawActivity>();
  for (const a of raw.activities) if (!byMid.has(a.moduleId)) byMid.set(a.moduleId, a);
  const ordered: Array<{ a: RawActivity; s: RawSection | null; pos: number | null }> = [];
  const placed = new Set<RawActivity>();
  for (const s of secs) {
    s.sequence.forEach((mid, pos) => {
      const a = byMid.get(mid);
      if (!a) { issues.push({ code: 'sequence_unknown_module', target: s.dir || `section ${s.id}`, detail: `la secuencia nombra el moduleid ${mid}, que no está en moodle_backup.xml` }); return; }
      if (placed.has(a)) return;
      placed.add(a);
      ordered.push({ a, s, pos });
    });
  }
  for (const a of raw.activities) {
    if (placed.has(a)) continue;
    placed.add(a);
    const s = secs.find((x) => x.id === (a.sectionId ?? a.listedSectionId)) ?? null;
    if (!a.missingFolder) issues.push({ code: 'not_in_sequence', target: a.dir, detail: 'la actividad no figura en el <sequence> de ninguna sección' });
    ordered.push({ a, s, pos: null });
  }

  const modnameByMid = new Map<number, string>();
  for (const a of raw.activities) if (!modnameByMid.has(a.moduleId)) modnameByMid.set(a.moduleId, a.modname);
  const bookChapters = new Map<number, Set<number>>();
  for (const a of raw.activities) {
    if (a.modname !== 'book') continue;
    bookChapters.set(a.moduleId, new Set(a.html.map((h) => /^chapter:(\d+)$/.exec(h.field)?.[1]).filter((v): v is string => !!v).map(Number)));
  }
  const tokenCtx: TokenContext = {
    modnameByMid,
    sectionIds: new Set(raw.sections.map((s) => s.id)),
    sectionNumbers: new Set(raw.sections.map((s) => s.number).filter((n): n is number => n !== null)),
    courseIds: new Set([raw.originalCourseId, raw.courseXmlId].filter((v): v is number => v !== null)),
    contextIds: new Set([...raw.activities.map((a) => a.contextId), raw.originalCourseContextId].filter((v): v is number => v !== null)),
    instances: new Map(raw.activities.filter((a) => a.instanceId !== null).map((a) => [`${a.modname}:${a.instanceId}`, a.moduleId] as [string, number])),
    bookChapters,
  };

  // Clasificación + ubicación en capítulos.
  const activities: WorkshopActivity[] = [];
  const titleHints = new Map<number, { text: string; priority: number; evidence: string }>();
  const chapterUuid = new Map<number, string>();
  let lastChapterInSection: { section: RawSection | null; chapter: number } | null = null;
  const moduleTitles = new Map<number, string>();
  for (const { a, s, pos } of ordered) {
    const info = s ? sectionInfo.get(s) ?? null : null;
    const main = a.html.find((h) => h.field === 'content' && h.html.trim()) ?? a.html.find((h) => h.field === 'intro') ?? null;
    const c = adapter.classify({ a, section: s, sectionInfo: info, plain: plainText(main?.html ?? '') });
    if (c.moduleTitle && c.unit != null && !moduleTitles.has(c.unit)) moduleTitles.set(c.unit, c.moduleTitle);
    let placement: ActivityPlacement = { scope: 'course', chapterNumber: null, by: 'none' };
    let role: ChapterRole | null = null;
    let kind: CourseKind = c.kind;
    let unknownReason = c.unknownReason ?? null;
    if (c.scope === 'chapter') {
      let n = c.chapter ?? null;
      let by: ActivityPlacement['by'] = c.placementBy ?? (n !== null ? 'number' : 'none');
      if (n === null && info?.chapter != null) { n = info.chapter; by = 'section'; }
      if (n === null && lastChapterInSection && lastChapterInSection.section === s) { n = lastChapterInSection.chapter; by = 'position'; }
      if (n === null) {
        // Rol de capítulo sin capítulo al que pertenecer: no se inventa uno.
        kind = 'unknown';
        unknownReason = `parece de capítulo (${c.evidence}) pero ni la actividad, ni su sección, ni la anterior dicen de cuál`;
      } else {
        placement = { scope: 'chapter', chapterNumber: n, by };
        role = c.role ?? 'unknown';
        lastChapterInSection = { section: s, chapter: n };
        if (c.chapterTitle?.text) {
          const prev = titleHints.get(n);
          if (!prev || c.chapterTitle.priority > prev.priority) titleHints.set(n, { ...c.chapterTitle, evidence: c.evidence });
        }
        if (c.chapterUuid && !chapterUuid.has(n)) chapterUuid.set(n, c.chapterUuid);
      }
    }
    const files = (a.contextId !== null ? raw.filesByContext.get(a.contextId) ?? [] : [])
      .filter((f) => f.filename !== '.' || f.filesize > 0)
      .slice()
      .sort((x, y) => x.fileId - y.fileId);
    const tokens = a.html.flatMap((h) => extractTokens(h.html, h, tokenCtx));
    const bk = /^cv\d+:(ch|exam|exam_info|module_intro|module_next|exam_explanations|shell|final_exam|final_exam_info|final_exam_next|final_exam_explanations)(?::([0-9a-f-]{36}))?(?::(.+))?$/.exec(a.idnumber ?? '');
    activities.push({
      moduleId: a.moduleId,
      modname: a.modname,
      dir: a.dir,
      backupIndex: a.backupIndex,
      sectionId: s ? s.id : a.sectionId,
      sectionNumber: s ? s.number : a.sectionNumber,
      position: pos,
      title: a.title || a.name || '',
      idnumber: a.idnumber,
      visible: a.visible,
      contextId: a.contextId,
      placement,
      role,
      kind: placement.scope === 'chapter' ? c.kind : kind,
      evidence: c.evidence,
      unknownReason: role === 'unknown' || (placement.scope === 'course' && kind === 'unknown') ? unknownReason ?? 'sin regla que lo decida' : null,
      unit: c.unit ?? null,
      pending: c.pending ?? null,
      builderKey: bk ? { kind: bk[1], uuid: bk[2] ?? null, key: bk[3] ?? null } : null,
      html: a.html,
      files,
      tokens,
      referencedBy: [],
      exam: null,
      source: null,
      entries: a.entries,
      missingFolder: a.missingFolder,
    });
  }

  // Referencias inversas (tokens que apuntan a cada actividad).
  const actByMid = new Map<number, WorkshopActivity>();
  for (const x of activities) if (!actByMid.has(x.moduleId)) actByMid.set(x.moduleId, x);
  for (const x of activities) {
    for (const t of x.tokens) {
      if (t.targetModuleId === null) continue;
      const target = actByMid.get(t.targetModuleId);
      if (target && !target.referencedBy.includes(x.moduleId)) target.referencedBy.push(x.moduleId);
    }
  }
  for (const x of activities) x.referencedBy.sort((p, q) => p - q);

  // Exámenes: preguntas del banco por contexto del quiz + referencias directas.
  const qById = new Map<number, WorkshopQuestion>();
  const qByEntry = new Map<number, number[]>();
  for (const c of raw.categories) {
    for (const q of c.questions) if (!qById.has(q.id)) qById.set(q.id, q);
    for (const [e, ids] of c.entries) qByEntry.set(e, ids);
  }
  const giftOf = (final: boolean, unit: number | null): string | null => {
    const re = final ? /(^|\/)examen_final\.gift$/ : unit !== null ? new RegExp(`(^|/)examen_unidad${unit}\\.gift$`) : null;
    if (!re) return null;
    return raw.extras.find((e) => /^gift_exams\//.test(e) && re.test(e)) ?? raw.extras.find((e) => re.test(e)) ?? null;
  };
  for (const x of activities) {
    if (x.modname !== 'quiz') continue;
    const ra = byMid.get(x.moduleId)!;
    const ids: number[] = [];
    const add = (id: number) => { if (!ids.includes(id) && qById.has(id)) ids.push(id); };
    for (const c of raw.categories) {
      if ((x.contextId !== null && c.contextId === x.contextId) || (c.contextInstanceId === x.moduleId && c.contextId !== null && x.contextId === null)) {
        for (const q of c.questions) add(q.id);
      }
    }
    for (const e of ra.quizRefs.entryIds) for (const id of qByEntry.get(e) ?? []) add(id);
    for (const id of ra.quizRefs.questionIds) add(id);
    const final = x.kind === 'final_exam';
    x.exam = { final, unit: final ? null : x.unit, slots: ra.quizSlots, questions: ids.map((id) => qById.get(id)!), giftEntry: giftOf(final, final ? null : x.unit) };
  }

  // Capítulos.
  const chapterNums = [...new Set(activities.filter((x) => x.placement.scope === 'chapter').map((x) => x.placement.chapterNumber as number))].sort((p, q) => p - q);
  const chapters: WorkshopChapter[] = chapterNums.map((n) => {
    const acts = activities.filter((x) => x.placement.scope === 'chapter' && x.placement.chapterNumber === n);
    const roles = emptyRoles();
    for (const x of acts) roles[x.role ?? 'unknown'].push(x.moduleId);
    const secNums = [...new Set(acts.map((x) => x.sectionNumber).filter((v): v is number => v !== null))].sort((p, q) => p - q);
    const sInfo = secs.filter((s) => secNums.includes(s.number as number)).map((s) => sectionInfo.get(s)!);
    const fromSection = sInfo.find((i) => i.chapter === n && i.chapterTitle);
    const hint = titleHints.get(n);
    const mods = [...new Set(sInfo.map((i) => i.module).filter((v): v is number => v !== null))];
    const missing = adapter.expectedChapterRoles
      .filter((group) => !group.some((r) => roles[r].length > 0))
      .map((group) => group.join('|'));
    const re = new RegExp(`(^|/)(libro_cap${n}\\.md|cap${n}_[^/]+|scorm_cap${n}_[^/]+|scorm_cap${n}\\.zip)$`);
    return {
      number: n,
      title: fromSection?.chapterTitle ?? hint?.text ?? null,
      titleEvidence: fromSection?.chapterTitle ? `nombre de la sección «${secs.find((s) => sectionInfo.get(s) === fromSection)?.name ?? ''}»` : hint ? hint.evidence : null,
      moduleNumber: mods.length === 1 ? mods[0] : null,
      builderUuid: chapterUuid.get(n) ?? null,
      sectionNumbers: secNums,
      activities: acts.map((x) => x.moduleId),
      roles,
      missingRoles: missing,
      packageSources: raw.extras.filter((e) => re.test(e)),
      source: null,
    };
  });

  // Módulos: de las secciones; los exámenes por unidad.
  const modNums = new Set<number>();
  for (const s of secs) { const i = sectionInfo.get(s)!; if (i.module !== null) modNums.add(i.module); }
  for (const x of activities) if (x.kind === 'exam' && x.unit !== null) modNums.add(x.unit);
  for (const c of chapters) if (c.moduleNumber !== null) modNums.add(c.moduleNumber);
  const modules: WorkshopModule[] = [...modNums].sort((p, q) => p - q).map((m) => {
    const ss = secs.filter((s) => sectionInfo.get(s)!.module === m);
    const title = ss.map((s) => sectionInfo.get(s)!.moduleTitle).find((t) => !!t) ?? moduleTitles.get(m) ?? null;
    const intro = activities.find((x) => x.kind === 'module_intro' && x.unit === m && x.builderKey?.uuid);
    return {
      number: m,
      title,
      builderUuid: intro?.builderKey?.uuid ?? activities.find((x) => x.kind === 'exam' && x.unit === m && x.builderKey?.uuid)?.builderKey?.uuid ?? null,
      sectionNumbers: ss.map((s) => s.number).filter((v): v is number => v !== null),
      chapterNumbers: chapters.filter((c) => c.moduleNumber === m).map((c) => c.number),
      examModuleIds: activities.filter((x) => x.kind === 'exam' && x.unit === m).map((x) => x.moduleId),
    };
  });

  const sections: WorkshopSection[] = secs.map((s) => {
    const i = sectionInfo.get(s)!;
    return { id: s.id, number: s.number, name: s.name || s.title, dir: s.dir, entry: s.entry, sequence: s.sequence, visible: s.visible, kind: i.kind, moduleNumber: i.module, chapterNumber: i.chapter };
  });

  const inAct = new Set<number>();
  for (const x of activities) if (x.contextId !== null) inAct.add(x.contextId);
  const otherFiles: Record<string, number> = {};
  for (const { contextId, file: f } of raw.allFiles) {
    if (contextId !== null && inAct.has(contextId)) continue;
    if (f.filename === '.' && f.filesize === 0) continue;
    const k = `${f.component}/${f.filearea}`;
    otherFiles[k] = (otherFiles[k] ?? 0) + 1;
  }

  const byRole = Object.fromEntries(CHAPTER_ROLES.map((r) => [r, 0])) as Record<ChapterRole, number>;
  for (const x of activities) if (x.role) byRole[x.role]++;
  const tokensStat: Record<TokenStatus, number> = { ok: 0, orphan: 0, wrong_type: 0, external: 0, malformed: 0, unchecked: 0 };
  for (const x of activities) for (const t of x.tokens) tokensStat[t.status] += t.count;

  return {
    schema: WORKSHOP_INVENTORY_SCHEMA,
    family: raw.family,
    container: raw.container,
    course: {
      title: raw.title,
      shortname: raw.shortname,
      originalCourseId: raw.originalCourseId,
      backupName: raw.backupName,
      builder: { line: raw.builderLine, version: raw.builderVersion },
      moodle: { release: raw.moodleRelease, backupRelease: raw.backupRelease, minimum: null },
      originalWwwroot: raw.originalWwwroot,
    },
    sections,
    modules,
    chapters,
    courseActivities: activities.filter((x) => x.placement.scope === 'course').map((x) => x.moduleId),
    activities,
    exams: activities.filter((x) => x.exam).map((x) => ({ moduleId: x.moduleId, final: x.exam!.final, unit: x.exam!.unit, slots: x.exam!.slots, questions: x.exam!.questions.length })),
    libro: activities.filter((x) => x.kind === 'libro' || x.kind === 'libro_mobile').map((x) => ({ moduleId: x.moduleId, ...(x.modname === 'book' ? { format: 'book' as const, filename: null } : libroFormat(x.files)) })),
    audiobook: activities.filter((x) => x.kind === 'audiobook').map((x) => x.moduleId),
    packageExtras: raw.extras,
    otherFiles: Object.fromEntries(Object.entries(otherFiles).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))),
    issues,
    stats: {
      activities: activities.length,
      chapters: chapters.length,
      byRole,
      unknownChapterRoles: activities.filter((x) => x.role === 'unknown').length,
      unknownCourseKinds: activities.filter((x) => x.placement.scope === 'course' && x.kind === 'unknown').length,
      tokens: tokensStat,
    },
    sourceLookup: { status: 'not_identified', courseId: null, artifacts: 0, detail: null },
  };
}

// ─── Serialización determinista ─────────────────────────────────────────────

/** JSON con las claves de cada objeto ordenadas: dos corridas iguales → mismos bytes. */
export function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}
