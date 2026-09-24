import { createHash } from 'crypto';
import type { BlueprintSnapshotV1 } from '../course-blueprints/blueprint-snapshot';

export const MANIFEST_RULES_VERSION = 1;
export const MANIFEST_SCHEMA_VERSION = 1;

export type ManifestItemType = 'content' | 'scorm' | 'video' | 'exam';

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
}

export interface ManifestModule {
  moduleId: string;
  position: number;
  moduleNumber: number;
  examEnabled: boolean;
  chapters: ManifestChapter[];
}

export interface ManifestItem {
  key: string;
  type: ManifestItemType;
  scope: 'chapter' | 'module';
  moduleId: string;
  chapterId: string | null;
  moduleNumber: number;
  chapterNumber: number | null;
  dependsOn: string[];
}

export interface ManifestTotals {
  moduleCount: number;
  chapterCount: number;
  contentCount: number;
  scormCount: number;
  videoCount: number;
  examCount: number;
  totalJobs: number;
}

export interface GenerationManifestV1 {
  manifestSchemaVersion: 1;
  rulesVersion: 1;
  source: ManifestSource;
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
export function buildGenerationManifest(
  snapshot: BlueprintSnapshotV1,
  source: ManifestSource,
): GenerationManifestV1 {
  const modulesSorted = [...snapshot.modules].sort((a, b) => a.position - b.position);
  let chapterNumber = 0;
  const modules: ManifestModule[] = [];
  const items: ManifestItem[] = [];

  modulesSorted.forEach((m, mi) => {
    const moduleNumber = mi + 1;
    const chaptersSorted = [...m.chapters].sort((a, b) => a.position - b.position);
    const chapters: ManifestChapter[] = [];
    const contentKeys: string[] = [];

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

      items.push({ key: contentKey, type: 'content', ...base, dependsOn: [] });
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
  const totals: ManifestTotals = {
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
    rulesVersion: 1,
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
  snapshot: BlueprintSnapshotV1,
  source: ManifestSource,
): ManifestValidationError[] {
  const errors: ManifestValidationError[] = [];

  if (m.rulesVersion !== 1) {
    errors.push({
      code: 'VERSION_MISMATCH',
      message: `rulesVersion esperado 1, encontrado ${m.rulesVersion}`,
    });
  }
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
  const canonicalOrderKeys: string[] = [];
  modulesSorted.forEach((mod) => {
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

  const KNOWN_ITEM_TYPES: ManifestItemType[] = ['content', 'scorm', 'video', 'exam'];

  for (const item of m.items) {
    // --- FIX I1: per-item identity/consistency checks, independent of
    // whether the referenced moduleId/chapterId actually exist (those are
    // handled separately below). Each check is computed from the item's
    // own claimed fields, so a swapped/forged id or number is caught even
    // when every key involved is otherwise present in the manifest. ---
    if (!KNOWN_ITEM_TYPES.includes(item.type)) {
      errors.push({
        code: 'UNKNOWN_TYPE',
        message: `item ${item.key}: type desconocido: ${String(item.type)}`,
        key: item.key,
      });
    } else {
      const expectedKey = item.type === 'exam' ? `exam:${item.moduleId}` : `${item.type}:${item.chapterId}`;
      if (item.key !== expectedKey) {
        errors.push({
          code: 'KEY_MISMATCH',
          message: `item ${item.key}: key esperada ${expectedKey} según type/${item.type === 'exam' ? 'moduleId' : 'chapterId'}`,
          key: item.key,
        });
      }

      const expectedScope = item.type === 'exam' ? 'module' : 'chapter';
      if (item.scope !== expectedScope) {
        errors.push({
          code: 'SCOPE_MISMATCH',
          message: `item ${item.key}: scope esperado '${expectedScope}' para type=${item.type}, encontrado '${item.scope}'`,
          key: item.key,
        });
      }

      const expectedModuleForItem = expectedModules.get(item.moduleId);
      if (expectedModuleForItem && item.moduleNumber !== expectedModuleForItem.moduleNumber) {
        errors.push({
          code: 'NUMBERING_MISMATCH',
          message: `item ${item.key}: moduleNumber esperado ${expectedModuleForItem.moduleNumber} para moduleId ${item.moduleId}, encontrado ${item.moduleNumber}`,
          key: item.key,
        });
      }

      if (item.type === 'exam') {
        if (item.chapterId !== null) {
          errors.push({
            code: 'NUMBERING_MISMATCH',
            message: `item ${item.key}: chapterId esperado null para un item de tipo exam, encontrado ${item.chapterId}`,
            key: item.key,
          });
        }
        if (item.chapterNumber !== null) {
          errors.push({
            code: 'NUMBERING_MISMATCH',
            message: `item ${item.key}: chapterNumber esperado null para un item de tipo exam, encontrado ${item.chapterNumber}`,
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

    if (item.type === 'exam') {
      const expectedModule = expectedModules.get(item.moduleId);
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
    let expectedDeps: string[] | undefined;
    if (item.type === 'content') {
      expectedDeps = [];
    } else if (item.type === 'scorm' || item.type === 'video') {
      if (item.chapterId) expectedDeps = [`content:${item.chapterId}`];
    } else if (item.type === 'exam') {
      const chapterIds = moduleChapterOrder.get(item.moduleId);
      if (chapterIds) expectedDeps = chapterIds.map((cid) => `content:${cid}`);
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
  const expectedTotals: ManifestTotals = {
    moduleCount: expectedModules.size,
    chapterCount: expectedChapters.size,
    contentCount: expectedContentKeys.size,
    scormCount: expectedScormKeys.size,
    videoCount: expectedVideoKeys.size,
    examCount: expectedExamKeys.size,
    totalJobs:
      expectedContentKeys.size + expectedScormKeys.size + expectedVideoKeys.size + expectedExamKeys.size,
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
    totals: {
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
