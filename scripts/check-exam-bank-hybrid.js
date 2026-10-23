#!/usr/bin/env node
/* eslint-disable */
// Exam-bank D (#1353) — regresión del gate: evidencia por referencia, pool de candidatas, memoria por hoja con
// estrategia alternativa y corte temprano (EXAM_BANK_LEAF_CAPACITY), con el ejecutor REAL (vm) y el LLM falso con
// fallas reales (test/e2e-v2/llm-exam-bank-sim.js). Corre el simulador de Monte Carlo (scripts/sim-exam-bank-montecarlo.js)
// con pocas semillas sobre capítulos SINTÉTICOS (el Markdown del LLM falso del E2E): sin red, sin DB, USD 0.
// El Monte Carlo completo (200 semillas, capítulos reales de #1353) corre fuera del gate (los textos son de la institución).
//
// Uso: CURSIA_FRONTEND_REPO=<campuscloud-gen> node scripts/check-exam-bank-hybrid.js   (requiere `npm run build`)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const FE = path.resolve(process.env.CURSIA_FRONTEND_REPO || path.join(REPO, '..', 'campuscloud-gen'));
let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`✅ ${msg}`); } else { fail++; console.log(`❌ ${msg}${detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 1500) : ''}`); }
}
if (!fs.existsSync(path.join(FE, 'src/js/45-dynamic-generation-executor.js'))) { console.log(`❌ frontend no encontrado en ${FE}`); process.exit(1); }

// Capítulos sintéticos: el Markdown que el LLM falso del E2E devuelve para el content (4 capítulos de un módulo).
const { createLlm } = require(path.join(REPO, 'test/e2e-v2/llm.js'));
const { createLlmV3 } = require(path.join(REPO, 'test/e2e-v2/llm-v3.js'));
const base = createLlm({ getFixtures: () => ({}), getSplit: () => ({}) });
const v3 = createLlmV3({ base });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-hybrid-'));
const titles = ['Presión y caudal en planta', 'Fluidos y contaminación del aceite', 'Bombas de engranajes y paletas', 'Válvulas de control direccional'];
const meta = { course: 0, moduleId: '0e0e0e0e-0000-4000-8000-000000000201', moduleTitle: 'Fundamentos del circuito', moduleNumber: 1, chapters: [] };
titles.forEach((t, i) => {
  const cid = `0e0e0e0e-0000-4000-8000-00000000030${i + 1}`;
  v3.st.moduleByTitle.set(meta.moduleTitle, meta.moduleId); v3.st.chapterByTitle.set(t, cid); v3.st.moduleOfChapter.set(cid, meta.moduleId);
  const out = base.respond({ messages: [{ content: `CONTEXTO DEL CURSO\n\nGenera el CAPÍTULO ${i + 1} COMPLETO: "${t}"\nMódulo 1` }] });
  const id = `0e0e0e0e-0000-4000-8000-00000000030${i + 1}`;
  fs.writeFileSync(path.join(dir, `ch-${i + 1}.md`), out.text.replace(/\n*```json context_summary[\s\S]*$/, ''));
  meta.chapters.push({ id, n: i + 1, title: t, file: `ch-${i + 1}.md` });
});
fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* nada */ } });

function sim(profile, runs, extra) {
  const outFile = path.join(dir, `sim-${profile}.json`);
  execFileSync(process.execPath, [path.join(REPO, 'scripts/sim-exam-bank-montecarlo.js'), '--fe', FE, '--fixtures', dir, '--profile', profile, '--runs', String(runs), '--json', outFile].concat(extra || []), { stdio: ['ignore', 'ignore', 'inherit'], timeout: 600000 });
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

const a = sim('a', 12, ['--x', '0.21']);
ok(a.summary.unknownPrompts === 0, 'perfil a: el LLM falso reconoce todos los prompts (fuente marcada [S#], reparación con memoria)');
ok(a.summary.firstAttemptCompletion >= 90 && a.summary.completed === 100, `perfil a (calibrado #1353): ${a.summary.firstAttemptCompletion} % completo en el 1.er intento, ${a.summary.completed} % completo`, a.summary);
ok(a.summary.acceptedBanks > 0 && a.summary.banksWithIssues === 0, `perfil a: ${a.summary.acceptedBanks} bancos aceptados, todos validados por validateExamBank (evidencia textual), 2·slots por hoja, mismo plan`, a.summary.bankIssues);
const runsA = a.runs.filter((r) => r.ok);
ok(runsA.every((r) => r.summary && r.summary.calls), 'perfil a: cada banco trae el resumen de llamadas');
const b = sim('b', 6, ['--x', '0.21']);
ok(b.summary.completed === 100 && b.summary.strategyCalls > 0, `perfil b (hoja atascada): ${b.summary.completed} % completo vía la estrategia alternativa (${b.summary.strategyCalls} llamadas con el marcador por corrida)`, b.summary);
ok(b.summary.banksWithIssues === 0, 'perfil b: bancos válidos (validateExamBank, 2·slots, mismo plan, evidencia textual)', b.summary.bankIssues);
const c = sim('c', 6, ['--x', '0.21']);
ok(c.summary.completed === 0 && (c.summary.failedByCode.EXAM_BANK_LEAF_CAPACITY || 0) === 6, `perfil c (capacidad agotada): las 6 corridas fallan con EXAM_BANK_LEAF_CAPACITY`, c.summary.failedByCode);
ok(c.summary.attemptsOnCapacityFail <= 2, `perfil c: el corte llega en ≤ 2 intentos (máx. ${c.summary.attemptsOnCapacityFail})`);
ok(c.runs.every((r) => /EXAM_BANK_LEAF_CAPACITY: .*× match [0-3]\/4 .*estrategia alternativa/.test((r.perAttempt[r.perAttempt.length - 1] || {}).error || '')), 'perfil c: el mensaje nombra la hoja, el conteo y la estrategia alternativa', c.runs.map((r) => ((r.perAttempt[r.perAttempt.length - 1] || {}).error || '').slice(0, 160)));
// rev. I2: hoja imposible con códigos MEZCLADOS (evidencia / esquema / enunciado duplicado) → también corta en ≤ 2 intentos.
const c2 = sim('c2', 6, ['--x', '0.21']);
ok(c2.summary.completed === 0 && (c2.summary.failedByCode.EXAM_BANK_LEAF_CAPACITY || 0) === 6 && c2.summary.attemptsOnCapacityFail <= 2, `perfil c2 (capacidad agotada, códigos mezclados): las 6 corridas fallan con EXAM_BANK_LEAF_CAPACITY en ≤ 2 intentos (máx. ${c2.summary.attemptsOnCapacityFail})`, c2.summary.failedByCode);

// Worker hospedado: partes de ≤ 7000 tokens estimados con max_tokens 12000 (el navegador sigue con 3500 / 8000).
(async () => {
  const { createExecutorRuntime, EXAM_BANK_WORKER_OUTPUT_EST, EXAM_BANK_WORKER_MAX_TOKENS } = require(path.join(REPO, 'dist/workers/llm-executor/executor-runtime.js'));
  const { LLM_WORKER_MAX_TOKENS_CAP } = require(path.join(REPO, 'dist/workers/llm-executor/server-llm.js'));
  const contract = require(path.join(REPO, 'dist/modules/course-shell/exam-bank.js'));
  const md = {};
  meta.chapters.forEach((c) => { md[c.id] = fs.readFileSync(path.join(dir, c.file), 'utf8'); });
  const calls = [];
  const rt = createExecutorRuntime({
    api: async (system, user, maxTok) => { const text = Array.isArray(user) ? user.map((b) => b.text).join('') : String(user); calls.push({ maxTok, repair: /\nEXAM_BANK_REPAIR v\d+\n/.test(text), ch: (/Todas las preguntas llevan "chapterId": "([^"]+)"/.exec(text) || [])[1] }); return JSON.stringify({ questions: [] }); },
    artifactText: async (id) => (id.startsWith('md:') ? md[id.slice(3)] : null), ownerId: 'owner-1', logger: { log() {}, warn() {}, error() {} },
  });
  const chapters = meta.chapters.map((c) => ({ id: c.id, moduleId: meta.moduleId }));
  const item = { itemRunId: 'ir-eb', runId: 'run-eb', courseId: 1, artifactCourseId: 'c', manifestId: 1, itemKey: 'exam:' + meta.moduleId, type: 'exam', rulesVersion: 3, moduleId: meta.moduleId, idempotencyKey: 'idem-eb', generation: 1, attempt: 1, outputSummary: {},
    context: { courseContext: { nombre: 'Hidráulica', sector: 'Minería', pais: 'Chile' }, contextHash: 'h' },
    blueprint: { outline: [{ id: meta.moduleId, moduleNumber: 1, title: meta.moduleTitle, chapters: meta.chapters.map((c) => ({ id: c.id, chapterNumber: c.n, title: c.title })) }] },
    dependencyArtifacts: chapters.map((c) => ({ type: 'dynamic_content_md', itemKey: 'content:' + c.id, artifactId: 'md:' + c.id, storagePath: 'x' })),
    claimPayload: { examBank: { artifactType: 'dynamic_exam_bank_json', bankVersion: 1, scope: 'module', moduleId: meta.moduleId, chapters: chapters.map((c) => ({ chapterId: c.id, moduleId: c.moduleId })), plan: contract.expectedExamPlan('module', chapters) } } };
  const r = await rt.run(item);
  const main = calls.filter((c) => !c.repair);
  const perCh = {};
  main.forEach((c) => { perCh[c.ch] = (perCh[c.ch] || 0) + 1; });
  ok(EXAM_BANK_WORKER_OUTPUT_EST === 7000 && EXAM_BANK_WORKER_MAX_TOKENS === 12000 && EXAM_BANK_WORKER_MAX_TOKENS <= LLM_WORKER_MAX_TOKENS_CAP && calls.length > 0 && calls.every((c) => c.maxTok === 12000), `worker: todas las llamadas del banco con max_tokens 12000 (${calls.length} llamadas)`, calls.slice(0, 3));
  ok(Object.keys(perCh).length === 4 && Object.values(perCh).every((n) => n <= 2), `worker: primera pasada en partes de ≤ 7000 tokens estimados (llamadas por capítulo ${JSON.stringify(Object.values(perCh))}; el navegador usa 4)`, perCh);
  ok(r && r.ok === false && /^EXAM_BANK_/.test(r.error || ''), 'worker: un modelo que no devuelve preguntas nunca deja un banco aceptado (falla EXAM_BANK_*)', r && r.error);
  // D3 (corte sistémico): sin ninguna válida el pool no escala; la ronda sin válidas corta el intento.
  ok(calls.length <= 24, `worker: con un modelo que no produce, el intento queda acotado (${calls.length} llamadas ≤ 24: primera pasada + una ronda)`, calls.length);
  console.log(`\n${fail === 0 ? 'Todos los checks de exam-bank D pasaron' : 'HAY FALLAS'} (${pass} ✅, ${fail} ❌).`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log(`❌ excepción: ${e && e.stack ? e.stack : e}`); process.exit(1); });
