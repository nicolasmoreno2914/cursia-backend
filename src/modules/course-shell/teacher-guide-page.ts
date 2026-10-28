// T6 (r57) · «Guía del docente» del curso — página Moodle (mod_page) OCULTA, solo para docentes (sección 0).
//
// Determinística y sin IA: se arma con lo que el paquete ya tiene validado —
//   - facts (estructura, horas estimadas, actividades por capítulo, entrega de la AA, archivos de trabajo, evaluación),
//   - la evaluación resuelta del perfil (categorías y pesos, nota mínima, intentos),
//   - el Blueprint congelado (objetivos de módulo y capítulo; con plan de aprendizaje, tipo de aprendizaje y metodología
//     con sus fases),
//   - los documentos de las Actividades de Aplicación (criterios y pesos, producto; el solucionario se NOMBRA, nunca se
//     enlaza ni se copia: sigue siendo su propia página oculta).
// Moodle filtra el HTML (format_text): estilos inline (CLEAN_SAFE), sin <style>/<script>, texto protegido con nolink.
import { APPLICATION_KIND_LABEL } from '../study-time/application-kind-tiers';
import { applicationDocKind } from './application-pages';
import type { ResolvedTheme } from '../theme-engine';
import { contrastRatio } from '../theme-engine';
import { lintCleanSafe } from '../visual-components';
import { eduIcon, roleTone } from '../visual-components/edu';
import { inlineHtml, labelHtml } from '../visual-components/text';
import type { BlueprintSnapshotV2 } from '../course-blueprints/blueprint-snapshot';
import { defaultFrameworkRegistry } from '../pedagogy/instructional-frameworks';
import { LEARNING_TYPE_LABELS } from '../pedagogy/learning-type';
import type { ResolvedAssessment } from '../../package/assessment';
import type { CourseFacts } from './facts';
import { Hx, Surf, bgSurf, box, eyebrow, heading, hx, pHtml, root, shellFail, st, toneSurf, ul, unprotectedText } from './html';
import { applicationSolutionPageName, practiceResourceName } from './application-pages';
import { courseApprovalRequirements, courseApprovalTeacherNote, courseHasGrades } from './shell';

export const TEACHER_GUIDE_IDNUMBER = 'cv3:shell:teacher_guide';
export const TEACHER_GUIDE_PAGE_NAME = 'Guía del docente (solo docentes)';
/** Frase fija del aviso de visibilidad (el validador la exige). */
export const TEACHER_GUIDE_HIDDEN_NOTICE = 'Esta página está oculta para los estudiantes: es la guía de uso del curso para el equipo docente.';

const H5P_TYPE_LABEL: Record<string, string> = {
  questionset: 'cuestionario',
  dragtext: 'arrastrar las palabras',
  blanks: 'completar los espacios',
  singlechoiceset: 'selección única',
  branchingscenario: 'caso ramificado (decisiones)',
};
const CATEGORY_LABEL: Record<string, string> = { practice: 'Práctica de capítulos', applications: 'Actividades de Aplicación', moduleExams: 'Evaluaciones de módulo', finalExam: 'Evaluación final' };

export interface TeacherGuideInput {
  facts: CourseFacts;
  resolved: ResolvedAssessment;
  blueprint: BlueprintSnapshotV2;
  /** Documentos validados de las Actividades de Aplicación, por capítulo. */
  applications?: Map<string, any> | null;
}

export interface TeacherGuidePage {
  name: string;
  html: string;
}

function readable(color: string, s: Surf): string {
  try {
    return contrastRatio(color, s.bg) >= 4.5 ? color : s.fg;
  } catch {
    return s.fg;
  }
}
function section(h: Hx, icon: Parameters<typeof eduIcon>[1], color0: string, title: string, s: Surf): string {
  const color = readable(color0, s);
  return `<div${st(h, [['margin', '28px 0 0 0'], ['padding', 0], ['color', s.fg]])}>` +
    `<p${st(h, [['margin', '0 0 10px 0'], ['color', color], ['font-weight', '700'], ['font-size', h.t.typography.sizeBodyPx]])}>${eduIcon(h.enh, icon, color, 20)} ${labelHtml(title)}</p>`;
}
const end = '</div>';
function meta(h: Hx, text: string, color0: string, s: Surf): string {
  return `<p class="cvc-meta"${st(h, [['margin', '0 0 6px 0'], ['padding', 0], ['color', readable(color0, s)], ['font-size', h.t.typography.sizeSmallPx], ['font-weight', '700'], ['line-height', '1.4']])}>${labelHtml(text)}</p>`;
}
const kv = (k: string, vHtml: string): string => `<strong>${labelHtml(`${k}: `)}</strong>${vHtml}`;
const attemptsText = (n: number): string => (n === 0 ? 'intentos ilimitados' : n === 1 ? '1 intento' : `${n} intentos`);
const hoursText = (min: number): string => {
  const h = Math.round((min / 60) * 10) / 10;
  return `${String(h).replace('.', ',')} h`;
};

const HOUR_CATEGORY_LABEL: Record<string, string> = {
  estudio_contenido: 'Estudio del contenido (páginas y presentaciones)',
  video: 'Videos (con sus preguntas)',
  lectura: 'Lectura del Libro Guía',
  practica_guiada: 'Práctica guiada',
  practica_autonoma: 'Práctica autónoma (actividades y repaso)',
  entregable: 'Actividades de Aplicación (entregables)',
  evaluacion: 'Evaluaciones',
  retroalimentacion: 'Retroalimentación',
  foro_otros: 'Orientación, foro y otros',
};
const h1 = (min: number): string => `${String(Math.round((min / 60) * 10) / 10).replace('.', ',')} h`;

/** r58 (I3): de dónde salen las horas — por categoría, medido/estimado vs declarado, y la diferencia con el objetivo. */
function hoursBreakdown(h: Hx, r: NonNullable<CourseFacts['hoursReport']>, ink: string, s: Surf): string {
  const rows: string[] = [];
  for (const [k, label] of Object.entries(HOUR_CATEGORY_LABEL)) {
    const est = r.estimated.byCategory[k as keyof typeof r.estimated.byCategory] ?? 0;
    const asg = r.assigned.byCategory[k as keyof typeof r.assigned.byCategory] ?? 0;
    if (est + asg <= 0) continue;
    const parts = [est > 0 ? `${h1(est)} estimadas` : '', asg > 0 ? `${h1(asg)} declaradas por nivel` : ''].filter(Boolean);
    rows.push(kv(label, labelHtml(parts.join(' + '))));
  }
  const lines: string[] = [
    kv('Estimadas (medidas o con evidencia)', labelHtml(h1(r.estimated.minutes))),
    kv('Declaradas por nivel (sin medición)', labelHtml(h1(r.assigned.minutes))),
  ];
  if (r.target.hours !== null && r.gap) {
    lines.push(kv('Objetivo', labelHtml(`${String(r.target.hours).replace('.', ',')} h`)));
    lines.push(kv('Diferencia con el objetivo', labelHtml(r.gap.within ? 'dentro de la tolerancia' : r.gap.minutes > 0 ? `faltan ${h1(r.gap.minutes)} (no se rellenan)` : `${h1(-r.gap.minutes)} por encima`)));
  }
  lines.push(kv('Tiempo observado', labelHtml('sin datos (Cursia no mide la dedicación real)')));
  return section(h, 'reloj', ink, 'Carga horaria: de dónde salen las horas', s) + ul(h, rows, s) + ul(h, lines, s) +
    pHtml(h, labelHtml(`Modelo de tiempo: ${r.configId}.`), s, { secondary: true, last: true }) + end;
}

function frameworkOf(id: string | undefined | null): { label: string; summary: string; phases: Array<{ label: string; elements: string[] }> } | null {
  if (!id) return null;
  try {
    const f = defaultFrameworkRegistry().get(id);
    return { label: f.label, summary: f.summary, phases: [...f.phases].sort((a, b) => a.order - b.order).map((p) => ({ label: p.label, elements: [...p.elements] })) };
  } catch {
    shellFail(`Guía del docente: metodología desconocida «${id}»`);
  }
}

/** Página de la Guía del docente (falla fuerte si el HTML no pasa CLEAN_SAFE). */
export function teacherGuidePage(input: TeacherGuideInput, theme: ResolvedTheme): TeacherGuidePage {
  const { facts, resolved, blueprint } = input;
  if (!facts || !resolved || !blueprint || blueprint.schemaVersion !== 2) shellFail('Guía del docente: faltan facts, la evaluación resuelta o el Blueprint v2');
  const h = hx(theme);
  const s = bgSurf(h);
  const ink = h.t.color.accent;
  const warn = roleTone(h.t, 'error').ink;
  const bpModules = new Map(blueprint.modules.map((m) => [m.id, m]));
  const bpChapters = new Map(blueprint.modules.flatMap((m) => m.chapters.map((c) => [c.id, c] as const)));
  const lp = blueprint.course.pedagogy?.learningPlan;
  const courseFramework = frameworkOf(lp?.framework);

  // ── encabezado ──
  let body =
    meta(h, 'Solo docentes · Guía del docente', warn, s) +
    heading(h, 'h2', `Guía del docente: ${facts.course.title}`, s) +
    pHtml(h, labelHtml(TEACHER_GUIDE_HIDDEN_NOTICE), s, { secondary: true });

  // ── resumen ──
  const c = facts.counts;
  const estMin = facts.chapters.reduce((a, ch) => a + (ch.estimatedMinutes ?? 0), 0);
  const summary: string[] = [
    kv('Estructura', labelHtml(`${c.modules} ${c.modules === 1 ? 'módulo' : 'módulos'} y ${c.chapters} ${c.chapters === 1 ? 'capítulo' : 'capítulos'}`)),
  ];
  if (facts.hours) summary.push(kv('Carga horaria declarada', labelHtml(`${String(facts.hours.value).replace('.', ',')} h`)));
  if (facts.studyTime) summary.push(kv('Tiempo de estudio estimado', labelHtml(`${String(facts.studyTime.courseEstimatedHours).replace('.', ',')} h`)));
  else if (estMin > 0) summary.push(kv('Tiempo de estudio estimado', labelHtml(hoursText(estMin))));
  const parts: string[] = [];
  if (c.videos) parts.push(`${c.videos} ${c.videos === 1 ? 'video interactivo' : 'videos interactivos'}`);
  if (c.activities) parts.push(`${c.activities} ${c.activities === 1 ? 'actividad práctica' : 'actividades prácticas'}`);
  if (c.applicationActivities) parts.push(`${c.applicationActivities} ${c.applicationActivities === 1 ? 'Actividad de Aplicación' : 'Actividades de Aplicación'}`);
  if (c.guidedPractices) parts.push(`${c.guidedPractices} ${c.guidedPractices === 1 ? 'práctica guiada' : 'prácticas guiadas'}`);
  if (c.practiceResources) parts.push(`${c.practiceResources} ${c.practiceResources === 1 ? 'archivo de trabajo' : 'archivos de trabajo'}`);
  if (c.evaluations) parts.push(`${c.evaluations} ${c.evaluations === 1 ? 'evaluación' : 'evaluaciones'}`);
  if (parts.length) summary.push(kv('Contenido', labelHtml(parts.join(' · '))));
  body += section(h, 'objetivo', ink, 'Resumen del curso', s) + ul(h, summary, s) + end;

  // ── r58 (I3): desglose de horas (solo si la configuración del modelo de tiempo lo pide) ──
  if (facts.hoursBreakdownInTeacherGuide && facts.hoursReport) body += hoursBreakdown(h, facts.hoursReport, ink, s);

  // ── metodología ──
  if (courseFramework) {
    body += section(h, 'reflexion', ink, `Metodología: ${courseFramework.label}`, s) +
      pHtml(h, labelHtml(courseFramework.summary), s) +
      ul(h, courseFramework.phases.map((p) => kv(p.label, labelHtml(p.elements.join('; ') || '—'))), s, { ordered: true }) +
      pHtml(h, labelHtml(lp?.phaseLabels ? 'Los estudiantes ven el nombre de cada fase en los bloques del capítulo.' : 'Las fases organizan el diseño; los estudiantes no ven sus nombres.'), s, { secondary: true, last: true }) + end;
  }

  // ── evaluación ──
  const ev: string[] = [];
  if (courseHasGrades(facts)) {
    ev.push(kv('Aprobación', labelHtml(`calificación final del curso ≥ ${resolved.courseGradepass}/100`)));
    for (const cat of resolved.categories) ev.push(kv(CATEGORY_LABEL[cat.key] ?? cat.fullname, labelHtml(`${cat.weight} % de la nota final`)));
    const k = facts.assessment.kinds;
    if (c.exams) ev.push(kv('Cada evaluación de módulo', labelHtml(`nota de referencia ${k.exam.passingGrade}/100 · ${attemptsText(k.exam.attempts)}`)));
    if (c.finalExam) ev.push(kv('La evaluación final', labelHtml(`nota de referencia ${k.finalExam.passingGrade}/100 · ${attemptsText(k.finalExam.attempts)}${facts.finalExam.questionCount ? ` · ${facts.finalExam.questionCount} preguntas` : ''}`)));
    if (c.activities || c.videos) ev.push(kv('Cada práctica de capítulo', labelHtml(`nota de referencia ${k.activity.passingGrade}/100 · ${attemptsText(k.activity.attempts)}`)));
    const app = facts.assessment.application;
    if (app && (c.applicationAssigns ?? 0) > 0) {
      ev.push(kv('Actividades de Aplicación (Tarea)', labelHtml(app.graded
        ? `calificadas sobre ${app.maxGrade} (referencia ${app.gradepass})${app.rubric ? ' con rúbrica' : ''}, en «${CATEGORY_LABEL[app.category ?? 'practice'] ?? app.category}»`
        : 'formativas: sin nota, con retroalimentación')));
    }
  } else {
    ev.push(labelHtml('El curso no tiene ítems calificables: se completa por la lectura del Libro Guía.'));
  }
  body += section(h, 'check', ink, 'Evaluación y aprobación', s) + ul(h, ev, s);
  if (courseHasGrades(facts)) body += pHtml(h, labelHtml(courseApprovalTeacherNote(courseApprovalRequirements(facts))), s, { secondary: true, last: true });
  body += end;

  // ── por módulo y capítulo ──
  for (const m of facts.modules) {
    const bm = bpModules.get(m.id);
    body += section(h, 'libro', ink, `Módulo ${m.number}: ${m.title}`, s);
    if (bm?.objective) body += pHtml(h, kv('Objetivo del módulo', inlineHtml(bm.objective)), s);
    const modFw = bm?.design?.framework && bm.design.framework !== lp?.framework ? frameworkOf(bm.design.framework) : null;
    if (modFw) body += pHtml(h, kv('Metodología del módulo', labelHtml(modFw.label)), s, { secondary: true });
    for (const ch of facts.chapters.filter((x) => x.moduleId === m.id)) {
      const bc = bpChapters.get(ch.id);
      const cs = toneSurf(h, 'alt');
      const lines: string[] = [];
      if (bc?.objective) lines.push(kv('Objetivo', inlineHtml(bc.objective)));
      const lt = bc?.design?.learningType;
      if (lt && LEARNING_TYPE_LABELS[lt.type]) lines.push(kv('Tipo de aprendizaje', labelHtml(`${LEARNING_TYPE_LABELS[lt.type]}${lt.source === 'override' ? ' (elegido por el equipo)' : ''}`)));
      const chFw = bc?.design?.framework && bc.design.framework !== (bm?.design?.framework ?? lp?.framework) ? frameworkOf(bc.design.framework) : null;
      if (chFw) lines.push(kv('Metodología', labelHtml(chFw.label)));
      if (ch.estimatedMinutes) lines.push(kv('Tiempo estimado', labelHtml(`~${ch.estimatedMinutes} min`)));
      const acts: string[] = [];
      if (ch.kind !== 'practice' && ch.slideCount > 0) acts.push(`presentación (${ch.slideCount} diapositivas)`);
      if (ch.videoEnabled) acts.push('video interactivo con preguntas');
      if (ch.activityEnabled) acts.push(ch.activityVariant === 'scorm' ? 'actividad práctica (SCORM)' : `actividad práctica: ${H5P_TYPE_LABEL[ch.activityType ?? ''] ?? 'H5P'}`);
      if (ch.reviewCards) acts.push('«Repaso» con tarjetas (sin nota)');
      if (ch.guidedPracticeMinutes !== undefined) acts.push(`práctica guiada (~${ch.guidedPracticeMinutes} min, con respuestas modelo)`);
      if (acts.length) lines.push(kv('Recursos del capítulo', labelHtml(acts.join(' · '))));
      let inner = eyebrow(h, `Capítulo ${ch.number}: ${ch.title}${ch.kind === 'practice' ? ' (capítulo de práctica)' : ''}`, cs.s, { sentence: true, color: readable(ink, cs.s) }) + ul(h, lines, cs.s);
      if (ch.applicationMinutes !== undefined) {
        const doc = input.applications?.get(ch.id);
        const a = doc?.activity;
        if (!a || !Array.isArray(a.criteria)) shellFail(`Guía del docente: el capítulo ${ch.number} tiene Actividad de Aplicación sin documento`);
        const deliv = ch.applicationDelivery?.mode === 'assign'
          ? (ch.applicationDelivery.graded ? 'Tarea de Moodle calificada' : 'Tarea de Moodle formativa (sin nota)')
          : 'página del curso (sin entrega en Moodle)';
        // r79.1: los tipos nuevos se nombran por su tipo (estudio de caso / proyecto integrador / retroalimentación formativa).
        const kind = applicationDocKind(doc);
        const SOL_WHAT: Record<string, string> = {
          case_study: 'análisis esperado de cada pregunta, discusión de la decisión, preguntas para la clase y guía de corrección por criterio',
          integrative_project: 'guía de cada etapa (producto esperado, errores frecuentes, preguntas de control), ejemplo de producto final y guía de corrección por criterio',
          formative_feedback: 'banco de retroalimentación por criterio de revisión, diagnóstico de errores y guía de corrección por criterio',
        };
        inner += pHtml(h, kv(kind ? APPLICATION_KIND_LABEL[kind] : 'Actividad de Aplicación', `${inlineHtml(a.title)}${labelHtml(` · ~${ch.applicationMinutes} min · ${deliv}`)}`), cs.s);
        inner += pHtml(h, kv('Producto o evidencia', inlineHtml(a.deliverable?.description ?? '')), cs.s, { secondary: true });
        inner += ul(h, a.criteria.map((cr: any) => `<strong>${inlineHtml(cr.name)}</strong>${labelHtml(` (${cr.weight} %) — `)}${inlineHtml(cr.description)}`), cs.s);
        inner += pHtml(h, kv('Solucionario', labelHtml(`página oculta «${applicationSolutionPageName(ch.number, kind)}» en la sección de este capítulo (${kind ? SOL_WHAT[kind] : 'respuestas, solución del taller y guía de corrección por criterio'}).`)), cs.s, { secondary: true });
      }
      if (ch.resources && ch.resources.length) {
        inner += pHtml(h, `<strong>${labelHtml(ch.resources.length === 1 ? 'Archivo de trabajo:' : 'Archivos de trabajo:')}</strong>`, cs.s);
        inner += ul(h, ch.resources.map((r) => labelHtml(`${practiceResourceName(r, ch.number)} (${r.filename})`)), cs.s);
      }
      body += box(h, inner, cs);
    }
    if (m.examEnabled) {
      body += pHtml(h, kv('Evaluación del módulo', labelHtml(`${m.examQuestionCount ?? '—'} preguntas${m.examBankSize ? ` sorteadas de un banco de ${m.examBankSize}` : ''}, al final del módulo.`)), s);
    }
    body += end;
  }
  if (facts.finalExam.enabled) {
    body += section(h, 'logro', ink, 'Evaluación final', s) +
      pHtml(h, labelHtml(`${facts.finalExam.questionCount ?? '—'} preguntas${facts.finalExam.bankSize ? ` sorteadas de un banco de ${facts.finalExam.bankSize}` : ''}, en su propia sección antes del cierre del curso.`), s, { last: true }) + end;
  }

  const name = TEACHER_GUIDE_PAGE_NAME;
  const html = root(h, 'teacher-guide', body);
  if (/<(style|script|details)\b/i.test(html)) shellFail(`${name}: la página lleva <style>/<script>/<details>`);
  const lint = lintCleanSafe(html);
  if (!lint.ok) shellFail(`${name}: no pasa CLEAN_SAFE: ${lint.errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join('; ')}`);
  const unprotected = unprotectedText(html);
  if (unprotected.length > 0) shellFail(`${name}: texto sin protección nolink: ${JSON.stringify(unprotected.slice(0, 3))}`);
  return { name, html };
}
