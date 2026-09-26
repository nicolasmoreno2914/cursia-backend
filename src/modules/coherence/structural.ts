import type { BlueprintSnapshotV1, BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import { blueprintV2Warnings, structuralViewV1 } from '../course-blueprints/blueprint-snapshot';
import { cmpStr } from './canonical-json';
import { COHERENCE_THRESHOLDS as T, CoherenceFindingDraft, buildOutline } from './coherence-types';
import { normTokens, round4, tokenContainment, tokenJaccard, tokenSet, trigramJaccard } from './normalize';

/**
 * Fase 7 — capa estructural (pre-generación). Función pura sobre el
 * Blueprint: títulos, objetivos y orden. Reglas S1–S3 de `coherence-rules@1`.
 * Nunca modifica nada; solo devuelve findings (sin id: los asigna report.ts).
 */
export function runStructuralRules(bp: BlueprintSnapshotV1): CoherenceFindingDraft[] {
  const outline = buildOutline(bp);
  const out: CoherenceFindingDraft[] = [];

  // S1 — títulos de capítulo casi duplicados (en todo el curso).
  const chs = outline.chapters;
  for (let i = 0; i < chs.length; i++) {
    for (let j = i + 1; j < chs.length; j++) {
      const a = chs[i];
      const b = chs[j];
      const tri = trigramJaccard(a.title, b.title);
      const tok = tokenJaccard(a.title, b.title);
      const cont = tokenContainment(a.title, b.title);
      const minTokens = Math.min(tokenSet(a.title).size, tokenSet(b.title).size);
      const byContainment = minTokens >= T.S1_CONTAINMENT_MIN_TOKENS && cont >= T.S1_TOKEN_CONTAINMENT_MIN;
      if (tri >= T.S1_TRIGRAM_JACCARD_MIN || tok >= T.S1_TOKEN_JACCARD_MIN || byContainment) {
        out.push({
          rule: 'S1',
          severity: 'warning',
          moduleIds: uniqSorted([a.moduleId, b.moduleId]),
          chapterIds: [a.id, b.id],
          evidence: {
            chapterIds: [a.id, b.id],
            titles: [a.title, b.title],
            trigramJaccard: round4(tri),
            tokenJaccard: round4(tok),
            tokenContainment: round4(cont),
          },
          message: `Los capítulos "${a.title}" y "${b.title}" tienen títulos casi duplicados.`,
          suggestion: 'Diferenciá los títulos o fusioná los capítulos si cubren lo mismo.',
          suggestedAction: 'review',
        });
      }
    }
  }

  // S2 — objetivo de módulo sin capítulos que lo cubran.
  for (const m of outline.modules) {
    if (!m.objective) continue;
    const objTokens = new Set(normTokens(m.objective));
    if (objTokens.size === 0) continue;
    const covered = new Set<string>();
    for (const c of m.chapters) {
      for (const t of normTokens(`${c.title} ${c.objective ?? ''}`)) covered.add(t);
    }
    const uncovered = [...objTokens].filter((t) => !covered.has(t)).sort(cmpStr);
    const coverage = (objTokens.size - uncovered.length) / objTokens.size;
    if (coverage < T.S2_MIN_OBJECTIVE_COVERAGE) {
      out.push({
        rule: 'S2',
        severity: 'info',
        moduleIds: [m.id],
        chapterIds: [],
        evidence: { moduleId: m.id, uncoveredTokens: uncovered, coverage: round4(coverage) },
        message: `El objetivo del módulo "${m.title}" no está cubierto por ningún capítulo.`,
        suggestion: 'Agregá o ajustá capítulos que trabajen el objetivo, o reformulá el objetivo del módulo.',
        suggestedAction: 'review',
      });
    }
  }

  // S3 — módulo con un solo capítulo y examen activado.
  for (const m of outline.modules) {
    if (m.examEnabled && m.chapters.length === 1) {
      out.push({
        rule: 'S3',
        severity: 'info',
        moduleIds: [m.id],
        chapterIds: [],
        evidence: { moduleId: m.id, chapterCount: 1 },
        message: `El módulo "${m.title}" tiene un solo capítulo y examen activado (examen trivial).`,
        suggestion: 'Considerá desactivar el examen del módulo o sumarle capítulos.',
        suggestedAction: 'review',
      });
    }
  }

  return out;
}

/**
 * V2.1 (R5) — capa estructural sobre un Blueprint schemaVersion 2 (runs
 * rulesVersion 3), `coherence-rules-v3@1`:
 *  - S1–S3: las mismas reglas de v1, sobre la vista estructural (títulos,
 *    objetivos, orden, examEnabled). Los toggles nuevos no las cambian.
 *  - S4 (nuevo, info): el curso no tiene nada calificable (ninguna
 *    actividad, ningún examen de módulo y sin examen final). Mismo criterio
 *    que la advertencia NO_GRADED_ITEMS del Blueprint v2.
 * El motor (`activityEngine`) y los recursos obligatorios (Gamma, audio) no
 * generan findings: son decisiones de producto, no incoherencias.
 */
export function runStructuralRulesV3(bp: BlueprintSnapshotV2): CoherenceFindingDraft[] {
  const out = runStructuralRules(structuralViewV1(bp));
  if (blueprintV2Warnings(bp).some((w) => w.code === 'NO_GRADED_ITEMS')) {
    out.push({
      rule: 'S4',
      severity: 'info',
      moduleIds: [],
      chapterIds: [],
      evidence: { activityCount: 0, examCount: 0, finalExam: false },
      message: 'El curso no tiene nada calificable: ninguna actividad, ningún examen de módulo y sin examen final.',
      suggestion: 'Activá al menos una actividad, un examen de módulo o el examen final para que el curso tenga nota.',
      suggestedAction: 'review',
    });
  }
  return out;
}

function uniqSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort(cmpStr);
}
