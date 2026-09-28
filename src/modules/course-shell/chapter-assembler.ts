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
 *
 * Las transiciones son microcopy determinístico (microcopy.ts); el LLM nunca
 * escribe navegación ni nombra recursos (lo garantiza validateExperience).
 */
import type { ResolvedTheme } from '../theme-engine';
import { ChapterExperience, assertValidExperience, lintCleanSafe, renderMovement } from '../visual-components';
import { labelHtml, inlineHtml } from '../visual-components/text';
import type { ChapterFacts, CourseFacts, ModuleFacts } from './facts';
import {
  ShellRenderOptions,
  bgSurf,
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
import { COPY, activityInstruction, bridgeLead, continueWith, moduleExamTransition } from './microcopy';

export type ChapterSlot =
  | { kind: 'label'; role: ChapterLabelRole; name: string; html: string }
  | { kind: 'presentation' }
  | { kind: 'video_h5p' }
  | { kind: 'activity'; variant: 'h5p' | 'scorm' };

export type ChapterLabelRole =
  | 'opening'
  | 'deepening'
  | 'video_primer'
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
  theme: ResolvedTheme;
  options?: ShellRenderOptions;
}

/** Secuencia de slots (solo `kind`/`role`) — útil para tests y para R12. */
export function chapterSlotSequence(flags: { videoEnabled: boolean; activityEnabled: boolean }): string[] {
  const seq = ['label:opening', 'presentation', 'label:deepening'];
  if (flags.videoEnabled) seq.push('label:video_primer', 'video_h5p');
  seq.push('label:synthesis');
  if (flags.activityEnabled) seq.push('label:activity_instruction', 'activity');
  else seq.push('label:self_check');
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
  };
  const mv = (role: 'opening' | 'deepening' | 'video_primer' | 'synthesis' | 'self_check' | 'closing') =>
    renderMovement(exp.movements[role], theme, { uid: uid(role), level, opener: role === 'opening' ? opener : undefined });
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
  slots.push(label('opening', 'Apertura', injectIntoMovement(mv('opening'), head, '')));
  // [2] Presentación (obligatoria en V2.1).
  slots.push({ kind: 'presentation' });
  // [3] Profundización.
  slots.push(label('deepening', 'Profundización', mv('deepening')));
  // [4] Video: guía previa (plantilla + conceptos del LLM) + transición → video.
  if (ch.videoEnabled) {
    const before = eyebrow(h, 'Video interactivo', s) + heading(h, 'h3', COPY.videoPrimerTitle, s) + pHtml(h, labelHtml(COPY.videoPrimerLead), s);
    const after = transitionBox(h, pHtml(h, labelHtml(COPY.videoGo), alt, { last: true }));
    slots.push(label('video_primer', 'Antes del video', injectIntoMovement(mv('video_primer'), before, after)));
    slots.push({ kind: 'video_h5p' });
  }
  // [5] Síntesis.
  slots.push(label('synthesis', 'Síntesis', mv('synthesis')));
  // [6] Actividad (instrucción determinística con nota mínima/intentos de facts) o repaso no calificado.
  if (ch.activityEnabled) {
    const k = assessment.kinds.activity;
    const inner =
      eyebrow(h, 'Práctica calificada', s) +
      heading(h, 'h3', COPY.activityTitle, s) +
      pHtml(h, labelHtml(activityInstruction(k.passingGrade, k.attempts)), s, { last: true });
    slots.push(label('activity_instruction', 'Práctica', root(h, uid('activity_instruction'), inner)));
    slots.push({ kind: 'activity', variant: ch.activityVariant as 'h5p' | 'scorm' });
  } else {
    const before = pHtml(h, labelHtml(COPY.selfCheckLead), s);
    slots.push(label('self_check', 'Repaso', injectIntoMovement(mv('self_check'), before, '')));
  }
  // [7] Cierre + puente (LLM, sin recursos) + transiciones determinísticas.
  // M12: el puente del LLM ("a continuación…") solo cuando realmente sigue otro
  // capítulo; antes de un examen de módulo o al final del curso manda la
  // transición determinística (nunca dos mensajes de navegación contradictorios).
  const examNext = lastOfModule && mod.examEnabled;
  let after = input.nextChapter && !examNext ? paras(h, exp.bridge_to_next, s) : '';
  // R14-A (I5): la transición dice primero qué repasar/reintentar y después el siguiente paso,
  // sin repetir "Con este capítulo terminas…" dos veces.
  const bridgeLeadText = bridgeLead({ activityEnabled: ch.activityEnabled, activityAttempts: assessment.kinds.activity.attempts });
  let nextStep: string;
  if (examNext) {
    if (!Number.isInteger(mod.examQuestionCount) || (mod.examQuestionCount as number) < 1) {
      shellFail(`módulo ${mod.number} con examen sin cantidad de preguntas medida`);
    }
    const q = mod.examQuestionCount as number;
    const pg = assessment.kinds.exam.passingGrade;
    nextStep = input.nextChapter
      ? `${moduleExamTransition({ number: mod.number, examQuestionCount: q }, pg)} ${continueWith(input.nextChapter)}`
      : `${COPY.lastChapterOfCourse} A continuación encontrarás la evaluación del módulo ${mod.number}: ${q} ${q === 1 ? 'pregunta' : 'preguntas'} y una nota mínima de ${pg} de 100.`;
  } else {
    nextStep = input.nextChapter ? continueWith(input.nextChapter) : COPY.lastChapterOfCourse;
  }
  after += transitionBox(h, pHtml(h, labelHtml(bridgeLeadText), alt, { secondary: true }) + pHtml(h, inlineHtml(nextStep), alt, { last: true, weight: 600 }));
  slots.push(label('closing', 'Cierre', injectIntoMovement(mv('closing'), '', after)));
  return slots;
}

/** Slots de todos los capítulos del curso, en orden (atajo para R12 y los tests). */
export function assembleAllChapters(
  facts: CourseFacts,
  experiences: Record<string, ChapterExperience>,
  theme: ResolvedTheme,
  options?: ShellRenderOptions,
): Array<{ chapterNumber: number; slots: ChapterSlot[] }> {
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
        theme,
        options,
      }),
    };
  });
}
