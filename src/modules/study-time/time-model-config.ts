// r58 (I3) · Configuración del modelo de tiempo (tasas y minutos acreditados por nivel).
//
// Las constantes del modelo de tiempo (palabras por minuto, minutos por diapositiva / interacción / ítem / tarjeta /
// pregunta, minutos del foro y minutos ACREDITADOS por nivel de la práctica guiada y de la Actividad de Aplicación) viven
// en un objeto de configuración con id. El default (`cursia.default.v1`) tiene EXACTAMENTE los valores de siempre: sin
// configuración propia, todo número que sale del modelo es byte a byte el de antes.
//
// Una institución (o un perfil) puede declarar una configuración propia con la clave opcional `hoursModel` del perfil
// pedagógico (dato, no código). Se congela en el Blueprint (`course.hoursModel`, solo si existe: sha de siempre sin
// ella). Cada línea del registro de horas anota el `configId` de la configuración que puso su tasa: el id propio solo
// en las líneas cuya regla se cambió; las demás conservan el id del default.
//
// Lo que NO se configura (estructural, con CHECK en la base y en el Blueprint): el CONJUNTO de niveles permitidos
// (AA 30/60/90/120, práctica guiada 40/60/80/120). Lo configurable es cuántos minutos se acreditan por cada nivel
// (default: el mismo número). Política de equivalencia de créditos (`hoursPerCredit`) y mapeo de los componentes del
// documento (`componentMap`) son OPCIONALES: sin ellos el informe dice «conversión no definida» / «mapeo no definido»;
// Cursia nunca supone una política académica.
import { APPLICATION_ACTIVITY_TIERS } from './application-tiers';
import { GUIDED_PRACTICE_TIERS } from './guided-practice-tiers';

export const DEFAULT_TIME_MODEL_CONFIG_ID = 'cursia.default.v1';

/** Categorías del registro de horas (informe; no cambian el cálculo). */
export const HOUR_CATEGORIES = Object.freeze([
  'estudio_contenido', 'video', 'lectura', 'practica_guiada', 'practica_autonoma', 'entregable', 'evaluacion', 'retroalimentacion', 'foro_otros',
] as const);
export type HourCategory = (typeof HOUR_CATEGORIES)[number];

/** Componentes de horas que declara un documento académico (academic-context `hours.components[].kind`). */
export const DECLARED_COMPONENT_KINDS = Object.freeze(['contact', 'practice', 'autonomous', 'other'] as const);
export type DeclaredComponentKind = (typeof DECLARED_COMPONENT_KINDS)[number];

export interface TimeModelRates {
  /** Lectura de estudio (no lectura rápida) de un estudiante típico. */
  readingWordsPerMinute: number;
  minutesPerSlide: number;
  /** Cada pregunta y cada pausa de reflexión del video interactivo. */
  minutesPerVideoInteraction: number;
  /** Cada pregunta o ítem de la actividad del capítulo (H5P o SCORM). */
  minutesPerActivityItem: number;
  minutesPerReviewCard: number;
  minutesPerExamQuestion: number;
  /** Presentarse y participar en el foro del curso. */
  forumMinutes: number;
}
export const TIME_MODEL_RATE_KEYS = Object.freeze([
  'readingWordsPerMinute', 'minutesPerSlide', 'minutesPerVideoInteraction', 'minutesPerActivityItem', 'minutesPerReviewCard', 'minutesPerExamQuestion', 'forumMinutes',
] as const);
export type TimeModelRateKey = (typeof TIME_MODEL_RATE_KEYS)[number];

export interface TimeModelConfig {
  id: string;
  rates: Readonly<TimeModelRates>;
  /** Minutos acreditados por nivel de la Actividad de Aplicación (default: el nivel mismo). */
  applicationTierMinutes: Readonly<Record<number, number>>;
  /** Minutos acreditados por nivel de la práctica guiada (default: el nivel mismo). */
  guidedPracticeTierMinutes: Readonly<Record<number, number>>;
  /** Horas por crédito declaradas por la institución. null = conversión no definida (nunca se supone). */
  hoursPerCredit: number | null;
  /** Componente del documento → categorías del registro. null = mapeo no definido (nunca se supone). */
  componentMap: Readonly<Partial<Record<DeclaredComponentKind, readonly HourCategory[]>>> | null;
  /** Mostrar el desglose de horas en la «Guía del docente» (si el paquete la lleva). */
  teacherGuideBreakdown: boolean;
  /** Qué partes cambió la configuración propia (para anotar el configId de cada línea). Vacío en el default. */
  overridden: Readonly<{ rates: readonly TimeModelRateKey[]; applicationTiers: readonly number[]; guidedPracticeTiers: readonly number[] }>;
}

const identity = (tiers: readonly number[]) => Object.freeze(Object.fromEntries(tiers.map((t) => [t, t])) as Record<number, number>);

export const DEFAULT_TIME_MODEL_CONFIG: TimeModelConfig = Object.freeze({
  id: DEFAULT_TIME_MODEL_CONFIG_ID,
  rates: Object.freeze({
    readingWordsPerMinute: 150,
    minutesPerSlide: 0.6,
    minutesPerVideoInteraction: 1,
    minutesPerActivityItem: 1.2,
    minutesPerReviewCard: 0.5,
    minutesPerExamQuestion: 1.2,
    forumMinutes: 10,
  }),
  applicationTierMinutes: identity(APPLICATION_ACTIVITY_TIERS),
  guidedPracticeTierMinutes: identity(GUIDED_PRACTICE_TIERS),
  hoursPerCredit: null,
  componentMap: null,
  teacherGuideBreakdown: false,
  overridden: Object.freeze({ rates: Object.freeze([]), applicationTiers: Object.freeze([]), guidedPracticeTiers: Object.freeze([]) }),
});

/** Configuración propia en su forma canónica (lo que se congela en el Blueprint). Solo las claves presentes. */
export interface HoursModelOverride {
  id: string;
  rates?: Partial<TimeModelRates>;
  applicationTierMinutes?: Record<string, number>;
  guidedPracticeTierMinutes?: Record<string, number>;
  hoursPerCredit?: number;
  componentMap?: Partial<Record<DeclaredComponentKind, HourCategory[]>>;
  teacherGuideBreakdown?: true;
}

export class HoursModelError extends Error {
  readonly code = 'HOURS_MODEL_INVALID';
  constructor(message: string) {
    super(`HOURS_MODEL_INVALID: ${message}`);
    this.name = 'HoursModelError';
  }
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Límites de cordura (no son política: solo evitan valores absurdos o un typo de unidades). */
const RATE_BOUNDS: Readonly<Record<TimeModelRateKey, [number, number]>> = Object.freeze({
  readingWordsPerMinute: [30, 600],
  minutesPerSlide: [0.05, 30],
  minutesPerVideoInteraction: [0.05, 30],
  minutesPerActivityItem: [0.05, 30],
  minutesPerReviewCard: [0.05, 30],
  minutesPerExamQuestion: [0.05, 30],
  forumMinutes: [0, 600],
});
const OVERRIDE_KEYS = ['id', 'rates', 'applicationTierMinutes', 'guidedPracticeTierMinutes', 'hoursPerCredit', 'componentMap', 'teacherGuideBreakdown'];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function tierMap(v: unknown, tiers: readonly number[], path: string): Record<string, number> | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) throw new HoursModelError(`${path} debe ser un objeto {nivel: minutos}`);
  const out: Record<string, number> = {};
  for (const k of Object.keys(v)) if (!tiers.includes(Number(k)) || String(Number(k)) !== k) throw new HoursModelError(`${path}.${k}: nivel desconocido (niveles: ${tiers.join(', ')})`);
  for (const t of tiers) {
    const x = v[String(t)];
    if (x === undefined) continue;
    if (!finite(x) || x <= 0 || x > 480) throw new HoursModelError(`${path}.${t} debe ser un número de minutos > 0 y ≤ 480 (fue ${JSON.stringify(x)})`);
    out[String(t)] = x;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Forma canónica de una configuración propia (claves en orden fijo; solo lo presente). null/undefined → null.
 * Lanza HOURS_MODEL_INVALID ante cualquier valor inválido o clave desconocida (nunca se ignora en silencio).
 */
export function canonicalHoursModel(v: unknown): HoursModelOverride | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) throw new HoursModelError('hoursModel debe ser un objeto');
  for (const k of Object.keys(v)) if (!OVERRIDE_KEYS.includes(k)) throw new HoursModelError(`campo desconocido "hoursModel.${k}"`);
  if (typeof v.id !== 'string' || !ID_RE.test(v.id)) throw new HoursModelError(`hoursModel.id debe ser un id en minúsculas (a-z, 0-9, . _ -; ≤ 64) (fue ${JSON.stringify(v.id)})`);
  if (v.id === DEFAULT_TIME_MODEL_CONFIG_ID) throw new HoursModelError(`hoursModel.id no puede ser el del default (${DEFAULT_TIME_MODEL_CONFIG_ID})`);
  const out: HoursModelOverride = { id: v.id };
  if (v.rates !== undefined) {
    if (!isObj(v.rates)) throw new HoursModelError('hoursModel.rates debe ser un objeto');
    for (const k of Object.keys(v.rates)) if (!(TIME_MODEL_RATE_KEYS as readonly string[]).includes(k)) throw new HoursModelError(`campo desconocido "hoursModel.rates.${k}"`);
    const rates: Partial<TimeModelRates> = {};
    for (const k of TIME_MODEL_RATE_KEYS) {
      const x = v.rates[k];
      if (x === undefined) continue;
      const [lo, hi] = RATE_BOUNDS[k];
      if (!finite(x) || x < lo || x > hi) throw new HoursModelError(`hoursModel.rates.${k} debe ser un número entre ${lo} y ${hi} (fue ${JSON.stringify(x)})`);
      rates[k] = x;
    }
    if (Object.keys(rates).length) out.rates = rates;
  }
  const at = tierMap(v.applicationTierMinutes, APPLICATION_ACTIVITY_TIERS, 'hoursModel.applicationTierMinutes');
  if (at) out.applicationTierMinutes = at;
  const gt = tierMap(v.guidedPracticeTierMinutes, GUIDED_PRACTICE_TIERS, 'hoursModel.guidedPracticeTierMinutes');
  if (gt) out.guidedPracticeTierMinutes = gt;
  if (v.hoursPerCredit !== undefined) {
    if (!finite(v.hoursPerCredit) || v.hoursPerCredit <= 0 || v.hoursPerCredit > 200) throw new HoursModelError(`hoursModel.hoursPerCredit debe ser un número > 0 y ≤ 200 (fue ${JSON.stringify(v.hoursPerCredit)})`);
    out.hoursPerCredit = v.hoursPerCredit;
  }
  if (v.componentMap !== undefined) {
    if (!isObj(v.componentMap)) throw new HoursModelError('hoursModel.componentMap debe ser un objeto {componente: [categorías]}');
    for (const k of Object.keys(v.componentMap)) if (!(DECLARED_COMPONENT_KINDS as readonly string[]).includes(k)) throw new HoursModelError(`hoursModel.componentMap.${k}: componente desconocido (${DECLARED_COMPONENT_KINDS.join(', ')})`);
    const cm: Partial<Record<DeclaredComponentKind, HourCategory[]>> = {};
    const used = new Set<string>();
    for (const k of DECLARED_COMPONENT_KINDS) {
      const xs = v.componentMap[k];
      if (xs === undefined) continue;
      if (!Array.isArray(xs) || !xs.length) throw new HoursModelError(`hoursModel.componentMap.${k} debe ser una lista no vacía de categorías`);
      for (const x of xs) {
        if (!(HOUR_CATEGORIES as readonly string[]).includes(x as string)) throw new HoursModelError(`hoursModel.componentMap.${k}: categoría desconocida ${JSON.stringify(x)}`);
        if (used.has(x as string)) throw new HoursModelError(`hoursModel.componentMap: la categoría ${x} está en dos componentes`);
        used.add(x as string);
      }
      cm[k] = HOUR_CATEGORIES.filter((c) => (xs as string[]).includes(c));
    }
    if (Object.keys(cm).length) out.componentMap = cm;
  }
  if (v.teacherGuideBreakdown !== undefined) {
    if (typeof v.teacherGuideBreakdown !== 'boolean') throw new HoursModelError('hoursModel.teacherGuideBreakdown debe ser boolean');
    if (v.teacherGuideBreakdown) out.teacherGuideBreakdown = true;
  }
  return out;
}

/** Configuración efectiva: el default + la configuración propia (canónica). Sin propia → el default (mismo objeto). */
export function resolveTimeModelConfig(override: unknown): TimeModelConfig {
  const o = canonicalHoursModel(override);
  if (!o) return DEFAULT_TIME_MODEL_CONFIG;
  const D = DEFAULT_TIME_MODEL_CONFIG;
  const rates = { ...D.rates, ...(o.rates ?? {}) };
  const changedRates = TIME_MODEL_RATE_KEYS.filter((k) => o.rates?.[k] !== undefined && o.rates[k] !== D.rates[k]);
  const at: Record<number, number> = { ...D.applicationTierMinutes };
  for (const [k, x] of Object.entries(o.applicationTierMinutes ?? {})) at[Number(k)] = x;
  const gt: Record<number, number> = { ...D.guidedPracticeTierMinutes };
  for (const [k, x] of Object.entries(o.guidedPracticeTierMinutes ?? {})) gt[Number(k)] = x;
  return Object.freeze({
    id: o.id,
    rates: Object.freeze(rates),
    applicationTierMinutes: Object.freeze(at),
    guidedPracticeTierMinutes: Object.freeze(gt),
    hoursPerCredit: o.hoursPerCredit ?? null,
    componentMap: o.componentMap ? Object.freeze({ ...o.componentMap }) : null,
    teacherGuideBreakdown: o.teacherGuideBreakdown === true,
    overridden: Object.freeze({
      rates: Object.freeze(changedRates),
      applicationTiers: Object.freeze(APPLICATION_ACTIVITY_TIERS.filter((t) => at[t] !== D.applicationTierMinutes[t])),
      guidedPracticeTiers: Object.freeze(GUIDED_PRACTICE_TIERS.filter((t) => gt[t] !== D.guidedPracticeTierMinutes[t])),
    }),
  });
}

/** ¿El modelo de tiempo de esta configuración da los mismos minutos que el default? (solo informe/política). */
export function isDefaultTimeModelConfig(c: TimeModelConfig): boolean {
  return c.id === DEFAULT_TIME_MODEL_CONFIG_ID;
}
