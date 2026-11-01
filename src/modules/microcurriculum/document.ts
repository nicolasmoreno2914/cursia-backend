import { identificationFromAnswers, resolveTotalHours } from './answers';
import {
  BloomEs, INSTITUTION_TYPES, InstitutionType, MC_LIMITS, McBibliography, McEvaluation, McIdentification, McOrigin, McOutcome, McUnit, MicrocurriculumAnswers,
  MicrocurriculumV1, MICROCURRICULUM_VERSION, MODALITIES, Modality, PROVENANCE_FIELDS, ProvenanceField,
} from './microcurriculum.types';

/**
 * r81 · Del JSON de la herramienta (o de una edición del docente) a `MicrocurriculumV1`. Coerción de TIPOS sin
 * inventar contenido: lo que no cumple el esquema queda tal cual (o vacío) y lo señala el validador (V8). Solo se
 * rechaza (`MicrocurriculumOutputError`) una salida inservible: sin resultados, unidades o evaluación.
 */

export class MicrocurriculumOutputError extends Error {
  constructor(readonly problems: string[]) {
    super(`MICROCURRICULUM_OUTPUT_INVALID: ${problems.slice(0, 8).join('; ')}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const collapse = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const text = (v: unknown, max: number = MC_LIMITS.text): string => (typeof v === 'string' ? collapse(v).slice(0, max) : typeof v === 'number' ? String(v) : '');
const texts = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.map((x) => text(x)).filter(Boolean).slice(0, max) : []);
const hours = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
};
const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 104 ? v : null);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => (x as string).trim().toUpperCase()).filter(Boolean).slice(0, 20) : []);

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function bloomOf(v: unknown): BloomEs {
  const s = typeof v === 'string' ? stripAccents(v).toLowerCase().trim() : '';
  return s as BloomEs; // fuera de BLOOM → lo marca V8 (no se adivina un nivel)
}

function outcome(v: unknown): McOutcome {
  const o = isObj(v) ? v : {};
  return { id: text(o.id, 12).toUpperCase(), text: text(o.text), verb: text(o.verb, 60), bloom: bloomOf(o.bloom), condition: text(o.condition), criterion: text(o.criterion) };
}
function unit(v: unknown): McUnit {
  const u = isObj(v) ? v : {};
  const h = isObj(u.hours) ? u.hours : {};
  const w = isObj(u.weeks) ? u.weeks : null;
  const from = w ? intOrNull(w.from) : null;
  const to = w ? intOrNull(w.to) : null;
  return {
    id: text(u.id, 12).toUpperCase(),
    title: text(u.title, 300),
    contents: texts(u.contents, 40),
    outcomeIds: ids(u.outcomeIds),
    hours: { contact: hours(h.contact), practice: hours(h.practice), autonomous: hours(h.autonomous) },
    weeks: from !== null && to !== null ? { from, to } : null,
    strategy: text(u.strategy),
    mainActivity: text(u.mainActivity),
  };
}
function evaluation(v: unknown): McEvaluation {
  const e = isObj(v) ? v : {};
  const p = typeof e.percent === 'string' ? Number(e.percent.replace('%', '').replace(',', '.')) : e.percent;
  return {
    name: text(e.name, 300),
    percent: typeof p === 'number' && Number.isFinite(p) ? Math.round(p * 100) / 100 : 0,
    outcomeIds: ids(e.outcomeIds),
    week: intOrNull(e.week),
    evidence: text(e.evidence),
  };
}
function bibliography(v: unknown): McBibliography {
  if (typeof v === 'string') return { text: text(v), origin: 'sugerida' };
  const b = isObj(v) ? v : {};
  return { text: text(b.text), origin: b.origin === 'docente' ? 'docente' : 'sugerida' };
}

/** Problemas que hacen INSERVIBLE una salida generada (cuentan para el único reintento). */
export function generatedOutputProblems(raw: unknown): string[] {
  if (!isObj(raw)) return ['la salida no es un objeto'];
  const p: string[] = [];
  for (const k of ['outcomes', 'units', 'evaluation']) if (!Array.isArray(raw[k]) || !(raw[k] as unknown[]).length) p.push(`falta la lista «${k}»`);
  for (const k of ['description', 'generalObjective']) if (typeof raw[k] !== 'string' || !String(raw[k]).trim()) p.push(`falta «${k}»`);
  return p;
}

/** Procedencia inicial de un documento generado: lo literal del docente es `docente`; lo redactado, `cursia`. */
export function initialProvenance(answers: MicrocurriculumAnswers, doc: Pick<MicrocurriculumV1, 'bibliography'>): Record<ProvenanceField, McOrigin> {
  const p = Object.fromEntries(PROVENANCE_FIELDS.map((f) => [f, 'cursia'])) as Record<ProvenanceField, McOrigin>;
  p.identification = 'docente';
  if (answers.purpose?.competencies) p.competencies = 'docente';
  if (doc.bibliography.length && doc.bibliography.every((b) => b.origin === 'docente')) p.bibliography = 'docente';
  return p;
}

/** Cuerpo (todo salvo identificación/horas totales/procedencia/reparaciones) desde un objeto crudo. */
function body(raw: Record<string, unknown>) {
  const m = isObj(raw.methodology) ? raw.methodology : {};
  return {
    description: text(raw.description),
    justification: text(raw.justification),
    learnerProfile: text(raw.learnerProfile),
    priorKnowledge: text(raw.priorKnowledge),
    generalObjective: text(raw.generalObjective),
    specificObjectives: texts(raw.specificObjectives, 12),
    outcomes: Array.isArray(raw.outcomes) ? raw.outcomes.slice(0, 16).map(outcome) : [],
    competencies: Array.isArray(raw.competencies)
      ? raw.competencies.slice(0, 16).map((c) => (isObj(c) ? { id: text(c.id, 12).toUpperCase(), text: text(c.text) } : { id: '', text: text(c) }))
      : [],
    units: Array.isArray(raw.units) ? raw.units.slice(0, 16).map(unit) : [],
    methodology: { text: typeof raw.methodology === 'string' ? text(raw.methodology) : text(m.text), strategies: texts(m.strategies, MC_LIMITS.listItems) },
    evaluation: Array.isArray(raw.evaluation) ? raw.evaluation.slice(0, 24).map(evaluation) : [],
    resources: texts(raw.resources, MC_LIMITS.resourcesMax),
    bibliography: Array.isArray(raw.bibliography) ? raw.bibliography.slice(0, MC_LIMITS.bibliographyMax).map(bibliography).filter((b) => b.text) : [],
  };
}

/**
 * Documento a partir de la salida de la herramienta: la identificación es SIEMPRE la del paso 1 (literal) y las horas
 * totales, las pedidas. Lanza MicrocurriculumOutputError si la salida es inservible.
 */
export function documentFromGenerated(raw: unknown, answers: MicrocurriculumAnswers): MicrocurriculumV1 {
  const problems = generatedOutputProblems(raw);
  if (problems.length) throw new MicrocurriculumOutputError(problems);
  const b = body(raw as Record<string, unknown>);
  const total = resolveTotalHours(answers.time);
  const doc: MicrocurriculumV1 = {
    version: MICROCURRICULUM_VERSION,
    identification: identificationFromAnswers(answers),
    ...b,
    totalHours: total ?? sumUnitHours(b.units),
    provenance: {} as Record<ProvenanceField, McOrigin>,
    repairs: [],
  };
  doc.provenance = initialProvenance(answers, doc);
  return doc;
}

/** Reemplaza UNA sección con la salida de la herramienta de regeneración (el resto queda fijo). */
export function withRegeneratedSection(doc: MicrocurriculumV1, section: 'outcomes' | 'units' | 'evaluation', raw: unknown): MicrocurriculumV1 {
  const r = isObj(raw) ? raw : {};
  if (!Array.isArray(r[section]) || !(r[section] as unknown[]).length) throw new MicrocurriculumOutputError([`falta la lista «${section}»`]);
  const b = body({ [section]: r[section] } as Record<string, unknown>);
  // El historial de reparaciones se conserva (review P2-1); las de esta regeneración se agregan después.
  return { ...doc, [section]: b[section], provenance: { ...doc.provenance, [section]: 'cursia' }, repairs: (doc.repairs || []).slice() };
}

function identification(v: unknown, prev: McIdentification): McIdentification {
  if (!isObj(v)) return prev;
  const opt = (x: unknown) => { const s = text(x, MC_LIMITS.text); return s ? s : null; };
  return {
    courseName: text(v.courseName, MC_LIMITS.text) || prev.courseName,
    institutionType: (INSTITUTION_TYPES as readonly string[]).includes(v.institutionType as string) ? (v.institutionType as InstitutionType) : prev.institutionType,
    program: opt(v.program),
    term: opt(v.term),
    modality: (MODALITIES as readonly string[]).includes(v.modality as string) ? (v.modality as Modality) : null,
    code: opt(v.code),
    area: opt(v.area),
  };
}

/** JSON con claves ordenadas: el documento guardado en jsonb vuelve con otro orden de claves y no debe contar como edición. */
function canon(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canon).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x as object).sort().map((k) => `${JSON.stringify(k)}:${canon((x as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(x === undefined ? null : x);
}

/**
 * Edición del docente (PATCH `document`): se reconstruye con la misma coerción; los campos de primer nivel que cambian
 * pasan a procedencia `docente`. Las reparaciones registradas se conservan (son historia de la generación). Lanza
 * MicrocurriculumOutputError si el objeto no tiene forma de microcurrículo.
 */
export function documentFromEdit(raw: unknown, prev: MicrocurriculumV1): MicrocurriculumV1 {
  if (!isObj(raw)) throw new MicrocurriculumOutputError(['el documento no es un objeto']);
  const merged: Record<string, unknown> = { ...prev, ...raw };
  const b = body(merged);
  const next: MicrocurriculumV1 = {
    version: MICROCURRICULUM_VERSION,
    identification: identification(merged.identification, prev.identification),
    ...b,
    totalHours: prev.totalHours,
    provenance: { ...prev.provenance },
    repairs: prev.repairs.slice(),
  };
  for (const f of PROVENANCE_FIELDS) {
    if (canon((next as unknown as Record<string, unknown>)[f]) !== canon((prev as unknown as Record<string, unknown>)[f])) next.provenance[f] = 'docente';
  }
  return next;
}

export function sumUnitHours(units: McUnit[]): number {
  return Math.round(units.reduce((a, u) => a + u.hours.contact + u.hours.practice + u.hours.autonomous, 0) * 100) / 100;
}
