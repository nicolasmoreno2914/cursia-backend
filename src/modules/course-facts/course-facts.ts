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
import { classifyEducation, STAGE_LEVEL, stageOfContexto, type EducationProfile } from './education-level';

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
  /**
   * r73 UX-10: revisión del pedido (sube en CADA escritura: la del usuario y la de Cursia). Ausente en pedidos
   * anteriores = 0. El cliente la manda como `baseRevision` al guardar (concurrencia optimista POR CAMPO).
   */
  revision?: number;
  /** r73 UX-10: revisión en que cambió cada dato por última vez (su valor o su marca «inferido»). Ausente = 0. */
  fieldRev?: Partial<Record<BriefValueField, number>>;
}

/** Los datos del pedido con valor propio (todo menos «inferidos», que es la marca de cuáles llenó Cursia). */
export type BriefValueField = Exclude<BriefField, 'inferidos'>;
export const BRIEF_VALUE_FIELDS = BRIEF_FIELDS.filter((k) => k !== 'inferidos') as BriefValueField[];

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
  const out: CourseBrief = { briefVersion: BRIEF_VERSION, fields: normalizeBriefFields(o.fields as Record<string, unknown>), updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '' };
  // r73 UX-10: revisión por pedido y por dato. Los pedidos anteriores no las traen (cuentan como 0) y se leen igual que antes.
  if (isRev(o.revision)) out.revision = o.revision;
  if (o.fieldRev && typeof o.fieldRev === 'object' && !Array.isArray(o.fieldRev)) {
    const src = o.fieldRev as Record<string, unknown>;
    const fr: Partial<Record<BriefValueField, number>> = {};
    for (const k of BRIEF_VALUE_FIELDS) if (isRev(src[k])) fr[k] = src[k] as number;
    out.fieldRev = fr;
  }
  return out;
}
const isRev = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

// ── r73 UX-10 · Guardar el pedido sin pisar datos más nuevos (merge por campo) ───────────────────────────────────
//
// Antes, PUT /brief REEMPLAZABA el pedido completo con lo que tuviera el formulario del navegador: un formulario viejo
// (localStorage de otra sesión) con un campo vacío borraba un dato que Cursia había inferido en el servidor (caso #87:
// el sector «Educación» desapareció al abrir el curso). Ahora el pedido se guarda como un PARCHE por campo:
//
//   Formato nuevo (cliente con `baseRevision`):
//     { baseRevision: n, set: { campo: valor }, clear: [campo…], inferred: { add: [campo…], remove: [campo…] } }
//     - Solo se tocan los campos mandados: un campo que el usuario no tocó NUNCA cambia en el servidor.
//     - `clear` es la ÚNICA forma de borrar un dato (decisión explícita del usuario); un texto vacío = «no mandado».
//     - Conflicto: si el servidor cambió ese campo DESPUÉS de `baseRevision` (fieldRev[campo] > baseRevision), se queda
//       el valor del servidor y el campo vuelve en `conflicts` (con el valor de cada lado); el cliente se reconcilia con
//       el pedido devuelto y lo avisa. Un cambio del usuario solo gana si el campo no cambió desde su base.
//     - Un valor mandado por el usuario deja de ser «inferido» salvo que venga en `inferred.add` (lo dedujo Cursia en el
//       navegador, p. ej. el sector del documento).
//   Formato anterior (cliente sin `baseRevision`, campos sueltos en la raíz): compatibilidad que NO borra nada:
//     - un campo con texto se guarda; un campo vacío o ausente = «no mandado» (antes lo borraba);
//     - solo `clear: [campo…]` borra (también se acepta en este formato);
//     - el `inferidos` del cliente solo decide la marca de los campos que ese mismo pedido manda con texto: los inferidos
//       del servidor (p. ej. el sector del autofix r71) se conservan;
//     - `expectedUpdatedAt` sigue dando 409 BRIEF_CHANGED si el pedido cambió (como en 8.1).
//   Escritores del servidor (writeBriefField: autofix «context_field», «Completar el dato», deshacer) usan este mismo
//   merge sin base: también suben la revisión y el fieldRev del campo, así un cliente con una base vieja ve el conflicto.

export interface BriefPatch {
  /** null = cliente anterior o escritor del servidor (sin concurrencia por campo). */
  baseRevision: number | null;
  set: Partial<Record<BriefValueField, string>>;
  clear: BriefValueField[];
  inferredAdd: BriefValueField[];
  inferredRemove: BriefValueField[];
  /** Formato anterior: la lista «inferidos» que mandó el cliente (solo cuenta para los campos que manda con texto). */
  legacyInferidos: BriefValueField[] | null;
}
export interface BriefConflict { field: BriefValueField; server: string | null; client: string | null }
export interface BriefMergeResult { brief: CourseBrief; changed: boolean; conflicts: BriefConflict[]; applied: BriefValueField[] }

const isValueField = (k: unknown): k is BriefValueField => typeof k === 'string' && (BRIEF_VALUE_FIELDS as string[]).includes(k);
const cleanText = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const inferredList = (s: unknown): BriefValueField[] => [...new Set(String(s || '').split(',').map((x) => x.trim()).filter(isValueField))];

/**
 * Cuerpo del PUT → parche validado. Lanza Error (el servicio lo vuelve 400) si un dato es desconocido, no es texto o
 * excede su máximo. El mismo dato en `set` y en `clear` → error (no se adivina cuál quiso el usuario).
 */
export function briefPatchFromBody(body: Record<string, unknown>): BriefPatch {
  const b = body || {};
  const hasBase = b.baseRevision !== undefined && b.baseRevision !== null;
  if (hasBase && !isRev(b.baseRevision)) throw new Error('baseRevision: entero ≥ 0.');
  const set: Partial<Record<BriefValueField, string>> = {};
  const putVal = (k: string, v: unknown, where: string) => {
    if (!isValueField(k)) throw new Error(`${where}: dato desconocido «${k}».`);
    if (v !== undefined && v !== null && typeof v !== 'string') throw new Error(`${where}.${k}: debe ser texto.`);
    const t = cleanText(v);
    if (t.length > BRIEF_MAX[k]) throw new Error(`${where}.${k}: hasta ${BRIEF_MAX[k]} caracteres.`);
    if (t) set[k] = t; // vacío = «no mandado» (para borrar está `clear`)
  };
  for (const k of BRIEF_VALUE_FIELDS) if (b[k] !== undefined) putVal(k, b[k], 'campo'); // formato anterior
  if (b.set !== undefined && b.set !== null) {
    if (typeof b.set !== 'object' || Array.isArray(b.set)) throw new Error('set: objeto { dato: texto }.');
    for (const [k, v] of Object.entries(b.set as Record<string, unknown>)) putVal(k, v, 'set');
  }
  const list = (v: unknown, where: string): BriefValueField[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > BRIEF_FIELDS.length) throw new Error(`${where}: lista de datos.`);
    for (const k of v) if (!isValueField(k)) throw new Error(`${where}: dato desconocido «${String(k)}».`);
    return [...new Set(v as BriefValueField[])];
  };
  const clear = list(b.clear, 'clear');
  for (const k of clear) if (set[k] !== undefined) throw new Error(`«${k}» viene en set y en clear a la vez.`);
  let inferredAdd: BriefValueField[] = [];
  let inferredRemove: BriefValueField[] = [];
  if (b.inferred !== undefined && b.inferred !== null) {
    const inf = b.inferred as Record<string, unknown>;
    if (typeof inf !== 'object' || Array.isArray(inf)) throw new Error('inferred: { add: [...], remove: [...] }.');
    inferredAdd = list(inf.add, 'inferred.add');
    inferredRemove = list(inf.remove, 'inferred.remove').filter((k) => !inferredAdd.includes(k));
  }
  const legacyInferidos = !hasBase && typeof b.inferidos === 'string' ? inferredList(b.inferidos) : null;
  return { baseRevision: hasBase ? (b.baseRevision as number) : null, set, clear, inferredAdd, inferredRemove, legacyInferidos };
}

/** Aplica el parche sobre el pedido vigente (puro). Sin cambios reales → changed:false y el pedido tal cual. */
export function mergeBrief(prev: CourseBrief | null, patch: BriefPatch, nowIso: string): BriefMergeResult {
  const fields: Partial<Record<BriefField, string>> = { ...(prev ? prev.fields : {}) };
  const fieldRev: Partial<Record<BriefValueField, number>> = { ...((prev && prev.fieldRev) || {}) };
  const rev0 = prev && isRev(prev.revision) ? prev.revision : 0;
  const nextRev = rev0 + 1;
  const inferred0 = inferredList(fields.inferidos);
  const inf = new Set<BriefValueField>(inferred0);
  const conflicts: BriefConflict[] = [];
  const applied: BriefValueField[] = [];
  const conflict = (k: BriefValueField) => patch.baseRevision !== null && (fieldRev[k] || 0) > patch.baseRevision;
  const touch = (k: BriefValueField) => { if (!applied.includes(k)) applied.push(k); };

  const valueKeys = [...new Set<BriefValueField>([...(Object.keys(patch.set) as BriefValueField[]), ...patch.clear])];
  for (const k of valueKeys) {
    const next = patch.clear.includes(k) ? null : (patch.set[k] as string);
    if (conflict(k)) {
      if ((fields[k] ?? null) !== next) conflicts.push({ field: k, server: fields[k] ?? null, client: next });
      continue;
    }
    if (next === null) {
      if (fields[k] !== undefined || inf.has(k)) { delete fields[k]; inf.delete(k); touch(k); }
      continue;
    }
    const wantInf = patch.inferredAdd.includes(k) || (patch.legacyInferidos ? patch.legacyInferidos.includes(k) : false);
    if (fields[k] !== next) { fields[k] = next; touch(k); }
    if (inf.has(k) !== wantInf) { if (wantInf) inf.add(k); else inf.delete(k); touch(k); }
  }
  // Solo la marca «inferido» de un dato cuyo valor no se manda (p. ej. el usuario confirma lo que dedujo Cursia).
  for (const k of [...patch.inferredAdd, ...patch.inferredRemove]) {
    if (valueKeys.includes(k) || fields[k] === undefined) continue;
    const want = patch.inferredAdd.includes(k);
    if (inf.has(k) === want || conflict(k)) continue; // con conflicto se queda lo del servidor
    if (want) inf.add(k); else inf.delete(k);
    touch(k);
  }

  if (!applied.length) return { brief: prev || { briefVersion: BRIEF_VERSION, fields: {}, updatedAt: '', revision: 0, fieldRev: {} }, changed: false, conflicts, applied };
  // Orden estable de «inferidos»: los que ya estaban y luego los nuevos; solo de datos que tienen valor.
  const order = [...inferred0, ...BRIEF_VALUE_FIELDS.filter((k) => !inferred0.includes(k))];
  const infStr = order.filter((k) => inf.has(k) && fields[k] !== undefined).join(',');
  if (infStr) fields.inferidos = infStr; else delete fields.inferidos;
  for (const k of applied) fieldRev[k] = nextRev;
  const brief: CourseBrief = { briefVersion: BRIEF_VERSION, fields: normalizeBriefFields(fields as Record<string, unknown>), updatedAt: nowIso, revision: nextRev, fieldRev };
  return { brief, changed: true, conflicts, applied };
}

/** Lo que devuelve la API: siempre con `revision` y `fieldRev` (0 / {} en pedidos anteriores a UX-10). */
export function briefForClient(b: CourseBrief | null): CourseBrief | null {
  return b ? { ...b, revision: isRev(b.revision) ? b.revision : 0, fieldRev: b.fieldRev || {} } : null;
}

// Valores de la pantalla Datos (chips) → vocabulario del motor pedagógico.
const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/**
 * «Universitario — estudiantes de pregrado…» → 'university'. Desconocido / «Otro» → null.
 * r73 (UX-9): también los textos por etapa («Educación Básica Primaria/Secundaria», «Educación Media», «Tecnólogo»…) y
 * un «Otro» que nombra el nivel («estudiantes de grado 6»).
 */
export function educationLevelFromBrief(contexto: string | undefined): 'basic' | 'secondary' | 'technical' | 'university' | 'professional' | null {
  const st = stageOfContexto(contexto);
  return st ? STAGE_LEVEL[st] : null;
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
/** Lecturas del documento marcadas para revisar (🟡), en el orden de «Lo que entendimos». */
function documentReviewOf(ctx: AcademicContextV1): CourseFacts['documentReview'] {
  const out: CourseFacts['documentReview'] = [];
  const f = (block: 'course' | 'learner' | 'outcomes', label: string, x: { status: string; value: unknown; review?: string }) => {
    if (x.status !== 'missing' && typeof x.value === 'string' && x.review) out.push({ block, label, text: x.value, message: x.review });
  };
  f('course', 'Objetivo general', ctx.identity.generalObjective);
  f('learner', 'Público', ctx.learner.profile);
  for (const o of ctx.outcomes) if (o.review) out.push({ block: 'outcomes', label: o.id, text: o.text, message: o.review });
  for (const c of ctx.competencies) if (c.review) out.push({ block: 'outcomes', label: c.id, text: c.text, message: c.review });
  return out.slice(0, 40);
}

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
  /**
   * LOOP 9.2: qué dice el documento de esos conocimientos — los exige, los recomienda, dice que no hace falta ninguno —
   * o null si el documento no habla de ellos.
   */
  documentPrerequisitesKind: PrerequisitesKind | null;
  learnerDescription: Fact<string>;
  /** origin (LOOP 8.2): de dónde salió CADA resultado — documento, propuesto por Cursia sin documento o escrito por el docente. */
  outcomes: Fact<{ id: string | null; text: string; domain: string | null; origin: OutcomeOrigin }[]>;
  competencies: Fact<string[]>;
  targetHours: Fact<number>;
  /**
   * El documento da las horas como RANGO («40–44 horas»): se conserva (min, max). `targetHours` es la meta de diseño
   * (el punto medio, salvo que el docente elija otra). null si el documento da un número o no habla de horas.
   */
  targetHoursRange: { min: number; max: number } | null;
  /**
   * Lecturas del documento con dudas (🟡): Cursia las usa, pero pide confirmarlas o completarlas (texto cortado en el
   * documento, por ejemplo). Nunca bloquean; `block` dice en qué bloque de «Lo que entendimos» se corrigen.
   */
  documentReview: { block: 'course' | 'learner' | 'outcomes'; label: string; text: string; message: string }[];
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
  /**
   * r73 (UX-9): nivel educativo que dice el curso (documento o nombre: grado, edades, etapa) y su coherencia con el
   * contexto del pedido: corregir (si lo puso Cursia), avisar (si lo eligió el docente) o preguntar (sin señales).
   */
  educationProfile: EducationProfile;
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
/** LOOP 9.2 (QA): título de relleno (o vacío): el curso todavía no tiene nombre propio. */
export function isPlaceholderCourseTitle(t: unknown): boolean {
  const v = String(t ?? '').trim();
  return !v || PLACEHOLDER_TITLES.includes(v);
}
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

export type PrerequisitesKind = 'required' | 'recommended' | 'none';

/**
 * LOOP 9.2 · «Se recomienda contar con…» = recomendados (no «sin conocimientos previos»); «No se exige ningún
 * prerrequisito» (sin nada recomendado) = ninguno; una lista sin esas marcas = exigidos.
 */
export function prerequisitesKindOf(items: string[]): PrerequisitesKind | null {
  if (!items.length) return null;
  const t = strip(items.join(' '));
  if (/\b(se recomienda\w*|recomendable|recomendad[oa]s?|deseable|se sugiere|sugerid[oa]s?|preferiblemente|conviene)\b/.test(t)) return 'recommended';
  // «No requiere conocimientos de X, pero sí manejo de Y» exige Y (review M7).
  if (/\bpero si\b/.test(t)) return 'required';
  if (/\b(no se (exige|requiere|necesita)n?|no requiere|no exige|sin (pre-?r?requisitos?|conocimientos previos|requisitos previos)|ninguno|no aplica|no tiene pre-?r?requisitos?)\b/.test(t)) return 'none';
  return 'required';
}

/**
 * LOOP 9.2 · Sector a partir de lo que el documento dice del curso (nombre, estudiantes, nivel), con evidencia: el
 * área tiene que aparecer en el nombre o al menos dos veces en el resto. Inferido y editable; sin coincidencia, sin dato.
 */
const SECTOR_KEYWORDS: ReadonlyArray<[string, RegExp]> = [
  ['Seguridad y Salud en el Trabajo', /\b(seguridad y salud en el trabajo|riesgos laborales|salud ocupacional|sg-?sst)\b/g],
  ['Salud', /\b(salud|enfermer\w*|clinic[oa]s?|hospital\w*|medicina|farmac\w*|odontolog\w*)\b/g],
  ['Educación', /\b(pedagog\w*|formacion docente|educacion (inicial|basica|media|superior)|didactica)\b/g],
  ['Logística', /\b(logistic\w*|cadena de suministro|inventarios?|bodegas?|almacenamiento)\b/g],
  ['Contabilidad y finanzas', /\b(contab\w*|financier\w*|finanzas|tributari\w*)\b/g],
  ['Tecnología', /\b(software|programacion|desarrollo web|informatica|ciberseguridad|python|bases de datos)\b/g],
  ['Gestión administrativa', /\b(auxiliares? administrativ\w*|asistentes? administrativ\w*|gestion documental|secretariado)\b/g],
];
/**
 * Review LOOP 9.2 (I5): puntaje por sector (el nombre vale doble) y se elige el MAYOR; empate o menos de 2 puntos → sin
 * dato (mejor sin sector que uno inventado). «seguridad y salud en el trabajo» no suma a «Salud».
 */
export function sectorFromKeywords(ctx: AcademicContextV1 | null | undefined): string | null {
  if (!ctx || !ctx.identity) return null;
  const val = (f: { status: string; value: unknown } | undefined) => (f && f.status !== 'missing' && f.value ? (typeof f.value === 'string' ? f.value : (f.value as any).text || '') : '');
  const sst = /\bseguridad y salud en el trabajo\b/g;
  const name = strip(String(val(ctx.identity.subjectName as any)));
  const rest = strip([val(ctx.learner && (ctx.learner.profile as any)), val(ctx.identity.educationLevel as any), val(ctx.identity.description as any)].join(' '));
  const scored = SECTOR_KEYWORDS.map(([sector, re]) => {
    const clean = (t: string) => (sector === 'Salud' ? t.replace(sst, ' ') : t);
    return { sector, score: 2 * (clean(name).match(re) || []).length + (clean(rest).match(re) || []).length };
  }).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < 2 || (scored[1] && scored[1].score === scored[0].score)) return null;
  return scored[0].sector;
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
  // LOOP 9.2: sin programa en el documento, el área que nombra el documento (inferida, editable).
  const keywordSector = ctx && withDocs && !docSector ? sectorFromKeywords(ctx) : null;
  const docPrereqs = ctx ? (found(ctx.learner.priorKnowledge) || []) : [];
  // Review I6: el tipo y el dato «del documento» solo con un documento leído (no con lo que propuso la IA sin documento).
  const prereqKind = withDocs ? prerequisitesKindOf(docPrereqs) : null;
  const ctxFact = <T>(f: { status: string; value: T | null } | undefined): Fact<T> =>
    f && f.status !== 'missing' ? fact<T>(f.value, ctxSource(f as any)) : { value: null, source: null };
  const conflicts: FactConflict[] = [];

  // Nivel educativo — Review L81 I2: la decisión explícita del docente en el perfil manda; si no, el documento; si no,
  // el pedido (Datos).
  const docLevel = ctx ? found(ctx.identity.educationLevel) : null;
  const briefLevel = educationLevelFromBrief(b.contexto);
  const pedLevel = ped && ped.learner ? ped.learner.educationLevel : null;
  // r73 (UX-9): la etapa que dice el curso (documento: grado, «Educación Básica Secundaria»…; o el nombre: «Grado Sexto»).
  const educationProfile = classifyEducation({
    brief: b as any, academic: ctx, courseTitle: input.courseTitle,
    userProfileLevel: owners.educationLevel === 'user' ? pedLevel : null,
  });
  const det = educationProfile.detected;
  const educationLevel = owners.educationLevel === 'user'
    ? fact<string>(pedLevel, 'profile')
    : first<string>(
      fact(docLevel && docLevel.level, 'document'),
      fact(det && det.source === 'document' ? det.level : null, 'document'),
      fact(pedLevel, 'profile'),
      // Lo que eligió el usuario manda sobre el nombre; el nombre, sobre el valor de partida (inferido).
      fact(briefSource('contexto') === 'user' ? briefLevel : null, 'user'),
      fact(det && det.source === 'name' ? det.level : null, 'inferred'),
      fact(briefLevel, briefSource('contexto')),
    );
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
      // Horas en RANGO del documento: unas horas elegidas dentro del rango no se apartan del documento.
      const range = f === 'targetHours' && ctx.hours.total.status !== 'missing' ? ctx.hours.total.range : undefined;
      const inRange = !!range && typeof pedHours === 'number' && pedHours >= range.min && pedHours <= range.max;
      const differs = f === 'assessmentMethods' ? missingDocMethods : inRange ? false : fieldSha(docV) !== fieldSha(derivedFieldValue(ped, f));
      if (owners[f] === 'user' && !isEmptyValue(docV) && differs) {
        differing.push(f);
        conflicts.push({ field: `pedagogy.${f}`, values: [{ source: 'document', value: docV }, { source: 'profile', value: derivedFieldValue(ped, f) }],
          message: FIELD_CONFLICT_MESSAGE[f](range ? `${String(range.min).replace('.', ',')}–${String(range.max).replace('.', ',')}` : docV, pedHours) });
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
    // LOOP 9.2: lo que dice el documento va antes del valor de partida de «Crear» (recomendados/exigidos = lo esencial).
    // Review I6: lo que eligió el usuario en «Crear» manda sobre el documento; el documento, sobre el valor de partida.
    priorKnowledge: first<string>(
      fact(ped && ped.learner ? ped.learner.priorKnowledge : null, 'profile'),
      fact(briefSource('nivel') === 'user' ? priorKnowledgeFromBrief(b.nivel) : null, 'user'),
      fact(prereqKind === 'none' ? 'none' : prereqKind ? 'basic' : null, 'document'),
      fact(priorKnowledgeFromBrief(b.nivel), briefSource('nivel')),
    ),
    documentPrerequisites: docPrereqs,
    documentPrerequisitesKind: prereqKind,
    learnerDescription: owners.description === 'user'
      ? fact<string>(ped!.learner.description, 'profile')
      : first<string>(ctx ? ctxFact(ctx.learner.profile) : fact<string>(null, null), fact(ped && ped.learner ? ped.learner.description : null, 'profile')),
    outcomes: first(fact(docOutcomes, docOutcomesSource), fact(pedOutcomes, 'profile')),
    competencies: first<string[]>(fact(ctx ? ctx.competencies.map((c) => c.text) : null, ctx && ctx.competencies.length ? ctxSource(ctx.competencies[0]) : 'document'), fact(ped && ped.learningOutcomes ? ped.learningOutcomes.competencies : null, 'profile')),
    targetHours,
    targetHoursRange: withDocs && ctx && ctx.hours.total.status !== 'missing' && ctx.hours.total.range ? { min: ctx.hours.total.range.min, max: ctx.hours.total.range.max } : null,
    documentReview: withDocs && ctx ? documentReviewOf(ctx) : [],
    units: fact(withDocs && ctx ? ctx.units.length : null, 'document'),
    // LOOP 8.2.1: sin sector en el pedido, solo con evidencia del documento (el programa encontrado en él); si no, sin dato.
    sector: first<string>(fact(b.sector, briefSource('sector')), fact(docSector, 'inferred'), fact(keywordSector, 'inferred')),
    documentSector: docSector ?? keywordSector,
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
    educationProfile,
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
  // r73: «Educación Básica Secundaria — …» es secundaria (antes caía en 'basic' por el prefijo «educación básica»).
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
