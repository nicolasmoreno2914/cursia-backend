/**
 * R11a — microcopy determinístico en español (audit §F.2: "Las transiciones
 * las escribe Cursia, no el LLM"). Plantillas puras: cada número viene de
 * `facts` (capítulo, módulo, nota mínima, intentos, preguntas). Ninguna
 * plantilla menciona un recurso que no exista: cada una se elige según los
 * flags del capítulo/módulo/curso.
 */
import type { GradeMethod } from '../course-profiles/course-profiles';
import type { H5pActivityType } from './activity-type';

export const COPY = Object.freeze({
  videoPrimerTitle: 'Antes de ver el video',
  videoPrimerLead: 'En el video de este capítulo, fíjate en estas ideas:',
  videoGo:
    'Ahora mira el video. Durante la reproducción aparecerán preguntas: respóndelas y, al final, envía tus respuestas para que queden registradas.',
  activityTitle: 'Pon a prueba lo aprendido',
  selfCheckLead: 'Antes de seguir, repasa lo aprendido: intenta responder cada pregunta y después revisa la respuesta.',
  lastChapterOfCourse: 'Con este capítulo terminas el recorrido de los contenidos del curso.',
  /** EV6 T5 (ruling 3): aviso neutral en lugar del video pendiente (vista previa) de un capítulo. */
  videoPendingNotice: 'El video interactivo de este capítulo estará disponible en una próxima versión del curso.',
});

export function attemptsText(attempts: number): string {
  if (!Number.isInteger(attempts) || attempts < 0) throw new Error(`MICROCOPY: intentos inválidos (${attempts})`);
  if (attempts === 0) return 'Puedes intentarlo todas las veces que quieras.';
  return attempts === 1 ? 'Tienes 1 intento.' : `Tienes ${attempts} intentos.`;
}

export function attemptsValue(attempts: number): string {
  return attempts === 0 ? 'ilimitados' : String(attempts);
}

export function passingText(passingGrade: number): string {
  return `Para aprobarla necesitas al menos ${passingGrade} de 100.`;
}

export const GRADE_METHOD_ES: Readonly<Record<GradeMethod, string>> = Object.freeze({
  highest: 'la mejor calificación de tus intentos',
  average: 'el promedio de tus intentos',
  first: 'la calificación del primer intento',
  last: 'la calificación del último intento',
});

/** EV5 — qué hará el estudiante, según el tipo de actividad (antes: la misma frase en todas). */
const ACTIVITY_TASK_ES: Readonly<Record<H5pActivityType | 'branchingscenario' | 'scorm', string>> = Object.freeze({
  questionset: 'Responderás preguntas de opción múltiple y de verdadero o falso sobre el capítulo.',
  singlechoiceset: 'Responderás preguntas de opción única sobre el capítulo.',
  dragtext: 'Arrastrarás cada término al lugar que le corresponde dentro de un texto.',
  blanks: 'Completarás un texto escribiendo la palabra que falta en cada espacio.',
  // EV6 H5P v2: caso ramificado (solo Manifests con activityTypeRules = 2).
  branchingscenario: 'Tomarás decisiones en un caso de tu trabajo; cada camino lleva a un final con su puntaje.',
  scorm: 'Resolverás un reto interactivo por etapas con lo que aprendiste en el capítulo.',
});

/** P3 — solo la tarea («Arrastrarás cada término…»): la nota mínima y los intentos van en la fila de datos. */
export function activityTask(activityType?: string | null): string {
  return (activityType ? ACTIVITY_TASK_ES[activityType as H5pActivityType | 'branchingscenario' | 'scorm'] : undefined) ?? 'Aplicarás lo aprendido en el capítulo en una actividad calificada.';
}


export function continueWith(next: { number: number; title: string }): string {
  return `Continúa con el capítulo ${next.number}: ${next.title}.`;
}

/** EV6 — último capítulo de un módulo SIN examen (el botón lleva al módulo siguiente). */
export function moduleEndText(moduleNumber: number): string {
  return `Con este capítulo terminas el módulo ${moduleNumber}.`;
}

/** Puente determinístico al final del capítulo (§F.3: con actividad OFF habla de "repasar"). */
export function bridgeText(opts: {
  activityEnabled: boolean;
  /** Intentos de la actividad (facts.assessment.kinds.activity.attempts; 0 = ilimitados). Fix round 1 (M4). */
  activityAttempts?: number;
  next?: { number: number; title: string } | null;
}): string {
  const attempts = opts.activityAttempts ?? 0;
  const lead = !opts.activityEnabled
    ? 'Repasa las ideas clave de este capítulo antes de avanzar.'
    : attempts === 0
      ? 'Si todavía no alcanzaste la nota mínima en la práctica, vuelve a intentarlo.'
      : attempts === 1
        ? 'Revisa tu resultado en la práctica y repasa lo que necesites.'
        : 'Si todavía no alcanzaste la nota mínima en la práctica y te quedan intentos, vuelve a intentarlo.';
  const tail = opts.next ? continueWith(opts.next) : COPY.lastChapterOfCourse;
  return `${lead} ${tail}`;
}

/** R14-A — solo la parte "repasa / reintenta" del puente (va como párrafo, fuera de la transición). */
export function bridgeLead(opts: { activityEnabled: boolean; activityAttempts?: number }): string {
  const full = bridgeText({ ...opts, next: { number: 1, title: 'x' } });
  return full.slice(0, full.indexOf(' Continúa con el capítulo'));
}

/** Transición al examen del módulo (solo si el módulo TIENE examen). */
export function moduleExamTransition(m: { number: number; examQuestionCount: number }, passingGrade: number): string {
  return (
    `Con este capítulo terminas el módulo ${m.number}. A continuación encontrarás la evaluación del módulo: ` +
    `${m.examQuestionCount} ${m.examQuestionCount === 1 ? 'pregunta' : 'preguntas'} y una nota mínima de ${passingGrade} de 100.`
  );
}
