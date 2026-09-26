/**
 * R11a — tipo H5P de la actividad de un capítulo (variant h5p) y validación
 * del payload `activity` que produce el LLM.
 *
 * El tipo NO lo elige el LLM ni el navegador. Ruling del controlador (fix
 * round 1, review G5 I6): se deriva del UUID del capítulo — nunca de su
 * número — para que un reordenamiento (que R5 trata como REUSE) jamás cambie
 * el tipo de una actividad ya generada:
 *   type = ACTIVITY_H5P_ROTATION[fnv1a32(utf8(chapterId.toLowerCase())) % 3]
 * FNV-1a 32 bits estándar (offset 2166136261, primo 16777619, sin signo).
 * El frontend la replica (`dynActivityTypeForChapter`) contra los mismos
 * vectores (`scripts/fixtures/v21-activity-type-vectors.json`) y el backend la
 * impone al completar el item (un payload de otro tipo se rechaza).
 *
 * R-011: 'singlechoiceset' es un tipo de dato válido pero NO forma parte de
 * la rotación de actividades calificadas (Moodle core no lo califica) — ver
 * ACTIVITY_H5P_ROTATION.
 *
 * Payload (artifact `dynamic_h5p_params_json`):
 *   { type: 'questionset'|'singlechoiceset'|'dragtext'|'blanks', data }
 * `data` es la entrada de R7. `itemKey` y `passPercentage` los pone CURSIA
 * (el ejecutor los sobrescribe; nunca el LLM): `itemKey`, si viene, debe ser
 * la clave del item; `passPercentage` (QS/SCS), si viene, lo valida R7 y el
 * empaque lo reemplaza por la nota del perfil vigente (R12). Si faltan se
 * inyectan solo para correr el validador de R7.
 */
import {
  H5pInputError,
  validateBlanksInput,
  validateDragTextInput,
  validateQuestionSetInput,
  validateSingleChoiceSetInput,
} from '../../package/h5p';

export type H5pActivityType = 'questionset' | 'singlechoiceset' | 'dragtext' | 'blanks';

/**
 * Tipos H5P reconocidos por el validador de payload (incluye 'singlechoiceset',
 * que sigue siendo un tipo válido de dato pero YA NO es asignable a una
 * actividad calificada — ver ACTIVITY_H5P_ROTATION).
 */
const KNOWN_H5P_TYPES: readonly H5pActivityType[] = Object.freeze([
  'questionset',
  'singlechoiceset',
  'dragtext',
  'blanks',
]);

/**
 * Rotación canónica de actividades CALIFICADAS (orden vinculante; el frontend
 * la replica tal cual).
 *
 * R-011 (evidencia técnica de un player Moodle 4.5 real): Moodle core NO
 * califica H5P.SingleChoiceSet 1.11 — el intento queda guardado sin disparar
 * completion/grade. Por eso 'singlechoiceset' se excluyó de esta rotación.
 * El validador de SCS (`validateSingleChoiceSetInput`) se conserva por si se
 * usa más adelante como actividad NO calificada, pero para una actividad
 * calificada es inalcanzable: `validateH5pActivityPayload` rechaza cualquier
 * payload de tipo 'singlechoiceset' con H5P_TYPE_NOT_GRADABLE antes de llegar
 * a compararlo contra la rotación.
 */
export const ACTIVITY_H5P_ROTATION: readonly H5pActivityType[] = Object.freeze([
  'questionset',
  'dragtext',
  'blanks',
]);

/** FNV-1a de 32 bits (estándar) sobre los bytes UTF-8 de `s`; entero sin signo. */
export function fnv1a32(s: string): number {
  let h = 2166136261;
  for (const b of Buffer.from(s, 'utf8')) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Tipo H5P calificado del capítulo, derivado de su UUID (estable ante reordenamientos). */
export function activityTypeForChapter(chapterId: string): H5pActivityType {
  if (typeof chapterId !== 'string' || !chapterId.trim()) {
    throw new Error(`ACTIVITY_TYPE_INVALID_CHAPTER: chapterId debe ser un texto no vacío (recibido ${JSON.stringify(chapterId)})`);
  }
  return ACTIVITY_H5P_ROTATION[fnv1a32(chapterId.toLowerCase()) % ACTIVITY_H5P_ROTATION.length];
}

/** Campos de `data` que escribe el LLM por tipo (además, Cursia agrega itemKey y, en QS/SCS, passPercentage). */
export const H5P_ACTIVITY_DATA_FIELDS: Readonly<Record<H5pActivityType, readonly string[]>> = Object.freeze({
  questionset: ['title', 'questions'],
  singlechoiceset: ['title', 'questions'],
  dragtext: ['title', 'taskDescription', 'text'],
  blanks: ['title', 'text', 'questions'],
});

/** Solo para correr el validador de R7; el valor real sale del perfil al empaquetar. */
const VALIDATION_PASS_PERCENTAGE = 70;

export interface ShellValidationError {
  path: string;
  code: string;
  message: string;
}

export interface H5pActivityPayloadResult {
  ok: boolean;
  errors: ShellValidationError[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Valida el payload h5p de `activity:<ch>`: forma `{type, data}`, tipo igual
 * al de la rotación y `data` válido para el validador estricto de R7.
 * Junta todos los errores.
 */
export function validateH5pActivityPayload(
  payload: unknown,
  expect: { chapterId: string; itemKey: string },
): H5pActivityPayloadResult {
  const errors: ShellValidationError[] = [];
  const expectedType = activityTypeForChapter(expect.chapterId);
  if (!isPlainObject(payload)) {
    return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'el payload debe ser un objeto {type, data}' }] };
  }
  for (const k of Object.keys(payload)) {
    if (k !== 'type' && k !== 'data') errors.push({ path: `$.${k}`, code: 'UNKNOWN_FIELD', message: `campo no permitido "${k}"` });
  }
  const type = payload.type;
  if (typeof type !== 'string' || !(KNOWN_H5P_TYPES as readonly string[]).includes(type)) {
    errors.push({ path: '$.type', code: 'ACTIVITY_TYPE_UNKNOWN', message: `tipo desconocido ${JSON.stringify(type)}` });
    return { ok: false, errors };
  }
  if (type === 'singlechoiceset') {
    // R-011: Moodle core no dispara completion/grade para H5P.SingleChoiceSet
    // 1.11 — no es asignable a una actividad calificada, sin importar qué
    // pida la rotación para este capítulo.
    errors.push({
      path: '$.type',
      code: 'H5P_TYPE_NOT_GRADABLE',
      message: 'singlechoiceset (H5P.SingleChoiceSet) no es calificable en Moodle core (R-011); no puede usarse en una actividad calificada',
    });
    return { ok: false, errors };
  }
  if (type !== expectedType) {
    errors.push({
      path: '$.type',
      code: 'ACTIVITY_TYPE_MISMATCH',
      message: `el capítulo ${expect.chapterId} exige "${expectedType}" (rotación), llegó "${type}"`,
    });
    return { ok: false, errors };
  }
  const data = payload.data;
  if (!isPlainObject(data)) {
    errors.push({ path: '$.data', code: data === undefined ? 'MISSING_FIELD' : 'NOT_OBJECT', message: 'data debe ser un objeto' });
    return { ok: false, errors };
  }
  if ('itemKey' in data && data.itemKey !== expect.itemKey) {
    errors.push({ path: '$.data.itemKey', code: 'ITEM_KEY_MISMATCH', message: `itemKey debe ser "${expect.itemKey}"` });
  }
  const t = type as H5pActivityType;
  const input: Record<string, unknown> = { ...data, itemKey: expect.itemKey };
  if ((t === 'questionset' || t === 'singlechoiceset') && !('passPercentage' in data)) input.passPercentage = VALIDATION_PASS_PERCENTAGE;
  try {
    if (t === 'questionset') validateQuestionSetInput(input);
    else if (t === 'singlechoiceset') validateSingleChoiceSetInput(input);
    else if (t === 'dragtext') validateDragTextInput(input);
    else validateBlanksInput(input);
  } catch (err) {
    if (err instanceof H5pInputError) {
      for (const e of err.errors) errors.push({ path: '$.data', code: 'H5P_INPUT_INVALID', message: e });
    } else {
      throw err;
    }
  }
  return { ok: errors.length === 0, errors };
}
