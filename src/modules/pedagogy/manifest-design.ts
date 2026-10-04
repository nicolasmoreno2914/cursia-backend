import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import { effectiveChapterDesign } from './pedagogical-blueprint';

/**
 * Motor pedagógico V1 — Blueprint → Manifest.
 *
 * Cada item del Manifest v3 de un curso CON perfil pedagógico lleva `design`:
 * la parte del diseño del Blueprint que necesita SU generador (el video, su
 * estilo; el examen, su estrategia…). Lo calculan igual el builder y el
 * validador (función pura, orden de claves fijo). Sin `course.pedagogy` no hay
 * `design` en ningún item (Manifest byte-idéntico al de antes).
 *
 * Items sin diseño propio: audio_welcome y audiobook_chapter (narran contenido
 * ya diseñado).
 */

export type ManifestItemDesign = Record<string, unknown>;

export interface ManifestFeaturesPedagogy {
  engineVersion: number;
  profileSha256: string;
}

export function manifestFeaturesPedagogy(snapshot: BlueprintSnapshotV2): ManifestFeaturesPedagogy | undefined {
  const p = snapshot.course.pedagogy;
  return p ? { engineVersion: p.engineVersion, profileSha256: p.profileSha256 } : undefined;
}

export function manifestItemDesign(
  snapshot: BlueprintSnapshotV2,
  type: string,
  moduleId: string | null,
  chapterId: string | null,
): ManifestItemDesign | undefined {
  const p = snapshot.course.pedagogy;
  if (!p) return undefined;
  const approaches = p.approaches.map((a) => a.id);
  switch (type) {
    case 'course_plan':
      return { approaches, objectivesStyle: p.objectivesStyle, contentDepth: p.contentDepth };
    case 'course_intro':
      return { approaches, interactionLevel: p.interactionLevel };
    case 'exam':
      return { strategy: p.assessment.strategy, examStyle: p.assessment.examStyle, feedback: { mode: p.assessment.feedbackMode, timing: p.assessment.feedbackTiming } };
    case 'final_exam':
      return { strategy: p.assessment.strategy, finalExamStyle: p.assessment.finalExamStyle, feedback: { mode: p.assessment.feedbackMode, timing: p.assessment.feedbackTiming } };
    case 'module_intro': {
      const m = snapshot.modules.find((x) => x.id === moduleId);
      if (!m?.design) throw new Error(`manifestItemDesign: el módulo ${moduleId} no tiene diseño pedagógico`);
      return { opening: m.design.opening, closing: m.design.closing };
    }
    case 'audio_welcome':
    case 'audiobook_chapter':
      return undefined;
    default: {
      const ch = snapshot.modules.flatMap((m) => m.chapters).find((c) => c.id === chapterId);
      if (!ch?.design) throw new Error(`manifestItemDesign: el capítulo ${chapterId} no tiene diseño pedagógico`);
      // Diseño efectivo: el congelado + las variaciones del rol que le da su posición actual.
      const d = effectiveChapterDesign(snapshot, ch.id);
      switch (type) {
        case 'content':
          return {
            role: d.role, sequence: [...d.sequence], objectiveStyle: d.objectiveStyle, objectiveVerbs: [...d.objectiveVerbs],
            contentType: d.contentType, depth: d.depth, scenario: { type: d.scenario.type, branching: d.scenario.branching }, resources: [...d.resources],
          };
        case 'experience':
          return { contentType: d.contentType, scenario: { type: d.scenario.type, branching: d.scenario.branching }, feedback: { mode: d.feedback.mode, timing: d.feedback.timing } };
        case 'presentation':
          return { contentType: d.contentType, sequence: [...d.sequence] };
        case 'video':
          return { style: d.video.style };
        case 'video_interactions':
          return { interactions: d.video.interactions, feedback: { mode: d.feedback.mode, timing: d.feedback.timing } };
        case 'activity':
          return { intent: d.activity.intent, scenario: { type: d.scenario.type, branching: d.scenario.branching }, feedback: { mode: d.feedback.mode, timing: d.feedback.timing } };
        default:
          throw new Error(`manifestItemDesign: tipo de item sin diseño definido: ${type}`);
      }
    }
  }
}
