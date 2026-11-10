/**
 * r107 B10 fix round 1 (P2-1) · TAMAÑO REAL de las llamadas de IA de una regeneración, ANTES de gastar: el prompt sale de
 * los MISMOS builders del generador (en el sandbox del ejecutor, sin red: `api()` lanza) y el `max_tokens` es el MISMO que
 * usa la llamada real. El estimado y la cota de cada línea de IA se calculan con estos tamaños (nunca con priors
 * genéricos), y se cuenta el reintento dirigido (`_dynV3JsonWithRetry` / el reintento de sala del motor SCORM v2).
 */
import { createExecutorSandbox } from '../../../workers/llm-executor/executor-runtime';
import { AudiobookSourceSection, planAudiobookSections, sectionNarrationPrompt, sectionTargetWords, AUDIOBOOK_PREV_TAIL_CHARS } from '../../../workers/provider-real/audio-scripts';
import type { WorkshopCourse } from '../course-model';
import { courseContextOf, outlineOf } from './scorm';
import type { ChapterSource, RegenDbSources } from './sources';
import { RegenTarget, SCORM_V2_ROOMS, SCORM_V2_TEMPLATE_IDS } from './types';
import { videoMaxMinutes } from './ports';

/** Lo que agrega un reintento dirigido al prompt base (hasta 30 errores de ~200 caracteres + instrucciones). */
export const RETRY_PROMPT_EXTRA_CHARS = 6000 + 800;
/** max_tokens de las llamadas reales del generador (45-dynamic-generation-executor.js). */
export const SCORM_ROOM_MAX_TOKENS = 4000;
export const PRACTICE_MAX_TOKENS = 5000;
export const VIDEO_INTERACTIONS_MAX_TOKENS = 4000;

export interface LlmCallSize {
  what: string;
  /** Caracteres del pedido principal (system + user). */
  promptChars: number;
  maxTokens: number;
  /** Caracteres del segundo pedido (reintento dirigido / continuación / condensación); null = no hay. */
  retryPromptChars: number | null;
  retryMaxTokens: number | null;
}

let sizerCtx: Record<string, any> | null = null;
function sizer(): Record<string, any> {
  if (sizerCtx) return sizerCtx;
  const sb = createExecutorSandbox({
    api: async () => { throw { fatal: true, msg: 'llm-sizes: sin IA (solo se miden prompts)' }; },
    artifactText: async () => null,
    ownerId: 'llm-sizes',
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  sizerCtx = sb.ctx;
  return sizerCtx;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v));

/** Tamaños de las llamadas de IA de una regeneración (vacío si la operación no usa IA). */
export function regenLlmSizes(t: RegenTarget, a: { course: WorkshopCourse; db: RegenDbSources | null; sources: ChapterSource[] }): LlmCallSize[] {
  const md = (n: number) => a.sources.find((s) => s.number === n)?.md ?? '';
  const out: LlmCallSize[] = [];
  switch (t.op) {
    case 'regenerate_scorm': {
      const ctx = sizer();
      const cc = courseContextOf(a.course, a.db);
      if (t.engine === 'scorm_v2') {
        const cap = { n: t.chapterNumber, t: t.chapterTitle };
        const outline = outlineOf(a.course);
        const sys = str(ctx.scormV2SysPrompt());
        const pool = t.mechanics.filter((m) => (SCORM_V2_TEMPLATE_IDS as readonly string[]).includes(m));
        // La sala más grande del conjunto (la asignación final depende del generador): cota conservadora por sala.
        const roomChars = Math.max(...(pool.length ? pool : [...SCORM_V2_TEMPLATE_IDS]).map((id) => str(ctx.dynScormV2RoomPrompt(id, cap, cc, outline, '')).length));
        for (let i = 0; i < SCORM_V2_ROOMS; i++) {
          out.push({ what: `sala ${i + 1}`, promptChars: sys.length + roomChars, maxTokens: SCORM_ROOM_MAX_TOKENS, retryPromptChars: sys.length + roomChars + RETRY_PROMPT_EXTRA_CHARS, retryMaxTokens: SCORM_ROOM_MAX_TOKENS });
        }
      } else {
        const cp = a.db?.contextPackage.get(t.chapterNumber) ?? null;
        const sys = str(ctx.dynH5pActivitySys());
        const p = str(ctx.dynH5pActivityPrompt(t.h5pType, md(t.chapterNumber), cp, { title: t.chapterTitle, objective: (cp as any)?.chapter?.objective ?? '' }));
        out.push({ what: `práctica ${t.h5pType}`, promptChars: sys.length + p.length, maxTokens: PRACTICE_MAX_TOKENS, retryPromptChars: sys.length + p.length + RETRY_PROMPT_EXTRA_CHARS, retryMaxTokens: PRACTICE_MAX_TOKENS });
      }
      break;
    }
    case 'regenerate_video': {
      const ctx = sizer();
      const text = md(t.chapterNumber);
      const words = text.split(/\s+/).filter(Boolean).length;
      // El plan de pausas de la duración MÁXIMA que cuenta la cota del render (más pausas = prompt más largo).
      const durationSec = videoMaxMinutes(words) * 60;
      const plan = ctx.dynPlanVideoCheckpoints(durationSec);
      const refl = t.advanced ? ctx.dynPlanReflectionPauses(durationSec, plan.checkpoints).reflections : undefined;
      const sys = str(ctx.dynVideoInteractionsSys());
      const p = str(ctx.dynVideoInteractionsPrompt(text, plan.checkpoints, refl, {}));
      out.push({ what: 'preguntas del video', promptChars: sys.length + p.length, maxTokens: VIDEO_INTERACTIONS_MAX_TOKENS, retryPromptChars: sys.length + p.length + RETRY_PROMPT_EXTRA_CHARS, retryMaxTokens: VIDEO_INTERACTIONS_MAX_TOKENS });
      break;
    }
    case 'regenerate_audio': {
      if (t.audio !== 'audiobook') break;
      for (const n of t.chapters) {
        const s = a.sources.find((x) => x.number === n);
        if (!s) continue;
        let sections: AudiobookSourceSection[];
        try { sections = planAudiobookSections(s.md).sections; } catch { continue; }
        const input = { courseTitle: a.course.course.title ?? '', chapterNumber: n, chapterTitle: s.title, contentMarkdown: s.md };
        sections.forEach((sec, i) => {
          const p = sectionNarrationPrompt(input, sec, sections.length, i ? 'x'.repeat(AUDIOBOOK_PREV_TAIL_CHARS) : null);
          const { max } = sectionTargetWords(sec.words);
          // UNA continuación (bloque corto) o UNA condensación (bloque largo): la condensación lleva el guion entero
          // (hasta `max` palabras, ~7 caracteres por palabra) + el bloque fuente.
          out.push({ what: `capítulo ${n}, bloque ${i + 1}`, promptChars: p.system.length + p.user.length, maxTokens: p.maxTokens, retryPromptChars: p.system.length + sec.text.length + max * 7 + 2000, retryMaxTokens: p.maxTokens });
        });
      }
      break;
    }
    default:
      break;
  }
  return out;
}
