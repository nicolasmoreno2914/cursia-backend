/**
 * EV5-C — tipo H5P de la actividad de práctica elegido por el OBJETIVO del
 * capítulo (auditoría P2: 7/7 actividades reales eran DragText/Blanks de
 * recordar vocabulario bajo objetivos como «Diseñar estrategias…»).
 *
 * Módulo PURO (sin DB, reloj ni azar) y determinístico: el tipo se decide y se
 * CONGELA al construir el Manifest v3 (`item.h5pType`, solo con el marcador
 * `features.activityTypeRules = 1`). Los Manifests guardados sin marcador
 * siguen con la rotación por hash (`activityTypeForChapter`), así que nada de
 * lo ya generado cambia de tipo.
 *
 * Reglas v1 (rulings del dueño, 2026-09-30):
 *  - Entrada por capítulo: objective; si no clasifica, title; si no,
 *    description. Texto plegado (minúsculas, sin tildes: «Diseñar» → «disenar»).
 *    Dentro de un texto gana el verbo (raíz) que aparece PRIMERO; si ningún
 *    verbo clasifica, se prueban las pistas de sustantivo (títulos nominales:
 *    «Análisis de…», «Glosario de…»), también la primera que aparece.
 *  - Intención → tipo (INTENT_TO_TYPE_V1):
 *      recall     → blanks      (ruling: recordar = completar huecos, no dragtext)
 *      relate     → dragtext
 *      apply      → questionset (preguntas de escenario)
 *      reflect    → questionset (hasta que exista un tipo ensayo)
 *      understand → questionset (ruling: explicar/comprender = questionset)
 *  - Nada clasificado → la rotación de siempre `activityTypeForChapter(id)`.
 *  - Sin override por capítulo (ruling): el tipo sale solo de estas reglas.
 *  - Balance por curso (ruling): al menos max(1, floor(n/3)) questionset entre
 *    las n actividades h5p, SIN tope. Si faltan, se promueven a questionset
 *    en este orden de grupo: fallback (sin clasificar) → relate → recall;
 *    dentro del grupo por fnv1a32(chapterId en minúsculas) ascendente (empate
 *    → chapterId). Nunca depende del orden de módulos/capítulos: el mismo
 *    conjunto de capítulos da el mismo resultado (reordenar es REUSE).
 *
 * Extensión: el clasificador devuelve una intención; `INTENT_TO_TYPE` por
 * versión de reglas. Unas reglas 2 podrían mapear a dialogcards /
 * branchingscenario cuando exista el pack H5P v2 (verificar que califiquen en
 * Moodle antes).
 */
import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import { ACTIVITY_H5P_ROTATION, activityTypeForChapter, fnv1a32 } from '../course-shell/activity-type';

/** Tipos H5P calificados asignables a una actividad (sin singlechoiceset, R-011). */
export type GradedH5pActivityType = 'questionset' | 'dragtext' | 'blanks';

/** Valores del marcador `features.activityTypeRules` (0 = ausente = rotación por hash). */
export type ActivityTypeRulesVersion = 0 | 1;

export type ActivityIntent = 'recall' | 'relate' | 'apply' | 'reflect' | 'understand';

export const INTENT_TO_TYPE_V1: Readonly<Record<ActivityIntent, GradedH5pActivityType>> = Object.freeze({
  recall: 'blanks',
  relate: 'dragtext',
  apply: 'questionset',
  reflect: 'questionset',
  understand: 'questionset',
});

/**
 * Raíces verbales (texto plegado, prefijo de palabra). Incluye las formas del
 * subjuntivo que cambian la raíz («conozca», «analice», «organice», «resuelva»,
 * «distinga») porque los objetivos suelen redactarse «Que el estudiante …».
 */
export const VERB_STEMS_V1: Readonly<Record<ActivityIntent, readonly string[]>> = Object.freeze({
  recall: ['recorda', 'recuerd', 'identific', 'defin', 'reconoc', 'reconozc', 'nombr', 'enumer', 'memoriz', 'memoric', 'conoc', 'conozc'],
  relate: [
    'relacion', 'clasific', 'compar', 'disting', 'diferenci', 'asoci', 'orden', 'organiz', 'organic',
    'secuenci', 'vincul', 'contrast', 'categoriz', 'categoric',
  ],
  apply: [
    'aplic', 'decid', 'analiz', 'analic', 'evalu', 'disen', 'resolv', 'resuelv', 'calcul', 'implement', 'planific',
    'elabor', 'constru', 'gestion', 'ejecut', 'selecc', 'propon', 'diagnost', 'negoci',
  ],
  reflect: ['reflexion', 'argument', 'valor'],
  understand: ['explic', 'describ', 'comprend', 'interpret', 'resum', 'entend', 'entiend'],
});

/**
 * Palabras que empiezan con una raíz verbal pero en los títulos suelen ser
 * sustantivos sin intención («cadena de valor», «orden de compra», «nombre
 * comercial»): no clasifican.
 */
export const NON_VERB_WORDS_V1: ReadonlySet<string> = new Set([
  'valor', 'valores', 'orden', 'ordenes', 'nombre', 'nombres',
]);

/**
 * Pistas de sustantivo (prefijo de palabra plegada) para títulos nominales;
 * solo cuentan si ningún verbo clasificó ese mismo texto.
 */
export const NOUN_CUES_V1: Readonly<Record<ActivityIntent, readonly string[]>> = Object.freeze({
  recall: ['glosari', 'terminolog', 'vocabulari', 'nomenclatur'],
  relate: ['tipos', 'tipolog', 'etapas', 'fases'],
  apply: ['analisis', 'estrategi', 'caso', 'practica', 'resolucion', 'solucion'],
  reflect: ['etica'],
  understand: ['concepto', 'fundamento', 'introduccion', 'principio'],
});

/** Orden fijo de intenciones para resolver una palabra que calce con dos raíces (no ocurre con las listas v1). */
const INTENT_ORDER: readonly ActivityIntent[] = ['recall', 'relate', 'apply', 'reflect', 'understand'];

/** Minúsculas, sin tildes/diéresis (ñ → n), palabras [a-z0-9]. */
export function foldText(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

function verbIntentOf(word: string): ActivityIntent | null {
  if (NON_VERB_WORDS_V1.has(word)) return null;
  for (const intent of INTENT_ORDER) {
    if (VERB_STEMS_V1[intent].some((stem) => word.startsWith(stem))) return intent;
  }
  return null;
}

function nounIntentOf(word: string): ActivityIntent | null {
  for (const intent of INTENT_ORDER) {
    if (NOUN_CUES_V1[intent].some((c) => word.startsWith(c))) return intent;
  }
  return null;
}

/** Intención de un texto: primer verbo que clasifica; si no hay, primera pista de sustantivo. */
export function classifyTextIntent(text: string | null | undefined): ActivityIntent | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const words = foldText(text);
  for (const w of words) {
    const v = verbIntentOf(w);
    if (v) return v;
  }
  for (const w of words) {
    const n = nounIntentOf(w);
    if (n) return n;
  }
  return null;
}

/** Intención del capítulo: objective → title → description (el primero que clasifique). */
export function classifyChapterIntent(ch: { objective?: string | null; title?: string | null; description?: string | null }): ActivityIntent | null {
  return classifyTextIntent(ch.objective) ?? classifyTextIntent(ch.title) ?? classifyTextIntent(ch.description);
}

export interface ActivityTypeDecision {
  chapterId: string;
  type: GradedH5pActivityType;
  /** null = no clasificó (tipo base = rotación por hash). */
  intent: ActivityIntent | null;
  /** true si el balance lo promovió a questionset. */
  promoted: boolean;
}

/** Mínimo de questionset por curso (ruling: max(1, floor(n/3)), sin tope). */
export function minQuestionsetsFor(n: number): number {
  return n <= 0 ? 0 : Math.max(1, Math.floor(n / 3));
}

/**
 * Reglas v1 sobre un Blueprint v2: tipo de cada capítulo con actividad h5p
 * (activityEnabled y course.activityEngine = 'h5p'). Motor scorm → mapa vacío.
 * Resultado indexado por chapterId; independiente del orden de entrada.
 */
export function chooseActivityTypesV1(snapshot: BlueprintSnapshotV2): Map<string, ActivityTypeDecision> {
  const out = new Map<string, ActivityTypeDecision>();
  if (!snapshot || snapshot.course?.activityEngine !== 'h5p') return out;
  for (const m of snapshot.modules ?? []) {
    for (const c of m.chapters ?? []) {
      if (c.activityEnabled !== true) continue;
      const intent = classifyChapterIntent(c);
      const type: GradedH5pActivityType = intent ? INTENT_TO_TYPE_V1[intent] : (activityTypeForChapter(c.id) as GradedH5pActivityType);
      out.set(c.id, { chapterId: c.id, type, intent, promoted: false });
    }
  }
  const need = minQuestionsetsFor(out.size) - [...out.values()].filter((d) => d.type === 'questionset').length;
  if (need > 0) {
    // Grupo 0 = fallback (sin clasificar), 1 = relate, 2 = recall. apply/reflect/understand ya son questionset.
    const group = (d: ActivityTypeDecision): number => (d.intent === null ? 0 : d.intent === 'relate' ? 1 : 2);
    const candidates = [...out.values()]
      .filter((d) => d.type !== 'questionset')
      .map((d) => ({ d, g: group(d), h: fnv1a32(d.chapterId.toLowerCase()) }))
      .sort((a, b) => a.g - b.g || a.h - b.h || (a.d.chapterId < b.d.chapterId ? -1 : a.d.chapterId > b.d.chapterId ? 1 : 0));
    for (const { d } of candidates.slice(0, need)) {
      d.type = 'questionset';
      d.promoted = true;
    }
  }
  return out;
}

/** Tipos válidos para `h5pType` (la rotación calificada). */
export function isGradedH5pActivityType(v: unknown): v is GradedH5pActivityType {
  return typeof v === 'string' && (ACTIVITY_H5P_ROTATION as readonly string[]).includes(v);
}
