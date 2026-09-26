import { sha256Canonical, sortedCanonicalJson } from '../coherence/canonical-json';

/**
 * Cursia V2.1 — R3: perfiles de curso (audit §M.2, §K.2). Lógica PURA: sin
 * DB, sin reloj, sin aleatoriedad.
 *
 * Los perfiles NO entran en el Blueprint, en el Manifest ni en ninguna huella
 * de invalidación: no cambian QUÉ se genera, solo cómo se empaqueta (y el
 * tema Gamma). Se guardan versionados (append-only) en `course_profiles`.
 */

export type ProfileKind = 'presentation' | 'assessment';
export const PROFILE_KINDS: readonly ProfileKind[] = ['presentation', 'assessment'];

export function isProfileKind(v: unknown): v is ProfileKind {
  return v === 'presentation' || v === 'assessment';
}

export interface ProfileValidationError {
  path: string;
  code: string;
  message: string;
}

// ── Presentation ────────────────────────────────────────────────────────────

/**
 * Copia de `ThemeFamilyId` del Theme Engine (bloque R1, en paralelo: NO se
 * importa a propósito). RECONCILIAR en la integración: reemplazar por el
 * import de `src/modules/theme-engine` y borrar esta lista.
 */
export const THEME_FAMILY_IDS = [
  'aula-clara',
  'institucional',
  'editorial',
  'tecnico',
  'vibrante',
  'oscuro-premium',
] as const;
export type ThemeFamilyIdCopy = (typeof THEME_FAMILY_IDS)[number];

/** Copia de `ThemeMode` (R1). Reconciliar igual que THEME_FAMILY_IDS. */
export const THEME_MODES = ['light', 'dark'] as const;
export type ThemeModeCopy = (typeof THEME_MODES)[number];

export interface BrandSeedInput {
  accent?: string;
  moduleColors?: string[];
}

export interface PresentationProfile {
  themeFamily: ThemeFamilyIdCopy;
  mode: ThemeModeCopy;
  brandSeed: BrandSeedInput | null;
  themeVersion: number;
}

export function defaultPresentationProfile(): PresentationProfile {
  return { themeFamily: 'aula-clara', mode: 'light', brandSeed: null, themeVersion: 1 };
}

// ── Assessment ──────────────────────────────────────────────────────────────

export const ASSESSMENT_PROFILE_VERSION = 1;
export const GRADE_METHODS = ['highest', 'average', 'first', 'last'] as const;
export type GradeMethod = (typeof GRADE_METHODS)[number];
export const ASSESSABLE_TYPES = ['activity', 'video', 'exam', 'finalExam'] as const;
export type AssessableType = (typeof ASSESSABLE_TYPES)[number];

export interface CategoryWeightsWithFinal {
  practice: number;
  moduleExams: number;
  finalExam: number;
}
export interface CategoryWeightsWithoutFinal {
  practice: number;
  moduleExams: number;
}

export interface AssessmentProfile {
  assessmentProfileVersion: number;
  passingGrade: number;
  overrides: Record<AssessableType, number | null>;
  attempts: Record<AssessableType, number>;
  gradeMethod: Record<AssessableType, GradeMethod>;
  categoryWeights: CategoryWeightsWithFinal | CategoryWeightsWithoutFinal;
  courseCompletion: {
    requireAllChapterActivities: boolean;
    requireExams: boolean;
    requireCourseGradePass: boolean;
  };
}

/** Defaults de producto (DECISIONES VIGENTES): 70; formativos ilimitados (0), exámenes 3; 30/50/20 o 40/60. */
export function defaultAssessmentProfile(opts: { finalExam: boolean }): AssessmentProfile {
  if (typeof opts?.finalExam !== 'boolean') {
    throw new Error('defaultAssessmentProfile: finalExam debe ser boolean');
  }
  return {
    assessmentProfileVersion: ASSESSMENT_PROFILE_VERSION,
    passingGrade: 70,
    overrides: { activity: null, video: null, exam: null, finalExam: null },
    attempts: { activity: 0, video: 0, exam: 3, finalExam: 3 },
    gradeMethod: { activity: 'highest', video: 'highest', exam: 'highest', finalExam: 'highest' },
    categoryWeights: opts.finalExam
      ? { practice: 30, moduleExams: 50, finalExam: 20 }
      : { practice: 40, moduleExams: 60 },
    courseCompletion: {
      requireAllChapterActivities: true,
      requireExams: true,
      requireCourseGradePass: false,
    },
  };
}

// ── Validación ──────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

/** Claves exactas: faltantes → MISSING_FIELD, sobrantes → UNKNOWN_FIELD (un typo nunca se ignora en silencio). */
function checkKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  errors: ProfileValidationError[],
): void {
  const at = (k: string) => (path ? `${path}.${k}` : k);
  for (const k of required) {
    if (!(k in obj)) errors.push({ path: at(k), code: 'MISSING_FIELD', message: `Falta el campo "${at(k)}"` });
  }
  for (const k of Object.keys(obj)) {
    if (!required.includes(k) && !optional.includes(k)) {
      errors.push({ path: at(k), code: 'UNKNOWN_FIELD', message: `Campo desconocido "${at(k)}"` });
    }
  }
}

export function validatePresentationProfile(p: unknown): ProfileValidationError[] {
  const errors: ProfileValidationError[] = [];
  if (!isPlainObject(p)) {
    return [{ path: '', code: 'INVALID_TYPE', message: 'El perfil de presentación debe ser un objeto' }];
  }
  checkKeys(p, ['themeFamily', 'mode', 'brandSeed', 'themeVersion'], [], '', errors);

  if ('themeFamily' in p && !(THEME_FAMILY_IDS as readonly unknown[]).includes(p.themeFamily)) {
    errors.push({
      path: 'themeFamily',
      code: 'INVALID_THEME_FAMILY',
      message: `themeFamily inválido: ${JSON.stringify(p.themeFamily)} (permitidos: ${THEME_FAMILY_IDS.join(', ')})`,
    });
  }
  if ('mode' in p && !(THEME_MODES as readonly unknown[]).includes(p.mode)) {
    errors.push({
      path: 'mode',
      code: 'INVALID_THEME_MODE',
      message: `mode inválido: ${JSON.stringify(p.mode)} (permitidos: ${THEME_MODES.join(', ')})`,
    });
  }
  if ('themeVersion' in p && !(isInt(p.themeVersion) && p.themeVersion >= 1)) {
    errors.push({ path: 'themeVersion', code: 'INVALID_THEME_VERSION', message: 'themeVersion debe ser un entero ≥ 1' });
  }
  if ('brandSeed' in p && p.brandSeed !== null) {
    const seed = p.brandSeed;
    if (!isPlainObject(seed)) {
      errors.push({ path: 'brandSeed', code: 'INVALID_BRAND_SEED', message: 'brandSeed debe ser null o un objeto' });
    } else {
      checkKeys(seed, [], ['accent', 'moduleColors'], 'brandSeed', errors);
      if ('accent' in seed && !(typeof seed.accent === 'string' && HEX_RE.test(seed.accent))) {
        errors.push({ path: 'brandSeed.accent', code: 'INVALID_BRAND_SEED_COLOR', message: 'brandSeed.accent debe ser #RRGGBB' });
      }
      if ('moduleColors' in seed) {
        if (!Array.isArray(seed.moduleColors)) {
          errors.push({ path: 'brandSeed.moduleColors', code: 'INVALID_BRAND_SEED', message: 'brandSeed.moduleColors debe ser un array' });
        } else {
          seed.moduleColors.forEach((c, i) => {
            if (!(typeof c === 'string' && HEX_RE.test(c))) {
              errors.push({
                path: `brandSeed.moduleColors[${i}]`,
                code: 'INVALID_BRAND_SEED_COLOR',
                message: `brandSeed.moduleColors[${i}] debe ser #RRGGBB`,
              });
            }
          });
        }
      }
    }
  }
  return errors;
}

function checkTypeMap(
  p: Record<string, unknown>,
  field: 'overrides' | 'attempts' | 'gradeMethod',
  errors: ProfileValidationError[],
  checkValue: (v: unknown) => boolean,
  code: string,
  expectation: string,
): void {
  if (!(field in p)) return;
  const m = p[field];
  if (!isPlainObject(m)) {
    errors.push({ path: field, code: 'INVALID_TYPE', message: `${field} debe ser un objeto` });
    return;
  }
  checkKeys(m, ASSESSABLE_TYPES, [], field, errors);
  for (const t of ASSESSABLE_TYPES) {
    if (t in m && !checkValue(m[t])) {
      errors.push({ path: `${field}.${t}`, code, message: `${field}.${t} ${expectation} (fue ${JSON.stringify(m[t])})` });
    }
  }
}

/**
 * Valida un perfil de evaluación COMPLETO contra el `finalExam` vigente del
 * curso: los pesos deben tener exactamente las categorías que existen
 * (con final: practice/moduleExams/finalExam; sin final: practice/moduleExams)
 * y sumar 100.
 */
export function validateAssessmentProfile(p: unknown, ctx: { finalExam: boolean }): ProfileValidationError[] {
  const errors: ProfileValidationError[] = [];
  if (!isPlainObject(p)) {
    return [{ path: '', code: 'INVALID_TYPE', message: 'El perfil de evaluación debe ser un objeto' }];
  }
  checkKeys(
    p,
    ['assessmentProfileVersion', 'passingGrade', 'overrides', 'attempts', 'gradeMethod', 'categoryWeights', 'courseCompletion'],
    [],
    '',
    errors,
  );

  if ('assessmentProfileVersion' in p && p.assessmentProfileVersion !== ASSESSMENT_PROFILE_VERSION) {
    errors.push({
      path: 'assessmentProfileVersion',
      code: 'INVALID_PROFILE_VERSION',
      message: `assessmentProfileVersion debe ser ${ASSESSMENT_PROFILE_VERSION}`,
    });
  }
  if ('passingGrade' in p && !(isInt(p.passingGrade) && p.passingGrade >= 0 && p.passingGrade <= 100)) {
    errors.push({ path: 'passingGrade', code: 'INVALID_PASSING_GRADE', message: 'passingGrade debe ser un entero entre 0 y 100' });
  }
  checkTypeMap(p, 'overrides', errors, (v) => v === null || (isInt(v) && v >= 0 && v <= 100),
    'INVALID_OVERRIDE', 'debe ser null o un entero entre 0 y 100');
  checkTypeMap(p, 'attempts', errors, (v) => isInt(v) && v >= 0,
    'INVALID_ATTEMPTS', 'debe ser un entero ≥ 0 (0 = ilimitados)');
  checkTypeMap(p, 'gradeMethod', errors, (v) => (GRADE_METHODS as readonly unknown[]).includes(v),
    'INVALID_GRADE_METHOD', `debe ser uno de ${GRADE_METHODS.join(', ')}`);

  if ('categoryWeights' in p) {
    const w = p.categoryWeights;
    if (!isPlainObject(w)) {
      errors.push({ path: 'categoryWeights', code: 'INVALID_TYPE', message: 'categoryWeights debe ser un objeto' });
    } else {
      const expected = ctx.finalExam ? ['practice', 'moduleExams', 'finalExam'] : ['practice', 'moduleExams'];
      const keys = Object.keys(w).sort();
      if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) {
        errors.push({
          path: 'categoryWeights',
          code: 'WEIGHTS_FINAL_EXAM_MISMATCH',
          message: `categoryWeights debe tener exactamente [${expected.join(', ')}] ` +
            `(${ctx.finalExam ? 'el curso tiene' : 'el curso no tiene'} examen final); tiene [${keys.join(', ')}]`,
        });
      }
      let allValid = true;
      for (const k of Object.keys(w)) {
        if (!(isInt(w[k]) && (w[k] as number) >= 0 && (w[k] as number) <= 100)) {
          allValid = false;
          errors.push({ path: `categoryWeights.${k}`, code: 'INVALID_WEIGHT', message: `categoryWeights.${k} debe ser un entero entre 0 y 100` });
        }
      }
      if (allValid) {
        const sum = Object.values(w).reduce((a: number, b) => a + (b as number), 0);
        if (sum !== 100) {
          errors.push({ path: 'categoryWeights', code: 'WEIGHTS_SUM_NOT_100', message: `Los pesos suman ${sum}, deben sumar 100` });
        }
      }
    }
  }

  if ('courseCompletion' in p) {
    const cc = p.courseCompletion;
    const flags = ['requireAllChapterActivities', 'requireExams', 'requireCourseGradePass'];
    if (!isPlainObject(cc)) {
      errors.push({ path: 'courseCompletion', code: 'INVALID_TYPE', message: 'courseCompletion debe ser un objeto' });
    } else {
      checkKeys(cc, flags, [], 'courseCompletion', errors);
      for (const f of flags) {
        if (f in cc && typeof cc[f] !== 'boolean') {
          errors.push({ path: `courseCompletion.${f}`, code: 'INVALID_COMPLETION_FLAG', message: `courseCompletion.${f} debe ser boolean` });
        }
      }
    }
  }
  return errors;
}

export function validateProfile(kind: ProfileKind, p: unknown, ctx: { finalExam: boolean }): ProfileValidationError[] {
  return kind === 'presentation' ? validatePresentationProfile(p) : validateAssessmentProfile(p, ctx);
}

// ── Normalización (orden de claves fijo para mostrar) y sha ─────────────────

function describe(errors: ProfileValidationError[]): string {
  return errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join('; ');
}

/** Orden de claves fijo. Lanza `PROFILE_INVALID` si no valida (nunca "arregla" en silencio). */
export function normalizePresentationProfile(p: unknown): PresentationProfile {
  const errors = validatePresentationProfile(p);
  if (errors.length > 0) throw new Error(`PROFILE_INVALID: ${describe(errors)}`);
  const q = p as PresentationProfile;
  let brandSeed: BrandSeedInput | null = null;
  if (q.brandSeed) {
    brandSeed = {};
    if (q.brandSeed.accent !== undefined) brandSeed.accent = q.brandSeed.accent;
    if (q.brandSeed.moduleColors !== undefined) brandSeed.moduleColors = [...q.brandSeed.moduleColors];
  }
  return { themeFamily: q.themeFamily, mode: q.mode, brandSeed, themeVersion: q.themeVersion };
}

/**
 * Orden de claves fijo. El set de pesos se toma del propio documento (con o
 * sin finalExam), así un perfil guardado se puede releer aunque el curso haya
 * cambiado `finalExam` después; la coherencia con el curso actual la reporta
 * `validateAssessmentProfile` (ver `warnings` en el GET).
 */
export function normalizeAssessmentProfile(p: unknown): AssessmentProfile {
  const hasFinal = isPlainObject(p) && isPlainObject(p.categoryWeights) && 'finalExam' in p.categoryWeights;
  const errors = validateAssessmentProfile(p, { finalExam: hasFinal });
  if (errors.length > 0) throw new Error(`PROFILE_INVALID: ${describe(errors)}`);
  const q = p as AssessmentProfile;
  const map = <T>(m: Record<AssessableType, T>): Record<AssessableType, T> => ({
    activity: m.activity, video: m.video, exam: m.exam, finalExam: m.finalExam,
  });
  const w = q.categoryWeights as CategoryWeightsWithFinal;
  return {
    assessmentProfileVersion: q.assessmentProfileVersion,
    passingGrade: q.passingGrade,
    overrides: map(q.overrides),
    attempts: map(q.attempts),
    gradeMethod: map(q.gradeMethod),
    categoryWeights: hasFinal
      ? { practice: w.practice, moduleExams: w.moduleExams, finalExam: w.finalExam }
      : { practice: w.practice, moduleExams: w.moduleExams },
    courseCompletion: {
      requireAllChapterActivities: q.courseCompletion.requireAllChapterActivities,
      requireExams: q.courseCompletion.requireExams,
      requireCourseGradePass: q.courseCompletion.requireCourseGradePass,
    },
  };
}

export function normalizeProfile(kind: ProfileKind, p: unknown): PresentationProfile | AssessmentProfile {
  return kind === 'presentation' ? normalizePresentationProfile(p) : normalizeAssessmentProfile(p);
}

/** JSON canónico (claves ordenadas recursivamente): independiente del orden de claves de jsonb. */
export function canonicalProfileJson(p: PresentationProfile | AssessmentProfile): string {
  return sortedCanonicalJson(p);
}

/** sha256 hex del JSON canónico del perfil. */
export function profileSha256(p: PresentationProfile | AssessmentProfile): string {
  return sha256Canonical(p);
}
