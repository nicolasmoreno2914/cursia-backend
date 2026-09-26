/**
 * R11a — tipo H5P de la actividad de un capítulo (variant h5p) y validación
 * del payload `activity` que produce el LLM.
 *
 * El tipo NO lo elige el LLM ni el navegador: es una rotación determinística
 * por número GLOBAL de capítulo (1-based, numeración del Manifest). El
 * frontend la replica (`dynActivityTypeForChapter`) y el backend la impone al
 * completar el item (un payload de otro tipo se rechaza).
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

/** Rotación canónica (orden vinculante; el frontend la replica tal cual). */
export const ACTIVITY_H5P_ROTATION: readonly H5pActivityType[] = Object.freeze([
  'questionset',
  'dragtext',
  'singlechoiceset',
  'blanks',
]);

/** Tipo H5P del capítulo N (1-based, numeración global del Manifest). */
export function activityTypeForChapter(chapterNumber: number): H5pActivityType {
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error(`ACTIVITY_TYPE_INVALID_CHAPTER: chapterNumber debe ser un entero ≥ 1 (recibido ${String(chapterNumber)})`);
  }
  return ACTIVITY_H5P_ROTATION[(chapterNumber - 1) % ACTIVITY_H5P_ROTATION.length];
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
  expect: { chapterNumber: number; itemKey: string },
): H5pActivityPayloadResult {
  const errors: ShellValidationError[] = [];
  const expectedType = activityTypeForChapter(expect.chapterNumber);
  if (!isPlainObject(payload)) {
    return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'el payload debe ser un objeto {type, data}' }] };
  }
  for (const k of Object.keys(payload)) {
    if (k !== 'type' && k !== 'data') errors.push({ path: `$.${k}`, code: 'UNKNOWN_FIELD', message: `campo no permitido "${k}"` });
  }
  const type = payload.type;
  if (typeof type !== 'string' || !(ACTIVITY_H5P_ROTATION as readonly string[]).includes(type)) {
    errors.push({ path: '$.type', code: 'ACTIVITY_TYPE_UNKNOWN', message: `tipo desconocido ${JSON.stringify(type)}` });
    return { ok: false, errors };
  }
  if (type !== expectedType) {
    errors.push({
      path: '$.type',
      code: 'ACTIVITY_TYPE_MISMATCH',
      message: `el capítulo ${expect.chapterNumber} exige "${expectedType}" (rotación), llegó "${type}"`,
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
