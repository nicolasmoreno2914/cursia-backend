import { createHash } from 'crypto';
import { REQUIREMENTS_EXTRACTOR_VERSION, requirementsFor } from './requirements-extractor';
import type { DocumentRequirement, RequirementGroup, RequirementsExtraction, RequirementSelection } from './requirements';

/**
 * LOOP 8.6B · Requisitos explícitos del documento en MODO LECTURA: se guardan, se muestran y se comparan con el diseño,
 * pero no cambian nada (ni la estructura, ni Cursia recomienda, ni la verificación, ni la generación). USD 0.
 *
 * Dónde viven (sin migración, como structureOrigin): courses.metadata
 *   documentRequirements          = { version, entries: [{ key, documents, extraction, at }] } (las últimas 3 lecturas)
 *   documentRequirementsSelection = { key, options: { [groupId]: optionId } } (la alternativa que eligió el docente)
 * `key` es la huella de los documentos (sha256 de cada uno, en orden): los requisitos valen para el contexto académico
 * guardado solo si vienen de esos MISMOS documentos. El contexto (AcademicContextV1) no cambia: su huella y su
 * validación siguen iguales.
 */

export const DOCUMENT_REQUIREMENTS_KEY = 'documentRequirements';
export const REQUIREMENTS_SELECTION_KEY = 'documentRequirementsSelection';
export const DOCUMENT_REQUIREMENTS_VERSION = 1;
const MAX_ENTRIES = 3;
const MAX_REQUIREMENTS = 200;

type Q = { query: (sql: string, params?: unknown[]) => Promise<any> };

export interface RequirementDocumentRef {
  id: string;
  name: string;
  sha256: string;
}

export interface StoredRequirementsEntry {
  key: string;
  documents: RequirementDocumentRef[];
  extractorVersion: number;
  extraction: Omit<RequirementsExtraction, 'ignored'> & { ignoredCount: number };
  at: string;
}

export interface StoredSelection {
  key: string;
  options: Record<string, string>;
}

/** Huella de un conjunto de documentos (en orden). */
export function documentsKey(docs: { sha256: string }[]): string {
  return createHash('sha256').update(docs.map((d) => d.sha256).join(',')).digest('hex').slice(0, 32);
}

/** Varias lecturas (una por documento) → una sola, con ids únicos por documento («D2-RQ3», «D2-G1»). */
export function mergeRequirementExtractions(parts: { documentId: string; x: RequirementsExtraction }[]): RequirementsExtraction {
  if (parts.length === 1) return parts[0].x;
  const out: RequirementsExtraction = { requirementsVersion: 1, requirements: [], groups: [], conflicts: [], ignored: [], multiCourse: false, subjects: [] };
  for (const { documentId, x } of parts) {
    const p = (id: string) => `${documentId}-${id}`;
    out.requirements.push(...x.requirements.map((r) => ({ ...r, id: p(r.id), ...(r.groupId ? { groupId: p(r.groupId) } : {}) })));
    out.groups.push(...x.groups.map((g) => ({
      ...g, id: p(g.id),
      ...(g.requirementIds ? { requirementIds: g.requirementIds.map(p) } : {}),
      ...(g.options ? { options: g.options.map((o) => ({ ...o, requirementIds: o.requirementIds.map(p) })) } : {}),
    })));
    out.conflicts.push(...x.conflicts.map((c) => ({ ...c, requirementIds: c.requirementIds.map(p) })));
    out.ignored.push(...x.ignored);
    out.multiCourse = out.multiCourse || x.multiCourse;
    for (const s of x.subjects) if (!out.subjects.includes(s)) out.subjects.push(s);
  }
  return out;
}

/** Lo que se guarda: sin la lista de cifras ignoradas (puede ser larga), con un tope de requisitos. */
export function storedEntry(documents: RequirementDocumentRef[], x: RequirementsExtraction, at = new Date().toISOString()): StoredRequirementsEntry {
  const kept = x.requirements.slice(0, MAX_REQUIREMENTS);
  const ids = new Set(kept.map((r) => r.id));
  const groups = x.groups
    .map((g) => ({
      ...g,
      ...(g.requirementIds ? { requirementIds: g.requirementIds.filter((id) => ids.has(id)) } : {}),
      ...(g.options ? { options: g.options.map((o) => ({ ...o, requirementIds: o.requirementIds.filter((id) => ids.has(id)) })) } : {}),
    }))
    .filter((g) => (g.requirementIds ? g.requirementIds.length : (g.options || []).some((o) => o.requirementIds.length)));
  const { ignored, ...rest } = x;
  return {
    key: documentsKey(documents),
    documents: documents.map((d) => ({ id: d.id, name: d.name, sha256: d.sha256 })),
    extractorVersion: REQUIREMENTS_EXTRACTOR_VERSION,
    extraction: { ...rest, requirements: kept, groups, ignoredCount: ignored.length },
    at,
  };
}

/** jsonb puede llegar como objeto o como texto (según el driver); las filas, como arreglo o en `.rows`. */
function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : (res && res.rows) || [];
}
function jsonOf(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function parseEntries(v: unknown): StoredRequirementsEntry[] {
  v = jsonOf(v);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  const e = (v as { entries?: unknown }).entries;
  if (!Array.isArray(e)) return [];
  return e.filter((x): x is StoredRequirementsEntry =>
    !!x && typeof x === 'object' && typeof (x as any).key === 'string' && Array.isArray((x as any).documents) &&
    !!(x as any).extraction && Array.isArray((x as any).extraction.requirements) && Array.isArray((x as any).extraction.groups));
}

export function parseSelection(v: unknown): StoredSelection | null {
  v = jsonOf(v);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.key !== 'string' || !o.options || typeof o.options !== 'object' || Array.isArray(o.options)) return null;
  const options: Record<string, string> = {};
  for (const [k, val] of Object.entries(o.options as Record<string, unknown>)) if (typeof val === 'string') options[k] = val;
  return { key: o.key, options };
}

/** Guarda la lectura (las últimas 3 por curso; la misma huella se reemplaza). Atómico por curso. */
export async function storeDocumentRequirements(q: Q, courseId: number, entry: StoredRequirementsEntry): Promise<void> {
  const rows = rowsOf(await q.query(`select metadata -> '${DOCUMENT_REQUIREMENTS_KEY}' as v from public.courses where id = $1 for update`, [courseId]));
  if (!rows.length) return;
  const entries = [entry, ...parseEntries(rows[0].v).filter((e) => e.key !== entry.key)].slice(0, MAX_ENTRIES);
  await q.query(
    `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{${DOCUMENT_REQUIREMENTS_KEY}}', $2::jsonb, true) where id = $1`,
    [courseId, JSON.stringify({ version: DOCUMENT_REQUIREMENTS_VERSION, entries })],
  );
}

export async function loadRequirementsState(q: Q, courseId: number): Promise<{ entries: StoredRequirementsEntry[]; selection: StoredSelection | null }> {
  const rows = rowsOf(await q.query(`select metadata -> '${DOCUMENT_REQUIREMENTS_KEY}' as r, metadata -> '${REQUIREMENTS_SELECTION_KEY}' as s from public.courses where id = $1`, [courseId]));
  if (!rows.length) return { entries: [], selection: null };
  return { entries: parseEntries(rows[0].r), selection: parseSelection(rows[0].s) };
}

export async function writeSelection(q: Q, courseId: number, sel: StoredSelection): Promise<void> {
  await q.query(
    `update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{${REQUIREMENTS_SELECTION_KEY}}', $2::jsonb, true) where id = $1`,
    [courseId, JSON.stringify(sel)],
  );
}

// ── Vista (lo que muestra la interfaz) ──

export type RequirementsState =
  | 'none' //    el contexto guardado no tiene documentos (o no hay contexto)
  | 'current' // requisitos leídos de los MISMOS documentos del contexto guardado
  | 'stale'; //  el contexto tiene documentos, pero no hay una lectura de requisitos de esos documentos (leído antes de 8.6)

export interface RequirementItem extends DocumentRequirement {
  documentName: string | null;
  /** Aplica a este curso con la alternativa elegida (solo lectura: no cambia el diseño). */
  applies: boolean;
}

export interface AlternativeGroupView {
  groupId: string;
  /** «Tamaño» (S/M/L…) u «Opción». */
  label: string;
  options: { id: string; label: string; requirementIds: string[] }[];
  selected: string | null;
}

export interface RequirementsView {
  requirementsViewVersion: 1;
  state: RequirementsState;
  documents: RequirementDocumentRef[];
  multiCourse: boolean;
  subjects: string[];
  items: RequirementItem[];
  groups: RequirementGroup[];
  alternatives: AlternativeGroupView[];
  conflicts: RequirementsExtraction['conflicts'];
  ignoredCount: number;
}

/** Documentos del contexto académico guardado → entrada vigente (o null). */
export function currentEntry(entries: StoredRequirementsEntry[], contextDocs: { sha256: string }[]): StoredRequirementsEntry | null {
  if (!contextDocs.length) return null;
  const key = documentsKey(contextDocs);
  return entries.find((e) => e.key === key) || null;
}

export function selectionFor(entry: StoredRequirementsEntry | null, sel: StoredSelection | null): RequirementSelection {
  if (!entry || !sel || sel.key !== entry.key) return {};
  const options: Record<string, string> = {};
  for (const g of entry.extraction.groups) {
    if (g.relation !== 'oneOf') continue;
    const o = sel.options[g.id];
    if (o && (g.options || []).some((x) => x.id === o)) options[g.id] = o;
  }
  return Object.keys(options).length ? { options } : {};
}

export function buildRequirementsView(entries: StoredRequirementsEntry[], sel: StoredSelection | null, contextDocs: { sha256: string }[]): RequirementsView {
  const entry = currentEntry(entries, contextDocs);
  const state: RequirementsState = !contextDocs.length ? 'none' : entry ? 'current' : 'stale';
  if (!entry) {
    return { requirementsViewVersion: 1, state, documents: [], multiCourse: false, subjects: [], items: [], groups: [], alternatives: [], conflicts: [], ignoredCount: 0 };
  }
  const x = entry.extraction;
  const selection = selectionFor(entry, sel);
  const applying = new Set(requirementsFor({ ...x, ignored: [] }, selection).map((r) => r.id));
  const names = new Map(entry.documents.map((d) => [d.id, d.name]));
  const items: RequirementItem[] = x.requirements.map((r) => ({ ...r, documentName: names.get(r.source.documentId) ?? null, applies: applying.has(r.id) }));
  const alternatives: AlternativeGroupView[] = x.groups.filter((g) => g.relation === 'oneOf').map((g) => {
    const opts = g.options || [];
    const sizes = opts.every((o) => /^(XS|S|M|L|XL)$/.test(o.id));
    return { groupId: g.id, label: sizes ? 'Tamaño' : 'Opción', options: opts.map((o) => ({ id: o.id, label: o.label, requirementIds: o.requirementIds })), selected: (selection.options && selection.options[g.id]) || null };
  });
  return {
    requirementsViewVersion: 1, state, documents: entry.documents, multiCourse: x.multiCourse, subjects: x.subjects,
    items, groups: x.groups, alternatives, conflicts: x.conflicts, ignoredCount: x.ignoredCount || 0,
  };
}

// ── Comparación con el diseño (solo lectura) ──

export interface DesignForRequirements {
  modules: {
    examEnabled: boolean;
    chapters: { kind: string; proposed?: boolean; videoEnabled: boolean; videoPinned?: boolean; activityEnabled: boolean; applicationMinutes: number | null; applicationPinned?: boolean; hours: number }[];
  }[];
  /** counts.evaluations del distribuidor: evaluaciones de módulo + final. */
  evaluations: number;
  targetHours: number | null;
  hoursSource: 'user' | 'adjusted' | 'document' | 'proposed';
  /** El docente cambió la estructura después de que Cursia la armó (o la armó él). */
  structureByTeacher: boolean;
  /** El docente eligió la prioridad audiovisual / el modo de Actividades de Aplicación (Ajustar o lo guardado). */
  audiovisualByTeacher: boolean;
  applicationByTeacher: boolean;
}

export type RequirementCheckStatus = 'met' | 'unmet' | 'not_verifiable';
export type RequirementChooser = 'teacher' | 'document' | 'cursia';

export interface RequirementCheck {
  requirementId: string;
  status: RequirementCheckStatus;
  /** Lo que tiene el diseño: un valor, una forma (estructura) o uno por módulo/capítulo (alcance «cada»). */
  actual: { value?: number | null; shape?: number[]; each?: number[] };
  /** Quién decidió el valor del diseño: el docente («Te estás apartando…»), el documento o Cursia. */
  chosenBy: RequirementChooser;
  /** Por qué no se puede verificar (o una aclaración). */
  note?: string;
}

/** D6: horas exactas con tolerancia ±5 %, mínimo ±1 h. */
export function hoursTolerance(v: number): number {
  return Math.max(0.05 * v, 1);
}

function satisfies(r: DocumentRequirement, a: number, hours: boolean): boolean {
  const v = r.value as number;
  const tol = hours ? hoursTolerance(v) : 0;
  switch (r.mode) {
    case 'exact': return Math.abs(a - v) <= tol + 1e-9;
    case 'min': return a >= v - 1e-9;
    case 'max': return a <= v + 1e-9;
    case 'range': return a >= v - 1e-9 && a <= (r.valueMax ?? v) + 1e-9;
    case 'approx': return Math.abs(a - v) <= Math.max(0.1 * v, 1) + 1e-9;
    default: return false;
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Compara los requisitos que APLICAN con el diseño. Solo informa: nunca cambia el diseño ni bloquea nada.
 *   met / unmet / not_verifiable (algo que Cursia hoy no modela o no puede medir: unidades, «2 videos por capítulo»…).
 */
export function compareRequirements(applicable: DocumentRequirement[], d: DesignForRequirements): RequirementCheck[] {
  const mods = d.modules;
  const chapters = mods.flatMap((m) => m.chapters);
  const proposedStructure = chapters.some((c) => c.proposed);
  const structureBy: RequirementChooser = d.structureByTeacher && !proposedStructure ? 'teacher' : 'cursia';
  const videosBy: RequirementChooser = d.audiovisualByTeacher || chapters.some((c) => c.videoPinned) ? 'teacher' : 'cursia';
  const appBy: RequirementChooser = d.applicationByTeacher || chapters.some((c) => c.applicationPinned) ? 'teacher' : 'cursia';
  const hoursBy: RequirementChooser = d.hoursSource === 'user' || d.hoursSource === 'adjusted' ? 'teacher' : d.hoursSource === 'document' ? 'document' : 'cursia';
  const modExams = mods.filter((m) => m.examEnabled).length;
  const finalExam = Math.max(0, d.evaluations - modExams);
  const out: RequirementCheck[] = [];
  const nv = (r: DocumentRequirement, note: string, chosenBy: RequirementChooser = 'cursia') => out.push({ requirementId: r.id, status: 'not_verifiable', actual: {}, chosenBy, note });
  const one = (r: DocumentRequirement, a: number, chosenBy: RequirementChooser, hours = false) =>
    out.push({ requirementId: r.id, status: satisfies(r, a, hours) ? 'met' : 'unmet', actual: { value: hours ? round1(a) : a }, chosenBy });
  const each = (r: DocumentRequirement, values: number[], chosenBy: RequirementChooser) =>
    out.push({ requirementId: r.id, status: values.length && values.every((a) => satisfies(r, a, false)) ? 'met' : 'unmet', actual: { each: values }, chosenBy });

  for (const r of applicable) {
    const s = r.scope;
    if (r.kind === 'units') { nv(r, 'Las unidades del documento no equivalen automáticamente a módulos: revisa esta lectura.'); continue; }
    if (s.level === 'outcome' || s.level === 'unit' || s.level === 'subject') { nv(r, 'Cursia todavía no mide este alcance en el diseño.'); continue; }
    if (r.kind === 'structure') {
      const shape = mods.map((m) => m.chapters.length);
      const ok = !!r.shape && r.shape.length === shape.length && r.shape.every((n, i) => n === shape[i]);
      out.push({ requirementId: r.id, status: ok ? 'met' : 'unmet', actual: { shape }, chosenBy: structureBy });
      continue;
    }
    if (r.value === null || r.value === undefined) { nv(r, 'Sin cantidad.'); continue; }
    const isEach = 'each' in s && s.each === true;
    switch (r.kind) {
      case 'modules':
        if (s.level !== 'course') { nv(r, 'Cursia todavía no mide este alcance en el diseño.'); break; }
        one(r, mods.length, structureBy);
        break;
      case 'chapters':
        if (s.level === 'course') one(r, chapters.length, structureBy);
        else if (s.level === 'module' && isEach) each(r, mods.map((m) => m.chapters.length), structureBy);
        else if (s.level === 'module' && 'index' in s) {
          const m = mods[s.index - 1];
          if (!m) nv(r, `El diseño no tiene módulo ${s.index}.`, structureBy); else one(r, m.chapters.length, structureBy);
        } else nv(r, 'Cursia todavía no mide este alcance en el diseño.');
        break;
      case 'target_hours':
        if (s.level === 'course') {
          if (typeof d.targetHours !== 'number') nv(r, 'El diseño todavía no tiene horas.', hoursBy); else one(r, d.targetHours, hoursBy, true);
        } else if (s.level === 'module' && 'index' in s) {
          const m = mods[s.index - 1];
          if (!m) nv(r, `El diseño no tiene módulo ${s.index}.`, structureBy);
          else one(r, m.chapters.reduce((a, c) => a + c.hours, 0), 'cursia', true);
        } else if (s.level === 'module' && isEach) {
          out.push({ requirementId: r.id, status: mods.length && mods.every((m) => satisfies(r, m.chapters.reduce((a, c) => a + c.hours, 0), true)) ? 'met' : 'unmet', actual: { each: mods.map((m) => round1(m.chapters.reduce((a, c) => a + c.hours, 0))) }, chosenBy: 'cursia' });
        } else nv(r, 'Cursia todavía no mide este alcance en el diseño.');
        break;
      case 'videos': {
        const vids = (cs: { videoEnabled: boolean }[]) => cs.filter((c) => c.videoEnabled).length;
        if (s.level === 'course') one(r, vids(chapters), videosBy);
        else if (s.level === 'module' && isEach) each(r, mods.map((m) => vids(m.chapters)), videosBy);
        else if (s.level === 'chapter' && isEach) {
          // Cursia produce como mucho un video por capítulo.
          if (r.mode === 'max' || r.value <= 1) {
            const target = chapters.filter((c) => (s.chapterKind ? c.kind === s.chapterKind : c.kind !== 'practice'));
            each(r, target.map((c) => (c.videoEnabled ? 1 : 0)), videosBy);
          } else nv(r, 'Cursia produce un video por capítulo: no puede cumplir más de uno por capítulo todavía.');
        } else nv(r, 'Cursia todavía no mide este alcance en el diseño.');
        break;
      }
      case 'application_activities': {
        const aa = (cs: { applicationMinutes: number | null }[]) => cs.filter((c) => !!c.applicationMinutes).length;
        if (s.level === 'course') one(r, aa(chapters), appBy);
        else if (s.level === 'module' && isEach) each(r, mods.map((m) => aa(m.chapters)), appBy);
        else if (s.level === 'chapter' && isEach) {
          if (r.mode === 'max' || r.value <= 1) {
            // Las prácticas también llevan Actividad de Aplicación (a diferencia del video, que es de los capítulos de contenido).
            const target = chapters.filter((c) => (s.chapterKind ? c.kind === s.chapterKind : true));
            each(r, target.map((c) => (c.applicationMinutes ? 1 : 0)), appBy);
          } else nv(r, 'Cursia diseña como mucho una Actividad de Aplicación por capítulo.');
        } else nv(r, 'Cursia todavía no mide este alcance en el diseño.');
        break;
      }
      case 'activities': {
        const ac = (cs: { activityEnabled: boolean }[]) => cs.filter((c) => c.activityEnabled).length;
        if (s.level === 'course') one(r, ac(chapters), 'cursia');
        else if (s.level === 'module' && isEach) each(r, mods.map((m) => ac(m.chapters)), 'cursia');
        else nv(r, 'Cursia todavía no mide este alcance en el diseño.');
        break;
      }
      case 'evaluations':
        if (s.level !== 'course') nv(r, 'Cursia todavía no mide este alcance en el diseño.');
        else if (r.evaluationType === 'partial') one(r, modExams, structureBy);
        else if (r.evaluationType === 'final') one(r, finalExam, structureBy);
        else one(r, d.evaluations, structureBy);
        break;
      default:
        nv(r, 'Cursia todavía no mide este requisito en el diseño.');
    }
  }
  return out;
}
