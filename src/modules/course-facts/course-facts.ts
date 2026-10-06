// LOOP 8.1 · Una sola fuente de verdad del curso («Lo que sabemos del curso»).
//
// Cada dato tiene UN dueño; el resto lo lee (nunca lo copia):
//   - pedido del curso (lo que dijo el usuario en Datos): courses.metadata.brief — tema, nivel, sector, país…;
//   - documento: contexto académico guardado (course_profiles kind 'academic') — resultados, unidades, horas, nivel;
//   - perfil pedagógico (kind 'pedagogy') — horas objetivo, enfoque y preferencias de diseño;
//   - estructura + su origen (LOOP 8.0).
// Prioridad: corrección explícita del usuario (Avanzado) > documento > pedido del usuario > inferido por Cursia > defecto.
//
// Todo lo de este archivo es puro (sin DB): lo prueba scripts/check-loop81-single-source.js.
import { createHash } from 'crypto';
import type { AcademicContextV1 } from '../academic-context/academic-context';
import type { PedagogicalProfile } from '../pedagogy/pedagogy-profile';

// ── Pedido del curso (brief) ──────────────────────────────────────────────────────────────────────────────

export const BRIEF_KEY = 'brief';
export const BRIEF_VERSION = 1 as const;
/** Mismos nombres que el contexto que se congela al generar (CourseContextDto), para no traducir campos. */
export const BRIEF_FIELDS = ['nombre', 'obj', 'sector', 'pais', 'ciudad', 'contexto', 'nivel', 'tono', 'comp'] as const;
export type BriefField = (typeof BRIEF_FIELDS)[number];
export const BRIEF_MAX: Readonly<Record<BriefField, number>> = Object.freeze({
  nombre: 255, obj: 600, sector: 255, pais: 100, ciudad: 100, contexto: 400, nivel: 255, tono: 255, comp: 255,
});

export interface CourseBrief {
  briefVersion: typeof BRIEF_VERSION;
  fields: Partial<Record<BriefField, string>>;
  updatedAt: string;
}

/** Texto limpio (colapsa espacios); vacío → se omite. Nunca recorta: el DTO ya validó los máximos. */
export function normalizeBriefFields(input: Partial<Record<string, unknown>>): Partial<Record<BriefField, string>> {
  const out: Partial<Record<BriefField, string>> = {};
  for (const k of BRIEF_FIELDS) {
    const v = input[k];
    if (typeof v !== 'string') continue;
    const t = v.replace(/\s+/g, ' ').trim();
    if (t) out[k] = t;
  }
  return out;
}

export function parseBrief(v: unknown): CourseBrief | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.briefVersion !== BRIEF_VERSION || !o.fields || typeof o.fields !== 'object') return null;
  return { briefVersion: BRIEF_VERSION, fields: normalizeBriefFields(o.fields as Record<string, unknown>), updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '' };
}

// Valores de la pantalla Datos (chips) → vocabulario del motor pedagógico.
const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** «Universitario — estudiantes de pregrado…» → 'university'. Desconocido / «Otro» → null. */
export function educationLevelFromBrief(contexto: string | undefined): 'secondary' | 'technical' | 'university' | 'professional' | null {
  const s = strip(String(contexto || '')).trim();
  if (/^bachillerato/.test(s)) return 'secondary';
  if (/^tecnico/.test(s)) return 'technical';
  if (/^(universitario|posgrado)/.test(s)) return 'university';
  if (/^corporativo/.test(s)) return 'professional';
  return null;
}
/** «Básico — sin conocimientos previos» → 'none'; «Intermedio…» → 'intermediate'; «Avanzado…» → 'advanced'. */
export function priorKnowledgeFromBrief(nivel: string | undefined): 'none' | 'intermediate' | 'advanced' | null {
  const s = strip(String(nivel || '')).trim();
  if (/^basico/.test(s)) return 'none';
  if (/^intermedio/.test(s)) return 'intermediate';
  if (/^avanzado/.test(s)) return 'advanced';
  return null;
}

// ── Derivación del perfil pedagógico desde el documento (sin botón) ───────────────────────────────────────

export const PEDAGOGY_DERIVATION_KEY = 'pedagogyDerivation';
/** Campos del perfil pedagógico cuyo dueño es el documento (los que escribe suggestProfileFromContext). */
export function derivedSubset(p: PedagogicalProfile | null): Record<string, unknown> {
  const x = p || ({} as PedagogicalProfile);
  return {
    description: x.learner ? x.learner.description ?? null : null,
    educationLevel: x.learner ? x.learner.educationLevel ?? null : null,
    know: x.learningOutcomes ? x.learningOutcomes.know || [] : [],
    do: x.learningOutcomes ? x.learningOutcomes.do || [] : [],
    competencies: x.learningOutcomes ? x.learningOutcomes.competencies || [] : [],
    targetHours: typeof x.targetHours === 'number' ? x.targetHours : null,
    assessmentMethods: x.assessmentMethods || [],
  };
}
export function derivedSubsetSha(p: PedagogicalProfile | null): string {
  return createHash('sha256').update(JSON.stringify(derivedSubset(p))).digest('hex');
}
export function derivedSubsetIsEmpty(p: PedagogicalProfile | null): boolean {
  const s = derivedSubset(p);
  return s.description === null && s.educationLevel === null && s.targetHours === null &&
    (s.know as unknown[]).length === 0 && (s.do as unknown[]).length === 0 && (s.competencies as unknown[]).length === 0 &&
    (s.assessmentMethods as unknown[]).length === 0;
}

export interface PedagogyDerivation {
  /** Versión del contexto académico de la que salió la última derivación. */
  academicVersion: number;
  /** Huella de los campos derivados tal como Cursia los dejó. */
  subsetSha: string;
}
export function parsePedagogyDerivation(v: unknown): PedagogyDerivation | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.academicVersion !== 'number' || !Number.isInteger(o.academicVersion) || o.academicVersion < 1) return null;
  if (typeof o.subsetSha !== 'string' || !/^[0-9a-f]{64}$/.test(o.subsetSha)) return null;
  return { academicVersion: o.academicVersion, subsetSha: o.subsetSha };
}
/**
 * ¿Cursia puede reescribir los campos del documento en el perfil? Sí si no hay perfil, si esos campos están vacíos o
 * si siguen exactamente como Cursia los dejó en la última derivación. Si el docente los cambió, se respetan.
 */
export function pedagogyDerivedUntouched(current: PedagogicalProfile | null, record: PedagogyDerivation | null): boolean {
  if (!current || derivedSubsetIsEmpty(current)) return true;
  return !!record && record.subsetSha === derivedSubsetSha(current);
}

// ── «Lo que sabemos del curso» ────────────────────────────────────────────────────────────────────────────

export type FactSource = 'document' | 'user' | 'profile' | 'inferred' | 'default';
export interface Fact<T> { value: T | null; source: FactSource | null }
export interface FactConflict { field: string; values: { source: FactSource; value: unknown }[]; message: string }

export interface CourseFacts {
  factsVersion: 1;
  title: Fact<string>;
  topic: Fact<string>;
  educationLevel: Fact<string>;
  priorKnowledge: Fact<string>;
  learnerDescription: Fact<string>;
  outcomes: Fact<{ id: string | null; text: string; domain: string | null }[]>;
  competencies: Fact<string[]>;
  targetHours: Fact<number>;
  units: Fact<number>;
  sector: Fact<string>;
  country: Fact<string>;
  document: { present: boolean; contextVersion: number | null; names: string[] };
  pedagogy: { version: number; primaryApproach: string | null; derivedFromDocument: boolean; derivedUntouched: boolean };
  institutionId: string | null;
  conflicts: FactConflict[];
}

export interface FactsInput {
  courseTitle: string | null;
  institutionId: string | null;
  brief: CourseBrief | null;
  academic: { version: number; context: AcademicContextV1 } | null;
  pedagogy: { version: number; profile: PedagogicalProfile } | null;
  derivation: PedagogyDerivation | null;
}

const PLACEHOLDER_TITLES = ['Curso Virtual', 'Curso sin título', 'Tu curso'];
const fact = <T>(value: T | null | undefined, source: FactSource | null): Fact<T> =>
  value === null || value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)
    ? { value: null, source: null }
    : { value: value as T, source };

/** Primera fuente con valor, en orden de autoridad. */
function first<T>(...cands: Fact<T>[]): Fact<T> {
  for (const c of cands) if (c.value !== null) return c;
  return { value: null, source: null };
}

export function resolveCourseFacts(input: FactsInput): CourseFacts {
  const b = input.brief ? input.brief.fields : {};
  const ctx = input.academic ? input.academic.context : null;
  const ped = input.pedagogy ? input.pedagogy.profile : null;
  const found = <T>(f: { status: string; value: T | null } | undefined): T | null => (f && f.status !== 'missing' ? f.value : null);
  const conflicts: FactConflict[] = [];

  const docLevel = ctx ? found(ctx.identity.educationLevel) : null;
  const briefLevel = educationLevelFromBrief(b.contexto);
  const pedLevel = ped && ped.learner ? ped.learner.educationLevel : null;
  const educationLevel = first<string>(fact(docLevel && docLevel.level, 'document'), fact(pedLevel, 'profile'), fact(briefLevel, 'user'));
  if (docLevel && docLevel.level && briefLevel && docLevel.level !== briefLevel) {
    conflicts.push({ field: 'educationLevel', values: [{ source: 'document', value: docLevel.level }, { source: 'user', value: briefLevel }],
      message: 'El documento indica un nivel educativo distinto del que elegiste en Datos: se usa el del documento.' });
  }

  const docHours = ctx ? found(ctx.hours.total) : null;
  const pedHours = ped && typeof ped.targetHours === 'number' ? ped.targetHours : null;
  const targetHours = first<number>(fact(pedHours, 'profile'), fact(docHours, 'document'));
  if (docHours !== null && pedHours !== null && docHours !== pedHours) {
    conflicts.push({ field: 'targetHours', values: [{ source: 'document', value: docHours }, { source: 'profile', value: pedHours }],
      message: `El documento indica ${docHours} h y el curso tiene ${pedHours} h objetivo.` });
  }

  const docOutcomes = ctx ? ctx.outcomes.map((o) => ({ id: o.id, text: o.text, domain: o.domain })) : [];
  const pedOutcomes = ped && ped.learningOutcomes
    ? [...ped.learningOutcomes.know.map((t) => ({ id: null, text: t, domain: 'know' })), ...ped.learningOutcomes.do.map((t) => ({ id: null, text: t, domain: 'do' }))]
    : [];
  const derivedUntouched = pedagogyDerivedUntouched(ped, input.derivation);
  if (ctx && docOutcomes.length && ped && !derivedUntouched) {
    conflicts.push({ field: 'pedagogy', values: [{ source: 'document', value: input.academic!.version }, { source: 'profile', value: input.pedagogy!.version }],
      message: 'Cambiaste a mano el estudiante, los resultados o las horas del perfil: Cursia no los reemplaza con el documento.' });
  }

  const title = first<string>(
    fact(b.nombre, 'user'),
    fact(ctx ? found(ctx.identity.subjectName) : null, 'document'),
    fact(input.courseTitle && !PLACEHOLDER_TITLES.includes(input.courseTitle.trim()) ? input.courseTitle : null, 'user'),
  );

  return {
    factsVersion: 1,
    title,
    topic: first<string>(fact(b.obj, 'user'), fact(ctx ? found(ctx.identity.generalObjective) : null, 'document')),
    educationLevel,
    priorKnowledge: first<string>(fact(ped && ped.learner ? ped.learner.priorKnowledge : null, 'profile'), fact(priorKnowledgeFromBrief(b.nivel), 'user')),
    learnerDescription: first<string>(fact(ctx ? found(ctx.learner.profile) : null, 'document'), fact(ped && ped.learner ? ped.learner.description : null, 'profile')),
    outcomes: first(fact(docOutcomes, 'document'), fact(pedOutcomes, 'profile')),
    competencies: first<string[]>(fact(ctx ? ctx.competencies.map((c) => c.text) : null, 'document'), fact(ped && ped.learningOutcomes ? ped.learningOutcomes.competencies : null, 'profile')),
    targetHours,
    units: fact(ctx ? ctx.units.length : null, 'document'),
    sector: fact(b.sector, 'user'),
    country: fact(b.pais, 'user'),
    document: { present: !!ctx, contextVersion: input.academic ? input.academic.version : null, names: ctx ? ctx.documents.map((d) => d.name) : [] },
    pedagogy: {
      version: input.pedagogy ? input.pedagogy.version : 0,
      primaryApproach: ped ? ped.primaryApproach : null,
      derivedFromDocument: !!input.derivation && !!ctx && derivedUntouched && !derivedSubsetIsEmpty(ped),
      derivedUntouched,
    },
    institutionId: input.institutionId,
    conflicts,
  };
}

// ── Contexto que se congela al generar: alineado con la fuente única ───────────────────────────────────────

const LEVEL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  basic: 'Educación básica',
  secondary: 'Bachillerato — estudiantes de secundaria y media',
  technical: 'Técnico / Tecnólogo — formación vocacional y técnica, orientada a competencias prácticas',
  university: 'Universitario — estudiantes de pregrado universitario, con rigor académico y pensamiento crítico',
  professional: 'Corporativo — profesionales en ejercicio, con enfoque práctico y aplicación inmediata',
});
const PRIOR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  none: 'Básico — sin conocimientos previos',
  basic: 'Básico — conoce lo esencial',
  intermediate: 'Intermedio — conoce los conceptos fundamentales',
  advanced: 'Avanzado — ya trabaja en el área',
});

/**
 * Un run NUEVO congela el contexto del curso. Para que los prompts nunca reciban dos estudiantes distintos, los campos
 * con un dueño de mayor autoridad que la pantalla Datos se alinean con él:
 *   - contexto educativo ← nivel del DOCUMENTO (si difiere del elegido en Datos);
 *   - nivel de conocimiento ← conocimientos previos del PERFIL (decisión explícita del docente) si difieren;
 *   - objetivo vacío ← objetivo general del documento.
 * Sin documento ni perfil (o sin diferencias) devuelve el contexto TAL CUAL (mismo hash que siempre).
 */
export function alignCourseContextWithFacts<T extends Record<string, any>>(ctx: T, facts: CourseFacts): { context: T; changed: string[] } {
  const out: Record<string, any> = { ...ctx };
  const changed: string[] = [];
  const lvl = facts.educationLevel;
  if (lvl.source === 'document' && lvl.value && educationLevelFromBrief(ctx.contexto) !== lvl.value && LEVEL_TEXT[lvl.value]) {
    out.contexto = LEVEL_TEXT[lvl.value];
    changed.push('contexto');
  }
  const pk = facts.priorKnowledge;
  if (pk.source === 'profile' && pk.value && priorKnowledgeFromBrief(ctx.nivel) !== pk.value && PRIOR_TEXT[pk.value]) {
    out.nivel = PRIOR_TEXT[pk.value];
    changed.push('nivel');
  }
  if ((!ctx.obj || !String(ctx.obj).trim()) && facts.topic.source === 'document' && facts.topic.value) {
    out.obj = facts.topic.value.slice(0, BRIEF_MAX.obj);
    changed.push('obj');
  }
  return { context: (changed.length ? out : ctx) as T, changed };
}
