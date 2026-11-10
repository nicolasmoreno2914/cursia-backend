/**
 * r107 B3 · Taller de cursos — diagnóstico técnico: corre T01–T12 sobre el paquete y arma el INFORME con semáforo.
 *
 * Reglas de agregación del semáforo (explícitas y probadas en scripts/r107/check-r107-diagnosis.js):
 *   - color de un conjunto de hallazgos: ROJO si hay al menos un `error`; AMARILLO si no hay errores y hay al menos un
 *     `warning`; VERDE si no hay ninguno de los dos (`info` NUNCA cambia el color);
 *   - ACTIVIDAD: los hallazgos cuyo alcance es esa actividad (`scope.activity.moduleId`);
 *   - CAPÍTULO N: los hallazgos con `scope.chapterNumber = N` (los de sus actividades y los del capítulo en sí);
 *   - CURSO: TODOS los hallazgos (de actividades, capítulos y del curso).
 *   Toda actividad y todo capítulo del inventario aparece en el informe (también los verdes).
 * Conteo por check: { error, warning, info } de cada T01–T12, y el estado de cada check (corrió / no aplica + motivo /
 * diferido: T12, la restauración real en Moodle, se corre en B6 o bajo demanda, nunca en este diagnóstico).
 *
 * Determinista: mismo paquete → mismo informe byte a byte (sin fechas: `diagnosedAt` lo pone el servicio aparte).
 */
import { stableStringify } from '../course-model';
import { DiagnosisContext, DiagnosisInput, buildDiagnosisContext } from './context';
import { CHECK_FAMILY_APPLICABILITY, TECHNICAL_CHECKS } from './checks';
import { foldValidator, validatorItems } from './check-v3';
import { CHECK_IDS, CheckId, CheckStatus, Finding, SEVERITY_RANK, Severity } from './finding';

/** Versión del ARMADO del diagnóstico: subirla en cada cambio de un check (un diagnóstico guardado con otra se rehace). */
export const DIAGNOSIS_CODE_VERSION = 'b3-r3';
export const DIAGNOSIS_SCHEMA = 1;

export type Light = 'red' | 'yellow' | 'green';
export interface SeverityCounts { error: number; warning: number; info: number }

export interface DiagnosisReport {
  schema: number;
  codeVersion: string;
  family: string;
  builderLine: string;
  builderVersion: string | null;
  checks: CheckStatus[];
  validator: { mode: 'with_expectations' | 'without_expectations' | 'not_applicable'; reason: string | null; issues: number; error: string | null };
  counts: { total: SeverityCounts; byCheck: Record<CheckId, SeverityCounts> };
  light: {
    course: Light;
    chapters: Array<{ number: number; title: string | null; light: Light; counts: SeverityCounts }>;
    activities: Array<{ moduleId: number; dir: string; modname: string; title: string; chapterNumber: number | null; light: Light; counts: SeverityCounts }>;
  };
  findings: Finding[];
}

const zero = (): SeverityCounts => ({ error: 0, warning: 0, info: 0 });
export function countOf(fs: readonly Finding[]): SeverityCounts {
  const c = zero();
  for (const x of fs) c[x.severity]++;
  return c;
}
/** Semáforo de un conjunto de hallazgos (regla de arriba). */
export function lightOf(fs: readonly Finding[]): Light {
  if (fs.some((x) => x.severity === 'error')) return 'red';
  if (fs.some((x) => x.severity === 'warning')) return 'yellow';
  return 'green';
}

const T12_REASON = 'restauración real en el Moodle de staging: disponible en B6 / bajo demanda (no corre en el diagnóstico)';

/** Diagnóstico de un contexto ya leído (puro). */
export function diagnoseContext(ctx: DiagnosisContext): DiagnosisReport {
  const checks: CheckStatus[] = [];
  const findings: Finding[] = [];
  for (const c of TECHNICAL_CHECKS) {
    const why = c.applies(ctx);
    checks.push({ check: c.id, title: c.title, status: why ? 'not_applicable' : 'ran', reason: why });
    if (!why) findings.push(...c.run(ctx));
  }
  const fam = CHECK_FAMILY_APPLICABILITY.T11[ctx.family];
  if (ctx.validator.mode === 'not_applicable') {
    checks.push({ check: 'T11', title: 'Validador completo del builder v3', status: 'not_applicable', reason: typeof fam === 'string' && ctx.builderLine !== 'v3' ? fam : ctx.validator.reason });
  } else {
    checks.push({ check: 'T11', title: 'Validador completo del builder v3', status: 'ran', reason: ctx.validator.mode === 'without_expectations' ? `sin expectativas: ${ctx.validator.reason}` : null });
    findings.push(...foldValidator(validatorItems(ctx), findings));
  }
  checks.push({ check: 'T12', title: 'Restauración real en Moodle', status: 'deferred', reason: T12_REASON });

  const order = new Map(ctx.course.activities.map((a, i) => [a.moduleId, i]));
  findings.sort((a, b) =>
    (a.check < b.check ? -1 : a.check > b.check ? 1 : 0)
    || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    || (a.scope.chapterNumber ?? 1e9) - (b.scope.chapterNumber ?? 1e9)
    || (a.scope.activity ? order.get(a.scope.activity.moduleId) ?? 1e9 : -1) - (b.scope.activity ? order.get(b.scope.activity.moduleId) ?? 1e9 : -1)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Ids únicos (dos hallazgos idénticos en todo = uno).
  const seen = new Set<string>();
  const unique = findings.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));

  const byCheck = Object.fromEntries(CHECK_IDS.map((id) => [id, countOf(unique.filter((x) => x.check === id))])) as Record<CheckId, SeverityCounts>;
  const report: DiagnosisReport = {
    schema: DIAGNOSIS_SCHEMA,
    codeVersion: DIAGNOSIS_CODE_VERSION,
    family: ctx.family,
    builderLine: ctx.builderLine,
    builderVersion: ctx.builderVersion,
    checks,
    validator: { mode: ctx.validator.mode, reason: ctx.validator.reason, issues: ctx.validator.issues.length, error: ctx.validator.error },
    counts: { total: countOf(unique), byCheck },
    light: {
      course: lightOf(unique),
      chapters: ctx.course.chapters.map((c) => {
        const fs = unique.filter((x) => x.scope.chapterNumber === c.number);
        return { number: c.number, title: c.title, light: lightOf(fs), counts: countOf(fs) };
      }),
      activities: ctx.course.activities.map((a) => {
        const fs = unique.filter((x) => x.scope.activity?.moduleId === a.moduleId);
        return { moduleId: a.moduleId, dir: a.dir, modname: a.modname, title: a.title, chapterNumber: a.placement.scope === 'chapter' ? a.placement.chapterNumber : null, light: lightOf(fs), counts: countOf(fs) };
      }),
    },
    findings: unique,
  };
  return JSON.parse(stableStringify(report)) as DiagnosisReport;
}

/** Lee el paquete y lo diagnostica. Nunca lanza por el contenido del paquete (sí por un error del lector al abrirlo). */
export async function runTechnicalDiagnosis(input: DiagnosisInput): Promise<DiagnosisReport> {
  return diagnoseContext(await buildDiagnosisContext(input));
}

export type { Severity };
