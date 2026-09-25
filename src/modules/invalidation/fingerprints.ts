import type { BlueprintSnapshotV1 } from '../course-blueprints/blueprint-snapshot';
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
  const v = INVALIDATION_FINGERPRINT_VERSION;
  const ctx = opts.courseContextSha256 ?? null;
  const outline = buildOutline(bp);
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
