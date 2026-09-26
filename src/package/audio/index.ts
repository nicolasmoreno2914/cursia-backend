/**
 * index.ts — R10-core: librerías puras de audio MP3 para el pipeline de
 * empaquetado (bienvenida + audiolibro por capítulo). Sin ffmpeg, sin
 * llamadas a proveedores. Ver `scripts/check-v21-audio.js` para las pruebas
 * y el brief `scratchpad/v21/briefs/r10-core-audio.md` para el contrato.
 */

export { parseMp3, mp3DurationSeconds } from './mp3-parser';
export type { ParsedMp3 } from './mp3-parser';

export { concatMp3 } from './mp3-concat';

export { formatDurationEs, formatDurationShortEs } from './format-duration';

export { assembleAudiobook } from './assemble-audiobook';
export type { AudiobookChapterInput, AudiobookPart, AssembledAudiobook } from './assemble-audiobook';

export type { Mp3Frame } from './mp3-frame';

export { Mp3Error, Mp3InvalidError, Mp3IncompatiblePartsError, AudiobookPartMissingError } from './mp3-errors';
