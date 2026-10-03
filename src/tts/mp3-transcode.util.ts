import { Logger } from '@nestjs/common';
import { spawn } from 'child_process';

const logger = new Logger('Mp3Transcode');

/**
 * Recodifica un buffer MP3 a un bitrate más bajo usando ffmpeg (voz hablada — sin música,
 * 64 kbps mono es más que suficiente y suena igual de bien que los 128 kbps que entrega
 * OpenAI TTS por defecto). La API de OpenAI TTS no expone un parámetro de bitrate — solo el
 * formato — así que la única forma de bajar el peso sin perder el formato mp3 (compatibilidad
 * universal con <audio> en Moodle) es recodificar server-side.
 *
 * Por qué esto importa: un audiolibro de ~30 minutos a 128 kbps pesa ~31-32 MB, justo por
 * encima del límite de 30 MB que mbz-builder.service.ts y 09-mbz.js usan para decidir si
 * embeben el audio en el paquete final o lo excluyen con un mensaje de "demasiado grande".
 * A 64 kbps el mismo audio pesa ~15-16 MB, con margen cómodo bajo ese límite.
 *
 * Si ffmpeg no está instalado en el servidor, o la recodificación falla por cualquier razón,
 * se devuelve el buffer ORIGINAL sin tocar — nunca bloquea la generación de audio por esto.
 * Requiere `ffmpeg` instalado en el sistema (apt install -y ffmpeg en la VPS).
 */
export async function transcodeMp3Bitrate(
  inputBuffer: Buffer,
  bitrateKbps: number = 64,
): Promise<Buffer> {
  try {
    const output = await runFfmpeg(inputBuffer, bitrateKbps);
    if (!output || output.length === 0) {
      logger.warn('[Mp3Transcode] ffmpeg produjo un buffer vacío — se usa el audio original sin recodificar');
      return inputBuffer;
    }
    return output;
  } catch (e) {
    logger.warn(`[Mp3Transcode] Recodificación falló (${e instanceof Error ? e.message : String(e)}) `
      + '— se usa el audio original sin recodificar');
    return inputBuffer;
  }
}

function runFfmpeg(inputBuffer: Buffer, bitrateKbps: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', 'pipe:0',
      '-ac', '1',
      '-b:a', `${bitrateKbps}k`,
      '-f', 'mp3',
      'pipe:1',
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    proc.on('error', (err) => {
      // ENOENT típico si ffmpeg no está instalado en el servidor
      reject(err);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(outChunks));
      } else {
        const stderrText = Buffer.concat(errChunks).toString('utf-8').slice(-500);
        reject(new Error(`ffmpeg exit code ${code}: ${stderrText}`));
      }
    });

    proc.stdin.on('error', () => {
      // Evita "Error: EPIPE" no manejado si ffmpeg cierra stdin temprano (p.ej. binario ausente)
    });
    proc.stdin.end(inputBuffer);
  });
}
