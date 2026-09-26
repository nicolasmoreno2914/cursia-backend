/**
 * Cursia V2.1 — R12: plan de empaquetado para Manifests rulesVersion 3.
 *
 * Puro y determinístico (mismo patrón que `packaging-plan.ts` v1/v2, que NO
 * cambia y sigue rechazando v3). Los números (módulo, capítulo, sección)
 * salen SOLO del Manifest congelado; los títulos se unen por UUID contra el
 * Blueprint v2 cuyo sha es `manifest.source.blueprintSha256`.
 *
 * Secciones Moodle (brief R12):
 *   0             — shell: foro, bienvenida, audio de bienvenida, competencias, metodología
 *   1             — ruta, Libro Guía (resource + tarjeta), audiolibro
 *   1 + m         — un módulo por sección (intro, capítulos, examen del módulo)
 *   2 + M         — cierre (label de cierre + examen final si course.finalExam)
 *
 * Cada item del Manifest queda consumido por EXACTAMENTE un lugar del plan;
 * un item desconocido o faltante es un Manifest roto → PackagingPlanV3Error.
 */
import { createHash } from 'crypto';
import type { GenerationManifestV1, ManifestItem } from '../generation-manifests/generation-manifest-builder';
import { BlueprintSnapshotV2, snapshotSha256V2 } from '../course-blueprints/blueprint-snapshot';

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
  title: string;
  videoEnabled: boolean;
  activityEnabled: boolean;
  activityVariant: 'h5p' | 'scorm' | null;
  keys: {
    content: string;
    experience: string;
    presentation: string;
    audiobookChapter: string;
    video: string | null;
    videoInteractions: string | null;
    activity: string | null;
  };
}

export interface PackagingModulePlanV3 {
  moduleId: string;
  moduleNumber: number;
  sectionNum: number;
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
  sections: Array<{ sectionNum: number; kind: 'shell' | 'route_and_book' | 'module' | 'closing'; moduleId?: string; title: string }>;
  modules: PackagingModulePlanV3[];
  closingSectionNum: number;
}

export function buildPackagingPlanV3(
  manifest: GenerationManifestV1,
  blueprint: BlueprintSnapshotV2,
  opts?: { manifestId?: number | null },
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
      const activityEnabled = mc.activityEnabled === true;
      let variant: 'h5p' | 'scorm' | null = null;
      let activityKey: string | null = null;
      if (activityEnabled) {
        activityKey = take(`activity:${id}`, 'activity');
        const v = byKey.get(activityKey)?.variant;
        if (v !== features.activityEngine) throw new PackagingPlanV3Error(`activity:${id} con variant ${String(v)} ≠ ${features.activityEngine}`);
        variant = v;
      }
      return {
        chapterId: id,
        moduleId: mm.moduleId,
        chapterNumber: mc.chapterNumber,
        moduleNumber: mm.moduleNumber,
        title: bc.title,
        videoEnabled: mc.videoEnabled === true,
        activityEnabled,
        activityVariant: variant,
        keys: {
          content: take(`content:${id}`, 'content'),
          experience: take(`experience:${id}`, 'experience'),
          presentation: take(`presentation:${id}`, 'presentation'),
          audiobookChapter: take(`audiobook_chapter:${id}`, 'audiobook_chapter'),
          video: mc.videoEnabled ? take(`video:${id}`, 'video') : null,
          videoInteractions: mc.videoEnabled ? take(`video_interactions:${id}`, 'video_interactions') : null,
          activity: activityKey,
        },
      };
    });
    return {
      moduleId: mm.moduleId,
      moduleNumber: mm.moduleNumber,
      sectionNum: 1 + mm.moduleNumber,
      title: bm.title,
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

  const closingSectionNum = 2 + modules.length;
  const sections: PackagingPlanV3['sections'] = [
    { sectionNum: 0, kind: 'shell', title: 'Bienvenida' },
    { sectionNum: 1, kind: 'route_and_book', title: 'Ruta de aprendizaje y Libro Guía' },
    ...modules.map((m) => ({ sectionNum: m.sectionNum, kind: 'module' as const, moduleId: m.moduleId, title: `Módulo ${m.moduleNumber} — ${m.title}` })),
    { sectionNum: closingSectionNum, kind: 'closing', title: 'Cierre del curso' },
  ];
  return {
    planVersion: 3,
    rulesVersion: 3,
    manifestId: opts?.manifestId ?? null,
    course: { id: courseId, title: blueprint.course.title },
    features: { finalExam: features.finalExam, activityEngine: features.activityEngine },
    keys,
    sections,
    modules,
    closingSectionNum,
  };
}

/** JSON canónico (orden de claves fijo por construcción) y su sha256. */
export function packagingPlanV3Sha256(p: PackagingPlanV3): string {
  return createHash('sha256').update(JSON.stringify(p), 'utf8').digest('hex');
}
