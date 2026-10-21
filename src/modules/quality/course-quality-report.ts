/**
 * r58 (I2) · Informe de calidad del CURSO (E1–E4) en el formato común (`quality-finding.ts`).
 *
 * Se arma al EMPAQUETAR (worker v3, después de validateMbzV3) y en el dry-run del driver offline, con lo que ya existe:
 * avisos del builder (vocabulario interno, aperturas repetidas, sesgo de las MC de video, caracteres sin glifo…), el
 * registro de horas (facts.hoursReport), y los chequeos determinísticos nuevos (`course-quality-checks.ts`). Opcionalmente
 * proyecta otros reportes ya calculados (batería Q1–Q9, verificación del diseño, alineación, rechazos de items, hallazgos del
 * validador del .mbz) con sus adaptadores. Nunca llama a una IA ni a la red; nunca reescribe contenido.
 *
 * Regla de entrega (documentada; I2-3):
 *   - blocksDelivery = hay al menos un BLOCKER. Hoy un BLOCKER real nunca llega a un paquete subido (el validador del .mbz
 *     y los invariantes ya fallan el job); el campo existe para que el informe sea autoexplicativo y para el dry-run.
 *   - requiresHumanResolution = hay al menos un MAJOR. NO bloquea automáticamente: se registra en el job (y la metadata del
 *     .mbz) y se muestra a administradores en «Curso listo». Resolver o aceptar un MAJOR (con motivo) es una decisión humana
 *     pendiente de flujo propio (mismo patrón que la aceptación R68 de capacidades).
 */
import { QUALITY_FINDING_FORMAT_VERSION, QUALITY_SEVERITIES, QualityFindingV2, QualitySeverityV2, findingsFromHoursReport, findingsFromMbzIssues, findingsFromPackageWarnings, sortFindings } from './quality-finding';
import { COURSE_QUALITY_CHECKS_VERSION, QualityCheckInput, QualityCourseChapter, runCourseQualityChecks } from './course-quality-checks';
import { QualityObservationMeta, isObservationFinding } from './package-observation';

export const COURSE_QUALITY_REPORT_VERSION = 1 as const;
/** Tope de hallazgos en el resumen persistido (job / metadata); el informe completo cuenta todos. */
export const COURSE_QUALITY_SUMMARY_MAX_FINDINGS = 60;

export const QUALITY_DELIVERY_RULE = Object.freeze({
  blocker: 'blocks_delivery',
  major: 'requires_human_resolution_or_recorded_acceptance (not auto-blocking)',
  minor: 'visible_no_action_required',
  info: 'reviewer_information',
});

export interface CourseQualityReport {
  reportVersion: typeof COURSE_QUALITY_REPORT_VERSION;
  formatVersion: typeof QUALITY_FINDING_FORMAT_VERSION;
  checksVersion: string;
  counts: Record<QualitySeverityV2, number>;
  blocksDelivery: boolean;
  requiresHumanResolution: boolean;
  needsHumanReview: number;
  /** Códigos de reglas que no se pudieron medir (measured:false). Nunca cuentan como aprobadas. */
  notMeasured: string[];
  deliveryRule: typeof QUALITY_DELIVERY_RULE;
  findings: QualityFindingV2[];
  /** Hallazgos omitidos del resumen por el tope (solo en el resumen persistido). */
  truncated?: number;
  /**
   * r63 (V1): hallazgos proyectados en MODO OBSERVACIÓN (batería Q1–Q9, alineación, C1–C7). Van al final de `findings`
   * (marcados con `observation`) y se cuentan SOLO acá: los contadores, `blocksDelivery`, `requiresHumanResolution`,
   * `needsHumanReview` y `notMeasured` de arriba no los incluyen. Ausente = informe de antes de r63 (nunca se recalcula).
   */
  observation?: QualityObservationMeta & { counts: Record<QualitySeverityV2, number>; notMeasured: string[] };
}

export function assembleCourseQualityReport(findings: QualityFindingV2[], observationMeta?: QualityObservationMeta | null): CourseQualityReport {
  // r63 (V1): los de observación se ordenan y cuentan aparte, DESPUÉS de los de siempre (el tope del resumen prioriza
  // los de siempre, con sus BLOCKER/MAJOR primero; los de observación nunca son BLOCKER ni MAJOR).
  const sorted = dedupe(sortFindings(findings.filter((f) => !isObservationFinding(f))));
  const observed = observationMeta ? dedupe(sortFindings(findings.filter(isObservationFinding))) : [];
  const countOf = (xs: QualityFindingV2[]) => {
    const c = Object.fromEntries(QUALITY_SEVERITIES.map((s) => [s, 0])) as Record<QualitySeverityV2, number>;
    for (const f of xs) c[f.severity]++;
    return c;
  };
  const notMeasuredOf = (xs: QualityFindingV2[]) => [...new Set(xs.filter((f) => f.measured === false).map((f) => f.code))].sort();
  const counts = countOf(sorted);
  return {
    reportVersion: COURSE_QUALITY_REPORT_VERSION,
    formatVersion: QUALITY_FINDING_FORMAT_VERSION,
    checksVersion: COURSE_QUALITY_CHECKS_VERSION,
    counts,
    blocksDelivery: counts.BLOCKER > 0,
    requiresHumanResolution: counts.MAJOR > 0,
    needsHumanReview: sorted.filter((f) => f.kind === 'needs_human_review').length,
    notMeasured: notMeasuredOf(sorted),
    deliveryRule: QUALITY_DELIVERY_RULE,
    findings: [...sorted, ...observed],
    ...(observationMeta ? { observation: { ...observationMeta, counts: countOf(observed), notMeasured: notMeasuredOf(observed) } } : {}),
  };
}

function dedupe(xs: QualityFindingV2[]): QualityFindingV2[] {
  const seen = new Set<string>();
  return xs.filter((f) => {
    const k = JSON.stringify([f.code, f.location, f.evidence]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Resumen persistible: contadores completos + los primeros hallazgos (los BLOCKER/MAJOR primero, por el orden). */
export function courseQualityReportSummary(r: CourseQualityReport, max = COURSE_QUALITY_SUMMARY_MAX_FINDINGS): CourseQualityReport {
  if (r.findings.length <= max) return r;
  return { ...r, findings: r.findings.slice(0, max), truncated: r.findings.length - max };
}

// ─── Entrada desde el empaque v3 ───────────────────────────────────────────

export interface PackageQualityInput {
  manifest: { modules: ReadonlyArray<{ moduleId: string; chapters: ReadonlyArray<{ chapterId: string; chapterNumber: number; kind?: 'practice'; applicationMinutes?: number; guidedPracticeMinutes?: number }> }>; items: ReadonlyArray<{ key: string; type: string; chapterId: string | null; moduleId: string | null; h5pType?: string; variant?: string }> };
  blueprint: { course?: { academicContext?: { outcomes?: ReadonlyArray<{ id: string; text: string; level: string | null; domain: 'know' | 'do' }> } | null } | null; modules: ReadonlyArray<{ id: string; chapters: ReadonlyArray<{ id: string; title: string; objective: string | null; outcomeIds?: string[]; design?: { learningType?: { type: string; level: string | null } } }> }> };
  contents: {
    contentMd: ReadonlyMap<string, string>;
    experiences: ReadonlyMap<string, unknown>;
    videoInteractions: ReadonlyMap<string, unknown>;
    applications?: ReadonlyMap<string, unknown> | null;
    guidedPractices?: ReadonlyMap<string, unknown> | null;
    examBanks?: ReadonlyMap<string, { scope: 'module' | 'final'; moduleId: string | null; questions: ReadonlyArray<any> }> | null;
    finalExamBank?: { scope: 'module' | 'final'; moduleId: string | null; questions: ReadonlyArray<any> } | null;
    examGift?: ReadonlyMap<string, string> | null;
    finalExamGift?: string | null;
  };
  /** summary.warnings + summary.qualityWarnings del builder (strings `code:detalle`). */
  packageWarnings?: ReadonlyArray<string> | null;
  /** summary.practiceResources (resueltos). */
  practiceResources?: ReadonlyArray<{ id: string; chapterId: string; filename: string; relation: string; title?: string }> | null;
  /** Títulos de los archivos de trabajo (del perfil) por id; el resumen del builder no los trae. */
  practiceTitles?: ReadonlyMap<string, string> | null;
  /** facts.hoursReport (con líneas) o su resumen. */
  hoursReport?: { reportVersion?: number; findings?: ReadonlyArray<{ code: string; severity: string; detail: string }>; lines?: ReadonlyArray<{ resource: string; chapterId: string | null; minutes: number; basis: string }> } | null;
  /** Hallazgos de validateMbzV3 (solo si se proyectan; en el worker un hallazgo ya falla el job). */
  mbzIssues?: ReadonlyArray<{ code: string; where: string; message: string }> | null;
  builderVersion?: string;
  /** Hallazgos ya proyectados de otros productores (batería, diseño, alineación, rechazos). */
  extraFindings?: QualityFindingV2[] | null;
  /**
   * r63 (V1): metadata del modo observación (`buildPackageObservationFindings().meta`). Con ella, los `extraFindings`
   * marcados con `observation` se cuentan aparte (ver `CourseQualityReport.observation`); sin ella, se ignoran.
   */
  observationMeta?: QualityObservationMeta | null;
}

export function qualityCheckInputFromPackage(p: PackageQualityInput): QualityCheckInput {
  const bpChapters = new Map<string, { title: string; objective: string | null; outcomeIds?: string[]; design?: { learningType?: { type: string; level: string | null } } }>();
  for (const m of p.blueprint.modules ?? []) for (const c of m.chapters ?? []) bpChapters.set(c.id, c);
  const activityType = new Map<string, string>();
  for (const it of p.manifest.items) if (it.type === 'activity' && it.chapterId && typeof it.h5pType === 'string') activityType.set(it.chapterId, it.h5pType);
  const flat = p.manifest.modules.flatMap((m) => m.chapters.map((c) => ({ m, c })));
  const chapters: QualityCourseChapter[] = flat.map(({ m, c }, i) => {
    const bp = bpChapters.get(c.chapterId);
    const lt = bp?.design?.learningType;
    return {
      chapterId: c.chapterId, moduleId: m.moduleId, number: c.chapterNumber, title: bp?.title ?? c.chapterId, objective: bp?.objective ?? null,
      ...(c.kind ? { kind: c.kind } : {}), ...(bp?.outcomeIds ? { outcomeIds: bp.outcomeIds } : {}),
      learningType: lt && typeof lt.type === 'string' ? { type: lt.type, level: lt.level ?? null } : null,
      ...(typeof c.applicationMinutes === 'number' ? { applicationMinutes: c.applicationMinutes } : {}),
      ...(typeof c.guidedPracticeMinutes === 'number' ? { guidedPracticeMinutes: c.guidedPracticeMinutes } : {}),
      activityType: activityType.get(c.chapterId) ?? null,
      hasNextChapter: i < flat.length - 1,
    };
  });
  const banks: Array<QualityCheckInput['examBanks'][number]> = [];
  for (const [moduleId, b] of p.contents.examBanks ?? new Map()) banks.push({ itemKey: `exam:${moduleId}`, scope: 'module', moduleId, questions: Array.isArray(b?.questions) ? b.questions : [] });
  if (p.contents.finalExamBank) banks.push({ itemKey: 'final_exam', scope: 'final', moduleId: null, questions: Array.isArray(p.contents.finalExamBank.questions) ? p.contents.finalExamBank.questions : [] });
  const giftExamKeys = [...(p.contents.examGift ?? new Map()).keys()].map((m) => `exam:${m}`).concat(p.contents.finalExamGift ? ['final_exam'] : []);
  return {
    chapters,
    outcomes: [...(p.blueprint.course?.academicContext?.outcomes ?? [])],
    contentMd: p.contents.contentMd,
    experiences: p.contents.experiences,
    videoInteractions: p.contents.videoInteractions,
    applications: p.contents.applications ?? new Map(),
    guidedPractices: p.contents.guidedPractices ?? new Map(),
    examBanks: banks,
    giftExamKeys,
    practiceResources: (p.practiceResources ?? []).map((r) => ({ id: r.id, chapterId: r.chapterId, filename: r.filename, relation: r.relation, title: r.title ?? p.practiceTitles?.get(r.id) ?? r.filename })),
    hourLines: p.hoursReport?.lines ?? null,
  };
}

/** Informe completo del paquete (puro). */
export function buildPackageQualityReport(p: PackageQualityInput): CourseQualityReport {
  const findings: QualityFindingV2[] = [
    ...findingsFromMbzIssues(p.mbzIssues),
    ...findingsFromPackageWarnings(p.packageWarnings, p.builderVersion ?? 'builder-v3'),
    ...findingsFromHoursReport(p.hoursReport ?? null),
    ...runCourseQualityChecks(qualityCheckInputFromPackage(p)),
    ...(p.extraFindings ?? []),
  ];
  return assembleCourseQualityReport(findings, p.observationMeta ?? null);
}
