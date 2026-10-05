import { sha256Canonical } from '../coherence/canonical-json';
import { TARGET_HOURS_MAX, TARGET_HOURS_MIN, isValidTargetHours } from '../study-time/target-hours';
import { PedagogicalApproachRegistry } from './approach-registry';
import { defaultApproachRegistry } from './builtin-approaches';
import {
  AGE_GROUPS,
  ASSESSMENT_METHODS,
  AgeGroup,
  AssessmentMethod,
  EDUCATION_LEVELS,
  EXPERIENCE_LEVELS,
  EXPERIENCE_TYPES,
  EducationLevel,
  ExperienceLevel,
  ExperienceType,
  LEARNING_MODES,
  LearningMode,
  PRIOR_KNOWLEDGE_LEVELS,
  PriorKnowledgeLevel,
  isOneOf,
} from './vocabulary';

/**
 * Motor pedagógico V1 — Perfil pedagógico del curso.
 *
 * Representación ESTRUCTURADA (nunca solo "pedagogy = constructivism"): enfoque
 * principal + secundarios, perfil del estudiante, resultados de aprendizaje,
 * forma de aprender, experiencia deseada, estrategia de evaluación y
 * principios adicionales. Las reglas de diseño se DERIVAN de este perfil
 * (design-rules.ts) y se guardan junto a él (`designRules`) como registro;
 * el servidor siempre las recalcula, nunca acepta las del cliente.
 *
 * Perfil vacío (`primaryApproach: null` o sin perfil) = comportamiento
 * anterior exacto: no hay reglas, el Blueprint y el Manifest no cambian.
 */

export const PEDAGOGY_PROFILE_VERSION = 1;
export const MAX_SECONDARY_APPROACHES = 2;
export const MAX_LIST_ITEMS = 12;
export const MAX_TEXT_LENGTH = 400;

export interface LearnerProfile {
  /** Quiénes son (texto libre del docente). */
  description: string | null;
  ageGroup: AgeGroup | null;
  educationLevel: EducationLevel | null;
  priorKnowledge: PriorKnowledgeLevel | null;
  experience: ExperienceLevel | null;
}

export interface LearningOutcomes {
  know: string[];
  do: string[];
  competencies: string[];
}

export interface PedagogicalProfile {
  pedagogyProfileVersion: number;
  primaryApproach: string | null;
  secondaryApproaches: string[];
  learner: LearnerProfile;
  learningOutcomes: LearningOutcomes;
  learningModes: LearningMode[];
  experienceTypes: ExperienceType[];
  assessmentMethods: AssessmentMethod[];
  principles: string[];
  origin: 'manual' | 'wizard';
  /**
   * Motor de carga horaria: horas de estudio objetivo del curso (restricción del curso, no pedagogía).
   * Opcional: la clave existe SOLO si se definió (perfiles anteriores conservan su sha). Puede ir en un
   * perfil sin enfoque.
   */
  targetHours?: number;
}

export interface PedagogyValidationError {
  path: string;
  code: string;
  message: string;
}

/** Perfil vacío explícito ("sin enfoque pedagógico"): conserva el comportamiento anterior. */
export function emptyPedagogicalProfile(): PedagogicalProfile {
  return {
    pedagogyProfileVersion: PEDAGOGY_PROFILE_VERSION,
    primaryApproach: null,
    secondaryApproaches: [],
    learner: { description: null, ageGroup: null, educationLevel: null, priorKnowledge: null, experience: null },
    learningOutcomes: { know: [], do: [], competencies: [] },
    learningModes: [],
    experienceTypes: [],
    assessmentMethods: [],
    principles: [],
    origin: 'manual',
  };
}

/** ¿El perfil NO define pedagogía? (null/undefined, objeto vacío o sin enfoque principal). */
export function isEmptyPedagogicalProfile(p: unknown): boolean {
  if (p === null || p === undefined) return true;
  if (typeof p !== 'object' || Array.isArray(p)) return false; // inválido, no vacío: que lo diga el validador
  const o = p as Record<string, unknown>;
  if (Object.keys(o).length === 0) return true;
  return o.primaryApproach === null || o.primaryApproach === undefined || o.primaryApproach === '';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const TOP_KEYS = [
  'pedagogyProfileVersion', 'primaryApproach', 'secondaryApproaches', 'learner', 'learningOutcomes',
  'learningModes', 'experienceTypes', 'assessmentMethods', 'principles', 'origin',
];
/** `designRules` lo escribe el servidor: se tolera en la entrada (se ignora y se recalcula). */
const TOLERATED_KEYS = ['designRules'];
/** Claves opcionales (ausentes = comportamiento anterior). */
const OPTIONAL_KEYS = ['targetHours'];

/**
 * Horas objetivo de un perfil guardado o enviado (con o sin enfoque). null = sin objetivo (comportamiento
 * anterior). Un valor inválido lanza PROFILE_INVALID (nunca se ignora en silencio).
 */
export function profileTargetHours(p: unknown): number | null {
  if (!isPlainObject(p) || p.targetHours === undefined || p.targetHours === null) return null;
  if (!isValidTargetHours(p.targetHours)) {
    throw new Error(`PROFILE_INVALID: INVALID_TARGET_HOURS targetHours: debe ser un número de ${TARGET_HOURS_MIN} a ${TARGET_HOURS_MAX} horas, en pasos de 0,5 (fue ${JSON.stringify(p.targetHours)})`);
  }
  return p.targetHours;
}
const LEARNER_KEYS = ['description', 'ageGroup', 'educationLevel', 'priorKnowledge', 'experience'];
const OUTCOME_KEYS = ['know', 'do', 'competencies'];

/**
 * Validación completa. Claves exactas (un typo nunca se ignora), enums
 * cerrados, enfoques existentes en el registro, sin repetidos, textos acotados.
 */
export function validatePedagogicalProfile(
  p: unknown,
  registry: PedagogicalApproachRegistry = defaultApproachRegistry(),
): PedagogyValidationError[] {
  const errors: PedagogyValidationError[] = [];
  const err = (path: string, code: string, message: string) => errors.push({ path, code, message });
  if (!isPlainObject(p)) return [{ path: '', code: 'INVALID_TYPE', message: 'El perfil pedagógico debe ser un objeto' }];

  for (const k of TOP_KEYS) if (!(k in p)) err(k, 'MISSING_FIELD', `Falta el campo "${k}"`);
  for (const k of Object.keys(p)) {
    if (!TOP_KEYS.includes(k) && !TOLERATED_KEYS.includes(k) && !OPTIONAL_KEYS.includes(k)) err(k, 'UNKNOWN_FIELD', `Campo desconocido "${k}"`);
  }
  if ('pedagogyProfileVersion' in p && p.pedagogyProfileVersion !== PEDAGOGY_PROFILE_VERSION) {
    err('pedagogyProfileVersion', 'INVALID_PROFILE_VERSION', `pedagogyProfileVersion debe ser ${PEDAGOGY_PROFILE_VERSION}`);
  }

  const primary = p.primaryApproach;
  if ('primaryApproach' in p && primary !== null) {
    if (typeof primary !== 'string' || !registry.has(primary)) {
      err('primaryApproach', 'UNKNOWN_APPROACH', `Enfoque desconocido: ${JSON.stringify(primary)} (disponibles: ${registry.ids().join(', ')})`);
    }
  }
  if ('secondaryApproaches' in p) {
    const s = p.secondaryApproaches;
    if (!Array.isArray(s)) err('secondaryApproaches', 'INVALID_TYPE', 'secondaryApproaches debe ser un array');
    else {
      if (s.length > MAX_SECONDARY_APPROACHES) err('secondaryApproaches', 'TOO_MANY_SECONDARY', `Como máximo ${MAX_SECONDARY_APPROACHES} enfoques secundarios`);
      if (new Set(s).size !== s.length) err('secondaryApproaches', 'DUPLICATE_APPROACH', 'Enfoques secundarios repetidos');
      s.forEach((x, i) => {
        if (typeof x !== 'string' || !registry.has(x)) err(`secondaryApproaches[${i}]`, 'UNKNOWN_APPROACH', `Enfoque desconocido: ${JSON.stringify(x)}`);
        else if (x === primary) err(`secondaryApproaches[${i}]`, 'SECONDARY_EQUALS_PRIMARY', 'Un enfoque secundario no puede ser el principal');
      });
      if (s.length > 0 && (primary === null || primary === undefined)) {
        err('secondaryApproaches', 'SECONDARY_WITHOUT_PRIMARY', 'Elige un enfoque principal antes de los secundarios');
      }
    }
  }

  if ('learner' in p) {
    const l = p.learner;
    if (!isPlainObject(l)) err('learner', 'INVALID_TYPE', 'learner debe ser un objeto');
    else {
      for (const k of LEARNER_KEYS) if (!(k in l)) err(`learner.${k}`, 'MISSING_FIELD', `Falta el campo "learner.${k}"`);
      for (const k of Object.keys(l)) if (!LEARNER_KEYS.includes(k)) err(`learner.${k}`, 'UNKNOWN_FIELD', `Campo desconocido "learner.${k}"`);
      checkText(l.description, 'learner.description', errors);
      checkEnumOrNull(l.ageGroup, AGE_GROUPS, 'learner.ageGroup', errors);
      checkEnumOrNull(l.educationLevel, EDUCATION_LEVELS, 'learner.educationLevel', errors);
      checkEnumOrNull(l.priorKnowledge, PRIOR_KNOWLEDGE_LEVELS, 'learner.priorKnowledge', errors);
      checkEnumOrNull(l.experience, EXPERIENCE_LEVELS, 'learner.experience', errors);
    }
  }
  if ('learningOutcomes' in p) {
    const o = p.learningOutcomes;
    if (!isPlainObject(o)) err('learningOutcomes', 'INVALID_TYPE', 'learningOutcomes debe ser un objeto');
    else {
      for (const k of OUTCOME_KEYS) if (!(k in o)) err(`learningOutcomes.${k}`, 'MISSING_FIELD', `Falta el campo "learningOutcomes.${k}"`);
      for (const k of Object.keys(o)) if (!OUTCOME_KEYS.includes(k)) err(`learningOutcomes.${k}`, 'UNKNOWN_FIELD', `Campo desconocido "learningOutcomes.${k}"`);
      for (const k of OUTCOME_KEYS) if (k in o) checkTextList(o[k], `learningOutcomes.${k}`, errors);
    }
  }
  if ('learningModes' in p) checkEnumList(p.learningModes, LEARNING_MODES, 'learningModes', errors);
  if ('experienceTypes' in p) checkEnumList(p.experienceTypes, EXPERIENCE_TYPES, 'experienceTypes', errors);
  if ('assessmentMethods' in p) checkEnumList(p.assessmentMethods, ASSESSMENT_METHODS, 'assessmentMethods', errors);
  if ('principles' in p) checkTextList(p.principles, 'principles', errors);
  if ('origin' in p && p.origin !== 'manual' && p.origin !== 'wizard') {
    err('origin', 'INVALID_ORIGIN', "origin debe ser 'manual' o 'wizard'");
  }
  if ('targetHours' in p && p.targetHours !== null && !isValidTargetHours(p.targetHours)) {
    err('targetHours', 'INVALID_TARGET_HOURS', `targetHours debe ser un número de ${TARGET_HOURS_MIN} a ${TARGET_HOURS_MAX} horas, en pasos de 0,5`);
  }
  return errors;
}

function checkText(v: unknown, path: string, errors: PedagogyValidationError[]): void {
  if (v === null) return;
  if (typeof v !== 'string') errors.push({ path, code: 'INVALID_TEXT', message: `${path} debe ser texto o null` });
  else if (v.length > MAX_TEXT_LENGTH) errors.push({ path, code: 'TEXT_TOO_LONG', message: `${path} supera ${MAX_TEXT_LENGTH} caracteres` });
}

function checkEnumOrNull(v: unknown, list: readonly string[], path: string, errors: PedagogyValidationError[]): void {
  if (v !== null && !isOneOf(list, v)) {
    errors.push({ path, code: 'INVALID_OPTION', message: `${path} inválido: ${JSON.stringify(v)} (permitidos: ${list.join(', ')} o null)` });
  }
}

function checkEnumList(v: unknown, list: readonly string[], path: string, errors: PedagogyValidationError[]): void {
  if (!Array.isArray(v)) {
    errors.push({ path, code: 'INVALID_TYPE', message: `${path} debe ser un array` });
    return;
  }
  if (new Set(v).size !== v.length) errors.push({ path, code: 'DUPLICATE_OPTION', message: `${path} tiene opciones repetidas` });
  v.forEach((x, i) => {
    if (!isOneOf(list, x)) errors.push({ path: `${path}[${i}]`, code: 'INVALID_OPTION', message: `Opción desconocida ${JSON.stringify(x)} (permitidas: ${list.join(', ')})` });
  });
}

function checkTextList(v: unknown, path: string, errors: PedagogyValidationError[]): void {
  if (!Array.isArray(v)) {
    errors.push({ path, code: 'INVALID_TYPE', message: `${path} debe ser un array de textos` });
    return;
  }
  if (v.length > MAX_LIST_ITEMS) errors.push({ path, code: 'TOO_MANY_ITEMS', message: `${path}: como máximo ${MAX_LIST_ITEMS} elementos` });
  v.forEach((x, i) => {
    if (typeof x !== 'string' || !x.trim()) errors.push({ path: `${path}[${i}]`, code: 'INVALID_TEXT', message: `${path}[${i}] debe ser un texto no vacío` });
    else if (x.length > MAX_TEXT_LENGTH) errors.push({ path: `${path}[${i}]`, code: 'TEXT_TOO_LONG', message: `${path}[${i}] supera ${MAX_TEXT_LENGTH} caracteres` });
  });
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Orden de claves fijo, textos colapsados, listas de opciones en el orden del
 * vocabulario (dos perfiles iguales con distinto orden de clics → mismo sha).
 * Lanza `PROFILE_INVALID` si no valida (nunca "arregla" en silencio).
 * `designRules` de la entrada se descarta (lo escribe el servidor).
 */
export function normalizePedagogicalProfile(
  p: unknown,
  registry: PedagogicalApproachRegistry = defaultApproachRegistry(),
): PedagogicalProfile {
  const errors = validatePedagogicalProfile(p, registry);
  if (errors.length > 0) {
    throw new Error(`PROFILE_INVALID: ${errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join('; ')}`);
  }
  const q = p as PedagogicalProfile;
  const inOrder = <T extends string>(list: readonly T[], v: T[]): T[] => list.filter((x) => v.includes(x));
  const text = (v: string | null) => (v === null ? null : collapse(v) || null);
  const texts = (v: string[]) => v.map(collapse).filter((x) => x.length > 0);
  return {
    pedagogyProfileVersion: q.pedagogyProfileVersion,
    primaryApproach: q.primaryApproach,
    secondaryApproaches: [...q.secondaryApproaches],
    learner: {
      description: text(q.learner.description),
      ageGroup: q.learner.ageGroup,
      educationLevel: q.learner.educationLevel,
      priorKnowledge: q.learner.priorKnowledge,
      experience: q.learner.experience,
    },
    learningOutcomes: {
      know: texts(q.learningOutcomes.know),
      do: texts(q.learningOutcomes.do),
      competencies: texts(q.learningOutcomes.competencies),
    },
    learningModes: inOrder(LEARNING_MODES, q.learningModes),
    experienceTypes: inOrder(EXPERIENCE_TYPES, q.experienceTypes),
    assessmentMethods: inOrder(ASSESSMENT_METHODS, q.assessmentMethods),
    principles: texts(q.principles),
    origin: q.origin,
    // Solo si se definió: los perfiles sin objetivo conservan bytes y sha.
    ...(q.targetHours !== undefined && q.targetHours !== null ? { targetHours: q.targetHours } : {}),
  };
}

/** sha256 del perfil normalizado (sin `designRules`). */
export function pedagogicalProfileSha256(p: PedagogicalProfile): string {
  const { designRules: _ignored, ...rest } = p as PedagogicalProfile & { designRules?: unknown };
  return sha256Canonical(rest);
}
