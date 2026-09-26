import { createHash } from 'crypto';
import type {
  ActivityEngine,
  AnyBlueprintSnapshot,
  BlueprintSnapshotV1,
  BlueprintSnapshotV2,
} from '../course-blueprints/blueprint-snapshot';

/**
 * rulesVersion por defecto (y el único que existía hasta 5B.2.B/Fase 6). La
 * versión que efectivamente crea `POST …/manifest` sale de config
 * (`DYNAMIC_MANIFEST_RULES_VERSION`, ver manifest-rules-config.ts); esta
 * constante queda como el default y como el valor de los Manifests v1.
 */
export const MANIFEST_RULES_VERSION = 1;
export const MANIFEST_SCHEMA_VERSION = 1;

/** rulesVersion soportados por este builder/validador (spec v2 §3). */
export type ManifestRulesVersion = 1 | 2 | 3;
export const SUPPORTED_RULES_VERSIONS: readonly ManifestRulesVersion[] = [1, 2, 3];
/**
 * rulesVersion que procesa el builder/validador "legacy" (v1/v2, byte-idéntico
 * a antes de V2.1). rulesVersion 3 tiene su propio builder/validador
 * (`buildGenerationManifestV3` / `validateGenerationManifestV3`).
 */
const LEGACY_RULES_VERSIONS: readonly ManifestRulesVersion[] = [1, 2];

export type ManifestItemType =
  | 'content'
  | 'scorm'
  | 'video'
  | 'exam'
  // rulesVersion 2 (5B.2.B + Fase 6):
  | 'course_plan'
  | 'course_intro'
  | 'module_intro'
  // rulesVersion 3 (V2.1, audit §N.2):
  | 'experience'
  | 'presentation'
  | 'video_interactions'
  | 'activity'
  | 'audiobook_chapter'
  | 'audio_welcome'
  | 'final_exam';

export type ManifestItemScope = 'chapter' | 'module' | 'course';

/** Tipos de item por rulesVersion (v1 queda exactamente como antes). */
export const MANIFEST_ITEM_TYPES_V1: readonly ManifestItemType[] = ['content', 'scorm', 'video', 'exam'];
export const MANIFEST_ITEM_TYPES_V2: readonly ManifestItemType[] = [
  'content', 'scorm', 'video', 'exam', 'course_plan', 'course_intro', 'module_intro',
];
/**
 * rulesVersion 3 (V2.1, audit §N.2): sin `scorm` (pasa a `activity` con
 * `variant`), + experience, presentation, video_interactions, activity,
 * audiobook_chapter, audio_welcome y final_exam. Orden = orden canónico de
 * aparición.
 */
export const MANIFEST_ITEM_TYPES_V3: readonly ManifestItemType[] = [
  'course_plan', 'course_intro', 'audio_welcome', 'module_intro',
  'content', 'experience', 'presentation', 'video', 'video_interactions', 'activity', 'audiobook_chapter',
  'exam', 'final_exam',
];
/** Tipos que solo existen en rulesVersion 3. */
export const V3_ONLY_ITEM_TYPES: readonly ManifestItemType[] = [
  'experience', 'presentation', 'video_interactions', 'activity', 'audiobook_chapter', 'audio_welcome', 'final_exam',
];
/** Todos los tipos que existen en algún rulesVersion soportado. */
export const ALL_MANIFEST_ITEM_TYPES: readonly ManifestItemType[] = [...MANIFEST_ITEM_TYPES_V2, ...V3_ONLY_ITEM_TYPES];

/** Scope de cada tipo (spec v2 §3 + audit §N.2); en v1 solo existen chapter y module. */
export function scopeOfItemType(type: ManifestItemType): ManifestItemScope {
  if (type === 'course_plan' || type === 'course_intro' || type === 'audio_welcome' || type === 'final_exam') return 'course';
  if (type === 'exam' || type === 'module_intro') return 'module';
  return 'chapter';
}

export function itemTypesForRulesVersion(rv: number): readonly ManifestItemType[] {
  if (rv === 3) return MANIFEST_ITEM_TYPES_V3;
  return rv === 2 ? MANIFEST_ITEM_TYPES_V2 : MANIFEST_ITEM_TYPES_V1;
}

/** Variante del item `activity` (solo rulesVersion 3) = `course.activityEngine` del Blueprint v2. */
export type ActivityVariant = ActivityEngine;

export interface ManifestSource {
  courseId: number;
  blueprintId: number;
  blueprintNumber: number;
  blueprintSha256: string;
}

export interface ManifestChapter {
  chapterId: string;
  position: number;
  chapterNumber: number;
  videoEnabled: boolean;
  /** Solo rulesVersion 3 (ausente en v1/v2: su forma canónica no cambia). */
  activityEnabled?: boolean;
}

export interface ManifestModule {
  moduleId: string;
  position: number;
  moduleNumber: number;
  examEnabled: boolean;
  chapters: ManifestChapter[];
}

/**
 * Item del Manifest. `moduleId`/`moduleNumber` son null SOLO en items de
 * scope 'course' (rulesVersion 2: course_plan, course_intro); en v1 nunca.
 */
export interface ManifestItem {
  key: string;
  type: ManifestItemType;
  scope: ManifestItemScope;
  moduleId: string | null;
  chapterId: string | null;
  moduleNumber: number | null;
  chapterNumber: number | null;
  dependsOn: string[];
  /** Solo en items `activity` de rulesVersion 3 ('h5p' | 'scorm'); ningún otro item lo tiene. */
  variant?: ActivityVariant;
}

/** Solo rulesVersion 3: flags de curso del Blueprint v2 que cambian el conjunto de items. */
export interface ManifestFeatures {
  finalExam: boolean;
  activityEngine: ActivityEngine;
}

/**
 * Totales. Los tres conteos de v2 existen SOLO en Manifests rulesVersion 2
 * (en v1 están ausentes: la forma canónica de v1 no cambia).
 */
export interface ManifestTotals {
  moduleCount: number;
  chapterCount: number;
  contentCount: number;
  /** v1/v2 siempre; ausente en v3 (no hay items `scorm`: activityCount + variant). */
  scormCount?: number;
  videoCount: number;
  examCount: number;
  coursePlanCount?: number;
  courseIntroCount?: number;
  moduleIntroCount?: number;
  // rulesVersion 3:
  experienceCount?: number;
  presentationCount?: number;
  videoInteractionsCount?: number;
  activityCount?: number;
  audiobookChapterCount?: number;
  audioWelcomeCount?: number;
  finalExamCount?: number;
  totalJobs: number;
}

/**
 * Manifest con `manifestSchemaVersion: 1` (la forma JSON), para cualquier
 * rulesVersion soportado. El nombre se conserva por compatibilidad: "V1" es
 * el schema, no las reglas.
 */
export interface GenerationManifestV1 {
  manifestSchemaVersion: 1;
  rulesVersion: ManifestRulesVersion;
  source: ManifestSource;
  /** Solo rulesVersion 3. */
  features?: ManifestFeatures;
  modules: ManifestModule[];
  items: ManifestItem[];
  totals: ManifestTotals;
}

export interface ManifestValidationError {
  code: string;
  message: string;
  key?: string;
}

/**
 * Builds the canonical, deterministic Generation Manifest V1 from a
 * Blueprint snapshot. Pure function: reads only `snapshot` and `source`,
 * no clock, no randomness, no DB. Rules V1 (see design spec §2.2):
 * content + scorm per chapter (always), video iff `videoEnabled`, exam
 * (module-level) iff `examEnabled` — no course-level items in V1.
 *
 * Canonical item order: by module (position) -> by chapter (position) ->
 * content, scorm, video; the module's exam item after all its chapters.
 * `dependsOn` for `exam:<moduleId>` lists the module's `content:*` keys in
 * chapter order.
 *
 * Input arrays (`snapshot.modules`, `.chapters`) are never mutated — sorted
 * copies are made instead.
 */
/**
 * rulesVersion 2 (spec `2026-09-25-cursia-v2-rules-v2-and-context-package-design.md` §3),
 * además de todo lo de v1:
 *  - `course_plan:<courseId>` (scope course, sin deps) y
 *    `course_intro:<courseId>` (scope course, deps [course_plan]) al inicio;
 *  - `module_intro:<moduleId>` (scope module, deps [course_plan]) al inicio de
 *    cada módulo, antes de sus capítulos;
 *  - `content:<chapterId>` depende de `course_plan`.
 *  Orden canónico v2: course_plan, course_intro, luego por módulo:
 *  module_intro → capítulos (content, scorm, video) → exam.
 *  Totales v2 += coursePlanCount, courseIntroCount, moduleIntroCount.
 * Con `rulesVersion` 1 (default) el resultado es byte-idéntico al de antes.
 */
export function coursePlanKey(courseId: number): string {
  return `course_plan:${courseId}`;
}
export function courseIntroKey(courseId: number): string {
  return `course_intro:${courseId}`;
}
export function moduleIntroKey(moduleId: string): string {
  return `module_intro:${moduleId}`;
}

export function buildGenerationManifest(
  snapshotIn: AnyBlueprintSnapshot,
  source: ManifestSource,
  opts?: { rulesVersion?: ManifestRulesVersion },
): GenerationManifestV1 {
  const rulesVersion: ManifestRulesVersion = opts?.rulesVersion ?? 1;
  if (!SUPPORTED_RULES_VERSIONS.includes(rulesVersion)) {
    throw new Error(`buildGenerationManifest: rulesVersion no soportado: ${String(rulesVersion)}`);
  }
  if (rulesVersion === 3) return buildGenerationManifestV3(snapshotIn as BlueprintSnapshotV2, source);
  if ((snapshotIn as any)?.schemaVersion !== 1) {
    // v1/v2 nunca procesan un Blueprint v2: perderían en silencio activityEnabled/finalExam.
    throw new Error(
      `${BLUEPRINT_SCHEMA_MISMATCH}: rulesVersion ${rulesVersion} requiere un Blueprint snapshot schemaVersion 1 ` +
        `(recibido ${String((snapshotIn as any)?.schemaVersion)})`,
    );
  }
  const snapshot = snapshotIn as BlueprintSnapshotV1;
  const v2 = rulesVersion === 2;
  const planKey = coursePlanKey(source.courseId);
  const modulesSorted = [...snapshot.modules].sort((a, b) => a.position - b.position);
  let chapterNumber = 0;
  const modules: ManifestModule[] = [];
  const items: ManifestItem[] = [];

  if (v2) {
    const courseBase = { scope: 'course' as const, moduleId: null, chapterId: null, moduleNumber: null, chapterNumber: null };
    items.push({ key: planKey, type: 'course_plan', ...courseBase, dependsOn: [] });
    items.push({ key: courseIntroKey(source.courseId), type: 'course_intro', ...courseBase, dependsOn: [planKey] });
  }

  modulesSorted.forEach((m, mi) => {
    const moduleNumber = mi + 1;
    const chaptersSorted = [...m.chapters].sort((a, b) => a.position - b.position);
    const chapters: ManifestChapter[] = [];
    const contentKeys: string[] = [];

    if (v2) {
      items.push({
        key: moduleIntroKey(m.id),
        type: 'module_intro',
        scope: 'module',
        moduleId: m.id,
        chapterId: null,
        moduleNumber,
        chapterNumber: null,
        dependsOn: [planKey],
      });
    }

    for (const c of chaptersSorted) {
      chapterNumber += 1;
      chapters.push({
        chapterId: c.id,
        position: c.position,
        chapterNumber,
        videoEnabled: !!c.videoEnabled,
      });

      const base = {
        scope: 'chapter' as const,
        moduleId: m.id,
        chapterId: c.id,
        moduleNumber,
        chapterNumber,
      };
      const contentKey = `content:${c.id}`;
      contentKeys.push(contentKey);

      items.push({ key: contentKey, type: 'content', ...base, dependsOn: v2 ? [planKey] : [] });
      items.push({ key: `scorm:${c.id}`, type: 'scorm', ...base, dependsOn: [contentKey] });
      if (c.videoEnabled) {
        items.push({ key: `video:${c.id}`, type: 'video', ...base, dependsOn: [contentKey] });
      }
    }

    modules.push({
      moduleId: m.id,
      position: m.position,
      moduleNumber,
      examEnabled: !!m.examEnabled,
      chapters,
    });

    if (m.examEnabled) {
      items.push({
        key: `exam:${m.id}`,
        type: 'exam',
        scope: 'module',
        moduleId: m.id,
        chapterId: null,
        moduleNumber,
        chapterNumber: null,
        dependsOn: [...contentKeys],
      });
    }
  });

  const count = (t: ManifestItemType) => items.filter((i) => i.type === t).length;
  const totals: ManifestTotals = v2
    ? {
        moduleCount: modules.length,
        chapterCount: chapterNumber,
        contentCount: count('content'),
        scormCount: count('scorm'),
        videoCount: count('video'),
        examCount: count('exam'),
        coursePlanCount: count('course_plan'),
        courseIntroCount: count('course_intro'),
        moduleIntroCount: count('module_intro'),
        totalJobs: items.length,
      }
    : {
        moduleCount: modules.length,
        chapterCount: chapterNumber,
        contentCount: count('content'),
        scormCount: count('scorm'),
        videoCount: count('video'),
        examCount: count('exam'),
        totalJobs: items.length,
      };

  return {
    manifestSchemaVersion: 1,
    rulesVersion,
    source: {
      courseId: source.courseId,
      blueprintId: source.blueprintId,
      blueprintNumber: source.blueprintNumber,
      blueprintSha256: source.blueprintSha256,
    },
    modules,
    items,
    totals,
  };
}

/**
 * Independently validates a Generation Manifest against the Blueprint
 * snapshot it claims to derive from. Does NOT call `buildGenerationManifest`
 * — it walks the snapshot itself and recomputes the expected item set,
 * totals, and structure, then diffs against `m`. Returns ALL errors found
 * (never stops at the first one).
 */
/**
 * Codes beyond the invariants listed in design spec §2.8 / the task brief,
 * added here and documented per the task's binding decisions:
 *  - VERSION_MISMATCH: `manifestSchemaVersion` or `rulesVersion` isn't the
 *    single value this validator (and the current builder) supports.
 *  - MODULES_MISMATCH: the manifest's `modules` mirror (ids, positions,
 *    numbers, `examEnabled`/`videoEnabled` flags) doesn't match the
 *    snapshot it claims to derive from.
 *  - UNKNOWN_MODULE: an `exam` item (or any item) references a `moduleId`
 *    that doesn't exist in the snapshot at all (distinct from
 *    UNKNOWN_CHAPTER, which is chapter-scoped).
 *  - WRONG_DEPENDENCIES: an item's `dependsOn` doesn't equal (order-
 *    sensitive) the exact expected edge for its type, derived independently
 *    from the snapshot: `content` -> `[]`; `scorm:X`/`video:X` ->
 *    `[content:X]`; `exam:M` -> `content:*` keys of M's chapters in
 *    position order. This is a stronger check than DANGLING_DEPENDENCY
 *    (which only asks "does this key exist anywhere in the manifest") — it
 *    catches a misdirected edge to a key that does exist (e.g.
 *    `scorm:X.dependsOn=[content:Y]`), and a cycle between two existing
 *    keys (e.g. `content:A.dependsOn=[scorm:A]`,
 *    `scorm:A.dependsOn=[content:A]`), which DANGLING_DEPENDENCY alone
 *    cannot see since every key involved is present. With the exact edge
 *    enforced per item, a cycle is structurally impossible to pass
 *    validation: `content` items are the only ones every edge points to,
 *    and they are the only items required to have zero outgoing edges, so
 *    nothing content depends on (per this check) can ever depend back on
 *    it.
 */
export function validateGenerationManifest(
  m: GenerationManifestV1,
  snapshot: AnyBlueprintSnapshot,
  source: ManifestSource,
): ManifestValidationError[] {
  // rulesVersion 3 con su Blueprint v2 → validador v3 independiente.
  if (m.rulesVersion === 3 && (snapshot as any)?.schemaVersion === 2) {
    return validateGenerationManifestV3(m, snapshot as BlueprintSnapshotV2, source);
  }
  // Cualquier otra combinación pasa por el validador v1/v2 de siempre
  // (byte-idéntico para un snapshot v1); si el schema del Blueprint no es el
  // que exige el rulesVersion, se antepone BLUEPRINT_SCHEMA_MISMATCH.
  const legacy = validateGenerationManifestLegacy(m, snapshot as BlueprintSnapshotV1, source);
  const wantsV2Snapshot = m.rulesVersion === 3;
  const isV2Snapshot = (snapshot as any)?.schemaVersion === 2;
  if (wantsV2Snapshot !== isV2Snapshot) {
    return [
      {
        code: BLUEPRINT_SCHEMA_MISMATCH,
        message:
          `rulesVersion ${m.rulesVersion} requiere un Blueprint snapshot schemaVersion ${wantsV2Snapshot ? 2 : 1}, ` +
          `recibido schemaVersion ${String((snapshot as any)?.schemaVersion)}`,
      },
      ...legacy,
    ];
  }
  return legacy;
}

function validateGenerationManifestLegacy(
  m: GenerationManifestV1,
  snapshot: BlueprintSnapshotV1,
  source: ManifestSource,
): ManifestValidationError[] {
  const errors: ManifestValidationError[] = [];

  // Despacho por rulesVersion (spec v2 §3): v1 se valida exactamente como
  // antes; v2 agrega los items de scope curso/módulo y la arista
  // content → course_plan. Un rulesVersion no soportado es VERSION_MISMATCH y
  // el resto se valida con las reglas v1 (igual que antes de v2).
  const rv: ManifestRulesVersion = m.rulesVersion === 2 ? 2 : 1;
  const v2 = rv === 2;
  if (!LEGACY_RULES_VERSIONS.includes(m.rulesVersion)) {
    errors.push({
      code: 'VERSION_MISMATCH',
      message: `rulesVersion esperado 1 o 2, encontrado ${m.rulesVersion}`,
    });
  }
  const knownTypes = itemTypesForRulesVersion(rv);
  const planKey = coursePlanKey(source.courseId);
  const expectedCourseKeys = new Map<string, ManifestItemType>(
    v2 ? [[planKey, 'course_plan'], [courseIntroKey(source.courseId), 'course_intro']] : [],
  );
  const expectedModuleIntroKeys = new Set<string>();
  if (m.manifestSchemaVersion !== 1) {
    errors.push({
      code: 'VERSION_MISMATCH',
      message: `manifestSchemaVersion esperado 1, encontrado ${m.manifestSchemaVersion}`,
    });
  }

  if (
    m.source.courseId !== source.courseId ||
    m.source.blueprintId !== source.blueprintId ||
    m.source.blueprintNumber !== source.blueprintNumber ||
    m.source.blueprintSha256 !== source.blueprintSha256
  ) {
    errors.push({
      code: 'SOURCE_MISMATCH',
      message: `source del manifest no coincide con el source esperado (courseId/blueprintId/blueprintNumber/blueprintSha256)`,
    });
  }

  // --- Recompute the expected structure from the snapshot (independent of
  // whatever `m` claims) ---
  const modulesSorted = [...snapshot.modules].sort((a, b) => a.position - b.position);
  const expectedModules = new Map<
    string,
    { position: number; moduleNumber: number; examEnabled: boolean }
  >();
  const expectedChapters = new Map<
    string,
    { moduleId: string; position: number; chapterNumber: number; videoEnabled: boolean }
  >();
  const expectedContentKeys = new Set<string>();
  const expectedScormKeys = new Set<string>();
  const expectedVideoKeys = new Set<string>();
  const expectedExamKeys = new Set<string>();
  const moduleChapterOrder = new Map<string, string[]>(); // moduleId -> chapterIds in position order

  let chapterNumber = 0;
  modulesSorted.forEach((mod, mi) => {
    const moduleNumber = mi + 1;
    expectedModules.set(mod.id, {
      position: mod.position,
      moduleNumber,
      examEnabled: !!mod.examEnabled,
    });
    const chaptersSorted = [...mod.chapters].sort((a, b) => a.position - b.position);
    const chapterIds: string[] = [];
    for (const c of chaptersSorted) {
      chapterNumber += 1;
      expectedChapters.set(c.id, {
        moduleId: mod.id,
        position: c.position,
        chapterNumber,
        videoEnabled: !!c.videoEnabled,
      });
      chapterIds.push(c.id);
      expectedContentKeys.add(`content:${c.id}`);
      expectedScormKeys.add(`scorm:${c.id}`);
      if (c.videoEnabled) expectedVideoKeys.add(`video:${c.id}`);
    }
    moduleChapterOrder.set(mod.id, chapterIds);
    if (mod.examEnabled) expectedExamKeys.add(`exam:${mod.id}`);
    if (v2) expectedModuleIntroKeys.add(moduleIntroKey(mod.id));
  });

  // --- FIX M4: canonical order ---
  // `items[]` must appear in canonical order (design spec §2.3): module
  // (position) -> chapter (position) -> content, scorm, video; the module's
  // `exam` after all of its chapters. Computed independently from the
  // snapshot (never from `m.items` itself) — includes only the keys the
  // snapshot says SHOULD exist; unknown/extra items in `m.items` are simply
  // skipped for this check (they're already caught by the other checks
  // above/below) so a single stray item can't mask a genuine ordering bug
  // in the rest of the array.
  const canonicalOrderKeys: string[] = [...expectedCourseKeys.keys()];
  modulesSorted.forEach((mod) => {
    if (v2) canonicalOrderKeys.push(moduleIntroKey(mod.id));
    const chaptersSorted = [...mod.chapters].sort((a, b) => a.position - b.position);
    for (const c of chaptersSorted) {
      canonicalOrderKeys.push(`content:${c.id}`);
      canonicalOrderKeys.push(`scorm:${c.id}`);
      if (c.videoEnabled) canonicalOrderKeys.push(`video:${c.id}`);
    }
    if (mod.examEnabled) canonicalOrderKeys.push(`exam:${mod.id}`);
  });
  const canonicalIndex = new Map<string, number>();
  canonicalOrderKeys.forEach((k, idx) => canonicalIndex.set(k, idx));

  const orderedIndices: number[] = [];
  for (const item of m.items) {
    const idx = canonicalIndex.get(item.key);
    if (idx !== undefined) orderedIndices.push(idx);
  }
  for (let i = 1; i < orderedIndices.length; i++) {
    if (orderedIndices[i] <= orderedIndices[i - 1]) {
      errors.push({
        code: 'ORDER_MISMATCH',
        message:
          'items no está en el orden canónico esperado (módulo → capítulo → content/scorm/video; exam al final de su módulo)',
      });
      break;
    }
  }

  // `modules[].chapters` must also be in position-sorted order.
  for (const mm of m.modules) {
    for (let i = 1; i < mm.chapters.length; i++) {
      if (mm.chapters[i].position <= mm.chapters[i - 1].position) {
        errors.push({
          code: 'ORDER_MISMATCH',
          message: `módulo ${mm.moduleId}: chapters no está en orden ascendente de position`,
          key: mm.moduleId,
        });
        break;
      }
    }
  }

  // --- modules[] mirror check ---
  if (m.modules.length !== expectedModules.size) {
    errors.push({
      code: 'MODULES_MISMATCH',
      message: `cantidad de módulos en el manifest (${m.modules.length}) no coincide con el snapshot (${expectedModules.size})`,
    });
  }
  for (const mm of m.modules) {
    const expected = expectedModules.get(mm.moduleId);
    if (!expected) {
      errors.push({
        code: 'MODULES_MISMATCH',
        message: `moduleId ${mm.moduleId} no existe en el snapshot`,
        key: mm.moduleId,
      });
      continue;
    }
    if (
      mm.position !== expected.position ||
      mm.moduleNumber !== expected.moduleNumber ||
      mm.examEnabled !== expected.examEnabled
    ) {
      errors.push({
        code: 'MODULES_MISMATCH',
        message: `módulo ${mm.moduleId} no coincide con el snapshot (position/moduleNumber/examEnabled)`,
        key: mm.moduleId,
      });
    }
    const expectedChapterIds = moduleChapterOrder.get(mm.moduleId) ?? [];
    if (mm.chapters.length !== expectedChapterIds.length) {
      errors.push({
        code: 'MODULES_MISMATCH',
        message: `módulo ${mm.moduleId}: cantidad de capítulos no coincide con el snapshot`,
        key: mm.moduleId,
      });
    }
    for (const mc of mm.chapters) {
      const expectedChapter = expectedChapters.get(mc.chapterId);
      if (!expectedChapter || expectedChapter.moduleId !== mm.moduleId) {
        errors.push({
          code: 'MODULES_MISMATCH',
          message: `capítulo ${mc.chapterId} no pertenece al módulo ${mm.moduleId} según el snapshot`,
          key: mc.chapterId,
        });
        continue;
      }
      if (
        mc.position !== expectedChapter.position ||
        mc.chapterNumber !== expectedChapter.chapterNumber ||
        mc.videoEnabled !== expectedChapter.videoEnabled
      ) {
        errors.push({
          code: 'MODULES_MISMATCH',
          message: `capítulo ${mc.chapterId} no coincide con el snapshot (position/chapterNumber/videoEnabled)`,
          key: mc.chapterId,
        });
      }
    }
  }

  // --- items[] checks ---
  const keyCounts = new Map<string, number>();
  for (const item of m.items) {
    keyCounts.set(item.key, (keyCounts.get(item.key) ?? 0) + 1);
  }
  for (const [key, cnt] of keyCounts) {
    if (cnt > 1) {
      errors.push({ code: 'DUPLICATE_KEY', message: `key duplicada: ${key} (${cnt} veces)`, key });
    }
  }

  const presentKeys = new Set(m.items.map((i) => i.key));
  const presentContentKeys = new Set<string>();
  const presentScormKeys = new Set<string>();
  const presentVideoKeys = new Set<string>();
  const presentExamKeys = new Set<string>();
  const presentCourseKeys = new Set<string>();
  const presentModuleIntroKeys = new Set<string>();

  for (const item of m.items) {
    const isKnown = knownTypes.includes(item.type);
    // Solo en v2 los tipos nuevos tienen reglas propias; en v1 un tipo v2 es
    // UNKNOWN_TYPE y sigue el camino de "capítulo" exactamente como antes.
    const isCourseType = isKnown && (item.type === 'course_plan' || item.type === 'course_intro');
    const isModuleIntro = isKnown && item.type === 'module_intro';
    const isModuleScoped = item.type === 'exam' || isModuleIntro;
    const itemModuleId = item.moduleId ?? '';

    // --- FIX I1: per-item identity/consistency checks, independent of
    // whether the referenced moduleId/chapterId actually exist (those are
    // handled separately below). Each check is computed from the item's
    // own claimed fields, so a swapped/forged id or number is caught even
    // when every key involved is otherwise present in the manifest. ---
    if (!isKnown) {
      errors.push({
        code: 'UNKNOWN_TYPE',
        message: `item ${item.key}: type desconocido: ${String(item.type)}`,
        key: item.key,
      });
    } else {
      const expectedKey = isCourseType
        ? `${item.type}:${source.courseId}`
        : isModuleScoped
          ? `${item.type}:${item.moduleId}`
          : `${item.type}:${item.chapterId}`;
      if (item.key !== expectedKey) {
        errors.push({
          code: 'KEY_MISMATCH',
          message: `item ${item.key}: key esperada ${expectedKey} según type/${isCourseType ? 'courseId' : isModuleScoped ? 'moduleId' : 'chapterId'}`,
          key: item.key,
        });
      }

      const expectedScope = scopeOfItemType(item.type);
      if (item.scope !== expectedScope) {
        errors.push({
          code: 'SCOPE_MISMATCH',
          message: `item ${item.key}: scope esperado '${expectedScope}' para type=${item.type}, encontrado '${item.scope}'`,
          key: item.key,
        });
      }

      if (isCourseType) {
        // Scope curso: sin módulo ni capítulo (identidad = el curso del source).
        for (const [field, value] of [
          ['moduleId', item.moduleId],
          ['chapterId', item.chapterId],
          ['moduleNumber', item.moduleNumber],
          ['chapterNumber', item.chapterNumber],
        ] as const) {
          if (value !== null) {
            errors.push({
              code: 'NUMBERING_MISMATCH',
              message: `item ${item.key}: ${field} esperado null para un item de scope course, encontrado ${value}`,
              key: item.key,
            });
          }
        }
      } else {
        const expectedModuleForItem = expectedModules.get(itemModuleId);
        if (expectedModuleForItem && item.moduleNumber !== expectedModuleForItem.moduleNumber) {
          errors.push({
            code: 'NUMBERING_MISMATCH',
            message: `item ${item.key}: moduleNumber esperado ${expectedModuleForItem.moduleNumber} para moduleId ${item.moduleId}, encontrado ${item.moduleNumber}`,
            key: item.key,
          });
        }

        if (isModuleScoped) {
          if (item.chapterId !== null) {
            errors.push({
              code: 'NUMBERING_MISMATCH',
              message: `item ${item.key}: chapterId esperado null para un item de tipo ${item.type}, encontrado ${item.chapterId}`,
              key: item.key,
            });
          }
          if (item.chapterNumber !== null) {
            errors.push({
              code: 'NUMBERING_MISMATCH',
              message: `item ${item.key}: chapterNumber esperado null para un item de tipo ${item.type}, encontrado ${item.chapterNumber}`,
              key: item.key,
            });
          }
        } else {
          const expectedChapterForItem = item.chapterId ? expectedChapters.get(item.chapterId) : undefined;
          if (expectedChapterForItem && item.chapterNumber !== expectedChapterForItem.chapterNumber) {
            errors.push({
              code: 'NUMBERING_MISMATCH',
              message: `item ${item.key}: chapterNumber esperado ${expectedChapterForItem.chapterNumber} para chapterId ${item.chapterId}, encontrado ${item.chapterNumber}`,
              key: item.key,
            });
          }
        }
      }
    }

    if (item.type === 'exam') {
      const expectedModule = expectedModules.get(itemModuleId);
      if (!expectedModule) {
        errors.push({
          code: 'UNKNOWN_MODULE',
          message: `exam ${item.key} referencia un moduleId inexistente en el snapshot: ${item.moduleId}`,
          key: item.key,
        });
      } else if (!expectedModule.examEnabled) {
        errors.push({
          code: 'EXAM_NOT_ENABLED',
          message: `exam ${item.key} existe pero el módulo ${item.moduleId} tiene examEnabled=false`,
          key: item.key,
        });
      }
      presentExamKeys.add(item.key);
    } else if (isModuleIntro) {
      if (!expectedModules.has(itemModuleId)) {
        errors.push({
          code: 'UNKNOWN_MODULE',
          message: `module_intro ${item.key} referencia un moduleId inexistente en el snapshot: ${item.moduleId}`,
          key: item.key,
        });
      }
      presentModuleIntroKeys.add(item.key);
    } else if (isCourseType) {
      presentCourseKeys.add(item.key);
    } else {
      // content | scorm | video: chapter-scoped
      const expectedChapter = item.chapterId ? expectedChapters.get(item.chapterId) : undefined;
      if (!item.chapterId || !expectedChapter) {
        errors.push({
          code: 'UNKNOWN_CHAPTER',
          message: `item ${item.key} referencia un chapterId inexistente en el snapshot: ${item.chapterId}`,
          key: item.key,
        });
      } else {
        if (expectedChapter.moduleId !== item.moduleId) {
          errors.push({
            code: 'CHAPTER_MODULE_MISMATCH',
            message: `item ${item.key}: capítulo ${item.chapterId} pertenece al módulo ${expectedChapter.moduleId}, no a ${item.moduleId}`,
            key: item.key,
          });
        }
        if (item.type === 'video' && !expectedChapter.videoEnabled) {
          errors.push({
            code: 'VIDEO_NOT_ENABLED',
            message: `video ${item.key} existe pero el capítulo ${item.chapterId} tiene videoEnabled=false`,
            key: item.key,
          });
        }
      }
      if (item.type === 'content') presentContentKeys.add(item.key);
      if (item.type === 'scorm') presentScormKeys.add(item.key);
      if (item.type === 'video') presentVideoKeys.add(item.key);
    }

    for (const dep of item.dependsOn) {
      if (!presentKeys.has(dep)) {
        errors.push({
          code: 'DANGLING_DEPENDENCY',
          message: `item ${item.key} depende de una key inexistente: ${dep}`,
          key: item.key,
        });
      }
    }

    // --- exact edges (independent of whether the dep key even exists) ---
    // The DAG has exactly one edge shape per rule (content -> [];
    // scorm:X/video:X -> [content:X]; exam:M -> content keys of M's
    // chapters in position order) — computed here from the snapshot, not
    // from `item` itself beyond identifying which chapter/module it claims
    // to belong to. Because every expected edge points strictly from a
    // non-content item to a content item, and content items always expect
    // `[]`, no cycle can ever satisfy this check: a cycle (e.g.
    // content:A.dependsOn=[scorm:A] / scorm:A.dependsOn=[content:A]) is
    // caught here as WRONG_DEPENDENCIES on the content item alone (expects
    // []), independent of anything else being wrong.
    // v2: content/course_intro/module_intro -> [course_plan:<courseId>] y
    // course_plan -> []. Sigue siendo acíclico: course_plan es la única
    // raíz, no depende de nada, y todo lo demás apunta "hacia" content o
    // hacia course_plan.
    let expectedDeps: string[] | undefined;
    if (item.type === 'content') {
      expectedDeps = v2 ? [planKey] : [];
    } else if (item.type === 'scorm' || item.type === 'video') {
      if (item.chapterId) expectedDeps = [`content:${item.chapterId}`];
    } else if (item.type === 'exam') {
      const chapterIds = moduleChapterOrder.get(itemModuleId);
      if (chapterIds) expectedDeps = chapterIds.map((cid) => `content:${cid}`);
    } else if (isKnown && item.type === 'course_plan') {
      expectedDeps = [];
    } else if (isKnown && (item.type === 'course_intro' || item.type === 'module_intro')) {
      expectedDeps = [planKey];
    }
    if (expectedDeps) {
      const same =
        item.dependsOn.length === expectedDeps.length &&
        item.dependsOn.every((dep, idx) => dep === expectedDeps![idx]);
      if (!same) {
        errors.push({
          code: 'WRONG_DEPENDENCIES',
          message: `item ${item.key}: dependsOn esperado ${JSON.stringify(expectedDeps)}, encontrado ${JSON.stringify(item.dependsOn)}`,
          key: item.key,
        });
      }
    }
  }

  // --- missing items (recounted from the snapshot) ---
  for (const [key, type] of expectedCourseKeys) {
    if (!presentCourseKeys.has(key)) {
      errors.push({ code: type === 'course_plan' ? 'MISSING_COURSE_PLAN' : 'MISSING_COURSE_INTRO', message: `falta el item ${key}`, key });
    }
  }
  for (const key of expectedModuleIntroKeys) {
    if (!presentModuleIntroKeys.has(key)) {
      errors.push({ code: 'MISSING_MODULE_INTRO', message: `falta el item ${key}`, key });
    }
  }
  for (const key of expectedContentKeys) {
    if (!presentContentKeys.has(key)) {
      errors.push({ code: 'MISSING_CONTENT', message: `falta el item ${key}`, key });
    }
  }
  for (const key of expectedScormKeys) {
    if (!presentScormKeys.has(key)) {
      errors.push({ code: 'MISSING_SCORM', message: `falta el item ${key}`, key });
    }
  }
  for (const key of expectedVideoKeys) {
    if (!presentVideoKeys.has(key)) {
      errors.push({ code: 'MISSING_VIDEO', message: `falta el item ${key}`, key });
    }
  }
  for (const key of expectedExamKeys) {
    if (!presentExamKeys.has(key)) {
      errors.push({ code: 'MISSING_EXAM', message: `falta el item ${key}`, key });
    }
  }

  // --- totals recount ---
  const v1Jobs = expectedContentKeys.size + expectedScormKeys.size + expectedVideoKeys.size + expectedExamKeys.size;
  const expectedTotals: ManifestTotals = v2
    ? {
        moduleCount: expectedModules.size,
        chapterCount: expectedChapters.size,
        contentCount: expectedContentKeys.size,
        scormCount: expectedScormKeys.size,
        videoCount: expectedVideoKeys.size,
        examCount: expectedExamKeys.size,
        coursePlanCount: 1,
        courseIntroCount: 1,
        moduleIntroCount: expectedModuleIntroKeys.size,
        totalJobs: v1Jobs + expectedCourseKeys.size + expectedModuleIntroKeys.size,
      }
    : {
        moduleCount: expectedModules.size,
        chapterCount: expectedChapters.size,
        contentCount: expectedContentKeys.size,
        scormCount: expectedScormKeys.size,
        videoCount: expectedVideoKeys.size,
        examCount: expectedExamKeys.size,
        totalJobs: v1Jobs,
      };
  (Object.keys(expectedTotals) as (keyof ManifestTotals)[]).forEach((field) => {
    if (m.totals[field] !== expectedTotals[field]) {
      errors.push({
        code: 'TOTALS_MISMATCH',
        message: `totals.${field} esperado ${expectedTotals[field]}, encontrado ${m.totals[field]}`,
      });
    }
  });
  if (m.items.length !== m.totals.totalJobs) {
    errors.push({
      code: 'TOTALS_MISMATCH',
      message: `totals.totalJobs (${m.totals.totalJobs}) no coincide con items.length (${m.items.length})`,
    });
  }

  return errors;
}

/**
 * Canonical serialization: rebuilds the manifest object with a fixed key
 * order (matching how `buildGenerationManifest` constructs its literals) so
 * that a manifest round-tripped through Postgres `jsonb` — which reorders
 * object keys but preserves array order — produces the identical string
 * and hash.
 */
export function canonicalManifestJson(m: GenerationManifestV1): string {
  if (m.rulesVersion === 3) return canonicalManifestJsonV3(m);
  const canonical: GenerationManifestV1 = {
    // FIX M1: copy the manifest's own values through instead of hardcoding
    // 1 — a stored manifest whose rulesVersion/manifestSchemaVersion drifted
    // (e.g. tampered or from a future rules generation) must survive
    // canonicalization unchanged, so `validateGenerationManifest` can catch
    // it as VERSION_MISMATCH on the read path. For any manifest actually
    // produced by `buildGenerationManifest` today, both are still 1, so the
    // pinned acceptance-fixture hash is unaffected.
    manifestSchemaVersion: m.manifestSchemaVersion,
    rulesVersion: m.rulesVersion,
    source: {
      courseId: m.source.courseId,
      blueprintId: m.source.blueprintId,
      blueprintNumber: m.source.blueprintNumber,
      blueprintSha256: m.source.blueprintSha256,
    },
    modules: m.modules.map((mod) => ({
      moduleId: mod.moduleId,
      position: mod.position,
      moduleNumber: mod.moduleNumber,
      examEnabled: mod.examEnabled,
      chapters: mod.chapters.map((c) => ({
        chapterId: c.chapterId,
        position: c.position,
        chapterNumber: c.chapterNumber,
        videoEnabled: c.videoEnabled,
      })),
    })),
    items: m.items.map((i) => ({
      key: i.key,
      type: i.type,
      scope: i.scope,
      moduleId: i.moduleId,
      chapterId: i.chapterId,
      moduleNumber: i.moduleNumber,
      chapterNumber: i.chapterNumber,
      dependsOn: [...i.dependsOn],
    })),
    // v1: exactamente las claves de siempre (el hash fijado no cambia). v2:
    // + los tres conteos nuevos, antes de totalJobs.
    totals:
      m.rulesVersion === 2
        ? {
            moduleCount: m.totals.moduleCount,
            chapterCount: m.totals.chapterCount,
            contentCount: m.totals.contentCount,
            scormCount: m.totals.scormCount,
            videoCount: m.totals.videoCount,
            examCount: m.totals.examCount,
            coursePlanCount: m.totals.coursePlanCount,
            courseIntroCount: m.totals.courseIntroCount,
            moduleIntroCount: m.totals.moduleIntroCount,
            totalJobs: m.totals.totalJobs,
          }
        : {
            moduleCount: m.totals.moduleCount,
            chapterCount: m.totals.chapterCount,
            contentCount: m.totals.contentCount,
            scormCount: m.totals.scormCount,
            videoCount: m.totals.videoCount,
            examCount: m.totals.examCount,
            totalJobs: m.totals.totalJobs,
          },
  };
  return JSON.stringify(canonical);
}

export function manifestSha256(m: GenerationManifestV1): string {
  return createHash('sha256').update(canonicalManifestJson(m), 'utf8').digest('hex');
}

// ════════════════════════════════════════════════════════════════════════════
// rulesVersion 3 (Cursia V2.1 — R4, audit §N.1/§N.2 + DECISIONES VIGENTES).
//
// Entrada: Blueprint snapshot schemaVersion 2 (R3). Todo lo de arriba (v1/v2)
// queda byte-idéntico: v3 tiene su propio builder, validador y canonical.
//
// Items v3 (key / scope / existe cuando / dependsOn exacto):
//   course_plan:<courseId>        course  siempre            []
//   course_intro:<courseId>       course  siempre            [course_plan]
//   audio_welcome:<courseId>      course  siempre            [course_intro]
//   module_intro:<m>              module  siempre            [course_plan]
//   content:<ch>                  chapter siempre            [course_plan]
//   experience:<ch>               chapter siempre            [content:<ch>]
//   presentation:<ch>             chapter siempre (Gamma)    [content:<ch>]
//   video:<ch>                    chapter videoEnabled       [content:<ch>]
//   video_interactions:<ch>       chapter videoEnabled       [video:<ch>, content:<ch>]
//   activity:<ch>  (+variant)     chapter activityEnabled    [content:<ch>]
//   audiobook_chapter:<ch>        chapter siempre            [content:<ch>]
//   exam:<m>                      module  examEnabled        content del módulo, en orden
//   final_exam:<courseId>         course  course.finalExam   todos los content, en orden
// Orden canónico: course_plan, course_intro, audio_welcome; por módulo:
// module_intro → por capítulo (content, experience, presentation, video,
// video_interactions, activity, audiobook_chapter) → exam; al final final_exam.
// ════════════════════════════════════════════════════════════════════════════

/** Código de error cuando el schemaVersion del Blueprint no es el que exige el rulesVersion. */
export const BLUEPRINT_SCHEMA_MISMATCH = 'BLUEPRINT_SCHEMA_MISMATCH';

export function audioWelcomeKey(courseId: number): string {
  return `audio_welcome:${courseId}`;
}
export function finalExamKey(courseId: number): string {
  return `final_exam:${courseId}`;
}

/** Tipos por capítulo de v3, en orden canónico. */
const V3_CHAPTER_TYPES_IN_ORDER = [
  'content', 'experience', 'presentation', 'video', 'video_interactions', 'activity', 'audiobook_chapter',
] as const;

function assertV2Snapshot(snapshot: any, where: string): asserts snapshot is BlueprintSnapshotV2 {
  if (!snapshot || snapshot.schemaVersion !== 2) {
    throw new Error(
      `${BLUEPRINT_SCHEMA_MISMATCH}: ${where}: rulesVersion 3 requiere un Blueprint snapshot schemaVersion 2 ` +
        `(recibido ${String(snapshot?.schemaVersion)})`,
    );
  }
}

/**
 * Builder v3. Función pura (sin clock/random/DB); no muta la entrada. Los
 * flags nuevos NO se coercionan: un Blueprint v2 mal formado (activityEnabled
 * no boolean, engine desconocido) tira en vez de apagar actividades en silencio.
 */
export function buildGenerationManifestV3(snapshot: BlueprintSnapshotV2, source: ManifestSource): GenerationManifestV1 {
  assertV2Snapshot(snapshot, 'buildGenerationManifestV3');
  const course = snapshot.course;
  if (typeof course?.finalExam !== 'boolean') {
    throw new Error(`BLUEPRINT_V2_INVALID_INPUT: course.finalExam debe ser boolean (fue ${JSON.stringify(course?.finalExam)})`);
  }
  if (course.activityEngine !== 'h5p' && course.activityEngine !== 'scorm') {
    throw new Error(`BLUEPRINT_V2_INVALID_INPUT: course.activityEngine inválido: ${JSON.stringify(course.activityEngine)}`);
  }
  const variant: ActivityVariant = course.activityEngine;
  const planKey = coursePlanKey(source.courseId);
  const introKey = courseIntroKey(source.courseId);
  const courseBase = { scope: 'course' as const, moduleId: null, chapterId: null, moduleNumber: null, chapterNumber: null };

  const items: ManifestItem[] = [
    { key: planKey, type: 'course_plan', ...courseBase, dependsOn: [] },
    { key: introKey, type: 'course_intro', ...courseBase, dependsOn: [planKey] },
    { key: audioWelcomeKey(source.courseId), type: 'audio_welcome', ...courseBase, dependsOn: [introKey] },
  ];
  const modules: ManifestModule[] = [];
  const allContentKeys: string[] = [];
  let chapterNumber = 0;

  const modulesSorted = [...snapshot.modules].sort((a, b) => a.position - b.position);
  modulesSorted.forEach((m, mi) => {
    const moduleNumber = mi + 1;
    items.push({
      key: moduleIntroKey(m.id), type: 'module_intro', scope: 'module',
      moduleId: m.id, chapterId: null, moduleNumber, chapterNumber: null, dependsOn: [planKey],
    });
    const chapters: ManifestChapter[] = [];
    const contentKeys: string[] = [];
    for (const c of [...m.chapters].sort((a, b) => a.position - b.position)) {
      if (typeof c.activityEnabled !== 'boolean') {
        throw new Error(`BLUEPRINT_V2_INVALID_INPUT: chapter ${c.id} sin activityEnabled boolean`);
      }
      chapterNumber += 1;
      const videoEnabled = !!c.videoEnabled;
      chapters.push({ chapterId: c.id, position: c.position, chapterNumber, videoEnabled, activityEnabled: c.activityEnabled });
      const base = { scope: 'chapter' as const, moduleId: m.id, chapterId: c.id, moduleNumber, chapterNumber };
      const contentKey = `content:${c.id}`;
      contentKeys.push(contentKey);
      allContentKeys.push(contentKey);
      items.push({ key: contentKey, type: 'content', ...base, dependsOn: [planKey] });
      items.push({ key: `experience:${c.id}`, type: 'experience', ...base, dependsOn: [contentKey] });
      items.push({ key: `presentation:${c.id}`, type: 'presentation', ...base, dependsOn: [contentKey] });
      if (videoEnabled) {
        items.push({ key: `video:${c.id}`, type: 'video', ...base, dependsOn: [contentKey] });
        items.push({
          key: `video_interactions:${c.id}`, type: 'video_interactions', ...base,
          dependsOn: [`video:${c.id}`, contentKey],
        });
      }
      if (c.activityEnabled) {
        items.push({ key: `activity:${c.id}`, type: 'activity', ...base, dependsOn: [contentKey], variant });
      }
      items.push({ key: `audiobook_chapter:${c.id}`, type: 'audiobook_chapter', ...base, dependsOn: [contentKey] });
    }
    modules.push({ moduleId: m.id, position: m.position, moduleNumber, examEnabled: !!m.examEnabled, chapters });
    if (m.examEnabled) {
      items.push({
        key: `exam:${m.id}`, type: 'exam', scope: 'module',
        moduleId: m.id, chapterId: null, moduleNumber, chapterNumber: null, dependsOn: [...contentKeys],
      });
    }
  });
  if (course.finalExam) {
    items.push({ key: finalExamKey(source.courseId), type: 'final_exam', ...courseBase, dependsOn: [...allContentKeys] });
  }

  const count = (t: ManifestItemType) => items.filter((i) => i.type === t).length;
  return {
    manifestSchemaVersion: 1,
    rulesVersion: 3,
    source: {
      courseId: source.courseId,
      blueprintId: source.blueprintId,
      blueprintNumber: source.blueprintNumber,
      blueprintSha256: source.blueprintSha256,
    },
    features: { finalExam: course.finalExam, activityEngine: course.activityEngine },
    modules,
    items,
    totals: totalsV3From({
      moduleCount: modules.length,
      chapterCount: chapterNumber,
      contentCount: count('content'),
      videoCount: count('video'),
      examCount: count('exam'),
      coursePlanCount: count('course_plan'),
      courseIntroCount: count('course_intro'),
      moduleIntroCount: count('module_intro'),
      experienceCount: count('experience'),
      presentationCount: count('presentation'),
      videoInteractionsCount: count('video_interactions'),
      activityCount: count('activity'),
      audiobookChapterCount: count('audiobook_chapter'),
      audioWelcomeCount: count('audio_welcome'),
      finalExamCount: count('final_exam'),
      totalJobs: items.length,
    }),
  };
}

/** Totales v3 en orden de claves canónico (sin scormCount). */
function totalsV3From(t: ManifestTotals): ManifestTotals {
  return {
    moduleCount: t.moduleCount,
    chapterCount: t.chapterCount,
    contentCount: t.contentCount,
    videoCount: t.videoCount,
    examCount: t.examCount,
    coursePlanCount: t.coursePlanCount,
    courseIntroCount: t.courseIntroCount,
    moduleIntroCount: t.moduleIntroCount,
    experienceCount: t.experienceCount,
    presentationCount: t.presentationCount,
    videoInteractionsCount: t.videoInteractionsCount,
    activityCount: t.activityCount,
    audiobookChapterCount: t.audiobookChapterCount,
    audioWelcomeCount: t.audioWelcomeCount,
    finalExamCount: t.finalExamCount,
    totalJobs: t.totalJobs,
  };
}

/** Claves exactas de totals en v3 (orden canónico). */
export const MANIFEST_TOTALS_KEYS_V3: readonly (keyof ManifestTotals)[] = [
  'moduleCount', 'chapterCount', 'contentCount', 'videoCount', 'examCount',
  'coursePlanCount', 'courseIntroCount', 'moduleIntroCount',
  'experienceCount', 'presentationCount', 'videoInteractionsCount', 'activityCount',
  'audiobookChapterCount', 'audioWelcomeCount', 'finalExamCount', 'totalJobs',
];

/** Canonical v3: claves en orden fijo; `variant` solo si el item lo trae (el validador exige que solo `activity` lo tenga). */
export function canonicalManifestJsonV3(m: GenerationManifestV1): string {
  const canonical = {
    manifestSchemaVersion: m.manifestSchemaVersion,
    rulesVersion: m.rulesVersion,
    source: {
      courseId: m.source.courseId,
      blueprintId: m.source.blueprintId,
      blueprintNumber: m.source.blueprintNumber,
      blueprintSha256: m.source.blueprintSha256,
    },
    features: { finalExam: m.features?.finalExam, activityEngine: m.features?.activityEngine },
    modules: m.modules.map((mod) => ({
      moduleId: mod.moduleId,
      position: mod.position,
      moduleNumber: mod.moduleNumber,
      examEnabled: mod.examEnabled,
      chapters: mod.chapters.map((c) => ({
        chapterId: c.chapterId,
        position: c.position,
        chapterNumber: c.chapterNumber,
        videoEnabled: c.videoEnabled,
        activityEnabled: c.activityEnabled,
      })),
    })),
    items: m.items.map((i) => ({
      key: i.key,
      type: i.type,
      scope: i.scope,
      moduleId: i.moduleId,
      chapterId: i.chapterId,
      moduleNumber: i.moduleNumber,
      chapterNumber: i.chapterNumber,
      dependsOn: [...i.dependsOn],
      ...(i.variant !== undefined ? { variant: i.variant } : {}),
    })),
    // Se copian TODAS las claves que traiga (en orden v3 primero, luego
    // cualquier extra como scormCount) para que el validador vea un totals
    // adulterado en vez de que la canonicalización lo esconda.
    totals: (() => {
      const out: Record<string, unknown> = {};
      for (const k of MANIFEST_TOTALS_KEYS_V3) out[k] = (m.totals as any)?.[k];
      for (const k of Object.keys(m.totals ?? {}).sort()) if (!(k in out)) out[k] = (m.totals as any)[k];
      return out;
    })(),
  };
  return JSON.stringify(canonical);
}

interface ExpectedItemV3 {
  key: string;
  type: ManifestItemType;
  scope: ManifestItemScope;
  moduleId: string | null;
  chapterId: string | null;
  moduleNumber: number | null;
  chapterNumber: number | null;
  dependsOn: string[];
  variant?: ActivityVariant;
}

/**
 * Validador v3 independiente: recalcula desde el snapshot v2 (NO llama al
 * builder) el conjunto exacto de items, aristas, orden, variant y totales,
 * y devuelve TODOS los errores. Códigos (además de los de v1/v2):
 *  - BLUEPRINT_SCHEMA_MISMATCH: el snapshot no es schemaVersion 2.
 *  - FEATURES_MISMATCH: `features` no refleja course.finalExam/activityEngine.
 *  - ACTIVITY_NOT_ENABLED / FINAL_EXAM_NOT_ENABLED: item presente con el toggle OFF
 *    (VIDEO_NOT_ENABLED también cubre video_interactions).
 *  - WRONG_VARIANT: activity sin variant o distinto de course.activityEngine.
 *  - UNEXPECTED_VARIANT: un item que no es activity trae `variant`.
 *  - UNEXPECTED_ITEM: key de un tipo v3 válido que el snapshot no produce por otra razón.
 *  - MISSING_<TYPE>: p. ej. MISSING_EXPERIENCE, MISSING_AUDIOBOOK_CHAPTER, MISSING_FINAL_EXAM.
 */
export function validateGenerationManifestV3(
  m: GenerationManifestV1,
  snapshot: BlueprintSnapshotV2,
  source: ManifestSource,
): ManifestValidationError[] {
  const errors: ManifestValidationError[] = [];
  if (!snapshot || (snapshot as any).schemaVersion !== 2) {
    return [{
      code: BLUEPRINT_SCHEMA_MISMATCH,
      message: `rulesVersion 3 requiere un Blueprint snapshot schemaVersion 2, recibido ${String((snapshot as any)?.schemaVersion)}`,
    }];
  }
  if (m.rulesVersion !== 3) {
    errors.push({ code: 'VERSION_MISMATCH', message: `rulesVersion esperado 3, encontrado ${m.rulesVersion}` });
  }
  if (m.manifestSchemaVersion !== 1) {
    errors.push({ code: 'VERSION_MISMATCH', message: `manifestSchemaVersion esperado 1, encontrado ${m.manifestSchemaVersion}` });
  }
  if (
    m.source?.courseId !== source.courseId ||
    m.source?.blueprintId !== source.blueprintId ||
    m.source?.blueprintNumber !== source.blueprintNumber ||
    m.source?.blueprintSha256 !== source.blueprintSha256
  ) {
    errors.push({
      code: 'SOURCE_MISMATCH',
      message: 'source del manifest no coincide con el source esperado (courseId/blueprintId/blueprintNumber/blueprintSha256)',
    });
  }
  const finalExam = snapshot.course.finalExam === true;
  const engine = snapshot.course.activityEngine;
  if (m.features?.finalExam !== finalExam || m.features?.activityEngine !== engine) {
    errors.push({
      code: 'FEATURES_MISMATCH',
      message: `features esperado ${JSON.stringify({ finalExam, activityEngine: engine })}, encontrado ${JSON.stringify(m.features ?? null)}`,
    });
  }

  // --- Recalcular lo esperado desde el snapshot ---
  const planKey = `course_plan:${source.courseId}`;
  const introKey = `course_intro:${source.courseId}`;
  const expected: ExpectedItemV3[] = [];
  const course = (type: ManifestItemType, dependsOn: string[]): ExpectedItemV3 => ({
    key: `${type}:${source.courseId}`, type, scope: 'course',
    moduleId: null, chapterId: null, moduleNumber: null, chapterNumber: null, dependsOn,
  });
  expected.push(course('course_plan', []));
  expected.push(course('course_intro', [planKey]));
  expected.push(course('audio_welcome', [introKey]));

  const chapterInfo = new Map<string, { moduleId: string; videoEnabled: boolean; activityEnabled: boolean }>();
  const moduleInfo = new Map<string, { examEnabled: boolean }>();
  const expectedModules: ManifestModule[] = [];
  const allContent: string[] = [];
  let chNum = 0;
  const mods = [...snapshot.modules].sort((a, b) => a.position - b.position);
  mods.forEach((mod, idx) => {
    const moduleNumber = idx + 1;
    moduleInfo.set(mod.id, { examEnabled: !!mod.examEnabled });
    expected.push({
      key: `module_intro:${mod.id}`, type: 'module_intro', scope: 'module',
      moduleId: mod.id, chapterId: null, moduleNumber, chapterNumber: null, dependsOn: [planKey],
    });
    const modContent: string[] = [];
    const mirrorChapters: ManifestChapter[] = [];
    for (const c of [...mod.chapters].sort((a, b) => a.position - b.position)) {
      chNum += 1;
      const videoOn = !!c.videoEnabled;
      const activityOn = c.activityEnabled === true;
      chapterInfo.set(c.id, { moduleId: mod.id, videoEnabled: videoOn, activityEnabled: activityOn });
      mirrorChapters.push({ chapterId: c.id, position: c.position, chapterNumber: chNum, videoEnabled: videoOn, activityEnabled: activityOn });
      const content = `content:${c.id}`;
      modContent.push(content);
      allContent.push(content);
      const ch = (type: ManifestItemType, dependsOn: string[], variant?: ActivityVariant): ExpectedItemV3 => ({
        key: `${type}:${c.id}`, type, scope: 'chapter', moduleId: mod.id, chapterId: c.id,
        moduleNumber, chapterNumber: chNum, dependsOn, ...(variant ? { variant } : {}),
      });
      for (const type of V3_CHAPTER_TYPES_IN_ORDER) {
        if (type === 'content') expected.push(ch(type, [planKey]));
        else if (type === 'video' || type === 'video_interactions') {
          if (!videoOn) continue;
          expected.push(ch(type, type === 'video' ? [content] : [`video:${c.id}`, content]));
        } else if (type === 'activity') {
          if (activityOn) expected.push(ch(type, [content], engine));
        } else expected.push(ch(type, [content]));
      }
    }
    expectedModules.push({ moduleId: mod.id, position: mod.position, moduleNumber, examEnabled: !!mod.examEnabled, chapters: mirrorChapters });
    if (mod.examEnabled) {
      expected.push({
        key: `exam:${mod.id}`, type: 'exam', scope: 'module',
        moduleId: mod.id, chapterId: null, moduleNumber, chapterNumber: null, dependsOn: [...modContent],
      });
    }
  });
  if (finalExam) expected.push(course('final_exam', [...allContent]));
  const expectedByKey = new Map(expected.map((e) => [e.key, e]));

  // --- modules[] (espejo, con activityEnabled) ---
  if (JSON.stringify(canonicalModules(m.modules ?? [])) !== JSON.stringify(canonicalModules(expectedModules))) {
    errors.push({
      code: 'MODULES_MISMATCH',
      message: 'modules del manifest no coincide con el snapshot (ids/position/numeración/examEnabled/videoEnabled/activityEnabled u orden)',
    });
  }

  // --- items ---
  const keyCounts = new Map<string, number>();
  for (const it of m.items) keyCounts.set(it.key, (keyCounts.get(it.key) ?? 0) + 1);
  for (const [key, cnt] of keyCounts) {
    if (cnt > 1) errors.push({ code: 'DUPLICATE_KEY', message: `key duplicada: ${key} (${cnt} veces)`, key });
  }
  const presentKeys = new Set(m.items.map((i) => i.key));

  for (const it of m.items) {
    const exp = expectedByKey.get(it.key);
    if (!MANIFEST_ITEM_TYPES_V3.includes(it.type)) {
      errors.push({ code: 'UNKNOWN_TYPE', message: `item ${it.key}: type desconocido en rulesVersion 3: ${String(it.type)}`, key: it.key });
    } else if (!exp) {
      errors.push(unexpectedItemError(it, source, chapterInfo, moduleInfo, finalExam));
    } else {
      if (it.type !== exp.type) {
        errors.push({ code: 'KEY_MISMATCH', message: `item ${it.key}: type esperado ${exp.type}, encontrado ${it.type}`, key: it.key });
      }
      if (it.scope !== exp.scope) {
        errors.push({ code: 'SCOPE_MISMATCH', message: `item ${it.key}: scope esperado '${exp.scope}', encontrado '${it.scope}'`, key: it.key });
      }
      if ((it.moduleId ?? null) !== exp.moduleId || (it.chapterId ?? null) !== exp.chapterId) {
        errors.push({
          code: 'CHAPTER_MODULE_MISMATCH',
          message: `item ${it.key}: moduleId/chapterId esperados ${exp.moduleId}/${exp.chapterId}, encontrados ${it.moduleId}/${it.chapterId}`,
          key: it.key,
        });
      }
      if (it.moduleNumber !== exp.moduleNumber || it.chapterNumber !== exp.chapterNumber) {
        errors.push({
          code: 'NUMBERING_MISMATCH',
          message: `item ${it.key}: moduleNumber/chapterNumber esperados ${exp.moduleNumber}/${exp.chapterNumber}, encontrados ${it.moduleNumber}/${it.chapterNumber}`,
          key: it.key,
        });
      }
      const deps = Array.isArray(it.dependsOn) ? it.dependsOn : [];
      if (deps.length !== exp.dependsOn.length || deps.some((d, i) => d !== exp.dependsOn[i])) {
        errors.push({
          code: 'WRONG_DEPENDENCIES',
          message: `item ${it.key}: dependsOn esperado ${JSON.stringify(exp.dependsOn)}, encontrado ${JSON.stringify(it.dependsOn)}`,
          key: it.key,
        });
      }
    }
    if (it.type === 'activity') {
      if (it.variant !== engine) {
        errors.push({
          code: 'WRONG_VARIANT',
          message: `item ${it.key}: variant esperado '${engine}' (course.activityEngine), encontrado ${JSON.stringify(it.variant)}`,
          key: it.key,
        });
      }
    } else if (it.variant !== undefined) {
      errors.push({ code: 'UNEXPECTED_VARIANT', message: `item ${it.key}: solo los items activity llevan variant`, key: it.key });
    }
    for (const dep of Array.isArray(it.dependsOn) ? it.dependsOn : []) {
      if (!presentKeys.has(dep)) {
        errors.push({ code: 'DANGLING_DEPENDENCY', message: `item ${it.key} depende de una key inexistente: ${dep}`, key: it.key });
      }
    }
  }

  // --- faltantes ---
  for (const e of expected) {
    if (!presentKeys.has(e.key)) {
      errors.push({ code: `MISSING_${e.type.toUpperCase()}`, message: `falta el item ${e.key}`, key: e.key });
    }
  }

  // --- orden canónico (solo entre las keys esperadas presentes) ---
  const rank = new Map(expected.map((e, i) => [e.key, i]));
  const seen = m.items.map((i) => rank.get(i.key)).filter((r): r is number => r !== undefined);
  if (seen.some((r, i) => i > 0 && r <= seen[i - 1])) {
    errors.push({
      code: 'ORDER_MISMATCH',
      message: 'items no está en el orden canónico v3 (curso → por módulo: intro → capítulos → exam → final_exam)',
    });
  }

  // --- totales (claves exactas v3) ---
  const cnt = (t: ManifestItemType) => expected.filter((e) => e.type === t).length;
  const expectedTotals = totalsV3From({
    moduleCount: expectedModules.length,
    chapterCount: chNum,
    contentCount: cnt('content'),
    videoCount: cnt('video'),
    examCount: cnt('exam'),
    coursePlanCount: cnt('course_plan'),
    courseIntroCount: cnt('course_intro'),
    moduleIntroCount: cnt('module_intro'),
    experienceCount: cnt('experience'),
    presentationCount: cnt('presentation'),
    videoInteractionsCount: cnt('video_interactions'),
    activityCount: cnt('activity'),
    audiobookChapterCount: cnt('audiobook_chapter'),
    audioWelcomeCount: cnt('audio_welcome'),
    finalExamCount: cnt('final_exam'),
    totalJobs: expected.length,
  });
  const totals: Record<string, unknown> = (m.totals as any) ?? {};
  for (const k of MANIFEST_TOTALS_KEYS_V3) {
    if (totals[k] !== (expectedTotals as any)[k]) {
      errors.push({ code: 'TOTALS_MISMATCH', message: `totals.${k} esperado ${(expectedTotals as any)[k]}, encontrado ${totals[k]}` });
    }
  }
  for (const k of Object.keys(totals)) {
    if (!MANIFEST_TOTALS_KEYS_V3.includes(k as keyof ManifestTotals) && totals[k] !== undefined) {
      errors.push({ code: 'TOTALS_MISMATCH', message: `totals.${k} no existe en rulesVersion 3` });
    }
  }
  if (m.items.length !== totals.totalJobs) {
    errors.push({ code: 'TOTALS_MISMATCH', message: `totals.totalJobs (${totals.totalJobs}) no coincide con items.length (${m.items.length})` });
  }
  return errors;
}

function canonicalModules(mods: ManifestModule[]): unknown {
  return mods.map((mm) => ({
    moduleId: mm.moduleId,
    position: mm.position,
    moduleNumber: mm.moduleNumber,
    examEnabled: mm.examEnabled,
    chapters: (mm.chapters ?? []).map((c) => ({
      chapterId: c.chapterId,
      position: c.position,
      chapterNumber: c.chapterNumber,
      videoEnabled: c.videoEnabled,
      activityEnabled: c.activityEnabled,
    })),
  }));
}

/** Clasifica un item presente que el snapshot no produce (toggle OFF, entidad inexistente, key mal armada). */
function unexpectedItemError(
  it: ManifestItem,
  source: ManifestSource,
  chapterInfo: Map<string, { moduleId: string; videoEnabled: boolean; activityEnabled: boolean }>,
  moduleInfo: Map<string, { examEnabled: boolean }>,
  finalExam: boolean,
): ManifestValidationError {
  const scope = scopeOfItemType(it.type);
  const entity = it.key.slice(it.key.indexOf(':') + 1);
  const keyType = it.key.slice(0, Math.max(0, it.key.indexOf(':')));
  if (keyType !== it.type) {
    return { code: 'KEY_MISMATCH', message: `item ${it.key}: la key no corresponde a type=${it.type}`, key: it.key };
  }
  if (scope === 'course') {
    if (it.type === 'final_exam' && entity === String(source.courseId) && !finalExam) {
      return { code: 'FINAL_EXAM_NOT_ENABLED', message: `${it.key} existe pero course.finalExam=false`, key: it.key };
    }
    return { code: 'KEY_MISMATCH', message: `item ${it.key}: key esperada ${it.type}:${source.courseId}`, key: it.key };
  }
  if (scope === 'module') {
    const mod = moduleInfo.get(entity);
    if (!mod) return { code: 'UNKNOWN_MODULE', message: `${it.key} referencia un módulo inexistente en el snapshot`, key: it.key };
    if (it.type === 'exam' && !mod.examEnabled) {
      return { code: 'EXAM_NOT_ENABLED', message: `${it.key} existe pero el módulo tiene examEnabled=false`, key: it.key };
    }
    return { code: 'UNEXPECTED_ITEM', message: `${it.key} no corresponde al snapshot`, key: it.key };
  }
  const ch = chapterInfo.get(entity);
  if (!ch) return { code: 'UNKNOWN_CHAPTER', message: `${it.key} referencia un capítulo inexistente en el snapshot`, key: it.key };
  if ((it.type === 'video' || it.type === 'video_interactions') && !ch.videoEnabled) {
    return { code: 'VIDEO_NOT_ENABLED', message: `${it.key} existe pero el capítulo tiene videoEnabled=false`, key: it.key };
  }
  if (it.type === 'activity' && !ch.activityEnabled) {
    return { code: 'ACTIVITY_NOT_ENABLED', message: `${it.key} existe pero el capítulo tiene activityEnabled=false`, key: it.key };
  }
  return { code: 'UNEXPECTED_ITEM', message: `${it.key} no corresponde al snapshot`, key: it.key };
}
