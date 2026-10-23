#!/usr/bin/env node
/* eslint-disable */
// Deriva fixtures pequeñas (<200KB) de audio real V1 para
// scripts/check-v21-audio.js, sin commitear el .mbz de 8MB (ver brief
// r10-core-audio.md). Se corre una sola vez a mano; el resultado (los
// archivos .mp3 pequeños en este mismo directorio) SÍ se commitea.
//
// Fuente: MP3 real de un curso V1 (MPEG-2 Layer III, 24kHz, 128kbps mono,
// sin header Xing, sin ID3), extraído del .mbz local de auditoría v21:
//   scratchpad/v21audit/mbz/files/7a/7a5450f4f736f416eaeea4daa969398be11abc6f
//   (era "audio_bienvenida.mp3", contenthash confirmado contra files.xml)
//
// Uso: node scripts/fixtures/derive-audio-fixtures.js /ruta/al/mp3/fuente

const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src) {
  console.error('Uso: node derive-audio-fixtures.js <ruta al mp3 fuente 24kHz/128kbps/mono>');
  process.exit(1);
}

const buf = fs.readFileSync(src);

// El fixture fuente no tiene ID3v2 ni ID3v1 (verificado a mano); cada frame
// mide 384 bytes exactos (MPEG2 Layer III, 128kbps, 24kHz: floor(72*128000/24000)+padding=384+0).
const FRAME_LEN = 384;
const SAMPLES_PER_FRAME = 576;
const SAMPLE_RATE = 24000;

function sliceFrames(startFrame, count) {
  const start = startFrame * FRAME_LEN;
  const end = start + count * FRAME_LEN;
  return buf.subarray(start, end);
}

const outDir = __dirname;

// welcome-100f.mp3: 100 frames = 38400 bytes, duración exacta 100*576/24000 = 2.4s
fs.writeFileSync(path.join(outDir, 'welcome-100f.mp3'), sliceFrames(0, 100));

// slice-a/b/c.mp3: 3 partes contiguas de 40 frames cada una (usadas para el
// test de concatMp3 — concatenarlas debe reproducir byte a byte los primeros
// 120 frames del original).
fs.writeFileSync(path.join(outDir, 'slice-a.mp3'), sliceFrames(0, 40));
fs.writeFileSync(path.join(outDir, 'slice-b.mp3'), sliceFrames(40, 40));
fs.writeFileSync(path.join(outDir, 'slice-c.mp3'), sliceFrames(80, 40));
fs.writeFileSync(path.join(outDir, 'slices-concat-expected.mp3'), sliceFrames(0, 120));

console.log('Fixtures escritas en', outDir);
for (const f of ['welcome-100f.mp3', 'slice-a.mp3', 'slice-b.mp3', 'slice-c.mp3', 'slices-concat-expected.mp3']) {
  console.log(' -', f, fs.statSync(path.join(outDir, f)).size, 'bytes');
}
