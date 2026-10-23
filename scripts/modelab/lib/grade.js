/* eslint-disable */
// r61 (F) — MODELAB · calificación DETERMINISTA (USD 0) de las salidas de un brazo. Reutiliza los validadores del
// repo donde existen (validación v3 del driver = la de completeItem; lqaSentenceFindings del QA de idioma;
// videoMcLengthBias; informe de calidad del paquete). Los proxies propios (repetición por shingles, inglés filtrado,
// marcadores editoriales) están marcados como tales.
'use strict';
const path = require('path');

const SHINGLE = 12; // mismo tamaño que el anti-bucle del audiolibro (AUDIOBOOK_SHINGLE_WORDS)
const ENGLISH_MARKERS = /\b(the|and|of|to|is|with|for|you|this|that|are|your)\b/gi;
// «TODO»/«TBD» solo en MAYÚSCULAS (en español «todo» es una palabra común).
const EDITORIAL_RE = /(lorem ipsum|placeholder|⚠️\s*Pendiente|\[insert|\{\{|\}\}|as an ai|como (?:modelo|ia) de lenguaje)/i;
const EDITORIAL_CS_RE = /\b(TODO|TBD|FIXME|XXX)\b/;
const TECH_KEYS = new Set(['id', 'chapterId', 'moduleId', 'itemKey', 'url', 'href', 'src', 'type', 'kind', 'library', 'subContentId', 'path', 'mime', 'license', 'youtubeId', 'videoId', 'slug', 'sourceRef', 'evidenceRef', 'refs']);

// Subárboles de interfaz/metadatos del H5P renderizado (títulos que repiten la pregunta, textos de botones, l10n):
// no son contenido generado y distorsionan la repetición.
const SKIP_SUBTREES = new Set(['metadata', 'l10n', 'texts', 'override', 'behaviour', 'UI', 'i18n', 'a11y', 'overallFeedback', 'endGame', 'introPage']);
function strings(v, out = [], key = null) {
  if (SKIP_SUBTREES.has(key)) return out;
  if (typeof v === 'string') { if (!TECH_KEYS.has(key)) out.push(v); return out; }
  if (Array.isArray(v)) { for (const x of v) strings(x, out, key); return out; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, out, k);
  return out;
}
const stripHtml = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => stripHtml(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const sentences = (s) => stripHtml(s).split(/(?<=[.!?¿¡])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length > 3);

/** MC del documento: objetos con `answers`/`options` de {text, correct:boolean}. */
function mcQuestions(doc) {
  const qs = [];
  (function walk(v) {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    for (const key of ['answers', 'options', 'choices']) {
      const arr = v[key];
      if (Array.isArray(arr) && arr.length >= 2 && arr.every((a) => a && typeof a === 'object' && typeof (a.text ?? a.label) === 'string' && typeof (a.correct ?? a.isCorrect) === 'boolean')) {
        qs.push(arr.map((a) => ({ len: stripHtml(a.text ?? a.label).length, correct: (a.correct ?? a.isCorrect) === true })));
      }
    }
    for (const x of Object.values(v)) walk(x);
  })(doc);
  return qs;
}

/** Sesgo de largo de la correcta (correcta estrictamente más larga que todo distractor) con z contra el azar. */
function answerLengthBias(docs) {
  let mc = 0, longest = 0, expected = 0, variance = 0, sumRatio = 0;
  for (const d of docs) for (const q of mcQuestions(d)) {
    const right = q.filter((a) => a.correct), wrong = q.filter((a) => !a.correct);
    if (right.length !== 1 || !wrong.length) continue;
    mc++;
    const p = 1 / q.length; expected += p; variance += p * (1 - p);
    const maxWrong = Math.max(...wrong.map((a) => a.len));
    if (right[0].len > maxWrong) longest++;
    sumRatio += right[0].len / Math.max(1, wrong.reduce((s, a) => s + a.len, 0) / wrong.length);
  }
  return { mc, correctLongest: longest, share: mc ? round(longest / mc) : null, expectedShare: mc ? round(expected / mc) : null, z: variance > 0 ? round((longest - expected) / Math.sqrt(variance)) : null, meanCorrectToDistractorLen: mc ? round(sumRatio / mc) : null };
}

/** Repetición: shingles de 12 palabras que aparecen más de una vez en el mismo texto. */
function repetition(text) {
  const w = words(text);
  if (w.length < SHINGLE * 2) return { words: w.length, shingles: 0, repeated: 0, ratio: 0 };
  const seen = new Map();
  for (let i = 0; i + SHINGLE <= w.length; i++) { const k = w.slice(i, i + SHINGLE).join(' '); seen.set(k, (seen.get(k) || 0) + 1); }
  let rep = 0; for (const n of seen.values()) if (n > 1) rep += n - 1;
  const total = w.length - SHINGLE + 1;
  return { words: w.length, shingles: total, repeated: rep, ratio: round(rep / total) };
}

function editorial(texts, lqa) {
  const out = { sentences: 0, VOSEO: 0, VOSOTROS: 0, REGIONAL: 0, ENGLISH_SENTENCES: 0, EDITORIAL_MARKERS: 0, examples: [] };
  for (const t of texts) {
    if (EDITORIAL_RE.test(t) || EDITORIAL_CS_RE.test(t)) { out.EDITORIAL_MARKERS++; if (out.examples.length < 5) out.examples.push({ code: 'EDITORIAL', text: stripHtml(t).slice(0, 120) }); }
    for (const s of sentences(t)) {
      out.sentences++;
      if (lqa) for (const f of lqa(s)) { out[f.code] = (out[f.code] || 0) + 1; if (out.examples.length < 5) out.examples.push({ code: f.code, term: f.term }); }
      const en = (s.match(ENGLISH_MARKERS) || []).length;
      if (en >= 3 && en / Math.max(1, words(s).length) > 0.15) { out.ENGLISH_SENTENCES++; if (out.examples.length < 5) out.examples.push({ code: 'ENGLISH', text: s.slice(0, 120) }); }
    }
  }
  return out;
}

function round(x) { return Math.round(x * 1000) / 1000; }

function lqaOf(distRoot) {
  try { return require(path.join(distRoot, 'modules/language-qa/language-qa.js')).lqaSentenceFindings; } catch { return null; }
}

/** Métricas de un conjunto de documentos (JSON parseado o texto). */
function gradeDocs(distRoot, docs) {
  const lqa = lqaOf(distRoot);
  const texts = [];
  const rep = [];
  const jsonDocs = [];
  for (const d of docs) {
    if (typeof d === 'string') { texts.push(d); rep.push(repetition(d)); }
    else {
      // Strings idénticos repetidos en campos distintos (p. ej. la retroalimentación que el H5P copia en dos lugares) se
      // cuentan una vez: la repetición mide al MODELO repitiéndose, no la duplicación de campos del formato.
      jsonDocs.push(d); const ss = [...new Set(strings(d).map((x) => stripHtml(x)))]; texts.push(...ss); rep.push(repetition(ss.join('\n')));
    }
  }
  const repTotal = rep.reduce((a, r) => ({ shingles: a.shingles + r.shingles, repeated: a.repeated + r.repeated, words: a.words + r.words }), { shingles: 0, repeated: 0, words: 0 });
  return {
    docs: docs.length,
    words: repTotal.words,
    answerLengthBias: answerLengthBias(jsonDocs),
    repetition: { ...repTotal, ratio: repTotal.shingles ? round(repTotal.repeated / repTotal.shingles) : 0, maxDocRatio: rep.length ? Math.max(...rep.map((r) => r.ratio)) : 0 },
    editorial: editorial(texts, lqa),
  };
}

/** Calificación de una corrida del driver (por componente objetivo) + contabilidad de llamadas del brazo. */
function gradeArmRun(distRoot, driverRes, targetKeys, calls) {
  const perType = {};
  for (const key of targetKeys) {
    const it = driverRes.items[key];
    if (!it) continue;
    const t = (perType[it.type] = perType[it.type] || { items: 0, completed: 0, firstPassValid: 0, jsonInvalid: 0, failed: [], calls: 0, nonMainCalls: 0, stop: {}, usd: 0, docs: [] });
    t.items++;
    const mine = calls.filter((c) => c.itemKey === key);
    t.calls += mine.length;
    const nonMain = mine.filter((c) => c.callRole !== 'main');
    t.nonMainCalls += nonMain.length;
    for (const c of mine) { t.stop[c.stopReason || 'none'] = (t.stop[c.stopReason || 'none'] || 0) + 1; t.usd += Number(c.usd || 0); }
    if (it.status === 'completed') {
      t.completed++;
      if (!nonMain.length && !mine.some((c) => c.stopReason === 'max_tokens' || c.stopReason === 'refusal')) t.firstPassValid++;
      for (const a of it.artifacts) {
        const txt = driverRes.artifactText(a.id);
        if (/json/.test(a.mimeType || '') || /\.json$/.test(a.filename || '')) { try { t.docs.push(JSON.parse(txt)); } catch { t.jsonInvalid++; } }
        else t.docs.push(txt);
      }
    } else t.failed.push({ key, error: String(it.error || '').slice(0, 240) });
  }
  const out = {};
  for (const [type, t] of Object.entries(perType)) {
    out[type] = {
      items: t.items, completed: t.completed, firstPassValidity: t.items ? round(t.firstPassValid / t.items) : null, jsonInvalid: t.jsonInvalid,
      hardFailures: t.failed, calls: t.calls, retriesPerItem: t.items ? round(t.nonMainCalls / t.items) : null, stopReasons: t.stop,
      usd: round(t.usd), usdPerValidItem: t.completed ? round(t.usd / t.completed) : null,
      quality: gradeDocs(distRoot, t.docs),
    };
  }
  return out;
}

module.exports = { gradeDocs, gradeArmRun, answerLengthBias, repetition, editorial, mcQuestions, strings };
