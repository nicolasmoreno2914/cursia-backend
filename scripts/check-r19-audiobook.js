#!/usr/bin/env node
/* eslint-disable */
// r19 (bloque A) — audiolibro COMPLETO (≥ 25 min en cursos de volumen normal).
//
// Sin red externa y sin gasto: proveedores FALSOS en 127.0.0.1 (test/e2e-v2/fakes.js) con un
// generador de MP3 NO silencioso (MPEG-2 L3, 24 kHz, mono, frames con carga ≠ 0) cuya duración
// es proporcional a las palabras (≈141 ppm), y un `ffmpeg` FALSO en el PATH (re-emite los mismos
// frames al bitrate pedido) para probar el transcode del audiolibro a 48 kbps sin ffmpeg real.
// El worker real (processRealProviderItem) corre contra un scheduler / ledger / Storage EN MEMORIA.
//
// Escenarios (brief IMPL-A §Tests / DIAG-A §5):
//   1. volumen normal (4 capítulos × ~2.800 palabras) → ≥ 1500 s, todos los capítulos y bloques;
//   2. curso chico (1 × 900) → sin relleno, la duración sigue al contenido, completo;
//   3. falla un segmento → el reintento regenera SOLO ese y los que faltan (llamadas contadas);
//   4. guion corto → continuación aceptada; sigue corto → falla fuerte, no se completa;
//   5. hash de segmento duplicado → rechazado (y repetición de bloques);
//   6. concatenación / manifiesto inconsistente → no completo; segmento guardado corrupto → solo ése;
//   7. duración del Info = duración por frames;
//   8. sin silencio artificial (el concat no inserta nada; voz ralentizada → rechazada);
//   9. costo incierto → ningún reintento automático (y tras la decisión, solo lo que falta);
//  10. re-empaque de un curso existente → 0 llamadas TTS / LLM.
//
// Usage: node scripts/check-r19-audiobook.js [path/to/dist]
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
const { Logger } = require('@nestjs/common');
const AS = loadDist('workers/provider-real/audio-scripts.js');
const RP = loadDist('workers/provider-real/real-providers.js');
const AUD = loadDist('package/audio/index.js');
const FC = loadDist('modules/reliability/failure-classifier.js');
const F = loadDist('modules/finops/index.js');
const RB = loadDist('modules/finops/run-budget.js');
const B = loadDist('package/dynamic-mbz-builder-v3.js');
const PF = require(path.join(REPO, 'scripts/lib/v21-packaging-fixtures.js'));
const { startProviderFakes } = require(path.join(REPO, 'test/e2e-v2/fakes.js'));

const LOGS = [];
const capLogger = { log: (m) => LOGS.push(String(m)), warn: (m) => LOGS.push(String(m)), error: (m) => LOGS.push(String(m)) };
Logger.overrideLogger({ log: capLogger.log, warn: capLogger.warn, error: capLogger.error, debug: () => {}, verbose: () => {} });

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}`);
    console.error(`   ${err && err.stack ? err.stack.split('\n').slice(0, 8).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); }
async function rejectsRe(p, re, m) {
  let e = null;
  try { await p; } catch (x) { e = x; }
  assert(e, `${m}: no lanzó`);
  assert(re.test(e.message), `${m}: mensaje inesperado "${String(e.message).slice(0, 400)}"`);
  return e;
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ─── MP3 falso NO silencioso: MPEG-2 L3, 24 kHz, mono; 64 kbps = 192 bytes / 576 muestras ─────────────
const FRAME_SECONDS = 576 / 24000;
const BR_INDEX = { 8: 1, 16: 2, 24: 3, 32: 4, 40: 5, 48: 6, 56: 7, 64: 8 };
function fakeMp3Frames(frames, kbps, seedText) {
  const len = 3 * kbps; // floor(72 × kbps × 1000 / 24000)
  const buf = Buffer.alloc(frames * len);
  let x = parseInt(sha256(`${seedText}|${frames}`).slice(0, 8), 16) || 1;
  for (let f = 0; f < frames; f++) {
    const o = f * len;
    buf[o] = 0xff; buf[o + 1] = 0xf3; buf[o + 2] = (BR_INDEX[kbps] << 4) | 0x04; buf[o + 3] = 0xc0;
    for (let i = 4; i < len; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; buf[o + i] = ((x >>> 16) & 0xff) | 0x01; }
  }
  return buf;
}
/** TTS falso: secs medidos por el fake (palabras / ritmo) → frames; el audio varía con el texto. */
const makeMp3 = (secs, text) => fakeMp3Frames(Math.max(1, Math.round(secs / FRAME_SECONDS)), 64, text || '');
/** Frames con carga principal en cero (silencio digital). */
function zeroFrames(buf) {
  const parsed = AUD.parseMp3(buf);
  let n = 0;
  for (const f of AUD.audioFramesOf(parsed)) {
    const body = buf.subarray(f.offset + 4 + 9, f.offset + f.length);
    if (body.every((b) => b === 0)) n++;
  }
  return n;
}

// ─── ffmpeg FALSO en el PATH: re-emite los MISMOS frames al bitrate pedido (-b:a Nk) ──────────────
const FAKE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r19-ffmpeg-'));
fs.writeFileSync(path.join(FAKE_BIN, 'ffmpeg'), `#!${process.execPath}
const crypto = require('crypto');
const args = process.argv.slice(2);
const br = parseInt(String(args[args.indexOf('-b:a') + 1] || '64'), 10);
const IDX = ${JSON.stringify(BR_INDEX)};
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const inp = Buffer.concat(chunks);
  const TBL = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  let o = 0; let frames = 0;
  while (o + 4 <= inp.length && inp[o] === 0xff) { const kb = TBL[(inp[o + 2] >> 4) & 15]; o += 3 * kb + ((inp[o + 2] >> 1) & 1); frames++; }
  const len = 3 * br; const out = Buffer.alloc(frames * len);
  let x = parseInt(crypto.createHash('sha256').update(inp).digest('hex').slice(0, 8), 16) || 1;
  for (let f = 0; f < frames; f++) { const p = f * len; out[p] = 0xff; out[p + 1] = 0xf3; out[p + 2] = (IDX[br] << 4) | 0x04; out[p + 3] = 0xc0;
    for (let i = 4; i < len; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out[p + i] = ((x >>> 16) & 0xff) | 1; } }
  process.stdout.write(out);
});
`, { mode: 0o755 });
process.env.PATH = `${FAKE_BIN}${path.delimiter}${process.env.PATH}`;

// ─── Capítulos de prueba: `##` reales, tabla, lista, glosario, bibliografía; sin frases repetidas ──────
let tokenSeq = 0;
function sentence(n, tag) {
  const w = [];
  for (let i = 0; i < n; i++) w.push(`${tag}${(tokenSeq++).toString(36)}`);
  return `${w.join(' ')}.`;
}
function para(words, tag) {
  const out = [];
  let left = words;
  while (left > 0) { const n = Math.min(12, left); out.push(sentence(n, tag)); left -= n; }
  return out.join(' ');
}
/** Capítulo de ≈`words` palabras narrables: 5 secciones, caso, actividades, tabla, glosario (con lista) y bibliografía. */
function chapterMd(ch, words) {
  const t = `c${ch}`;
  const sec = Math.round(words / 8.6);
  return [
    `# Capítulo ${ch}`,
    '',
    para(Math.round(sec * 0.3), t),
    ...[1, 2, 3, 4, 5].flatMap((k) => ['', `## ${ch}.${k} Tema ${k}`, '', para(Math.round(sec * 0.55), t), '', para(Math.round(sec * 0.45), t)]),
    '', '## Caso aplicado', '', para(sec, t),
    '', '## Actividades de apoyo', '', `1. ${sentence(10, t)}`, `2. ${sentence(10, t)}`, '', para(Math.max(10, sec - 24), t),
    '', '## Comparación', '', `| Criterio | Opción ${t}A | Opción ${t}B |`, '|---|---|---|', `| ${t}costo | ${t}bajo | ${t}alto |`, `| ${t}riesgo | ${t}medio | ${t}bajo |`, '',
    para(Math.round(sec * 0.6), t),
    '', '## Glosario', '', `- **${t}gl1**: ${sentence(11, t)}`, `- **${t}gl2**: ${sentence(11, t)}`, `- **${t}gl3**: ${sentence(11, t)}`, '', para(Math.round(sec * 0.4), t),
    '', '## Bibliografía', '', `- Autor ${t}, (2020). Obra de referencia. Editorial.`,
  ].join('\n');
}

// ─── Entorno en memoria del worker: scheduler, ledger, Storage, artifacts ──────────────────────────
function memoryWorld() {
  const blobs = new Map();
  const ledgerRows = [];
  const items = new Map();
  const artifacts = [];
  const scheduler = {
    async completeItem(id, e, o) { const it = items.get(id); it.status = 'completed'; it.completion = o; it.outputSummary = { ...it.outputSummary, ...o.summary, artifactIds: o.artifactIds }; return true; },
    async failItem(id, e, msg, retry) { const it = items.get(id); it.status = retry ? 'retrying' : 'failed'; it.error = msg; it.fails.push({ msg, retry }); return true; },
    async blockItemForBudget(id, e, msg) { const it = items.get(id); it.status = 'blocked'; it.error = msg; return true; },
    async recordItemExternal(id, e, patch) { const it = items.get(id); it.outputSummary = { ...it.outputSummary, ...JSON.parse(JSON.stringify(patch)) }; return true; },
    async heartbeatItem() { return true; },
  };
  const keyOf = (input) => input.idempotencyKey || `${input.idempotency.kind}:${JSON.stringify(input.idempotency.parts)}`;
  const ledger = {
    async recordCharge(input) {
      const key = keyOf(input);
      let row = ledgerRows.find((r) => r.idempotency_key === key);
      if (row) return { inserted: false, event: row };
      row = { idempotency_key: key, attempt: input.attempt, provider: input.provider, external_operation_id: input.externalOperationId ?? null,
        measurement_status: input.measurementStatus, reservation: !!(input.metadata && input.metadata.reservation), settled: false, itemRunId: input.itemRunId, usage: input.usage };
      ledgerRows.push(row);
      return { inserted: true, event: row };
    },
    async recordAdjustment() { return { inserted: true }; },
    async recordZero() { return { inserted: true }; },
    async settleReservation(key, finalCharge) {
      const res = ledgerRows.find((r) => r.idempotency_key === key);
      if (!res) throw new Error(`no existe la reserva ${key}`);
      let fin = null;
      if (finalCharge) fin = await ledger.recordCharge(finalCharge);
      res.settled = true;
      return { finalInserted: !!(fin && fin.inserted), finalEvent: fin ? fin.event : null, released: true, alreadySettled: false };
    },
    async itemPaidCharges(itemRunId) { return ledgerRows.filter((r) => r.itemRunId === itemRunId).map((r) => ({ ...r })); },
  };
  const arts = {
    async uploadJsonArtifact(a) { const id = crypto.randomUUID(); artifacts.push({ id, ...a }); return { id }; },
    async uploadBufferArtifact(a) { const id = crypto.randomUUID(); blobs.set(`cursia-artifacts/${a.storagePath}`, a.buffer); artifacts.push({ id, ...a }); return { id }; },
    async putStorageObject(a) {
      const k = `cursia-artifacts/${a.storagePath}`;
      if (blobs.has(k) && a.upsert === false) throw new Error(`Supabase Storage upload failed: 409 Duplicate ${a.storagePath}`);
      blobs.set(k, a.buffer);
      return { sizeBytes: a.buffer.length, adopted: false };
    },
    async downloadStorageObject(bucket, p) { const b = blobs.get(`${bucket}/${p}`); if (!b) throw new Error(`404 ${p}`); return b; },
    async getDownloadUrl(id) { const a = artifacts.find((x) => x.id === id); return { url: `data:text/plain;base64,${Buffer.from(a.text).toString('base64')}` }; },
  };
  return { blobs, ledgerRows, items, artifacts, scheduler, ledger, arts };
}

const KEYS = { OPENAI_API_KEY: 'sk-r19-openai-fake', ANTHROPIC_API_KEY: 'sk-r19-anthropic-fake' };
let FAKES = null;
let ENV = null;
const counts = () => ({ tts: FAKES.st.tts.length, llm: FAKES.st.llm.length });
const delta = (c0) => { const c = counts(); return { tts: c.tts - c0.tts, llm: c.llm - c0.llm }; };

function newItem(W, { ch, md, type = 'audiobook_chapter', attempt = 1 }) {
  const depId = crypto.randomUUID();
  W.artifacts.push({ id: depId, text: JSON.stringify({ markdown: md }) });
  const it = {
    itemRunId: crypto.randomUUID(), runId: crypto.randomUUID(), courseId: 1, artifactCourseId: 'course-r19', manifestId: 7,
    itemKey: `${type}:ch${ch}`, type, chapterId: `ch${ch}`, chapterNumber: ch, idempotencyKey: `idem-${ch}-${crypto.randomUUID().slice(0, 6)}`,
    attempt, generation: 1, outputSummary: {}, dependencyArtifacts: [{ type: 'dynamic_content_md', artifactId: depId }],
    blueprint: { course: { title: 'Curso r19' }, chapter: { title: `Capítulo ${ch}`, description: null } },
    context: { courseContext: { pais: 'Colombia' } }, status: 'running', fails: [],
  };
  W.items.set(it.itemRunId, it);
  return it;
}
function workerDeps(W, over = {}) {
  return {
    scheduler: W.scheduler, dataSource: { async query() { return []; } }, artifacts: W.arts, logger: capLogger, executorId: 'r19-worker', leaseSeconds: 120,
    finops: W.ledger, budget: { async guardPaidSubmission() { return { allow: true, decision: 'ALLOW', committed: '0', remaining: '99', reason: 'test', authorizedBudget: '99' }; } },
    env: ENV, ...over,
  };
}
/** Un claim del item: corre el worker real; devuelve el item (estado en memoria). */
async function claim(W, it, over = {}) {
  it.status = 'running';
  try { await RP.processRealProviderItem(workerDeps(W, over), it, 'owner-r19'); } catch (err) { it.thrown = err.message; }
  return it;
}
/** Reintento del item (lo que hace el scheduler): mismo item_run, intento +1, output_summary conservado. */
function nextAttempt(it, extra = {}) { it.attempt += 1; it.outputSummary = { ...it.outputSummary, ...extra }; return it; }
function audioOf(W, it) { const a = W.artifacts.find((x) => x.id === it.completion.artifactIds[0]); return a.buffer; }

async function main() {
  FAKES = startProviderFakes({ openaiKey: KEYS.OPENAI_API_KEY, anthropicKey: KEYS.ANTHROPIC_API_KEY, gammaKey: 'g', makePdf: () => Buffer.from('%PDF'), makeMp3, ttsWordsPerSecond: AUD.AUDIOBOOK_WPM_REF / 60 });
  const urls = await FAKES.listen();
  ENV = { ...KEYS, OPENAI_API_BASE_URL: urls.openaiUrl, ANTHROPIC_API_BASE_URL: urls.anthropicUrl };
  try {
    await pureChecks();
    await workerChecks();
    await packagingChecks();
    await finopsChecks();
  } finally {
    await FAKES.close();
  }
  console.log(`\n${passes} OK, ${failures} con fallas`);
  process.exit(failures ? 1 : 0);
}

// ════════════════════════════════════════════════════════════════════════════
async function pureChecks() {
  await check('plan: cubre TODO el capítulo (bloques + excluidos = palabras del capítulo), tabla/lista/glosario narrados, bibliografía excluida', () => {
    const md = chapterMd(1, 2800);
    const p = AS.planAudiobookSections(md);
    eq(p.narratableWords + p.excluded.reduce((a, e) => a + e.words, 0), p.sourceWords, 'cobertura');
    assert(p.narratableWords >= 2650 && p.narratableWords <= 2950, `≈2.800 palabras narrables (${p.narratableWords})`);
    eq(p.excluded.map((e) => e.reason), ['bibliography'], 'solo la bibliografía queda fuera');
    const all = p.sections.map((s) => s.text).join(' ');
    assert(/Criterio: c1costo; Opción c1A: c1bajo; Opción c1B: c1alto\./.test(all), 'tabla verbalizada (encabezado: celda)');
    assert(/c1gl2: /.test(all) && !/\*\*/.test(all), 'glosario y lista narrados, sin markdown');
    assert(p.sections.every((s) => s.words >= AS.AUDIOBOOK_CHUNK_MIN_WORDS || p.sections.length === 1) && p.sections.every((s) => s.words <= AS.AUDIOBOOK_CHUNK_MAX_WORDS), `bloques ${p.sections.map((s) => s.words)}`);
    assert(new Set(p.sections.map((s) => s.sha256)).size === p.sections.length, 'sha por bloque');
  });

  await check('plan: regresión del recorte — un capítulo de 20.000 caracteres se narra entero (sin slice(0, 2200)); sección > 900 palabras se parte por párrafos', () => {
    const md = `# Largo\n\n## Única sección\n\n${Array.from({ length: 36 }, () => para(130, "L")).join('\n\n')}`;
    assert(md.length > 20000, `fixture ${md.length} caracteres`);
    const p = AS.planAudiobookSections(md);
    const src = AS.cleanAudioText(md);
    eq(p.narratableWords, AS.wordCount(src), 'todas las palabras del capítulo');
    assert(p.sections.length >= 3 && p.sections.every((s) => s.words <= AS.AUDIOBOOK_CHUNK_SPLIT_WORDS + 120), `partes ${p.sections.map((s) => s.words)}`);
    const last = src.split(' ').slice(-3).join(' ');
    assert(p.sections[p.sections.length - 1].text.endsWith(last), 'el final del capítulo está en el último bloque');
    assert(!('AUDIOBOOK_EXCERPT_CHARS' in AS) && !('chapterNarrationPrompt' in AS), 'el extracto de 2.200 y el prompt de resumen ya no existen');
  });

  await check('prompt por bloque: fuente COMPLETA del bloque, objetivo 90 % (85–110), adapta (no resume), verbaliza tablas/listas, sin datos nuevos, tuteo, veracidad', () => {
    const p = AS.planAudiobookSections(chapterMd(2, 2800));
    const s = p.sections[1];
    const pr = AS.sectionNarrationPrompt({ courseTitle: 'C', chapterNumber: 2, chapterTitle: 'T', pais: 'Colombia', contentMarkdown: '' }, s, p.sections.length, 'cola previa');
    assert(pr.user.includes(s.text), 'texto completo del bloque');
    const t = AS.sectionTargetWords(s.words);
    assert(pr.user.includes(`alrededor de ${t.target} palabras (entre ${t.min} y ${t.max})`), 'objetivo');
    assert(/NO un resumen/.test(pr.system) && /tablas/.test(pr.system) && /No agregues información/.test(pr.system), 'adaptación');
    assert(/tuteo/.test(pr.system) && /multiplicadores/.test(pr.system) && /idea completa/.test(pr.system), 'reglas R14');
    assert(/cola previa/.test(pr.user) && /NO lo repitas/.test(pr.user), 'continuidad');
    assert(!/resume,/.test(pr.system), 'sin la orden de resumir');
    const c = AS.sectionContinuationPrompt('ya narrado', s, 'T', 50, 'Colombia');
    assert(/CONTINUAR/.test(c.system) && c.user.includes(s.text) && /tuteo/.test(c.system), 'continuación con la fuente del bloque');
  });

  await check('guion por bloque: 1 llamada si cae en la banda; corto → UNA continuación aceptada; sigue corto → AUDIOBOOK_SECTION_TOO_SHORT; largo → AUDIOBOOK_SECTION_PADDED', async () => {
    const p = AS.planAudiobookSections(chapterMd(3, 2800));
    const s = p.sections[0];
    const input = { courseTitle: 'C', chapterNumber: 3, chapterTitle: 'T', contentMarkdown: '' };
    const w = (n) => s.text.split(/\s+/).slice(0, n).join(' ');
    const t = AS.sectionTargetWords(s.words);
    let calls = [];
    const r1 = await AS.generateSectionScript(input, s, p.sections.length, null, async (pr, role) => { calls.push(role); return { text: w(t.target), messageId: 'm1' }; });
    eq([calls, r1.continued, r1.words], [['main'], false, t.target], 'una llamada');
    assert(r1.ratio >= 0.85 && r1.ratio <= 1.1, `ratio ${r1.ratio}`);
    calls = [];
    const r2 = await AS.generateSectionScript(input, s, p.sections.length, null, async (pr, role) => { calls.push(role); return { text: role === 'main' ? w(Math.round(t.target * 0.6)) : w(t.target - Math.round(t.target * 0.6)), messageId: role }; });
    eq([calls, r2.continued, r2.messageIds], [['main', 'continuation'], true, ['main', 'continuation']], 'continuación');
    const e1 = await rejectsRe(AS.generateSectionScript(input, s, 1, null, async () => ({ text: w(20), messageId: 'x' })), /AUDIOBOOK_SECTION_TOO_SHORT/, 'sigue corto');
    eq(e1.retryable, true, 'reintentable');
    const many = s.text.split(/\s+/).concat(s.text.split(/\s+/)).slice(0, Math.round(s.words * 1.4)).join(' ');
    await rejectsRe(AS.generateSectionScript(input, s, 1, null, async () => ({ text: many, messageId: 'x' })), /AUDIOBOOK_SECTION_PADDED/, 'relleno');
  });

  await check('anti-bucle: bloques idénticos o frase de 12 palabras repetida > 2 veces → detectados; segmentos con clave determinística seg-<bloque>-<parte>-<sha12>', () => {
    eq(AS.findScriptRepetition([{ idx: 0, text: 'a b c' }, { idx: 1, text: 'otra cosa distinta' }]).idxs, [], 'sin repetición');
    eq(AS.findScriptRepetition([{ idx: 0, text: 'Hola mundo.' }, { idx: 1, text: 'hola,  mundo' }]).idxs, [0, 1], 'idénticos (normalizado)');
    const loop = Array.from({ length: 3 }, () => 'uno dos tres cuatro cinco seis siete ocho nueve diez once doce').join(' ');
    assert(AS.findScriptRepetition([{ idx: 0, text: `inicio ${loop}` }]).idxs.length === 1, 'bucle');
    const txt = `${'Oración de prueba número uno. '.repeat(10)}`;
    const a = AS.audiobookSegments([{ idx: 0, text: 'Primero.' }, { idx: 1, text: `${txt}`.repeat(20) }]);
    const b = AS.audiobookSegments([{ idx: 1, text: `${txt}`.repeat(20) }, { idx: 0, text: 'Primero.' }]);
    eq(a.map((x) => x.key), b.map((x) => x.key), 'determinística (orden de bloque)');
    assert(a.every((x) => /^seg-\d+-\d+-[0-9a-f]{12}$/.test(x.key) && x.chars <= AS.TTS_MAX_CHARS), 'forma');
    assert(a.filter((x) => x.sectionIdx === 1).length >= 2, 'un bloque largo se parte en varias partes');
  });

  await check('manifiesto: esperados = generados = concatenados, hashes únicos, frames = suma, Info = frames; cualquier diferencia → NO completo', () => {
    const seg = (i, frames, extra = {}) => ({ key: `seg-0-${i}-x${i}`, sectionIdx: 0, partIdx: i, words: 200, chars: 1200, textSha: `t${i}`, audioSha: `a${i}`, frames, seconds: frames * FRAME_SECONDS, bitrateKbps: 48, requestId: `r${i}`, storagePath: 'p', ...extra });
    const base = () => {
      const segs = [seg(0, 3500), seg(1, 3600)];
      const frames = 7100;
      return {
        v: 1, chapterId: 'c', source: { words: 450, narratableWords: 450, sections: 1, sha256: 's', excluded: [] },
        script: { words: 400, ratio: 0.889, sections: [{ idx: 0, title: '', sourceWords: 450, sourceSha: 's', scriptWords: 400, ratio: 0.889, continued: false, messageIds: ['m'] }] },
        tts: { wordsSent: 400, charsSent: 2400, segmentsExpected: 2, segmentsGenerated: 2, segmentsConcatenated: 2, segments: segs },
        audio: { frames, seconds: frames * FRAME_SECONDS, infoFrames: frames, infoFrameSeconds: frames * FRAME_SECONDS, bitrateKbps: 48, wpm: 400 / ((frames * FRAME_SECONDS) / 60) },
      };
    };
    eq(AUD.validateChapterAudioManifest(base()), [], 'válido');
    const m1 = base(); m1.tts.segmentsConcatenated = 1;
    assert(AUD.validateChapterAudioManifest(m1).some((e) => /SEGMENTS_CONCATENATED/.test(e)), 'concatenación incompleta');
    const m2 = base(); m2.tts.segmentsGenerated = 1;
    assert(AUD.validateChapterAudioManifest(m2).some((e) => /SEGMENTS_GENERATED/.test(e)), 'generación incompleta');
    const m3 = base(); m3.tts.segments[1].audioSha = 'a0';
    assert(AUD.validateChapterAudioManifest(m3).some((e) => /SEGMENT_AUDIO_DUPLICATE/.test(e)), 'audio duplicado');
    const m4 = base(); m4.tts.segments[1].textSha = 't0';
    assert(AUD.validateChapterAudioManifest(m4).some((e) => /SEGMENT_TEXT_DUPLICATE/.test(e)), 'texto duplicado');
    const m5 = base(); m5.audio.infoFrames = 7000;
    assert(AUD.validateChapterAudioManifest(m5).some((e) => /INFO_FRAMES/.test(e)), 'Info ≠ frames');
    const m6 = base(); m6.audio.frames = 7200;
    assert(AUD.validateChapterAudioManifest(m6).some((e) => /FRAMES_SUM/.test(e)), 'frames ≠ suma (algo se insertó)');
    const m7 = base(); m7.script.sections[0].ratio = 0.5;
    assert(AUD.validateChapterAudioManifest(m7).some((e) => /SECTION_RATIO/.test(e)), 'bloque fuera de banda');
  });

  await check('piso del curso: Σ fuente ≥ umbral (≈4.148, = ceil(25 × 141 / 0.85)) y < 1500 s → AUDIOBOOK_TOO_SHORT_FOR_SOURCE con diagnóstico; chico → sigue al contenido; sin manifiesto → se omite con aviso', () => {
    eq(AUD.AUDIOBOOK_FLOOR_SOURCE_WORDS, Math.ceil((25 * 141) / 0.85), 'umbral derivado');
    eq(AUD.AUDIOBOOK_FLOOR_SECONDS, 1500, 'piso');
    const man = (words, secs) => ({ source: { narratableWords: words }, script: { words: Math.round(words * 0.9), sections: [{ idx: 0, ratio: 0.86 }] }, tts: { segmentsExpected: 3, segmentsGenerated: 3, segmentsConcatenated: 3 }, audio: { wpm: 141 }, secs });
    let e = null;
    try { AUD.checkAudiobookCourseFloor([{ chapterId: 'a', durationSeconds: 700, manifest: man(2800) }, { chapterId: 'b', durationSeconds: 700, manifest: man(2800) }]); } catch (x) { e = x; }
    assert(e && /^AUDIOBOOK_TOO_SHORT_FOR_SOURCE/.test(e.message) && /bloques bajo el objetivo/.test(e.message), `diagnóstico: ${e && e.message}`);
    const ok = AUD.checkAudiobookCourseFloor([{ chapterId: 'a', durationSeconds: 1000, manifest: man(2800) }, { chapterId: 'b', durationSeconds: 1000, manifest: man(2800) }]);
    eq([ok.checked, ok.belowFloor, ok.sourceWords], [true, false, 5600], 'normal ≥ piso');
    const small = AUD.checkAudiobookCourseFloor([{ chapterId: 'a', durationSeconds: 340, manifest: man(900) }]);
    eq([small.checked, small.belowFloor], [true, true], 'chico: sin piso, sin relleno');
    const legacy = AUD.checkAudiobookCourseFloor([{ chapterId: 'a', durationSeconds: 200, manifest: null }, { chapterId: 'b', durationSeconds: 200, manifest: man(2800) }]);
    eq([legacy.checked, legacy.warnings], [false, ['audiobook_floor_skipped_no_manifest:a']], 'curso existente');
  });

  await check('clasificador: «chunk N/M (persisted N-1)» → A (nada pagado sin guardar); el formato viejo con trozos pagados sigue en C; códigos nuevos con regla', () => {
    const v = (e, ctx = {}) => FC.classifyFailure({ scope: 'item', error: e, itemType: 'audiobook_chapter', source: 'provider_worker', ...ctx });
    eq(v('tts_failed: chunk 3/5 (persisted 2): openai POST /audio/speech HTTP 429: rate limit').class, 'A', 'persistidos');
    eq(v('tts_failed: chunk 3/5: HTTP 503').class, 'C', 'legacy');
    for (const c of ['AUDIOBOOK_SECTION_TOO_SHORT', 'AUDIOBOOK_SECTION_PADDED', 'AUDIOBOOK_SCRIPT_REPETITION']) eq(v(`${c}: x`).class, 'B', c);
    for (const c of ['AUDIO_WPM_OUT_OF_RANGE', 'AUDIOBOOK_SEGMENT_DUPLICATE', 'AUDIOBOOK_MANIFEST_INVALID']) eq(v(`${c}: x`).class, 'B', c);
    eq(v('audio_segment_unavailable: seg-1 (404)').class, 'A', 'descarga del segmento');
    eq(v('AUDIOBOOK_PLAN_COVERAGE: x').class, 'D', 'bug del plan');
    eq(FC.classifyFailure({ source: 'package_worker', error: 'AUDIOBOOK_TOO_SHORT_FOR_SOURCE: el audiolibro dura 900 s' }).class, 'D', 'piso a nivel paquete');
  });
}

// ════════════════════════════════════════════════════════════════════════════
const COURSE_MANIFESTS = new Map();
const COURSE_MP3 = new Map();
async function workerChecks() {
  await check('1/7/8. volumen normal: 4 capítulos × ~2.800 palabras → cada capítulo completo con manifiesto; audiolibro ≥ 1500 s; Info = frames; sin silencio insertado; 48 kbps (bienvenida a 64)', async () => {
    const W = memoryWorld();
    const c0 = counts();
    let planned = 0;
    for (const ch of [1, 2, 3, 4]) {
      const md = chapterMd(ch, 2800);
      const plan = AS.planAudiobookSections(md);
      planned += plan.sections.length;
      const it = await claim(W, newItem(W, { ch, md }));
      eq([it.status, it.error ?? null], ['completed', null], `capítulo ${ch}`);
      const m = it.outputSummary.audiobookManifest;
      eq(AUD.validateChapterAudioManifest(m), [], `manifiesto ${ch}`);
      eq(m.script.sections.map((s) => s.sourceSha), plan.sections.map((s) => s.sha256), `todos los bloques del capítulo ${ch} narrados (sha)`);
      eq([m.tts.segmentsExpected, m.tts.segmentsGenerated, m.tts.segmentsConcatenated].every((n) => n === m.tts.segments.length), true, 'esperados = generados = concatenados');
      const buf = audioOf(W, it);
      const info = RP.mp3FrameInfo(buf);
      eq([info.frames, info.infoFrames], [m.audio.frames, m.audio.frames], 'Info = frames del buffer');
      eq(info.frames, m.tts.segments.reduce((a, s) => a + s.frames, 0), 'el concat no inserta frames');
      eq(zeroFrames(buf), 0, 'ningún frame silencioso');
      eq(info.bitrateKbps, 48, 'audiolibro a 48 kbps');
      assert(m.audio.wpm >= 115 && m.audio.wpm <= 175, `ritmo ${m.audio.wpm}`);
      assert(m.script.ratio >= 0.85 && m.script.ratio <= 1.1, `ratio ${m.script.ratio}`);
      COURSE_MANIFESTS.set(`ch${ch}`, m);
      COURSE_MP3.set(`ch${ch}`, buf);
    }
    const d = delta(c0);
    eq(d.llm, planned, 'una llamada LLM por bloque (sin continuaciones)');
    const ab = AUD.assembleAudiobook([1, 2, 3, 4].map((n) => ({ chapterId: `ch${n}`, chapterNumber: n, mp3: COURSE_MP3.get(`ch${n}`) })), { manifests: COURSE_MANIFESTS });
    assert(ab.durationSeconds >= 1500, `audiolibro ${ab.durationSeconds} s`);
    eq(ab.parts.map((p) => p.chapterId), ['ch1', 'ch2', 'ch3', 'ch4'], 'todos los capítulos');
    eq([ab.floor.checked, ab.floor.belowFloor], [true, false], 'piso evaluado');
    const tot = RP.mp3FrameInfo(ab.buffer);
    assert(Math.abs(tot.infoFrames * FRAME_SECONDS - ab.durationSeconds) < 1e-6, 'Info del curso = duración por frames');
    console.log(`   4 × 2.800: ${(ab.durationSeconds / 60).toFixed(1)} min, ${d.llm} llamadas LLM, ${d.tts} segmentos TTS, ${(ab.buffer.length / 1e6).toFixed(1)} MB`);
    // Bienvenida: sin cambios (64 kbps).
    const wel = newItem(W, { ch: 0, md: '', type: 'audio_welcome' });
    wel.dependencyArtifacts = [{ type: 'dynamic_course_intro_json', artifactId: (() => { const id = crypto.randomUUID(); W.artifacts.push({ id, text: JSON.stringify({ welcome: 'Te damos la bienvenida al curso. Vamos a aprender juntos paso a paso.' }) }); return id; })() }];
    await claim(W, wel);
    eq([wel.status, RP.mp3FrameInfo(audioOf(W, wel)).bitrateKbps], ['completed', 64], 'bienvenida a 64 kbps');
  });

  await check('2. curso chico (1 × 900 palabras) → completo, sin relleno: duración = palabras narradas / ritmo (±2 %), piso no aplica', async () => {
    const W = memoryWorld();
    const it = await claim(W, newItem(W, { ch: 1, md: chapterMd(1, 900) }));
    eq(it.status, 'completed', `completo (${it.error})`);
    const m = it.outputSummary.audiobookManifest;
    const expected = AUD.expectedSecondsForWords(m.tts.wordsSent);
    assert(Math.abs(m.audio.seconds - expected) / expected < 0.02, `duración ${m.audio.seconds} vs ${expected}`);
    const ab = AUD.assembleAudiobook([{ chapterId: 'ch1', chapterNumber: 1, mp3: audioOf(W, it) }], { manifests: new Map([['ch1', m]]) });
    eq([ab.floor.belowFloor, ab.durationSeconds < 1500], [true, true], 'chico: sigue al contenido');
  });

  await check('3. falla el segmento 3 (429 definitivo) → reintentable, «persisted 2»; el reintento sintetiza SOLO desde el 3 (0 LLM) y nunca repaga los guardados', async () => {
    const W = memoryWorld();
    const md = chapterMd(5, 2800);
    const it = newItem(W, { ch: 5, md });
    // Los dos primeros pasan; el tercero recibe 429 (rechazo definitivo: sin gasto, reserva liberada).
    const c0 = counts();
    let n = 0;
    FAKES.plan.ttsFail = { shift: () => (++n === 3 ? 429 : undefined) };
    await claim(W, it);
    FAKES.plan.ttsFail = [];
    eq(it.status, 'retrying', `reintentable (${it.error})`);
    assert(/^tts_failed: chunk 3\/\d+ \(persisted 2\)/.test(it.error), it.error);
    eq(FC.classifyFailure({ scope: 'item', error: it.error, itemType: 'audiobook_chapter', source: 'provider_worker' }).class, 'A', 'clase A');
    const segsTotal = Number(/chunk 3\/(\d+)/.exec(it.error)[1]);
    const d1 = delta(c0);
    eq(d1.tts, 3, '3 llamadas TTS (2 pagadas + el 429)');
    eq(Object.keys(it.outputSummary.audioSegments).length, 2, '2 segmentos guardados');
    const c1 = counts();
    await claim(W, nextAttempt(it));
    eq(it.status, 'completed', `completa (${it.error})`);
    eq(delta(c1), { tts: segsTotal - 2, llm: 0 }, 'solo los segmentos que faltaban; 0 LLM');
    eq(it.outputSummary.reusedSegments, 2, 'reutilizó los 2 guardados');
    const charges = W.ledgerRows.filter((r) => r.provider === 'openai' && !r.reservation);
    eq(charges.length, segsTotal, 'un cargo TTS por segmento (nunca dos)');
    eq(new Set(charges.map((r) => r.external_operation_id)).size, segsTotal, 'request ids distintos');
  });

  await check('4. guion corto → continuación aceptada; sigue corto → AUDIOBOOK_SECTION_TOO_SHORT (no completo); el reintento pide SOLO ese bloque y los siguientes', async () => {
    const W = memoryWorld();
    const c0 = counts();
    FAKES.plan.llmShortFirst = 1;
    const ok = await claim(W, newItem(W, { ch: 6, md: chapterMd(6, 1200) }));
    eq(ok.status, 'completed', `continuación aceptada (${ok.error})`);
    assert(ok.outputSummary.audiobookManifest.script.sections[0].continued === true, 'bloque 1 continuado');
    const n6 = AS.planAudiobookSections(chapterMd(6, 1200)).sections.length;
    eq(delta(c0).llm, n6 + 1, 'una continuación');

    const md = chapterMd(7, 1500);
    const n = AS.planAudiobookSections(md).sections.length;
    const it = newItem(W, { ch: 7, md });
    const c1 = counts();
    // Bloque 1 OK; bloque 2: principal y continuación diminutas (las 2 llamadas que siguen a la primera).
    const st = FAKES.st;
    const before = st.llm.length;
    Object.defineProperty(FAKES.plan, 'llmTiny', { configurable: true, get() { const calls = st.llm.length - before; return calls >= 1 && calls <= 2 ? 1 : 0; }, set() {} });
    await claim(W, it);
    Object.defineProperty(FAKES.plan, 'llmTiny', { configurable: true, writable: true, value: 0 });
    eq(it.status, 'retrying', `no completo (${it.error})`);
    assert(/^AUDIOBOOK_SECTION_TOO_SHORT: el guion del bloque 2/.test(it.error), it.error);
    eq(it.completion, undefined, 'nunca completeItem');
    eq(Object.keys(it.outputSummary.audiobookSections), ['0'], 'el bloque 1 quedó guardado');
    eq(delta(c1), { tts: 0, llm: 3 }, '3 llamadas LLM, 0 TTS');
    const c2 = counts();
    await claim(W, nextAttempt(it));
    eq(it.status, 'completed', `completa (${it.error})`);
    eq(delta(c2).llm, n - 1, 'solo el bloque fallido y los siguientes');
  });

  await check('5. duplicados: bloque que repite otro → AUDIOBOOK_SCRIPT_REPETITION (solo se regenera ése); audio idéntico en dos segmentos → AUDIOBOOK_SEGMENT_DUPLICATE (no completo)', async () => {
    const W = memoryWorld();
    // Dos secciones del MISMO tamaño: el duplicado pasa la banda y lo atrapa el anti-bucle.
    const eqMd = `# Dup\n\n## Uno\n\n${para(300, 'u')}\n\n## Dos\n\n${para(300, 'v')}\n\n## Tres\n\n${para(300, 'x')}`;
    const it = newItem(W, { ch: 8, md: eqMd });
    FAKES.plan.llmDuplicate = 0;
    let k = 0;
    Object.defineProperty(FAKES.plan, 'llmDuplicate', { configurable: true, get() { return ++k === 2 ? 1 : 0; }, set() {} });
    await claim(W, it);
    Object.defineProperty(FAKES.plan, 'llmDuplicate', { configurable: true, writable: true, value: 0 });
    eq(it.status, 'retrying', `no completo (${it.error})`);
    assert(/^AUDIOBOOK_SCRIPT_REPETITION: los bloques 1 y 2 son idénticos/.test(it.error), it.error);
    eq(Object.keys(it.outputSummary.audiobookSections).sort(), ['0', '2'], 'se descartó solo el bloque repetido');
    const c0 = counts();
    await claim(W, nextAttempt(it));
    eq([it.status, delta(c0).llm], ['completed', 1], `solo ese bloque (${it.error})`);

    const W2 = memoryWorld();
    // Sin preámbulo: los dos primeros bloques narran las mismas palabras → misma duración → bytes idénticos.
    const it2 = newItem(W2, { ch: 9, md: `## Uno\n\n${para(300, 'p')}\n\n## Dos\n\n${para(300, 'q')}` });
    FAKES.plan.ttsSameAudio = 2; // dos segmentos de igual duración reciben bytes idénticos
    await claim(W2, it2);
    FAKES.plan.ttsSameAudio = 0;
    eq(it2.status, 'retrying', `no completo (${it2.error})`);
    assert(/^AUDIOBOOK_SEGMENT_DUPLICATE/.test(it2.error), it2.error);
    eq(it2.completion, undefined, 'nunca completeItem');
  });

  await check('6. segmento guardado corrupto en Storage → diagnóstico: se regenera SOLO ése (el resto se reutiliza, 0 LLM)', async () => {
    const W = memoryWorld();
    const md = chapterMd(10, 1500);
    const it = newItem(W, { ch: 10, md });
    let n = 0;
    FAKES.plan.ttsFail = { shift: () => (++n === 3 ? 429 : undefined) };
    await claim(W, it);
    FAKES.plan.ttsFail = [];
    eq(it.status, 'retrying', 'cortado en el 3');
    const firstKey = Object.keys(it.outputSummary.audioSegments)[0];
    const p = it.outputSummary.audioSegments[firstKey].storagePath;
    const blob = W.blobs.get(`cursia-artifacts/${p}`);
    W.blobs.set(`cursia-artifacts/${p}`, blob.subarray(0, blob.length - 3 * 64)); // le falta un frame
    const total = Number(/chunk 3\/(\d+)/.exec(it.error)[1]);
    const c0 = counts();
    await claim(W, nextAttempt(it));
    eq(it.status, 'completed', `completa (${it.error})`);
    eq(delta(c0), { tts: total - 2 + 1, llm: 0 }, 'los que faltaban + el corrupto');
    eq(it.outputSummary.reusedSegments, 1, 'el otro guardado se reutilizó');
    assert(LOGS.some((l) => l.includes(firstKey) && /no coincide con su manifiesto/.test(l)), 'diagnóstico en el log');
  });

  await check('8. voz ralentizada (doble de duración por palabra) → AUDIO_WPM_OUT_OF_RANGE: no se guarda ni se completa; el reintento regenera solo ese segmento', async () => {
    const W = memoryWorld();
    const it = newItem(W, { ch: 11, md: chapterMd(11, 900) });
    FAKES.plan.ttsSlow = 1;
    await claim(W, it);
    FAKES.plan.ttsSlow = 0;
    eq(it.status, 'retrying', `no completo (${it.error})`);
    assert(/^AUDIO_WPM_OUT_OF_RANGE/.test(it.error), it.error);
    eq(Object.keys(it.outputSummary.audioSegments || {}).length, 0, 'el segmento lento no se guardó');
    const c0 = counts();
    await claim(W, nextAttempt(it));
    eq([it.status, delta(c0).llm], ['completed', 0], `completa sin repagar el guion (${it.error})`);
  });

  await check('9. costo incierto (conexión cortada tras enviar el segmento 2) → reconciliación, 0 reintentos automáticos; el re-claim común no llama; tras la decisión explícita solo se sintetiza lo que falta', async () => {
    const W = memoryWorld();
    const it = newItem(W, { ch: 12, md: chapterMd(12, 1500) });
    let n = 0;
    FAKES.plan.ttsFail = { shift: () => (++n === 2 ? 'drop' : undefined) };
    await claim(W, it);
    FAKES.plan.ttsFail = [];
    eq(it.status, 'failed', `no reintentable (${it.error})`);
    assert(/^provider_reconciliation_required: openai/.test(it.error), it.error);
    const pending = W.ledgerRows.filter((r) => r.reservation && !r.settled);
    eq(pending.length, 1, 'una reserva pendiente: SOLO la del segmento incierto');
    assert(/seg_seg-/.test(pending[0].idempotency_key), pending[0].idempotency_key);
    const c0 = counts();
    await claim(W, nextAttempt(it));
    eq([it.status, delta(c0)], ['failed', { tts: 0, llm: 0 }], 're-claim común: 0 llamadas');
    assert(/^provider_reconciliation_required: openai/.test(it.error), it.error);
    // Decisión explícita (resubmitProvider / #583): reconoce los intentos hasta acá.
    const c1 = counts();
    await claim(W, nextAttempt(it, { reconciliationAcknowledgedThroughAttempt: it.attempt }));
    eq(it.status, 'completed', `completa (${it.error})`);
    const total = it.outputSummary.audiobookManifest.tts.segmentsExpected;
    eq(delta(c1), { tts: total - 1, llm: 0 }, 'el segmento 1 guardado NO se repaga');
  });
}

// ════════════════════════════════════════════════════════════════════════════
async function packagingChecks() {
  await check('10. re-empaque de un curso existente (audio sin manifiesto) → el paquete se arma, 0 llamadas TTS / LLM, el piso se omite con aviso', async () => {
    const c0 = counts();
    const input = PF.packagingInput(distRoot, {});
    const legacy = await B.buildDynamicMbzV3(input);
    assert(legacy.mbz && legacy.mbz.length > 0, 'paquete');
    eq(legacy.summary.audiobookFloor, undefined, 'sin manifiestos: nada cambia en el resumen');
    const ids = [...input.contents.audiobookChapters.keys()];
    const withNulls = await B.buildDynamicMbzV3({ ...input, contents: { ...input.contents, audiobookManifests: new Map(ids.map((id) => [id, null])) } });
    eq(withNulls.summary.audiobookFloor.checked, false, 'piso omitido');
    assert(ids.every((id) => withNulls.summary.warnings.includes(`audiobook_floor_skipped_no_manifest:${id}`)), JSON.stringify(withNulls.summary.warnings));
    eq(delta(c0), { tts: 0, llm: 0 }, '0 llamadas a proveedores');
  });

  await check('piso en el empaque: manifiestos de un curso de volumen normal con audio corto → AUDIOBOOK_TOO_SHORT_FOR_SOURCE (nunca un audiolibro corto en silencio)', async () => {
    const input = PF.packagingInput(distRoot, {});
    const ids = [...input.contents.audiobookChapters.keys()];
    const fake = { source: { narratableWords: 2800 }, script: { words: 2520, sections: [{ idx: 0, ratio: 0.9 }] }, tts: { segmentsExpected: 1, segmentsGenerated: 1, segmentsConcatenated: 1 }, audio: { wpm: 141 } };
    await rejectsRe(B.buildDynamicMbzV3({ ...input, contents: { ...input.contents, audiobookManifests: new Map(ids.map((id) => [id, fake])) } }), /AUDIOBOOK_TOO_SHORT_FOR_SOURCE/, 'piso');
  });
}

// ════════════════════════════════════════════════════════════════════════════
async function finopsChecks() {
  await check('FinOps: priors v1.6 ≈ US$0.35 por capítulo (p50), estimado ∝ palabras del capítulo; #625 (2×1) y #616 (2×2) antes/después', () => {
    const seed = JSON.parse(fs.readFileSync(path.join(REPO, 'src/modules/finops/pricing-seed.v1.json'), 'utf8'));
    const catalog = seed.rows.map((r, i) => ({ id: `seed-${i}`, ...r }));
    const est = (items) => F.estimateCost({ items, catalog, usageModel: F.usageModelPriorsV1(), retryPolicy: { maxRetries: 1 } });
    const one = est([{ itemKey: 'a', itemType: 'audiobook_chapter' }]);
    const perChapter = Number(one.totals.expected);
    const ttsLine = one.lines.find((l) => l.provider === 'openai');
    const p50 = perChapter / 1.15;
    assert(p50 > 0.3 && p50 < 0.4, `p50 por capítulo ${p50}`);
    eq(RB.audiobookUsageScale(1400), 0.5, 'escala');
    const half = RB.estimateItemsForRun([{ key: 'audiobook_chapter:c1', type: 'audiobook_chapter', chapterId: 'c1', moduleId: 'm1' }], 'real', null, { chapterWords: { c1: 1400 } });
    eq(half[0].usageScale, 0.5, 'item con escala');
    const e = est(half);
    assert(Math.abs(Number(e.totals.expected) - perChapter / 2) < 0.01, 'mitad de palabras ≈ mitad de costo');
    // Medido vs estimado (±25 %): el ledger falso del escenario 1 (tokens de la fake + segundos de audio medidos).
    const course = (mods, chs) => {
      const man = [];
      for (let m = 1; m <= mods; m++) for (let c = 1; c <= chs; c++) man.push({ key: `audiobook_chapter:m${m}c${c}`, type: 'audiobook_chapter', chapterId: `m${m}c${c}`, moduleId: `m${m}` });
      return man;
    };
    for (const [name, m, c] of [['#625 (2×1)', 2, 1], ['#616 (2×2)', 2, 2]]) {
      const r = est(RB.estimateItemsForRun(course(m, c), 'real'));
      console.log(`   ${name}: audiolibro estimado ${Number(r.totals.expected).toFixed(2)} USD (antes ${(0.085 * m * c).toFixed(2)})`);
    }
    const secs = [...COURSE_MANIFESTS.values()].reduce((a, x) => a + x.audio.seconds, 0) / COURSE_MANIFESTS.size;
    const ttsUsd = (secs / 60) * 0.015;
    const ttsPrior = Number(ttsLine.expected) / 1.15;
    assert(Math.abs(ttsUsd - ttsPrior) / ttsPrior <= 0.25, `TTS medido ${ttsUsd.toFixed(3)} vs prior ${ttsPrior.toFixed(3)}`);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
