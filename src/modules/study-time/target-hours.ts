// Motor de carga horaria — horas de estudio objetivo del curso (`targetHours`). Sin dependencias: lo
// importan el perfil del curso y el snapshot del Blueprint.

/** Rango admitido de `targetHours` (horas, en pasos de 0,5). */
export const TARGET_HOURS_MIN = 1;
export const TARGET_HOURS_MAX = 500;

/** ¿Es un objetivo de horas válido? (número finito en [1, 500], múltiplo de 0,5). */
export function isValidTargetHours(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= TARGET_HOURS_MIN && v <= TARGET_HOURS_MAX && Number.isInteger(v * 2);
}
