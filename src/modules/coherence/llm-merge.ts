import type { BlueprintSnapshotV1 } from '../course-blueprints/blueprint-snapshot';
import { cmpStr, sha256Hex } from './canonical-json';
import { CoherenceFinding, CoherenceFindingDraft, ContextSummaryInput, CoursePlanInput, buildOutline } from './coherence-types';
import { normalizePlanChapters } from './content';
import { CoherenceReport, compareFindings, deterministicReportSha256, toFinding } from './report';

/**
 * Fase 7 — capa LLM opcional (detrás de flag, corre en el navegador).
 *
 * - `buildCompactLlmInput`: outline compacto + conceptos y resúmenes, nunca el
 *   curso completo, con tope de tamaño (`LLM_INPUT_MAX_CHARS`).
 * - `mergeLlmFindings`: incorpora los findings del LLM al reporte. Descarta
 *   (y cuenta) los que referencian UUIDs que no existen en el Blueprint,
 *   rotula los aceptados con `source:'llm'` y **nunca** toca los findings
 *   determinísticos ni `reportSha256`.
 */

export const LLM_INPUT_VERSION = 1;
export const LLM_INPUT_MAX_CHARS = 24000;
/** Fix wave I1: tope por campo de texto de un finding LLM (message, suggestion). */
export const LLM_TEXT_MAX_CHARS = 2000;
/** Fix wave I1: tope del JSON serializado de `evidence` de un finding LLM. */
export const LLM_EVIDENCE_MAX_BYTES = 8192;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface LlmFindingInput {
  rule?: unknown;
  severity?: unknown;
  moduleIds?: unknown;
  chapterIds?: unknown;
  evidence?: unknown;
  message?: unknown;
  suggestion?: unknown;
  suggestedAction?: unknown;
}

export interface LlmReviewResult {
  model: string;
  promptSha256: string;
  findings: LlmFindingInput[];
}

export interface CoherenceReportWithLlm extends CoherenceReport {
  llm: {
    model: string;
    promptSha256: string;
    accepted: number;
    droppedInvalidIds: number;
    /** Aditivo: findings que no eran objetos válidos (sin mensaje, ids no-string, etc.). */
    droppedMalformed: number;
  };
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === 'string');
}

export function mergeLlmFindings(
  report: CoherenceReport,
  blueprint: BlueprintSnapshotV1,
  llm: LlmReviewResult,
): CoherenceReportWithLlm {
  const deterministic = report.findings.filter((f) => f.source === 'deterministic');
  // Defensa: el reporte que recibimos debe ser íntegro; si alguien alteró la
  // parte determinística, fallar fuerte en vez de mezclar encima.
  const expected = deterministicReportSha256({ ...report, findings: deterministic });
  if (expected !== report.reportSha256) {
    throw new Error('COHERENCE_REPORT_TAMPERED: reportSha256 no coincide con la parte determinística');
  }

  const outline = buildOutline(blueprint);
  const moduleIds = new Set(outline.modules.map((m) => m.id.toLowerCase()));
  const chapterIds = new Set(outline.chapters.map((c) => c.id.toLowerCase()));
  const known = new Set([...moduleIds, ...chapterIds]);

  let droppedInvalidIds = 0;
  let droppedMalformed = 0;
  const taken = new Set(deterministic.map((f) => f.id));
  const accepted: CoherenceFinding[] = [];

  for (const raw of llm?.findings ?? []) {
    if (!raw || typeof raw !== 'object') {
      droppedMalformed += 1;
      continue;
    }
    const mIds: unknown = raw.moduleIds === undefined ? [] : raw.moduleIds;
    const cIds: unknown = raw.chapterIds === undefined ? [] : raw.chapterIds;
    if (!isStringArray(mIds) || !isStringArray(cIds) || typeof raw.message !== 'string' || !raw.message.trim()) {
      droppedMalformed += 1;
      continue;
    }
    const moduleRefs = mIds as string[];
    const chapterRefs = cIds as string[];
    const evidence =
      raw.evidence && typeof raw.evidence === 'object' && !Array.isArray(raw.evidence)
        ? (raw.evidence as Record<string, unknown>)
        : {};
    const suggestion = typeof raw.suggestion === 'string' ? raw.suggestion : '';
    // Defensa en profundidad (el DTO HTTP ya responde 400): un finding que
    // excede los topes por campo se descarta como malformado.
    let evidenceBytes = Infinity;
    try {
      evidenceBytes = Buffer.byteLength(JSON.stringify(evidence), 'utf8');
    } catch {
      /* no serializable → malformado */
    }
    if (
      raw.message.length > LLM_TEXT_MAX_CHARS ||
      suggestion.length > LLM_TEXT_MAX_CHARS ||
      evidenceBytes > LLM_EVIDENCE_MAX_BYTES
    ) {
      droppedMalformed += 1;
      continue;
    }

    // Todo UUID mencionado (en ids, evidencia o texto) debe existir y ser del tipo correcto.
    const badTyped =
      moduleRefs.some((id) => !moduleIds.has(id.toLowerCase())) ||
      chapterRefs.some((id) => !chapterIds.has(id.toLowerCase()));
    const mentioned: string[] = `${JSON.stringify(evidence)} ${raw.message} ${suggestion}`.match(UUID_RE) ?? [];
    const badMentioned = mentioned.some((id) => !known.has(id.toLowerCase()));
    if (badTyped || badMentioned) {
      droppedInvalidIds += 1;
      continue;
    }

    const draft: CoherenceFindingDraft = {
      rule: 'LLM',
      severity: raw.severity === 'warning' || raw.severity === 'error' ? 'warning' : 'info',
      moduleIds: [...new Set(moduleRefs)].sort(cmpStr),
      chapterIds: [...new Set(chapterRefs)].sort(cmpStr),
      evidence: typeof raw.rule === 'string' && raw.rule ? { ...evidence, llmRule: raw.rule } : evidence,
      message: raw.message,
      suggestion,
      suggestedAction:
        raw.suggestedAction === 'review' || raw.suggestedAction === 'regenerate_chapter' ? raw.suggestedAction : null,
    };
    const f = toFinding(draft, 'llm');
    if (taken.has(f.id)) continue;
    taken.add(f.id);
    accepted.push(f);
  }

  const findings = [...deterministic, ...accepted].sort(compareFindings);
  return {
    ...report,
    findings,
    llm: {
      model: String(llm?.model ?? ''),
      promptSha256: String(llm?.promptSha256 ?? ''),
      accepted: accepted.length,
      droppedInvalidIds,
      droppedMalformed,
    },
    reportSha256: report.reportSha256,
  };
}

// ---------------------------------------------------------------------------
// Entrada compacta para el LLM
// ---------------------------------------------------------------------------

export interface CompactLlmInputArgs {
  blueprint: BlueprintSnapshotV1;
  coursePlan?: CoursePlanInput | null;
  contextSummaries?: Record<string, ContextSummaryInput> | null;
  maxChars?: number;
}

export interface CompactLlmInput {
  llmInputVersion: number;
  json: string;
  chars: number;
  /** Nivel de compactación aplicado (0 = sin recortes). */
  compactionLevel: number;
  promptInputSha256: string;
}

const LEVELS = [
  { summaryChars: 400, maxConcepts: 20, textChars: 300 },
  { summaryChars: 200, maxConcepts: 12, textChars: 300 },
  { summaryChars: 80, maxConcepts: 8, textChars: 200 },
  { summaryChars: 0, maxConcepts: 5, textChars: 160 },
  { summaryChars: 0, maxConcepts: 2, textChars: 120 },
  { summaryChars: 0, maxConcepts: 0, textChars: 80 },
];

export function buildCompactLlmInput(args: CompactLlmInputArgs): CompactLlmInput {
  const maxChars = args.maxChars ?? LLM_INPUT_MAX_CHARS;
  const outline = buildOutline(args.blueprint);
  const plan = normalizePlanChapters(args.coursePlan);
  const real = args.contextSummaries ?? {};

  const clip = (s: unknown, n: number) => (typeof s === 'string' && n > 0 ? s.slice(0, n) : undefined);
  const list = (xs: unknown, n: number) =>
    n > 0 && Array.isArray(xs) ? xs.filter((x) => typeof x === 'string').slice(0, n).map((x: string) => x.slice(0, 80)) : undefined;
  const pack = (s: ContextSummaryInput | undefined, lv: (typeof LEVELS)[number]) =>
    s
      ? {
          summary: clip(s.summary, lv.summaryChars),
          introduced: list(s.concepts_introduced, lv.maxConcepts),
          assumed: list(s.concepts_assumed, lv.maxConcepts),
          keyTerms: list(s.key_terms, lv.maxConcepts),
        }
      : undefined;

  for (let level = 0; level < LEVELS.length; level++) {
    const lv = LEVELS[level];
    const doc = {
      llmInputVersion: LLM_INPUT_VERSION,
      course: { title: String(args.blueprint.course?.title ?? '').slice(0, 200) },
      modules: outline.modules.map((m) => ({
        id: m.id,
        title: m.title.slice(0, lv.textChars),
        objective: m.objective ? m.objective.slice(0, lv.textChars) : null,
        chapters: m.chapters.map((c) => ({
          id: c.id,
          title: c.title.slice(0, lv.textChars),
          objective: c.objective ? c.objective.slice(0, lv.textChars) : null,
          planned: pack(plan.get(c.id), lv),
          real: pack(real[c.id], lv),
        })),
      })),
    };
    const json = JSON.stringify(doc);
    if (json.length <= maxChars || level === LEVELS.length - 1) {
      if (json.length > maxChars) {
        throw new Error(`COHERENCE_LLM_INPUT_TOO_LARGE: el outline mínimo ocupa ${json.length} > ${maxChars} caracteres`);
      }
      return { llmInputVersion: LLM_INPUT_VERSION, json, chars: json.length, compactionLevel: level, promptInputSha256: sha256Hex(json) };
    }
  }
  /* istanbul ignore next */
  throw new Error('unreachable');
}
