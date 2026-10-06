import type { BlueprintSnapshotV1, BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import { itemOutcomes } from '../academic-context/alignment-brief';
import { cmpStr, sha256Canonical } from '../coherence/canonical-json';
import { Outline, buildOutline } from '../coherence/coherence-types';
import { roleDesignDelta } from '../pedagogy/generator-directives';

/**
 * Title Normalization: la descripción entra en la huella SOLO si existe (con la
 * clave indicada). Sin descripción la huella es idéntica a la de antes → runs y
 * planes de invalidación existentes no cambian; cambiarla regenera lo que
 * dependía del capítulo/módulo, igual que el título o el objetivo.
 */
function descField(x: { description?: string }, key: string): Record<string, string> {
  return x.description ? { [key]: x.description } : {};
}

/**
 * Motor pedagógico V1: el diseño pedagógico (Blueprint v2 con `course.pedagogy`) entra en la
 * huella SOLO si existe, como sha de su JSON canónico. Sin diseño la huella es idéntica a la
 * de antes; cambiar el enfoque (o el diseño de un capítulo) regenera lo que dependía de él.
 */
function designField(design: unknown, key: string): Record<string, string> {
  return design !== undefined && design !== null ? { [key]: sha256Canonical(design) } : {};
}

interface PedagogyLookup {
  course: unknown;
  modules: Map<string, unknown>;
  chapters: Map<string, unknown>;
}

/**
 * Review I3: de `course.pedagogy` solo entra lo que define el DISEÑO. `profileSha256` (cambia con la
 * descripción del estudiante, un resultado o el origen del perfil) y `engineVersion` quedan afuera: un
 * cambio que no altera ningún valor de diseño no regenera nada.
 */
function coursePedagogyDesignProjection(p: any): unknown {
  if (p === undefined || p === null) return undefined;
  const { profileSha256: _sha, engineVersion: _engine, ...design } = p;
  return design;
}

function pedagogyLookup(bp: any): PedagogyLookup {
  const out: PedagogyLookup = { course: coursePedagogyDesignProjection(bp?.course?.pedagogy), modules: new Map(), chapters: new Map() };
  for (const m of Array.isArray(bp?.modules) ? bp.modules : []) {
    if (m?.design !== undefined) out.modules.set(m.id, m.design);
    for (const c of Array.isArray(m?.chapters) ? m.chapters : []) if (c?.design !== undefined) out.chapters.set(c.id, c.design);
  }
  return out;
}

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
/** Motor de carga horaria: ids de los capítulos de práctica del snapshot (v1 y v2 sin práctica → vacío). */
function practiceChapterIdsOf(bp: { modules: ReadonlyArray<{ chapters: ReadonlyArray<{ id: string }> }> }): Set<string> {
  const out = new Set<string>();
  for (const m of bp.modules ?? []) for (const c of m.chapters ?? []) if ((c as { kind?: string }).kind === 'practice') out.add(c.id);
  return out;
}

function computeFingerprintsAt(
  v: number,
  bp: Pick<BlueprintSnapshotV1, 'course' | 'modules'>,
  opts: { courseContextSha256?: string | null } = {},
): BlueprintFingerprints {
  const ctx = opts.courseContextSha256 ?? null;
  const outline = buildOutline(bp as BlueprintSnapshotV1);
  const ped = pedagogyLookup(bp);
  const content = new Map<string, ChapterFingerprint>();
  const exam = new Map<string, string>();
  const moduleIntro = new Map<string, string>();
  // Motor de carga horaria: los capítulos de práctica no aportan texto a los exámenes (sin práctica: huellas de siempre).
  const practiceIds = practiceChapterIdsOf(bp);

  for (const m of outline.modules) {
    const context = sha256Canonical({
      v,
      kind: 'content-context',
      moduleId: m.id,
      moduleTitle: m.title,
      moduleObjective: m.objective,
      ...descField(m, 'moduleDescription'),
      courseContextSha256: ctx,
      ...designField(ped.course, 'coursePedagogy'),
    });
    for (const c of m.chapters) {
      const own = sha256Canonical({
        v, kind: 'content-own', chapterId: c.id, title: c.title, objective: c.objective, ...descField(c, 'description'),
        ...designField(ped.chapters.get(c.id), 'design'),
      });
      content.set(c.id, { own, context, full: sha256Canonical({ v, kind: 'content', own, context }) });
    }
    const chapterIds = m.chapters.map((c) => c.id).filter((id) => !practiceIds.has(id)).sort(cmpStr);
    exam.set(
      m.id,
      sha256Canonical({
        v,
        kind: 'exam',
        moduleId: m.id,
        moduleTitle: m.title,
        moduleObjective: m.objective,
        ...descField(m, 'moduleDescription'),
        chapterIds,
        contentOwn: chapterIds.map((id) => content.get(id)!.own),
        ...designField(ped.modules.get(m.id), 'moduleDesign'),
        ...designField(ped.course, 'coursePedagogy'),
      }),
    );
    moduleIntro.set(
      m.id,
      sha256Canonical({
        v, kind: 'module_intro', moduleId: m.id, title: m.title, objective: m.objective, ...descField(m, 'description'), chapterIds: m.chapters.map((c) => c.id).sort(cmpStr),
        ...designField(ped.modules.get(m.id), 'moduleDesign'),
      }),
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
    ...designField(ped.course, 'coursePedagogy'),
    modules: [...outline.modules]
      .sort((a, b) => cmpStr(a.id, b.id))
      .map((m) => ({
        id: m.id,
        title: m.title,
        objective: m.objective,
        ...descField(m, 'description'),
        chapters: [...m.chapters]
          .sort((a, b) => cmpStr(a.id, b.id))
          .map((c) => ({ id: c.id, title: c.title, objective: c.objective, ...descField(c, 'description') })),
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
//       EV5-C: + h5pType SOLO si el item lo trae explícito (Manifest con
//       activityTypeRules=1); sin él la huella es byte-idéntica a la de antes.
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
  /**
   * Motor pedagógico Fase 2 (review N2 de V1 + I1 de Fase 2): por capítulo, tipo de trabajo → sha de la parte del
   * diseño EFECTIVO que lee su brief, SOLO cuando el rol del capítulo en el módulo la cambia (roleDesignDelta).
   * Entra únicamente en la huella de ESE trabajo: un reorden regenera solo lo que recibe otra indicación.
   */
  roleDesign: Map<string, Record<string, string>>;
  /** Motor de carga horaria: capítulo de práctica → sha de sus fuentes (capítulos de contenido del módulo). */
  practiceSources?: Map<string, string>;
  /**
   * Fase 2 · Actividades de Aplicación: capítulo → sha de lo que la actividad lee además del capítulo (minutos y
   * contexto congelado del estudiante/resultados). Solo capítulos con actividad.
   */
  application?: Map<string, string>;
  /**
   * Fase 3 · Contexto académico (R26): `<type>:<entidad>` → sha de los resultados de aprendizaje (ids + textos) que
   * recibe ese item, SOLO para los items que producen evidencia y con resultados. Entra únicamente en su huella: un
   * cambio de vínculos regenera actividades, Actividades de Aplicación y exámenes, nunca el content (ni su video).
   */
  alignment?: Map<string, string>;
}

/** Fase 3 (R26): tipos cuya huella incluye los resultados que deben evidenciar. */
export const ALIGNMENT_FINGERPRINT_TYPES: readonly string[] = ['experience', 'activity', 'video_interactions', 'application_activity', 'exam', 'final_exam'];

function withAlignment(fps: BlueprintFingerprintsV3, type: string, entityId: string, fp: string | null): string | null {
  const a = fps.alignment?.get(`${type}:${entityId}`);
  return fp && a ? sha256Canonical({ v: INVALIDATION_FINGERPRINT_VERSION_V3, kind: 'alignment', type, base: fp, alignment: a }) : fp;
}

/** Envuelve la huella de experience/activity de un capítulo de práctica con la de sus fuentes (contenido: igual). */
function withPracticeSources(fps: BlueprintFingerprintsV3, type: string, chapterId: string, fp: string | null): string | null {
  const src = (type === 'experience' || type === 'activity' || type === 'application_activity') ? fps.practiceSources?.get(chapterId) : undefined;
  return fp && src ? sha256Canonical({ v: INVALIDATION_FINGERPRINT_VERSION_V3, kind: 'practice', type, base: fp, sources: src }) : fp;
}

/** Contexto que no vive en el Blueprint y que algunas huellas v3 necesitan. */
export interface FingerprintExtrasV3 {
  /** Solo `activity`: el motor del item ('h5p' | 'scorm'). */
  variant?: string | null;
  /** Solo `activity` h5p con tipo congelado en el Manifest (EV5-C); ausente/null = no entra en la huella. */
  h5pType?: string | null;
  /** Solo `video_interactions`: identidad del output del video vigente (null = desconocida). */
  videoIdentity?: string | null;
}

export function computeFingerprintsV3(
  bp: BlueprintSnapshotV2,
  opts: { courseContextSha256?: string | null } = {},
): BlueprintFingerprintsV3 {
  const v = INVALIDATION_FINGERPRINT_VERSION_V3;
  const base = computeFingerprintsAt(v, bp, opts);
  const ped = pedagogyLookup(bp);
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
        ...descField(m, 'description'),
        chapterIds: ids,
        contentOwn: ids.map((id) => base.content.get(id)!.own),
        ...designField(ped.modules.get(m.id), 'moduleDesign'),
      }),
    );
  }
  const practiceIds = practiceChapterIdsOf(bp);
  const chapterIds = base.outline.chapters.map((c) => c.id).filter((id) => !practiceIds.has(id)).sort(cmpStr);
  // Motor de carga horaria: experience/activity de un capítulo de práctica se apoyan en los capítulos de CONTENIDO de
  // su módulo: su huella suma el `own` de esas fuentes (en orden), así un cambio en ellas o en el conjunto la regenera.
  const practiceSources = new Map<string, string>();
  for (const m of base.outline.modules) {
    const sources = m.chapters.map((c) => c.id).filter((id) => !practiceIds.has(id));
    for (const c of m.chapters) {
      if (!practiceIds.has(c.id)) continue;
      practiceSources.set(c.id, sha256Canonical({ v, kind: 'practice-sources', sources, sourcesOwn: sources.map((id) => base.content.get(id)!.own) }));
    }
  }
  const finalExam = sha256Canonical({
    v,
    kind: 'final_exam',
    chapterIds,
    contentOwn: chapterIds.map((id) => base.content.get(id)!.own),
    ...designField(ped.course, 'coursePedagogy'),
  });
  const roleDesign = new Map<string, Record<string, string>>();
  if ((bp as any).course?.pedagogy) {
    for (const ch of base.outline.chapters) {
      const delta = roleDesignDelta(bp, ch.id);
      const shas: Record<string, string> = {};
      for (const [type, proj] of Object.entries(delta)) shas[type] = sha256Canonical(proj);
      if (Object.keys(shas).length) roleDesign.set(ch.id, shas);
    }
  }
  // Fase 2: minutos + contexto congelado (course.applicationContext) de cada capítulo con Actividad de Aplicación.
  const application = new Map<string, string>();
  const appContext = (bp as any).course?.applicationContext ?? null;
  for (const m of (bp as any).modules ?? []) {
    for (const c of m.chapters ?? []) {
      if (typeof c.applicationMinutes === 'number') {
        application.set(c.id, sha256Canonical({ v, kind: 'application-frame', minutes: c.applicationMinutes, applicationContext: appContext }));
      }
    }
  }
  // Fase 3 (R26): resultados que recibe cada item de evidencia (mismo cálculo que el brief del claim).
  const alignment = new Map<string, string>();
  if ((bp as any).course?.academicContext) {
    const courseId = String((bp as any).course.id);
    const add = (type: string, entityId: string, ref: { type: string; moduleId?: string | null; chapterId: string | null }) => {
      const outs = itemOutcomes(bp, ref);
      if (outs.length) alignment.set(`${type}:${entityId}`, sha256Canonical({ v, kind: 'alignment', outcomes: outs }));
    };
    for (const m of bp.modules) {
      add('exam', m.id, { type: 'exam', moduleId: m.id, chapterId: null });
      for (const c of m.chapters) {
        for (const t of ALIGNMENT_FINGERPRINT_TYPES) if (CHAPTER_ITEM_TYPES_V3.includes(t)) add(t, c.id, { type: t, moduleId: m.id, chapterId: c.id });
      }
    }
    if (ALIGNMENT_FINGERPRINT_TYPES.includes('final_exam')) add('final_exam', courseId, { type: 'final_exam', chapterId: null });
  }
  return { ...base, moduleIntro, finalExam, roleDesign, practiceSources, application, ...(alignment.size ? { alignment } : {}) };
}

/** Sha de la variación por rol que recibe el trabajo `type` del capítulo (null = el rol no le cambia nada). */
export function roleDesignShaV3(fps: BlueprintFingerprintsV3, type: string, chapterId: string): string | null {
  return fps.roleDesign?.get(chapterId)?.[type] ?? null;
}

/** Envuelve una huella con la variación por rol del trabajo (sin variación = la huella de siempre). */
function withRoleDesign(fps: BlueprintFingerprintsV3, type: string, chapterId: string, fp: string | null): string | null {
  const r = roleDesignShaV3(fps, type, chapterId);
  return fp && r ? sha256Canonical({ v: INVALIDATION_FINGERPRINT_VERSION_V3, kind: 'role-design', type, base: fp, roleDesign: r }) : fp;
}

/** Tipos v3 cuya entidad es un capítulo (key `<type>:<chapterId>`). */
export const CHAPTER_ITEM_TYPES_V3: readonly string[] = [
  'content',
  'experience',
  'presentation',
  'video',
  'video_interactions',
  'activity',
  'application_activity',
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

/** EV5-C: `h5pType` entra en la huella de activity solo si es explícito (las huellas legacy no cambian). */
function h5pTypeField(extras: FingerprintExtrasV3): { h5pType?: string } {
  return extras.h5pType ? { h5pType: extras.h5pType } : {};
}

/** Huella "completa" v3 de un item (null si la entidad no existe o si falta la identidad del video). */
export function itemFingerprintV3(fps: BlueprintFingerprintsV3, key: string, extras: FingerprintExtrasV3 = {}): string | null {
  const { type, entityId } = parseItemKey(key);
  assertKnownV3Type(type, key);
  const fp = itemFingerprintV3Base(fps, key, extras);
  const wrapped = CHAPTER_ITEM_TYPES_V3.includes(type) ? withRoleDesign(fps, type, entityId, withPracticeSources(fps, type, entityId, fp)) : fp;
  return withAlignment(fps, type, entityId, wrapped);
}

function itemFingerprintV3Base(fps: BlueprintFingerprintsV3, key: string, extras: FingerprintExtrasV3): string | null {
  const v = INVALIDATION_FINGERPRINT_VERSION_V3;
  const { type, entityId } = parseItemKey(key);
  if (OWN_MATCH_TYPES_V3.has(type)) return fps.content.get(entityId)?.full ?? null;
  if (type === 'activity') {
    const c = fps.content.get(entityId);
    return c ? sha256Canonical({ v, kind: 'activity', content: c.full, variant: activityVariantOf(key, extras), ...h5pTypeField(extras) }) : null;
  }
  if (type === 'video_interactions') {
    const c = fps.content.get(entityId);
    const video = extras.videoIdentity ?? null;
    return c && video ? sha256Canonical({ v, kind: 'video_interactions', content: c.full, video }) : null;
  }
  if (type === 'application_activity') {
    const c = fps.content.get(entityId);
    const frame = fps.application?.get(entityId);
    return c && frame ? sha256Canonical({ v, kind: 'application_activity', content: c.full, frame }) : null;
  }
  if (type === 'exam') return fps.exam.get(entityId) ?? null;
  if (type === 'module_intro') return fps.moduleIntro.get(entityId) ?? null;
  if (type === 'final_exam') return fps.finalExam;
  return fps.courseOutline; // course_plan, course_intro, audio_welcome
}

/** Huella de match v3 (la que se guarda en el artifact y decide REUSE de un deshabilitado). */
export function matchFingerprintV3(fps: BlueprintFingerprintsV3, key: string, extras: FingerprintExtrasV3 = {}): string | null {
  const { type, entityId } = parseItemKey(key);
  assertKnownV3Type(type, key);
  if (!CHAPTER_ITEM_TYPES_V3.includes(type)) return itemFingerprintV3(fps, key, extras);
  return withAlignment(fps, type, entityId, withRoleDesign(fps, type, entityId, withPracticeSources(fps, type, entityId, matchFingerprintV3Base(fps, key, extras))));
}

function matchFingerprintV3Base(fps: BlueprintFingerprintsV3, key: string, extras: FingerprintExtrasV3): string | null {
  const v = INVALIDATION_FINGERPRINT_VERSION_V3;
  const { type, entityId } = parseItemKey(key);
  if (OWN_MATCH_TYPES_V3.has(type)) return fps.content.get(entityId)?.own ?? null;
  if (type === 'activity') {
    const c = fps.content.get(entityId);
    return c ? sha256Canonical({ v, kind: 'activity', own: c.own, variant: activityVariantOf(key, extras), ...h5pTypeField(extras) }) : null;
  }
  if (type === 'video_interactions') {
    const c = fps.content.get(entityId);
    const video = extras.videoIdentity ?? null;
    return c && video ? sha256Canonical({ v, kind: 'video_interactions', own: c.own, video }) : null;
  }
  if (type === 'application_activity') {
    const c = fps.content.get(entityId);
    const frame = fps.application?.get(entityId);
    return c && frame ? sha256Canonical({ v, kind: 'application_activity', own: c.own, frame }) : null;
  }
  return itemFingerprintV3Base(fps, key, extras);
}
