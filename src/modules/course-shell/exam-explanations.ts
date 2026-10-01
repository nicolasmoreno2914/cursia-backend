/**
 * EV6 P2-B4 — «Respuestas explicadas»: página (mod_page) que sigue a cada evaluación y la nota
 * para docentes sobre su acceso condicional (P2-design §1.3, §2.3, rulings 1–3).
 *
 *  - La página se desbloquea al APROBAR o al AGOTAR los intentos (availability del builder); el
 *    estudiante nunca la ve antes. Su contenido es HTML con estilos inline SOLO de la base
 *    CLEAN_SAFE: sin <style>, <script> ni <details> (format_text de Moodle los quita), mismo
 *    tema, mismos rótulos por rol (P3) y todo texto protegido con `nolink`.
 *  - Banco (`dynamic_exam_bank_json`): agrupado por capítulo (examen de módulo) o por módulo
 *    (examen final) en el orden del plan; por pregunta: enunciado, respuesta correcta, «Por qué»
 *    (explicación) y, en selección múltiple, cada distractor con su `why`; V/F: el valor correcto
 *    y el `whyWrong` del otro; emparejamiento: «definición → término» (la orientación que el
 *    estudiante vio en el quiz, P2-B3 fix 1).
 *  - GIFT (artifacts viejos): enunciado + respuesta correcta, sin grupos ni «Por qué».
 *  - Los textos del banco son del LLM: aquí NO aplica el lint de cifras de facts (un enunciado
 *    puede decir «5 mg/L»); sí CLEAN_SAFE y la protección nolink.
 */
import type { ResolvedTheme } from '../theme-engine';
import { contrastRatio, moduleColor } from '../theme-engine';
import { lintCleanSafe } from '../visual-components';
import { eduIcon, EduIcon, moduleTone, roleTone, Tone } from '../visual-components/edu';
import { groundColor } from '../visual-components/render';
import { inlineHtml, labelHtml } from '../visual-components/text';
import type { GiftQuestion } from '../../package/mbz-common';
import type { ExamBankQuestion, ExamBankV1 } from './exam-bank';
import { EXAM_QUESTION_TYPES } from './exam-bank';
import { Hx, Surf, bgSurf, eyebrow, hx, pHtml, root, shellFail, st, unprotectedText } from './html';

/**
 * EV6 P2-B4 (P2-design §1.3, ruling 1): con intentos limitados la página se desbloquea si el quiz está
 * completo (e=1, que también acepta COMPLETE_PASS) O completo-y-reprobado (e=3 = intentos agotados,
 * gracias a completionattemptsexhausted=1). `show:false`: oculta hasta entonces.
 * Fix 1 (C1): con intentos ILIMITADOS (attempts 0) B1 emite completionattemptsexhausted=0 y Moodle marca
 * COMPLETE_FAIL tras UN intento reprobado → e=3 abriría el banco y el estudiante reintentaría con las
 * respuestas. Ahí la condición es SOLO aprobar (e=1).
 */
export function examExplanationsAvailability(quizMid: number, attempts: number): string {
  if (!Number.isInteger(quizMid) || quizMid < 1) throw new Error(`MBZ_V3_INVARIANT: moduleid de quiz inválido (${quizMid})`);
  if (!Number.isInteger(attempts) || attempts < 0) throw new Error(`MBZ_V3_INVARIANT: intentos inválidos (${attempts})`);
  if (attempts === 0) return `{"op":"|","show":false,"c":[{"type":"completion","cm":${quizMid},"e":1}]}`;
  return `{"op":"|","show":false,"c":[{"type":"completion","cm":${quizMid},"e":1},{"type":"completion","cm":${quizMid},"e":3}]}`;
}

/** Nombre de la página (P2-task-B4 §1). */
export function examExplanationsName(scope: { kind: 'module'; moduleNumber: number } | { kind: 'final' }): string {
  return scope.kind === 'final' ? 'Respuestas explicadas — Evaluación final' : `Respuestas explicadas — Evaluación del módulo ${scope.moduleNumber}`;
}

/** Nombre corto con el que el resto del curso la anuncia. */
export const EXAM_EXPLANATIONS_SHORT = 'Respuestas explicadas';

export const EXAM_EXPLANATIONS_LEAD_BANK = 'Aquí tienes todas las preguntas de esta evaluación con su respuesta correcta y la explicación.';
export const EXAM_EXPLANATIONS_LEAD_GIFT = 'Aquí tienes todas las preguntas de esta evaluación con su respuesta correcta.';

/** Rulings 2 + 3: texto EXACTO de la nota para docentes (dos oraciones). */
export const EXAMS_TEACHER_NOTE_AVAILABILITY =
  'Las páginas de “Respuestas explicadas” necesitan el acceso condicional de Moodle activado; si un estudiante las ve antes de presentar la evaluación, actívalo en Administración del sitio. ' +
  'Si el curso ya se restauró con el acceso condicional desactivado, actívalo y vuelve a restaurar el curso, o agrega a cada página “Respuestas explicadas” la restricción “Finalización de actividad” de su evaluación.';
export const EXAMS_TEACHER_NOTE_ATTEMPTS =
  'Dar intentos adicionales a un estudiante que agotó una evaluación sin aprobar es decisión tuya: ten en cuenta que ya pudo leer sus “Respuestas explicadas”.';
export const EXAMS_TEACHER_NOTE = `${EXAMS_TEACHER_NOTE_AVAILABILITY} ${EXAMS_TEACHER_NOTE_ATTEMPTS}`;

/**
 * Línea del label de información del examen (P2-task-B4 §4), de facts: intentos > 0 → «… cuando
 * apruebes o cuando uses tus N intentos.»; 0 (ilimitados) → «… cuando apruebes.». Con un GIFT
 * (sin explicaciones) no promete «su explicación».
 */
export function examExplanationsInfoText(attempts: number, explained: boolean): string {
  if (!Number.isInteger(attempts) || attempts < 0) shellFail(`intentos inválidos (${attempts})`);
  const what = explained ? 'Las respuestas correctas y su explicación se habilitan' : 'Las respuestas correctas se habilitan';
  const when = attempts === 0 ? 'cuando apruebes' : attempts === 1 ? 'cuando apruebes o cuando uses tu único intento' : `cuando apruebes o cuando uses tus ${attempts} intentos`;
  return `Al terminar cada intento verás tu calificación. ${what} en «${EXAM_EXPLANATIONS_SHORT}» ${when}.`;
}

// ─── Render ───────────────────────────────────────────────────────────────

export type ExamExplanationsScope = { kind: 'module'; moduleNumber: number; title: string } | { kind: 'final' };

export interface ExamExplanationsBankInput {
  scope: ExamExplanationsScope;
  bank: ExamBankV1;
  /** Grupos (capítulos | módulos) en orden del Manifest: los MISMOS que las categorías padre del quiz. */
  groups: Array<{ ownerId: string; name: string }>;
}

export interface ExamExplanationsGiftInput {
  scope: ExamExplanationsScope;
  questions: GiftQuestion[];
}

export interface ExamExplanationsPage {
  name: string;
  html: string;
}

function ink(bg: string, cands: string[], fallback: string): string {
  return cands.find((c) => contrastRatio(c, bg) >= 4.5) ?? fallback;
}

/** Tono de la página: el del módulo (examen de módulo) o el acento del curso (final). */
function pageTone(theme: ResolvedTheme, scope: ExamExplanationsScope): Tone {
  if (scope.kind === 'module') return moduleTone(theme, moduleColor(theme, scope.moduleNumber - 1), groundColor(theme));
  const c = theme.color;
  return { ink: c.accentStrong, soft: c.accentSoft, edge: c.border, fill: c.accentStrong, onFill: c.textOnAccent };
}

/** Rótulo (ícono + texto) en el color de un rol; CLEAN_SAFE (glifo, sin píldora). */
function roleLine(h: Hx, icon: EduIcon, color: string, label: string, s: Surf, bodyHtml: string, last = false): string {
  const c = ink(s.bg, [color], s.fg);
  return (
    `<p${st(h, [['margin', last ? '0' : '0 0 8px 0'], ['padding', 0], ['color', s.fg], ['font-size', h.t.typography.sizeBodyPx], ['line-height', String(h.t.typography.lineBody)], ['max-width', `${h.t.typography.measureCh}ch`]])}>` +
    `${eduIcon(h.enh, icon, c, 18)} <strong${st(h, [['color', c]])}>${labelHtml(`${label}: `)}</strong>${bodyHtml}</p>`
  );
}

function subList(h: Hx, items: string[], s: Surf): string {
  return (
    `<ul${st(h, [['margin', '0 0 8px 0'], ['padding', '0 0 0 24px'], ['list-style', 'disc']])}>` +
    items.map((it) => `<li${st(h, [['margin', '0 0 6px 0'], ['padding', 0], ['color', s.fg]])}>${it}</li>`).join('') +
    `</ul>`
  );
}

/** Una pregunta = fila con filete superior: número, enunciado y respuestas. */
function questionRow(h: Hx, n: number, stemHtml: string, bodyHtml: string, s: Surf, tone: Tone): string {
  const numColor = ink(s.bg, [tone.ink], s.fg);
  return (
    `<li class="cvc-qa"${st(h, [['margin', 0], ['padding', '18px 0'], ['color', s.fg], ['border-top', `1px solid ${h.t.color.border}`]])}>` +
    `<p class="cvc-meta"${st(h, [['margin', '0 0 6px 0'], ['padding', 0], ['color', numColor], ['font-size', h.t.typography.sizeSmallPx], ['font-weight', '700'], ['line-height', '1.4']])}>${labelHtml(`Pregunta ${n}`)}</p>` +
    `<p${st(h, [['margin', '0 0 10px 0'], ['padding', 0], ['color', s.fg], ['font-size', h.t.typography.sizeBodyPx], ['font-weight', '600'], ['line-height', String(h.t.typography.lineBody)], ['max-width', `${h.t.typography.measureCh}ch`]])}>${stemHtml}</p>` +
    bodyHtml +
    `</li>`
  );
}

function questionList(h: Hx, rowsHtml: string): string {
  return `<ol class="cvc-qa-list"${st(h, [['list-style', 'none'], ['margin', '0 0 24px 0'], ['padding', 0], ['border-bottom', `1px solid ${h.t.color.border}`]])}>${rowsHtml}</ol>`;
}

function bankQuestionBody(h: Hx, q: ExamBankQuestion, s: Surf): string {
  const ok = roleTone(h.t, 'ejemplo').ink;
  const why = roleTone(h.t, 'concepto').ink;
  const bad = roleTone(h.t, 'error').ink;
  const explanation = roleLine(h, 'concepto', why, 'Por qué', s, inlineHtml(q.explanation));
  if (q.type === 'multichoice') {
    const others = q.distractors.map((d) => `<strong>${inlineHtml(d.text)}</strong>${labelHtml(' — ')}${inlineHtml(d.why)}`);
    return (
      roleLine(h, 'check', ok, 'Respuesta correcta', s, inlineHtml(q.correct.text)) +
      explanation +
      roleLine(h, 'error', bad, 'Las otras opciones', s, '') +
      subList(h, others, s)
    );
  }
  if (q.type === 'truefalse') {
    const right = q.answer ? 'Verdadero' : 'Falso';
    const wrong = q.answer ? 'Falso' : 'Verdadero';
    return (
      roleLine(h, 'check', ok, 'Respuesta correcta', s, labelHtml(right)) +
      explanation +
      roleLine(h, 'error', bad, `Por qué no es «${wrong}»`, s, inlineHtml(q.whyWrong), true)
    );
  }
  // match: definición → término (la orientación del quiz).
  const pairs = q.pairs.map((p) => `${inlineHtml(p.definition)}${labelHtml(' → ')}<strong>${inlineHtml(p.term)}</strong>`);
  return roleLine(h, 'check', ok, 'Pares correctos (definición → término)', s, '') + subList(h, pairs, s) + explanation;
}

function giftQuestionBody(h: Hx, q: GiftQuestion, s: Surf): string {
  const ok = roleTone(h.t, 'ejemplo').ink;
  if (q.type === 'truefalse') return roleLine(h, 'check', ok, 'Respuesta correcta', s, labelHtml(q.answer ? 'Verdadero' : 'Falso'), true);
  if (q.type === 'multichoice') {
    const right = q.options.filter((o) => o.correct).map((o) => o.text);
    if (!right.length) shellFail(`pregunta GIFT sin respuesta correcta: ${q.text.slice(0, 60)}`);
    if (right.length === 1) return roleLine(h, 'check', ok, 'Respuesta correcta', s, inlineHtml(right[0]), true);
    return roleLine(h, 'check', ok, 'Respuestas correctas', s, '') + subList(h, right.map((t) => inlineHtml(t)), s);
  }
  if (q.type === 'shortanswer') {
    if (q.answers.length === 1) return roleLine(h, 'check', ok, 'Respuesta correcta', s, inlineHtml(q.answers[0]), true);
    return roleLine(h, 'check', ok, 'Respuestas aceptadas', s, '') + subList(h, q.answers.map((t) => inlineHtml(t)), s);
  }
  // match (GIFT: subpregunta → respuesta, sin cambios).
  return roleLine(h, 'check', ok, 'Respuesta correcta', s, '') + subList(h, q.pairs.map((p) => `${inlineHtml(p.q)}${labelHtml(' → ')}<strong>${inlineHtml(p.a)}</strong>`), s);
}

/**
 * Fix 1 (M1): Moodle ya imprime el nombre de la página («Respuestas explicadas — Evaluación …») como
 * encabezado; el contenido abre solo con el rótulo (ícono + evaluación) y el lead, sin repetir un h3.
 */
function header(h: Hx, scope: ExamExplanationsScope, tone: Tone, leadText: string, s: Surf): string {
  const c = ink(s.bg, [tone.ink], s.fg);
  const what = scope.kind === 'final' ? 'Evaluación final' : `Evaluación del módulo ${scope.moduleNumber}: ${scope.title}`;
  const chip =
    `<p class="cvc-meta cvc-chip"${st(h, [['margin', '0 0 12px 0'], ['color', c], ['font-size', h.t.typography.sizeSmallPx], ['font-weight', '700'], ['line-height', '1.4']])}>` +
    `${eduIcon(h.enh, 'examen', c, 20)} ${inlineHtml(what)}</p>`;
  return chip + pHtml(h, labelHtml(leadText), s, { secondary: true });
}

function finish(name: string, uid: string, h: Hx, inner: string): ExamExplanationsPage {
  const html = root(h, uid, inner);
  if (/<(style|script|details)\b/i.test(html)) shellFail(`${name}: la página lleva <style>/<script>/<details>`);
  const lint = lintCleanSafe(html);
  if (!lint.ok) shellFail(`${name}: no pasa CLEAN_SAFE: ${lint.errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join('; ')}`);
  const unprotected = unprotectedText(html);
  if (unprotected.length > 0) shellFail(`${name}: texto sin protección nolink: ${JSON.stringify(unprotected.slice(0, 3))}`);
  return { name, html };
}

function uidFor(scope: ExamExplanationsScope): string {
  return scope.kind === 'final' ? 'exam-explanations-final' : `exam-explanations-${scope.moduleNumber}`;
}

function nameFor(scope: ExamExplanationsScope): string {
  return examExplanationsName(scope.kind === 'final' ? { kind: 'final' } : { kind: 'module', moduleNumber: scope.moduleNumber });
}

/**
 * Página de un banco: TODAS las preguntas del banco (no solo las sorteadas), agrupadas por el dueño
 * de su hoja (capítulo | módulo) en el orden de `groups` y, dentro, por tipo en el orden del plan.
 * Falla fuerte si una pregunta no cae en ningún grupo (nunca se omite una en silencio).
 */
export function examExplanationsBankPage(input: ExamExplanationsBankInput, theme: ResolvedTheme): ExamExplanationsPage {
  const { bank, groups, scope } = input;
  if (!bank || !Array.isArray(bank.questions) || !bank.questions.length) shellFail('respuestas explicadas: banco vacío');
  if (!groups.length) shellFail('respuestas explicadas: sin grupos');
  const h = hx(theme); // CLEAN_SAFE: la página nunca lleva <style>.
  const s = bgSurf(h);
  const tone = pageTone(theme, scope);
  const owner = (q: ExamBankQuestion): string => (bank.scope === 'final' ? (q.moduleId as string) : q.chapterId);
  const seen = new Set<string>();
  let n = 0;
  let body = '';
  for (const g of groups) {
    const qs = EXAM_QUESTION_TYPES.flatMap((t) => bank.questions.filter((q) => q.type === t && owner(q) === g.ownerId));
    if (!qs.length) continue;
    const rowsHtml = qs
      .map((q) => {
        seen.add(q.id);
        return questionRow(h, ++n, inlineHtml(q.stem), bankQuestionBody(h, q, s), s, tone);
      })
      .join('');
    body += `<div class="cvc-qa-group"${st(h, [['margin', '28px 0 0 0'], ['padding', 0], ['color', s.fg]])}>` + eyebrow(h, g.name, s, { color: tone.ink, sentence: true }) + questionList(h, rowsHtml) + `</div>`;
  }
  const lost = bank.questions.filter((q) => !seen.has(q.id)).map((q) => q.id);
  if (lost.length) shellFail(`respuestas explicadas: preguntas sin grupo (${lost.join(', ')})`);
  const name = nameFor(scope);
  return finish(name, uidFor(scope), h, header(h, scope, tone, EXAM_EXPLANATIONS_LEAD_BANK, s) + body);
}

/** Página de un GIFT (artifacts viejos): enunciado + respuesta correcta, sin grupos ni explicación. */
export function examExplanationsGiftPage(input: ExamExplanationsGiftInput, theme: ResolvedTheme): ExamExplanationsPage {
  if (!input.questions.length) shellFail('respuestas explicadas: GIFT sin preguntas');
  const h = hx(theme);
  const s = bgSurf(h);
  const tone = pageTone(theme, input.scope);
  const rowsHtml = input.questions.map((q, i) => questionRow(h, i + 1, inlineHtml(q.text), giftQuestionBody(h, q, s), s, tone)).join('');
  const name = nameFor(input.scope);
  return finish(name, uidFor(input.scope), h, header(h, input.scope, tone, EXAM_EXPLANATIONS_LEAD_GIFT, s) + questionList(h, rowsHtml));
}
