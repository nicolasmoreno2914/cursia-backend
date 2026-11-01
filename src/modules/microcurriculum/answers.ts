import {
  HOUR_KINDS, HourKind, INSTITUTION_TYPES, InstitutionType, MC_LIMITS, McIdentification, MicrocurriculumAnswers, MODALITIES, Modality, TIME_MODES, TimeMode,
} from './microcurriculum.types';

/**
 * r81 · Respuestas del cuestionario: normalización, obligatorias (★), intensidad horaria y lecturas derivadas (reparto
 * exigido, cortes institucionales). Puro. «Que Cursia lo proponga» = valor vacío → el campo queda ausente.
 */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const collapse = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = collapse(v).slice(0, MC_LIMITS.text);
  return s ? s : undefined;
}
function num(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'string' && v.trim() ? Number(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) return undefined;
  return Math.round(n * 100) / 100;
}
function list(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    const s = str(x);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= MC_LIMITS.listItems) break;
  }
  return out.length ? out : undefined;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}
/** Quita claves `undefined` y devuelve undefined si el objeto queda vacío. */
function compact<T extends Record<string, unknown>>(o: T): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length ? (out as T) : undefined;
}

/**
 * Forma canónica de las respuestas (borrador parcial admitido): textos colapsados y recortados a 2 000 caracteres,
 * listas sin vacíos ni repetidos (≤ 40), números en rango, enumerados válidos. Lo desconocido se descarta.
 */
export function normalizeAnswers(raw: unknown): MicrocurriculumAnswers {
  const a = isObj(raw) ? raw : {};
  const g = (k: string) => (isObj(a[k]) ? (a[k] as Record<string, unknown>) : {});
  const id = g('identification');
  const le = g('learners');
  const pu = g('purpose');
  const ti = g('time');
  const co = g('contents');
  const me = g('methodology');
  const re = g('references');
  const sp = isObj(ti.split) ? ti.split : {};
  const out: MicrocurriculumAnswers = {
    identification: compact({
      courseName: str(id.courseName),
      institutionType: oneOf<InstitutionType>(id.institutionType, INSTITUTION_TYPES),
      program: str(id.program),
      term: str(id.term),
      modality: oneOf<Modality>(id.modality, MODALITIES),
      code: str(id.code),
      area: str(id.area),
    }),
    learners: compact({ profile: str(le.profile), priorKnowledge: str(le.priorKnowledge), context: str(le.context), specialNeeds: str(le.specialNeeds) }),
    purpose: compact({ need: str(pu.need), expectedAbilities: str(pu.expectedAbilities), competencies: str(pu.competencies) }),
    time: compact({
      mode: oneOf<TimeMode>(ti.mode, TIME_MODES),
      totalHours: num(ti.totalHours, MC_LIMITS.hoursMin, MC_LIMITS.hoursMax),
      credits: num(ti.credits, 0.5, 60),
      weeks: num(ti.weeks, 1, 104),
      hoursPerWeek: num(ti.hoursPerWeek, 0.5, MC_LIMITS.hoursMax),
      split: compact({ contact: num(sp.contact, 0, MC_LIMITS.hoursMax), practice: num(sp.practice, 0, MC_LIMITS.hoursMax), autonomous: num(sp.autonomous, 0, MC_LIMITS.hoursMax) }),
      calendar: str(ti.calendar),
    }),
    contents: compact({
      requiredTopics: list(co.requiredTopics),
      excludedTopics: list(co.excludedTopics),
      unitCount: (() => { const n = num(co.unitCount, MC_LIMITS.unitCountMin, MC_LIMITS.unitCountMax); return n !== undefined && Number.isInteger(n) ? n : undefined; })(),
    }),
    methodology: compact({ strategies: list(me.strategies), institutionalEvaluation: str(me.institutionalEvaluation), resources: str(me.resources) }),
    references: compact({ bibliography: list(re.bibliography), author: str(re.author), notes: str(re.notes) }),
  };
  return compact(out as Record<string, unknown>) as MicrocurriculumAnswers || {};
}

/**
 * Intensidad horaria total pedida: horas totales, créditos × 48 o semanas × horas/semana (según `mode`; sin `mode`, la
 * primera forma completa). null si falta o queda fuera de 1–1 000 h.
 */
export function resolveTotalHours(time: MicrocurriculumAnswers['time'] | null | undefined): number | null {
  if (!time) return null;
  const forms: Record<TimeMode, () => number | null> = {
    total: () => (typeof time.totalHours === 'number' ? time.totalHours : null),
    credits: () => (typeof time.credits === 'number' ? time.credits * MC_LIMITS.hoursPerCredit : null),
    weekly: () => (typeof time.weeks === 'number' && typeof time.hoursPerWeek === 'number' ? time.weeks * time.hoursPerWeek : null),
  };
  const order: TimeMode[] = time.mode ? [time.mode] : ['total', 'credits', 'weekly'];
  for (const m of order) {
    const h = forms[m]();
    if (h === null) continue;
    const r = Math.round(h * 100) / 100;
    return r >= MC_LIMITS.hoursMin && r <= MC_LIMITS.hoursMax ? r : null;
  }
  return null;
}

/** Reparto docente/práctica/autónomo EXIGIDO por el docente (solo los tipos que escribió). */
export function requestedSplit(time: MicrocurriculumAnswers['time'] | null | undefined): Partial<Record<HourKind, number>> {
  const out: Partial<Record<HourKind, number>> = {};
  const sp = time?.split;
  if (!sp) return out;
  for (const k of HOUR_KINDS) if (typeof sp[k] === 'number') out[k] = sp[k] as number;
  return out;
}

/** ¿El reparto exigido es posible con el total? (suma ≤ total; si da los tres, suma = total ± tolerancia). */
export function splitConsistent(time: MicrocurriculumAnswers['time'] | null | undefined): boolean {
  const total = resolveTotalHours(time);
  const sp = requestedSplit(time);
  const given = Object.values(sp) as number[];
  if (total === null || !given.length) return true;
  const sum = given.reduce((a, b) => a + b, 0);
  if (sum > total + MC_LIMITS.hoursTolerance) return false;
  if (given.length === HOUR_KINDS.length && Math.abs(sum - total) > MC_LIMITS.hoursTolerance) return false;
  return true;
}

/** Las 8 obligatorias (★) del cuestionario que faltan, como rutas estables (el frontend lleva al paso). */
export function missingRequired(answers: MicrocurriculumAnswers): string[] {
  const miss: string[] = [];
  if (!answers.identification?.courseName) miss.push('identification.courseName');
  if (!answers.identification?.institutionType) miss.push('identification.institutionType');
  if (!answers.learners?.profile) miss.push('learners.profile');
  if (!answers.purpose?.need) miss.push('purpose.need');
  if (!answers.purpose?.expectedAbilities) miss.push('purpose.expectedAbilities');
  if (resolveTotalHours(answers.time) === null) miss.push('time.totalHours');
  else if (!splitConsistent(answers.time)) miss.push('time.split');
  if (!answers.contents?.requiredTopics?.length) miss.push('contents.requiredTopics');
  if (!answers.methodology?.strategies?.length) miss.push('methodology.strategies');
  return miss;
}

/**
 * Cortes institucionales legibles en el texto de evaluación exigida: el primer patrón `n/n/n` (2 a 6 números) que suma
 * 100 («30/30/40», «20 / 30 / 50 %»). null si no hay patrón legible (entonces V2 solo exige que sume 100).
 */
export function parseInstitutionalCuts(text: string | null | undefined): number[] | null {
  if (!text) return null;
  const re = /(\d{1,3}(?:[.,]\d+)?)\s*%?(?:\s*\/\s*(\d{1,3}(?:[.,]\d+)?)\s*%?){1,5}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const nums = m[0].split('/').map((x) => Number(x.replace('%', '').replace(',', '.').trim()));
    if (nums.length >= 2 && nums.every((n) => Number.isFinite(n) && n > 0) && Math.abs(nums.reduce((a, b) => a + b, 0) - 100) < 0.01) return nums;
  }
  return null;
}

/** Identificación del documento: SIEMPRE la del paso 1, literal (V7). */
export function identificationFromAnswers(answers: MicrocurriculumAnswers): McIdentification {
  const id = answers.identification || {};
  return {
    courseName: id.courseName || '',
    institutionType: (id.institutionType || 'universidad') as InstitutionType,
    program: id.program ?? null,
    term: id.term ?? null,
    modality: id.modality ?? null,
    code: id.code ?? null,
    area: id.area ?? null,
  };
}

export function answersTitle(answers: MicrocurriculumAnswers): string {
  return (answers.identification?.courseName || '').slice(0, 200);
}
