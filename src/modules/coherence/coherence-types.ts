import type { BlueprintSnapshotV1 } from '../course-blueprints/blueprint-snapshot';
import { cmpStr } from './canonical-json';

/**
 * Fase 7 — tipos y umbrales versionados del Coherence Engine.
 * Cambiar un umbral o la semántica de una regla sube `COHERENCE_RULESET`.
 */

export const COHERENCE_VERSION = 1 as const;
export const COHERENCE_RULESET = 'coherence-rules@1' as const;

export const COHERENCE_THRESHOLDS = Object.freeze({
  /** S1: títulos casi duplicados si trigram-Jaccard ≥ esto… */
  S1_TRIGRAM_JACCARD_MIN: 0.6,
  /** …o token-Jaccard ≥ esto. */
  S1_TOKEN_JACCARD_MIN: 0.75,
  /** …o contención de tokens |A∩B|/min(|A|,|B|) ≥ esto, si min(|A|,|B|) ≥ S1_CONTAINMENT_MIN_TOKENS. */
  S1_TOKEN_CONTAINMENT_MIN: 0.8,
  S1_CONTAINMENT_MIN_TOKENS: 2,
  /** S2: fracción de tokens del objetivo del módulo cubiertos por títulos/objetivos de sus capítulos. */
  S2_MIN_OBJECTIVE_COVERAGE: 0.3,
  /** C4: fracción de tokens del objetivo del capítulo cubiertos por sus concepts_introduced reales. */
  C4_MIN_OBJECTIVE_COVERAGE: 0.3,
  /** C5: key_terms reales de dos capítulos con Jaccard ≥ esto. */
  C5_KEY_TERMS_JACCARD_MIN: 0.5,
  /** C6: |real ∩ planeado| / |planeado| < esto ⇒ desvío. */
  C6_MIN_PLAN_OVERLAP: 0.3,
  /** C6: un concepto real "coincide" con uno planeado si su token-Jaccard ≥ esto (paráfrasis). */
  C6_CONCEPT_MATCH_TOKEN_JACCARD: 0.5,
});

export type CoherenceRuleId = 'S1' | 'S2' | 'S3' | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7';
export const RULE_ORDER: readonly string[] = ['S1', 'S2', 'S3', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'];

export type CoherenceSeverity = 'info' | 'warning';
export type SuggestedAction = 'review' | 'regenerate_chapter' | null;

/** Finding sin id ni source (lo que devuelven las reglas). */
export interface CoherenceFindingDraft {
  rule: string;
  severity: CoherenceSeverity;
  moduleIds: string[];
  chapterIds: string[];
  evidence: Record<string, unknown>;
  message: string;
  suggestion: string;
  suggestedAction: SuggestedAction;
}

export interface CoherenceFinding extends CoherenceFindingDraft {
  id: string;
  source: 'deterministic' | 'llm';
}

/**
 * Entrada del sidecar `context_summary` real (spec rulesVersion 2 §3/§4) y
 * de cada capítulo del `course_plan`. Todos los campos se toleran ausentes.
 */
export interface ContextSummaryInput {
  summary?: string | null;
  concepts_introduced?: string[] | null;
  concepts_assumed?: string[] | null;
  key_terms?: string[] | null;
}

export interface CoursePlanChapterInput extends ContextSummaryInput {
  chapterId?: string;
}

/**
 * Forma mínima del `course_plan` (rulesVersion 2). Se aceptan capítulos como
 * mapa `chapterId → entrada` o como arreglo con `chapterId`.
 */
export interface CoursePlanInput {
  chapters: Record<string, CoursePlanChapterInput> | CoursePlanChapterInput[];
  modules?: Record<string, { summary?: string | null }> | Array<{ moduleId: string; summary?: string | null }>;
}

/** Capítulo en orden de curso (derivado del Blueprint por position). */
export interface OutlineChapter {
  id: string;
  moduleId: string;
  title: string;
  objective: string | null;
  /** Índice 0-based en el orden global del curso. */
  index: number;
}

export interface OutlineModule {
  id: string;
  title: string;
  objective: string | null;
  examEnabled: boolean;
  chapters: OutlineChapter[];
}

export interface Outline {
  modules: OutlineModule[];
  chapters: OutlineChapter[];
  chapterById: Map<string, OutlineChapter>;
  moduleById: Map<string, OutlineModule>;
}

/**
 * Orden semántico del curso: módulos por `position`, capítulos por
 * `position` dentro de su módulo (desempate por UUID para que un empate
 * nunca dependa del orden del arreglo de entrada).
 */
export function buildOutline(bp: BlueprintSnapshotV1): Outline {
  const modules = [...(bp.modules ?? [])].sort(
    (a, b) => Number(a.position) - Number(b.position) || cmpStr(a.id, b.id),
  );
  const chapters: OutlineChapter[] = [];
  const outModules: OutlineModule[] = modules.map((m) => {
    const chs = [...(m.chapters ?? [])]
      .sort((a, b) => Number(a.position) - Number(b.position) || cmpStr(a.id, b.id))
      .map((c) => {
        const oc: OutlineChapter = {
          id: c.id,
          moduleId: m.id,
          title: c.title ?? '',
          objective: c.objective ?? null,
          index: chapters.length,
        };
        chapters.push(oc);
        return oc;
      });
    return { id: m.id, title: m.title ?? '', objective: m.objective ?? null, examEnabled: !!m.examEnabled, chapters: chs };
  });
  return {
    modules: outModules,
    chapters,
    chapterById: new Map(chapters.map((c) => [c.id, c])),
    moduleById: new Map(outModules.map((m) => [m.id, m])),
  };
}
