import { createHash } from 'crypto';
import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import type { PedagogicalApproachRegistry } from './approach-registry';
import { defaultApproachRegistry } from './builtin-approaches';
import { PEDAGOGY_SECTION_LABELS, PEDAGOGY_VALUE_LABELS } from './labels';
import { allowedPedagogicalTypes, choosePedagogicalActivityTypes, effectiveChapterDesign } from './pedagogical-blueprint';
import { ENUM_TARGETS } from './vocabulary';

/**
 * Motor pedagógico Fase 2 — diseño del item → indicaciones para SU generador.
 *
 * El Manifest v3 de un curso con perfil pedagógico trae `design` en cada item (V1). Esta función
 * pura convierte ese diseño en el «brief» que recibe el generador que produce el item: el prompt
 * del navegador (contenido, experiencia, actividades, evaluaciones…), el content_txt de Videogen o
 * las instrucciones de Gamma. El backend lo arma al entregar el claim (fuente única del texto).
 *
 * Reglas:
 *  - Las indicaciones salen de los VALORES del vocabulario (vocabulary.ts), nunca del nombre de un
 *    enfoque: cualquier enfoque registrado funciona sin tocar este archivo.
 *  - Cada generador recibe solo las partes del diseño que le sirven (el video, su estilo; el examen,
 *    su estrategia…).
 *  - Prioridad: 1 técnica/seguridad · 2 producto · 3 curso · 4 diseño pedagógico · 5 preferencias.
 *    El texto se aplica DENTRO de las reglas del prompt, y `overridden` deja la traza de cada regla
 *    pedagógica que pierde (total o parcialmente) frente a una superior.
 *  - Sin diseño no hay brief (el claim y el prompt quedan byte a byte como antes).
 * Puro: sin DB, sin reloj, sin red, sin proveedores.
 */

export const GENERATOR_DIRECTIVES_VERSION = 1;

/** Marcador del bloque en los prompts LLM (lo buscan las pruebas y el ejecutor). */
export const PEDAGOGY_PROMPT_MARKER = 'DISEÑO PEDAGÓGICO DE ESTE RECURSO';

export type PedagogyGeneratorId =
  | 'course_plan'
  | 'course_intro'
  | 'module_intro'
  | 'content'
  | 'experience'
  | 'presentation'
  | 'video'
  | 'video_interactions'
  | 'activity'
  | 'branching_scenario'
  | 'scorm_activity'
  | 'exam'
  | 'final_exam';

/** Generadores que reciben un prompt LLM (bloque con marcador) vs. proveedores (línea compacta). */
const PROVIDER_GENERATORS: ReadonlySet<PedagogyGeneratorId> = new Set(['presentation', 'video']);

export type OverrideLevel = 'technical' | 'product' | 'course';
/** Nivel de prioridad (menor = manda). El diseño pedagógico es 4. */
export const OVERRIDE_PRIORITY: Readonly<Record<OverrideLevel | 'pedagogy', number>> = Object.freeze({ technical: 1, product: 2, course: 3, pedagogy: 4 });

export interface PedagogyDirective {
  target: string;
  value: string;
  label: string;
  instruction: string;
  /** Versión para el docente (panel) cuando la instrucción del generador usa ids internos. */
  display?: string;
}

export interface PedagogyOverride {
  target: string;
  value: string;
  by: OverrideLevel;
  /** 'full' = la regla pedagógica no se aplica; 'partial' = se aplica dentro del límite. */
  scope: 'full' | 'partial';
  rule: string;
  effect: string;
}

export interface ItemPedagogyBrief {
  version: number;
  engineVersion: number;
  generator: PedagogyGeneratorId;
  directives: PedagogyDirective[];
  overridden: PedagogyOverride[];
  /** Texto listo para el generador (bloque con marcador en prompts LLM; línea compacta en proveedores). */
  text: string;
  textSha256: string;
}

// ── Cobertura: qué hace cada tipo de item con el diseño ─────────────────────

/**
 * Todo tipo de item que el Manifest v3 puede emitir, con lo que su generador hace con el diseño.
 * `consumes: false` debe decir por qué (check-pedagogy-generators.js exige que el registro cubra
 * todos los tipos y que coincida con manifestItemDesign).
 */
export const PEDAGOGY_GENERATOR_COVERAGE: Readonly<Record<string, { consumes: boolean; generator: string; reason: string }>> = Object.freeze({
  course_plan: { consumes: true, generator: 'LLM (navegador) — plan de conceptos', reason: 'estilo de objetivos y profundidad del curso' },
  course_intro: { consumes: true, generator: 'LLM (navegador) — bienvenida', reason: 'enfoques y nivel de interacción: cómo se aprende en el curso' },
  module_intro: { consumes: true, generator: 'LLM (navegador) — presentación del módulo', reason: 'apertura y cierre del módulo' },
  content: { consumes: true, generator: 'LLM (navegador) — libro del capítulo', reason: 'secuencia, tipo de contenido, objetivos, profundidad, caso y recursos' },
  experience: { consumes: true, generator: 'LLM (navegador) — experiencia visual', reason: 'componentes según el tipo de contenido, escenario y retroalimentación' },
  presentation: { consumes: true, generator: 'Gamma (worker) — additionalInstructions', reason: 'tipo de contenido y secuencia de las diapositivas' },
  video: { consumes: true, generator: 'Videogen (worker) — content_txt', reason: 'estilo del video' },
  video_interactions: { consumes: true, generator: 'LLM (navegador) — preguntas del video interactivo', reason: 'tipo de interacción y retroalimentación' },
  activity: { consumes: true, generator: 'LLM (navegador) — H5P (cuestionario, arrastrar, completar, escenario ramificado) o salas SCORM', reason: 'intención, escenario y retroalimentación (+ tipo H5P elegido por el diseño en V1)' },
  exam: { consumes: true, generator: 'LLM (navegador) — banco de preguntas o GIFT del módulo', reason: 'estrategia, estilo de evaluación y retroalimentación' },
  final_exam: { consumes: true, generator: 'LLM (navegador) — banco de preguntas o GIFT final', reason: 'estrategia, estilo integrador y retroalimentación' },
  audio_welcome: {
    consumes: false,
    generator: 'TTS (worker) — narra la bienvenida ya generada',
    reason: 'narra literalmente la bienvenida, que ya recibió el diseño; cambiar la narración rompería la fidelidad al texto',
  },
  audiobook_chapter: {
    consumes: false,
    generator: 'LLM guion + TTS (worker) — audiolibro del capítulo',
    reason: 'narra el capítulo ya diseñado y su guion se valida contra el texto del capítulo; instrucciones de diseño propias competirían con esa fidelidad',
  },
});

// ── Huellas: qué campos del diseño EFECTIVO (con variaciones por rol) lee el brief de cada trabajo ──

/**
 * Por tipo de item de capítulo, los campos del diseño que lee su brief y que pueden variar según el ROL del
 * capítulo en su módulo (roleTargets). Las huellas de invalidación v3 agregan esta proyección a la huella de
 * ESE trabajo solo cuando el rol la cambia: un reorden regenera únicamente lo que recibe otra indicación
 * (review I1 de Fase 2), y sin variación por rol las huellas son las de V1.
 */
export const BRIEF_ROLE_SENSITIVE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  content: ['objectiveStyle', 'contentType', 'scenario.type'],
  experience: ['contentType', 'scenario.type', 'feedback.mode'],
  presentation: ['contentType'],
  video: ['video.style'],
  video_interactions: ['video.interactions', 'feedback.mode', 'feedback.timing'],
  activity: ['activity.intent', 'scenario.type', 'scenario.branching', 'feedback.mode', 'feedback.timing'],
  // Fase 2: la Actividad de Aplicación lee el tipo de contenido, el escenario, la intención y la retroalimentación.
  application_activity: ['contentType', 'scenario.type', 'activity.intent', 'feedback.mode'],
});

function pick(o: any, path: string): unknown {
  return path.split('.').reduce((x, k) => (x === undefined || x === null ? undefined : x[k]), o);
}

/**
 * Proyección del diseño EFECTIVO que lee el brief de cada tipo de trabajo del capítulo, SOLO para los tipos
 * en los que el rol del capítulo la cambia respecto del diseño congelado (vacío = el rol no cambia nada).
 */
export function roleDesignDelta(snapshot: BlueprintSnapshotV2, chapterId: string): Record<string, Record<string, unknown>> {
  if (!snapshot.course.pedagogy) return {};
  const frozen = snapshot.modules.flatMap((m) => m.chapters).find((c) => c.id === chapterId)?.design;
  if (!frozen) return {};
  const eff = effectiveChapterDesign(snapshot, chapterId);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [type, fields] of Object.entries(BRIEF_ROLE_SENSITIVE_FIELDS)) {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    for (const f of fields) { a[f] = pick(eff, f); b[f] = pick(frozen, f); }
    if (JSON.stringify(a) !== JSON.stringify(b)) out[type] = a;
  }
  return out;
}

// ── Textos por valor del vocabulario ────────────────────────────────────────

const OBJECTIVES_TEXT: Readonly<Record<string, string>> = Object.freeze({
  observable_performance: 'Redacta los objetivos y logros como desempeños observables: verbo de acción + condición + criterio de calidad.',
  problem_solving: 'Redacta los objetivos y logros en términos de analizar situaciones, decidir y resolver problemas.',
  experiential: 'Redacta los objetivos y logros en términos de vivir una experiencia, reflexionar sobre ella y aplicar lo aprendido.',
  relational_understanding: 'Redacta los objetivos y logros en términos de relacionar, explicar y organizar conceptos.',
  self_directed_goal: 'Redacta los objetivos y logros como metas que el estudiante puede fijarse y verificar por sí mismo.',
});

const DEPTH_TEXT: Readonly<Record<string, string>> = Object.freeze({
  introductory: 'Profundidad introductoria: define cada término técnico la primera vez y avanza en pasos cortos.',
  standard: 'Profundidad estándar: explica lo esencial con ejemplos y criterios, sin detenerte en lo obvio.',
  advanced: 'Profundidad avanzada: da por sabida la base y profundiza en criterios, excepciones y matices.',
});

const CONTENT_TYPE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  procedural_guide: 'Escribe el capítulo como guía de desempeño: qué se hace, en qué orden, con qué criterio de calidad y qué errores evitar.',
  case_driven: 'Presenta primero el problema o caso y explica la teoría solo cuando el caso la necesita para avanzar.',
  experience_debrief: 'Parte de una experiencia concreta que el estudiante pueda vivir o imaginar; luego guíalo a observar qué pasó, conceptualizar y volver a intentarlo.',
  conceptual_network: 'Construye una red de conceptos: conecta cada idea nueva con lo que el estudiante ya sabe y explicita cómo se relacionan.',
  modular_reference: 'Organiza el capítulo en bloques autónomos de consulta, cada uno con su propósito claro, que el estudiante pueda recorrer a su ritmo.',
});

const PRESENTATION_TEXT: Readonly<Record<string, string>> = Object.freeze({
  procedural_guide: 'diapositivas de guía de desempeño (pasos, criterios y errores frecuentes)',
  case_driven: 'diapositivas que plantean primero el caso y luego la teoría que lo resuelve',
  experience_debrief: 'diapositivas que parten de una experiencia concreta y guían la reflexión',
  conceptual_network: 'diapositivas que muestran los conceptos y cómo se relacionan entre sí',
  modular_reference: 'diapositivas en bloques autónomos de consulta',
});

/** Nombres para el docente de los componentes de la experiencia (los ids son del catálogo DYN_VC del navegador). */
const COMPONENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  process_steps: 'pasos del proceso', checklist: 'lista de verificación', worked_example: 'ejemplo resuelto', case_scenario: 'caso',
  comparison: 'comparación', diagram: 'diagrama', myth_reality: 'mito y realidad', concept_cards: 'tarjetas de conceptos',
  tabs: 'pestañas', accordion: 'acordeón',
});

/** Componentes de la experiencia que mejor expresan cada tipo de contenido (catálogo DYN_VC del navegador). */
export const EXPERIENCE_COMPONENTS_BY_CONTENT_TYPE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  procedural_guide: ['process_steps', 'checklist', 'worked_example'],
  case_driven: ['case_scenario', 'comparison', 'diagram'],
  experience_debrief: ['case_scenario', 'myth_reality', 'checklist'],
  conceptual_network: ['concept_cards', 'diagram', 'comparison'],
  modular_reference: ['tabs', 'accordion', 'checklist'],
});

const SCENARIO_TEXT: Readonly<Record<string, string>> = Object.freeze({
  workplace_situation: 'una situación del puesto de trabajo',
  ill_structured_problem: 'un problema abierto, con información incompleta y más de una salida razonable',
  simulated_experience: 'una experiencia simulada que el estudiante vive en primera persona',
  analogy_case: 'un caso por analogía que conecte lo nuevo con algo conocido',
  self_selected_case: 'un caso que el estudiante pueda trasladar a su propia realidad',
});

const VIDEO_STYLE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  demonstration: 'demostración: muestra el procedimiento paso a paso, como lo haría un experto, nombrando el criterio de cada paso.',
  problem_trigger: 'planteamiento del caso: presenta la situación problemática y deja abierta la pregunta que el capítulo ayudará a resolver.',
  scenario_dramatization: 'situación dramatizada: personajes que enfrentan una situación y sus consecuencias, para reflexionar después.',
  concept_explainer: 'explicación de concepto: la idea central y sus relaciones, con ejemplos y analogías.',
  micro_lecture: 'micro-clase breve y autocontenida, con una idea por segmento, para ver al propio ritmo.',
});

const INTERACTIONS_TEXT: Readonly<Record<string, string>> = Object.freeze({
  performance_checkpoints: 'Cada pregunta verifica si el estudiante reconoce el desempeño correcto y el criterio que se aplicó.',
  decision_points: 'Cada pregunta es un punto de decisión: qué harías ahora en esa situación y por qué.',
  reflective_pauses: 'Cada pregunta invita a relacionar lo visto con la propia experiencia antes de seguir.',
  concept_checks: 'Cada pregunta comprueba la comprensión de conceptos y sus relaciones, no la memoria literal.',
  self_check: 'Cada pregunta es de autocomprobación: el estudiante verifica por sí mismo si lo entendió.',
});

const FEEDBACK_TEXT: Readonly<Record<string, string>> = Object.freeze({
  criterion_referenced: 'La retroalimentación dice qué criterio se cumplió y cuál faltó.',
  guided_hints: 'La retroalimentación da pistas que orientan el razonamiento en vez de solo dar la respuesta.',
  reflective_prompts: 'La retroalimentación devuelve una pregunta de reflexión sobre la decisión tomada.',
  elaborative_explanation: 'La retroalimentación explica el porqué y relaciona la respuesta con el concepto.',
  self_check_keys: 'La retroalimentación funciona como clave de autocorrección para que el estudiante revise su propio trabajo.',
});

const INTENT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  apply: 'La actividad pide aplicar el procedimiento o el criterio en una situación concreta.',
  decide: 'La actividad pide analizar la situación y tomar una decisión justificada.',
  simulate: 'La actividad simula una situación completa en la que el estudiante actúa como lo haría en la realidad.',
  relate: 'La actividad pide relacionar conceptos entre sí y con situaciones.',
  self_check: 'La actividad es de autocomprobación: el estudiante verifica lo que ya domina.',
});

const BRANCHING_INTENT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  apply: 'Cada decisión aplica (o no) el procedimiento correcto, y la consecuencia muestra el efecto de aplicarlo bien o mal.',
  decide: 'Intención didáctica: TOMA DE DECISIONES. Cada punto plantea un dilema real; el estudiante analiza la información y decide, y cada opción lleva a una consecuencia distinta y visible.',
  simulate: 'Intención didáctica: SIMULACIÓN. El estudiante actúa como en la situación real, de principio a fin, y vive las consecuencias de cada decisión.',
  relate: 'Cada decisión exige relacionar conceptos del capítulo para elegir bien; la consecuencia explica la relación.',
  self_check: 'El recorrido sirve de autocomprobación: al final el estudiante ve qué decisiones dominó y cuáles debe repasar.',
});

const SCORM_INTENT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  apply: 'Las salas piden aplicar el procedimiento o el criterio del capítulo.',
  decide: 'Las salas plantean decisiones: el estudiante analiza y elige.',
  simulate: 'Las salas recrean una situación completa en la que el estudiante actúa.',
  relate: 'Las salas piden relacionar conceptos.',
  self_check: 'Las salas sirven de autocomprobación.',
});

const STRATEGY_TEXT: Readonly<Record<string, string>> = Object.freeze({
  performance_evidence: 'Evalúa el desempeño: las preguntas piden reconocer o elegir la actuación correcta en una situación del trabajo, no recordar definiciones.',
  solution_evaluation: 'Evalúa la capacidad de analizar y resolver el problema, no la memoria de conceptos: las preguntas piden diagnosticar, elegir y justificar una solución.',
  reflective_evidence: 'Evalúa la aplicación de lo vivido: las preguntas parten de experiencias y piden interpretar qué pasó y qué hacer distinto.',
  conceptual_understanding: 'Evalúa la comprensión: las preguntas piden relacionar conceptos, explicar causas y distinguir ideas cercanas.',
  self_assessment: 'Evalúa como autocomprobación: preguntas claras que le dicen al estudiante qué domina y qué debe repasar.',
});

const EXAM_STYLE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  situational_cases: 'Los enunciados plantean situaciones del puesto de trabajo.',
  problem_scenarios: 'Los enunciados plantean situaciones problema nuevas que se resuelven con lo que enseña el capítulo.',
  experience_based_cases: 'Los enunciados parten de experiencias concretas del estudiante o del sector.',
  conceptual_relations: 'Los enunciados preguntan por relaciones entre conceptos.',
  self_check_bank: 'Los enunciados son de autocomprobación directa.',
});

const FINAL_EXAM_STYLE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  integrative_performance_case: 'Las preguntas integran el curso en casos de desempeño completos.',
  integrative_problem: 'Las preguntas integran el curso en problemas que exigen combinar lo aprendido para resolverlos.',
  integrative_experience: 'Las preguntas integran el curso a partir de experiencias completas.',
  integrative_concept_synthesis: 'Las preguntas integran los conceptos del curso en una síntesis de relaciones.',
  self_assessment_plus_test: 'Las preguntas combinan autocomprobación con una prueba de lo esencial del curso.',
});

const OPENING_TEXT: Readonly<Record<string, string>> = Object.freeze({
  competency_map: 'Abre el módulo con el mapa de competencias: qué hará el participante al terminar y con qué criterio se verificará.',
  driving_problem: 'Abre el módulo con un problema detonante que los capítulos ayudarán a resolver.',
  concrete_experience: 'Abre el módulo invitando a recordar o imaginar una experiencia concreta relacionada con el tema.',
  advance_organizer: 'Abre el módulo con un organizador previo: las ideas principales y cómo se conectan con lo que el estudiante ya sabe.',
  learning_contract: 'Abre el módulo invitando al estudiante a fijar sus metas y a reconocer lo que ya sabe.',
});

const CLOSING_TEXT: Readonly<Record<string, string>> = Object.freeze({
  performance_check: 'Anuncia que el módulo cierra verificando el desempeño.',
  solution_review: 'Anuncia que el módulo cierra revisando la solución del problema planteado.',
  reflection_synthesis: 'Anuncia que el módulo cierra con una síntesis reflexiva de lo vivido.',
  concept_map_synthesis: 'Anuncia que el módulo cierra integrando los conceptos en un mapa.',
  self_assessment: 'Anuncia que el módulo cierra con una autoevaluación.',
});

const INTERACTION_LEVEL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  high: 'Anticipa que el curso propone práctica e interacción frecuentes.',
  medium: 'Anticipa que el curso combina lectura con práctica en cada capítulo.',
  low: 'Anticipa que el curso privilegia la lectura y el estudio, con práctica puntual.',
});

/** Recursos que el capítulo puede pedir como forma de una Actividad de Apoyo (los demás no aplican al libro). */
const SUPPORT_RESOURCE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  checklist: 'lista de verificación', job_aid: 'ayuda de trabajo de una página', performance_rubric: 'rúbrica de desempeño',
  case_library: 'banco de casos breves', reflection_journal: 'diario de reflexión', concept_map: 'mapa conceptual',
  advance_organizer: 'organizador previo', learning_plan: 'plan de aprendizaje personal', self_assessment_rubric: 'rúbrica de autoevaluación',
});
/** Recursos que chocan con la regla de veracidad (no inventar fuentes): nunca se piden al generador. */
const TRUTH_BLOCKED_RESOURCES: ReadonlySet<string> = new Set(['research_sources', 'further_reading']);

const PRODUCT_SECTIONS = 5;

// ── Utilidades ──────────────────────────────────────────────────────────────

function label(v: string): string {
  return PEDAGOGY_VALUE_LABELS[v] ?? v;
}
function sectionLabel(s: string): string {
  return PEDAGOGY_SECTION_LABELS[s] ?? s;
}
function need(table: Readonly<Record<string, string>>, v: unknown, what: string): string {
  if (typeof v !== 'string' || !table[v]) throw new Error(`PEDAGOGY_DIRECTIVE_UNKNOWN: ${what}=${JSON.stringify(v)} sin texto de generador`);
  return table[v];
}
function d(target: string, value: string, instruction: string): PedagogyDirective {
  return { target, value, label: label(value), instruction };
}
function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Agrupa los pasos de la secuencia en las 5 secciones numeradas del capítulo (orden conservado). */
export function sequenceToSections(sequence: readonly string[], sections = PRODUCT_SECTIONS): string[][] {
  const n = sequence.length;
  if (n === 0) return [];
  if (n <= sections) return sequence.map((s) => [s]);
  const out: string[][] = [];
  for (let i = 0; i < sections; i++) out.push(sequence.slice(Math.floor((i * n) / sections), Math.floor(((i + 1) * n) / sections)));
  return out;
}

function feedbackTimingOverride(timing: string, rule: string): PedagogyOverride[] {
  return timing === 'after_attempt'
    ? [{ target: 'feedback.timing', value: timing, by: 'technical', scope: 'full', rule, effect: 'La retroalimentación se muestra en el momento que fija la plataforma; el diseño no cambia ese momento.' }]
    : [];
}

// ── Brief por generador ─────────────────────────────────────────────────────

export interface BriefInput {
  /** Item del Manifest v3 (con `design`). */
  item: { type: string; chapterId: string | null; variant?: string; h5pType?: string; design?: Record<string, unknown> };
  /** Snapshot del Blueprint (con course.pedagogy) del que salió el Manifest. */
  snapshot: BlueprintSnapshotV2;
  /** features.activityTypeRules del Manifest (para la traza del tipo H5P). */
  activityTypeRules?: number | null;
  registry?: PedagogicalApproachRegistry;
}

/** Generador que produce el item (null = el item no consume diseño). */
export function generatorForItem(item: BriefInput['item']): PedagogyGeneratorId | null {
  switch (item.type) {
    case 'course_plan':
    case 'course_intro':
    case 'module_intro':
    case 'content':
    case 'experience':
    case 'presentation':
    case 'video':
    case 'video_interactions':
    case 'exam':
    case 'final_exam':
      return item.type;
    case 'activity':
      if (item.variant === 'scorm') return 'scorm_activity';
      return item.h5pType === 'branchingscenario' ? 'branching_scenario' : 'activity';
    default:
      return null;
  }
}

function approachLines(snapshot: BlueprintSnapshotV2, registry: PedagogicalApproachRegistry): { primary: string | null; text: string; summary: string | null } {
  const p = snapshot.course.pedagogy!;
  const named = p.approaches.map((a) => {
    let lbl = a.id;
    let summary: string | null = null;
    try {
      const def = registry.get(a.id);
      lbl = def.label;
      summary = def.summary;
    } catch {
      // enfoque ya no registrado: se nombra por su id (el diseño congelado sigue valiendo).
    }
    return { role: a.role, lbl, summary };
  });
  const primary = named.find((x) => x.role === 'primary') ?? null;
  const secondary = named.filter((x) => x.role === 'secondary').map((x) => x.lbl);
  const text = primary ? primary.lbl + (secondary.length ? ` (con ${secondary.join(' y ')})` : '') : secondary.join(' y ');
  return { primary: primary?.lbl ?? null, text, summary: primary?.summary ?? null };
}

function directivesFor(gen: PedagogyGeneratorId, input: BriefInput): { directives: PedagogyDirective[]; overridden: PedagogyOverride[] } {
  const des = (input.item.design ?? {}) as Record<string, any>;
  const snapshot = input.snapshot;
  const directives: PedagogyDirective[] = [];
  const overridden: PedagogyOverride[] = [];
  const registry = input.registry ?? defaultApproachRegistry();

  switch (gen) {
    case 'course_plan': {
      const ap = approachLines(snapshot, registry);
      directives.push({ target: 'approaches', value: ap.text, label: ap.text, instruction: `Enfoque del curso: ${ap.text}. Planea los conceptos de cada capítulo para que el curso avance según ese enfoque.` });
      directives.push(d('objectives.style', des.objectivesStyle, need(OBJECTIVES_TEXT, des.objectivesStyle, 'objectivesStyle')));
      directives.push(d('content.depth', des.contentDepth, need(DEPTH_TEXT, des.contentDepth, 'contentDepth')));
      break;
    }
    case 'course_intro': {
      const ap = approachLines(snapshot, registry);
      directives.push({
        target: 'approaches', value: ap.text, label: ap.text,
        instruction: `Explica en pocas palabras, dentro de la bienvenida, cómo se aprende en este curso${ap.summary ? `: ${ap.summary}` : '.'} Dilo con palabras simples, sin nombrar teorías, autores ni el nombre técnico del enfoque.`,
      });
      directives.push(d('interactionLevel', des.interactionLevel, need(INTERACTION_LEVEL_TEXT, des.interactionLevel, 'interactionLevel')));
      break;
    }
    case 'module_intro':
      directives.push(d('module.opening', des.opening, need(OPENING_TEXT, des.opening, 'opening')));
      directives.push(d('module.closing', des.closing, need(CLOSING_TEXT, des.closing, 'closing')));
      break;
    case 'content': {
      const seq: string[] = Array.isArray(des.sequence) ? des.sequence : [];
      const groups = sequenceToSections(seq);
      const lines = groups.map((g, i) => `${i + 1}.ª sección: ${g.map(sectionLabel).join(' + ')}`).join('; ');
      directives.push({
        target: 'sequence', value: seq.join('>'), label: seq.map(sectionLabel).join(' → '),
        instruction: `Ordena las secciones numeradas del capítulo según esta secuencia didáctica: ${lines}. Desarrolla cada paso con lo que enseña el capítulo, sin citar estudios ni fuentes.`,
      });
      if (seq.length > PRODUCT_SECTIONS) {
        overridden.push({
          target: 'sequence', value: seq.join('>'), by: 'product', scope: 'partial', rule: `El capítulo tiene ${PRODUCT_SECTIONS} secciones numeradas`,
          effect: `Los ${seq.length} pasos de la secuencia se agrupan en ${PRODUCT_SECTIONS} secciones, en el mismo orden.`,
        });
      }
      directives.push(d('content.type', des.contentType, need(CONTENT_TYPE_TEXT, des.contentType, 'contentType')));
      const verbs: string[] = Array.isArray(des.objectiveVerbs) ? des.objectiveVerbs.slice(0, 6) : [];
      directives.push(d('objectives.style', des.objectiveStyle, need(OBJECTIVES_TEXT, des.objectiveStyle, 'objectiveStyle') + (verbs.length ? ` Verbos preferidos: ${verbs.join(', ')}.` : '')));
      directives.push(d('content.depth', des.depth, need(DEPTH_TEXT, des.depth, 'depth')));
      const sc = des.scenario ?? {};
      directives.push(d('scenarios.type', sc.type, `El caso del capítulo es ${need(SCENARIO_TEXT, sc.type, 'scenario.type')} (siempre ilustrativo, como exigen las reglas).`));
      const res: string[] = Array.isArray(des.resources) ? des.resources : [];
      const forms = res.filter((r) => SUPPORT_RESOURCE_TEXT[r]).slice(0, 2);
      if (forms.length) {
        directives.push({ target: 'resources', value: forms.join(','), label: forms.map(label).join(', '), instruction: `Cuando encaje, da a las actividades de apoyo la forma de: ${forms.map((r) => SUPPORT_RESOURCE_TEXT[r]).join(' y ')}.` });
      }
      for (const r of res.filter((x) => TRUTH_BLOCKED_RESOURCES.has(x))) {
        overridden.push({ target: 'resources', value: r, by: 'technical', scope: 'full', rule: 'Veracidad: no inventar fuentes ni referencias', effect: `«${label(r)}» no se pide al generador del libro.` });
      }
      break;
    }
    case 'experience': {
      const comps = EXPERIENCE_COMPONENTS_BY_CONTENT_TYPE[des.contentType];
      if (!comps) need({}, des.contentType, 'experience.contentType');
      directives.push({
        ...d('content.type', des.contentType, `Prioriza, cuando encajen con el contenido, estos componentes: ${comps.join(', ')}. ${need(CONTENT_TYPE_TEXT, des.contentType, 'contentType')}`),
        display: `Prioriza, cuando encajen con el contenido: ${comps.map((c) => COMPONENT_LABELS[c] ?? c).join(', ')}. ${need(CONTENT_TYPE_TEXT, des.contentType, 'contentType')}`,
      });
      const sc = des.scenario ?? {};
      directives.push(d('scenarios.type', sc.type, `Si usas un caso, que sea ${need(SCENARIO_TEXT, sc.type, 'scenario.type')} (ilustrativo).`));
      const fb = des.feedback ?? {};
      directives.push(d('feedback.mode', fb.mode, need(FEEDBACK_TEXT, fb.mode, 'feedback.mode')));
      overridden.push({ target: 'content.type', value: des.contentType, by: 'product', scope: 'partial', rule: 'Catálogo y límites de la experiencia visual de Cursia', effect: 'Los componentes preferidos se usan solo dentro de los límites del catálogo.' });
      break;
    }
    case 'presentation': {
      const seq: string[] = Array.isArray(des.sequence) ? des.sequence : [];
      directives.push(d('content.type', des.contentType, `Enfoque: ${need(PRESENTATION_TEXT, des.contentType, 'contentType')}.`));
      directives.push({ target: 'sequence', value: seq.join('>'), label: seq.map(sectionLabel).join(' → '), instruction: `Orden de las diapositivas: ${seq.map(sectionLabel).join(' → ')}.` });
      overridden.push({ target: 'sequence', value: seq.join('>'), by: 'product', scope: 'partial', rule: 'Portada en la primera diapositiva y número fijo de diapositivas', effect: 'La secuencia ordena las diapositivas de contenido, después de la portada.' });
      break;
    }
    case 'video': {
      const v = des.style;
      directives.push(d('video.style', v, `Estilo del video: ${need(VIDEO_STYLE_TEXT, v, 'video.style')}`));
      break;
    }
    case 'video_interactions': {
      directives.push(d('video.interactions', des.interactions, need(INTERACTIONS_TEXT, des.interactions, 'video.interactions')));
      const fb = des.feedback ?? {};
      directives.push(d('feedback.mode', fb.mode, need(FEEDBACK_TEXT, fb.mode, 'feedback.mode')));
      overridden.push({ target: 'video.interactions', value: des.interactions, by: 'product', scope: 'partial', rule: 'Cursia fija cuántas preguntas tiene el video y en qué momento aparecen', effect: 'El diseño orienta el contenido de las preguntas; cuántas y cuándo lo fija el plan.' });
      overridden.push(...feedbackTimingOverride(fb.timing, 'El video interactivo muestra la retroalimentación al responder'));
      break;
    }
    case 'activity':
    case 'branching_scenario':
    case 'scorm_activity': {
      const intent = des.activity?.intent ?? des.intent;
      const sc = des.scenario ?? {};
      const fb = des.feedback ?? {};
      const table = gen === 'branching_scenario' ? BRANCHING_INTENT_TEXT : gen === 'scorm_activity' ? SCORM_INTENT_TEXT : INTENT_TEXT;
      directives.push(d('activity.intent', intent, need(table, intent, 'activity.intent')));
      directives.push(d('scenarios.type', sc.type, `${gen === 'branching_scenario' ? 'El escenario es' : 'La situación de la actividad es'} ${need(SCENARIO_TEXT, sc.type, 'scenario.type')} (ilustrativa).`));
      directives.push(d('feedback.mode', fb.mode, need(FEEDBACK_TEXT, fb.mode, 'feedback.mode')));
      if (gen !== 'scorm_activity') overridden.push(...feedbackTimingOverride(fb.timing, 'Las actividades interactivas muestran la retroalimentación al responder'));
      if (gen === 'scorm_activity') {
        overridden.push({ target: 'activity.intent', value: intent, by: 'product', scope: 'partial', rule: 'Las salas SCORM usan plantillas con mecánicas fijas', effect: 'El diseño orienta el contenido de las salas; la mecánica la fija la plantilla.' });
      } else if (input.item.chapterId) {
        overridden.push(...activityTypeOverrides(input));
      }
      break;
    }
    case 'exam':
    case 'final_exam': {
      directives.push(d('assessment.strategy', des.strategy, need(STRATEGY_TEXT, des.strategy, 'assessment.strategy')));
      if (gen === 'exam') directives.push(d('assessment.examStyle', des.examStyle, need(EXAM_STYLE_TEXT, des.examStyle, 'assessment.examStyle')));
      else directives.push(d('assessment.finalExamStyle', des.finalExamStyle, need(FINAL_EXAM_STYLE_TEXT, des.finalExamStyle, 'assessment.finalExamStyle')));
      const fb = des.feedback ?? {};
      directives.push(d('feedback.mode', fb.mode, `${need(FEEDBACK_TEXT, fb.mode, 'feedback.mode')} Aplícalo en las explicaciones de cada pregunta cuando el formato pida explicaciones.`));
      overridden.push({
        target: 'assessment.strategy', value: des.strategy, by: 'product', scope: 'partial', rule: 'Banco de preguntas de Cursia: tipos, cantidades, niveles y cita textual del capítulo',
        effect: 'El diseño orienta los enunciados y las explicaciones; tipos de pregunta, cantidades, niveles y evidencia los fija Cursia.',
      });
      overridden.push(...feedbackTimingOverride(fb.timing, 'Cursia configura en Moodle cuándo se revisa el cuestionario'));
      break;
    }
  }
  return { directives, overridden };
}

/** Traza del tipo H5P: el preferido por el diseño vs. el que congeló el Manifest. */
function activityTypeOverrides(input: BriefInput): PedagogyOverride[] {
  const out: PedagogyOverride[] = [];
  const chapterId = input.item.chapterId!;
  const eff = effectiveChapterDesign(input.snapshot, chapterId);
  const allowed = allowedPedagogicalTypes(input.activityTypeRules ?? null) as readonly string[];
  const notAllowed = eff.activity.preferredTypes.filter((t) => !allowed.includes(t));
  for (const t of notAllowed) {
    out.push({ target: 'activity.preferredTypes', value: t, by: 'product', scope: 'full', rule: input.activityTypeRules === 2 ? 'Tipos de actividad disponibles en este curso' : 'Este curso usa H5P sin escenarios ramificados', effect: `«${label(t)}» no está disponible en este curso.` });
  }
  const got = input.item.h5pType;
  if (!got) return out;
  let reason: string | undefined;
  try {
    reason = choosePedagogicalActivityTypes(input.snapshot, input.activityTypeRules ?? null).get(chapterId)?.reason;
  } catch {
    reason = undefined;
  }
  if (reason === 'branching_cap') {
    out.push({ target: 'activity.preferredTypes', value: 'branchingscenario', by: 'product', scope: 'full', rule: 'Tope de escenarios ramificados por curso (uno cada cuatro actividades)', effect: `La actividad queda como «${label(got)}».` });
  } else if (reason === 'variety') {
    out.push({ target: 'activity.preferredTypes', value: eff.activity.preferredTypes[0] ?? got, by: 'product', scope: 'full', rule: 'Variedad: ningún tipo de actividad domina el curso', effect: `La actividad queda como «${label(got)}».` });
  } else if (reason === 'objective') {
    out.push({ target: 'activity.intent', value: eff.activity.intent, by: 'course', scope: 'partial', rule: 'El objetivo del capítulo pide otro tipo (dentro de los 2 preferidos del enfoque)', effect: `La actividad queda como «${label(got)}».` });
  }
  if (eff.scenario.branching && got !== 'branchingscenario') {
    out.push({ target: 'scenarios.branching', value: 'true', by: reason === 'objective' ? 'course' : 'product', scope: 'partial', rule: 'Tipo de actividad ya fijado para este capítulo', effect: 'La decisión se trabaja dentro del tipo elegido, sin ramificar.' });
  }
  return out;
}

function renderText(gen: PedagogyGeneratorId, directives: PedagogyDirective[]): string {
  // Videogen recibe la línea dentro del texto del capítulo: se marca como indicación para que no se narre (review M10).
  if (gen === 'video') return `[Indicación para el guion, no narrar] ${directives.map((x) => x.instruction).join(' ')}`;
  if (PROVIDER_GENERATORS.has(gen)) {
    return `Enfoque didáctico: ${directives.map((x) => x.instruction).join(' ')}`;
  }
  return (
    `\n\n── ${PEDAGOGY_PROMPT_MARKER} ──\n` +
    'Aplica estas indicaciones DENTRO de todas las reglas de este pedido, las de antes y las de después de este bloque (formato, cantidades, límites, veracidad y validaciones). Si alguna choca con esas reglas, mandan las reglas.\n' +
    directives.map((x) => `- ${x.instruction}`).join('\n')
  );
}

/**
 * Brief pedagógico de un item del Manifest (null si el item no trae diseño o su tipo no lo consume).
 * Falla fuerte si el diseño trae un valor sin texto (vocabulario y textos desalineados).
 */
export function buildItemPedagogyBrief(input: BriefInput): ItemPedagogyBrief | null {
  if (!input.item.design || !input.snapshot.course.pedagogy) return null;
  const gen = generatorForItem(input.item);
  if (!gen) return null;
  const { directives, overridden } = directivesFor(gen, input);
  const text = renderText(gen, directives);
  return {
    version: GENERATOR_DIRECTIVES_VERSION,
    engineVersion: input.snapshot.course.pedagogy.engineVersion,
    generator: gen,
    directives,
    overridden,
    text,
    textSha256: sha256(text),
  };
}

/** Valores del vocabulario que algún generador podría recibir sin texto (vacío = completo). */
export function missingGeneratorTexts(): string[] {
  const missing: string[] = [];
  const check = (table: Readonly<Record<string, unknown>>, values: readonly string[], what: string) => {
    for (const v of values) if (!table[v]) missing.push(`${what}:${v}`);
  };
  check(OBJECTIVES_TEXT, ENUM_TARGETS['objectives.style'], 'objectives.style');
  check(CONTENT_TYPE_TEXT, ENUM_TARGETS['content.type'], 'content.type');
  check(PRESENTATION_TEXT, ENUM_TARGETS['content.type'], 'presentation');
  check(EXPERIENCE_COMPONENTS_BY_CONTENT_TYPE, ENUM_TARGETS['content.type'], 'experience');
  check(SCENARIO_TEXT, ENUM_TARGETS['scenarios.type'], 'scenarios.type');
  check(VIDEO_STYLE_TEXT, ENUM_TARGETS['video.style'], 'video.style');
  check(INTERACTIONS_TEXT, ENUM_TARGETS['video.interactions'], 'video.interactions');
  check(FEEDBACK_TEXT, ENUM_TARGETS['feedback.mode'], 'feedback.mode');
  check(INTENT_TEXT, ENUM_TARGETS['activity.intent'], 'activity.intent');
  check(BRANCHING_INTENT_TEXT, ENUM_TARGETS['activity.intent'], 'branching.intent');
  check(SCORM_INTENT_TEXT, ENUM_TARGETS['activity.intent'], 'scorm.intent');
  check(STRATEGY_TEXT, ENUM_TARGETS['assessment.strategy'], 'assessment.strategy');
  check(EXAM_STYLE_TEXT, ENUM_TARGETS['assessment.examStyle'], 'assessment.examStyle');
  check(FINAL_EXAM_STYLE_TEXT, ENUM_TARGETS['assessment.finalExamStyle'], 'assessment.finalExamStyle');
  check(OPENING_TEXT, ENUM_TARGETS['module.opening'], 'module.opening');
  check(CLOSING_TEXT, ENUM_TARGETS['module.closing'], 'module.closing');
  check(DEPTH_TEXT, ['introductory', 'standard', 'advanced'], 'depth');
  check(INTERACTION_LEVEL_TEXT, ['high', 'medium', 'low'], 'interactionLevel');
  return missing;
}
