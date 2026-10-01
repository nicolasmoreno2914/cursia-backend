// EV6 H5P v2 — H5P.BranchingScenario 1.10 (actividad calificada "decidir").
//
// Contrato LLM (`data` del payload `branchingscenario`, texto plano; el LLM
// nunca escribe índices, puntajes ni campos H5P):
//   { title ≤120, situation ≤700,
//     decisions: [ { id "d1".."d6", question ≤250,
//                    options: [ { text ≤200, next "dN" | "end:eK", consequence? ≤250 } ×2..3 ] } ×2..6 ],
//     endings:   [ { id "e1".."e5", quality optimal|acceptable|poor, title ≤80, text ≤300 } ×3..5 ] }
//
// Cursia lo mapea a H5P (diseño H5P2 §2.2, prueba en Moodle 4.5 cursos 1007/1008):
//   nodo 0 = situación (H5P.AdvancedText) → nextContentId 1; nodos 1..n = decisiones
//   (H5P.BranchingQuestion) en orden de declaración; `end:eK` → nextContentId -1 con
//   feedback {title, subtitle, endScreenScore}; `consequence` → pantalla de feedback
//   intermedia. TODO nodo lleva feedback {subtitle:''} (sin él BS se cae en "Continuar":
//   TypeError … 'title' en handleProceed), proceedButtonText 'Continuar',
//   contentBehaviour/forceContentFinished 'useBehavioural' y l10n completa en español.
// Puntaje: static-end-score, sin puntaje de interacciones; óptimo 10, aceptable 7
// (ruling Q3: aprueba con 70), malo 0 ⇒ maxScore 10. subContentId = UUIDv5(itemKey#i#p2).
import { h5pSubContentId } from '../ids';
import { applyH5pL10n } from '../l10n';
import { h5pProfileVersionV2 } from '../profile';
import { H5pBuiltContent, H5pInputError, Issues, checkItemKey, escapeText, isPlainObject } from './common';

export const BRANCHING_SCENARIO_LIMITS = Object.freeze({
  titleMax: 120,
  situationMax: 700,
  questionMax: 250,
  optionTextMax: 200,
  consequenceMax: 250,
  endingTitleMax: 80,
  endingTextMax: 300,
  minDecisions: 2,
  maxDecisions: 6,
  minOptions: 2,
  maxOptions: 3,
  minEndings: 3,
  maxEndings: 5,
  minDepth: 1,
  maxDepth: 4,
  maxPaths: 16,
  maxContentNodes: 8,
  maxOptimal: 2,
});

/** Puntaje fijo por calidad del final (ruling Q3, constante reversible). */
export const BRANCHING_SCENARIO_ENDING_SCORES = Object.freeze({ optimal: 10, acceptable: 7, poor: 0 });
export const BRANCHING_SCENARIO_MAX_SCORE = 10;

export type BsEndingQuality = 'optimal' | 'acceptable' | 'poor';

export interface BsOptionInput {
  text: string;
  next: string;
  consequence?: string;
}
export interface BsDecisionInput {
  id: string;
  question: string;
  options: BsOptionInput[];
}
export interface BsEndingInput {
  id: string;
  quality: BsEndingQuality;
  title: string;
  text: string;
}
export interface BranchingScenarioData {
  title: string;
  situation: string;
  decisions: BsDecisionInput[];
  endings: BsEndingInput[];
}
export interface BranchingScenarioInput extends BranchingScenarioData {
  itemKey: string;
}

/** Códigos BS_* (diseño §4). BS_SHAPE/BS_TEXT = forma y longitudes. */
export type BsIssueCode =
  | 'BS_SHAPE'
  | 'BS_TEXT'
  | 'BS_REF'
  | 'BS_FORWARD_ONLY'
  | 'BS_UNREACHABLE'
  | 'BS_DEAD_END'
  | 'BS_ENDINGS'
  | 'BS_DUP_OPTION'
  | 'BS_DEPTH'
  | 'BS_PATHS'
  | 'BS_NODES';

export interface BsIssue {
  code: BsIssueCode;
  path: string;
  message: string;
}

const DECISION_ID_RE = /^d[1-6]$/;
const ENDING_ID_RE = /^e[1-5]$/;
const NEXT_RE = /^(?:d[1-9]\d*|end:e[1-9]\d*)$/;
const QUALITIES: readonly BsEndingQuality[] = ['optimal', 'acceptable', 'poor'];
const HTML_TAG_RE = /<\/?[a-zA-Z][^<>]*>|<!--|<!\[CDATA\[/;
const HTML_ENTITY_RE = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function textIssue(out: BsIssue[], path: string, v: unknown, max: number, multiline = false): v is string {
  if (typeof v !== 'string') {
    out.push({ code: 'BS_TEXT', path, message: 'debe ser texto' });
    return false;
  }
  const t = v.trim();
  if (!t) {
    out.push({ code: 'BS_TEXT', path, message: 'no puede estar vacío' });
    return false;
  }
  if (t.length > max) out.push({ code: 'BS_TEXT', path, message: `máximo ${max} caracteres (tiene ${t.length})` });
  if (HTML_TAG_RE.test(v)) out.push({ code: 'BS_TEXT', path, message: 'no se permite HTML (solo texto plano)' });
  if (HTML_ENTITY_RE.test(v)) out.push({ code: 'BS_TEXT', path, message: 'no se permiten entidades HTML' });
  if (CONTROL_RE.test(v)) out.push({ code: 'BS_TEXT', path, message: 'caracteres de control no permitidos' });
  if (!multiline && /[\r\n]/.test(v)) out.push({ code: 'BS_TEXT', path, message: 'debe ser una sola línea' });
  return true;
}

function unknownKeys(out: BsIssue[], path: string, o: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) out.push({ code: 'BS_SHAPE', path, message: `campo desconocido "${k}"` });
}

function listIssue(out: BsIssue[], path: string, v: unknown, min: number, max: number): v is unknown[] {
  if (!Array.isArray(v)) {
    out.push({ code: 'BS_SHAPE', path, message: 'debe ser una lista' });
    return false;
  }
  if (v.length < min || v.length > max) {
    out.push({ code: 'BS_SHAPE', path, message: `debe tener entre ${min} y ${max} elementos (tiene ${v.length})` });
    return false;
  }
  return true;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Valida `data` (con o sin `itemKey`) y devuelve TODOS los problemas con su código.
 * Lista vacía ⇔ válido. Pura.
 */
export function validateBranchingScenarioData(data: unknown, opts: { allowItemKey?: boolean } = {}): BsIssue[] {
  const L = BRANCHING_SCENARIO_LIMITS;
  const out: BsIssue[] = [];
  if (!isPlainObject(data)) return [{ code: 'BS_SHAPE', path: '$', message: 'debe ser un objeto' }];
  unknownKeys(out, '$', data, ['title', 'situation', 'decisions', 'endings', ...(opts.allowItemKey ? ['itemKey'] : [])]);
  textIssue(out, 'title', data.title, L.titleMax);
  textIssue(out, 'situation', data.situation, L.situationMax, true);

  // Finales
  const endings = new Map<string, { quality: BsEndingQuality; index: number }>();
  const endingsOk = listIssue(out, 'endings', data.endings, L.minEndings, L.maxEndings);
  if (endingsOk) {
    (data.endings as unknown[]).forEach((e, i) => {
      const p = `endings[${i}]`;
      if (!isPlainObject(e)) {
        out.push({ code: 'BS_SHAPE', path: p, message: 'debe ser un objeto' });
        return;
      }
      unknownKeys(out, p, e, ['id', 'quality', 'title', 'text']);
      if (typeof e.id !== 'string' || !ENDING_ID_RE.test(e.id)) out.push({ code: 'BS_SHAPE', path: `${p}.id`, message: 'debe ser "e1".."e5"' });
      else if (endings.has(e.id)) out.push({ code: 'BS_SHAPE', path: `${p}.id`, message: `id duplicado ${e.id}` });
      if (!(QUALITIES as readonly unknown[]).includes(e.quality)) out.push({ code: 'BS_SHAPE', path: `${p}.quality`, message: 'debe ser "optimal", "acceptable" o "poor"' });
      textIssue(out, `${p}.title`, e.title, L.endingTitleMax);
      textIssue(out, `${p}.text`, e.text, L.endingTextMax);
      if (typeof e.id === 'string' && ENDING_ID_RE.test(e.id) && !endings.has(e.id) && (QUALITIES as readonly unknown[]).includes(e.quality)) {
        endings.set(e.id, { quality: e.quality as BsEndingQuality, index: i });
      }
    });
  }

  // Decisiones
  const decisionIndex = new Map<string, number>();
  const decisionsOk = listIssue(out, 'decisions', data.decisions, L.minDecisions, L.maxDecisions);
  const decisions = decisionsOk ? (data.decisions as unknown[]) : [];
  decisions.forEach((d, i) => {
    if (!isPlainObject(d)) return;
    if (typeof d.id === 'string' && DECISION_ID_RE.test(d.id) && !decisionIndex.has(d.id)) decisionIndex.set(d.id, i);
  });
  // edges[i] = destinos (decisión: índice; final: "end:eK") de la decisión i (solo aristas válidas)
  const edges: Array<Array<{ decision?: number; ending?: string }>> = decisions.map(() => []);
  decisions.forEach((d, i) => {
    const p = `decisions[${i}]`;
    if (!isPlainObject(d)) {
      out.push({ code: 'BS_SHAPE', path: p, message: 'debe ser un objeto' });
      return;
    }
    unknownKeys(out, p, d, ['id', 'question', 'options']);
    if (typeof d.id !== 'string' || !DECISION_ID_RE.test(d.id)) out.push({ code: 'BS_SHAPE', path: `${p}.id`, message: 'debe ser "d1".."d6"' });
    else if (decisionIndex.get(d.id) !== i) out.push({ code: 'BS_SHAPE', path: `${p}.id`, message: `id duplicado ${d.id}` });
    textIssue(out, `${p}.question`, d.question, L.questionMax);
    if (!listIssue(out, `${p}.options`, d.options, L.minOptions, L.maxOptions)) return;
    const seen = new Set<string>();
    (d.options as unknown[]).forEach((o, j) => {
      const op = `${p}.options[${j}]`;
      if (!isPlainObject(o)) {
        out.push({ code: 'BS_SHAPE', path: op, message: 'debe ser un objeto' });
        return;
      }
      unknownKeys(out, op, o, ['text', 'next', 'consequence']);
      if (textIssue(out, `${op}.text`, o.text, L.optionTextMax)) {
        const n = norm(o.text as string);
        if (seen.has(n)) out.push({ code: 'BS_DUP_OPTION', path: `${op}.text`, message: 'opción repetida en la misma decisión' });
        seen.add(n);
      }
      if (o.consequence !== undefined) textIssue(out, `${op}.consequence`, o.consequence, L.consequenceMax);
      const next = o.next;
      if (next === undefined || next === null || (typeof next === 'string' && next.trim() === '')) {
        out.push({ code: 'BS_DEAD_END', path: `${op}.next`, message: 'la opción no tiene destino (debe ser "dN" o "end:eK")' });
        return;
      }
      if (typeof next !== 'string' || !NEXT_RE.test(next)) {
        out.push({ code: 'BS_REF', path: `${op}.next`, message: `destino inválido ${JSON.stringify(next)} (debe ser "dN" o "end:eK")` });
        return;
      }
      if (next.startsWith('end:')) {
        const eid = next.slice(4);
        if (!endings.has(eid)) out.push({ code: 'BS_REF', path: `${op}.next`, message: `el final ${eid} no existe` });
        else edges[i].push({ ending: eid });
        return;
      }
      const t = decisionIndex.get(next);
      if (t === undefined) {
        out.push({ code: 'BS_REF', path: `${op}.next`, message: `la decisión ${next} no existe` });
        return;
      }
      if (t <= i) {
        out.push({ code: 'BS_FORWARD_ONLY', path: `${op}.next`, message: `${next} no está declarada después de ${String(d.id)} (solo se avanza: sin ciclos)` });
        return;
      }
      edges[i].push({ decision: t });
    });
  });

  // Análisis del grafo: solo si la forma básica es válida (si no, los errores de arriba bastan).
  const graphable = decisionsOk && endingsOk && !out.some((e) => e.code === 'BS_SHAPE' && /\.id$|^decisions$|^endings$|options$/.test(e.path));
  if (graphable && decisions.length) {
    const facts = analyzeGraph(edges);
    const reachedDecisions = facts.reachedDecisions;
    decisions.forEach((d, i) => {
      if (!reachedDecisions.has(i)) out.push({ code: 'BS_UNREACHABLE', path: `decisions[${i}]`, message: `la decisión ${String((d as Record<string, unknown>).id)} no se alcanza desde la situación` });
    });
    for (const [eid, e] of endings) {
      if (!(eid in facts.endingDepth)) out.push({ code: 'BS_UNREACHABLE', path: `endings[${e.index}]`, message: `el final ${eid} no se alcanza desde la situación` });
    }
    if (facts.paths > L.maxPaths) out.push({ code: 'BS_PATHS', path: 'decisions', message: `hay ${facts.paths} caminos distintos (máximo ${L.maxPaths})` });
    if (facts.maxDepthAll > L.maxDepth) out.push({ code: 'BS_DEPTH', path: 'decisions', message: `un camino recorre ${facts.maxDepthAll} decisiones (máximo ${L.maxDepth})` });
    if (facts.maxDepthAll < 2) out.push({ code: 'BS_DEPTH', path: 'decisions', message: 'ningún camino recorre 2 o más decisiones' });
    const optimal = [...endings].filter(([, e]) => e.quality === 'optimal');
    const poor = [...endings].filter(([, e]) => e.quality === 'poor');
    if (optimal.length > L.maxOptimal) out.push({ code: 'BS_ENDINGS', path: 'endings', message: `máximo ${L.maxOptimal} finales "optimal" (hay ${optimal.length})` });
    if (!poor.length) out.push({ code: 'BS_ENDINGS', path: 'endings', message: 'falta al menos un final "poor"' });
    if (!optimal.some(([eid]) => (facts.endingDepth[eid] ?? 0) >= 2)) {
      out.push({ code: 'BS_ENDINGS', path: 'endings', message: 'ningún final "optimal" se alcanza tras 2 o más decisiones' });
    }
  }
  // ≤ 8 nodos H5P (situación + decisiones), aunque la lista ya haya fallado por cantidad.
  if (Array.isArray(data.decisions) && 1 + data.decisions.length > L.maxContentNodes) {
    out.push({ code: 'BS_NODES', path: 'decisions', message: `máximo ${L.maxContentNodes} nodos H5P (situación + ${data.decisions.length} decisiones)` });
  }
  return out;
}

function analyzeGraph(edges: Array<Array<{ decision?: number; ending?: string }>>): {
  reachedDecisions: Set<number>;
  endingDepth: Record<string, number>;
  paths: number;
  maxDepthAll: number;
} {
  // DAG (solo aristas hacia adelante) ⇒ DFS acotado. Nodo raíz = decisión 0.
  const reachedDecisions = new Set<number>();
  const endingDepth: Record<string, number> = {};
  let paths = 0;
  let maxDepthAll = 0;
  const PATH_CAP = 10000;
  const dfs = (i: number, depth: number): void => {
    if (paths > PATH_CAP) return;
    reachedDecisions.add(i);
    if (depth > maxDepthAll) maxDepthAll = depth;
    for (const e of edges[i]) {
      if (e.ending !== undefined) {
        paths++;
        endingDepth[e.ending] = Math.max(endingDepth[e.ending] ?? 0, depth);
      } else if (e.decision !== undefined) {
        dfs(e.decision, depth + 1);
      }
    }
  };
  dfs(0, 1);
  return { reachedDecisions, endingDepth, paths, maxDepthAll };
}

/** Lanza H5pInputError("H5P_INPUT_INVALID(BranchingScenario): …") con todos los problemas `[CODE] path: msg`. */
export function validateBranchingScenarioInput(input: unknown): asserts input is BranchingScenarioInput {
  const issues: string[] = [];
  if (isPlainObject(input)) {
    const keyIssues = new Issues();
    checkItemKey(keyIssues, input.itemKey);
    issues.push(...keyIssues.list.map((m) => `[BS_SHAPE] ${m}`));
  }
  for (const e of validateBranchingScenarioData(input, { allowItemKey: true })) issues.push(`[${e.code}] ${e.path}: ${e.message}`);
  if (issues.length) throw new H5pInputError('BranchingScenario', issues);
}

const P = (s: string): string => `<p>${escapeText(s)}</p>`;

function paragraphs(s: string): string {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => P(l))
    .join('');
}

const NODE_COMMON = Object.freeze({
  showContentTitle: false,
  proceedButtonText: 'Continuar',
  contentBehaviour: 'useBehavioural',
  forceContentFinished: 'useBehavioural',
});

export function buildBranchingScenario(input: BranchingScenarioInput): H5pBuiltContent {
  validateBranchingScenarioInput(input);
  const scores = BRANCHING_SCENARIO_ENDING_SCORES;
  const nodeOf = new Map(input.decisions.map((d, i) => [d.id, i + 1]));
  const endingOf = new Map(input.endings.map((e) => [e.id, e]));
  const sub = (i: number): string => h5pSubContentId(input.itemKey, i, h5pProfileVersionV2);
  const content: Array<Record<string, unknown>> = [
    {
      type: {
        library: 'H5P.AdvancedText 1.1',
        params: { text: paragraphs(input.situation) },
        subContentId: sub(0),
        metadata: { contentType: 'Text', license: 'U', title: 'Situación' },
      },
      ...NODE_COMMON,
      nextContentId: 1,
      feedback: { subtitle: '' },
    },
  ];
  input.decisions.forEach((d, i) => {
    const alternatives = d.options.map((o) => {
      if (o.next.startsWith('end:')) {
        const e = endingOf.get(o.next.slice(4))!;
        const subtitle = (o.consequence ? P(o.consequence) : '') + P(e.text);
        return { text: escapeText(o.text), nextContentId: -1, feedback: { title: P(e.title), subtitle, endScreenScore: scores[e.quality] } };
      }
      const target = nodeOf.get(o.next)!;
      return {
        text: escapeText(o.text),
        nextContentId: target,
        feedback: o.consequence ? { title: P('Consecuencia de tu decisión'), subtitle: P(o.consequence) } : { title: '' },
      };
    });
    content.push({
      type: {
        library: 'H5P.BranchingQuestion 1.0',
        params: { branchingQuestion: { question: P(d.question), alternatives } },
        subContentId: sub(i + 1),
        metadata: { contentType: 'Branching Question', license: 'U', title: `Decisión ${i + 1}` },
      },
      ...NODE_COMMON,
      feedback: { subtitle: '' },
    });
  });
  const title = input.title.trim();
  const params = applyH5pL10n('H5P.BranchingScenario', {
    branchingScenario: {
      title: escapeText(title),
      startScreen: {
        startScreenTitle: P(title),
        startScreenSubtitle: P('Toma las decisiones como lo harías en tu trabajo. Cada final tiene un puntaje.'),
      },
      endScreens: [{ endScreenTitle: P('Fin del caso'), endScreenSubtitle: P('Revisa tus decisiones.'), contentId: -1, endScreenScore: 0 }],
      content,
      scoringOptionGroup: { scoringOption: 'static-end-score', includeInteractionsScores: false },
      behaviour: { enableBackwardsNavigation: false, forceContentFinished: false, randomizeBranchingQuestions: false },
    },
  });
  assertBranchingScenarioContent(params);
  return {
    mainLibrary: 'H5P.BranchingScenario',
    title,
    content: params,
    subContentIds: content.map((c) => (c.type as { subContentId: string }).subContentId),
    maxScore: BRANCHING_SCENARIO_MAX_SCORE,
  };
}

/**
 * Re-afirma las invariantes del contenido H5P ya mapeado (el empaque nunca
 * confía en el builder): índices en rango, nodo 0 → 1, -1 solo con
 * endScreenScore numérico, feedback en todo nodo, ≤ 8 nodos, puntaje máximo 10.
 */
export function assertBranchingScenarioContent(params: unknown): void {
  const bad: string[] = [];
  const bs = isPlainObject(params) && isPlainObject(params.branchingScenario) ? params.branchingScenario : null;
  const content = bs && Array.isArray(bs.content) ? (bs.content as Array<Record<string, any>>) : null;
  if (!content || !content.length) throw new Error('H5P_BS_INVARIANT: branchingScenario.content vacío');
  const n = content.length;
  if (n > BRANCHING_SCENARIO_LIMITS.maxContentNodes) bad.push(`${n} nodos (máximo ${BRANCHING_SCENARIO_LIMITS.maxContentNodes})`);
  let maxEnd = -Infinity;
  content.forEach((c, i) => {
    if (!isPlainObject(c.feedback)) bad.push(`nodo ${i} sin feedback`);
    if (c.proceedButtonText !== 'Continuar') bad.push(`nodo ${i} sin proceedButtonText`);
    const lib = c.type && c.type.library;
    if (lib === 'H5P.BranchingQuestion 1.0') {
      const alts = c.type.params?.branchingQuestion?.alternatives;
      if (!Array.isArray(alts) || alts.length < 2) bad.push(`nodo ${i}: alternativas inválidas`);
      else
        alts.forEach((a: Record<string, any>, j: number) => {
          if (!isPlainObject(a.feedback)) bad.push(`nodo ${i} alternativa ${j} sin feedback`);
          if (a.nextContentId === -1) {
            if (typeof a.feedback?.endScreenScore !== 'number') bad.push(`nodo ${i} alternativa ${j}: -1 sin endScreenScore`);
            else maxEnd = Math.max(maxEnd, a.feedback.endScreenScore);
          } else if (!Number.isInteger(a.nextContentId) || a.nextContentId <= i || a.nextContentId >= n) {
            bad.push(`nodo ${i} alternativa ${j}: nextContentId ${a.nextContentId} fuera de rango`);
          } else if (a.feedback && a.feedback.endScreenScore !== undefined) {
            bad.push(`nodo ${i} alternativa ${j}: endScreenScore sin terminar`);
          }
        });
    } else if (lib === 'H5P.AdvancedText 1.1') {
      if (i !== 0 || c.nextContentId !== 1) bad.push(`nodo ${i}: la situación debe ser el nodo 0 con nextContentId 1`);
    } else {
      bad.push(`nodo ${i}: librería no permitida ${String(lib)}`);
    }
  });
  if (maxEnd !== BRANCHING_SCENARIO_MAX_SCORE) bad.push(`puntaje máximo de los finales ${maxEnd} ≠ ${BRANCHING_SCENARIO_MAX_SCORE}`);
  const sc = bs!.scoringOptionGroup as Record<string, unknown> | undefined;
  if (!sc || sc.scoringOption !== 'static-end-score' || sc.includeInteractionsScores !== false) bad.push('scoringOptionGroup debe ser static-end-score sin interacciones');
  if (bad.length) throw new Error(`H5P_BS_INVARIANT: ${bad.join('; ')}`);
}
