/**
 * R11a — validación SERVER-SIDE (pura) de los artifacts LLM de rulesVersion 3
 * antes de aceptar la completitud de un item (scheduler.completeItem).
 *
 * | item               | artifact validado                  | validador                                  |
 * |--------------------|------------------------------------|--------------------------------------------|
 * | course_intro       | dynamic_course_intro_json          | validateCourseIntroV3 (+ lints R2)         |
 * | module_intro       | dynamic_module_intro_json          | validateModuleIntroV3 (journey = capítulos)|
 * | experience         | dynamic_experience_json            | validateExperience (R2) + chapterId        |
 * | video_interactions | dynamic_video_interactions_json    | validateVideoInteractionsDoc (R8)          |
 * | activity (h5p)     | dynamic_h5p_params_json            | validateH5pActivityPayload (R7 + rotación) |
 * | final_exam         | dynamic_exam_gift                  | validateExamGift (parseGIFT)               |
 *
 * `activity` scorm y `exam` de módulo siguen con sus artifacts existentes
 * (solo el chequeo de roles de R4). Todo lo demás de v1/v2: sin cambios.
 */
import { validateExperience } from '../visual-components';
import { H5pInputError, VideoPlanError, planInteractionCheckpoints, validateVideoInteractionsDoc } from '../../package/h5p';
import type { VideoCheckpoint } from '../../package/h5p';
import { ShellValidationError, activityTypeForChapter, validateH5pActivityPayload } from './activity-type';
import { validateCourseIntroV3, validateModuleIntroV3 } from './intro-schemas';
import { FINAL_EXAM_QUESTION_RANGE, validateExamGift } from './final-exam';

export const V3_PAYLOAD_INVALID = 'v3_payload_invalid';

/** Artifact que se valida por tipo de item v3 (null = sin validación de contenido en R11a). */
export function v3ValidatedArtifactType(type: string, variant?: string | null): string | null {
  switch (type) {
    case 'course_intro':
      return 'dynamic_course_intro_json';
    case 'module_intro':
      return 'dynamic_module_intro_json';
    case 'experience':
      return 'dynamic_experience_json';
    case 'video_interactions':
      return 'dynamic_video_interactions_json';
    case 'activity':
      return variant === 'h5p' ? 'dynamic_h5p_params_json' : null;
    case 'final_exam':
      return 'dynamic_exam_gift';
    default:
      return null;
  }
}

export interface V3ItemValidationContext {
  type: string;
  variant?: string | null;
  itemKey: string;
  chapterId?: string | null;
  /** Numeración global del Manifest (informativo; el tipo h5p sale de chapterId). */
  chapterNumber?: number | null;
  /** module_intro: capítulos del módulo en orden del Manifest. */
  moduleChapterIds?: string[];
  /** video_interactions: video completado del capítulo. */
  video?: { videoItemKey: string; durationSec: number } | null;
}

export interface V3ItemValidationResult {
  ok: boolean;
  errors: ShellValidationError[];
  /** Datos medidos para output_summary (p.ej. questionCount del GIFT final). */
  summary?: Record<string, unknown>;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: ShellValidationError } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: { path: '$', code: 'JSON_INVALID', message: `JSON inválido: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

function h5pErrors(err: unknown): ShellValidationError[] {
  if (err instanceof H5pInputError) return err.errors.map((m) => ({ path: '$', code: 'H5P_INPUT_INVALID', message: m }));
  throw err;
}

/**
 * Valida el contenido (texto crudo) del artifact principal de un item v3.
 * Nunca lanza por contenido inválido: devuelve TODOS los errores. Lanza solo
 * si el contexto del item es inconsistente (bug de integración).
 */
export function validateV3ItemArtifact(ctx: V3ItemValidationContext, text: string): V3ItemValidationResult {
  const expected = v3ValidatedArtifactType(ctx.type, ctx.variant);
  if (!expected) throw new Error(`V3_VALIDATION_CONTEXT: el item ${ctx.itemKey} (${ctx.type}) no tiene validación de contenido`);

  if (ctx.type === 'final_exam') {
    const r = validateExamGift(text, FINAL_EXAM_QUESTION_RANGE);
    return { ok: r.ok, errors: r.errors, summary: { questionCount: r.questionCount } };
  }

  const parsed = parseJson(text);
  if (parsed.ok === false) return { ok: false, errors: [parsed.error] };
  const doc = parsed.value;

  switch (ctx.type) {
    case 'course_intro':
      return validateCourseIntroV3(doc);
    case 'module_intro': {
      if (!ctx.moduleChapterIds || ctx.moduleChapterIds.length === 0) {
        throw new Error(`V3_VALIDATION_CONTEXT: module_intro ${ctx.itemKey} sin capítulos del módulo`);
      }
      return validateModuleIntroV3(doc, { chapterIds: ctx.moduleChapterIds });
    }
    case 'experience': {
      if (!ctx.chapterId) throw new Error(`V3_VALIDATION_CONTEXT: experience ${ctx.itemKey} sin chapterId`);
      const r = validateExperience(doc);
      const errors: ShellValidationError[] = r.errors.map((e) => ({ path: e.path, code: e.code, message: e.message }));
      const cid = doc && typeof doc === 'object' ? (doc as Record<string, unknown>).chapterId : undefined;
      if (typeof cid === 'string' && cid !== ctx.chapterId) {
        errors.push({ path: '$.chapterId', code: 'CHAPTER_ID_MISMATCH', message: `chapterId debe ser "${ctx.chapterId}"` });
      }
      return { ok: errors.length === 0, errors };
    }
    case 'video_interactions': {
      if (!ctx.video) throw new Error(`V3_VALIDATION_CONTEXT: video_interactions ${ctx.itemKey} sin datos del video`);
      try {
        const plan = validateVideoInteractionsDoc(doc, { videoItemKey: ctx.video.videoItemKey, durationSec: ctx.video.durationSec });
        return { ok: true, errors: [], summary: { interactionCount: plan.length } };
      } catch (err) {
        return { ok: false, errors: h5pErrors(err) };
      }
    }
    case 'activity': {
      if (!ctx.chapterId) throw new Error(`V3_VALIDATION_CONTEXT: activity ${ctx.itemKey} sin chapterId`);
      const r = validateH5pActivityPayload(doc, { chapterId: ctx.chapterId, itemKey: ctx.itemKey });
      return { ...r, summary: { activityType: activityTypeForChapter(ctx.chapterId) } };
    }
    default:
      throw new Error(`V3_VALIDATION_CONTEXT: tipo ${ctx.type} sin validador`);
  }
}

/** Mensaje de error del item (persistido en generation_item_runs.error). */
export function v3ValidationErrorMessage(ctx: { itemKey: string; type: string }, errors: ShellValidationError[]): string {
  const codes = [...new Set(errors.map((e) => e.code))].sort();
  const detail = errors.slice(0, 8).map((e) => `${e.path} ${e.code}: ${e.message}`).join(' | ');
  return `${V3_PAYLOAD_INVALID}: ${ctx.type} ${ctx.itemKey} rechazado por el validador del servidor [${codes.join(', ')}] ${detail}`;
}

// ─── Datos del video para video_interactions (claim y completitud) ─────────

export interface VideoClaimFacts {
  videoItemKey: string;
  youtubeId: string;
  durationSec: number;
  checkpoints: VideoCheckpoint[];
}

export type VideoClaimFactsResult = { ok: true; video: VideoClaimFacts } | { ok: false; code: string; message: string };

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Datos del video COMPLETADO (output_summary del item video + metadata de su
 * artifact `dynamic_video`): youtubeId y duración real → plan de checkpoints
 * de R8. Sin youtubeId o sin duración medida → error explícito (nunca se
 * inventa una duración ni se planifica contra un número supuesto).
 */
export function videoClaimFacts(input: {
  videoItemKey: string;
  outputSummary?: Record<string, any> | null;
  artifactMetadata?: Record<string, any> | null;
}): VideoClaimFactsResult {
  const os = input.outputSummary ?? {};
  const md = input.artifactMetadata ?? {};
  const youtubeId = os.youtubeVideoId ?? md.youtubeVideoId ?? null;
  const durationSec = os.durationSec ?? md.durationSec ?? null;
  if (typeof youtubeId !== 'string' || !YOUTUBE_ID_RE.test(youtubeId)) {
    return {
      ok: false,
      code: 'VIDEO_YOUTUBE_ID_MISSING',
      message: `el video ${input.videoItemKey} no tiene un youtubeVideoId válido (el video interactivo necesita la entrega por YouTube)`,
    };
  }
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return {
      ok: false,
      code: 'VIDEO_DURATION_MISSING',
      message: `el video ${input.videoItemKey} no registró su duración medida (durationSec); no se planifican preguntas sobre una duración supuesta`,
    };
  }
  try {
    const checkpoints = planInteractionCheckpoints(durationSec);
    return { ok: true, video: { videoItemKey: input.videoItemKey, youtubeId, durationSec, checkpoints } };
  } catch (err) {
    if (err instanceof VideoPlanError) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
}
