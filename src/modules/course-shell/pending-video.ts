/**
 * EV6 T5 (ruling 3) — videos pendientes (vista previa) en un paquete v3.
 *
 * Un capítulo cuyo video todavía es de vista previa se empaqueta SIN video. Si algún texto
 * generado que el paquete publica menciona ese video (experience del capítulo — sin el
 * movimiento `video_primer`, que no se publica —, la presentación de su módulo o la del
 * curso), el capítulo lleva el aviso neutral `COPY.videoPendingNotice` en lugar del video, así
 * el texto sigue siendo verdadero y la descarga nunca se bloquea. Pura y determinística.
 *
 * Hoy es una defensa: los textos publicados del LLM ya pasan RESOURCE_MENTION al aceptarse y al
 * ensamblarse (assertValidExperience / assertValid*IntroV3), así que en la práctica ninguno
 * nombra el video. Las referencias bibliográficas (sin lint, solo van al Libro Guía) no cuentan.
 */
import { lintResourceMentions } from '../visual-components';

/** Todas las cadenas de un JSON (valores, nunca claves), en orden de recorrido. */
function strings(v: unknown, skip?: (path: string[]) => boolean, path: string[] = []): string[] {
  if (skip && skip(path)) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(x, skip, [...path, String(i)]));
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => strings(x, skip, [...path, k]));
  return [];
}

/** ¿El texto refiere a un video del curso? (mismo detector RESOURCE_MENTION que el validador). */
export function mentionsCourseVideo(text: string): boolean {
  return lintResourceMentions(text).some((h) => /video/.test(h.match));
}

/** Las referencias bibliográficas se publican solo en el Libro Guía (nunca en un label). */
const skipBibliography = (p: string[]) => p.includes('bibliography');

function anyMention(doc: unknown, skip?: (path: string[]) => boolean): boolean {
  return strings(doc, (p) => skipBibliography(p) || (!!skip && skip(p))).some(mentionsCourseVideo);
}

export interface PendingVideoNoticeInput {
  /** Capítulos del curso (id + módulo). */
  chapters: ReadonlyArray<{ id: string; moduleId: string }>;
  /** Capítulos con video pendiente (vista previa). */
  pendingChapterIds: readonly string[];
  courseIntro: unknown;
  moduleIntros: ReadonlyMap<string, unknown>;
  experiences: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>;
}

/** Capítulos pendientes que llevan el aviso (orden de `chapters`). */
export function pendingVideoNoticeChapterIds(input: PendingVideoNoticeInput): string[] {
  const pending = new Set(input.pendingChapterIds);
  if (pending.size === 0) return [];
  const exp = (id: string): unknown =>
    input.experiences instanceof Map ? input.experiences.get(id) : (input.experiences as Record<string, unknown>)[id];
  const skipPrimer = (p: string[]) => p[0] === 'movements' && p[1] === 'video_primer';
  const courseWide = anyMention(input.courseIntro);
  const moduleMention = new Map<string, boolean>();
  const out: string[] = [];
  for (const ch of input.chapters) {
    if (!pending.has(ch.id)) continue;
    if (!moduleMention.has(ch.moduleId)) moduleMention.set(ch.moduleId, anyMention(input.moduleIntros.get(ch.moduleId)));
    if (courseWide || moduleMention.get(ch.moduleId) || anyMention(exp(ch.id), skipPrimer)) out.push(ch.id);
  }
  return out;
}
