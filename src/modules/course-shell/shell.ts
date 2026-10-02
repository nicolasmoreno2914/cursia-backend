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
 *    etiquetadas "(definida por la institución)". Única excepción (EV6 T3): el
 *    panel «Tu certificado» del cierre, que existe SOLO cuando el paquete trae la
 *    insignia de curso nativa de Moodle (`certificate` en closingLabel);
 *  - CLEAN_SAFE siempre (se verifica con `lintCleanSafe` de R2 antes de
 *    devolver: un label que no pasa → throw SHELL_RENDER), ENHANCED opcional;
 *  - la bibliografía NO va en los labels (va al Libro Guía, R12).
 */
import type { ResolvedTheme } from '../theme-engine';
import { moduleColor } from '../theme-engine';
import { extractText, lintCleanSafe, renderComponent } from '../visual-components';
import { labelHtml, inlineHtml } from '../visual-components/text';
import { formatDurationEs } from '../../package/audio';
import type { AssessableType } from '../course-profiles/course-profiles';
import { CourseFacts, ModuleFacts, courseIntroProse, lintShellNumbers, moduleIntroProse } from './facts';
import { CTA_BADGES, CTA_EXAM, ctaButton, ctaSection } from './cta';
import {
  CourseIntroV3,
  ModuleIntroV3,
  assertValidCourseIntroV3,
  assertValidModuleIntroV3,
} from './intro-schemas';
import {
  Hx,
  ShellRenderOptions,
  accentRule,
  audio,
  bgSurf,
  box,
  eyebrow,
  heading,
  hx,
  lead,
  link,
  numRow,
  numeralHtml,
  pHtml,
  panelSurf,
  paras,
  plural,
  root,
  rows,
  shellFail,
  st,
  statRow,
  surfOn,
  toneSurf,
  unprotectedText,
} from './html';
import { GRADE_METHOD_ES, attemptsValue } from './microcopy';
import { EXAMS_TEACHER_NOTE, EXAMS_TEACHER_NOTE_ATTEMPTS, EXAMS_TEACHER_NOTE_AVAILABILITY, examExplanationsInfoText } from './exam-explanations';

export interface ShellLabel {
  name: string;
  html: string;
}

export const SHELL_AUDIO_WELCOME_FILE = 'audio_bienvenida.mp3';
export const SHELL_AUDIOBOOK_FILE = 'audiolibro.mp3';

/**
 * Gate de render (fix round 1, C1): todo número visible del label (nombre +
 * texto) debe estar en factsNumberSet. Si no → SHELL_NUMBER_NOT_FROM_FACTS
 * (el empaquetado falla fuerte; nunca se publica una cifra inventada).
 */
export function assertShellNumbers(label: ShellLabel, facts: CourseFacts, prose: readonly string[] = []): void {
  // V542 fix round 2 (N1): plantilla estricta; solo la prosa LLM del label admite cifras de contenido.
  const bad = lintShellNumbers(`${label.name} ${extractText(label.html)}`, facts, prose);
  if (bad.length > 0) {
    throw new Error(`SHELL_NUMBER_NOT_FROM_FACTS: "${label.name}" muestra cifras que no salen de facts: ${bad.join(', ')}`);
  }
}

function out(name: string, html: string, facts: CourseFacts, prose: readonly string[] = []): ShellLabel {
  const lint = lintCleanSafe(html);
  if (!lint.ok) {
    shellFail(`${name}: no pasa CLEAN_SAFE: ${lint.errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join('; ')}`);
  }
  const unprotected = unprotectedText(html);
  if (unprotected.length > 0) shellFail(`${name}: texto sin protección nolink: ${JSON.stringify(unprotected.slice(0, 3))}`);
  const label = { name, html };
  assertShellNumbers(label, facts, prose);
  return label;
}

/** "<strong>Clave:</strong> valor" con cada tramo protegido (nolink). */
function kv(key: string, value: string): string {
  return `<strong>${labelHtml(`${key}:`)}</strong>${labelHtml(` ${value}`)}`;
}

function lvl(h: Hx): 'enhanced' | undefined {
  return h.enh ? 'enhanced' : undefined;
}

// ─── S0.2 Bienvenida ────────────────────────────────────────────────────────

/** EV6 DoD (BE-A): texto del aviso de un paquete de QA (sin cifras ni nombres de recursos). */
export const QA_PREVIEW_NOTICE_TITLE = 'QA — vista previa, no entregable';
export const QA_PREVIEW_NOTICE_TEXT =
  'Este paquete es una copia interna de control de calidad. Contiene componentes simulados o pendientes y no es ' +
  'el curso final: no lo entregues a estudiantes ni a clientes.';

export function welcomeLabel(
  facts: CourseFacts,
  courseIntro: CourseIntroV3,
  theme: ResolvedTheme,
  opts?: ShellRenderOptions,
  /** EV6 DoD: paquete de QA → aviso visible antes de la bienvenida (default: sin aviso, bytes de siempre). */
  qaPreviewNotice = false,
): ShellLabel {
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
    { uid: 'shell-welcome-hero', level: lvl(h), countless: true },
  );
  const s = bgSurf(h);
  const hours = facts.hours
    ? pHtml(h, labelHtml(`Duración estimada: ${facts.hours.value} h (${facts.hours.source}).`), s, { secondary: true, last: true })
    : '';
  let qa = '';
  if (qaPreviewNotice) {
    const cs = toneSurf(h, 'alt');
    qa = box(h, eyebrow(h, QA_PREVIEW_NOTICE_TITLE, cs.s) + pHtml(h, labelHtml(QA_PREVIEW_NOTICE_TEXT), cs.s, { last: true }), cs, { cls: 'cvc-qa-preview' });
  }
  return out('Bienvenida', root(h, 'shell-welcome', qa + hero + statRow(h, stats) + hours), facts, courseIntroProse(intro, 'welcome'));
}

// ─── S0.3 Audio de bienvenida ───────────────────────────────────────────────

export function audioWelcomeLabel(facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const inner =
    eyebrow(h, 'Escucha', s) +
    heading(h, 'h3', 'Audio de bienvenida', s) +
    pHtml(h, labelHtml(`Escucha la presentación del curso. Duración: ${formatDurationEs(facts.audio.welcomeSeconds)}.`), s, { secondary: true }) +
    audio(h, `@@PLUGINFILE@@/${SHELL_AUDIO_WELCOME_FILE}`, 'el audio de bienvenida', s);
  return out('Audio de bienvenida', root(h, 'shell-audio-welcome', inner), facts);
}

// ─── S0.4 Competencias ──────────────────────────────────────────────────────

export function competenciesLabel(facts: CourseFacts, courseIntro: CourseIntroV3, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const intro = assertValidCourseIntroV3(courseIntro);
  const h = hx(theme, opts);
  const comp = renderComponent(
    { type: 'learning_objectives', title: 'Qué aprenderás', items: intro.competencies },
    theme,
    { uid: 'shell-competencies-list', level: lvl(h), countless: true },
  );
  return out('Qué aprenderás', root(h, 'shell-competencies', comp), facts, courseIntroProse(intro, 'competencies'));
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
  const items = methodologySteps(facts)
    .map((x) => numRow(h, heading(h, 'h4', x.title, s) + pHtml(h, labelHtml(x.body), s, { secondary: true, last: true }), s))
    .join('');
  const inner =
    eyebrow(h, 'Metodología', s) +
    heading(h, 'h3', 'Cómo vas a aprender', s) +
    rows(h, items, { cls: 'cvc-cols2', ordered: true }) +
    paras(h, intro.methodology_note, s, { last: true });
  return out('Metodología', root(h, 'shell-methodology', inner), facts, courseIntroProse(intro, 'methodology_note'));
}

// ─── S1.1 Ruta de aprendizaje ───────────────────────────────────────────────

export function routeLabel(facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const h = hx(theme, opts);
  const s = bgSurf(h);
  let inner = eyebrow(h, `Mapa del curso · ${facts.counts.modules} ${plural(facts.counts.modules, 'módulo', 'módulos')}`, s) + heading(h, 'h3', 'Ruta de aprendizaje', s);
  facts.modules.forEach((m, mi) => {
    const mc = moduleColor(theme, mi);
    const items = m.chapterNumbers.map((n) => {
      const ch = facts.chapters.find((x) => x.number === n);
      if (!ch) shellFail(`capítulo ${n} ausente en facts`);
      const marks: string[] = [];
      if (ch.videoEnabled) marks.push('video interactivo');
      if (ch.activityEnabled) marks.push('actividad práctica');
      const tail = marks.length ? `<br>${`<span${' style="color:' + s.fg2 + '"'}>${labelHtml(marks.join(' · '))}</span>`}` : '';
      return numRow(h, `<strong>${inlineHtml(ch.title)}</strong>${tail}`, s, String(ch.number));
    });
    if (m.examEnabled) {
      items.push(numRow(h, `<strong>${labelHtml('Evaluación del módulo')}</strong>${labelHtml(' · ')}${labelHtml(`${m.examQuestionCount} ${plural(m.examQuestionCount as number, 'pregunta', 'preguntas')}`)}`, s));
    }
    const body =
      eyebrow(h, `Módulo ${m.number}`, s, { color: mc.main, margin: '0 0 6px 0' }) +
      heading(h, 'h4', m.title, s) +
      rows(h, items.join(''), { ordered: true });
    inner += `<div class="cvc-route-mod">${body}</div>`;
  });
  if (facts.finalExam.enabled) {
    const q = facts.finalExam.questionCount as number;
    inner += eyebrow(h, 'Cierre', s, { margin: '8px 0 6px 0' }) + heading(h, 'h4', 'Evaluación final', s) + pHtml(h, labelHtml(`${q} ${plural(q, 'pregunta', 'preguntas')} sobre todo el curso.`), s, { secondary: true, last: true });
  }
  return out('Ruta de aprendizaje', root(h, 'shell-route', inner), facts);
}

// ─── S1.2 Libro Guía ────────────────────────────────────────────────────────

export function libroCardLabel(libroMid: number, facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  if (!Number.isInteger(libroMid) || libroMid < 1) shellFail(`libroMid inválido (${libroMid})`);
  const h = hx(theme, opts);
  const cs = { s: panelSurf(h), border: h.t.color.border };
  const c = facts.counts;
  const text =
    `El texto completo del curso en un solo documento: ${c.chapters} ${plural(c.chapters, 'capítulo', 'capítulos')} ` +
    `en ${c.modules} ${plural(c.modules, 'módulo', 'módulos')}${facts.libro.hasBibliography === false ? '' : ', con bibliografía sugerida'}. ` +
    `Extensión aproximada: ${facts.libro.wordCount} palabras.`;
  const inner =
    eyebrow(h, 'Material de estudio', cs.s) +
    heading(h, 'h3', 'Libro Guía', cs.s) +
    pHtml(h, labelHtml(text), cs.s) +
    link(h, `$@RESOURCEVIEWBYID*${libroMid}@$`, 'Abrir el Libro Guía', cs.s, { button: true, margin: '16px 0 0 0' });
  return out('Libro Guía', root(h, 'shell-libro', box(h, inner, cs)), facts);
}

// ─── S1.3 Audiolibro ────────────────────────────────────────────────────────

export function audiobookLabel(facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const items = facts.audio.audiobookParts.map((p) => {
    const ch = facts.chapters.find((c) => c.id === p.chapterId);
    if (!ch) shellFail(`parte del audiolibro sin capítulo (${p.chapterId})`);
    return numRow(
      h,
      `<strong>${inlineHtml(ch.title)}</strong><br>` +
        `<span${' style="color:' + s.fg2 + '"'}>${labelHtml(`Empieza en ${formatDurationEs(p.offsetSeconds)} · dura ${formatDurationEs(p.seconds)}`)}</span>`,
      s,
      String(ch.number),
    );
  });
  const inner =
    eyebrow(h, 'Escucha', s) +
    heading(h, 'h3', 'Audiolibro', s) +
    pHtml(h, labelHtml(`La versión narrada de los capítulos. Duración total: ${formatDurationEs(facts.audio.audiobookSeconds)}.`), s, { secondary: true }) +
    audio(h, `@@PLUGINFILE@@/${SHELL_AUDIOBOOK_FILE}`, 'el audiolibro', s) +
    `<div${' style="margin:24px 0 0 0"'}>` +
    eyebrow(h, 'Índice', s) +
    rows(h, items.join(''), { ordered: true }) +
    `</div>`;
  return out('Audiolibro', root(h, 'shell-audiobook', inner), facts);
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
  // R14-A (review C3): el módulo NO repite la anatomía de la apertura de capítulo (numeral
  // gigante): es una banda tintada con la etiqueta del módulo y el título; el numeral queda
  // solo para los capítulos.
  const ps = panelSurf(h);
  void numeralHtml;
  // Review I: la banda lleva solo la entrada (2–3 líneas); el resto va abierto, como cuerpo.
  const sentences = intro.presentation.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [intro.presentation];
  let bandText = '';
  let k = 0;
  while (k < sentences.length && (bandText.length === 0 || bandText.length + sentences[k].length <= 240)) bandText += sentences[k++];
  const restText = sentences.slice(k).join('').trim();
  const header =
    `<div class="cvc-modhead"${st(h, [['background-color', ps.bg], ['color', ps.fg], ['margin', '0 0 28px 0'], ['padding', '28px 28px 24px 28px']], [['border-radius', h.t.shape.radiusLg], ['padding', 'clamp(24px, 4vw, 44px)']])}>` +
    eyebrow(h, `Módulo ${module.number} · ${chapters.length} ${plural(chapters.length, 'capítulo', 'capítulos')}`, ps, { color: mc.main }) +
    heading(h, 'h2', module.title, ps) +
    accentRule(h, ps) +
    lead(h, bandText.trim(), ps, { last: true }) +
    `</div>` +
    (restText ? paras(h, restText, s) : '');
  const journey = intro.journey
    .map((j, i) => numRow(h, heading(h, 'h4', chapters[i].title, s) + pHtml(h, inlineHtml(j.line), s, { secondary: true, last: true }), s, String(chapters[i].number)))
    .join('');
  const outcomes = intro.outcomes.map((o) => numRow(h, inlineHtml(o), s)).join('');
  const inner =
    header +
    `<div${' style="margin:32px 0 0 0"'}>` +
    eyebrow(h, 'Al terminar este módulo podrás', s) +
    rows(h, outcomes, { cls: 'cvc-cols2' }) +
    `</div>` +
    eyebrow(h, 'Recorrido del módulo', s) +
    rows(h, journey, { ordered: true });
  return out(`Módulo ${module.number}: presentación`, root(h, `shell-module-${module.number}`, inner), facts, moduleIntroProse(intro));
}

// ─── Sm.E Evaluación del módulo / SZ Evaluación final ───────────────────────

function examInfo(
  h: Hx,
  uid: string,
  name: string,
  title: string,
  leadText: string,
  questionCount: number,
  kind: AssessableType,
  facts: CourseFacts,
  ctaText: string,
  explained: boolean,
): ShellLabel {
  const k = facts.assessment.kinds[kind];
  const cs = { s: panelSurf(h), border: h.t.color.border };
  const items = [
    kv('Preguntas', String(questionCount)),
    kv('Nota mínima para aprobar', `${k.passingGrade} de 100`),
    kv('Intentos', attemptsValue(k.attempts)),
    kv('Calificación', `se toma ${GRADE_METHOD_ES[k.gradeMethod]}`),
  ]
    .map((it) => numRow(h, it, cs.s))
    .join('');
  // Edu EV3: el botón lleva al cuestionario (el builder resuelve el marcador al crearlo).
  // EV6 P2-B4: la página «Respuestas explicadas» se anuncia aquí (está oculta hasta aprobar o agotar
  // los intentos); los intentos salen de facts.
  const inner =
    eyebrow(h, 'Evaluación', cs.s) +
    heading(h, 'h3', title, cs.s) +
    pHtml(h, labelHtml(leadText), cs.s, { secondary: true }) +
    rows(h, items, { cls: 'cvc-cols2' }) +
    pHtml(h, labelHtml(examExplanationsInfoText(k.attempts, explained)), cs.s, { secondary: true, last: true }) +
    ctaButton(h, CTA_EXAM, ctaText, cs.s);
  return out(name, root(h, uid, box(h, inner, cs)), facts);
}

export function examInfoLabel(
  module: ModuleFacts,
  facts: CourseFacts,
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
    `Presentar evaluación del módulo ${module.number} →`,
    module.examBankSize !== undefined,
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
    'Presentar evaluación final →',
    facts.finalExam.bankSize !== undefined,
  );
}

/**
 * Edu EV3 — cierre de un módulo: «Cuando termines el módulo N…» + botón a la sección del
 * módulo siguiente. EV6: `{ kind: 'closing' }` = después del último módulo: con examen final
 * el botón lleva a la sección «Evaluación final» (el cierre va DESPUÉS del examen final); sin
 * examen final, al cierre. `sectionNum` es la sección destino. Toda cifra sale de facts.
 */
export function moduleNextLabel(
  module: ModuleFacts,
  next: { kind: 'module'; module: ModuleFacts; sectionNum: number } | { kind: 'closing'; sectionNum: number },
  facts: CourseFacts,
  theme: ResolvedTheme,
  opts?: ShellRenderOptions,
): ShellLabel {
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const done = `Cuando termines el módulo ${module.number} («${module.title}»), continúa por aquí.`;
  const text =
    next.kind === 'module'
      ? `Continuar con el módulo ${next.module.number}: ${next.module.title} →`
      : facts.finalExam.enabled
        ? 'Ir a la evaluación final →'
        : 'Ir al cierre del curso →';
  const inner = pHtml(h, labelHtml(done), s, { weight: 600 }) + ctaButton(h, ctaSection(next.sectionNum), text, s);
  return out(`Módulo ${module.number}: siguiente paso`, root(h, `shell-module-next-${module.number}`, inner), facts);
}

// ─── EV6: botones de navegación entre secciones (una sección por página) ────

/** Fin de la sección 0 (Bienvenida): «Comenzar el curso →» a la sección del primer capítulo. */
export function welcomeStartLabel(firstChapterSectionNum: number, facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const inner =
    pHtml(h, labelHtml('Empieza por aquí. La ruta de aprendizaje y el Libro Guía están en la sección siguiente, para consultarlos cuando quieras.'), s, { weight: 600 }) +
    ctaButton(h, ctaSection(firstChapterSectionNum), 'Comenzar el curso →', s);
  return out('Comenzar el curso', root(h, 'shell-start', inner), facts);
}

/** Fin de la sección 1 (Ruta y Libro Guía): «Comenzar con el capítulo N →» (N = primer capítulo de facts). */
export function routeStartLabel(firstChapterSectionNum: number, facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const first = facts.chapters[0];
  if (!first) shellFail('el curso no tiene capítulos');
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const inner =
    pHtml(h, labelHtml('Ya conoces el recorrido. Es momento de empezar.'), s, { weight: 600 }) +
    ctaButton(h, ctaSection(firstChapterSectionNum), `Comenzar con el capítulo ${first.number} →`, s);
  return out('Comenzar con el primer capítulo', root(h, 'shell-route-start', inner), facts);
}

/** Después del examen final: «Ir al cierre del curso →» (solo si el curso tiene examen final). */
export function finalExamNextLabel(closingSectionNum: number, facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  if (!facts.finalExam.enabled) shellFail('el curso no tiene examen final');
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const inner =
    pHtml(h, labelHtml('Cuando termines la evaluación final, continúa por aquí.'), s, { weight: 600 }) +
    ctaButton(h, ctaSection(closingSectionNum), 'Ir al cierre del curso →', s);
  return out('Evaluación final: siguiente paso', root(h, 'shell-final-exam-next', inner), facts);
}

// ─── SZ Cierre ──────────────────────────────────────────────────────────────

/**
 * EV6 (T3): el paquete trae una insignia de curso nativa de Moodle (el certificado), que se otorga
 * al completar el curso. Fix round 1 (review I1): el texto nombra EXACTAMENTE los criterios de
 * completion del paquete (por tipo de ítem) y nunca promete algo que la insignia no cumple:
 * cada ítem calificable cuenta solo APROBADO (`completionpassgrade=1`) y, si el perfil lo exige,
 * también la nota mínima del curso (criterio de nota, sin cifras: la cifra no sale de facts).
 */
export interface CertificateRequirements {
  /** Criterios: actividades prácticas de capítulo (H5P/SCORM). */
  activities: boolean;
  /** Criterios: videos interactivos (calificables). */
  videos: boolean;
  /** Criterios: evaluaciones de módulo. */
  moduleExams: boolean;
  /** Criterio: evaluación final (aprobada). */
  finalExam: boolean;
  /** Criterio de nota del curso (`requireCourseGradePass`). */
  courseGrade: boolean;
}

function joinEs(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
}

/** Condiciones de la insignia en subjuntivo («apruebes…») o infinitivo («aprobar…»). */
export function certificateRequirementClauses(r: CertificateRequirements, mood: 'sub' | 'inf'): string {
  // Fix round 1b (decisión M5): «Curso completo → Evaluación final aprobada → Cierre → Certificado»:
  // el certificado existe SOLO si el curso tiene evaluación final (y siempre la exige aprobada).
  if (!r.finalExam) shellFail('certificado: solo existe con evaluación final (y la exige aprobada)');
  const v = mood === 'sub' ? { pass: 'apruebes', reach: 'alcances' } : { pass: 'aprobar', reach: 'alcanzar' };
  const items: string[] = [];
  if (r.activities) items.push('todas las actividades prácticas');
  if (r.videos) items.push('todos los videos interactivos');
  if (r.moduleExams) items.push('todas las evaluaciones de módulo');
  if (r.finalExam) items.push('la evaluación final');
  const clauses: string[] = [];
  if (items.length) clauses.push(`${v.pass} ${joinEs(items)}`);
  if (r.courseGrade) clauses.push(`${v.reach} la nota mínima del curso`);
  return joinEs(clauses);
}

export function closingCertificateText(r: CertificateRequirements): string {
  return `Cuando ${certificateRequirementClauses(r, 'sub')}, Moodle te otorga el certificado del curso. Lo encuentras en tu perfil, en Insignias.`;
}

export function closingLabel(
  facts: CourseFacts,
  courseIntro: CourseIntroV3,
  theme: ResolvedTheme,
  opts?: ShellRenderOptions,
  certificate?: CertificateRequirements,
): ShellLabel {
  const intro = assertValidCourseIntroV3(courseIntro);
  const h = hx(theme, opts);
  const s = bgSurf(h);
  // EV6: el cierre va DESPUÉS de la evaluación final: constata que terminó (nunca la anuncia como pendiente).
  const next = facts.finalExam.enabled
    ? 'Has completado el recorrido del curso y su evaluación final.'
    : 'Has completado el recorrido del curso.';
  let inner =
    eyebrow(h, 'Cierre', s) +
    heading(h, 'h3', 'Cierre del curso', s) +
    accentRule(h, s) +
    lead(h, intro.closing, s) +
    pHtml(h, labelHtml(next), s, { weight: 700, last: !certificate });
  if (certificate) {
    const c = facts.counts;
    if (certificate.finalExam && !facts.finalExam.enabled) shellFail('certificado: exige una evaluación final que el curso no tiene');
    if ((certificate.activities && c.activities < 1) || (certificate.videos && c.videos < 1) || (certificate.moduleExams && c.exams < 1)) {
      shellFail('certificado: exige un tipo de ítem que el curso no tiene');
    }
    const cs = toneSurf(h, 'soft');
    inner += box(
      h,
      eyebrow(h, 'Certificado', cs.s) +
        heading(h, 'h4', 'Tu certificado', cs.s) +
        pHtml(h, labelHtml(closingCertificateText(certificate)), cs.s) +
        ctaButton(h, CTA_BADGES, 'Ver mi certificado →', cs.s),
      cs,
      { cls: 'cvc-certificate' },
    );
  }
  return out('Cierre del curso', root(h, 'shell-closing', inner), facts, courseIntroProse(intro, 'closing'));
}

/**
 * EV6 T3 (fix 0b): label SOLO PARA DOCENTES (el builder lo empaqueta con `visible=0`: el docente lo
 * ve atenuado, el estudiante nunca). Moodle restaura la insignia desactivada: aquí se explica cómo
 * habilitarla una vez. `badgeName` = nombre exacto de la insignia del paquete.
 */
/** Fix round 1 (review I2): la restauración puede omitir la insignia sin aviso (execute_condition). */
export const CERTIFICATE_TEACHER_TROUBLESHOOTING =
  'Si no ves la insignia, revisa que las insignias estén habilitadas en el sitio y en el curso, y que la restauración haya incluido todas las actividades.';

export function certificateTeacherLabel(badgeName: string, facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const name = String(badgeName ?? '').trim();
  if (!name.startsWith('Certificado: ')) shellFail(`certificado (docentes): nombre de insignia inválido (${name})`);
  const h = hx(theme, opts);
  const cs = toneSurf(h, 'alt');
  const inner =
    eyebrow(h, 'Solo docentes', cs.s) +
    heading(h, 'h4', 'Para docentes: activa el certificado del curso', cs.s) +
    pHtml(
      h,
      labelHtml(
        `Moodle deja la insignia desactivada al restaurar. Entra a Insignias → «${name}» → «Habilitar acceso». Solo se hace una vez. ` +
          CERTIFICATE_TEACHER_TROUBLESHOOTING,
      ),
      cs.s,
    ) +
    ctaButton(h, CTA_BADGES, 'Abrir las insignias del curso →', cs.s) +
    // EV6 P2-B4 (rulings 2 + 3): el certificado exige la evaluación final → siempre hay «Respuestas
    // explicadas»; su nota para docentes va aquí, un párrafo más.
    // Fix 1 (M2): con su propio subtítulo, para no leerse como parte del paso de la insignia.
    (hasExams(facts)
      ? `<div${st(h, [['margin', '24px 0 0 0'], ['padding', '16px 0 0 0'], ['color', cs.s.fg], ['border-top', `1px solid ${cs.border}`]])}>` +
        heading(h, 'h4', 'Respuestas explicadas', cs.s) +
        pHtml(h, labelHtml(EXAMS_TEACHER_NOTE), cs.s, { last: true }) +
        `</div>`
      : '');
  return out('Para docentes: activar el certificado', root(h, 'shell-certificate-teacher', box(h, inner, cs, { cls: 'cvc-certificate-teacher' })), facts);
}

function hasExams(facts: CourseFacts): boolean {
  return facts.counts.exams > 0 || facts.finalExam.enabled;
}

/**
 * EV6 P2-B4 (rulings 2 + 3): label SOLO PARA DOCENTES (el builder lo empaqueta con `visible=0`) cuando
 * el curso tiene evaluaciones pero no trae el label del certificado: el acceso condicional que
 * necesitan las páginas «Respuestas explicadas» y la decisión de dar intentos adicionales.
 */
export function examsTeacherLabel(facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  if (!hasExams(facts)) shellFail('nota para docentes de las evaluaciones en un curso sin evaluaciones');
  const h = hx(theme, opts);
  const cs = toneSurf(h, 'alt');
  const inner =
    eyebrow(h, 'Solo docentes', cs.s) +
    heading(h, 'h4', 'Para docentes: respuestas explicadas', cs.s) +
    pHtml(h, labelHtml(EXAMS_TEACHER_NOTE_AVAILABILITY), cs.s) +
    pHtml(h, labelHtml(EXAMS_TEACHER_NOTE_ATTEMPTS), cs.s, { last: true });
  return out('Para docentes: respuestas explicadas', root(h, 'shell-exams-teacher', box(h, inner, cs, { cls: 'cvc-exams-teacher' })), facts);
}
