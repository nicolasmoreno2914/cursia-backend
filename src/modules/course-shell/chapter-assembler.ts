/**
 * R11a — ensamblador determinístico del capítulo (audit §F.1–§F.3).
 *
 * Entrada: facts del capítulo y de su módulo, el `experience` validado (R2,
 * vcSchemaVersion 1) y el tema. Salida: slots ORDENADOS:
 *   { kind:'label', name, html }        — movimientos + transiciones de Cursia
 *   { kind:'presentation' }             — R12 renderiza la tarjeta de R9
 *   { kind:'video_h5p' }                — R12 emite el h5pactivity con la intro inline de R8
 *   { kind:'activity', variant }        — R12 emite el h5pactivity / SCORM
 *
 * Matriz ON/OFF (§F.3):
 *   V ON  A ON : opening · presentation · deepening · video_primer(+transición) · video_h5p · synthesis · activity_instruction · activity · closing(+puente)
 *   V OFF A ON : sin video_primer ni video_h5p
 *   V ON  A OFF: synthesis · self_check · closing (el puente dice "repasa")
 *   V OFF A OFF: opening · presentation · deepening · synthesis · self_check · closing
 * Último capítulo de un módulo CON examen: el cierre agrega la transición
 * "evaluación del módulo" (nunca se promete una evaluación inexistente).
 * EV6: el cierre termina con UN botón a la sección siguiente (`nextStep`, derivado del layout
 * de secciones): «Continuar con el capítulo N →», «Presentar evaluación del módulo M →»,
 * «Continuar con el módulo M: … →», «Ir a la evaluación final →» o «Ir al cierre del curso →».
 *
 * Las transiciones son microcopy determinístico (microcopy.ts); el LLM nunca
 * escribe navegación ni nombra recursos (lo garantiza validateExperience).
 */
import { moduleColor, ResolvedTheme } from '../theme-engine';
import { eduIcon, EduIcon, moduleTone, Tone } from '../visual-components/edu';
import { groundColor } from '../visual-components/render';
import { ChapterExperience, assertValidExperience, lintCleanSafe, renderMovement } from '../visual-components';
import { labelHtml, inlineHtml } from '../visual-components/text';
import type { ChapterFacts, CourseFacts, ModuleFacts } from './facts';
import {
  Hx,
  ShellRenderOptions,
  st,
  surfOn,
  bgSurf,
  box,
  eyebrow,
  heading,
  hx,
  injectIntoMovement,
  pHtml,
  paras,
  root,
  shellFail,
  toneSurf,
  transitionBox,
  unprotectedText,
} from './html';
import { COPY, activityTask, bridgeLead, moduleEndText, moduleExamTransition } from './microcopy';
import { CTA_ACTIVITY, ctaButton, ctaSection } from './cta';
import { ChapterNextStep, chapterNextSteps } from './section-layout';

export type ChapterSlot =
  | { kind: 'label'; role: ChapterLabelRole; name: string; html: string }
  | { kind: 'presentation' }
  | { kind: 'video_h5p' }
  | { kind: 'activity'; variant: 'h5p' | 'scorm' }
  /** EV6 H5P v2: «Repaso» opcional con Dialog Cards (sin nota); solo si chapterFacts.reviewCards. */
  | { kind: 'review_cards' };

export type ChapterLabelRole =
  | 'opening'
  | 'deepening'
  | 'video_primer'
  | 'video_pending'
  | 'synthesis'
  | 'activity_instruction'
  | 'self_check'
  | 'closing';

export interface AssembleChapterInput {
  chapterFacts: ChapterFacts;
  moduleFacts: ModuleFacts;
  experience: ChapterExperience;
  /** Nota mínima e intentos por tipo (facts.assessment). */
  assessment: CourseFacts['assessment'];
  isLastChapterOfModule: boolean;
  nextChapter?: { number: number; title: string } | null;
  /** EV6: destino del botón del cierre del capítulo (sección siguiente). */
  nextStep: ChapterNextStep;
  /** EV6 (fix 1, m3): facts.finalExam.enabled — el paso terminal debe coincidir con el curso. */
  finalExamEnabled: boolean;
  theme: ResolvedTheme;
  options?: ShellRenderOptions;
  /** P3 — total de capítulos del curso (facts.counts.chapters) para «Capítulo N de T»; omitido = sin «de T». */
  courseChapterCount?: number;
  /** P3 — capítulos del módulo (de facts) para el riel del cierre. */
  moduleChapters?: Array<{ number: number; title: string }>;
}

/** Secuencia de slots (solo `kind`/`role`) — útil para tests y para R12. */
export function chapterSlotSequence(flags: { videoEnabled: boolean; activityEnabled: boolean; videoPendingNotice?: boolean; reviewCards?: boolean }): string[] {
  const seq = ['label:opening', 'presentation', 'label:deepening'];
  if (flags.videoEnabled) seq.push('label:video_primer', 'video_h5p');
  else if (flags.videoPendingNotice) seq.push('label:video_pending');
  seq.push('label:synthesis');
  if (flags.activityEnabled) seq.push('label:activity_instruction', 'activity');
  else seq.push('label:self_check');
  if (flags.reviewCards) seq.push('review_cards');
  seq.push('label:closing');
  return seq;
}

function check(html: string, name: string): string {
  const lint = lintCleanSafe(html);
  if (!lint.ok) shellFail(`${name}: no pasa CLEAN_SAFE: ${lint.errors.slice(0, 3).map((e) => `${e.code} ${e.message}`).join('; ')}`);
  const bare = unprotectedText(html);
  if (bare.length) shellFail(`${name}: texto sin protección nolink: ${JSON.stringify(bare.slice(0, 3))}`);
  return html;
}

export function assembleChapter(input: AssembleChapterInput): ChapterSlot[] {
  const { chapterFacts: ch, moduleFacts: mod, assessment, theme } = input;
  if (!ch || !mod) shellFail('faltan chapterFacts/moduleFacts');
  if (ch.moduleId !== mod.id || !mod.chapterNumbers.includes(ch.number)) {
    shellFail(`el capítulo ${ch.number} no pertenece al módulo ${mod.number}`);
  }
  const lastOfModule = mod.chapterNumbers[mod.chapterNumbers.length - 1] === ch.number;
  if (lastOfModule !== !!input.isLastChapterOfModule) {
    shellFail(`isLastChapterOfModule=${input.isLastChapterOfModule} no coincide con facts (capítulo ${ch.number}, módulo ${mod.number})`);
  }
  if (input.nextChapter && (!Number.isInteger(input.nextChapter.number) || input.nextChapter.number !== ch.number + 1)) {
    shellFail(`nextChapter debe ser el capítulo ${ch.number + 1}`);
  }
  const step = input.nextStep;
  if (!step || !Number.isInteger(step.sectionNum) || step.sectionNum < 2) shellFail(`capítulo ${ch.number} sin paso siguiente (nextStep)`);
  if (!lastOfModule) {
    if (step.kind !== 'chapter' || !input.nextChapter || step.number !== input.nextChapter.number) {
      shellFail(`capítulo ${ch.number}: el paso siguiente debe ser el capítulo ${ch.number + 1} del mismo módulo (vino ${step.kind})`);
    }
  } else if (mod.examEnabled) {
    if (step.kind !== 'module_exam' || step.moduleNumber !== mod.number) shellFail(`capítulo ${ch.number}: el paso siguiente debe ser la evaluación del módulo ${mod.number} (vino ${step.kind})`);
  } else if (step.kind === 'chapter' || step.kind === 'module_exam') {
    shellFail(`capítulo ${ch.number}: último capítulo de un módulo sin examen con paso siguiente ${step.kind}`);
  } else if ((step.kind === 'module') !== !!input.nextChapter) {
    shellFail(`capítulo ${ch.number}: paso siguiente ${step.kind} incoherente con nextChapter`);
  } else if (step.kind === 'module' && step.number !== mod.number + 1) {
    shellFail(`capítulo ${ch.number}: el paso siguiente debe ser el módulo ${mod.number + 1} (vino ${step.number})`);
  } else if (step.kind !== 'module' && (step.kind === 'final_exam') !== (input.finalExamEnabled === true)) {
    shellFail(`capítulo ${ch.number}: paso ${step.kind} incoherente con el examen final del curso (${input.finalExamEnabled})`);
  }
  const exp = assertValidExperience(input.experience);
  if (exp.chapterId !== ch.id) shellFail(`experience.chapterId (${exp.chapterId}) ≠ capítulo ${ch.id}`);
  if (ch.activityEnabled && (ch.activityVariant !== 'h5p' && ch.activityVariant !== 'scorm')) {
    shellFail(`capítulo ${ch.number} con actividad pero sin variant`);
  }

  const h = hx(theme, input.options);
  const level = h.enh ? ('enhanced' as const) : undefined;
  // R14: el rol VA PRIMERO ("opening-ch8", no "ch8-opening"): el filtro de emoticones de Moodle
  // convierte "8-o" en una imagen DENTRO del atributo class/uid y rompe el HTML del capítulo 8/18/28….
  // Con el número al final nunca queda "<dígito>-<letra>" que forme un emoticón.
  const uid = (role: string) => `${role.replace(/_/g, '-')}-ch${ch.number}`;
  const opener = {
    kicker: `Módulo ${mod.number} · Capítulo ${ch.number}`,
    title: ch.title,
    numeral: ch.number < 10 ? `0${ch.number}` : String(ch.number),
    progress: input.courseChapterCount ? `Módulo ${mod.number} · Capítulo ${ch.number} de ${input.courseChapterCount}` : undefined,
    minutes: ch.estimatedMinutes,
  };
  const mc = moduleColor(theme, mod.number - 1);
  const mt = moduleTone(theme, mc, groundColor(theme));
  const fill = { bg: mt.fill, fg: mt.onFill };
  const mv = (role: 'opening' | 'deepening' | 'video_primer' | 'synthesis' | 'self_check' | 'closing') =>
    renderMovement(exp.movements[role], theme, { uid: uid(role), level, opener: role === 'opening' ? opener : undefined, module: mc });
  const label = (role: ChapterLabelRole, name: string, html: string): ChapterSlot => ({
    kind: 'label',
    role,
    name: `Capítulo ${ch.number} · ${name}`,
    html: check(html, `capítulo ${ch.number} ${role}`),
  });
  const s = bgSurf(h);
  const alt = s;

  const slots: ChapterSlot[] = [];
  // [1] Apertura: identificación determinística + movimiento opening.
  // R14-A: si el movimiento abre con un hero, el título del capítulo entra COMO apertura (pico
  // tipográfico, ctx.opener); si no, se antepone con la misma jerarquía (kicker + display).
  const opening = exp.movements.opening;
  const headsWithHero = Array.isArray(opening) && opening.length > 0 && (opening[0] as { type?: string }).type === 'hero';
  const head = headsWithHero ? '' : eyebrow(h, opener.kicker, s) + heading(h, 'h2', ch.title, s);
  const examNext = lastOfModule && mod.examEnabled;
  slots.push(label('opening', 'Apertura', injectIntoMovement(mv('opening'), head, chapterRoute(h, ch, examNext, mt))));
  // [2] Presentación (obligatoria en V2.1).
  slots.push({ kind: 'presentation' });
  // [3] Profundización.
  slots.push(label('deepening', 'Profundización', mv('deepening')));
  // [4] Video: guía previa (plantilla + conceptos del LLM) + transición → video.
  if (ch.videoEnabled) {
    const before = chipH(h, 'video', 'Video interactivo', mt, s) + heading(h, 'h3', COPY.videoPrimerTitle, s) + pHtml(h, labelHtml(COPY.videoPrimerLead), s);
    const after = transitionBox(h, pHtml(h, labelHtml(COPY.videoGo), alt, { last: true }), mt.ink);
    slots.push(label('video_primer', 'Antes del video', injectIntoMovement(mv('video_primer'), before, after)));
    slots.push({ kind: 'video_h5p' });
  } else if (ch.videoPendingNotice) {
    // EV6 T5 (ruling 3): video todavía de vista previa y los textos del curso lo mencionan →
    // aviso neutral en su lugar (nunca un video simulado, nunca un recorrido que lo prometa).
    if (!ch.videoPending) shellFail(`capítulo ${ch.number}: aviso de video pendiente sin video pendiente`);
    const cs = toneSurf(h, 'alt');
    const inner = box(h, eyebrow(h, 'Video interactivo', cs.s) + pHtml(h, labelHtml(COPY.videoPendingNotice), cs.s, { last: true }), cs, { cls: 'cvc-video-pending' });
    slots.push(label('video_pending', 'Video pendiente', root(h, uid('video_pending'), inner)));
  }
  // [5] Síntesis.
  slots.push(label('synthesis', 'Síntesis', mv('synthesis')));
  // [6] Actividad (instrucción determinística con nota mínima/intentos de facts) o repaso no calificado.
  if (ch.activityEnabled) {
    const k = assessment.kinds.activity;
    const pss = surfOn(h.t, mt.soft);
    const factsRow =
      `<p class="cvc-facts-row"${st(h, [['margin', '0 0 14px 0'], ['padding', 0], ['color', pss.fg], ['font-size', h.t.typography.sizeSmallPx], ['font-weight', '600'], ['line-height', '1.6']])}>` +
      // fix M1: separador visible «·» entre los dos datos (en CLEAN los espacios colapsan).
      `<span>${eduIcon(h.enh, 'check', mt.ink, 18)} ${labelHtml(`Nota mínima: ${k.passingGrade} de 100`)}</span><span class="cvc-sep"${st(h, [['color', pss.fg2]])}>${labelHtml(' · ')}</span>` +
      `<span>${eduIcon(h.enh, 'repaso', mt.ink, 18)} ${labelHtml(k.attempts === 0 ? 'Intentos: sin límite' : `Intentos: ${k.attempts}`)}</span></p>`;
    const inner = box(
      h,
      chipH(h, 'practica', `Práctica calificada · Capítulo ${ch.number}`, mt, pss, true) +
        heading(h, 'h3', COPY.activityTitle, pss) +
        factsRow +
        pHtml(h, labelHtml(activityTask(ch.activityVariant === 'scorm' ? 'scorm' : ch.activityType)), pss, { last: true }) +
        // Edu EV3: botón a la actividad (el builder resuelve el marcador al crearla).
        ctaButton(h, CTA_ACTIVITY, `Iniciar actividad →`, pss, fill),
      { s: pss, border: mt.edge },
      { cls: 'cvc-practice' },
    );
    slots.push(label('activity_instruction', 'Práctica', root(h, uid('activity_instruction'), inner)));
    slots.push({ kind: 'activity', variant: ch.activityVariant as 'h5p' | 'scorm' });
  } else {
    const before = pHtml(h, labelHtml(COPY.selfCheckLead), s);
    slots.push(label('self_check', 'Repaso', injectIntoMovement(mv('self_check'), before, '')));
  }
  // EV6 H5P v2: «Repaso» opcional (Dialog Cards desde la experiencia) antes del cierre. Sin nota.
  if (ch.reviewCards === true) slots.push({ kind: 'review_cards' });
  // [7] Cierre + puente (LLM, sin recursos) + transiciones determinísticas.
  // M12: el puente del LLM ("a continuación…") solo cuando realmente sigue otro
  // capítulo; antes de un examen de módulo o al final del curso manda la
  // transición determinística (nunca dos mensajes de navegación contradictorios).
  let after = input.nextChapter && !examNext ? `<div class="cvc-bridge"${st(h, [['margin', '28px 0 0 0'], ['color', s.fg]])}>${paras(h, exp.bridge_to_next, s)}</div>` : '';
  // R14-A (I5): la transición dice primero qué repasar/reintentar y después el siguiente paso,
  // sin repetir "Con este capítulo terminas…" dos veces.
  const bridgeLeadText = bridgeLead({ activityEnabled: ch.activityEnabled, activityAttempts: assessment.kinds.activity.attempts });
  // EV6: el texto dice qué viene y el BOTÓN (elemento dominante) lleva a la sección siguiente.
  let nextText: string;
  let button: string;
  if (step.kind === 'module_exam') {
    if (!Number.isInteger(mod.examQuestionCount) || (mod.examQuestionCount as number) < 1) {
      shellFail(`módulo ${mod.number} con examen sin cantidad de preguntas medida`);
    }
    const q = mod.examQuestionCount as number;
    const pg = assessment.kinds.exam.passingGrade;
    // EV5: solo la evaluación. El paso siguiente (módulo o cierre) lo da el label module_next
    // después del examen; antes esta línea anunciaba el examen Y «Continúa con el capítulo…».
    nextText = moduleExamTransition({ number: mod.number, examQuestionCount: q }, pg);
    button = `Presentar evaluación del módulo ${mod.number} →`;
  } else if (step.kind === 'chapter') {
    // Fix 1 (m5): sin línea «Lo que sigue…»: el botón ya lo dice.
    nextText = '';
    button = `Continuar con el capítulo ${step.number} →`;
  } else if (step.kind === 'module') {
    nextText = moduleEndText(mod.number);
    button = `Continuar con el módulo ${step.number}: ${step.title} →`;
  } else {
    nextText = COPY.lastChapterOfCourse;
    button = step.kind === 'final_exam' ? 'Ir a la evaluación final →' : 'Ir al cierre del curso →';
  }
  after += moduleRail(h, mod, ch, input.moduleChapters, mt);
  after += transitionBox(
    h,
    pHtml(h, labelHtml(bridgeLeadText), alt, nextText ? { secondary: true } : { secondary: true, last: true }) +
      (nextText ? pHtml(h, inlineHtml(nextText), alt, { last: true }) : '') +
      ctaButton(h, ctaSection(step.sectionNum), button, alt, fill),
    mt.ink,
  );
  slots.push(label('closing', 'Cierre', injectIntoMovement(mv('closing'), '', after)));
  return slots;
}

/**
 * EV4b — «En este capítulo»: el recorrido del capítulo al final de la apertura, armado SOLO con los
 * flags del capítulo (nunca nombra un recurso que no existe). El estudiante sabe qué viene y en qué
 * orden, como en un curso, no como en un artículo.
 */
function chapterRoute(h: Hx, ch: ChapterFacts, examNext: boolean, mt: Tone): string {
  const steps: Array<[EduIcon, string]> = [['presentacion', 'Presentación'], ['libro', 'Profundización']];
  if (ch.videoEnabled) steps.push(['video', 'Video interactivo']);
  steps.push(['logro', 'Síntesis']);
  steps.push(ch.activityEnabled ? ['practica', 'Práctica calificada'] : ['repaso', 'Repaso']);
  if (examNext) steps.push(['examen', 'Evaluación del módulo']);
  const s = bgSurf(h);
  const items = steps
    .map(([ic, x]) => `<li${st(h, [['margin', '0 0 6px 0'], ['padding', 0], ['color', s.fg], ['font-weight', '600']])}>${eduIcon(h.enh, ic, mt.ink, 20)} ${labelHtml(x)}</li>`)
    .join('');
  return (
    `<div class="cvc-route"${st(h, [['margin', '24px 0 0 0'], ['padding', '16px 0 0 0'], ['color', s.fg], ['border-top', `1px solid ${h.t.color.border}`]])}>` +
    eyebrow(h, 'Tu recorrido en este capítulo', s, { color: mt.ink, sentence: true }) +
    `<ol class="cvc-route-steps"${st(h, [['list-style', 'none'], ['margin', 0], ['padding', 0]])}>${items}</ol></div>`
  );
}

/** P3 — rótulo (ícono + etiqueta) del shell, mismo lenguaje que los bloques. */
function chipH(h: Hx, icon: EduIcon, text: string, mt: Tone, s: { bg: string; fg: string }, onPanel = false): string {
  const ink = mt.ink;
  return (
    `<p class="cvc-meta cvc-chip"${st(
      h,
      [['margin', '0 0 12px 0'], ['color', ink], ['font-size', h.t.typography.sizeSmallPx], ['font-weight', '700'], ['line-height', '1.4']],
      [['display', 'inline-flex'], ['align-items', 'center'], ['gap', '8px'], ['background-color', onPanel ? groundColor(h.t) : mt.soft], ['padding', '5px 14px 5px 10px'], ['border-radius', '999px']],
    )}>${eduIcon(h.enh, icon, ink, 20)} ${labelHtml(text)}</p>`
  );
}

/**
 * P3 — «Dónde estás en el módulo»: posición del capítulo en su módulo (de facts), nunca datos del
 * estudiante. El capítulo actual va relleno con el color del módulo; los demás, delineados.
 */
function moduleRail(h: Hx, mod: ModuleFacts, ch: ChapterFacts, chapters: Array<{ number: number; title: string }> | undefined, mt: Tone): string {
  if (!chapters || !chapters.length) return '';
  const s = bgSurf(h);
  // fix M4: MISMO markup en ambos niveles — número en la línea del título (CLEAN_SAFE: «1 Título»); en
  // ENHANCED el <style> del label lo dibuja como insignia (rellena en el capítulo actual).
  const num = (inner: string) => `<strong class="cvc-n"${st(h, [['color', mt.ink]])}>${inner}</strong> `;
  const items = chapters
    .map((c) => {
      const cur = c.number === ch.number;
      return (
        `<li${cur ? ' class="cvc-cur"' : ''}${st(h, [['margin', '0 0 10px 0'], ['padding', 0], ['color', cur ? s.fg : s.fg2], ['font-weight', cur ? '700' : '400'], ['line-height', '1.4']])}>` +
        num(labelHtml(String(c.number))) +
        `<span class="cvc-t">${labelHtml(c.title)}${cur ? `<span${st(h, [['color', mt.ink], ['font-weight', '700']])}>${labelHtml(' · estás aquí')}</span>` : ''}</span></li>`
      );
    })
    .join('');
  const exam = mod.examEnabled
    ? `<li${st(h, [['margin', '0'], ['padding', 0], ['color', s.fg2], ['line-height', '1.4']])}>${num(eduIcon(h.enh, 'examen', mt.ink, 18))}<span class="cvc-t">${labelHtml(`Evaluación del módulo ${mod.number}`)}</span></li>`
    : '';
  return (
    `<div class="cvc-modrail"${st(h, [['margin', '40px 0 0 0'], ['padding', '20px 0 0 0'], ['color', s.fg], ['border-top', `1px solid ${h.t.color.border}`]])}>` +
    eyebrow(h, `Dónde estás · Módulo ${mod.number}: ${mod.title}`, s, { color: mt.ink, sentence: true }) +
    `<ol class="cvc-mrail"${st(h, [['list-style', 'none'], ['margin', '12px 0 0 0'], ['padding', 0]])}>${items}${exam}</ol></div>`
  );
}

/** Slots de todos los capítulos del curso, en orden (atajo para R12 y los tests). */
export function assembleAllChapters(
  facts: CourseFacts,
  experiences: Record<string, ChapterExperience>,
  theme: ResolvedTheme,
  options?: ShellRenderOptions,
): Array<{ chapterNumber: number; slots: ChapterSlot[] }> {
  const steps = chapterNextSteps(facts);
  return facts.chapters.map((ch, i) => {
    const mod = facts.modules.find((m) => m.id === ch.moduleId);
    if (!mod) shellFail(`módulo ${ch.moduleId} ausente en facts`);
    const next = facts.chapters[i + 1];
    const exp = experiences[ch.id];
    if (!exp) shellFail(`falta el experience del capítulo ${ch.number}`);
    return {
      chapterNumber: ch.number,
      slots: assembleChapter({
        chapterFacts: ch,
        moduleFacts: mod,
        experience: exp,
        assessment: facts.assessment,
        isLastChapterOfModule: mod.chapterNumbers[mod.chapterNumbers.length - 1] === ch.number,
        nextChapter: next ? { number: next.number, title: next.title } : null,
        nextStep: steps[ch.id],
        finalExamEnabled: facts.finalExam.enabled,
        theme,
        options,
        courseChapterCount: facts.counts.chapters,
        moduleChapters: facts.chapters.filter((x) => x.moduleId === mod.id).map((x) => ({ number: x.number, title: x.title })),
      }),
    };
  });
}

