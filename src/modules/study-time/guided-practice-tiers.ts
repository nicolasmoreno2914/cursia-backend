// Loop 9 B · «Práctica guiada del capítulo» — niveles de duración (minutos de trabajo del estudiante).
//
// Formativa y sin nota: NO es una Actividad de Aplicación (sin solucionario oculto, sin calificación, más corta y dentro
// del alcance del capítulo). Solo en capítulos de CONTENIDO. Fuente ÚNICA de los niveles y de los ejercicios por nivel:
// el modelo de tiempo, el Blueprint (chapters[].guidedPracticeMinutes), la columna course_chapters.guided_practice_minutes
// (CHECK), el distribuidor, el claim del ejecutor y el validador del artifact. Cursia fija los minutos y los ejercicios;
// la IA nunca. Sin dependencias para que el Blueprint lo importe sin arrastrar el modelo de tiempo.

/** Niveles de la práctica guiada (0 = sin práctica guiada; no es un nivel). */
export const GUIDED_PRACTICE_TIERS = Object.freeze([40, 60, 80, 120] as const);
export type GuidedPracticeMinutes = (typeof GUIDED_PRACTICE_TIERS)[number];

/** Ejercicios por nivel: 40 = 2×20, 60 = 2×30, 80 = 2×40, 120 = 3×40 (minutos de cada ejercicio). */
export const GUIDED_PRACTICE_EXERCISES_BY_MINUTES: Readonly<Record<GuidedPracticeMinutes, readonly number[]>> = Object.freeze({
  40: Object.freeze([20, 20]),
  60: Object.freeze([30, 30]),
  80: Object.freeze([40, 40]),
  120: Object.freeze([40, 40, 40]),
});

export function isGuidedPracticeMinutes(v: unknown): v is GuidedPracticeMinutes {
  return typeof v === 'number' && (GUIDED_PRACTICE_TIERS as readonly number[]).includes(v);
}

/** Plan de ejercicios de un nivel: ids E1.. y minutos de cada uno (los pone Cursia). */
export function guidedPracticeExercisePlan(minutes: number): { id: string; minutes: number }[] {
  if (!isGuidedPracticeMinutes(minutes)) throw new Error(`GUIDED_PRACTICE_MINUTES_INVALID: ${JSON.stringify(minutes)} (permitidos: ${GUIDED_PRACTICE_TIERS.join(', ')})`);
  return GUIDED_PRACTICE_EXERCISES_BY_MINUTES[minutes].map((m, i) => ({ id: `E${i + 1}`, minutes: m }));
}
