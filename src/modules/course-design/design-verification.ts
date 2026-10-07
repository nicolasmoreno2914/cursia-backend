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
}

export interface DesignCheck {
  id: string;
  area: CheckArea;
  severity: CheckSeverity;
  title: string;
  detail?: string;
  fix?: CheckFix;
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
  findings?: { id: string; rule: string; severity: string; outcomeIds: string[]; chapterIds: string[]; message: string; suggestion: string }[];
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
  /** Capítulos existentes sin vínculos propios (la corrección automática de vínculos solo toca esos). */
  unlinkedChapters: number;
}

const h1 = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const AV_TEXT: Record<string, string> = { less: 'menos video', recommended: 'recomendado', more: 'más video' };

/** Corrección de un hallazgo de la alineación (por regla). */
function fixForRule(rule: string, unlinked: number): CheckFix | undefined {
  // La vinculación automática solo une resultados de aprendizaje con capítulos sin vínculos; las competencias (A1c) se
  // vinculan a mano (son transversales: el docente decide dónde se ponen en juego).
  if ((rule === 'A1' || rule === 'A4') && unlinked > 0) return { kind: 'auto', action: 'link_outcomes', label: 'Vincular resultados y capítulos' };
  if (rule === 'A1' || rule === 'A1c' || rule === 'A4') return { kind: 'editor', action: 'outcome_links', label: 'Vincular en el editor' };
  if (rule === 'A2') return { kind: 'editor', action: 'module_exams', label: 'Activar la evaluación del módulo' };
  if (rule === 'A3' || rule === 'A5') return { kind: 'adjust', action: 'emphasis', value: 'application', label: 'Más aplicación' };
  if (rule === 'A6') return { kind: 'adjust', action: 'applicationActivities', value: 'auto', label: 'Actividades donde el diseño las necesite' };
  if (rule === 'A7') return { kind: 'understood', action: 'outcomes', label: 'Redactar el resultado' };
  if (rule === 'P2') return { kind: 'understood', action: 'learner', label: 'Indicar lo que ya sabe el estudiante' };
  return undefined;
}

export function verifyDesign(input: VerificationInput): DesignVerification {
  const checks: DesignCheck[] = [];
  const add = (c: DesignCheck) => checks.push(c);
  const k = input.counts;

  // Consistencia: el diseño se puede congelar tal cual (la tarjeta = el Manifest).
  if (input.manifestErrors.length) {
    add({ id: 'consistency', area: 'consistency', severity: 'critical', title: 'El diseño no se puede preparar para generar', detail: input.manifestErrors.map((e) => e.code).join(', '), fix: { kind: 'editor', action: 'structure', label: 'Revisar la estructura' } });
  }

  // Horas de trabajo del estudiante.
  const hoursTitle = `Carga horaria: ${h1(input.estimatedHours)} de ${h1(input.targetHours)} h de trabajo del estudiante`;
  if (input.status === 'within_tolerance') add({ id: 'hours', area: 'hours', severity: 'ok', title: hoursTitle });
  else if (input.status === 'above_tolerance') add({ id: 'hours', area: 'hours', severity: 'warning', title: hoursTitle, detail: `Queda ${h1(input.estimatedHours - input.targetHours)} h por encima (tolerancia ±${h1(input.toleranceHours)} h).`, fix: { kind: 'adjust', action: 'targetHours', value: Math.ceil(input.estimatedHours), label: `Usar ${Math.ceil(input.estimatedHours)} h` } });
  else if (input.status === 'cannot_reach_target') add({ id: 'hours', area: 'hours', severity: 'warning', title: hoursTitle, detail: 'Con los contenidos actuales no se llega sin rellenar: hacen falta más módulos o capítulos.', fix: { kind: 'editor', action: 'add_modules', label: 'Agregar módulos en el editor' } });
  else add({ id: 'hours', area: 'hours', severity: 'critical', title: `Los contenidos ya suman ≈ ${h1(input.baseHours)} h, más que las ${h1(input.targetHours)} h pedidas`, detail: 'Cursia no recorta contenido por su cuenta.', fix: { kind: 'adjust', action: 'targetHours', value: Math.ceil(input.baseHours), label: `Diseñar para ${Math.ceil(input.baseHours)} h` } });

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
    const findings = al.findings || [];
    const worst: CheckSeverity = findings.some((f) => f.severity === 'critical') ? 'critical' : findings.some((f) => f.severity === 'warning') ? 'warning' : 'ok';
    add({ id: 'outcomes', area: 'outcomes', severity: worst,
      title: `${covered(ra)} de ${ra.length} resultados de aprendizaje con evidencia${co.length ? ` · ${covered(co)} de ${co.length} competencias` : ''}` });
    for (const f of al.findings || []) {
      const severity: CheckSeverity = f.severity === 'critical' ? 'critical' : f.severity === 'warning' ? 'warning' : 'info';
      add({ id: `alignment:${f.id}`, area: 'outcomes', severity, title: f.message, detail: f.suggestion, fix: fixForRule(f.rule, input.unlinkedChapters) });
    }
  }

  // Estructura.
  add({ id: 'structure', area: 'structure', severity: k.modules > 0 && k.chapters > 0 ? 'ok' : 'critical', title: `${plural(k.modules, 'módulo', 'módulos')} y ${plural(k.chapters, 'capítulo', 'capítulos')}` });
  // Actividades interactivas.
  const noActivity = k.chapters - k.activities;
  add({ id: 'activities', area: 'activities', severity: noActivity > 0 ? 'info' : 'ok', title: noActivity > 0 ? `${plural(noActivity, 'capítulo sin actividad interactiva', 'capítulos sin actividad interactiva')}` : 'Todos los capítulos tienen actividad interactiva' });
  // Práctica.
  if (k.practiceChapters === 0 && input.policyKind === 'application_first') {
    add({ id: 'practice', area: 'practice', severity: 'info', title: 'Sin capítulos de práctica', detail: 'El enfoque prioriza la aplicación: la práctica está en las Actividades de Aplicación de los capítulos.' });
  } else add({ id: 'practice', area: 'practice', severity: 'ok', title: k.practiceChapters ? plural(k.practiceChapters, 'capítulo de práctica', 'capítulos de práctica') : 'Sin capítulos de práctica (no hacen falta para estas horas)' });
  add({ id: 'application', area: 'activities', severity: 'ok', title: plural(k.applicationActivities, 'Actividad de Aplicación', 'Actividades de Aplicación') });
  // Audiovisual.
  add({ id: 'audiovisual', area: 'audiovisual', severity: 'ok', title: `${plural(k.videoChapters, 'capítulo con video', 'capítulos con video')}${input.audiovisual ? ` (${AV_TEXT[input.audiovisual]})` : ''}`,
    detail: input.pinnedChapters ? `${plural(input.pinnedChapters, 'capítulo fijado', 'capítulos fijados')} por ti: Cursia los respeta.` : undefined });
  // Evaluaciones.
  if (k.evaluations === 0) add({ id: 'evaluations', area: 'evaluations', severity: 'warning', title: 'El curso no tiene evaluaciones', detail: 'Sin evaluaciones no hay nota ni certificado de logro.', fix: { kind: 'editor', action: 'module_exams', label: 'Activar evaluaciones en el editor' } });
  else add({ id: 'evaluations', area: 'evaluations', severity: 'ok', title: plural(k.evaluations, 'evaluación', 'evaluaciones') });
  // Pedagogía.
  if (input.approach) add({ id: 'pedagogy', area: 'pedagogy', severity: 'ok', title: `Enfoque: ${input.approach.label}` });
  else add({ id: 'pedagogy', area: 'pedagogy', severity: 'warning', title: 'Sin enfoque pedagógico', detail: 'Cursia no encontró resultados para recomendar uno.', fix: { kind: 'adjust', action: 'approach', label: 'Elegir un enfoque' } });
  // Costo.
  if (input.cost) add({ id: 'cost', area: 'cost', severity: 'ok', title: `Costo estimado de generar ≈ USD ${input.cost.expected} (entre ${input.cost.min} y ${input.cost.max})` });
  else add({ id: 'cost', area: 'cost', severity: 'warning', title: 'No pudimos estimar el costo de generar este diseño', fix: { kind: 'editor', action: 'structure', label: 'Revisar la estructura' } });

  const counts: Record<CheckSeverity, number> = { ok: 0, info: 0, warning: 0, critical: 0 };
  for (const c of checks) counts[c.severity]++;
  return { verificationVersion: 1, checks, counts, blocking: counts.critical > 0 };
}
