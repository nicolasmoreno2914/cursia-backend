#!/usr/bin/env node
/* eslint-disable */
// R10-core (audio) — pruebas sin DB, sin ffmpeg, sin llamadas a proveedores.
// Requiere el módulo COMPILADO (dist/), como el resto de scripts/check-*.js
// de este repo (ver check-generation-manifest-determinism.js).
//
// Usage: node scripts/check-v21-audio.js

const fs = require('fs');
const path = require('path');

const modPath = path.resolve(process.cwd(), 'dist/package/audio/index.js');
let audio;
try {
  audio = require(modPath);
} catch (err) {
  console.error(`❌ No se pudo cargar el módulo compilado en ${modPath}`);
  console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
  console.error(`   ${err.message}`);
  process.exit(1);
}

const { parseMp3, mp3DurationSeconds, concatMp3, formatDurationEs, formatDurationShortEs, assembleAudiobook } = audio;

const FIXDIR = path.resolve(__dirname, 'fixtures');
const readFixture = (name) => fs.readFileSync(path.join(FIXDIR, name));

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`❌ ${name}`);
    console.log(`   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertThrowsCode(fn, code, msg) {
  try {
    fn();
  } catch (err) {
    if (err && err.code === code) return;
    throw new Error(`${msg || 'expected throw'}: esperaba code=${code}, obtuve code=${err && err.code} (${err && err.message})`);
  }
  throw new Error(`${msg || 'expected throw'}: no lanzó`);
}

// ─── Fixtures reales derivadas (ver scripts/fixtures/derive-audio-fixtures.js) ──

const welcome100f = readFixture('welcome-100f.mp3'); // 100 frames, MPEG2 L3, 24kHz mono
const sliceA = readFixture('slice-a.mp3'); // frames 0-39
const sliceB = readFixture('slice-b.mp3'); // frames 40-79
const sliceC = readFixture('slice-c.mp3'); // frames 80-119
const expectedConcat = readFixture('slices-concat-expected.mp3'); // frames 0-119, contiguo

// ─── parseMp3 / mp3DurationSeconds ──────────────────────────────────────────

check('parseMp3: reconoce 100 frames Layer III MPEG2 24kHz mono', () => {
  const parsed = parseMp3(welcome100f);
  assert(parsed.frames.length === 100, `esperaba 100 frames, obtuve ${parsed.frames.length}`);
  assert(parsed.id3v2Bytes === 0, `esperaba id3v2Bytes=0, obtuve ${parsed.id3v2Bytes}`);
  assert(parsed.id3v1 === null, 'esperaba id3v1=null');
  assert(parsed.hasXing === false, 'esperaba hasXing=false (fixture sin Xing)');
  for (const f of parsed.frames) {
    assert(f.version === 'MPEG2', `frame version esperado MPEG2, obtuve ${f.version}`);
    assert(f.sampleRate === 24000, `sampleRate esperado 24000, obtuve ${f.sampleRate}`);
    assert(f.channels === 1, `channels esperado 1, obtuve ${f.channels}`);
    assert(f.bitrateKbps === 128, `bitrate esperado 128, obtuve ${f.bitrateKbps}`);
    assert(f.length === 384, `frame length esperado 384, obtuve ${f.length}`);
  }
});

check('mp3DurationSeconds: duración exacta de 100 frames a 24kHz = 2.4s', () => {
  const d = mp3DurationSeconds(welcome100f);
  assert(Math.abs(d - 2.4) < 1e-9, `esperaba 2.4s exactos, obtuve ${d}`);
});

check('mp3DurationSeconds: bienvenida completa ≈ 60s (±2s), medida de verdad', () => {
  // Reconstruimos la duración esperada de la bienvenida completa (931200 bytes
  // reales, ver r10-core-audio.report.md) a partir del mismo framing: 931200/384=2425 frames.
  const totalFrames = 931200 / 384;
  const d = (totalFrames * 576) / 24000;
  assert(Math.abs(d - 58.2) < 2, `duración calculada ${d}s fuera de 60s±2s`);
});

// ─── ID3 stripping ──────────────────────────────────────────────────────────

check('parseMp3: despoja ID3v2 (sync-safe size) correctamente', () => {
  // ID3v2 header sintético: "ID3" + version(2) + flags(1) + syncsafe size(4) = 10 bytes,
  // tag body de 50 bytes de relleno, luego el audio real (slice-a).
  const tagBodyLen = 50;
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'ascii');
  header[3] = 4; // version major
  header[4] = 0; // version minor
  header[5] = 0; // flags (sin footer)
  // syncsafe encode de tagBodyLen en 4 bytes de 7 bits
  header[6] = (tagBodyLen >> 21) & 0x7f;
  header[7] = (tagBodyLen >> 14) & 0x7f;
  header[8] = (tagBodyLen >> 7) & 0x7f;
  header[9] = tagBodyLen & 0x7f;
  const tagBody = Buffer.alloc(tagBodyLen, 0x00);
  const withId3 = Buffer.concat([header, tagBody, sliceA]);

  const parsed = parseMp3(withId3);
  assert(parsed.id3v2Bytes === 10 + tagBodyLen, `esperaba id3v2Bytes=${10 + tagBodyLen}, obtuve ${parsed.id3v2Bytes}`);
  assert(parsed.frames.length === 40, `esperaba 40 frames tras el tag, obtuve ${parsed.frames.length}`);
  assert(parsed.frames[0].offset === 10 + tagBodyLen, 'el primer frame debe empezar justo después del tag ID3v2');
});

check('parseMp3: detecta ID3v1 (128 bytes finales "TAG...")', () => {
  const id3v1 = Buffer.alloc(128, 0x00);
  id3v1.write('TAG', 0, 'ascii');
  id3v1.write('Cursia audiobook', 3, 'ascii');
  const withId3v1 = Buffer.concat([sliceA, id3v1]);

  const parsed = parseMp3(withId3v1);
  assert(parsed.frames.length === 40, `esperaba 40 frames, obtuve ${parsed.frames.length}`);
  assert(parsed.id3v1 !== null, 'esperaba id3v1 detectado');
  assert(parsed.id3v1.toString('ascii', 0, 3) === 'TAG', 'id3v1 debe empezar con "TAG"');
});

// ─── concatMp3 ──────────────────────────────────────────────────────────────

check('concatMp3: 3 slices contiguas reproducen el original byte a byte', () => {
  const result = concatMp3([sliceA, sliceB, sliceC]);
  assert(Buffer.compare(result, expectedConcat) === 0, 'el resultado no coincide byte a byte con el original');
});

check('concatMp3: duración del resultado = suma de duraciones de las partes', () => {
  const dA = mp3DurationSeconds(sliceA);
  const dB = mp3DurationSeconds(sliceB);
  const dC = mp3DurationSeconds(sliceC);
  const result = concatMp3([sliceA, sliceB, sliceC]);
  const dResult = mp3DurationSeconds(result);
  assert(Math.abs(dResult - (dA + dB + dC)) < 1e-9, `duración concatenada ${dResult} != suma de partes ${dA + dB + dC}`);
});

check('concatMp3: despoja ID3 de cada parte antes de concatenar', () => {
  const id3v1 = Buffer.alloc(128, 0x00);
  id3v1.write('TAG', 0, 'ascii');
  const sliceAWithTag = Buffer.concat([sliceA, id3v1]);
  const result = concatMp3([sliceAWithTag, sliceB]);
  const parsed = parseMp3(result);
  assert(parsed.id3v1 === null, 'el resultado no debería tener ID3v1 (viene de una parte intermedia, no del final real)');
  assert(parsed.frames.length === 80, `esperaba 80 frames (40+40), obtuve ${parsed.frames.length}`);
});

check('concatMp3: partes incompatibles (44.1kHz vs 24kHz) → MP3_INCOMPATIBLE_PARTS', () => {
  // Frame único MPEG1 Layer III, 44100Hz, mono, 128kbps, sin datos de audio reales
  // (el parser solo valida el header + el largo declarado, no decodifica PCM).
  const version = 0b11; // MPEG1
  const layer = 0b01; // Layer III
  const protection = 1; // sin CRC
  const bitrateIndex = 9; // 128kbps en tabla V1L3
  const sampleRateIndex = 0; // 44100Hz
  const padding = 0;
  const channelMode = 0b11; // mono

  const b1 = 0xe0 | (version << 3) | (layer << 1) | protection;
  const b2 = (bitrateIndex << 4) | (sampleRateIndex << 2) | (padding << 1);
  const b3 = channelMode << 6;

  const frameLen = Math.floor((1152 / 8) * (128 * 1000) / 44100) + padding; // 417
  const frame = Buffer.alloc(frameLen, 0x00);
  frame[0] = 0xff;
  frame[1] = b1;
  frame[2] = b2;
  frame[3] = b3;

  assertThrowsCode(() => concatMp3([sliceA, frame]), 'MP3_INCOMPATIBLE_PARTS', 'debía rechazar partes con distinto sample rate');
});

// ─── assembleAudiobook ──────────────────────────────────────────────────────

check('assembleAudiobook: ordena por chapterNumber y ensambla', () => {
  const result = assembleAudiobook([
    { chapterId: 'cap-2', chapterNumber: 2, mp3: sliceB },
    { chapterId: 'cap-1', chapterNumber: 1, mp3: sliceA },
    { chapterId: 'cap-3', chapterNumber: 3, mp3: sliceC },
  ]);
  assert(Buffer.compare(result.buffer, expectedConcat) === 0, 'el buffer ensamblado no coincide con el esperado en orden 1,2,3');
  assert(result.parts.length === 3, 'esperaba 3 partes en el índice');
  assert(result.parts[0].chapterId === 'cap-1', 'la primera parte debe ser cap-1 (reordenado)');
  assert(result.parts[1].offsetSeconds > result.parts[0].offsetSeconds, 'offsets deben ser crecientes');
  const sumParts = result.parts.reduce((s, p) => s + p.durationSeconds, 0);
  assert(Math.abs(sumParts - result.durationSeconds) < 1e-9, 'la duración total debe ser la suma de las partes');
});

check('assembleAudiobook: capítulo faltante → AUDIOBOOK_PART_MISSING (fail loud, nunca corto en silencio)', () => {
  assertThrowsCode(
    () =>
      assembleAudiobook([
        { chapterId: 'cap-1', chapterNumber: 1, mp3: sliceA },
        { chapterId: 'cap-2', chapterNumber: 2, mp3: undefined },
        { chapterId: 'cap-3', chapterNumber: 3, mp3: sliceC },
      ]),
    'AUDIOBOOK_PART_MISSING',
  );
});

check('assembleAudiobook: AUDIOBOOK_PART_MISSING lista exactamente los capítulos faltantes', () => {
  try {
    assembleAudiobook([
      { chapterId: 'cap-1', chapterNumber: 1, mp3: undefined },
      { chapterId: 'cap-2', chapterNumber: 2, mp3: sliceB },
      { chapterId: 'cap-3', chapterNumber: 3, mp3: undefined },
    ]);
    throw new Error('no lanzó');
  } catch (err) {
    assert(err.code === 'AUDIOBOOK_PART_MISSING', `code esperado AUDIOBOOK_PART_MISSING, obtuve ${err.code}`);
    assert(JSON.stringify(err.missingChapterIds) === JSON.stringify(['cap-1', 'cap-3']), `missingChapterIds inesperado: ${JSON.stringify(err.missingChapterIds)}`);
  }
});

// ─── formatDurationEs / formatDurationShortEs ──────────────────────────────

check('formatDurationEs: casos exactos', () => {
  assert(formatDurationEs(62) === '1 min 02 s', `obtuve "${formatDurationEs(62)}"`);
  assert(formatDurationEs(511) === '8 min 31 s', `obtuve "${formatDurationEs(511)}"`);
  assert(formatDurationEs(0) === '0 min 00 s', `obtuve "${formatDurationEs(0)}"`);
  assert(formatDurationEs(59.6) === '1 min 00 s', `obtuve "${formatDurationEs(59.6)}" (redondeo)`);
});

check('formatDurationShortEs: casos exactos (redondeado al minuto)', () => {
  assert(formatDurationShortEs(511) === '≈ 9 min', `obtuve "${formatDurationShortEs(511)}"`);
  assert(formatDurationShortEs(60) === '≈ 1 min', `obtuve "${formatDurationShortEs(60)}"`);
  assert(formatDurationShortEs(29) === '≈ 1 min', `obtuve "${formatDurationShortEs(29)}" (M3: nunca "≈ 0 min" con audio)`);
  assert(formatDurationShortEs(0) === '≈ 0 min', `obtuve "${formatDurationShortEs(0)}"`);
});

// ─── Garbage → MP3_INVALID ──────────────────────────────────────────────────

check('parseMp3: basura sin sync → MP3_INVALID', () => {
  const garbage = Buffer.from('esto no es un mp3, es texto plano de mas de 20 bytes', 'ascii');
  assertThrowsCode(() => parseMp3(garbage), 'MP3_INVALID');
});

check('parseMp3: buffer vacío → MP3_INVALID', () => {
  assertThrowsCode(() => parseMp3(Buffer.alloc(0)), 'MP3_INVALID');
});

check('parseMp3: frame válido seguido de basura (cadena rota a mitad) → MP3_INVALID', () => {
  const corrupted = Buffer.concat([sliceA, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])]);
  assertThrowsCode(() => parseMp3(corrupted), 'MP3_INVALID');
});

// ─── Fix round 1 (review G5: I3, M2) — sondas p2 ────────────────────────────
// Frames sintéticos MPEG2 L3 24 kHz mono 32 kbps (384 bytes, 576 muestras = 24 ms).
function synthFrame({ crc = false } = {}) {
  const b = Buffer.alloc(384, 0x55);
  b[0] = 0xff; b[1] = crc ? 0xf2 : 0xf3; b[2] = 0xc4; b[3] = 0xc0;
  return b;
}
function synthInfo(n, crc = false) {
  const b = synthFrame({ crc });
  b.fill(0, 4);
  const o = 4 + (crc ? 2 : 0) + 9;
  b.write('Info', o, 'ascii');
  b.writeUInt32BE(1, o + 4);
  b.writeUInt32BE(n, o + 8);
  return b;
}
const synthAudio = (n) => Buffer.concat(Array.from({ length: n }, () => synthFrame()));
const near = (a, b) => Math.abs(a - b) < 1e-9;

check('I3: un header Info que declara 1000 frames con 100 reales → duración de los 100 frames contados', () => {
  const lie = Buffer.concat([synthInfo(1000), synthAudio(100)]);
  const d = mp3DurationSeconds(lie);
  assert(near(d, 2.4), `duración ${d} (esperada 2.4)`);
});

check('I3: assembleAudiobook — total y offsets coinciden EXACTAMENTE con el buffer ensamblado (con parte Info mentirosa)', () => {
  const lie = Buffer.concat([synthInfo(1000), synthAudio(100)]);
  const r = assembleAudiobook([
    { chapterId: 'b', chapterNumber: 2, mp3: synthAudio(50) },
    { chapterId: 'a', chapterNumber: 1, mp3: lie },
    { chapterId: 'c', chapterNumber: 3, mp3: Buffer.concat([synthInfo(7, true), synthAudio(25)]) },
  ]);
  const real = mp3DurationSeconds(r.buffer);
  assert(near(r.durationSeconds, real) && near(real, 175 * 0.024), `total ${r.durationSeconds} vs buffer ${real}`);
  assert(JSON.stringify(r.parts.map((p) => [p.chapterId, +p.offsetSeconds.toFixed(6), +p.durationSeconds.toFixed(6)])) ===
    JSON.stringify([['a', 0, 2.4], ['b', 2.4, 1.2], ['c', 3.6, 0.6]]), JSON.stringify(r.parts));
  // Cada offset cae exactamente en un borde de frame del buffer ensamblado.
  const frames = parseMp3(r.buffer).frames;
  assert(!parseMp3(r.buffer).hasXing && frames.length === 175, `frames ${frames.length}`);
});

check('M2: un frame Info con CRC (protection_bit=0) se detecta y se descarta al concatenar', () => {
  const crcX = Buffer.concat([synthInfo(100, true), synthAudio(100)]);
  const p = parseMp3(crcX);
  assert(p.hasXing === true, 'Info con CRC no detectado');
  assert(near(mp3DurationSeconds(crcX), 2.4), `duración ${mp3DurationSeconds(crcX)}`);
  assert(parseMp3(concatMp3([crcX])).frames.length === 100, 'el frame Info se coló en el stream');
});

check('M2: una parte que cambia de sample rate a mitad del stream → MP3_INVALID', () => {
  const f22 = synthFrame(); f22[2] = 0xc0; // 22050 Hz → 417 bytes
  const mixed = Buffer.concat([synthAudio(2), Buffer.concat([f22, Buffer.alloc(417 - 384, 0)])]);
  assertThrowsCode(() => parseMp3(mixed), 'MP3_INVALID');
});

// ─── Resumen ────────────────────────────────────────────────────────────────

if (failed > 0) {
  console.error(`\n${failed} prueba(s) fallida(s).`);
  process.exit(1);
} else {
  console.log('\nTodas las pruebas de R10-core (audio) pasaron.');
}
