/* eslint-disable */
// Cursia V2.1 — R13: fase rulesVersion 3 del E2E local (sin gasto ni red externa).
//
// Corre DESPUÉS del E2E v2 (e2e.js) sobre el MISMO PG16 descartable (run-e2e.sh
// con E2E_AFTER, ver run-e2e-v21.sh). App Nest real + workers reales (item,
// provider, package) como procesos hijos con netguard; ejecutor REAL del
// navegador (vm) con un LLM falso v3 (llm-v3.js); Videogen, Storage y Google
// falsos en 127.0.0.1 (el video "se publica" con el id de YouTube real
// IdwOipZAeqY y dura 468 s); Gamma/TTS en modo MOCK (fixtures R9/R10).
//
// Cursos (§R.1 adaptada): E1 (2 módulos, las 4 combinaciones V/A, aula-clara
// light, 70, final ON, h5p) + re-empaque (tecnico/dark, 80); E2 (4 módulos,
// oscuro-premium dark, 60, final OFF, scorm); E3 (2 módulos, tecnico dark, 80,
// final ON, h5p). Luego restore de los 4 MBZ en el Moodle 4.5 local
// (restore-and-inspect.sh + inspector PHP) y simulación de notas.
//
// Salida: $OUT/results-v3.json (+ MBZ, JSON de Moodle) para el QA de
// navegador (browser-qa-v3.js) y el resumen (run-e2e-v21.sh).
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const REPO = process.env.REPO;
const FE = process.env.FE_ROOT;
const OUT = process.env.OUT;
const HERE = __dirname;
const R = (m) => require(path.join(REPO, 'node_modules', m));
const jwt = R('jsonwebtoken');
const JSZip = R('jszip');
const { Client } = R('pg');
const { startFakes } = require('./fakes');
const { makeFront } = require('./front');
const { createLlm } = require('./llm');
const { createLlmV3 } = require('./llm-v3');
const D = (p) => require(path.join(REPO, 'dist', p));

const PGPORT = Number(process.env.PGPORT_T);
const APP_PORT = Number(process.env.APP_PORT || 38471) + 7;
const OWNER = crypto.randomUUID();
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const VIDEOGEN_KEY = 'fake-videogen-key-local-only';
const YT_ID = 'IdwOipZAeqY';
const V3OUT = path.join(OUT, 'v3');
fs.mkdirSync(V3OUT, { recursive: true });
const NET_LOG = path.join(V3OUT, 'net-violations.log');
const MOODLE_SCRATCH = process.env.MOODLE_SCRATCH;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── resultados ───────────────────────────────────────────────────────────
const results = { startedAt: new Date().toISOString(), owner: OWNER, steps: {}, assertions: [], timings: {}, mbz: {}, courses: {}, finops: {}, counters: {} };
let curStep = 'setup';
function ok(cond, msg, detail) {
  const r = { step: curStep, ok: !!cond, msg };
  if (!cond && detail !== undefined) r.detail = detail;
  results.assertions.push(r);
  console.log(`${cond ? '✅' : '❌'} [${curStep}] ${msg}${!cond && detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 1500) : ''}`);
  return !!cond;
}
function eq(a, b, msg) { return ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b }); }
async function step(name, fn, { fatal = true } = {}) {
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
  save();
  if (threw && fatal) throw threw;
}
function save() { fs.writeFileSync(path.join(V3OUT, 'results-v3.json'), JSON.stringify(results, null, 2)); }

// ─── procesos ───────────────────────────────────────────────────────────────
const children = new Set();
let FAKES;
const YT_SECRET = crypto.randomBytes(32).toString('hex');
function baseEnv() {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C',
    NODE_ENV: 'production', NODE_PATH: path.join(REPO, 'node_modules'),
    NODE_OPTIONS: `--require ${JSON.stringify(path.join(HERE, 'netguard.js'))} --require ${JSON.stringify(path.join(HERE, 'google-fake-redirect.js'))}`,
    E2E_NET_LOG: NET_LOG, E2E_GOOGLE_FAKE_BASE: FAKES.googleUrl,
    DB_HOST: '127.0.0.1', DB_PORT: String(PGPORT), DB_USER: 'postgres', DB_PASS: 'x', DB_NAME: 'v2db', DB_SSL: 'false',
    SUPABASE_URL: FAKES.storageUrl, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key-local-only', SUPABASE_JWT_SECRET: JWT_SECRET,
    DYNAMIC_COURSE_STRUCTURE: 'true', DYNAMIC_MANIFEST_RULES_VERSION: '3',
    DYNAMIC_REAL_VIDEO_OWNERS: OWNER, DYNAMIC_V2_ALLOWED_OWNERS: OWNER,
    // rulesVersion 3: worker de proveedor desplegado + mocks de Gamma/TTS permitidos (escape de no-producción).
    DYNAMIC_PROVIDER_WORKER_ENABLED: 'true', DYNAMIC_ALLOW_PROVIDER_MOCK: 'true',
    // Config de producción del video: entrega YouTube (sin DYNAMIC_VIDEO_DELIVERY ni el escape videogen_direct).
    YOUTUBE_TOKEN_SECRET: YT_SECRET, YOUTUBE_CLIENT_ID: 'fake-client-id', YOUTUBE_CLIENT_SECRET: 'fake-client-secret',
    VIDEOGEN_API_URL: FAKES.videogenUrl, VIDEOGEN_API_KEY: VIDEOGEN_KEY,
  };
}
function spawnProc(label, script, env) {
  const logFile = path.join(V3OUT, `${label}.log`);
  const fd = fs.openSync(logFile, 'a');
  const ch = spawn(process.execPath, [path.join(REPO, 'dist', script)], { cwd: V3OUT, env, stdio: ['ignore', fd, fd] });
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
async function startApp() {
  const ch = spawnProc('app-v3', 'main.js', { ...baseEnv(), PORT: String(APP_PORT) });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (ch.exited) throw new Error(`app terminó al arrancar: ${JSON.stringify(ch.exited)} (ver ${ch.logFile})`);
    try { const r = await fetch(`http://127.0.0.1:${APP_PORT}/health`); if (r.ok) return ch; } catch {}
    await sleep(250);
  }
  throw new Error('app no respondió /health en 60s');
}

// ─── HTTP ──────────────────────────────────────────────────────────────────
const TOKEN = jwt.sign({ sub: OWNER, email: 'e2e-v3-owner@example.com', role: 'authenticated', aud: 'authenticated' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '6h' });
const BASE = `http://127.0.0.1:${APP_PORT}/api/v1`;
async function api(method, p, body, token = TOKEN) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, data: json && json.data !== undefined ? json.data : null, error: json && (json.error || json.message), raw: json };
}
let db;
const q = async (sql, params) => (await db.query(sql, params)).rows;

// ─── Cursos de la matriz ───────────────────────────────────────────────────
const CTX = { sector: 'Minería', pais: 'Chile', ciudad: 'Antofagasta', contexto: 'Técnicos de mantenimiento de planta concentradora', nivel: 'Intermedio', tono: 'cercano y técnico', obj: 'Formar técnicos que mantengan sistemas hidráulicos', comp: 'Diagnostica y mantiene sistemas hidráulicos' };
const COURSES = [
  { key: 'E1', title: '[E2E V2.1 E1] Hidráulica de planta', theme: { themeFamily: 'aula-clara', mode: 'light' }, passing: 70, finalExam: true, engine: 'h5p', modules: [
    { title: 'Fundamentos del circuito', objective: 'Comprender presión y caudal', exam: true, chapters: [
      { title: 'Presión y caudal en planta', v: true, a: true },
      { title: 'Fluidos y contaminación del aceite', v: false, a: true },
    ] },
    { title: 'Componentes de potencia', objective: 'Seleccionar bombas y actuadores', exam: false, chapters: [
      { title: 'Bombas de engranajes y paletas', v: true, a: false },
      { title: 'Cilindros de doble efecto', v: false, a: false },
    ] },
  ] },
  { key: 'E2', title: '[E2E V2.1 E2] Mantenimiento predictivo', theme: { themeFamily: 'oscuro-premium', mode: 'dark' }, passing: 60, finalExam: false, engine: 'scorm', modules: [
    { title: 'Diagnóstico por síntomas', objective: 'Aislar la causa de una falla', exam: true, chapters: [{ title: 'Síntomas de falla en bombas', v: true, a: true }] },
    { title: 'Análisis del aceite', objective: 'Interpretar un informe de aceite', exam: true, chapters: [
      { title: 'Muestreo de aceite en terreno', v: false, a: true },
      { title: 'Lectura del informe de laboratorio', v: false, a: false },
    ] },
    { title: 'Termografía aplicada', objective: 'Detectar puntos calientes', exam: true, chapters: [{ title: 'Puntos calientes en válvulas', v: true, a: false }] },
    { title: 'Plan predictivo', objective: 'Armar un plan predictivo', exam: true, chapters: [
      { title: 'Rutas de inspección', v: true, a: true },
      { title: 'Indicadores de confiabilidad', v: false, a: true },
    ] },
  ] },
  { key: 'E3', title: '[E2E V2.1 E3] Válvulas y control', theme: { themeFamily: 'tecnico', mode: 'dark' }, passing: 80, finalExam: true, engine: 'h5p', modules: [
    { title: 'Válvulas direccionales', objective: 'Leer esquemas de válvulas', exam: true, chapters: [
      { title: 'Esquemas de centros de válvula', v: true, a: true },
      { title: 'Solenoides y mando', v: false, a: false },
    ] },
    { title: 'Control de presión', objective: 'Ajustar válvulas de alivio', exam: true, chapters: [{ title: 'Válvulas de alivio y secuencia', v: false, a: true }] },
  ] },
];

async function readStructure(courseId) {
  const r = await api('GET', `/courses/${courseId}/modules`);
  if (r.status !== 200) throw new Error(`GET modules ${r.status} ${r.error}`);
  return r.data;
}
async function artifactsOfRun(runId) {
  return q(`select a.id, a.type, a.status, a.storage_bucket, a.storage_path, a.item_run_id, a.metadata, g.item_key
              from public.artifacts a join public.generation_item_runs g on g.id = a.item_run_id where g.job_id = $1 order by a.id`, [runId]);
}
async function itemRuns(runId) {
  return q(`select id, item_key, type, status, worker_id, attempt_count, output_summary, chapter_id, module_id, error as error_message from public.generation_item_runs where job_id = $1 order by item_key`, [runId]);
}
async function waitRunTerminal(ctl, label, timeoutMs = 15 * 60 * 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (['completed', 'failed', 'cancelled', 'fatal', 'stopped'].includes(ctl.state.status)) return ctl.state;
    await sleep(500);
  }
  throw new Error(`${label}: el ejecutor no terminó en ${timeoutMs} ms (estado ${JSON.stringify(ctl.state)})`);
}
async function waitItemsDone(runId, timeoutMs = 10 * 60 * 1000) {
  const t0 = Date.now();
  let items = [];
  while (Date.now() - t0 < timeoutMs) {
    items = await itemRuns(runId);
    if (items.length && items.every((i) => ['completed', 'failed', 'blocked', 'cancelled'].includes(i.status))) return items;
    await sleep(700);
  }
  return items;
}

/** Crea el curso por HTTP (estructura, toggles v3, perfiles), bloquea el Blueprint y crea el Manifest v3. */
async function createCourse(C, llm) {
  const fc = crypto.randomUUID();
  const c = await api('POST', '/courses/dynamic', { frontendCourseId: fc, title: C.title });
  ok(c.status === 201, `${C.key}: POST /courses/dynamic → 201`, { s: c.status, e: c.error });
  const courseId = Number(c.data.id);
  let st = await readStructure(courseId);
  let counter = st.structureVersionCounter;
  for (const m of st.modules) counter = (await api('DELETE', `/courses/${courseId}/modules/${m.id}`, { expectedCounter: counter })).data.structureVersionCounter;
  const setg = await api('PATCH', `/courses/${courseId}/structure-settings`, { finalExam: C.finalExam, activityEngine: C.engine, expectedCounter: counter });
  ok(setg.status === 200 && setg.data.finalExam === C.finalExam && setg.data.activityEngine === C.engine, `${C.key}: PATCH structure-settings → finalExam ${C.finalExam}, motor ${C.engine}`, { s: setg.status, e: setg.error, d: setg.data });
  counter = setg.data.structureVersionCounter;
  for (const ms of C.modules) {
    const cm = await api('POST', `/courses/${courseId}/modules`, { title: ms.title, objective: ms.objective, examEnabled: ms.exam, expectedCounter: counter });
    if (cm.status !== 201) throw new Error(`POST module ${cm.status} ${cm.error}`);
    counter = cm.data.structureVersionCounter;
    const mid = cm.data.module.id;
    const auto = cm.data.module.chapters || [];
    for (let i = 0; i < ms.chapters.length; i++) {
      const cs = ms.chapters[i];
      const body = { title: cs.title, objective: `Aplicar ${cs.title.toLowerCase()}`, videoEnabled: cs.v, activityEnabled: cs.a, expectedCounter: counter };
      const r = i === 0 && auto.length === 1
        ? await api('PATCH', `/courses/${courseId}/modules/${mid}/chapters/${auto[0].id}`, body)
        : await api('POST', `/courses/${courseId}/modules/${mid}/chapters`, body);
      if (![200, 201].includes(r.status)) throw new Error(`capítulo "${cs.title}": ${r.status} ${r.error}`);
      counter = r.data.structureVersionCounter;
    }
  }
  st = await readStructure(courseId);
  const mods = st.modules.map((m) => ({ id: m.id, title: m.title, exam: m.examEnabled, chapters: m.chapters.map((x) => ({ id: x.id, title: x.title, v: !!x.videoEnabled, a: x.activityEnabled !== false })) }));
  eq(mods.map((m) => m.chapters.map((x) => `${x.v ? 'V+' : 'V-'}${x.a ? 'A+' : 'A-'}`)), C.modules.map((m) => m.chapters.map((x) => `${x.v ? 'V+' : 'V-'}${x.a ? 'A+' : 'A-'}`)), `${C.key}: estructura viva con las combinaciones V/A pedidas`);
  // Perfiles (append-only, fuera del Blueprint): evaluación y presentación.
  const A = D('modules/course-profiles/course-profiles.js');
  const assessment = { ...A.defaultAssessmentProfile({ finalExam: C.finalExam }), passingGrade: C.passing };
  const pa = await api('POST', `/courses/${courseId}/profiles/assessment`, { data: assessment });
  ok(pa.status === 201, `${C.key}: POST profiles/assessment (passingGrade ${C.passing}) → 201`, { s: pa.status, e: pa.error });
  const pp = await api('POST', `/courses/${courseId}/profiles/presentation`, { data: { ...C.theme, brandSeed: null, themeVersion: 1 } });
  ok(pp.status === 201, `${C.key}: POST profiles/presentation (${C.theme.themeFamily}/${C.theme.mode}) → 201`, { s: pp.status, e: pp.error });
  const lock = await api('POST', `/courses/${courseId}/blueprints`, { expectedCounter: st.structureVersionCounter });
  ok(lock.status === 201 && lock.data.blueprint.snapshot && lock.data.blueprint.snapshot.schemaVersion === 2, `${C.key}: lock → Blueprint schemaVersion 2`, { s: lock.status, e: lock.error, sv: lock.data && lock.data.blueprint && lock.data.blueprint.snapshot && lock.data.blueprint.snapshot.schemaVersion });
  const n = lock.data.blueprint.blueprintNumber;
  const man = await api('POST', `/courses/${courseId}/blueprints/${n}/manifest`);
  ok(man.status === 201 && man.data.manifest.rulesVersion === 3, `${C.key}: POST manifest → 201 rulesVersion 3`, { s: man.status, e: man.error });
  const manifest = man.data.manifest;
  const M = manifest.manifest;
  const chapters = mods.flatMap((m) => m.chapters);
  const want = {
    videos: chapters.filter((x) => x.v).length, activities: chapters.filter((x) => x.a).length, exams: mods.filter((m) => m.exam).length,
  };
  eq([M.totals.videoCount, M.totals.activityCount, M.totals.examCount, M.totals.finalExamCount, M.totals.presentationCount, M.totals.audiobookChapterCount, M.totals.experienceCount],
    [want.videos, want.activities, want.exams, C.finalExam ? 1 : 0, chapters.length, chapters.length, chapters.length], `${C.key}: totales del Manifest v3 (video/actividad/examen/final/Gamma/audiolibro/experiencia)`);
  ok(M.items.filter((i) => i.type === 'activity').every((i) => i.variant === C.engine), `${C.key}: actividades con variant ${C.engine}`);
  // mapas del LLM falso (títulos → UUID)
  llm.st.courseId = courseId;
  llm.st.chapterByTitle.clear(); llm.st.moduleByTitle.clear(); llm.st.moduleOfChapter.clear();
  for (const m of mods) { llm.st.moduleByTitle.set(m.title, m.id); for (const x of m.chapters) { llm.st.chapterByTitle.set(x.title, x.id); llm.st.moduleOfChapter.set(x.id, m.id); } }
  return { courseId, frontendCourseId: fc, n, manifest, mods, assessment };
}

/** POST package + espera + descarga. */
async function packageRun(label, courseId, n, runId) {
  const t0 = Date.now();
  const reqd = await api('POST', `/courses/${courseId}/blueprints/${n}/manifest/runs/${runId}/package`);
  ok(reqd.status === 202 && reqd.data && reqd.data.jobId, `${label}: POST package → 202 {jobId}`, { s: reqd.status, e: reqd.error, d: reqd.raw });
  if (!(reqd.data && reqd.data.jobId)) throw new Error(`${label}: sin job de empaque`);
  let st = null;
  while (Date.now() - t0 < 5 * 60 * 1000) {
    st = await api('GET', `/courses/${courseId}/blueprints/${n}/manifest/runs/${runId}/package`);
    if (st.data && ['completed', 'failed'].includes(st.data.status)) break;
    await sleep(500);
  }
  const [job] = await q(`select id, worker_status, worker_id, output_summary, error_message from public.production_jobs where id = $1`, [reqd.data.jobId]);
  ok(st && st.data && st.data.status === 'completed' && st.data.downloadUrl, `${label}: dynamic-package-worker v3 completó el job (validador §Q.8 sobre los bytes antes de subir)`, { st: st && st.data, err: job && job.error_message });
  if (!(st && st.data && st.data.downloadUrl)) throw new Error(`${label}: empaque falló: ${job && job.error_message}`);
  const buf = Buffer.from(await (await fetch(st.data.downloadUrl)).arrayBuffer());
  const file = path.join(V3OUT, `${label}.mbz`);
  fs.writeFileSync(file, buf);
  results.mbz[label] = { file, bytes: buf.length, sha256: sha(buf), jobId: reqd.data.jobId, artifactId: st.data.artifactId, packagingMs: Date.now() - t0, summary: job.output_summary };
  return { buf, file, job, status: st.data };
}

async function ledgerRows(where = 'true', params = []) {
  return q(`select event_kind, cost_source, provider, operation, amount::float8 amount, billing_account, course_id, run_id, item_key, item_type, measurement_status from public.generation_cost_events where ${where}`, params);
}

// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  fs.writeFileSync(NET_LOG, '');
  db = new Client({ host: '127.0.0.1', port: PGPORT, user: 'postgres', database: 'v2db' });
  await db.connect();
  FAKES = await startFakes({ tlsDir: process.env.TLS_DIR, videogenKey: VIDEOGEN_KEY });
  const g = FAKES.google;
  g.fixedVideoId = YT_ID;
  const frontNet = [];
  let app, itemWorker, providerWorker, pkgWorker;
  const S = {};
  const llmBase = createLlm({ getFixtures: () => S.front.SV2_PREVIEW_FIXTURES, getSplit: (n) => S.front.dynExamQuestionSplit(n) });
  const llm = createLlmV3({ base: llmBase });
  const claimLog = [];
  function newFront(label) {
    const f = makeFront({ feRoot: FE, backendUrl: `http://127.0.0.1:${APP_PORT}`, storageUrl: FAKES.storageUrl, token: TOKEN, ownerId: OWNER, llm, logFile: path.join(V3OUT, `front-${label}.log`), netViolations: frontNet });
    const orig = f.backendDynClaim;
    f.backendDynClaim = function (runId, executorId, types, lease) {
      return orig(runId, executorId, types, lease).then((res) => {
        const it = res && res.data && res.data.item;
        if (it) claimLog.push({ label, itemKey: it.itemKey, type: it.type, types: [...types] });
        return res;
      });
    };
    return f;
  }
  const ledger0 = (await q(`select count(*)::int n from public.generation_cost_events`))[0].n;
  results.finops.ledgerEventsBeforeV3 = ledger0;

  try {
    await step('v3-0-arranque', async () => {
      app = await startApp();
      const f = await api('GET', '/features');
      eq(f.data, { dynamicCourseStructure: true, realVideo: true, coherenceLlm: false, manifestRulesVersion: 3 }, 'GET /features → rulesVersion 3 activo');
      S.front = newFront('v3');
      const tplIds = S.front.SCORM_V2_TEMPLATES.map((t) => t.id);
      S.templates = tplIds.filter((t) => S.front.scormV2ValidateRoomData(t, JSON.parse(JSON.stringify(S.front.SV2_PREVIEW_FIXTURES[t]))).ok);
      ok(S.templates.length >= 2, `plantillas SCORM v2 con fixture válido: ${S.templates.join(', ')}`);
      // Conexión YouTube del owner (refresh token cifrado con el AES-256-GCM real) + Google falso.
      process.env.YOUTUBE_TOKEN_SECRET = YT_SECRET;
      const { YoutubeTokenService } = D('youtube/youtube-token.service.js');
      const tks = new YoutubeTokenService();
      tks.onModuleInit();
      const enc = tks.encryptRefreshToken('fake-refresh-token-v3');
      await q(`insert into public.youtube_connections (user_id, user_email, channel_id, channel_title, encrypted_refresh_token, token_iv, scopes, status, connected_at)
               values ($1, 'e2e-v3-owner@example.com', 'UCe2eV3Channel00000000000', 'Canal E2E v3', $2, $3, 'youtube.upload,youtube.readonly', 'active', now())`, [OWNER, enc.encrypted, enc.iv]);
      g.refresh.set('fake-refresh-token-v3', 'fake-access-token-v3');
      g.channels.set('fake-access-token-v3', { id: 'UCe2eV3Channel00000000000', title: 'Canal E2E v3 (fake)', thumb: 'https://yt3.fake/v3.jpg' });
      const p1 = await api('GET', '/dynamic/youtube/preflight');
      ok(p1.data && p1.data.ok === true, 'preflight YouTube con canal falso → ok', p1.data);
    });

    // FinOps: decisión AUTO para un run 100 % mock (antes de levantar los workers: nada lo ejecuta).
    await step('v3-1-finops-gates', async () => {
      const ctx0 = { nombre: '[E2E V2.1 E0] Run mock', ...CTX, scormTemplateIds: S.templates };
      const C0 = { key: 'E0', title: ctx0.nombre, theme: { themeFamily: 'aula-clara', mode: 'light' }, passing: 70, finalExam: false, engine: 'h5p', modules: [
        { title: 'Módulo mock', objective: 'Probar la decisión AUTO', exam: false, chapters: [{ title: 'Capítulo mock sin video', v: false, a: true }] }] };
      const c0 = await createCourse(C0, llm);
      const subs0 = FAKES.videogen.submissions.length;
      const realProv = await api('POST', `/courses/${c0.courseId}/blueprints/${c0.n}/manifest/runs`, { ...ctx0, videoMode: 'mock' });
      ok(realProv.status === 409 && /^budget_approval_required/.test(String(realProv.error)), 'E0: run con Gamma/TTS REALES (providerModes por defecto) sin aprobación → 409 budget_approval_required', { s: realProv.status, e: realProv.error });
      const noRun = await q(`select count(*)::int n from public.production_jobs where course_id = $1 and execution_mode = 'dynamic_generation'`, [c0.courseId]);
      eq(noRun[0].n, 0, 'E0: el 409 no creó ningún run');
      const mock = await api('POST', `/courses/${c0.courseId}/blueprints/${c0.n}/manifest/runs`, { ...ctx0, videoMode: 'mock', providerModes: { presentation: 'mock', audio: 'mock' } });
      ok(mock.status === 201 && mock.data.run && mock.data.run.id, 'E0: run 100 % mock (video mock, Gamma/TTS mock) → 201 sin aprobación', { s: mock.status, e: mock.error });
      const runId = mock.data.run.id;
      const auth = await q(`select decision from public.cost_budget_authorizations where course_id = $1`, [c0.courseId]);
      ok(auth.length >= 1 && auth.every((a) => a.decision === 'AUTO_WITHIN_POLICY'), 'E0: decisión de presupuesto AUTO_WITHIN_POLICY para el run mock', auth);
      const est = await q(`select scope, run_id from public.cost_estimates where course_id = $1`, [c0.courseId]);
      ok(est.some((e) => e.run_id === runId && e.scope === 'run'), 'E0: cost_estimates del run creado (scope run)', est);
      const cancel = await api('POST', `/courses/${c0.courseId}/blueprints/${c0.n}/manifest/runs/${runId}/cancel`);
      ok([200, 201].includes(cancel.status), 'E0: run mock cancelado (no se ejecuta)', { s: cancel.status, e: cancel.error });
      eq(FAKES.videogen.submissions.length, subs0, 'E0: 0 llamadas a Videogen');
      results.finops.e0 = { courseId: c0.courseId, runId, authorizations: auth.map((a) => a.decision) };
    });

    await step('v3-2-workers', async () => {
      itemWorker = spawnProc('dynamic-item-worker', 'workers/dynamic-item-worker.js', {
        ...baseEnv(), DYNAMIC_ITEM_WORKER_ID: 'e2e-v3-item-worker', DYNAMIC_ITEM_WORKER_POLL_MS: '400', DYNAMIC_ITEM_WORKER_VIDEO_POLL_MS: '300',
        DYNAMIC_ITEM_WORKER_HEARTBEAT_MS: '5000', DYNAMIC_YOUTUBE_UPLOAD_RETRY_BASE_MS: '50', NODE_TLS_REJECT_UNAUTHORIZED: '0',
      });
      providerWorker = spawnProc('dynamic-provider-worker', 'workers/dynamic-provider-worker.js', { ...baseEnv(), DYNAMIC_PROVIDER_WORKER_ID: 'e2e-v3-provider-worker', DYNAMIC_PROVIDER_WORKER_POLL_MS: '400' });
      pkgWorker = spawnProc('dynamic-package-worker', 'workers/dynamic-package-worker.js', { ...baseEnv(), DYNAMIC_PACKAGE_WORKER_ID: 'e2e-v3-package-worker', DYNAMIC_PACKAGE_WORKER_POLL_MS: '400' });
      await sleep(2500);
      ok(!itemWorker.exited && !providerWorker.exited && !pkgWorker.exited, '3 workers reales vivos (item, provider, package)', { i: itemWorker.exited, p: providerWorker.exited, k: pkgWorker.exited });
    });

    for (const C of COURSES) {
      await step(`v3-${C.key}-generacion`, async () => {
        const c = await createCourse(C, llm);
        S[C.key] = c;
        const ctx = { nombre: C.title, ...CTX, scormTemplateIds: S.templates };
        const body = { ...ctx, videoMode: 'real', providerModes: { presentation: 'mock', audio: 'mock' } };
        const subs0 = FAKES.videogen.submissions.length;
        let start = await api('POST', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs`, body);
        const estM = /estimateId=([0-9a-f-]{36})/.exec(String(start.error || ''));
        ok(start.status === 409 && /^budget_approval_required/.test(String(start.error)) && !!estM, `${C.key}: run con video real (Videogen) sin aprobación → 409 budget_approval_required con estimateId`, { s: start.status, e: start.error });
        eq(FAKES.videogen.submissions.length, subs0, `${C.key}: el 409 no llamó a ningún proveedor`);
        await q(`insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, decision, approved_by, reason)
                 values ($1, $2, 1000, 'ADMIN_APPROVED', 'e2e-admin@cursia.test', 'e2e v3: aprobación del run (Videogen FALSO local)')`, [c.courseId, estM && estM[1]]);
        start = await api('POST', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs`, body);
        ok(start.status === 201 && start.data.run.videoDelivery === 'youtube', `${C.key}: run creado (201), videoDelivery youtube, providerModes mock`, { s: start.status, e: start.error, d: start.data && start.data.run });
        c.runId = start.data.run.id;
        const [job] = await q(`select input_payload from public.production_jobs where id = $1`, [c.runId]);
        const pm = job.input_payload.providerModes || {};
        eq([pm.presentation, pm.audio], ['mock', 'mock'], `${C.key}: providerModes congelados en el run`);
        llm.st.tag = 'A';
        const t0 = Date.now();
        const ctl = S.front.dynExecutorStart({ courseId: c.courseId, blueprintNumber: c.n, runId: c.runId });
        const stt = await waitRunTerminal(ctl, `${C.key} run`);
        const items = await waitItemsDone(c.runId);
        results.timings[`${C.key}-run`] = Date.now() - t0;
        ok(stt.status === 'completed' && stt.rulesVersion === 3, `${C.key}: ejecutor del navegador terminó (rulesVersion 3)`, stt);
        ok(stt.failed === 0 && !stt.fatalError, `${C.key}: ejecutor sin items fallidos`, stt);
        ok(llm.st.unknown.length === 0, `${C.key}: LLM falso sin prompts no reconocidos`, llm.st.unknown);
        const keys = c.manifest.manifest.items.map((i) => i.key).sort();
        eq(items.map((i) => i.item_key).sort(), keys, `${C.key}: item runs = items del Manifest v3 (por UUID)`);
        ok(items.every((i) => i.status === 'completed'), `${C.key}: los ${items.length} items completed`, items.filter((i) => i.status !== 'completed').map((i) => [i.item_key, i.status, i.error_message && i.error_message.slice(0, 300)]));
        const byType = (t) => items.filter((i) => i.type === t);
        ok(byType('video').every((i) => i.worker_id === 'e2e-v3-item-worker'), `${C.key}: videos por el dynamic-item-worker real`);
        ok([...byType('presentation'), ...byType('audio_welcome'), ...byType('audiobook_chapter')].every((i) => i.worker_id === 'e2e-v3-provider-worker'), `${C.key}: Gamma/TTS por el dynamic-provider-worker real (mock)`);
        ok(items.filter((i) => !['video', 'presentation', 'audio_welcome', 'audiobook_chapter'].includes(i.type)).every((i) => /^browser-/.test(i.worker_id || '')), `${C.key}: items LLM por el ejecutor del navegador`);
        for (const v of byType('video')) {
          const os = v.output_summary || {};
          ok(os.youtubeVideoId === YT_ID && os.delivery === 'completed' && os.external && os.external.durationSec === 468, `${C.key}: video ${v.chapter_id.slice(0, 8)} publicado (${YT_ID}), durationSec 468 del Videogen falso`, os);
        }
        const run = await api('GET', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs/${c.runId}`);
        ok(run.data && run.data.status === 'completed', `${C.key}: GET run → completed`, run.data && run.data.status);
        c.items = items;
        c.artifacts = await artifactsOfRun(c.runId);
        const mockArts = c.artifacts.filter((a) => ['dynamic_presentation', 'dynamic_audio_mp3'].includes(a.type));
        ok(mockArts.length === byType('presentation').length + byType('audio_welcome').length + byType('audiobook_chapter').length && mockArts.every((a) => a.metadata && (a.metadata.mock === true || a.metadata.fixture === true)),
          `${C.key}: artifacts de Gamma/TTS marcados mock (${mockArts.length})`, mockArts.map((a) => [a.item_key, a.metadata]));
        results.courses[C.key] = { courseId: c.courseId, frontendCourseId: c.frontendCourseId, blueprintNumber: c.n, runId: c.runId, items: items.length, spec: C,
          modules: c.mods, manifestItems: c.manifest.manifest.items.map((i) => ({ key: i.key, type: i.type, variant: i.variant || null })), manifestModules: c.manifest.manifest.modules,
          features: c.manifest.manifest.features, assessment: c.assessment };
      });

      await step(`v3-${C.key}-empaquetado`, async () => {
        const c = S[C.key];
        const P = await packageRun(C.key, c.courseId, c.n, c.runId);
        const os = P.job.output_summary || {};
        const TE = D('modules/theme-engine/index.js');
        const wantTheme = TE.themeSha256(TE.resolveTheme({ ...C.theme, themeVersion: 1 }));
        const BV = D('package/dynamic-mbz-builder-v3.js').DYNAMIC_MBZ_BUILDER_VERSION_V3;
        ok(os.builderVersion === BV && os.rulesVersion === 3 && os.themeSource === 'profile' && os.themeSha256 === wantTheme, `${C.key}: builder ${BV}, tema del perfil ${C.theme.themeFamily}/${C.theme.mode} (themeSha256 = resolveTheme del perfil)`, { b: os.builderVersion, src: os.themeSource, t: os.themeSha256, want: wantTheme });
        eq((os.warnings || []).filter((w) => !/mock/i.test(JSON.stringify(w))), [], `${C.key}: 0 warnings del worker (salvo los avisos de fixtures mock de Gamma/TTS)`);
        results.courses[C.key].packageSummary = os;
        c.pkg = P;
      });

      if (C.key === 'E1') {
        await step('v3-E1-reempaque-tema-y-nota', async () => {
          const c = S.E1;
          const itemsBefore = (await q(`select count(*)::int n from public.generation_item_runs where job_id = $1`, [c.runId]))[0].n;
          const allItemsBefore = (await q(`select count(*)::int n from public.generation_item_runs`))[0].n;
          const evBefore = await q(`select id from public.generation_cost_events`);
          const subs0 = FAKES.videogen.submissions.length;
          const callsBefore = llm.st.calls.length;
          const A = D('modules/course-profiles/course-profiles.js');
          const pa = await api('POST', `/courses/${c.courseId}/profiles/assessment`, { data: { ...A.defaultAssessmentProfile({ finalExam: true }), passingGrade: 80 } });
          ok(pa.status === 201, 'E1: perfil de evaluación nuevo (passingGrade 80) → 201', { s: pa.status, e: pa.error });
          const pp = await api('POST', `/courses/${c.courseId}/profiles/presentation`, { data: { themeFamily: 'tecnico', mode: 'dark', brandSeed: null, themeVersion: 1 } });
          ok(pp.status === 201, 'E1: perfil de presentación nuevo (tecnico/dark) → 201', { s: pp.status, e: pp.error });
          const pk = await api('GET', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs/${c.runId}/package`);
          ok(pk.data && pk.data.stale === true, 'E1: el paquete anterior queda stale (perfil nuevo)', pk.data);
          const P = await packageRun('E1-repack', c.courseId, c.n, c.runId);
          const os = P.job.output_summary || {};
          const TE = D('modules/theme-engine/index.js');
          const wantTheme = TE.themeSha256(TE.resolveTheme({ themeFamily: 'tecnico', mode: 'dark', themeVersion: 1 }));
          ok(os.themeSha256 === wantTheme && os.themeSha256 !== results.mbz.E1.summary.themeSha256, 'E1-repack: tema tecnico/dark (themeSha256 nuevo = resolveTheme del perfil nuevo)', { got: os.themeSha256, want: wantTheme });
          ok(os.assessmentProfileVersion !== results.mbz.E1.summary.assessmentProfileVersion || os.presentationProfileVersion !== results.mbz.E1.summary.presentationProfileVersion, 'E1-repack: versiones de perfil nuevas en el resumen del empaque', { a: [results.mbz.E1.summary.assessmentProfileVersion, os.assessmentProfileVersion], p: [results.mbz.E1.summary.presentationProfileVersion, os.presentationProfileVersion] });
          eq((await q(`select count(*)::int n from public.generation_item_runs where job_id = $1`, [c.runId]))[0].n, itemsBefore, 'E1-repack: 0 item runs nuevos en el run');
          eq((await q(`select count(*)::int n from public.generation_item_runs`))[0].n, allItemsBefore, 'E1-repack: 0 item runs nuevos en toda la DB');
          eq(llm.st.calls.length, callsBefore, 'E1-repack: 0 llamadas al LLM');
          eq(FAKES.videogen.submissions.length, subs0, 'E1-repack: 0 envíos a Videogen');
          const before = new Set(evBefore.map((e) => e.id));
          const newEv = (await q(`select id, event_kind, cost_source, operation, amount::float8 amount, provider from public.generation_cost_events`)).filter((e) => !before.has(e.id));
          ok(newEv.length === 1 && newEv[0].event_kind === 'CHARGE' && newEv[0].cost_source === 'ZERO_BY_DESIGN' && newEv[0].amount === 0, 'E1-repack: único evento nuevo del ledger = CHARGE ZERO_BY_DESIGN del empaque (monto 0)', newEv);
          ok(results.mbz['E1-repack'].sha256 !== results.mbz.E1.sha256, 'E1-repack: sha del MBZ distinto al del E1', [results.mbz.E1.sha256, results.mbz['E1-repack'].sha256]);
          eq(os.sourceArtifactIds, results.mbz.E1.summary.sourceArtifactIds, 'E1-repack: MISMOS artifacts de contenido (sourceArtifactIds idénticos)');
          ok(os.sourceIdsHash !== results.mbz.E1.summary.sourceIdsHash, 'E1-repack: clave de reuse distinta (tema/perfil forman parte de la clave)');
          // Los .h5p de contenido no cambian con el tema (solo passPercentage de QS si aplica).
          const z1 = await JSZip.loadAsync(S.E1.pkg.buf); const z2 = await JSZip.loadAsync(P.buf);
          const names1 = Object.keys(z1.files).filter((f) => /^files\//.test(f)).length; const names2 = Object.keys(z2.files).filter((f) => /^files\//.test(f)).length;
          ok(names1 > 0 && names2 > 0, `E1-repack: blobs en ambos paquetes (${names1} / ${names2})`);
          results.courses.E1repack = { ...results.courses.E1, theme: { themeFamily: 'tecnico', mode: 'dark' }, passing: 80, packageSummary: os };
        });
      }
    }

    await step('v3-finops', async () => {
      const courseIds = COURSES.map((C) => S[C.key].courseId);
      const ev = await ledgerRows('course_id = any($1::int[])', [courseIds]);
      const bySrc = {};
      ev.forEach((e) => { const k = `${e.provider}/${e.cost_source}/${e.operation}`; bySrc[k] = (bySrc[k] || 0) + 1; });
      results.finops.ledgerV3 = bySrc;
      const videoCount = COURSES.reduce((n, C) => n + C.modules.flatMap((m) => m.chapters).filter((x) => x.v).length, 0);
      const nonVideo = ev.filter((e) => !['videogen', 'youtube'].includes(e.provider));
      ok(nonVideo.length > 0 && nonVideo.every((e) => ['MOCK', 'ZERO_BY_DESIGN'].includes(e.cost_source) && e.amount === 0), 'ledger v3: todo evento que no es del video (Gamma/TTS/empaque) es MOCK o ZERO_BY_DESIGN con monto 0', nonVideo.filter((e) => !['MOCK', 'ZERO_BY_DESIGN'].includes(e.cost_source)));
      const mockEv = ev.filter((e) => e.cost_source === 'MOCK');
      const provItems = COURSES.reduce((n, C) => n + 1 + 2 * C.modules.flatMap((m) => m.chapters).length, 0);
      eq(mockEv.length, provItems, `ledger v3: ${provItems} eventos MOCK (presentation + audio_welcome + audiobook_chapter, billing_account mock)`);
      ok(mockEv.every((e) => e.billing_account === 'mock'), 'ledger v3: los MOCK con billing_account mock');
      const zero = ev.filter((e) => e.cost_source === 'ZERO_BY_DESIGN' && e.operation === 'package.build');
      eq(zero.length, COURSES.length + 1, `ledger v3: ${COURSES.length + 1} eventos ZERO_BY_DESIGN de empaque (uno por curso + el re-empaque de E1)`);
      const yt = ev.filter((e) => e.provider === 'youtube');
      ok(yt.length >= 1 && yt.every((e) => e.cost_source === 'ZERO_BY_DESIGN' && e.amount === 0), 'ledger v3: cuota de YouTube como ZERO_BY_DESIGN (monto 0)', yt);
      const vg = ev.filter((e) => e.provider === 'videogen');
      ok(vg.length === videoCount && vg.every((e) => e.cost_source === 'CALCULATED_FROM_USAGE' && Math.abs(e.amount - 0.42) < 1e-9),
        `ledger v3: ${videoCount} eventos de Videogen = el costo que devuelve el Videogen FALSO local (0.42, CALCULATED_FROM_USAGE, HD-V21-20); ninguno de un proveedor real`, vg);
      const est = await q(`select course_id, scope, run_id from public.cost_estimates where course_id = any($1::int[])`, [courseIds]);
      ok(COURSES.every((C) => est.some((e) => e.course_id === S[C.key].courseId && e.run_id === S[C.key].runId)), 'cost_estimates creados para los 3 runs', est);
      const auth = await q(`select course_id, decision from public.cost_budget_authorizations where course_id = any($1::int[])`, [courseIds]);
      ok(COURSES.every((C) => auth.some((a) => a.course_id === S[C.key].courseId && a.decision === 'ADMIN_APPROVED')), 'runs con video real: autorización ADMIN_APPROVED (HD-V21-19)', auth);
      results.finops.authorizations = auth;
      const blocked = fs.readFileSync(NET_LOG, 'utf8').trim();
      ok(blocked === '', 'netguard (app + 3 workers): 0 conexiones fuera de 127.0.0.1 ⇒ 0 llamadas a proveedores reales', blocked.slice(0, 800));
      eq(frontNet, [], 'navegador simulado: 0 fetch fuera de 127.0.0.1');
      results.counters = {
        realProviderCalls: blocked === '' && frontNet.length === 0 ? 0 : 'VIOLATION',
        netguardBlocked: blocked ? blocked.split('\n').length : 0,
        fakeVideogenSubmissions: FAKES.videogen.submissions.length,
        fakeGoogleUploads: g.uploads.length,
        fakeGoogleCalls: g.calls.length,
        fakeLlmCalls: llm.st.calls.length,
        fakeLlmInvalidFirst: llm.st.invalidSent,
        fakeLlmRetriesSeen: llm.st.retriesSeen,
        gammaRealCalls: 0, ttsRealCalls: 0, anthropicRealCalls: 0, videogenRealCalls: 0, youtubeRealCalls: 0,
      };
      eq(FAKES.videogen.submissions.length, videoCount, `Videogen FALSO: ${videoCount} envíos (uno por video; ninguno en los 409 ni en el re-empaque)`);
      eq(g.uploads.length, videoCount, `Google FALSO: ${videoCount} subidas Unlisted`);
      // Reintento dirigido: una respuesta inválida por tipo, una sola vez, y luego válida.
      const kinds = ['experience', 'course_intro', 'module_intro', 'video_interactions', 'h5p_questionset', 'h5p_dragtext', 'h5p_blanks', 'final_exam'];
      const sent = llm.st.invalidSent;
      const seenKinds = kinds.filter((k) => sent[k]);
      ok(seenKinds.length >= 6 && seenKinds.every((k) => sent[k] === 1), `LLM falso: 1 respuesta inválida por tipo (${seenKinds.join(', ')})`, sent);
      ok(seenKinds.every((k) => (llm.st.retriesSeen[k] || 0) >= 1), 'cada respuesta inválida produjo exactamente el reintento dirigido (validation_retry / continuation) y luego pasó', llm.st.retriesSeen);
    }, { fatal: false });

    // ═══ Moodle: restore + inspección + simulación de notas (4 MBZ) ═══
    const MOODLE_JOBS = [['E1', 'E1'], ['E1-repack', 'E1repack'], ['E2', 'E2'], ['E3', 'E3']];
    const SHELL = D('modules/course-shell/index.js');
    const AS = D('package/assessment/index.js');
    const { mp3DurationSeconds } = D('package/audio/mp3-parser.js');
    const { formatDurationEs } = D('package/audio/format-duration.js');
    const PHP = process.env.PHP_BIN;
    const PHPINI = process.env.MOODLE_PHPINI;
    const kindOf = (idn) => (/:video$/.test(idn) ? 'video' : /:activity$/.test(idn) ? 'activity' : /^cv3:exam:/.test(idn) ? 'exam' : idn === 'cv3:final_exam' ? 'finalExam' : null);
    results.moodle = {};
    await step('moodle-preflight-h5p', async () => {
      const pf = spawnSync(process.execPath, [path.join(REPO, 'scripts/h5p-preflight-moodle.js'), process.env.MOODLE_ROOT, PHPINI], { encoding: 'utf8', env: { ...process.env, PHP_BIN: PHP } });
      ok(pf.status === 0, 'preflight de librerías H5P del sitio vs CURSIA_H5P_PROFILE_V1 (h5p-preflight-moodle.js) pasa', (pf.stdout + pf.stderr).slice(-800));
    }, { fatal: false });
    for (const [label, ckey] of MOODLE_JOBS) {
      await step(`moodle-${label}`, async () => {
        const info = results.courses[ckey];
        const mbz = results.mbz[label];
        const rs = spawnSync(path.join(MOODLE_SCRATCH, 'restore-and-inspect.sh'), [mbz.file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        fs.writeFileSync(path.join(V3OUT, `moodle-${label}.restore.log`), `${rs.stdout}\n--- stderr ---\n${rs.stderr}`);
        ok(rs.status === 0, `${label}: restore-and-inspect.sh exit 0`, rs.stderr.slice(-600));
        const courseid = Number((/Restored course id: (\d+)/.exec(rs.stderr) || [])[1]);
        ok(courseid > 0, `${label}: curso Moodle restaurado #${courseid}`);
        const cliWarn = rs.stderr.split('\n').filter((l) => /warning|notice|debug|deprecated|exception/i.test(l));
        eq(cliWarn, [], `${label}: salida del CLI de restore sin warnings/notices`);
        const inPath = path.join(V3OUT, `moodle-${label}.in.json`);
        const outPath = path.join(V3OUT, `moodle-${label}.json`);
        fs.writeFileSync(inPath, JSON.stringify({ moodleRoot: process.env.MOODLE_ROOT, courseid, mbz: mbz.file }));
        const ins = spawnSync(PHP, ['-c', PHPINI, path.join(REPO, 'scripts/moodle/v21-packaging-v3-inspect.php'), inPath, outPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        ok(ins.status === 0 && !/warning|notice|deprecated/i.test(ins.stderr || ''), `${label}: inspector PHP sin error`, (ins.stderr || '').slice(0, 600));
        const o = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        results.moodle[label] = { courseid, warnings: (o.precheck.warnings || []).length + (o.precheck.errors || []).length + (o.restoreLogLines || []).length + (o.restoreDbLogWarnings || []).length + cliWarn.length };
        eq(o.precheck, { warnings: [], errors: [] }, `${label}: precheck 0 warnings / 0 errors`);
        eq(o.restoreStatus, 1000, `${label}: restore_controller status 1000 (FINISHED_OK)`);
        eq([o.restoreLogFound, o.restoreLogLines, o.restoreDbLogWarnings], [true, [], []], `${label}: log del restore y backup_logs sin warnings`);
        // Estructura por UUID (idnumber cv3:…) = Manifest + chapterSlotSequence (orden del ensamblador).
        const M = { modules: info.manifestModules, features: info.features };
        const want = [];
        want.push([0, ['cv3:shell:forum', 'cv3:shell:welcome', 'cv3:shell:audio_welcome', 'cv3:shell:competencies', 'cv3:shell:methodology']]);
        want.push([1, ['cv3:shell:route', 'cv3:shell:libro', 'cv3:shell:libro_card', 'cv3:shell:audiobook']]);
        for (const mod of M.modules) {
          const ids = [`cv3:module_intro:${mod.moduleId}`];
          for (const ch of mod.chapters) for (const s of SHELL.chapterSlotSequence({ videoEnabled: ch.videoEnabled, activityEnabled: ch.activityEnabled })) {
            const role = s.startsWith('label:') ? s.slice(6) : s === 'video_h5p' ? 'video' : s;
            ids.push(`cv3:ch:${ch.chapterId}:${role}`);
          }
          if (mod.examEnabled) ids.push(`cv3:exam_info:${mod.moduleId}`, `cv3:exam:${mod.moduleId}`);
          want.push([1 + mod.moduleNumber, ids]);
        }
        want.push([2 + M.modules.length, M.features.finalExam ? ['cv3:shell:closing', 'cv3:final_exam_info', 'cv3:final_exam'] : ['cv3:shell:closing']]);
        eq(o.sections.map((s) => [s.section, s.cms.map((c) => c.idnumber)]), want, `${label}: secciones × actividades por UUID = orden del ensamblador de capítulo`);
        const cms = o.sections.flatMap((s) => s.cms);
        const cm = Object.fromEntries(cms.map((c) => [c.idnumber, c]));
        // Sin video/actividad fantasma: V− sin primer/video; A− sin instrucción/actividad; y ningún label de esos capítulos las menciona.
        const chFlags = M.modules.flatMap((m) => m.chapters);
        const phantom = [];
        for (const ch of chFlags) {
          const mine = cms.filter((c) => c.idnumber && c.idnumber.startsWith(`cv3:ch:${ch.chapterId}:`));
          if (!ch.videoEnabled && mine.some((c) => /:(video|video_primer)$/.test(c.idnumber))) phantom.push(`${ch.chapterId}: video`);
          if (!ch.activityEnabled && mine.some((c) => /:(activity|activity_instruction)$/.test(c.idnumber))) phantom.push(`${ch.chapterId}: actividad`);
        }
        eq(phantom, [], `${label}: 0 videos/actividades fantasma (V−/A− sin slots)`);
        const rsv = AS.resolveAssessment(info.assessment && label !== 'E1-repack' ? info.assessment : { ...info.assessment, passingGrade: 80 }, { hasFinalExam: M.features.finalExam, activityEngine: M.features.activityEngine });
        const passing = label === 'E1-repack' ? 80 : info.spec.passing;
        results.moodle[label].passing = passing;
        // gradepass/grademax/categoría/completion por ítem calificable
        const graded = cms.filter((c) => kindOf(c.idnumber));
        const bad = [];
        for (const c of graded) {
          const k = rsv.kinds[kindOf(c.idnumber)];
          const it = o.items.find((i) => i.idnumber === c.idnumber);
          if (!it) { bad.push(`${c.idnumber}: sin grade item`); continue; }
          if (it.gradepass !== passing || k.passingGrade !== passing) bad.push(`${c.idnumber}: gradepass ${it.gradepass} ≠ ${passing}`);
          if (it.grademax !== 100 || it.grademin !== 0) bad.push(`${c.idnumber}: rango ${it.grademin}–${it.grademax}`);
          if (it.category !== AS.ASSESSMENT_CATEGORY_NAMES[k.category]) bad.push(`${c.idnumber}: categoría ${it.category}`);
          if (!(c.completion === 2 && String(c.completiongradeitemnumber) === '0' && c.completionpassgrade === 1)) bad.push(`${c.idnumber}: completion ${c.completion}/${c.completiongradeitemnumber}/${c.completionpassgrade}`);
        }
        eq(bad, [], `${label}: ${graded.length} ítems calificables con gradepass ${passing}, 0–100, categoría y completionpassgrade`);
        const wantW = M.features.finalExam ? [30, 50, 20] : [40, 60];
        eq(o.categories.filter((x) => x.depth === 2).map((x) => x.weight), wantW, `${label}: categorías ponderadas ${wantW.join('/')}`);
        const top = o.categories.find((x) => x.depth === 1);
        eq([top.aggregation, o.courseItem.grademax], [10, 100], `${label}: curso con media ponderada (aggregation 10), total sobre 100`);
        const expCrit = AS.completionCriteriaFor(graded.map((c) => ({ moduleId: c.cmid, modname: c.modname, kind: kindOf(c.idnumber) })), rsv.courseCompletion).map((x) => cms.find((c) => c.cmid === x.moduleId).idnumber);
        eq(o.criteria.filter((x) => x.criteriatype === 4).map((x) => x.idnumber), expCrit, `${label}: criterios de completion del curso (${expCrit.length}) por UUID`);
        const quizzes = Object.entries(o.quizzes);
        ok(quizzes.length === M.modules.filter((m) => m.examEnabled).length + (M.features.finalExam ? 1 : 0) && quizzes.every(([id, qz]) => qz.attempts === rsv.kinds[kindOf(id)].attempts && qz.sumgrades === 100 && qz.maxmarkSum === 100 && qz.slots > 0),
          `${label}: quizzes con intentos del perfil (${quizzes.map(([, qz]) => qz.attempts).join(',')}) y Σ maxmark = 100`, o.quizzes);
        const h5ps = Object.entries(o.h5ps);
        const deployBad = h5ps.filter(([, h]) => !(h.deploy.h5pid && !h.deploy.exception && h.deploy.messages.length === 0)).map(([id, h]) => [id, h.deploy]);
        eq(deployBad, [], `${label}: los ${h5ps.length} H5P despliegan con las librerías del sitio (preflight OK)`);
        const scorms = Object.keys(o.scorms);
        eq(scorms.length, info.spec.engine === 'scorm' ? chFlags.filter((x) => x.activityEnabled).length : 0, `${label}: SCORM restaurados = actividades del motor scorm`);
        // Archivos: audio (con duración medida en el label), Libro, Gamma (portada + PDF).
        const zip = await JSZip.loadAsync(fs.readFileSync(mbz.file));
        const blobByHash = async (h) => { const f = zip.file(`files/${h.slice(0, 2)}/${h}`); return f ? f.async('nodebuffer') : null; };
        const aw = (cm['cv3:shell:audio_welcome'] || { files: [] }).files.find((f) => /\.mp3$/.test(f.name));
        const ab = (cm['cv3:shell:audiobook'] || { files: [] }).files.find((f) => /\.mp3$/.test(f.name));
        const lb = (cm['cv3:shell:libro'] || { files: [] }).files.find((f) => f.name === 'libro_guia_completo.html');
        ok(aw && ab && lb, `${label}: audio de bienvenida, audiolibro y Libro Guía restaurados`, { aw, ab, lb });
        const labels = spawnSync(PHP, ['-c', PHPINI, path.join(HERE, 'moodle-v3-labels.php'), process.env.MOODLE_ROOT, String(courseid)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        const L = JSON.parse((labels.stdout || '{}').split('\n').find((l) => l.startsWith('{')) || '{}');
        ok(labels.status === 0 && L.labels, `${label}: textos de labels leídos de la DB`, (labels.stderr || '').slice(0, 300));
        const text = (idn) => ((L.labels || {})[idn] || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
        if (aw && ab) {
          const awS = mp3DurationSeconds(await blobByHash(aw.hash));
          const abS = mp3DurationSeconds(await blobByHash(ab.hash));
          ok(text('cv3:shell:audio_welcome').includes(formatDurationEs(awS)), `${label}: el label del audio de bienvenida muestra la duración MEDIDA (${formatDurationEs(awS)})`, text('cv3:shell:audio_welcome').slice(0, 300));
          ok(text('cv3:shell:audiobook').includes(formatDurationEs(abS)), `${label}: el label del audiolibro muestra la duración total MEDIDA (${formatDurationEs(abS)})`, text('cv3:shell:audiobook').slice(0, 300));
          results.moodle[label].audio = { welcomeSec: awS, audiobookSec: abS };
        }
        const pres = cms.filter((c) => /:presentation$/.test(c.idnumber));
        ok(pres.length === chFlags.length && pres.every((c) => JSON.stringify(c.files.map((f) => f.mime).sort()) === JSON.stringify(['application/pdf', 'image/png'])), `${label}: ${chFlags.length} tarjetas Gamma con portada PNG + PDF`, pres.map((c) => c.files.map((f) => f.mime)));
        // Cifras del shell = Manifest (facts).
        const nCh = chFlags.length; const nV = chFlags.filter((x) => x.videoEnabled).length; const nA = chFlags.filter((x) => x.activityEnabled).length;
        const nEval = M.modules.filter((m) => m.examEnabled).length + (M.features.finalExam ? 1 : 0);
        const w = text('cv3:shell:welcome');
        const num = (re) => { const m = re.exec(w); return m ? Number(m[1]) : null; };
        const got = { modules: num(/(\d+)\s+módulos?/), chapters: num(/(\d+)\s+capítulos?/), videos: num(/(\d+)\s+videos? interactivos?/), activities: num(/(\d+)\s+actividad(?:es)? prácticas?/), evaluations: num(/(\d+)\s+evaluaci(?:ón|ones)/) };
        eq(got, { modules: M.modules.length, chapters: nCh, videos: nV || null, activities: nA || null, evaluations: nEval || null }, `${label}: cifras de la bienvenida = Manifest (módulos, capítulos, videos, actividades, evaluaciones)`);
        // ningún label de capítulo V−/A− menciona el recurso apagado
        const mention = [];
        for (const ch of chFlags) {
          const t = Object.entries(L.labels || {}).filter(([k]) => k.startsWith(`cv3:ch:${ch.chapterId}:`)).map(([, v]) => v.replace(/<[^>]+>/g, ' ')).join(' ').toLowerCase();
          if (!ch.videoEnabled && /\bvideo\b/.test(t)) mention.push(`${ch.chapterId.slice(0, 8)} menciona video`);
          if (!ch.activityEnabled && /actividad (práctica|interactiva)/.test(t)) mention.push(`${ch.chapterId.slice(0, 8)} menciona actividad`);
        }
        eq(mention, [], `${label}: ningún label de capítulo menciona un video/actividad apagado`);
        // ── simulación de notas por la API de Moodle ──
        const plan = { pass: {}, fail: {}, mixed: {} };
        const gradedList = graded.map((c) => ({ idnumber: c.idnumber, modname: c.modname, kind: kindOf(c.idnumber) }));
        gradedList.forEach((c, i) => {
          plan.pass[c.idnumber] = passing;              // exactamente la nota aprobatoria → COMPLETE_PASS
          plan.fail[c.idnumber] = passing - 1;          // un punto abajo → COMPLETE_FAIL
          plan.mixed[c.idnumber] = i % 2 === 0 ? 100 : 0; // 0 y 100 (bordes del rango)
        });
        const simIn = path.join(V3OUT, `moodle-${label}.sim.in.json`);
        const simOut = path.join(V3OUT, `moodle-${label}.sim.json`);
        fs.writeFileSync(simIn, JSON.stringify({ moodleRoot: process.env.MOODLE_ROOT, courseid, grades: plan }));
        const sim = spawnSync(PHP, ['-c', PHPINI, path.join(HERE, 'moodle-v3-grades.php'), simIn, simOut], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        ok(sim.status === 0 && !/warning|notice|deprecated/i.test(sim.stderr || ''), `${label}: simulación de notas (PHP) sin error`, (sim.stderr || sim.stdout || '').slice(-800));
        const so = JSON.parse(fs.readFileSync(simOut, 'utf8'));
        const catOf = (idn) => rsv.kinds[kindOf(idn)].category;
        const weights = Object.fromEntries(rsv.categories.map((x) => [x.key, x.weight]));
        const expectTotal = (who) => {
          const byCat = {};
          gradedList.forEach((c) => { (byCat[catOf(c.idnumber)] = byCat[catOf(c.idnumber)] || []).push(plan[who][c.idnumber]); });
          let num2 = 0; let den = 0;
          for (const [k, arr] of Object.entries(byCat)) { const mean = arr.reduce((a, b) => a + b, 0) / arr.length; num2 += (weights[k] || 0) * mean; den += weights[k] || 0; }
          return num2 / den;
        };
        for (const who of ['pass', 'fail', 'mixed']) {
          const r = so.sim[who];
          const badG = gradedList.filter((c) => r.grades[c.idnumber] !== plan[who][c.idnumber] || r.grades[c.idnumber] < 0 || r.grades[c.idnumber] > 100).map((c) => [c.idnumber, r.grades[c.idnumber]]);
          eq(badG, [], `${label} [${who}]: notas registradas en 0–100 = las simuladas`);
          const wantState = (c) => (plan[who][c.idnumber] >= passing ? 2 : 3);
          const badS = gradedList.filter((c) => r.states[c.idnumber] !== wantState(c)).map((c) => [c.idnumber, r.states[c.idnumber], plan[who][c.idnumber]]);
          eq(badS, [], `${label} [${who}]: COMPLETE_PASS(2)/COMPLETE_FAIL(3) alrededor de la nota aprobatoria ${passing}`);
          const et = expectTotal(who);
          ok(r.courseTotal !== null && Math.abs(r.courseTotal - et) < 0.01, `${label} [${who}]: total ponderado del curso ${r.courseTotal} ≈ ${et.toFixed(2)}`, { got: r.courseTotal, want: et });
          if (who === 'pass') ok(r.courseComplete === true, `${label} [pass]: curso completo (criterios por actividad/examen cumplidos)`, r);
          if (who === 'fail') ok(r.courseComplete === false, `${label} [fail]: curso NO completo`, r);
        }
        results.moodle[label].sim = so.sim;
        results.moodle[label].cms = cms.map((c) => ({ cmid: c.cmid, idnumber: c.idnumber, modname: c.modname }));
      }, { fatal: false });
    }

    await step('v3-red-final', async () => {
      const blocked = fs.readFileSync(NET_LOG, 'utf8').trim();
      ok(blocked === '', 'netguard: 0 conexiones fuera de 127.0.0.1 en toda la fase v3', blocked.slice(0, 500));
    }, { fatal: false });
  } catch (e) {
    console.error('ABORT', e && e.stack);
    results.aborted = String(e && e.message);
  } finally {
    for (const ch of [...children]) await stopProc(ch);
    await FAKES.close().catch(() => {});
    await db.end().catch(() => {});
    results.finishedAt = new Date().toISOString();
    results.pass = !results.aborted && Object.values(results.steps).every((s) => s.pass) && results.assertions.every((a) => a.ok);
    results.totals = { assertions: results.assertions.length, failed: results.assertions.filter((a) => !a.ok).length };
    save();
    console.log(`\nE2E V2.1 (rulesVersion 3): ${results.pass ? 'PASS' : 'FAIL'} — ${results.totals.assertions} aserciones, ${results.totals.failed} fallidas`);
    process.exit(results.pass ? 0 : 1);
  }
})();
