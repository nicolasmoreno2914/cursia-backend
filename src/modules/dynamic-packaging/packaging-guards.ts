import { frozenProviderModesOf, providerKindOfArtifactType } from '../dynamic-generation/provider-modes';

/**
 * V2.1 — fix round 1 (review G2 I1/M11): guarda de empaque para salidas de
 * PROVEEDOR simuladas (Gamma/TTS). La llama el empaque v3 (R12) antes de
 * armar el paquete, sobre TODOS los artifacts resueltos del run.
 *
 * Regla: un artifact marcado como simulado (`metadata.mock === true` o
 * `metadata.fixture === true`) solo es empaquetable si el run está congelado
 * en `mock` para ESE proveedor (`input_payload.providerModes`). Un run no
 * congelado como mock (real, o sin modos) nunca empaqueta una fixture: falla
 * fuerte con MOCK_ARTIFACT_IN_REAL_RUN listando los artifacts. Un artifact
 * simulado de un tipo que no es de Gamma/TTS también falla (nadie debería
 * producirlo; el video tiene su propia regla MOCK_VIDEO_NOT_PACKAGEABLE).
 *
 * Pura: sin DB ni red.
 */
export const MOCK_ARTIFACT_IN_REAL_RUN = 'MOCK_ARTIFACT_IN_REAL_RUN';

export interface GuardRun {
  id?: string;
  input_payload?: any;
  inputPayload?: any;
}

export interface GuardArtifact {
  id: string;
  type: string;
  metadata?: Record<string, any> | null;
  itemKey?: string | null;
}

export class MockArtifactInRealRunError extends Error {
  readonly code = MOCK_ARTIFACT_IN_REAL_RUN;
  constructor(public readonly offending: string[], runId: string | undefined) {
    super(
      `${MOCK_ARTIFACT_IN_REAL_RUN}: el run ${runId ?? '?'} no está congelado como mock para estos artifacts simulados ` +
        `(${offending.join(', ')}); un paquete real nunca lleva salidas de proveedor falsas.`,
    );
    this.name = 'MockArtifactInRealRunError';
  }
}

export function isMockArtifact(a: Pick<GuardArtifact, 'metadata'>): boolean {
  const m = a?.metadata;
  return !!m && (m.mock === true || m.fixture === true);
}

/** Lanza MockArtifactInRealRunError si algún artifact simulado no está permitido por los modos congelados del run. */
export function assertNoMockArtifactsForRealPackage(run: GuardRun, artifacts: readonly GuardArtifact[]): void {
  const modes = frozenProviderModesOf(run?.input_payload ?? run?.inputPayload);
  const offending: string[] = [];
  for (const a of artifacts ?? []) {
    if (!isMockArtifact(a)) continue;
    const kind = providerKindOfArtifactType(a.type);
    if (!kind || !modes || modes[kind] !== 'mock') offending.push(`${a.itemKey ?? '?'}:${a.type}:${a.id}`);
  }
  if (offending.length > 0) throw new MockArtifactInRealRunError(offending.sort(), run?.id);
}
