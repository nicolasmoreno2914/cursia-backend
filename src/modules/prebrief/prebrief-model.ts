import { createHash } from 'crypto';
import type { AcademicContextV1 } from '../academic-context/academic-context';
import type { CourseFacts, FactSource } from '../course-facts/course-facts';
import { CourseFormatDef, StoredCourseFormat, formatDef, formatFit } from './course-formats';
import { PREBRIEF_CONTEXT_FIELDS, PREBRIEF_REQUIRED_CONTEXT_FIELDS } from './prebrief-context';

/**
 * Prebrief pedagógico · MODELO canónico (los datos que se presentan, se aprueban y se congelan).
 *
 * Fuente única: se arma SOLO con datos que ya existen (pedido del curso, «Lo que sabemos del curso», contexto académico,
 * la recomendación de «Cursia recomienda» con su verificación, los requisitos del documento, el formato S/M/L, los
 * motivos de excepción y las confirmaciones). No guarda nada aparte ni recalcula el diseño: copia lo que ya calculó el
 * servidor. El documento (texto) y el PDF se derivan de ESTE modelo; su huella (`prebriefModelSha`) es la que se aprueba.
 *
 * La huella cubre todo lo que cambia el curso que se generaría: la huella del Blueprint (estructura, perfil, contexto
 * académico, configuración), el formato, los requisitos aplicables y su estado, la alternativa elegida, las excepciones
 * con su motivo y el CONTEXTO DE GENERACIÓN (nombre, sector, país, ciudad, contexto, nivel, tono, objetivo, competencias),
 * que el servidor usa al iniciar el run en lugar del que envía el navegador. No incluye costos ni fechas del servidor.
 */

export const PREBRIEF_MODEL_VERSION = 1 as const;

/** Origen visible de un dato (6 etiquetas para el cliente). */
export type PrebriefOrigin = 'requirement' | 'document' | 'institution' | 'format' | 'cursia' | 'exception';

export interface OriginValue<T> {
  value: T;
  origin: PrebriefOrigin;
  /** Cita del documento (≤ 160) y página, cuando existe. */
  evidence?: { quote: string; page: number | null };
}

export interface PrebriefChapter {
  n: number;
  title: string;
  kind: 'content' | 'practice';
  hours: number;
  video: boolean;
  activity: boolean;
  applicationMinutes: number | null;
  outcomeIds: string[];
  /** Capítulo que todavía propone Cursia (solo en borrador: con cambios pendientes no se puede preparar). */
  proposed: boolean;
}

export interface PrebriefModule {
  n: number;
  title: string;
  hours: number;
  exam: boolean;
  chapters: PrebriefChapter[];
}

export interface PrebriefRequirement {
  key: string;
  text: string;
  status: 'met' | 'exception' | 'not_verifiable' | 'conflict';
  /** Lo que exige (crudo): lo cubre la huella aunque cambie la redacción. */
  raw: { mode: string; value: number | null; valueMax: number | null; shape: number[] | null; obligation: string };
  /** Lo que tiene el diseño (para excepciones y conflictos). */
  actual: string | null;
  detail: string | null;
  evidence: { quote: string; page: number | null } | null;
}

export interface PrebriefException {
  requirementKey: string;
  requirementText: string;
  appliedText: string;
  reason: string | null;
  by: string | null;
  at: string | null;
}

export interface PrebriefDecision {
  field: string;
  label: string;
  value: string;
  /** Valor crudo (código), el que cubre la huella (la etiqueta es redacción). */
  code: string;
  origin: PrebriefOrigin;
}

export interface PrebriefModel {
  prebriefModelVersion: typeof PREBRIEF_MODEL_VERSION;
  course: {
    id: number;
    title: string;
    program: OriginValue<string> | null;
    institution: string | null;
    modality: OriginValue<string>;
    level: OriginValue<string> | null;
    language: string;
  };
  learner: {
    description: OriginValue<string> | null;
    priorKnowledge: OriginValue<string> | null;
  };
  goals: {
    generalObjective: (OriginValue<string> & { label: string }) | null;
    outcomes: { id: string; text: string; origin: PrebriefOrigin; chapters: number[]; evidence?: { quote: string; page: number | null } }[];
    competencies: { id: string; text: string; origin: PrebriefOrigin }[];
  };
  pedagogy: {
    approach: (OriginValue<string> & { id: string; summary: string | null }) | null;
    /** Cómo se trabaja en cada capítulo (directivas reales del enfoque). */
    cycle: string[];
    methodologyFromDocument: OriginValue<string> | null;
  };
  duration: {
    targetHours: OriginValue<number> | null;
    estimatedHours: number;
    format: (OriginValue<string> & { code: string; modules: number; chaptersPerModule: number; hoursMin: number; hoursMax: number }) | null;
    credits: OriginValue<number> | null;
  };
  structure: {
    origin: PrebriefOrigin;
    modules: PrebriefModule[];
    totals: { modules: number; chapters: number; contentChapters: number; practiceChapters: number; hours: number };
  };
  evaluation: {
    moduleExams: { module: number; title: string; outcomeIds: string[] }[];
    finalExam: boolean;
    applicationActivities: { chapter: number; title: string; minutes: number; outcomeIds: string[] }[];
    fromDocument: { text: string; weightPct: number | null; outcomeIds: string[]; origin: PrebriefOrigin }[];
    /** Nota mínima de aprobación del curso (perfil de evaluación), si está definida. */
    passingGrade: number | null;
  };
  resources: {
    videos: number;
    presentations: number;
    interactiveActivities: number;
    applicationActivities: number;
    audiobookChapters: number;
    welcomeAudio: boolean;
    guideBook: boolean;
    moduleExams: number;
    finalExam: boolean;
  };
  requirements: {
    hasDocument: boolean;
    documentNames: string[];
    alternatives: { label: string; selected: string | null; options: string[] }[];
    items: PrebriefRequirement[];
    counts: { total: number; met: number; exceptions: number; notVerifiable: number; conflicts: number };
  };
  decisions: PrebriefDecision[];
  exceptions: PrebriefException[];
  observations: { id: string; text: string }[];
  /** Lo que el servidor congela en el run (reemplaza al contexto que envía el navegador). */
  generationContext: Record<string, string>;
  /** Huella del Blueprint que congelaría hoy la estructura viva (null si no se pudo materializar). */
  blueprintSha256: string | null;
  /**
   * Perfiles del curso que cambian lo que se produce sin pasar por el Blueprint: evaluación (nota mínima, intentos,
   * ponderaciones, finalización) y presentación (tema visual). Su huella entra en la del Prebrief.
   */
  productionProfiles: { assessmentSha256: string | null; presentationSha256: string | null; paletteId: string | null };
}

// ── Entradas ────────────────────────────────────────────────────────────────────────────────────────────────

export interface StoredExceptionReason {
  reason: string;
  /** Texto del requisito al escribir el motivo: si el documento cambia el requisito, el motivo debe revisarse. */
  requirementText: string;
  by: string | null;
  at: string;
}

export interface PrebriefInputs {
  course: { id: number; title: string; institutionName: string | null };
  brief: Partial<Record<string, string>>;
  facts: CourseFacts;
  academic: AcademicContextV1 | null;
  /** Respuesta de CourseDesignService.recommend (la MISMA que ve el docente). */
  card: any;
  format: StoredCourseFormat | null;
  /** Origen de la estructura (8.0): 'document' si la armó Cursia desde el documento. */
  structureSource: 'document' | 'cursia' | 'teacher';
  exceptionReasons: Record<string, StoredExceptionReason>;
  /** Definición del enfoque (registro): resumen y directivas reales (texto). */
  approachInfo: { summary: string | null; cycle: string[] } | null;
  /** Estudiante del perfil vigente (lo que congelará el Blueprint) para alinear el contexto de generación. */
  alignContext: (ctx: Record<string, string>) => Record<string, string>;
  /** Perfiles de evaluación y presentación vigentes (huella y datos), o null si el curso no los tiene. */
  profiles?: { assessment: { sha256: string; data: any } | null; presentation: { sha256: string; data: any } | null; paletteId?: string | null };
}

// ── Utilidades ──────────────────────────────────────────────────────────────────────────────────────────────

const clean = (s: unknown): string => String(s == null ? '' : s).normalize('NFC').replace(/\s+/g, ' ').trim();
const round1 = (n: number) => Math.round(Number(n) * 10) / 10;

export function factOrigin(src: FactSource | null | undefined): PrebriefOrigin {
  switch (src) {
    case 'document': return 'document';
    case 'user':
    case 'profile': return 'institution';
    default: return 'cursia';
  }
}

function evidenceOf(sources: { excerpt?: string; page?: number | null }[] | undefined): { quote: string; page: number | null } | undefined {
  const s = sources && sources[0];
  if (!s || !clean(s.excerpt)) return undefined;
  const q = clean(s.excerpt);
  return { quote: q.length > 160 ? q.slice(0, 157) + '…' : q, page: typeof s.page === 'number' ? s.page : null };
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined) continue;
      out[k] = sortKeysDeep(x);
    }
    return out;
  }
  return v;
}

export function canonicalModelJson(m: PrebriefModel): string {
  return JSON.stringify(sortKeysDeep(m));
}

/**
 * Review BE-1 I5: la huella cubre los DATOS, no la redacción que vive en el código (títulos de Verificación, directivas
 * del enfoque, texto de los requisitos, etiquetas de decisiones): mejorar un texto en un deploy no invalida aprobaciones.
 * Lo redactado queda archivado en el documento de cada versión.
 */
export function hashProjection(m: PrebriefModel): unknown {
  const c = JSON.parse(JSON.stringify(m)) as PrebriefModel;
  c.pedagogy.cycle = [];
  if (c.pedagogy.approach) { c.pedagogy.approach.summary = null; (c.pedagogy.approach as any).value = c.pedagogy.approach.id; }
  c.observations = c.observations.map((o) => ({ id: o.id, text: '' }));
  c.requirements.items = c.requirements.items.map((i) => ({ ...i, text: '', detail: null, actual: null }));
  c.exceptions = c.exceptions.map((e) => ({ ...e, requirementText: '', appliedText: '' }));
  c.decisions = c.decisions.map((d) => ({ ...d, label: '', value: '' })); // el código crudo (`code`) sí entra
  c.course.modality = { ...c.course.modality, value: '' };
  if (c.duration.format) c.duration.format = { ...c.duration.format, value: '' };
  return c;
}

export function prebriefModelSha(m: PrebriefModel): string {
  return createHash('sha256').update(JSON.stringify(sortKeysDeep(hashProjection(m)))).digest('hex');
}

const EXCEPTION_TITLE_RE = /^Excepción al requisito del documento/;

/** Texto del requisito y lo que tiene el diseño, tal como los presenta Verificación. */
function requirementTexts(card: any): Map<string, { text: string; actual: string | null; detail: string | null }> {
  const out = new Map<string, { text: string; actual: string | null; detail: string | null }>();
  const checks: any[] = (card && card.verification && card.verification.checks) || [];
  for (const c of checks) {
    if (typeof c.id !== 'string' || !c.id.startsWith('requirement:')) continue;
    const id = c.id.slice('requirement:'.length);
    const t = String(c.title || '');
    const m = t.match(/:\s*(.+)$/);
    out.set(id, { text: m ? m[1] : t, actual: null, detail: c.detail ? String(c.detail) : null });
  }
  return out;
}

// ── Builder ─────────────────────────────────────────────────────────────────────────────────────────────────

export function buildPrebriefModel(inp: PrebriefInputs, actualTextOf: (requirement: any, check: any) => string, requirementTextOf: (requirement: any) => string): PrebriefModel {
  const { card, facts, academic, brief } = inp;
  const design = card && card.design;
  const fdef: CourseFormatDef | null = inp.format ? formatDef(inp.format.code) : null;

  // Curso.
  const program = academic && academic.identity.program && academic.identity.program.status !== 'missing' && clean(academic.identity.program.value)
    ? { value: clean(academic.identity.program.value), origin: academic.identity.program.status === 'provided' ? 'institution' as const : 'document' as const, evidence: evidenceOf(academic.identity.program.sources) }
    : null;
  const declaredLevel = clean(brief.contexto);
  const level: OriginValue<string> | null = declaredLevel
    ? { value: declaredLevel, origin: 'institution' }
    : facts.educationLevel.value ? { value: clean(facts.educationLevel.value), origin: factOrigin(facts.educationLevel.source) } : null;

  // Estudiante.
  const description = facts.learnerDescription.value ? { value: clean(facts.learnerDescription.value), origin: factOrigin(facts.learnerDescription.source) } : null;
  const prior = facts.priorKnowledge.value ? { value: clean(facts.priorKnowledge.value), origin: factOrigin(facts.priorKnowledge.source) } : null;

  // Objetivo: el general del documento; si no hay, el propósito que escribió la institución (nunca uno inventado).
  const go = academic && academic.identity.generalObjective;
  const generalObjective = go && go.status !== 'missing' && clean(go.value)
    ? { label: 'Objetivo general', value: clean(go.value), origin: go.status === 'provided' ? 'institution' as const : go.status === 'inferred' ? 'cursia' as const : 'document' as const, evidence: evidenceOf(go.sources) }
    : clean(brief.obj) ? { label: 'Propósito del curso', value: clean(brief.obj), origin: 'institution' as const } : null;

  // Estructura (la del diseño verificado; con cambios pendientes la preparación se bloquea).
  let chN = 0;
  const modules: PrebriefModule[] = (design ? design.modules : []).map((m: any, mi: number) => {
    const chapters: PrebriefChapter[] = (m.chapters || []).map((c: any) => ({
      n: ++chN,
      title: clean(c.title),
      kind: c.kind === 'practice' ? 'practice' : 'content',
      hours: round1(c.hours || 0),
      video: !!c.videoEnabled,
      activity: !!c.activityEnabled,
      applicationMinutes: c.applicationMinutes ? Number(c.applicationMinutes) : null,
      outcomeIds: Array.isArray(c.outcomeIds) ? [...c.outcomeIds].map(String).sort() : [],
      proposed: !!c.proposed,
    }));
    return { n: mi + 1, title: clean(m.title), hours: round1(chapters.reduce((a, c) => a + c.hours, 0)), exam: !!m.examEnabled, chapters };
  });
  const allCh = modules.flatMap((m) => m.chapters);
  const totals = {
    modules: modules.length,
    chapters: allCh.length,
    contentChapters: allCh.filter((c) => c.kind === 'content').length,
    practiceChapters: allCh.filter((c) => c.kind === 'practice').length,
    hours: round1(design ? design.estimatedHours : 0),
  };

  // Resultados (con los capítulos que los desarrollan).
  const chaptersOf = (id: string) => allCh.filter((c) => c.outcomeIds.includes(id)).map((c) => c.n);
  const academicOutcome = (id: string | null) => (academic && id ? academic.outcomes.find((o) => o.id === id) : undefined);
  const outcomes = ((facts.outcomes.value || []) as any[]).map((o, i) => {
    const id = clean(o.id) || `RA${i + 1}`;
    const ao = academicOutcome(o.id);
    const origin: PrebriefOrigin = o.origin === 'document' ? 'document' : o.origin === 'proposed' ? 'cursia' : 'institution';
    return { id, text: clean(o.text), origin, chapters: chaptersOf(id), ...(ao && origin === 'document' ? { evidence: evidenceOf(ao.sources) } : {}) };
  });
  const compSrc = factOrigin(facts.competencies.source);
  const competencies = ((facts.competencies.value || []) as string[]).map((t, i) => ({ id: `CO${i + 1}`, text: clean(t), origin: compSrc }));

  // Pedagogía.
  const ap = card && card.approach;
  const approachOrigin: PrebriefOrigin = !ap ? 'cursia' : ap.source === 'recommended' ? 'cursia' : ap.source === 'adjusted' ? 'institution'
    : card.suggestedApproach && card.suggestedApproach === ap.id ? 'cursia' : 'institution';
  const approach = ap ? { id: String(ap.id), value: clean(ap.label), origin: approachOrigin, summary: inp.approachInfo ? inp.approachInfo.summary : null } : null;
  const meth = academic && academic.methodology;
  const methodologyFromDocument = meth && meth.status !== 'missing' && clean(meth.value)
    ? { value: clean(meth.value).slice(0, 900), origin: meth.status === 'provided' ? 'institution' as const : 'document' as const, evidence: evidenceOf(meth.sources) }
    : null;

  // Horas.
  const hs = card && card.hours ? card.hours : null;
  const fit = fdef ? formatFit(fdef, modules, hs && typeof hs.target === 'number' ? hs.target : null) : null;
  let hoursOrigin: PrebriefOrigin = 'cursia';
  if (hs) {
    if (hs.source === 'document') hoursOrigin = 'document';
    else if (hs.source === 'requirement') hoursOrigin = 'requirement';
    else if (hs.source === 'user' || hs.source === 'adjusted') hoursOrigin = fdef && hs.target === fdef.targetHours ? 'format' : 'institution';
  }
  const credits = academic && academic.hours.credits && academic.hours.credits.status !== 'missing' && typeof academic.hours.credits.value === 'number'
    ? { value: academic.hours.credits.value, origin: 'document' as const } : null;

  // Requisitos.
  const reqs = card && card.requirements ? card.requirements : null;
  const texts = requirementTexts(card);
  const checkById = new Map<string, any>(((reqs && reqs.checks) || []).map((c: any) => [c.requirementId, c]));
  const items: PrebriefRequirement[] = [];
  const exceptions: PrebriefException[] = [];
  for (const r of ((reqs && reqs.items) || []) as any[]) {
    if (!r.applies || r.obligation !== 'required') continue;
    const c = checkById.get(r.id);
    const vt = texts.get(r.id);
    const text = requirementTextOf(r);
    const sev = c ? c.severity : null;
    const ex = vt && vt.text && EXCEPTION_TITLE_RE.test(String(((card.verification || {}).checks || []).find((x: any) => x.id === `requirement:${r.id}`)?.title || ''));
    let status: PrebriefRequirement['status'];
    if (ex) status = 'exception';
    else if (sev === 'critical') status = 'conflict';
    else if (c && c.status === 'met' && (sev === 'ok' || !sev)) status = 'met';
    else if (c && c.status === 'met') status = 'met';
    else status = 'not_verifiable';
    const actual = c && c.status !== 'not_verifiable' ? actualTextOf(r, c) : null;
    const quote = r.source && clean(r.source.quote) ? { quote: clean(r.source.quote).slice(0, 160), page: typeof r.source.page === 'number' ? r.source.page : null } : null;
    items.push({ key: String(r.key), text, status, raw: { mode: String(r.mode), value: typeof r.value === 'number' ? r.value : null, valueMax: typeof r.valueMax === 'number' ? r.valueMax : null, shape: Array.isArray(r.shape) ? r.shape.map(Number) : null, obligation: String(r.obligation) }, actual, detail: status === 'not_verifiable' && c && c.note ? clean(c.note) : null, evidence: quote });
    if (status === 'exception') {
      const saved = inp.exceptionReasons[String(r.key)];
      const valid = saved && saved.requirementText === text && clean(saved.reason).length > 0;
      exceptions.push({
        requirementKey: String(r.key), requirementText: text, appliedText: actual || '—',
        reason: valid ? clean(saved.reason) : null, by: valid ? saved.by : null, at: valid ? saved.at : null,
      });
    }
  }
  items.sort((a, b) => a.key.localeCompare(b.key));
  exceptions.sort((a, b) => a.requirementKey.localeCompare(b.requirementKey));
  const counts = {
    total: items.length,
    met: items.filter((i) => i.status === 'met').length,
    exceptions: items.filter((i) => i.status === 'exception').length,
    notVerifiable: items.filter((i) => i.status === 'not_verifiable').length,
    conflicts: items.filter((i) => i.status === 'conflict').length,
  };
  const alternatives = ((reqs && reqs.alternatives) || []).map((g: any) => {
    const opt = (g.options || []).find((o: any) => o.id === g.selected);
    return { label: clean(g.label) || 'Opción', selected: opt ? clean(opt.label) : null, options: (g.options || []).map((o: any) => clean(o.label)) };
  });

  // Estructura: de dónde viene.
  const structureOrigin: PrebriefOrigin = fdef ? 'format'
    : items.some((i) => i.status === 'met' && /^estructura|módulos|capítulos/.test(i.text)) ? 'requirement'
      : inp.structureSource === 'document' ? 'document' : inp.structureSource === 'teacher' ? 'institution' : 'cursia';

  // Evaluación.
  const outcomesOfModule = (m: PrebriefModule) => [...new Set(m.chapters.flatMap((c) => c.outcomeIds))].sort();
  const counts2 = design ? design.counts : null;
  const moduleExamCount = modules.filter((m) => m.exam).length;
  const finalExam = counts2 ? Number(counts2.evaluations) - moduleExamCount > 0 : false;
  const evaluation = {
    moduleExams: modules.filter((m) => m.exam).map((m) => ({ module: m.n, title: m.title, outcomeIds: outcomesOfModule(m) })),
    finalExam,
    applicationActivities: allCh.filter((c) => c.applicationMinutes).map((c) => ({ chapter: c.n, title: c.title, minutes: c.applicationMinutes as number, outcomeIds: c.outcomeIds })),
    fromDocument: (academic ? academic.evaluation : []).map((e) => ({
      text: clean(e.instrument), weightPct: typeof e.weightPct === 'number' ? e.weightPct : null, outcomeIds: [...(e.outcomeIds || [])].sort(),
      origin: e.status === 'provided' ? 'institution' as const : 'document' as const,
    })).filter((e) => e.text),
    passingGrade: inp.profiles && inp.profiles.assessment && typeof inp.profiles.assessment.data?.passingGrade === 'number' ? inp.profiles.assessment.data.passingGrade : null,
  };

  // Recursos (lo que materializa el Manifest de este diseño).
  const t = (card && card.manifestTotals) || {};
  const resources = {
    videos: Number(t.videoCount || 0),
    presentations: Number(t.presentationCount || 0),
    interactiveActivities: Number(t.activityCount || 0),
    applicationActivities: Number(t.applicationActivityCount || 0),
    audiobookChapters: Number(t.audiobookChapterCount || 0),
    welcomeAudio: Number(t.audioWelcomeCount || 0) > 0,
    guideBook: allCh.length > 0,
    moduleExams: moduleExamCount,
    finalExam,
  };

  // Decisiones de la institución.
  const decisions: PrebriefDecision[] = [];
  if (fdef) decisions.push({ field: 'format', label: 'Formato del curso', value: `${fdef.label}: ${fdef.modules} módulos × ${fdef.chaptersPerModule} capítulos, ${fdef.hoursMin}–${fdef.hoursMax} horas`, code: fdef.code, origin: 'format' });
  if (hs && (hs.source === 'user' || hs.source === 'adjusted') && typeof hs.target === 'number' && !(fdef && hs.target === fdef.targetHours)) {
    decisions.push({ field: 'hours', label: 'Horas de trabajo del estudiante', value: `${String(hs.target).replace('.', ',')} horas`, code: String(hs.target), origin: 'institution' });
  }
  const dec = reqs && reqs.authority && reqs.authority.decisions ? reqs.authority.decisions : {};
  const AV: Record<string, string> = { less: 'Menos video', recommended: 'Recomendado', more: 'Más video' };
  const AA: Record<string, string> = { auto: 'Donde el diseño las necesite', practice_only: 'Solo en prácticas', none: 'Ninguna' };
  if (dec.audiovisual) decisions.push({ field: 'audiovisual', label: 'Prioridad audiovisual', value: AV[dec.audiovisual] || dec.audiovisual, code: String(dec.audiovisual), origin: 'institution' });
  if (dec.applicationActivities) decisions.push({ field: 'applicationActivities', label: 'Actividades de Aplicación', value: AA[dec.applicationActivities] || dec.applicationActivities, code: String(dec.applicationActivities), origin: 'institution' });
  if (approach && approach.origin === 'institution') decisions.push({ field: 'approach', label: 'Enfoque pedagógico', value: approach.value, code: approach.id, origin: 'institution' });
  if (!fdef && inp.structureSource === 'teacher') decisions.push({ field: 'structure', label: 'Estructura', value: 'La institución definió los módulos y capítulos.', code: 'teacher', origin: 'institution' });
  for (const a of alternatives) if (a.selected) decisions.push({ field: `alternative:${a.label}`, label: a.label === 'Tamaño' ? 'Tamaño elegido del documento' : `Opción elegida: ${a.label}`, value: a.selected, code: a.selected, origin: 'institution' });

  // Observaciones (advertencias de Verificación, sin costo ni excepciones, que ya tienen su sección).
  const observations: { id: string; text: string }[] = [];
  for (const c of ((card && card.verification && card.verification.checks) || []) as any[]) {
    if (c.summary || c.severity !== 'warning' || c.area === 'cost' || EXCEPTION_TITLE_RE.test(String(c.title || ''))) continue;
    observations.push({ id: String(c.id), text: clean(c.title) });
  }
  if (fdef && fit && !fit.structureOk) observations.push({ id: 'format:structure', text: `La estructura (${fit.contentShape.join(', ') || '0'} capítulos de contenido por módulo) no coincide con el ${fdef.label} (${fdef.modules} módulos × ${fdef.chaptersPerModule} capítulos).` });
  if (fdef && fit && !fit.hoursOk) observations.push({ id: 'format:hours', text: `Las horas del diseño están fuera del rango del ${fdef.label} (${fdef.hoursMin}–${fdef.hoursMax} horas).` });
  observations.sort((a, b) => a.id.localeCompare(b.id));

  // Contexto de generación: el pedido guardado, alineado con el estudiante que congela el Blueprint.
  const ctx: Record<string, string> = {};
  for (const k of PREBRIEF_CONTEXT_FIELDS) {
    const v = clean(k === 'nombre' ? brief.nombre || inp.course.title : brief[k]);
    if (v) ctx[k] = v;
  }
  const generationContext = inp.alignContext(ctx);

  return {
    prebriefModelVersion: PREBRIEF_MODEL_VERSION,
    course: {
      id: inp.course.id,
      title: clean(brief.nombre || inp.course.title),
      program,
      institution: inp.course.institutionName ? clean(inp.course.institutionName) : null,
      modality: { value: 'Virtual (aula Moodle)', origin: 'cursia' },
      level,
      language: 'Español',
    },
    learner: { description, priorKnowledge: prior },
    goals: { generalObjective, outcomes, competencies },
    pedagogy: { approach, cycle: inp.approachInfo ? inp.approachInfo.cycle : [], methodologyFromDocument },
    duration: {
      targetHours: hs && typeof hs.target === 'number' ? { value: hs.target, origin: hoursOrigin } : null,
      estimatedHours: totals.hours,
      format: fdef ? { value: fdef.label, origin: 'format', code: fdef.code, modules: fdef.modules, chaptersPerModule: fdef.chaptersPerModule, hoursMin: fdef.hoursMin, hoursMax: fdef.hoursMax } : null,
      credits,
    },
    structure: { origin: structureOrigin, modules, totals },
    evaluation,
    resources,
    requirements: {
      hasDocument: !!(facts.document && facts.document.present),
      documentNames: facts.document ? [...facts.document.names] : [],
      alternatives,
      items,
      counts,
    },
    decisions,
    exceptions,
    observations,
    generationContext,
    blueprintSha256: card && card.blueprintSha256 ? String(card.blueprintSha256) : null,
    productionProfiles: {
      assessmentSha256: inp.profiles && inp.profiles.assessment ? String(inp.profiles.assessment.sha256) : null,
      presentationSha256: inp.profiles && inp.profiles.presentation ? String(inp.profiles.presentation.sha256) : null,
      // Sin perfil de presentación, Gamma y el empaque toman la paleta de courses.metadata (review BE-2 I1).
      paletteId: inp.profiles && inp.profiles.paletteId ? String(inp.profiles.paletteId) : null,
    },
  };
}

/** Campos obligatorios del contexto de generación que faltan. */
export function missingContextFields(m: PrebriefModel): string[] {
  return PREBRIEF_REQUIRED_CONTEXT_FIELDS.filter((k) => !m.generationContext[k]);
}

// ── Diferencias entre versiones (texto para el docente) ─────────────────────────────────────────────────────

export function diffModels(prev: PrebriefModel, next: PrebriefModel): string[] {
  const out: string[] = [];
  const eq = (a: unknown, b: unknown) => JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
  const h = (x: { value: number } | null) => (x ? `${String(x.value).replace('.', ',')} h` : 'sin horas');
  if (prev.course.title !== next.course.title) out.push(`Nombre del curso: «${prev.course.title}» → «${next.course.title}»`);
  if (!eq(prev.duration.targetHours, next.duration.targetHours)) out.push(`Horas: ${h(prev.duration.targetHours)} → ${h(next.duration.targetHours)}`);
  if (!eq(prev.duration.format, next.duration.format)) out.push(`Formato: ${prev.duration.format ? prev.duration.format.value : 'sin formato'} → ${next.duration.format ? next.duration.format.value : 'sin formato'}`);
  const shape = (m: PrebriefModel) => m.structure.modules.map((x) => x.chapters.length).join(', ');
  if (prev.structure.totals.modules !== next.structure.totals.modules || shape(prev) !== shape(next)) {
    out.push(`Estructura: ${prev.structure.totals.modules} módulos (${shape(prev)} capítulos) → ${next.structure.totals.modules} módulos (${shape(next)} capítulos)`);
  } else if (!eq(prev.structure.modules, next.structure.modules)) {
    out.push('Estructura: cambiaron títulos, horas o recursos de algunos capítulos');
  }
  if (!eq(prev.goals.outcomes.map((o) => o.text), next.goals.outcomes.map((o) => o.text))) out.push('Resultados de aprendizaje');
  if (!eq(prev.goals.competencies, next.goals.competencies)) out.push('Competencias');
  if (!eq(prev.goals.generalObjective, next.goals.generalObjective)) out.push('Objetivo general');
  if (!eq(prev.learner, next.learner)) out.push('Público objetivo');
  if (!eq(prev.pedagogy.approach, next.pedagogy.approach)) out.push(`Enfoque: ${prev.pedagogy.approach ? prev.pedagogy.approach.value : '—'} → ${next.pedagogy.approach ? next.pedagogy.approach.value : '—'}`);
  if (!eq(prev.evaluation, next.evaluation)) out.push('Estrategia de evaluación');
  if (!eq(prev.resources, next.resources)) out.push('Recursos previstos');
  if (!eq(prev.requirements, next.requirements)) out.push('Requisitos del documento o su cumplimiento');
  if (!eq(prev.exceptions, next.exceptions)) out.push('Excepciones al documento o sus motivos');
  if (!eq(prev.decisions, next.decisions)) out.push('Decisiones de la institución');
  if (!eq(prev.productionProfiles, next.productionProfiles)) out.push('Configuración de evaluación o de presentación del curso');
  if (!eq(prev.generationContext, next.generationContext)) {
    const ks = [...new Set([...Object.keys(prev.generationContext), ...Object.keys(next.generationContext)])].filter((k) => prev.generationContext[k] !== next.generationContext[k]).sort();
    out.push(`Datos del curso para producir: ${ks.join(', ')}`);
  }
  if (prev.blueprintSha256 !== next.blueprintSha256 && !out.length) out.push('Configuración del diseño (perfil o contexto académico)');
  if (!out.length && !eq(prev, next)) out.push('Otros datos de la propuesta');
  return out;
}
