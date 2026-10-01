/**
 * R2 — Visual Components: schema (vcSchemaVersion 1).
 *
 * Pipeline (audit §G): LLM → JSON estricto → validateExperience() → render → HTML de label.
 * El LLM nunca produce HTML: todo campo de texto es texto plano con un `**énfasis**`
 * limitado. Nada calificable vive aquí (lo calificable va en H5P, SCORM o quiz).
 *
 * El schema es DATA (VC_COMPONENT_SPECS): el validador lo recorre genéricamente, así
 * que agregar un campo o ajustar un límite es un cambio de una línea.
 */

export const VC_SCHEMA_VERSION = 1;

export type VcComponentType =
  | 'hero'
  | 'learning_objectives'
  | 'concept_cards'
  | 'reveal_cards'
  | 'accordion'
  | 'tabs'
  | 'timeline'
  | 'process_steps'
  | 'comparison'
  | 'myth_reality'
  | 'case_scenario'
  | 'checklist'
  | 'reflection'
  | 'callout'
  | 'summary_visual'
  | 'self_check'
  | 'worked_example'
  | 'diagram';

export type VcCalloutVariant = 'tip' | 'warning' | 'info' | 'example';

/** P3 — «¿Por qué importa?» (why) y «¿Cómo lo aplicas?» (apply), opcionales. */
export interface VcEduFields {
  why?: string;
  apply?: string;
}

export interface VcHero { type: 'hero'; eyebrow?: string; title: string; lead: string }
export interface VcLearningObjectives { type: 'learning_objectives'; title?: string; items: string[] }
export interface VcConceptCards extends VcEduFields { type: 'concept_cards'; title?: string; cards: { term: string; definition: string }[] }
export interface VcRevealCards { type: 'reveal_cards'; title?: string; cards: { front: string; back: string }[] }
export interface VcAccordion extends VcEduFields { type: 'accordion'; title?: string; items: { heading: string; body: string }[] }
export interface VcTabs extends VcEduFields { type: 'tabs'; title?: string; tabs: { label: string; body: string }[] }
export interface VcTimeline extends VcEduFields { type: 'timeline'; title?: string; events: { marker: string; heading: string; body: string }[] }
export interface VcProcessSteps extends VcEduFields { type: 'process_steps'; title?: string; steps: { heading: string; body: string }[] }
export interface VcComparison extends VcEduFields {
  type: 'comparison';
  title?: string;
  /** Sujetos comparados (encabezados de columna), 2–4. */
  columns: string[];
  /** Criterios (filas), 2–8; `cells.length === columns.length`. */
  rows: { label: string; cells: string[] }[];
}
export interface VcMythReality extends VcEduFields { type: 'myth_reality'; title?: string; pairs: { myth: string; reality: string }[] }
export interface VcCaseScenario extends VcEduFields { type: 'case_scenario'; title: string; narrative: string; questions: string[] }
export interface VcChecklist extends VcEduFields { type: 'checklist'; title?: string; items: string[] }
export interface VcReflection { type: 'reflection'; prompt: string; hint?: string }
export interface VcCallout { type: 'callout'; variant: VcCalloutVariant; title?: string; body: string; apply?: string }
export interface VcSummaryVisual { type: 'summary_visual'; central: string; points: string[] }
export interface VcSelfCheck { type: 'self_check'; title?: string; items: { q: string; a: string }[] }
/**
 * Edu Phase A — ejemplo resuelto: un caso COMPLETO (situación con datos → proceso → resultado).
 * Los datos son ilustrativos (hipotéticos): se permiten cifras y porcentajes en este componente,
 * nunca cantidades de la estructura del curso (ver lintQuantityClaims, modo ilustrativo).
 */
export interface VcWorkedExample extends VcEduFields {
  type: 'worked_example';
  title: string;
  situation: string;
  data: string[];
  steps: { action: string; detail: string }[];
  result: string;
  takeaway?: string;
}
/** Formas de diagrama que se describen con `nodes`. */
export type VcNodeDiagramKind = 'cycle' | 'flow' | 'hierarchy' | 'matrix';
export type VcDiagramKind = VcNodeDiagramKind | 'decision';
/**
 * Edu Phase A — diagrama educativo. Formas fijas; el LLM llena nodos, Cursia dibuja
 * (HTML/CSS + SVG decorativo en ENHANCED; lista/tabla legible en CLEAN_SAFE).
 *  - cycle / flow: 3–6 nodos en orden.
 *  - hierarchy: nodes[0] = raíz, el resto (2–5) sus componentes.
 *  - matrix: exactamente 4 cuadrantes [arriba-izq, arriba-der, abajo-izq, abajo-der] + x_axis/y_axis
 *    (cada eje crece hacia la derecha / hacia arriba).
 */
export interface VcNodeDiagram extends VcEduFields {
  type: 'diagram';
  kind: VcNodeDiagramKind;
  title: string;
  caption?: string;
  nodes: { label: string; detail?: string }[];
  x_axis?: string;
  y_axis?: string;
}
/**
 * EV6 — árbol de decisión (kind "decision"): una pregunta con dos ramas (Sí / No); cada rama
 * termina en una acción o abre otra pregunta. Reemplaza al flujo "1 ¿Responde? → 2 Sí → …"
 * que enseñaba como secuencia algo que se ramifica. Límites en VC_DECISION_LIMITS.
 */
export interface VcDecisionBranch {
  /** Rótulo de la rama (por defecto «Sí» / «No»). */
  label?: string;
  /** Acción final (exactamente una de action | tree). */
  action?: string;
  /** Otra pregunta (exactamente una de action | tree). */
  tree?: VcDecisionNode;
}
export interface VcDecisionNode {
  question: string;
  yes: VcDecisionBranch;
  no: VcDecisionBranch;
}
export interface VcDecisionDiagram extends VcEduFields {
  type: 'diagram';
  kind: 'decision';
  title?: string;
  caption?: string;
  tree: VcDecisionNode;
}
export type VcDiagram = VcNodeDiagram | VcDecisionDiagram;

export type VcComponent =
  | VcHero
  | VcLearningObjectives
  | VcConceptCards
  | VcRevealCards
  | VcAccordion
  | VcTabs
  | VcTimeline
  | VcProcessSteps
  | VcComparison
  | VcMythReality
  | VcCaseScenario
  | VcChecklist
  | VcReflection
  | VcCallout
  | VcSummaryVisual
  | VcSelfCheck
  | VcWorkedExample
  | VcDiagram;

export type VcMovementId = 'opening' | 'deepening' | 'synthesis' | 'closing' | 'video_primer' | 'self_check';

export interface ChapterExperience {
  vcSchemaVersion: 1;
  chapterId: string;
  movements: Record<VcMovementId, VcComponent[]>;
  bridge_to_next: string;
}

// ─── Field specs (data) ─────────────────────────────────────────────────────

export type VcFieldSpec =
  | { kind: 'text'; max: number; optional?: boolean }
  | { kind: 'enum'; values: readonly string[]; optional?: boolean }
  | { kind: 'textList'; min: number; max: number; itemMax: number; optional?: boolean }
  | { kind: 'objList'; min: number; max: number; fields: Record<string, VcFieldSpec>; optional?: boolean };

const T = (max: number, optional = false): VcFieldSpec => ({ kind: 'text', max, optional });
const TITLE = T(120, true);
/**
 * P3 — campos opcionales «¿Por qué importa?» / «¿Cómo lo aplicas?» (una frase cada uno) en los bloques
 * de contenido. Opcionales SIEMPRE en el schema (las experiencias viejas no los tienen); desde el
 * prompt v21-exp-6 la validación del item exige un mínimo (validateEduFields, pedagogy.ts).
 */
const WHY = T(160, true);
const APPLY = T(200, true);
const EDU = { why: WHY, apply: APPLY };

export const VC_CALLOUT_VARIANTS: readonly VcCalloutVariant[] = ['tip', 'warning', 'info', 'example'];
export const VC_DIAGRAM_KINDS: readonly VcDiagramKind[] = ['cycle', 'flow', 'hierarchy', 'matrix', 'decision'];
/** Nodos por forma de diagrama [min, max] (además del rango genérico 2–8 del spec). */
export const VC_DIAGRAM_NODES: Record<VcNodeDiagramKind, [number, number]> = {
  cycle: [3, 6],
  flow: [3, 6],
  hierarchy: [3, 6],
  matrix: [4, 4],
};
/**
 * EV6 — árbol de decisión: la pregunta termina en «?»; profundidad = preguntas en un camino.
 * La forma (question/yes/no, label/action/tree) la valida validate.ts (el árbol es recursivo:
 * no entra en VC_COMPONENT_SPECS).
 */
export const VC_DECISION_LIMITS = { questionMax: 90, actionMax: 90, labelMax: 24, maxDepth: 3, maxQuestions: 4 } as const;
/** Campos de primer nivel de un diagrama "decision" (el `tree` se valida aparte). */
export const VC_DECISION_DIAGRAM_SPEC: Record<string, VcFieldSpec> = {
  kind: { kind: 'enum', values: ['decision'] },
  title: T(120, true),
  caption: T(300, true),
  ...EDU,
};
/** Tipos cuyos textos son datos ILUSTRATIVOS: cifras y % permitidos (no cantidades del curso). */
export const VC_ILLUSTRATIVE_TYPES: readonly VcComponentType[] = ['worked_example'];

/** Campos permitidos por tipo (additionalProperties: false). `type` es implícito. */
export const VC_COMPONENT_SPECS: Record<VcComponentType, Record<string, VcFieldSpec>> = {
  hero: { eyebrow: T(60, true), title: T(120), lead: T(400) },
  learning_objectives: { title: TITLE, items: { kind: 'textList', min: 2, max: 6, itemMax: 200 } },
  concept_cards: {
    ...EDU,
    title: TITLE,
    cards: { kind: 'objList', min: 2, max: 6, fields: { term: T(80), definition: T(400) } },
  },
  reveal_cards: {
    title: TITLE,
    cards: { kind: 'objList', min: 2, max: 6, fields: { front: T(200), back: T(500) } },
  },
  accordion: {
    ...EDU,
    title: TITLE,
    items: { kind: 'objList', min: 2, max: 8, fields: { heading: T(120), body: T(900) } },
  },
  tabs: {
    ...EDU,
    title: TITLE,
    tabs: { kind: 'objList', min: 2, max: 5, fields: { label: T(40), body: T(900) } },
  },
  timeline: {
    ...EDU,
    title: TITLE,
    events: { kind: 'objList', min: 3, max: 8, fields: { marker: T(40), heading: T(120), body: T(400) } },
  },
  process_steps: {
    ...EDU,
    title: TITLE,
    steps: { kind: 'objList', min: 3, max: 8, fields: { heading: T(120), body: T(400) } },
  },
  comparison: {
    ...EDU,
    title: TITLE,
    columns: { kind: 'textList', min: 2, max: 4, itemMax: 60 },
    rows: {
      kind: 'objList',
      min: 2,
      max: 8,
      fields: { label: T(80), cells: { kind: 'textList', min: 2, max: 4, itemMax: 240 } },
    },
  },
  myth_reality: {
    ...EDU,
    title: TITLE,
    pairs: { kind: 'objList', min: 1, max: 5, fields: { myth: T(240), reality: T(500) } },
  },
  case_scenario: {
    ...EDU,
    title: T(120),
    narrative: T(1200),
    questions: { kind: 'textList', min: 1, max: 4, itemMax: 240 },
  },
  checklist: { ...EDU, title: TITLE, items: { kind: 'textList', min: 3, max: 10, itemMax: 200 } },
  reflection: { prompt: T(400), hint: T(400, true) },
  callout: { variant: { kind: 'enum', values: VC_CALLOUT_VARIANTS }, title: T(80, true), body: T(600), apply: APPLY },
  summary_visual: { central: T(120), points: { kind: 'textList', min: 3, max: 5, itemMax: 200 } },
  self_check: {
    title: TITLE,
    items: { kind: 'objList', min: 2, max: 4, fields: { q: T(300), a: T(600) } },
  },
  worked_example: {
    ...EDU,
    title: T(120),
    situation: T(500),
    data: { kind: 'textList', min: 2, max: 6, itemMax: 160 },
    steps: { kind: 'objList', min: 3, max: 6, fields: { action: T(120), detail: T(400) } },
    result: T(400),
    takeaway: T(300, true),
  },
  diagram: {
    ...EDU,
    kind: { kind: 'enum', values: VC_DIAGRAM_KINDS },
    title: T(120),
    caption: T(300, true),
    nodes: { kind: 'objList', min: 2, max: 8, fields: { label: T(48), detail: T(160, true) } },
    x_axis: T(48, true),
    y_axis: T(48, true),
  },
};

export const VC_COMPONENT_TYPES = Object.keys(VC_COMPONENT_SPECS) as VcComponentType[];

export const VC_MOVEMENT_IDS: readonly VcMovementId[] = [
  'opening',
  'deepening',
  'synthesis',
  'closing',
  'video_primer',
  'self_check',
];

/** [min, max] componentes por movimiento. */
export const VC_MOVEMENT_LIMITS: Record<VcMovementId, [number, number]> = {
  opening: [1, 3],
  // Edu EV2: conceptos + explicación + ejemplo + recurso visual (+ uno más) → hasta 5.
  deepening: [1, 5],
  synthesis: [1, 2],
  closing: [1, 2],
  video_primer: [1, 2],
  self_check: [1, 1],
};

/** Mínimo de tipos distintos en todo el documento. */
export const VC_MIN_DISTINCT_TYPES = 2;
/** §G.3: no repetir el mismo tipo más de N veces por capítulo. */
export const VC_MAX_SAME_TYPE = 2;

export const VC_CHAPTER_ID_MAX = 80;
export const VC_BRIDGE_MAX = 300;

/** P3 — tipos que admiten `why` / `apply` (callout: solo `apply`). */
export const VC_EDU_WHY_TYPES: readonly VcComponentType[] = ['concept_cards', 'accordion', 'tabs', 'timeline', 'process_steps', 'comparison', 'myth_reality', 'case_scenario', 'checklist', 'worked_example', 'diagram'];
export const VC_EDU_APPLY_TYPES: readonly VcComponentType[] = [...VC_EDU_WHY_TYPES, 'callout'];
