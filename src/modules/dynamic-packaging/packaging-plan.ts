/**
 * Fase 5B.1 — B1: capa determinística UUID → numeración de empaquetado.
 *
 * `buildPackagingPlan` es pura y determinística (spec §3): no hace I/O, no
 * llama IA, no cuenta nada por sí sola. Los números (moduleNumber,
 * chapterNumber, sectionNum) salen SOLO del Manifest congelado
 * (`GenerationManifestV1`); los títulos/objetivos se unen por UUID contra el
 * snapshot del Blueprint (`BlueprintSnapshotV1`) referenciado por
 * `manifest.source.blueprintId`. El join nunca usa el número como clave.
 *
 * Reglas (spec §3, vinculantes):
 * - secciones: 0 'welcome' ("Bienvenida"), 1 'route_and_book' ("Ruta de
 *   aprendizaje y Libro Guía"), luego una por módulo con
 *   sectionNum = 1 + moduleNumber, titulada `Módulo {moduleNumber} — {title}`.
 * - videoItemKey/examItemKey solo si esos items existen en manifest.items.
 * - sin examen final, sin sección de cierre (dynamic V1).
 * - totals se derivan del plan y deben coincidir con manifest.totals
 *   (assert — nunca deberían divergir dado que ambos derivan del mismo
 *   Manifest, pero un desacuerdo silencioso sería exactamente el patrón de
 *   "falla silenciosa" que CLAUDE.md pide evitar).
 */

import { createHash } from 'crypto';
import type {
  GenerationManifestV1,
  BlueprintSnapshotV1,
  PackagingChapterPlan,
  PackagingModulePlan,
  PackagingPlan,
} from './packaging-types';

/** Error de construcción del plan: Manifest y Blueprint snapshot no casan. */
export class PackagingPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackagingPlanError';
  }
}

/**
 * Recalcula el hash canónico del snapshot del Blueprint exactamente como lo
 * hace `snapshotSha256` en `blueprint-snapshot.ts` (mismo algoritmo:
 * sha256 sobre `JSON.stringify(snapshot)`), sin importar ese módulo — B1 no
 * depende de un tercer archivo compartido para una operación de una línea,
 * y así este archivo se mantiene un import más liviano hacia el contrato.
 * Si `blueprint-snapshot.ts` cambia su forma canónica alguna vez, este
 * cálculo y el suyo deben cambiar juntos (ambos están documentados como
 * "canonical json = JSON.stringify(snapshot)").
 */
function blueprintSnapshotSha256(snapshot: BlueprintSnapshotV1): string {
  return createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
}

function findBlueprintModule(snapshot: BlueprintSnapshotV1, moduleId: string) {
  const m = snapshot.modules.find((mm) => mm.id === moduleId);
  if (!m) {
    throw new PackagingPlanError(
      `PackagingPlanError: el módulo ${moduleId} del Manifest no existe en el snapshot del Blueprint (source.blueprintId=? — revisar que el Manifest y el snapshot correspondan al mismo Blueprint).`,
    );
  }
  return m;
}

function findBlueprintChapter(
  snapshot: BlueprintSnapshotV1,
  bpModule: BlueprintSnapshotV1['modules'][number],
  chapterId: string,
) {
  const c = bpModule.chapters.find((cc) => cc.id === chapterId);
  if (!c) {
    throw new PackagingPlanError(
      `PackagingPlanError: el capítulo ${chapterId} del Manifest (módulo ${bpModule.id}) no existe en el snapshot del Blueprint.`,
    );
  }
  return c;
}

export function buildPackagingPlan(
  manifest: GenerationManifestV1,
  blueprint: BlueprintSnapshotV1,
  opts?: { manifestId?: number },
): PackagingPlan {
  // El source del Manifest es la única referencia al Blueprint que usamos
  // para validar que el snapshot recibido es EL snapshot congelado del que
  // este Manifest derivó — nunca lo asumimos por conveniencia del caller.
  const expectedSha = manifest.source.blueprintSha256;
  const actualSha = blueprintSnapshotSha256(blueprint);
  if (expectedSha && actualSha !== expectedSha) {
    throw new PackagingPlanError(
      `PackagingPlanError: blueprintSha256 no coincide — manifest.source.blueprintSha256=${expectedSha}, snapshot recibido=${actualSha}. ` +
        'El Manifest y el snapshot del Blueprint no corresponden al mismo Blueprint congelado.',
    );
  }

  // Índice de items del Manifest por key, para resolver videoItemKey /
  // examItemKey en O(1) sin volver a recorrer manifest.items por capítulo.
  const itemKeys = new Set(manifest.items.map((i) => i.key));

  const modules: PackagingModulePlan[] = manifest.modules.map((mm) => {
    const bpModule = findBlueprintModule(blueprint, mm.moduleId);
    const moduleNumber = mm.moduleNumber;
    const sectionNum = 1 + moduleNumber;

    const chapters: PackagingChapterPlan[] = mm.chapters.map((mc) => {
      const bpChapter = findBlueprintChapter(blueprint, bpModule, mc.chapterId);
      const videoItemKey = `video:${mc.chapterId}`;
      return {
        chapterId: mc.chapterId,
        moduleId: mm.moduleId,
        chapterNumber: mc.chapterNumber,
        moduleNumber,
        title: bpChapter.title,
        objective: bpChapter.objective ?? null,
        contentItemKey: `content:${mc.chapterId}`,
        scormItemKey: `scorm:${mc.chapterId}`,
        videoItemKey: itemKeys.has(videoItemKey) ? videoItemKey : null,
      };
    });

    const examItemKey = `exam:${mm.moduleId}`;

    return {
      moduleId: mm.moduleId,
      moduleNumber,
      sectionNum,
      title: bpModule.title,
      objective: bpModule.objective ?? null,
      colorIndex: moduleNumber - 1,
      chapters,
      examItemKey: itemKeys.has(examItemKey) ? examItemKey : null,
    };
  });

  const sections: PackagingPlan['sections'] = [
    { sectionNum: 0, kind: 'welcome', title: 'Bienvenida' },
    { sectionNum: 1, kind: 'route_and_book', title: 'Ruta de aprendizaje y Libro Guía' },
    ...modules.map((m) => ({
      sectionNum: m.sectionNum,
      kind: 'module' as const,
      moduleId: m.moduleId,
      title: `Módulo ${m.moduleNumber} — ${m.title}`,
    })),
  ];

  const chapterCount = modules.reduce((n, m) => n + m.chapters.length, 0);
  const scormCount = chapterCount; // Rules V1: scorm siempre acompaña a content.
  const videoCount = modules.reduce(
    (n, m) => n + m.chapters.filter((c) => c.videoItemKey !== null).length,
    0,
  );
  const examCount = modules.filter((m) => m.examItemKey !== null).length;

  const totals: PackagingPlan['totals'] = {
    modules: modules.length,
    chapters: chapterCount,
    scorms: scormCount,
    videos: videoCount,
    exams: examCount,
  };

  // Assert: los totals derivados del plan deben coincidir con
  // manifest.totals. Ambos derivan del mismo Manifest, así que una
  // divergencia real es imposible salvo bug — pero fallar fuerte acá en vez
  // de servir un plan silenciosamente inconsistente es exactamente lo que
  // pide CLAUDE.md ("Trampas conocidas: falla silenciosa").
  const mismatches: string[] = [];
  if (totals.modules !== manifest.totals.moduleCount) {
    mismatches.push(`modules: plan=${totals.modules} manifest=${manifest.totals.moduleCount}`);
  }
  if (totals.chapters !== manifest.totals.chapterCount) {
    mismatches.push(`chapters: plan=${totals.chapters} manifest=${manifest.totals.chapterCount}`);
  }
  if (totals.scorms !== manifest.totals.scormCount) {
    mismatches.push(`scorms: plan=${totals.scorms} manifest=${manifest.totals.scormCount}`);
  }
  if (totals.videos !== manifest.totals.videoCount) {
    mismatches.push(`videos: plan=${totals.videos} manifest=${manifest.totals.videoCount}`);
  }
  if (totals.exams !== manifest.totals.examCount) {
    mismatches.push(`exams: plan=${totals.exams} manifest=${manifest.totals.examCount}`);
  }
  if (mismatches.length > 0) {
    throw new PackagingPlanError(
      `PackagingPlanError: totals del plan no coinciden con manifest.totals (${mismatches.join('; ')}).`,
    );
  }

  return {
    planVersion: 1,
    manifestId: opts?.manifestId ?? null,
    course: {
      id: manifest.source.courseId,
      title: blueprint.course.title,
      // BlueprintSnapshotV1.course no tiene un campo de resumen/objetivo a
      // nivel curso (solo id/title/structureVersion) — no hay fuente de la
      // que derivar `summary` de forma determinística en 5B.1. Los textos
      // de curso (bienvenida, intro, metodología) son contenido con IA que
      // queda fuera de alcance (spec §5, §8) y llega en 5B.2/rulesVersion 2.
      summary: null,
    },
    sections,
    modules,
    totals,
  };
}

/**
 * Serialización canónica del plan: reconstruye el objeto con orden de claves
 * fijo (igual patrón que `canonicalManifestJson` en
 * generation-manifest-builder.ts) para que un plan que pasó por jsonb u otro
 * round-trip que reordene claves de objeto (pero preserve el orden de
 * arrays) produzca el mismo string y el mismo hash.
 */
export function canonicalPackagingPlanJson(p: PackagingPlan): string {
  const canonical = {
    planVersion: p.planVersion,
    manifestId: p.manifestId,
    course: { id: p.course.id, title: p.course.title, summary: p.course.summary },
    sections: p.sections.map((s) =>
      s.kind === 'module'
        ? { sectionNum: s.sectionNum, kind: s.kind, moduleId: s.moduleId, title: s.title }
        : { sectionNum: s.sectionNum, kind: s.kind, title: s.title },
    ),
    modules: p.modules.map((m) => ({
      moduleId: m.moduleId,
      moduleNumber: m.moduleNumber,
      sectionNum: m.sectionNum,
      title: m.title,
      objective: m.objective,
      colorIndex: m.colorIndex,
      chapters: m.chapters.map((c) => ({
        chapterId: c.chapterId,
        moduleId: c.moduleId,
        chapterNumber: c.chapterNumber,
        moduleNumber: c.moduleNumber,
        title: c.title,
        objective: c.objective,
        contentItemKey: c.contentItemKey,
        scormItemKey: c.scormItemKey,
        videoItemKey: c.videoItemKey,
      })),
      examItemKey: m.examItemKey,
    })),
    totals: {
      modules: p.totals.modules,
      chapters: p.totals.chapters,
      scorms: p.totals.scorms,
      videos: p.totals.videos,
      exams: p.totals.exams,
    },
  };
  return JSON.stringify(canonical);
}

export function packagingPlanSha256(p: PackagingPlan): string {
  return createHash('sha256').update(canonicalPackagingPlanJson(p), 'utf8').digest('hex');
}
