import { InstructionalFrameworkRegistry, defaultFrameworkRegistry, frameworkDirectivesFor, FrameworkExperienceRequirement } from './instructional-frameworks';
import { LEARNING_TYPE_LABELS } from './learning-type';
import { LEARNING_TYPES, LearningType } from './vocabulary';

/**
 * T2 (r57) · Plan de aprendizaje → indicaciones del brief (generator-directives.ts).
 *
 * Dos fuentes, ambas DATOS:
 *  - el tipo de aprendizaje del capítulo (qué tiene que hacer cada generador con un capítulo conceptual,
 *    procedimental, de protocolo, de decisión, de comunicación o normativo-ético);
 *  - el marco instruccional (las indicaciones de cada fase para ese generador).
 * Solo se agregan cuando el diseño del item las trae (plan activo); sin plan, el brief es el de siempre.
 */

/** Generadores del brief que reciben una indicación por tipo de aprendizaje. */
export const LEARNING_TYPE_DIRECTIVE_GENERATORS = [
  'content', 'experience', 'presentation', 'video', 'video_interactions', 'application_activity', 'guided_practice', 'scorm_activity',
] as const;

export const LEARNING_TYPE_DIRECTIVE_TEXT: Readonly<Record<LearningType, Readonly<Record<(typeof LEARNING_TYPE_DIRECTIVE_GENERATORS)[number], string>>>> = Object.freeze({
  conceptual: {
    content: 'Capítulo conceptual: define cada concepto con un ejemplo y un no-ejemplo, muestra cómo se relacionan y cierra con una aplicación corta.',
    experience: 'Capítulo conceptual: prioriza concept_cards, comparison o diagram para distinguir los conceptos; el ejemplo aplica el concepto a una situación corta.',
    presentation: 'Capítulo conceptual: diapositivas con cada concepto, un ejemplo y un no-ejemplo.',
    video: 'Capítulo conceptual: explica cada concepto con un ejemplo y un contraejemplo.',
    video_interactions: 'Capítulo conceptual: las preguntas piden reconocer el concepto en un ejemplo nuevo.',
    application_activity: 'Capítulo conceptual: los ejercicios piden clasificar ejemplos y aplicar el concepto a casos cortos.',
    guided_practice: 'Capítulo conceptual: ejercicios para distinguir ejemplos de no-ejemplos y explicar por qué.',
    scorm_activity: 'Capítulo conceptual: las salas piden reconocer y aplicar los conceptos en situaciones cortas.',
  },
  procedimental: {
    content: 'Capítulo procedimental: describe el procedimiento paso a paso con el criterio de calidad de cada paso, los errores frecuentes y un ejemplo resuelto completo.',
    experience: 'Capítulo procedimental: incluye un process_steps con los pasos y un worked_example que los ejecute con datos.',
    presentation: 'Capítulo procedimental: diapositivas con los pasos, sus criterios de calidad y los errores frecuentes.',
    video: 'Capítulo procedimental: el video es una demostración paso a paso de la tarea y nombra el criterio de cada paso.',
    video_interactions: 'Capítulo procedimental: las preguntas piden el paso siguiente o detectar el error en un paso.',
    application_activity: 'Capítulo procedimental: ejercicios graduados que ejecutan el procedimiento completo con datos nuevos.',
    guided_practice: 'Capítulo procedimental: práctica con apoyo que se retira de a poco: primero completar pasos, después ejecutar el procedimiento completo.',
    scorm_activity: 'Capítulo procedimental: las salas piden ejecutar pasos del procedimiento y detectar errores.',
  },
  protocolo: {
    content: 'Capítulo de protocolo: presenta la secuencia estandarizada, marca los pasos críticos que no se pueden omitir, cuándo se activa y qué pasa si se omite un paso.',
    experience: 'Capítulo de protocolo: incluye un process_steps con la secuencia y un checklist para verificar los pasos críticos.',
    presentation: 'Capítulo de protocolo: diapositivas con la secuencia, los pasos críticos y su verificación.',
    video: 'Capítulo de protocolo: demuestra la secuencia completa y resalta los pasos críticos.',
    video_interactions: 'Capítulo de protocolo: las preguntas piden el paso siguiente o el paso crítico que falta.',
    application_activity: 'Capítulo de protocolo: casos en los que el estudiante aplica el protocolo completo y verifica cada paso crítico.',
    guided_practice: 'Capítulo de protocolo: ejercicios para ordenar la secuencia y detectar pasos omitidos.',
    scorm_activity: 'Capítulo de protocolo: las salas piden ordenar la secuencia y detectar el paso crítico omitido.',
  },
  decision_caso: {
    content: 'Capítulo de decisión: plantea situaciones con alternativas, los criterios para decidir y las consecuencias de cada decisión.',
    experience: 'Capítulo de decisión: prioriza un case_scenario o un diagram de tipo decision con las alternativas y sus consecuencias.',
    presentation: 'Capítulo de decisión: diapositivas con la situación, las alternativas, los criterios y las consecuencias.',
    video: 'Capítulo de decisión: plantea una situación y muestra cómo se decide con los criterios del capítulo.',
    video_interactions: 'Capítulo de decisión: las preguntas son puntos de decisión con su consecuencia.',
    application_activity: 'Capítulo de decisión: casos en los que el estudiante decide, justifica con criterios y anticipa consecuencias.',
    guided_practice: 'Capítulo de decisión: situaciones cortas para decidir y justificar con los criterios del capítulo.',
    scorm_activity: 'Capítulo de decisión: cada sala es una decisión en una situación, con su consecuencia.',
  },
  comunicacion: {
    content: 'Capítulo de comunicación: muestra cómo se dice (frases modelo), contrasta una buena y una mala práctica y explica por qué funciona cada una.',
    experience: 'Capítulo de comunicación: incluye una comparison entre buena y mala práctica y un case_scenario de diálogo.',
    presentation: 'Capítulo de comunicación: diapositivas con buena y mala práctica y frases modelo.',
    video: 'Capítulo de comunicación: modela una conversación de buena práctica y señala qué la hace efectiva.',
    video_interactions: 'Capítulo de comunicación: las preguntas piden elegir la mejor respuesta en el diálogo.',
    application_activity: 'Capítulo de comunicación: situaciones de diálogo en las que el estudiante redacta o elige respuestas y reflexiona.',
    guided_practice: 'Capítulo de comunicación: ejercicios para reformular respuestas poco efectivas y justificar el cambio.',
    scorm_activity: 'Capítulo de comunicación: cada sala es un momento de un diálogo en el que se elige la mejor respuesta.',
  },
  normativo_etico: {
    content: 'Capítulo normativo o ético: presenta la regla aplicable, a quién obliga y un caso límite; explica cómo se aplica y cómo se justifica la decisión, sin inventar números de normas.',
    experience: 'Capítulo normativo o ético: incluye un case_scenario límite y un myth_reality o comparison que aclare lo que la norma exige y lo que no.',
    presentation: 'Capítulo normativo: diapositivas con la regla, su alcance y un caso límite.',
    video: 'Capítulo normativo o ético: explica la regla con un caso límite y cómo se justifica la decisión.',
    video_interactions: 'Capítulo normativo o ético: las preguntas piden aplicar la regla a un caso y justificar.',
    application_activity: 'Capítulo normativo o ético: casos límite en los que el estudiante aplica la regla y justifica su decisión.',
    guided_practice: 'Capítulo normativo o ético: casos cortos para identificar la regla aplicable y justificar.',
    scorm_activity: 'Capítulo normativo o ético: cada sala aplica la regla a un caso y pide la justificación.',
  },
});

/** Qué hace la actividad calificada según el tipo H5P elegido y el tipo de aprendizaje (datos). */
export const LEARNING_TYPE_ACTIVITY_TEXT: Readonly<Record<string, Partial<Record<LearningType | '*', string>>>> = Object.freeze({
  dragtext: {
    procedimental: 'Arrastrar y ordenar: el texto recorre los pasos del procedimiento en orden y los huecos son los pasos o criterios críticos.',
    protocolo: 'Arrastrar y ordenar: el texto recorre la secuencia del protocolo y los huecos son los pasos críticos, en su orden.',
    '*': 'Arrastrar y ordenar: los huecos relacionan cada concepto con su definición, ejemplo o categoría.',
  },
  blanks: {
    '*': 'Completar: los huecos son los términos clave del capítulo dentro de frases que los usan.',
  },
  questionset: {
    conceptual: 'Preguntas de aplicación: cada pregunta presenta una situación corta en la que hay que reconocer o usar el concepto.',
    procedimental: 'Preguntas de aplicación: cada pregunta pide ejecutar un paso, un cálculo o detectar un error con datos.',
    protocolo: 'Preguntas de caso: cuál es el paso siguiente o el paso crítico que falta.',
    decision_caso: 'Preguntas de caso: cada pregunta es una decisión en una situación, con la consecuencia en la retroalimentación.',
    comunicacion: 'Preguntas de juicio situacional: elegir la mejor respuesta en un diálogo y por qué.',
    normativo_etico: 'Preguntas de caso con justificación: aplicar la regla a un caso límite; la retroalimentación explica la regla que lo justifica.',
    '*': 'Preguntas de aplicación a situaciones del capítulo.',
  },
  branchingscenario: {
    comunicacion: 'Escenario ramificado como diálogo: cada respuesta del estudiante cambia la reacción de la otra persona.',
    normativo_etico: 'Escenario ramificado: cada decisión muestra qué exige la regla y la consecuencia de no cumplirla.',
    '*': 'Escenario ramificado: cada decisión lleva a una consecuencia distinta y a la siguiente decisión.',
  },
});

export interface LearningPlanDirective {
  target: string;
  value: string;
  label: string;
  instruction: string;
}

/** Generador del brief → clave de las indicaciones del marco (las actividades comparten «activity»). */
function frameworkGeneratorKey(gen: string): string {
  return gen === 'branching_scenario' || gen === 'scorm_activity' ? 'activity' : gen;
}

/**
 * Indicaciones del plan para un item (vacío = el item no trae plan). Falla fuerte con un tipo o un marco
 * desconocidos (vocabulario y textos desalineados = bug, nunca se ignora en silencio).
 */
export function learningPlanDirectives(
  gen: string,
  design: Record<string, any>,
  h5pType: string | undefined,
  frameworks: InstructionalFrameworkRegistry = defaultFrameworkRegistry(),
): LearningPlanDirective[] {
  const out: LearningPlanDirective[] = [];
  const lt = design.learningType;
  if (lt) {
    const type = lt.type as LearningType;
    if (!(LEARNING_TYPES as readonly string[]).includes(type)) throw new Error(`PEDAGOGY_DIRECTIVE_UNKNOWN: learningType=${JSON.stringify(type)} sin texto de generador`);
    const label = LEARNING_TYPE_LABELS[type];
    if (gen === 'activity' || gen === 'branching_scenario') {
      const table = h5pType ? LEARNING_TYPE_ACTIVITY_TEXT[h5pType] : undefined;
      const t = table ? table[type] ?? table['*'] : undefined;
      if (!t) throw new Error(`PEDAGOGY_DIRECTIVE_UNKNOWN: actividad ${JSON.stringify(h5pType)} sin texto para el tipo de aprendizaje ${type}`);
      out.push({ target: 'learningType', value: type, label, instruction: `Tipo de aprendizaje del capítulo: ${label}. ${t}` });
    } else {
      const t = (LEARNING_TYPE_DIRECTIVE_TEXT[type] as Record<string, string>)[gen];
      // El tipo de aprendizaje es del CAPÍTULO: si choca con el tipo de contenido general del curso, manda este.
      if (t) out.push({ target: 'learningType', value: type, label, instruction: `${t} Si choca con la indicación general del curso sobre el tipo de contenido, manda esta (es la de este capítulo).` });
    }
  }
  if (typeof design.framework === 'string') {
    const fw = frameworks.get(design.framework);
    const phases = frameworkDirectivesFor(fw, frameworkGeneratorKey(gen));
    for (const { phase, text } of phases) {
      out.push({ target: `framework.${phase.id}`, value: fw.id, label: `${fw.shortLabel} · ${phase.label}`, instruction: text });
    }
    // Los nombres de las fases son para el diseño (y, si el curso los muestra, los pone Cursia en rótulos fijos): el
    // texto generado nunca los escribe (mismo criterio que el vocabulario interno de T1).
    if (phases.length) {
      out.push({ target: 'framework', value: fw.id, label: fw.label, instruction: 'Aplica estas fases sin nombrarlas en el texto: no escribas «Evento 1», «Fase Teoría» ni el nombre de la metodología; el estudiante ve el resultado, no la etiqueta.' });
    }
  }
  return out;
}

/** Requisitos de la experiencia del marco del item (vacío sin marco o si el marco no los define). */
export function learningPlanExperienceRequirements(
  design: Record<string, any> | undefined,
  frameworks: InstructionalFrameworkRegistry = defaultFrameworkRegistry(),
): FrameworkExperienceRequirement[] {
  if (!design || typeof design.framework !== 'string') return [];
  return frameworks.get(design.framework).experienceRequirements.map((r) => ({ ...r, movements: [...r.movements], anyOf: [...r.anyOf] }));
}

/** Textos que faltan (vacío = completo) — check-learning-plan.js lo exige. */
export function missingLearningPlanTexts(): string[] {
  const missing: string[] = [];
  for (const t of LEARNING_TYPES) {
    for (const g of LEARNING_TYPE_DIRECTIVE_GENERATORS) if (!(LEARNING_TYPE_DIRECTIVE_TEXT[t] as Record<string, string>)?.[g]) missing.push(`learningType:${t}:${g}`);
    for (const h of ['dragtext', 'blanks', 'questionset', 'branchingscenario']) {
      const table = LEARNING_TYPE_ACTIVITY_TEXT[h];
      if (!table[t] && !table['*']) missing.push(`activity:${h}:${t}`);
    }
  }
  return missing;
}
