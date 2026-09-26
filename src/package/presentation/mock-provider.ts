/**
 * R9 — mock provider para E2E: produce un `PresentationArtifact` válido SIN
 * llamar nunca a Gamma. Usado más adelante por el worker de presentación en
 * modo mock (fuera de alcance de este brief — ver r9-core-gamma.md).
 */
import { createHash } from 'crypto';
import { pdfPageCount } from './pdf-page-count';
import { pngDimensions } from './png-dimensions';
import { loadV1ChapterBytes } from './fixtures-loader';
import { PRESENTATION_ARTIFACT_SCHEMA_VERSION, type PresentationArtifact } from './artifact';
import type { ThemeFamilyId } from '../../modules/theme-engine';

export type MockPresentationArtifact = PresentationArtifact & { mock: true };

export interface MockPresentationResult {
  artifact: MockPresentationArtifact;
  pdfBytes: Buffer;
  coverBytes: Buffer;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * `fixtureIndex` selecciona cuál de los 9 capítulos de V1 usar como base
 * (1..9); fuera de ese rango, o si el scratch no tiene los blobs reales,
 * cae a las fixtures sintéticas — nunca falla por eso.
 */
export function mockPresentationArtifactFromFixture(
  chapterId: string,
  fixtureIndex: number,
  opts?: { themeFamily?: ThemeFamilyId; gammaThemeId?: string; generatedAt?: string },
): MockPresentationResult {
  const { pdfBytes, coverBytes } = loadV1ChapterBytes(fixtureIndex);

  const slideCount = pdfPageCount(pdfBytes);
  const { width, height } = pngDimensions(coverBytes);

  const themeFamilyAtGeneration: ThemeFamilyId = opts?.themeFamily ?? 'aula-clara';
  const gammaThemeId = opts?.gammaThemeId ?? 'mock-theme';
  const generatedAt = opts?.generatedAt ?? new Date(0).toISOString();

  const artifact: MockPresentationArtifact = {
    schemaVersion: PRESENTATION_ARTIFACT_SCHEMA_VERSION,
    chapterId,
    gammaGenerationId: null,
    pdf: {
      storagePath: `mock/presentation/${chapterId}/cap${fixtureIndex}_presentacion.pdf`,
      sha256: sha256Hex(pdfBytes),
      bytes: pdfBytes.length,
    },
    cover: {
      storagePath: `mock/presentation/${chapterId}/cap${fixtureIndex}_portada.png`,
      sha256: sha256Hex(coverBytes),
      bytes: coverBytes.length,
      width,
      height,
    },
    slideCount,
    themeFamilyAtGeneration,
    gammaThemeId,
    generatedAt,
    mock: true,
  };

  return { artifact, pdfBytes, coverBytes };
}
