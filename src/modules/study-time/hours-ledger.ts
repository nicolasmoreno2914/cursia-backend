// r58 (I3) · Registro de horas del curso (HoursReport): declarado vs objetivo vs estimado vs asignado vs observado.
//
// Puro y determinista (USD 0). Sale de las MISMAS líneas que el modelo de tiempo (`estimateCourseStudyTimeDetailed`):
//   - estimated = líneas `measured` (cantidad contada en el artifact × tasa) + `estimated_with_evidence` (cantidad
//     planificada calibrada × tasa);
//   - assigned  = líneas `declared` (niveles de la Actividad de Aplicación y de la práctica guiada, constante del foro);
//   - declared  = lo que dice el DOCUMENTO (total, componentes, créditos, semanas), con su procedencia;
//   - target    = horas objetivo del curso (perfil / Blueprint) y los límites obligatorios del documento;
//   - observed  = SIEMPRE null por contrato: no hay fuente (logs de Moodle, finalización) — nunca se imputa;
//   - gap       = target − (estimated + assigned), explícito. Un gap nunca se rellena.
// Invariantes (los exige scripts/check-hours-model.js): total = Σ líneas = estimated + assigned = minutos del modelo.
import { HourBasis, HourLine, StudyTimeEstimate } from './time-model';
import { DECLARED_COMPONENT_KINDS, DeclaredComponentKind, HOUR_CATEGORIES, HourCategory, TimeModelConfig } from './time-model-config';

export const HOURS_REPORT_VERSION = 1 as const;

/**
 * Tolerancia del gap: la MISMA del distribuidor (DISTRIBUTOR_RULES.tolerance; check-hours-model exige igualdad). Copia
 * local para no arrastrar el distribuidor (y el motor pedagógico) al empaque.
 */
export const HOURS_REPORT_TOLERANCE = Object.freeze({ pct: 0.05, minHours: 1 });

/** Horas del documento académico (academic-context `hours`), solo lo que el documento trae. */
export interface DeclaredHoursInput {
  /** De dónde salen (hoy solo el documento académico del curso). */
  source: 'document';
  total: number | null;
  /** El documento da un rango («40–44 horas»); `total` es el punto medio. */
  totalRange?: { min: number; max: number } | null;
  weekly: number | null;
  weeks: number | null;
  credits: number | null;
  components: Array<{ id: string; label: string; kind: DeclaredComponentKind; hours: number }>;
}

export type HoursFindingSeverity = 'MAJOR' | 'MINOR' | 'INFO';
export interface HoursFinding {
  code: 'HOURS_TARGET_GAP' | 'HOURS_COMPONENT_MISMATCH' | 'HOURS_COMPONENT_MAPPING_UNDEFINED' | 'HOURS_CREDITS_CONVERSION_UNDEFINED' | 'HOURS_UNMEASURED';
  severity: HoursFindingSeverity;
  detail: string;
}

type ByCategory = Record<HourCategory, number>;
type ByBasis = Record<HourBasis, number>;

export interface HoursReport {
  reportVersion: typeof HOURS_REPORT_VERSION;
  /** design = antes de generar (valores planificados); package = al empaquetar (medidas del paquete). */
  stage: 'design' | 'package';
  rulesVersion: number;
  configId: string;
  lines: HourLine[];
  totals: { minutes: number; hours: number; byCategory: ByCategory; byBasis: ByBasis };
  declared:
    | {
      source: 'document';
      totalHours: number | null;
      totalRange: { min: number; max: number } | null;
      weekly: number | null;
      weeks: number | null;
      /** weekly × weeks (solo si el documento trae ambos; no se compara con nada: dato). */
      weeklyTimesWeeks: number | null;
      credits: null | { value: number; conversion: 'no_definida' } | { value: number; conversion: 'configurada'; hoursPerCredit: number; hours: number };
      components: Array<{
        id: string; label: string; kind: DeclaredComponentKind; hours: number;
        /** Categorías del registro a las que corresponde (de la configuración). null = mapeo no definido. */
        mappedCategories: HourCategory[] | null;
        /** Horas del modelo en esas categorías (solo con mapeo). */
        modelHours: number | null;
        deltaHours: number | null;
      }>;
    }
    | null;
  /** Solo sin horas del documento: por qué no hay declarado (el documento no las trae, o no se congelan en el Blueprint). */
  declaredReason?: 'no_document_hours' | 'document_hours_not_frozen';
  target: { hours: number | null; bounds: { min?: number; max?: number } | null; toleranceHours: number | null };
  estimated: { minutes: number; hours: number; byCategory: ByCategory; measuredMinutes: number; estimatedWithEvidenceMinutes: number };
  assigned: { minutes: number; hours: number; byCategory: ByCategory };
  observed: null;
  observedReason: 'no_data_source';
  /** target − (estimated + assigned), en horas. null sin objetivo. Nunca se rellena. */
  gap: { hours: number; minutes: number; within: boolean } | null;
  /** assigned / total (0–1, 4 decimales). Siempre visible; el umbral es una decisión pendiente (no se aplica ninguno). */
  declaredShare: number;
  findings: HoursFinding[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const zeroCat = (): ByCategory => Object.fromEntries(HOUR_CATEGORIES.map((c) => [c, 0])) as ByCategory;
const roundCat = (x: ByCategory): ByCategory => Object.fromEntries(HOUR_CATEGORIES.map((c) => [c, r2(x[c])])) as ByCategory;
const hoursTxt = (h: number) => String(h).replace('.', ',');

export class HoursReportError extends Error {
  readonly code = 'HOURS_REPORT_INVARIANT';
  constructor(message: string) {
    super(`HOURS_REPORT_INVARIANT: ${message}`);
    this.name = 'HoursReportError';
  }
}

/** Horas del documento desde el contexto académico guardado (solo lo encontrado; nada se infiere). null sin horas. */
export function declaredHoursFromAcademicContext(ctx: unknown): DeclaredHoursInput | null {
  const h = (ctx as any)?.hours;
  if (!h || typeof h !== 'object') return null;
  const val = (f: any): number | null => (f && f.status !== 'missing' && typeof f.value === 'number' && Number.isFinite(f.value) ? f.value : null);
  const components = (Array.isArray(h.components) ? h.components : [])
    .filter((c: any) => c && (DECLARED_COMPONENT_KINDS as readonly string[]).includes(c.kind) && typeof c.hours === 'number' && Number.isFinite(c.hours))
    .map((c: any) => ({ id: String(c.id), label: String(c.label ?? ''), kind: c.kind as DeclaredComponentKind, hours: c.hours }));
  const out: DeclaredHoursInput = {
    source: 'document',
    total: val(h.total),
    totalRange: h.total?.range && typeof h.total.range.min === 'number' && typeof h.total.range.max === 'number' ? { min: h.total.range.min, max: h.total.range.max } : null,
    weekly: val(h.weekly),
    weeks: val(h.weeks),
    credits: val(h.credits),
    components,
  };
  return out.total === null && out.weekly === null && out.weeks === null && out.credits === null && !components.length ? null : out;
}

export interface HoursReportInput {
  stage: 'design' | 'package';
  estimate: StudyTimeEstimate;
  lines: HourLine[];
  config: TimeModelConfig;
  targetHours: number | null;
  hoursBounds?: { min?: number; max?: number } | null;
  declared?: DeclaredHoursInput | null;
  /** Motivo si no hay declarado (default `no_document_hours`). */
  declaredReason?: 'no_document_hours' | 'document_hours_not_frozen';
}

/** Informe de horas. Lanza HOURS_REPORT_INVARIANT si las líneas no suman la estimación (nunca un informe incoherente). */
export function buildHoursReport(input: HoursReportInput): HoursReport {
  const { estimate, lines, config } = input;
  const byCategory = zeroCat();
  const estCat = zeroCat();
  const asgCat = zeroCat();
  const byBasis: ByBasis = { measured: 0, estimated_with_evidence: 0, declared: 0 };
  for (const l of lines) {
    byCategory[l.category] += l.minutes;
    byBasis[l.basis] += l.minutes;
    if (l.basis === 'declared') asgCat[l.category] += l.minutes;
    else estCat[l.category] += l.minutes;
  }
  const total = r2(lines.reduce((a, l) => a + l.minutes, 0));
  if (Math.abs(total - estimate.courseEstimatedMinutes) > 0.005) {
    throw new HoursReportError(`las líneas suman ${total} min y el modelo ${estimate.courseEstimatedMinutes} min`);
  }
  const measuredMin = r2(byBasis.measured);
  const ewe = r2(byBasis.estimated_with_evidence);
  const estimatedMin = r2(byBasis.measured + byBasis.estimated_with_evidence);
  const assignedMin = r2(byBasis.declared);
  if (Math.abs(r2(estimatedMin + assignedMin) - total) > 0.011) throw new HoursReportError(`estimated + assigned (${estimatedMin} + ${assignedMin}) ≠ total ${total}`);

  const findings: HoursFinding[] = [];
  const target = input.targetHours ?? null;
  const tolH = target === null ? null : Math.max(target * HOURS_REPORT_TOLERANCE.pct, HOURS_REPORT_TOLERANCE.minHours);
  let gap: HoursReport['gap'] = null;
  if (target !== null) {
    const gapMin = r2(target * 60 - total);
    const within = Math.abs(gapMin) <= (tolH as number) * 60 + 1e-9;
    gap = { hours: r1(gapMin / 60), minutes: gapMin, within };
    if (!within) {
      findings.push({
        code: 'HOURS_TARGET_GAP',
        severity: 'MAJOR',
        detail: gapMin > 0
          ? `Faltan ${hoursTxt(r1(gapMin / 60))} h para el objetivo de ${hoursTxt(target)} h (el curso suma ${hoursTxt(r1(total / 60))} h). La diferencia no se rellena.`
          : `El curso suma ${hoursTxt(r1(total / 60))} h: ${hoursTxt(r1(-gapMin / 60))} h por encima del objetivo de ${hoursTxt(target)} h.`,
      });
    }
  }

  let declared: HoursReport['declared'] = null;
  const d = input.declared ?? null;
  if (d) {
    const credits: NonNullable<HoursReport['declared']>['credits'] = d.credits === null
      ? null
      : config.hoursPerCredit === null
        ? { value: d.credits, conversion: 'no_definida' }
        : { value: d.credits, conversion: 'configurada', hoursPerCredit: config.hoursPerCredit, hours: r1(d.credits * config.hoursPerCredit) };
    if (credits && credits.conversion === 'no_definida') {
      findings.push({ code: 'HOURS_CREDITS_CONVERSION_UNDEFINED', severity: 'INFO', detail: `El documento declara ${hoursTxt(d.credits as number)} créditos: conversión no definida (sin horas por crédito configuradas; Cursia no supone ninguna).` });
    }
    const components = d.components.map((c) => {
      const cats = config.componentMap?.[c.kind] ? [...(config.componentMap[c.kind] as HourCategory[])] : null;
      const modelMin = cats ? cats.reduce((a, k) => a + byCategory[k], 0) : null;
      const modelHours = modelMin === null ? null : r1(modelMin / 60);
      const delta = modelHours === null ? null : r1(c.hours - modelHours);
      if (cats && delta !== null && Math.abs(delta) > Math.max(c.hours * HOURS_REPORT_TOLERANCE.pct, HOURS_REPORT_TOLERANCE.minHours)) {
        findings.push({ code: 'HOURS_COMPONENT_MISMATCH', severity: 'MINOR', detail: `«${c.label || c.kind}» (${c.kind}): el documento declara ${hoursTxt(c.hours)} h y el modelo da ${hoursTxt(modelHours as number)} h en ${cats.join(', ')}.` });
      }
      return { id: c.id, label: c.label, kind: c.kind, hours: c.hours, mappedCategories: cats, modelHours, deltaHours: delta };
    });
    const unmapped = components.filter((c) => c.mappedCategories === null);
    if (unmapped.length) {
      findings.push({ code: 'HOURS_COMPONENT_MAPPING_UNDEFINED', severity: 'INFO', detail: `Componentes del documento sin mapeo a categorías: ${unmapped.map((c) => `${c.label || c.kind} (${c.kind}, ${hoursTxt(c.hours)} h)`).join('; ')} — mapeo no definido.` });
    }
    declared = {
      source: 'document',
      totalHours: d.total,
      totalRange: d.totalRange ?? null,
      weekly: d.weekly,
      weeks: d.weeks,
      weeklyTimesWeeks: d.weekly !== null && d.weeks !== null ? r1(d.weekly * d.weeks) : null,
      credits,
      components,
    };
  }
  if (input.stage === 'package') {
    const unmeasured = lines.filter((l) => l.basis === 'estimated_with_evidence');
    if (unmeasured.length) {
      const kinds = [...new Set(unmeasured.map((l) => l.resource))];
      findings.push({ code: 'HOURS_UNMEASURED', severity: 'INFO', detail: `${unmeasured.length} línea(s) con valor planificado (no medido en el paquete): ${kinds.join(', ')} — ${hoursTxt(r1(ewe / 60))} h.` });
    }
  }

  return {
    reportVersion: HOURS_REPORT_VERSION,
    stage: input.stage,
    rulesVersion: estimate.rulesVersion,
    configId: config.id,
    lines,
    totals: { minutes: total, hours: r1(total / 60), byCategory: roundCat(byCategory), byBasis: { measured: measuredMin, estimated_with_evidence: ewe, declared: assignedMin } },
    declared,
    ...(declared ? {} : { declaredReason: input.declaredReason ?? ('no_document_hours' as const) }),
    target: { hours: target, bounds: input.hoursBounds ?? null, toleranceHours: tolH === null ? null : r1(tolH) },
    estimated: { minutes: estimatedMin, hours: r1(estimatedMin / 60), byCategory: roundCat(estCat), measuredMinutes: measuredMin, estimatedWithEvidenceMinutes: ewe },
    assigned: { minutes: assignedMin, hours: r1(assignedMin / 60), byCategory: roundCat(asgCat) },
    observed: null,
    observedReason: 'no_data_source',
    gap,
    declaredShare: total > 0 ? Math.round((assignedMin / total) * 10000) / 10000 : 0,
    findings,
  };
}

/** Resumen compacto (sin líneas) para el resumen del job de empaque y la metadata. */
export function hoursReportSummary(r: HoursReport): Omit<HoursReport, 'lines'> & { lineCount: number } {
  const { lines, ...rest } = r;
  return { ...rest, lineCount: lines.length };
}
