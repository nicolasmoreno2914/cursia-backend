/**
 * R9 — Gamma V2 presentation. Barrel público. Ver:
 *  - artifact.ts            — contrato `presentation:<chapterUUID>` + validador
 *  - pdf-page-count.ts       — pdfPageCount (puro, sin adivinar)
 *  - png-dimensions.ts       — pngDimensions (puro, IHDR)
 *  - card-html.ts            — presentationCardHtml (CLEAN_SAFE + ENHANCED) + lint mínimo
 *  - theme-mapping.ts        — gammaThemeFor / themeMismatch
 *  - mock-provider.ts        — mockPresentationArtifactFromFixture (E2E, sin Gamma)
 *  - fixtures-loader.ts      — carga de las fixtures de los 9 capítulos V1
 *  - synthetic-fixtures.ts   — PDF/PNG sintéticos cuando el scratch no está
 */
export {
  PRESENTATION_ARTIFACT_SCHEMA_VERSION,
  type PresentationArtifact,
  type PresentationFileRef,
  type PresentationCoverRef,
  type PresentationValidationError,
  validatePresentationArtifact,
} from './artifact';

export { pdfPageCount, PdfPageCountUnknownError } from './pdf-page-count';
export { pngDimensions, PngDimensionsUnknownError, type PngDimensions } from './png-dimensions';

export {
  presentationCardHtml,
  lintCleanSafeMinimal,
  type PresentationCardInput,
} from './card-html';

export {
  gammaThemeFor,
  themeMismatch,
  buildGammaThemeMap,
  type GammaThemeMapKey,
  type ThemeMismatchResult,
} from './theme-mapping';

export {
  mockPresentationArtifactFromFixture,
  type MockPresentationArtifact,
  type MockPresentationResult,
} from './mock-provider';

export {
  loadV1ChapterBytes,
  locateAuditMbzDir,
  v1FixtureChapterNumbers,
  v1FixtureMeta,
  type V1ChapterBytes,
  type V1FixtureChapter,
  type V1FixtureFileMeta,
} from './fixtures-loader';

export { syntheticOnePagePdf, syntheticOnePxPng } from './synthetic-fixtures';
