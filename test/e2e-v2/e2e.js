/* eslint-disable */
// Cursia V2 — Fase 9: aceptación END-TO-END local (sin llamadas pagas/externas).
// App Nest REAL (dist/main.js) + workers REALES (dist/workers/dynamic-*-worker.js)
// como procesos hijos, PG16 descartable, Storage/Videogen falsos locales, el
// ejecutor REAL del navegador (24/44/45/46 + 04-api.js) en un vm, LLM falso
// determinístico, Moodle 4.5 local. Ver run-e2e.sh.
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const REPO = process.env.REPO;
const FE = process.env.FE_ROOT;
const OUT = process.env.OUT;
const HERE = __dirname;
const R = (m) => require(path.join(REPO, 'node_modules', m));
const jwt = R('jsonwebtoken');
const JSZip = R('jszip');
const { Client } = R('pg');
const { startFakes } = require('./fakes');
const { makeFront, pureCtx } = require('./front');
const { createLlm } = require('./llm');
const { inspectMbz, markers } = require('./mbz');

const PGPORT = Number(process.env.PGPORT_T);
const APP_PORT = Number(process.env.APP_PORT || 38471);
const OWNER = crypto.randomUUID();
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const VIDEOGEN_KEY = 'fake-videogen-key-local-only';
const NET_LOG = path.join(OUT, 'net-violations.log');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── resultados ───────────────────────────────────────────────────────────
const results = { startedAt: new Date().toISOString(), owner: OWNER, steps: {}, assertions: [], timings: {}, artifacts: {}, findings: [] };
let curStep = 'setup';
function ok(cond, msg, detail) {
  const r = { step: curStep, ok: !!cond, msg };
  if (!cond && detail !== undefined) r.detail = detail;
  results.assertions.push(r);
  console.log(`${cond ? '✅' : '❌'} [${curStep}] ${msg}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 1500) : ''}`);
  return !!cond;
}
function eq(a, b, msg) { return ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b }); }
async function step(name, fn) {
  curStep = name;
  console.log(`\n══════ ${name} ══════`);
  const t0 = Date.now();
  let threw = null;
  try { await fn(); } catch (e) { threw = e; ok(false, `excepción: ${e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : e}`); }
  const ms = Date.now() - t0;
  results.timings[name] = ms;
  const mine = results.assertions.filter((a) => a.step === name);
  results.steps[name] = { pass: !threw && mine.every((a) => a.ok), assertions: mine.length, failed: mine.filter((a) => !a.ok).length, ms };
  console.log(`── ${name}: ${results.steps[name].pass ? 'PASS' : 'FAIL'} (${mine.length} aserciones, ${ms} ms)`);
  if (threw) throw threw;
}
function save() { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2)); }

// ─── procesos ───────────────────────────────────────────────────────────────
const children = new Set();
function baseEnv(fakes, { flag = true } = {}) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C',
    NODE_ENV: 'production', NODE_PATH: path.join(REPO, 'node_modules'),
    NODE_OPTIONS: `--require ${JSON.stringify(path.join(HERE, 'netguard.js'))}`, E2E_NET_LOG: NET_LOG,
    DB_HOST: '127.0.0.1', DB_PORT: String(PGPORT), DB_USER: 'postgres', DB_PASS: 'x', DB_NAME: 'v2db', DB_SSL: 'false',
    SUPABASE_URL: fakes.storageUrl, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key-local-only', SUPABASE_JWT_SECRET: JWT_SECRET,
    DYNAMIC_MANIFEST_RULES_VERSION: '2', DYNAMIC_REAL_VIDEO_OWNERS: OWNER, DYNAMIC_V2_ALLOWED_OWNERS: OWNER,
    // Runs A/B: entrega videogen_direct (pinned) → desde DN-1 solo con el escape de staging explícito.
    // La fase 5y usa la config de producción (YouTube por default, sin el escape).
    DYNAMIC_VIDEO_DELIVERY: 'videogen_direct', DYNAMIC_ALLOW_VIDEOGEN_DIRECT: 'true',
    VIDEOGEN_API_URL: fakes.videogenUrl, VIDEOGEN_API_KEY: VIDEOGEN_KEY,
  };
  if (flag) env.DYNAMIC_COURSE_STRUCTURE = 'true';
  return env;
}
function spawnProc(label, script, env) {
  const logFile = path.join(OUT, `${label}.log`);
  const fd = fs.openSync(logFile, 'a');
  const ch = spawn(process.execPath, [path.join(REPO, 'dist', script)], { cwd: OUT, env, stdio: ['ignore', fd, fd] });
  ch.label = label; ch.logFile = logFile; ch.exited = null;
  ch.on('exit', (code, sig) => { ch.exited = { code, sig }; children.delete(ch); });
  children.add(ch);
  return ch;
}
async function stopProc(ch, timeoutMs = 20000) {
  if (!ch || ch.exited) return ch && ch.exited;
  ch.kill('SIGTERM');
  const t0 = Date.now();
  while (!ch.exited && Date.now() - t0 < timeoutMs) await sleep(100);
  if (!ch.exited) { ch.kill('SIGKILL'); await sleep(300); }
  return ch.exited;
}
async function startApp(fakes, opts) {
  const env = { ...baseEnv(fakes, opts), ...((opts && opts.env) || {}), PORT: String(APP_PORT) };
  const ch = spawnProc((opts && opts.label) || (opts && opts.flag === false ? 'app-flag-off' : 'app'), 'main.js', env);
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (ch.exited) throw new Error(`app terminó al arrancar: ${JSON.stringify(ch.exited)} (ver ${ch.logFile})`);
    try { const r = await fetch(`http://127.0.0.1:${APP_PORT}/health`); if (r.ok) return ch; } catch {}
    await sleep(250);
  }
  throw new Error('app no respondió /health en 60s');
}

// ─── HTTP al backend ───────────────────────────────────────────────────────
const TOKEN = jwt.sign({ sub: OWNER, email: 'e2e-owner@example.com', role: 'authenticated', aud: 'authenticated' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '4h' });
const BASE = `http://127.0.0.1:${APP_PORT}/api/v1`;
async function api(method, p, body, token = TOKEN) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, data: json && json.data !== undefined ? json.data : null, error: json && (json.error || json.message), raw: json };
}

// ─── DB ────────────────────────────────────────────────────────────────────
let db;
const q = async (sql, params) => (await db.query(sql, params)).rows;

// ─── escenario ─────────────────────────────────────────────────────────────
const SPEC = [
  { title: 'Fundamentos de la hidráulica industrial', objective: 'Comprender presión, caudal y fluidos', exam: true, chapters: [
    { title: 'Presión y caudal en sistemas hidráulicos', objective: 'Relacionar presión y caudal', video: true },
    { title: 'Fluidos hidráulicos y su contaminación', objective: 'Controlar la contaminación del aceite', video: false },
  ] },
  { title: 'Bombas y actuadores', objective: 'Seleccionar bombas y actuadores', exam: false, chapters: [
    { title: 'Bombas de engranajes y de paletas', objective: 'Distinguir tipos de bombas', video: true },
    { title: 'Cilindros hidráulicos', objective: 'Dimensionar cilindros', video: false },
    { title: 'Motores hidráulicos', objective: 'Aplicar motores hidráulicos', video: true },
    { title: 'Válvulas direccionales', objective: 'Leer esquemas de válvulas', video: false },
    { title: 'Válvulas de control de presión', objective: 'Ajustar válvulas de alivio', video: false },
  ] },
  { title: 'Diagnóstico de fallas', objective: 'Diagnosticar fallas hidráulicas', exam: true, chapters: [
    { title: 'Diagnóstico por síntomas', objective: 'Aislar la causa de una falla', video: true },
  ] },
  { title: 'Mantenimiento predictivo', objective: 'Planificar el mantenimiento predictivo', exam: true, chapters: [
    { title: 'Análisis de aceite', objective: 'Interpretar un análisis de aceite', video: false },
    { title: 'Termografía en circuitos', objective: 'Detectar puntos calientes', video: true },
    { title: 'Plan de mantenimiento predictivo', objective: 'Armar un plan predictivo', video: true },
  ] },
];
const COURSE_TITLE = '[E2E F9] Mantenimiento hidráulico industrial';
const D_FIELDS = { nombre: COURSE_TITLE, sector: 'Minería', pais: 'Chile', ciudad: 'Antofagasta', contexto: 'Técnicos de mantenimiento de planta concentradora', nivel: 'Intermedio', tono: 'cercano y técnico', obj: 'Formar técnicos que mantengan sistemas hidráulicos', comp: 'Diagnostica y mantiene sistemas hidráulicos' };

const S = {}; // estado compartido entre pasos

async function readStructure(courseId) {
  const r = await api('GET', `/courses/${courseId}/modules`);
  if (r.status !== 200) throw new Error(`GET modules ${r.status} ${r.error}`);
  return r.data;
}
function expectedKeys(courseId, mods) {
  const keys = [`course_plan:${courseId}`, `course_intro:${courseId}`];
  for (const m of mods) {
    keys.push(`module_intro:${m.id}`);
    for (const c of m.chapters) { keys.push(`content:${c.id}`, `scorm:${c.id}`); if (c.video) keys.push(`video:${c.id}`); }
    if (m.exam) keys.push(`exam:${m.id}`);
  }
  return keys.sort();
}
function syncLlmMaps(llm, courseId, mods) {
  llm.st.courseId = courseId;
  llm.st.chapterByTitle.clear(); llm.st.moduleByTitle.clear(); llm.st.moduleOfChapter.clear();
  for (const m of mods) {
    llm.st.moduleByTitle.set(m.title, m.id);
    for (const c of m.chapters) { llm.st.chapterByTitle.set(c.title, c.id); llm.st.moduleOfChapter.set(c.id, m.id); }
  }
}
/** Estructura viva → [{id,title,exam,chapters:[{id,title,video}]}] */
function modsFromStructure(st) {
  return st.modules.map((m) => ({ id: m.id, title: m.title, exam: m.examEnabled, chapters: m.chapters.map((c) => ({ id: c.id, title: c.title, video: !!c.videoEnabled })) }));
}

async function waitRunTerminal(ctl, label, timeoutMs = 15 * 60 * 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (['completed', 'failed', 'cancelled', 'fatal', 'stopped'].includes(ctl.state.status)) return ctl.state;
    await sleep(500);
  }
  throw new Error(`${label}: el ejecutor no terminó en ${timeoutMs} ms (estado ${JSON.stringify(ctl.state)})`);
}
async function itemRuns(runId) {
  return q(`select id, item_key, type, status, worker_id, attempt_count, carried_from_item_run_id, output_summary, chapter_id, module_id from public.generation_item_runs where job_id = $1 order by item_key`, [runId]);
}
async function artifactsOfRun(runId) {
  return q(`select a.id, a.type, a.status, a.storage_bucket, a.storage_path, a.item_run_id, a.size_bytes, a.metadata, g.item_key
              from public.artifacts a join public.generation_item_runs g on g.id = a.item_run_id where g.job_id = $1 order by a.id`, [runId]);
}
function blobOf(fakes, a) { return fakes.storage.blobs.get(`${a.storage_bucket}/${a.storage_path}`); }

/** Expectativa de curso (por UUID) → aserciones sobre una vista {sections:[{number, activities:[{modname, markers, externalurl, questionCount, name}]}]} */
function assertCourseView(label, view, exp) {
  const secs = view.sections;
  const tagOk = (list, kind, id, tag) => list.some((m) => m.kind === kind && m.id === id && m.tag === tag);
  // course_intro en la sección 0
  const s0 = secs.find((s) => s.number === 0);
  ok(s0 && s0.activities.some((a) => a.modname === 'label' && tagOk(a.markers, 'CI', String(exp.courseId), exp.tags.course_intro)),
    `${label}: course_intro (MARKCI-${exp.courseId}-${exp.tags.course_intro}) en la sección 0`);
  ok(secs.filter((s) => s.number !== 0).every((s) => !s.activities.some((a) => a.markers.some((m) => m.kind === 'CI' && a.modname === 'label'))), `${label}: course_intro SOLO en la sección 0`);
  // sección de cada módulo = la que empieza con su module_intro
  const modSec = [];
  for (const m of exp.modules) {
    const s = secs.find((x) => x.activities.length && x.activities[0].modname === 'label' && x.activities[0].markers.some((k) => k.kind === 'MI' && k.id === m.id));
    modSec.push(s);
    ok(!!s, `${label}: M${m.n} (${m.id}) tiene sección y su module_intro es la PRIMERA actividad`);
    if (s) ok(tagOk(s.activities[0].markers, 'MI', m.id, exp.tags.module_intro[m.id]), `${label}: module_intro M${m.n} con tag ${exp.tags.module_intro[m.id]}`);
  }
  const nums = modSec.map((s) => s && s.number);
  ok(nums.every((n, i) => n != null && (i === 0 || n > nums[i - 1])), `${label}: secciones de módulo en el orden del Blueprint`, nums);
  // por módulo: capítulos en orden, url/scorm por capítulo, quiz
  let allUrls = 0; let allQuiz = 0; let allScorm = 0;
  const scormOrder = [];
  exp.modules.forEach((m, mi) => {
    const s = modSec[mi];
    if (!s) return;
    const acts = s.activities;
    // v2: la tarjeta del capítulo ("📖 Capítulo N — título") no lleva el
    // contenido (va al Libro Guía): el bloque de cada capítulo va de su
    // tarjeta a la siguiente; su identidad es el UUID del SCORM del bloque
    // (MARKSC-<uuid>) y la tarjeta debe llevar el número global y el título
    // de ESE UUID en el Blueprint.
    const cards = [];
    acts.forEach((a, i) => { if (a.modname === 'label' && /^📖 Capítulo \d+/.test(a.name || '')) cards.push(i); });
    const chIdx = cards.map((i, ci) => {
      const end = ci + 1 < cards.length ? cards[ci + 1] : acts.length;
      const sc = acts.slice(i + 1, end).find((a) => a.modname === 'scorm');
      const k = sc && sc.markers.find((x) => x.kind === 'SC');
      return { i, id: k ? k.id : null, name: acts[i].name };
    });
    eq(chIdx.map((c) => c.id), m.chapters.map((c) => c.id), `${label}: M${m.n} bloques de capítulo en orden por UUID`);
    m.chapters.forEach((c, ci) => {
      const at = chIdx[ci];
      if (!at || at.id !== c.id) return;
      const gn = exp.globalNumber[c.id];
      ok(at.name === `📖 Capítulo ${gn} — ${c.title}`, `${label}: tarjeta de ${c.id.slice(0, 8)} = "📖 Capítulo ${gn} — ${c.title}"`, at.name);
      const end = ci + 1 < chIdx.length ? chIdx[ci + 1].i : acts.length;
      const block = acts.slice(at.i + 1, end);
      const urls = block.filter((a) => a.modname === 'url');
      if (c.video) {
        ok(urls.length === 1 && acts[at.i + 1].modname === 'url' && urls[0].externalurl === exp.videoUrl[c.id],
          `${label}: url del video de ${c.id.slice(0, 8)} justo después del capítulo = URL de Videogen falso`, { got: urls.map((u) => u.externalurl), want: exp.videoUrl[c.id] });
      } else ok(urls.length === 0, `${label}: capítulo ${c.id.slice(0, 8)} sin video → sin url`);
      allUrls += urls.length;
      const sc = block.filter((a) => a.modname === 'scorm');
      ok(sc.length === 1 && tagOk(sc[0].markers, 'SC', c.id, exp.tags.scorm[c.id]), `${label}: SCORM de ${c.id.slice(0, 8)} (tag ${exp.tags.scorm[c.id]}) dentro del bloque del capítulo`, sc.map((x) => x.markers.filter((k) => k.kind === 'SC')));
      if (sc[0]) { const k = sc[0].markers.find((x) => x.kind === 'SC'); scormOrder.push(k && k.id); }
      allScorm += sc.length;
    });
    const quizzes = acts.filter((a) => a.modname === 'quiz');
    allQuiz += quizzes.length;
    if (m.exam) {
      ok(quizzes.length === 1 && acts[acts.length - 1].modname === 'quiz', `${label}: M${m.n} tiene exactamente 1 quiz al final de su sección`, quizzes.length);
      if (quizzes[0]) {
        const exm = quizzes[0].markers.filter((k) => k.kind === 'EX');
        ok(exm.length > 0 && exm.every((k) => k.id === m.id && k.tag === exp.tags.exam[m.id]), `${label}: quiz de M${m.n} = preguntas de exam:${m.id.slice(0, 8)} (tag ${exp.tags.exam[m.id]})`, [...new Set(exm.map((k) => k.id + ':' + k.tag))]);
        ok(quizzes[0].questionCount === exp.examQuestions[m.id], `${label}: quiz de M${m.n} con ${exp.examQuestions[m.id]} preguntas`, quizzes[0].questionCount);
      }
    } else ok(quizzes.length === 0, `${label}: M${m.n} sin examen → sin quiz`);
  });
  const totalQuiz = secs.reduce((n, s) => n + s.activities.filter((a) => a.modname === 'quiz').length, 0);
  ok(totalQuiz === allQuiz && totalQuiz === exp.modules.filter((m) => m.exam).length, `${label}: quizzes totales = ${exp.modules.filter((m) => m.exam).length} (sin examen final ni quiz fuera de secciones de módulo)`, totalQuiz);
  const totalUrl = secs.reduce((n, s) => n + s.activities.filter((a) => a.modname === 'url').length, 0);
  ok(totalUrl === allUrls && totalUrl === Object.keys(exp.videoUrl).length, `${label}: url totales = ${Object.keys(exp.videoUrl).length}`, totalUrl);
  const totalScorm = secs.reduce((n, s) => n + s.activities.filter((a) => a.modname === 'scorm').length, 0);
  const chOrder = exp.modules.flatMap((m) => m.chapters.map((c) => c.id));
  ok(totalScorm === chOrder.length && JSON.stringify(scormOrder) === JSON.stringify(chOrder), `${label}: ${chOrder.length} SCORM en el orden del curso (por UUID)`, { totalScorm, scormOrder });
  // Libro Guía
  const libros = secs.flatMap((s) => s.activities).filter((a) => a.modname === 'resource');
  ok(libros.length === 1, `${label}: exactamente 1 resource (Libro Guía)`, libros.length);
  if (libros[0]) {
    const lm = libros[0].markers;
    const chs = lm.filter((k) => k.kind === 'CH');
    eq(chs.map((k) => k.id), chOrder, `${label}: Libro Guía con ${chOrder.length} capítulos en orden por UUID`);
    ok(chs.every((k) => k.tag === exp.tags.content[k.id]), `${label}: Libro Guía — cada capítulo con el tag de su content`);
    const bib = lm.find((k) => k.kind === 'BIB');
    ok(bib && bib.tag === exp.tags.course_intro && bib.pos > Math.max(...chs.map((k) => k.pos)), `${label}: Libro Guía con Bibliografía sugerida (MARKBIB) después del último capítulo`);
    const mis = lm.filter((k) => k.kind === 'MI').map((k) => k.id);
    eq(mis, exp.modules.map((m) => m.id), `${label}: Libro Guía con el prefacio (module_intro) de cada módulo en orden`);
  }
}

function globalNumbers(mods) { const o = {}; let n = 0; mods.forEach((m) => m.chapters.forEach((c) => { o[c.id] = ++n; })); return o; }
function viewFromMoodle(j) {
  return { sections: j.sections.map((s) => ({ number: s.section, activities: s.activities.map((a) => ({ modname: a.modname, name: a.name, markers: markers(a.text || ''), externalurl: a.extra && a.extra.externalurl, questionCount: a.extra && a.extra.question_count })) })) };
}
function viewFromMbz(x) {
  return { sections: x.sections.map((s) => ({ number: s.number, activities: s.activities.map((a) => ({ modname: a.modname, name: a.title, markers: a.markers || [], externalurl: a.extra && a.extra.externalurl, questionCount: a.extra && a.extra.questionCount })) })) };
}
function moodleRestore(mbzPath, outJson) {
  return new Promise((resolve) => {
    execFile(process.env.PHP_BIN, ['-c', process.env.MOODLE_PHPINI, path.join(HERE, 'moodle-restore-inspect.php'), mbzPath, outJson],
      { env: { ...process.env, MOODLE_ROOT: process.env.MOODLE_ROOT }, maxBuffer: 64 * 1024 * 1024, timeout: 600000 },
      (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

async function packageRun(label, courseId, n, runId, fakes) {
  const t0 = Date.now();
  const reqd = await api('POST', `/courses/${courseId}/blueprints/${n}/manifest/runs/${runId}/package`);
  ok(reqd.status === 202 && reqd.data && reqd.data.jobId, `${label}: POST package → 202 {jobId}`, { s: reqd.status, e: reqd.error });
  let st = null;
  while (Date.now() - t0 < 5 * 60 * 1000) {
    st = await api('GET', `/courses/${courseId}/blueprints/${n}/manifest/runs/${runId}/package`);
    if (st.data && ['completed', 'failed'].includes(st.data.status)) break;
    await sleep(500);
  }
  ok(st && st.data && st.data.status === 'completed' && st.data.downloadUrl, `${label}: dynamic-package-worker (proceso real) completó el job`, st && st.data);
  const [job] = await q(`select id, worker_status, worker_id, output_summary, error_message from public.production_jobs where id = $1`, [reqd.data.jobId]);
  const dl = await fetch(st.data.downloadUrl);
  const buf = Buffer.from(await dl.arrayBuffer());
  const file = path.join(OUT, `${label}.mbz`);
  fs.writeFileSync(file, buf);
  results.artifacts[`${label}.mbz`] = { file, bytes: buf.length, sha256: sha(buf), artifactId: st.data.artifactId, jobId: reqd.data.jobId, packagingMs: Date.now() - t0, warnings: job.output_summary && job.output_summary.warnings };
  return { buf, file, job, status: st.data };
}

// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  fs.writeFileSync(NET_LOG, '');
  db = new Client({ host: '127.0.0.1', port: PGPORT, user: 'postgres', database: 'v2db' });
  await db.connect();
  const fakes = await startFakes({ tlsDir: process.env.TLS_DIR, videogenKey: VIDEOGEN_KEY });
  S.fakes = fakes;
  const frontNet = [];
  let app, itemWorker, pkgWorker;
  const llm = createLlm({ getFixtures: () => S.front.SV2_PREVIEW_FIXTURES, getSplit: (n) => S.front.dynExamQuestionSplit(n) });
  const claimLog = { A: [], B: [], Y: [] };
  function newFront(label) {
    const f = makeFront({ feRoot: FE, backendUrl: `http://127.0.0.1:${APP_PORT}`, storageUrl: fakes.storageUrl, token: TOKEN, ownerId: OWNER, llm, logFile: path.join(OUT, `front-${label}.log`), netViolations: frontNet });
    const orig = f.backendDynClaim;
    f.backendDynClaim = function (runId, executorId, types, lease) {
      return orig(runId, executorId, types, lease).then((res) => {
        const it = res && res.data && res.data.item;
        if (it) claimLog[label].push({ itemKey: it.itemKey, type: it.type, item: JSON.parse(JSON.stringify(it)) });
        return res;
      });
    };
    return f;
  }

  try {
    await step('0-arranque', async () => {
      app = await startApp(fakes);
      ok(true, `app Nest real (dist/main.js) en 127.0.0.1:${APP_PORT}, DYNAMIC_COURSE_STRUCTURE=true, rulesVersion 2, videogen_direct`);
      const f = await api('GET', '/features');
      // V2.1 R3/R13: /features expone además manifestRulesVersion (2 en esta fase).
      eq(f.data, { dynamicCourseStructure: true, realVideo: true, coherenceLlm: false, manifestRulesVersion: 2 }, 'GET /features con el JWT local → dynamic ON, realVideo ON para el owner de prueba, coherenceLlm OFF (fail-closed sin DYNAMIC_COHERENCE_LLM), manifestRulesVersion 2');
      const noAuth = await api('GET', '/features', undefined, null);
      ok(noAuth.status === 401, 'sin token → 401 (guard JWT real, HS256 con SUPABASE_JWT_SECRET local)');
      const bad = await api('GET', '/features', undefined, jwt.sign({ sub: OWNER }, 'otro-secreto'));
      ok(bad.status === 401, 'token firmado con otro secreto → 401');
      S.front = newFront('A');
      const tplIds = S.front.SCORM_V2_TEMPLATES.map((t) => t.id);
      const valid = tplIds.filter((t) => S.front.scormV2ValidateRoomData(t, JSON.parse(JSON.stringify(S.front.SV2_PREVIEW_FIXTURES[t]))).ok);
      results.scormTemplates = { catalog: tplIds, validFixtures: valid };
      ok(valid.length >= 2, `plantillas SCORM v2 con fixture válido para el LLM falso: ${valid.join(', ')}`, { tplIds, valid });
      S.templates = valid;
    });

    await step('1-estructura-blueprint-manifest', async () => {
      S.frontendCourseId = crypto.randomUUID();
      const c = await api('POST', '/courses/dynamic', { frontendCourseId: S.frontendCourseId, title: COURSE_TITLE });
      ok(c.status === 201 && c.data && c.data.id, 'POST /courses/dynamic → 201', { s: c.status, e: c.error });
      S.courseId = Number(c.data.id);
      const again = await api('POST', '/courses/dynamic', { frontendCourseId: S.frontendCourseId, title: COURSE_TITLE });
      ok(again.data && Number(again.data.id) === S.courseId, 'POST /courses/dynamic idempotente por frontendCourseId');
      let st = await readStructure(S.courseId);
      let counter = st.structureVersionCounter;
      // si el curso nace con módulos por defecto, se eliminan (estructura del criterio desde cero)
      for (const m of st.modules) {
        const d = await api('DELETE', `/courses/${S.courseId}/modules/${m.id}`, { expectedCounter: counter });
        counter = d.data.structureVersionCounter;
      }
      for (const ms of SPEC) {
        const cm = await api('POST', `/courses/${S.courseId}/modules`, { title: ms.title, objective: ms.objective, examEnabled: ms.exam, expectedCounter: counter });
        ok(cm.status === 201, `POST module "${ms.title}" → 201`, { s: cm.status, e: cm.error });
        counter = cm.data.structureVersionCounter;
        const mid = cm.data.module.id;
        const auto = cm.data.module.chapters || [];
        for (let i = 0; i < ms.chapters.length; i++) {
          const cs = ms.chapters[i];
          if (i === 0 && auto.length === 1) {
            const up = await api('PATCH', `/courses/${S.courseId}/modules/${mid}/chapters/${auto[0].id}`, { title: cs.title, objective: cs.objective, videoEnabled: cs.video, expectedCounter: counter });
            ok(up.status === 200, `PATCH capítulo por defecto → "${cs.title}"`, { s: up.status, e: up.error });
            counter = up.data.structureVersionCounter;
          } else {
            const cc = await api('POST', `/courses/${S.courseId}/modules/${mid}/chapters`, { title: cs.title, objective: cs.objective, videoEnabled: cs.video, expectedCounter: counter });
            ok(cc.status === 201, `POST capítulo "${cs.title}" → 201`, { s: cc.status, e: cc.error });
            counter = cc.data.structureVersionCounter;
          }
        }
      }
      const stale = await api('POST', `/courses/${S.courseId}/modules`, { title: 'x', expectedCounter: counter - 1 });
      ok(stale.status === 409, 'expectedCounter viejo → 409 (concurrencia optimista real)', stale.status);
      st = await readStructure(S.courseId);
      S.modsA = modsFromStructure(st);
      eq(S.modsA.map((m) => m.chapters.length), [2, 5, 1, 3], 'estructura viva: 4 módulos {2,5,1,3}');
      eq(S.modsA.map((m) => m.exam), [true, false, true, true], 'exámenes M1 ON, M2 OFF, M3 ON, M4 ON');
      const flat = S.modsA.flatMap((m) => m.chapters);
      eq(flat.map((c, i) => (c.video ? i + 1 : null)).filter(Boolean), [1, 3, 5, 8, 10, 11], 'videos en capítulos globales 1,3,5,8,10,11');
      S.counter = st.structureVersionCounter;
      const lock = await api('POST', `/courses/${S.courseId}/blueprints`, { expectedCounter: S.counter });
      ok(lock.status === 201 && lock.data.created === true, 'POST blueprints (lock) → 201 created', { s: lock.status, e: lock.error });
      S.nA = lock.data.blueprint.blueprintNumber;
      const lock2 = await api('POST', `/courses/${S.courseId}/blueprints`, { expectedCounter: S.counter });
      ok(lock2.status === 200 && lock2.data.created === false && lock2.data.blueprint.blueprintNumber === S.nA, 'lock repetido con la misma estructura → 200 idempotente');
      const man = await api('POST', `/courses/${S.courseId}/blueprints/${S.nA}/manifest`);
      ok(man.status === 201 && man.data.manifest.rulesVersion === 2, 'POST manifest → 201, rulesVersion 2', { s: man.status, e: man.error });
      S.manifestA = man.data.manifest;
      const keys = S.manifestA.manifest.items.map((i) => i.key).sort();
      eq(keys.length, 37, 'Manifest v2 con 37 items');
      eq(keys, expectedKeys(S.courseId, S.modsA), 'items del Manifest por UUID = plan, intros, content/scorm ×11, video ×6 (1,3,5,8,10,11), exam M1/M3/M4');
      const man2 = await api('POST', `/courses/${S.courseId}/blueprints/${S.nA}/manifest`);
      ok(man2.status === 200 && man2.data.manifest.id === S.manifestA.id, 'POST manifest repetido → 200 mismo Manifest');
      syncLlmMaps(llm, S.courseId, S.modsA);
    });

    await step('2-generacion-run-A', async () => {
      itemWorker = spawnProc('dynamic-item-worker', 'workers/dynamic-item-worker.js', {
        ...baseEnv(fakes), DYNAMIC_ITEM_WORKER_ID: 'e2e-item-worker', DYNAMIC_ITEM_WORKER_POLL_MS: '500', DYNAMIC_ITEM_WORKER_VIDEO_POLL_MS: '300', DYNAMIC_ITEM_WORKER_HEARTBEAT_MS: '5000',
      });
      const f = S.front;
      f.D = { ...D_FIELDS };
      f.SEL = { scormTemplates: S.templates };
      const ctx = f.dynBuildCourseContextFromCurrentFields();
      ok(ctx.nombre === COURSE_TITLE && JSON.stringify(ctx.scormTemplateIds) === JSON.stringify(S.templates), 'freeze del contexto (dynBuildCourseContextFromCurrentFields real)');
      const est = await f.backendDynEstimate(S.courseId, S.nA);
      const estD = est.data && est.data.videoCount !== undefined ? est.data : est.data && est.data.data;
      ok(est.ok && estD && estD.videoCount === 6, 'estimate (wrapper real 24) → 6 videos', est);
      const t0 = Date.now();
      let start = await f.backendDynStartRun(S.courseId, S.nA, { ...ctx, videoMode: 'real' });
      // V2.1 RF-b (HD-V21-19): video real = proveedor pagado → el primer intento pide
      // aprobación de admin (409 con el estimateId); se aprueba como lo haría
      // POST /finops/courses/:id/authorizations (fila ADMIN_APPROVED) y se reintenta.
      const startText = JSON.stringify(start);
      // R13: el wrapper real (24) devuelve el status HTTP en `_httpStatus`.
      ok((start._httpStatus === 409 || start.status === 409) && /budget_approval_required/.test(startText), 'run real sin aprobación → 409 budget_approval_required (RF-b)', start);
      const estM = /estimateId=([0-9a-f-]{36})/.exec(startText);
      ok(!!estM, '409 trae el estimateId', startText.slice(0, 400));
      await q(`insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, decision, approved_by, reason)
               values ($1, $2, 1000, 'ADMIN_APPROVED', 'e2e-admin@cursia.test', 'e2e: aprobación del run real')`, [S.courseId, estM && estM[1]]);
      start = await f.backendDynStartRun(S.courseId, S.nA, { ...ctx, videoMode: 'real' });
      const sd = start.data && start.data.run ? start.data : start.data && start.data.data;
      ok(start.ok && sd && sd.created === true && sd.run.id, 'backendDynStartRun (wrapper real) → run A creado, videoMode real', start);
      S.runA = sd.run.id;
      const ctl = f.dynExecutorStart({ courseId: S.courseId, blueprintNumber: S.nA, runId: S.runA });
      const stt = await waitRunTerminal(ctl, 'run A');
      results.timings['2-run-A-executor'] = Date.now() - t0;
      ok(stt.status === 'completed', `ejecutor real terminó con el run completed (estado ${stt.status})`, stt);
      ok(stt.rulesVersion === 2 && stt.rulesVersionSource === 'run', 'ejecutor resolvió rulesVersion 2 desde el run', { v: stt.rulesVersion, s: stt.rulesVersionSource });
      ok(stt.failed === 0 && stt.abandoned === 0 && stt.contextSummaryMissing === 0 && !stt.fatalError, 'ejecutor: 0 fallidos, 0 abandonados, 0 sidecars ausentes', stt);
      eq(stt.completed, 31, 'ejecutor del navegador completó 31 items (37 − 6 videos)');
      ok(llm.st.unknown.length === 0, 'LLM falso: 0 prompts no reconocidos', llm.st.unknown);
      const run = await api('GET', `/courses/${S.courseId}/blueprints/${S.nA}/manifest/runs/${S.runA}`);
      ok(run.data.status === 'completed' && run.data.rulesVersion === 2, 'GET run A → completed, rulesVersion 2', run.data && { s: run.data.status, rv: run.data.rulesVersion });
      const items = await itemRuns(S.runA);
      S.itemsA = items;
      eq(items.length, 37, 'run A: 37 item runs');
      ok(items.every((i) => i.status === 'completed'), 'run A: los 37 items completed', items.filter((i) => i.status !== 'completed').map((i) => [i.item_key, i.status]));
      eq(items.map((i) => i.item_key).sort(), expectedKeys(S.courseId, S.modsA), 'item keys del run A = Manifest (por UUID)');
      const vids = items.filter((i) => i.type === 'video');
      ok(vids.length === 6 && vids.every((i) => i.worker_id === 'e2e-item-worker'), '6 videos ejecutados por el proceso dynamic-item-worker real', vids.map((v) => v.worker_id));
      ok(items.filter((i) => i.type !== 'video').every((i) => /^browser-/.test(i.worker_id || '')), 'los 31 items no-video los ejecutó el ejecutor del navegador');
      eq(claimLog.A.map((c) => c.type).filter((t) => t === 'video').length, 0, 'el navegador nunca reclamó un video');
      eq(claimLog.A[0] && claimLog.A[0].type, 'course_plan', 'primer claim del navegador = course_plan');
      // Videogen falso
      const subs = fakes.videogen.submissions;
      eq(subs.length, 6, 'Videogen falso: exactamente 6 submissions (una por video)');
      eq(new Set(subs.map((s) => s.client_reference_id)).size, 6, 'Videogen: 6 client_reference_id distintos (sin doble envío)');
      eq(fakes.videogen.badAuth.length, 0, 'Videogen: todas las llamadas con la API key configurada');
      const videoUrl = {};
      for (const v of vids) {
        const chId = v.item_key.slice('video:'.length);
        const sub = subs.find((s) => s.job_id === v.output_summary.videogenJobId);
        ok(sub && sub.content_txt.includes(`MARKCH-${chId}-A`), `video ${chId.slice(0, 8)}: el worker envió a Videogen el markdown REAL de su content (marcador por UUID)`);
        ok(v.output_summary.mode === 'real' && v.output_summary.costUsd === 0.42 && v.output_summary.downloadUrl === `${fakes.httpsBase}/api/videos/${v.output_summary.videogenJobId}/download`,
          `video ${chId.slice(0, 8)}: completed_local → mode real, costo real 0.42, downloadUrl https local`, v.output_summary);
        videoUrl[chId] = v.output_summary.downloadUrl;
      }
      S.videoUrl = videoUrl;
      eq(Object.keys(videoUrl).sort(), S.modsA.flatMap((m) => m.chapters).filter((c) => c.video).map((c) => c.id).sort(), 'videos por UUID = capítulos con video del Blueprint');
      // artifacts, Context Package, sidecars
      const arts = await artifactsOfRun(S.runA);
      S.artsA = arts;
      const byKey = (k) => arts.filter((a) => a.item_key === k);
      eq(arts.filter((a) => a.type === 'dynamic_course_plan_json').length, 1, 'exactamente 1 dynamic_course_plan_json');
      const pure = pureCtx(FE);
      const pure2 = pureCtx(FE);
      const planArt = arts.find((a) => a.type === 'dynamic_course_plan_json');
      const plan = JSON.parse(blobOf(fakes, planArt).toString('utf8'));
      let pkgOk = 0; let sideOk = 0;
      const pkgHashes = {};
      for (const m of S.modsA) for (const c of m.chapters) {
        const k = `content:${c.id}`;
        const ir = items.find((i) => i.item_key === k);
        const a = byKey(k);
        const pkgA = a.find((x) => x.type === 'dynamic_context_package_json');
        const side = a.find((x) => x.type === 'dynamic_context_summary_json');
        const md = a.find((x) => x.type === 'dynamic_content_md');
        const claim = claimLog.A.find((x) => x.itemKey === k);
        if (!pkgA || !side || !md || !claim) { ok(false, `${k}: faltan artifacts/claim`, { types: a.map((x) => x.type), claim: !!claim }); continue; }
        const pkgBlob = blobOf(fakes, pkgA).toString('utf8');
        const h = sha(pkgBlob);
        const r1 = pure.dynBuildContextPackage(pure.dynPackageManifestFromClaim(claim.item), claim.item.context.courseContext, plan, c.id);
        const r2 = pure2.dynBuildContextPackage(pure2.dynPackageManifestFromClaim(JSON.parse(JSON.stringify(claim.item))), claim.item.context.courseContext, JSON.parse(JSON.stringify(plan)), c.id);
        if (h === ir.output_summary.contextPackageSha256 && r1.contextPackageSha256 === h && r2.contextPackageSha256 === h && r1.canonicalJson === pkgBlob) pkgOk++;
        else ok(false, `${k}: hash del Context Package inestable`, { blob: h, summary: ir.output_summary.contextPackageSha256, r1: r1.contextPackageSha256, r2: r2.contextPackageSha256 });
        pkgHashes[c.id] = h;
        const sc = JSON.parse(blobOf(fakes, side).toString('utf8'));
        if (sc.chapterId === c.id && sc.source === 'inline' && sc.contextSummaryVersion === 1 && ir.output_summary.contextSummary === 'present' && !blobOf(fakes, md).toString('utf8').includes('context_summary')) sideOk++;
        else ok(false, `${k}: sidecar inválido`, { sc, os: ir.output_summary });
      }
      S.pkgHashesA = pkgHashes;
      eq(pkgOk, 11, 'Context Package subido para los 11 content: sha256(blob) = output_summary = recomputado (2 vm puros, inputs clonados) — hash estable');
      eq(sideOk, 11, 'sidecar context_summary presente (source inline) en los 11 content, y el markdown sin el bloque');
      const prev = claimLog.A.filter((c) => c.type === 'content').map((c) => pure.dynBuildContextPackage(pure.dynPackageManifestFromClaim(c.item), c.item.context.courseContext, plan, c.item.chapterId).contextPackage);
      ok(prev.some((p) => p.previous_chapter_summary === null) && prev.filter((p) => p.previous_chapter_summary).length === 10, 'Context Package: 1 capítulo sin anterior (el 1º), 10 con resumen del anterior');
      eq(arts.filter((a) => a.type === 'dynamic_module_intro_md').length, 4, '4 dynamic_module_intro_md');
      eq(arts.filter((a) => a.type === 'dynamic_exam_gift').length, 3, '3 dynamic_exam_gift (M1, M3, M4)');
      eq(arts.filter((a) => a.type === 'dynamic_video').length, 6, '6 dynamic_video');
      ok(arts.every((a) => a.status === 'ready'), 'todos los artifacts del run A ready');
      // snapshot histórico de A (para el paso 5)
      S.artsASnap = arts.map((a) => ({ id: a.id, type: a.type, bucket: a.storage_bucket, path: a.storage_path, item_run_id: a.item_run_id, size: String(a.size_bytes), sha: sha(blobOf(fakes, a)), item_key: a.item_key }));
      results.runA = { runId: S.runA, items: items.length, llmCalls: llm.st.calls.length };
    });

    await step('3-empaquetado-A-y-Moodle', async () => {
      pkgWorker = spawnProc('dynamic-package-worker', 'workers/dynamic-package-worker.js', { ...baseEnv(fakes), DYNAMIC_PACKAGE_WORKER_ID: 'e2e-package-worker', DYNAMIC_PACKAGE_WORKER_POLL_MS: '500' });
      const P = await packageRun('run-A', S.courseId, S.nA, S.runA, fakes);
      S.pkgA = P;
      ok(P.job.worker_id === 'e2e-package-worker', 'job dynamic_package reclamado por el proceso dynamic-package-worker real');
      const warnsA = (P.job.output_summary && P.job.output_summary.warnings) || [];
      eq(warnsA, [], 'packaging A: 0 warnings del worker');
      const x = await inspectMbz(JSZip, P.buf);
      S.mbzA = x;
      eq(x.orphanTokens, [], `.mbz A: 0 tokens huérfanos/mal tipados (${x.tokens.length} tokens verificados)`);
      const tagsA = { course_intro: 'A', module_intro: {}, content: {}, scorm: {}, exam: {} };
      S.modsA.forEach((m) => { tagsA.module_intro[m.id] = 'A'; tagsA.exam[m.id] = 'A'; m.chapters.forEach((c) => { tagsA.content[c.id] = 'A'; tagsA.scorm[c.id] = 'A'; }); });
      const examQ = {};
      S.modsA.forEach((m) => { if (m.exam) examQ[m.id] = S.front.dynExamQuestionSplit(m.chapters.length).total; });
      S.expA = { courseId: S.courseId, modules: S.modsA.map((m, i) => ({ ...m, n: i + 1 })), tags: tagsA, videoUrl: S.videoUrl, examQuestions: examQ, globalNumber: globalNumbers(S.modsA) };
      assertCourseView('mbz A', viewFromMbz(x), S.expA);
      const https = require('https');
      const getHttps = (u) => new Promise((res) => https.get(u, { rejectUnauthorized: false }, (r) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => res({ status: r.statusCode, type: r.headers['content-type'], body: Buffer.concat(b) })); }).on('error', (e) => res({ status: 0, err: e.message })));
      const urls = x.sections.flatMap((s) => s.activities).filter((a) => a.modname === 'url').map((a) => a.extra.externalurl);
      const served = [];
      for (const u of urls) { const r = await getHttps(u); served.push(r.status === 200 && r.type === 'video/mp4' && r.body.includes(Buffer.from('ftypmp42'))); }
      ok(urls.length === 6 && served.every(Boolean) && urls.every((u) => u.startsWith(fakes.httpsBase + '/api/videos/')), 'las 6 URLs de video del .mbz son https LOCALES del Videogen falso y sirven un MP4', { urls, served });
      const t0 = Date.now();
      const r = await moodleRestore(P.file, path.join(OUT, 'moodle-A.json'));
      results.timings['3-moodle-restore-A'] = Date.now() - t0;
      fs.writeFileSync(path.join(OUT, 'moodle-A.restore.log'), `${r.stdout}\n--- stderr ---\n${r.stderr}`);
      ok(!r.err, 'restore del .mbz A en Moodle 4.5 local sin error de proceso', r.err && String(r.err).slice(0, 500));
      const mj = JSON.parse(fs.readFileSync(path.join(OUT, 'moodle-A.json'), 'utf8'));
      S.moodleA = mj;
      ok(/^4\.5/.test(mj.moodle_release || ''), `Moodle local = ${mj.moodle_release}`);
      eq(mj.precheck_warnings, [], 'Moodle A: precheck con 0 warnings');
      eq(mj.precheck_errors, [], 'Moodle A: precheck con 0 errors');
      ok(mj.restore_error === null, 'Moodle A: execute_plan sin excepción', mj.restore_error);
      ok(!/warning|notice|deprecated/i.test(r.stderr || ''), 'Moodle A: stderr del restore sin warnings/notices PHP', (r.stderr || '').slice(0, 800));
      assertCourseView('Moodle A (DB)', viewFromMoodle(mj), S.expA);
      const scos = mj.sections.flatMap((s) => s.activities).filter((a) => a.modname === 'scorm').map((a) => a.extra.sco_count);
      ok(scos.length === 11 && scos.every((n) => n >= 1), 'Moodle A: los 11 SCORM con ≥1 SCO registrado', scos);
    });

    await step('4-coherencia', async () => {
      const s1 = await api('POST', `/courses/${S.courseId}/coherence/structure`, {});
      const s2 = await api('POST', `/courses/${S.courseId}/coherence/structure`, {});
      ok(s1.status === 200 && s1.data, 'POST coherence/structure (estructura viva) → 200', { s: s1.status, e: s1.error });
      eq(JSON.stringify(s1.data), JSON.stringify(s2.data), 'coherence/structure determinístico (dos llamadas idénticas byte a byte)');
      const sb = await api('POST', `/courses/${S.courseId}/coherence/structure`, { blueprintNumber: S.nA });
      ok(sb.status === 200, 'POST coherence/structure {blueprintNumber} → 200', { s: sb.status, e: sb.error });
      results.coherenceStructure = s1.data;
      const before = await q(`select count(*)::int n from public.artifacts where course_id = $1`, [S.frontendCourseId]);
      const c1 = await api('POST', `/courses/${S.courseId}/blueprints/${S.nA}/manifest/runs/${S.runA}/coherence`);
      ok(c1.status === 201 && c1.data, 'POST run coherence → 201 (reporte nuevo)', { s: c1.status, e: c1.error });
      const shaOf = (d) => d && (d.reportSha256 || (d.report && d.report.reportSha256) || (d.artifact && d.artifact.metadata && d.artifact.metadata.reportSha256));
      const h1 = shaOf(c1.data);
      ok(/^[0-9a-f]{64}$/.test(String(h1)), 'reporte con reportSha256', c1.data && Object.keys(c1.data));
      const c2 = await api('POST', `/courses/${S.courseId}/blueprints/${S.nA}/manifest/runs/${S.runA}/coherence`);
      ok(c2.status === 200 && shaOf(c2.data) === h1, 'POST run coherence repetido → 200 con el MISMO reportSha256 (determinístico, sin duplicar)', { s: c2.status, h: shaOf(c2.data) });
      const g = await api('GET', `/courses/${S.courseId}/blueprints/${S.nA}/manifest/runs/${S.runA}/coherence`);
      ok(g.status === 200 && shaOf(g.data) === h1, 'GET run coherence → el reporte persistido (mismo sha)', { s: g.status, h: shaOf(g.data) });
      const after = await q(`select count(*)::int n from public.artifacts where course_id = $1`, [S.frontendCourseId]);
      eq(after[0].n - before[0].n, 1, 'exactamente 1 artifact de reporte persistido');
      const [rep] = await q(`select type, storage_bucket, storage_path, metadata from public.artifacts where course_id = $1 order by created_at desc limit 1`, [S.frontendCourseId]);
      const repBlob = blobOf(fakes, rep);
      ok(!!repBlob, `reporte persistido en Storage (${rep.type})`);
      const rep1 = repBlob ? JSON.parse(repBlob.toString('utf8')) : null;
      const { deterministicReportSha256 } = require(path.join(REPO, 'dist/modules/coherence/report.js'));
      ok(rep1 && rep1.reportSha256 === h1 && deterministicReportSha256(rep1) === h1, 'reporte persistido: reportSha256 = recomputado con deterministicReportSha256 (dist) sobre el JSON guardado');
      const bySev = {}; (rep1 ? rep1.findings : []).forEach((f) => { const k = `${f.rule}/${f.severity}`; bySev[k] = (bySev[k] || 0) + 1; });
      results.coherenceRun = { sha: h1, type: rep.type, findings: bySev };
      fs.writeFileSync(path.join(OUT, 'coherence-run-A.json'), JSON.stringify(rep1, null, 2));
      fs.writeFileSync(path.join(OUT, 'coherence-structure.json'), JSON.stringify(s1.data, null, 2));
    });

    await step('5-invalidacion-run-B', async () => {
      let counter = (await readStructure(S.courseId)).structureVersionCounter;
      const [m1, m2, , m4] = S.modsA;
      const c3 = m2.chapters[0];
      const addC = await api('POST', `/courses/${S.courseId}/modules/${m2.id}/chapters`, { title: 'Acumuladores hidráulicos', objective: 'Dimensionar acumuladores', videoEnabled: false, expectedCounter: counter });
      ok(addC.status === 201, 'cambio: agregar capítulo a M2', { s: addC.status, e: addC.error }); counter = addC.data.structureVersionCounter;
      const c12 = addC.data.chapter.id;
      const exOff = await api('PATCH', `/courses/${S.courseId}/modules/${m4.id}`, { examEnabled: false, expectedCounter: counter });
      ok(exOff.status === 200, 'cambio: examen OFF en M4', { s: exOff.status, e: exOff.error }); counter = exOff.data.structureVersionCounter;
      const ed = await api('PATCH', `/courses/${S.courseId}/modules/${m2.id}/chapters/${c3.id}`, { title: 'Bombas de engranajes, paletas y pistones', expectedCounter: counter });
      ok(ed.status === 200, 'cambio: editar título del capítulo 3', { s: ed.status, e: ed.error }); counter = ed.data.structureVersionCounter;
      const ro = await api('PATCH', `/courses/${S.courseId}/modules/${m1.id}/chapters/reorder`, { order: [m1.chapters[1].id, m1.chapters[0].id], expectedCounter: counter });
      ok(ro.status === 200, 'cambio: reordenar capítulos 1↔2 de M1', { s: ro.status, e: ro.error }); counter = ro.data.structureVersionCounter;
      const st = await readStructure(S.courseId);
      S.modsB = modsFromStructure(st);
      eq(S.modsB.map((m) => m.chapters.length), [2, 6, 1, 3], 'estructura nueva {2,6,1,3}');
      const lock = await api('POST', `/courses/${S.courseId}/blueprints`, { expectedCounter: st.structureVersionCounter });
      ok(lock.status === 201 && lock.data.blueprint.blueprintNumber === S.nA + 1, 'lock Blueprint v2 → 201', { s: lock.status, e: lock.error });
      S.nB = lock.data.blueprint.blueprintNumber;
      const man = await api('POST', `/courses/${S.courseId}/blueprints/${S.nB}/manifest`);
      ok(man.status === 201 && man.data.manifest.rulesVersion === 2, 'Manifest del Blueprint v2 → 201 rulesVersion 2');
      const keysB = man.data.manifest.manifest.items.map((i) => i.key).sort();
      eq(keysB, expectedKeys(S.courseId, S.modsB), 'Manifest B por UUID: 38 items (+content/scorm del nuevo, −exam M4)');
      // expectativa (tabla Fase 8, combinada)
      const want = {};
      for (const k of keysB) want[k] = 'REUSE';
      Object.assign(want, {
        [`course_plan:${S.courseId}`]: 'REGENERATE', [`course_intro:${S.courseId}`]: 'REGENERATE',
        [`module_intro:${m2.id}`]: 'REGENERATE',
        [`content:${m1.chapters[0].id}`]: 'REVIEW', [`content:${m1.chapters[1].id}`]: 'REVIEW',
        [`content:${c3.id}`]: 'REGENERATE', [`scorm:${c3.id}`]: 'REGENERATE', [`video:${c3.id}`]: 'STALE_NO_AUTO',
        [`content:${c12}`]: 'GENERATE', [`scorm:${c12}`]: 'GENERATE',
      });
      S.wantB = want;
      const cnt = async () => (await q(`select (select count(*)::int from public.artifacts) a, (select count(*)::int from public.generation_item_runs) g, (select count(*)::int from public.production_jobs) j`))[0];
      const before = await cnt();
      const dry = await api('GET', `/courses/${S.courseId}/blueprints/${S.nB}/manifest/invalidation-plan?fromRun=${S.runA}`);
      ok(dry.status === 200 && dry.data.applied === false && (dry.data.blockers || []).length === 0, 'GET invalidation-plan (dry-run) → 200, sin bloqueos', { s: dry.status, e: dry.error, b: dry.data && dry.data.blockers });
      eq(await cnt(), before, 'dry-run no escribe nada');
      const got = Object.fromEntries(dry.data.plan.actions.filter((a) => a.inTargetManifest).map((a) => [a.itemKey, a.action]));
      const sortO = (o) => Object.fromEntries(Object.entries(o).sort());
      eq(sortO(got), sortO(want), 'acción por UUID de cada item de Mb = tabla Fase 8 (REVIEW ×2 reorden, REGENERATE cap 3 + scorm, STALE_NO_AUTO video cap 3, GENERATE nuevo, REGENERATE plan/intro/intro M2, resto REUSE)');
      const removed = dry.data.plan.actions.filter((a) => !a.inTargetManifest);
      ok(removed.length === 1 && removed[0].itemKey === `exam:${m4.id}` && removed[0].action === 'SOFT_DISABLE' && removed[0].reasons.includes('exam_toggled_off'), 'exam:M4 fuera de Mb → SOFT_DISABLE (exam_toggled_off)', removed);
      ok(dry.data.videoItemsToGenerate && dry.data.videoItemsToGenerate.length === 0, 'dry-run: 0 videos a generar (sin costo de video)', dry.data.videoItemsToGenerate);
      results.invalidationPlan = { planSha256: dry.data.plan.planSha256, totals: dry.data.plan.totals, actions: dry.data.plan.actions.map((a) => ({ key: a.itemKey, action: a.action, reasons: a.reasons })) };
      const ap = await api('POST', `/courses/${S.courseId}/blueprints/${S.nB}/manifest/runs`, { fromRun: S.runA });
      ok(ap.status === 201 && ap.data.created === true && ap.data.invalidation.planSha256 === dry.data.plan.planSha256, 'POST runs {fromRun} → 201, plan aplicado = dry-run (planSha256)', { s: ap.status, e: ap.error });
      S.runB = ap.data.run.id;
      ok(ap.data.run.videoMode === 'real', 'run B hereda videoMode real');
      const ap2 = await api('POST', `/courses/${S.courseId}/blueprints/${S.nB}/manifest/runs`, { fromRun: S.runA });
      ok(ap2.status === 200 && ap2.data.run.id === S.runB, 'apply repetido → 200 mismo run B (idempotente)');
      const itemsB0 = await itemRuns(S.runB);
      const badAct = itemsB0.filter((i) => !i.output_summary || !i.output_summary.invalidation || i.output_summary.invalidation.action !== want[i.item_key]).map((i) => i.item_key);
      eq(badAct, [], 'run B: output_summary.invalidation.action de cada item = acción del plan (por UUID)');
      const dry2 = await api('GET', `/courses/${S.courseId}/blueprints/${S.nB}/manifest/invalidation-plan?fromRun=${S.runA}`);
      ok(dry2.data && dry2.data.applied === true && dry2.data.existingRunId === ap.data.run.id && dry2.data.plan.planSha256 === dry.data.plan.planSha256, 'dry-run tras aplicar → applied:true, existingRunId = B, mismo planSha256');
      const pendingB = itemsB0.filter((i) => i.status === 'pending').map((i) => i.item_key).sort();
      const expPending = Object.entries(want).filter(([, a]) => a === 'GENERATE' || a === 'REGENERATE').map(([k]) => k).sort();
      eq(pendingB, expPending, 'run B: pending exactamente = GENERATE/REGENERATE (7 items)');
      ok(itemsB0.filter((i) => i.status === 'completed').every((i) => i.carried_from_item_run_id), 'run B: el resto completed con carried_from (REUSE/REVIEW/STALE_NO_AUTO)');
      // ejecutar B
      const subsBefore = fakes.videogen.submissions.length;
      const callsBefore = llm.st.calls.length;
      llm.st.tag = 'B';
      syncLlmMaps(llm, S.courseId, S.modsB);
      S.frontB = newFront('B');
      const t0 = Date.now();
      const ctl = S.frontB.dynExecutorStart({ courseId: S.courseId, blueprintNumber: S.nB, runId: S.runB });
      const stt = await waitRunTerminal(ctl, 'run B');
      results.timings['5-run-B-executor'] = Date.now() - t0;
      ok(stt.status === 'completed' && stt.failed === 0 && stt.completed === 7, `ejecutor B: completed, 7 items ejecutados, 0 fallidos`, stt);
      eq(claimLog.B.map((c) => c.itemKey).sort(), expPending, 'el navegador reclamó SOLO los 7 items pending de B');
      eq(fakes.videogen.submissions.length, subsBefore, 'run B: 0 submissions nuevas a Videogen (video cap 3 STALE_NO_AUTO, sin pagar)');
      const callsB = llm.st.calls.slice(callsBefore);
      const kinds = {};
      callsB.forEach((c) => { const k = c.kind.startsWith('scorm_room') ? 'scorm_room' : c.kind; kinds[k] = (kinds[k] || 0) + 1; });
      eq(sortO(kinds), sortO({ course_plan: 1, course_intro: 1, module_intro: 1, content_v2: 2, scorm_room: 10 }), 'LLM en B: plan 1, intro 1, intro M2 1, content ×2, salas SCORM ×10, 0 exámenes');
      eq([...new Set(callsB.filter((c) => c.kind === 'content_v2').map((c) => c.id))].sort(), [c3.id, c12].sort(), 'content regenerado = cap 3 y nuevo (por UUID)');
      const itemsB = await itemRuns(S.runB);
      ok(itemsB.every((i) => i.status === 'completed'), 'run B: 38/38 completed');
      const runB = await api('GET', `/courses/${S.courseId}/blueprints/${S.nB}/manifest/runs/${S.runB}`);
      ok(runB.data.status === 'completed', 'GET run B → completed');
      // Context Package de los reutilizados: mismo hash que en A
      const reused = S.modsB.flatMap((m) => m.chapters).filter((c) => want[`content:${c.id}`] === 'REUSE' || want[`content:${c.id}`] === 'REVIEW');
      const sameHash = reused.filter((c) => { const i = itemsB.find((x) => x.item_key === `content:${c.id}`); return i.output_summary.contextPackageSha256 === S.pkgHashesA[c.id]; });
      eq(sameHash.length, reused.length, `Context Package de los ${reused.length} content reutilizados: mismo hash que en A`);
      const reg = itemsB.find((x) => x.item_key === `content:${c3.id}`);
      ok(reg.output_summary.contextPackageSha256 && reg.output_summary.contextPackageSha256 !== S.pkgHashesA[c3.id] && reg.output_summary.contextSummary === 'present', 'content cap 3 regenerado: Context Package nuevo + sidecar presente');
      // empaquetar B
      const P = await packageRun('run-B', S.courseId, S.nB, S.runB, fakes);
      S.pkgB = P;
      const warnsB = (P.job.output_summary && P.job.output_summary.warnings) || [];
      results.packagingWarningsB = warnsB;
      ok(warnsB.length >= 1 && JSON.stringify(warnsB).includes(`video:${c3.id}`), 'packaging B: warning visible del video stale del cap 3 (STALE_NO_AUTO, esperado por diseño)', warnsB);
      const x = await inspectMbz(JSZip, P.buf);
      eq(x.orphanTokens, [], `.mbz B: 0 tokens huérfanos (${x.tokens.length} verificados)`);
      const tagsB = JSON.parse(JSON.stringify(S.expA.tags));
      tagsB.course_intro = 'B'; tagsB.module_intro[m2.id] = 'B'; tagsB.content[c3.id] = 'B'; tagsB.scorm[c3.id] = 'B'; tagsB.content[c12] = 'B'; tagsB.scorm[c12] = 'B';
      delete tagsB.exam[m4.id];
      const examQB = { ...S.expA.examQuestions }; delete examQB[m4.id];
      S.expB = { courseId: S.courseId, modules: S.modsB.map((m, i) => ({ ...m, n: i + 1 })), tags: tagsB, videoUrl: S.videoUrl, examQuestions: examQB, globalNumber: globalNumbers(S.modsB) };
      assertCourseView('mbz B', viewFromMbz(x), S.expB);
      const r = await moodleRestore(P.file, path.join(OUT, 'moodle-B.json'));
      fs.writeFileSync(path.join(OUT, 'moodle-B.restore.log'), `${r.stdout}\n--- stderr ---\n${r.stderr}`);
      ok(!r.err, 'restore del .mbz B en Moodle 4.5 local', r.err && String(r.err).slice(0, 500));
      const mj = JSON.parse(fs.readFileSync(path.join(OUT, 'moodle-B.json'), 'utf8'));
      eq(mj.precheck_warnings, [], 'Moodle B: precheck con 0 warnings');
      eq(mj.precheck_errors, [], 'Moodle B: precheck con 0 errors');
      ok(mj.restore_error === null, 'Moodle B: execute_plan sin excepción', mj.restore_error);
      assertCourseView('Moodle B (DB)', viewFromMoodle(mj), S.expB);
      const vm4 = viewFromMoodle(mj).sections.find((s) => s.activities[0] && s.activities[0].markers.some((k) => k.kind === 'MI' && k.id === m4.id));
      ok(vm4 && !vm4.activities.some((a) => a.modname === 'quiz'), 'Moodle B: el quiz de M4 ya no está');
      const vm2 = viewFromMoodle(mj).sections.find((s) => s.activities[0] && s.activities[0].markers.some((k) => k.kind === 'MI' && k.id === m2.id));
      ok(vm2 && vm2.activities.some((a) => a.modname === 'label' && a.name === `📖 Capítulo ${S.expB.globalNumber[c12]} — Acumuladores hidráulicos`) && vm2.activities.some((a) => a.modname === 'scorm' && a.markers.some((k) => k.kind === 'SC' && k.id === c12)), 'Moodle B: capítulo nuevo presente en M2 (tarjeta "Capítulo 9" + SCORM por UUID)');
      // históricos de A intactos
      const now = await q(`select id, type, status, storage_bucket, storage_path, item_run_id, size_bytes, metadata from public.artifacts where id = any($1::uuid[])`, [S.artsASnap.map((a) => a.id)]);
      const byId = Object.fromEntries(now.map((a) => [a.id, a]));
      const bad = [];
      const actFor = (k) => want[k] || 'SOFT_DISABLE';
      for (const a of S.artsASnap) {
        const n = byId[a.id];
        if (!n) { bad.push(`${a.item_key}/${a.type}: fila desaparecida`); continue; }
        if (n.type !== a.type || n.storage_bucket !== a.bucket || n.storage_path !== a.path || n.item_run_id !== a.item_run_id || String(n.size_bytes) !== a.size) bad.push(`${a.item_key}/${a.type}: fila alterada`);
        const b = fakes.storage.blobs.get(`${a.bucket}/${a.path}`);
        if (!b || sha(b) !== a.sha) bad.push(`${a.item_key}/${a.type}: blob alterado/borrado`);
        const act = actFor(a.item_key);
        const expSt = act === 'REGENERATE' || act === 'STALE_NO_AUTO' ? 'stale' : act === 'SOFT_DISABLE' ? 'disabled' : 'ready';
        if (n.status !== expSt) bad.push(`${a.item_key}/${a.type}: status ${n.status} ≠ ${expSt}`);
      }
      ok(bad.length === 0, `históricos de A intactos: ${S.artsASnap.length} artifacts con misma ruta/bytes/vínculo; solo status (stale/disabled) según el plan`, bad);
      const itemsA2 = await itemRuns(S.runA);
      ok(itemsA2.every((i) => i.status === 'completed'), 'item runs de A siguen completed');
      const [mbzA] = await q(`select status, storage_bucket, storage_path from public.artifacts where id = $1`, [S.pkgA.status.artifactId]);
      const mbzABlob = blobOf(fakes, mbzA);
      ok(mbzA && (mbzA.status === null || mbzA.status === 'ready') && mbzABlob && sha(mbzABlob) === results.artifacts['run-A.mbz'].sha256, '.mbz de A intacto: fila sin stale/disabled (status null = artifact no-item, sin ciclo de vida) y blob byte-idéntico en Storage', { row: mbzA, blob: !!mbzABlob, sha: mbzABlob && sha(mbzABlob), want: results.artifacts['run-A.mbz'].sha256, id: S.pkgA.status.artifactId });
      const pA = await api('GET', `/courses/${S.courseId}/blueprints/${S.nA}/manifest/runs/${S.runA}/package`);
      ok(pA.data && pA.data.status === 'completed' && pA.data.artifactId === S.pkgA.status.artifactId, 'GET package de A sigue devolviendo el .mbz de A');
      const cohB = await api('POST', `/courses/${S.courseId}/blueprints/${S.nB}/manifest/runs/${S.runB}/coherence`);
      ok(cohB.status === 201, 'coherencia del run B → 201', { s: cohB.status, e: cohB.error });
      fs.writeFileSync(path.join(OUT, 'coherence-run-B.json'), JSON.stringify(cohB.data, null, 2));
    });

    // ═══ DN-1: run con entrega YouTube Unlisted (config de producción) ═══
    await step('5y-youtube-dn1', async () => {
      // App + item worker con la config de DN-1: sin DYNAMIC_VIDEO_DELIVERY ni el escape de staging →
      // un run real con videos congela 'youtube'. Google (OAuth + YouTube Data API) = falso local vía
      // google-fake-redirect.js; netguard sigue bloqueando todo lo que no sea 127.0.0.1.
      const secret = crypto.randomBytes(32).toString('hex');
      const ytEnv = (extra = {}) => ({
        DYNAMIC_VIDEO_DELIVERY: '', DYNAMIC_ALLOW_VIDEOGEN_DIRECT: '',
        YOUTUBE_TOKEN_SECRET: secret, YOUTUBE_CLIENT_ID: 'fake-client-id', YOUTUBE_CLIENT_SECRET: 'fake-client-secret',
        E2E_GOOGLE_FAKE_BASE: fakes.googleUrl,
        NODE_OPTIONS: `--require ${JSON.stringify(path.join(HERE, 'netguard.js'))} --require ${JSON.stringify(path.join(HERE, 'google-fake-redirect.js'))}`,
        ...extra,
      });
      await stopProc(itemWorker);
      await stopProc(app);
      app = await startApp(fakes, { env: ytEnv(), label: 'app-youtube' });
      itemWorker = spawnProc('dynamic-item-worker-youtube', 'workers/dynamic-item-worker.js', {
        ...baseEnv(fakes), ...ytEnv({
          DYNAMIC_ITEM_WORKER_ID: 'e2e-item-worker-yt', DYNAMIC_ITEM_WORKER_POLL_MS: '500', DYNAMIC_ITEM_WORKER_VIDEO_POLL_MS: '300',
          DYNAMIC_ITEM_WORKER_HEARTBEAT_MS: '5000', DYNAMIC_YOUTUBE_UPLOAD_RETRY_BASE_MS: '50',
          // Solo para bajar el "MP4" del Videogen falso (https local con cert autofirmado); netguard limita todo a 127.0.0.1.
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        }),
      });
      const g = fakes.google;

      // Preflight sin conexión.
      const p0 = await api('GET', '/dynamic/youtube/preflight');
      ok(p0.status === 200 && p0.data && p0.data.ok === false && p0.data.reason === 'no_connection' && p0.data.channel === null,
        'preflight sin canal conectado → {ok:false, reason:no_connection, channel:null}', p0);
      eq(p0.data && p0.data.checks.map((c) => c.key), ['connected', 'oauth_valid', 'refresh_usable', 'channel_resolved', 'upload_permission', 'privacy_unlisted'], 'preflight: checks del contrato en orden');

      // Curso Y: 1 módulo con examen, 2 capítulos (el 1º con video).
      const COURSE_Y = '[E2E DN-1] Seguridad en circuitos hidráulicos';
      const fcY = crypto.randomUUID();
      const c = await api('POST', '/courses/dynamic', { frontendCourseId: fcY, title: COURSE_Y });
      ok(c.status === 201, 'curso Y: POST /courses/dynamic → 201', { s: c.status, e: c.error });
      const cY = Number(c.data.id);
      let st = await readStructure(cY);
      let counter = st.structureVersionCounter;
      for (const m of st.modules) counter = (await api('DELETE', `/courses/${cY}/modules/${m.id}`, { expectedCounter: counter })).data.structureVersionCounter;
      const cm = await api('POST', `/courses/${cY}/modules`, { title: 'Seguridad hidráulica', objective: 'Trabajar seguro con presión', examEnabled: true, expectedCounter: counter });
      counter = cm.data.structureVersionCounter;
      const mid = cm.data.module.id;
      const specY = [{ title: 'Energía almacenada y bloqueo', objective: 'Aplicar bloqueo y etiquetado', video: true }, { title: 'Mangueras y fugas', objective: 'Inspeccionar mangueras', video: false }];
      const auto = cm.data.module.chapters || [];
      for (let i = 0; i < specY.length; i++) {
        const cs = specY[i];
        const r = i === 0 && auto.length === 1
          ? await api('PATCH', `/courses/${cY}/modules/${mid}/chapters/${auto[0].id}`, { title: cs.title, objective: cs.objective, videoEnabled: cs.video, expectedCounter: counter })
          : await api('POST', `/courses/${cY}/modules/${mid}/chapters`, { title: cs.title, objective: cs.objective, videoEnabled: cs.video, expectedCounter: counter });
        counter = r.data.structureVersionCounter;
      }
      st = await readStructure(cY);
      const modsY = modsFromStructure(st);
      eq(modsY.map((m) => m.chapters.map((x) => x.video)), [[true, false]], 'curso Y: 1 módulo, video solo en el capítulo 1');
      const lk = await api('POST', `/courses/${cY}/blueprints`, { expectedCounter: st.structureVersionCounter });
      const nY = lk.data.blueprint.blueprintNumber;
      const man = await api('POST', `/courses/${cY}/blueprints/${nY}/manifest`);
      ok(man.status === 201 && man.data.manifest.manifest.items.filter((i) => i.type === 'video').length === 1, 'curso Y: Manifest v2 con 1 video');
      const videoCh = modsY[0].chapters[0].id;
      const plainCh = modsY[0].chapters[1].id;

      const f = newFront('Y');
      f.D = { ...D_FIELDS, nombre: COURSE_Y };
      f.SEL = { scormTemplates: S.templates };
      const ctx = f.dynBuildCourseContextFromCurrentFields();
      const cnt = async () => (await q(`select (select count(*)::int from public.production_jobs) j, (select count(*)::int from public.generation_item_runs) g, (select count(*)::int from public.generation_run_contexts) c`))[0];

      // Gate: sin canal → 409, sin escrituras ni gasto.
      const before = await cnt();
      const subs0 = fakes.videogen.submissions.length;
      const r409 = await api('POST', `/courses/${cY}/blueprints/${nY}/manifest/runs`, { ...ctx, videoMode: 'real' });
      ok(r409.status === 409 && /^youtube_preflight_failed:no_connection: /.test(r409.error), 'startRun video+real sin canal → 409 youtube_preflight_failed:no_connection', r409);
      eq(await cnt(), before, 'gate: nada escrito (jobs, items, contextos)');
      eq(fakes.videogen.submissions.length, subs0, 'gate: 0 envíos a Videogen');

      // Conexión del owner (refresh token cifrado con el MISMO AES-256-GCM real de YoutubeTokenService).
      process.env.YOUTUBE_TOKEN_SECRET = secret;
      const { YoutubeTokenService } = require(path.join(REPO, 'dist/youtube/youtube-token.service.js'));
      const tks = new YoutubeTokenService();
      tks.onModuleInit();
      const enc = tks.encryptRefreshToken('fake-refresh-token-e2e');
      await q(`insert into public.youtube_connections (user_id, user_email, channel_id, channel_title, encrypted_refresh_token, token_iv, scopes, status, connected_at)
               values ($1, 'e2e-owner@example.com', 'UCe2eChannel0000000000000', 'Canal E2E', $2, $3, 'youtube.upload,youtube.readonly', 'active', now())`,
        [OWNER, enc.encrypted, enc.iv]);
      g.refresh.set('fake-refresh-token-e2e', 'fake-access-token-e2e');
      g.channels.set('fake-access-token-e2e', { id: 'UCe2eChannel0000000000000', title: 'Canal E2E (fake)', thumb: 'https://yt3.fake/e2e.jpg' });
      const p1 = await api('GET', '/dynamic/youtube/preflight');
      ok(p1.data && p1.data.ok === true && p1.data.channel && p1.data.channel.id === 'UCe2eChannel0000000000000' && p1.data.checks.every((x) => x.ok), 'preflight con canal → ok:true, canal verificado por channels.list', p1.data);
      ok(!JSON.stringify(p1.raw).includes('fake-access-token') && !JSON.stringify(p1.raw).includes('fake-refresh-token'), 'preflight: sin tokens en la respuesta');

      // Run youtube: el primer inicio de subida responde 503 (reintento en el mismo reclamo, paridad legacy).
      g.initPlan = [503];
      // V2.1 RF-b (HD-V21-19): video real = proveedor pagado → 409 con estimateId, aprobación de admin y reintento.
      let s1 = await api('POST', `/courses/${cY}/blueprints/${nY}/manifest/runs`, { ...ctx, videoMode: 'real' });
      const estY = /estimateId=([0-9a-f-]{36})/.exec(String(s1.error || ''));
      ok(s1.status === 409 && /^budget_approval_required/.test(String(s1.error)) && !!estY, 'run Y real sin aprobación → 409 budget_approval_required con estimateId (RF-b)', { s: s1.status, e: s1.error });
      await q(`insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, decision, approved_by, reason)
               values ($1, $2, 1000, 'ADMIN_APPROVED', 'e2e-admin@cursia.test', 'e2e: aprobación del run Y')`, [cY, estY && estY[1]]);
      s1 = await api('POST', `/courses/${cY}/blueprints/${nY}/manifest/runs`, { ...ctx, videoMode: 'real' });
      ok(s1.status === 201 && s1.data.run.videoDelivery === 'youtube', 'startRun con preflight OK → 201, videoDelivery congelado = youtube', { s: s1.status, e: s1.error });
      const runY = s1.data.run.id;
      syncLlmMaps(llm, cY, modsY);
      llm.st.tag = 'A';
      const ctl = f.dynExecutorStart({ courseId: cY, blueprintNumber: nY, runId: runY });
      const stt = await waitRunTerminal(ctl, 'run Y');
      ok(stt.status === 'completed' && stt.failed === 0, `ejecutor Y: run completed (${stt.status})`, stt);
      const itemsY = await itemRuns(runY);
      const v = itemsY.find((i) => i.item_key === `video:${videoCh}`);
      ok(v && v.status === 'completed' && v.worker_id === 'e2e-item-worker-yt', 'video del run Y: completed por el dynamic-item-worker real', v && { s: v.status, w: v.worker_id });
      const os = (v && v.output_summary) || {};
      const up = g.uploads.find((x) => x.videoId === os.youtubeVideoId);
      ok(os.delivery === 'completed' && /^YtE2E\d{6}$/.test(os.youtubeVideoId || '') && os.youtubeUrl === `https://www.youtube.com/watch?v=${os.youtubeVideoId}`,
        'video Y: delivery=completed con youtubeVideoId + URL final', os);
      ok(up && up.privacyStatus === 'unlisted' && up.bytes > 0, 'Google falso: 1 video subido Unlisted con los bytes del MP4 de Videogen', up);
      eq(g.calls.filter((x) => x === 'POST /upload/youtube/v3/videos').length, 2, 'Google falso: 2 inicios de subida (503 + OK, reintento en el mismo reclamo)');
      eq(g.calls.filter((x) => x.startsWith('PUT /upload-session/')).length, 1, 'Google falso: 1 sola subida de bytes');
      eq(fakes.videogen.submissions.length - subs0, 1, 'Videogen: exactamente 1 envío (nunca re-enviado por el reintento de subida)');
      const gr = await api('GET', `/courses/${cY}/blueprints/${nY}/manifest/runs/${runY}`);
      const dv = gr.data && gr.data.items.find((i) => i.itemKey === `video:${videoCh}`);
      ok(gr.data.status === 'completed' && dv && dv.delivery.state === 'completed' && dv.delivery.youtubeVideoId === os.youtubeVideoId, 'GET run Y: completed, delivery.state del video = completed');
      eq(gr.data.videoDeliverySummary, { total: 1, byState: { completed: 1 }, needsAttention: false }, 'GET run Y: videoDeliverySummary');
      // youtube-resolution sobre un video ya publicado: 409 not_ambiguous SIN consultar a YouTube (videos.list).
      const vl0 = g.calls.filter((x) => x === 'GET /youtube/v3/videos').length;
      const res409 = await api('POST', `/courses/${cY}/blueprints/${nY}/manifest/runs/${runY}/items/${encodeURIComponent(`video:${videoCh}`)}/youtube-resolution`,
        { action: 'confirm_existing', youtubeVideoId: os.youtubeVideoId });
      ok(res409.status === 409 && /^not_ambiguous: /.test(res409.error), 'youtube-resolution sobre un video completed → 409 not_ambiguous', res409);
      eq(g.calls.filter((x) => x === 'GET /youtube/v3/videos').length, vl0, 'youtube-resolution sin nada que resolver: 0 consultas a videos.list');

      // Packaging youtube → label embebible (no url, no MP4).
      const P = await packageRun('run-Y-youtube', cY, nY, runY, fakes);
      const x = await inspectMbz(JSZip, P.buf);
      eq(x.orphanTokens, [], '.mbz Y: 0 tokens huérfanos');
      const all = x.sections.flatMap((s) => s.activities);
      eq(all.filter((a) => a.modname === 'url').length, 0, '.mbz Y: 0 actividades url (el video no es un link externo)');
      // Sección del módulo = la que EMPIEZA con su module_intro (el Libro Guía también lleva marcadores MI).
      const sec = x.sections.find((s) => s.activities.length && s.activities[0].modname === 'label' && s.activities[0].markers.some((k) => k.kind === 'MI' && k.id === mid));
      const acts = sec ? sec.activities : [];
      const card = (id) => acts.findIndex((a) => a.modname === 'label' && a.title === `📖 Capítulo ${modsY[0].chapters.findIndex((c2) => c2.id === id) + 1} — ${modsY[0].chapters.find((c2) => c2.id === id).title}`);
      const i1 = card(videoCh); const i2 = card(plainCh);
      const watch = `https://www.youtube.com/watch?v=${os.youtubeVideoId}`;
      const vl = acts[i1 + 1];
      ok(i1 >= 0 && vl && vl.modname === 'label' && vl.text.includes(`href=&quot;${watch}&quot;`) && /nomediaplugin/.test(vl.text),
        '.mbz Y: justo después de la tarjeta del capítulo con video, un label con el link de SU youtubeVideoId (+ respaldo nomediaplugin)', vl && { t: vl.title });
      const block2 = acts.slice(i2 + 1).filter((a, j, arr) => j < arr.findIndex((b) => b.modname === 'scorm') + 1);
      ok(i2 >= 0 && !block2.some((a) => /youtube\.com/.test(a.text)), '.mbz Y: el capítulo sin video no tiene link de YouTube');
      ok(!P.buf.includes(Buffer.from('ftypmp42')) && !/\.mp4/i.test(all.map((a) => a.text).join('')), '.mbz Y: sin MP4 embebido ni URL de MP4');

      // Moodle 4.5: restore + render del label con los filtros del contexto del módulo.
      const r = await moodleRestore(P.file, path.join(OUT, 'moodle-Y.json'));
      ok(!r.err, 'restore del .mbz Y en Moodle 4.5 local', r.err && String(r.err).slice(0, 500));
      const mj = JSON.parse(fs.readFileSync(path.join(OUT, 'moodle-Y.json'), 'utf8'));
      eq([mj.precheck_warnings, mj.precheck_errors, mj.restore_error], [[], [], null], 'Moodle Y: precheck sin warnings/errors y restore sin excepción');
      eq(mj.sections.flatMap((s2) => s2.activities).filter((a) => a.modname === 'url').length, 0, 'Moodle Y (DB): 0 actividades url');
      const renderOut = path.join(OUT, 'moodle-Y-render.json');
      const rr = await new Promise((resolve) => execFile(process.env.PHP_BIN, ['-c', process.env.MOODLE_PHPINI, path.join(HERE, 'moodle-render-youtube-labels.php'), P.file, renderOut, 'default'],
        { env: { ...process.env, MOODLE_ROOT: process.env.MOODLE_ROOT }, maxBuffer: 64 * 1024 * 1024, timeout: 600000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
      ok(!rr.err && !/warning|notice|deprecated/i.test(rr.stderr || ''), 'render de labels en Moodle sin error ni warnings PHP', { err: rr.err && String(rr.err), stderr: (rr.stderr || '').slice(0, 500) });
      const rj = JSON.parse(fs.readFileSync(renderOut, 'utf8'));
      results.moodleYoutubeRender = { release: rj.moodle_release, mediaplugin: rj.filters_active_in_course.includes('mediaplugin'), sortorder: rj.media_plugins_sortorder, videojsYoutube: rj.media_videojs_youtube, labels: rj.labels.map((l) => ({ videoId: l.video_id, player: l.player, embeds: l.embeds_this_video, fallback: l.fallback_link_kept })) };
      ok(rj.filters_active_in_course.includes('mediaplugin') && rj.media_youtube_enabled, `Moodle ${rj.moodle_release}: filtro multimedia activo en el curso y media_youtube habilitado (config por defecto)`, results.moodleYoutubeRender);
      const lab = rj.labels.find((l) => l.video_id === os.youtubeVideoId);
      ok(rj.labels.length === 1 && lab && lab.embeds_this_video && lab.media_players_in_label === 1 && lab.fallback_link_kept,
        `Moodle: format_text del label (contexto del módulo) → reproductor embebido de ESE video (${lab && lab.player}), 1 solo reproductor + link de respaldo`, rj.labels.map((l) => ({ id: l.video_id, player: l.player, n: l.media_players_in_label })));
      results.runY = { runId: runY, courseId: cY, youtubeVideoId: os.youtubeVideoId, googleCalls: g.calls.length };
    });

    await step('6-gating-flag-off', async () => {
      await stopProc(itemWorker); await stopProc(pkgWorker);
      ok(true, 'workers detenidos (SIGTERM)');
      await stopProc(app);
      app = await startApp(fakes, { flag: false });
      const f = await api('GET', '/features');
      eq(f.data, { dynamicCourseStructure: false, realVideo: false, coherenceLlm: false }, 'flag OFF: GET /features → false/false/false');
      const routes = [
        ['POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID() }],
        ['GET', `/courses/${S.courseId}/modules`],
        ['POST', `/courses/${S.courseId}/blueprints`, { expectedCounter: 0 }],
        ['GET', `/courses/${S.courseId}/blueprints/${S.nB}/manifest`],
        ['GET', `/courses/${S.courseId}/blueprints/${S.nB}/manifest/runs/${S.runB}`],
        ['POST', '/dynamic-generation/claim', { runId: S.runB, executorId: 'x', types: ['content'], leaseSeconds: 60 }],
        ['GET', `/courses/${S.courseId}/blueprints/${S.nB}/manifest/runs/${S.runB}/package`],
        ['POST', `/courses/${S.courseId}/coherence/structure`, {}],
        ['GET', `/courses/${S.courseId}/blueprints/${S.nB}/manifest/invalidation-plan?fromRun=${S.runA}`],
      ];
      for (const [m, p, b] of routes) {
        const r = await api(m, p, b);
        ok(r.status === 404, `flag OFF: ${m} ${p.replace(/[0-9a-f-]{36}/g, ':uuid')} → 404`, r.status);
      }
      const h = await fetch(`http://127.0.0.1:${APP_PORT}/health`);
      ok(h.ok, 'flag OFF: /health 200');
      const lc = await api('POST', '/courses', { title: '[E2E F9] curso legacy' });
      ok(lc.status === 201 && lc.data && lc.data.id, 'flag OFF: ruta legacy POST /courses → 201', { s: lc.status, e: lc.error });
      const ll = await api('GET', '/courses');
      ok(ll.status === 200 && Array.isArray(ll.data) && ll.data.some((c) => Number(c.id) === Number(lc.data.id)), 'flag OFF: ruta legacy GET /courses → 200 con el curso');
      const lg = await api('GET', `/courses/${lc.data.id}`);
      ok(lg.status === 200, 'flag OFF: GET /courses/:id legacy → 200');
      // workers con el flag OFF: inactivos sin tocar la DB
      const w1 = spawnProc('item-worker-flag-off', 'workers/dynamic-item-worker.js', baseEnv(fakes, { flag: false }));
      const w2 = spawnProc('package-worker-flag-off', 'workers/dynamic-package-worker.js', baseEnv(fakes, { flag: false }));
      await sleep(4000);
      const l1 = fs.readFileSync(w1.logFile, 'utf8'); const l2 = fs.readFileSync(w2.logFile, 'utf8');
      ok(!w1.exited && /desactivado/.test(l1) && !w2.exited && /desactivado/.test(l2), 'flag OFF: ambos workers quedan vivos e inactivos (log "desactivado", sin salir)', { l1: l1.slice(-300), l2: l2.slice(-300) });
      const e1 = await stopProc(w1); const e2 = await stopProc(w2);
      ok(e1 && e1.code === 0 && e2 && e2.code === 0, 'flag OFF: SIGTERM → exit 0', { e1, e2 });
      await stopProc(app);
      app = await startApp(fakes);
      const f2 = await api('GET', '/features');
      eq(f2.data, { dynamicCourseStructure: true, realVideo: true, coherenceLlm: false, manifestRulesVersion: 2 }, 'flag ON de nuevo: /features true (restart sin pérdida)');
      const rB = await api('GET', `/courses/${S.courseId}/blueprints/${S.nB}/manifest/runs/${S.runB}`);
      ok(rB.status === 200 && rB.data.status === 'completed', 'flag ON de nuevo: el run B sigue legible y completed');
    });

    await step('7-red', async () => {
      const blocked = fs.readFileSync(NET_LOG, 'utf8').trim();
      ok(blocked === '', 'netguard (app + workers): 0 conexiones fuera de 127.0.0.1', blocked.slice(0, 1000));
      eq(frontNet, [], 'navegador simulado: 0 fetch fuera de 127.0.0.1 / /api/proxy');
      results.frontNet = frontNet.slice();
      results.network = { storageRequests: fakes.storage.log.length, videogenSubmissions: fakes.videogen.submissions.length, httpsVideoDownloads: fakes.vids.downloads.length };
    });
  } catch (e) {
    console.error('ABORT', e && e.stack);
    results.aborted = String(e && e.message);
  } finally {
    for (const ch of [...children]) await stopProc(ch);
    await fakes.close().catch(() => {});
    await db.end().catch(() => {});
    results.finishedAt = new Date().toISOString();
    results.pass = !results.aborted && Object.values(results.steps).every((s) => s.pass) && results.assertions.every((a) => a.ok);
    results.totals = { assertions: results.assertions.length, failed: results.assertions.filter((a) => !a.ok).length };
    save();
    console.log(`\nE2E F9: ${results.pass ? 'PASS' : 'FAIL'} — ${results.totals.assertions} aserciones, ${results.totals.failed} fallidas`);
    process.exit(results.pass ? 0 : 1);
  }
})();
