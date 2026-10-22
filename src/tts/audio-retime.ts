import { Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { AudioAnalysis, atempoFilterChain } from '../package/audio/audiobook-policy';

const logger = new Logger('AudioRetime');

// ─────────────────────────────────────────────────────────────────────────────
// r67 (A1): corrección LOCAL del ritmo de un segmento del audiolibro (USD 0, sin proveedor).
//
// A diferencia de transcodeMp3Bitrate (que con ffmpeg ausente devuelve el original en silencio), aquí NUNCA hay
// fallback silencioso: sin ffmpeg, con un error o con una salida vacía → null, y el worker pasa a la re-síntesis con
// otra estrategia (A2). El buffer de entrada nunca se modifica (se escribe por stdin; el original queda intacto para la
// cuarentena).
//
// Determinismo: misma entrada + mismo factor → mismos bytes (sha). Argumentos fijos del encoder: sin metadatos
// (-map_metadata -1), sin etiquetas ID3 (encoder/fecha), bitexact en formato y códec, un solo hilo y la cadena de
// filtros calculada (atempo, -ac 1, -b:a Nk). Un solo encode desde el MP3 CRUDO de OpenAI (sin doble transcode).
// ─────────────────────────────────────────────────────────────────────────────

/** r67: herramientas de audio inyectables (las pruebas reemplazan ffmpeg; producción usa el binario del PATH). */
export interface AudioTools {
  /** MP3 re-temporizado por `factor`, a `kbps` mono. null = no disponible / falló (nunca el original). */
  retimeMp3(raw: Buffer, factor: number, kbps: number): Promise<Buffer | null>;
  /** Silencios (> 2 s, −40 dB) y pico (dBFS). null = no se pudo analizar. */
  analyzeAudio(buf: Buffer): Promise<AudioAnalysis | null>;
}

const FFMPEG_TIMEOUT_MS = 90_000;

/** r67: argumentos EXACTOS del retime (exportados para la prueba de determinismo). */
export function retimeFfmpegArgs(factor: number, kbps: number): string[] {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1',
    '-i', 'pipe:0',
    '-map', '0:a:0', '-map_metadata', '-1',
    '-fflags', '+bitexact', '-flags:a', '+bitexact',
    '-af', atempoFilterChain(factor),
    '-ac', '1', '-b:a', `${Math.floor(kbps)}k`,
    '-id3v2_version', '0', '-write_id3v1', '0',
    '-f', 'mp3', 'pipe:1',
  ];
}

/** r67: argumentos del análisis (silencedetect + astats, sin salida de audio). */
export function analyzeFfmpegArgs(): string[] {
  return [
    '-hide_banner', '-nostdin', '-nostats', '-threads', '1',
    '-i', 'pipe:0',
    '-af', 'silencedetect=noise=-40dB:d=2,astats=metadata=0:reset=0',
    '-f', 'null', '-',
  ];
}

function runFfmpeg(args: string[], input: Buffer): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`ffmpeg superó ${FFMPEG_TIMEOUT_MS} ms`)); }, FFMPEG_TIMEOUT_MS);
    proc.stdout.on('data', (c: Buffer) => out.push(c));
    proc.stderr.on('data', (c: Buffer) => err.push(c));
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf-8');
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr });
      else reject(new Error(`ffmpeg exit code ${code}: ${stderr.slice(-400)}`));
    });
    proc.stdin.on('error', () => { /* EPIPE si ffmpeg cierra stdin temprano */ });
    // Copia: el buffer original nunca se toca.
    proc.stdin.end(Buffer.from(input));
  });
}

/** r67: parser de la salida de silencedetect/astats (exportado para las pruebas). */
export function parseAnalysis(stderr: string): AudioAnalysis {
  const silences: Array<{ start: number; end: number }> = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[0-9.]+)/.exec(line);
    if (s) { open = Math.max(0, Number(s[1])); continue; }
    const e = /silence_end:\s*([0-9.]+)/.exec(line);
    if (e && open !== null) { silences.push({ start: open, end: Number(e[1]) }); open = null; }
  }
  // Silencio que llega hasta el final del archivo (sin silence_end): es de borde.
  if (open !== null) silences.push({ start: open, end: Number.POSITIVE_INFINITY });
  let peak: number | null = null;
  const overall = stderr.lastIndexOf('Overall');
  const tail = overall >= 0 ? stderr.slice(overall) : stderr;
  const pk = /Peak level dB:\s*(-?inf|-?[0-9.]+)/i.exec(tail);
  if (pk) peak = /inf/i.test(pk[1]) ? (pk[1].startsWith('-') ? -Infinity : Infinity) : Number(pk[1]);
  const d = /Duration:\s*(\d+):(\d+):([0-9.]+)/.exec(stderr);
  const durationSeconds = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  return { durationSeconds, silences, peakDbfs: peak };
}

export const ffmpegAudioTools: AudioTools = {
  async retimeMp3(raw: Buffer, factor: number, kbps: number): Promise<Buffer | null> {
    try {
      const { stdout } = await runFfmpeg(retimeFfmpegArgs(factor, kbps), raw);
      if (!stdout.length) {
        logger.warn('[AudioRetime] ffmpeg devolvió un buffer vacío — sin corrección local');
        return null;
      }
      return stdout;
    } catch (e) {
      logger.warn(`[AudioRetime] retime no disponible (${e instanceof Error ? e.message : String(e)}) — sin corrección local`);
      return null;
    }
  },
  async analyzeAudio(buf: Buffer): Promise<AudioAnalysis | null> {
    try {
      const { stderr } = await runFfmpeg(analyzeFfmpegArgs(), buf);
      const a = parseAnalysis(stderr);
      return a.peakDbfs === null ? null : a;
    } catch (e) {
      logger.warn(`[AudioRetime] análisis no disponible (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
  },
};

/** r67: entrada pública (A1.3): retime con ffmpeg; null sin ffmpeg (nunca el original). */
export function retimeMp3(raw: Buffer, factor: number, kbps: number): Promise<Buffer | null> {
  return ffmpegAudioTools.retimeMp3(raw, factor, kbps);
}
