import { VC_COMPONENT_TYPES, VC_MOVEMENT_IDS } from '../visual-components/schema';

/**
 * T2 (r57) · Marco instruccional (metodología) como DATOS.
 *
 * Un marco define fases/eventos ordenados, a qué bloques FIJOS del capítulo se asigna cada fase (el
 * orden de los bloques de Moodle no cambia: lo arma course-shell/chapter-assembler.ts), qué indica cada
 * fase a cada generador (texto del brief), qué elementos son obligatorios y qué exige la validación de la
 * experiencia (parámetro de validatePedagogy). Agregar una metodología = un objeto más en el registro,
 * validado por `validateFrameworkDefinition`; ningún archivo del motor conoce un marco por nombre.
 *
 * «Teoría – Demostración – Práctica» y «9 eventos de instrucción de Gagné» son configuraciones
 * reutilizables por cualquier institución (no hay código de un cliente).
 * Puro: sin DB, sin red.
 */

/** Bloques del capítulo (y evaluaciones) a los que una fase se puede asignar. Orden = orden real del curso. */
export const FRAMEWORK_SLOTS = [
  'opening', 'presentation', 'deepening', 'video', 'synthesis', 'guided_practice', 'activity', 'self_check',
  'review_cards', 'application', 'closing', 'module_exam', 'final_exam',
] as const;
export type FrameworkSlot = (typeof FRAMEWORK_SLOTS)[number];

/** Bloques que TODO capítulo de contenido tiene (una fase obligatoria debe caer en al menos uno). */
export const FRAMEWORK_ALWAYS_PRESENT_SLOTS: readonly FrameworkSlot[] = Object.freeze(['opening', 'presentation', 'deepening', 'synthesis', 'closing']);

/** Generadores que pueden recibir indicaciones de una fase (los ids del brief, generator-directives.ts). */
export const FRAMEWORK_DIRECTIVE_GENERATORS = [
  'module_intro', 'content', 'experience', 'presentation', 'video', 'video_interactions', 'activity', 'application_activity',
  'guided_practice', 'exam', 'final_exam',
] as const;
export type FrameworkDirectiveGenerator = (typeof FRAMEWORK_DIRECTIVE_GENERATORS)[number];

export interface FrameworkPhase {
  id: string;
  order: number;
  /** Nombre para el docente. */
  label: string;
  /** Rótulo visible para el estudiante (si el curso muestra las fases). */
  studentLabel: string;
  slots: FrameworkSlot[];
  required: boolean;
  /** Elementos del curso que cumplen la fase (texto para el docente). */
  elements: string[];
  directives: Partial<Record<FrameworkDirectiveGenerator, string>>;
}

/** Requisito de la experiencia visual (validatePedagogy): algún componente de `anyOf` en alguno de `movements`. */
export interface FrameworkExperienceRequirement {
  id: string;
  phase: string;
  movements: string[];
  anyOf: string[];
  message: string;
}

export interface InstructionalFramework {
  id: string;
  version: number;
  label: string;
  shortLabel: string;
  summary: string;
  /** Mostrar las fases al estudiante por defecto (el perfil puede cambiarlo). */
  phaseLabelsDefault: boolean;
  phases: FrameworkPhase[];
  experienceRequirements: FrameworkExperienceRequirement[];
}

export interface FrameworkValidationError {
  path: string;
  message: string;
}

const ID_RE = /^[a-z][a-z0-9_]{1,40}$/;
const TEXT_MAX = 400;

function text(v: unknown, path: string, errors: FrameworkValidationError[], max = TEXT_MAX): void {
  if (typeof v !== 'string' || !v.trim()) errors.push({ path, message: 'debe ser un texto no vacío' });
  else if (v.length > max) errors.push({ path, message: `supera ${max} caracteres` });
}

/** Validación completa de una definición (lo usa el registro al registrar; vacío = válida). */
export function validateFrameworkDefinition(def: unknown): FrameworkValidationError[] {
  const errors: FrameworkValidationError[] = [];
  const d = def as InstructionalFramework;
  if (!d || typeof d !== 'object') return [{ path: '', message: 'el marco debe ser un objeto' }];
  if (typeof d.id !== 'string' || !ID_RE.test(d.id)) errors.push({ path: 'id', message: 'id inválido (minúsculas, dígitos y _; 2–41 caracteres)' });
  if (!Number.isInteger(d.version) || d.version < 1) errors.push({ path: 'version', message: 'debe ser un entero ≥ 1' });
  text(d.label, 'label', errors, 120);
  text(d.shortLabel, 'shortLabel', errors, 40);
  text(d.summary, 'summary', errors);
  if (typeof d.phaseLabelsDefault !== 'boolean') errors.push({ path: 'phaseLabelsDefault', message: 'debe ser boolean' });
  if (!Array.isArray(d.phases) || d.phases.length === 0) {
    errors.push({ path: 'phases', message: 'al menos una fase' });
    return errors;
  }
  const ids = new Set<string>();
  d.phases.forEach((p, i) => {
    const at = `phases[${i}]`;
    if (!p || typeof p !== 'object') { errors.push({ path: at, message: 'debe ser un objeto' }); return; }
    if (typeof p.id !== 'string' || !ID_RE.test(p.id)) errors.push({ path: `${at}.id`, message: 'id inválido' });
    else if (ids.has(p.id)) errors.push({ path: `${at}.id`, message: `fase repetida «${p.id}»` });
    else ids.add(p.id);
    if (p.order !== i + 1) errors.push({ path: `${at}.order`, message: `las fases van en orden 1..n (se esperaba ${i + 1})` });
    text(p.label, `${at}.label`, errors, 120);
    text(p.studentLabel, `${at}.studentLabel`, errors, 80);
    if (!Array.isArray(p.slots) || p.slots.length === 0) errors.push({ path: `${at}.slots`, message: 'la fase debe asignarse al menos a un bloque' });
    else {
      p.slots.forEach((s, j) => { if (!(FRAMEWORK_SLOTS as readonly string[]).includes(s)) errors.push({ path: `${at}.slots[${j}]`, message: `bloque desconocido «${s}» (permitidos: ${FRAMEWORK_SLOTS.join(', ')})` }); });
      if (new Set(p.slots).size !== p.slots.length) errors.push({ path: `${at}.slots`, message: 'bloques repetidos' });
      if (p.required === true && !p.slots.some((s) => FRAMEWORK_ALWAYS_PRESENT_SLOTS.includes(s))) {
        errors.push({ path: `${at}.slots`, message: `una fase obligatoria debe caer en un bloque que todo capítulo tiene (${FRAMEWORK_ALWAYS_PRESENT_SLOTS.join(', ')})` });
      }
    }
    if (typeof p.required !== 'boolean') errors.push({ path: `${at}.required`, message: 'debe ser boolean' });
    if (!Array.isArray(p.elements)) errors.push({ path: `${at}.elements`, message: 'debe ser un array' });
    else p.elements.forEach((e, j) => text(e, `${at}.elements[${j}]`, errors, 120));
    if (!p.directives || typeof p.directives !== 'object' || Array.isArray(p.directives)) errors.push({ path: `${at}.directives`, message: 'debe ser un objeto' });
    else {
      for (const [g, t] of Object.entries(p.directives)) {
        if (!(FRAMEWORK_DIRECTIVE_GENERATORS as readonly string[]).includes(g)) errors.push({ path: `${at}.directives.${g}`, message: `generador desconocido (permitidos: ${FRAMEWORK_DIRECTIVE_GENERATORS.join(', ')})` });
        text(t, `${at}.directives.${g}`, errors);
      }
    }
  });
  if (!Array.isArray(d.experienceRequirements)) errors.push({ path: 'experienceRequirements', message: 'debe ser un array' });
  else {
    const rids = new Set<string>();
    d.experienceRequirements.forEach((r, i) => {
      const at = `experienceRequirements[${i}]`;
      if (typeof r?.id !== 'string' || !/^[a-z][a-z0-9_.]{1,60}$/.test(r.id)) errors.push({ path: `${at}.id`, message: 'id inválido' });
      else if (rids.has(r.id)) errors.push({ path: `${at}.id`, message: 'requisito repetido' });
      else rids.add(r.id);
      if (!ids.has(r?.phase)) errors.push({ path: `${at}.phase`, message: `fase inexistente «${r?.phase}»` });
      if (!Array.isArray(r?.movements) || !r.movements.length || r.movements.some((m) => !(VC_MOVEMENT_IDS as readonly string[]).includes(m))) {
        errors.push({ path: `${at}.movements`, message: `movimientos de la experiencia: ${VC_MOVEMENT_IDS.join(', ')}` });
      }
      if (!Array.isArray(r?.anyOf) || !r.anyOf.length || r.anyOf.some((t) => !(VC_COMPONENT_TYPES as readonly string[]).includes(t as never))) {
        errors.push({ path: `${at}.anyOf`, message: 'tipos de componente del catálogo visual' });
      }
      text(r?.message, `${at}.message`, errors);
    });
  }
  return errors;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export class InstructionalFrameworkRegistry {
  private readonly defs = new Map<string, InstructionalFramework>();

  register(def: InstructionalFramework): this {
    const errors = validateFrameworkDefinition(def);
    if (errors.length) throw new Error(`FRAMEWORK_INVALID ${String((def as any)?.id)}: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    if (this.defs.has(def.id)) throw new Error(`FRAMEWORK_DUPLICATE: ${def.id}`);
    this.defs.set(def.id, deepFreeze(JSON.parse(JSON.stringify(def))));
    return this;
  }

  has(id: unknown): boolean {
    return typeof id === 'string' && this.defs.has(id);
  }

  get(id: string): InstructionalFramework {
    const d = this.defs.get(id);
    if (!d) throw new Error(`FRAMEWORK_UNKNOWN: ${JSON.stringify(id)} (disponibles: ${this.ids().join(', ')})`);
    return d;
  }

  ids(): string[] {
    return [...this.defs.keys()];
  }

  list(): InstructionalFramework[] {
    return [...this.defs.values()];
  }
}

// ── Marcos incluidos (datos) ────────────────────────────────────────────────

export const DEFAULT_FRAMEWORK_ID = 'default';

export const BUILTIN_FRAMEWORKS: readonly InstructionalFramework[] = [
  {
    id: DEFAULT_FRAMEWORK_ID,
    version: 1,
    label: 'Estructura estándar de Cursia',
    shortLabel: 'Estándar',
    summary: 'El recorrido de siempre: inicio, estudio, práctica y cierre en cada capítulo, con evaluación por módulo.',
    phaseLabelsDefault: false,
    phases: [
      { id: 'inicio', order: 1, label: 'Inicio', studentLabel: 'Inicio', slots: ['opening'], required: true, elements: ['Apertura del capítulo'], directives: {} },
      { id: 'estudio', order: 2, label: 'Estudio', studentLabel: 'Estudio', slots: ['presentation', 'deepening', 'video', 'synthesis'], required: true, elements: ['Presentación', 'Profundización', 'Video', 'Síntesis'], directives: {} },
      { id: 'practica', order: 3, label: 'Práctica', studentLabel: 'Práctica', slots: ['guided_practice', 'activity', 'self_check', 'review_cards', 'application'], required: false, elements: ['Ejercicios guiados', 'Práctica calificada', 'Actividad de Aplicación'], directives: {} },
      { id: 'cierre', order: 4, label: 'Cierre', studentLabel: 'Cierre', slots: ['closing'], required: true, elements: ['Cierre del capítulo'], directives: {} },
      { id: 'evaluacion', order: 5, label: 'Evaluación', studentLabel: 'Evaluación', slots: ['module_exam', 'final_exam'], required: false, elements: ['Evaluación del módulo', 'Evaluación final'], directives: {} },
    ],
    experienceRequirements: [],
  },
  {
    id: 'teoria_demostracion_practica',
    version: 1,
    label: 'Teoría – Demostración – Práctica',
    shortLabel: 'TDP',
    summary: 'Cada capítulo recorre tres fases: la teoría necesaria, la demostración de cómo se hace y la práctica de lo demostrado.',
    phaseLabelsDefault: true,
    phases: [
      {
        id: 'teoria', order: 1, label: 'Teoría', studentLabel: 'Teoría', slots: ['opening', 'presentation', 'deepening'], required: true,
        elements: ['Presentación', 'Conceptos clave', 'Libro Guía con audiolibro'],
        directives: {
          content: 'Fase Teoría: explica primero los conceptos y criterios que se necesitan para hacer la tarea, sin adelantar la práctica.',
          experience: 'Fase Teoría (apertura y profundización): los conceptos clave en concept_cards y una explicación breve, antes del ejemplo.',
          presentation: 'Fase Teoría: las diapositivas cubren los conceptos y criterios clave del capítulo.',
        },
      },
      {
        id: 'demostracion', order: 2, label: 'Demostración', studentLabel: 'Demostración', slots: ['deepening', 'video'], required: true,
        elements: ['Video paso a paso', 'Ejemplo resuelto', 'Casos del oficio'],
        directives: {
          content: 'Fase Demostración: incluye un ejemplo resuelto paso a paso de una tarea real del oficio, con el criterio de cada paso.',
          experience: 'Fase Demostración: un worked_example (o process_steps) en la profundización muestra cómo se hace, paso a paso y con el porqué de cada paso.',
          video: 'Fase Demostración: el video muestra paso a paso cómo se hace la tarea del capítulo y nombra el criterio de cada paso.',
          video_interactions: 'Fase Demostración: las preguntas verifican que el estudiante sigue los pasos demostrados.',
        },
      },
      {
        id: 'practica', order: 3, label: 'Práctica', studentLabel: 'Práctica', slots: ['guided_practice', 'activity', 'self_check', 'application', 'closing'], required: true,
        elements: ['Actividad interactiva', 'Ejercicios guiados', 'Actividad de Aplicación'],
        directives: {
          activity: 'Fase Práctica: la actividad pide hacer lo que se demostró (ejecutar, ordenar o decidir), no solo recordarlo.',
          application_activity: 'Fase Práctica: los ejercicios y el taller replican lo demostrado con datos y situaciones nuevas.',
          guided_practice: 'Fase Práctica: ejercicios con apoyo que repiten lo demostrado y retiran la ayuda de a poco.',
          experience: 'Fase Práctica: el cierre propone aplicar lo demostrado en una situación nueva del trabajo.',
        },
      },
    ],
    experienceRequirements: [
      {
        id: 'tdp.demonstration', phase: 'demostracion', movements: ['deepening'], anyOf: ['worked_example', 'process_steps'],
        message: 'Teoría – Demostración – Práctica: la profundización debe traer la demostración: un "worked_example" o un "process_steps" con los pasos',
      },
    ],
  },
  {
    id: 'gagne_9_eventos',
    version: 1,
    label: 'Nueve eventos de instrucción de Gagné',
    shortLabel: 'Gagné',
    summary: 'Cada capítulo recorre los nueve eventos: atención, objetivo, saberes previos, contenido, guía, desempeño, retroalimentación, evaluación y transferencia.',
    phaseLabelsDefault: true,
    phases: [
      {
        id: 'captar_atencion', order: 1, label: '1. Captar la atención', studentLabel: '1 · Para empezar', slots: ['opening', 'video'], required: true,
        elements: ['Apertura con una situación real', 'Inicio del video'],
        directives: {
          experience: 'Evento 1 (captar la atención): el hero abre con una situación real del oficio que plantea un reto concreto.',
          video: 'Evento 1: el video abre con una situación real del oficio antes de explicar.',
          module_intro: 'Evento 1: la presentación del módulo abre con una situación real que muestre para qué sirve lo que viene.',
        },
      },
      {
        id: 'informar_objetivo', order: 2, label: '2. Informar el objetivo', studentLabel: '2 · Lo que vas a lograr', slots: ['opening'], required: true,
        elements: ['Objetivo del capítulo con su criterio de desempeño'],
        directives: {
          content: 'Evento 2 (informar el objetivo): al inicio enuncia el objetivo del capítulo como desempeño observable con su criterio de calidad.',
          experience: 'Evento 2: la apertura incluye learning_objectives con lo que el estudiante podrá hacer y el criterio con que se verifica.',
        },
      },
      {
        id: 'recordar_saberes', order: 3, label: '3. Estimular el recuerdo de saberes previos', studentLabel: '3 · Lo que ya sabes', slots: ['opening'], required: true,
        elements: ['Pregunta de activación al inicio del capítulo'],
        directives: {
          content: 'Evento 3 (saberes previos): conecta el capítulo con lo que el estudiante ya sabe o vivió antes de presentar lo nuevo.',
          experience: 'Evento 3: la apertura incluye un reflection con una pregunta de activación sobre lo que el estudiante ya sabe o vivió (máximo 3 componentes en la apertura).',
        },
      },
      {
        id: 'presentar_contenido', order: 4, label: '4. Presentar el contenido', studentLabel: '4 · Aprende', slots: ['presentation', 'deepening'], required: true,
        elements: ['Presentación', 'Conceptos clave', 'Libro Guía'],
        directives: {
          experience: 'Evento 4 (presentar el contenido): los concept_cards van en la profundización, con una explicación breve y un recurso visual.',
          presentation: 'Evento 4 (presentar el contenido): las diapositivas muestran los conceptos clave y cómo se relacionan.',
        },
      },
      {
        id: 'guiar_aprendizaje', order: 5, label: '5. Guiar el aprendizaje', studentLabel: '5 · Mira cómo se hace', slots: ['deepening', 'video', 'guided_practice'], required: true,
        elements: ['Video demostrativo', 'Ejemplo resuelto'],
        directives: {
          content: 'Evento 5 (guiar el aprendizaje): incluye un ejemplo resuelto paso a paso con el razonamiento de cada paso.',
          experience: 'Evento 5: un worked_example en la profundización resuelve paso a paso un caso del oficio.',
          video: 'Evento 5: demuestra paso a paso, con un ejemplo resuelto.',
          guided_practice: 'Evento 5: los ejercicios guían con pistas antes de la respuesta modelo.',
        },
      },
      {
        id: 'provocar_desempeno', order: 6, label: '6. Provocar el desempeño', studentLabel: '6 · Hazlo tú', slots: ['activity', 'self_check', 'application'], required: false,
        elements: ['Actividad interactiva', 'Actividad de Aplicación'],
        directives: {
          activity: 'Evento 6 (provocar el desempeño): la actividad pide ejecutar o decidir como en el trabajo, no solo recordar.',
          application_activity: 'Evento 6: los ejercicios y el taller piden el desempeño completo del objetivo.',
        },
      },
      {
        id: 'retroalimentar', order: 7, label: '7. Proporcionar retroalimentación', studentLabel: '7 · Revisa tu respuesta', slots: ['activity', 'guided_practice', 'application'], required: false,
        elements: ['Respuestas explicadas en cada actividad'],
        directives: {
          activity: 'Evento 7 (retroalimentar): cada respuesta trae la explicación de por qué es correcta o no.',
          video_interactions: 'Evento 7: cada pregunta del video explica la respuesta correcta y el error de las demás.',
          guided_practice: 'Evento 7: la respuesta modelo explica el criterio, no solo el resultado.',
          application_activity: 'Evento 7: la autoevaluación y el solucionario explican cada criterio.',
        },
      },
      {
        id: 'evaluar_desempeno', order: 8, label: '8. Evaluar el desempeño', studentLabel: '8 · Evaluación', slots: ['module_exam', 'final_exam'], required: false,
        elements: ['Evaluación del módulo con evidencias de conocimiento'],
        directives: {
          exam: 'Evento 8 (evaluar el desempeño): las preguntas evalúan el desempeño del módulo con situaciones ligadas a su objetivo.',
          final_exam: 'Evento 8: la evaluación final integra los desempeños del curso en situaciones nuevas.',
        },
      },
      {
        id: 'retencion_transferencia', order: 9, label: '9. Mejorar la retención y la transferencia', studentLabel: '9 · Llévalo a tu trabajo', slots: ['synthesis', 'review_cards', 'closing'], required: true,
        elements: ['Síntesis', 'Audiolibro', 'Guía de práctica'],
        directives: {
          experience: 'Evento 9 (retención y transferencia): la síntesis resume lo esencial y el cierre plantea cómo usarlo en otra situación del trabajo.',
          content: 'Evento 9: termina con un resumen y una situación nueva donde aplicar lo aprendido.',
          module_intro: 'Evento 9: el cierre del módulo conecta lo aprendido con situaciones nuevas del trabajo.',
        },
      },
    ],
    experienceRequirements: [
      {
        id: 'gagne.objective', phase: 'informar_objetivo', movements: ['opening'], anyOf: ['learning_objectives'],
        message: 'Gagné, evento 2 (informar el objetivo): la apertura debe incluir un "learning_objectives"',
      },
      {
        id: 'gagne.activation', phase: 'recordar_saberes', movements: ['opening'], anyOf: ['reflection'],
        message: 'Gagné, evento 3 (saberes previos): la apertura debe incluir un "reflection" con una pregunta de activación',
      },
      {
        id: 'gagne.guidance', phase: 'guiar_aprendizaje', movements: ['deepening'], anyOf: ['worked_example'],
        message: 'Gagné, evento 5 (guiar el aprendizaje): la profundización debe incluir un "worked_example"',
      },
    ],
  },
];

let defaultRegistry: InstructionalFrameworkRegistry | null = null;

/** Registro con los marcos incluidos (una instancia; los marcos están congelados). */
export function defaultFrameworkRegistry(): InstructionalFrameworkRegistry {
  if (!defaultRegistry) {
    const r = new InstructionalFrameworkRegistry();
    for (const d of BUILTIN_FRAMEWORKS) r.register(d);
    defaultRegistry = r;
  }
  return defaultRegistry;
}

/** Fases de un marco asignadas a un bloque (en orden). */
export function frameworkPhasesForSlot(fw: InstructionalFramework, slot: FrameworkSlot): FrameworkPhase[] {
  return fw.phases.filter((p) => p.slots.includes(slot));
}

/** Indicaciones del marco para un generador, en el orden de las fases. */
export function frameworkDirectivesFor(fw: InstructionalFramework, gen: string): Array<{ phase: FrameworkPhase; text: string }> {
  const out: Array<{ phase: FrameworkPhase; text: string }> = [];
  for (const p of fw.phases) {
    const t = (p.directives as Record<string, string | undefined>)[gen];
    if (t) out.push({ phase: p, text: t });
  }
  return out;
}

/** Rótulos visibles por bloque (solo bloques con fase): `bloque → «rótulo · rótulo»`. */
export function frameworkSlotLabels(fw: InstructionalFramework): Partial<Record<FrameworkSlot, string>> {
  const out: Partial<Record<FrameworkSlot, string>> = {};
  for (const s of FRAMEWORK_SLOTS) {
    const ps = frameworkPhasesForSlot(fw, s);
    if (ps.length) out[s] = ps.map((p) => p.studentLabel).join(' · ');
  }
  return out;
}
