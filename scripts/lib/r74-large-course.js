/* eslint-disable */
// r74 — cursos SINTÉTICOS grandes con medios de TAMAÑO REAL (sin IA, sin red):
//   - audiolibro: MP3 MPEG-2 Layer III 24 kHz mono a 48 kbps (frames de 144 B con cuerpo pseudoaleatorio → incompresible,
//     igual que un MP3 real); 21 min por capítulo (± unos frames para que ningún capítulo sea idéntico a otro);
//   - portada de cada presentación: PNG de ruido 760×760 (≈ 1,7 MB, incompresible, ≤ 1600 px → no se reduce) + PDF;
//   - bienvenida: 1 min a 48 kbps.
// Forma #87: 6 módulos × 5 capítulos, 1 video por módulo, actividad en todos, Actividad de Aplicación, examen por módulo
// y final. `chapters` = total de capítulos (múltiplo del número de módulos).
'use strict';
const path = require('path');
const crypto = require('crypto');
const V = require('./v21-packaging-fixtures');

const FRAME = 144; // 72 × 48000 / 24000
const FRAME_SECONDS = 576 / 24000;
const HEADER = Buffer.from([0xff, 0xf3, 0x64, 0xc4]);

/** MP3 48 kbps de ≈ `seconds` con cuerpo pseudoaleatorio (incompresible). Rápido: un bloque aleatorio grande rotado. */
function realisticMp3(seconds, seed) {
  const frames = Math.max(1, Math.round(seconds / FRAME_SECONDS));
  const buf = Buffer.alloc(frames * FRAME);
  // Cuerpo de cada frame: flujo AES-CTR con clave por capítulo (determinístico, sin repeticiones → incompresible).
  const big = crypto.createCipheriv('aes-128-ctr', crypto.createHash('md5').update(`k:${seed}`).digest(), Buffer.alloc(16, 0));
  const stream = big.update(Buffer.alloc(frames * (FRAME - 4)));
  for (let i = 0; i < frames; i++) {
    HEADER.copy(buf, i * FRAME);
    stream.copy(buf, i * FRAME + 4, i * (FRAME - 4), (i + 1) * (FRAME - 4));
  }
  return buf;
}

function noisePng(media, w, h, seed) {
  const cipher = crypto.createCipheriv('aes-128-ctr', crypto.createHash('md5').update(`png:${seed}`).digest(), Buffer.alloc(16, 0));
  const px = cipher.update(Buffer.alloc(w * h * 3));
  return media.encodePng(w, h, 3, px);
}

/**
 * Insumos completos de buildDynamicMbzV3 para un curso de `chapters` capítulos con medios de tamaño real.
 * o.minutesPerChapter (default 21), o.modules (default 6), o.coverPx (default 760).
 */
function largeCourseInput(distRoot, chapters, o = {}) {
  const nMod = o.modules || 6;
  if (chapters % nMod) throw new Error(`chapters (${chapters}) debe ser múltiplo de modules (${nMod})`);
  const per = chapters / nMod;
  const modules = Array.from({ length: nMod }, (_, mi) => ({
    examEnabled: true,
    chapters: Array.from({ length: per }, (_, k) => ({ video: k === 0, activity: true, application: 60 })),
  }));
  const input = V.packagingInput(distRoot, { modules, courseId: o.courseId || 8700 + chapters, finalExam: true });
  const media = require(path.join(distRoot, 'package/v3/synthetic-media.js'));
  const minutes = o.minutesPerChapter || 21;
  const px = o.coverPx || 760;
  let i = 0;
  for (const m of input.manifest.modules) {
    for (const c of m.chapters) {
      if (c.kind === 'practice') continue;
      input.contents.audiobookChapters.set(c.chapterId, realisticMp3(minutes * 60 + (i % 7) * 0.5, `${o.courseId || chapters}:${c.chapterId}`));
      const pres = input.contents.presentations.get(c.chapterId);
      if (pres) input.contents.presentations.set(c.chapterId, { ...pres, cover: noisePng(media, px, px, `${chapters}:${c.chapterId}`) });
      i++;
    }
  }
  input.contents.audioWelcome = realisticMp3(60, `welcome:${chapters}`);
  return input;
}

/** Almacén en memoria con la forma de SplitDeliveryStore; `failAfterUploads` simula un corte (proceso muerto) a mitad. */
function memoryStore(opts = {}) {
  const rows = [];
  const objects = new Map();
  let uploads = 0;
  const store = {
    rows,
    objects,
    uploads: () => uploads,
    failAfterUploads: opts.failAfterUploads ?? null,
    async findAll(ownerId, f) {
      return rows.filter((r) => r.ownerId === ownerId && (!f.courseId || r.courseId === f.courseId) && (!f.type || r.type === f.type)).slice().reverse();
    },
    async uploadBufferArtifact(input) {
      if (store.failAfterUploads !== null && uploads >= store.failAfterUploads) {
        // corte A MITAD de la subida: el objeto queda escrito a medias en Storage y NO se registra la fila
        objects.set(input.storagePath, input.buffer.subarray(0, Math.floor(input.buffer.length / 2)));
        throw new Error('SIMULATED_CRASH: proceso cortado a mitad de la subida');
      }
      uploads++;
      const sha = crypto.createHash('sha256').update(input.buffer).digest('hex');
      // Igual que putStorageObject: un objeto previo (p. ej. a medias tras un corte) con otros bytes se REEMPLAZA.
      objects.set(input.storagePath, Buffer.from(input.buffer));
      const row = {
        id: crypto.randomUUID(), ownerId: input.ownerId, courseId: input.courseId, type: input.type, filename: input.filename,
        storagePath: input.storagePath, checksumSha256: sha, sizeBytes: input.buffer.length, metadata: input.metadata,
      };
      rows.push(row);
      return row;
    },
    async headStorageObjectBytes(_bucket, p) {
      const o = objects.get(p);
      return o ? o.length : null;
    },
  };
  return store;
}

module.exports = { largeCourseInput, realisticMp3, memoryStore, FRAME_SECONDS };
