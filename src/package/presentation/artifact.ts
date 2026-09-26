/**
 * R9 — contrato del artifact `presentation:<chapterUUID>` (Gamma V2).
 * Ver r9-core-gamma.md §1. `schemaVersion` fijo en 1 para esta primera versión.
 */
import type { ThemeFamilyId, ThemeMode } from '../../modules/theme-engine';

export const PRESENTATION_ARTIFACT_SCHEMA_VERSION = 1;

export interface PresentationFileRef {
  storagePath: string;
  sha256: string;
  bytes: number;
}

export interface PresentationCoverRef extends PresentationFileRef {
  width: number;
  height: number;
}

export interface PresentationArtifact {
  schemaVersion: 1;
  chapterId: string;
  /** null cuando el artifact viene de un mock/fixture (nunca se llamó a Gamma). */
  gammaGenerationId: string | null;
  pdf: PresentationFileRef;
  cover: PresentationCoverRef;
  slideCount: number;
  themeFamilyAtGeneration: ThemeFamilyId;
  /** Aditivo (fix round 1, I5): modo del tema con que se generó; opcional en artifacts previos. */
  themeModeAtGeneration?: ThemeMode;
  gammaThemeId: string;
  /** R-007 / M13: true si y solo si es un fixture (gammaGenerationId null). El empaque rechaza mocks en runs reales. */
  mock?: true;
  /** ISO 8601. */
  generatedAt: string;
}

export interface PresentationValidationError {
  code: string;
  message: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Fail loud: nunca degrada en silencio un artifact incompleto o corrupto
 * (ver CLAUDE.md "Trampas conocidas" — falla silenciosa es el bug más común
 * de este proyecto). Devuelve la lista de errores en vez de lanzar, siguiendo
 * el mismo patrón que `validateTheme` de R1 — el caller decide si aborta.
 */
export function validatePresentationArtifact(a: unknown): PresentationValidationError[] {
  const errors: PresentationValidationError[] = [];
  const push = (code: string, message: string) => errors.push({ code, message });

  if (a === null || typeof a !== 'object') {
    push('NOT_AN_OBJECT', 'el artifact no es un objeto');
    return errors;
  }
  const artifact = a as Partial<PresentationArtifact>;

  if (artifact.schemaVersion !== PRESENTATION_ARTIFACT_SCHEMA_VERSION) {
    push(
      'SCHEMA_VERSION',
      `schemaVersion debe ser ${PRESENTATION_ARTIFACT_SCHEMA_VERSION}, vino ${String(artifact.schemaVersion)}`,
    );
  }
  if (!isNonEmptyString(artifact.chapterId)) {
    push('CHAPTER_ID', 'falta chapterId');
  }
  if (
    artifact.gammaGenerationId !== null &&
    !isNonEmptyString(artifact.gammaGenerationId)
  ) {
    push('GAMMA_GENERATION_ID', 'gammaGenerationId debe ser string no vacío o null');
  }

  if (!artifact.pdf || typeof artifact.pdf !== 'object') {
    push('PDF_MISSING', 'falta el PDF de la presentación');
  } else {
    if (!isNonEmptyString(artifact.pdf.storagePath)) push('PDF_STORAGE_PATH', 'falta pdf.storagePath');
    if (!isNonEmptyString(artifact.pdf.sha256)) push('PDF_SHA256', 'falta pdf.sha256');
    if (!isPositiveInt(artifact.pdf.bytes)) push('PDF_BYTES', 'pdf.bytes debe ser un entero positivo');
  }

  if (!artifact.cover || typeof artifact.cover !== 'object') {
    push('COVER_MISSING', 'falta la portada de la presentación');
  } else {
    if (!isNonEmptyString(artifact.cover.storagePath)) push('COVER_STORAGE_PATH', 'falta cover.storagePath');
    if (!isNonEmptyString(artifact.cover.sha256)) push('COVER_SHA256', 'falta cover.sha256');
    if (!isPositiveInt(artifact.cover.bytes)) push('COVER_BYTES', 'cover.bytes debe ser un entero positivo');
    if (!isPositiveInt(artifact.cover.width)) push('COVER_WIDTH', 'cover.width debe ser un entero positivo');
    if (!isPositiveInt(artifact.cover.height)) push('COVER_HEIGHT', 'cover.height debe ser un entero positivo');
  }

  if (!isPositiveInt(artifact.slideCount)) {
    push('SLIDE_COUNT', 'slideCount debe ser un entero >= 1 (nunca se adivina)');
  }
  if (!isNonEmptyString(artifact.themeFamilyAtGeneration)) {
    push('THEME_FAMILY', 'falta themeFamilyAtGeneration');
  }
  if (artifact.themeModeAtGeneration !== undefined && artifact.themeModeAtGeneration !== 'light' && artifact.themeModeAtGeneration !== 'dark') {
    push('THEME_MODE', 'themeModeAtGeneration debe ser "light" o "dark"');
  }
  // M13: un artifact sin generación de Gamma es un mock y debe declararlo (y viceversa).
  const isMock = (artifact as { mock?: unknown }).mock === true;
  if (artifact.gammaGenerationId === null && !isMock) {
    push('MOCK_UNDECLARED', 'gammaGenerationId null exige mock: true (un fixture nunca se presenta como real)');
  }
  if (isMock && artifact.gammaGenerationId !== null) {
    push('MOCK_WITH_GENERATION', 'mock: true exige gammaGenerationId null');
  }
  if (!isNonEmptyString(artifact.gammaThemeId)) {
    push('GAMMA_THEME_ID', 'falta gammaThemeId');
  }
  if (!isNonEmptyString(artifact.generatedAt) || Number.isNaN(Date.parse(artifact.generatedAt as string))) {
    push('GENERATED_AT', 'generatedAt debe ser una fecha ISO 8601 válida');
  }

  return errors;
}
