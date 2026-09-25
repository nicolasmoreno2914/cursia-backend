import { createHash } from 'crypto';

/**
 * Raw shape returned by `select ... from course_modules`. snake_case on
 * purpose — this is what pg gives back, not an entity.
 */
export interface RawModuleRow {
  id: string;
  position: number;
  title: string;
  objective: string | null;
  exam_enabled: boolean;
}

/**
 * Raw shape returned by `select ... from course_chapters`.
 */
export interface RawChapterRow {
  id: string;
  module_id: string;
  position: number;
  title: string;
  objective: string | null;
  video_enabled: boolean;
}

export interface BlueprintChapter {
  id: string;
  position: number;
  title: string;
  objective: string | null;
  videoEnabled: boolean;
}

export interface BlueprintModule {
  id: string;
  position: number;
  title: string;
  objective: string | null;
  examEnabled: boolean;
  chapters: BlueprintChapter[];
}

export interface BlueprintSnapshotV1 {
  schemaVersion: 1;
  course: { id: number; title: string; structureVersion: 'dynamic' };
  modules: BlueprintModule[];
}

export interface BlueprintValidationError {
  path: string;
  code: string;
  message: string;
}

const MAX_TITLE_LENGTH = 255;

/**
 * Builds the canonical, immutable Blueprint snapshot from raw DB rows.
 *
 * Key order in every object literal here is fixed on purpose — it is what
 * makes `canonicalJson` deterministic (JSON.stringify preserves insertion
 * order for string keys). Modules are sorted by `position`, and chapters
 * are sorted by `position` within their module. `objective` is normalized
 * to `null` (both `null` and `undefined` collapse to `null`). Titles are
 * stored exactly as read from the DB — NOT trimmed — because the snapshot
 * is meant to be a faithful freeze of what existed; trimming is a
 * validation concern only (see `validateBlueprintSnapshot`/
 * `validateBlueprintInput` below), not a normalization one. Input arrays
 * are never mutated (we sort copies).
 *
 * Design choice — orphan chapters: a snapshot has no slot to put a chapter
 * whose `module_id` doesn't match any given module (chapters are nested
 * under their module in the output shape). Silently dropping such a
 * chapter would be exactly the "falla silenciosa" anti-pattern this
 * codebase explicitly avoids (see root CLAUDE.md, "Trampas conocidas" —
 * failing loud is preferred over quietly producing incomplete output). So
 * `buildBlueprintSnapshot` throws if it finds one. In practice this should
 * never trigger in the real pipeline: callers (Task 3's transaction, Task
 * 4's getStructure mapping) are expected to run `validateBlueprintInput`
 * first — which detects orphans as a normal `ORPHAN_CHAPTER` validation
 * error, not an exception — and abort before ever calling this function
 * with bad input. The throw here is a last-resort defensive guard, not the
 * primary detection path.
 */
export function buildBlueprintSnapshot(
  course: { id: number; title: string },
  modules: RawModuleRow[],
  chapters: RawChapterRow[],
): BlueprintSnapshotV1 {
  const moduleIds = new Set(modules.map((m) => m.id));
  const orphan = chapters.find((c) => !moduleIds.has(c.module_id));
  if (orphan) {
    throw new Error(
      `ORPHAN_CHAPTER: chapter ${orphan.id} references unknown module_id ${orphan.module_id}. ` +
        'Call validateBlueprintInput() first to detect this as a validation error instead of an exception.',
    );
  }

  const chaptersByModule = new Map<string, RawChapterRow[]>();
  for (const c of chapters) {
    const list = chaptersByModule.get(c.module_id) ?? [];
    list.push(c);
    chaptersByModule.set(c.module_id, list);
  }

  const sortedModules = [...modules].sort((a, b) => Number(a.position) - Number(b.position));

  return {
    schemaVersion: 1,
    course: {
      id: course.id,
      title: course.title,
      structureVersion: 'dynamic',
    },
    modules: sortedModules.map((m) => {
      const moduleChapters = [...(chaptersByModule.get(m.id) ?? [])].sort(
        (a, b) => Number(a.position) - Number(b.position),
      );
      return {
        id: m.id,
        position: Number(m.position),
        title: m.title,
        objective: m.objective ?? null,
        examEnabled: !!m.exam_enabled,
        chapters: moduleChapters.map((c) => ({
          id: c.id,
          position: Number(c.position),
          title: c.title,
          objective: c.objective ?? null,
          videoEnabled: !!c.video_enabled,
        })),
      };
    }),
  };
}

/**
 * Canonical serialization. The fixed key order comes entirely from how
 * `buildBlueprintSnapshot` constructs its object literals — plain
 * `JSON.stringify` is enough, no key-sorting needed.
 */
export function canonicalJson(s: BlueprintSnapshotV1): string {
  return JSON.stringify(s);
}

export function snapshotSha256(s: BlueprintSnapshotV1): string {
  return createHash('sha256').update(canonicalJson(s), 'utf8').digest('hex');
}

function isBlank(title: string): boolean {
  return title.trim().length === 0;
}

function isTooLong(title: string): boolean {
  return title.trim().length > MAX_TITLE_LENGTH;
}

/**
 * Validates an already-built snapshot (Ruling R2: no contiguity
 * requirement — gaps in `position` are valid, Fase 2 deletes don't
 * resequence; only duplicate positions are an error).
 *
 * Cannot detect ORPHAN_CHAPTER: by construction a snapshot never contains
 * one (see `buildBlueprintSnapshot`'s doc comment above — it throws before
 * producing a snapshot that would need one). This function is for callers
 * that only have the snapshot shape available, e.g. Task 4's
 * `getStructure`, which maps entities into the raw row shape and may
 * choose to validate post-build.
 */
export function validateBlueprintSnapshot(s: BlueprintSnapshotV1): BlueprintValidationError[] {
  const errors: BlueprintValidationError[] = [];

  if (isBlank(s.course.title)) {
    errors.push({
      path: 'course.title',
      code: 'BLANK_TITLE',
      message: 'El título del curso está vacío',
    });
  } else if (isTooLong(s.course.title)) {
    errors.push({
      path: 'course.title',
      code: 'TITLE_TOO_LONG',
      message: `El título del curso supera ${MAX_TITLE_LENGTH} caracteres`,
    });
  }

  if (s.modules.length === 0) {
    errors.push({
      path: 'modules',
      code: 'EMPTY_COURSE',
      message: 'El curso no tiene módulos',
    });
  }

  const seenModulePositions = new Map<number, number>(); // position -> first index seen

  s.modules.forEach((m, mIdx) => {
    if (isBlank(m.title)) {
      errors.push({
        path: `modules[${mIdx}].title`,
        code: 'BLANK_TITLE',
        message: `El título del módulo ${m.id} está vacío`,
      });
    } else if (isTooLong(m.title)) {
      errors.push({
        path: `modules[${mIdx}].title`,
        code: 'TITLE_TOO_LONG',
        message: `El título del módulo ${m.id} supera ${MAX_TITLE_LENGTH} caracteres`,
      });
    }

    if (seenModulePositions.has(m.position)) {
      const firstIdx = seenModulePositions.get(m.position) as number;
      errors.push({
        path: `modules[${mIdx}].position`,
        code: 'DUPLICATE_POSITION',
        message: `Posición de módulo duplicada: ${m.position} (módulos ${s.modules[firstIdx].id} y ${m.id})`,
      });
    } else {
      seenModulePositions.set(m.position, mIdx);
    }

    if (m.chapters.length === 0) {
      errors.push({
        path: `modules[${mIdx}].chapters`,
        code: 'EMPTY_MODULE',
        message: `El módulo ${m.id} no tiene capítulos`,
      });
    }

    const seenChapterPositions = new Map<number, number>();
    m.chapters.forEach((c, cIdx) => {
      if (isBlank(c.title)) {
        errors.push({
          path: `modules[${mIdx}].chapters[${cIdx}].title`,
          code: 'BLANK_TITLE',
          message: `El título del capítulo ${c.id} está vacío`,
        });
      } else if (isTooLong(c.title)) {
        errors.push({
          path: `modules[${mIdx}].chapters[${cIdx}].title`,
          code: 'TITLE_TOO_LONG',
          message: `El título del capítulo ${c.id} supera ${MAX_TITLE_LENGTH} caracteres`,
        });
      }

      if (seenChapterPositions.has(c.position)) {
        errors.push({
          path: `modules[${mIdx}].chapters[${cIdx}].position`,
          code: 'DUPLICATE_POSITION',
          message: `Posición de capítulo duplicada en módulo ${m.id}: ${c.position}`,
        });
      } else {
        seenChapterPositions.set(c.position, cIdx);
      }
    });
  });

  return errors;
}

/**
 * Validates raw pg rows BEFORE building the snapshot. This is the only
 * validator that can see ORPHAN_CHAPTER, since `buildBlueprintSnapshot`
 * has no slot in its output shape for a chapter whose `module_id` doesn't
 * match any given module.
 *
 * Intended call site: Task 3's transaction should call this first and
 * abort (returning the errors to the caller / rolling back) instead of
 * calling `buildBlueprintSnapshot` with unvalidated input, which would
 * throw on an orphan rather than reporting it as a normal validation
 * error.
 *
 * Implementation: orphan chapters are detected directly against the raw
 * rows, then a "lenient" snapshot is built excluding only the orphan
 * chapters (never mutating the caller's arrays) so the rest of the checks
 * (EMPTY_COURSE, EMPTY_MODULE, BLANK_TITLE, TITLE_TOO_LONG,
 * DUPLICATE_POSITION) can be reused from `validateBlueprintSnapshot`
 * without duplicating that logic.
 */
export function validateBlueprintInput(
  course: { id: number; title: string },
  modules: RawModuleRow[],
  chapters: RawChapterRow[],
): BlueprintValidationError[] {
  const moduleIds = new Set(modules.map((m) => m.id));
  const errors: BlueprintValidationError[] = [];
  const validChapters: RawChapterRow[] = [];

  chapters.forEach((c, idx) => {
    if (!moduleIds.has(c.module_id)) {
      errors.push({
        path: `chapters[${idx}]`,
        code: 'ORPHAN_CHAPTER',
        message: `El capítulo ${c.id} referencia un module_id inexistente: ${c.module_id}`,
      });
    } else {
      validChapters.push(c);
    }
  });

  const lenientSnapshot = buildBlueprintSnapshot(course, modules, validChapters);
  return [...errors, ...validateBlueprintSnapshot(lenientSnapshot)];
}
