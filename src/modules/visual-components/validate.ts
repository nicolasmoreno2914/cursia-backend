/**
 * R2 — Visual Components: validador estricto del documento de experiencia.
 *
 * validateExperience(doc) junta TODOS los errores (no corta en el primero) para que
 * el reintento del LLM reciba la lista completa. Errores: { path, code, message }.
 *
 * Lints de texto exportados por separado (reutilizables en R11 para intros):
 *  - lintResourceMentions  → RESOURCE_MENTION (el LLM nunca nombra recursos; §F.2)
 *  - lintQuantityClaims    → QUANTITY_CLAIM (dígitos pegados a módulos, capítulos, %…)
 */
import {
  ChapterExperience,
  VC_BRIDGE_MAX,
  VC_CHAPTER_ID_MAX,
  VC_COMPONENT_SPECS,
  VC_MAX_SAME_TYPE,
  VC_MIN_DISTINCT_TYPES,
  VC_MOVEMENT_IDS,
  VC_MOVEMENT_LIMITS,
  VC_SCHEMA_VERSION,
  VcComponentType,
  VcFieldSpec,
} from './schema';
import { lintView } from './text';

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export type VcErrorCode =
  | 'NOT_OBJECT'
  | 'SCHEMA_VERSION'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'TYPE_MISMATCH'
  | 'UNKNOWN_COMPONENT'
  | 'ENUM_VALUE'
  | 'COUNT_RANGE'
  | 'ARITY_MISMATCH'
  | 'MOVEMENT_RANGE'
  | 'COMPONENT_NOT_ALLOWED'
  | 'TYPE_DIVERSITY'
  | 'TYPE_REPEATED'
  | 'TEXT_EMPTY'
  | 'TEXT_TOO_LONG'
  | 'TEXT_FORMAT'
  | 'HTML_IN_TEXT'
  | 'RESOURCE_MENTION'
  | 'QUANTITY_CLAIM'
  | 'CHAPTER_ID';

export interface VcValidationError {
  path: string;
  code: VcErrorCode;
  message: string;
}

export interface VcValidationResult {
  ok: boolean;
  errors: VcValidationError[];
}

export interface VcTextLintHit {
  code: 'RESOURCE_MENTION' | 'QUANTITY_CLAIM';
  /** Coincidencia sobre el texto normalizado (minúsculas, sin acentos). */
  match: string;
}

// ─── Text lints ─────────────────────────────────────────────────────────────

/** minúsculas + sin diacríticos (ñ → n incluido); preserva longitud semántica de palabras. */
function normalizeForLint(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036F]/g, '').toLowerCase();
}

// Límites de palabra Unicode (\b de JS es solo ASCII).
const WB_START = '(?<![\\p{L}\\p{N}_])';
const WB_END = '(?![\\p{L}\\p{N}_])';

/**
 * RESOURCE_MENTION (ruling del controlador, fix round 1 / I4): detecta REFERENCIAS a recursos
 * o navegación del curso ("en el video", "la actividad interactiva", "el examen"), no el
 * vocabulario del dominio ("juego de roles", "evaluación de riesgos", "presentación de
 * resultados", "actividad económica"). Se evalúa sobre el texto normalizado (minúsculas, sin
 * acentos, sin `**`, espacios simples).
 */
const DET_SG_M = '(?:el|este|ese|del|al|un|en el|siguiente|proximo|ultimo)';
const DET_PL_M = '(?:los|estos|esos|unos|en los|siguientes|proximos)';
const DET_SG_F = '(?:la|esta|esa|una|en la|siguiente|proxima|ultima)';
const DET_PL_F = '(?:las|estas|esas|unas|en las|siguientes|proximas)';
/** "presentación de/del X" es dominio salvo que X sea una unidad del curso. */
const COURSE_UNIT = '(?:(?:este|esta|el|la)\\s+)?(?:capitulo|modulo|tema|curso|unidad|leccion)';
/** "examen físico/médico…" es dominio. */
const EXAM_DOMAIN = '(?:fisico|medico|clinico|oftalmologico|visual|de sangre|de laboratorio|de conciencia)';
const RESOURCE_PATTERNS = [
  `${DET_SG_M}\\s+video`,
  `${DET_PL_M}\\s+videos`,
  `${DET_SG_F}\\s+actividad\\s+(?:interactiva|practica|gamificada|de practica|calificada|evaluada|siguiente|final)`,
  `${DET_PL_F}\\s+actividades\\s+(?:interactivas|practicas|gamificadas|de practica|calificadas|evaluadas)`,
  `(?:en|con)\\s+la\\s+siguiente\\s+actividad`,
  `${DET_SG_M}\\s+examen(?!\\s+${EXAM_DOMAIN})`,
  `${DET_PL_M}\\s+examenes(?!\\s+${EXAM_DOMAIN})`,
  `${DET_SG_F}\\s+evaluacion\\s+(?:del modulo|de la unidad|del capitulo|del curso|final|calificada|siguiente)`,
  `${DET_SG_F}\\s+presentacion(?!\\s+(?:de|del)\\s+(?!${COURSE_UNIT}))`,
  `${DET_PL_F}\\s+presentaciones(?!\\s+(?:de|del)\\s+(?!${COURSE_UNIT}))`,
  'diapositivas?',
  'quiz(?:zes|es)?',
  'scorm',
  'h5p',
  'juegos?\\s+(?:interactivos?|gamificados?|educativos?|de practica|del capitulo|del modulo)',
  '(?:el|este|al|del)\\s+(?:siguiente|proximo)\\s+recurso',
];
const RESOURCE_RE = new RegExp(`${WB_START}(?:${RESOURCE_PATTERNS.join('|')})${WB_END}`, 'gu');

const QUANTITY_WORDS = [
  'modulos?',
  'capitulos?',
  'videos?',
  'actividad(?:es)?',
  'preguntas?',
  'intentos?',
  'minutos?',
  'horas?',
  'paginas?',
].join('|');
const NUM = '\\d+(?:[.,]\\d+)?';
// "3 módulos", "30%", "30 %", "capítulo 3", "módulo n° 2".
const QUANTITY_RE = new RegExp(
  [
    `${WB_START}${NUM}\\s*%`,
    `${WB_START}${NUM}\\s*(?:${QUANTITY_WORDS})${WB_END}`,
    `${WB_START}(?:${QUANTITY_WORDS})\\s*(?:n\\s*[°º.]?\\s*)?${NUM}`,
  ].join('|'),
  'gu',
);

export function lintResourceMentions(text: string): VcTextLintHit[] {
  const norm = normalizeForLint(lintView(String(text ?? '')));
  return Array.from(norm.matchAll(RESOURCE_RE), (m) => ({ code: 'RESOURCE_MENTION' as const, match: m[0] }));
}

export function lintQuantityClaims(text: string): VcTextLintHit[] {
  const norm = normalizeForLint(lintView(String(text ?? '')));
  return Array.from(norm.matchAll(QUANTITY_RE), (m) => ({ code: 'QUANTITY_CLAIM' as const, match: m[0] }));
}

// ─── Plain-text checks ──────────────────────────────────────────────────────

/** Cualquier cosa con forma de tag/comentario/doctype HTML (`<b`, `</p`, `<!--`, `<?`). "a < b" no cuenta. */
const HTML_TAG_RE = /<(?:\/?[a-zA-Z]|!|\?)/;
// Controles prohibidos (se permiten \n y \t en textos largos).
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// Invisibles que evadirían los lints ("vid\u200Beo") o romperían el renderer (uso privado).
const INVISIBLE_RE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\uE000-\uF8FF]/;

function checkText(value: unknown, path: string, max: number, errors: VcValidationError[]): void {
  if (typeof value !== 'string') {
    errors.push({ path, code: 'TYPE_MISMATCH', message: 'se esperaba texto (string)' });
    return;
  }
  if (value.trim().length === 0) {
    errors.push({ path, code: 'TEXT_EMPTY', message: 'texto vacío' });
    return;
  }
  const len = Array.from(value).length;
  if (len > max) {
    errors.push({ path, code: 'TEXT_TOO_LONG', message: `${len} caracteres > máximo ${max}` });
  }
  if (HTML_TAG_RE.test(value)) {
    errors.push({ path, code: 'HTML_IN_TEXT', message: 'el texto contiene algo con forma de etiqueta HTML' });
  }
  if (CONTROL_RE.test(value)) {
    errors.push({ path, code: 'TEXT_FORMAT', message: 'caracteres de control no permitidos' });
  }
  if (INVISIBLE_RE.test(value)) {
    errors.push({ path, code: 'TEXT_FORMAT', message: 'caracteres invisibles/de formato (ancho cero, guion suave, bidi, uso privado) no permitidos' });
  }
  const stars = value.split('**').length - 1;
  if (stars % 2 !== 0) {
    errors.push({ path, code: 'TEXT_FORMAT', message: 'énfasis **…** sin cerrar' });
  }
  for (const hit of lintResourceMentions(value)) {
    errors.push({ path, code: 'RESOURCE_MENTION', message: `menciona un recurso: "${hit.match}"` });
  }
  for (const hit of lintQuantityClaims(value)) {
    errors.push({ path, code: 'QUANTITY_CLAIM', message: `afirma una cantidad: "${hit.match}"` });
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkCount(arr: unknown[], min: number, max: number, path: string, errors: VcValidationError[]): void {
  if (arr.length < min || arr.length > max) {
    errors.push({ path, code: 'COUNT_RANGE', message: `${arr.length} elementos, se esperaban ${min}–${max}` });
  }
}

function checkField(spec: VcFieldSpec, value: unknown, path: string, errors: VcValidationError[]): void {
  switch (spec.kind) {
    case 'text':
      checkText(value, path, spec.max, errors);
      return;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        errors.push({ path, code: 'ENUM_VALUE', message: `valor inválido; permitido: ${spec.values.join(', ')}` });
      }
      return;
    case 'textList':
      if (!Array.isArray(value)) {
        errors.push({ path, code: 'TYPE_MISMATCH', message: 'se esperaba una lista de textos' });
        return;
      }
      checkCount(value, spec.min, spec.max, path, errors);
      value.forEach((item, i) => checkText(item, `${path}[${i}]`, spec.itemMax, errors));
      return;
    case 'objList':
      if (!Array.isArray(value)) {
        errors.push({ path, code: 'TYPE_MISMATCH', message: 'se esperaba una lista de objetos' });
        return;
      }
      checkCount(value, spec.min, spec.max, path, errors);
      value.forEach((item, i) => checkObject(spec.fields, item, `${path}[${i}]`, errors));
      return;
  }
}

function checkObject(
  fields: Record<string, VcFieldSpec>,
  value: unknown,
  path: string,
  errors: VcValidationError[],
  implicit: string[] = [],
): void {
  if (!isPlainObject(value)) {
    errors.push({ path, code: 'NOT_OBJECT', message: 'se esperaba un objeto' });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!hasOwn(fields, key) && !implicit.includes(key)) {
      errors.push({ path: `${path}.${key}`, code: 'UNKNOWN_FIELD', message: `campo no permitido "${key}"` });
    }
  }
  for (const [key, spec] of Object.entries(fields)) {
    const v = value[key];
    if (v === undefined) {
      if (!spec.optional) errors.push({ path: `${path}.${key}`, code: 'MISSING_FIELD', message: `falta "${key}"` });
      continue;
    }
    checkField(spec, v, `${path}.${key}`, errors);
  }
}

/** Valida un componente suelto (sin reglas de movimiento). */
export function validateComponent(c: unknown, path = 'component'): VcValidationError[] {
  const errors: VcValidationError[] = [];
  if (!isPlainObject(c)) {
    errors.push({ path, code: 'NOT_OBJECT', message: 'se esperaba un objeto componente' });
    return errors;
  }
  const type = c.type;
  if (typeof type !== 'string' || !hasOwn(VC_COMPONENT_SPECS, type)) {
    errors.push({ path: `${path}.type`, code: 'UNKNOWN_COMPONENT', message: `tipo de componente desconocido "${String(type)}"` });
    return errors;
  }
  checkObject(VC_COMPONENT_SPECS[type as VcComponentType], c, path, errors, ['type']);
  const columns = c.columns;
  if (type === 'comparison' && Array.isArray(columns) && Array.isArray(c.rows)) {
    c.rows.forEach((row, i) => {
      const cells = isPlainObject(row) ? row.cells : undefined;
      if (Array.isArray(cells) && cells.length !== columns.length) {
        errors.push({
          path: `${path}.rows[${i}].cells`,
          code: 'ARITY_MISMATCH',
          message: `${cells.length} celdas, pero hay ${columns.length} columnas`,
        });
      }
    });
  }
  return errors;
}

export function validateExperience(doc: unknown): VcValidationResult {
  const errors: VcValidationError[] = [];
  if (!isPlainObject(doc)) {
    return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'el documento debe ser un objeto' }] };
  }
  const allowedTop = ['vcSchemaVersion', 'chapterId', 'movements', 'bridge_to_next'];
  for (const key of Object.keys(doc)) {
    if (!allowedTop.includes(key)) {
      errors.push({ path: `$.${key}`, code: 'UNKNOWN_FIELD', message: `campo no permitido "${key}"` });
    }
  }
  if (doc.vcSchemaVersion !== VC_SCHEMA_VERSION) {
    errors.push({
      path: '$.vcSchemaVersion',
      code: 'SCHEMA_VERSION',
      message: `vcSchemaVersion debe ser ${VC_SCHEMA_VERSION}`,
    });
  }
  if (typeof doc.chapterId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:.-]*$/.test(doc.chapterId) || doc.chapterId.length > VC_CHAPTER_ID_MAX) {
    errors.push({
      path: '$.chapterId',
      code: 'CHAPTER_ID',
      message: `chapterId debe ser un identificador [A-Za-z0-9_:.-] de hasta ${VC_CHAPTER_ID_MAX} caracteres`,
    });
  }
  if (doc.bridge_to_next === undefined) {
    errors.push({ path: '$.bridge_to_next', code: 'MISSING_FIELD', message: 'falta "bridge_to_next"' });
  } else {
    checkText(doc.bridge_to_next, '$.bridge_to_next', VC_BRIDGE_MAX, errors);
  }

  const movements = doc.movements;
  if (!isPlainObject(movements)) {
    errors.push({ path: '$.movements', code: movements === undefined ? 'MISSING_FIELD' : 'NOT_OBJECT', message: 'movements debe ser un objeto' });
    return { ok: false, errors };
  }
  for (const key of Object.keys(movements)) {
    if (!(VC_MOVEMENT_IDS as readonly string[]).includes(key)) {
      errors.push({ path: `$.movements.${key}`, code: 'UNKNOWN_FIELD', message: `movimiento desconocido "${key}"` });
    }
  }

  const typeCounts = new Map<string, number>();
  for (const mv of VC_MOVEMENT_IDS) {
    const mpath = `$.movements.${mv}`;
    const list = movements[mv];
    if (list === undefined) {
      errors.push({ path: mpath, code: 'MISSING_FIELD', message: `falta el movimiento "${mv}"` });
      continue;
    }
    if (!Array.isArray(list)) {
      errors.push({ path: mpath, code: 'TYPE_MISMATCH', message: 'un movimiento es una lista de componentes' });
      continue;
    }
    const [min, max] = VC_MOVEMENT_LIMITS[mv];
    if (list.length < min || list.length > max) {
      errors.push({ path: mpath, code: 'MOVEMENT_RANGE', message: `${list.length} componentes, se esperaban ${min}–${max}` });
    }
    list.forEach((c, i) => {
      const cpath = `${mpath}[${i}]`;
      errors.push(...validateComponent(c, cpath));
      const type = isPlainObject(c) ? c.type : undefined;
      if (typeof type === 'string' && hasOwn(VC_COMPONENT_SPECS, type)) {
        typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
        // self_check (movimiento) contiene exactamente un componente self_check, y ese
        // tipo no aparece en otros movimientos (el movimiento se ensambla solo si la
        // actividad está OFF, §F.3; en otro lado sería un repaso duplicado).
        if (mv === 'self_check' && type !== 'self_check') {
          errors.push({ path: `${cpath}.type`, code: 'COMPONENT_NOT_ALLOWED', message: 'el movimiento self_check solo admite un componente "self_check"' });
        }
        if (mv !== 'self_check' && type === 'self_check') {
          errors.push({ path: `${cpath}.type`, code: 'COMPONENT_NOT_ALLOWED', message: '"self_check" solo puede ir en el movimiento self_check' });
        }
      }
    });
  }

  if (typeCounts.size > 0 && typeCounts.size < VC_MIN_DISTINCT_TYPES) {
    errors.push({ path: '$.movements', code: 'TYPE_DIVERSITY', message: `se requieren al menos ${VC_MIN_DISTINCT_TYPES} tipos distintos de componente` });
  }
  for (const [type, n] of Array.from(typeCounts.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (n > VC_MAX_SAME_TYPE) {
      errors.push({ path: '$.movements', code: 'TYPE_REPEATED', message: `"${type}" aparece ${n} veces (máximo ${VC_MAX_SAME_TYPE})` });
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Type guard de conveniencia: valida y devuelve el documento tipado, o lanza VC_INVALID. */
export function assertValidExperience(doc: unknown): ChapterExperience {
  const r = validateExperience(doc);
  if (!r.ok) {
    const head = r.errors.slice(0, 5).map((e) => `${e.path} ${e.code}`).join('; ');
    throw new Error(`VC_INVALID: ${r.errors.length} error(es): ${head}`);
  }
  return doc as ChapterExperience;
}
