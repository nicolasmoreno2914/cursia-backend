/**
 * R11a — microcopy determinístico en español (audit §F.2: "Las transiciones
 * las escribe Cursia, no el LLM"). Plantillas puras: cada número viene de
 * `facts` (capítulo, módulo, nota mínima, intentos, preguntas). Ninguna
 * plantilla menciona un recurso que no exista: cada una se elige según los
 * flags del capítulo/módulo/curso.
 */
import type { GradeMethod } from '../course-profiles/course-profiles';

export const COPY = Object.freeze({
  videoPrimerTitle: 'Antes de ver el video',
  videoPrimerLead: 'En el video de este capítulo, fíjate en estas ideas:',
  videoGo:
    'Ahora mira el video. Durante la reproducción aparecerán preguntas: respóndelas y, al final, envía tus respuestas para que queden registradas.',
  activityTitle: 'Pon a prueba lo aprendido',
  selfCheckLead: 'Antes de seguir, repasa lo aprendido: intenta responder cada pregunta y después revisa la respuesta.',
  lastChapterOfCourse: 'Con este capítulo terminas el recorrido de los contenidos del curso.',
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

export function activityInstruction(passingGrade: number, attempts: number): string {
  return `La actividad práctica que sigue es calificada. ${passingText(passingGrade)} ${attemptsText(attempts)}`;
}

export function continueWith(next: { number: number; title: string }): string {
  return `Continúa con el capítulo ${next.number}: ${next.title}.`;
}

/** Puente determinístico al final del capítulo (§F.3: con actividad OFF habla de "repasar"). */
export function bridgeText(opts: {
  activityEnabled: boolean;
  next?: { number: number; title: string } | null;
}): string {
  const lead = opts.activityEnabled
    ? 'Si todavía no alcanzaste la nota mínima en la práctica, vuelve a intentarlo.'
    : 'Repasa las ideas clave de este capítulo antes de avanzar.';
  const tail = opts.next ? continueWith(opts.next) : COPY.lastChapterOfCourse;
  return `${lead} ${tail}`;
}

/** Transición al examen del módulo (solo si el módulo TIENE examen). */
export function moduleExamTransition(m: { number: number; examQuestionCount: number }, passingGrade: number): string {
  return (
    `Con este capítulo terminas el módulo ${m.number}. A continuación encontrarás la evaluación del módulo: ` +
    `${m.examQuestionCount} ${m.examQuestionCount === 1 ? 'pregunta' : 'preguntas'} y una nota mínima de ${passingGrade} de 100.`
  );
}
