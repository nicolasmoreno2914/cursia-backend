/**
 * r63 (V1) · Proyección al informe de calidad del PAQUETE de lo que ya se mide después de generar, en MODO OBSERVACIÓN.
 *
 * Fuentes (todas puras, deterministas, sin IA ni red, sobre artifacts ya pagados):
 *   - batería Q1–Q9 (`runQualityBattery`), armada con los mismos contenidos que cargó el empaque;
 *   - alineación A1–A7 / P1–P3 (`buildAlignmentReport`) del Blueprint congelado + Manifest + tiempo de estudio;
 *   - reglas de contenido C1–C7 (`runContentRules`) con el course_plan y los sidecars `context_summary` reales.
 *
 * Regla dura del modo observación (r63):
 *   - un hallazgo proyectado acá NUNCA es BLOCKER ni MAJOR: lo que su productor marcaría BLOCKER/MAJOR entra como MINOR
 *     (equivalente a WARNING), salvo los BLOCKER que otra compuerta ya garantiza antes de empaquetar (Q1, Q6 sin evaluar,
 *     A1), que entran como INFO «verificado» para no duplicar;
 *   - `blocksDelivery` es siempre false y la severidad original queda en `observation.originalSeverity`;
 *   - el informe los cuenta APARTE (`report.observation`): los contadores, `blocksDelivery`, `requiresHumanResolution`,
 *     `needsHumanReview` y `notMeasured` de siempre no cambian;
 *   - cada fuente corre aislada: si falla, las demás siguen y queda un INFO `QUALITY_OBSERVATION_NOT_EVALUATED`
 *     (`measured:false`). Nunca lanza.
 *
 * Versión: `QUALITY_OBSERVATION_RULES_VERSION`. Los paquetes ya generados no se recalculan (el reuse copia su informe tal
 * cual); un informe sin `observation` es de antes de esta versión.
 */
import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import { recanonicalizeBlueprintSnapshotV2, structuralViewV1 } from '../course-blueprints/blueprint-snapshot';
import type { GenerationManifestV1 } from '../generation-manifests/generation-manifest-builder';
import { buildAlignmentReport } from '../coherence/alignment';
import { runContentRules } from '../coherence/content';
import type { CoherenceFindingDraft, ContextSummaryInput, CoursePlanInput } from '../coherence/coherence-types';
import { estimateCourseStudyTime, studyTimeInputFromManifest, timeModelConfigOf } from '../study-time';
import { QualityInputs, QualityReport, runQualityBattery } from './quality-battery';
import { QualityFindingV2, QualitySeverityV2, excerpt, finding, findingsFromAlignment, findingsFromQualityBattery } from './quality-finding';

export const QUALITY_OBSERVATION_RULES_VERSION = 'r63-observation@1' as const;
export const QUALITY_OBSERVATION_SOURCES = ['quality_battery', 'alignment', 'content_rules'] as const;
export type QualityObservationSource = (typeof QUALITY_OBSERVATION_SOURCES)[number];

/** BLOCKER que otra compuerta ya garantiza antes de empaquetar → INFO «verificado». */
const VERIFIED_UPSTREAM = new Set(['Q1_MISSING_ARTIFACT', 'Q6_CHAPTER_NOT_ASSESSED', 'A1']);

export interface QualityObservationMarker {
  rulesVersion: typeof QUALITY_OBSERVATION_RULES_VERSION;
  source: QualityObservationSource;
  originalSeverity: QualitySeverityV2;
}

export interface QualityObservationSourceStatus {
  status: 'evaluated' | 'not_evaluated';
  findings: number;
  reason?: string;
}

export interface QualityObservationMeta {
  rulesVersion: typeof QUALITY_OBSERVATION_RULES_VERSION;
  mode: 'observation';
  sources: Record<QualityObservationSource, QualityObservationSourceStatus>;
}

export interface PackageObservationInput {
  manifest: GenerationManifestV1;
  blueprint: BlueprintSnapshotV2;
  contents: {
    contentMd: ReadonlyMap<string, string>;
    courseIntro?: any;
    examBanks?: ReadonlyMap<string, { questions?: ReadonlyArray<any> }> | null;
    finalExamBank?: { questions?: ReadonlyArray<any> } | null;
    guidedPractices?: ReadonlyMap<string, unknown> | null;
  };
  /** itemKey → tipos de artifact vigentes (de `prepared.byItem`). */
  artifactTypesByItem: Record<string, string[]>;
  /** course_plan del run (null = no se pudo leer). */
  coursePlan?: CoursePlanInput | null;
  /** chapterId → sidecar real; null = no se pudieron cargar (C1–C7 y Q3/Q7 quedan sin datos reales). */
  contextSummaries?: Record<string, ContextSummaryInput> | null;
  /** Motivo por el que no se cargaron los sidecars (va como INFO; nunca rompe). */
  sidecarsError?: string | null;
  /** Inyección para pruebas (por defecto, las funciones reales). */
  runners?: Partial<{
    battery: (i: QualityInputs) => QualityReport;
    alignment: typeof buildAlignmentReport;
    contentRules: typeof runContentRules;
  }>;
}

export interface PackageObservationResult {
  findings: QualityFindingV2[];
  meta: QualityObservationMeta;
}

/** Severidad acotada del modo observación (nunca BLOCKER ni MAJOR). */
export function observationSeverity(code: string, original: QualitySeverityV2): QualitySeverityV2 {
  if (original === 'BLOCKER' || original === 'MAJOR') return VERIFIED_UPSTREAM.has(code) && original === 'BLOCKER' ? 'INFO' : 'MINOR';
  return original;
}

/** Marca un hallazgo como de observación con la severidad acotada. */
export function asObservation(f: QualityFindingV2, source: QualityObservationSource): QualityFindingV2 & { observation: QualityObservationMarker } {
  const severity = observationSeverity(f.code, f.severity);
  const verified = severity === 'INFO' && f.severity === 'BLOCKER';
  return {
    ...f,
    severity,
    blocksDelivery: false,
    ...(verified ? { recommendation: excerpt(`ninguna (verificado antes de empaquetar); ${f.recommendation}`, 300) } : {}),
    observation: { rulesVersion: QUALITY_OBSERVATION_RULES_VERSION, source, originalSeverity: f.severity },
  };
}

export function isObservationFinding(f: QualityFindingV2): boolean {
  const o = (f as any)?.observation;
  return !!o && typeof o === 'object' && typeof o.rulesVersion === 'string';
}

/** INFO «no se pudo evaluar X» (measured:false). */
export function notEvaluatedFinding(source: QualityObservationSource | 'sidecars', reason: string): QualityFindingV2 {
  const f = finding({
    code: 'QUALITY_OBSERVATION_NOT_EVALUATED', severity: 'INFO', layer: 'pkg', location: { section: 'course', page: source },
    evidence: `no se pudo evaluar ${source}: ${reason}`, rule: { id: source, version: QUALITY_OBSERVATION_RULES_VERSION },
    cause: 'la medición de observación falló o le faltaron datos', recommendation: 'ninguna para entregar (el paquete no depende de esto); revisar el registro del job',
    kind: 'deterministic', measured: false,
  });
  return asObservation(f, source === 'sidecars' ? 'content_rules' : source);
}

/** Toda la observación falló (p. ej. la función entera lanzó): un INFO por fuente y el empaque sigue igual. */
export function observationFailed(reason: unknown): PackageObservationResult {
  const r = errMsg(reason);
  const sources = {} as Record<QualityObservationSource, QualityObservationSourceStatus>;
  for (const s of QUALITY_OBSERVATION_SOURCES) sources[s] = { status: 'not_evaluated', findings: 0, reason: r };
  return { findings: QUALITY_OBSERVATION_SOURCES.map((s) => notEvaluatedFinding(s, r)), meta: { rulesVersion: QUALITY_OBSERVATION_RULES_VERSION, mode: 'observation', sources } };
}

function errMsg(e: unknown): string {
  return excerpt(e instanceof Error ? e.message : String(e), 160);
}

/** Entrada de la batería Q1–Q9 desde lo que cargó el empaque (mismo armado que `CoherenceService.qualityReport`). */
export function qualityInputsFromPackage(p: PackageObservationInput): QualityInputs {
  const chapters: QualityInputs['chapters'] = [];
  for (const m of p.blueprint.modules ?? []) {
    for (const c of (m as any).chapters ?? []) {
      chapters.push({ id: c.id, moduleId: m.id, title: c.title, objective: c.objective ?? null, outcomeIds: Array.isArray(c.outcomeIds) ? c.outcomeIds : [], ...(c.kind === 'practice' ? { kind: 'practice' as const } : {}) });
    }
  }
  const actx: any = (p.blueprint as any).course?.academicContext || {};
  const outcomes = (actx.outcomes || []).map((o: any) => ({ id: String(o.id), text: String(o.text || ''), domain: o.domain }));
  const competencies = (actx.competencies || []).map((o: any) => ({ id: String(o.id), text: String(o.text || '') }));
  const items: any[] = (p.manifest as any).items || [];
  const chapterMd: Record<string, string> = {};
  for (const [id, md] of p.contents.contentMd) chapterMd[id] = md;
  const contextSummaries: QualityInputs['contextSummaries'] = {};
  for (const [id, s] of Object.entries(p.contextSummaries ?? {})) {
    if (s) contextSummaries[id] = { concepts_introduced: s.concepts_introduced ?? null, concepts_assumed: s.concepts_assumed ?? null, key_terms: s.key_terms ?? null };
  }
  const intro = p.contents.courseIntro;
  const introCompetencies = intro && Array.isArray(intro.competencies) ? intro.competencies.map(String) : null;
  const examBanks: QualityInputs['examBanks'] = {};
  const qs = (b: { questions?: ReadonlyArray<any> } | null | undefined) => (Array.isArray(b?.questions) ? b!.questions! : []).map((q: any) => ({ chapterId: q?.chapterId ?? null, evidence: q?.evidence ?? null }));
  for (const [moduleId, b] of p.contents.examBanks ?? new Map()) {
    const it = items.find((x) => x.type === 'exam' && x.moduleId === moduleId);
    const key = it ? String(it.key) : `exam:${moduleId}`;
    examBanks[key] = { chapterIds: chapters.filter((c) => c.kind !== 'practice' && c.moduleId === moduleId).map((c) => c.id), questions: qs(b) };
  }
  if (p.contents.finalExamBank) {
    const it = items.find((x) => x.type === 'final_exam');
    examBanks[it ? String(it.key) : 'final_exam'] = { chapterIds: chapters.filter((c) => c.kind !== 'practice').map((c) => c.id), questions: qs(p.contents.finalExamBank) };
  }
  const guidedPractices: NonNullable<QualityInputs['guidedPractices']> = {};
  for (const [id, d] of p.contents.guidedPractices ?? new Map()) {
    const doc: any = d;
    if (doc && Array.isArray(doc.exercises)) guidedPractices[id] = { minutes: typeof doc.minutes === 'number' ? doc.minutes : null, exercises: doc.exercises };
  }
  return {
    chapters, outcomes, competencies,
    manifestItems: items.map((x) => ({ key: String(x.key), type: String(x.type), chapterId: x.chapterId ?? null, moduleId: x.moduleId ?? null })),
    artifactTypesByItem: p.artifactTypesByItem, chapterMd, contextSummaries, introCompetencies, examBanks,
    ...(Object.keys(guidedPractices).length ? { guidedPractices } : {}),
  };
}

/** C1–C7 (`info`/`warning`) → hallazgos del formato común (needs_human_review: son léxicos). */
export function findingsFromContentRules(drafts: ReadonlyArray<CoherenceFindingDraft>, ruleset: string): QualityFindingV2[] {
  return drafts.map((d) => finding({
    code: `COHERENCE_${d.rule}`, layer: 'E3', location: { chapterId: d.chapterIds[0], moduleId: d.moduleIds[0], section: 'course' },
    evidence: d.message, rule: { id: d.rule, version: ruleset }, cause: 'coherencia de conceptos entre capítulos (plan y sidecars reales)',
    recommendation: d.suggestion, kind: 'needs_human_review',
  }, d.severity === 'warning' ? 'MINOR' : 'INFO'));
}

/** Corre las tres fuentes aisladas y devuelve los hallazgos ya marcados como observación. Nunca lanza. */
export function buildPackageObservationFindings(p: PackageObservationInput): PackageObservationResult {
  const out: QualityFindingV2[] = [];
  const sources = {} as Record<QualityObservationSource, QualityObservationSourceStatus>;
  const run = (source: QualityObservationSource, fn: () => QualityFindingV2[]) => {
    try {
      const fs = fn().map((f) => asObservation(f, source));
      out.push(...fs);
      sources[source] = { status: 'evaluated', findings: fs.length };
    } catch (e) {
      const reason = errMsg(e);
      out.push(notEvaluatedFinding(source, reason));
      sources[source] = { status: 'not_evaluated', findings: 0, reason };
    }
  };
  const R = p.runners ?? {};
  run('quality_battery', () => findingsFromQualityBattery((R.battery ?? runQualityBattery)(qualityInputsFromPackage(p))));
  run('alignment', () => {
    const studyTime = estimateCourseStudyTime(studyTimeInputFromManifest(p.manifest, p.blueprint), timeModelConfigOf(p.blueprint));
    const r = (R.alignment ?? buildAlignmentReport)({ snapshot: p.blueprint, manifest: p.manifest, studyTime, priorKnowledgeDeclared: null });
    if (r.available === false) throw new Error(`alineación no disponible (${r.reason})`);
    return findingsFromAlignment(r.findings);
  });
  run('content_rules', () => {
    if (!p.coursePlan && !p.contextSummaries) throw new Error(p.sidecarsError ? `sin course_plan ni sidecars (${p.sidecarsError})` : 'sin course_plan ni sidecars');
    const bpV1 = structuralViewV1(recanonicalizeBlueprintSnapshotV2(p.blueprint));
    const drafts = (R.contentRules ?? runContentRules)({ blueprint: bpV1, coursePlan: p.coursePlan ?? null, contextSummaries: p.contextSummaries ?? null, declaredPriorConcepts: null });
    return findingsFromContentRules(drafts, 'coherence-rules-v3@1');
  });
  if (p.sidecarsError && (p.coursePlan || p.contextSummaries)) out.push(notEvaluatedFinding('sidecars', p.sidecarsError));
  return { findings: out, meta: { rulesVersion: QUALITY_OBSERVATION_RULES_VERSION, mode: 'observation', sources } };
}
