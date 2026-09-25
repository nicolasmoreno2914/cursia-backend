/**
 * Fase 5B.1 — B1 (PLACEHOLDER, bloque en paralelo).
 *
 * Este archivo es un stand-in mínimo de `buildPackagingPlan`, escrito por el
 * bloque B3 SOLO para poder compilar y probar el resto de la ejecución
 * (endpoint + worker) mientras B1 construye la versión real y determinística
 * descrita en el spec §3 / §7. B1 reemplaza el contenido de este archivo
 * entero al integrar — la firma exportada (`buildPackagingPlan`) y los tipos
 * de `packaging-types.ts` son el contrato compartido y no deberían cambiar.
 *
 * Diferencias conocidas frente al spec real que B1 debe cerrar:
 * - No valida exhaustivamente el Manifest contra el Blueprint (asume que
 *   `manifest.items` y `blueprint.modules/chapters` son consistentes).
 * - No fija un hash/versión de plan para el check de determinismo de CI
 *   (`scripts/check-packaging-plan-determinism.js`, tarea de B1).
 */

import type { BlueprintModule, BlueprintChapter } from '../course-blueprints/blueprint-snapshot';
import type {
  BlueprintSnapshotV1,
  GenerationManifestV1,
  PackagingChapterPlan,
  PackagingModulePlan,
  PackagingPlan,
} from './packaging-types';

export function buildPackagingPlan(
  manifest: GenerationManifestV1,
  blueprint: BlueprintSnapshotV1,
  ctx: { manifestId: number | null },
): PackagingPlan {
  const itemsByChapterAndType = new Map<string, string>(); // `${type}:${chapterId||moduleId}` -> item.key
  for (const it of manifest.items) {
    const scopeId = it.chapterId ?? it.moduleId;
    itemsByChapterAndType.set(`${it.type}:${scopeId}`, it.key);
  }

  const sortedModules = [...blueprint.modules].sort((a, b) => a.position - b.position);

  let globalChapterNumber = 0;
  const modules: PackagingModulePlan[] = sortedModules.map((m: BlueprintModule, mIdx: number) => {
    const moduleNumber = mIdx + 1;
    const sortedChapters = [...m.chapters].sort((a, b) => a.position - b.position);
    const chapters: PackagingChapterPlan[] = sortedChapters.map((c: BlueprintChapter) => {
      globalChapterNumber += 1;
      const contentItemKey = itemsByChapterAndType.get(`content:${c.id}`) ?? `content:${c.id}`;
      const scormItemKey = itemsByChapterAndType.get(`scorm:${c.id}`) ?? `scorm:${c.id}`;
      const videoItemKey = itemsByChapterAndType.get(`video:${c.id}`) ?? null;
      return {
        chapterId: c.id,
        moduleId: m.id,
        chapterNumber: globalChapterNumber,
        moduleNumber,
        title: c.title,
        objective: c.objective ?? null,
        contentItemKey,
        scormItemKey,
        videoItemKey,
      };
    });

    const examItemKey = itemsByChapterAndType.get(`exam:${m.id}`) ?? null;

    return {
      moduleId: m.id,
      moduleNumber,
      sectionNum: 1 + moduleNumber,
      title: m.title,
      objective: m.objective ?? null,
      colorIndex: moduleNumber - 1,
      chapters,
      examItemKey,
    };
  });

  const sections: PackagingPlan['sections'] = [
    { sectionNum: 0, kind: 'welcome', title: 'Bienvenida' },
    { sectionNum: 1, kind: 'route_and_book', title: 'Ruta del curso y Libro Guía' },
    ...modules.map((m) => ({ sectionNum: m.sectionNum, kind: 'module' as const, moduleId: m.moduleId, title: m.title })),
  ];

  const totals = {
    modules: modules.length,
    chapters: modules.reduce((n, m) => n + m.chapters.length, 0),
    scorms: modules.reduce((n, m) => n + m.chapters.length, 0),
    videos: modules.reduce((n, m) => n + m.chapters.filter((c) => c.videoItemKey !== null).length, 0),
    exams: modules.filter((m) => m.examItemKey !== null).length,
  };

  return {
    planVersion: 1,
    manifestId: ctx.manifestId,
    course: { id: blueprint.course.id, title: blueprint.course.title, summary: null },
    sections,
    modules,
    totals,
  };
}
