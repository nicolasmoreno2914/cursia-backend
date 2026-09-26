import type { ManifestRulesVersion } from './generation-manifest-builder';

/**
 * rulesVersion que crea `POST …/manifest` (y que leen los endpoints "del
 * Manifest actual" de un Blueprint). Spec v2 §3: sale de config
 * `DYNAMIC_MANIFEST_RULES_VERSION` ∈ {1, 2}, default 1 hasta que v2 esté
 * completo y validado.
 *
 * Fail-fast: cualquier otro valor (incluido "v2", " 2 ", "4") lanza — nunca
 * se cae en silencio a otra versión. GenerationManifestsService lo lee en cada
 * uso (lanza ahí) y, en el constructor, solo lo loguea como error: un valor
 * inválido nunca aborta el boot de la API legacy ni de los workers (I4
 * review-rv2).
 *
 * V2.1 (R3): "3" es un valor válido de config (el lock crea Blueprints
 * schemaVersion 2), pero crear/leer Manifests con "3" lanza
 * NOT_IMPLEMENTED_RULES_V3 hasta R4. El default sigue siendo 1.
 */
export const MANIFEST_RULES_VERSION_ENV = 'DYNAMIC_MANIFEST_RULES_VERSION';

/** Valores que acepta la config. 3 = V2.1 (Blueprint schemaVersion 2); su builder de Manifest es R4. */
export type ConfiguredRulesVersion = 1 | 2 | 3;

export const NOT_IMPLEMENTED_RULES_V3 = 'NOT_IMPLEMENTED_RULES_V3';

/**
 * Lee la config cruda: ausente/"" → 1; "1" | "2" | "3" → ese número;
 * cualquier otra cosa lanza (sin fallback). Lo usa el lock del Blueprint
 * para decidir el schemaVersion del snapshot (3 → v2, resto → v1).
 */
export function readConfiguredRulesVersion(env: NodeJS.ProcessEnv = process.env): ConfiguredRulesVersion {
  const raw = env[MANIFEST_RULES_VERSION_ENV];
  if (raw === undefined || raw === '') return 1;
  if (raw === '1') return 1;
  if (raw === '2') return 2;
  if (raw === '3') return 3;
  throw new Error(
    `${MANIFEST_RULES_VERSION_ENV} inválido: ${JSON.stringify(raw)} (valores permitidos: "1", "2" o "3"; ausente = 1)`,
  );
}

/** schemaVersion del Blueprint que crea el lock para una config dada: v2 SOLO con rulesVersion 3. */
export function blueprintSchemaVersionForRules(rules: ConfiguredRulesVersion): 1 | 2 {
  return rules === 3 ? 2 : 1;
}

/**
 * rulesVersion para CREAR/LEER Manifests (builder v1/v2). Con "3" lanza
 * `NOT_IMPLEMENTED_RULES_V3` hasta que R4 implemente el builder v3: nunca se
 * cae en silencio a v1/v2 con un Blueprint v2.
 */
export function readManifestRulesVersionConfig(env: NodeJS.ProcessEnv = process.env): ManifestRulesVersion {
  const rules = readConfiguredRulesVersion(env);
  if (rules === 3) {
    throw new Error(
      `${NOT_IMPLEMENTED_RULES_V3}: ${MANIFEST_RULES_VERSION_ENV}=3 (V2.1) todavía no tiene builder de Generation ` +
        'Manifest (bloque R4). El lock de Blueprints ya produce snapshots schemaVersion 2 con esta config.',
    );
  }
  return rules;
}
