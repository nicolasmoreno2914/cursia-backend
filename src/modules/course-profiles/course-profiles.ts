import { sha256Canonical, sortedCanonicalJson } from '../coherence/canonical-json';
import { LEGACY_PALETTES, THEME_FAMILIES, presentationProfileFromPalette, resolveTheme } from '../theme-engine';
import {
  PedagogicalProfile,
  normalizePedagogicalProfile,
  pedagogicalProfileSha256,
  validatePedagogicalProfile,
} from '../pedagogy/pedagogy-profile';
import { AcademicContextV1, normalizeAcademicContext, validateAcademicContextShape } from '../academic-context/academic-context';
import {
  ApplicationDeliveryProfile,
  PracticeResourceSpec,
  deliveryNeedsOwnCategory,
  normalizeApplicationDelivery,
  normalizePracticeResources,
  validateApplicationDelivery,
  validatePracticeResources,
} from './application-delivery';

/**
 * Cursia V2.1 — R3: perfiles de curso (audit §M.2, §K.2). Lógica PURA: sin
 * DB, sin reloj, sin aleatoriedad.
 *
 * Los perfiles de presentación y evaluación NO entran en el Blueprint, en el
 * Manifest ni en ninguna huella de invalidación: no cambian QUÉ se genera, solo
 * cómo se empaqueta (y el tema Gamma). Se guardan versionados (append-only) en
 * `course_profiles`.
 *
 * Motor pedagógico V1: `pedagogy` es la excepción deliberada — el perfil
 * pedagógico SÍ cambia el diseño: el lock del Blueprint v2 lo convierte en
 * reglas y congela el diseño resultante (src/modules/pedagogy). Su forma y su
 * validación viven en pedagogy-profile.ts.
 *
 * Fase 3: `academic` (contexto académico del curso: microcurrículo estructurado) también cambia el diseño — sus
 * resultados de aprendizaje se congelan en el Blueprint v2 (course.academicContext). Forma y validación en
 * src/modules/academic-context.
 */

export type ProfileKind = 'presentation' | 'assessment' | 'pedagogy' | 'academic';
export const PROFILE_KINDS: readonly ProfileKind[] = ['presentation', 'assessment', 'pedagogy', 'academic'];

export function isProfileKind(v: unknown): v is ProfileKind {
  return v === 'presentation' || v === 'assessment' || v === 'pedagogy' || v === 'academic';
}

export type AnyCourseProfile = PresentationProfile | AssessmentProfile | PedagogicalProfile | AcademicContextV1;

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

/**
 * r76 «Diseño visual»: tipografía del curso. Ausente (o 'family') = la de la familia visual. Solo pilas de fuentes del
 * sistema (Moodle no carga webfonts de un label de forma fiable).
 */
export const PRESENTATION_TYPOGRAPHY = ['family', 'sans', 'serif'] as const;
export type PresentationTypography = (typeof PRESENTATION_TYPOGRAPHY)[number];

/** r76: de dónde sale el logo del curso (Libro Guía y, si se pide, la bienvenida). */
export const PRESENTATION_LOGO_SOURCES = ['account', 'custom', 'cursia'] as const;
export type PresentationLogoSource = (typeof PRESENTATION_LOGO_SOURCES)[number];
/** r76: tope del logo propio del curso (data URI; el frontend lo reduce a ≤ 512 px antes de subirlo). */
export const PRESENTATION_LOGO_MAX_CHARS = 1_400_000;
export const PRESENTATION_INSTITUTION_NAME_MAX = 120;

/**
 * r76: identidad institucional del curso.
 *  - logo: 'account' = Brand Kit de la institución → logo de la cuenta → Cursia (lo de siempre); 'custom' = el logo
 *    subido para ESTE curso (`logoDataUri`, PNG/JPEG); 'cursia' = el logo de Cursia.
 *  - institutionName: null/ausente = el nombre de la institución del curso; '' = sin nombre; texto = ese nombre.
 *  - watermark: marca de agua del Libro Guía (una por página, decisión r19). Default true.
 *  - showInCourse: el logo (y el nombre) encabezan la bienvenida del curso en Moodle. Default false.
 * El default completo ({ logo: 'account', watermark: true, showInCourse: false }, sin nombre) se normaliza a AUSENTE:
 * un perfil anterior a r76 o «Restaurar valores» conserva el mismo sha (y los mismos bytes del paquete).
 */
export interface PresentationIdentity {
  logo: PresentationLogoSource;
  logoDataUri?: string;
  institutionName?: string | null;
  watermark: boolean;
  showInCourse: boolean;
}

export interface PresentationProfile {
  themeFamily: ThemeFamilyIdCopy;
  mode: ThemeModeCopy;
  brandSeed: BrandSeedInput | null;
  themeVersion: number;
  /** r76: solo presente si no es la de la familia. */
  typography?: 'sans' | 'serif';
  /** r76: solo presente si no es el default (ver PresentationIdentity). */
  identity?: PresentationIdentity;
}

/** r76: identidad efectiva (la guardada o el default). */
export function presentationIdentityOf(p: Pick<PresentationProfile, 'identity'> | null | undefined): PresentationIdentity {
  const i = p?.identity;
  return i
    ? { logo: i.logo, ...(i.logoDataUri ? { logoDataUri: i.logoDataUri } : {}), ...(i.institutionName !== undefined ? { institutionName: i.institutionName } : {}), watermark: i.watermark, showInCourse: i.showInCourse }
    : { logo: 'account', watermark: true, showInCourse: false };
}

export function defaultPresentationProfile(): PresentationProfile {
  return { themeFamily: 'aula-clara', mode: 'light', brandSeed: null, themeVersion: 1 };
}

/**
 * V542 (G2, decisión EV6 n.º 3) — un curso NUEVO sin perfil guardado arranca en Aula Clara (claro); la
 * paleta solo aporta los colores de marca (`brandSeed`). Los cursos ANTERIORES conservan el tema que
 * siempre derivaron de su paleta (claro → aula-clara/light, el resto → oscuro-premium/dark): su paquete
 * y sus presentaciones de Gamma ya dependen de él.
 *
 * Marca: `courses.created_at` (timestamptz NOT NULL default now(), inmutable). Se eligió sobre una
 * marca en `courses.metadata` porque PATCH /courses reemplaza `metadata` entero (CoursesService.update:
 * Object.assign) y la marca se perdería; tampoco sirve «tiene runs/paquetes» porque el primer run de un
 * curso nuevo ya existe cuando Gamma pide el tema.
 * V542 fix round 1 (I3): falla CERRADO. Solo con `PRESENTATION_LIGHT_DEFAULT_SINCE` (ISO válido) puesto
 * en el entorno; sin la variable (o inválida) el default claro está APAGADO y todo curso conserva el tema
 * derivado de su paleta. El deploy de staging la fija en el instante de su deploy (2026-10-02T12:00:00Z).
 */
export const PRESENTATION_LIGHT_DEFAULT_SINCE_ENV = 'PRESENTATION_LIGHT_DEFAULT_SINCE';
/** Corte del default claro, o null (apagado) si la variable falta o no es una fecha ISO válida. */
export function presentationLightDefaultSince(env: NodeJS.ProcessEnv = process.env): Date | null {
  const raw = String(env[PRESENTATION_LIGHT_DEFAULT_SINCE_ENV] ?? '').trim();
  if (!raw || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}
/** ¿El curso (por su `created_at`) arranca en Aula Clara sin perfil guardado? Apagado o sin fecha legible → no (conserva). */
export function isLightDefaultCourse(createdAt: Date | string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const since = presentationLightDefaultSince(env);
  if (!since || createdAt === null || createdAt === undefined || createdAt === '') return false;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return Number.isFinite(d.getTime()) && d.getTime() >= since.getTime();
}

/** F1 (I4): de dónde sale el perfil de presentación por defecto de un curso sin perfil guardado. */
export type PresentationDefaultSource = 'palette' | 'fallback';

/**
 * F1 (I4): perfil de presentación por defecto de un curso sin perfil guardado.
 * - Con una paleta legacy conocida → derivado de ella
 *   (`presentationProfileFromPalette`: claro → aula-clara/light, el resto →
 *   oscuro-premium/dark; brandSeed de la paleta), `source: 'palette'`.
 *   V542 (G2): con `opts.lightDefault` (curso nuevo, `isLightDefaultCourse`) el tema es SIEMPRE
 *   aula-clara/light y la paleta aporta solo el brandSeed (`source: 'palette'` igual).
 * - Sin paleta → aula-clara/light, `source: 'fallback'`.
 * - Paleta desconocida → aula-clara/light, `source: 'fallback'` + aviso
 *   `PALETTE_UNKNOWN` (esto es solo la LECTURA del default; el empaque falla
 *   fuerte con una paleta guardada desconocida).
 * Pura: nunca persiste nada.
 */
export function defaultPresentationProfileFor(paletteId: string | null | undefined, opts: { lightDefault?: boolean } = {}): {
  profile: PresentationProfile;
  source: PresentationDefaultSource;
  warnings: ProfileValidationError[];
} {
  const id = typeof paletteId === 'string' ? paletteId.trim() : '';
  if (!id) return { profile: defaultPresentationProfile(), source: 'fallback', warnings: [] };
  const found = LEGACY_PALETTES.find((x) => x.id === id);
  if (!found) {
    return {
      profile: defaultPresentationProfile(),
      source: 'fallback',
      warnings: [{ path: 'paletteId', code: 'PALETTE_UNKNOWN', message: `Paleta desconocida "${id}": se usa el diseño por defecto (Aula Clara, claro)` }],
    };
  }
  const d = presentationProfileFromPalette(found);
  const seed: BrandSeedInput = {};
  if (d.brandSeed.accent) seed.accent = d.brandSeed.accent;
  if (d.brandSeed.moduleColors) seed.moduleColors = [...d.brandSeed.moduleColors];
  const base = opts.lightDefault ? defaultPresentationProfile() : { themeFamily: d.themeFamily, mode: d.mode, themeVersion: d.themeVersion };
  return {
    profile: {
      themeFamily: base.themeFamily,
      mode: base.mode,
      brandSeed: Object.keys(seed).length ? seed : null,
      themeVersion: base.themeVersion,
    },
    source: 'palette',
    warnings: [],
  };
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
/**
 * T4 (r57): con `applicationDelivery.grading` calificada en categoría propia, los pesos traen además `applications`
 * («Actividades de Aplicación»). Sin esa entrega, la clave no existe (perfiles de siempre).
 */
export type CategoryWeights = (CategoryWeightsWithFinal | CategoryWeightsWithoutFinal) & { applications?: number };

export interface AssessmentProfile {
  assessmentProfileVersion: number;
  passingGrade: number;
  overrides: Record<AssessableType, number | null>;
  attempts: Record<AssessableType, number>;
  gradeMethod: Record<AssessableType, GradeMethod>;
  categoryWeights: CategoryWeights;
  courseCompletion: {
    requireAllChapterActivities: boolean;
    requireExams: boolean;
    requireCourseGradePass: boolean;
  };
  /**
   * T4 (r57): entrega de las Actividades de Aplicación (página de siempre o Tarea de Moodle). Ausente = página: el
   * perfil, su sha y el paquete son los de siempre.
   */
  applicationDelivery?: ApplicationDeliveryProfile;
  /** T5 (r57): archivos de trabajo por capítulo (mod_resource; la AA los enlaza). Ausente/vacío = ninguno. */
  practiceResources?: PracticeResourceSpec[];
  /**
   * T6 (r57): «Guía del docente» del curso — página oculta solo para docentes (sección 0), armada sin IA desde lo ya
   * generado (objetivos, tipo de aprendizaje y fases, actividades, criterios, solucionarios, archivos, evaluación,
   * horas). Ausente o `include: false` = paquete de siempre.
   */
  teacherGuide?: TeacherGuideProfile;
}

/** T6 (r57): opción de la Guía del docente. */
export interface TeacherGuideProfile {
  include: boolean;
}

/** T6 (r57): valida `teacherGuide` ({ include: boolean }, sin otros campos). */
export function validateTeacherGuide(v: unknown): ProfileValidationError[] {
  if (!isPlainObject(v)) return [{ path: 'teacherGuide', code: 'INVALID_TEACHER_GUIDE', message: 'teacherGuide debe ser un objeto { include: boolean }' }];
  const errors: ProfileValidationError[] = [];
  checkKeys(v, ['include'], [], 'teacherGuide', errors);
  if ('include' in v && typeof v.include !== 'boolean') errors.push({ path: 'teacherGuide.include', code: 'INVALID_TEACHER_GUIDE', message: 'teacherGuide.include debe ser true o false' });
  return errors;
}

/** T6 (r57): ¿el perfil pide la Guía del docente? */
export function teacherGuideEnabled(p: { teacherGuide?: TeacherGuideProfile } | null | undefined): boolean {
  return p?.teacherGuide?.include === true;
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
    // r55 (R3): estas banderas ya no deciden la completion del curso (el resolver fuerza el criterio de nota
    // final y ningún criterio de actividad); se conservan en el esquema para leer perfiles guardados. El default
    // refleja la regla real (nota del curso obligatoria).
    courseCompletion: {
      requireAllChapterActivities: true,
      requireExams: true,
      requireCourseGradePass: true,
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
  checkKeys(p, ['themeFamily', 'mode', 'brandSeed', 'themeVersion'], ['typography', 'identity'], '', errors);
  // r76: tipografía e identidad (opcionales).
  if ('typography' in p && !(PRESENTATION_TYPOGRAPHY as readonly unknown[]).includes(p.typography)) {
    errors.push({ path: 'typography', code: 'INVALID_TYPOGRAPHY', message: `typography inválida: ${JSON.stringify(p.typography)} (permitidas: ${PRESENTATION_TYPOGRAPHY.join(', ')})` });
  }
  if ('identity' in p && p.identity !== null) validatePresentationIdentity(p.identity, errors);

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
  // F1: la familia define qué modos existen (Theme Engine R1); un modo que la
  // familia no soporta se rechaza al guardar, no recién al empaquetar.
  if (
    (THEME_FAMILY_IDS as readonly unknown[]).includes(p.themeFamily) &&
    (THEME_MODES as readonly unknown[]).includes(p.mode) &&
    !(THEME_FAMILIES[p.themeFamily as ThemeFamilyIdCopy].supportedModes as readonly unknown[]).includes(p.mode)
  ) {
    errors.push({
      path: 'mode',
      code: 'THEME_MODE_NOT_SUPPORTED',
      message: `La familia ${String(p.themeFamily)} no admite el modo ${String(p.mode)} (admite: ${THEME_FAMILIES[p.themeFamily as ThemeFamilyIdCopy].supportedModes.join(', ')})`,
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
  // r76: el tema tiene que poder resolverse YA (al guardar), no recién al empaquetar (falla fuerte y visible).
  if (errors.length === 0 && isPlainObject(p)) {
    try {
      const seed = p.brandSeed as BrandSeedInput | null;
      resolveTheme({
        themeFamily: p.themeFamily as ThemeFamilyIdCopy,
        mode: p.mode as ThemeModeCopy,
        ...(seed ? { brandSeed: { ...seed } } : {}),
        // themeVersion se valida arriba (esquema); aquí solo importan familia, modo, colores y tipografía.
        ...(p.typography === 'sans' || p.typography === 'serif' ? { typography: p.typography } : {}),
      });
    } catch (err) {
      errors.push({ path: 'brandSeed', code: 'THEME_UNRESOLVABLE', message: `Con estos colores el diseño no se puede armar: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return errors;
}

/** r76: data URI de imagen PNG o JPEG en base64 (la validación de bytes la hace libro-logo al empaquetar y en la vista previa). */
const LOGO_DATA_URI_RE = /^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/]+={0,2}$/;

function validatePresentationIdentity(v: unknown, errors: ProfileValidationError[]): void {
  if (!isPlainObject(v)) {
    errors.push({ path: 'identity', code: 'INVALID_IDENTITY', message: 'identity debe ser null o un objeto' });
    return;
  }
  checkKeys(v, ['logo', 'watermark', 'showInCourse'], ['logoDataUri', 'institutionName'], 'identity', errors);
  if ('logo' in v && !(PRESENTATION_LOGO_SOURCES as readonly unknown[]).includes(v.logo)) {
    errors.push({ path: 'identity.logo', code: 'INVALID_IDENTITY_LOGO', message: `identity.logo inválido: ${JSON.stringify(v.logo)} (permitidos: ${PRESENTATION_LOGO_SOURCES.join(', ')})` });
  }
  if (v.logo === 'custom' && !('logoDataUri' in v)) {
    errors.push({ path: 'identity.logoDataUri', code: 'MISSING_FIELD', message: 'Con identity.logo = "custom" falta identity.logoDataUri (el logo del curso)' });
  }
  if ('logoDataUri' in v) {
    if (v.logo !== 'custom') {
      errors.push({ path: 'identity.logoDataUri', code: 'INVALID_IDENTITY_LOGO', message: 'identity.logoDataUri solo se admite con identity.logo = "custom"' });
    } else if (typeof v.logoDataUri !== 'string' || !LOGO_DATA_URI_RE.test(v.logoDataUri)) {
      errors.push({ path: 'identity.logoDataUri', code: 'INVALID_IDENTITY_LOGO', message: 'El logo del curso debe ser una imagen PNG o JPEG (data URI base64)' });
    } else if (v.logoDataUri.length > PRESENTATION_LOGO_MAX_CHARS) {
      errors.push({ path: 'identity.logoDataUri', code: 'IDENTITY_LOGO_TOO_LARGE', message: `El logo del curso es demasiado grande (máximo ${Math.round((PRESENTATION_LOGO_MAX_CHARS * 3) / 4 / 1024)} KB)` });
    }
  }
  if ('institutionName' in v && v.institutionName !== null) {
    if (typeof v.institutionName !== 'string' || v.institutionName.length > PRESENTATION_INSTITUTION_NAME_MAX || /[<>\u0000-\u001f]/.test(v.institutionName)) {
      errors.push({ path: 'identity.institutionName', code: 'INVALID_IDENTITY_NAME', message: `identity.institutionName debe ser null o un texto de hasta ${PRESENTATION_INSTITUTION_NAME_MAX} caracteres, sin < ni >` });
    }
  }
  if ('watermark' in v && typeof v.watermark !== 'boolean') errors.push({ path: 'identity.watermark', code: 'INVALID_TYPE', message: 'identity.watermark debe ser booleano' });
  if ('showInCourse' in v && typeof v.showInCourse !== 'boolean') errors.push({ path: 'identity.showInCourse', code: 'INVALID_TYPE', message: 'identity.showInCourse debe ser booleano' });
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
export function validateAssessmentProfile(
  p: unknown,
  ctx: { finalExam: boolean; allowLegacyZeroPassingGrade?: boolean },
): ProfileValidationError[] {
  const errors: ProfileValidationError[] = [];
  if (!isPlainObject(p)) {
    return [{ path: '', code: 'INVALID_TYPE', message: 'El perfil de evaluación debe ser un objeto' }];
  }
  checkKeys(
    p,
    ['assessmentProfileVersion', 'passingGrade', 'overrides', 'attempts', 'gradeMethod', 'categoryWeights', 'courseCompletion'],
    ['applicationDelivery', 'practiceResources', 'teacherGuide'],
    '',
    errors,
  );
  // T4/T5 (r57): claves opcionales (ausentes = perfil de siempre).
  if ('teacherGuide' in p) errors.push(...validateTeacherGuide(p.teacherGuide));
  if ('applicationDelivery' in p) errors.push(...validateApplicationDelivery(p.applicationDelivery));
  if ('practiceResources' in p) errors.push(...validatePracticeResources(p.practiceResources));
  const ownCategory = 'applicationDelivery' in p && validateApplicationDelivery(p.applicationDelivery).length === 0 && deliveryNeedsOwnCategory(p.applicationDelivery as ApplicationDeliveryProfile);

  if ('assessmentProfileVersion' in p && p.assessmentProfileVersion !== ASSESSMENT_PROFILE_VERSION) {
    errors.push({
      path: 'assessmentProfileVersion',
      code: 'INVALID_PROFILE_VERSION',
      message: `assessmentProfileVersion debe ser ${ASSESSMENT_PROFILE_VERSION}`,
    });
  }
  // r55 review r1 (I1): la nota mínima DEL CURSO va de 1 a 100. Con 0 el criterio único «Calificación del curso»
  // lo cumpliría cualquiera (el resolver lo rechaza con ASSESSMENT_UNENFORCEABLE, que queda como defensa).
  // Solo la LECTURA de un perfil viejo ya guardado con 0 lo tolera (allowLegacyZeroPassingGrade) para que el panel
  // lo muestre y se pueda corregir; guardar, el gate de startRun y el empaque lo rechazan.
  const minPassing = ctx.allowLegacyZeroPassingGrade ? 0 : 1;
  if ('passingGrade' in p && !(isInt(p.passingGrade) && p.passingGrade >= minPassing && p.passingGrade <= 100)) {
    errors.push({ path: 'passingGrade', code: 'INVALID_PASSING_GRADE', message: 'passingGrade debe ser un entero entre 1 y 100' });
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
      const expected = [...(ctx.finalExam ? ['practice', 'moduleExams', 'finalExam'] : ['practice', 'moduleExams']), ...(ownCategory ? ['applications'] : [])];
      const keys = Object.keys(w).sort();
      if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) {
        errors.push({
          path: 'categoryWeights',
          code: 'WEIGHTS_FINAL_EXAM_MISMATCH',
          message: `categoryWeights debe tener exactamente [${expected.join(', ')}] ` +
            `(${ctx.finalExam ? 'el curso tiene' : 'el curso no tiene'} examen final${ownCategory ? '; las Actividades de Aplicación califican en su propia categoría' : ''}); tiene [${keys.join(', ')}]`,
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
  if (kind === 'pedagogy') return validatePedagogicalProfile(p);
  if (kind === 'academic') return validateAcademicContextShape(p);
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
  // r76: solo si no son los de siempre (mismo objeto y mismo sha para los perfiles anteriores y para «Restaurar valores»).
  const typography = q.typography === 'sans' || q.typography === 'serif' ? { typography: q.typography } : {};
  let identity: { identity: PresentationIdentity } | Record<string, never> = {};
  if (q.identity) {
    const i = q.identity;
    const name = typeof i.institutionName === 'string' ? i.institutionName.replace(/\s+/g, ' ').trim() : i.institutionName;
    const norm: PresentationIdentity = {
      logo: i.logo,
      ...(i.logo === 'custom' && i.logoDataUri ? { logoDataUri: i.logoDataUri.replace(/^data:image\/jpg;/, 'data:image/jpeg;') } : {}),
      ...(name !== undefined && name !== null ? { institutionName: name } : {}),
      watermark: i.watermark,
      showInCourse: i.showInCourse,
    };
    const isDefault = norm.logo === 'account' && norm.watermark === true && norm.showInCourse === false && norm.institutionName === undefined;
    if (!isDefault) identity = { identity: norm };
  }
  return { themeFamily: q.themeFamily, mode: q.mode, brandSeed, themeVersion: q.themeVersion, ...typography, ...identity };
}

/**
 * Orden de claves fijo. El set de pesos se toma del propio documento (con o
 * sin finalExam), así un perfil guardado se puede releer aunque el curso haya
 * cambiado `finalExam` después; la coherencia con el curso actual la reporta
 * `validateAssessmentProfile` (ver `warnings` en el GET).
 */
export function normalizeAssessmentProfile(
  p: unknown,
  opts: { allowLegacyZeroPassingGrade?: boolean } = {},
): AssessmentProfile {
  const hasFinal = isPlainObject(p) && isPlainObject(p.categoryWeights) && 'finalExam' in p.categoryWeights;
  const errors = validateAssessmentProfile(p, { finalExam: hasFinal, allowLegacyZeroPassingGrade: opts.allowLegacyZeroPassingGrade === true });
  if (errors.length > 0) throw new Error(`PROFILE_INVALID: ${describe(errors)}`);
  const q = p as AssessmentProfile;
  const map = <T>(m: Record<AssessableType, T>): Record<AssessableType, T> => ({
    activity: m.activity, video: m.video, exam: m.exam, finalExam: m.finalExam,
  });
  const w = q.categoryWeights as CategoryWeightsWithFinal & { applications?: number };
  const apps = w.applications !== undefined ? { applications: w.applications } : {};
  return {
    assessmentProfileVersion: q.assessmentProfileVersion,
    passingGrade: q.passingGrade,
    overrides: map(q.overrides),
    attempts: map(q.attempts),
    gradeMethod: map(q.gradeMethod),
    categoryWeights: hasFinal
      ? { practice: w.practice, moduleExams: w.moduleExams, finalExam: w.finalExam, ...apps }
      : { practice: w.practice, moduleExams: w.moduleExams, ...apps },
    courseCompletion: {
      requireAllChapterActivities: q.courseCompletion.requireAllChapterActivities,
      requireExams: q.courseCompletion.requireExams,
      requireCourseGradePass: q.courseCompletion.requireCourseGradePass,
    },
    // T4/T5 (r57): solo si el perfil las trae (sin ellas, el mismo objeto y el mismo sha de siempre).
    ...(q.applicationDelivery ? { applicationDelivery: normalizeApplicationDelivery(q.applicationDelivery) } : {}),
    ...(q.practiceResources && q.practiceResources.length ? { practiceResources: normalizePracticeResources(q.practiceResources) } : {}),
    // T6 (r57): solo si el perfil la ENCIENDE. Review r1 (M4): `{ include: false }` ≡ ausente (mismo objeto, mismo sha:
    // apagarla no re-empaqueta un curso que nunca la tuvo).
    ...(q.teacherGuide?.include === true ? { teacherGuide: { include: true } } : {}),
  };
}

export function normalizeProfile(kind: 'presentation', p: unknown): PresentationProfile;
export function normalizeProfile(kind: 'assessment', p: unknown): AssessmentProfile;
export function normalizeProfile(kind: 'pedagogy', p: unknown): PedagogicalProfile;
export function normalizeProfile(kind: 'academic', p: unknown): AcademicContextV1;
export function normalizeProfile(kind: ProfileKind, p: unknown): AnyCourseProfile;
export function normalizeProfile(kind: ProfileKind, p: unknown): AnyCourseProfile {
  if (kind === 'pedagogy') return normalizePedagogicalProfile(p);
  if (kind === 'academic') return normalizeAcademicContext(p);
  return kind === 'presentation' ? normalizePresentationProfile(p) : normalizeAssessmentProfile(p);
}

/** JSON canónico (claves ordenadas recursivamente): independiente del orden de claves de jsonb. */
export function canonicalProfileJson(p: AnyCourseProfile): string {
  return sortedCanonicalJson(p);
}

/**
 * sha256 hex del JSON canónico del perfil. El perfil pedagógico se hashea sin
 * `designRules` (registro derivado que guarda el servidor): mismo perfil ⇒ mismo sha.
 */
export function profileSha256(p: AnyCourseProfile): string {
  if (isPedagogicalProfileShape(p)) return pedagogicalProfileSha256(p);
  return sha256Canonical(p);
}

function isPedagogicalProfileShape(p: unknown): p is PedagogicalProfile {
  return !!p && typeof p === 'object' && 'pedagogyProfileVersion' in (p as Record<string, unknown>);
}
