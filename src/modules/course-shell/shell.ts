/**
 * R11a — Course Shell (audit §E): labels del curso = plantilla determinística
 * + slots de texto LLM validados (sin cifras ni recursos). Todo número sale de
 * `facts` (§M.3). Cada función devuelve `{ name, html }` para un label Moodle.
 *
 * Reglas:
 *  - el shell solo nombra recursos PRESENTES (videos, actividades, exámenes);
 *    Gamma, Libro Guía y audiolibro son obligatorios en V2.1 (DECISIONES);
 *  - nada de "certificado", "PDF" del curso, "narración profesional", "minutos
 *    por pregunta" ni horas inventadas: las horas solo si vienen del setup,
 *    etiquetadas "(definida por la institución)";
 *  - CLEAN_SAFE siempre (se verifica con `lintCleanSafe` de R2 antes de
 *    devolver: un label que no pasa → throw SHELL_RENDER), ENHANCED opcional;
 *  - la bibliografía NO va en los labels (va al Libro Guía, R12).
 */
import type { ResolvedTheme } from '../theme-engine';
import { moduleColor } from '../theme-engine';
import { lintCleanSafe, renderComponent } from '../visual-components';
import { escapeHtml, inlineHtml } from '../visual-components/text';
import { formatDurationEs } from '../../package/audio';
import type { AssessableType } from '../course-profiles/course-profiles';
import type { CourseFacts, ModuleFacts } from './facts';
import {
  CourseIntroV3,
  ModuleIntroV3,
  assertValidCourseIntroV3,
  assertValidModuleIntroV3,
} from './intro-schemas';
import {
  Hx,
  ShellRenderOptions,
  audio,
  bgSurf,
  box,
  eyebrow,
  heading,
  hx,
  link,
  pHtml,
  paras,
  plural,
  root,
  shellFail,
  statRow,
  surfOn,
  toneSurf,
  ul,
} from './html';
import { GRADE_METHOD_ES, attemptsValue } from './microcopy';

export interface ShellLabel {
  name: string;
  html: string;
}

export const SHELL_AUDIO_WELCOME_FILE = 'audio_bienvenida.mp3';
export const SHELL_AUDIOBOOK_FILE = 'audiolibro.mp3';

function out(name: string, html: string): ShellLabel {
  const lint = lintCleanSafe(html);
  if (!lint.ok) {
    shellFail(`${name}: no pasa CLEAN_SAFE: ${lint.errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join('; ')}`);
  }
  return { name, html };
}

function lvl(h: Hx): 'enhanced' | undefined {
  return h.enh ? 'enhanced' : undefined;
}

// ─── S0.2 Bienvenida ────────────────────────────────────────────────────────

export function welcomeLabel(facts: CourseFacts, courseIntro: CourseIntroV3, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const intro = assertValidCourseIntroV3(courseIntro);
  const h = hx(theme, opts);
  const c = facts.counts;
  const stats: Array<{ value: number; label: string }> = [
    { value: c.modules, label: plural(c.modules, 'módulo', 'módulos') },
    { value: c.chapters, label: plural(c.chapters, 'capítulo', 'capítulos') },
  ];
  if (c.videos > 0) stats.push({ value: c.videos, label: plural(c.videos, 'video interactivo', 'videos interactivos') });
  if (c.activities > 0) stats.push({ value: c.activities, label: plural(c.activities, 'actividad práctica', 'actividades prácticas') });
  if (c.evaluations > 0) stats.push({ value: c.evaluations, label: plural(c.evaluations, 'evaluación', 'evaluaciones') });
  const hero = renderComponent(
    { type: 'hero', eyebrow: 'Bienvenida', title: facts.course.title, lead: intro.welcome },
    theme,
    { uid: 'shell-welcome-hero', level: lvl(h) },
  );
  const s = bgSurf(h);
  const hours = facts.hours
    ? pHtml(h, escapeHtml(`Duración estimada: ${facts.hours.value} h (${facts.hours.source}).`), s, { secondary: true, last: true })
    : '';
  return out('Bienvenida', root(h, 'shell-welcome', hero + statRow(h, stats) + hours));
}

// ─── S0.3 Audio de bienvenida ───────────────────────────────────────────────

export function audioWelcomeLabel(facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const inner =
    heading(h, 'h3', 'Audio de bienvenida', s) +
    pHtml(h, escapeHtml(`Escucha la presentación del curso. Duración: ${formatDurationEs(facts.audio.welcomeSeconds)}.`), s) +
    audio(h, `@@PLUGINFILE@@/${SHELL_AUDIO_WELCOME_FILE}`, 'el audio de bienvenida', s);
  return out('Audio de bienvenida', root(h, 'shell-audio-welcome', inner));
}

// ─── S0.4 Competencias ──────────────────────────────────────────────────────

export function competenciesLabel(courseIntro: CourseIntroV3, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const intro = assertValidCourseIntroV3(courseIntro);
  const h = hx(theme, opts);
  const comp = renderComponent(
    { type: 'learning_objectives', title: 'Qué aprenderás', items: intro.competencies },
    theme,
    { uid: 'shell-competencies-list', level: lvl(h) },
  );
  return out('Qué aprenderás', root(h, 'shell-competencies', comp));
}

// ─── S0.5 Metodología (plantilla determinística) ────────────────────────────

/** Pasos de la metodología: SOLO los tipos de recurso presentes en el curso. */
export function methodologySteps(facts: CourseFacts): Array<{ title: string; body: string }> {
  const c = facts.counts;
  const allVideo = c.videos === c.chapters;
  const allActivity = c.activities === c.chapters;
  const allExam = c.exams === c.modules;
  const steps: Array<{ title: string; body: string }> = [
    { title: 'Recorrido del capítulo', body: 'Cada capítulo te guía con explicaciones, ejemplos y momentos de reflexión.' },
    { title: 'Presentación del capítulo', body: 'Una visión general de las ideas principales, para ver o repasar cuando quieras.' },
  ];
  if (c.videos > 0) {
    steps.push({
      title: 'Video interactivo',
      body: `${allVideo ? 'En cada capítulo' : 'En los capítulos que lo incluyen'}, un video con preguntas durante la reproducción.`,
    });
  }
  if (c.activities > 0) {
    steps.push({
      title: 'Actividad práctica',
      body: `${allActivity ? 'En cada capítulo' : 'En los capítulos que la incluyen'}, una práctica calificada para aplicar lo aprendido.`,
    });
  }
  steps.push({ title: 'Libro Guía', body: 'El texto completo del curso, para leer y consultar en cualquier momento.' });
  steps.push({ title: 'Audiolibro', body: 'La versión narrada de los capítulos, para escuchar a tu ritmo.' });
  if (c.exams > 0) {
    steps.push({
      title: 'Evaluación del módulo',
      body: `${allExam ? 'Al cierre de cada módulo' : 'Al cierre de los módulos que la incluyen'}, una evaluación de lo aprendido.`,
    });
  }
  if (c.finalExam) steps.push({ title: 'Evaluación final', body: 'Al terminar el curso, una evaluación que integra todos los contenidos.' });
  return steps;
}

export function methodologyLabel(facts: CourseFacts, courseIntro: CourseIntroV3, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const intro = assertValidCourseIntroV3(courseIntro);
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const items = methodologySteps(facts).map((x) => `<strong>${escapeHtml(x.title)}.</strong> ${escapeHtml(x.body)}`);
  const inner = heading(h, 'h3', 'Cómo vas a aprender', s) + ul(h, items, s, { ordered: true }) + paras(h, intro.methodology_note, s, { last: true });
  return out('Metodología', root(h, 'shell-methodology', inner));
}

// ─── S1.1 Ruta de aprendizaje ───────────────────────────────────────────────

export function routeLabel(facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const h = hx(theme, opts);
  const s = bgSurf(h);
  let inner = heading(h, 'h3', 'Ruta de aprendizaje', s);
  facts.modules.forEach((m, mi) => {
    const mc = moduleColor(theme, mi);
    const ms = surfOn(theme, mc.soft, [mc.onSoft]);
    const items = m.chapterNumbers.map((n) => {
      const ch = facts.chapters.find((x) => x.number === n);
      if (!ch) shellFail(`capítulo ${n} ausente en facts`);
      const marks: string[] = [];
      if (ch.videoEnabled) marks.push('video interactivo');
      if (ch.activityEnabled) marks.push('actividad práctica');
      const tail = marks.length ? ` <span>(${escapeHtml(marks.join(' · '))})</span>` : '';
      return `<strong>${escapeHtml(`Capítulo ${ch.number}`)}</strong> · ${inlineHtml(ch.title)}${tail}`;
    });
    if (m.examEnabled) {
      items.push(`<strong>Evaluación del módulo</strong> · ${escapeHtml(`${m.examQuestionCount} ${plural(m.examQuestionCount as number, 'pregunta', 'preguntas')}`)}`);
    }
    const body = heading(h, 'h4', `Módulo ${m.number} · ${m.title}`, ms) + ul(h, items, ms);
    inner += box(h, body, { s: ms, border: mc.border }, { accentLeft: mc.main });
  });
  if (facts.finalExam.enabled) {
    const cs = toneSurf(h, 'alt');
    const q = facts.finalExam.questionCount as number;
    inner += box(h, heading(h, 'h4', 'Evaluación final', cs.s) + pHtml(h, escapeHtml(`${q} ${plural(q, 'pregunta', 'preguntas')} sobre todo el curso.`), cs.s, { last: true }), cs);
  }
  return out('Ruta de aprendizaje', root(h, 'shell-route', inner));
}

// ─── S1.2 Libro Guía ────────────────────────────────────────────────────────

export function libroCardLabel(libroMid: number, facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  if (!Number.isInteger(libroMid) || libroMid < 1) shellFail(`libroMid inválido (${libroMid})`);
  const h = hx(theme, opts);
  const cs = toneSurf(h, 'soft');
  const c = facts.counts;
  const text =
    `El texto completo del curso en un solo documento: ${c.chapters} ${plural(c.chapters, 'capítulo', 'capítulos')} ` +
    `en ${c.modules} ${plural(c.modules, 'módulo', 'módulos')}, con bibliografía sugerida. ` +
    `Extensión aproximada: ${facts.libro.wordCount} palabras.`;
  const inner =
    eyebrow(h, 'Material de estudio', cs.s) +
    heading(h, 'h3', 'Libro Guía', cs.s) +
    pHtml(h, escapeHtml(text), cs.s) +
    pHtml(h, link(h, `$@RESOURCEVIEWBYID*${libroMid}@$`, 'Abrir el Libro Guía', cs.s), cs.s, { last: true });
  return out('Libro Guía', root(h, 'shell-libro', box(h, inner, cs)));
}

// ─── S1.3 Audiolibro ────────────────────────────────────────────────────────

export function audiobookLabel(facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const items = facts.audio.audiobookParts.map((p) => {
    const ch = facts.chapters.find((c) => c.id === p.chapterId);
    if (!ch) shellFail(`parte del audiolibro sin capítulo (${p.chapterId})`);
    return (
      `<strong>${escapeHtml(`Capítulo ${ch.number}`)}</strong> · ${inlineHtml(ch.title)} — ` +
      escapeHtml(`empieza en ${formatDurationEs(p.offsetSeconds)} · dura ${formatDurationEs(p.seconds)}`)
    );
  });
  const inner =
    heading(h, 'h3', 'Audiolibro', s) +
    pHtml(h, escapeHtml(`La versión narrada de los capítulos. Duración total: ${formatDurationEs(facts.audio.audiobookSeconds)}.`), s) +
    audio(h, `@@PLUGINFILE@@/${SHELL_AUDIOBOOK_FILE}`, 'el audiolibro', s) +
    heading(h, 'h4', 'Índice', s) +
    ul(h, items, s);
  return out('Audiolibro', root(h, 'shell-audiobook', inner));
}

// ─── Sm.0 Presentación del módulo ───────────────────────────────────────────

export function moduleIntroLabel(
  module: ModuleFacts,
  moduleIntro: ModuleIntroV3,
  facts: CourseFacts,
  theme: ResolvedTheme,
  opts?: ShellRenderOptions,
): ShellLabel {
  const chapters = module.chapterNumbers.map((n) => {
    const ch = facts.chapters.find((c) => c.number === n);
    if (!ch) shellFail(`capítulo ${n} ausente en facts`);
    return ch;
  });
  const intro = assertValidModuleIntroV3(moduleIntro, { chapterIds: chapters.map((c) => c.id) });
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const mc = moduleColor(theme, module.number - 1);
  const ms = surfOn(theme, mc.soft, [mc.onSoft]);
  const header = box(h, eyebrow(h, `Módulo ${module.number}`, ms) + heading(h, 'h2', module.title, ms), { s: ms, border: mc.border }, { accentLeft: mc.main });
  const journey = intro.journey.map((j, i) => `<strong>${escapeHtml(`Capítulo ${chapters[i].number}`)}</strong> · ${inlineHtml(chapters[i].title)}: ${inlineHtml(j.line)}`);
  const inner =
    header +
    paras(h, intro.presentation, s) +
    heading(h, 'h4', 'Al terminar este módulo podrás:', s) +
    ul(h, intro.outcomes.map((o) => inlineHtml(o)), s) +
    heading(h, 'h4', 'Recorrido del módulo', s) +
    ul(h, journey, s);
  return out(`Módulo ${module.number}: presentación`, root(h, `shell-module-${module.number}`, inner));
}

// ─── Sm.E Evaluación del módulo / SZ Evaluación final ───────────────────────

function examInfo(
  h: Hx,
  uid: string,
  name: string,
  title: string,
  lead: string,
  questionCount: number,
  kind: AssessableType,
  facts: Pick<CourseFacts, 'assessment'>,
): ShellLabel {
  const k = facts.assessment.kinds[kind];
  const cs = toneSurf(h, 'alt');
  const items = [
    `<strong>Preguntas:</strong> ${questionCount}`,
    `<strong>Nota mínima para aprobar:</strong> ${k.passingGrade} de 100`,
    `<strong>Intentos:</strong> ${escapeHtml(attemptsValue(k.attempts))}`,
    `<strong>Calificación:</strong> ${escapeHtml(`se toma ${GRADE_METHOD_ES[k.gradeMethod]}`)}`,
  ];
  const inner = eyebrow(h, 'Evaluación', cs.s) + heading(h, 'h3', title, cs.s) + pHtml(h, escapeHtml(lead), cs.s) + ul(h, items, cs.s);
  return out(name, root(h, uid, box(h, inner, cs)));
}

export function examInfoLabel(
  module: ModuleFacts,
  facts: Pick<CourseFacts, 'assessment'>,
  theme: ResolvedTheme,
  opts?: ShellRenderOptions,
): ShellLabel {
  if (!module.examEnabled || !Number.isInteger(module.examQuestionCount) || (module.examQuestionCount as number) < 1) {
    shellFail(`el módulo ${module.number} no tiene examen: no se genera información de una evaluación inexistente`);
  }
  const h = hx(theme, opts);
  return examInfo(
    h,
    `shell-exam-${module.number}`,
    `Módulo ${module.number}: evaluación`,
    `Evaluación del módulo ${module.number}`,
    `Evalúa lo aprendido en el módulo «${module.title}».`,
    module.examQuestionCount as number,
    'exam',
    facts,
  );
}

export function finalExamInfoLabel(facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  if (!facts.finalExam.enabled || !facts.finalExam.questionCount) shellFail('el curso no tiene examen final');
  const h = hx(theme, opts);
  return examInfo(
    h,
    'shell-final-exam',
    'Evaluación final',
    'Evaluación final',
    'Integra los contenidos de todo el curso.',
    facts.finalExam.questionCount,
    'finalExam',
    facts,
  );
}

// ─── SZ Cierre ──────────────────────────────────────────────────────────────

export function closingLabel(facts: CourseFacts, courseIntro: CourseIntroV3, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const intro = assertValidCourseIntroV3(courseIntro);
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const next = facts.finalExam.enabled
    ? 'Para terminar, completa la evaluación final.'
    : 'Has completado el recorrido del curso.';
  const inner = heading(h, 'h3', 'Cierre del curso', s) + paras(h, intro.closing, s) + pHtml(h, escapeHtml(next), s, { weight: 700, last: true });
  return out('Cierre del curso', root(h, 'shell-closing', inner));
}
