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
  Surf,
  ShellRenderOptions,
  accentRule,
  audio,
  bgSurf,
  box,
  eyebrow,
  heading,
  heroBand,
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
  splitBodyParagraphs,
  splitLeadRest,
  st,
  statRow,
  surfOn,
  toneSurf,
  unprotectedText,
} from './html';
import { GRADE_METHOD_ES, attemptsValue } from './microcopy';
import { EXAMS_TEACHER_NOTE_ATTEMPTS, EXAMS_TEACHER_NOTE_AVAILABILITY, EXAMS_TEACHER_NOTE_UNLIMITED, examExplanationsInfoText, examsHaveUnlimitedAttempts, examsTeacherNoteFor } from './exam-explanations';

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

/** r19 W: topes de la composición de la bienvenida (los usa también el validador ≥ 3.13.0). */
export const WELCOME_LEAD_MAX_WORDS = 40;
export const WELCOME_LEAD_MAX_CHARS = 240;
export const WELCOME_PARA_MAX_WORDS = 70;
export const WELCOME_PARA_TARGET_WORDS = 60;

/**
 * Fix round 2: un token larguísimo (URL, cadena sin espacios) no desborda a 375 px. CLEAN_SAFE: los guiones suaves
 * deterministas de richParagraphs (cada 10 caracteres en palabras de ≥ 22; Moodle elimina overflow-wrap/word-break bajo
 * forceclean, text.ts §X.1). ENHANCED: además overflow-wrap:anywhere en la entrada y el cuerpo.
 */
const WRAP: Array<[string, string]> = [['overflow-wrap', 'anywhere'], ['word-break', 'break-word']];

/**
 * r76 «Diseño visual»: identidad institucional al inicio de la bienvenida (solo si el perfil la pide; ausente = bytes de
 * siempre). `src` = archivo del label (`@@PLUGINFILE@@/…`, en files.xml con su SHA1). El `alt` es FIJO: los filtros de
 * Moodle reescriben atributos y `nolink` no los protege (mismo criterio que la portada de la presentación).
 */
export interface WelcomeIdentity {
  src: string;
  /** Tamaño en px de la imagen tal como se muestra (atributos width/height: sobreviven al purificador). */
  width: number;
  height: number;
  /** Nombre de la institución (o null). */
  name: string | null;
}
export const WELCOME_LOGO_FILE = 'logo-institucion.png';
export const WELCOME_LOGO_FILE_JPEG = 'logo-institucion.jpg';
export const WELCOME_LOGO_ALT = 'Logo de la institución';
export const WELCOME_LOGO_MAX_H = 56;
export const WELCOME_LOGO_MAX_W = 220;

/** r76: tamaño de la imagen del logo en la bienvenida (alto 56 px, ancho ≤ 220 px, proporción del original). */
export function welcomeLogoSize(width: number, height: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: WELCOME_LOGO_MAX_H, height: WELCOME_LOGO_MAX_H };
  let h = WELCOME_LOGO_MAX_H;
  let w = Math.round((h * width) / height);
  if (w > WELCOME_LOGO_MAX_W) {
    w = WELCOME_LOGO_MAX_W;
    h = Math.max(16, Math.round((w * height) / width));
  }
  return { width: w, height: h };
}

export function identityStrip(h: Hx, idn: WelcomeIdentity, s: Surf): string {
  const img = `<img src="${idn.src.replace(/"/g, '&quot;')}" alt="${WELCOME_LOGO_ALT}" width="${idn.width}" height="${idn.height}"` +
    st(h, [['margin', idn.name ? '0 0 8px 0' : '0'], ['display', 'block']], [['max-width', '100%'], ['height', 'auto']]) + ' />';
  const name = idn.name ? eyebrow(h, idn.name, s, { sentence: true, margin: '0', color: s.fg }) : '';
  return `<div class="cvc-identity"${st(h, [['margin', '0 0 20px 0'], ['padding', '0 0 16px 0'], ['border-bottom', `1px solid ${h.t.color.border}`]])}>${img}${name}</div>`;
}

export function welcomeLabel(
  facts: CourseFacts,
  courseIntro: CourseIntroV3,
  theme: ResolvedTheme,
  opts?: ShellRenderOptions,
  /** EV6 DoD: paquete de QA → aviso visible antes de la bienvenida (default: sin aviso, bytes de siempre). */
  qaPreviewNotice = false,
  /** r76: logo y nombre de la institución al inicio del hero (ausente = bytes de siempre). */
  identity: WelcomeIdentity | null = null,
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
  // UX r18 (problema 1): Moodle 4.5 siempre pinta el nombre de la sección 0 («Bienvenida») como
  // encabezado justo encima de este label (núcleo de format_topics, no se puede quitar desde el
  // .mbz). El hero NO repite esa palabra: su línea meta son cifras de facts.
  // r19 W: la bienvenida dejó de ser UN párrafo a tamaño de entrada (141–155 palabras = 11–13 líneas
  // a 1280 y ~24 a 375). Composición determinística, sin LLM ni cambio de esquema:
  //   superficie del hero (heroTreatment de la familia) → «Curso · N módulos · M capítulos» (caja de oración a 16 px:
  //   pasa de 30 caracteres, no cabe como chip en mayúsculas — regla del QA del navegador) → título →
  //   filete → entrada (≤ 40 palabras / 240 caracteres, oraciones enteras) → resto a tamaño de cuerpo
  //   en párrafos de ≤ 70 palabras → fila de cifras. No se pierde ni se repite texto.
  const s = bgSurf(h);
  // Fix round 1 (C1): `cut` — una primera oración fuera de tope se corta en la última cláusula (o palabra) que
  // quepa y lo demás abre el cuerpo: TODA bienvenida válida por el esquema produce un label conforme (nunca falla el
  // empaquetado por la forma del texto). `guard`: sin cortes en abreviaturas ni dentro de un énfasis.
  const split = splitLeadRest(intro.welcome, { maxChars: WELCOME_LEAD_MAX_CHARS, maxWords: WELCOME_LEAD_MAX_WORDS, guard: true, cut: true });
  const hero = heroBand(h, 'cvc-welcome-band', (bs) =>
    (identity ? identityStrip(h, identity, bs) : '') +
    eyebrow(h, `Curso · ${c.modules} ${plural(c.modules, 'módulo', 'módulos')} · ${c.chapters} ${plural(c.chapters, 'capítulo', 'capítulos')}`, bs, { sentence: true }) +
    heading(h, 'h4', facts.course.title, bs, { display: true }) +
    accentRule(h, bs) +
    // Fix round 2: con `cut` la entrada siempre cabe o es vacía (primera palabra de > 240 caracteres): sin entrada, el
    // hero queda en línea meta + título + filete y todo el texto va al cuerpo.
    (split.lead ? lead(h, split.lead, bs, { last: true, cls: 'cvc-lead', enh: WRAP }) : ''),
  );
  if (!split.fits) shellFail(`Bienvenida: entrada fuera de tope (${split.lead.length} caracteres)`);
  const bodyParas = split.rest ? splitBodyParagraphs(split.rest, { maxWords: WELCOME_PARA_MAX_WORDS, target: WELCOME_PARA_TARGET_WORDS }) : [];
  const body = bodyParas.length ? `<div class="cvc-welcome-body"${st(h, [['margin', '0'], ['padding', 0], ['color', s.fg]])}>${paras(h, bodyParas.join('\n\n'), s, { enh: WRAP })}</div>` : '';
  const hours = facts.hours
    // Review r1 (M-5): «(definida por la institución)» solo con horas del documento de la institución; si no, neutra.
    ? pHtml(h, labelHtml(facts.hours.source
      ? `Duración estimada: ${String(facts.hours.value).replace('.', ',')} h (${facts.hours.source}).`
      : `Duración estimada del curso: ${String(facts.hours.value).replace('.', ',')} h.`), s, { secondary: true, last: true })
    : '';
  let qa = '';
  if (qaPreviewNotice) {
    const cs = toneSurf(h, 'alt');
    qa = box(h, eyebrow(h, QA_PREVIEW_NOTICE_TITLE, cs.s) + pHtml(h, labelHtml(QA_PREVIEW_NOTICE_TEXT), cs.s, { last: true }), cs, { cls: 'cvc-qa-preview' });
  }
  // r76: el nombre de la institución es texto del usuario (puede tener cifras: «Colegio 21») → prosa admitida.
  const prose = identity?.name ? [...courseIntroProse(intro, 'welcome'), identity.name] : courseIntroProse(intro, 'welcome');
  return out('Bienvenida', root(h, 'shell-welcome', qa + hero + body + statRow(h, stats) + hours), facts, prose);
}

// ─── S0.3 Audio de bienvenida ───────────────────────────────────────────────

/** Títulos visibles de los labels de audio; también son el nombre accesible (aria-label) de su reproductor. */
const AUDIO_WELCOME_TITLE = 'Audio de bienvenida';
const AUDIOBOOK_TITLE = 'Audiolibro';

export function audioWelcomeLabel(facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const inner =
    eyebrow(h, 'Escucha', s) +
    heading(h, 'h3', AUDIO_WELCOME_TITLE, s) +
    pHtml(h, labelHtml(`Escucha la presentación del curso. Duración: ${formatDurationEs(facts.audio.welcomeSeconds)}.`), s, { secondary: true }) +
    audio(h, `@@PLUGINFILE@@/${SHELL_AUDIO_WELCOME_FILE}`, 'el audio de bienvenida', s, AUDIO_WELCOME_TITLE);
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
  // Motor de carga horaria: con capítulos de práctica la presentación es solo de los de contenido (sin práctica:
  // el texto de siempre).
  const practice = facts.chapters.some((ch) => ch.kind === 'practice');
  const steps: Array<{ title: string; body: string }> = [
    { title: 'Recorrido del capítulo', body: 'Cada capítulo te guía con explicaciones, ejemplos y momentos de reflexión.' },
    practice
      ? { title: 'Presentación del capítulo', body: 'En los capítulos de contenido, una visión general de las ideas principales, para ver o repasar cuando quieras.' }
      : { title: 'Presentación del capítulo', body: 'Una visión general de las ideas principales, para ver o repasar cuando quieras.' },
    ...(practice ? [{ title: 'Capítulos de práctica', body: 'Integran lo que aprendiste en el módulo en un caso completo, sin teoría nueva.' }] : []),
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

/**
 * #583 (M5/M6): descripción del recurso «📘 Libro Guía» (builder 3.11.0: `showdescription` = 1): la sección 1 muestra una
 * sola entrada del Libro Guía (la fila del recurso con esta tarjeta debajo). Sin `libroMid` (builder 3.11.0–3.12.0) la
 * tarjeta no lleva botón.
 * r19 (L4, builder 3.13.0): con `libroMid` (el moduleid del PROPIO recurso) lleva el botón visible «Abrir Libro Guía →»
 * hacia `$@RESOURCEVIEWBYID*libroMid@$` en una pestaña nueva; con `display` = 5 (abrir) view.php entrega el PDF, que el
 * navegador muestra en su visor.
 */
export function libroResourceIntro(facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions, libroMid?: number, onlineBookMid?: number): ShellLabel {
  if (libroMid === undefined) return libroCard(null, facts, theme, opts);
  if (!Number.isInteger(libroMid) || libroMid < 1) shellFail(`libroMid inválido (${libroMid})`);
  if (onlineBookMid !== undefined && (!Number.isInteger(onlineBookMid) || onlineBookMid < 1)) shellFail(`onlineBookMid inválido (${onlineBookMid})`);
  return libroCard(libroMid, facts, theme, opts, { text: LIBRO_CTA_TEXT, newTab: true, pdf: true, ...(onlineBookMid !== undefined ? { onlineBookMid } : {}) });
}

/** r19 (L4): texto del botón del Libro Guía en la descripción del recurso (builder ≥ 3.13.0). */
export const LIBRO_CTA_TEXT = 'Abrir Libro Guía →';
/** r78: botón de la tarjeta hacia la lectura en línea (libro de Moodle, builder ≥ 3.18.0). */
export const LIBRO_ONLINE_CTA_TEXT = 'Leer en el celular →';
/** r78: frase de la tarjeta sobre la lectura en línea. */
export const LIBRO_ONLINE_CARD_TEXT = 'Para leer en el teléfono, usa la versión en línea: el mismo texto, con letra cómoda que se ajusta a la pantalla. El PDF sirve para descargar e imprimir.';

/** Tarjeta del Libro Guía como label aparte (builder ≤ 3.10.0; se conserva para paquetes y pruebas anteriores). */
export function libroCardLabel(libroMid: number, facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  if (!Number.isInteger(libroMid) || libroMid < 1) shellFail(`libroMid inválido (${libroMid})`);
  return libroCard(libroMid, facts, theme, opts);
}

function libroCard(
  libroMid: number | null,
  facts: CourseFacts,
  theme: ResolvedTheme,
  opts?: ShellRenderOptions,
  cta: { text: string; newTab: boolean; pdf: boolean; onlineBookMid?: number } = { text: 'Abrir el Libro Guía', newTab: false, pdf: false },
): ShellLabel {
  const h = hx(theme, opts);
  const cs = { s: panelSurf(h), border: h.t.color.border };
  const c = facts.counts;
  // T1 (r57): el Libro trae el texto de los capítulos de CONTENIDO; los de práctica no tienen texto propio. Antes decía
  // «15 capítulos» y el PDF tenía 12 (y su portada decía 12): ahora ambos cuentan lo mismo y lo dicen.
  const practiceN = facts.chapters.filter((x) => x.kind === 'practice').length;
  const contentN = c.chapters - practiceN;
  const chaptersText = practiceN
    ? `los ${contentN} ${plural(contentN, 'capítulo', 'capítulos')} de contenido en ${c.modules} ${plural(c.modules, 'módulo', 'módulos')} (${plural(practiceN, 'el capítulo', `los ${practiceN} capítulos`)} de práctica se ${plural(practiceN, 'trabaja', 'trabajan')} en el aula virtual)`
    : `${c.chapters} ${plural(c.chapters, 'capítulo', 'capítulos')} en ${c.modules} ${plural(c.modules, 'módulo', 'módulos')}`;
  const text =
    `El texto completo del curso en un solo documento${cta.pdf ? ' PDF' : ''}: ${chaptersText}${facts.libro.hasBibliography === false ? '' : ', con bibliografía sugerida'}. ` +
    `Extensión aproximada: ${facts.libro.wordCount} palabras.`;
  const inner =
    eyebrow(h, 'Material de estudio', cs.s) +
    heading(h, 'h3', 'Libro Guía', cs.s) +
    pHtml(h, labelHtml(text), cs.s, { last: libroMid === null }) +
    (libroMid !== null && cta.onlineBookMid !== undefined ? pHtml(h, labelHtml(LIBRO_ONLINE_CARD_TEXT), cs.s, { secondary: true }) : '') +
    (libroMid === null
      ? ''
      : link(h, `$@RESOURCEVIEWBYID*${libroMid}@$`, cta.text, cs.s, { button: true, margin: '16px 0 0 0', ...(cta.newTab ? { target: '_blank' as const } : {}) })) +
    // r78: lectura en línea (libro de Moodle con el mismo texto), en la misma pestaña: la app oficial lo abre dentro.
    (libroMid !== null && cta.onlineBookMid !== undefined ? link(h, `$@BOOKVIEWBYID*${cta.onlineBookMid}@$`, LIBRO_ONLINE_CTA_TEXT, cs.s, { button: true, margin: '12px 0 0 0' }) : '');
  return out(libroMid === null || cta.newTab ? 'Libro Guía (descripción del recurso)' : 'Libro Guía', root(h, 'shell-libro', box(h, inner, cs)), facts);
}

// ─── S1.3 Audiolibro ────────────────────────────────────────────────────────

export function audiobookLabel(facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions, links?: Readonly<Record<string, string>> | null): ShellLabel {
  if (facts.audio.delivery?.mode === 'parts') return audiobookDeliveredInPartsLabel(facts, theme, opts);
  if (facts.audio.delivery?.mode === 'linked') return audiobookLinkedLabel(facts, theme, opts, links ?? {});
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
    heading(h, 'h3', AUDIOBOOK_TITLE, s) +
    pHtml(h, labelHtml(`La versión narrada de los capítulos. Duración total: ${formatDurationEs(facts.audio.audiobookSeconds)}.`), s, { secondary: true }) +
    audio(h, `@@PLUGINFILE@@/${SHELL_AUDIOBOOK_FILE}`, 'el audiolibro', s, AUDIOBOOK_TITLE) +
    `<div${' style="margin:24px 0 0 0"'}>` +
    eyebrow(h, 'Índice', s) +
    rows(h, items.join(''), { ordered: true }) +
    `</div>`;
  return out('Audiolibro', root(h, 'shell-audiobook', inner), facts);
}

/** r74: nombre de archivo del MP3 de un segmento del audiolibro entregado por partes (sin cifras visibles). */
export function audiobookSegmentFile(moduleNumber: number, firstChapter: number, lastChapter: number): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `audiolibro_modulo_${p2(moduleNumber)}_cap_${p2(firstChapter)}-${p2(lastChapter)}.mp3`;
}

function chapterRange(nums: readonly number[]): string {
  return nums.length === 1 ? `capítulo ${nums[0]}` : `capítulos ${nums[0]} a ${nums[nums.length - 1]}`;
}

/**
 * r74: etiqueta del audiolibro en el paquete PRINCIPAL cuando el audio va en partes aparte. Dice la duración total
 * medida, qué trae cada parte y que, al restaurarlas en este curso, los reproductores aparecen aquí debajo. Sin MP3.
 */
export function audiobookDeliveredInPartsLabel(facts: CourseFacts, theme: ResolvedTheme, opts?: ShellRenderOptions): ShellLabel {
  const d = facts.audio.delivery;
  if (!d) shellFail('audiobookDeliveredInPartsLabel sin entrega por partes');
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const partRows = d.parts.map((p) => {
    const mods = p.segments
      .map((sg) => `Módulo ${sg.moduleNumber} (${chapterRange(sg.chapterNumbers)})`)
      .join(' · ');
    return numRow(h, `<strong>${labelHtml(`Parte ${p.partNumber} de ${d.totalFiles}`)}</strong><br><span style="color:${s.fg2}">${labelHtml(`${mods} · dura ${formatDurationEs(p.seconds)}`)}</span>`, s);
  });
  const items = facts.audio.audiobookParts.map((p) => {
    const ch = facts.chapters.find((c) => c.id === p.chapterId);
    if (!ch) shellFail(`parte del audiolibro sin capítulo (${p.chapterId})`);
    return numRow(h, `<strong>${inlineHtml(ch.title)}</strong><br><span style="color:${s.fg2}">${labelHtml(`Dura ${formatDurationEs(p.seconds)}`)}</span>`, s, String(ch.number));
  });
  const inner =
    eyebrow(h, 'Escucha', s) +
    heading(h, 'h3', AUDIOBOOK_TITLE, s) +
    pHtml(h, labelHtml(`La versión narrada de los capítulos. Duración total: ${formatDurationEs(facts.audio.audiobookSeconds)}.`), s, { secondary: true }) +
    pHtml(h, labelHtml(`Por su extensión, el audiolibro se entrega por módulos en archivos aparte de este curso (las partes ${d.parts[0].partNumber} a ${d.totalFiles} del paquete). Cuando se restauran en este mismo curso, cada módulo aparece justo debajo, con su reproductor.`), s) +
    rows(h, partRows.join('')) +
    `<div style="margin:24px 0 0 0">` +
    eyebrow(h, 'Índice', s) +
    rows(h, items.join(''), { ordered: true }) +
    `</div>`;
  return out('Audiolibro', root(h, 'shell-audiobook', inner), facts);
}

/** r74: clave estable de un segmento del audiolibro (módulo + primer capítulo) para su enlace duradero. */
export function audiobookSegmentKey(moduleNumber: number, firstChapterNumber: number): string {
  return `m${moduleNumber}c${firstChapterNumber}`;
}

/**
 * r74: audiolibro EN LÍNEA (un solo .mbz): un reproductor por módulo con la dirección DURADERA de Cursia del MP3
 * (nunca una URL firmada temporal). La duración de cada tramo y el índice salen de facts (medidos).
 */
export function audiobookLinkedLabel(facts: CourseFacts, theme: ResolvedTheme, opts: ShellRenderOptions | undefined, links: Readonly<Record<string, string>>): ShellLabel {
  const d = facts.audio.delivery;
  if (!d || d.mode !== 'linked') shellFail('audiobookLinkedLabel sin entrega en línea');
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const blocks = d.parts.flatMap((p) => p.segments).map((sg) => {
    const key = audiobookSegmentKey(sg.moduleNumber, sg.chapterNumbers[0]);
    const url = links[key];
    if (!url || !/^https:\/\/[^\s"<>]+$/.test(url)) shellFail(`audiolibro en línea sin dirección para ${key}`);
    const mod = facts.modules.find((m) => m.number === sg.moduleNumber);
    if (!mod) shellFail(`módulo ${sg.moduleNumber} ausente en facts`);
    const items = sg.chapters.map((x) => {
      const ch = facts.chapters.find((c) => c.id === x.chapterId);
      if (!ch) shellFail(`capítulo ${x.chapterId} ausente en facts`);
      return numRow(h, `<strong>${inlineHtml(ch.title)}</strong><br><span style="color:${s.fg2}">${labelHtml(`Empieza en ${formatDurationEs(x.offsetSeconds)} · dura ${formatDurationEs(x.seconds)}`)}</span>`, s, String(ch.number));
    });
    return (
      `<div style="margin:24px 0 0 0">` +
      eyebrow(h, `Módulo ${sg.moduleNumber} · ${chapterRange(sg.chapterNumbers)}`, s) +
      heading(h, 'h4', mod.title, s) +
      pHtml(h, labelHtml(`Duración: ${formatDurationEs(sg.seconds)}.`), s, { secondary: true }) +
      audio(h, url, `el audiolibro del módulo ${sg.moduleNumber}`, s, `${AUDIOBOOK_TITLE} · Módulo ${sg.moduleNumber}`) +
      rows(h, items.join(''), { ordered: true }) +
      `</div>`
    );
  });
  const inner =
    eyebrow(h, 'Escucha', s) +
    heading(h, 'h3', AUDIOBOOK_TITLE, s) +
    pHtml(h, labelHtml(`La versión narrada de los capítulos, por módulo. Duración total: ${formatDurationEs(facts.audio.audiobookSeconds)}. Se escucha en línea desde Cursia: no hay que instalar nada más.`), s, { secondary: true }) +
    blocks.join('');
  return out('Audiolibro', root(h, 'shell-audiobook', inner), facts);
}

/** r74: etiqueta de un segmento del audiolibro (va en una parte de audio; se restaura en la sección 1 del curso). */
export function audiobookSegmentLabel(
  facts: CourseFacts,
  theme: ResolvedTheme,
  opts: ShellRenderOptions | undefined,
  where: { partNumber: number; segmentIndex: number },
): ShellLabel & { file: string } {
  const d = facts.audio.delivery;
  const part = d?.parts.find((p) => p.partNumber === where.partNumber);
  const sg = part?.segments[where.segmentIndex];
  if (!d || !part || !sg) shellFail(`segmento del audiolibro inexistente (parte ${where.partNumber}, ${where.segmentIndex})`);
  const mod = facts.modules.find((m) => m.number === sg.moduleNumber);
  if (!mod) shellFail(`módulo ${sg.moduleNumber} ausente en facts`);
  const h = hx(theme, opts);
  const s = bgSurf(h);
  const file = audiobookSegmentFile(sg.moduleNumber, sg.chapterNumbers[0], sg.chapterNumbers[sg.chapterNumbers.length - 1]);
  const what = `Módulo ${sg.moduleNumber} (${chapterRange(sg.chapterNumbers)})`;
  const items = sg.chapters.map((x) => {
    const ch = facts.chapters.find((c) => c.id === x.chapterId);
    if (!ch) shellFail(`capítulo ${x.chapterId} ausente en facts`);
    return numRow(
      h,
      `<strong>${inlineHtml(ch.title)}</strong><br><span style="color:${s.fg2}">${labelHtml(`Empieza en ${formatDurationEs(x.offsetSeconds)} · dura ${formatDurationEs(x.seconds)}`)}</span>`,
      s,
      String(ch.number),
    );
  });
  const body =
    eyebrow(h, `Audiolibro · parte ${part.partNumber} de ${d.totalFiles}`, s) +
    heading(h, 'h3', mod.title, s) +
    pHtml(h, labelHtml(`${what}. Duración: ${formatDurationEs(sg.seconds)}.`), s, { secondary: true }) +
    audio(h, `@@PLUGINFILE@@/${file}`, `el audiolibro del módulo ${sg.moduleNumber}`, s, `${AUDIOBOOK_TITLE} · Módulo ${sg.moduleNumber}`) +
    `<div style="margin:24px 0 0 0">` +
    eyebrow(h, 'Índice', s) +
    rows(h, items.join(''), { ordered: true }) +
    `</div>`;
  return { ...out(`🎧 Audiolibro · ${what}`, root(h, 'shell-audiobook-part', body), facts), file };
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
  // r19 W: el divisor vive en html.ts (splitLeadRest) y lo comparte la bienvenida del curso.
  const { lead: bandText, rest: restText } = splitLeadRest(intro.presentation, { maxChars: 240 });
  const header =
    `<div class="cvc-modhead"${st(h, [['background-color', ps.bg], ['color', ps.fg], ['margin', '0 0 28px 0'], ['padding', '28px 28px 24px 28px']], [['border-radius', h.t.shape.radiusLg], ['padding', 'clamp(24px, 4vw, 44px)']])}>` +
    eyebrow(h, `Módulo ${module.number} · ${chapters.length} ${plural(chapters.length, 'capítulo', 'capítulos')}`, ps, { color: mc.main }) +
    heading(h, 'h2', module.title, ps) +
    accentRule(h, ps) +
    lead(h, bandText, ps, { last: true }) +
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
    // r55 (R4): la nota mínima de la evaluación es informativa (aprobada / no aprobada); el curso se aprueba por la nota final.
    kv('Nota mínima de esta evaluación', `${k.passingGrade} de 100`),
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
    pHtml(h, labelHtml(examCountsText(facts)), cs.s, { secondary: true }) +
    pHtml(h, labelHtml(examExplanationsInfoText(k.attempts, explained)), cs.s, { secondary: true, last: true }) +
    ctaButton(h, CTA_EXAM, ctaText, cs.s);
  return out(name, root(h, uid, box(h, inner, cs)), facts);
}

/** r55 (R4): cómo cuenta una evaluación — suma a la nota final según su peso; no hay que aprobarla por separado. */
export function examCountsText(facts: CourseFacts): string {
  return `Esta evaluación suma a tu calificación final del curso según su peso: apruebas el curso con una calificación final de ${coursePassingGradeOf(facts)}/100 o más.`;
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
 * r55 (R3/R4) — regla REAL de aprobación del curso, la misma en todo texto del curso (cierre, certificado,
 * descripción de la insignia, notas para docentes, info de las evaluaciones): el curso se aprueba SOLO por la
 * calificación final (criterio de nota del curso, tipo 6) ≥ la nota mínima del curso del perfil, calculada con
 * los ítems calificables según los pesos de sus categorías; el «Repaso» (y las páginas formativas) no cuentan.
 * Ningún texto promete «aprobar todas las actividades»: una actividad bajo su nota mínima no bloquea el curso.
 * Todo sale de facts (cifras incluidas: la nota mínima del curso está en `facts.assessment.coursePassingGrade`).
 *
 * `CertificateRequirements` (nombre histórico): qué entra en la nota final del curso.
 */
export interface CertificateRequirements {
  /** Nota mínima del curso (0 < x ≤ 100). */
  coursePassingGrade: number;
  /** Ítems calificables por tipo presentes en el curso (todos entran en la nota final, ninguno es criterio). */
  activities: boolean;
  videos: boolean;
  moduleExams: boolean;
  finalExam: boolean;
  /** El curso tiene «Repaso» (sin nota). */
  reviewCards: boolean;
  /** T4 (r57): Actividades de Aplicación entregadas como Tarea calificada que pesan en la nota final. Solo si true. */
  applications?: true;
}

/** r55: ¿el curso tiene ítems calificables (nota final)? Mismo criterio que `withoutGrades` del resolver. */
export function courseHasGrades(facts: CourseFacts): boolean {
  const c = facts.counts;
  // T4 (r57): una Tarea calificada también es un ítem de la nota final.
  return c.activities + c.videos + c.exams + (c.applicationAssignsGraded ?? 0) > 0 || c.finalExam === true;
}

/** r55: nota mínima del curso desde facts (fail loud si falta: facts anteriores a r55 no se renderizan). */
export function coursePassingGradeOf(facts: CourseFacts): number {
  const g = facts.assessment?.coursePassingGrade;
  if (typeof g !== 'number' || !Number.isFinite(g) || g <= 0 || g > 100) shellFail(`nota mínima del curso inválida o ausente en facts (${String(g)})`);
  return g;
}

/** r55: requisitos (qué cuenta en la nota final) a partir de facts. Fail loud en un curso sin nota. */
export function courseApprovalRequirements(facts: CourseFacts): CertificateRequirements {
  if (!courseHasGrades(facts)) shellFail('regla de aprobación: el curso no tiene ítems calificables');
  const c = facts.counts;
  // r55 review r1 (M3): una categoría con ítems pero peso efectivo 0 no aporta a la nota final → no se nombra.
  // Facts anteriores sin `categoryWeights`: todas las categorías pobladas cuentan (comportamiento previo).
  const w = facts.assessment?.categoryWeights;
  const weighs = (k: 'practice' | 'moduleExams' | 'finalExam' | 'applications'): boolean => !w || (w[k] ?? 0) > 0;
  const appCategory = facts.assessment?.application?.category;
  const applications = (c.applicationAssignsGraded ?? 0) > 0 && !!appCategory && weighs(appCategory);
  return {
    coursePassingGrade: coursePassingGradeOf(facts),
    activities: c.activities > 0 && weighs('practice'),
    videos: c.videos > 0 && weighs('practice'),
    moduleExams: c.exams > 0 && weighs('moduleExams'),
    finalExam: c.finalExam === true && weighs('finalExam'),
    reviewCards: (c.reviewCards ?? 0) > 0,
    ...(applications ? { applications: true as const } : {}),
  };
}

function joinEs(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
}

/** «las actividades prácticas, los videos interactivos, las evaluaciones de módulo y la evaluación final». */
export function courseGradeComponentsText(r: CertificateRequirements): string {
  const items: string[] = [];
  if (r.activities) items.push('las actividades prácticas');
  if (r.videos) items.push('los videos interactivos');
  if (r.applications) items.push('las Actividades de Aplicación calificadas');
  if (r.moduleExams) items.push('las evaluaciones de módulo');
  if (r.finalExam) items.push('la evaluación final');
  if (!items.length) shellFail('regla de aprobación: ningún ítem entra en la nota final');
  return joinEs(items);
}

function reviewClause(r: CertificateRequirements): string {
  if (!r.reviewCards) return '';
  return r.activities ? '; las actividades de repaso no cuentan en la nota' : '; el «Repaso» no cuenta en la nota';
}

/**
 * «Apruebas el curso con una calificación final igual o superior a 70/100, calculada con … según sus pesos; las
 * actividades de repaso no cuentan en la nota.» (texto aprobado, R4).
 */
export function courseApprovalRuleText(r: CertificateRequirements): string {
  return `Apruebas el curso con una calificación final igual o superior a ${r.coursePassingGrade}/100, calculada con ${courseGradeComponentsText(r)} según sus pesos${reviewClause(r)}.`;
}

/** Panel «Tu certificado» del cierre. */
export function closingCertificateText(r: CertificateRequirements): string {
  return `Cuando tu calificación final del curso llegue a ${r.coursePassingGrade}/100 o más, Moodle te otorga el certificado del curso (puede tardar unos minutos en aparecer). Lo encuentras en tu perfil, en Insignias.`;
}

/** Descripción de la insignia (infinitivo). */
export function certificateRequirementClauses(r: CertificateRequirements): string {
  return `obtener una calificación final igual o superior a ${r.coursePassingGrade}/100, calculada con ${courseGradeComponentsText(r)} según sus pesos${reviewClause(r)}`;
}

/** Nota para docentes (en el label oculto del certificado o en el de las evaluaciones): cómo se aprueba de verdad. */
export function courseApprovalTeacherNote(r: CertificateRequirements): string {
  return (
    `El curso se aprueba solo por la calificación final: la finalización del curso tiene un único criterio, «Calificación del curso» ≥ ${r.coursePassingGrade}/100. ` +
    'Una actividad o una evaluación por debajo de su nota mínima no bloquea el curso, y marcar a mano una actividad como completada no lo aprueba. ' +
    'Moodle revisa ese criterio con su tarea programada (cron): la finalización y el certificado llegan unos minutos después de la última calificación, y mientras tanto el libro de calificaciones ya puede mostrar el curso como aprobado. ' +
    COURSE_RESTORE_COMPLETION_NOTE
  );
}

/**
 * r55 review r1 (I2): el criterio «Calificación del curso» solo funciona si el curso destino tiene la finalización
 * activada. Restaurado como curso NUEVO viene activado; dentro de un curso existente, solo con «Sobrescribir
 * configuración del curso». Mismo texto en «Cómo restaurarlo en Moodle» del FE (43-dynamic-structure-editor.js).
 */
export const COURSE_RESTORE_COMPLETION_NOTE =
  'Restaura el paquete como un curso nuevo. Si lo restauras dentro de un curso existente, elige «Sobrescribir configuración del curso: Sí» (o activa el seguimiento de finalización del curso y revisa que su finalización tenga el criterio «Calificación del curso»); si no, el criterio de nota no hace nada: nadie completa el curso ni recibe el certificado.';

/**
 * `certificate`: true (o, por compatibilidad, cualquier objeto de requisitos) → panel «Tu certificado». Los
 * requisitos salen SIEMPRE de facts (`courseApprovalRequirements`), nunca del llamador. El certificado existe
 * solo con evaluación final (decisión M5).
 */
export function closingLabel(
  facts: CourseFacts,
  courseIntro: CourseIntroV3,
  theme: ResolvedTheme,
  opts?: ShellRenderOptions,
  certificate?: boolean | object,
): ShellLabel {
  const intro = assertValidCourseIntroV3(courseIntro);
  const h = hx(theme, opts);
  const s = bgSurf(h);
  // EV6: el cierre va DESPUÉS de la evaluación final. #583 (M5/M7): la frase es condicional — lo ve también
  // quien todavía no aprobó (o ni intentó) la evaluación final, así que nunca afirma que ya la completó.
  // r55 (R4): con nota, la frase es la regla REAL de aprobación (nota final ≥ mínimo), no «aprobar la final».
  const graded = courseHasGrades(facts);
  const req = graded ? courseApprovalRequirements(facts) : null;
  const next = req ? courseApprovalRuleText(req) : 'Llegaste al cierre del recorrido del curso.';
  const withCertificate = !!certificate;
  let inner =
    eyebrow(h, 'Cierre', s) +
    heading(h, 'h3', 'Cierre del curso', s) +
    accentRule(h, s) +
    lead(h, intro.closing, s) +
    pHtml(h, labelHtml(next), s, { weight: 700, last: !withCertificate });
  if (withCertificate) {
    if (!facts.finalExam.enabled || !req) shellFail('certificado: solo existe con evaluación final (y con nota del curso)');
    const cs = toneSurf(h, 'soft');
    inner += box(
      h,
      eyebrow(h, 'Certificado', cs.s) +
        heading(h, 'h4', 'Tu certificado', cs.s) +
        pHtml(h, labelHtml(closingCertificateText(req)), cs.s) +
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
    // r55 (R4): cómo se aprueba de verdad (criterio único de nota final, cron, override manual sin efecto).
    `<div${st(h, [['margin', '24px 0 0 0'], ['padding', '16px 0 0 0'], ['color', cs.s.fg], ['border-top', `1px solid ${cs.border}`]])}>` +
    heading(h, 'h4', 'Cómo se aprueba el curso', cs.s) +
    pHtml(h, labelHtml(courseApprovalTeacherNote(courseApprovalRequirements(facts))), cs.s, { last: true }) +
    `</div>` +
    // EV6 P2-B4 (rulings 2 + 3): el certificado exige la evaluación final → siempre hay «Respuestas
    // explicadas»; su nota para docentes va aquí, un párrafo más.
    // Fix 1 (M2): con su propio subtítulo, para no leerse como parte del paso de la insignia.
    (hasExams(facts)
      ? `<div${st(h, [['margin', '24px 0 0 0'], ['padding', '16px 0 0 0'], ['color', cs.s.fg], ['border-top', `1px solid ${cs.border}`]])}>` +
        heading(h, 'h4', 'Respuestas explicadas', cs.s) +
        pHtml(h, labelHtml(examsTeacherNoteFor(facts)), cs.s, { last: true }) +
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
  const unlimited = examsHaveUnlimitedAttempts(facts);
  const inner =
    eyebrow(h, 'Solo docentes', cs.s) +
    heading(h, 'h4', 'Para docentes: respuestas explicadas', cs.s) +
    pHtml(h, labelHtml(EXAMS_TEACHER_NOTE_AVAILABILITY), cs.s) +
    pHtml(h, labelHtml(EXAMS_TEACHER_NOTE_ATTEMPTS), cs.s, { last: !unlimited && !courseHasGrades(facts) }) +
    (unlimited ? pHtml(h, labelHtml(EXAMS_TEACHER_NOTE_UNLIMITED), cs.s, { last: !courseHasGrades(facts) }) : '') +
    // r55 (R4): la regla real de aprobación también para el docente de un curso sin certificado.
    (courseHasGrades(facts) ? pHtml(h, labelHtml(courseApprovalTeacherNote(courseApprovalRequirements(facts))), cs.s, { last: true }) : '');
  return out('Para docentes: respuestas explicadas', root(h, 'shell-exams-teacher', box(h, inner, cs, { cls: 'cvc-exams-teacher' })), facts);
}
