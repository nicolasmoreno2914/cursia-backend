/* eslint-disable */
// r61 (F) — MODELAB · BASELINE offline (USD 0) contra el que compara el A/B:
//   1) salidas REALES de Sonnet 4.6 del curso #1510 (paquete extraído en r60/D-scratch: H5P de actividad y de video,
//      Libro Guía, etiquetas) → mismos graders deterministas que los brazos;
//   2) tasas de la evidencia del ledger (#1353/#1510): llamadas por ítem válido (proxy de reintentos);
//   3) rechazos de primera pasada documentados del banco de examen (B-model-audit §4.2, validation/ de #1353).
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./grade');
const P = require('./project');

const FIRST_PASS_EXAM_EVIDENCE = Object.freeze({
  source: '~/cursia-test-env/work/r60/B-model-audit.md §4.2 (validation/exam-bank-investigation-2026-10-14.md, final-exam-run1..3)',
  preFix_bank_firstAttemptRejections: { SCHEMA: 0.33, EVIDENCE: 0.32, DISTRACTORS: 0.26, LENGTH_BIAS: 0.07 },
  postFix_M2_bank: { attempts: 1, calls: 17, usd: 1.631, repairCallsShare: 9 / 17, rejections: { LENGTH_BIAS: 38, DISTRACTORS: 25, SCHEMA: 9 }, mcYieldFirstPass: 0.61, mcYieldRepair: 0.48 },
  postFix_finalExam_run3: { completed: true, paidCalls: 43, usd: 2.95, rejections: { LENGTH_BIAS: 47, SCHEMA: 23, DISTRACTORS: 12, MISSING_FIELD: 12 }, correctLongestShare: 0.188 },
});

function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function packageBaseline(distRoot, dir) {
  const out = { source: dir, available: false };
  const h5pa = readIf(path.join(dir, 'h5pa/content/content.json'));
  const h5pv = readIf(path.join(dir, 'h5pv/content/content.json'));
  const libro = readIf(path.join(dir, 'libro.txt'));
  const labels = readIf(path.join(dir, 'labels.txt'));
  if (!h5pa && !h5pv && !libro) return out;
  out.available = true;
  out.course = '#1510 (S 1×1, Sonnet 4.6 real, staging)';
  const parse = (s) => { try { return { ok: true, v: JSON.parse(s) } } catch { return { ok: false } } };
  if (h5pa) { const j = parse(h5pa); out.activity = { jsonValid: j.ok, ...(j.ok ? G.gradeDocs(distRoot, [j.v]) : {}) }; }
  if (h5pv) { const j = parse(h5pv); out.video_interactions = { jsonValid: j.ok, interactions: j.ok ? (j.v.interactiveVideo.assets.interactions || []).length : 0, ...(j.ok ? G.gradeDocs(distRoot, [j.v]) : {}) }; }
  if (libro) out.content_libro = G.gradeDocs(distRoot, [libro]);
  if (labels) out.labels = G.gradeDocs(distRoot, [labels]);
  return out;
}

function ledgerBaseline() {
  const rows = [];
  for (const [c, ev] of Object.entries(P.EVIDENCE_M)) {
    const s = P.EVIDENCE_S[c];
    rows.push({
      component: c, m1353_items: ev.items, m1353_calls: ev.calls, m1353_callsPerValidItem: Math.round(ev.calls / ev.items * 100) / 100,
      m1353_avgOutPerCall: Math.round(ev.out / ev.calls), s1510_calls: s ? s.calls : null, s1510_out: s ? s.out : null,
    });
  }
  return rows;
}

function buildBaseline(distRoot, o = {}) {
  return {
    generatedBy: 'scripts/modelab baseline (USD 0, sin red)',
    package1510: packageBaseline(distRoot, o.packageDir || path.join(process.env.HOME || '', 'cursia-test-env/work/r60/D-scratch/out')),
    ledger: ledgerBaseline(),
    examFirstPass: FIRST_PASS_EXAM_EVIDENCE,
    caveats: [
      'El ledger offline solo trae TOTALES por componente: no hay distribución por llamada (p95) ni códigos de rechazo por llamada fuera del banco de examen.',
      'El paquete #1510 es la salida RENDERIZADA (H5P/HTML): mide sesgo de largo, repetición e idioma, no la validación v3 de primera pasada.',
      'Las fixtures de replay del repo (scripts/fixtures/replay) son SINTÉTICAS (LLM falso del E2E): sirven para probar el arnés, no como baseline de calidad.',
    ],
  };
}

module.exports = { buildBaseline, packageBaseline, ledgerBaseline, FIRST_PASS_EXAM_EVIDENCE };
