import type { BlueprintSnapshotV1, BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import { cmpStr, sha256Canonical } from '../coherence/canonical-json';
import { Outline, buildOutline } from '../coherence/coherence-types';

/**
 * Fase 8 — huellas de inputs relevantes por item (spec §2), siempre por UUID.
 *
 * - `content:<ch>`: `own` = (chapter.id, title, objective) y `context` =
 *   (module.id, module.title, module.objective, contexto congelado del curso).
 *   La huella completa del spec es sha(own, context). **La posición no entra.**
 *   Se separan porque la tabla de reglas (§3) trata distinto un cambio propio
 *   (REGENERATE) de un cambio de contexto (mover de módulo, editar el módulo:
 *   REVIEW). Ver plan.ts.
 * - `scorm:<ch>` / `video:<ch>`: la huella completa del content del capítulo;
 *   para decidir se usa `own` (si el content se reutiliza, ellos también).
 * - `exam:<m>`: sha(module.id, module.title, module.objective, conjunto
 *   ORDENADO de chapterIds, `own` de esos content). Incluye título/objetivo
 *   del módulo porque la tabla pide REGENERATE del examen al editarlos.
 * - `module_intro:<m>`: sha(module.id, title, objective, conjunto ordenado de chapterIds).
 * - `course_plan` / `course_intro`: sha(outline como CONJUNTO: módulos y capítulos
 *   ordenados por UUID con título, objetivo y membresía). Un reorder puro no
 *   la cambia (Ruling A de la fix wave: reordenar nunca regenera).
 */

export const INVALIDATION_FINGERPRINT_VERSION = 1;

export interface ChapterFingerprint {
  own: string;
  context: string;
  full: string;
}

export interface BlueprintFingerprints {
  outline: Outline;
  content: Map<string, ChapterFingerprint>;
  exam: Map<string, string>;
  moduleIntro: Map<string, string>;
  courseOutline: string;
}

export function computeFingerprints(
  bp: BlueprintSnapshotV1,
  opts: { courseContextSha256?: string | null } = {},
): BlueprintFingerprints {
  return computeFingerprintsAt(INVALIDATION_FINGERPRINT_VERSION, bp, opts);
}

/**
 * Cuerpo común de las huellas estructurales. `v` entra en cada sha: v1/v2
 * llaman con INVALIDATION_FINGERPRINT_VERSION (byte-idéntico a antes) y
 * rulesVersion 3 con INVALIDATION_FINGERPRINT_VERSION_V3. Solo lee campos
 * estructurales comunes a Blueprint schemaVersion 1 y 2 (ids, títulos,
 * objetivos, position, membresía): los toggles y el motor NUNCA entran.
 */
function computeFingerprintsAt(
  v: number,
  bp: Pick<BlueprintSnapshotV1, 'course' | 'modules'>,
  opts: { courseContextSha256?: string | null } = {},
): BlueprintFingerprints {
  const ctx = opts.courseContextSha256 ?? null;
  const outline = buildOutline(bp as BlueprintSnapshotV1);
  const content = new Map<string, ChapterFingerprint>();
  const exam = new Map<string, string>();
  const moduleIntro = new Map<string, string>();

  for (const m of outline.modules) {
    const context = sha256Canonical({
      v,
      kind: 'content-context',
      moduleId: m.id,
      moduleTitle: m.title,
      moduleObjective: m.objective,
      courseContextSha256: ctx,
    });
    for (const c of m.chapters) {
      const own = sha256Canonical({ v, kind: 'content-own', chapterId: c.id, title: c.title, objective: c.objective });
      content.set(c.id, { own, context, full: sha256Canonical({ v, kind: 'content', own, context }) });
    }
    const chapterIds = m.chapters.map((c) => c.id).sort(cmpStr);
    exam.set(
      m.id,
      sha256Canonical({
        v,
        kind: 'exam',
        moduleId: m.id,
        moduleTitle: m.title,
        moduleObjective: m.objective,
        chapterIds,
        contentOwn: chapterIds.map((id) => content.get(id)!.own),
      }),
    );
    moduleIntro.set(
      m.id,
      sha256Canonical({ v, kind: 'module_intro', moduleId: m.id, title: m.title, objective: m.objective, chapterIds }),
    );
  }

  // Independiente del orden (Ruling A, fix wave): conjunto de módulos
  // ordenado por UUID, cada uno con su conjunto de capítulos ordenado por
  // UUID. Un reorder puro no cambia la huella; membresía, títulos,
  // objetivos, altas y bajas sí.
  const courseOutline = sha256Canonical({
    v,
    kind: 'outline',
    courseTitle: bp.course?.title ?? null,
    courseContextSha256: ctx,
    modules: [...outline.modules]
      .sort((a, b) => cmpStr(a.id, b.id))
      .map((m) => ({
        id: m.id,
        title: m.title,
        objective: m.objective,
        chapters: [...m.chapters]
          .sort((a, b) => cmpStr(a.id, b.id))
          .map((c) => ({ id: c.id, title: c.title, objective: c.objective })),
      })),
  });

  return { outline, content, exam, moduleIntro, courseOutline };
}

/** Tipo e id de entidad a partir de la key (`<type>:<uuid|courseId>`). */
export function parseItemKey(key: string): { type: string; entityId: string } {
  const i = key.indexOf(':');
  if (i <= 0) throw new Error(`INVALID_INVALIDATION_INPUT: item key inválida: ${key}`);
  return { type: key.slice(0, i), entityId: key.slice(i + 1) };
}

/**
 * Huella "completa" de un item (la que se expone en el plan y se guarda
 * para comparar un artifact deshabilitado al volver a activarlo). `null` si
 * la entidad no existe en este Blueprint.
 */
export function itemFingerprint(fps: BlueprintFingerprints, key: string): string | null {
  const { type, entityId } = parseItemKey(key);
  switch (type) {
    case 'content':
    case 'scorm':
    case 'video':
      return fps.content.get(entityId)?.full ?? null;
    case 'exam':
      return fps.exam.get(entityId) ?? null;
    case 'module_intro':
      return fps.moduleIntro.get(entityId) ?? null;
    case 'course_plan':
    case 'course_intro':
      return fps.courseOutline;
    default:
      return null;
  }
}

/**
 * Huella con la que se decide si un artifact es reutilizable ("match"): para
 * items de capítulo es el `own` del content (un cambio de contexto no invalida
 * el texto, solo pide REVIEW); para el resto, la huella completa.
 */
export function matchFingerprint(fps: BlueprintFingerprints, key: string): string | null {
  const { type, entityId } = parseItemKey(key);
  if (type === 'content' || type === 'scorm' || type === 'video') return fps.content.get(entityId)?.own ?? null;
  return itemFingerprint(fps, key);
}

// ════════════════════════════════════════════════════════════════════════════
// rulesVersion 3 (Cursia V2.1 — R5, audit §P). Todo lo de arriba (v1/v2)
// queda byte-idéntico; v3 usa su propia versión de huella (entra en cada sha,
// así que una huella v3 nunca coincide por accidente con una v1/v2).
//
// Regla dura (audit §O.1 + DECISIONES VIGENTES): ninguna huella lee toggles
// (videoEnabled / activityEnabled / examEnabled / finalExam), perfiles (tema,
// passingGrade, intentos, pesos) ni orden. El único flag de recurso que entra
// es el `variant` de `activity` (el motor define QUÉ artifact se genera).
//
//   content / experience / presentation / video / audiobook_chapter:<ch>
//       match = `own` del content del capítulo (como scorm/video en v1/v2).
//   activity:<ch>
//       match = sha(own, variant). Cambiar el motor ⇒ solo activity cambia.
//   video_interactions:<ch>
//       match = sha(own, identidad del video vigente). La identidad es la del
//       output del video (storage paths, ver `artifactOutputIdentity`): si el
//       video se regenera, la identidad cambia; sin identidad ⇒ null (nunca
//       se reutiliza a ciegas).
//   final_exam:<courseId>
//       sha(conjunto de chapterIds del curso + `own` de cada content). La
//       posición y el módulo no entran: reordenar ⇒ REUSE.
//   audio_welcome:<courseId>
//       la huella de course_intro (outline como conjunto).
//   module_intro:<m>
//       sha(id, título, objetivo del módulo, conjunto de chapterIds + `own` de
//       cada capítulo). A diferencia de v1/v2 incluye el `own` de sus
//       capítulos: audit §P pide module_intro RG al editar el título/objetivo
//       de un capítulo. Reordenar sigue sin cambiarla.
//   exam / course_plan / course_intro: mismas fórmulas de v1/v2.
// ════════════════════════════════════════════════════════════════════════════

export const INVALIDATION_FINGERPRINT_VERSION_V3 = 2;

export interface BlueprintFingerprintsV3 extends BlueprintFingerprints {
  /** Huella de `final_exam` (conjunto de capítulos + `own`). */
  finalExam: string;
}

/** Contexto que no vive en el Blueprint y que algunas huellas v3 necesitan. */
export interface FingerprintExtrasV3 {
  /** Solo `activity`: el motor del item ('h5p' | 'scorm'). */
  variant?: string | null;
  /** Solo `video_interactions`: identidad del output del video vigente (null = desconocida). */
  videoIdentity?: string | null;
}

export function computeFingerprintsV3(
  bp: BlueprintSnapshotV2,
  opts: { courseContextSha256?: string | null } = {},
): BlueprintFingerprintsV3 {
  const v = INVALIDATION_FINGERPRINT_VERSION_V3;
  const base = computeFingerprintsAt(v, bp, opts);
  const moduleIntro = new Map<string, string>();
  for (const m of base.outline.modules) {
    const ids = m.chapters.map((c) => c.id).sort(cmpStr);
    moduleIntro.set(
      m.id,
      sha256Canonical({
        v,
        kind: 'module_intro',
        moduleId: m.id,
        title: m.title,
        objective: m.objective,
        chapterIds: ids,
        contentOwn: ids.map((id) => base.content.get(id)!.own),
      }),
    );
  }
  const chapterIds = base.outline.chapters.map((c) => c.id).sort(cmpStr);
  const finalExam = sha256Canonical({
    v,
    kind: 'final_exam',
    chapterIds,
    contentOwn: chapterIds.map((id) => base.content.get(id)!.own),
  });
  return { ...base, moduleIntro, finalExam };
}

/** Tipos v3 cuya entidad es un capítulo (key `<type>:<chapterId>`). */
export const CHAPTER_ITEM_TYPES_V3: readonly string[] = [
  'content',
  'experience',
  'presentation',
  'video',
  'video_interactions',
  'activity',
  'audiobook_chapter',
];
/** Tipos v3 cuya entidad es un módulo (key `<type>:<moduleId>`). */
export const MODULE_ITEM_TYPES_V3: readonly string[] = ['module_intro', 'exam'];
/** Tipos v3 de alcance curso (key `<type>:<courseId>`). */
export const COURSE_ITEM_TYPES_V3: readonly string[] = ['course_plan', 'course_intro', 'audio_welcome', 'final_exam'];

/** Mismos tipos que usan el `own` del content tal cual como match. */
const OWN_MATCH_TYPES_V3 = new Set(['content', 'experience', 'presentation', 'video', 'audiobook_chapter']);

function assertKnownV3Type(type: string, key: string): void {
  if (!CHAPTER_ITEM_TYPES_V3.includes(type) && !MODULE_ITEM_TYPES_V3.includes(type) && !COURSE_ITEM_TYPES_V3.includes(type)) {
    throw new Error(`INVALID_INVALIDATION_INPUT: tipo de item desconocido en rulesVersion 3: ${key}`);
  }
}

function activityVariantOf(key: string, extras: FingerprintExtrasV3): string {
  const variant = extras.variant;
  if (variant !== 'h5p' && variant !== 'scorm') {
    throw new Error(`INVALID_INVALIDATION_INPUT: ${key} sin variant válido (fue ${JSON.stringify(variant)}; se esperaba 'h5p' o 'scorm')`);
  }
  return variant;
}

/** Huella "completa" v3 de un item (null si la entidad no existe o si falta la identidad del video). */
export function itemFingerprintV3(fps: BlueprintFingerprintsV3, key: string, extras: FingerprintExtrasV3 = {}): string | null {
  const v = INVALIDATION_FINGERPRINT_VERSION_V3;
  const { type, entityId } = parseItemKey(key);
  assertKnownV3Type(type, key);
  if (OWN_MATCH_TYPES_V3.has(type)) return fps.content.get(entityId)?.full ?? null;
  if (type === 'activity') {
    const c = fps.content.get(entityId);
    return c ? sha256Canonical({ v, kind: 'activity', content: c.full, variant: activityVariantOf(key, extras) }) : null;
  }
  if (type === 'video_interactions') {
    const c = fps.content.get(entityId);
    const video = extras.videoIdentity ?? null;
    return c && video ? sha256Canonical({ v, kind: 'video_interactions', content: c.full, video }) : null;
  }
  if (type === 'exam') return fps.exam.get(entityId) ?? null;
  if (type === 'module_intro') return fps.moduleIntro.get(entityId) ?? null;
  if (type === 'final_exam') return fps.finalExam;
  return fps.courseOutline; // course_plan, course_intro, audio_welcome
}

/** Huella de match v3 (la que se guarda en el artifact y decide REUSE de un deshabilitado). */
export function matchFingerprintV3(fps: BlueprintFingerprintsV3, key: string, extras: FingerprintExtrasV3 = {}): string | null {
  const v = INVALIDATION_FINGERPRINT_VERSION_V3;
  const { type, entityId } = parseItemKey(key);
  assertKnownV3Type(type, key);
  if (OWN_MATCH_TYPES_V3.has(type)) return fps.content.get(entityId)?.own ?? null;
  if (type === 'activity') {
    const c = fps.content.get(entityId);
    return c ? sha256Canonical({ v, kind: 'activity', own: c.own, variant: activityVariantOf(key, extras) }) : null;
  }
  if (type === 'video_interactions') {
    const c = fps.content.get(entityId);
    const video = extras.videoIdentity ?? null;
    return c && video ? sha256Canonical({ v, kind: 'video_interactions', own: c.own, video }) : null;
  }
  return itemFingerprintV3(fps, key, extras);
}
