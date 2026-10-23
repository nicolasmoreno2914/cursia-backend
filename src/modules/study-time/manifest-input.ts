// Motor de carga horaria — entrada del modelo de tiempo desde un Manifest v3 (lo que se va a generar).
//
// Cada recurso existe si el Manifest tiene su trabajo: página (experience), Libro Guía (content),
// presentación, video (+ preguntas), actividad, Actividad de Aplicación (Fase 2, con sus minutos), práctica guiada (Loop 9 B),
// apertura de módulo, exámenes, bienvenida y audio de bienvenida. El «Repaso» depende del ajuste del Blueprint (mismas condiciones que el empaque) y el foro
// lo agrega siempre el shell del curso. Las medidas (si ya se generó) llegan aparte y reemplazan a los
// valores planificados.
import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import type { GenerationManifestV1 } from '../generation-manifests/generation-manifest-builder';
import { StudyTimeChapterInput, StudyTimeCourseInput, StudyTimeError } from './time-model';
import { TimeModelConfig, resolveTimeModelConfig } from './time-model-config';

/** Medidas opcionales del curso ya generado (cualquier subconjunto). */
export interface StudyTimeMeasurements {
  pageWordsByChapter?: Record<string, number>;
  libroWordsByChapter?: Record<string, number>;
  slidesByChapter?: Record<string, number>;
  videoSecondsByChapter?: Record<string, number>;
  activityItemsByChapter?: Record<string, number>;
  reviewCardsByChapter?: Record<string, number>;
  /** Capítulos con «Repaso» real (el empaque omite mazos de < 4 tarjetas). Ausente = según el Blueprint. */
  reviewChapterIds?: readonly string[];
  examQuestionsByModule?: Record<string, number>;
  finalExamQuestions?: number;
  frameWords?: number;
  introWordsByModule?: Record<string, number>;
  welcomeAudioSeconds?: number;
  /**
   * Loop 9 B · capítulos cuya práctica guiada tiene su artifact VALIDADO (al empaquetar). Presente = solo esos suman sus
   * minutos (una práctica que falta no se cuenta: la diferencia queda a la vista). Ausente = las del Manifest (plan).
   */
  guidedPracticeChapterIds?: readonly string[];
}

/**
 * r58 (I3): configuración del modelo de tiempo congelada en el Blueprint (`course.hoursModel`); sin ella, el default.
 * Lanza HOURS_MODEL_INVALID si la del Blueprint no valida (nunca se cae al default en silencio).
 */
export function timeModelConfigOf(blueprint: BlueprintSnapshotV2): TimeModelConfig {
  return resolveTimeModelConfig(blueprint?.course?.hoursModel);
}

/**
 * ¿El curso lleva «Repaso» (Dialog Cards)? Ajuste del Blueprint + H5P v2 + motor h5p. Predicado ÚNICO:
 * el empaque v3 (`reviewCardsApply`) lo usa también.
 */
export function reviewCardsEnabledFor(blueprint: BlueprintSnapshotV2, manifest: GenerationManifestV1): boolean {
  return blueprint.course.reviewCards === true && manifest.features?.activityTypeRules === 2 && blueprint.course.activityEngine === 'h5p';
}

/** Minutos de la Actividad de Aplicación de un capítulo (del item del Manifest; falta o inválido → throw). */
function applicationMinutesOf(manifest: GenerationManifestV1, chapterId: string): number {
  const it = manifest.items.find((i) => i.type === 'application_activity' && i.chapterId === chapterId);
  const m = it?.applicationMinutes;
  if (typeof m !== 'number') throw new StudyTimeError(`application_activity:${chapterId} sin applicationMinutes`);
  return m;
}

/** Loop 9 B: minutos de la práctica guiada de un capítulo (del item del Manifest; falta o inválido → throw). */
function guidedPracticeMinutesOf(manifest: GenerationManifestV1, chapterId: string): number {
  const it = manifest.items.find((i) => i.type === 'guided_practice' && i.chapterId === chapterId);
  const m = it?.guidedPracticeMinutes;
  if (typeof m !== 'number') throw new StudyTimeError(`guided_practice:${chapterId} sin guidedPracticeMinutes`);
  return m;
}

export function studyTimeInputFromManifest(
  manifest: GenerationManifestV1,
  blueprint: BlueprintSnapshotV2,
  measured: StudyTimeMeasurements = {},
): StudyTimeCourseInput {
  if (!manifest || manifest.rulesVersion !== 3) throw new StudyTimeError('el estimador necesita un Manifest rulesVersion 3');
  if (!blueprint || blueprint.schemaVersion !== 2) throw new StudyTimeError('el estimador necesita un Blueprint schemaVersion 2');
  const keys = new Set(manifest.items.map((i) => i.key));
  const has = (type: string, id: string) => keys.has(`${type}:${id}`);
  const hasType = (type: string) => manifest.items.some((i) => i.type === type);
  const review = reviewCardsEnabledFor(blueprint, manifest);
  const reviewIds = measured.reviewChapterIds ? new Set(measured.reviewChapterIds) : null;
  const guidedIds = measured.guidedPracticeChapterIds ? new Set(measured.guidedPracticeChapterIds) : null;
  const ivAdvanced = manifest.features?.ivAdvanced === 1;
  const pick = (rec: Record<string, number> | undefined, id: string) => (rec && Object.prototype.hasOwnProperty.call(rec, id) ? rec[id] : undefined);

  return {
    frame: hasType('course_intro'),
    frameWords: measured.frameWords,
    welcomeAudio: hasType('audio_welcome'),
    welcomeAudioSeconds: measured.welcomeAudioSeconds,
    // El shell v3 siempre publica el foro del curso.
    forum: true,
    finalExam: hasType('final_exam'),
    finalExamQuestions: measured.finalExamQuestions,
    modules: manifest.modules.map((m) => ({
      moduleId: m.moduleId,
      intro: has('module_intro', m.moduleId),
      introWords: pick(measured.introWordsByModule, m.moduleId),
      exam: m.examEnabled,
      examQuestions: pick(measured.examQuestionsByModule, m.moduleId),
      chapters: m.chapters.map((c): StudyTimeChapterInput => {
        const id = c.chapterId;
        return {
          chapterId: id,
          // Motor de carga horaria: capítulo de práctica (página de práctica guiada; sin Libro, presentación ni video).
          ...(c.kind === 'practice' ? { kind: 'practice' as const } : {}),
          // v3 siempre publica la página (experience) del capítulo.
          pageWords: pick(measured.pageWordsByChapter, id),
          libro: has('content', id),
          libroWords: pick(measured.libroWordsByChapter, id),
          presentation: has('presentation', id),
          slides: pick(measured.slidesByChapter, id),
          video: has('video', id),
          videoSeconds: pick(measured.videoSecondsByChapter, id),
          ivAdvanced,
          activity: has('activity', id),
          activityItems: pick(measured.activityItemsByChapter, id),
          review: reviewIds ? reviewIds.has(id) : review,
          reviewCards: pick(measured.reviewCardsByChapter, id),
          // Fase 2: la Actividad de Aplicación entra con sus minutos (nivel fijado por el diseño, nunca medido).
          ...(has('application_activity', id) ? { applicationMinutes: applicationMinutesOf(manifest, id) } : {}),
          // Loop 9 B: la práctica guiada entra con sus minutos (nivel del diseño); al empaquetar, solo si se validó.
          ...(has('guided_practice', id) && (!guidedIds || guidedIds.has(id)) ? { guidedPracticeMinutes: guidedPracticeMinutesOf(manifest, id) } : {}),
        };
      }),
    })),
  };
}
