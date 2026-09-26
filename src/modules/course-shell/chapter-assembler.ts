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
import { escapeHtml, inlineHtml } from '../visual-components/text';
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
} from './html';
import { COPY, activityInstruction, bridgeText, moduleExamTransition } from './microcopy';

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
  const uid = (role: string) => `ch${ch.number}-${role.replace(/_/g, '-')}`;
  const mv = (role: 'opening' | 'deepening' | 'video_primer' | 'synthesis' | 'self_check' | 'closing') =>
    renderMovement(exp.movements[role], theme, { uid: uid(role), level });
  const label = (role: ChapterLabelRole, name: string, html: string): ChapterSlot => ({
    kind: 'label',
    role,
    name: `Capítulo ${ch.number} · ${name}`,
    html: check(html, `capítulo ${ch.number} ${role}`),
  });
  const s = bgSurf(h);
  const alt = toneSurf(h, 'alt').s;

  const slots: ChapterSlot[] = [];
  // [1] Apertura: identificación determinística + movimiento opening.
  const head = eyebrow(h, `Módulo ${mod.number} · Capítulo ${ch.number}`, s) + heading(h, 'h2', ch.title, s);
  slots.push(label('opening', 'Apertura', injectIntoMovement(mv('opening'), head, '')));
  // [2] Presentación (obligatoria en V2.1).
  slots.push({ kind: 'presentation' });
  // [3] Profundización.
  slots.push(label('deepening', 'Profundización', mv('deepening')));
  // [4] Video: guía previa (plantilla + conceptos del LLM) + transición → video.
  if (ch.videoEnabled) {
    const before = heading(h, 'h3', COPY.videoPrimerTitle, s) + pHtml(h, escapeHtml(COPY.videoPrimerLead), s);
    const after = transitionBox(h, pHtml(h, escapeHtml(COPY.videoGo), alt, { last: true }));
    slots.push(label('video_primer', 'Antes del video', injectIntoMovement(mv('video_primer'), before, after)));
    slots.push({ kind: 'video_h5p' });
  }
  // [5] Síntesis.
  slots.push(label('synthesis', 'Síntesis', mv('synthesis')));
  // [6] Actividad (instrucción determinística con nota mínima/intentos de facts) o repaso no calificado.
  if (ch.activityEnabled) {
    const k = assessment.kinds.activity;
    const inner = transitionBox(
      h,
      heading(h, 'h3', COPY.activityTitle, alt) + pHtml(h, escapeHtml(activityInstruction(k.passingGrade, k.attempts)), alt, { last: true }),
    );
    slots.push(label('activity_instruction', 'Práctica', root(h, uid('activity_instruction'), inner)));
    slots.push({ kind: 'activity', variant: ch.activityVariant as 'h5p' | 'scorm' });
  } else {
    const before = pHtml(h, escapeHtml(COPY.selfCheckLead), s);
    slots.push(label('self_check', 'Repaso', injectIntoMovement(mv('self_check'), before, '')));
  }
  // [7] Cierre + puente (LLM, sin recursos) + transiciones determinísticas.
  let after = paras(h, exp.bridge_to_next, s);
  const bridge: string[] = [];
  if (lastOfModule && mod.examEnabled) {
    if (!Number.isInteger(mod.examQuestionCount) || (mod.examQuestionCount as number) < 1) {
      shellFail(`módulo ${mod.number} con examen sin cantidad de preguntas medida`);
    }
    bridge.push(moduleExamTransition({ number: mod.number, examQuestionCount: mod.examQuestionCount as number }, assessment.kinds.exam.passingGrade));
  }
  bridge.push(bridgeText({ activityEnabled: ch.activityEnabled, next: input.nextChapter ?? null }));
  after += transitionBox(h, bridge.map((b, i) => pHtml(h, inlineHtml(b), alt, { last: i === bridge.length - 1 })).join(''));
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
