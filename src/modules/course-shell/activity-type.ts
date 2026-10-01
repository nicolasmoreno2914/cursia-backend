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
  validateBranchingScenarioData,
  validateDragTextInput,
  validateQuestionSetInput,
  validateSingleChoiceSetInput,
} from '../../package/h5p';
import { lintResourceMentions } from '../visual-components';

export type H5pActivityType = 'questionset' | 'singlechoiceset' | 'dragtext' | 'blanks';

/**
 * EV6 H5P v2 — tipos de actividad calificada que SOLO existen bajo el marcador
 * `features.activityTypeRules = 2` (CURSIA_H5P_PROFILE_V2). Con cualquier otro
 * marcador (0/1/ausente) un payload con estos tipos se trata exactamente como
 * antes: ACTIVITY_TYPE_UNKNOWN.
 */
export type H5pActivityTypeRules2Only = 'branchingscenario';
export type H5pActivityTypeV2 = H5pActivityType | H5pActivityTypeRules2Only;
export const H5P_ACTIVITY_TYPES_RULES2_ONLY: readonly H5pActivityTypeRules2Only[] = Object.freeze(['branchingscenario']);
/** Valor del marcador `features.activityTypeRules` que habilita los tipos de H5P v2. */
export const ACTIVITY_TYPE_RULES_H5P_V2 = 2;

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

/** Origen del tipo de una actividad h5p: congelado en el Manifest (EV5-C) o rotación por hash. */
export type ActivityTypeSource = 'manifest' | 'rotation';

/** Forma mínima de un item de Manifest que necesita el resolvedor (ManifestItem, item de invalidación, JSON crudo). */
export interface ActivityTypeItemLike {
  key?: string;
  type?: string;
  variant?: string | null;
  chapterId?: string | null;
  h5pType?: string | null;
}

function chapterIdOfItem(item: ActivityTypeItemLike): string {
  if (typeof item.chapterId === 'string' && item.chapterId) return item.chapterId;
  const k = typeof item.key === 'string' ? item.key : '';
  const i = k.indexOf(':');
  return i >= 0 ? k.slice(i + 1) : '';
}

/**
 * EV5-C — ÚNICO resolvedor del tipo H5P de un item del Manifest. Todos los
 * consumidores (claim del scheduler, validación al completar, facts del
 * shell → validador del .mbz, invalidación) pasan por acá:
 *   activity variant 'h5p' → `item.h5pType` (Manifest con activityTypeRules=1)
 *                            ?? activityTypeForChapter(chapterId) (legacy: hash);
 *   cualquier otro item    → null.
 * Un `h5pType` fuera de la rotación calificada lanza (integridad rota: nunca
 * se cae en silencio al hash).
 */
export function resolveActivityType(
  item: ActivityTypeItemLike | null | undefined,
  opts?: { activityTypeRules?: number | null },
): H5pActivityTypeV2 | null {
  return resolveActivityTypeWithSource(item, opts)?.type ?? null;
}

/**
 * EV6 H5P v2: `opts.activityTypeRules` = marcador del Manifest del item. Solo con 2 se acepta
 * `h5pType: 'branchingscenario'`; con cualquier otro (o sin opts) lanza como siempre.
 */
export function resolveActivityTypeWithSource(
  item: ActivityTypeItemLike | null | undefined,
  opts?: { activityTypeRules?: number | null },
): { type: H5pActivityTypeV2; source: ActivityTypeSource } | null {
  if (!item) return null;
  const type = item.type ?? (typeof item.key === 'string' ? item.key.slice(0, Math.max(0, item.key.indexOf(':'))) : undefined);
  if (type !== 'activity' || item.variant !== 'h5p') return null;
  if (item.h5pType !== undefined && item.h5pType !== null) {
    if (opts?.activityTypeRules === ACTIVITY_TYPE_RULES_H5P_V2 && (H5P_ACTIVITY_TYPES_RULES2_ONLY as readonly string[]).includes(item.h5pType)) {
      return { type: item.h5pType as H5pActivityTypeV2, source: 'manifest' };
    }
    if (!(ACTIVITY_H5P_ROTATION as readonly string[]).includes(item.h5pType)) {
      throw new Error(`ACTIVITY_TYPE_INVALID_MANIFEST: h5pType ${JSON.stringify(item.h5pType)} de ${item.key ?? 'activity'} no es un tipo calificado`);
    }
    return { type: item.h5pType as H5pActivityType, source: 'manifest' };
  }
  return { type: activityTypeForChapter(chapterIdOfItem(item)), source: 'rotation' };
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
 * al esperado y `data` válido para el validador estricto de R7.
 * `expectedType` (EV5-C) = `resolveActivityType(item del Manifest)`; sin él,
 * la rotación por hash de siempre. Junta todos los errores.
 */
export function validateH5pActivityPayload(
  payload: unknown,
  expect: {
    chapterId: string;
    itemKey: string;
    expectedType?: H5pActivityTypeV2 | null;
    /** EV6: marcador `features.activityTypeRules` del Manifest congelado (2 habilita branchingscenario). */
    activityTypeRules?: number | null;
  },
): H5pActivityPayloadResult {
  const errors: ShellValidationError[] = [];
  const fromManifest = !!expect.expectedType;
  const rules2 = expect.activityTypeRules === ACTIVITY_TYPE_RULES_H5P_V2;
  if (expect.expectedType && (H5P_ACTIVITY_TYPES_RULES2_ONLY as readonly string[]).includes(expect.expectedType) && !rules2) {
    return {
      ok: false,
      errors: [
        {
          path: '$.type',
          code: 'ACTIVITY_TYPE_RULES',
          message: `"${expect.expectedType}" solo es válido con activityTypeRules=${ACTIVITY_TYPE_RULES_H5P_V2} (recibido ${JSON.stringify(expect.activityTypeRules ?? null)})`,
        },
      ],
    };
  }
  const expectedType = expect.expectedType ?? activityTypeForChapter(expect.chapterId);
  if (!isPlainObject(payload)) {
    return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'el payload debe ser un objeto {type, data}' }] };
  }
  for (const k of Object.keys(payload)) {
    if (k !== 'type' && k !== 'data') errors.push({ path: `$.${k}`, code: 'UNKNOWN_FIELD', message: `campo no permitido "${k}"` });
  }
  const type = payload.type;
  const known: readonly string[] = rules2 ? [...KNOWN_H5P_TYPES, ...H5P_ACTIVITY_TYPES_RULES2_ONLY] : KNOWN_H5P_TYPES;
  if (typeof type !== 'string' || !known.includes(type)) {
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
      message: `el capítulo ${expect.chapterId} exige "${expectedType}" (${fromManifest ? 'Manifest' : 'rotación'}), llegó "${type}"`,
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
  if (type === 'branchingscenario') {
    for (const e of validateBranchingScenarioData(data, { allowItemKey: true })) errors.push({ path: `$.data.${e.path}`.replace(/\.\$$/, ''), code: e.code, message: e.message });
    for (const [p, txt] of branchingScenarioTexts(data)) {
      for (const hit of lintResourceMentions(txt)) {
        errors.push({ path: `$.data.${p}`, code: 'RESOURCE_MENTION', message: `menciona un recurso del curso ("${hit.match}"): el caso debe sostenerse solo` });
      }
    }
    return { ok: errors.length === 0, errors };
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

/** Textos (ruta, valor) de un payload branchingscenario para los lints livianos. */
function branchingScenarioTexts(data: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const take = (p: string, v: unknown) => {
    if (typeof v === 'string') out.push([p, v]);
  };
  take('title', data.title);
  take('situation', data.situation);
  if (Array.isArray(data.decisions)) {
    data.decisions.forEach((d, i) => {
      if (!isPlainObject(d)) return;
      take(`decisions[${i}].question`, d.question);
      if (Array.isArray(d.options)) {
        d.options.forEach((o, j) => {
          if (!isPlainObject(o)) return;
          take(`decisions[${i}].options[${j}].text`, o.text);
          take(`decisions[${i}].options[${j}].consequence`, o.consequence);
        });
      }
    });
  }
  if (Array.isArray(data.endings)) {
    data.endings.forEach((e, i) => {
      if (!isPlainObject(e)) return;
      take(`endings[${i}].title`, e.title);
      take(`endings[${i}].text`, e.text);
    });
  }
  return out;
}
