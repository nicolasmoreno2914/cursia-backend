import { createHash } from 'crypto';
import { extractRequirements } from '../requirements/requirements-extractor';
import { mergeRequirementExtractions } from '../requirements/document-requirements';
import type { RequirementsExtraction } from '../requirements/requirements';
import type { EducationLevel } from '../../pedagogy/vocabulary';
import {
  ACADEMIC_LIMITS,
  AcademicContextV1,
  AcademicDocument,
  BibliographyItem,
  Competency,
  ContextConflict,
  EvaluationItem,
  Field,
  HoursComponent,
  HoursComponentKind,
  LearningOutcome,
  SourceRef,
  ThematicUnit,
  UnitContent,
  emptyAcademicContext,
  missingField,
  normalizeAcademicContext,
} from '../academic-context';
import { bloomLevelOf, outcomeDomainOf } from '../bloom';
import { ReadDocument, SourceLine, readDocument } from './text-sources';

/**
 * Extracción DETERMINISTA de un microcurrículo / sílabo → contexto académico estructurado. Sin LLM, sin red,
 * sin proveedores (USD 0). Regla de oro: lo que el documento no dice queda `missing`; lo derivado lleva su regla
 * (`inferred` + `basis`); nada se inventa.
 *
 *   1. Secciones por léxico de encabezados (sin tildes ni mayúsculas, numeración admitida, «Clave: valor» y filas
 *      de tabla «Clave | valor»). Una viñeta nunca es un encabezado.
 *   2. Un analizador por sección (listas con códigos RA/CO, unidades con horas, componentes de horas, evaluación
 *      con %, bibliografía, textos).
 *   3. Inferencias declaradas: total de horas = suma de componentes o semanales × semanas; nivel desde el nombre
 *      del programa («Tecnología en…»); resultados desde «objetivos específicos» si no hay resultados.
 *   4. Valores distintos para un mismo dato → se conserva el primero y queda un `conflict` con ambas fuentes.
 */

export const EXTRACTOR_ID = 'cursia-academic-extractor';
export const EXTRACTOR_VERSION = 1;

export interface ExtractionNote {
  code: string;
  documentId: string | null;
  message: string;
}

export interface ExtractionInput {
  name: string;
  data: Buffer;
}

export interface ExtractionResult {
  context: AcademicContextV1;
  /** LOOP 8.6 · requisitos explícitos (cantidades, estructura, alternativas) de los mismos documentos. Solo lectura. */
  requirements: RequirementsExtraction;
  notes: ExtractionNote[];
  stats: { documents: number; lines: number; sectionsFound: string[]; providersCalled: 0 };
}

type SectionKey =
  | 'subject' | 'program' | 'level' | 'semester' | 'learner' | 'prior' | 'generalObjective' | 'specificObjectives'
  | 'outcomes' | 'competencies' | 'contents' | 'hours' | 'hoursTotal' | 'hoursWeekly' | 'weeks' | 'credits'
  | 'hoursContact' | 'hoursPractice' | 'hoursAutonomous' | 'evaluation' | 'bibliography' | 'methodology'
  | 'constraints' | 'description' | 'additional';

/** Léxico de encabezados (texto normalizado: sin tildes, minúsculas, sin numeración ni «:» final). */
const HEADINGS: ReadonlyArray<[SectionKey, RegExp]> = [
  ['subject', /^(nombre (de la|del) (asignatura|curso|espacio academico|materia|modulo|unidad de aprendizaje)|asignatura|nombre del curso|espacio academico|materia|curso|unidad de aprendizaje)$/],
  ['program', /^(programa( academico| de formacion)?|carrera|programa al que pertenece)$/],
  ['level', /^(nivel( de formacion| academico| educativo)?|tipo de formacion)$/],
  ['semester', /^(semestre|periodo academico|ciclo|ubicacion en el plan de estudios)$/],
  ['learner', /^(perfil (del|de los|de las) (estudiantes?|participantes?|aprendices?)|poblacion objetivo|publico objetivo|dirigido a|perfil de ingreso|destinatarios)$/],
  // LOOP 9.2: «Prerrequisitos» se escribe con doble r (antes solo se reconocía «prerequisitos»).
  ['prior', /^(pre-?r?requisitos?|requisitos previos|conocimientos previos|co-?requisitos?|saberes previos)$/],
  ['generalObjective', /^(objetivo general|proposito( del curso| de formacion| de la asignatura)?|objetivo del curso)$/],
  ['specificObjectives', /^(objetivos especificos|objetivos de aprendizaje)$/],
  ['outcomes', /^(resultados de aprendizaje( esperados| del curso| de la asignatura| previstos)?|resultados esperados|logros de aprendizaje|logros esperados)$/],
  ['competencies', /^(competencias( especificas| genericas| a desarrollar| profesionales| transversales| del curso)?|competencia( especifica| general)?)$/],
  ['contents', /^(contenidos?( tematicos?| programaticos?| del curso| de la asignatura| minimos)?|unidades( tematicas| de aprendizaje)?|temario|ejes tematicos|plan tematico|estructura tematica|programa tematico|contenido programatico)$/],
  ['hoursTotal', /^(intensidad horaria total|horas totales|total de horas|numero total de horas)$/],
  ['hoursWeekly', /^(intensidad horaria semanal|horas semanales|horas por semana|intensidad semanal)$/],
  ['hours', /^(intensidad horaria|carga horaria|distribucion (de|del) (tiempo|las horas|horas)|distribucion horaria|tiempo de dedicacion|duracion( total)?( y distribucion horaria| y distribucion de (las )?horas)?|horas de trabajo( del estudiante)?)$/],
  ['weeks', /^(numero de semanas|semanas|duracion en semanas)$/],
  ['credits', /^(creditos( academicos)?|numero de creditos|n(o|ro)\.? de creditos)$/],
  ['hoursContact', /^(horas (de trabajo )?presencial(es)?|horas de acompanamiento( docente| directo)?|trabajo presencial|horas teoricas|horas de clase|horas con docente|trabajo con acompanamiento docente|acompanamiento directo)$/],
  ['hoursPractice', /^(horas practicas|horas de practica|trabajo practico)$/],
  ['hoursAutonomous', /^(horas (de trabajo )?(autonomo|independiente)|trabajo (autonomo|independiente)|horas autonomas|estudio independiente)$/],
  ['evaluation', /^(evaluacion( del aprendizaje| de los aprendizajes| del curso| de la asignatura)?|criterios de evaluacion|sistema de evaluacion|estrategias? de evaluacion|plan de evaluacion|evaluacion y calificacion|ponderacion)$/],
  ['bibliography', /^(bibliografia( basica| complementaria| recomendada| obligatoria)?|referencias( bibliograficas)?|fuentes( de consulta| consultadas)?|recursos bibliograficos|lecturas( recomendadas| obligatorias)?|webgrafia|referentes( normativos)?( y tecnicos)?)$/],
  // LOOP 9.2: encabezados combinados («Enfoque pedagógico y metodología»): la metodología del documento no se pierde.
  ['methodology', /^(metodologia( de ensenanza| del curso| de la asignatura)?|estrategias? (metodologicas?|didacticas?|pedagogicas?)|metodologia y estrategias didacticas|enfoque pedagogico( y metodologia| y didactico)?|enfoque metodologico|metodologia y enfoque( pedagogico)?|enfoque y metodologia)$/],
  ['constraints', /^(restricciones( institucionales)?|lineamientos( institucionales)?|condiciones( institucionales)?|requisitos institucionales|consideraciones institucionales)$/],
  ['description', /^(descripcion( del curso| de la asignatura| general)?|justificacion|presentacion( del curso| de la asignatura)?)$/],
  ['additional', /^(observaciones|informacion adicional|notas|modalidad|codigo( de la asignatura)?|area( de formacion)?|componente de formacion)$/],
];

/** Claves de un solo valor (el valor va en la misma línea, en la celda vecina o en la línea siguiente). */
const SINGLE_VALUE: ReadonlySet<SectionKey> = new Set(['subject', 'program', 'level', 'semester', 'hoursTotal', 'hoursWeekly', 'weeks', 'credits', 'hoursContact', 'hoursPractice', 'hoursAutonomous']);

const SECTION_LABEL: Readonly<Record<SectionKey, string>> = {
  subject: 'Asignatura', program: 'Programa', level: 'Nivel', semester: 'Semestre', learner: 'Perfil del estudiante',
  prior: 'Conocimientos previos', generalObjective: 'Objetivo general', specificObjectives: 'Objetivos específicos',
  outcomes: 'Resultados de aprendizaje', competencies: 'Competencias', contents: 'Contenidos', hours: 'Intensidad horaria',
  hoursTotal: 'Intensidad horaria', hoursWeekly: 'Intensidad horaria', weeks: 'Intensidad horaria', credits: 'Créditos',
  hoursContact: 'Intensidad horaria', hoursPractice: 'Intensidad horaria', hoursAutonomous: 'Intensidad horaria',
  evaluation: 'Evaluación', bibliography: 'Bibliografía', methodology: 'Metodología', constraints: 'Restricciones institucionales',
  description: 'Descripción', additional: 'Información adicional',
};

export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
const NUMBERING_RE = /^(?:[0-9]{1,2}(?:\.[0-9]{1,2})*[.)\-–]?\s+|[ivxlc]{1,6}[.)\-–]\s+)/i;
const BULLET_RE = /^\s*(?:[-•*▪◦○●·–—✓➢►]|\(?[0-9]{1,2}[.)]|\(?[a-z][.)])\s+/i;

function normKey(s: string): string {
  return stripAccents(s).toLowerCase().replace(NUMBERING_RE, '').replace(/[“”"«»*_#]/g, '').replace(/\s+/g, ' ').replace(/[\s:.\-–]+$/, '').trim();
}

function keyOf(text: string): SectionKey | null {
  const k = normKey(text);
  if (!k || k.length > 70) return null;
  for (const [key, re] of HEADINGS) if (re.test(k)) return key;
  return null;
}

/**
 * Rótulos de columna de una tabla (sin tildes, minúsculas). Una fila hecha SOLO de estos rótulos es el encabezado de la
 * tabla («Código | Resultado de aprendizaje», «Evaluación | Momento | Resultados principales»), nunca un dato.
 */
const COLUMN_LABEL_RE = /^(?:codigo|cod\.?|n[°º.o]?|nro\.?|numero|item|#|id|elemento|definicion|descripcion|detalle|nombre|titulo|resultados?(?: de aprendizaje| esperados?| principales| asociados| que evalua)?|competencias?(?: asociadas?)?|ra|co|unidad(?:es)?(?: tematicas?)?|modulos?|capitulos?|temas?|subtemas?|contenidos?(?: principal(?:es)?| tematicos?)?|recursos?(?: previstos| didacticos)?|actividad(?:es)?(?: de aprendizaje)?|horas?(?: de trabajo(?: del estudiante)?| totales| presenciales| autonomas)?|semanas?|sesion(?:es)?|fecha|momento|evaluacion(?:es)?|instrumento|tipo|criterios?(?: de evaluacion)?|evidencias?(?: de aprendizaje)?|porcentaje|peso|ponderacion|%|valor|observaciones|duracion|intensidad horaria|creditos|producto|estrategias?(?: didacticas?)?)$/;

/** ¿La fila (celdas o texto) es el encabezado de una tabla? Todas sus celdas son rótulos de columna (≥ 2 celdas). */
export function isColumnHeaderRow(l: { text: string; cells?: string[] }): boolean {
  const cells = (l.cells && l.cells.length ? l.cells : null)?.map((c) => normKey(c)).filter(Boolean);
  if (cells && cells.length >= 2) return cells.every((c) => COLUMN_LABEL_RE.test(c));
  // Sin celdas (lectura plana): «Código Resultado de aprendizaje» = 2 rótulos seguidos. Se parte en rótulos conocidos.
  let rest = normKey(l.text);
  if (!rest || rest.length > 80 || /\d/.test(rest)) return false;
  let parts = 0;
  while (rest) {
    let hit = '';
    const words = rest.split(' ');
    for (let k = Math.min(words.length, 6); k >= 1; k--) {
      const cand = words.slice(0, k).join(' ');
      if (COLUMN_LABEL_RE.test(cand)) { hit = cand; break; }
    }
    if (!hit) return false;
    parts++;
    rest = rest.slice(hit.length).trim();
  }
  return parts >= 2;
}

interface HeadingHit { key: SectionKey; value: string | null; heading: string }

/** ¿La línea es un encabezado conocido? Devuelve la clave y el valor en línea («Clave: valor»), si lo hay. */
function headingOf(l: SourceLine): HeadingHit | null {
  if (l.cells) return null; // las filas de tabla se tratan aparte (pares clave | valor)
  if (BULLET_RE.test(l.text) && !l.heading) {
    // «1. Resultados de aprendizaje» es un encabezado numerado; «- Evaluación» es una viñeta.
    if (!/^\s*\(?[0-9]{1,2}[.)]\s+/.test(l.text)) return null;
  }
  const colon = l.text.indexOf(':');
  if (colon > 0) {
    const key = keyOf(l.text.slice(0, colon));
    if (key) {
      const value = l.text.slice(colon + 1).trim();
      return { key, value: value || null, heading: l.text.slice(0, colon).trim() };
    }
  }
  const key = keyOf(l.text);
  return key ? { key, value: null, heading: l.text.replace(/[:\s]+$/, '') } : null;
}

// ── Utilidades de texto ────────────────────────────────────────────────────────────────────────────────────

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const excerptOf = (s: string) => {
  const t = collapse(s);
  return t.length <= ACADEMIC_LIMITS.excerpt ? t : `${t.slice(0, ACADEMIC_LIMITS.excerpt - 1)}…`;
};
/** Corta en el último fin de oración ≤ max (si no hay, en el último espacio). Devuelve si cortó. */
function clip(s: string, max: number): { text: string; clipped: boolean } {
  const t = collapse(s);
  if (t.length <= max) return { text: t, clipped: false };
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  const at = end > max * 0.5 ? end + 1 : cut.lastIndexOf(' ');
  return { text: cut.slice(0, at > 0 ? at : max).trim(), clipped: true };
}
const HOURS_RE = /(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:horas?|hrs?\.?|h)(?![a-z])/i;
const HNUM = '(\\d{1,4}(?:[.,]\\d{1,2})?)';
/** «40–44 horas», «40 - 44 h», «40 a 44 horas», «de 40 a 44 horas», «entre 40 y 44 horas». */
const HOURS_RANGE_RE = new RegExp(`(?:entre\\s+${HNUM}\\s+y\\s+${HNUM}|${HNUM}\\s*(?:-|–|—|a|al|hasta)\\s*${HNUM})\\s*(?:horas?|hrs?\\.?|h)(?![a-z])`, 'i');
/** Meta de diseño de un rango: el punto medio a la media hora (misma regla que los formatos S/M/L). */
export const rangeMidpoint = (min: number, max: number) => Math.round(((min + max) / 2) * 2) / 2;
/**
 * Horas de un texto, CONSERVANDO un rango: «40–44 horas» → {value 42, min 40, max 44}; «48 horas» → {value 48}.
 * Un rango nunca se convierte en su extremo superior.
 */
export function hoursSpanOf(text: string): { value: number; min?: number; max?: number; raw: string } | null {
  const r = HOURS_RANGE_RE.exec(text);
  if (r) {
    const a = num(r[1] ?? r[3]);
    const b = num(r[2] ?? r[4]);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b >= a) return a === b ? { value: a, raw: r[0] } : { value: rangeMidpoint(a, b), min: a, max: b, raw: r[0] };
  }
  const m = HOURS_RE.exec(text);
  return m ? { value: num(m[1]), raw: m[0] } : null;
}
const PCT_RE = /(\d{1,3}(?:[.,]\d{1,2})?)\s*%/;
const num = (s: string) => Number(s.replace(',', '.'));
const OUTCOME_CODE_RE = /^\s*\(?(RAA|RAP|RA|R)\s*[-.]?\s*([0-9]{1,3})\s*\)?\s*[.:)\-–—|]?\s+/i;
const COMPETENCY_CODE_RE = /^\s*\(?(CE|CG|CO|C)\s*[-.]?\s*([0-9]{1,3})\s*\)?\s*[.:)\-–—|]?\s+/i;
// Vínculos: «RA1» (mayúsculas) en cualquier parte; las competencias («CE2», «CO1») SOLO dentro de un grupo de códigos
// —entre paréntesis, al final tras un guion o en una celda que solo trae códigos—, para no confundir «CO2» de
// «emisiones de CO2» con una competencia.
const OUTCOME_REF_G = /\b(RAA|RAP|RA)\s*-?\s*([0-9]{1,3})\b/g;
// Dentro de un grupo de códigos se aceptan minúsculas («(ra1, ra2)»); fuera, solo «RA» en mayúsculas.
const CODE_G = /\b(RAA|RAP|RA|CE|CG|CO)\s*-?\s*([0-9]{1,3})\b/gi;
const CODE_LIST = '(?:(?:RAA|RAP|RA|CE|CG|CO)\\s*-?\\s*[0-9]{1,3}[\\s,;y·/]*)+';
const GROUP_PAREN_G = new RegExp(`\\((\\s*${CODE_LIST})\\)`, 'gi');
// Al final tras guion o barra (no «:» — «Gas principal: CO2» no es un vínculo).
const GROUP_TAIL_RE = new RegExp(`[-–—|]\\s*(${CODE_LIST})$`, 'i');
const GROUP_ALL_RE = new RegExp(`^\\s*${CODE_LIST}$`, 'i');

// ── Estado por documento ──────────────────────────────────────────────────────────────────────────────────

interface Section {
  key: SectionKey;
  heading: string;
  headingLine: SourceLine;
  inline: string | null;
  lines: SourceLine[];
  /** LOOP 9.2: «Módulo 1 — título» con sus capítulos y temas, sin una sección «Contenidos» que los agrupe. */
  moduleTree?: boolean;
  /** Fase 1 (review): «Nombre» a secas (con «:» o con el valor en la línea siguiente): solo vale si no hay otra clave. */
  bareName?: boolean;
}

/** LOOP 9.2: encabezado de módulo / unidad con título («8. Módulo 1 — Fundamentos, derechos y atención inicial»). */
const MODULE_HEADING_RE = /^(?:\d{1,2}[.)]\s+)?(?:m[oó]dulo|unidad)\s+(\d{1,2}|[ivxlc]{1,6})\s*[—–:.·|-]\s*(\S.*)$/i;
/**
 * Encabezado de módulo IMPERFECTO (documentos reales): «Módulo 2» sin título (los temas van debajo) o «Módulo: Atención
 * inicial» sin número. Solo cuenta si lo que sigue son sus temas o capítulos (lo decide isModuleHeading).
 */
const BARE_MODULE_RE = /^(?:\d{1,2}[.)]\s+)?(?:m[oó]dulo|unidad)(?:\s+(\d{1,2}|[ivxlc]{1,6}))?\s*(?:[—–:.·|-]\s*(\S.*))?$/i;
/** Fila o línea de capítulo: «1.1 | título | recursos», «1.1 título», «Capítulo 3: título». */
const CHAPTER_ROW_RE = /^(?:cap[ií]tulo|lecci[oó]n|tema)?\s*(\d{1,2})[.](\d{1,2})\.?(?:\s|$)|^(?:cap[ií]tulo|lecci[oó]n)\s+(\d{1,2}|[ivxlc]{1,6})\b/i;
/**
 * Review LOOP 9.2 (C1/I2): solo un ENCABEZADO de módulo abre el árbol — con estilo de título (Word/Markdown) o con la
 * numeración de las secciones del documento («8. Módulo 1 — …») —, con un título de verdad (no «30 %», no una oración).
 */
function isModuleHeading(l: SourceLine, next?: SourceLine): boolean {
  const t = l.text.trim();
  const m = MODULE_HEADING_RE.exec(t);
  if (!m && !l.cells && t.length <= 120 && next) {
    // «Módulo 2» solo, o «Módulo: título» sin número: encabezado si le siguen sus temas (línea corta que no es otro
    // encabezado ni una oración) o sus capítulos.
    const b = BARE_MODULE_RE.exec(t);
    if (!b || (!b[1] && !b[2])) return false;
    const title = (b[2] || '').trim();
    if (title && (title.split(/\s+/).length > 14 || /%|\d+\s*(h|horas?)\b/i.test(title) || /[.;]$/.test(title))) return false;
    const nt = (next.cells && next.cells.length ? next.cells[0] : next.text).trim();
    const shortTopic = !next.cells && nt.split(/\s+/).length <= 12 && !/[.;:]$/.test(nt) && !keyOf(nt) && !BARE_MODULE_RE.test(nt);
    return CHAPTER_ROW_RE.test(nt) || isColumnHeaderRow(next) || shortTopic;
  }
  if (!m || l.cells || t.length > 160) return false;
  const title = m[2].trim();
  const words = title.split(/\s+/).filter((w) => /[a-záéíóúñ]{2,}/i.test(w));
  // Un título de una sola palabra («Módulo 1 — Fundamentos») también vale; nunca una cifra, unas horas o una oración.
  if (words.length < 1 || words.length > 14 || /%|\d+\s*(h|horas?)\b/i.test(title) || /[.;]$/.test(title)) return false;
  if (l.heading || /^\d{1,2}[.)]\s+/.test(t)) return true;
  // Documento sin estilos (PDF, texto copiado): es un encabezado de módulo si lo que sigue son sus capítulos (una fila de
  // capítulo o el encabezado de la tabla de capítulos).
  if (!next) return false;
  const nt = next.cells && next.cells.length ? next.cells[0] : next.text;
  return CHAPTER_ROW_RE.test(nt.trim()) || isColumnHeaderRow(next);
}
/** Review LOOP 9.2 (I4): «Nombre» a secas solo es el nombre del curso en la ficha de identificación (no docente ni firmas). */
const BARE_NAME_BLOCKERS = /(docente|profesor|tutor|elabor|revis|aprob|firma|autor|responsable|coordinador|estudiante|participante|contacto|integrante|grupo|evaluaci|bibliograf|referencia)/;

interface Item { text: string; lines: SourceLine[] }

class DocExtraction {
  readonly ctx: AcademicContextV1 = emptyAcademicContext();
  readonly notes: ExtractionNote[] = [];
  readonly found = new Set<string>();
  private rawOutcomes: { code: number | null; item: Item; inferredFrom: string | null }[] = [];
  private rawCompetencies: { code: number | null; item: Item }[] = [];
  /** Horas por módulo / unidad de una tabla de distribución horaria («Módulo 1 | 13–15 h»), por número de módulo. */
  private unitHours: { index: number; value: number; line: SourceLine }[] = [];
  /** Encabezado de la primera sección de metodología (otra con distinto encabezado la complementa). */
  private methodologyHeading: string | null = null;

  constructor(readonly docId: string) {}

  src(l: SourceLine, section: string | null): SourceRef {
    return { documentId: this.docId, section, page: l.page, line: l.line, excerpt: excerptOf(l.text) };
  }
  note(code: string, message: string): void {
    this.notes.push({ code, documentId: this.docId, message });
  }

  /** Asigna un Field encontrado; si ya tenía otro valor distinto, queda el primero y se registra el conflicto. */
  setFound<T>(path: string, current: Field<T>, value: T, source: SourceRef, show: (v: T) => string): Field<T> {
    if (current.status === 'missing') return { status: 'found', value, sources: [source] };
    const a = show(current.value as T);
    const b = show(value);
    if (normKey(a) === normKey(b)) {
      return current.sources.length < ACADEMIC_LIMITS.sourcesPerItem ? { ...current, sources: [...current.sources, source] } : current;
    }
    // El mismo texto, una vez cortado («…prácticas clínicas o») y otra completo: no es una contradicción; manda el
    // completo (y deja de pedir confirmación).
    const ka = normKey(a);
    const kb = normKey(b);
    if (Math.min(ka.length, kb.length) >= 20 && (ka.startsWith(kb) || kb.startsWith(ka))) {
      const longer = kb.length > ka.length;
      const sources = (longer ? [source, ...current.sources] : [...current.sources, source]).slice(0, ACADEMIC_LIMITS.sourcesPerItem);
      const { review: _r, ...rest } = current;
      return longer ? { ...rest, value, sources } : { ...current, sources };
    }
    this.addConflict(path, [{ value: a, source: current.sources[0] }, { value: b, source }]);
    return current;
  }
  addConflict(path: string, values: ContextConflict['values']): void {
    const existing = this.ctx.conflicts.find((c) => c.path === path);
    if (existing) {
      for (const v of values) {
        // Review 8.6C (documentos reales): todo valor de un conflicto respeta el largo máximo, no solo los dos primeros
        // (si no, guardar el contexto fallaba con TEXT_TOO_LONG y el documento no se podía usar).
        if (!existing.values.some((x) => normKey(x.value) === normKey(v.value)) && existing.values.length < ACADEMIC_LIMITS.sourcesPerItem) existing.values.push({ value: v.value.slice(0, ACADEMIC_LIMITS.title), source: v.source });
      }
    } else if (this.ctx.conflicts.length < ACADEMIC_LIMITS.conflicts) {
      this.ctx.conflicts.push({ path, values: values.map((v) => ({ value: v.value.slice(0, ACADEMIC_LIMITS.title), source: v.source })) });
    }
  }

  run(doc: ReadDocument): void {
    const sections = this.segment(doc.lines);
    for (const s of sections) this.found.add(s.key);
    for (const s of sections) this.parse(s);
    this.applyUnitHours();
    this.finishOutcomes(sections);
    this.inferHours();
    this.inferLevel();
  }

  /** Corta el documento en secciones por encabezados conocidos. Las filas «clave | valor» se resuelven aquí. */
  private segment(lines: SourceLine[]): Section[] {
    const out: Section[] = [];
    let cur: Section | null = null;
    // LOOP 9 (P1-1): una sección que Cursia no modela («5. Estructura del curso») cierra la anterior: si no, su texto se
    // sumaba a la lista de arriba (p. ej. un «RA6» con la estructura). Cuenta como encabezado solo si sigue la numeración
    // de los encabezados del documento (4 → 5), es corto, sin punto final, y la sección actual no numera sus propios ítems.
    let lastHeadingNum: number | null = null;
    let curNumbered = false;
    let seenSubject = false;
    let context = ''; // último título y última línea (para «Nombre» a secas)
    const bareNameOk = (l: SourceLine) => !seenSubject && l.line <= 40 && !BARE_NAME_BLOCKERS.test(stripAccents(context).toLowerCase());
    const headingNum = (t: string) => { const m = /^\s*(\d{1,2})[.)]\s+\S/.exec(t); return m ? Number(m[1]) : null; };
    // La sección abierta por una fila «clave | valor» de una ficha: la fila siguiente de esa misma ficha con otro rótulo
    // («Requisito audiovisual | …») es otro dato, no la continuación del anterior.
    let curFromRow = false;
    for (let li = 0; li < lines.length; li++) {
      const l = lines[li];
      if (l.cells) {
        // Encabezado de una tabla («Código | Resultado de aprendizaje»): no es un dato ni una clave; la tabla sigue en la
        // sección abierta (sus parsers lo reconocen y lo saltan).
        if (isColumnHeaderRow(l)) {
          if (cur) { cur.lines.push(l); curFromRow = false; }
          continue;
        }
        const cells0 = (l.cells ?? []).map(collapse);
        // «Nombre | Atención Integral…» en la ficha del curso (Review LOOP 9.2 I4: solo ahí).
        if (cells0[0] && normKey(cells0[0]) === 'nombre' && cells0[1] && !keyOf(cells0[1])) {
          if (bareNameOk(l)) { out.push({ key: 'subject', heading: cells0[0], headingLine: l, inline: cells0[1], lines: [] }); seenSubject = true; cur = null; }
          else if (cur) cur.lines.push(l);
          context = cells0.join(' ');
          continue;
        }
        const pairs = this.cellPairs(l);
        if (pairs.some((p) => p.key === 'subject')) seenSubject = true;
        if (pairs.length) {
          for (const p of pairs) out.push({ key: p.key, heading: p.heading, headingLine: l, inline: p.value, lines: [] });
          // Una fila clave | valor de una sección de varias líneas abre esa sección para lo que sigue.
          const last = pairs[pairs.length - 1];
          cur = SINGLE_VALUE.has(last.key) ? null : out[out.length - 1];
          curFromRow = !!cur;
          continue;
        }
        // Otra fila de la ficha con un rótulo que Cursia no modela («Requisito audiovisual | …»): cierra el dato anterior.
        if (cur && curFromRow && cells0[0] && cells0.length === 2 && cells0[0].split(/\s+/).length <= 5 && !/\d/.test(cells0[0])) { cur = null; curFromRow = false; continue; }
        if (cur) cur.lines.push(l);
        continue;
      }
      // Un título suelto después de la ficha («Nota de diseño») tampoco continúa el último dato de la ficha.
      if (cur && curFromRow && (l.heading || (l.text.split(/\s+/).length <= 4 && !/[.;:,]$/.test(l.text)))) { cur = null; curFromRow = false; }
      curFromRow = false;
      // LOOP 9.2: «Módulo N — título» abre (o continúa) el árbol de contenidos del documento: módulos → capítulos → temas.
      // Review C1/I2: nunca dentro de una sección «Contenidos» o «Evaluación» ya abierta (ahí sigue el lector de siempre).
      if (isModuleHeading(l, lines[li + 1]) && !(cur && !cur.moduleTree && (cur.key === 'contents' || cur.key === 'evaluation'))) {
        if (!cur || !cur.moduleTree) {
          cur = { key: 'contents', heading: 'Contenidos', headingLine: l, inline: null, lines: [], moduleTree: true };
          out.push(cur);
        }
        cur.lines.push(l);
        const mn = headingNum(l.text);
        if (mn !== null) lastHeadingNum = mn;
        curNumbered = false;
        continue;
      }
      let h = headingOf(l);
      // Dentro de un módulo, «Propósito: …» es el propósito del módulo (no el objetivo general del curso). Review I3: solo
      // «Propósito» a secas; «Objetivo general» o «Propósito del curso» cierran el árbol como siempre.
      if (h && cur && cur.moduleTree && h.key === 'generalObjective' && h.value && normKey(h.heading) === 'proposito') {
        cur.lines.push(l);
        continue;
      }
      // Review 2.ª (I4): «Propósito / Objetivo del módulo: …» también es del módulo.
      if (cur && cur.moduleTree && /^(prop[oó]sito|objetivo) del m[oó]dulo\s*:/i.test(l.text.trim())) {
        cur.lines.push(l);
        continue;
      }
      // «Nombre: …» a secas (Review I4): solo en la ficha de identificación.
      let bare = false;
      if (!h && !l.cells) {
        const colon = l.text.indexOf(':');
        if (colon > 0 && normKey(l.text.slice(0, colon)) === 'nombre' && l.text.slice(colon + 1).trim() && bareNameOk(l)) { h = { key: 'subject', value: l.text.slice(colon + 1).trim(), heading: l.text.slice(0, colon).trim() }; bare = true; }
        // Fase 1 («Pegar información»): un texto copiado de la ficha pierde la tabla y queda «Nombre» en una línea y el
        // valor en la siguiente. Mismas guardas que la celda y que «Nombre: …» (solo en la ficha, antes de otra asignatura).
        else if (normKey(l.text) === 'nombre' && bareNameOk(l)) { h = { key: 'subject', value: null, heading: l.text.trim() }; bare = true; }
      }
      if (h && h.key === 'subject') seenSubject = true;
      if (l.heading || headingNum(l.text) !== null || l.text.length <= 40) context = l.text;
      if (h) {
        cur = { key: h.key, heading: h.heading, headingLine: l, inline: h.value, lines: [], ...(bare ? { bareName: true } : {}) };
        out.push(cur);
        const hn = headingNum(l.text);
        if (hn !== null) lastHeadingNum = hn;
        curNumbered = false;
        if (SINGLE_VALUE.has(h.key) && h.value) cur = null;
        continue;
      }
      const n = headingNum(l.text);
      if (cur && n !== null) {
        const title = l.text.replace(/^\s*\d{1,2}[.)]\s+/, '').trim();
        const unknownHeading = !curNumbered && lastHeadingNum !== null && n === lastHeadingNum + 1 && title.split(/\s+/).length <= 8 && !/[.;:]$/.test(title);
        // (Solo la numeración: un encabezado con estilo —Markdown «#», «Título N» de Word— puede ser una unidad dentro de
        // «Contenidos»; no cierra la sección. Review BE-L9 I1.)
        if (unknownHeading) { cur = null; lastHeadingNum = n; continue; }
        curNumbered = true;
      }
      if (cur) {
        cur.lines.push(l);
        // Un dato de un solo valor sin valor en línea toma SOLO la línea siguiente.
        if (SINGLE_VALUE.has(cur.key)) cur = null;
      }
    }
    // Fase 1 (review): un «Nombre» a secas es el último recurso: si el documento trae la asignatura con su clave
    // («Asignatura», «Nombre del curso», la fila de la ficha), esa manda y el «Nombre» suelto se descarta.
    if (out.some((x) => x.key === 'subject' && !x.bareName)) return out.filter((x) => !(x.key === 'subject' && x.bareName));
    return out;
  }

  private cellPairs(l: SourceLine): { key: SectionKey; value: string | null; heading: string }[] {
    const cells = (l.cells ?? []).map(collapse);
    const out: { key: SectionKey; value: string | null; heading: string }[] = [];
    for (let i = 0; i < cells.length; i++) {
      const key = cells[i] ? keyOf(cells[i]) : null;
      if (!key) continue;
      const next = cells[i + 1];
      if (next && !keyOf(next)) {
        out.push({ key, value: next, heading: cells[i] });
        i++;
      } else if (cells.length === 1 || cells.every((c, j) => j === i || !c)) {
        out.push({ key, value: null, heading: cells[i] });
      }
    }
    return out;
  }

  private parse(s: Section): void {
    const label = SECTION_LABEL[s.key];
    switch (s.key) {
      case 'subject':
      case 'program':
      case 'semester':
      case 'level': {
        const v = this.singleValue(s);
        if (!v) return;
        const value = clip(v.text, ACADEMIC_LIMITS.title).text;
        const src = this.src(v.line, label);
        if (s.key === 'subject') this.ctx.identity.subjectName = this.setFound('identity.subjectName', this.ctx.identity.subjectName, value, src, (x) => x);
        else if (s.key === 'program') this.ctx.identity.program = this.setFound('identity.program', this.ctx.identity.program, value, src, (x) => x);
        else if (s.key === 'level') this.ctx.identity.educationLevel = this.setFound('identity.educationLevel', this.ctx.identity.educationLevel, { text: value, level: educationLevelOf(value) }, src, (x) => x.text);
        else this.pushListField('additionalInfo', `${s.heading}: ${value}`, v.line, label);
        return;
      }
      case 'additional': {
        const v = this.singleValue(s);
        if (v) this.pushListField('additionalInfo', `${s.heading}: ${clip(v.text, ACADEMIC_LIMITS.text - s.heading.length - 2).text}`, v.line, label);
        for (const l of s.lines.slice(v && !s.inline ? 1 : 0)) this.pushListField('additionalInfo', l.text, l, label);
        return;
      }
      case 'learner':
        return this.textField(s, 'learner.profile');
      case 'generalObjective':
        return this.textField(s, 'identity.generalObjective');
      case 'description':
        return this.textField(s, 'identity.description');
      case 'methodology':
        return this.textField(s, 'methodology');
      case 'prior':
        for (const it of this.items(s)) this.pushListField('priorKnowledge', it.text, it.lines[0], label);
        return;
      case 'constraints':
        for (const it of this.items(s)) this.pushListField('constraints', it.text, it.lines[0], label);
        return;
      case 'outcomes':
      case 'specificObjectives':
        for (const it of this.items(s)) {
          const m = OUTCOME_CODE_RE.exec(it.text);
          this.rawOutcomes.push({ code: m ? Number(m[2]) : null, item: { ...it, text: m ? it.text.slice(m[0].length) : it.text }, inferredFrom: s.key === 'specificObjectives' ? s.heading : null });
        }
        return;
      case 'competencies':
        for (const it of this.items(s)) {
          const m = COMPETENCY_CODE_RE.exec(it.text);
          this.rawCompetencies.push({ code: m ? Number(m[2]) : null, item: { ...it, text: m ? it.text.slice(m[0].length) : it.text } });
        }
        return;
      case 'contents':
        return this.parseContents(s);
      case 'hours':
      case 'hoursTotal':
      case 'hoursWeekly':
      case 'weeks':
      case 'credits':
      case 'hoursContact':
      case 'hoursPractice':
      case 'hoursAutonomous':
        return this.parseHours(s);
      case 'evaluation':
        return this.parseEvaluation(s);
      case 'bibliography':
        return this.parseBibliography(s);
    }
  }

  private singleValue(s: Section): { text: string; line: SourceLine } | null {
    if (s.inline) return { text: s.inline, line: s.headingLine };
    const l = s.lines[0];
    return l ? { text: l.cells ? l.cells.filter(Boolean).join(' ') : l.text, line: l } : null;
  }

  private textField(s: Section, path: 'learner.profile' | 'identity.generalObjective' | 'identity.description' | 'methodology'): void {
    const parts = [...(s.inline ? [{ text: s.inline, line: s.headingLine }] : []), ...s.lines.map((l) => ({ text: l.text, line: l }))];
    if (!parts.length) return;
    const { text, clipped } = clip(parts.map((p) => p.text).join(' '), ACADEMIC_LIMITS.text);
    if (clipped) this.note('TEXT_CLIPPED', `«${SECTION_LABEL[s.key]}» supera ${ACADEMIC_LIMITS.text} caracteres: se guardó hasta el último punto (revisa el texto completo en el documento).`);
    const src = this.src(parts[0].line, SECTION_LABEL[s.key]);
    // Texto que el documento muestra cortado (sale de la página o termina a mitad de frase): se usa y se pide confirmarlo.
    const cut = cutReview(parts.map((p) => p.line), text);
    if (path === 'methodology' && this.ctx.methodology.status === 'found' && this.methodologyHeading !== null && this.methodologyHeading !== normKey(s.heading)) {
      // «Enfoque pedagógico» y «Metodología» son dos partes del mismo dato (cómo se enseña), no valores que chocan.
      const m = this.ctx.methodology;
      if (!normKey(m.value as string).includes(normKey(text))) {
        this.ctx.methodology = { ...m, value: clip(`${m.value} ${text}`, ACADEMIC_LIMITS.text).text, sources: [...m.sources, src].slice(0, ACADEMIC_LIMITS.sourcesPerItem) };
      }
      return;
    }
    if (path === 'methodology') this.methodologyHeading = normKey(s.heading);
    if (path === 'learner.profile') this.ctx.learner.profile = withReview(this.setFound(path, this.ctx.learner.profile, text, src, (x) => x), text, cut);
    else if (path === 'identity.generalObjective') this.ctx.identity.generalObjective = withReview(this.setFound(path, this.ctx.identity.generalObjective, text, src, (x) => x), text, cut);
    else if (path === 'identity.description') this.ctx.identity.description = this.setFound(path, this.ctx.identity.description, text, src, (x) => x);
    else this.ctx.methodology = this.setFound(path, this.ctx.methodology, text, src, (x) => x);
  }

  private pushListField(which: 'priorKnowledge' | 'constraints' | 'additionalInfo', text: string, line: SourceLine, section: string): void {
    const f: Field<string[]> = which === 'priorKnowledge' ? this.ctx.learner.priorKnowledge : which === 'constraints' ? this.ctx.constraints : this.ctx.additionalInfo;
    const value = clip(text, ACADEMIC_LIMITS.text).text;
    if (!value) return;
    const list = f.value ?? [];
    if (list.length >= ACADEMIC_LIMITS.listItems || list.some((x) => normKey(x) === normKey(value))) return;
    const next: Field<string[]> = {
      status: 'found',
      value: [...list, value],
      sources: f.sources.length < ACADEMIC_LIMITS.sourcesPerItem ? [...f.sources, this.src(line, section)] : f.sources,
    };
    if (which === 'priorKnowledge') this.ctx.learner.priorKnowledge = next;
    else if (which === 'constraints') this.ctx.constraints = next;
    else this.ctx.additionalInfo = next;
  }

  /**
   * Elementos de una lista: empieza uno nuevo en cada viñeta / numeración / código / elemento de lista del
   * documento / fila de tabla; las líneas sin marca continúan el anterior (si no hay ninguna marca, cada línea es
   * un elemento). El valor en línea del encabezado cuenta como primer elemento.
   */
  private items(s: Section): Item[] {
    // LOOP 9.2: el valor en línea de una fila «clave | valor» es solo el valor (sin la celda del rótulo).
    const lines: SourceLine[] = [...(s.inline ? [{ ...s.headingLine, text: s.inline, cells: undefined }] : []), ...s.lines];
    const marked = (l: SourceLine) => !!l.cells || !!l.list || BULLET_RE.test(l.text) || OUTCOME_CODE_RE.test(l.text) || COMPETENCY_CODE_RE.test(l.text);
    const anyMarked = lines.some(marked);
    const out: Item[] = [];
    for (const l of lines) {
      // El encabezado de una tabla («Código | Resultado de aprendizaje») nunca es un elemento.
      if (isColumnHeaderRow(l)) continue;
      const text = l.cells ? l.cells.filter(Boolean).join(' — ') : l.text;
      const clean = text.replace(BULLET_RE, '').trim();
      if (!clean) continue;
      const prev = out[out.length - 1];
      // Sin marcas, una oración partida en varias líneas («… protocolos institucionales. La» / «formación no…») es UN
      // elemento: la línea que sigue a una que no termina en signo de cierre y empieza en minúscula la continúa.
      const wrapped = !anyMarked && prev && !/[.;:!?]$/.test(prev.text) && /^[a-záéíóúñü(]/.test(clean);
      if ((anyMarked && !marked(l) && prev) || wrapped) {
        prev.text = `${prev.text} ${clean}`;
        prev.lines.push(l);
      } else {
        out.push({ text: clean, lines: [l] });
      }
    }
    return out.map((i) => ({ ...i, text: collapse(i.text) }));
  }

  // ── Resultados y competencias (ids) ──

  private finishOutcomes(sections: Section[]): void {
    const hasOutcomes = sections.some((s) => s.key === 'outcomes');
    const raw = hasOutcomes ? this.rawOutcomes.filter((o) => o.inferredFrom === null) : this.rawOutcomes;
    const ids = assignIds(raw.map((o) => o.code), 'RA', ACADEMIC_LIMITS.outcomes);
    if (raw.length > ACADEMIC_LIMITS.outcomes) this.note('TOO_MANY_OUTCOMES', `El documento trae ${raw.length} resultados de aprendizaje; se guardaron los primeros ${ACADEMIC_LIMITS.outcomes}.`);
    this.ctx.outcomes = raw.slice(0, ACADEMIC_LIMITS.outcomes).map((o, i): LearningOutcome => {
      const text = clip(o.item.text, ACADEMIC_LIMITS.outcomeText).text;
      const level = bloomLevelOf(text);
      const section = o.inferredFrom ?? SECTION_LABEL.outcomes;
      const sources = o.item.lines.slice(0, ACADEMIC_LIMITS.sourcesPerItem).map((l) => this.src(l, section));
      const review = cutReview(o.item.lines, text);
      return o.inferredFrom
        ? { id: ids[i], text, level, domain: outcomeDomainOf(level), status: 'inferred', sources, basis: `el documento no trae «resultados de aprendizaje»; se usan sus «${o.inferredFrom}»`.slice(0, ACADEMIC_LIMITS.basis), ...(review ? { review } : {}) }
        : { id: ids[i], text, level, domain: outcomeDomainOf(level), status: 'found', sources, ...(review ? { review } : {}) };
    });
    if (hasOutcomes) {
      for (const o of this.rawOutcomes.filter((x) => x.inferredFrom !== null)) this.pushListField('additionalInfo', `Objetivo específico: ${o.item.text}`, o.item.lines[0], o.inferredFrom as string);
    }
    const cids = assignIds(this.rawCompetencies.map((c) => c.code), 'CO', ACADEMIC_LIMITS.competencies);
    this.ctx.competencies = this.rawCompetencies.slice(0, ACADEMIC_LIMITS.competencies).map((c, i): Competency => {
      const text = clip(c.item.text, ACADEMIC_LIMITS.outcomeText).text;
      const review = cutReview(c.item.lines, text);
      return {
        id: cids[i], text, status: 'found',
        sources: c.item.lines.slice(0, ACADEMIC_LIMITS.sourcesPerItem).map((l) => this.src(l, SECTION_LABEL.competencies)),
        ...(review ? { review } : {}),
      };
    });
  }

  // ── Contenidos (unidades + temas) ──

  private parseContents(s: Section): void {
    if (s.moduleTree) return this.parseModuleTree(s);
    const UNIT_RE = /^(?:unidad|m[oó]dulo|tema|eje|bloque|cap[ií]tulo)(?:\s+tem[aá]tica)?\s*(?:n[°º.]?\s*)?([0-9]{1,2}|[ivxlc]{1,6})\b\s*[:.\-–—)]?\s*(.*)$/i;
    const SUB_RE = /^\s*([0-9]{1,2})\.([0-9]{1,2})\.?\s+(.*)$/;
    const TOP_RE = /^\s*([0-9]{1,2})[.)]\s+(.*)$/;
    const units: { title: string; hours: number | null; line: SourceLine; contents: Item[]; refs: string[] }[] = [];
    const lines: SourceLine[] = [...(s.inline ? [{ ...s.headingLine, text: s.inline }] : []), ...s.lines];
    const hasUnitWords = lines.some((l) => UNIT_RE.test((l.cells?.[0] ?? l.text).replace(BULLET_RE, '')));
    const hasSub = !hasUnitWords && lines.some((l) => SUB_RE.test(l.text));
    let cur: (typeof units)[number] | null = null;
    const loose: Item[] = [];
    const pushContent = (text: string, l: SourceLine) => {
      const t = collapse(text.replace(BULLET_RE, ''));
      if (!t) return;
      const target = cur ? cur.contents : loose;
      for (const part of splitContentCell(t)) target.push({ text: part, lines: [l] });
    };
    for (const l of lines) {
      if (l.cells) {
        // Tabla de contenidos: | Unidad 1: título | temas | 12 h | RA1 |. Las filas de encabezado se saltan.
        const cells = l.cells.map(collapse);
        if (cells.every((c) => !c || /^(unidad(es)?|contenidos?|temas?|horas?|resultados?( de aprendizaje)?|ra|semana|n[°º.]?)$/i.test(stripAccents(c)))) continue;
        const ui = cells.findIndex((c) => UNIT_RE.test(c));
        if (ui >= 0) {
          const m = UNIT_RE.exec(cells[ui])!;
          const { text: title, hours } = takeHours(m[2] || cells[ui]);
          const rest = cells.filter((_c, j) => j !== ui);
          const hoursCell = rest.find((c) => /^\d{1,4}(?:[.,]\d{1,2})?\s*(?:h|horas?)?$/i.test(c));
          const refs = rest.filter((c) => c !== hoursCell).flatMap((c) => refsOf(c).ids);
          cur = { title: title || cells[ui], hours: hours ?? (hoursCell ? num(hoursCell) : null), line: l, contents: [], refs };
          units.push(cur);
          for (const c of rest) if (c !== hoursCell && refsOf(c).rest) pushContent(refsOf(c).rest, l);
          continue;
        }
        pushContent(cells.filter(Boolean).join('; '), l);
        continue;
      }
      const text = l.text.replace(BULLET_RE, '');
      const um = hasUnitWords ? UNIT_RE.exec(text) : null;
      const tm = !um && hasSub ? TOP_RE.exec(l.text) : null;
      if (um || (tm && !SUB_RE.test(l.text))) {
        const raw = um ? (um[2] || text) : (tm as RegExpExecArray)[2];
        const r = refsOf(raw);
        const { text: title, hours } = takeHours(r.rest);
        cur = { title: title || raw, hours, line: l, contents: [], refs: r.ids };
        units.push(cur);
        continue;
      }
      const sm = hasSub ? SUB_RE.exec(l.text) : null;
      pushContent(sm ? sm[3] : l.text, l);
    }
    this.emitUnits(s, units, loose);
  }

  /**
   * LOOP 9.2 · Árbol del documento: «Módulo N — título» → unidad; «Capítulo N. título» → un contenido con sus temas
   * («título: tema; tema…»). La práctica integradora y las evaluaciones del módulo no son capítulos de contenido (las
   * exigen los requisitos del documento, no los contenidos); el propósito del módulo tampoco.
   */
  private parseModuleTree(s: Section): void {
    const MOD_RE = MODULE_HEADING_RE;
    const CH_RE = /^(?:cap[ií]tulo|lecci[oó]n)\s+(\d{1,2}|[ivxlc]{1,6})\s*[.:—–)-]\s*(\S.*)$/i;
    // Review C1: solo los bloques del módulo que no son capítulos de contenido (práctica integradora, evaluación parcial o
    // final, propósito), y solo como encabezado corto; un tema que empieza con «Evaluación de riesgos…» sigue siendo tema.
    const SKIP_RE = /^(pr[aá]ctica (integradora|final|del m[oó]dulo)|evaluaci[oó]n (parcial|final|del m[oó]dulo)|examen (parcial|final|del m[oó]dulo)|actividad(es)? de aplicaci[oó]n( del m[oó]dulo)?)\b/i;
    // Celda de recursos («2 videos · 1 actividad H5P»), horas («12 h») o solo códigos («RA1 · RA2»): no es el título.
    const RESOURCE_CELL_RE = /^(?:\d{1,3}\s+(?:videos?|actividad(?:es)?|h5p|lecturas?|podcasts?|casos?|talleres?|presentaci\w+|recursos?|evaluaci\w+|quiz\w*)\b|\d{1,4}(?:[.,]\d{1,2})?\s*(?:h|horas?)\b)/i;
    let header: string[] | null = null;
    const titleOfRow = (cells: string[]): { title: string; rest: string[] } | null => {
      const cs = cells.map(collapse);
      if (!cs.length) return null;
      const codeIdx = CHAPTER_ROW_RE.test(cs[0]) && cs[0].split(/\s+/).length <= 2 ? 0 : -1;
      let idx = -1;
      if (header) {
        const h = header.findIndex((x, j) => j !== codeIdx && /^(contenidos?|temas?|titulo|nombre|descripcion|capitulo)\b/.test(x) && !!cs[j]);
        if (h >= 0) idx = h;
      }
      if (idx < 0) idx = cs.findIndex((c, j) => j !== codeIdx && !!c && !RESOURCE_CELL_RE.test(c) && !GROUP_ALL_RE.test(c.replace(/[·,;]/g, ' ')));
      if (idx < 0) return null;
      // Código y título en la misma celda («1.1 Conceptos…»): el título sin el código.
      const title = codeIdx < 0 ? cs[idx].replace(/^(?:cap[ií]tulo\s+)?\d{1,2}\.\d{1,2}\.?\s+/i, '') : cs[idx];
      return { title, rest: cs.filter((_c, j) => j !== idx && j !== codeIdx) };
    };
    const PURPOSE_RE = /^(prop[oó]sito|objetivo)( del m[oó]dulo)?\s*:/i;
    const isBlockHeading = (l: SourceLine, t: string) => (!!l.heading || (t.split(/\s+/).length <= 8 && !/[.;:]$/.test(t))) && SKIP_RE.test(t);
    const units: { title: string; hours: number | null; line: SourceLine; contents: Item[]; refs: string[] }[] = [];
    const loose: Item[] = [];
    let unit: (typeof units)[number] | null = null;
    let chapter: { title: string; topics: string[]; lines: SourceLine[]; refs?: string[] } | null = null;
    let skipping = false;
    const flush = () => {
      if (unit && chapter) {
        const text = chapter.topics.length ? `${chapter.title}: ${chapter.topics.join('; ')}` : chapter.title;
        // Vínculos de la fila («… | RA1 · RA2») al final, como los lee emitUnits.
        unit.contents.push({ text: chapter.refs && chapter.refs.length ? `${text} (${chapter.refs.join(', ')})` : text, lines: chapter.lines });
      }
      chapter = null;
    };
    for (const l of s.lines) {
      if (isColumnHeaderRow(l)) { header = (l.cells ?? []).map((c) => normKey(c)); continue; }
      const text = collapse((l.cells ? l.cells.filter(Boolean).join(' — ') : l.text).replace(BULLET_RE, ''));
      if (!text) continue;
      // Fila de la tabla de capítulos (con el código del capítulo, o sin código dentro de una tabla con encabezado).
      if (l.cells && l.cells.length >= 2 && !MOD_RE.test(text)) {
        const row = titleOfRow(l.cells);
        if (row && SKIP_RE.test(row.title)) { flush(); skipping = true; continue; }
        if (row && (CHAPTER_ROW_RE.test(collapse(l.cells[0])) || header)) {
          flush();
          skipping = false;
          const refs = row.rest.flatMap((c) => refsOf(c).ids);
          chapter = { title: row.title.replace(/[.:]$/, ''), topics: [], lines: [l], ...(refs.length ? { refs } : {}) };
          continue;
        }
      }
      const nm = !l.cells ? /^(?:cap[ií]tulo\s+)?(\d{1,2})\.(\d{1,2})\.?\s+(\S.*)$/i.exec(text) : null;
      if (nm && !/\d\s*(h|horas?)\b|%/.test(nm[3])) {
        flush();
        skipping = false;
        chapter = { title: collapse(nm[3]).replace(/[.:]$/, ''), topics: [], lines: [l] };
        continue;
      }
      const mm = MOD_RE.exec(text) || (!l.cells ? BARE_MODULE_RE.exec(text) : null);
      if (mm && (mm[1] || mm[2])) {
        flush();
        skipping = false;
        // Sin título («Módulo 2»): el módulo se nombra con su número; sin número: con su título.
        const raw = mm[2] || `${/^unidad/i.test(text.replace(/^\d{1,2}[.)]\s+/, '')) ? 'Unidad' : 'Módulo'} ${mm[1]}`;
        const r = refsOf(raw);
        const { text: title, hours } = takeHours(r.rest);
        unit = { title: title || raw, hours, line: l, contents: [], refs: r.ids };
        units.push(unit);
        continue;
      }
      const cm = CH_RE.exec(text);
      if (cm) {
        flush();
        skipping = false;
        chapter = { title: collapse(cm[2]).replace(/[.:]$/, ''), topics: [], lines: [l] };
        continue;
      }
      if (PURPOSE_RE.test(text)) continue; // propósito del módulo: no es un tema
      // Una oración que EXIGE algo («Cada capítulo tendrá 2 videos.») entre los temas es un requisito (lo lee el lector de
      // requisitos), no un tema del módulo.
      if (!l.cells && /\b(tendr[aá]n?|deber[aá]n?|debe(?:n)?|incluir[aá]n?|contar[aá]n?|se realizar[aá]n?)(?![a-záéíóúñ])/i.test(text) && /\d/.test(text) && /[.;]$/.test(text)) continue;
      if (isBlockHeading(l, text)) { flush(); skipping = true; continue; }
      if (skipping) continue;
      if (chapter) { chapter.topics.push(text.replace(/[.;]$/, '')); chapter.lines.push(l); continue; }
      if (unit) unit.contents.push({ text, lines: [l] });
      else loose.push({ text, lines: [l] });
    }
    flush();
    this.emitUnits(s, units, loose);
  }

  private emitUnits(s: Section, units0: { title: string; hours: number | null; line: SourceLine; contents: Item[]; refs: string[] }[], loose: Item[]): void {
    const section = SECTION_LABEL.contents;
    // Documento con contenido repetido (una tabla resumen y el detalle, la misma unidad en dos páginas): una unidad por
    // título y cada tema una sola vez. Nada se pierde (lo nuevo de la repetición se suma) y nada se duplica.
    const units: typeof units0 = [];
    for (const u of units0) {
      const dedup = (list: Item[]) => list.filter((c, i) => list.findIndex((x) => normKey(x.text) === normKey(c.text)) === i);
      const prev = units.find((x) => normKey(x.title) === normKey(u.title));
      if (!prev) { units.push({ ...u, contents: dedup(u.contents) }); continue; }
      for (const c of u.contents) if (!prev.contents.some((x) => normKey(x.text) === normKey(c.text))) prev.contents.push(c);
      if (prev.hours === null) prev.hours = u.hours;
      prev.refs = [...new Set([...prev.refs, ...u.refs])];
      this.note('DUPLICATE_UNIT', `«${clip(u.title, 80).text}» aparece más de una vez en el documento: se tomó una sola vez, sin repetir sus temas.`);
    }
    if (!units.length && loose.length) {
      units.push({ title: s.heading, hours: null, line: s.headingLine, contents: loose.splice(0), refs: [] });
      (units[0] as any).inferred = true;
    } else if (loose.length) {
      this.note('CONTENTS_BEFORE_FIRST_UNIT', `${loose.length} tema(s) aparecen antes de la primera unidad y quedaron en «Información adicional».`);
      for (const it of loose) this.pushListField('additionalInfo', it.text, it.lines[0], section);
    }
    if (units.length > ACADEMIC_LIMITS.units) this.note('TOO_MANY_UNITS', `El documento trae ${units.length} unidades; se guardaron las primeras ${ACADEMIC_LIMITS.units}.`);
    const base = this.ctx.units.length;
    for (const [i, u] of units.slice(0, ACADEMIC_LIMITS.units - base).entries()) {
      const id = `U${base + i + 1}`;
      if (u.contents.length > ACADEMIC_LIMITS.contentsPerUnit) this.note('TOO_MANY_CONTENTS', `La unidad «${u.title}» trae ${u.contents.length} temas; se guardaron los primeros ${ACADEMIC_LIMITS.contentsPerUnit}.`);
      const contents: UnitContent[] = u.contents.slice(0, ACADEMIC_LIMITS.contentsPerUnit).map((c, j) => {
        const r = refsOf(c.text);
        const text = clip(r.rest || c.text, ACADEMIC_LIMITS.text).text;
        const review = cutReview(c.lines, text);
        return { id: `${id}.${j + 1}`, text, outcomeIds: r.ids.slice(0, ACADEMIC_LIMITS.outcomeIdsPerItem), status: 'found', sources: [this.src(c.lines[0], section)], ...(review ? { review } : {}) };
      });
      if (u.hours !== null && !(u.hours > 0 && u.hours <= 5000)) {
        this.note('VALUE_OUT_OF_RANGE', `La unidad «${clip(u.title, 60).text}» declara ${fmtH(u.hours)} h, fuera del rango admitido; no se usó.`);
        u.hours = null;
      }
      const unit: ThematicUnit = (u as any).inferred
        ? { id, title: clip(u.title, ACADEMIC_LIMITS.title).text, hours: null, outcomeIds: [], contents, status: 'inferred', sources: [this.src(u.line, section)], basis: 'el documento lista los contenidos sin agruparlos en unidades: se usan como una sola unidad con el título de la sección' }
        : { id, title: clip(u.title, ACADEMIC_LIMITS.title).text, hours: u.hours, outcomeIds: [...new Set(u.refs)].slice(0, ACADEMIC_LIMITS.outcomeIdsPerItem), contents, status: 'found', sources: [this.src(u.line, section)] };
      this.ctx.units.push(unit);
    }
  }

  // ── Horas ──

  private parseHours(s: Section): void {
    const section = SECTION_LABEL[s.key];
    const entries: { label: string; text: string; line: SourceLine; key: SectionKey }[] = [];
    if (s.inline) entries.push({ label: s.heading, text: s.inline, line: s.headingLine, key: s.key });
    for (const l of s.lines) {
      if (l.cells) {
        const cells = l.cells.map(collapse).filter(Boolean);
        const numIdx = cells.findIndex((c) => /^\d{1,4}(?:[.,]\d{1,2})?(?:\s*(?:-|–|—|a)\s*\d{1,4}(?:[.,]\d{1,2})?)?\s*(?:h|horas?)?$/i.test(c));
        if (numIdx > 0) entries.push({ label: cells.slice(0, numIdx).join(' '), text: cells[numIdx], line: l, key: 'hours' });
        continue;
      }
      const colon = l.text.indexOf(':');
      if (colon > 0) entries.push({ label: l.text.slice(0, colon), text: l.text.slice(colon + 1), line: l, key: 'hours' });
      else if (HOURS_RE.test(l.text) || /^\s*\d{1,4}(?:[.,]\d{1,2})?\s*$/.test(l.text)) {
        // Sin etiqueta propia («48 horas» debajo de «Total de horas»): manda el encabezado de la sección.
        const label = collapse(l.text.replace(HOURS_RE, '').replace(/^\s*\d{1,4}(?:[.,]\d{1,2})?\s*$/, ''));
        entries.push({ label: label || s.heading, text: l.text, line: l, key: label ? 'hours' : s.key });
      }
    }
    for (const e of entries) {
      const kind = hoursKindOf(e.key, e.label, e.text);
      if (!kind) continue;
      // Una oración («La duración requerida … es de 40–44 horas…») no es el rótulo de un componente de horas.
      if (kind !== 'total' && kind !== 'weekly' && kind !== 'weeks' && kind !== 'credits' && collapse(e.label).split(/\s+/).length > 8) continue;
      const span = kind === 'credits' || kind === 'weeks' ? null : hoursSpanOf(e.text) ?? hoursSpanOf(`${e.text.replace(/\s+$/, '')} h`);
      const m = kind === 'credits' || kind === 'weeks' ? /(\d{1,3}(?:[.,]\d{1,2})?)/.exec(e.text) : span ? [span.raw, String(span.value)] : /^\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*$/.exec(e.text);
      if (!m) continue;
      const value = num(m[1]);
      if (!Number.isFinite(value)) continue;
      // Horas por módulo / unidad («Módulo 1 | 13–15 h»): son las horas de esa unidad, no un componente del total.
      const um = /^(?:m[oó]dulo|unidad)\s+(\d{1,2})$/i.exec(collapse(e.label));
      if (um && kind !== 'credits' && kind !== 'weeks') {
        this.unitHours.push({ index: Number(um[1]), value, line: e.line });
        continue;
      }
      // Fuera del rango del modelo: el dato queda «missing» con una nota (nunca rechaza el documento entero).
      const max = kind === 'credits' ? 60 : kind === 'weeks' ? 104 : 5000;
      if (value <= 0 || value > max) {
        this.note('VALUE_OUT_OF_RANGE', `«${clip(e.line.text, 80).text}»: ${fmtH(value)} está fuera del rango admitido (hasta ${max}); no se usó.`);
        continue;
      }
      const src = this.src(e.line, section);
      const show = (x: number) => String(x);
      if (kind === 'total') this.ctx.hours.total = this.setTotalHours(value, span && span.min !== undefined ? { min: span.min, max: span.max as number } : null, src);
      else if (kind === 'weekly') this.ctx.hours.weekly = this.setFound('hours.weekly', this.ctx.hours.weekly, value, src, show);
      else if (kind === 'weeks') this.ctx.hours.weeks = this.setFound('hours.weeks', this.ctx.hours.weeks, value, src, show);
      else if (kind === 'credits') this.ctx.hours.credits = this.setFound('hours.credits', this.ctx.hours.credits, value, src, show);
      else {
        const label = clip(collapse(e.label.replace(/[:|]+$/, '')) || SECTION_LABEL[s.key], ACADEMIC_LIMITS.title).text;
        const dup = this.ctx.hours.components.find((c) => normKey(c.label) === normKey(label));
        if (dup) {
          if (dup.hours !== value) this.addConflict(`hours.components.${dup.id}`, [{ value: String(dup.hours), source: dup.sources[0] }, { value: String(value), source: src }]);
          continue;
        }
        if (this.ctx.hours.components.length >= ACADEMIC_LIMITS.components) continue;
        const comp: HoursComponent = { id: `H${this.ctx.hours.components.length + 1}`, label, kind, hours: value, status: 'found', sources: [src] };
        this.ctx.hours.components.push(comp);
      }
    }
  }

  // ── Evaluación ──

  private parseEvaluation(s: Section): void {
    // Con una tabla de evaluaciones, la oración que la presenta («El curso tendrá 3 evaluaciones parciales…») describe la
    // estrategia: no es otra evaluación (sus cantidades las lee el lector de requisitos).
    const hasTable = s.lines.some((l) => l.cells && l.cells.length >= 2 && !isColumnHeaderRow(l));
    for (const it of this.items(s)) {
      if (this.ctx.evaluation.length >= ACADEMIC_LIMITS.evaluation) break;
      if (hasTable && !it.lines[0].cells && it.text.split(/\s+/).length > 12 && /[.;]$/.test(it.text)) continue;
      let pm = PCT_RE.exec(it.text);
      if (pm && !(num(pm[1]) >= 0 && num(pm[1]) <= 100)) {
        this.note('VALUE_OUT_OF_RANGE', `«${clip(it.text, 80).text}»: un peso de ${pm[1]} % no es válido; la actividad quedó sin peso.`);
        pm = null;
      }
      const r = refsOf(it.text.replace(PCT_RE, ''));
      const instrument = collapse(r.rest.replace(/[—–\-|:;,()]+\s*$/g, '').replace(/^\s*[—–\-|:;,]+/, '').replace(/\(\s*\)/g, ''));
      if (!instrument) continue;
      const ev: EvaluationItem = {
        id: `EV${this.ctx.evaluation.length + 1}`,
        instrument: clip(instrument, ACADEMIC_LIMITS.text).text,
        weightPct: pm ? num(pm[1]) : null,
        outcomeIds: r.ids.slice(0, ACADEMIC_LIMITS.outcomeIdsPerItem),
        status: 'found',
        sources: [this.src(it.lines[0], SECTION_LABEL.evaluation)],
      };
      this.ctx.evaluation.push(ev);
    }
  }

  // ── Bibliografía ──

  private parseBibliography(s: Section): void {
    const lines: SourceLine[] = [...(s.inline ? [{ ...s.headingLine, text: s.inline }] : []), ...s.lines];
    const items: Item[] = [];
    const marked = (l: SourceLine) => !!l.list || !!l.cells || BULLET_RE.test(l.text);
    const anyMarked = lines.some(marked);
    // Una referencia nueva: viñeta, o «Apellido, X.» / «APELLIDO» / «Institución (año)» al inicio.
    const startsRef = (t: string) => /^[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñü'\-]+(?:\s[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñü'\-]+)*,\s/.test(t) || /\(\d{4}[a-z]?\)/.test(t.slice(0, 120));
    for (const l of lines) {
      const text = (l.cells ? l.cells.filter(Boolean).join('. ') : l.text).replace(BULLET_RE, '').trim();
      if (!text || keyOf(text)) continue; // «Bibliografía complementaria» dentro de la sección
      const prev = items[items.length - 1];
      const isNew = anyMarked ? marked(l) : !prev || startsRef(text) || /[.)]$/.test(prev.text);
      if (!isNew && prev) {
        prev.text = `${prev.text} ${text}`;
        prev.lines.push(l);
      } else items.push({ text, lines: [l] });
    }
    for (const it of items) {
      if (this.ctx.bibliography.length >= ACADEMIC_LIMITS.bibliography) {
        this.note('TOO_MANY_REFERENCES', `La bibliografía supera ${ACADEMIC_LIMITS.bibliography} referencias; se guardaron las primeras.`);
        break;
      }
      const b: BibliographyItem = { id: `B${this.ctx.bibliography.length + 1}`, text: clip(it.text, ACADEMIC_LIMITS.text).text, status: 'found', sources: [this.src(it.lines[0], SECTION_LABEL.bibliography)] };
      this.ctx.bibliography.push(b);
    }
  }

  // ── Inferencias declaradas ──

  /**
   * Total de horas. Un RANGO del documento se conserva (`range`) y el valor es su punto medio, declarado como inferido
   * (la meta de diseño), nunca el extremo superior. El mismo dato repetido (ficha y requisitos) suma la fuente; otro
   * valor queda como conflicto (se conserva el primero).
   */
  private setTotalHours(value: number, range: { min: number; max: number } | null, src: SourceRef): Field<number> {
    const cur = this.ctx.hours.total;
    const next: Field<number> = range
      ? { status: 'inferred', value, sources: [src], basis: `el documento da un rango de ${fmtH(range.min)}–${fmtH(range.max)} horas: la meta de diseño es el punto medio`, range }
      : { status: 'found', value, sources: [src] };
    if (cur.status === 'missing') return next;
    const show = (f: Field<number>) => (f.range ? `${fmtH(f.range.min)}–${fmtH(f.range.max)}` : fmtH(f.value as number));
    if (show(cur) === show(next)) {
      return cur.sources.length < ACADEMIC_LIMITS.sourcesPerItem ? { ...cur, sources: [...cur.sources, src] } : cur;
    }
    // Un total exacto dentro del rango ya leído lo precisa (no lo contradice): manda el exacto, el rango queda.
    if (cur.range && !range && value >= cur.range.min && value <= cur.range.max) return { status: 'found', value, sources: [src, ...cur.sources].slice(0, ACADEMIC_LIMITS.sourcesPerItem), range: cur.range };
    if (cur.sources[0]) this.addConflict('hours.total', [{ value: show(cur), source: cur.sources[0] }, { value: show(next), source: src }]);
    return cur;
  }

  /** Horas de cada módulo de una tabla de distribución horaria → la unidad (módulo) del mismo número. */
  private applyUnitHours(): void {
    for (const h of this.unitHours) {
      const u = this.ctx.units[h.index - 1];
      if (!u) continue;
      if (u.hours === null) u.hours = h.value;
      else if (u.hours !== h.value) this.addConflict(`units.${u.id}.hours`, [{ value: fmtH(u.hours), source: u.sources[0] }, { value: fmtH(h.value), source: this.src(h.line, SECTION_LABEL.hours) }]);
    }
  }

  private inferHours(): void {
    const h = this.ctx.hours;
    if (h.total.status !== 'missing') return;
    const comps = h.components.filter((c) => c.kind !== 'other' || h.components.length === 1);
    if (comps.length) {
      const sum = round2(comps.reduce((a, c) => a + c.hours, 0));
      h.total = { status: 'inferred', value: sum, sources: [], basis: `suma de los componentes de horas del documento (${comps.map((c) => `${c.label} ${fmtH(c.hours)} h`).join(' + ')})`.slice(0, ACADEMIC_LIMITS.basis) };
    } else if (h.weekly.value !== null && h.weeks.value !== null) {
      h.total = { status: 'inferred', value: round2(h.weekly.value * h.weeks.value), sources: [], basis: `horas semanales × semanas del documento (${fmtH(h.weekly.value)} × ${fmtH(h.weeks.value)})` };
    }
  }

  private inferLevel(): void {
    const id = this.ctx.identity;
    if (id.educationLevel.status !== 'missing' || id.program.value === null) return;
    const level = educationLevelFromProgram(id.program.value);
    if (!level) return;
    id.educationLevel = { status: 'inferred', value: { text: id.program.value, level }, sources: [...id.program.sources], basis: `el nombre del programa («${id.program.value.slice(0, 80)}») indica el nivel` };
  }
}

// ── Funciones auxiliares puras ──────────────────────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmtH = (n: number) => String(n).replace('.', ',');

/** Ids RA1…: usa los códigos del documento si son únicos y todos están; si no, numera en orden. */
function assignIds(codes: (number | null)[], prefix: 'RA' | 'CO', max: number): string[] {
  const n = Math.min(codes.length, max);
  const valid = codes.slice(0, n);
  const allCoded = valid.every((c) => c !== null && c > 0 && c < 1000) && new Set(valid).size === valid.length;
  return valid.map((c, i) => `${prefix}${allCoded ? c : i + 1}`);
}

/** Vínculos «RA1», «RA 2», «CE3» dentro de un texto → ids normalizados + el texto sin la lista de vínculos. */
export function refsOf(text: string): { ids: string[]; rest: string } {
  const ids: string[] = [];
  const groups: string[] = [];
  for (const m of text.matchAll(GROUP_PAREN_G)) groups.push(m[1]);
  const tail = GROUP_TAIL_RE.exec(text);
  if (tail) groups.push(tail[1]);
  if (GROUP_ALL_RE.test(text)) groups.push(text);
  for (const g of groups) {
    for (const m of g.matchAll(CODE_G)) ids.push(/^R/i.test(m[1]) ? `RA${Number(m[2])}` : `CO${Number(m[2])}`);
  }
  for (const m of text.matchAll(OUTCOME_REF_G)) ids.push(`RA${Number(m[2])}`);
  const rest = collapse(text.replace(GROUP_PAREN_G, '').replace(GROUP_TAIL_RE, '').replace(GROUP_ALL_RE, ''));
  // Orden canónico (review N5): RA antes que CO, por número (RA2 antes que RA10).
  return { ids: [...new Set(ids)].sort((a, b) => (a.startsWith('RA') ? 0 : 1) - (b.startsWith('RA') ? 0 : 1) || Number(a.slice(2)) - Number(b.slice(2))), rest };
}

/**
 * ¿El documento muestra este texto cortado? Sí si alguna de sus líneas sale de la página (PDF) o si termina a mitad de
 * frase (coma, conector o artículo al final). Devuelve el aviso para el docente o null.
 */
function cutReview(lines: SourceLine[], text: string): string | null {
  const t = collapse(text);
  const dangling = /(?:,|\b(?:y|o|e|u|de|del|la|las|el|los|en|con|a|al|para|por|que|su|sus|un|una|ni|se))$/i.test(t);
  if (lines.some((l) => l.clipped) || dangling) {
    return 'El texto parece cortado en el documento (no termina la frase): confírmalo o complétalo.';
  }
  return null;
}
function withReview<T>(f: Field<T>, _text: string, review: string | null): Field<T> {
  if (!review || f.status === 'missing' || f.review) return f;
  // Solo si el valor guardado es el cortado (no si otra fuente ya trajo el texto completo).
  return { ...f, review };
}

function takeHours(text: string): { text: string; hours: number | null } {
  const span = hoursSpanOf(text);
  if (!span) return { text: collapse(text), hours: null };
  return { text: collapse(text.replace(span.raw, '').replace(/\(\s*\)/g, '').replace(/[\s:.\-–—(]+$/, '')), hours: span.value };
}

/** Una celda de tabla con varios temas («a; b; c» o «• a • b») → temas separados. */
function splitContentCell(t: string): string[] {
  const parts = t.split(/\s*(?:;|•|▪|◦|\s-\s)\s*/).map(collapse).filter((x) => x.length > 1);
  return parts.length ? parts : [t];
}

function hoursKindOf(key: SectionKey, label: string, text: string): 'total' | 'weekly' | 'weeks' | 'credits' | HoursComponentKind | null {
  if (key === 'hoursTotal') return 'total';
  if (key === 'hoursWeekly') return 'weekly';
  // «16 semanas de 4 horas» son semanas (no un total de 4 h); «Duración: 64 horas» sí es el total.
  if (key === 'weeks') return /hora/i.test(text) && !/\d\s*semanas?/i.test(text) ? 'total' : 'weeks';
  if (key === 'credits') return 'credits';
  if (key === 'hoursContact') return 'contact';
  if (key === 'hoursPractice') return 'practice';
  if (key === 'hoursAutonomous') return 'autonomous';
  const l = stripAccents(label).toLowerCase();
  if (/total|intensidad horaria$|^intensidad horaria|carga horaria|^duracion/.test(l)) return /semanal|por semana/.test(l) ? 'weekly' : 'total';
  if (/semanal|por semana/.test(l)) return 'weekly';
  if (/credito/.test(l)) return 'credits';
  if (/semanas?/.test(l) && !/hora/.test(stripAccents(text).toLowerCase())) return 'weeks';
  if (/autonom|independiente/.test(l)) return 'autonomous';
  if (/practic|laboratorio|taller/.test(l)) return 'practice';
  if (/presencial|acompanamiento|teoric|clase|directo|docente|sincronic/.test(l)) return 'contact';
  return HOURS_RE.test(text) && l.trim() ? 'other' : null;
}

export function educationLevelOf(text: string): EducationLevel | null {
  const t = stripAccents(text).toLowerCase();
  if (/posgrado|especializacion|maestria|doctorado|pregrado|universitari|profesional universitari|licenciatura|ingenieria/.test(t)) return 'university';
  if (/tecnico|tecnologic|tecnologo|formacion para el trabajo/.test(t)) return 'technical';
  if (/bachillerato|secundaria|educacion media/.test(t)) return 'secondary';
  if (/primaria|basica primaria/.test(t)) return 'basic';
  if (/formacion continua|corporativ|empresarial|educacion continuada|diplomado/.test(t)) return 'professional';
  return null;
}

function educationLevelFromProgram(program: string): EducationLevel | null {
  const t = stripAccents(program).toLowerCase().trim();
  if (/^(tecnologia|tecnico profesional|tecnico laboral|tecnico)\b/.test(t)) return 'technical';
  if (/^(especializacion|maestria|doctorado)\b/.test(t)) return 'university';
  return null;
}

// ── Orquestación: documentos → contexto ────────────────────────────────────────────────────────────────────

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Lee y extrae 1–5 documentos y los fusiona en orden (lo ya encontrado no se pisa; las diferencias quedan como
 * conflicto). Devuelve un contexto en forma canónica (normalizeAcademicContext) — nunca persiste nada.
 */
export async function extractAcademicContext(inputs: ExtractionInput[]): Promise<ExtractionResult> {
  if (!inputs.length) throw new Error('ACADEMIC_EXTRACT_NO_DOCUMENTS: se necesita al menos un documento');
  if (inputs.length > ACADEMIC_LIMITS.documents) throw new Error(`ACADEMIC_EXTRACT_TOO_MANY: como máximo ${ACADEMIC_LIMITS.documents} documentos`);
  const notes: ExtractionNote[] = [];
  const parts: { doc: AcademicDocument; ex: DocExtraction }[] = [];
  const reqParts: { documentId: string; x: RequirementsExtraction }[] = [];
  let totalLines = 0;
  const sections = new Set<string>();
  for (const [i, input] of inputs.entries()) {
    const docId = `D${i + 1}`;
    const read = await readDocument(input.data, input.name);
    totalLines += read.lines.length;
    const doc: AcademicDocument = {
      id: docId,
      name: collapse(input.name).slice(0, ACADEMIC_LIMITS.name) || docId,
      mediaType: read.mediaType,
      sha256: sha256(input.data),
      bytes: input.data.length,
      pages: read.pages,
      characters: read.characters,
      extractor: { id: EXTRACTOR_ID, version: EXTRACTOR_VERSION },
    };
    const ex = new DocExtraction(docId);
    for (const n of read.notes ?? []) ex.note(n.code, `«${doc.name}»: ${n.message}`);
    if (!read.lines.length) {
      ex.note('DOCUMENT_WITHOUT_TEXT', `«${doc.name}» no tiene texto extraíble (¿PDF escaneado?). Cursia no hace OCR: sube un PDF con texto o un DOCX.`);
    } else {
      ex.run(read);
      if (!ex.found.size) ex.note('NO_SECTIONS_RECOGNIZED', `En «${doc.name}» no se reconoció ninguna sección de un microcurrículo (resultados, contenidos, horas, evaluación…).`);
    }
    for (const k of ex.found) sections.add(k);
    const dangling = ex.ctx.outcomes.length || ex.ctx.competencies.length ? danglingRefs(ex.ctx) : [];
    if (dangling.length) ex.note('UNKNOWN_OUTCOME_REF_IN_DOCUMENT', `«${doc.name}» vincula ${dangling.join(', ')}, que no aparecen entre sus resultados de aprendizaje o competencias: esos vínculos no se guardaron.`);
    notes.push(...ex.notes);
    parts.push({ doc, ex });
    // LOOP 8.6B (review I2): un fallo del lector de requisitos nunca impide leer el documento; se dice en una nota.
    try {
      reqParts.push({ documentId: docId, x: extractRequirements(read.lines, docId) });
    } catch (err) {
      notes.push({ code: 'REQUIREMENTS_NOT_READ', documentId: docId, message: `«${doc.name}»: no pudimos leer sus requisitos explícitos (cantidades de módulos, capítulos, horas…); el resto del documento sí se leyó.` });
      // eslint-disable-next-line no-console
      console.warn(`[requirements] ${docId}: ${err instanceof Error ? err.message : String(err)}`);
      reqParts.push({ documentId: docId, x: { requirementsVersion: 1, requirements: [], groups: [], conflicts: [], ignored: [], multiCourse: false, subjects: [] } });
    }
  }
  const merged = mergeExtractions(parts.map((p) => p.ex.ctx), parts.map((p) => p.doc));
  // Vínculos que, ya fusionados, no apuntan a ningún resultado ni competencia: se quitan con una nota (nunca se guarda
  // un vínculo roto).
  const finalDangling = danglingRefs(merged);
  if (finalDangling.length) {
    notes.push({ code: 'UNKNOWN_OUTCOME_REF_IN_DOCUMENT', documentId: null, message: `Los documentos vinculan ${finalDangling.join(', ')}, que no aparecen entre los resultados de aprendizaje o competencias: esos vínculos no se guardaron.` });
    const known = new Set([...merged.outcomes.map((o) => o.id), ...merged.competencies.map((o) => o.id)]);
    const keep = (ids: string[]) => ids.filter((x) => known.has(x));
    merged.units = merged.units.map((u) => ({ ...u, outcomeIds: keep(u.outcomeIds), contents: u.contents.map((c) => ({ ...c, outcomeIds: keep(c.outcomeIds) })) }));
    merged.evaluation = merged.evaluation.map((e) => ({ ...e, outcomeIds: keep(e.outcomeIds) }));
  }
  return {
    context: normalizeAcademicContext(merged),
    requirements: mergeRequirementExtractions(reqParts),
    notes,
    stats: { documents: inputs.length, lines: totalLines, sectionsFound: [...sections].sort(), providersCalled: 0 },
  };
}

/** Fusión en orden: el primer valor encontrado gana; las listas se concatenan sin repetidos y se renumeran. */
export function mergeExtractions(ctxs: AcademicContextV1[], documents: AcademicDocument[]): AcademicContextV1 {
  const out = emptyAcademicContext();
  out.documents = documents;
  const field = <T>(path: string, pick: (c: AcademicContextV1) => Field<T>, show: (v: T) => string): Field<T> => {
    let cur: Field<T> = missingField<T>();
    for (const c of ctxs) {
      const f = pick(c);
      if (f.status === 'missing') continue;
      if (cur.status === 'missing' || (cur.status === 'inferred' && f.status === 'found')) {
        cur = f;
        continue;
      }
      if (normKey(show(cur.value as T)) !== normKey(show(f.value as T)) && cur.sources[0] && f.sources[0]) {
        const k = out.conflicts.find((x) => x.path === path);
        const vals = [{ value: show(cur.value as T).slice(0, ACADEMIC_LIMITS.title), source: cur.sources[0] }, { value: show(f.value as T).slice(0, ACADEMIC_LIMITS.title), source: f.sources[0] }];
        if (k) {
          if (!k.values.some((v) => normKey(v.value) === normKey(vals[1].value)) && k.values.length < ACADEMIC_LIMITS.sourcesPerItem) k.values.push(vals[1]);
        } else if (out.conflicts.length < ACADEMIC_LIMITS.conflicts) out.conflicts.push({ path, values: vals });
      }
    }
    return cur;
  };
  const s = (x: string) => x;
  const sl = (x: string[]) => x.join('; ');
  const n = (x: number) => String(x);
  out.identity.subjectName = field('identity.subjectName', (c) => c.identity.subjectName, s);
  out.identity.program = field('identity.program', (c) => c.identity.program, s);
  out.identity.educationLevel = field('identity.educationLevel', (c) => c.identity.educationLevel, (x) => x.text);
  out.identity.generalObjective = field('identity.generalObjective', (c) => c.identity.generalObjective, s);
  out.identity.description = field('identity.description', (c) => c.identity.description, s);
  out.learner.profile = field('learner.profile', (c) => c.learner.profile, s);
  out.learner.priorKnowledge = field('learner.priorKnowledge', (c) => c.learner.priorKnowledge, sl);
  out.methodology = field('methodology', (c) => c.methodology, s);
  out.constraints = field('constraints', (c) => c.constraints, sl);
  out.additionalInfo = field('additionalInfo', (c) => c.additionalInfo, sl);
  out.hours.total = field('hours.total', (c) => c.hours.total, n);
  out.hours.weekly = field('hours.weekly', (c) => c.hours.weekly, n);
  out.hours.weeks = field('hours.weeks', (c) => c.hours.weeks, n);
  out.hours.credits = field('hours.credits', (c) => c.hours.credits, n);
  for (const c of ctxs) {
    for (const k of c.conflicts) if (out.conflicts.length < ACADEMIC_LIMITS.conflicts && !out.conflicts.some((x) => x.path === k.path)) out.conflicts.push(k);
  }
  // Listas: el primer documento que trae una lista la define (ids del documento); los siguientes solo agregan elementos
  // nuevos, renumerados después de los existentes. Cada documento lleva su MAPA de ids (su RA1 → el id fusionado, o el
  // id del resultado con el mismo texto) y sus vínculos de unidades / contenidos / evaluación se reescriben con él.
  const seenText = <T extends { text: string }>(list: T[], t: string): T | undefined => list.find((x) => normKey(x.text) === normKey(t));
  for (const c of ctxs) {
    const idMap = new Map<string, string>();
    for (const o of c.outcomes) {
      const same = seenText(out.outcomes, o.text);
      if (same) { idMap.set(o.id, same.id); continue; }
      if (out.outcomes.length >= ACADEMIC_LIMITS.outcomes) continue;
      const id = out.outcomes.some((x) => x.id === o.id) ? nextId(out.outcomes.map((x) => x.id), 'RA') : o.id;
      idMap.set(o.id, id);
      out.outcomes.push({ ...o, id });
    }
    for (const o of c.competencies) {
      const same = seenText(out.competencies, o.text);
      if (same) { idMap.set(o.id, same.id); continue; }
      if (out.competencies.length >= ACADEMIC_LIMITS.competencies) continue;
      const id = out.competencies.some((x) => x.id === o.id) ? nextId(out.competencies.map((x) => x.id), 'CO') : o.id;
      idMap.set(o.id, id);
      out.competencies.push({ ...o, id });
    }
    // Un documento que no define resultados ni competencias (p. ej. el anexo de contenidos de un sílabo partido en dos)
    // se refiere a los ids ya fusionados (review N4): sus vínculos se conservan tal cual.
    const definesOwn = c.outcomes.length > 0 || c.competencies.length > 0;
    const remap = (ids: string[]) => [...new Set(ids.map((x) => (definesOwn ? idMap.get(x) : x)).filter((x): x is string => !!x))];
    if (!out.units.length && c.units.length) {
      out.units = c.units.slice(0, ACADEMIC_LIMITS.units).map((u) => ({ ...u, outcomeIds: remap(u.outcomeIds), contents: u.contents.map((x) => ({ ...x, outcomeIds: remap(x.outcomeIds) })) }));
    }
    if (!out.hours.components.length && c.hours.components.length) out.hours.components = c.hours.components;
    if (!out.evaluation.length && c.evaluation.length) out.evaluation = c.evaluation.map((e) => ({ ...e, outcomeIds: remap(e.outcomeIds) }));
    for (const b of c.bibliography) {
      if (out.bibliography.length >= ACADEMIC_LIMITS.bibliography || seenText(out.bibliography, b.text)) continue;
      out.bibliography.push({ ...b, id: `B${out.bibliography.length + 1}` });
    }
  }
  return out;
}

function nextId(ids: string[], prefix: 'RA' | 'CO'): string {
  const max = ids.reduce((a, x) => Math.max(a, Number(x.slice(prefix.length)) || 0), 0);
  return `${prefix}${max + 1}`;
}

/** Vínculos del documento que apuntan a resultados inexistentes (antes de la fusión): para avisar al docente. */
export function danglingRefs(ctx: AcademicContextV1): string[] {
  const known = new Set([...ctx.outcomes.map((o) => o.id), ...ctx.competencies.map((o) => o.id)]);
  const refs = [...ctx.units.flatMap((u) => [...u.outcomeIds, ...u.contents.flatMap((c) => c.outcomeIds)]), ...ctx.evaluation.flatMap((e) => e.outcomeIds)];
  return [...new Set(refs.filter((r) => !known.has(r)))].sort();
}
