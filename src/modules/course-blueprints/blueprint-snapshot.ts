import { createHash } from 'crypto';
import {
  BlueprintPedagogyInput,
  ChapterDesign,
  CoursePedagogyDesign,
  ModuleDesign,
  canonicalChapterDesign,
  canonicalCoursePedagogy,
  canonicalModuleDesign,
} from '../pedagogy/blueprint-design';

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
  /** Title Normalization (solo v2; v1 lo ignora). */
  description?: string | null;
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
  /** Title Normalization (solo v2; v1 lo ignora). */
  description?: string | null;
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

// ════════════════════════════════════════════════════════════════════════════
// Blueprint snapshot schemaVersion 2 (Cursia V2.1 — R3, audit §M.1 / §S).
//
// Todo lo de arriba (v1) queda byte-idéntico: v2 tiene su propio builder,
// canonicalJson, sha y validador. v2 agrega los toggles de producto que
// CAMBIAN el conjunto de items del Manifest:
//   - course.finalExam        (courses.final_exam_enabled, default true)
//   - course.activityEngine   (courses.activity_engine, 'h5p' | 'scorm')
//   - chapter.activityEnabled (course_chapters.activity_enabled, default true)
// Tema, passingGrade, intentos y pesos NO entran (son perfiles, §M.2).
// ════════════════════════════════════════════════════════════════════════════

export type ActivityEngine = 'h5p' | 'scorm';
export const ACTIVITY_ENGINES: readonly ActivityEngine[] = ['h5p', 'scorm'];
export const DEFAULT_ACTIVITY_ENGINE: ActivityEngine = 'h5p';

export interface RawChapterRowV2 extends RawChapterRow {
  activity_enabled: boolean;
}

export interface BlueprintCourseInputV2 {
  id: number;
  title: string;
  finalExam: boolean;
  activityEngine: ActivityEngine;
  /**
   * EV6 H5P v2: ajuste «Repaso» (Dialog Cards opcional por capítulo). courses.review_cards_enabled:
   * NULL en cursos anteriores (= apagado), default true en cursos nuevos. Solo `true` entra al snapshot.
   */
  reviewCards?: boolean | null;
}

export interface BlueprintChapterV2 extends BlueprintChapter {
  /** Solo presente con texto: los snapshots sin descripción conservan su sha. */
  description?: string;
  activityEnabled: boolean;
  /** Motor pedagógico V1: solo si el curso tiene perfil pedagógico (sin él, sha de siempre). */
  design?: ChapterDesign;
}

export interface BlueprintModuleV2 {
  id: string;
  position: number;
  title: string;
  objective: string | null;
  /** Solo presente con texto: los snapshots sin descripción conservan su sha. */
  description?: string;
  examEnabled: boolean;
  /** Motor pedagógico V1: solo si el curso tiene perfil pedagógico. */
  design?: ModuleDesign;
  chapters: BlueprintChapterV2[];
}

export interface BlueprintSnapshotV2 {
  schemaVersion: 2;
  course: {
    id: number;
    title: string;
    structureVersion: 'dynamic';
    finalExam: boolean;
    activityEngine: ActivityEngine;
    /**
     * EV6 H5P v2: «Repaso» con Dialog Cards en los capítulos cuya experiencia trae ≥ 4 tarjetas.
     * La clave existe SOLO cuando está encendido: los snapshots sin ella conservan su sha.
     */
    reviewCards?: true;
    /**
     * Motor pedagógico V1: resumen del diseño pedagógico (enfoques, estrategia de evaluación…).
     * La clave existe SOLO con perfil pedagógico: los snapshots sin ella conservan su sha.
     */
    pedagogy?: CoursePedagogyDesign;
  };
  modules: BlueprintModuleV2[];
}

export type AnyBlueprintSnapshot = BlueprintSnapshotV1 | BlueprintSnapshotV2;

/**
 * Title Normalization: la clave `description` va en el snapshot v2 SOLO si hay
 * texto (después de colapsar espacios), en orden fijo detrás de `objective`.
 * Sin descripción el JSON canónico es byte a byte el de antes → los Blueprints
 * existentes, sus huellas y su invalidación no cambian.
 */
export function descriptionKey(v: string | null | undefined): { description?: string } {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t ? { description: t } : {};
}

export function isActivityEngine(v: unknown): v is ActivityEngine {
  return v === 'h5p' || v === 'scorm';
}

/**
 * Builder v2. Mismas reglas que v1 (orden por `position`, objective → null,
 * títulos sin trim, input sin mutar, huérfanos → throw) y claves en orden
 * fijo. Diferencia deliberada: los campos NUEVOS no se coercionan con `!!` —
 * si una query se olvidó de seleccionar `activity_enabled` (undefined), v1
 * habría producido `false` en silencio (todas las actividades apagadas). Acá
 * eso tira: `BLUEPRINT_V2_INVALID_INPUT`.
 */
export function buildBlueprintSnapshotV2(
  course: BlueprintCourseInputV2,
  modules: RawModuleRow[],
  chapters: RawChapterRowV2[],
  pedagogy?: BlueprintPedagogyInput | null,
): BlueprintSnapshotV2 {
  if (typeof course.finalExam !== 'boolean') {
    throw new Error(`BLUEPRINT_V2_INVALID_INPUT: course.finalExam debe ser boolean (fue ${JSON.stringify(course.finalExam)})`);
  }
  if (!isActivityEngine(course.activityEngine)) {
    throw new Error(
      `BLUEPRINT_V2_INVALID_INPUT: course.activityEngine debe ser 'h5p' o 'scorm' (fue ${JSON.stringify(course.activityEngine)})`,
    );
  }
  if (course.reviewCards !== undefined && course.reviewCards !== null && typeof course.reviewCards !== 'boolean') {
    throw new Error(`BLUEPRINT_V2_INVALID_INPUT: course.reviewCards debe ser boolean o null (fue ${JSON.stringify(course.reviewCards)})`);
  }
  const badChapter = chapters.find((c) => typeof c.activity_enabled !== 'boolean');
  if (badChapter) {
    throw new Error(
      `BLUEPRINT_V2_INVALID_INPUT: chapter ${badChapter.id} sin activity_enabled boolean ` +
        `(fue ${JSON.stringify(badChapter.activity_enabled)}) — ¿la query no seleccionó la columna?`,
    );
  }
  const moduleIds = new Set(modules.map((m) => m.id));
  const orphan = chapters.find((c) => !moduleIds.has(c.module_id));
  if (orphan) {
    throw new Error(
      `ORPHAN_CHAPTER: chapter ${orphan.id} references unknown module_id ${orphan.module_id}. ` +
        'Call validateBlueprintInputV2() first to detect this as a validation error instead of an exception.',
    );
  }

  const chaptersByModule = new Map<string, RawChapterRowV2[]>();
  for (const c of chapters) {
    const list = chaptersByModule.get(c.module_id) ?? [];
    list.push(c);
    chaptersByModule.set(c.module_id, list);
  }
  const sortedModules = [...modules].sort((a, b) => Number(a.position) - Number(b.position));
  // Motor pedagógico V1: con perfil, TODO módulo y capítulo lleva su diseño (incompleto → throw).
  if (pedagogy) {
    for (const m of modules) if (!pedagogy.modules?.[m.id]) throw new Error(`BLUEPRINT_PEDAGOGY_INVALID: falta el diseño del módulo ${m.id}`);
    for (const c of chapters) if (!pedagogy.chapters?.[c.id]) throw new Error(`BLUEPRINT_PEDAGOGY_INVALID: falta el diseño del capítulo ${c.id}`);
  }
  const coursePedagogy = pedagogy ? canonicalCoursePedagogy(pedagogy.course) : null;

  return {
    schemaVersion: 2,
    course: {
      id: course.id,
      title: course.title,
      structureVersion: 'dynamic',
      finalExam: course.finalExam,
      activityEngine: course.activityEngine,
      ...(course.reviewCards === true ? { reviewCards: true as const } : {}),
      ...(coursePedagogy ? { pedagogy: coursePedagogy } : {}),
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
        ...descriptionKey(m.description),
        examEnabled: !!m.exam_enabled,
        ...(pedagogy ? { design: canonicalModuleDesign(pedagogy.modules[m.id], `modules[${m.id}].design`) } : {}),
        chapters: moduleChapters.map((c) => ({
          id: c.id,
          position: Number(c.position),
          title: c.title,
          objective: c.objective ?? null,
          ...descriptionKey(c.description),
          videoEnabled: !!c.video_enabled,
          activityEnabled: c.activity_enabled,
          ...(pedagogy ? { design: canonicalChapterDesign(pedagogy.chapters[c.id], `chapters[${c.id}].design`) } : {}),
        })),
      };
    }),
  };
}

/**
 * Canonical v2: el orden de claves lo fija `buildBlueprintSnapshotV2`. Para
 * un objeto que viene de jsonb (claves reordenadas) usar
 * `recanonicalizeBlueprintSnapshotV2` antes.
 */
export function canonicalJsonV2(s: BlueprintSnapshotV2): string {
  return JSON.stringify(s);
}

export function snapshotSha256V2(s: BlueprintSnapshotV2): string {
  return createHash('sha256').update(canonicalJsonV2(s), 'utf8').digest('hex');
}

/** Re-arma un snapshot v2 (p.ej. leído de jsonb) en su orden canónico, pasando por el builder. */
export function recanonicalizeBlueprintSnapshotV2(stored: any): BlueprintSnapshotV2 {
  const s = typeof stored === 'string' ? JSON.parse(stored) : stored;
  if (!s || s.schemaVersion !== 2) {
    throw new Error(`recanonicalizeBlueprintSnapshotV2: schemaVersion ${s?.schemaVersion} (se esperaba 2)`);
  }
  const { course, modules, chapters, pedagogy } = snapshotV2ToRows(s);
  return buildBlueprintSnapshotV2(course, modules, chapters, pedagogy);
}

/**
 * Snapshot v2 (en cualquier orden de claves) → la entrada del builder: filas crudas + el diseño
 * pedagógico tal cual estaba congelado (null si el snapshot no lo tiene). Lo usan
 * `recanonicalizeBlueprintSnapshotV2` y el motor pedagógico (aplicar/proponer sobre un snapshot).
 */
export function snapshotV2ToRows(s: any): {
  course: BlueprintCourseInputV2;
  modules: RawModuleRow[];
  chapters: RawChapterRowV2[];
  pedagogy: BlueprintPedagogyInput | null;
} {
  const modules: RawModuleRow[] = [];
  const chapters: RawChapterRowV2[] = [];
  const hasPedagogy = s.course?.pedagogy !== undefined;
  const pedagogy: BlueprintPedagogyInput | null = hasPedagogy ? { course: s.course.pedagogy, modules: {}, chapters: {} } : null;
  for (const m of s.modules) {
    modules.push({ id: m.id, position: m.position, title: m.title, objective: m.objective, exam_enabled: m.examEnabled, description: m.description ?? null });
    if (pedagogy) pedagogy.modules[m.id] = m.design;
    else if (m.design !== undefined) throw new Error(`BLUEPRINT_PEDAGOGY_INVALID: el módulo ${m.id} trae design sin course.pedagogy`);
    for (const c of m.chapters) {
      chapters.push({
        id: c.id, module_id: m.id, position: c.position, title: c.title, objective: c.objective,
        description: c.description ?? null,
        video_enabled: c.videoEnabled, activity_enabled: c.activityEnabled,
      });
      if (pedagogy) pedagogy.chapters[c.id] = c.design;
      else if (c.design !== undefined) throw new Error(`BLUEPRINT_PEDAGOGY_INVALID: el capítulo ${c.id} trae design sin course.pedagogy`);
    }
  }
  return {
    course: {
      id: s.course.id,
      title: s.course.title,
      finalExam: s.course.finalExam,
      activityEngine: s.course.activityEngine,
      ...(s.course.reviewCards !== undefined ? { reviewCards: s.course.reviewCards } : {}),
    },
    modules,
    chapters,
    pedagogy,
  };
}

/**
 * Vista v1 de un v2 (solo para reusar las reglas estructurales de v1; nunca
 * para hashear). Exportada en R5 para el Coherence Engine (reglas S1–S3 y
 * de contenido sobre un Blueprint v2).
 */
export function structuralViewV1(s: BlueprintSnapshotV2): BlueprintSnapshotV1 {
  return {
    schemaVersion: 1,
    course: { id: s.course.id, title: s.course.title, structureVersion: 'dynamic' },
    modules: s.modules.map((m) => ({
      id: m.id, position: m.position, title: m.title, objective: m.objective, examEnabled: m.examEnabled,
      chapters: m.chapters.map((c) => ({ id: c.id, position: c.position, title: c.title, objective: c.objective, videoEnabled: c.videoEnabled })),
    })),
  };
}

/**
 * Validador v2: todas las reglas estructurales de v1 (mismos códigos y
 * paths) + los toggles nuevos (`INVALID_FINAL_EXAM`,
 * `INVALID_ACTIVITY_ENGINE`, `INVALID_ACTIVITY_ENABLED`) + schemaVersion.
 */
export function validateBlueprintSnapshotV2(s: BlueprintSnapshotV2): BlueprintValidationError[] {
  const errors: BlueprintValidationError[] = [];
  if (s.schemaVersion !== 2) {
    errors.push({ path: 'schemaVersion', code: 'INVALID_SCHEMA_VERSION', message: `schemaVersion ${s.schemaVersion} (se esperaba 2)` });
  }
  if (typeof s.course.finalExam !== 'boolean') {
    errors.push({ path: 'course.finalExam', code: 'INVALID_FINAL_EXAM', message: 'course.finalExam debe ser boolean' });
  }
  if (!isActivityEngine(s.course.activityEngine)) {
    errors.push({
      path: 'course.activityEngine',
      code: 'INVALID_ACTIVITY_ENGINE',
      message: `course.activityEngine inválido: ${JSON.stringify(s.course.activityEngine)} (permitidos: h5p, scorm)`,
    });
  }
  // Motor pedagógico V1: con course.pedagogy, todo módulo y capítulo lleva design; sin él, ninguno.
  const hasPedagogy = s.course.pedagogy !== undefined;
  s.modules.forEach((m, mIdx) => {
    if ((m.design !== undefined) !== hasPedagogy) {
      errors.push({
        path: `modules[${mIdx}].design`,
        code: 'PEDAGOGY_INCOMPLETE',
        message: hasPedagogy ? `El módulo ${m.id} no tiene diseño pedagógico` : `El módulo ${m.id} trae diseño pedagógico sin course.pedagogy`,
      });
    }
    m.chapters.forEach((c, cIdx) => {
      if ((c.design !== undefined) !== hasPedagogy) {
        errors.push({
          path: `modules[${mIdx}].chapters[${cIdx}].design`,
          code: 'PEDAGOGY_INCOMPLETE',
          message: hasPedagogy ? `El capítulo ${c.id} no tiene diseño pedagógico` : `El capítulo ${c.id} trae diseño pedagógico sin course.pedagogy`,
        });
      }
    });
  });
  s.modules.forEach((m, mIdx) =>
    m.chapters.forEach((c, cIdx) => {
      if (typeof c.activityEnabled !== 'boolean') {
        errors.push({
          path: `modules[${mIdx}].chapters[${cIdx}].activityEnabled`,
          code: 'INVALID_ACTIVITY_ENABLED',
          message: `El capítulo ${c.id} tiene activityEnabled no booleano`,
        });
      }
    }),
  );
  return [...errors, ...validateBlueprintSnapshot(structuralViewV1(s))];
}

/**
 * Validación de filas crudas ANTES del build v2 (detecta ORPHAN_CHAPTER como
 * error normal). Las filas v2 son superconjunto de las v1, así que reusa
 * `validateBlueprintInput` y agrega los checks de los campos nuevos.
 */
export function validateBlueprintInputV2(
  course: BlueprintCourseInputV2,
  modules: RawModuleRow[],
  chapters: RawChapterRowV2[],
): BlueprintValidationError[] {
  const errors = validateBlueprintInput({ id: course.id, title: course.title }, modules, chapters);
  if (typeof course.finalExam !== 'boolean') {
    errors.push({ path: 'course.finalExam', code: 'INVALID_FINAL_EXAM', message: 'course.finalExam debe ser boolean' });
  }
  if (!isActivityEngine(course.activityEngine)) {
    errors.push({
      path: 'course.activityEngine',
      code: 'INVALID_ACTIVITY_ENGINE',
      message: `course.activityEngine inválido: ${JSON.stringify(course.activityEngine)} (permitidos: h5p, scorm)`,
    });
  }
  if (course.reviewCards !== undefined && course.reviewCards !== null && typeof course.reviewCards !== 'boolean') {
    errors.push({ path: 'course.reviewCards', code: 'INVALID_REVIEW_CARDS', message: 'course.reviewCards debe ser boolean o null' });
  }
  chapters.forEach((c, idx) => {
    if (typeof c.activity_enabled !== 'boolean') {
      errors.push({
        path: `chapters[${idx}].activity_enabled`,
        code: 'INVALID_ACTIVITY_ENABLED',
        message: `El capítulo ${c.id} tiene activity_enabled no booleano`,
      });
    }
  });
  return errors;
}

/**
 * Advertencias NO bloqueantes (audit §M.1): si ningún capítulo tiene
 * actividad, ningún módulo tiene examen y no hay examen final, el curso no
 * tiene nada calificable.
 */
export function blueprintV2Warnings(s: BlueprintSnapshotV2): BlueprintValidationError[] {
  const anyActivity = s.modules.some((m) => m.chapters.some((c) => c.activityEnabled));
  const anyExam = s.modules.some((m) => m.examEnabled);
  if (!anyActivity && !anyExam && !s.course.finalExam) {
    return [{
      path: 'course',
      code: 'NO_GRADED_ITEMS',
      message: 'Todas las actividades y exámenes están apagados: el curso no tendrá nota.',
    }];
  }
  return [];
}

/**
 * Lector de compatibilidad (audit §S): cualquier snapshot → forma v2.
 * Un v1 se lee como `finalExam=false` (un curso v2 no gana examen final al
 * releerse), `activityEngine='scorm'` (el motor que ya usaba) y
 * `activityEnabled=true` en cada capítulo. Es una VISTA: nunca se re-hashea
 * ni se persiste (el sha de un v1 no cambia). Un v2 se devuelve en orden
 * canónico. Cualquier otro schemaVersion → throw.
 */
export function readSnapshotAsV2(snapshot: AnyBlueprintSnapshot | any): BlueprintSnapshotV2 {
  const s = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
  if (s && s.schemaVersion === 2) return recanonicalizeBlueprintSnapshotV2(s);
  if (!s || s.schemaVersion !== 1) {
    throw new Error(`readSnapshotAsV2: schemaVersion no soportado: ${s?.schemaVersion}`);
  }
  return {
    schemaVersion: 2,
    course: {
      id: s.course.id,
      title: s.course.title,
      structureVersion: 'dynamic',
      finalExam: false,
      activityEngine: 'scorm',
    },
    modules: s.modules.map((m: BlueprintModule) => ({
      id: m.id,
      position: m.position,
      title: m.title,
      objective: m.objective ?? null,
      examEnabled: !!m.examEnabled,
      chapters: m.chapters.map((c) => ({
        id: c.id,
        position: c.position,
        title: c.title,
        objective: c.objective ?? null,
        videoEnabled: !!c.videoEnabled,
        activityEnabled: true,
      })),
    })),
  };
}

/** sha del snapshot según su propio schemaVersion (v1 → snapshotSha256, v2 → snapshotSha256V2). */
export function anySnapshotSha256(s: AnyBlueprintSnapshot): string {
  return s.schemaVersion === 2 ? snapshotSha256V2(s) : snapshotSha256(s);
}
