import type { ManifestRulesVersion } from './generation-manifest-builder';
import type { ActivityTypeRulesVersion } from './activity-type-rules';

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
 * V2.1: "3" crea Manifests rulesVersion 3 (R4) sobre Blueprints schemaVersion
 * 2 (el lock los crea con esta misma config, R3). El default sigue siendo 1.
 */
export const MANIFEST_RULES_VERSION_ENV = 'DYNAMIC_MANIFEST_RULES_VERSION';

/** Valores que acepta la config. 3 = V2.1 (Blueprint schemaVersion 2 + Manifest rulesVersion 3). */
export type ConfiguredRulesVersion = 1 | 2 | 3;

/**
 * @deprecated R4 implementó el builder v3: `readManifestRulesVersionConfig`
 * ya no lanza este código. Se conserva el export por compatibilidad.
 */
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
 * rulesVersion para CREAR/LEER Manifests: 1 | 2 | 3 (fail-fast con cualquier
 * otro valor, sin fallback). Con 3 el builder exige un Blueprint schemaVersion
 * 2 (`BLUEPRINT_SCHEMA_MISMATCH` si no).
 */
export function readManifestRulesVersionConfig(env: NodeJS.ProcessEnv = process.env): ManifestRulesVersion {
  return readConfiguredRulesVersion(env);
}

/**
 * EV5-C — reglas de tipo de actividad para Manifests v3 NUEVOS
 * (`features.activityTypeRules`). Config `DYNAMIC_ACTIVITY_TYPE_RULES` ∈ {0, 1, 2} (EV6: 2 = H5P v2),
 * default 0 (= rotación por hash, byte-idéntico a antes). Mismo criterio que
 * DYNAMIC_MANIFEST_RULES_VERSION: cualquier otro valor ("true", " 1", "2")
 * lanza, nunca se cae en silencio a 0. Un Manifest YA guardado conserva su
 * marcador (GenerationManifestsService lo reconstruye con el guardado).
 */
export const ACTIVITY_TYPE_RULES_ENV = 'DYNAMIC_ACTIVITY_TYPE_RULES';

export function readActivityTypeRulesConfig(env: NodeJS.ProcessEnv = process.env): ActivityTypeRulesVersion {
  const raw = env[ACTIVITY_TYPE_RULES_ENV];
  if (raw === undefined || raw === '' || raw === '0') return 0;
  if (raw === '1') return 1;
  // EV6 H5P v2: "2" = reglas v2 (Branching Scenario + IV avanzado) para Manifests v3 NUEVOS.
  // El default sigue siendo 0; el controlador decide cuándo activarlo en staging.
  if (raw === '2') return 2;
  throw new Error(
    `${ACTIVITY_TYPE_RULES_ENV} inválido: ${JSON.stringify(raw)} (valores permitidos: "0", "1" o "2"; ausente = 0)`,
  );
}

/**
 * LOOP 7 (A2 A3) — FUENTE ÚNICA del marcador de reglas de actividad que tendrá el PRÓXIMO Manifest v3 del curso:
 * el del Manifest v3 más reciente del curso (`features.activityTypeRules ?? 0`); sin Manifest v3 previo, la config.
 * La usan el Manifest nuevo (GenerationManifestsService), el dry-run del curso («Cursia recomienda»), «Aplicar
 * diseño» y la vista previa del impacto: lo que se muestra se dimensiona con las mismas reglas que se congelan.
 */
export async function activityTypeRulesForNextManifest(
  q: { query(sql: string, params?: unknown[]): Promise<any> },
  courseId: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ActivityTypeRulesVersion> {
  // Sin la tabla de Manifests (esquema sin esa migración) no hay Manifest previo → config, como antes. to_regclass no
  // falla (una consulta fallida abortaría la transacción del llamador, p. ej. «Aplicar diseño»).
  const [reg] = await q.query(`select to_regclass('public.course_generation_manifests') is not null as ok`);
  const [prev] = reg && reg.ok
    ? await q.query(
      `select id, manifest_json->'features'->'activityTypeRules' as activity_type_rules
         from public.course_generation_manifests
        where course_id = $1 and rules_version = 3
        order by created_at desc, id desc
        limit 1`,
      [courseId],
    )
    : [];
  if (!prev) return readActivityTypeRulesConfig(env);
  const raw = prev.activity_type_rules;
  if (raw === undefined || raw === null) return 0;
  if (raw === 0 || raw === 1 || raw === 2) return raw;
  throw new Error(`Generation Manifest #${String(prev.id)}: features.activityTypeRules guardado inválido (${JSON.stringify(raw)})`);
}
