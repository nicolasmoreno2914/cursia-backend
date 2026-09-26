/**
 * assemble-audiobook.ts
 *
 * `assembleAudiobook` — ensambla el audiolibro final a partir de las partes
 * `audiobook_chapter:<uuid>` generadas por capítulo (§E, S1.3). Es la pieza
 * de empaquetado: el audio en sí ya viene medido y validado por
 * `mp3-parser.ts` / `mp3-concat.ts`.
 *
 * Fail loud (CLAUDE.md "Trampas conocidas" #9): si falta la parte de un
 * capítulo, NUNCA se arma un audiolibro corto en silencio — se lanza
 * `AUDIOBOOK_PART_MISSING` con la lista de capítulos faltantes para que el
 * caller decida (generar el faltante, o abortar visiblemente).
 */

import { concatMp3 } from './mp3-concat';
import { mp3DurationSeconds } from './mp3-parser';
import { AudiobookPartMissingError } from './mp3-errors';

export interface AudiobookChapterInput {
  chapterId: string;
  chapterNumber: number;
  mp3: Buffer | undefined;
}

export interface AudiobookPart {
  chapterId: string;
  durationSeconds: number;
  offsetSeconds: number;
}

export interface AssembledAudiobook {
  buffer: Buffer;
  durationSeconds: number;
  parts: AudiobookPart[];
}

export function assembleAudiobook(chapters: AudiobookChapterInput[]): AssembledAudiobook {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    throw new AudiobookPartMissingError([]);
  }

  const ordered = [...chapters].sort((a, b) => a.chapterNumber - b.chapterNumber);

  const missing = ordered.filter((c) => !c.mp3).map((c) => c.chapterId);
  if (missing.length > 0) {
    throw new AudiobookPartMissingError(missing);
  }

  const durations = ordered.map((c) => mp3DurationSeconds(c.mp3 as Buffer));
  const buffer = concatMp3(ordered.map((c) => c.mp3 as Buffer));

  const parts: AudiobookPart[] = [];
  let cursor = 0;
  for (let i = 0; i < ordered.length; i++) {
    parts.push({ chapterId: ordered[i].chapterId, durationSeconds: durations[i], offsetSeconds: cursor });
    cursor += durations[i];
  }

  const durationSeconds = durations.reduce((sum, d) => sum + d, 0);

  return { buffer, durationSeconds, parts };
}
