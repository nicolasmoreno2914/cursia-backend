/**
 * EV5-C — tipo H5P de la actividad de práctica elegido por el OBJETIVO del
 * capítulo (auditoría P2: 7/7 actividades reales eran DragText/Blanks de
 * recordar vocabulario bajo objetivos como «Diseñar estrategias…»).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CONGELADO: cambiar cualquier lista = nuevas reglas (activityTypeRules 2) con
 * despacho propio; rules 1 debe quedar byte-idéntico para siempre.
 * El validador del Manifest recalcula `h5pType` con ESTE código para todo
 * Manifest guardado con activityTypeRules = 1: si una lista (verbos, raíces
 * irregulares, terminaciones, lista negra, pistas de sustantivo, rangos,
 * mapeo) cambia, esos Manifests dejan de validar (500 de integridad). El test
 * `check-v21-activity-type-rules.js` fija el sha256 de la serialización
 * canónica de todas las listas (`activityTypeRulesV1ListsSha256`).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Módulo PURO (sin DB, reloj ni azar) y determinístico: el tipo se decide y se
 * CONGELA al construir el Manifest v3 (`item.h5pType`, solo con el marcador
 * `features.activityTypeRules = 1`). Los Manifests guardados sin marcador
 * siguen con la rotación por hash (`activityTypeForChapter`).
 *
 * Reglas v1 (rulings del dueño, 2026-09-30 + review fix round 1):
 *  - Cascada por capítulo: objective → title → description (el primero que
 *    clasifique). En objective y title cuentan verbos y, si no hay ninguno,
 *    pistas de sustantivo; en description SOLO pistas de sustantivo (una
 *    descripción narra, no declara la intención).
 *  - Un VERBO es solo una forma verbal: raíz + terminación de VERB_ENDINGS_V1
 *    (infinitivo, 3.ª persona/imperativo, subjuntivo, gerundio, enclíticos).
 *    Las nominalizaciones (-ción, -sión, -miento, -anza, -ncia, -dor/-dora),
 *    los participios/adjetivos (-ado, -ido) y los adverbios (-mente) nunca
 *    calzan porque no son terminaciones de la lista; los sustantivos que SÍ
 *    coinciden con una forma verbal («nombre», «resumen», «secuencia»,
 *    «diferencia», «fórmula»…) están en NON_VERB_WORDS_V1.
 *  - Con varios verbos (o varias pistas) gana el de MAYOR nivel cognitivo
 *    (INTENT_RANK_V1: apply > reflect > relate > understand > recall):
 *    «Identificar … y aplicar …» ⇒ apply. Ya no gana el más temprano.
 *  - Intención → tipo (INTENT_TO_TYPE_V1):
 *      recall     → blanks      (ruling: recordar = completar huecos, no dragtext)
 *      relate     → dragtext
 *      apply      → questionset (preguntas de escenario)
 *      reflect    → questionset (hasta que exista un tipo ensayo)
 *      understand → questionset (ruling: explicar/comprender = questionset)
 *  - Nada clasificado → la rotación de siempre `activityTypeForChapter(id)`.
 *  - Sin override por capítulo (ruling): el tipo sale solo de estas reglas.
 *  - Balance por curso (ruling): al menos max(1, floor(n/3)) questionset entre
 *    las n actividades h5p, SIN tope (ver chooseActivityTypesV1).
 *
 * Extensión: el clasificador devuelve una intención; `INTENT_TO_TYPE` por
 * versión de reglas. Unas reglas 2 podrían mapear a dialogcards /
 * branchingscenario cuando exista el pack H5P v2 (verificar que califiquen en
 * Moodle antes).
 */
import { createHash } from 'crypto';
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
 * Nivel cognitivo (mayor gana cuando un texto trae varias intenciones).
 * Requisito de la review: aplicar/decidir/diseñar > relacionar > recordar.
 * reflect (evaluar/argumentar) va debajo de apply; understand (explicar)
 * entre relate y recall, como en Bloom (comprender < analizar).
 */
export const INTENT_RANK_V1: Readonly<Record<ActivityIntent, number>> = Object.freeze({
  apply: 5,
  reflect: 4,
  relate: 3,
  understand: 2,
  recall: 1,
});

/** Verbos por intención, en infinitivo plegado (sin tildes, ñ → n). */
export const VERBS_V1: Readonly<Record<ActivityIntent, readonly string[]>> = Object.freeze({
  recall: [
    'recordar', 'identificar', 'definir', 'reconocer', 'nombrar', 'enumerar', 'memorizar', 'conocer', 'mencionar', 'senalar',
  ],
  relate: [
    'relacionar', 'clasificar', 'comparar', 'distinguir', 'diferenciar', 'asociar', 'ordenar', 'organizar', 'secuenciar',
    'vincular', 'contrastar', 'categorizar', 'jerarquizar',
  ],
  apply: [
    'aplicar', 'decidir', 'analizar', 'evaluar', 'disenar', 'resolver', 'calcular', 'implementar', 'planificar', 'elaborar',
    'construir', 'gestionar', 'ejecutar', 'seleccionar', 'proponer', 'diagnosticar', 'negociar', 'elegir', 'establecer',
    'usar', 'utilizar', 'adaptar', 'detectar', 'revisar', 'auditar', 'formular', 'redactar', 'prevenir', 'crear',
    'convertir', 'generar', 'fijar', 'desarrollar', 'solucionar', 'optimizar', 'controlar', 'administrar', 'manejar',
    'preparar', 'estimar', 'priorizar', 'verificar', 'liderar', 'atender', 'operar', 'mejorar',
  ],
  reflect: ['reflexionar', 'argumentar', 'valorar', 'justificar', 'debatir'],
  understand: ['explicar', 'describir', 'comprender', 'interpretar', 'resumir', 'entender', 'parafrasear', 'ejemplificar', 'ilustrar'],
});

/** Raíces irregulares (cambio de vocal/consonante que las reglas ortográficas no derivan). */
export const IRREGULAR_ROOTS_V1: Readonly<Record<string, readonly string[]>> = Object.freeze({
  recordar: ['recuerd'],
  elegir: ['elig', 'elij'],
  resolver: ['resuelv'],
  entender: ['entiend'],
  atender: ['atiend'],
  proponer: ['propong'],
  convertir: ['conviert', 'convirt'],
  prevenir: ['preveng', 'previen'],
});

/**
 * Terminaciones verbales aceptadas tras la raíz: infinitivo, 3.ª persona e
 * imperativo (-a/-an/-e/-en), subjuntivo (-a/-e…), gerundio y enclíticos.
 * Deliberadamente SIN -o/-os/-as/-es/-ado/-ido/-ción/-miento/-dor/-mente: esas
 * terminaciones producen sobre todo sustantivos/adjetivos («diseño», «uso»,
 * «cálculo», «negocio», «aplicado», «ordenador», «conocimiento»).
 */
export const VERB_ENDINGS_V1: readonly string[] = Object.freeze([
  'ar', 'er', 'ir', 'a', 'an', 'e', 'en', 'ando', 'iendo', 'yendo',
  'arlo', 'arla', 'arlos', 'arlas', 'arse', 'erlo', 'erla', 'erlos', 'erlas', 'erse', 'irlo', 'irla', 'irlos', 'irlas', 'irse',
]);

/** Sustantivos/adjetivos que coinciden EXACTO con una forma verbal generada: nunca cuentan como verbo. */
export const NON_VERB_WORDS_V1: ReadonlySet<string> = new Set([
  'nombre', 'resumen', 'secuencia', 'diferencia', 'contraste', 'formula', 'fija', 'cree', 'creen', 'mejora', 'opera',
  'estima', 'interprete', 'valor', 'valores', 'orden', 'ordenes', 'uso', 'usos', 'diseno', 'calculo', 'negocio',
  'lista', 'critica', 'practica', 'debate',
]);

/**
 * Pistas de sustantivo (palabra plegada EXACTA) para títulos nominales y
 * descripciones. Solo cuentan si el texto no trae ningún verbo (en
 * description, siempre: allí no cuentan verbos).
 */
export const NOUN_CUES_V1: Readonly<Record<ActivityIntent, readonly string[]>> = Object.freeze({
  recall: ['glosario', 'terminologia', 'vocabulario', 'nomenclatura'],
  relate: ['tipos', 'tipologia', 'tipologias', 'etapas', 'fases', 'clasificacion', 'comparacion', 'diferencias'],
  apply: [
    'analisis', 'estrategia', 'estrategias', 'caso', 'casos', 'diseno', 'planificacion', 'diagnostico', 'negociacion',
    'resolucion', 'solucion', 'soluciones', 'gestion', 'calculo', 'calculos', 'prevencion',
  ],
  reflect: ['etica'],
  understand: ['concepto', 'conceptos', 'fundamentos', 'introduccion', 'principios', 'nociones'],
});

const INTENTS_BY_RANK: readonly ActivityIntent[] = (Object.keys(INTENT_RANK_V1) as ActivityIntent[])
  .sort((a, b) => INTENT_RANK_V1[b] - INTENT_RANK_V1[a]);

/** Raíces de un infinitivo: la base + variantes ortográficas del subjuntivo + irregulares. */
export function verbRootsV1(infinitive: string): string[] {
  const root = infinitive.slice(0, -2);
  const roots = [root];
  if (infinitive.endsWith('car')) roots.push(`${root.slice(0, -1)}qu`); // aplicar → apliqu-e
  if (infinitive.endsWith('zar')) roots.push(`${root.slice(0, -1)}c`); // analizar → analic-e
  if (infinitive.endsWith('guir')) roots.push(root.slice(0, -1)); // distinguir → disting-a
  else if (infinitive.endsWith('ger') || infinitive.endsWith('gir')) roots.push(`${root.slice(0, -1)}j`); // elegir → elij-a
  if (infinitive.endsWith('cer')) roots.push(`${root.slice(0, -1)}zc`); // conocer → conozc-a
  if (infinitive.endsWith('uir')) roots.push(`${root}y`); // construir → construy-a
  for (const r of IRREGULAR_ROOTS_V1[infinitive] ?? []) roots.push(r);
  return roots;
}

/** forma verbal plegada → intención (se arma una vez; un choque entre intenciones es un bug de las listas). */
const VERB_FORMS_V1: ReadonlyMap<string, ActivityIntent> = (() => {
  const out = new Map<string, ActivityIntent>();
  for (const intent of INTENTS_BY_RANK) {
    for (const inf of VERBS_V1[intent]) {
      for (const root of verbRootsV1(inf)) {
        for (const end of VERB_ENDINGS_V1) {
          const form = root + end;
          if (NON_VERB_WORDS_V1.has(form)) continue;
          const prev = out.get(form);
          if (prev && prev !== intent) {
            throw new Error(`ACTIVITY_TYPE_RULES_V1: la forma "${form}" calza con ${prev} y ${intent}`);
          }
          out.set(form, intent);
        }
      }
    }
  }
  return out;
})();

/** Intención verbal de una palabra plegada (null si no es una forma verbal de las listas). */
export function verbIntentOfWord(word: string): ActivityIntent | null {
  return VERB_FORMS_V1.get(word) ?? null;
}

function nounIntentOfWord(word: string): ActivityIntent | null {
  for (const intent of INTENTS_BY_RANK) if (NOUN_CUES_V1[intent].includes(word)) return intent;
  return null;
}

/** Minúsculas, sin tildes/diéresis (ñ → n), palabras [a-z0-9]. */
export function foldText(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

function highest(intents: ActivityIntent[]): ActivityIntent | null {
  let best: ActivityIntent | null = null;
  for (const i of intents) if (!best || INTENT_RANK_V1[i] > INTENT_RANK_V1[best]) best = i;
  return best;
}

/**
 * Intención de un texto: la de MAYOR nivel entre sus verbos; si no hay
 * verbos, la de mayor nivel entre sus pistas de sustantivo.
 * `nounsOnly` (description): solo pistas de sustantivo.
 */
export function classifyTextIntent(text: string | null | undefined, opts: { nounsOnly?: boolean } = {}): ActivityIntent | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const words = foldText(text);
  if (!opts.nounsOnly) {
    const v = highest(words.map(verbIntentOfWord).filter((x): x is ActivityIntent => x !== null));
    if (v) return v;
  }
  return highest(words.map(nounIntentOfWord).filter((x): x is ActivityIntent => x !== null));
}

/** Intención del capítulo: objective → title → description (esta última solo con pistas de sustantivo). */
export function classifyChapterIntent(ch: { objective?: string | null; title?: string | null; description?: string | null }): ActivityIntent | null {
  return classifyTextIntent(ch.objective) ?? classifyTextIntent(ch.title) ?? classifyTextIntent(ch.description, { nounsOnly: true });
}

/**
 * sha256 de la serialización canónica de TODAS las listas de las reglas v1
 * (orden fijo de claves; los arreglos en su orden declarado). El test lo fija:
 * si cambia, no es rules 1 (ver el encabezado CONGELADO).
 */
export function activityTypeRulesV1ListsSha256(): string {
  const intents: ActivityIntent[] = ['recall', 'relate', 'apply', 'reflect', 'understand'];
  const canonical = {
    intentToType: intents.map((i) => [i, INTENT_TO_TYPE_V1[i]]),
    intentRank: intents.map((i) => [i, INTENT_RANK_V1[i]]),
    verbs: intents.map((i) => [i, [...VERBS_V1[i]]]),
    irregularRoots: Object.keys(IRREGULAR_ROOTS_V1).sort().map((k) => [k, [...IRREGULAR_ROOTS_V1[k]]]),
    verbEndings: [...VERB_ENDINGS_V1],
    nonVerbWords: [...NON_VERB_WORDS_V1].sort(),
    nounCues: intents.map((i) => [i, [...NOUN_CUES_V1[i]]]),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
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
 *
 * Balance (ruling): al menos max(1, floor(n/3)) questionset, sin tope. Si
 * faltan, se promueven en orden de grupo fallback (sin clasificar) → relate →
 * recall; dentro del grupo por fnv1a32(chapterId en minúsculas) ascendente
 * (empate → chapterId). No depende del orden de módulos/capítulos.
 *
 * OJO (review, costo): el balance ACOPLA capítulos entre versiones del
 * Blueprint. Cambiar el objetivo de un capítulo, agregar/quitar uno o
 * prender/apagar una actividad puede cambiar cuántos questionset faltan y
 * así voltear el tipo de OTRO capítulo que no se tocó; la invalidación lo ve
 * como activity_type_changed y regenera esa actividad (costo LLM). Es
 * intencional (el curso nunca queda sin questionset), no un bug.
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
