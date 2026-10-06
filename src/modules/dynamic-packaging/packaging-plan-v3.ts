/**
 * Cursia V2.1 — R12: plan de empaquetado para Manifests rulesVersion 3.
 *
 * Puro y determinístico (mismo patrón que `packaging-plan.ts` v1/v2, que NO
 * cambia y sigue rechazando v3). Los números (módulo, capítulo, sección)
 * salen SOLO del Manifest congelado; los títulos se unen por UUID contra el
 * Blueprint v2 cuyo sha es `manifest.source.blueprintSha256`.
 *
 * Secciones Moodle (EV6: una sección por página, `section-layout.ts`):
 *   0             — shell: foro, bienvenida, audio de bienvenida, competencias, metodología
 *   1             — ruta, Libro Guía (resource + tarjeta), audiolibro
 *   luego, por módulo: una sección por capítulo («Módulo m · Capítulo n: título»; la
 *                   presentación del módulo arriba de su primer capítulo) y, si el módulo
 *                   tiene examen, «Módulo m · Evaluación»
 *   «Evaluación final» (si course.finalExam) y, al final, «Cierre del curso».
 *
 * Cada item del Manifest queda consumido por EXACTAMENTE un lugar del plan;
 * un item desconocido o faltante es un Manifest roto → PackagingPlanV3Error.
 */
import { createHash } from 'crypto';
import { displayStructureTitle } from '../course-structure/structure-titles';
import type { GenerationManifestV1, ManifestItem } from '../generation-manifests/generation-manifest-builder';
import { BlueprintSnapshotV2, snapshotSha256V2 } from '../course-blueprints/blueprint-snapshot';
import { SectionEntryV3, sectionLayoutV3 } from '../course-shell/section-layout';

export class PackagingPlanV3Error extends Error {
  constructor(message: string) {
    super(`PACKAGING_PLAN_V3_INVALID: ${message}`);
    this.name = 'PackagingPlanV3Error';
  }
}

export interface PackagingChapterPlanV3 {
  chapterId: string;
  moduleId: string;
  chapterNumber: number;
  moduleNumber: number;
  /** EV6: sección Moodle del capítulo. */
  sectionNum: number;
  title: string;
  /** Video REAL en el paquete (false si el capítulo no tiene video o si su video quedó pendiente). */
  videoEnabled: boolean;
  /**
   * EV6 T5: el capítulo tiene video en el Manifest pero su video todavía es de vista previa
   * (mock): se omite del paquete (sin actividad, sin guía, sin mención en el recorrido).
   */
  videoPending: boolean;
  activityEnabled: boolean;
  activityVariant: 'h5p' | 'scorm' | null;
  /**
   * Motor de carga horaria: SOLO en capítulos de práctica (los de contenido no llevan la clave: el sha del plan
   * de siempre). Sin content (Libro), presentación, video ni audiolibro: esas keys son null.
   */
  kind?: 'practice';
  /** Fase 2: minutos de la Actividad de Aplicación, SOLO en capítulos que la tienen (sin la clave: sha de siempre). */
  applicationMinutes?: number;
  keys: {
    content: string | null;
    experience: string;
    presentation: string | null;
    audiobookChapter: string | null;
    video: string | null;
    videoInteractions: string | null;
    activity: string | null;
    /** Fase 2: SOLO en capítulos con Actividad de Aplicación (actividad + solucionario oculto). */
    application?: string;
  };
}

export interface PackagingModulePlanV3 {
  moduleId: string;
  moduleNumber: number;
  /** EV6: sección de su primer capítulo (arriba va la presentación del módulo). */
  firstSectionNum: number;
  /** EV6: sección «Módulo m · Evaluación»; null si el módulo no tiene examen. */
  examSectionNum: number | null;
  title: string;
  examEnabled: boolean;
  keys: { moduleIntro: string; exam: string | null };
  chapters: PackagingChapterPlanV3[];
}

export interface PackagingPlanV3 {
  planVersion: 3;
  rulesVersion: 3;
  manifestId: number | null;
  course: { id: number; title: string };
  features: { finalExam: boolean; activityEngine: 'h5p' | 'scorm' };
  keys: { coursePlan: string; courseIntro: string; audioWelcome: string; finalExam: string | null };
  sections: SectionEntryV3[];
  modules: PackagingModulePlanV3[];
  finalExamSectionNum: number | null;
  closingSectionNum: number;
  /**
   * EV6 T5: videos del Manifest omitidos por estar pendientes (vista previa), en orden del
   * plan. Sus items (video + video_interactions) quedan consumidos pero sin lugar en el paquete.
   */
  omittedVideos: Array<{ chapterId: string; chapterNumber: number; title: string; videoKey: string; videoInteractionsKey: string }>;
}

export function buildPackagingPlanV3(
  manifest: GenerationManifestV1,
  blueprint: BlueprintSnapshotV2,
  opts?: {
    manifestId?: number | null;
    /** EV6 T5: capítulos cuyo video está pendiente (vista previa) → se omite su video. */
    omitVideoChapterIds?: readonly string[] | null;
  },
): PackagingPlanV3 {
  if (!manifest || manifest.rulesVersion !== 3) throw new PackagingPlanV3Error('el Manifest debe ser rulesVersion 3');
  if (!blueprint || blueprint.schemaVersion !== 2) throw new PackagingPlanV3Error('el Blueprint debe ser schemaVersion 2');
  const sha = snapshotSha256V2(blueprint);
  if (sha !== manifest.source?.blueprintSha256) {
    throw new PackagingPlanV3Error(`blueprintSha256 no coincide (manifest=${manifest.source?.blueprintSha256}, snapshot=${sha})`);
  }
  const features = manifest.features;
  if (!features || typeof features.finalExam !== 'boolean' || (features.activityEngine !== 'h5p' && features.activityEngine !== 'scorm')) {
    throw new PackagingPlanV3Error('Manifest v3 sin features válidas');
  }
  const byKey = new Map<string, ManifestItem>();
  for (const it of manifest.items) {
    if (byKey.has(it.key)) throw new PackagingPlanV3Error(`item repetido ${it.key}`);
    byKey.set(it.key, it);
  }
  const omit = new Set<string>(opts?.omitVideoChapterIds ?? []);
  const videoChapterIds = new Set(manifest.modules.flatMap((m) => m.chapters.filter((c) => c.videoEnabled).map((c) => c.chapterId)));
  for (const id of omit) {
    if (!videoChapterIds.has(id)) throw new PackagingPlanV3Error(`omitVideoChapterIds: ${id} no es un capítulo con video en el Manifest`);
  }
  const consumed = new Set<string>();
  const take = (key: string, type: string): string => {
    const it = byKey.get(key);
    if (!it) throw new PackagingPlanV3Error(`falta el item ${key} en el Manifest`);
    if (it.type !== type) throw new PackagingPlanV3Error(`el item ${key} es ${it.type}, se esperaba ${type}`);
    if (consumed.has(key)) throw new PackagingPlanV3Error(`item ${key} consumido dos veces`);
    consumed.add(key);
    return key;
  };
  const courseId = manifest.source.courseId;
  const keys = {
    coursePlan: take(`course_plan:${courseId}`, 'course_plan'),
    courseIntro: take(`course_intro:${courseId}`, 'course_intro'),
    audioWelcome: take(`audio_welcome:${courseId}`, 'audio_welcome'),
    finalExam: features.finalExam ? take(`final_exam:${courseId}`, 'final_exam') : null,
  };

  const modules: PackagingModulePlanV3[] = manifest.modules.map((mm) => {
    const bm = blueprint.modules.find((m) => m.id === mm.moduleId);
    if (!bm) throw new PackagingPlanV3Error(`el módulo ${mm.moduleId} no está en el Blueprint`);
    const chapters: PackagingChapterPlanV3[] = mm.chapters.map((mc) => {
      const bc = bm.chapters.find((c) => c.id === mc.chapterId);
      if (!bc) throw new PackagingPlanV3Error(`el capítulo ${mc.chapterId} no está en el módulo ${mm.moduleId} del Blueprint`);
      const id = mc.chapterId;
      const practice = mc.kind === 'practice';
      const videoInManifest = mc.videoEnabled === true;
      if (practice && videoInManifest) throw new PackagingPlanV3Error(`el capítulo de práctica ${id} tiene video en el Manifest`);
      const videoPending = videoInManifest && omit.has(id);
      // Un video pendiente se consume igual (el Manifest queda cubierto) pero no ocupa lugar en el paquete.
      let videoKey: string | null = null;
      let videoInteractionsKey: string | null = null;
      if (videoInManifest) {
        videoKey = take(`video:${id}`, 'video');
        videoInteractionsKey = take(`video_interactions:${id}`, 'video_interactions');
      }
      const activityEnabled = mc.activityEnabled === true;
      let variant: 'h5p' | 'scorm' | null = null;
      let activityKey: string | null = null;
      if (activityEnabled) {
        activityKey = take(`activity:${id}`, 'activity');
        const v = byKey.get(activityKey)?.variant;
        if (v !== features.activityEngine) throw new PackagingPlanV3Error(`activity:${id} con variant ${String(v)} ≠ ${features.activityEngine}`);
        variant = v;
      }
      // Fase 2: la Actividad de Aplicación del capítulo (Manifest = fuente: chapters[].applicationMinutes).
      const applicationKey = mc.applicationMinutes !== undefined ? take(`application_activity:${id}`, 'application_activity') : null;
      if (applicationKey && byKey.get(applicationKey)?.applicationMinutes !== mc.applicationMinutes) {
        throw new PackagingPlanV3Error(`${applicationKey} con applicationMinutes distinto del capítulo del Manifest`);
      }
      return {
        chapterId: id,
        moduleId: mm.moduleId,
        chapterNumber: mc.chapterNumber,
        moduleNumber: mm.moduleNumber,
        sectionNum: -1, // se asigna abajo con el layout de secciones
        title: displayStructureTitle(bc.title),
        videoEnabled: videoInManifest && !videoPending,
        videoPending,
        activityEnabled,
        activityVariant: variant,
        ...(practice ? { kind: 'practice' as const } : {}),
        ...(applicationKey ? { applicationMinutes: mc.applicationMinutes as number } : {}),
        keys: {
          content: practice ? null : take(`content:${id}`, 'content'),
          experience: take(`experience:${id}`, 'experience'),
          presentation: practice ? null : take(`presentation:${id}`, 'presentation'),
          audiobookChapter: practice ? null : take(`audiobook_chapter:${id}`, 'audiobook_chapter'),
          video: videoPending ? null : videoKey,
          videoInteractions: videoPending ? null : videoInteractionsKey,
          activity: activityKey,
          ...(applicationKey ? { application: applicationKey } : {}),
        },
      };
    });
    return {
      moduleId: mm.moduleId,
      moduleNumber: mm.moduleNumber,
      firstSectionNum: -1,
      examSectionNum: null,
      title: displayStructureTitle(bm.title),
      examEnabled: mm.examEnabled === true,
      keys: {
        moduleIntro: take(`module_intro:${mm.moduleId}`, 'module_intro'),
        exam: mm.examEnabled ? take(`exam:${mm.moduleId}`, 'exam') : null,
      },
      chapters,
    };
  });
  const leftover = manifest.items.filter((i) => !consumed.has(i.key)).map((i) => i.key);
  if (leftover.length > 0) throw new PackagingPlanV3Error(`items del Manifest sin lugar en el paquete: ${leftover.join(', ')}`);

  const layout = sectionLayoutV3({
    modules: modules.map((m) => ({
      id: m.moduleId,
      number: m.moduleNumber,
      examEnabled: m.examEnabled,
      chapters: m.chapters.map((ch) => ({ id: ch.chapterId, number: ch.chapterNumber, title: ch.title })),
    })),
    finalExam: features.finalExam,
  });
  for (const m of modules) {
    m.firstSectionNum = layout.moduleFirstSection[m.moduleId];
    m.examSectionNum = m.examEnabled ? layout.examSection[m.moduleId] : null;
    for (const ch of m.chapters) ch.sectionNum = layout.chapterSection[ch.chapterId];
  }
  const omittedVideos = modules.flatMap((m) =>
    m.chapters
      .filter((ch) => ch.videoPending)
      .map((ch) => ({
        chapterId: ch.chapterId,
        chapterNumber: ch.chapterNumber,
        title: ch.title,
        videoKey: `video:${ch.chapterId}`,
        videoInteractionsKey: `video_interactions:${ch.chapterId}`,
      })),
  );
  const sections = layout.sections;
  const finalExamSectionNum = layout.finalExamSection;
  const closingSectionNum = layout.closingSection;
  return {
    planVersion: 3,
    rulesVersion: 3,
    manifestId: opts?.manifestId ?? null,
    course: { id: courseId, title: blueprint.course.title },
    features: { finalExam: features.finalExam, activityEngine: features.activityEngine },
    keys,
    sections,
    modules,
    finalExamSectionNum,
    closingSectionNum,
    omittedVideos,
  };
}

/** JSON canónico (orden de claves fijo por construcción) y su sha256. */
export function packagingPlanV3Sha256(p: PackagingPlanV3): string {
  return createHash('sha256').update(JSON.stringify(p), 'utf8').digest('hex');
}
