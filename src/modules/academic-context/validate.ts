import { tokenJaccard } from '../coherence/normalize';
import { MAX_LIST_ITEMS } from '../pedagogy/pedagogy-profile';
import { isValidTargetHours } from '../study-time/target-hours';
import type { AcademicContextV1, Field } from './academic-context';

/**
 * Fase 3 · Loop 3.4 — validación SEMÁNTICA del contexto académico antes de pasar al diseño.
 *
 *   error    — imposible continuar (no hay nada que diseñar, vínculos rotos). Bloquea «usar en el diseño».
 *   warning  — inconsistencias del documento (horas que no suman, pesos que no dan 100 %, resultados sin
 *              contenido…). No bloquea: el docente decide.
 *   missing  — datos clave que el documento no trae. No bloquea.
 *
 * Puro y determinista (mismo contexto → mismos issues en el mismo orden). La forma ya la validó
 * validateAcademicContextShape (un contexto mal formado nunca llega aquí).
 */

export const ACADEMIC_VALIDATION_VERSION = 1 as const;

export type AcademicIssueSeverity = 'error' | 'warning' | 'missing';

export interface AcademicIssue {
  severity: AcademicIssueSeverity;
  code: string;
  path: string;
  message: string;
}

export interface AcademicValidation {
  validationVersion: typeof ACADEMIC_VALIDATION_VERSION;
  canProceed: boolean;
  counts: { error: number; warning: number; missing: number };
  issues: AcademicIssue[];
}

/** Umbral de casi-duplicado (token-Jaccard sobre el texto normalizado del Coherence Engine). */
export const DUPLICATE_JACCARD_MIN = 0.8;
const HOURS_TOLERANCE = 0.5;
export const ISSUES_PER_CODE_MAX = 20;

const fmt = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',');
const known = <T>(f: Field<T>) => f.status !== 'missing' && f.value !== null;

export function validateAcademicContext(ctx: AcademicContextV1): AcademicValidation {
  const issues: AcademicIssue[] = [];
  const add = (severity: AcademicIssueSeverity, code: string, path: string, message: string) => issues.push({ severity, code, path, message });

  const contents = ctx.units.flatMap((u) => u.contents);
  const ids = new Set([...ctx.outcomes.map((o) => o.id), ...ctx.competencies.map((o) => o.id)]);

  // ── Errores ──
  if (!ctx.outcomes.length && !ctx.competencies.length && !contents.length && !ctx.units.length) {
    const noText = ctx.documents.length > 0 && ctx.documents.every((d) => d.characters === 0);
    add('error', noText ? 'DOCUMENT_WITHOUT_TEXT' : 'CONTEXT_EMPTY', '',
      noText
        ? 'Los documentos no tienen texto extraíble (¿PDF escaneado?). Sube un PDF con texto o un DOCX.'
        : 'El contexto no tiene resultados de aprendizaje, competencias ni contenidos: no hay nada con qué diseñar el curso.');
  }
  const refs: { path: string; id: string }[] = [];
  ctx.units.forEach((u, i) => {
    u.outcomeIds.forEach((id) => refs.push({ path: `units[${i}].outcomeIds`, id }));
    u.contents.forEach((c, j) => c.outcomeIds.forEach((id) => refs.push({ path: `units[${i}].contents[${j}].outcomeIds`, id })));
  });
  ctx.evaluation.forEach((e, i) => e.outcomeIds.forEach((id) => refs.push({ path: `evaluation[${i}].outcomeIds`, id })));
  for (const r of refs) if (!ids.has(r.id)) add('error', 'UNKNOWN_OUTCOME_REF', r.path, `${r.path} vincula «${r.id}», que no existe entre los resultados de aprendizaje ni las competencias.`);

  // ── Advertencias: horas ──
  const total = known(ctx.hours.total) ? (ctx.hours.total.value as number) : null;
  const comps = ctx.hours.components;
  if (total !== null && comps.length) {
    const sum = comps.reduce((a, c) => a + c.hours, 0);
    if (Math.abs(sum - total) > HOURS_TOLERANCE && ctx.hours.total.status !== 'inferred') {
      add('warning', 'HOURS_SUM_MISMATCH', 'hours', `El documento indica ${fmt(total)} horas, pero la suma de componentes reportada es ${fmt(sum)} horas.`);
    }
  }
  if (total !== null && known(ctx.hours.weekly) && known(ctx.hours.weeks)) {
    const prod = (ctx.hours.weekly.value as number) * (ctx.hours.weeks.value as number);
    if (Math.abs(prod - total) > HOURS_TOLERANCE && ctx.hours.total.status !== 'inferred') {
      add('warning', 'WEEKLY_HOURS_MISMATCH', 'hours', `El documento indica ${fmt(total)} horas, pero ${fmt(ctx.hours.weekly.value as number)} horas semanales × ${fmt(ctx.hours.weeks.value as number)} semanas son ${fmt(prod)} horas.`);
    }
  }
  if (total !== null && ctx.units.length > 1 && ctx.units.every((u) => u.hours !== null)) {
    const sum = ctx.units.reduce((a, u) => a + (u.hours as number), 0);
    if (Math.abs(sum - total) > HOURS_TOLERANCE) add('warning', 'UNIT_HOURS_MISMATCH', 'units', `Las horas de las unidades suman ${fmt(sum)}, pero el total del documento es ${fmt(total)} horas.`);
  }
  if (total !== null && !isValidTargetHours(total)) {
    add('warning', 'HOURS_OUT_OF_RANGE', 'hours.total', `El total de ${fmt(total)} horas no se puede usar como horas objetivo del curso (de 1 a 500, en pasos de 0,5).`);
  }

  // ── Advertencias: evaluación ──
  const weighted = ctx.evaluation.filter((e) => e.weightPct !== null);
  if (weighted.length) {
    const sum = weighted.reduce((a, e) => a + (e.weightPct as number), 0);
    if (Math.abs(sum - 100) > 0.5) add('warning', 'EVALUATION_WEIGHTS_NOT_100', 'evaluation', `Los pesos de la evaluación suman ${fmt(sum)} %, no 100 %.`);
    if (weighted.length < ctx.evaluation.length) add('warning', 'EVALUATION_WEIGHTS_PARTIAL', 'evaluation', `${ctx.evaluation.length - weighted.length} actividad(es) de evaluación no tienen peso.`);
  }

  // ── Advertencias: alineación del documento (solo si el documento vincula algo: sin vínculos no se presume) ──
  const linkedFromContents = new Set<string>();
  ctx.units.forEach((u) => { u.outcomeIds.forEach((x) => linkedFromContents.add(x)); u.contents.forEach((c) => c.outcomeIds.forEach((x) => linkedFromContents.add(x))); });
  if (linkedFromContents.size) {
    ctx.outcomes.forEach((o, i) => {
      if (!linkedFromContents.has(o.id)) add('warning', 'OUTCOME_WITHOUT_CONTENT', `outcomes[${i}]`, `El resultado ${o.id} («${short(o.text)}») no tiene ningún contenido asociado en el documento.`);
    });
    ctx.units.forEach((u, i) => {
      const linked = u.outcomeIds.length > 0 || u.contents.some((c) => c.outcomeIds.length > 0);
      if (!linked) add('warning', 'CONTENT_WITHOUT_OUTCOME', `units[${i}]`, `La unidad ${u.id} («${short(u.title)}») no está asociada a ningún resultado de aprendizaje.`);
    });
  }
  const evaluated = new Set(ctx.evaluation.flatMap((e) => e.outcomeIds));
  if (evaluated.size) {
    ctx.outcomes.forEach((o, i) => {
      if (!evaluated.has(o.id)) add('warning', 'OUTCOME_WITHOUT_EVALUATION', `outcomes[${i}]`, `El resultado ${o.id} («${short(o.text)}») no aparece en ninguna actividad de evaluación del documento.`);
    });
  }

  // ── Advertencias: duplicados y contradicciones ──
  dupes(ctx.outcomes.map((o) => ({ id: o.id, text: o.text })), 'outcomes', 'DUPLICATE_OUTCOME', 'resultados', add);
  dupes(ctx.competencies.map((o) => ({ id: o.id, text: o.text })), 'competencies', 'DUPLICATE_COMPETENCY', 'competencias', add);
  // Contenidos: solo dentro de cada unidad (un tema repetido entre unidades suele ser intencional y el par completo es
  // cuadrático: hasta 800 contenidos).
  ctx.units.forEach((u, i) => dupes(u.contents.map((c) => ({ id: c.id, text: c.text })), `units[${i}]`, 'DUPLICATE_CONTENT', 'contenidos', add));
  for (const k of ctx.conflicts) {
    add('warning', 'CONTRADICTION', k.path, `El documento da valores distintos para ${PATH_LABEL[k.path] ?? k.path}: ${k.values.map((v) => `«${short(v.value)}»${v.source.page ? ` (p. ${v.source.page})` : ''}`).join(' y ')}. Se usó el primero; revísalo.`);
  }
  const know = ctx.outcomes.filter((o) => o.domain === 'know').length;
  const doo = ctx.outcomes.filter((o) => o.domain === 'do').length;
  if (know > MAX_LIST_ITEMS || doo > MAX_LIST_ITEMS || ctx.competencies.length > MAX_LIST_ITEMS) {
    add('warning', 'TOO_MANY_OUTCOMES_FOR_PROFILE', 'outcomes', `El perfil pedagógico admite hasta ${MAX_LIST_ITEMS} resultados por tipo: al usarlo en el perfil se tomarán los primeros ${MAX_LIST_ITEMS}.`);
  }

  // ── Faltantes ──
  const miss = (cond: boolean, code: string, path: string, what: string) => { if (cond) add('missing', code, path, `El documento no indica ${what}.`); };
  miss(!known(ctx.identity.subjectName), 'MISSING_SUBJECT', 'identity.subjectName', 'el nombre de la asignatura');
  miss(!ctx.outcomes.length, 'MISSING_OUTCOMES', 'outcomes', 'resultados de aprendizaje');
  miss(!ctx.competencies.length, 'MISSING_COMPETENCIES', 'competencies', 'competencias');
  miss(!ctx.units.length, 'MISSING_CONTENTS', 'units', 'contenidos ni unidades temáticas');
  miss(!known(ctx.hours.total), 'MISSING_HOURS', 'hours.total', 'la intensidad horaria total');
  miss(!ctx.evaluation.length, 'MISSING_EVALUATION', 'evaluation', 'criterios de evaluación');
  miss(!ctx.bibliography.length, 'MISSING_BIBLIOGRAPHY', 'bibliography', 'bibliografía');
  miss(!known(ctx.learner.profile), 'MISSING_LEARNER', 'learner.profile', 'el perfil del estudiante');
  miss(!known(ctx.identity.educationLevel), 'MISSING_LEVEL', 'identity.educationLevel', 'el nivel educativo');
  miss(!known(ctx.methodology), 'MISSING_METHODOLOGY', 'methodology', 'la metodología');

  // Tope por código: 20 issues + una línea «y N más» (un contexto enorme no produce miles de avisos).
  const byCode = new Map<string, number>();
  const capped: AcademicIssue[] = [];
  for (const it of issues) {
    const k = `${it.severity}:${it.code}`;
    const seen = (byCode.get(k) ?? 0) + 1;
    byCode.set(k, seen);
    if (seen <= ISSUES_PER_CODE_MAX) capped.push(it);
  }
  for (const [k, total] of byCode) {
    if (total <= ISSUES_PER_CODE_MAX) continue;
    const [severity, code] = k.split(':') as [AcademicIssueSeverity, string];
    capped.push({ severity, code, path: '', message: `… y ${total - ISSUES_PER_CODE_MAX} aviso(s) más del mismo tipo.` });
  }
  const counts = { error: 0, warning: 0, missing: 0 };
  for (const i of issues) counts[i.severity]++;
  return { validationVersion: ACADEMIC_VALIDATION_VERSION, canProceed: counts.error === 0, counts, issues: capped };
}

const PATH_LABEL: Record<string, string> = {
  'identity.subjectName': 'el nombre de la asignatura', 'identity.program': 'el programa', 'identity.educationLevel': 'el nivel',
  'hours.total': 'la intensidad horaria total', 'hours.weekly': 'las horas semanales', 'hours.weeks': 'el número de semanas',
  'hours.credits': 'los créditos', 'learner.profile': 'el perfil del estudiante', methodology: 'la metodología',
};

function short(s: string): string {
  return s.length > 90 ? `${s.slice(0, 89)}…` : s;
}

function dupes(list: { id: string; text: string }[], path: string, code: string, what: string, add: (s: AcademicIssueSeverity, c: string, p: string, m: string) => void): void {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (tokenJaccard(list[i].text, list[j].text) >= DUPLICATE_JACCARD_MIN) {
        add('warning', code, path, `Los ${what} ${list[i].id} y ${list[j].id} son casi iguales («${short(list[i].text)}»).`);
      }
    }
  }
}
