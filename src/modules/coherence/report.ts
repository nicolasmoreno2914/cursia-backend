import { BlueprintSnapshotV1, snapshotSha256 } from '../course-blueprints/blueprint-snapshot';
import { GenerationManifestV1, manifestSha256 } from '../generation-manifests/generation-manifest-builder';
import { cmpStr, sha256Canonical, sha256Hex, sortedCanonicalJson } from './canonical-json';
import {
  COHERENCE_RULESET,
  COHERENCE_THRESHOLDS,
  COHERENCE_VERSION,
  CoherenceFinding,
  CoherenceFindingDraft,
  ContextSummaryInput,
  CoursePlanInput,
  RULE_ORDER,
} from './coherence-types';
import { ContentCoherenceInput, normalizePlanChapters, runContentRules } from './content';
import { runStructuralRules } from './structural';

/**
 * Fase 7 — ensamblado del reporte de coherencia (spec §4).
 *
 * Reproducible: mismos inputs ⇒ mismos findings, mismo orden, mismos ids y
 * mismo `reportSha256`. El hash cubre solo la parte determinística
 * (`coherenceVersion`, `ruleset`, `layers`, `inputs`, findings `source:'deterministic'`);
 * la capa LLM queda rotulada aparte (`llm-merge.ts`) y nunca lo altera.
 */

export interface CoherenceReportInputs {
  blueprintSha256: string;
  manifestSha256: string | null;
  coursePlanSha256: string | null;
  contextSummariesSha256: string | null;
  /**
   * Aditivo a la spec §4: el contexto previo declarado cambia C3, así que
   * también se hashea (conjunto ordenado). `null` si no se declaró.
   */
  declaredPriorConceptsSha256: string | null;
}

export interface CoherenceLlmBlock {
  model: string;
  promptSha256: string;
  accepted: number;
  droppedInvalidIds: number;
}

export interface CoherenceReport {
  coherenceVersion: typeof COHERENCE_VERSION;
  ruleset: typeof COHERENCE_RULESET;
  layers: { structural: boolean; content: boolean };
  thresholds: typeof COHERENCE_THRESHOLDS;
  inputs: CoherenceReportInputs;
  findings: CoherenceFinding[];
  llm: CoherenceLlmBlock | null;
  /** sha256 de la parte determinística (ver arriba). */
  reportSha256: string;
}

export interface CoherenceReportInput extends ContentCoherenceInput {
  /** Manifest del run (v1 o v2). Solo se hashea; las reglas no lo leen. */
  manifest?: { rulesVersion?: number } | null;
  /** Default: estructural siempre; contenido solo si hay plan o sidecars. */
  layers?: { structural?: boolean; content?: boolean };
}

export function findingId(draft: Pick<CoherenceFindingDraft, 'rule' | 'moduleIds' | 'chapterIds' | 'evidence'>): string {
  const ids = [...new Set([...(draft.moduleIds ?? []), ...(draft.chapterIds ?? [])])].sort(cmpStr);
  return sha256Hex(`${draft.rule}\n${ids.join(',')}\n${sortedCanonicalJson(draft.evidence ?? {})}`);
}

/** Orden determinístico: por regla (S1…C7, luego las demás) y por id. */
export function compareFindings(a: CoherenceFinding, b: CoherenceFinding): number {
  const src = (a.source === 'llm' ? 1 : 0) - (b.source === 'llm' ? 1 : 0);
  if (src !== 0) return src;
  const ra = RULE_ORDER.indexOf(a.rule);
  const rb = RULE_ORDER.indexOf(b.rule);
  const oa = ra === -1 ? RULE_ORDER.length : ra;
  const ob = rb === -1 ? RULE_ORDER.length : rb;
  if (oa !== ob) return oa - ob;
  if (a.rule !== b.rule) return cmpStr(a.rule, b.rule);
  return cmpStr(a.id, b.id);
}

/**
 * sha del Blueprint igual al del sistema (`snapshotSha256` sobre el orden
 * canónico de claves del builder), pero reconstruyendo el objeto para que
 * un snapshot con claves reordenadas (jsonb) o módulos/capítulos en otro
 * orden de arreglo dé el mismo hash. El orden semántico es `position`.
 */
export function canonicalBlueprintSha256(bp: BlueprintSnapshotV1): string {
  const byPos = <X extends { position: number; id: string }>(a: X, b: X) =>
    Number(a.position) - Number(b.position) || cmpStr(a.id, b.id);
  const canonical: BlueprintSnapshotV1 = {
    schemaVersion: 1,
    course: { id: bp.course.id, title: bp.course.title, structureVersion: 'dynamic' },
    modules: [...bp.modules].sort(byPos).map((m) => ({
      id: m.id,
      position: Number(m.position),
      title: m.title,
      objective: m.objective ?? null,
      examEnabled: !!m.examEnabled,
      chapters: [...m.chapters].sort(byPos).map((c) => ({
        id: c.id,
        position: Number(c.position),
        title: c.title,
        objective: c.objective ?? null,
        videoEnabled: !!c.videoEnabled,
      })),
    })),
  };
  return snapshotSha256(canonical);
}

export function canonicalManifestSha256(manifest: { rulesVersion?: number } | null | undefined): string | null {
  if (!manifest) return null;
  if (manifest.rulesVersion === 1) return manifestSha256(manifest as unknown as GenerationManifestV1);
  // v2 (u otro): el builder v1 descartaría campos desconocidos; se usa JSON
  // canónico con claves ordenadas y los arreglos tal cual (su orden es canónico).
  return sha256Canonical(manifest);
}

/** Listas de conceptos como conjuntos (orden no semántico): únicas y ordenadas. */
function canonicalSummary(s: ContextSummaryInput): Record<string, unknown> {
  const set = (xs: string[] | null | undefined) =>
    [...new Set((xs ?? []).filter((x) => typeof x === 'string'))].sort(cmpStr);
  return {
    summary: typeof s.summary === 'string' ? s.summary : null,
    concepts_introduced: set(s.concepts_introduced),
    concepts_assumed: set(s.concepts_assumed),
    key_terms: set(s.key_terms),
  };
}

export function canonicalCoursePlanSha256(plan: CoursePlanInput | null | undefined): string | null {
  if (!plan) return null;
  const chapters: Record<string, unknown> = {};
  for (const [id, c] of normalizePlanChapters(plan)) chapters[id] = canonicalSummary(c);
  const modules: Record<string, unknown> = {};
  if (Array.isArray(plan.modules)) {
    for (const m of plan.modules) if (m && typeof m.moduleId === 'string') modules[m.moduleId] = { summary: m.summary ?? null };
  } else if (plan.modules) {
    for (const [id, m] of Object.entries(plan.modules)) modules[id] = { summary: m?.summary ?? null };
  }
  const { chapters: _c, modules: _m, ...rest } = plan as unknown as Record<string, unknown>;
  return sha256Canonical({ ...rest, chapters, modules });
}

export function canonicalContextSummariesSha256(
  summaries: Record<string, ContextSummaryInput> | null | undefined,
): string | null {
  if (!summaries) return null;
  const out: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(summaries)) if (s) out[id] = canonicalSummary(s);
  return sha256Canonical(out);
}

export function deterministicReportSha256(
  r: Pick<CoherenceReport, 'coherenceVersion' | 'ruleset' | 'layers' | 'inputs' | 'findings'>,
): string {
  return sha256Canonical({
    coherenceVersion: r.coherenceVersion,
    ruleset: r.ruleset,
    layers: r.layers,
    inputs: r.inputs,
    findings: r.findings.filter((f) => f.source === 'deterministic'),
  });
}

export function toFinding(draft: CoherenceFindingDraft, source: 'deterministic' | 'llm'): CoherenceFinding {
  return {
    id: findingId(draft),
    rule: draft.rule,
    severity: draft.severity,
    moduleIds: [...draft.moduleIds],
    chapterIds: [...draft.chapterIds],
    evidence: draft.evidence,
    message: draft.message,
    suggestion: draft.suggestion,
    suggestedAction: draft.suggestedAction ?? null,
    source,
  };
}

export function buildCoherenceReport(input: CoherenceReportInput): CoherenceReport {
  const hasContentInputs = !!input.coursePlan || !!input.contextSummaries;
  const layers = {
    structural: input.layers?.structural ?? true,
    content: input.layers?.content ?? hasContentInputs,
  };

  const drafts: CoherenceFindingDraft[] = [];
  if (layers.structural) drafts.push(...runStructuralRules(input.blueprint));
  if (layers.content) drafts.push(...runContentRules(input));

  const byId = new Map<string, CoherenceFinding>();
  for (const d of drafts) {
    const f = toFinding(d, 'deterministic');
    if (!byId.has(f.id)) byId.set(f.id, f);
  }
  const findings = [...byId.values()].sort(compareFindings);

  const inputs: CoherenceReportInputs = {
    blueprintSha256: canonicalBlueprintSha256(input.blueprint),
    manifestSha256: canonicalManifestSha256(input.manifest),
    coursePlanSha256: canonicalCoursePlanSha256(input.coursePlan),
    contextSummariesSha256: canonicalContextSummariesSha256(input.contextSummaries),
    declaredPriorConceptsSha256: input.declaredPriorConcepts
      ? sha256Canonical([...new Set(input.declaredPriorConcepts.map((x) => String(x)))].sort(cmpStr))
      : null,
  };

  const base = { coherenceVersion: COHERENCE_VERSION, ruleset: COHERENCE_RULESET, layers, inputs, findings };
  return {
    coherenceVersion: COHERENCE_VERSION,
    ruleset: COHERENCE_RULESET,
    layers,
    thresholds: COHERENCE_THRESHOLDS,
    inputs,
    findings,
    llm: null,
    reportSha256: deterministicReportSha256(base),
  };
}
