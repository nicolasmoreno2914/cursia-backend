#!/usr/bin/env node
/* eslint-disable */
// Exam-bank Monte Carlo (USD 0, sin red): el ejecutor REAL del frontend (vm, test/e2e-v2/front.js) arma el banco del
// examen del Módulo 2 de #1353 con los 4 capítulos REALES (fixtures fuera del repo) contra un LLM falso con fallas
// reales (test/e2e-v2/llm-exam-bank-sim.js). Repite intentos del item con el borrador del intento anterior, como el
// backend, hasta éxito, EXAM_BANK_LEAF_CAPACITY (clase D: el backend no reintenta) o MAX_ATTEMPTS.
//
// Uso: node scripts/sim-exam-bank-montecarlo.js --fe <frontend> --fixtures <dir> [--profile a|b|c] [--runs 200]
//        [--x 0.18] [--refFix 0.5] [--maxAttempts 8] [--json out.json]
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const FE = path.resolve(args.fe || path.join(REPO, '..', 'campuscloud-gen'));
const FIX = path.resolve(args.fixtures || path.join(os.homedir(), 'cursia-test-env/fixtures/1353'));
const PROFILE = args.profile || 'a';
const RUNS = Number(args.runs || 200);
const MAX_ATTEMPTS = Number(args.maxAttempts || 8);
const X = Number(args.x || 0.18);
const REF_FIX = args.refFix != null ? Number(args.refFix) : 0.5;
const SEED0 = Number(args.seed0 || 1);

const contract = require(path.join(args.contractDist || path.join(REPO, 'dist'), 'modules/course-shell/exam-bank.js'));
const { makeFront } = require(path.join(REPO, 'test/e2e-v2/front.js'));
const { createSimLlm } = require(path.join(REPO, 'test/e2e-v2/llm-exam-bank-sim.js'));

const meta = JSON.parse(fs.readFileSync(path.join(FIX, 'meta.json'), 'utf8'));
const MD = {};
for (const c of meta.chapters) MD[c.id] = fs.readFileSync(path.join(FIX, c.file), 'utf8');
const OUTLINE = [{ id: meta.moduleId, moduleNumber: meta.moduleNumber, title: meta.moduleTitle, chapters: meta.chapters.map((c) => ({ id: c.id, chapterNumber: c.n, title: c.title })) }];
const CHAPTERS = meta.chapters.map((c) => ({ id: c.id, moduleId: meta.moduleId }));
const CTX = { nombre: 'Atención integral a víctimas de violencia sexual', sector: 'Salud', pais: 'Colombia', ciudad: 'Bogotá', contexto: 'Personal de salud', nivel: 'Universitario', tono: 'cercano y profesional', obj: 'Atender con enfoque de derechos', comp: 'Atiende de forma integral' };
const STUCK = { chapterId: meta.chapters[1].id, type: 'match', capacity: 3 }; // capítulo 2.2 × emparejamiento (#1353)

function item(attempt, draftRef) {
  return {
    type: 'exam', itemKey: `exam:${meta.moduleId}`, itemRunId: 'sim-run-m2', idempotencyKey: 'sim-idem-m2', generation: 1, attempt,
    moduleId: meta.moduleId, blueprint: { outline: OUTLINE }, context: { courseContext: CTX },
    outputSummary: draftRef ? { examBankDraft: { artifactId: draftRef, generation: 1, attempt: attempt - 1 } } : {},
    claimPayload: { examBank: { artifactType: 'dynamic_exam_bank_json', bankVersion: 1, scope: 'module', moduleId: meta.moduleId, bankValidationVersion: 4, draftArtifactType: 'dynamic_exam_bank_draft_json',
      chapters: CHAPTERS.map((c) => ({ chapterId: c.id, moduleId: c.moduleId })), plan: contract.expectedExamPlan('module', CHAPTERS) } },
    dependencyArtifacts: CHAPTERS.map((c) => ({ type: 'dynamic_content_md', itemKey: `content:${c.id}`, artifactId: `md:${c.id}`, storagePath: `x/${c.id}.md` })),
  };
}

function checkBank(doc) {
  const plan = contract.expectedExamPlan('module', CHAPTERS);
  const v = contract.validateExamBank(doc, { scope: 'module', chapters: CHAPTERS, chapterMd: new Map(Object.entries(MD)) });
  const issues = v.ok ? [] : v.errors.slice(0, 5).map((e) => `${e.code} ${e.path}`);
  // Hojas exactamente en 2s, mismos tipos y cobertura que el plan, evidencia textual del capítulo.
  for (const leaf of plan) {
    const n = doc.questions.filter((q) => q.chapterId === leaf.chapterId && q.type === leaf.type).length;
    if (n !== 2 * leaf.slots) issues.push(`leaf ${leaf.chapterId.slice(0, 8)}×${leaf.type} ${n}/${2 * leaf.slots}`);
  }
  const sig = (pl) => pl.map((l) => [l.chapterId, l.type, l.slots].join('|')).join(';');
  if (sig(doc.plan) !== sig(plan)) issues.push('plan distinto');
  for (const q of doc.questions) {
    const norm = contract.normalizeExamText(MD[q.chapterId] || '');
    if (!norm.includes(contract.normalizeExamText(q.evidence))) issues.push(`evidencia no textual ${q.id}`);
  }
  return issues;
}

async function oneRun(seed) {
  const logFile = path.join(os.tmpdir(), `sim-eb-${process.pid}.log`);
  let llm = null;
  const proxy = { respond: (b, h) => llm.respond(b, h) };
  const f = makeFront({ feRoot: FE, backendUrl: 'http://127.0.0.1:9', storageUrl: 'http://127.0.0.1:9', token: 'x', ownerId: '00000000-0000-4000-8000-000000000999', llm: proxy, logFile, netViolations: [] });
  f.DYN_EXAM_BANK_MODE_ENABLED = true;
  f.DYN_LLM_BACKOFF_BASE_MS = 1;
  // --worker 1: mismos ajustes que el worker hospedado (executor-runtime.ts) — partes de ≤ 7000 tokens estimados.
  if (args.worker === '1') { f.DYN_EXAM_BANK_MAX_OUTPUT_EST = 7000; f.DYN_EXAM_BANK_CALL_MAX_TOKENS = 12000; }
  llm = createSimLlm(f, { profile: PROFILE, seed, x: X, refFix: REF_FIX, stuck: STUCK, noise: args.noise || 'realistic', pB: args.pB != null ? Number(args.pB) : 0.6 });
  const drafts = {};
  f._dynDownloadArtifactText = async (id) => {
    if (id && id.startsWith('md:') && MD[id.slice(3)]) return { ok: true, text: MD[id.slice(3)] };
    if (drafts[id]) return { ok: true, text: drafts[id] };
    return { ok: false, error: 'missing' };
  };
  let draftRef = null;
  const out = { seed, attempts: 0, ok: false, code: null, issues: [], firstAttemptOk: false, perAttempt: [] };
  for (let a = 1; a <= MAX_ATTEMPTS; a++) {
    llm.setAttempt(a);
    const before = llm.st.calls;
    const r = await f._dynRunItemV3(item(a, draftRef));
    out.attempts = a;
    out.perAttempt.push({ calls: llm.st.calls - before, ok: !!(r && r.ok), error: r && r.error ? String(r.error).slice(0, 160) : null });
    if (r && r.ok) {
      out.ok = true; out.firstAttemptOk = a === 1;
      out.issues = checkBank(JSON.parse(r.artifacts[0].content));
      out.summary = { rejectedByCode: r.summary.rejectedByCode, calls: r.summary.calls };
      break;
    }
    out.code = String((r && r.error) || '').split(':')[0];
    if (out.code === 'EXAM_BANK_LEAF_CAPACITY' || (r && r.retryable === false)) break;
    if (r && r.draft) { draftRef = `draft:${a}`; drafts[draftRef] = r.draft.content; }
    else if (r && r.draftClear) draftRef = null;
  }
  try { fs.unlinkSync(logFile); } catch (e) { /* nada */ }
  out.calls = llm.st.calls; out.repairCalls = llm.st.repairCalls; out.strategyCalls = llm.st.strategyCalls; out.usd = llm.st.usd;
  out.outputTokens = llm.st.outputTokens; out.mainCalls = llm.st.mainCalls; out.mainQ = llm.st.mainQuestions || 0; out.repairQ = llm.st.repairQuestions || 0; out.faults = llm.st.faults; out.unknown = llm.st.unknownPrompts;
  return out;
}

(async () => {
  const t0 = Date.now();
  const res = [];
  for (let i = 0; i < RUNS; i++) res.push(await oneRun(SEED0 + i));
  const pct = (n) => Math.round((1000 * n) / RUNS) / 10;
  const mean = (k) => res.reduce((t, r) => t + r[k], 0) / RUNS;
  const q = (k, p) => { const v = res.map((r) => r[k]).sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
  const faults = {};
  res.forEach((r) => Object.entries(r.faults).forEach(([k, v]) => { faults[k] = (faults[k] || 0) + v; }));
  const codes = {};
  res.filter((r) => !r.ok).forEach((r) => { codes[r.code] = (codes[r.code] || 0) + 1; });
  const summary = {
    fe: FE, worker: args.worker === '1', noise: args.noise || 'realistic', profile: PROFILE, runs: RUNS, x: X, refFix: REF_FIX, maxAttempts: MAX_ATTEMPTS,
    firstAttemptCompletion: pct(res.filter((r) => r.firstAttemptOk).length),
    completed: pct(res.filter((r) => r.ok).length),
    failedByCode: codes,
    attempts: { mean: +mean('attempts').toFixed(2), p95: q('attempts', 0.95), max: q('attempts', 1) },
    attemptsOnCapacityFail: res.filter((r) => r.code === 'EXAM_BANK_LEAF_CAPACITY').map((r) => r.attempts).reduce((m, a) => Math.max(m, a), 0),
    firstAttemptCalls: +(res.reduce((t, r) => t + r.perAttempt[0].calls, 0) / RUNS).toFixed(1),
    calls: { mean: +mean('calls').toFixed(1), p50: q('calls', 0.5), p95: q('calls', 0.95), max: q('calls', 1) },
    repairCalls: +mean('repairCalls').toFixed(1), mainCalls: +mean('mainCalls').toFixed(1), mainQ: +mean('mainQ').toFixed(1), repairQ: +mean('repairQ').toFixed(1), strategyCalls: +mean('strategyCalls').toFixed(2),
    usd: { mean: +mean('usd').toFixed(3), p95: +q('usd', 0.95).toFixed(3), max: +q('usd', 1).toFixed(3) },
    outputTokens: Math.round(mean('outputTokens')),
    faultMix: faults,
    bankIssues: res.filter((r) => r.ok && r.issues.length).map((r) => ({ seed: r.seed, issues: r.issues })).slice(0, 5),
    acceptedBanks: res.filter((r) => r.ok).length, banksWithIssues: res.filter((r) => r.ok && r.issues.length).length,
    unknownPrompts: res.reduce((t, r) => t + r.unknown, 0),
    sampleFailures: res.filter((r) => !r.ok).slice(0, 2).map((r) => r.perAttempt.slice(-2)),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  console.log(JSON.stringify(summary, null, 1));
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ summary, runs: res }, null, 1));
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
