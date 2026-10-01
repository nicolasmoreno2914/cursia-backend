/**
 * R11a — validación SERVER-SIDE (pura) de los artifacts LLM de rulesVersion 3
 * antes de aceptar la completitud de un item (scheduler.completeItem).
 *
 * | item               | artifact validado                  | validador                                  |
 * |--------------------|------------------------------------|--------------------------------------------|
 * | course_intro       | dynamic_course_intro_json          | validateCourseIntroV3 (+ lints R2)         |
 * | module_intro       | dynamic_module_intro_json          | validateModuleIntroV3 (journey = capítulos)|
 * | experience         | dynamic_experience_json            | validateExperience (R2) + validatePedagogy (EV2) + validateSimulatedDiagrams (EV6) + validateEduFields (P3, ≥ v21-exp-6) + chapterId |
 * | video_interactions | dynamic_video_interactions_json    | validateVideoInteractionsDoc (R8)          |
 * | activity (h5p)     | dynamic_h5p_params_json            | validateH5pActivityPayload (R7 + rotación) |
 * | final_exam         | dynamic_exam_gift                  | validateExamGift (parseGIFT)               |
 * | exam / final_exam  | dynamic_exam_bank_json (EV6 P2)    | validateExamBank (plan del Manifest)       |
 *
 * EV6 P2 (despliegue mixto): `exam` y `final_exam` aceptan EXACTAMENTE uno de
 * `dynamic_exam_bank_json` | `dynamic_exam_gift`; se valida según el tipo que
 * se subió (ambos → EXAM_ARTIFACT_AMBIGUOUS). El GIFT de módulo sigue sin
 * validación de contenido (como antes). `activity` scorm: solo roles de R4.
 * Todo lo demás de v1/v2: sin cambios.
 */
import { eduMetrics, validateEduFields, validateExperience, validatePedagogy, validateSimulatedDiagrams } from '../visual-components';
import { H5pInputError, VideoPlanError, planInteractionCheckpoints, validateVideoInteractionsDoc } from '../../package/h5p';
import type { VideoCheckpoint } from '../../package/h5p';
import { H5pActivityType, ShellValidationError, activityTypeForChapter, validateH5pActivityPayload } from './activity-type';
import { validateCourseIntroV3, validateModuleIntroV3 } from './intro-schemas';
import { FINAL_EXAM_QUESTION_RANGE, validateExamGift } from './final-exam';
import { EXAM_BANK_ARTIFACT_TYPE, EXAM_BANK_VERSION, EXAM_GIFT_ARTIFACT_TYPE, ExamPlanLeaf, expectedExamPlan, validateExamBank } from './exam-bank';

export const V3_PAYLOAD_INVALID = 'v3_payload_invalid';

/**
 * EV6 P2: artifacts cuyo contenido valida el servidor, por tipo de item v3 (lista vacía = solo roles).
 * `exam`: solo el banco (el GIFT de módulo sigue sin validación de contenido); `final_exam`: banco o GIFT.
 */
export function v3ValidatedArtifactTypes(type: string, variant?: string | null): string[] {
  if (type === 'exam') return [EXAM_BANK_ARTIFACT_TYPE];
  if (type === 'final_exam') return [EXAM_BANK_ARTIFACT_TYPE, EXAM_GIFT_ARTIFACT_TYPE];
  const t = v3ValidatedArtifactType(type, variant);
  return t ? [t] : [];
}

/** Artifact preferido que se valida por tipo de item v3 (null = sin validación de contenido). EV6 P2: exámenes → el banco. */
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
    case 'exam':
    case 'final_exam':
      return EXAM_BANK_ARTIFACT_TYPE;
    default:
      return null;
  }
}

export interface V3ItemValidationContext {
  type: string;
  variant?: string | null;
  itemKey: string;
  chapterId?: string | null;
  /** Numeración global del Manifest (informativo). */
  chapterNumber?: number | null;
  /**
   * EV5-C: tipo h5p esperado = resolveActivityType(item del Manifest congelado).
   * Ausente → rotación por hash del chapterId (compatibilidad).
   */
  expectedActivityType?: H5pActivityType | null;
  /** module_intro: capítulos del módulo en orden del Manifest. */
  moduleChapterIds?: string[];
  /** video_interactions: video completado del capítulo. */
  video?: { videoItemKey: string; durationSec: number } | null;
  /** Edu EV2: promptVersion que reporta el ejecutor (summary). La estructura educativa se exige solo a partir de v21-exp-4. */
  promptVersion?: string | null;
  /**
   * EV6 P2: tipo del artifact que se valida (exam/final_exam aceptan banco o GIFT).
   * Ausente en final_exam → GIFT (compatibilidad).
   */
  artifactType?: string | null;
  /** EV6 P2: capítulos del examen (orden del Manifest congelado) con su módulo; exigidos para validar un banco. */
  examChapters?: Array<{ id: string; moduleId: string }>;
  /** EV6 P2 fix 1 (I1): Markdown vigente (dynamic_content_md) de los capítulos del examen → EXAM_BANK_EVIDENCE al completar. */
  examChapterMd?: ReadonlyMap<string, string>;
}

/**
 * Edu EV2 — compatibilidad de despliegue: la estructura educativa (validatePedagogy) se exige solo a
 * experiencias generadas con el prompt que la pide (≥ v21-exp-4). Una pestaña con el bundle anterior
 * no queda reintentando (y pagando) contra una regla que su prompt no conoce. No es un control de
 * seguridad: el ejecutor es de Cursia.
 */
export const PEDAGOGY_MIN_EXPERIENCE_PROMPT = 4;
export function pedagogyApplies(promptVersion: string | null | undefined): boolean {
  const m = /^v21-exp-(\d+)$/.exec(String(promptVersion ?? ''));
  return !!m && Number(m[1]) >= PEDAGOGY_MIN_EXPERIENCE_PROMPT;
}

/**
 * EV6 — diagramas simulados con texto (DIAGRAM_BRANCHING_IN_SEQUENCE / TEXT_SIMULATED_DIAGRAM): mismo
 * criterio de despliegue que la pedagogía, a partir del prompt que describe el kind "decision" (v21-exp-5).
 */
export const ANTI_SIMULATION_MIN_EXPERIENCE_PROMPT = 5;
export function antiSimulationApplies(promptVersion: string | null | undefined): boolean {
  const m = /^v21-exp-(\d+)$/.exec(String(promptVersion ?? ''));
  return !!m && Number(m[1]) >= ANTI_SIMULATION_MIN_EXPERIENCE_PROMPT;
}

/**
 * P3 — «¿Por qué importa?» / «¿Cómo lo aplicas?» (validateEduFields): mismo criterio de despliegue, a
 * partir del prompt que los pide (v21-exp-6). Las experiencias anteriores no los tienen y siguen válidas.
 */
export const EDU_FIELDS_MIN_EXPERIENCE_PROMPT = 6;
export function eduFieldsApply(promptVersion: string | null | undefined): boolean {
  const m = /^v21-exp-(\d+)$/.exec(String(promptVersion ?? ''));
  return !!m && Number(m[1]) >= EDU_FIELDS_MIN_EXPERIENCE_PROMPT;
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

  if (ctx.type === 'exam' || ctx.type === 'final_exam') {
    const artifactType = ctx.artifactType ?? (ctx.type === 'final_exam' ? EXAM_GIFT_ARTIFACT_TYPE : null);
    if (artifactType === EXAM_GIFT_ARTIFACT_TYPE && ctx.type === 'final_exam') {
      const r = validateExamGift(text, FINAL_EXAM_QUESTION_RANGE);
      return { ok: r.ok, errors: r.errors, summary: { questionCount: r.questionCount } };
    }
    if (artifactType !== EXAM_BANK_ARTIFACT_TYPE) {
      throw new Error(`V3_VALIDATION_CONTEXT: el item ${ctx.itemKey} (${ctx.type}) no tiene validación de contenido para ${String(artifactType)}`);
    }
    if (!ctx.examChapters || ctx.examChapters.length === 0) {
      throw new Error(`V3_VALIDATION_CONTEXT: ${ctx.type} ${ctx.itemKey} sin capítulos del examen`);
    }
    const parsedBank = parseJson(text);
    if (parsedBank.ok === false) return { ok: false, errors: [parsedBank.error] };
    const r = validateExamBank(parsedBank.value, {
      scope: ctx.type === 'exam' ? 'module' : 'final',
      chapters: ctx.examChapters,
      ...(ctx.examChapterMd ? { chapterMd: ctx.examChapterMd } : {}),
    });
    // questionCount = slots (lo que ve el estudiante), no el tamaño del banco.
    return { ok: r.ok, errors: r.errors, summary: { questionCount: r.slotCount, bankSize: r.bankSize, bankVersion: EXAM_BANK_VERSION } };
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
      // Edu EV2: estructura educativa mínima, solo para experiencias NUEVAS (el empaque no la exige:
      // los cursos ya generados siguen siendo válidos).
      if (r.ok && pedagogyApplies(ctx.promptVersion)) for (const e of validatePedagogy(doc as never)) errors.push({ path: e.path, code: e.code, message: e.message });
      if (r.ok && antiSimulationApplies(ctx.promptVersion)) for (const e of validateSimulatedDiagrams(doc as never)) errors.push({ path: e.path, code: e.code, message: e.message });
      if (r.ok && eduFieldsApply(ctx.promptVersion)) for (const e of validateEduFields(doc as never)) errors.push({ path: e.path, code: e.code, message: e.message });
      const cid = doc && typeof doc === 'object' ? (doc as Record<string, unknown>).chapterId : undefined;
      if (typeof cid === 'string' && cid !== ctx.chapterId) {
        errors.push({ path: '$.chapterId', code: 'CHAPTER_ID_MISMATCH', message: `chapterId debe ser "${ctx.chapterId}"` });
      }
      // P3: métricas observables (no bloquean): bloques con why/apply y la racha de texto más larga.
      return { ok: errors.length === 0, errors, ...(r.ok ? { summary: { edu: eduMetrics(doc as never) } } : {}) };
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
      const expectedType = ctx.expectedActivityType ?? activityTypeForChapter(ctx.chapterId);
      const r = validateH5pActivityPayload(doc, { chapterId: ctx.chapterId, itemKey: ctx.itemKey, expectedType });
      return { ...r, summary: { activityType: expectedType } };
    }
    default:
      throw new Error(`V3_VALIDATION_CONTEXT: tipo ${ctx.type} sin validador`);
  }
}

/**
 * EV6 P2: capítulos de un examen según el Manifest congelado (orden del Manifest):
 * `exam` → los del módulo `moduleId`; `final_exam` → todos los del curso. Vacío si
 * el módulo no existe (el caller falla fuerte).
 */
export function examChaptersFromManifest(
  manifest: { modules?: Array<{ moduleId: string; chapters?: Array<{ chapterId: string }> }> } | null | undefined,
  type: 'exam' | 'final_exam',
  moduleId?: string | null,
): Array<{ id: string; moduleId: string }> {
  const mods = (manifest?.modules ?? []).filter((m) => type === 'final_exam' || m.moduleId === moduleId);
  return mods.flatMap((m) => (m.chapters ?? []).map((c) => ({ id: c.chapterId, moduleId: m.moduleId })));
}

/** EV6 P2: lo que el claim de un examen v3 entrega al ejecutor para armar el banco (el plan es el que valida el servidor). */
export interface ExamBankClaimFacts {
  artifactType: typeof EXAM_BANK_ARTIFACT_TYPE;
  bankVersion: typeof EXAM_BANK_VERSION;
  scope: 'module' | 'final';
  moduleId: string | null;
  chapters: Array<{ chapterId: string; moduleId: string }>;
  plan: ExamPlanLeaf[];
}

export function examBankClaimFacts(
  manifest: Parameters<typeof examChaptersFromManifest>[0],
  type: 'exam' | 'final_exam',
  moduleId?: string | null,
): ExamBankClaimFacts | null {
  const chapters = examChaptersFromManifest(manifest, type, moduleId);
  if (chapters.length === 0) return null;
  const scope = type === 'exam' ? 'module' : 'final';
  return {
    artifactType: EXAM_BANK_ARTIFACT_TYPE,
    bankVersion: EXAM_BANK_VERSION,
    scope,
    moduleId: scope === 'module' ? (moduleId as string) : null,
    chapters: chapters.map((c) => ({ chapterId: c.id, moduleId: c.moduleId })),
    plan: expectedExamPlan(scope, chapters),
  };
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
