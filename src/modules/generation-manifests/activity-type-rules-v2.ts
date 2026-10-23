/**
 * EV6 H5P v2 — reglas de tipo de actividad v2 (marcador `features.activityTypeRules = 2`).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CONGELADO (igual que rules 1): cambiar cualquier lista o número de este
 * archivo = reglas 3. El validador del Manifest recalcula `h5pType` con ESTE
 * código para todo Manifest guardado con activityTypeRules = 2;
 * `activityTypeRulesV2ListsSha256` queda fijado en check-ev6-h5p2-wire.js.
 * Rules 1 (activity-type-rules.ts) no cambia: v2 reutiliza su clasificador y
 * solo agrega la intención `decide` por encima.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Rulings del controlador (2026-10-01, H5P2-rulings.md):
 *  - Intención `decide` (decidir, elegir, seleccionar, priorizar, negociar,
 *    manejar, atender, liderar, intervenir + frases «resolver conflictos»,
 *    «responder ante», «toma de decisiones»…) → `branchingscenario`. Rango:
 *    decide > apply (decidir ES aplicar con consecuencias).
 *  - Todas las demás intenciones mapean EXACTAMENTE como rules 1 (Q4: categorizar
 *    y secuenciar siguen en dragtext; no hay DragQuestion).
 *  - Cascada objective → title → description (description: solo frases/pistas).
 *  - Tope de Branching Scenario por curso: max(1, floor(n/4)) (Q7, tamaño del
 *    paquete ≈ 3.7 MB c/u). Los que sobran bajan a questionset en orden
 *    fnv1a32(chapterId en minúsculas) ascendente (empate → chapterId): los primeros
 *    se quedan como BS. Independiente del orden de módulos/capítulos.
 *  - Balance «escenario» (questionset + branchingscenario) ≥ max(1, floor(n/3));
 *    si falta, se promueve a questionset igual que rules 1 (fallback → relate →
 *    recall, por fnv1a32).
 *  - Nada clasificado → rotación por hash (`activityTypeForChapter`), igual que v1.
 */
import { createHash } from 'crypto';
import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import { activityTypeForChapter, fnv1a32 } from '../course-shell/activity-type';
import {
  ACCENTED_PRETERITE_ENDINGS_V1,
  ActivityIntent,
  BALANCE_PROMOTION_ORDER_V1,
  GradedH5pActivityType,
  INTENT_TO_TYPE_V1,
  NON_VERB_WORDS_V1,
  VERB_ENDINGS_V1,
  classifyTextIntent,
  minQuestionsetsFor,
  tokenizeRulesV1,
  verbRootsV1,
} from './activity-type-rules';

export type ActivityIntentV2 = ActivityIntent | 'decide';
export type GradedH5pActivityTypeV2 = GradedH5pActivityType | 'branchingscenario';

/** Tipos asignables bajo rules 2 (los de v1 + branchingscenario). */
export const GRADED_H5P_TYPES_V2: readonly GradedH5pActivityTypeV2[] = Object.freeze(['questionset', 'dragtext', 'blanks', 'branchingscenario']);

export function isGradedH5pActivityTypeV2(v: unknown): v is GradedH5pActivityTypeV2 {
  return typeof v === 'string' && (GRADED_H5P_TYPES_V2 as readonly string[]).includes(v);
}

export const INTENT_TO_TYPE_V2: Readonly<Record<ActivityIntentV2, GradedH5pActivityTypeV2>> = Object.freeze({
  ...INTENT_TO_TYPE_V1,
  decide: 'branchingscenario',
});

/** Verbos de decisión (infinitivo plegado). Rules 1 los clasifica como apply; acá ganan como decide. */
export const DECIDE_VERBS_V2: readonly string[] = Object.freeze([
  'decidir', 'elegir', 'seleccionar', 'priorizar', 'negociar', 'manejar', 'atender', 'liderar', 'intervenir',
]);

/** Raíces irregulares propias de v2 (los verbos de v1 usan IRREGULAR_ROOTS_V1 vía verbRootsV1). */
export const DECIDE_IRREGULAR_ROOTS_V2: Readonly<Record<string, readonly string[]>> = Object.freeze({
  intervenir: Object.freeze(['interveng', 'intervien', 'intervin', 'intervendr']),
});

/**
 * Frases (palabras plegadas contiguas) que expresan una decisión: «resolver» y
 * «responder» solos son ambiguos («resolver ejercicios», «responder preguntas»),
 * por eso solo cuentan en estas frases. Valen también en description.
 */
export const DECIDE_PHRASES_V2: readonly string[] = Object.freeze([
  'resolver conflictos', 'resolver un conflicto', 'resolver el conflicto', 'resolver conflicto', 'resolver situaciones',
  'responder ante', 'toma de decisiones', 'tomar decisiones', 'tomar una decision', 'tomar la decision',
]);

/** Tope de Branching Scenario por curso (Q7). */
export function maxBranchingScenariosFor(n: number): number {
  return n <= 0 ? 0 : Math.max(1, Math.floor(n / 4));
}

const NON_VERB = new Set(NON_VERB_WORDS_V1);

/** forma plegada → {rootLen, finalAccent} de los verbos de decisión (mismas reglas ortográficas que v1). */
const DECIDE_FORMS_V2: ReadonlyMap<string, { rootLen: number; finalAccent: boolean }> = (() => {
  const out = new Map<string, { rootLen: number; finalAccent: boolean }>();
  const add = (form: string, rootLen: number, finalAccent: boolean) => {
    if (NON_VERB.has(form)) return;
    const prev = out.get(form);
    out.set(form, prev ? { rootLen: Math.min(prev.rootLen, rootLen), finalAccent: prev.finalAccent && finalAccent } : { rootLen, finalAccent });
  };
  for (const inf of DECIDE_VERBS_V2) {
    for (const root of [...verbRootsV1(inf), ...(DECIDE_IRREGULAR_ROOTS_V2[inf] ?? [])]) {
      for (const end of VERB_ENDINGS_V1) add(root + end, root.length, false);
      for (const end of ACCENTED_PRETERITE_ENDINGS_V1) add(root + end, root.length, true);
    }
  }
  return out;
})();

function hasDecideVerb(tokens: Array<{ folded: string; accents: number[] }>): boolean {
  return tokens.some((t) => {
    const f = DECIDE_FORMS_V2.get(t.folded);
    if (!f) return false;
    if (f.finalAccent && !t.accents.includes(t.folded.length - 1)) return false;
    if (t.accents.some((i) => i < f.rootLen - 1)) return false;
    return true;
  });
}

function hasDecidePhrase(tokens: Array<{ folded: string }>): boolean {
  const joined = ` ${tokens.map((t) => t.folded).join(' ')} `;
  return DECIDE_PHRASES_V2.some((p) => joined.includes(` ${p} `));
}

/** Intención v2 de un texto: decide si hay verbo/frase de decisión; si no, la de rules 1. */
export function classifyTextIntentV2(text: string | null | undefined, opts: { nounsOnly?: boolean } = {}): ActivityIntentV2 | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const tokens = tokenizeRulesV1(text);
  if (hasDecidePhrase(tokens)) return 'decide';
  if (!opts.nounsOnly && hasDecideVerb(tokens)) return 'decide';
  return classifyTextIntent(text, opts);
}

export function classifyChapterIntentV2(ch: { objective?: string | null; title?: string | null; description?: string | null }): ActivityIntentV2 | null {
  return classifyTextIntentV2(ch.objective) ?? classifyTextIntentV2(ch.title) ?? classifyTextIntentV2(ch.description, { nounsOnly: true });
}

export interface ActivityTypeDecisionV2 {
  chapterId: string;
  type: GradedH5pActivityTypeV2;
  intent: ActivityIntentV2 | null;
  /** true si el balance lo promovió a questionset. */
  promoted: boolean;
  /** true si el tope de Branching Scenario lo bajó a questionset. */
  demoted: boolean;
}

const hashOrder = (a: { chapterId: string }, b: { chapterId: string }): number => {
  const ha = fnv1a32(a.chapterId.toLowerCase());
  const hb = fnv1a32(b.chapterId.toLowerCase());
  return ha - hb || (a.chapterId < b.chapterId ? -1 : a.chapterId > b.chapterId ? 1 : 0);
};

/** Reglas v2 sobre un Blueprint v2. Pura, determinística e independiente del orden de entrada. */
export function chooseActivityTypesV2(snapshot: BlueprintSnapshotV2): Map<string, ActivityTypeDecisionV2> {
  const out = new Map<string, ActivityTypeDecisionV2>();
  if (!snapshot || snapshot.course?.activityEngine !== 'h5p') return out;
  for (const m of snapshot.modules ?? []) {
    for (const c of m.chapters ?? []) {
      if (c.activityEnabled !== true) continue;
      const intent = classifyChapterIntentV2(c);
      const type: GradedH5pActivityTypeV2 = intent ? INTENT_TO_TYPE_V2[intent] : (activityTypeForChapter(c.id) as GradedH5pActivityType);
      out.set(c.id, { chapterId: c.id, type, intent, promoted: false, demoted: false });
    }
  }
  const n = out.size;
  // 1) Tope de Branching Scenario (Q7).
  const bs = [...out.values()].filter((d) => d.type === 'branchingscenario').sort(hashOrder);
  for (const d of bs.slice(maxBranchingScenariosFor(n))) {
    d.type = 'questionset';
    d.demoted = true;
  }
  // 2) Balance de «escenario» (questionset + branchingscenario).
  const scenario = [...out.values()].filter((d) => d.type === 'questionset' || d.type === 'branchingscenario').length;
  const need = minQuestionsetsFor(n) - scenario;
  if (need > 0) {
    const group = (d: ActivityTypeDecisionV2): number => BALANCE_PROMOTION_ORDER_V1.indexOf(d.intent === null ? 'fallback' : (d.intent as ActivityIntent));
    const candidates = [...out.values()]
      .filter((d) => d.type !== 'questionset' && d.type !== 'branchingscenario')
      .sort((a, b) => group(a) - group(b) || hashOrder(a, b));
    for (const d of candidates.slice(0, need)) {
      d.type = 'questionset';
      d.promoted = true;
    }
  }
  return out;
}

/** sha256 de la serialización canónica de lo PROPIO de v2 (listas, mapeo, tope, frases). */
export function activityTypeRulesV2ListsSha256(): string {
  const canonical = {
    intentToType: (['recall', 'relate', 'apply', 'reflect', 'understand', 'decide'] as ActivityIntentV2[]).map((i) => [i, INTENT_TO_TYPE_V2[i]]),
    decideVerbs: [...DECIDE_VERBS_V2],
    decideIrregularRoots: Object.keys(DECIDE_IRREGULAR_ROOTS_V2).sort().map((k) => [k, [...DECIDE_IRREGULAR_ROOTS_V2[k]]]),
    decidePhrases: [...DECIDE_PHRASES_V2],
    bsCap: [1, 4, 5, 8, 9, 12].map((n) => [n, maxBranchingScenariosFor(n)]),
    decideForms: [...DECIDE_FORMS_V2.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([f, x]) => [f, x.rootLen, x.finalAccent]),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
