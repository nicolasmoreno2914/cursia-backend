/**
 * r58 (I2) · Formato COMÚN de hallazgo de calidad (E4) y tabla de severidades.
 *
 * Los productores existentes no cambian (cada uno conserva su forma: `{code, where, message}` del validador del .mbz,
 * strings `code:detalle` de los avisos del empaque, critical/warning/info de la batería Q1–Q9, ok/info/warning/critical
 * de la verificación del diseño, critical/warning/suggestion de la alineación, MAJOR/MINOR/INFO del registro de horas).
 * Este módulo es la capa de ADAPTADORES: los proyecta a un solo formato con una severidad única y una regla de entrega:
 *
 *   BLOCKER  — el curso NO se entrega (blocksDelivery = true). Hoy: todo lo que ya bloquea por sí solo (validateMbzV3,
 *              invariantes del builder, rechazo final de un item) + Q1/Q6-sin-evaluar/Q8-artifact-huérfano + A1 + crítico
 *              de la verificación del diseño.
 *   MAJOR    — requiere que una PERSONA lo resuelva o lo acepte con motivo registrado. NO bloquea automáticamente
 *              (decisión documentada: hasta que exista el flujo de aceptación, el aviso es visible en «Curso listo» para
 *              administradores y se registra en el job; nunca se marca como resuelto solo).
 *   MINOR    — defecto editorial / pedagógico menor; visible, no exige acción.
 *   INFO     — dato para el revisor (reparaciones automáticas ya hechas, prerrequisitos externos, NO MEDIDO…).
 *
 * `kind`: `deterministic` = la regla decide con certeza (conteo, presencia, igualdad); `needs_human_review` = la regla
 * solo señala un CANDIDATO (léxico, numérico, auto-declarado por la IA): una persona confirma. Ningún hallazgo de este
 * formato reescribe contenido ni "verifica hechos": solo señala.
 *
 * Puro, sin I/O, determinista (mismo input → mismo orden y mismo JSON).
 */

export const QUALITY_FINDING_FORMAT_VERSION = 1 as const;

export const QUALITY_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR', 'INFO'] as const;
export type QualitySeverityV2 = (typeof QUALITY_SEVERITIES)[number];
export type QualityFindingKind = 'deterministic' | 'needs_human_review';
export type QualityLayer = 'E1' | 'E2' | 'E3' | 'pkg' | 'hours';

export interface QualityLocation {
  itemKey?: string;
  moduleId?: string;
  chapterId?: string;
  /** Parte del curso: libro | experience | exam | final_exam | video_interactions | application | guided_practice | package | course… */
  section?: string;
  /** idnumber de la actividad Moodle (cv3:…) o `where` del validador. */
  activity?: string;
  /** Página / ruta dentro del documento (p. ej. `checkpoints[3]`, `questions[q12]`). */
  page?: string;
}

export interface QualityFindingV2 {
  code: string;
  severity: QualitySeverityV2;
  layer: QualityLayer;
  location: QualityLocation;
  /** Extracto corto (≤ 240 caracteres) o valores medidos. Nunca el documento entero. */
  evidence: string;
  rule: { id: string; version: string };
  /** Causa probable (texto corto). */
  cause: string;
  recommendation: string;
  blocksDelivery: boolean;
  kind: QualityFindingKind;
  /** false = la regla no pudo medirse (NOT MEASURED); nunca cuenta como aprobado. Ausente = medido. */
  measured?: false;
}

/**
 * Tabla de severidades (documentada en el informe I2I4). Clave = código del hallazgo ya proyectado. Lo que no está acá
 * cae en el default de su adaptador (nunca BLOCKER por defecto: un BLOCKER es siempre explícito).
 */
export const QUALITY_SEVERITY_MAP: Readonly<Record<string, QualitySeverityV2>> = Object.freeze({
  // Bloqueantes (ya bloquean hoy por su productor).
  MBZ_VALIDATION: 'BLOCKER',
  ITEM_REJECTED_FINAL: 'BLOCKER',
  EXAM_BANK_INVALID: 'BLOCKER',
  Q1_MISSING_ARTIFACT: 'BLOCKER',
  Q6_CHAPTER_NOT_ASSESSED: 'BLOCKER',
  Q8_ARTIFACT_WITHOUT_ITEM: 'BLOCKER',
  A1: 'BLOCKER',
  DESIGN_CRITICAL: 'BLOCKER',
  // Mayores: persona resuelve o acepta.
  // Review r1 (M-6): MAJOR aunque «puede ser legítimo» — un plazo/cantidad contradictorio entre capítulos y exámenes es
  // un error de contenido con consecuencia (la respuesta correcta del examen depende de cuál vale); la heurística no puede
  // decidir si son casos distintos → `needs_human_review`, nunca bloquea ni se corrige solo (docs/v21/quality-reports.md).
  NUMERIC_WINDOW_CONFLICT: 'MAJOR',
  ASSESSMENT_MEMORY_FOR_PRACTICAL: 'MAJOR',
  VIDEO_MC_LENGTH_BIAS: 'MAJOR',
  PRACTICE_FILE_REFERENCE_UNKNOWN: 'MAJOR',
  Q6_EVIDENCE_NOT_IN_CHAPTER: 'MAJOR',
  HOURS_TARGET_GAP: 'MAJOR',
  A3: 'MAJOR',
  A5: 'MAJOR',
  A6: 'MAJOR',
  // Menores.
  COUNT_CLAIM_MISMATCH: 'MINOR',
  DANGLING_BACK_REFERENCE: 'MINOR',
  PREMATURE_COURSE_CLOSURE: 'MINOR',
  ACTIVITY_LENGTH_DISPROPORTIONATE: 'MINOR',
  FORMULAIC_OPENING: 'MINOR',
  INTERNAL_VOCABULARY_KEPT: 'MINOR',
  PRACTICE_FILE_MENTION_WITHOUT_FILE: 'MINOR',
  LIBRO_CHARS_UNMAPPED: 'MINOR',
  APPLICATION_CHARS_UNMAPPED: 'MINOR',
  PRACTICE_RESOURCE_ORPHAN: 'MINOR',
  PRACTICE_RESOURCE_NO_APPLICATION: 'MINOR',
  Q2_DUPLICATE_PARAGRAPH: 'MINOR',
  Q3_KEY_TERM_ABSENT: 'MINOR',
  Q4_OUTCOME_NOT_REFLECTED: 'MINOR',
  Q7_ASSUMED_NOT_INTRODUCED: 'MINOR',
  Q9_GUIDED_DUPLICATE_ACROSS_CHAPTERS: 'MINOR',
  Q9_GUIDED_AT_FLOOR: 'MINOR',
  Q9_GUIDED_THIN_VOLUME: 'MINOR',
  HOURS_COMPONENT_MISMATCH: 'MINOR',
  A7: 'MINOR',
  DESIGN_WARNING: 'MINOR',
  // Informativos.
  INTERNAL_VOCABULARY_REPAIRED: 'INFO',
  BRIDGE_DUPLICATE_DROPPED: 'INFO',
  DEAD_LINK_UNWRAPPED: 'INFO',
  PRACTICE_FILE_NOT_REFERENCED: 'INFO',
  ALIGNMENT_NOT_MEASURED: 'INFO',
  Q5_COMPETENCY_NOT_IN_INTRO: 'INFO',
  Q7_EXTERNAL_PREREQUISITE: 'INFO',
  Q7_NOT_MEASURED: 'INFO',
  Q8_CHAPTER_WITHOUT_OUTCOME: 'INFO',
  Q9_GUIDED_MINUTES_VS_CONTENT: 'INFO',
  HOURS_UNMEASURED: 'INFO',
  HOURS_COMPONENT_MAPPING_UNDEFINED: 'INFO',
  HOURS_CREDITS_CONVERSION_UNDEFINED: 'INFO',
  A4: 'INFO',
  DESIGN_INFO: 'INFO',
  ITEM_REJECTED_RETRIED: 'INFO',
});

export const EVIDENCE_MAX = 240;

export function excerpt(s: unknown, max = EVIDENCE_MAX): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Hallazgo con la severidad de la tabla (o `fallback`) y blocksDelivery = (severity === BLOCKER). */
export function finding(
  f: Omit<QualityFindingV2, 'severity' | 'blocksDelivery' | 'evidence'> & { evidence: unknown; severity?: QualitySeverityV2 },
  fallback: QualitySeverityV2 = 'INFO',
): QualityFindingV2 {
  const severity = f.severity ?? QUALITY_SEVERITY_MAP[f.code] ?? fallback;
  const out: QualityFindingV2 = {
    code: f.code,
    severity,
    layer: f.layer,
    location: cleanLocation(f.location),
    evidence: excerpt(f.evidence),
    rule: { id: f.rule.id, version: String(f.rule.version) },
    cause: excerpt(f.cause, 300),
    recommendation: excerpt(f.recommendation, 300),
    blocksDelivery: severity === 'BLOCKER',
    kind: f.kind,
  };
  if (f.measured === false) out.measured = false;
  return out;
}

function cleanLocation(l: QualityLocation): QualityLocation {
  const out: QualityLocation = {};
  for (const k of ['itemKey', 'moduleId', 'chapterId', 'section', 'activity', 'page'] as const) {
    const v = l?.[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

const SEV_RANK: Record<QualitySeverityV2, number> = { BLOCKER: 0, MAJOR: 1, MINOR: 2, INFO: 3 };

/** Orden estable: severidad, código, ubicación, evidencia. */
export function sortFindings(xs: QualityFindingV2[]): QualityFindingV2[] {
  const key = (f: QualityFindingV2) => `${f.code}|${f.location.chapterId ?? ''}|${f.location.moduleId ?? ''}|${f.location.section ?? ''}|${f.location.activity ?? ''}|${f.location.page ?? ''}|${f.evidence}`;
  return [...xs].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// ─── Adaptadores de productores existentes ─────────────────────────────────

/** validateMbzV3 → BLOCKER (el empaque ya falla con cualquiera de estos). */
export function findingsFromMbzIssues(issues: ReadonlyArray<{ code: string; where: string; message: string }> | null | undefined, validatorVersion = 'mbz-validator-v3'): QualityFindingV2[] {
  return (issues ?? []).map((i) =>
    finding({
      code: 'MBZ_VALIDATION', layer: 'pkg', location: { activity: i.where, section: 'package' }, evidence: `${i.code}: ${i.message}`,
      rule: { id: i.code, version: validatorVersion }, cause: 'el paquete no cumple una regla estructural del validador del .mbz',
      recommendation: 'corregir la causa (el paquete no se sube con este hallazgo)', kind: 'deterministic',
    }),
  );
}

/**
 * Rechazos del validador de items (`{path, code, message}` del completeItem). `final` = el item quedó fallido tras sus
 * reintentos (BLOCKER: el curso no está completo); si no, el rechazo se reintentó (INFO de trazabilidad).
 */
export function findingsFromItemRejections(
  rejections: ReadonlyArray<{ itemKey: string; final: boolean; errors: ReadonlyArray<{ path?: string; code: string; message: string }> }> | null | undefined,
): QualityFindingV2[] {
  const out: QualityFindingV2[] = [];
  for (const r of rejections ?? []) {
    for (const e of r.errors) {
      out.push(finding({
        code: r.final ? 'ITEM_REJECTED_FINAL' : 'ITEM_REJECTED_RETRIED', layer: 'pkg', location: { itemKey: r.itemKey, page: e.path },
        evidence: `${e.code}: ${e.message}`, rule: { id: e.code, version: 'v3-validation' },
        cause: 'la salida de la IA no pasó el validador del item', recommendation: r.final ? 'regenerar el componente' : 'ninguna (se reintentó con la lista de errores)', kind: 'deterministic',
      }));
    }
  }
  return out;
}

/** validateExamBank (errores) → BLOCKER (el builder ya re-valida el banco y falla con EXAM_BANK_INVALID). */
export function findingsFromExamBankErrors(itemKey: string, errors: ReadonlyArray<{ path?: string; code: string; message: string }> | null | undefined): QualityFindingV2[] {
  return (errors ?? []).map((e) => finding({
    code: 'EXAM_BANK_INVALID', layer: 'E2', location: { itemKey, section: 'exam', page: e.path }, evidence: `${e.code}: ${e.message}`,
    rule: { id: e.code, version: 'exam-bank' }, cause: 'el banco de preguntas no cumple sus reglas', recommendation: 'regenerar el examen', kind: 'deterministic',
  }));
}

const PKG_WARNING_CODES: ReadonlyArray<[RegExp, string, QualityLayer, QualityFindingKind, string, string]> = [
  [/^internal_vocabulary_repaired$/, 'INTERNAL_VOCABULARY_REPAIRED', 'E3', 'deterministic', 'el texto generado usaba vocabulario interno de Cursia', 'ninguna (reparado al empaquetar); revisar el prompt si se repite'],
  [/^internal_vocabulary_short_label$/, 'INTERNAL_VOCABULARY_REPAIRED', 'E3', 'deterministic', 'etiqueta corta con vocabulario interno', 'ninguna (reparado al empaquetar)'],
  [/^internal_vocabulary_kept_length_limit$/, 'INTERNAL_VOCABULARY_KEPT', 'E3', 'deterministic', 'la reparación pasaba el límite de largo del campo y el término quedó', 'editar el texto a mano o regenerar el componente'],
  [/^formulaic_opening$/, 'FORMULAIC_OPENING', 'E3', 'deterministic', 'la misma apertura en muchos capítulos', 'variar las aperturas (regenerar experiencias)'],
  [/^video_mc_length_bias$/, 'VIDEO_MC_LENGTH_BIAS', 'E3', 'deterministic', 'en las preguntas de los videos la correcta es la más larga más de lo que da el azar', 'regenerar las interacciones de los videos que más empujan el sesgo o aceptar con motivo'],
  [/^dead_link_unwrapped$/, 'DEAD_LINK_UNWRAPPED', 'pkg', 'deterministic', 'enlaces sin destino en el texto', 'ninguna (desenvueltos al empaquetar)'],
  [/^libro_chars_unmapped$/, 'LIBRO_CHARS_UNMAPPED', 'pkg', 'deterministic', 'caracteres sin glifo en la fuente del PDF del Libro', 'revisar el PDF del Libro Guía'],
  [/^application_chars_unmapped$/, 'APPLICATION_CHARS_UNMAPPED', 'pkg', 'deterministic', 'caracteres sin glifo en el PDF de la actividad', 'revisar el PDF de la Actividad de Aplicación'],
  [/^practice_resource_orphan$/, 'PRACTICE_RESOURCE_ORPHAN', 'pkg', 'deterministic', 'archivo de trabajo de un capítulo que ya no está en el curso', 'quitarlo del perfil o moverlo a un capítulo vigente'],
  [/^practice_resource_no_application$/, 'PRACTICE_RESOURCE_NO_APPLICATION', 'pkg', 'deterministic', 'archivo de la Actividad de Aplicación en un capítulo sin actividad', 'revisar la relación del archivo en el perfil'],
];

/** Avisos del empaque (`summary.warnings` + `qualityWarnings`, strings `code:detalle`) → hallazgos. Los operativos sin mapeo se omiten. */
export function findingsFromPackageWarnings(warnings: ReadonlyArray<string> | null | undefined, builderVersion = 'builder-v3'): QualityFindingV2[] {
  const out: QualityFindingV2[] = [];
  for (const w of warnings ?? []) {
    const s = String(w);
    const [head, ...rest] = s.split(':');
    const m = PKG_WARNING_CODES.find(([re]) => re.test(head));
    if (!m) continue;
    const [, code, layer, kind, cause, recommendation] = m;
    const detail = rest.join(':');
    out.push(finding({
      code, layer, location: { section: 'package', ...(head === 'application_chars_unmapped' ? { itemKey: rest[0] } : {}) }, evidence: detail ? `${head}: ${detail.replace(/_/g, ' ')}` : head,
      rule: { id: head, version: builderVersion }, cause, recommendation, kind,
    }));
  }
  return out;
}

/** Batería Q1–Q9 → hallazgos (Q7 null = NOT MEASURED, nunca aprobado). */
export function findingsFromQualityBattery(report: { version: string; checks: ReadonlyArray<{ id: string; metric: number | null; findings: ReadonlyArray<{ code: string; severity: string; message: string; ref?: string }>; status?: string; measuredReason?: string }> } | null | undefined): QualityFindingV2[] {
  const out: QualityFindingV2[] = [];
  if (!report) return out;
  for (const c of report.checks) {
    for (const f of c.findings) {
      const humanish = /^Q(2|3|4|5|7|9)_/.test(f.code);
      out.push(finding({
        code: f.code, layer: c.id === 'Q6' || c.id === 'Q4' ? 'E2' : c.id === 'Q1' || c.id === 'Q8' ? 'E1' : 'E3',
        location: { ...(f.ref && !f.ref.includes('|') ? { chapterId: f.ref } : {}), section: 'course' }, evidence: f.message,
        rule: { id: c.id, version: report.version }, cause: 'medición léxica del curso terminado', recommendation: 'revisar el capítulo o el componente señalado',
        kind: humanish ? 'needs_human_review' : 'deterministic', ...(f.code === 'Q7_NOT_MEASURED' ? { measured: false as const } : {}),
      }, f.severity === 'critical' ? 'BLOCKER' : f.severity === 'warning' ? 'MINOR' : 'INFO'));
    }
  }
  return out;
}

/** Registro de horas (MAJOR/MINOR/INFO propios) → hallazgos. */
export function findingsFromHoursReport(r: { reportVersion?: number; configId?: string; findings?: ReadonlyArray<{ code: string; severity: string; detail: string }> } | null | undefined): QualityFindingV2[] {
  return (r?.findings ?? []).map((f) => finding({
    code: f.code, layer: 'hours', location: { section: 'course' }, evidence: f.detail, rule: { id: f.code, version: `hours-report-v${r?.reportVersion ?? 1}` },
    cause: f.code === 'HOURS_TARGET_GAP' ? 'las horas del curso no alcanzan (o superan) el objetivo; el gap nunca se rellena' : 'diferencia o dato no definido en el registro de horas',
    recommendation: f.code === 'HOURS_TARGET_GAP' ? 'ajustar la estructura o aceptar el gap con motivo' : 'revisar la configuración de horas',
    kind: f.code === 'HOURS_TARGET_GAP' ? 'needs_human_review' : 'deterministic',
  }, (QUALITY_SEVERITIES as readonly string[]).includes(f.severity) ? (f.severity as QualitySeverityV2) : 'INFO'));
}

/** Verificación del diseño (ok/info/warning/critical) → hallazgos (ok y los resúmenes no cuentan). */
export function findingsFromDesignVerification(checks: ReadonlyArray<{ id: string; area: string; severity: string; title: string; detail?: string; summary?: true }> | null | undefined): QualityFindingV2[] {
  const out: QualityFindingV2[] = [];
  for (const c of checks ?? []) {
    if (c.severity === 'ok' || c.summary) continue;
    const code = c.severity === 'critical' ? 'DESIGN_CRITICAL' : c.severity === 'warning' ? 'DESIGN_WARNING' : 'DESIGN_INFO';
    out.push(finding({
      code, layer: c.area === 'outcomes' || c.area === 'evaluations' ? 'E2' : 'E1', location: { section: c.area }, evidence: `${c.title}${c.detail ? ` — ${c.detail}` : ''}`,
      rule: { id: c.id, version: 'design-verification' }, cause: 'verificación del diseño antes de generar', recommendation: 'resolver en Revisión del diseño', kind: 'deterministic',
    }));
  }
  return out;
}

/** Alineación A1–A7 / P1–P3 (critical/warning/suggestion) → hallazgos; la severidad sale de la tabla por regla. */
export function findingsFromAlignment(findings: ReadonlyArray<{ id: string; rule: string; severity: string; chapterIds: string[]; moduleIds: string[]; message: string; suggestion: string }> | null | undefined): QualityFindingV2[] {
  return (findings ?? []).map((f) => {
    const rule = String(f.rule);
    return finding({
      code: rule in QUALITY_SEVERITY_MAP ? rule : `ALIGNMENT_${rule}`, layer: 'E2', location: { chapterId: f.chapterIds[0], moduleId: f.moduleIds[0], section: 'design' },
      evidence: f.message, rule: { id: f.rule, version: 'alignment-rules@1' }, cause: 'alineación de diseño (resultado ↔ práctica ↔ evaluación)', recommendation: f.suggestion,
      kind: 'needs_human_review',
    }, f.severity === 'critical' ? 'BLOCKER' : f.severity === 'warning' ? 'MAJOR' : 'MINOR');
  });
}
