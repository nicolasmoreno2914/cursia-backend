/**
 * mp3-errors.ts
 *
 * Errores con código explícito para el pipeline de audio (R10-core). Regla
 * del proyecto: "fallar fuerte y visible, nunca degradar en silencio"
 * (CLAUDE.md, "Trampas conocidas") — cada error acá lleva un `.code` estable
 * para que el caller (worker, script de empaquetado) pueda distinguir el
 * motivo sin parsear el mensaje.
 */

export class Mp3Error extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = 'Mp3Error';
  }
}

export class Mp3InvalidError extends Mp3Error {
  constructor(message: string) {
    super('MP3_INVALID', message);
    this.name = 'Mp3InvalidError';
  }
}

export class Mp3IncompatiblePartsError extends Mp3Error {
  parts: Array<Record<string, unknown>>;

  constructor(message: string, parts: Array<Record<string, unknown>>) {
    super('MP3_INCOMPATIBLE_PARTS', message);
    this.name = 'Mp3IncompatiblePartsError';
    this.parts = parts;
  }
}

export class AudiobookPartMissingError extends Mp3Error {
  missingChapterIds: string[];

  constructor(missingChapterIds: string[]) {
    super('AUDIOBOOK_PART_MISSING', JSON.stringify(missingChapterIds));
    this.name = 'AudiobookPartMissingError';
    this.missingChapterIds = missingChapterIds;
  }
}
