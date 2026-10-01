#!/usr/bin/env node
/* eslint-disable */
// EV6 P2-B6 — el LLM falso de BANCOS del E2E (test/e2e-v2/llm-exam-bank.js, vía llm-v3.js) contra el
// ejecutor REAL del navegador (frontend en un vm, mismo cargador que el E2E: test/e2e-v2/front.js) y el
// contrato REAL del backend (dist/modules/course-shell/exam-bank.js). Sin DB, sin red, sin Moodle:
// corre suelto y en la regresión del gate (scripts/check-*.js).
//
// Qué fija (lo mismo que el gate necesita para que E1/E3 pasen en modo banco):
//   1. examen de módulo (2 capítulos) y examen final (2 módulos): el ejecutor arma bancos que
//      validateExamBank acepta con la evidencia del Markdown;
//   2. la falla inyectada (evidencia fuera del capítulo + MC con distractores mucho más cortos) sale
//      UNA vez, el ejecutor manda EXACTAMENTE UNA reparación (EXAM_BANK_REPAIR v1) y el banco
//      queda completo (rejectedByCode EXAM_BANK_EVIDENCE + EXAM_BANK_LENGTH_BIAS, repaired 2);
//   3. A1: un desvío del contrato hace fallar AL FAKE (respuesta 400 + st.unknown);
//   4. el modo banco solo se enciende con el override de la prueba: el frontend trae
//      DYN_EXAM_BANK_MODE_ENABLED = true (encendido desde EV6 fase 2) y, con el interruptor en false, exam/final_exam siguen por GIFT.
//
// Uso: CURSIA_FRONTEND_REPO=<campuscloud-gen> node scripts/check-p2-exam-bank-e2e-fake.js
//      (requiere `npm run build`; sin CURSIA_FRONTEND_REPO usa ../campuscloud-gen).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const FE = path.resolve(process.env.CURSIA_FRONTEND_REPO || path.join(REPO, '..', 'campuscloud-gen'));
const E2E = path.join(REPO, 'test', 'e2e-v2');
let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`✅ ${msg}`); } else { fail++; console.log(`❌ ${msg}${detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 1500) : ''}`); }
  return !!cond;
}

if (!fs.existsSync(path.join(FE, 'src/js/45-dynamic-generation-executor.js'))) {
  console.log(`❌ frontend no encontrado en ${FE} (CURSIA_FRONTEND_REPO)`);
  process.exit(1);
}
const contract = require(path.join(REPO, 'dist', 'modules/course-shell/exam-bank.js'));
const { makeFront } = require(path.join(E2E, 'front.js'));
const { createLlm } = require(path.join(E2E, 'llm.js'));
const { createLlmV3 } = require(path.join(E2E, 'llm-v3.js'));
const { parseBankPrompt } = require(path.join(E2E, 'llm-exam-bank.js'));

const CTX = { nombre: '[B6] Hidráulica de planta', sector: 'Minería', pais: 'Chile', ciudad: 'Antofagasta', contexto: 'Técnicos de mantenimiento de planta concentradora', nivel: 'Intermedio', tono: 'cercano y técnico', obj: 'Formar técnicos que mantengan sistemas hidráulicos', comp: 'Diagnostica y mantiene sistemas hidráulicos' };
const uuid = (n) => `0b6b6b6b-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OUTLINE = [
  { id: uuid(101), moduleNumber: 1, title: 'Fundamentos del circuito', objective: 'Comprender presión y caudal', chapters: [
    { id: uuid(1), chapterNumber: 1, title: 'Presión y caudal en planta', objective: 'Aplicar presión y caudal en planta' },
    { id: uuid(2), chapterNumber: 2, title: 'Fluidos y contaminación del aceite', objective: 'Aplicar fluidos y contaminación del aceite' },
  ] },
  { id: uuid(102), moduleNumber: 2, title: 'Componentes de potencia', objective: 'Seleccionar bombas y actuadores', chapters: [
    { id: uuid(3), chapterNumber: 3, title: 'Bombas de engranajes y paletas', objective: 'Aplicar bombas de engranajes y paletas' },
  ] },
];
const LOGS = [];
process.on('exit', () => { for (const f of LOGS) { try { fs.unlinkSync(f); } catch (e) { /* ya no existe */ } } });
const ALL_CH = OUTLINE.flatMap((m) => m.chapters.map((c) => ({ ...c, moduleId: m.id })));

function setup(label) {
  const llmBase = createLlm({ getFixtures: () => ({}), getSplit: () => ({ multichoice: 1, truefalse: 1, match: 1 }) });
  const llm = createLlmV3({ base: llmBase, examBankContract: contract });
  llm.st.courseId = 9006;
  for (const m of OUTLINE) { llm.st.moduleByTitle.set(m.title, m.id); for (const c of m.chapters) { llm.st.chapterByTitle.set(c.title, c.id); llm.st.moduleOfChapter.set(c.id, m.id); } }
  // Markdown de cada capítulo = lo que devuelve el LLM falso del E2E para el content v2/v3, sin el sidecar.
  const md = {};
  for (const c of ALL_CH) {
    const out = llmBase.respond({ messages: [{ content: `CONTEXTO DEL CURSO\n\nGenera el CAPÍTULO ${c.chapterNumber} COMPLETO: "${c.title}"\nMódulo 1` }] });
    md[c.id] = out.text.replace(/\n*```json context_summary[\s\S]*$/, '');
  }
  const logFile = path.join(os.tmpdir(), `check-p2-b6-${process.pid}-${label}.log`);
  LOGS.push(logFile);
  const netViolations = [];
  const f = makeFront({ feRoot: FE, backendUrl: 'http://127.0.0.1:9', storageUrl: 'http://127.0.0.1:9', token: 'x', ownerId: uuid(999), llm, logFile, netViolations });
  // Dependencias en memoria (el E2E las baja del Storage falso; aquí no hay backend).
  f._dynDownloadArtifactText = async (id) => (id && id.startsWith('md:') && md[id.slice(3)] ? { ok: true, text: md[id.slice(3)] } : { ok: false, error: 'missing' });
  f.DYN_LLM_BACKOFF_BASE_MS = 1;
  return { f, llm, md, netViolations };
}

function examItem(scope, moduleId) {
  const chapters = (scope === 'module' ? ALL_CH.filter((c) => c.moduleId === moduleId) : ALL_CH).map((c) => ({ id: c.id, moduleId: c.moduleId }));
  return {
    type: scope === 'module' ? 'exam' : 'final_exam',
    itemKey: scope === 'module' ? `exam:${moduleId}` : 'final_exam:9006',
    itemRunId: `run-${scope}-${moduleId || 'final'}`, idempotencyKey: `idem-${scope}-${moduleId || 'final'}`, generation: 1, attempt: 1,
    moduleId: moduleId || null,
    blueprint: { outline: OUTLINE },
    context: { courseContext: CTX },
    claimPayload: { examBank: { artifactType: 'dynamic_exam_bank_json', bankVersion: 1, scope, moduleId: scope === 'module' ? moduleId : null, chapters: chapters.map((c) => ({ chapterId: c.id, moduleId: c.moduleId })), plan: contract.expectedExamPlan(scope, chapters) } },
    dependencyArtifacts: chapters.map((c) => ({ type: 'dynamic_content_md', itemKey: `content:${c.id}`, artifactId: `md:${c.id}`, storagePath: `x/${c.id}.md` })),
    _chapters: chapters,
  };
}
function validateArtifact(res, item, md) {
  const doc = JSON.parse(res.artifacts[0].content);
  const scope = item.type === 'exam' ? 'module' : 'final';
  return contract.validateExamBank(doc, { scope, chapters: item._chapters, chapterMd: new Map(item._chapters.map((c) => [c.id, md[c.id]])) });
}

(async () => {
  // ── 0. El interruptor de producción sigue apagado; el override es solo de la prueba ──
  {
    const src = fs.readFileSync(path.join(FE, 'src/js/45-dynamic-generation-executor.js'), 'utf8');
    ok(/^var DYN_EXAM_BANK_MODE_ENABLED = true;$/m.test(src), 'frontend: DYN_EXAM_BANK_MODE_ENABLED = true en 45 (modo banco encendido)');
    const { f, llm } = setup('off');
    const calls0 = llm.st.calls.length; // setup() pidió el Markdown de los capítulos al LLM v2
    ok(f.DYN_EXAM_BANK_MODE_ENABLED === true, 'sin override: el interruptor viene encendido');
    f.DYN_EXAM_BANK_MODE_ENABLED = false; // kill switch
    ok(f._dynExamBankModeOn(examItem('module', OUTLINE[0].id)) === false, 'con el interruptor en false: _dynExamBankModeOn(exam con examBank) = false → GIFT');
    f.DYN_EXAM_BANK_MODE_ENABLED = true; // override del E2E: DESPUÉS de cargar 45 (el `var` del script lo pisaría antes)
    ok(f._dynExamBankModeOn(examItem('module', OUTLINE[0].id)) === true && f._dynExamBankModeOn(examItem('final')) === true, 'con el override del harness: modo banco encendido para exam y final_exam');
    ok(llm.st.calls.length === calls0, 'el override no llama al LLM');
  }

  // ── 1. Examen de módulo (2 capítulos) con la falla inyectada → 1 reparación ──
  const { f, llm, md, netViolations } = setup('bank');
  f.DYN_EXAM_BANK_MODE_ENABLED = true;
  const prompts = [];
  const origRespond = llm.respond;
  llm.respond = (body) => { prompts.push(String(body.messages[0].content)); return origRespond(body); };
  const exam1 = examItem('module', OUTLINE[0].id);
  const r1 = await f._dynRunItemV3(exam1);
  ok(r1 && r1.ok === true, 'examen del módulo 1 (2 capítulos): ok', r1 && (r1.error || r1));
  if (r1 && r1.ok) {
    const v = validateArtifact(r1, exam1, md);
    ok(r1.artifacts.length === 1 && r1.artifacts[0].type === 'dynamic_exam_bank_json' && v.ok, `artifact dynamic_exam_bank_json válido para validateExamBank de B2 (con evidencia): ${v.bankSize} preguntas, ${v.slotCount} slots`, v.errors.slice(0, 5));
    const s = r1.summary;
    ok(s.repaired === 2 && s.rejectedByCode.EXAM_BANK_EVIDENCE >= 1 && s.rejectedByCode.EXAM_BANK_LENGTH_BIAS >= 1 && s.calls.continuation === 1 && s.evidenceChecked === true,
      `resumen: rechazos EXAM_BANK_EVIDENCE + EXAM_BANK_LENGTH_BIAS, 2 reparadas en 1 llamada continuation (calls ${JSON.stringify(s.calls)})`, s);
    ok(s.correctLongestShare <= 0.3, `«correcta = la más larga» en ${Math.round(s.correctLongestShare * 100)} % de las MC (≤ 30 %), histograma ${JSON.stringify(s.lengthRankHistogram)}`);
  }
  const repairs = llm.st.v3calls.filter((c) => c.kind === 'exam_bank_repair');
  ok(llm.st.invalidSent.exam_bank === 1 && repairs.length === 1 && llm.st.retriesSeen.exam_bank === 1, `falla inyectada 1 vez → EXACTAMENTE 1 reparación (${repairs.length})`, { inv: llm.st.invalidSent, rep: repairs });
  ok(repairs.length === 1 && repairs[0].ids.length === 2, 'la reparación pide solo los 2 ids rechazados', repairs);
  const rp = prompts.filter((p) => p.startsWith('EXAM_BANK_REPAIR v1'));
  ok(rp.length === 1 && /EXAM_BANK_EVIDENCE/.test(rp[0]) && /EXAM_BANK_LENGTH_BIAS/.test(rp[0]), 'el prompt de reparación nombra los dos motivos (EVIDENCE y LENGTH_BIAS)');
  ok(prompts.filter((p) => !p.startsWith('EXAM_BANK_REPAIR')).every((p) => p.startsWith('EXAM_BANK_CHAPTER v1')), 'módulo: todas las llamadas principales son EXAM_BANK_CHAPTER v1 (un capítulo por llamada)');

  // ── 2. Segundo examen de módulo y examen final: SIN fallas nuevas (once por corrida) ──
  const exam2 = examItem('module', OUTLINE[1].id);
  const r2 = await f._dynRunItemV3(exam2);
  ok(r2 && r2.ok && validateArtifact(r2, exam2, md).ok && r2.summary.repaired === 0 && r2.summary.calls.continuation === 0, 'examen del módulo 2 (1 capítulo): válido sin reparaciones', r2 && (r2.error || r2.summary));
  prompts.length = 0;
  const fin = examItem('final');
  const r3 = await f._dynRunItemV3(fin);
  ok(r3 && r3.ok === true, 'examen final (2 módulos, 3 capítulos): ok', r3 && (r3.error || r3));
  if (r3 && r3.ok) {
    const v = validateArtifact(r3, fin, md);
    const doc = JSON.parse(r3.artifacts[0].content);
    ok(v.ok && doc.questions.every((q) => q.moduleId === ALL_CH.find((c) => c.id === q.chapterId).moduleId), `final: válido para B2 (${v.bankSize} preguntas, ${v.slotCount} slots), moduleId = módulo del capítulo`, v.errors.slice(0, 5));
    ok(r3.summary.repaired === 0 && r3.summary.chaptersCovered === 3, 'final: sin reparaciones, los 3 capítulos cubiertos', r3.summary);
    ok(prompts.length > 0 && prompts.every((p) => p.startsWith('EXAM_BANK_FINAL_CHAPTER v1')), 'final: llamadas EXAM_BANK_FINAL_CHAPTER v1');
  }
  ok(llm.st.v3calls.filter((c) => c.kind === 'exam_bank_repair').length === 1, 'en toda la corrida: exam_bank_repair registrado UNA sola vez');
  ok(llm.st.unknown.length === 0 && netViolations.length === 0, 'LLM falso sin prompts no reconocidos; 0 fetch fuera de /api/proxy', { u: llm.st.unknown, n: netViolations });

  // ── 3. Determinismo: otra corrida da los mismos bancos (sha) ──
  {
    const again = setup('again');
    again.f.DYN_EXAM_BANK_MODE_ENABLED = true;
    const a1 = await again.f._dynRunItemV3(examItem('module', OUTLINE[0].id));
    ok(a1.ok && r1.ok && a1.summary.bankSha256 === r1.summary.bankSha256, 'determinista: el mismo banco (bankSha256) en otra corrida con la misma falla');
  }

  // ── 4. A1: un desvío del contrato falla AL FAKE ──
  {
    const bad = { ...contract, validateExamBank: (doc, ctx) => { const r = contract.validateExamBank(doc, ctx); return { ...r, ok: false, errors: [...r.errors, { path: '$.questions[0].stem', code: 'EXAM_BANK_SCHEMA', message: 'deriva simulada' }] }; } };
    const llmBase = createLlm({ getFixtures: () => ({}), getSplit: () => ({}) });
    const drift = createLlmV3({ base: llmBase, examBankContract: bad });
    const p = prompts[0];
    const out = drift.respond({ messages: [{ content: p }] });
    ok(out.httpStatus === 400 && drift.st.unknown.length === 1 && /desvío del contrato B2/.test(drift.st.unknown[0]), 'contrato con deriva → el fake responde 400 y lo registra en st.unknown (no devuelve un banco)', { out, u: drift.st.unknown });
    const noContract = createLlmV3({ base: createLlm({ getFixtures: () => ({}), getSplit: () => ({}) }) });
    const out2 = noContract.respond({ messages: [{ content: p }] });
    ok(out2.httpStatus === 400 && /falta el contrato B2/.test(noContract.st.unknown[0] || ''), 'sin contrato B2 el fake se niega a responder bancos');
    const parsed = parseBankPrompt(p);
    ok(parsed && parsed.scope === 'final' && parsed.asks.length > 0 && parsed.chapters.length === 1, `parser: prompt final → ${parsed && parsed.asks.length} ids de 1 capítulo`);
  }

  console.log(`\n${fail === 0 ? 'Todos los checks de P2-B6 pasaron' : 'HAY FALLAS'} (${pass} ✅, ${fail} ❌).`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log(`❌ excepción: ${e && e.stack ? e.stack : e}`); process.exit(1); });
