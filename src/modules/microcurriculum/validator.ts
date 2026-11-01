import { parseInstitutionalCuts, requestedSplit, resolveTotalHours } from './answers';
import { sumUnitHours } from './document';
import {
  BLOOM, HOUR_KINDS, HourKind, IssueCode, MC_LIMITS, MicrocurriculumAnswers, MicrocurriculumIssue, MicrocurriculumV1, PROVENANCE_FIELDS, competenciesRequired,
} from './microcurriculum.types';

/**
 * r81 · Validador determinista del microcurrículo (spec §2.2; sin IA, USD 0). Una sola fuente de verdad: lo usan la
 * generación (antes y después de reparar), el reintento (la lista de errores va al modelo) y cada PATCH de la revisión.
 *
 *   V1 hours_sum         Σ horas de unidades = total pedido (± 0,5 h) y reparto exigido por tipo (± 0,5 h)
 *   V2 eval_sum          Σ % = 100 y cortes institucionales `n/n/n` respetados (grupos consecutivos)
 *   V3 outcome_coverage  cada RA en ≥ 1 unidad y ≥ 1 evaluación; ninguna referencia a un RA inexistente
 *   V4 required_topics   cada tema obligatorio aparece (tokens normalizados) en el título o contenidos de una unidad
 *   V5 excluded_topics   ningún tema excluido aparece en unidades, resultados ni evaluaciones
 *   V6 observable_verbs  el verbo de cada RA es observable (no «comprender», «conocer», «saber»…)
 *   V7 verbatim          nombre, programa, código y bibliografía obligatoria del docente aparecen literales
 *   V8 shape             cardinalidades, ids únicos con formato, campos obligatorios no vacíos
 *
 * `repairArithmetic` corrige SOLO lo aritmético (V1: reparto proporcional con mayor resto a 0,5 h; V2: escala de los
 * porcentajes al entero con mayor resto) y lo registra en `repairs`. Lo demás va al único reintento.
 */

const RA_RE = /^RA[0-9]{1,2}$/;
const CO_RE = /^CO[0-9]{1,2}$/;
const U_RE = /^U[0-9]{1,2}$/;

/** Verbos no observables (V6): infinitivos y formas de 3.ª persona, sin tildes. */
export const NON_OBSERVABLE_VERBS: readonly string[] = Object.freeze([
  'comprender', 'conocer', 'entender', 'saber', 'aprender', 'apreciar', 'familiarizarse', 'familiarizar', 'valorar', 'interiorizar',
  'internalizar', 'asimilar', 'captar', 'percibir', 'creer', 'concientizar', 'concientizarse', 'sensibilizar', 'sensibilizarse', 'reflexionar',
  'comprende', 'conoce', 'entiende', 'sabe', 'aprende', 'aprecia', 'se familiariza', 'familiariza', 'valora', 'interioriza', 'asimila', 'capta',
  'percibe', 'cree', 'reflexiona', 'tomar conciencia', 'toma conciencia', 'darse cuenta', 'se da cuenta',
]);

const STOPWORDS = new Set([
  'a', 'al', 'ante', 'con', 'contra', 'de', 'del', 'desde', 'e', 'el', 'en', 'entre', 'es', 'la', 'las', 'lo', 'los', 'o', 'para', 'por', 'que',
  'se', 'segun', 'sin', 'sobre', 'su', 'sus', 'u', 'un', 'una', 'unas', 'unos', 'y', 'tema', 'temas', 'introduccion', 'basico', 'basicos', 'nociones',
]);

export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
const collapse = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Plural simple → raíz SIMÉTRICA: se quita la «s» final y después la «e» final (si quedan > 3 letras), así singular y
 * plural dan lo mismo también cuando el singular termina en «e» (base/bases → «bas», clase/clases → «clas»,
 * redes → «red», funciones → «funcion»). Review r81 P1-2.
 */
function stem(t: string): string {
  let x = t;
  if (x.length > 3 && x.endsWith('s')) x = x.slice(0, -1);
  if (x.length > 3 && x.endsWith('e')) x = x.slice(0, -1);
  return x;
}

/** Tokens normalizados (sin tildes, minúsculas, sin palabras vacías, plural simple → raíz común). */
export function topicTokens(s: string): string[] {
  return stripAccents(String(s || '').toLowerCase()).split(/[^a-z0-9ñ]+/).filter((t) => t && !STOPWORDS.has(t)).map(stem);
}

/** ¿El tema aparece en el texto? Todos sus tokens significativos están en el texto (contención de tokens). */
export function topicAppears(topic: string, haystack: string): boolean {
  const need = topicTokens(topic);
  if (!need.length) {
    const t = stripAccents(topic.toLowerCase()).trim();
    return !!t && stripAccents(haystack.toLowerCase()).includes(t);
  }
  const have = new Set(topicTokens(haystack));
  return need.every((t) => have.has(t));
}

function verbIsNonObservable(verb: string): boolean {
  const v = stripAccents(collapse(verb).toLowerCase()).replace(/^(el|la|los|las)\s+(estudiante|estudiantes|aprendiz|aprendices|participante|participantes)\s+/, '');
  if (!v) return false;
  return NON_OBSERVABLE_VERBS.some((n) => v === n || v.startsWith(`${n} `));
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const unitTotal = (u: MicrocurriculumV1['units'][number]) => u.hours.contact + u.hours.practice + u.hours.autonomous;

class Issues {
  readonly list: MicrocurriculumIssue[] = [];
  err(code: IssueCode, message: string, path?: string) { this.list.push({ code, severity: 'error', message, ...(path ? { path } : {}) }); }
  warn(code: IssueCode, message: string, path?: string) { this.list.push({ code, severity: 'warning', message, ...(path ? { path } : {}) }); }
}

function checkShape(answers: MicrocurriculumAnswers, mc: MicrocurriculumV1, I: Issues): void {
  if (mc.version !== 1) I.err('V8', 'El documento no tiene la versión 1 del microcurrículo.', 'version');
  if (!collapse(mc.identification?.courseName)) I.err('V8', 'Falta el nombre del curso.', 'identification.courseName');
  for (const [k, label] of [['description', 'la descripción'], ['justification', 'la justificación'], ['generalObjective', 'el objetivo general'], ['learnerProfile', 'el perfil del estudiante']] as const) {
    if (!collapse(mc[k])) I.err('V8', `Falta ${label}.`, k);
  }
  if (!collapse(mc.methodology?.text)) I.err('V8', 'Falta la descripción de la metodología.', 'methodology.text');

  const so = mc.specificObjectives.length;
  if (so < MC_LIMITS.specificObjectivesMin || so > MC_LIMITS.specificObjectivesMax) {
    I.err('V8', `Debe haber de ${MC_LIMITS.specificObjectivesMin} a ${MC_LIMITS.specificObjectivesMax} objetivos específicos (hay ${so}).`, 'specificObjectives');
  }

  const n = mc.outcomes.length;
  if (n < MC_LIMITS.outcomesMin || n > MC_LIMITS.outcomesMax) I.err('V8', `Debe haber de ${MC_LIMITS.outcomesMin} a ${MC_LIMITS.outcomesMax} resultados de aprendizaje (hay ${n}).`, 'outcomes');
  const seen = new Set<string>();
  mc.outcomes.forEach((o, i) => {
    const p = `outcomes[${i}]`;
    if (!RA_RE.test(o.id)) I.err('V8', `${o.id || `El resultado ${i + 1}`}: el id debe ser RA1, RA2…`, `${p}.id`);
    else if (seen.has(o.id)) I.err('V8', `Id repetido: ${o.id}.`, `${p}.id`);
    seen.add(o.id);
    for (const [k, label] of [['text', 'el enunciado'], ['verb', 'el verbo'], ['condition', 'la condición'], ['criterion', 'el criterio']] as const) {
      if (!collapse(o[k])) I.err('V8', `${o.id || `Resultado ${i + 1}`}: falta ${label}.`, `${p}.${k}`);
    }
    if (!(BLOOM as readonly string[]).includes(o.bloom)) I.err('V8', `${o.id || `Resultado ${i + 1}`}: nivel de Bloom inválido («${o.bloom}»).`, `${p}.bloom`);
  });

  if (competenciesRequired(answers) && !mc.competencies.length) I.err('V8', 'Faltan las competencias (las pidió el docente o las exige el tipo de institución).', 'competencies');
  if (mc.competencies.length > MC_LIMITS.competenciesMax) I.err('V8', `Como máximo ${MC_LIMITS.competenciesMax} competencias.`, 'competencies');
  const seenCo = new Set<string>();
  mc.competencies.forEach((c, i) => {
    if (!CO_RE.test(c.id)) I.err('V8', `Competencia ${i + 1}: el id debe ser CO1, CO2…`, `competencies[${i}].id`);
    else if (seenCo.has(c.id)) I.err('V8', `Id repetido: ${c.id}.`, `competencies[${i}].id`);
    seenCo.add(c.id);
    if (!collapse(c.text)) I.err('V8', `${c.id || `Competencia ${i + 1}`}: falta el enunciado.`, `competencies[${i}].text`);
  });

  const u = mc.units.length;
  const wanted = answers.contents?.unitCount;
  if (typeof wanted === 'number') {
    if (u !== wanted) I.err('V8', `Se pidieron ${wanted} unidades y hay ${u}.`, 'units');
  } else if (u < MC_LIMITS.unitCountMin || u > MC_LIMITS.unitCountMax) {
    I.err('V8', `Debe haber de ${MC_LIMITS.unitCountMin} a ${MC_LIMITS.unitCountMax} unidades (hay ${u}).`, 'units');
  } else if (u < MC_LIMITS.defaultUnitsMin || u > MC_LIMITS.defaultUnitsMax) {
    I.warn('V8', `Lo habitual son ${MC_LIMITS.defaultUnitsMin} a ${MC_LIMITS.defaultUnitsMax} unidades (hay ${u}).`, 'units');
  }
  const seenU = new Set<string>();
  mc.units.forEach((x, i) => {
    const p = `units[${i}]`;
    if (!U_RE.test(x.id)) I.err('V8', `Unidad ${i + 1}: el id debe ser U1, U2…`, `${p}.id`);
    else if (seenU.has(x.id)) I.err('V8', `Id repetido: ${x.id}.`, `${p}.id`);
    seenU.add(x.id);
    if (!collapse(x.title)) I.err('V8', `${x.id || `Unidad ${i + 1}`}: falta el título.`, `${p}.title`);
    if (!x.contents.length) I.err('V8', `${x.id || `Unidad ${i + 1}`}: no tiene contenidos.`, `${p}.contents`);
    if (x.contents.length > MC_LIMITS.contentsPerUnitMax) I.err('V8', `${x.id}: como máximo ${MC_LIMITS.contentsPerUnitMax} contenidos por unidad.`, `${p}.contents`);
    if (x.weeks && x.weeks.from > x.weeks.to) I.err('V8', `${x.id}: la semana inicial es posterior a la final.`, `${p}.weeks`);
  });

  const e = mc.evaluation.length;
  if (e < MC_LIMITS.evaluationMin || e > MC_LIMITS.evaluationMax) I.err('V8', `Debe haber de ${MC_LIMITS.evaluationMin} a ${MC_LIMITS.evaluationMax} momentos de evaluación (hay ${e}).`, 'evaluation');
  mc.evaluation.forEach((x, i) => {
    if (!collapse(x.name)) I.err('V8', `Evaluación ${i + 1}: falta el nombre.`, `evaluation[${i}].name`);
    if (!collapse(x.evidence)) I.err('V8', `${x.name || `Evaluación ${i + 1}`}: falta la evidencia.`, `evaluation[${i}].evidence`);
    if (!(x.percent >= 0 && x.percent <= 100)) I.err('V8', `${x.name || `Evaluación ${i + 1}`}: porcentaje fuera de 0–100.`, `evaluation[${i}].percent`);
  });
  if (mc.bibliography.length > MC_LIMITS.bibliographyMax) I.err('V8', `Como máximo ${MC_LIMITS.bibliographyMax} referencias.`, 'bibliography');
  mc.bibliography.forEach((b, i) => {
    if (b.origin !== 'docente' && b.origin !== 'sugerida') I.err('V8', `Referencia ${i + 1}: origen inválido.`, `bibliography[${i}].origin`);
  });
  for (const f of PROVENANCE_FIELDS) {
    const v = mc.provenance?.[f];
    if (v !== 'docente' && v !== 'cursia') I.err('V8', `Procedencia inválida en «${f}».`, `provenance.${f}`);
  }
}

function checkHours(answers: MicrocurriculumAnswers, mc: MicrocurriculumV1, I: Issues): void {
  const total = resolveTotalHours(answers.time);
  if (total === null) return;
  const tol = MC_LIMITS.hoursTolerance;
  if (Math.abs(mc.totalHours - total) > tol) I.err('V1', `El total declarado (${mc.totalHours} h) no es el pedido (${total} h).`, 'totalHours');
  const sum = sumUnitHours(mc.units);
  if (Math.abs(sum - total) > tol) I.err('V1', `Las horas de las unidades suman ${sum} h y el total pedido es ${total} h.`, 'units');
  const split = requestedSplit(answers.time);
  const label: Record<HourKind, string> = { contact: 'docente', practice: 'práctica', autonomous: 'autónomo' };
  for (const k of HOUR_KINDS) {
    if (split[k] === undefined) continue;
    const got = round2(mc.units.reduce((a, x) => a + x.hours[k], 0));
    if (Math.abs(got - (split[k] as number)) > tol) I.err('V1', `Horas de trabajo ${label[k]}: ${got} h y se exigieron ${split[k]} h.`, 'units');
  }
}

/** ¿Los porcentajes, en orden, se agrupan en bloques consecutivos que suman cada corte? */
export function respectsCuts(all: number[], cuts: number[]): boolean {
  const percents = all.filter((p) => p > 0); // un momento de 0 % (formativo) no pertenece a ningún corte (review P2-10)
  let i = 0;
  for (const c of cuts) {
    let acc = 0;
    const start = i;
    while (i < percents.length && acc < c - 0.01) acc += percents[i++];
    if (i === start || Math.abs(acc - c) > 0.01) return false;
  }
  return i === percents.length;
}

function checkEvaluation(answers: MicrocurriculumAnswers, mc: MicrocurriculumV1, I: Issues): void {
  if (!mc.evaluation.length) return;
  const sum = round2(mc.evaluation.reduce((a, e) => a + e.percent, 0));
  if (Math.abs(sum - 100) > 0.01) I.err('V2', `Los porcentajes de evaluación suman ${sum} % (deben sumar 100 %).`, 'evaluation');
  const cuts = parseInstitutionalCuts(answers.methodology?.institutionalEvaluation);
  if (cuts && Math.abs(sum - 100) <= 0.01 && !respectsCuts(mc.evaluation.map((e) => e.percent), cuts)) {
    I.err('V2', `La evaluación no respeta los cortes institucionales ${cuts.join('/')} (en orden, los momentos consecutivos deben sumar cada corte).`, 'evaluation');
  }
}

function checkCoverage(mc: MicrocurriculumV1, I: Issues): void {
  const ids = new Set(mc.outcomes.map((o) => o.id));
  const inUnits = new Set<string>();
  const inEval = new Set<string>();
  mc.units.forEach((u, i) => u.outcomeIds.forEach((r) => {
    if (!ids.has(r)) I.err('V3', `${u.id || `Unidad ${i + 1}`} referencia ${r}, que no existe.`, `units[${i}].outcomeIds`);
    inUnits.add(r);
  }));
  mc.evaluation.forEach((e, i) => e.outcomeIds.forEach((r) => {
    if (!ids.has(r)) I.err('V3', `«${e.name || `Evaluación ${i + 1}`}» referencia ${r}, que no existe.`, `evaluation[${i}].outcomeIds`);
    inEval.add(r);
  }));
  mc.outcomes.forEach((o, i) => {
    if (!inUnits.has(o.id)) I.err('V3', `${o.id} no se trabaja en ninguna unidad.`, `outcomes[${i}]`);
    if (!inEval.has(o.id)) I.err('V3', `${o.id} no se evalúa en ningún momento de evaluación.`, `outcomes[${i}]`);
  });
}

function checkTopics(answers: MicrocurriculumAnswers, mc: MicrocurriculumV1, I: Issues): void {
  const unitTexts = mc.units.map((u) => [u.title, ...u.contents].join(' \n '));
  (answers.contents?.requiredTopics || []).forEach((t, i) => {
    if (!unitTexts.some((h) => topicAppears(t, h))) I.err('V4', `El tema obligatorio «${t}» no aparece en ninguna unidad.`, `contents.requiredTopics[${i}]`);
  });
  const items: { text: string; where: string }[] = [];
  mc.units.forEach((u, i) => {
    items.push({ text: u.title, where: `units[${i}].title` });
    u.contents.forEach((c, j) => items.push({ text: c, where: `units[${i}].contents[${j}]` }));
  });
  mc.outcomes.forEach((o, i) => items.push({ text: o.text, where: `outcomes[${i}].text` }));
  mc.evaluation.forEach((e, i) => items.push({ text: `${e.name} ${e.evidence}`, where: `evaluation[${i}]` }));
  (answers.contents?.excludedTopics || []).forEach((t) => {
    const hit = items.find((x) => topicAppears(t, x.text));
    if (hit) I.err('V5', `Aparece el tema excluido «${t}».`, hit.where);
  });
}

function checkVerbs(mc: MicrocurriculumV1, I: Issues): void {
  mc.outcomes.forEach((o, i) => {
    const first = collapse(o.text).split(' ')[0] || '';
    if (verbIsNonObservable(o.verb) || verbIsNonObservable(first)) {
      I.err('V6', `${o.id}: «${o.verb || first}» no es un verbo observable; usa uno que se pueda evidenciar (analizar, diseñar, calcular…).`, `outcomes[${i}].verb`);
    }
  });
}

function checkVerbatim(answers: MicrocurriculumAnswers, mc: MicrocurriculumV1, I: Issues): void {
  const id = answers.identification || {};
  const same = (a: unknown, b: unknown) => collapse(String(a ?? '')) === collapse(String(b ?? ''));
  if (id.courseName && !same(mc.identification.courseName, id.courseName)) I.err('V7', 'El nombre del curso no es el que escribió el docente.', 'identification.courseName');
  if (id.program && !same(mc.identification.program, id.program)) I.err('V7', 'El programa no es el que escribió el docente.', 'identification.program');
  if (id.code && !same(mc.identification.code, id.code)) I.err('V7', 'El código no es el que escribió el docente.', 'identification.code');
  (answers.references?.bibliography || []).forEach((b, i) => {
    const hit = mc.bibliography.find((x) => same(x.text, b));
    if (!hit) I.err('V7', `Falta, literal, la referencia obligatoria «${b}».`, `references.bibliography[${i}]`);
    else if (hit.origin !== 'docente') I.err('V7', `La referencia «${b}» es del docente y figura como sugerida.`, `references.bibliography[${i}]`);
  });
}

/** V1–V8 sobre un documento (sin IA, USD 0). Errores primero, en orden de código. */
export function validateMicrocurriculum(answers: MicrocurriculumAnswers, mc: MicrocurriculumV1): MicrocurriculumIssue[] {
  const I = new Issues();
  checkShape(answers, mc, I);
  checkHours(answers, mc, I);
  checkEvaluation(answers, mc, I);
  checkCoverage(mc, I);
  checkTopics(answers, mc, I);
  checkVerbs(mc, I);
  checkVerbatim(answers, mc, I);
  const sev = (x: MicrocurriculumIssue) => (x.severity === 'error' ? 0 : 1);
  return I.list.map((x, i) => ({ x, i })).sort((a, b) => sev(a.x) - sev(b.x) || a.x.code.localeCompare(b.x.code) || a.i - b.i).map((y) => y.x);
}

export const errorsOf = (issues: MicrocurriculumIssue[]) => issues.filter((i) => i.severity === 'error');

// ── Reparación aritmética ──────────────────────────────────────────────────────────────────────────────────

/** Reparte `steps` enteros en proporción a `weights` (mayor resto; empates por orden). Pesos nulos → partes iguales. */
export function largestRemainder(weights: number[], steps: number): number[] {
  if (!weights.length) return [];
  const w = weights.map((x) => (x > 0 ? x : 0));
  const W = w.reduce((a, b) => a + b, 0);
  const share = W > 0 ? w.map((x) => (x / W) * steps) : w.map(() => steps / w.length);
  const base = share.map(Math.floor);
  let left = steps - base.reduce((a, b) => a + b, 0);
  const order = share.map((s, i) => ({ i, r: s - Math.floor(s) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) base[order[k].i]++;
  return base;
}

/**
 * Corrige lo aritmético y lo registra: V1 (horas proporcionales al reparto del modelo, por tipo y por unidad, a 0,5 h,
 * respetando el reparto exigido) y V2 (porcentajes escalados al entero con mayor resto). No toca nada más.
 */
/**
 * Granularidad del reparto: 0,5 h cuando el total es múltiplo de 0,5; si no, 0,25 h o, en último caso, 0,01 h — así
 * el reparto siempre puede sumar EXACTAMENTE el total (review P2-2).
 */
export function hoursStepFor(total: number): number {
  const mult = (s: number) => Math.abs(Math.round(total / s) * s - total) < 1e-9;
  return mult(MC_LIMITS.hoursStep) ? MC_LIMITS.hoursStep : mult(0.25) ? 0.25 : 0.01;
}

export function repairArithmetic(
  answers: MicrocurriculumAnswers, input: MicrocurriculumV1, scope: { hours?: boolean; percents?: boolean } = {},
): { mc: MicrocurriculumV1; repairs: string[] } {
  const mc: MicrocurriculumV1 = JSON.parse(JSON.stringify(input));
  const repairs: string[] = [];
  const total = resolveTotalHours(answers.time);
  const tol = MC_LIMITS.hoursTolerance;
  const doHours = scope.hours !== false;
  const doPercents = scope.percents !== false;

  if (doHours && total !== null && mc.units.length) {
    const step = hoursStepFor(total);
    const r = (n: number) => Math.round(n * 100) / 100;
    const split = requestedSplit(answers.time);
    const before = sumUnitHours(mc.units);
    const kindSum = (k: HourKind) => mc.units.reduce((a, u) => a + u.hours[k], 0);
    const splitBroken = HOUR_KINDS.some((k) => split[k] !== undefined && Math.abs(kindSum(k) - (split[k] as number)) > tol);
    if (Math.abs(before - total) > tol || splitBroken) {
      const totalSteps = Math.round(total / step);
      // Horas objetivo por tipo (reales): las exigidas tal cual; el resto, en proporción a lo que propuso el modelo. Luego
      // UN solo reparto de mayor resto contra el total en pasos → los tipos suman exactamente el total (P2-2).
      const want: Record<HourKind, number> = { contact: 0, practice: 0, autonomous: 0 };
      const free = HOUR_KINDS.filter((k) => split[k] === undefined);
      let fixed = 0;
      for (const k of HOUR_KINDS) if (split[k] !== undefined) { want[k] = split[k] as number; fixed += want[k]; }
      const rest = Math.max(0, total - fixed);
      if (free.length) {
        const w = free.map(kindSum);
        const W = w.reduce((a, b) => a + b, 0);
        free.forEach((k, i) => { want[k] = W > 0 ? (w[i] / W) * rest : rest / free.length; });
      }
      const target: Record<HourKind, number> = { contact: 0, practice: 0, autonomous: 0 };
      largestRemainder(HOUR_KINDS.map((k) => want[k]), totalSteps).forEach((s, i) => { target[HOUR_KINDS[i]] = s; });
      for (const k of HOUR_KINDS) {
        const w = mc.units.map((u) => u.hours[k]);
        const weights = w.some((x) => x > 0) ? w : mc.units.map(unitTotal);
        largestRemainder(weights, target[k]).forEach((s, i) => { mc.units[i].hours[k] = r(s * step); });
      }
      repairs.push(`Horas: se redistribuyeron en proporción para sumar ${round2(sumUnitHours(mc.units))} h (la propuesta sumaba ${before} h${splitBroken ? ' y no respetaba el reparto exigido' : ''}).`);
    }
    if (Math.abs(mc.totalHours - total) > 0.001) {
      repairs.push(`Horas: el total declarado pasó de ${mc.totalHours} h a ${total} h (el pedido).`);
      mc.totalHours = total;
    }
  }

  if (doPercents && mc.evaluation.length) {
    const sum = round2(mc.evaluation.reduce((a, e) => a + e.percent, 0));
    if (Math.abs(sum - 100) > 0.01) {
      largestRemainder(mc.evaluation.map((e) => e.percent), 100).forEach((p, i) => { mc.evaluation[i].percent = p; });
      repairs.push(`Evaluación: los porcentajes sumaban ${sum} % y se escalaron para sumar 100 %.`);
    }
  }
  mc.repairs = [...(mc.repairs || []), ...repairs];
  return { mc, repairs };
}
