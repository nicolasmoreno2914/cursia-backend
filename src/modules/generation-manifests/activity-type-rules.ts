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
 * canónica de todas las listas (`activityTypeRulesV1ListsSha256`) y el del
 * comportamiento derivado (`activityTypeRulesV1BehaviorSha256`: mapa
 * forma → intención generado, frases de sustantivo y orden del balance).
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
 *    (infinitivo, 3.ª persona/imperativo, subjuntivo, futuro, condicional,
 *    pretérito plural, gerundio, enclíticos también sobre el gerundio). El
 *    pretérito singular (-ó/-ió/-yó) exige la «ó» final escrita, y una tilde
 *    dentro de la raíz («diagnóstica», «cálculo») descarta la forma verbal.
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
/** Congela recursivamente (arreglos y objetos anidados): las listas v1 no se pueden mutar en runtime. */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const k of Object.keys(v as object)) deepFreeze((v as any)[k]);
    Object.freeze(v);
  }
  return v;
}

export type GradedH5pActivityType = 'questionset' | 'dragtext' | 'blanks';

/**
 * Valores del marcador `features.activityTypeRules` (0 = ausente = rotación por hash).
 * EV6 H5P v2: 2 = reglas v2 (activity-type-rules-v2.ts: intención «decide» → branchingscenario).
 */
export type ActivityTypeRulesVersion = 0 | 1 | 2;

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
export const VERBS_V1: Readonly<Record<ActivityIntent, readonly string[]>> = deepFreeze({
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
export const IRREGULAR_ROOTS_V1: Readonly<Record<string, readonly string[]>> = deepFreeze({
  recordar: ['recuerd'],
  elegir: ['elig', 'elij'],
  resolver: ['resuelv'],
  entender: ['entiend'],
  atender: ['atiend'],
  proponer: ['propong', 'propondr'],
  convertir: ['conviert', 'convirt'],
  prevenir: ['preveng', 'previen', 'previn', 'prevendr'],
});

/**
 * Terminaciones verbales aceptadas tras la raíz (texto plegado): infinitivo,
 * 3.ª persona e imperativo (-a/-an/-e/-en), subjuntivo, futuro (-ará/-erá/-irá
 * y demás personas), condicional (-aría/-ería/-iría…), pretérito 3.ª persona
 * plural (-aron/-ieron/-yeron), gerundio y enclíticos (también sobre el
 * gerundio: «aplicándolos»).
 * Deliberadamente SIN -o/-os/-as/-es/-ado/-ido/-ción/-miento/-dor/-mente: esas
 * terminaciones producen sobre todo sustantivos/adjetivos («diseño», «uso»,
 * «cálculo», «negocio», «aplicado», «ordenador», «conocimiento»).
 */
export const VERB_ENDINGS_V1: readonly string[] = deepFreeze([
  'ar', 'er', 'ir', 'a', 'an', 'e', 'en', 'ando', 'iendo', 'yendo',
  'arlo', 'arla', 'arlos', 'arlas', 'arse', 'erlo', 'erla', 'erlos', 'erlas', 'erse', 'irlo', 'irla', 'irlos', 'irlas', 'irse',
  // gerundio + enclítico
  'andolo', 'andola', 'andolos', 'andolas', 'andose', 'iendolo', 'iendola', 'iendolos', 'iendolas', 'iendose',
  'yendolo', 'yendola', 'yendolos', 'yendolas', 'yendose',
  // futuro
  'ara', 'aras', 'aremos', 'aran', 'era', 'eras', 'eremos', 'eran', 'ira', 'iras', 'iremos', 'iran',
  // condicional
  'aria', 'arias', 'ariamos', 'arian', 'eria', 'erias', 'eriamos', 'erian', 'iria', 'irias', 'iriamos', 'irian',
  // pretérito 3.ª persona plural
  'aron', 'ieron', 'yeron',
]);

/**
 * Pretérito 3.ª persona singular («aplicó», «decidió», «construyó»): plegado
 * termina en -o/-io/-yo, que choca con sustantivos («diseño», «uso»,
 * «negocio», «diagnóstico»). Solo cuenta si la palabra ORIGINAL termina en «ó».
 */
export const ACCENTED_PRETERITE_ENDINGS_V1: readonly string[] = deepFreeze(['o', 'io', 'yo']);

/**
 * Sustantivos/adjetivos que coinciden EXACTO con una forma verbal generada:
 * nunca cuentan como verbo (arreglo congelado; consulta con isNonVerbWordV1).
 * Trade-off conocido y aceptado: «opera», «mejora», «estima», «fórmula»
 * también son formas de operar/mejorar/estimar/formular, pero en títulos son
 * casi siempre sustantivos («Mejora continua», «Fórmula de costos»); se
 * pierde el verbo en 3.ª persona y ese capítulo cae al fallback (hash) salvo
 * que otra palabra clasifique. «diagnóstica(s)/diagnóstico» son adjetivo /
 * sustantivo («Evaluación diagnóstica»): «diagnostica(s)» sin tilde choca con
 * el verbo, así que se excluye; con tilde ya la descarta la regla de tildes.
 */
export const NON_VERB_WORDS_V1: readonly string[] = deepFreeze([
  'nombre', 'resumen', 'secuencia', 'diferencia', 'contraste', 'formula', 'fija', 'cree', 'creen', 'mejora', 'opera',
  'estima', 'interprete', 'valor', 'valores', 'orden', 'ordenes', 'usos', 'lista', 'critica', 'practica', 'debate',
  'diagnostica', 'diagnosticas', 'operaria', 'operarias',
]);
// «diseño», «uso», «cálculo», «negocio», «diagnóstico» NO van en la lista:
// solo coinciden con el pretérito («diseñó», «usó», «negoció»,
// «diagnosticó»), que exige la «ó» final, y «cálculo»/«diagnóstico» además
// llevan tilde dentro de la raíz. Ponerlos acá borraría esos pretéritos.
const NON_VERB_SET_V1: ReadonlySet<string> = new Set(NON_VERB_WORDS_V1);
export function isNonVerbWordV1(word: string): boolean {
  return NON_VERB_SET_V1.has(word);
}

/**
 * Pistas de sustantivo para títulos nominales y descripciones: palabra o
 * FRASE plegada exacta (las frases calzan como palabras contiguas: así
 * «evaluación de riesgos» es apply sin que «evaluación» sola voltee otros
 * títulos). Solo cuentan si el texto no trae ningún verbo (en description,
 * siempre: allí no cuentan verbos).
 */
export const NOUN_CUES_V1: Readonly<Record<ActivityIntent, readonly string[]>> = deepFreeze({
  recall: ['glosario', 'terminologia', 'vocabulario', 'nomenclatura'],
  relate: ['tipos', 'tipologia', 'tipologias', 'etapas', 'fases', 'clasificacion', 'comparacion', 'diferencias'],
  apply: [
    'analisis', 'estrategia', 'estrategias', 'caso', 'casos', 'diseno', 'planificacion', 'planeacion', 'diagnostico',
    'negociacion', 'resolucion', 'solucion', 'soluciones', 'gestion', 'calculo', 'calculos', 'prevencion', 'manejo',
    'evaluacion de riesgos', 'evaluacion del riesgo', 'evaluacion de riesgo', 'practica de laboratorio', 'practicas de laboratorio',
    'toma de decisiones', 'tomar decisiones', 'control de calidad',
  ],
  reflect: ['etica'],
  understand: ['concepto', 'conceptos', 'fundamentos', 'introduccion', 'principios', 'nociones'],
});

/** Orden de promoción del balance (grupos): fallback (sin clasificar) → relate → recall. */
export const BALANCE_PROMOTION_ORDER_V1: readonly ('fallback' | ActivityIntent)[] = deepFreeze(['fallback', 'relate', 'recall']);

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

/** Entrada del mapa de formas: intención, largo mínimo de raíz y si exige «ó» final (pretérito). */
interface VerbFormV1 {
  intent: ActivityIntent;
  rootLen: number;
  finalAccent: boolean;
}

/** forma verbal plegada → entrada (se arma una vez; un choque entre intenciones es un bug de las listas). */
const VERB_FORMS_V1: ReadonlyMap<string, VerbFormV1> = (() => {
  const out = new Map<string, VerbFormV1>();
  const add = (form: string, intent: ActivityIntent, rootLen: number, finalAccent: boolean) => {
    if (NON_VERB_SET_V1.has(form)) return;
    const prev = out.get(form);
    if (prev) {
      if (prev.intent !== intent) throw new Error(`ACTIVITY_TYPE_RULES_V1: la forma "${form}" calza con ${prev.intent} y ${intent}`);
      // Misma intención por dos raíces/terminaciones: la versión más permisiva.
      out.set(form, { intent, rootLen: Math.min(prev.rootLen, rootLen), finalAccent: prev.finalAccent && finalAccent });
      return;
    }
    out.set(form, { intent, rootLen, finalAccent });
  };
  for (const intent of INTENTS_BY_RANK) {
    for (const inf of VERBS_V1[intent]) {
      for (const root of verbRootsV1(inf)) {
        for (const end of VERB_ENDINGS_V1) add(root + end, intent, root.length, false);
        for (const end of ACCENTED_PRETERITE_ENDINGS_V1) add(root + end, intent, root.length, true);
      }
    }
  }
  return out;
})();

/** Palabra tokenizada: plegada + posiciones con tilde aguda en el original (ñ/ü no cuentan). */
interface WordToken {
  folded: string;
  accents: number[];
}

function tokenize(s: string): WordToken[] {
  const out: WordToken[] = [];
  for (const raw of s.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    let folded = '';
    const accents: number[] = [];
    for (const ch of raw) {
      const base = ch.normalize('NFD');
      const plain = base.replace(/[̀-ͯ]/g, '');
      if (/[́]/.test(base)) accents.push(folded.length);
      folded += plain;
    }
    const clean = folded.replace(/[^a-z0-9]/g, '');
    if (clean.length === folded.length && clean) out.push({ folded, accents });
    else if (clean) out.push({ folded: clean, accents: [] });
  }
  return out;
}

function verbIntentOfToken(t: WordToken): ActivityIntent | null {
  const f = VERB_FORMS_V1.get(t.folded);
  if (!f) return null;
  // Pretérito singular: la palabra original debe terminar en «ó».
  if (f.finalAccent && !t.accents.includes(t.folded.length - 1)) return null;
  // Una tilde dentro de la raíz (antes de su última letra) no es de una forma
  // verbal de la lista: «diagnóstica», «cálculo» (sí vale «evalúe»).
  if (t.accents.some((i) => i < f.rootLen - 1)) return null;
  return f.intent;
}

/**
 * EV6 H5P v2 — tokenizador de v1 expuesto para las reglas 2 (mismas reglas de plegado y de
 * tildes). Solo lectura: no cambia nada de rules 1 (sus listas y su comportamiento siguen
 * fijados por los sha de check-v21-activity-type-rules.js).
 */
export function tokenizeRulesV1(s: string): Array<{ folded: string; accents: number[] }> {
  return tokenize(s).map((t) => ({ folded: t.folded, accents: [...t.accents] }));
}

/** Intención verbal de UNA palabra tal como se escribe (acepta tildes; null si no es una forma de las listas). */
export function verbIntentOfWord(word: string): ActivityIntent | null {
  const [t] = tokenize(word);
  return t ? verbIntentOfToken(t) : null;
}

/** Minúsculas, sin tildes/diéresis (ñ → n), palabras [a-z0-9]. */
export function foldText(s: string): string[] {
  return tokenize(s).map((t) => t.folded);
}

function highest(intents: ActivityIntent[]): ActivityIntent | null {
  let best: ActivityIntent | null = null;
  for (const i of intents) if (!best || INTENT_RANK_V1[i] > INTENT_RANK_V1[best]) best = i;
  return best;
}

function nounIntents(words: string[]): ActivityIntent[] {
  const joined = ` ${words.join(' ')} `;
  const out: ActivityIntent[] = [];
  for (const intent of INTENTS_BY_RANK) {
    if (NOUN_CUES_V1[intent].some((cue) => joined.includes(` ${cue} `))) out.push(intent);
  }
  return out;
}

/**
 * Intención de un texto: la de MAYOR nivel entre sus verbos; si no hay
 * verbos, la de mayor nivel entre sus pistas de sustantivo.
 * `nounsOnly` (description): solo pistas de sustantivo.
 */
export function classifyTextIntent(text: string | null | undefined, opts: { nounsOnly?: boolean } = {}): ActivityIntent | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const tokens = tokenize(text);
  if (!opts.nounsOnly) {
    const v = highest(tokens.map(verbIntentOfToken).filter((x): x is ActivityIntent => x !== null));
    if (v) return v;
  }
  return highest(nounIntents(tokens.map((t) => t.folded)));
}

/** Intención del capítulo: objective → title → description (esta última solo con pistas de sustantivo). */
export function classifyChapterIntent(ch: { objective?: string | null; title?: string | null; description?: string | null }): ActivityIntent | null {
  return classifyTextIntent(ch.objective) ?? classifyTextIntent(ch.title) ?? classifyTextIntent(ch.description, { nounsOnly: true });
}

const INTENTS_CANONICAL: readonly ActivityIntent[] = ['recall', 'relate', 'apply', 'reflect', 'understand'];

/**
 * sha256 de la serialización canónica de TODAS las listas de las reglas v1
 * (orden fijo de claves; los arreglos en su orden declarado). El test lo fija:
 * si cambia, no es rules 1 (ver el encabezado CONGELADO).
 */
export function activityTypeRulesV1ListsSha256(): string {
  const canonical = {
    intentToType: INTENTS_CANONICAL.map((i) => [i, INTENT_TO_TYPE_V1[i]]),
    intentRank: INTENTS_CANONICAL.map((i) => [i, INTENT_RANK_V1[i]]),
    verbs: INTENTS_CANONICAL.map((i) => [i, [...VERBS_V1[i]]]),
    irregularRoots: Object.keys(IRREGULAR_ROOTS_V1).sort().map((k) => [k, [...IRREGULAR_ROOTS_V1[k]]]),
    verbEndings: [...VERB_ENDINGS_V1],
    accentedPreteriteEndings: [...ACCENTED_PRETERITE_ENDINGS_V1],
    nonVerbWords: [...NON_VERB_WORDS_V1].sort(),
    nounCues: INTENTS_CANONICAL.map((i) => [i, [...NOUN_CUES_V1[i]]]),
    balancePromotionOrder: [...BALANCE_PROMOTION_ORDER_V1],
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/**
 * sha256 del COMPORTAMIENTO v1: todas las entradas del mapa generado
 * forma → {intención, largo de raíz, exige «ó»} ordenadas por forma, más las
 * pistas/frases de sustantivo y el orden de grupos del balance. Fija lo que
 * el código DERIVA de las listas (reglas ortográficas, lista negra aplicada),
 * no solo las listas.
 */
export function activityTypeRulesV1BehaviorSha256(): string {
  const forms = [...VERB_FORMS_V1.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([form, f]) => [form, f.intent, f.rootLen, f.finalAccent]);
  const canonical = {
    forms,
    nounCues: INTENTS_CANONICAL.map((i) => [i, [...NOUN_CUES_V1[i]]]),
    intentRank: INTENTS_CANONICAL.map((i) => [i, INTENT_RANK_V1[i]]),
    balancePromotionOrder: [...BALANCE_PROMOTION_ORDER_V1],
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** Cantidad de formas verbales generadas (diagnóstico / tests). */
export function verbFormCountV1(): number {
  return VERB_FORMS_V1.size;
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
    // Grupos en BALANCE_PROMOTION_ORDER_V1: fallback (sin clasificar) → relate → recall. apply/reflect/understand ya son questionset.
    const group = (d: ActivityTypeDecision): number => BALANCE_PROMOTION_ORDER_V1.indexOf(d.intent === null ? 'fallback' : d.intent);
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
