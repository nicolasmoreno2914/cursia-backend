/**
 * LOOP 8.4 · Verificación del diseño (antes de generar). Puro: sin DB, sin red, sin proveedores.
 *
 * Reúne en UNA lista lo que hay que mirar antes de generar, sobre el MISMO diseño de «Cursia recomienda» (distribuidor +
 * Blueprint/Manifest materializados + alineación del Coherence Engine, que ya corren en el dry-run):
 *   horas objetivo vs. diseñadas · resultados ↔ estructura (alineación A1–A7 / P1–P3) · módulos y capítulos ·
 *   actividades · capítulos de práctica · audiovisual · evaluaciones · enfoque pedagógico · costo · consistencia.
 *
 * Cada problema trae cómo resolverlo:
 *   - auto: Cursia lo corrige sin tocar ninguna decisión del docente (p. ej. vincular resultados a capítulos SIN vínculos);
 *   - adjust: lleva a «Ajustar» con el control preciso; editor: al editor de estructura; understood: a «Lo que entendimos».
 * `blocking` = hay algo crítico: no se debe generar así (el paso 4 lo usa).
 *
 * Requisitos institucionales (plantillas, pesos mínimos de evaluación por institución): pendiente — Cuenta todavía no
 * guarda requisitos de la institución; cuando existan, entran como otra área aquí.
 */

export type CheckSeverity = 'ok' | 'info' | 'warning' | 'critical';
export type CheckArea = 'hours' | 'outcomes' | 'structure' | 'activities' | 'practice' | 'audiovisual' | 'evaluations' | 'pedagogy' | 'cost' | 'consistency';
export type FixKind = 'auto' | 'adjust' | 'editor' | 'understood';

export interface CheckFix {
  kind: FixKind;
  /** auto: acción del servidor (POST /design/fix); adjust: control de «Ajustar»; understood: bloque de «Lo que entendimos». */
  action: string;
  label: string;
  /** adjust: valor sugerido para el control (p. ej. horas que dan los contenidos). */
  value?: unknown;
  /** editor: dónde se resuelve (el editor abre ahí). */
  targets?: { chapterIds?: string[]; moduleIds?: string[] };
}

export interface DesignCheck {
  id: string;
  area: CheckArea;
  severity: CheckSeverity;
  title: string;
  detail?: string;
  fix?: CheckFix;
  /** Resumen de un área cuyos problemas ya se listan uno por uno: no suma en los contadores. */
  summary?: true;
}

export interface DesignVerification {
  verificationVersion: 1;
  checks: DesignCheck[];
  counts: Record<CheckSeverity, number>;
  blocking: boolean;
}

interface AlignmentLike {
  available: boolean;
  outcomes?: { id: string; status: string; domain?: string }[];
  findings?: { id: string; rule: string; severity: string; outcomeIds: string[]; chapterIds: string[]; moduleIds?: string[]; message: string; suggestion: string }[];
  coverage?: { outcomes: number; covered: number; partial: number; uncovered: number };
}

export interface VerificationInput {
  status: 'within_tolerance' | 'above_tolerance' | 'minimum_exceeds_target' | 'cannot_reach_target';
  targetHours: number;
  estimatedHours: number;
  toleranceHours: number;
  baseHours: number;
  counts: { modules: number; chapters: number; contentChapters: number; practiceChapters: number; videoChapters: number; activities: number; applicationActivities: number; evaluations: number };
  manifestErrors: { code: string; message?: string }[];
  alignment: AlignmentLike | null | undefined;
  approach: { id: string; label: string } | null;
  policyKind: 'application_first' | 'depth_first' | null;
  audiovisual: 'less' | 'recommended' | 'more' | null;
  pinnedChapters: number;
  cost: { min: string; expected: string; max: string } | null;
  /** Preferencias vigentes (una corrección «Ajustar» solo se ofrece si cambia algo). */
  preferences: { emphasis: string; applicationActivities: string };
  /**
   * Lo que la vinculación automática PUEDE hacer: capítulos de contenido existentes, sin vínculos, que el docente no
   * desvinculó a propósito, y para los que hay una sugerencia (review L84 C1/I1/I2).
   */
  autoLink: { chapterIds: string[]; outcomeIds: string[]; preview: { chapter: string; outcomes: string[] }[] };
  /** Ids (del Manifest) de los capítulos que propone el diseño y todavía no existen (review L84 I3). */
  proposedChapterIds: string[];
  /** Contenidos del microcurrículo que ningún capítulo trabaja (review L84 I5). */
  uncoveredContents: string[];
  /** Instrumentos de evaluación que pide el microcurrículo. */
  requiredEvaluations: string[];
  /** Instrumentos del microcurrículo cuyos resultados el diseño no evalúa con el mismo tipo de evidencia (review L84-2 N6). */
  uncoveredEvaluations: { instrument: string; outcomes: string[]; kind: 'performance' | 'exam'; chapterIds?: string[] }[];
}

/** Máximo de horas de un curso (la meta válida va de 1 a 500). */
const MAX_TARGET_HOURS = 500;

const h1 = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');
const usd = (s: string) => String(s).replace('.', ',');
const list = (xs: string[], max = 3) => xs.slice(0, max).map((x) => `«${x}»`).join(', ') + (xs.length > max ? ` y ${xs.length - max} más` : '');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const AV_TEXT: Record<string, string> = { less: 'menos video', recommended: 'recomendado', more: 'más video' };

type Finding = NonNullable<AlignmentLike['findings']>[number];

/** Corrección de un hallazgo de la alineación: solo se ofrece la que de verdad lo resuelve. */
function fixForFinding(f: Finding, input: VerificationInput): CheckFix | undefined {
  const al = input.autoLink;
  const editorAt = (label: string, action = 'outcome_links'): CheckFix => ({ kind: 'editor', action, label, targets: { chapterIds: f.chapterIds, moduleIds: f.moduleIds || [] } });
  // La vinculación automática une resultados de aprendizaje con capítulos de contenido sin vínculos; las competencias
  // (A1c) se vinculan a mano (son transversales: el docente decide dónde se ponen en juego).
  if (f.rule === 'A1') return f.outcomeIds.some((id) => al.outcomeIds.includes(id)) ? { kind: 'auto', action: 'link_outcomes', label: 'Vincular automáticamente' } : editorAt('Vincular en el editor');
  if (f.rule === 'A4') return f.chapterIds.some((id) => al.chapterIds.includes(id)) ? { kind: 'auto', action: 'link_outcomes', label: 'Vincular automáticamente' } : editorAt('Vincular en el editor');
  if (f.rule === 'A1c') return editorAt('Vincular en el editor');
  if (f.rule === 'A2') return editorAt('Activar la evaluación del módulo', 'module_exams');
  if (f.rule === 'A3' || f.rule === 'A5') {
    return input.preferences.emphasis !== 'application' ? { kind: 'adjust', action: 'emphasis', value: 'application', label: 'Más aplicación' } : editorAt('Agregar práctica en el editor', 'add_practice');
  }
  if (f.rule === 'A6') {
    return input.preferences.applicationActivities !== 'auto' ? { kind: 'adjust', action: 'applicationActivities', value: 'auto', label: 'Actividades donde el diseño las necesite' } : editorAt('Agregar práctica en el editor', 'add_practice');
  }
  if (f.rule === 'A7') return { kind: 'understood', action: 'outcomes', label: 'Redactar el resultado' };
  if (f.rule === 'P2') return { kind: 'understood', action: 'learner', label: 'Indicar lo que ya sabe el estudiante' };
  return undefined;
}

export function verifyDesign(input: VerificationInput): DesignVerification {
  const checks: DesignCheck[] = [];
  const add = (c: DesignCheck) => checks.push(c);
  const k = input.counts;

  // Consistencia: el diseño se puede congelar tal cual (la tarjeta = el Manifest).
  if (input.manifestErrors.length) {
    add({ id: 'consistency', area: 'consistency', severity: 'critical', title: 'El diseño no se puede preparar para generar', detail: 'Hay algo en la estructura que impide armar el plan de generación: revísala en el editor.', fix: { kind: 'editor', action: 'structure', label: 'Revisar la estructura' } });
  }

  // Horas de trabajo del estudiante.
  const hoursTitle = `Carga horaria: ${h1(input.estimatedHours)} de ${h1(input.targetHours)} h de trabajo del estudiante`;
  if (input.status === 'within_tolerance') add({ id: 'hours', area: 'hours', severity: 'ok', title: hoursTitle });
  else if (input.status === 'above_tolerance') {
    const up = Math.ceil(input.estimatedHours);
    add({ id: 'hours', area: 'hours', severity: 'warning', title: hoursTitle, detail: `Queda ${h1(input.estimatedHours - input.targetHours)} h por encima (tolerancia ±${h1(input.toleranceHours)} h).`,
      fix: up <= MAX_TARGET_HOURS ? { kind: 'adjust', action: 'targetHours', value: up, label: `Usar ${up} h` } : { kind: 'editor', action: 'structure', label: 'Quitar contenidos o dividir el curso' } });
  }
  else if (input.status === 'cannot_reach_target') add({ id: 'hours', area: 'hours', severity: 'warning', title: hoursTitle, detail: 'Con los contenidos actuales no se llega sin rellenar: hacen falta más módulos o capítulos.', fix: { kind: 'editor', action: 'add_modules', label: 'Agregar módulos en el editor' } });
  else {
    // Review L84 I4 + m: la tarjeta ya ofrece «Diseñar para N h»; aquí solo la salida que la tarjeta no tiene cuando N > 500.
    const need = Math.ceil(input.baseHours);
    add({ id: 'hours', area: 'hours', severity: 'critical', title: `Los contenidos ya suman ≈ ${h1(input.baseHours)} h, más que las ${h1(input.targetHours)} h pedidas`,
      detail: need <= MAX_TARGET_HOURS ? `Cursia no recorta contenido por su cuenta: usa «Diseñar para ${need} h» en la tarjeta o quita contenidos.` : `Cursia no recorta contenido por su cuenta, y un curso admite hasta ${MAX_TARGET_HOURS} h: quita contenidos o divide el curso.`,
      ...(need <= MAX_TARGET_HOURS ? {} : { fix: { kind: 'editor' as const, action: 'structure', label: 'Quitar contenidos o dividir el curso' } }) });
  }

  // Resultados ↔ estructura (Coherence Engine).
  const al = input.alignment;
  if (!al || !al.available) {
    add({ id: 'outcomes', area: 'outcomes', severity: 'warning', title: 'Sin resultados de aprendizaje para verificar la coherencia', detail: 'Cursia no puede comprobar que el diseño evidencie lo que el curso debe lograr.', fix: { kind: 'understood', action: 'outcomes', label: 'Agregar resultados de aprendizaje' } });
  } else {
    // Resultados de aprendizaje y competencias por separado; la severidad es la del peor hallazgo (el Coherence Engine
    // decide qué es crítico: p. ej. una competencia sin vincular es advertencia, un resultado sin capítulo es crítico).
    const outs = al.outcomes || [];
    const ra = outs.filter((o) => o.domain !== 'competency');
    const co = outs.filter((o) => o.domain === 'competency');
    const covered = (xs: typeof outs) => xs.filter((o) => o.status === 'covered').length;
    // Review L84 I3: un capítulo que el diseño PROPONE todavía no existe: no se le puede pedir vínculos (se vinculan al aplicarlo).
    const proposed = new Set(input.proposedChapterIds);
    const findings = (al.findings || []).filter((f) => !(f.rule === 'A4' && f.chapterIds.length && f.chapterIds.every((id) => proposed.has(id))));
    const worst: CheckSeverity = findings.some((f) => f.severity === 'critical') ? 'critical' : findings.some((f) => f.severity === 'warning') ? 'warning' : 'ok';
    add({ id: 'outcomes', area: 'outcomes', severity: worst,
      title: `${covered(ra)} de ${ra.length} resultados de aprendizaje con evidencia${co.length ? ` · ${covered(co)} de ${co.length} competencias` : ''}`, ...(findings.length ? { summary: true as const } : {}) });
    if (input.autoLink.preview.length) {
      // Review L84 I2: lo que Cursia vincula, a la vista (y se aplica solo al usar el diseño).
      add({ id: 'outcome_links', area: 'outcomes', severity: 'info', title: `Cursia vinculará ${plural(input.autoLink.preview.length, 'capítulo', 'capítulos')} con sus resultados al usar este diseño`,
        detail: input.autoLink.preview.slice(0, 4).map((p) => `«${p.chapter}» → ${p.outcomes.join(', ')}`).join(' · ') + (input.autoLink.preview.length > 4 ? ` y ${input.autoLink.preview.length - 4} más` : ''),
        fix: { kind: 'auto', action: 'link_outcomes', label: 'Vincular ahora' } });
    }
    for (const f of findings) {
      const severity: CheckSeverity = f.severity === 'critical' ? 'critical' : f.severity === 'warning' ? 'warning' : 'info';
      add({ id: `alignment:${f.id}`, area: 'outcomes', severity, title: f.message, detail: f.suggestion, fix: fixForFinding(f, input) });
    }
  }

  // Estructura: hay módulos y capítulos, y cubre los contenidos del microcurrículo (review L84 I5).
  if (!(k.modules > 0 && k.chapters > 0)) add({ id: 'structure', area: 'structure', severity: 'critical', title: 'El curso no tiene módulos con capítulos', fix: { kind: 'editor', action: 'structure', label: 'Armar la estructura' } });
  else add({ id: 'structure', area: 'structure', severity: 'ok', title: `${plural(k.modules, 'módulo', 'módulos')} y ${plural(k.chapters, 'capítulo', 'capítulos')}` });
  if (input.uncoveredContents.length) {
    add({ id: 'contents', area: 'structure', severity: 'warning', title: `${plural(input.uncoveredContents.length, 'contenido del microcurrículo no aparece', 'contenidos del microcurrículo no aparecen')} en ningún capítulo`,
      detail: list(input.uncoveredContents), fix: { kind: 'editor', action: 'add_chapter', label: 'Agregar en el editor' } });
  }
  // Actividades interactivas.
  const noActivity = k.chapters - k.activities;
  add({ id: 'activities', area: 'activities', severity: noActivity > 0 ? 'info' : 'ok', title: noActivity > 0 ? `${plural(noActivity, 'capítulo sin actividad interactiva', 'capítulos sin actividad interactiva')}` : 'Todos los capítulos tienen actividad interactiva' });
  // Práctica.
  if (k.practiceChapters === 0 && input.policyKind === 'application_first') {
    add({ id: 'practice', area: 'practice', severity: 'info', title: 'Sin capítulos de práctica', detail: 'El enfoque prioriza la aplicación: la práctica está en las Actividades de Aplicación de los capítulos.' });
  } else add({ id: 'practice', area: 'practice', severity: 'ok', title: k.practiceChapters ? plural(k.practiceChapters, 'capítulo de práctica', 'capítulos de práctica') : 'Sin capítulos de práctica (no hacen falta para estas horas)' });
  add({ id: 'application', area: 'activities', severity: 'ok', title: plural(k.applicationActivities, 'Actividad de Aplicación', 'Actividades de Aplicación') });
  // Audiovisual.
  // Sin ningún video siendo «recomendado» o «más» solo puede venir de capítulos fijados sin video: se informa.
  const noVideo = k.videoChapters === 0 && k.contentChapters > 0 && input.audiovisual !== 'less';
  add({ id: 'audiovisual', area: 'audiovisual', severity: noVideo ? 'info' : 'ok', title: `${plural(k.videoChapters, 'capítulo con video', 'capítulos con video')}${input.audiovisual ? ` (${AV_TEXT[input.audiovisual]})` : ''}`,
    detail: input.pinnedChapters ? `${plural(input.pinnedChapters, 'capítulo fijado', 'capítulos fijados')} por ti: Cursia los respeta.${noVideo ? ' Así, el curso queda sin video.' : ''}` : undefined });
  // Evaluaciones.
  if (k.evaluations === 0) {
    add({ id: 'evaluations', area: 'evaluations', severity: 'warning', title: 'El curso no tiene evaluaciones',
      detail: input.requiredEvaluations.length ? `El microcurrículo pide evaluar con ${list(input.requiredEvaluations)}.` : 'Sin evaluaciones no hay nota ni certificado de logro.',
      fix: { kind: 'editor', action: 'module_exams', label: 'Activar evaluaciones en el editor' } });
  }
  else add({ id: 'evaluations', area: 'evaluations', severity: 'ok', title: plural(k.evaluations, 'evaluación', 'evaluaciones') });
  // Lo que pide el microcurrículo (review L84-2 N6): mismo tipo de evidencia para los mismos resultados.
  const perf = input.uncoveredEvaluations.filter((e) => e.kind === 'performance');
  const exams = input.uncoveredEvaluations.filter((e) => e.kind === 'exam');
  const evText = (xs: typeof perf) => xs.slice(0, 3).map((e) => `«${e.instrument}»${e.outcomes.length ? ` (${e.outcomes.join(', ')})` : ''}`).join(', ') + (xs.length > 3 ? ` y ${xs.length - 3} más` : '');
  if (perf.length) {
    add({ id: 'evaluation_performance', area: 'evaluations', severity: 'warning', title: 'El microcurrículo evalúa con trabajos que el diseño no tiene',
      detail: `${evText(perf)}: ningún capítulo que trabaje ese resultado tiene Actividad de Aplicación.`,
      // Review L84-3 Mn5: lo que resuelve es una Actividad de Aplicación en un capítulo que trabaje ese resultado; vincular,
      // solo si ningún capítulo lo trabaja.
      fix: input.preferences.applicationActivities !== 'auto' ? { kind: 'adjust', action: 'applicationActivities', value: 'auto', label: 'Actividades donde el diseño las necesite' }
        : perf.some((e) => (e.chapterIds || []).length) ? { kind: 'editor', action: 'application', label: 'Agregar la Actividad de Aplicación', targets: { chapterIds: perf.flatMap((e) => e.chapterIds || []).slice(0, 1) } }
          : { kind: 'editor', action: 'outcome_links', label: 'Vincular el resultado en el editor' } });
  }
  if (exams.length && k.evaluations > 0) {
    add({ id: 'evaluation_exams', area: 'evaluations', severity: 'warning', title: 'El microcurrículo evalúa con pruebas que el diseño no tiene',
      detail: `${evText(exams)}: ninguna evaluación de módulo trabaja ese resultado y no hay evaluación final.`,
      fix: { kind: 'editor', action: 'module_exams', label: 'Activar evaluaciones en el editor' } });
  }
  // Pedagogía.
  if (input.approach) add({ id: 'pedagogy', area: 'pedagogy', severity: 'ok', title: `Enfoque: ${input.approach.label}` });
  else add({ id: 'pedagogy', area: 'pedagogy', severity: 'warning', title: 'Sin enfoque pedagógico', detail: 'Cursia no encontró resultados para recomendar uno.', fix: { kind: 'adjust', action: 'approach', label: 'Elegir un enfoque' } });
  // Costo.
  if (input.cost) add({ id: 'cost', area: 'cost', severity: 'ok', title: `Costo estimado de generar ≈ USD ${usd(input.cost.expected)} (entre ${usd(input.cost.min)} y ${usd(input.cost.max)})` });
  else add({ id: 'cost', area: 'cost', severity: 'warning', title: 'No pudimos estimar el costo de generar este diseño', fix: { kind: 'editor', action: 'structure', label: 'Revisar la estructura' } });

  const counts: Record<CheckSeverity, number> = { ok: 0, info: 0, warning: 0, critical: 0 };
  for (const c of checks) if (!c.summary) counts[c.severity]++;
  return { verificationVersion: 1, checks, counts, blocking: counts.critical > 0 };
}
