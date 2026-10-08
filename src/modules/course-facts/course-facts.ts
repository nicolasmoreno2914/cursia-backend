import { isProposed } from '../academic-context/proposed-context';
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
import { ASSESSMENT_METHODS } from '../pedagogy/vocabulary';

// ── Pedido del curso (brief) ──────────────────────────────────────────────────────────────────────────────

export const BRIEF_KEY = 'brief';
export const BRIEF_VERSION = 1 as const;
/** Mismos nombres que el contexto que se congela al generar (CourseContextDto), para no traducir campos. */
/** inferidos (LOOP 8.2): claves del pedido que llenó Cursia (V2 no pregunta sector, país ni tono), separadas por comas. */
export const BRIEF_FIELDS = ['nombre', 'obj', 'sector', 'pais', 'ciudad', 'contexto', 'nivel', 'tono', 'comp', 'inferidos'] as const;
export type BriefField = (typeof BRIEF_FIELDS)[number];
export const BRIEF_MAX: Readonly<Record<BriefField, number>> = Object.freeze({
  nombre: 255, obj: 600, sector: 255, pais: 100, ciudad: 100, contexto: 400, nivel: 255, tono: 255, comp: 255, inferidos: 100,
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

// ── Derivación del perfil pedagógico desde el documento (sin botón), POR CAMPO ───────────────────────────
//
// Review L81 I1: cada campo tiene su dueño. Un campo es «del documento» si está vacío o sigue con el valor que Cursia
// escribió la última vez (huella por campo en courses.metadata.pedagogyDerivation); si el docente lo cambió (o lo
// escribió antes de subir el documento, p. ej. las horas), es «del usuario» y se respeta. Un valor igual al que
// propone el documento cuenta como del documento (cursos anteriores a 8.1 que usaron «Usar en el perfil»).

export const PEDAGOGY_DERIVATION_KEY = 'pedagogyDerivation';
export const DERIVED_FIELDS = ['description', 'educationLevel', 'know', 'do', 'competencies', 'targetHours', 'assessmentMethods'] as const;
export type DerivedField = (typeof DERIVED_FIELDS)[number];
export type FieldOwner = 'document' | 'user' | 'empty';

export function derivedFieldValue(p: PedagogicalProfile | null, f: DerivedField): unknown {
  const x = p || ({} as PedagogicalProfile);
  switch (f) {
    case 'description': return x.learner ? x.learner.description ?? null : null;
    case 'educationLevel': return x.learner ? x.learner.educationLevel ?? null : null;
    case 'know': return x.learningOutcomes ? x.learningOutcomes.know || [] : [];
    case 'do': return x.learningOutcomes ? x.learningOutcomes.do || [] : [];
    case 'competencies': return x.learningOutcomes ? x.learningOutcomes.competencies || [] : [];
    case 'targetHours': return typeof x.targetHours === 'number' ? x.targetHours : null;
    case 'assessmentMethods': return x.assessmentMethods || [];
  }
}
/** Copia el valor del campo de `from` a `into` (perfiles completos, normalizados). */
export function setDerivedField(into: PedagogicalProfile, from: PedagogicalProfile, f: DerivedField): void {
  switch (f) {
    case 'description': into.learner = { ...into.learner, description: from.learner.description }; break;
    case 'educationLevel': into.learner = { ...into.learner, educationLevel: from.learner.educationLevel }; break;
    case 'know': into.learningOutcomes = { ...into.learningOutcomes, know: from.learningOutcomes.know.slice() }; break;
    case 'do': into.learningOutcomes = { ...into.learningOutcomes, do: from.learningOutcomes.do.slice() }; break;
    case 'competencies': into.learningOutcomes = { ...into.learningOutcomes, competencies: from.learningOutcomes.competencies.slice() }; break;
    case 'targetHours':
      if (typeof from.targetHours === 'number') into.targetHours = from.targetHours;
      else delete (into as { targetHours?: number }).targetHours;
      break;
    case 'assessmentMethods': into.assessmentMethods = from.assessmentMethods.slice(); break;
  }
}
const isEmptyValue = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === 'string' && !v.trim());
export function fieldSha(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(v === undefined ? null : v)).digest('hex');
}

export interface PedagogyDerivation {
  /** Versión del contexto académico de la que salió la última derivación. */
  academicVersion: number;
  /** Huella del valor que Cursia escribió en cada campo que es del documento. */
  fields: Partial<Record<DerivedField, string>>;
}
export function parsePedagogyDerivation(v: unknown): PedagogyDerivation | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.academicVersion !== 'number' || !Number.isInteger(o.academicVersion) || o.academicVersion < 1) return null;
  if (!o.fields || typeof o.fields !== 'object' || Array.isArray(o.fields)) return null;
  const fields: Partial<Record<DerivedField, string>> = {};
  for (const f of DERIVED_FIELDS) {
    const sha = (o.fields as Record<string, unknown>)[f];
    if (typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha)) fields[f] = sha;
  }
  return { academicVersion: o.academicVersion, fields };
}

/** Dueño de cada campo del perfil frente al documento (`suggested` = lo que propone el documento vigente, o null). */
export function pedagogyFieldOwners(
  current: PedagogicalProfile | null,
  record: PedagogyDerivation | null,
  /** Lo que propone el documento vigente y, al guardar una versión nueva, también la anterior. */
  suggested: PedagogicalProfile | null | (PedagogicalProfile | null)[],
  /** LOOP 8.3 (review L83 I-3): horas que propuso Cursia (metadata.designHours); con ese valor no son del docente. */
  proposedHours: number | null = null,
): Record<DerivedField, FieldOwner> {
  const out = {} as Record<DerivedField, FieldOwner>;
  const sugs = (Array.isArray(suggested) ? suggested : [suggested]).filter((x): x is PedagogicalProfile => !!x);
  for (const f of DERIVED_FIELDS) {
    const v = derivedFieldValue(current, f);
    const sha = fieldSha(v);
    if (isEmptyValue(v)) out[f] = 'empty';
    else if (f === 'targetHours' && typeof proposedHours === 'number' && v === proposedHours) out[f] = 'empty';
    else if (record && record.fields[f] === sha) out[f] = 'document';
    // Igual al documento SOLO sin registro (perfiles anteriores a 8.1, «Usar en el perfil»). Con registro, un valor que
    // el docente escribió y coincide con el documento sigue siendo suyo (review L81 R2-M4).
    else if (!record && sugs.some((sg) => fieldSha(derivedFieldValue(sg, f)) === sha)) out[f] = 'document';
    else out[f] = 'user';
  }
  return out;
}

/**
 * Perfil derivado: los campos que son del documento (o vacíos) toman el valor que propone el documento; los del
 * usuario se conservan, salvo los que el docente pide explícitamente reemplazar (`force`). Devuelve el perfil, el
 * registro nuevo y qué campos cambiaron.
 */
export function mergeDerivedProfile(
  current: PedagogicalProfile,
  suggested: PedagogicalProfile,
  owners: Record<DerivedField, FieldOwner>,
  academicVersion: number,
  force: readonly DerivedField[] = [],
): { profile: PedagogicalProfile; record: PedagogyDerivation; changed: DerivedField[]; kept: DerivedField[] } {
  const next: PedagogicalProfile = JSON.parse(JSON.stringify(current));
  const record: PedagogyDerivation = { academicVersion, fields: {} };
  const changed: DerivedField[] = [];
  const kept: DerivedField[] = [];
  for (const f of DERIVED_FIELDS) {
    const docValue = derivedFieldValue(suggested, f);
    const takeDoc = owners[f] !== 'user' || force.includes(f);
    if (takeDoc && !isEmptyValue(docValue)) {
      if (f === 'assessmentMethods' && owners[f] === 'user') {
        // Forzado sobre métodos del docente: se SUMAN los del documento (es lo que el panel muestra), en el orden del
        // vocabulario (el del perfil guardado). El campo sigue siendo del docente: no se registra como del documento,
        // así una versión nueva del documento nunca borra sus métodos (review L81 R3-M1).
        const have = new Set<string>([...(current.assessmentMethods || []), ...(suggested.assessmentMethods || [])]);
        const ordered = ASSESSMENT_METHODS.filter((x) => have.has(x));
        if (fieldSha(ordered) !== fieldSha(current.assessmentMethods || [])) changed.push(f);
        next.assessmentMethods = ordered as PedagogicalProfile['assessmentMethods'];
        continue;
      }
      if (fieldSha(derivedFieldValue(current, f)) !== fieldSha(docValue)) changed.push(f);
      setDerivedField(next, suggested, f);
      record.fields[f] = fieldSha(docValue);
    } else if (owners[f] === 'user' && !isEmptyValue(docValue) && fieldSha(docValue) !== fieldSha(derivedFieldValue(current, f))) {
      kept.push(f);
    }
  }
  return { profile: next, record, changed, kept };
}

// ── «Lo que sabemos del curso» ────────────────────────────────────────────────────────────────────────────

export type FactSource = 'document' | 'user' | 'profile' | 'inferred' | 'default';
export type OutcomeOrigin = 'document' | 'proposed' | 'user' | 'profile';
/** Estado de un dato del contexto académico → origen visible (LOOP 8.2: un contexto sin documento no es «del documento»). */
// Review L82 I2: «inferido» del EXTRACTOR (p. ej. objetivos del documento usados como resultados) sigue siendo del
// documento; solo lo que propuso Cursia desde el pedido (PROPOSAL_BASIS) es «propuesto».
function ctxSource(x: { status?: string; basis?: string } | undefined): FactSource {
  const s = x && x.status;
  return s === 'found' ? 'document' : s === 'inferred' ? (isProposed(x as any) ? 'inferred' : 'document') : 'user';
}
function ctxOrigin(x: { status?: string; basis?: string } | undefined): OutcomeOrigin {
  const s = x && x.status;
  return s === 'found' ? 'document' : s === 'inferred' ? (isProposed(x as any) ? 'proposed' : 'document') : 'user';
}
export interface Fact<T> { value: T | null; source: FactSource | null }
export interface FactConflict { field: string; values: { source: FactSource; value: unknown }[]; message: string }

export interface CourseFacts {
  factsVersion: 1;
  title: Fact<string>;
  topic: Fact<string>;
  educationLevel: Fact<string>;
  priorKnowledge: Fact<string>;
  /** LOOP 9: conocimientos previos que lista el documento (temas), tal cual; vacío si no hay documento o no los trae. */
  documentPrerequisites: string[];
  learnerDescription: Fact<string>;
  /** origin (LOOP 8.2): de dónde salió CADA resultado — documento, propuesto por Cursia sin documento o escrito por el docente. */
  outcomes: Fact<{ id: string | null; text: string; domain: string | null; origin: OutcomeOrigin }[]>;
  competencies: Fact<string[]>;
  targetHours: Fact<number>;
  units: Fact<number>;
  /** LOOP 8.2.1 (review M2): sector deducido del documento vigente (programa encontrado), aunque el pedido tenga otro. */
  documentSector: string | null;
  sector: Fact<string>;
  country: Fact<string>;
  /** present: hay un documento leído. proposed (LOOP 8.2): sin documento, con resultados que propuso Cursia sin confirmar. */
  document: { present: boolean; proposed: boolean; contextVersion: number | null; names: string[] };
  pedagogy: {
    version: number;
    primaryApproach: string | null;
    /** Dueño de cada dato del perfil que puede venir del documento. */
    owners: Record<DerivedField, FieldOwner>;
    /** Algún dato del perfil viene del documento. */
    derivedFromDocument: boolean;
    /** Datos del perfil que el docente decidió y difieren del documento (se respetan; «Usar los del documento» los reemplaza). */
    userFieldsDifferingFromDocument: DerivedField[];
  };
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
  /** Lo que el documento vigente propone para el perfil (suggestProfileFromContext), o null sin documento. */
  suggested: PedagogicalProfile | null;
  /** LOOP 8.3: horas que propuso Cursia y el docente aceptó (courses.metadata.designHours). */
  proposedHours?: number | null;
}

const PLACEHOLDER_TITLES = ['Curso Virtual', 'Curso sin título', 'Tu curso', 'Nuevo curso'];
const fact = <T>(value: T | null | undefined, source: FactSource | null): Fact<T> =>
  value === null || value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)
    ? { value: null, source: null }
    : { value: value as T, source };

/** Primera fuente con valor, en orden de autoridad. */
function first<T>(...cands: Fact<T>[]): Fact<T> {
  for (const c of cands) if (c.value !== null) return c;
  return { value: null, source: null };
}

const FIELD_LABEL: Readonly<Record<DerivedField, string>> = Object.freeze({
  description: 'el perfil del estudiante', educationLevel: 'el nivel educativo', know: 'los resultados de saber', do: 'los resultados de saber hacer',
  competencies: 'las competencias', targetHours: 'las horas objetivo', assessmentMethods: 'los métodos de evaluación',
});

/** Qué usa Cursia en cada caso (review L81 R2-M1: el mensaje dice exactamente qué recibe cada parte del curso). */
const FIELD_CONFLICT_MESSAGE: Readonly<Record<DerivedField, (docV: unknown, pedHours: number | null) => string>> = Object.freeze({
  targetHours: (docV: unknown, h: number | null) => `El documento indica ${docV} h y elegiste ${h} h: el diseño usa lo que elegiste.`,
  educationLevel: () => 'Elegiste un nivel educativo distinto del documento: todo el curso usa el que elegiste.',
  description: () => 'Cambiaste el perfil del estudiante: las Actividades de Aplicación usan el tuyo.',
  know: () => 'Cambiaste los resultados de saber: el diseño y las Actividades de Aplicación usan los tuyos; los capítulos se alinean con los resultados del documento.',
  do: () => 'Cambiaste los resultados de saber hacer: el diseño y las Actividades de Aplicación usan los tuyos; los capítulos se alinean con los resultados del documento.',
  competencies: () => 'Cambiaste las competencias: el diseño y las Actividades de Aplicación usan las tuyas; los capítulos se alinean con las del documento.',
  assessmentMethods: () => 'Cambiaste los métodos de evaluación: el diseño usa los tuyos.',
});

/** Prefijos de título que no son el área («Tecnología en…», «Técnico profesional en…»…). */
const DEGREE_PREFIX_RE = /^(?:(?:programa|carrera)\s+(?:(?:acad[eé]mico|de\s+formaci[oó]n)\s+)?(?:(?:de|en)\s+)?)?(?:(?:tecnolog[ií]a|t[eé]cnic[oa](?:\s+(?:profesional|laboral)(?:\s+por\s+competencias)?)?|tecn[oó]log[oa]|tecnol[oó]gico|licenciatura|especializaci[oó]n(?:\s+tecnol[oó]gica)?|maestr[ií]a|doctorado|pregrado|diplomado|profesional)\s+(?:en|de|del)\s+)/i;
/** Valores de «programa» que no son un área (placeholders, códigos, unidades administrativas). */
const NOT_A_SECTOR_RE = /^(?:n\/?a|no\s+aplica|ninguno|ninguna|todos|todas|varios|general|otro|otros|sin\s+programa|transversal|curso)\b|c[oó]digo|snies|facultad|resoluci[oó]n|departamento\s+de|escuela\s+de/i;
/** Encabezados que preceden al nombre del programa («Programa académico de…», «Programa: …», «Ciclo propedéutico en…»). */
const PROGRAM_LEAD_RE = /^(?:programa(?:\s+acad[eé]mico)?\s*(?::|de\s+|en\s+)|ciclo\s+proped[eé]utico\s*(?::|de\s+|en\s+)?)\s*/i;
/** Lo que queda después de quitar el título no puede ser otro título sin área («Tecnología en» suelto). */
const BARE_DEGREE_RE = /^(?:programa|carrera|tecnolog[ií]a|t[eé]cnic[oa]|tecn[oó]log[oa]|licenciatura|especializaci[oó]n|maestr[ií]a|doctorado|pregrado|diplomado|profesional)(?:\s+(?:profesional|laboral|por|competencias|en|de|del))*$/i;

/**
 * LOOP 8.2.1 · Sector a partir del documento, SOLO con evidencia: el programa académico ENCONTRADO en el documento
 * (con su cita), sin el prefijo del título. «Tecnología en Gestión Contable y Financiera» → «Gestión Contable y
 * Financiera». Sin programa encontrado (o si queda vacío o es demasiado largo para ser un sector) → null: nunca se inventa.
 */
export function sectorFromAcademicContext(ctx: AcademicContextV1 | null | undefined): string | null {
  const p = ctx && ctx.identity ? ctx.identity.program : null;
  if (!p || p.status !== 'found' || typeof p.value !== 'string' || !p.sources.length) return null;
  const raw = p.value.replace(/\s+/g, ' ').trim();
  if (NOT_A_SECTOR_RE.test(raw)) return null;
  const rest = raw.replace(PROGRAM_LEAD_RE, '').replace(DEGREE_PREFIX_RE, '').replace(/^[\s:–—-]+/, '').trim();
  if (!rest || BARE_DEGREE_RE.test(rest) || NOT_A_SECTOR_RE.test(rest)) return null;
  // Un «programa» que es una frase larga no es un área: mejor sin dato que un sector inventado.
  if (rest.length < 3 || rest.length > 80 || rest.split(' ').length > 10) return null;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export function resolveCourseFacts(input: FactsInput): CourseFacts {
  const b = input.brief ? input.brief.fields : {};
  const inferredKeys = new Set(String(b.inferidos || '').split(',').map((s) => s.trim()).filter(Boolean));
  const briefSource = (k: BriefField): FactSource => (inferredKeys.has(k) ? 'inferred' : 'user');
  const ctx = input.academic ? input.academic.context : null;
  const ped = input.pedagogy ? input.pedagogy.profile : null;
  const found = <T>(f: { status: string; value: T | null } | undefined): T | null => (f && f.status !== 'missing' ? f.value : null);
  const owners = pedagogyFieldOwners(ped, input.derivation, input.suggested, input.proposedHours ?? null);
  const withDocs = !!ctx && Array.isArray(ctx.documents) && ctx.documents.length > 0;
  const docSector = ctx && withDocs ? sectorFromAcademicContext(ctx) : null;
  const ctxFact = <T>(f: { status: string; value: T | null } | undefined): Fact<T> =>
    f && f.status !== 'missing' ? fact<T>(f.value, ctxSource(f as any)) : { value: null, source: null };
  const conflicts: FactConflict[] = [];

  // Nivel educativo — Review L81 I2: la decisión explícita del docente en el perfil manda; si no, el documento; si no,
  // el pedido (Datos).
  const docLevel = ctx ? found(ctx.identity.educationLevel) : null;
  const briefLevel = educationLevelFromBrief(b.contexto);
  const pedLevel = ped && ped.learner ? ped.learner.educationLevel : null;
  const educationLevel = owners.educationLevel === 'user'
    ? fact<string>(pedLevel, 'profile')
    : first<string>(fact(docLevel && docLevel.level, 'document'), fact(pedLevel, 'profile'), fact(briefLevel, briefSource('contexto')));
  // LOOP 9 (P1-4): un nivel que el usuario no eligió (el valor de partida de «Crear», marcado como inferido) no choca con el
  // documento: el documento manda sin preguntar.
  if (owners.educationLevel !== 'user' && briefSource('contexto') === 'user' && docLevel && docLevel.level && briefLevel && docLevel.level !== briefLevel) {
    conflicts.push({ field: 'educationLevel', values: [{ source: 'document', value: docLevel.level }, { source: 'user', value: briefLevel }],
      message: 'El documento indica un nivel educativo distinto del que elegiste en Datos: se usa el del documento.' });
  }

  const docHours = ctx ? found(ctx.hours.total) : null;
  const pedHours = ped && typeof ped.targetHours === 'number' ? ped.targetHours : null;
  // LOOP 8.2.1: horas que el perfil tiene porque las derivó del documento (dueño = documento) se muestran «del
  // documento»; solo las que decidió el docente son «elegidas por ti» (y si difieren del documento, hay conflicto).
  const hoursProposed = typeof input.proposedHours === 'number' && pedHours === input.proposedHours;
  const targetHours = first<number>(fact(pedHours, hoursProposed ? 'inferred' : withDocs && owners.targetHours === 'document' ? 'document' : 'profile'), fact(docHours, 'document'));

  // Datos del perfil que decidió el docente y difieren de lo que propone el documento: se respetan y se informan.
  const differing: DerivedField[] = [];
  // Solo frente a un DOCUMENTO: sin documento (propuesta de Cursia) lo que decidió el docente manda y no hay con qué chocar.
  if (ctx && withDocs && input.suggested) {
    for (const f of DERIVED_FIELDS) {
      const docV = derivedFieldValue(input.suggested, f);
      // Métodos de evaluación: los del documento se SUMAN; solo hay conflicto si falta alguno del documento.
      const missingDocMethods = f === 'assessmentMethods' && (docV as string[]).some((x) => !((ped && ped.assessmentMethods) || []).includes(x as any));
      const differs = f === 'assessmentMethods' ? missingDocMethods : fieldSha(docV) !== fieldSha(derivedFieldValue(ped, f));
      if (owners[f] === 'user' && !isEmptyValue(docV) && differs) {
        differing.push(f);
        conflicts.push({ field: `pedagogy.${f}`, values: [{ source: 'document', value: docV }, { source: 'profile', value: derivedFieldValue(ped, f) }],
          message: FIELD_CONFLICT_MESSAGE[f](docV, pedHours) });
      }
    }
  }

  const docOutcomes = ctx ? ctx.outcomes.map((o) => ({ id: o.id, text: o.text, domain: o.domain as string | null, origin: ctxOrigin(o) })) : [];
  const srcs = ctx ? ctx.outcomes.map((o) => ctxSource(o)) : [];
  const docOutcomesSource: FactSource = !srcs.length ? 'document' : srcs.every((s) => s === srcs[0]) ? srcs[0] : srcs.includes('document') ? 'document' : 'user';
  const pedOutcomes = ped && ped.learningOutcomes
    ? [...ped.learningOutcomes.know.map((t) => ({ id: null, text: t, domain: 'know' as string | null, origin: 'profile' as OutcomeOrigin })), ...ped.learningOutcomes.do.map((t) => ({ id: null, text: t, domain: 'do' as string | null, origin: 'profile' as OutcomeOrigin }))]
    : [];
  const title = first<string>(
    fact(b.nombre && !PLACEHOLDER_TITLES.includes(String(b.nombre).trim()) ? b.nombre : null, briefSource('nombre')), // LOOP 9.1: nunca un nombre de relleno
    ctx ? ctxFact(ctx.identity.subjectName) : fact<string>(null, null),
    fact(input.courseTitle && !PLACEHOLDER_TITLES.includes(input.courseTitle.trim()) ? input.courseTitle : null, 'user'),
  );

  return {
    factsVersion: 1,
    title,
    topic: first<string>(fact(b.obj, 'user'), ctx ? ctxFact(ctx.identity.generalObjective) : fact<string>(null, null)),
    educationLevel,
    // LOOP 9 (P1-2): el nivel de partida de «Crear» que nadie eligió es de Cursia («inferido»), no «tu pedido».
    priorKnowledge: first<string>(fact(ped && ped.learner ? ped.learner.priorKnowledge : null, 'profile'), fact(priorKnowledgeFromBrief(b.nivel), briefSource('nivel'))),
    documentPrerequisites: ctx ? (found(ctx.learner.priorKnowledge) || []) : [],
    learnerDescription: owners.description === 'user'
      ? fact<string>(ped!.learner.description, 'profile')
      : first<string>(ctx ? ctxFact(ctx.learner.profile) : fact<string>(null, null), fact(ped && ped.learner ? ped.learner.description : null, 'profile')),
    outcomes: first(fact(docOutcomes, docOutcomesSource), fact(pedOutcomes, 'profile')),
    competencies: first<string[]>(fact(ctx ? ctx.competencies.map((c) => c.text) : null, ctx && ctx.competencies.length ? ctxSource(ctx.competencies[0]) : 'document'), fact(ped && ped.learningOutcomes ? ped.learningOutcomes.competencies : null, 'profile')),
    targetHours,
    units: fact(withDocs && ctx ? ctx.units.length : null, 'document'),
    // LOOP 8.2.1: sin sector en el pedido, solo con evidencia del documento (el programa encontrado en él); si no, sin dato.
    sector: first<string>(fact(b.sector, briefSource('sector')), fact(docSector, 'inferred')),
    documentSector: docSector,
    country: fact(b.pais, briefSource('pais')),
    document: { present: withDocs, proposed: !withDocs && !!ctx && ctx.outcomes.some((o) => isProposed(o)), contextVersion: input.academic ? input.academic.version : null, names: ctx ? ctx.documents.map((d) => d.name) : [] },
    pedagogy: {
      version: input.pedagogy ? input.pedagogy.version : 0,
      primaryApproach: ped ? ped.primaryApproach : null,
      owners,
      derivedFromDocument: withDocs && DERIVED_FIELDS.some((f) => owners[f] === 'document'),
      userFieldsDifferingFromDocument: differing,
    },
    institutionId: input.institutionId,
    conflicts,
  };
}

// ── Contexto que se congela al generar: alineado con el perfil CONGELADO en el Blueprint ───────────────────

const LEVEL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  basic: 'Educación básica — primeros niveles de escolaridad',
  secondary: 'Bachillerato — estudiantes de secundaria y media',
  technical: 'Técnico / Tecnólogo — formación vocacional y técnica, orientada a competencias prácticas',
  university: 'Universitario — estudiantes de pregrado universitario, con rigor académico y pensamiento crítico',
  professional: 'Corporativo — profesionales en ejercicio, con enfoque práctico y aplicación inmediata',
});
const PRIOR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  none: 'Básico — sin conocimientos previos',
  basic: 'Básico — conoce lo esencial del tema',
  intermediate: 'Intermedio — conoce los conceptos fundamentales',
  advanced: 'Avanzado — ya trabaja en el área',
});
/** Texto del contexto educativo → nivel (mismo vocabulario que LEVEL_TEXT, ida y vuelta sin pérdida). */
export function contextLevelOf(contexto: string | undefined): string | null {
  const s = strip(String(contexto || '')).trim();
  if (/^educacion basica/.test(s)) return 'basic';
  return educationLevelFromBrief(contexto);
}
/** Texto del nivel de conocimiento → previos (ida y vuelta sin pérdida con PRIOR_TEXT). */
export function contextPriorOf(nivel: string | undefined): string | null {
  const s = strip(String(nivel || '')).trim();
  if (/^basico — conoce/.test(s)) return 'basic';
  return priorKnowledgeFromBrief(nivel);
}

/**
 * Review L81 I2/I3: un run NUEVO congela el contexto del curso alineado con el estudiante que el Blueprint de ESE
 * Manifest congeló para las Actividades de Aplicación (course.applicationContext.learner: nivel y previos, que ya
 * resuelven la autoridad documento / decisión del docente). Así contenido y Actividades de Aplicación reciben el mismo
 * estudiante, y el mismo Manifest produce siempre el mismo contexto (reanudar nunca cambia el hash).
 * Sin estudiante congelado (o sin diferencias) devuelve el contexto TAL CUAL (mismo hash que siempre).
 */
export function alignCourseContextWithSnapshot<T extends Record<string, any>>(ctx: T, frozenLearner: unknown): { context: T; changed: string[] } {
  const l = frozenLearner && typeof frozenLearner === 'object' ? (frozenLearner as Record<string, unknown>) : null;
  if (!l) return { context: ctx, changed: [] };
  const out: Record<string, any> = { ...ctx };
  const changed: string[] = [];
  const lvl = typeof l.educationLevel === 'string' ? l.educationLevel : null;
  if (lvl && LEVEL_TEXT[lvl] && contextLevelOf(ctx.contexto) !== lvl) {
    out.contexto = LEVEL_TEXT[lvl];
    changed.push('contexto');
  }
  const pk = typeof l.priorKnowledge === 'string' ? l.priorKnowledge : null;
  if (pk && PRIOR_TEXT[pk] && contextPriorOf(ctx.nivel) !== pk) {
    out.nivel = PRIOR_TEXT[pk];
    changed.push('nivel');
  }
  return { context: (changed.length ? out : ctx) as T, changed };
}
