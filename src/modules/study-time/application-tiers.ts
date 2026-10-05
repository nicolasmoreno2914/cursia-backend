// Fase 2 · Actividades de Aplicación — niveles de duración (minutos de trabajo del estudiante).
//
// Fuente ÚNICA de los niveles: el modelo de tiempo (STUDY_TIME_RULES.applicationActivityTiers), el Blueprint
// (chapters[].applicationMinutes), la columna course_chapters.application_minutes (CHECK) y el distribuidor.
// Sin dependencias para que el Blueprint lo importe sin arrastrar el modelo de tiempo.

export const APPLICATION_ACTIVITY_TIERS = Object.freeze([30, 60, 90, 120] as const);
export type ApplicationMinutes = (typeof APPLICATION_ACTIVITY_TIERS)[number];

export function isApplicationMinutes(v: unknown): v is ApplicationMinutes {
  return typeof v === 'number' && (APPLICATION_ACTIVITY_TIERS as readonly number[]).includes(v);
}
