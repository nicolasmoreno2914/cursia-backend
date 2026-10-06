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
//
// EV6 P2-B6 — evaluaciones como BANCOS (dynamic_exam_bank_json): E1 y E3 corren con el modo banco
// del ejecutor ENCENDIDO solo dentro de esta prueba (override `S.front.DYN_EXAM_BANK_MODE_ENABLED =
// true` sobre el vm, DESPUÉS de cargar 45; el frontend de producción trae la constante en false).
// E2 y E4 siguen por GIFT (cobertura del camino de siempre). El LLM falso de bancos
// (llm-exam-bank.js) inyecta una falla UNA vez → exactamente una reparación.
//
// EV6 H5P v2 (H4) — E5: curso con DYNAMIC_ACTIVITY_TYPE_RULES=2 (la app se REINICIA con ese env solo
// para E5, después de E1–E4, que siguen con rules 0/1 y sus aserciones de siempre): capítulo «decidir…»
// → Branching Scenario (respuesta inválida una vez → reintento dirigido), «Repaso» encendido por ser un
// curso nuevo con H5P v2, IV avanzado (video de 468 s → 2 pausas de reflexión) → empaque → restore en
// Moodle 4.5 → inspección. Necesita el frontend de H3 (fixtures/h5p2/fake-llm-h5p2.json); con un
// frontend sin H5P v2, E2E_H5P2=auto (default) omite E5 (queda registrado) y E2E_H5P2=require falla.
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
const { startFakes, startProviderFakes } = require('./fakes');
const { makeFront } = require('./front');
const { createLlm } = require('./llm');
const { createLlmV3 } = require('./llm-v3');
const D = (p) => require(path.join(REPO, 'dist', p));
const SHELL_TYPES = require(path.join(REPO, 'dist', 'modules/course-shell/index.js'));
const PV = require('./providers');
// EV6 H5P v2: fixtures del LLM falso del frontend H3 (null si el frontend no trae H5P v2).
const H5P2_FIXTURE = path.join(FE, 'fixtures/h5p2/fake-llm-h5p2.json');
const H5P2 = fs.existsSync(H5P2_FIXTURE) ? JSON.parse(fs.readFileSync(H5P2_FIXTURE, 'utf8')) : null;
const H5P2_MODE = process.env.E2E_H5P2 || 'auto'; // auto | require | off

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
// LOOP 7: restores de Moodle con la sesión del admin (como un restore web): los overrides del paquete se aplican.
process.env.CURSIA_RESTORE_PHP = process.env.CURSIA_RESTORE_PHP || path.join(REPO, 'scripts/moodle/restore-as-admin.php');
// V2.1 F2: `E2E_V3_ONLY=real-providers` corre SOLO arranque + workers + E4 (Gamma/TTS/LLM reales contra
// fakes locales), sin E1–E3 ni restores de Moodle (para correrlo aparte cuando el Moodle local está ocupado).
const ONLY_REAL_PROVIDERS = process.env.E2E_V3_ONLY === 'real-providers';
// Claves FALSAS de los proveedores reales (Gamma/OpenAI/Anthropic): solo abren los fakes de 127.0.0.1.
const PROVIDER_KEYS = { gamma: 'fake-gamma-key-e2e-local', openai: 'fake-openai-key-e2e-local', anthropic: 'fake-anthropic-key-e2e-local' };
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
let PFAKES; // V2.1 F2: Gamma / OpenAI TTS / Anthropic falsos
let PURLS;
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
    // EV6 DoD (BE-A): SOLO en este sandbox — escape de QA para video de vista previa y el owner de la
    // prueba como SUPER_ADMIN (E1–E3 terminan `preview` por Gamma/TTS mock: su paquete es QA, rotulado).
    DYNAMIC_ALLOW_VIDEO_PREVIEW: 'true', SUPER_ADMIN_EMAILS: 'e2e-v3-owner@example.com',
    // Config de producción del video: entrega YouTube (sin DYNAMIC_VIDEO_DELIVERY ni el escape videogen_direct).
    YOUTUBE_TOKEN_SECRET: YT_SECRET, YOUTUBE_CLIENT_ID: 'fake-client-id', YOUTUBE_CLIENT_SECRET: 'fake-client-secret',
    VIDEOGEN_API_URL: FAKES.videogenUrl, VIDEOGEN_API_KEY: VIDEOGEN_KEY,
    // V2.1 F2: proveedores REALES de Gamma/TTS/LLM apuntando a fakes en 127.0.0.1 (claves falsas).
    GAMMA_API_KEY: PROVIDER_KEYS.gamma, GAMMA_API_BASE_URL: PURLS.gammaUrl,
    GAMMA_THEME_V21_LIGHT_DEFAULT: 'e2e-theme-light', GAMMA_THEME_V21_DARK_DEFAULT: 'e2e-theme-dark',
    OPENAI_API_KEY: PROVIDER_KEYS.openai, OPENAI_API_BASE_URL: PURLS.openaiUrl,
    ANTHROPIC_API_KEY: PROVIDER_KEYS.anthropic, ANTHROPIC_API_BASE_URL: PURLS.anthropicUrl,
    DYNAMIC_GAMMA_POLL_MS: '200',
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
async function startApp(extraEnv = {}, label = 'app-v3') {
  const ch = spawnProc(label, 'main.js', { ...baseEnv(), ...extraEnv, PORT: String(APP_PORT) });
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
  { key: 'E1', title: '[E2E V2.1 E1] Hidráulica de planta', theme: { themeFamily: 'aula-clara', mode: 'light' }, passing: 70, finalExam: true, engine: 'h5p', examBank: true, modules: [
    { title: 'Fundamentos del circuito', objective: 'Comprender presión y caudal', exam: true, chapters: [
      { title: 'Presión y caudal en planta', v: true, a: true, h5p: 'questionset' },
      { title: 'Fluidos y contaminación del aceite', v: false, a: true, h5p: 'dragtext' },
    ] },
    { title: 'Componentes de potencia', objective: 'Seleccionar bombas y actuadores', exam: false, chapters: [
      { title: 'Bombas de engranajes y paletas', v: true, a: false },
      { title: 'Cilindros de doble efecto', v: false, a: false },
    ] },
  ] },
  { key: 'E2', title: '[E2E V2.1 E2] Mantenimiento predictivo', theme: { themeFamily: 'oscuro-premium', mode: 'dark' }, passing: 60, finalExam: false, engine: 'scorm', examBank: false, modules: [
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
  { key: 'E3', title: '[E2E V2.1 E3] Válvulas y control', theme: { themeFamily: 'tecnico', mode: 'dark' }, passing: 80, finalExam: true, engine: 'h5p', examBank: true, modules: [
    { title: 'Válvulas direccionales', objective: 'Leer esquemas de válvulas', exam: true, chapters: [
      { title: 'Esquemas de centros de válvula', v: true, a: true, h5p: 'blanks' },
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
async function waitRunTerminal(ctl, label, timeoutMs = 15 * 60 * 1000, runId = null) {
  const t0 = Date.now();
  let lastDb = 0;
  while (Date.now() - t0 < timeoutMs) {
    if (['completed', 'preview', 'failed', 'cancelled', 'fatal', 'stopped'].includes(ctl.state.status)) return ctl.state;
    // EV6 DoD (BE-A): `preview` es terminal en el backend; un ejecutor del navegador anterior a la DoD no
    // lo conoce y seguiría consultando → se lee el estado del run y se detiene al ejecutor (solo la prueba).
    if (runId && Date.now() - lastDb > 2000) {
      lastDb = Date.now();
      const [r] = await q(`select worker_status from public.production_jobs where id = $1`, [runId]);
      if (r && r.worker_status === 'preview') {
        ctl.stop();
        return { ...ctl.state, status: 'preview', stoppedByHarness: true };
      }
    }
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
  // Fase 3: contexto académico guardado ANTES de crear los capítulos (los vínculos solo apuntan a un contexto guardado).
  if (C.academic) {
    const pa = await api('POST', `/courses/${courseId}/profiles/academic`, { data: C.academic, expectedVersion: 0 });
    ok(pa.status === 201, `${C.key}: POST profiles/academic → 201`, { s: pa.status, e: pa.error });
  }
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
      // EV6 H5P v2: `cs.objective` explícito (p. ej. «Decidir…» → Branching Scenario con rules 2).
      const body = { title: cs.title, objective: cs.objective || `Aplicar ${cs.title.toLowerCase()}`, videoEnabled: cs.v, activityEnabled: cs.a, expectedCounter: counter };
      // Fase 2: capítulo de práctica y Actividad de Aplicación (minutos) cuando el escenario los pide.
      if (cs.kind) body.kind = cs.kind;
      if (cs.app) body.applicationMinutes = cs.app;
      // Fase 3: descripción y vínculos a resultados del contexto académico.
      if (cs.description) body.description = cs.description;
      if (cs.outcomeIds) body.outcomeIds = cs.outcomeIds;
      const isAuto = i === 0 && auto.length === 1;
      const r = isAuto
        ? await api('PATCH', `/courses/${courseId}/modules/${mid}/chapters/${auto[0].id}`, body)
        : await api('POST', `/courses/${courseId}/modules/${mid}/chapters`, body);
      if (![200, 201].includes(r.status)) throw new Error(`capítulo "${cs.title}": ${r.status} ${r.error}`);
      counter = r.data.structureVersionCounter;
      // R13 fix round 1 (I5): cobertura DETERMINÍSTICA de los 3 tipos H5P calificables. El tipo sale
      // del UUID del capítulo (R-012, FNV-1a); si no coincide con el pedido, se crea el capítulo de
      // nuevo (UUID nuevo) y se borra el anterior, hasta que la rotación dé el tipo pedido.
      if (cs.h5p) {
        let curId = isAuto ? auto[0].id : r.data.chapter.id;
        for (let tries = 0; SHELL_TYPES.activityTypeForChapter(curId) !== cs.h5p; tries++) {
          if (tries > 60) throw new Error(`no se obtuvo un UUID con tipo ${cs.h5p} para "${cs.title}"`);
          const nw = await api('POST', `/courses/${courseId}/modules/${mid}/chapters`, { ...body, expectedCounter: counter });
          if (nw.status !== 201) throw new Error(`recrear capítulo: ${nw.status} ${nw.error}`);
          counter = nw.data.structureVersionCounter;
          const del = await api('DELETE', `/courses/${courseId}/modules/${mid}/chapters/${curId}`, { expectedCounter: counter });
          if (del.status !== 200) throw new Error(`borrar capítulo: ${del.status} ${del.error}`);
          counter = del.data.structureVersionCounter;
          curId = nw.data.chapter.id;
        }
      }
    }
  }
  st = await readStructure(courseId);
  const mods = st.modules.map((m) => ({ id: m.id, title: m.title, exam: m.examEnabled, chapters: m.chapters.map((x) => ({ id: x.id, title: x.title, v: !!x.videoEnabled, a: x.activityEnabled !== false, kind: x.kind || 'content', app: x.applicationMinutes ?? null })) }));
  eq(mods.map((m) => m.chapters.map((x) => `${x.kind}/${x.app}`)), C.modules.map((m) => m.chapters.map((x) => `${x.kind || 'content'}/${x.app || null}`)), `${C.key}: tipo de capítulo y minutos de Actividad de Aplicación persistidos`);
  eq(mods.map((m) => m.chapters.map((x) => `${x.v ? 'V+' : 'V-'}${x.a ? 'A+' : 'A-'}`)), C.modules.map((m) => m.chapters.map((x) => `${x.v ? 'V+' : 'V-'}${x.a ? 'A+' : 'A-'}`)), `${C.key}: estructura viva con las combinaciones V/A pedidas`);
  // Perfiles (append-only, fuera del Blueprint): evaluación y presentación.
  const A = D('modules/course-profiles/course-profiles.js');
  const assessment = { ...A.defaultAssessmentProfile({ finalExam: C.finalExam }), passingGrade: C.passing };
  const pa = await api('POST', `/courses/${courseId}/profiles/assessment`, { data: assessment });
  ok(pa.status === 201, `${C.key}: POST profiles/assessment (passingGrade ${C.passing}) → 201`, { s: pa.status, e: pa.error });
  const pp = await api('POST', `/courses/${courseId}/profiles/presentation`, { data: { ...C.theme, brandSeed: null, themeVersion: 1 } });
  ok(pp.status === 201, `${C.key}: POST profiles/presentation (${C.theme.themeFamily}/${C.theme.mode}) → 201`, { s: pp.status, e: pp.error });
  // Motor pedagógico V1 (E6): perfil pedagógico ANTES del lock (el lock lo congela en el Blueprint).
  if (C.pedagogy) {
    const pg = await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: C.pedagogy, expectedVersion: 0 });
    ok(pg.status === 201 && pg.data.profile.designRules && pg.data.profile.designRules.engineVersion === 1, `${C.key}: POST profiles/pedagogy (${C.pedagogy.primaryApproach}) → 201 con reglas del servidor`, { s: pg.status, e: pg.error });
  }
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
  const contentChapters = chapters.filter((x) => x.kind !== 'practice').length;
  eq([M.totals.videoCount, M.totals.activityCount, M.totals.examCount, M.totals.finalExamCount, M.totals.presentationCount, M.totals.audiobookChapterCount, M.totals.experienceCount],
    [want.videos, want.activities, want.exams, C.finalExam ? 1 : 0, contentChapters, contentChapters, chapters.length], `${C.key}: totales del Manifest v3 (video/actividad/examen/final/Gamma/audiolibro/experiencia)`);
  eq(M.totals.applicationActivityCount ?? 0, chapters.filter((x) => x.app).length, `${C.key}: totales del Manifest v3 (Actividades de Aplicación)`);
  ok(M.items.filter((i) => i.type === 'activity').every((i) => i.variant === C.engine), `${C.key}: actividades con variant ${C.engine}`);
  // mapas del LLM falso (títulos → UUID)
  llm.st.courseId = courseId;
  llm.st.chapterByTitle.clear(); llm.st.moduleByTitle.clear(); llm.st.moduleOfChapter.clear();
  for (const m of mods) { llm.st.moduleByTitle.set(m.title, m.id); for (const x of m.chapters) { llm.st.chapterByTitle.set(x.title, x.id); llm.st.moduleOfChapter.set(x.id, m.id); } }
  return { courseId, frontendCourseId: fc, n, manifest, mods, assessment };
}

// P2-B6: evaluaciones dentro del .mbz (lector del validador B5): banco ⇒ todos los slots aleatorios,
// GIFT ⇒ todos fijos; una página «Respuestas explicadas» por quiz (con las explicaciones del banco);
// la nota para docentes EXACTAMENTE una vez; y examChecksV3 (QUIZ_RANDOM / EXPLANATIONS_GATE /
// ANSWER_LEAK) sin issues.
async function assertExamPackage(label, buf, bank) {
  const EV = D('package/v3/exam-validator-v3.js');
  const EXPL = D('modules/course-shell/exam-explanations.js');
  const pkg = await EV.readExamPackageV3(await JSZip.loadAsync(buf));
  const quizzes = pkg.acts.filter((a) => a.modname === 'quiz');
  const slots = quizzes.map((q) => ({ idnumber: q.idnumber, random: (q.actXml.match(/<question_set_reference\b/g) || []).length, fixed: (q.actXml.match(/<question_reference\b/g) || []).length }));
  ok(quizzes.length > 0 && slots.every((x) => (bank ? x.random > 0 && x.fixed === 0 : x.fixed > 0 && x.random === 0)),
    `${label}: ${quizzes.length} quiz(zes) con slots ${bank ? 'ALEATORIOS por hoja del banco (question_set_reference)' : 'FIJOS (GIFT)'}: ${slots.map((x) => `${x.idnumber} ${bank ? x.random : x.fixed}`).join(', ')}`, slots);
  const pageOf = (q) => pkg.acts.find((a) => a.modname === 'page' && a.idnumber === EV.explanationsIdnumberFor(q.idnumber));
  const badPages = quizzes.filter((q) => { const pg = pageOf(q); return !pg || !pg.content.trim() || (bank && !/Antes de intervenir se mide y se compara/.test(pg.content)); }).map((q) => q.idnumber);
  ok(badPages.length === 0, `${label}: una página «Respuestas explicadas» por quiz${bank ? ' con las explicaciones del banco' : ''}`, badPages);
  const plain = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const note = pkg.acts.filter((a) => a.modname === 'label' && plain(a.intro).includes(EXPL.EXAMS_TEACHER_NOTE_ATTEMPTS)).map((a) => a.idnumber);
  ok(note.length === 1 && /^cv3:shell:(certificate_teacher|exams_teacher)$/.test(note[0]), `${label}: nota para docentes de «Respuestas explicadas» exactamente una vez (${note.join(', ')})`, note);
  const issues = EV.examChecksV3(pkg);
  eq(issues, [], `${label}: examChecksV3 (QUIZ_RANDOM / EXPLANATIONS_GATE / ANSWER_LEAK) sin issues`);
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
  return q(`select id, corrects_event_id, event_kind, cost_source, provider, operation, amount::float8 amount, billing_account, course_id, run_id, item_key, item_type, measurement_status,
                  coalesce((metadata->>'reservation') = 'true', false) as reservation
             from public.generation_cost_events where ${where}`, params);
}

// Calibración #2: cada llamada pagada deja una RESERVA (CHARGE pending) que se liquida a 0 con un ADJUSTMENT
// en la misma transacción que su cargo final. Filas de reservas y de sus liquidaciones (netean 0).
function reservationBookkeeping(ev) {
  const resIds = new Set(ev.filter((e) => e.reservation).map((e) => e.id));
  return ev.filter((e) => e.reservation || resIds.has(e.corrects_event_id));
}

// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  fs.writeFileSync(NET_LOG, '');
  db = new Client({ host: '127.0.0.1', port: PGPORT, user: 'postgres', database: 'v2db' });
  await db.connect();
  FAKES = await startFakes({ tlsDir: process.env.TLS_DIR, videogenKey: VIDEOGEN_KEY });
  {
    const SMM = D('package/v3/synthetic-media.js');
    PFAKES = startProviderFakes({ gammaKey: PROVIDER_KEYS.gamma, openaiKey: PROVIDER_KEYS.openai, anthropicKey: PROVIDER_KEYS.anthropic, makePdf: SMM.syntheticPdf, makeMp3: SMM.syntheticMp3 });
    PURLS = await PFAKES.listen();
  }
  const g = FAKES.google;
  g.fixedVideoId = YT_ID;
  const frontNet = [];
  let app, itemWorker, providerWorker, pkgWorker;
  const S = {};
  const llmBase = createLlm({ getFixtures: () => S.front.SV2_PREVIEW_FIXTURES, getSplit: (n) => S.front.dynExamQuestionSplit(n) });
  // P2-B6: el fake de bancos valida cada respuesta con validateExamBank de B2 (dist) antes de devolverla.
  const EXAM_BANK = D('modules/course-shell/exam-bank.js');
  const llm = createLlmV3({ base: llmBase, examBankContract: EXAM_BANK, h5p2: H5P2 });
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
      eq(f.data, { dynamicCourseStructure: true, realVideo: true, coherenceLlm: false, manifestRulesVersion: 3, dodContract: true, superAdmin: true }, 'GET /features → rulesVersion 3 activo (+ contrato DoD; el owner del sandbox es SUPER_ADMIN)');
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

    for (const C of (ONLY_REAL_PROVIDERS ? [] : COURSES)) {
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
        // P2-B6: override SOLO de la prueba (el `var` de 45 ya se evaluó en el vm; el ejecutor lo lee en cada item).
        S.front.DYN_EXAM_BANK_MODE_ENABLED = C.examBank === true;
        const t0 = Date.now();
        const ctl = S.front.dynExecutorStart({ courseId: c.courseId, blueprintNumber: c.n, runId: c.runId });
        const stt = await waitRunTerminal(ctl, `${C.key} run`, undefined, c.runId);
        const items = await waitItemsDone(c.runId);
        results.timings[`${C.key}-run`] = Date.now() - t0;
        // EV6 DoD: Gamma/TTS congelados en mock → el run termina `preview` (nunca `completed`).
        ok(stt.status === 'preview' && stt.rulesVersion === 3, `${C.key}: ejecutor del navegador terminó (rulesVersion 3) con el run en vista previa`, stt);
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
          // V2.1 F2 (I2): la duración final sale del mvhd del MP4 que se subió (fuente primaria).
          ok(os.durationSec === 468 && os.durationSource === 'mp4_mvhd' && os.mp4Duration && os.mp4Duration.durationSource === 'mp4_mvhd', `${C.key}: video ${v.chapter_id.slice(0, 8)}: duración medida del mvhd del MP4 subido (468 s, mp4_mvhd)`, { d: os.durationSec, s: os.durationSource, m: os.mp4Duration });
        }
        const run = await api('GET', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs/${c.runId}`);
        // EV6 DoD (BE-A): todos los items completados pero Gamma/TTS de vista previa → `preview`, nunca «Curso listo».
        const cpl = run.data && run.data.completion;
        ok(run.data && run.data.status === 'preview' && cpl && cpl.state === 'preview' && cpl.complete === false && cpl.generationComplete === false,
          `${C.key}: GET run → preview (completion.state preview, complete false)`, run.data && { status: run.data.status, completion: cpl });
        const provKeys = c.manifest.manifest.items.filter((i) => ['presentation', 'audio_welcome', 'audiobook_chapter'].includes(i.type)).map((i) => i.key).sort();
        eq([...(cpl ? cpl.previewComponents : [])].sort(), provKeys, `${C.key}: componentes de vista previa = los ${provKeys.length} items de Gamma/TTS (los videos son reales)`);
        c.items = items;
        c.artifacts = await artifactsOfRun(c.runId);
        // P2-B6: exam/final_exam → banco (E1, E3) o GIFT (E2): exactamente un artifact del tipo esperado por item.
        {
          const examItems = [...byType('exam'), ...byType('final_exam')];
          const wantType = C.examBank ? 'dynamic_exam_bank_json' : 'dynamic_exam_gift';
          const badExam = examItems.filter((i) => {
            const t = c.artifacts.filter((a) => a.item_key === i.item_key && a.status !== 'disabled' && /^dynamic_exam_(bank_json|gift)$/.test(a.type)).map((a) => a.type);
            return !(t.length === 1 && t[0] === wantType);
          }).map((i) => [i.item_key, c.artifacts.filter((a) => a.item_key === i.item_key).map((a) => a.type)]);
          ok(examItems.length > 0 && badExam.length === 0, `${C.key}: ${examItems.length} evaluaciones generadas como ${wantType}${C.examBank ? ' (modo banco, override de la prueba)' : ' (GIFT, modo banco apagado)'}`, badExam);
          if (C.examBank) {
            const badSum = examItems.filter((i) => {
              const os = i.output_summary || {};
              return !(os.evidenceChecked === true && os.bankSize >= os.slots && os.slots > 0 && os.correctLongestShare <= 0.3 && Array.isArray(os.perLeaf) && os.perLeaf.every((l) => l.kept >= l.floor));
            }).map((i) => [i.item_key, i.output_summary]);
            ok(badSum.length === 0, `${C.key}: resumen de cada banco (evidencia verificada, hojas ≥ piso, «correcta = la más larga» ≤ 30 %): ${examItems.map((i) => `${i.type} ${(i.output_summary || {}).bankSize}/${(i.output_summary || {}).slots}`).join(', ')}`, badSum);
            c.examBankSummaries = examItems.map((i) => ({ itemKey: i.item_key, type: i.type, ...(i.output_summary || {}) }));
          }
        }
        const mockArts = c.artifacts.filter((a) => ['dynamic_presentation', 'dynamic_audio_mp3'].includes(a.type));
        ok(mockArts.length === byType('presentation').length + byType('audio_welcome').length + byType('audiobook_chapter').length && mockArts.every((a) => a.metadata && (a.metadata.mock === true || a.metadata.fixture === true)),
          `${C.key}: artifacts de Gamma/TTS marcados mock (${mockArts.length})`, mockArts.map((a) => [a.item_key, a.metadata]));
        results.courses[C.key] = { courseId: c.courseId, frontendCourseId: c.frontendCourseId, blueprintNumber: c.n, runId: c.runId, items: items.length, spec: C,
          modules: c.mods, manifestItems: c.manifest.manifest.items.map((i) => ({ key: i.key, type: i.type, variant: i.variant || null })), manifestModules: c.manifest.manifest.modules,
          features: c.manifest.manifest.features, assessment: c.assessment, examBank: C.examBank === true, examBankSummaries: c.examBankSummaries || [] };
      });

      await step(`v3-${C.key}-empaquetado`, async () => {
        const c = S[C.key];
        const P = await packageRun(C.key, c.courseId, c.n, c.runId);
        const os = P.job.output_summary || {};
        // EV6 DoD (BE-A): run de vista previa → paquete de QA (SUPER_ADMIN + escape del sandbox), rotulado y NO entregable.
        ok(os.packageKind === 'qa_preview' && os.deliverable === false && P.status.packageKind === 'qa_preview' && P.status.deliverable === false &&
          P.status.complete === false && /^QA-VISTA-PREVIA-/.test(String(P.status.downloadFilename || '')),
          `${C.key}: paquete QA (qa_preview, deliverable false, complete false, QA-VISTA-PREVIA-…)`, { kind: os.packageKind, st: P.status });
        {
          const zq = await JSZip.loadAsync(P.buf);
          const courseXml = await zq.file('course/course.xml').async('string');
          ok(/<fullname>[^<]*\[QA — vista previa, no entregable\]<\/fullname>/.test(courseXml), `${C.key}: el nombre del curso lleva «[QA — vista previa, no entregable]»`);
          const lbls = await Promise.all(Object.keys(zq.files).filter((f) => /activities\/label_\d+\/label\.xml$/.test(f)).map((f) => zq.file(f).async('string')));
          ok(lbls.some((x) => /QA — vista previa, no entregable/.test(x) && /no es el curso final/.test(x)), `${C.key}: aviso visible «QA — vista previa, no entregable» en la bienvenida`);
        }
        const runDto = await api('GET', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs/${c.runId}`);
        ok(runDto.data && runDto.data.completion && runDto.data.completion.packageReady === false && runDto.data.completion.state === 'preview',
          `${C.key}: con el paquete QA el run sigue en vista previa (packageReady false)`, runDto.data && runDto.data.completion);
        const TE = D('modules/theme-engine/index.js');
        const wantTheme = TE.themeSha256(TE.resolveTheme({ ...C.theme, themeVersion: 1 }));
        const BV = D('package/dynamic-mbz-builder-v3.js').DYNAMIC_MBZ_BUILDER_VERSION_V3;
        ok(os.builderVersion === BV && os.rulesVersion === 3 && os.themeSource === 'profile' && os.themeSha256 === wantTheme, `${C.key}: builder ${BV}, tema del perfil ${C.theme.themeFamily}/${C.theme.mode} (themeSha256 = resolveTheme del perfil)`, { b: os.builderVersion, src: os.themeSource, t: os.themeSha256, want: wantTheme });
        // EV6 T3: sin evaluación final no hay certificado y el worker lo avisa con EXACTAMENTE
        // certificate_omitted:no_final_exam (intencional); con evaluación final ese aviso no existe.
        const certOmitted = (w) => w && w.code === 'certificate_omitted' && w.detail === 'certificate_omitted:no_final_exam';
        // r19 L: la DB del E2E no tiene la tabla `user_settings` (la gestiona Supabase), así que el paquete avisa
        // libro_logo_source_unavailable:user_settings y usa el logo de Cursia; es el único aviso tolerado.
        eq((os.warnings || []).filter((w) => !/mock/i.test(JSON.stringify(w)) && !(!C.finalExam && certOmitted(w)) && !/^libro_logo_source_unavailable:user_settings$/.test(String(w.detail || w.code || ''))), [], `${C.key}: 0 warnings del worker (salvo los avisos de fixtures mock de Gamma/TTS${C.finalExam ? '' : ' y certificate_omitted:no_final_exam'})`);
        eq((os.warnings || []).filter(certOmitted).length, C.finalExam ? 0 : 1, `${C.key}: aviso certificate_omitted:no_final_exam ${C.finalExam ? 'ausente (hay evaluación final)' : 'presente (sin evaluación final)'}`);
        results.courses[C.key].packageSummary = os;
        await assertExamPackage(C.key, P.buf, C.examBank === true);
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
          // M7: los ids de origen del resumen existen como artifacts ready del run, y los blobs de
          // contenido (MP3, PDF, PNG de portada) son byte-idénticos entre los dos paquetes.
          const runArts = await artifactsOfRun(c.runId);
          const runIds = new Set(runArts.map((a) => a.id));
          ok(os.sourceArtifactIds.length > 0 && os.sourceArtifactIds.every((id) => runIds.has(id)) && runArts.filter((a) => os.sourceArtifactIds.includes(a.id)).every((a) => a.status === 'ready'),
            `E1-repack: los ${os.sourceArtifactIds.length} sourceArtifactIds son artifacts ready de ESTE run (cruce con la DB)`);
          const blobs = async (z) => {
            const fx = await z.file('files.xml').async('string');
            const m = {};
            for (const f of fx.match(/<file id="\d+">[\s\S]*?<\/file>/g) || []) {
              // EV6 T3: la imagen de la insignia-certificado depende del TEMA (acento): se compara aparte.
              if (/<component>badges<\/component>/.test(f)) continue;
              const fnm = (/<filename>([^<]*)<\/filename>/.exec(f) || [])[1] || '';
              // r19 L: el Libro Guía es un PDF que sigue el acento del TEMA → se compara aparte (cambia con el tema).
              if (/^libro_guia_.*\.pdf$/.test(fnm)) { (m.libro = m.libro || new Set()).add(/<contenthash>(\w+)<\/contenthash>/.exec(f)[1]); continue; }
              const ext = (/\.(mp3|pdf|png|h5p|html)$/.exec(fnm) || [])[1];
              if (ext) (m[ext] = m[ext] || new Set()).add(/<contenthash>(\w+)<\/contenthash>/.exec(f)[1]);
            }
            return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v].sort()]));
          };
          const b1 = await blobs(z1); const b2 = await blobs(z2);
          eq([b2.mp3, b2.pdf, b2.png], [b1.mp3, b1.pdf, b1.png], `E1-repack: MP3 (${(b1.mp3 || []).length}), PDF de Gamma (${(b1.pdf || []).length}) y PNG (${(b1.png || []).length}) byte-idénticos entre E1 y E1-repack`);
          ok((b1.libro || []).length === 1 && (b2.libro || []).length === 1 && b1.libro[0] !== b2.libro[0], 'E1-repack: un Libro Guía PDF en cada paquete, regenerado con el tema nuevo', [b1.libro, b2.libro]);
          // EV6 T3: la imagen de la insignia es función SOLO del tema: cambia con el tema nuevo y es
          // exactamente la que renderiza ese tema (mismos bytes que courseBadgeImages(resolveTheme(perfil nuevo))).
          const badgeBlobs = async (z) => {
            const fx = await z.file('files.xml').async('string');
            return Object.fromEntries((fx.match(/<file id="\d+">[\s\S]*?<\/file>/g) || []).filter((f) => /<component>badges<\/component>/.test(f))
              .map((f) => [(/<filename>([^<]*)<\/filename>/.exec(f) || [])[1], /<contenthash>(\w+)<\/contenthash>/.exec(f)[1]]));
          };
          const g1 = await badgeBlobs(z1); const g2 = await badgeBlobs(z2);
          const BADGE = D('package/v3/course-badge.js');
          const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
          const wantBadge = Object.fromEntries(BADGE.courseBadgeImages(TE.resolveTheme({ themeFamily: 'tecnico', mode: 'dark', themeVersion: 1 })).map((x) => [x.filename, sha1(x.png)]));
          eq(Object.keys(g1).sort(), ['f1.png', 'f2.png', 'f3.png'], 'E1: imagen de la insignia-certificado (f1/f2/f3)');
          eq(g2, wantBadge, 'E1-repack: imagen de la insignia = render determinístico del tema nuevo (tecnico/dark)');
          ok(['f1.png', 'f2.png', 'f3.png'].every((n) => g1[n] && g1[n] !== g2[n]), 'E1-repack: la imagen de la insignia cambia con el tema (y solo ella entre los PNG)', { g1, g2 });
          ok((b1.h5p || []).length > 0 && (b1.h5p || []).length === (b2.h5p || []).length, `E1-repack: misma cantidad de paquetes .h5p (${(b1.h5p || []).length}); cambian solo por passPercentage/tema`);
          await assertExamPackage('E1-repack', P.buf, true);
          results.courses.E1repack = { ...results.courses.E1, theme: { themeFamily: 'tecnico', mode: 'dark' }, passing: 80, packageSummary: os };
        });
      }
    }

    if (!ONLY_REAL_PROVIDERS) await step('v3-finops', async () => {
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
      const book = reservationBookkeeping(ev);
      const bookIds = new Set(book.map((e) => e.id));
      const resv = book.filter((e) => e.reservation);
      ok(resv.every((r) => book.some((a) => a.corrects_event_id === r.id)) && Math.abs(book.reduce((a, e) => a + e.amount, 0)) < 1e-9,
        'ledger v3 (calibración #2): toda reserva previa a una llamada pagada quedó liquidada (neto 0)', resv);
      const vg = ev.filter((e) => e.provider === 'videogen' && !bookIds.has(e.id) && e.event_kind === 'CHARGE');
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
      // R13 fix round 1 (I1): conteos MEDIDOS por proveedor. netguard registra cada conexión saliente
      // fuera de 127.0.0.1 de la app y de los 3 workers (host + proceso); el navegador simulado registra
      // cada fetch fuera de 127.0.0.1 / /api/proxy. Se clasifican por host de proveedor pagado.
      const ng = PV.countNetguardLog(NET_LOG);
      const fn = PV.countUrls(frontNet);
      const attempts = PV.emptyCounts();
      for (const k of PV.PROVIDERS) attempts[k] = ng.byProvider[k] + fn.byProvider[k];
      results.frontNet = frontNet.slice();
      results.counters = {
        scope: 'fase v3: app Nest + dynamic-item/provider/package-worker (netguard) + ejecutor del navegador (vm)',
        realAttemptsByProvider: attempts,
        netguardBlockedTotal: ng.total,
        netguardOtherHosts: ng.otherHosts,
        frontBlockedTotal: fn.total,
        fakeReached: {
          anthropic_via_api_proxy_fake: llm.st.calls.length,
          videogen_fake_submissions: FAKES.videogen.submissions.length,
          google_fake_calls: g.calls.length,
          google_fake_uploads: g.uploads.length,
          gamma_mock_ledger: ev.filter((e) => e.provider === 'gamma' && e.cost_source === 'MOCK').length,
          tts_mock_ledger: ev.filter((e) => e.provider === 'openai' && e.cost_source === 'MOCK').length,
        },
        fakeLlmInvalidFirst: llm.st.invalidSent,
        fakeLlmRetriesSeen: llm.st.retriesSeen,
      };
      eq(attempts, PV.emptyCounts(), `intentos REALES medidos por proveedor (netguard + navegador simulado): ${JSON.stringify(attempts)}`);
      ok(ev.filter((e) => ['gamma', 'openai'].includes(e.provider)).every((e) => e.cost_source === 'MOCK'), 'Gamma/TTS: todos los eventos del ledger son MOCK (ningún cliente real resuelto)');
      const pwLog = fs.readFileSync(providerWorker.logFile, 'utf8');
      ok(!/PROVIDER_NOT_WIRED_V21|provider_mock_not_allowed|PROVIDER_MODE_UNSET/.test(pwLog), 'dynamic-provider-worker: nunca tomó el camino real (sin PROVIDER_NOT_WIRED_V21 / modo no-mock en su log)');
      eq(FAKES.videogen.submissions.length, videoCount, `Videogen FALSO: ${videoCount} envíos (uno por video; ninguno en los 409 ni en el re-empaque)`);
      eq(g.uploads.length, videoCount, `Google FALSO: ${videoCount} subidas Unlisted`);
      // Cobertura determinística (I5): los 3 tipos H5P calificables aparecen en E1+E3.
      const types = [...new Set(['E1', 'E3'].flatMap((k) => results.courses[k].modules.flatMap((m) => m.chapters)).filter((x) => x.a).map((x) => SHELL_TYPES.activityTypeForChapter(x.id)))].sort();
      eq(types, ['blanks', 'dragtext', 'questionset'], 'E1+E3: los 3 tipos H5P calificables (questionset, dragtext, blanks) por la rotación del UUID');
      // Reintento dirigido: una respuesta inválida por tipo, una sola vez, y luego exactamente 1 reintento.
      // P2-B6: el examen final de E1/E3 es un banco; la falla del banco (exam_bank) produce UNA reparación.
      // La falla GIFT del examen final (final_exam → corrección) se comprueba en E4 (GIFT).
      const kinds = ['experience', 'course_intro', 'module_intro', 'video_interactions', 'h5p_questionset', 'h5p_dragtext', 'h5p_blanks', 'exam_bank'];
      eq(kinds.map((k) => llm.st.invalidSent[k] || 0), kinds.map(() => 1), `LLM falso: exactamente 1 respuesta inválida por cada uno de los ${kinds.length} tipos v3`);
      eq(kinds.map((k) => llm.st.retriesSeen[k] || 0), kinds.map(() => 1), 'cada respuesta inválida produjo EXACTAMENTE 1 reintento dirigido (validation_retry / continuation) y luego pasó');
      // P2-B6 (A2): bancos — falla inyectada una vez (más rechazos que la holgura de la hoja, BANKOPT),
      // EXACTAMENTE una reparación con lo que falta, y el item que la recibió la registra (rechazos
      // EVIDENCE + LENGTH_BIAS, 2 reparadas); ningún otro banco necesitó reparación.
      // BANKOPT (caché): todo prompt de banco llegó como [fuente+cache_control, tarea+cache_control, tail].
      const shapes = (llm.st.examBank && llm.st.examBank.blockShapes) || [];
      ok(shapes.length > 0 && shapes.every((x) => JSON.stringify(x) === JSON.stringify(['ephemeral', 'ephemeral', null])), `bancos: ${shapes.length} prompts con cache_control en fuente y tarea`, shapes.slice(0, 5));
      const bankCalls = llm.st.v3calls.filter((x) => /^(exam_bank|final_exam_bank|exam_bank_repair)$/.test(x.kind));
      const repairs = bankCalls.filter((x) => x.kind === 'exam_bank_repair');
      ok(repairs.length === 1 && (llm.st.examBank.faults || []).length === 1, `bancos: exam_bank_repair registrado UNA vez (${bankCalls.length} llamadas de banco al LLM falso, ${repairs.length} reparación)`, { repairs, faults: llm.st.examBank.faults });
      const bankSums = COURSES.filter((C) => C.examBank).flatMap((C) => (results.courses[C.key].examBankSummaries || []).map((x) => ({ course: C.key, ...x })));
      const repairedItems = bankSums.filter((x) => (x.repaired || 0) > 0 || ((x.calls || {}).continuation || 0) > 0);
      ok(repairedItems.length === 1 && repairedItems[0].repaired === 2 && repairedItems[0].calls.continuation === 1 && (repairedItems[0].rejectedByCode || {}).EXAM_BANK_EVIDENCE >= 1 && (repairedItems[0].rejectedByCode || {}).EXAM_BANK_LENGTH_BIAS >= 1,
        `bancos: la reparación quedó en UN solo item (${repairedItems.map((x) => `${x.course} ${x.itemKey}`).join(', ')}): rechazos EVIDENCE + LENGTH_BIAS, 2 preguntas reparadas en 1 llamada`, repairedItems);
      ok(bankSums.length === COURSES.filter((C) => C.examBank).reduce((n, C) => n + C.modules.filter((m) => m.exam).length + (C.finalExam ? 1 : 0), 0),
        `bancos: ${bankSums.length} evaluaciones como banco en E1/E3 (todas las de esos cursos)`, bankSums.map((x) => x.itemKey));
      results.counters.examBank = { calls: bankCalls.length, repairs: repairs.length, faults: llm.st.examBank.faults, items: bankSums.map((x) => ({ course: x.course, itemKey: x.itemKey, bankSize: x.bankSize, slots: x.slots, repaired: x.repaired, rejectedByCode: x.rejectedByCode, correctLongestShare: x.correctLongestShare })) };
    }, { fatal: false });

    // ═══ V2.1 F2: E4 — Gamma / TTS / guion LLM REALES contra fakes locales ═══
    await step('v3-E4-proveedores-reales', async () => {
      const C = { key: 'E4', title: '[E2E V2.1 E4] Seguridad hidráulica (proveedores reales/fakes)', theme: { themeFamily: 'tecnico', mode: 'dark' }, passing: 70, finalExam: true, engine: 'h5p', modules: [
        { title: 'Seguridad hidráulica', objective: 'Operar el circuito con seguridad', exam: true, chapters: [
          { title: 'Bloqueo y etiquetado', v: true, a: true },
          { title: 'Purgado de circuitos', v: false, a: false },
        ] }] };
      const c = await createCourse(C, llm);
      S.E4 = c;
      const body = { nombre: C.title, ...CTX, scormTemplateIds: S.templates, videoMode: 'real' }; // providerModes: default REAL
      const calls0 = { g: PFAKES.st.gammaPosts.length, t: PFAKES.st.tts.length, l: PFAKES.st.llm.length, v: FAKES.videogen.submissions.length };
      let start = await api('POST', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs`, body);
      const estM = /estimateId=([0-9a-f-]{36})/.exec(String(start.error || ''));
      ok(start.status === 409 && /^budget_approval_required/.test(String(start.error)) && !!estM, 'E4: Gamma/TTS/Videogen reales sin aprobación → 409 budget_approval_required (el preflight de proveedores pasó)', { s: start.status, e: start.error });
      eq([PFAKES.st.gammaPosts.length, PFAKES.st.tts.length, PFAKES.st.llm.length, FAKES.videogen.submissions.length], [calls0.g, calls0.t, calls0.l, calls0.v], 'E4: el 409 no llamó a ningún proveedor');
      await q(`insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, decision, approved_by, reason)
               values ($1, $2, 1000, 'ADMIN_APPROVED', 'e2e-admin@cursia.test', 'e2e v3 E4: aprobación (proveedores FALSOS locales)')`, [c.courseId, estM && estM[1]]);
      start = await api('POST', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs`, body);
      ok(start.status === 201 && start.data.run.videoDelivery === 'youtube', 'E4: run creado (201) tras ADMIN_APPROVED, entrega YouTube', { s: start.status, e: start.error });
      c.runId = start.data.run.id;
      const [job] = await q(`select input_payload from public.production_jobs where id = $1`, [c.runId]);
      eq([job.input_payload.providerModes.presentation, job.input_payload.providerModes.audio], ['real', 'real'], 'E4: providerModes REAL congelados');
      S.front.DYN_EXAM_BANK_MODE_ENABLED = false; // P2-B6: E4 cubre el camino GIFT (examen de módulo + final)
      const finalGift0 = { inv: llm.st.invalidSent.final_exam || 0, ret: llm.st.retriesSeen.final_exam || 0 };
      const ctl = S.front.dynExecutorStart({ courseId: c.courseId, blueprintNumber: c.n, runId: c.runId });
      const stt = await waitRunTerminal(ctl, 'E4 run', undefined, c.runId);
      const items = await waitItemsDone(c.runId);
      ok(stt.status === 'completed' && stt.failed === 0, 'E4: ejecutor del navegador terminó sin fallidos', stt);
      ok(items.length > 0 && items.every((i) => i.status === 'completed'), `E4: los ${items.length} items completed`, items.filter((i) => i.status !== 'completed').map((i) => [i.item_key, i.status, i.error_message && i.error_message.slice(0, 300)]));
      // P2-B6: GIFT en E4 — la respuesta inválida del examen final GIFT (una vez por corrida) y su corrección.
      eq([finalGift0.inv, finalGift0.ret, llm.st.invalidSent.final_exam || 0, llm.st.retriesSeen.final_exam || 0], [0, 0, 1, 1], 'E4: examen final GIFT — 1 respuesta inválida y EXACTAMENTE 1 corrección (continuation), luego pasó');
      const e4Arts = await artifactsOfRun(c.runId);
      const e4Exams = items.filter((i) => i.type === 'exam' || i.type === 'final_exam');
      ok(e4Exams.length === 2 && e4Exams.every((i) => e4Arts.filter((a) => a.item_key === i.item_key && a.status !== 'disabled' && /^dynamic_exam_/.test(a.type)).map((a) => a.type).join() === 'dynamic_exam_gift'), 'E4: examen de módulo y final como GIFT (modo banco apagado)', e4Exams.map((i) => [i.item_key, e4Arts.filter((a) => a.item_key === i.item_key).map((a) => a.type)]));
      const prov = items.filter((i) => ['presentation', 'audio_welcome', 'audiobook_chapter'].includes(i.type));
      ok(prov.length === 5 && prov.every((i) => i.worker_id === 'e2e-v3-provider-worker' && i.output_summary && i.output_summary.mode === 'real'), 'E4: Gamma/TTS por el dynamic-provider-worker en modo REAL', prov.map((i) => [i.item_key, i.worker_id, i.output_summary && i.output_summary.mode]));
      const arts = await artifactsOfRun(c.runId);
      const provArts = arts.filter((a) => ['dynamic_presentation', 'dynamic_audio_mp3'].includes(a.type));
      ok(provArts.length === 5 && provArts.every((a) => a.metadata && a.metadata.mode === 'real' && !a.metadata.mock && !a.metadata.fixture), 'E4: artifacts de Gamma/TTS reales (no mock)', provArts.map((a) => [a.item_key, a.metadata]));
      const newGamma = PFAKES.st.gammaPosts.slice(calls0.g);
      ok(newGamma.length === 2 && newGamma.every((b) => b.textOptions && b.textOptions.language === 'es-419' && b.themeId === 'e2e-theme-dark' && b.exportAs === 'pdf'),
        'E4: Gamma falso recibió 2 generaciones (una por capítulo) con es-419 y el themeId de tecnico/dark', newGamma.map((b) => [b.textOptions, b.themeId]));
      ok(PFAKES.st.llm.length - calls0.l >= 2, `E4: guion del audiolibro por el LLM server-side (fake Anthropic): ${PFAKES.st.llm.length - calls0.l} llamadas`);
      ok(PFAKES.st.tts.length - calls0.t >= 3, `E4: OpenAI TTS falso: ${PFAKES.st.tts.length - calls0.t} llamadas (bienvenida + 2 capítulos)`);
      eq(PFAKES.st.badAuth, [], 'E4: los fakes recibieron SU clave (0 rechazos)');
      const vid = items.find((i) => i.type === 'video');
      ok(vid && vid.output_summary.durationSource === 'mp4_mvhd' && vid.output_summary.durationSec === 468, 'E4: video con duración medida del mvhd (468 s)', vid && vid.output_summary);
      // EV6 DoD (BE-A): camino real — todo real y validado → `completed`; sin paquete = «packaging»; con él = completo.
      const runE4 = await api('GET', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs/${c.runId}`);
      const c4 = runE4.data && runE4.data.completion;
      // EV6 DoD (BE-B): al pasar a `completed` el servidor encola SOLO el paquete final (sin clic); según el
      // ritmo del worker de empaquetado el run se lee `packaging` (armándose) o ya `complete`.
      ok(runE4.data && runE4.data.status === 'completed' && c4 && ['packaging', 'complete'].includes(c4.state) && c4.generationComplete === true && c4.missingComponents.length === 0 && c4.previewComponents.length === 0,
        'E4: run completed, completion = packaging/complete (generación completa; paquete automático)', runE4.data && { status: runE4.data.status, completion: c4 });
      const autoJobs = await q(`select id, input_payload from public.production_jobs where execution_mode = 'dynamic_package' and input_payload->>'runId' = $1 order by created_at`, [c.runId]);
      ok(autoJobs.length === 1 && autoJobs[0].input_payload && autoJobs[0].input_payload.auto === true && !autoJobs[0].input_payload.packageKind,
        'E4: el servidor encoló UN paquete final automático (input_payload.auto, sin packageKind)', autoJobs);
      const P = await packageRun('E4', c.courseId, c.n, c.runId);
      ok(autoJobs[0] && P.job.id === autoJobs[0].id, 'E4: POST …/package (botón manual) reusa el job automático (idempotente, nunca un segundo build)', { auto: autoJobs[0] && autoJobs[0].id, manual: P.job.id });
      const os = P.job.output_summary || {};
      ok(!os.packageKind && P.status.packageKind === 'final' && P.status.deliverable === true && P.status.complete === true && !/^QA-/.test(String(P.status.downloadFilename || '')),
        'E4: paquete FINAL entregable (sin rótulo QA) y GET …/package complete:true', { kind: os.packageKind, st: P.status });
      {
        const z4 = await JSZip.loadAsync(P.buf);
        const cx = await z4.file('course/course.xml').async('string');
        ok(!/QA — vista previa/.test(cx), 'E4: el nombre del curso NO lleva el rótulo QA');
      }
      const runE4b = await api('GET', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs/${c.runId}`);
      const c4b = runE4b.data && runE4b.data.completion;
      ok(c4b && c4b.state === 'complete' && c4b.packageReady === true && c4b.complete === true, 'E4: con el paquete final el curso queda COMPLETO (completion.state complete)', c4b);
      eq((os.warnings || []).filter((w) => /mock/i.test(JSON.stringify(w))), [], 'E4: el empaque no usó ninguna fixture mock');
      ok(Array.isArray(os.mockPresentationChapters) ? os.mockPresentationChapters.length === 0 : true, 'E4: 0 capítulos con presentación mock', os.mockPresentationChapters);
      const z = await JSZip.loadAsync(P.buf);
      const fx = await z.file('files.xml').async('string');
      const names = [...fx.matchAll(/<filename>([^<]*)<\/filename>/g)].map((m) => m[1]);
      ok(names.some((n) => /\.pdf$/.test(n)) && names.some((n) => /\.png$/.test(n)) && names.some((n) => /\.mp3$/.test(n)), 'E4: el MBZ lleva el PDF, la portada PNG y los MP3 de los fakes', names.filter((n) => /\.(pdf|png|mp3)$/.test(n)));
      // Neto por CHARGE = monto + sus ADJUSTMENT (F2 fix round 1: Gamma reserva pendiente al aceptar y se liquida al terminar).
      const ev = await q(`select c.provider, c.operation, c.cost_source, c.measurement_status, c.external_operation_id, c.recorded_by, c.item_key,
                                 (c.amount + coalesce((select sum(a.amount) from public.generation_cost_events a where a.corrects_event_id = c.id), 0))::float8 amount
                            from public.generation_cost_events c where c.course_id = $1 and c.event_kind = 'CHARGE'
                             and coalesce(c.metadata->>'reservation', 'false') <> 'true'`, [c.courseId]);
      const resvE4 = await q(`select c.provider, (c.amount + coalesce((select sum(a.amount) from public.generation_cost_events a where a.corrects_event_id = c.id), 0))::float8 net,
                                     exists (select 1 from public.generation_cost_events a where a.corrects_event_id = c.id) settled
                                from public.generation_cost_events c where c.course_id = $1 and c.event_kind = 'CHARGE' and (c.metadata->>'reservation') = 'true'`, [c.courseId]);
      ok(resvE4.length >= 5 && resvE4.every((r) => r.settled && Math.abs(r.net) < 1e-9), 'E4 ledger (calibración #2): una reserva durable antes de CADA llamada pagada (Gamma / TTS / LLM / Videogen), toda liquidada a neto 0', resvE4);
      const g = ev.filter((e) => e.provider === 'gamma');
      ok(g.length === 2 && g.every((e) => e.cost_source === 'CALCULATED_FROM_USAGE' && Math.abs(e.amount - 0.42) < 1e-9 && /^gen_f2_/.test(e.external_operation_id)), 'E4 ledger: Gamma = reserva al aceptar liquidada a credits.deducted × catálogo (neto 0.42, CALCULATED_FROM_USAGE, id = generationId)', g);
      const t = ev.filter((e) => e.provider === 'openai');
      ok(t.length >= 3 && t.every((e) => e.cost_source === 'CALCULATED_FROM_USAGE' && e.amount > 0 && /^req_f2_/.test(e.external_operation_id)), 'E4 ledger: TTS medido por segundos de audio (CALCULATED_FROM_USAGE, id = x-request-id)', t);
      const l = ev.filter((e) => e.provider === 'anthropic' && e.recorded_by === 'dynamic-provider-worker');
      ok(l.length >= 2 && l.every((e) => e.operation === 'llm.audiobook_script' && e.cost_source === 'CALCULATED_FROM_USAGE' && /^msg_f2_/.test(e.external_operation_id)), 'E4 ledger: guion LLM server-side medido (llm.audiobook_script, id = msg_…)', l);
      ok(!ev.some((e) => e.cost_source === 'MOCK'), 'E4 ledger: ningún evento MOCK');
      const blocked = fs.readFileSync(NET_LOG, 'utf8').trim();
      ok(blocked === '', 'E4 netguard: 0 conexiones fuera de 127.0.0.1 (proveedores = fakes locales)', blocked.slice(0, 500));
      results.courses.E4 = { courseId: c.courseId, runId: c.runId, items: items.length, spec: C };
      results.counters.providerFakes = { gammaGenerations: PFAKES.st.gammaPosts.length, ttsCalls: PFAKES.st.tts.length, llmServerCalls: PFAKES.st.llm.length };
    }, { fatal: false });

    // ═══ EV6 H5P v2 (H4) — E5: rules 2 + «Repaso» + IV avanzado ═══
    const RUN_E5 = !ONLY_REAL_PROVIDERS && H5P2_MODE !== 'off' && (H5P2 || H5P2_MODE === 'require');
    if (!ONLY_REAL_PROVIDERS && !RUN_E5) {
      results.h5p2 = { skipped: true, reason: H5P2_MODE === 'off' ? 'E2E_H5P2=off' : `el frontend no trae ${path.relative(FE, H5P2_FIXTURE)} (H5P v2 del frontend H3)` };
      console.log(`\n(E5 H5P v2 omitido: ${results.h5p2.reason})`);
    }
    if (RUN_E5) await step('v3-E5-h5p2-generacion', async () => {
      ok(!!H5P2, `E5: fixtures H5P v2 del frontend presentes (${path.relative(FE, H5P2_FIXTURE)})`);
      if (!H5P2) throw new Error('E5 sin fixtures H5P v2 del frontend');
      // La app vuelve a arrancar con H5P v2 SOLO para E5 (el env se lee al crear el curso y su primer Manifest).
      await stopProc(app);
      app = await startApp({ DYNAMIC_ACTIVITY_TYPE_RULES: '2' }, 'app-v3-h5p2');
      const C = { key: 'E5', title: '[E2E EV6 E5] Decisiones de mantenimiento (H5P v2)', theme: { themeFamily: 'aula-clara', mode: 'light' }, passing: 70, finalExam: true, engine: 'h5p', examBank: false, modules: [
        { title: 'Decisiones en terreno', objective: 'Decidir intervenciones seguras', exam: true, chapters: [
          { title: 'Intervenir una pala con baja presión', v: true, a: true, objective: 'Decidir cómo intervenir una pala hidráulica con baja presión' },
          { title: 'Componentes del circuito', v: false, a: true, objective: 'Identificar los componentes del circuito hidráulico' },
        ] }] };
      const c = await createCourse(C, llm);
      S.E5 = c;
      const st0 = await readStructure(c.courseId);
      eq([st0.reviewCardsEnabled, st0.reviewCardsAvailable], [true, true], 'E5: curso NUEVO con H5P v2 → «Repaso» encendido y disponible (GET estructura)');
      const M = c.manifest.manifest;
      eq(M.features, { finalExam: true, activityEngine: 'h5p', activityTypeRules: 2, ivAdvanced: 1 }, 'E5: Manifest rules 2 (activityTypeRules 2 + ivAdvanced 1)');
      const decideCh = c.mods[0].chapters[0].id;
      const acts = M.items.filter((i) => i.type === 'activity');
      eq(acts.map((i) => [i.chapterId === decideCh, i.h5pType]), [[true, 'branchingscenario'], [false, 'blanks']], 'E5: «decidir» → branchingscenario; «identificar» → blanks (rules 2)');
      const ctx = { nombre: C.title, ...CTX, scormTemplateIds: S.templates };
      const body = { ...ctx, videoMode: 'real', providerModes: { presentation: 'mock', audio: 'mock' } };
      let start = await api('POST', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs`, body);
      const estM = /estimateId=([0-9a-f-]{36})/.exec(String(start.error || ''));
      ok(start.status === 409 && !!estM, 'E5: run con video real sin aprobación → 409 con estimateId', { s: start.status, e: start.error });
      await q(`insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, decision, approved_by, reason)
               values ($1, $2, 1000, 'ADMIN_APPROVED', 'e2e-admin@cursia.test', 'e2e EV6 E5: aprobación (Videogen FALSO local)')`, [c.courseId, estM && estM[1]]);
      start = await api('POST', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs`, body);
      ok(start.status === 201, 'E5: run creado (201)', { s: start.status, e: start.error });
      c.runId = start.data.run.id;
      llm.st.tag = 'E5';
      S.front.DYN_EXAM_BANK_MODE_ENABLED = false;
      const bs0 = { inv: llm.st.invalidSent.h5p_branchingscenario || 0, ret: llm.st.retriesSeen.h5p_branchingscenario || 0 };
      const ctl = S.front.dynExecutorStart({ courseId: c.courseId, blueprintNumber: c.n, runId: c.runId });
      const stt = await waitRunTerminal(ctl, 'E5 run');
      const items = await waitItemsDone(c.runId);
      // EV6 DoD: el sandbox genera videos de vista previa (mock) → el run termina en `preview`, nunca `completed`
      // (mismo criterio que E1–E3); el paquete que sigue es de QA (owner SUPER_ADMIN + escape del sandbox).
      ok(stt.status === 'preview' && stt.failed === 0 && !stt.fatalError, 'E5: ejecutor del navegador terminó sin fallidos (run en vista previa: videos mock)', stt);
      ok(items.every((i) => i.status === 'completed'), `E5: los ${items.length} items completed`, items.filter((i) => i.status !== 'completed').map((i) => [i.item_key, i.status, i.error_message && i.error_message.slice(0, 400)]));
      ok(llm.st.unknown.length === 0, 'E5: LLM falso sin prompts no reconocidos', llm.st.unknown);
      eq([bs0.inv, bs0.ret, llm.st.invalidSent.h5p_branchingscenario || 0, llm.st.retriesSeen.h5p_branchingscenario || 0], [0, 0, 1, 1], 'E5: caso ramificado — 1 respuesta inválida (BS_FORWARD_ONLY) y EXACTAMENTE 1 reintento dirigido, luego pasó');
      const arts = await artifactsOfRun(c.runId);
      const textOf = async (a) => { const r = await fetch(`${FAKES.storageUrl}/storage/v1/object/authenticated/${a.storage_bucket}/${a.storage_path}`); return r.ok ? r.text() : null; };
      const bsArt = arts.find((a) => a.item_key === `activity:${decideCh}` && a.type === 'dynamic_h5p_params_json' && a.status !== 'disabled');
      const bsDoc = bsArt ? JSON.parse((await textOf(bsArt)) || 'null') : null;
      ok(bsDoc && bsDoc.type === 'branchingscenario' && bsDoc.data.decisions.length === 3 && bsDoc.data.endings.length === 3, 'E5: artifact de la actividad = branchingscenario (3 decisiones, 3 finales)', bsDoc && { type: bsDoc.type });
      const viArt = arts.find((a) => a.item_key === `video_interactions:${decideCh}` && a.type === 'dynamic_video_interactions_json' && a.status !== 'disabled');
      const viDoc = viArt ? JSON.parse((await textOf(viArt)) || 'null') : null;
      ok(viDoc && viDoc.schemaVersion === 2 && Array.isArray(viDoc.reflections) && viDoc.reflections.length === 2, 'E5: video_interactions schemaVersion 2 con 2 reflexiones (video de 468 s)', viDoc && { v: viDoc.schemaVersion, r: viDoc.reflections && viDoc.reflections.length });
      const viItem = items.find((i) => i.item_key === `video_interactions:${decideCh}`);
      ok(viItem && viItem.output_summary && viItem.output_summary.reflectionCount === 2, 'E5: resumen del item video_interactions con reflectionCount 2 (validado contra la duración MEDIDA)', viItem && viItem.output_summary);
      results.courses.E5 = { courseId: c.courseId, frontendCourseId: c.frontendCourseId, blueprintNumber: c.n, runId: c.runId, items: items.length, spec: C,
        modules: c.mods, manifestItems: M.items.map((i) => ({ key: i.key, type: i.type, variant: i.variant || null, h5pType: i.h5pType || null })), manifestModules: M.modules,
        features: M.features, assessment: c.assessment, examBank: false, examBankSummaries: [], decideChapterId: decideCh, bsAnswers: H5P2.branchingScenario.valid };
    }, { fatal: false });
    if (RUN_E5 && S.E5 && S.E5.runId) await step('v3-E5-h5p2-empaquetado', async () => {
      const c = S.E5;
      const P = await packageRun('E5', c.courseId, c.n, c.runId);
      const os = P.job.output_summary || {};
      const libs = (os.h5pPackages || []).map((p) => p.mainLibrary);
      ok(libs.includes('H5P.BranchingScenario') && libs.filter((l) => l === 'H5P.Dialogcards').length === 2, 'E5: paquete con el Branching Scenario y un «Repaso» (Dialog Cards) por capítulo', libs);
      eq(P.status.restore && P.status.restore.as, 'admin_or_manager', 'E5: GET …/package devuelve la nota «restaurar como administrador o gestor»');
      results.courses.E5.packageSummary = os;
      results.courses.E5.reviewCardsChapterIds = (os.h5pPackages || []).filter((p) => /^review_cards:/.test(p.itemKey)).map((p) => p.itemKey.slice('review_cards:'.length));
      // El paquete BS lleva su delta de librerías (+ LICENSE.txt) y el IV v2 pausas + remediación.
      const z = await JSZip.loadAsync(P.buf);
      const pkgOf = async (mainLibrary, keyPrefix) => {
        const p = (os.h5pPackages || []).find((x) => x.mainLibrary === mainLibrary && (!keyPrefix || x.itemKey.startsWith(keyPrefix)));
        return p ? JSZip.loadAsync(await z.file(`files/${p.sha1.slice(0, 2)}/${p.sha1}`).async('nodebuffer')) : null;
      };
      const H = D('package/h5p/index.js');
      const bsz = await pkgOf('H5P.BranchingScenario');
      const tops = bsz ? [...new Set(Object.keys(bsz.files).filter((n) => !bsz.files[n].dir && n !== 'h5p.json' && !n.startsWith('content/')).map((n) => n.split('/')[0]))].sort() : [];
      eq(tops, H.profileDeltaDirs(H.CURSIA_H5P_PROFILE_V2, 'H5P.BranchingScenario'), 'E5: el .h5p del caso ramificado lleva EXACTAMENTE las 19 carpetas delta de librerías');
      ok(tops.length > 0 && tops.every((d) => bsz.file(`${d}/LICENSE.txt`)), 'E5: cada carpeta delta trae su aviso LICENSE.txt (MIT)');
      const ivz = await pkgOf('H5P.InteractiveVideo', `video:${c.mods[0].chapters[0].id}`);
      const iv = ivz ? JSON.parse(await ivz.file('content/content.json').async('string')) : null;
      const ints = iv ? iv.interactiveVideo.assets.interactions : [];
      const pauses = ints.filter((i) => i.action.library === 'H5P.Text 1.1');
      const qs = ints.filter((i) => i.action.library !== 'H5P.Text 1.1');
      ok(pauses.length === 2 && pauses.every((p) => p.pause === true && /Pausa para pensar:/.test(p.action.params.text)), 'E5: IV v2 con 2 pausas de reflexión (H5P.Text, pausan el video)', pauses.map((p) => p.duration));
      ok(qs.length > 0 && qs.every((x) => x.adaptivity && Number.isInteger(x.adaptivity.wrong.seekTo) && x.adaptivity.wrong.seekLabel === 'Volver a ver este tramo'), 'E5: cada pregunta del IV v2 con remediación (seekTo del plan, «Volver a ver este tramo»)', qs.map((x) => x.adaptivity));
      // Para browser-h5p2.js: tramos de las pausas y, por pregunta, una respuesta INCORRECTA (texto visible).
      const plain = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      results.courses.E5.iv = {
        chapterId: c.mods[0].chapters[0].id,
        pauses: pauses.map((p) => ({ from: p.duration.from, to: p.duration.to })),
        questions: qs.map((x) => {
          const pr = x.action.params;
          const wrongText = /^H5P\.TrueFalse /.test(x.action.library)
            ? (String(pr.correct) === 'true' ? 'Falso' : 'Verdadero')
            : plain(((pr.answers || []).find((a) => !a.correct) || {}).text);
          return { from: x.duration.from, to: x.duration.to, seekTo: x.adaptivity.wrong.seekTo, library: x.action.library, wrongText };
        }),
      };
    }, { fatal: false });

    // ═══ Motor pedagógico V1 — E6: perfil pedagógico → Blueprint → Manifest con diseño → run 100 % mock → empaque ═══
    // Prueba que los consumidores REALES (runs, scheduler, ejecutor del navegador, workers, empaque) toleran el
    // diseño pedagógico (`course.pedagogy`, `design`, h5pType elegido por el diseño). Sin gasto: todo mock/falso.
    if (RUN_E5) await step('v3-E6-pedagogia-generacion', async () => {
      const PED = D('modules/pedagogy/index.js');
      const MB = D('modules/generation-manifests/generation-manifest-builder.js');
      const pedagogy = {
        pedagogyProfileVersion: 1, primaryApproach: 'significativo', secondaryApproaches: ['experiencial'],
        learner: { description: 'Técnicos de mantenimiento nuevos', ageGroup: 'adults', educationLevel: 'technical', priorKnowledge: 'none', experience: 'none' },
        learningOutcomes: { know: ['Componentes del circuito hidráulico'], do: ['Verificar la presión'], competencies: [] },
        learningModes: ['concepts'], experienceTypes: ['teacher_guided'], assessmentMethods: ['quizzes'], principles: [], origin: 'manual',
      };
      const C = { key: 'E6', title: '[E2E Pedagogía E6] Circuitos hidráulicos (significativo)', theme: { themeFamily: 'aula-clara', mode: 'light' }, passing: 70, finalExam: true, engine: 'h5p', examBank: true, pedagogy, modules: [
        { title: 'Fundamentos del circuito', objective: 'Relacionar los componentes del circuito hidráulico', exam: true, chapters: [
          { title: 'Componentes y funciones', v: true, a: true, objective: 'Relacionar cada componente del circuito con su función' },
          { title: 'Presión y caudal', v: false, a: true, objective: 'Explicar la relación entre presión y caudal' },
        ] }] };
      const c = await createCourse(C, llm);
      S.E6 = c;
      const st6 = await readStructure(c.courseId);
      eq(st6.liveMatchesCurrentBlueprint, true, 'E6: con perfil pedagógico, la estructura queda «confirmada» (liveMatchesCurrentBlueprint true, review I1)');
      const bp = (await api('GET', `/courses/${c.courseId}/blueprints/${c.n}`)).data;
      const snap = bp && (bp.snapshot || (bp.blueprint && bp.blueprint.snapshot));
      ok(snap && snap.course.pedagogy && snap.course.pedagogy.approaches.map((a) => a.id).join('+') === 'significativo+experiencial', 'E6: Blueprint congela course.pedagogy (significativo + experiencial)', snap && snap.course.pedagogy);
      ok(snap && snap.modules.every((m) => m.design && m.chapters.every((x) => x.design && x.design.sequence.length > 5)), 'E6: design en cada módulo y capítulo del Blueprint');
      const M = c.manifest.manifest;
      ok(M.features.pedagogy && M.features.pedagogy.engineVersion === 1, 'E6: Manifest con features.pedagogy', M.features);
      eq(MB.validateGenerationManifestV3(M, PED.applyPedagogyToSnapshot(snap, PED.deriveDesignRules(pedagogy)), M.source), [], 'E6: el Manifest guardado valida contra el diseño recalculado del perfil');
      eq(bp && bp.sha256, M.source.blueprintSha256, 'E6: el Manifest apunta al Blueprint con diseño');
      const acts = M.items.filter((i) => i.type === 'activity');
      // significativo (0,6) + experiencial (0,4): tipos preferidos [arrastrar, preguntas, …]; «Explicar…» (objetivo) elige preguntas dentro del top-2.
      const prefs = snap.modules[0].chapters[0].design.activity.preferredTypes;
      eq(prefs.slice(0, 2), ['dragtext', 'questionset'], 'E6: tipos preferidos combinados (significativo + experiencial)');
      ok(acts.length === 2 && acts.every((i) => prefs.slice(0, 2).includes(i.h5pType) && i.design && i.design.intent === 'relate') && acts[0].h5pType === 'dragtext', 'E6: actividades con tipo y diseño del enfoque (intención relacionar; tipos del top-2 del diseño)', acts.map((i) => [i.h5pType, i.design]));
      ok(M.items.find((i) => i.type === 'video').design.style === 'concept_explainer', 'E6: video con estilo del enfoque (explicación de concepto)');
      ok(M.items.filter((i) => i.type === 'exam').every((i) => i.design.examStyle === 'conceptual_relations'), 'E6: examen de módulo con estilo del enfoque');
      // Fase 2: como E4, Videogen / Gamma / TTS / guion LLM por los workers REALES contra los fakes locales (el
      // diseño tiene que llegar a la configuración final de cada proveedor), con la aprobación de presupuesto del
      // sandbox. Ningún proveedor real: gasto 0.
      const ctx = { nombre: C.title, ...CTX, scormTemplateIds: S.templates };
      const body = { ...ctx, videoMode: 'real' }; // providerModes: default REAL (contra los fakes)
      const calls0 = { g: PFAKES.st.gammaPosts.length, v: FAKES.videogen.submissions.length };
      let start = await api('POST', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs`, body);
      const estM = /estimateId=([0-9a-f-]{36})/.exec(String(start.error || ''));
      ok(start.status === 409 && !!estM, 'E6: run con video (Videogen falso) sin aprobación → 409 con estimateId', { s: start.status, e: start.error });
      await q(`insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, decision, approved_by, reason)
               values ($1, $2, 1000, 'ADMIN_APPROVED', 'e2e-admin@cursia.test', 'e2e pedagogía E6: aprobación (Videogen FALSO local)')`, [c.courseId, estM && estM[1]]);
      start = await api('POST', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs`, body);
      ok(start.status === 201, 'E6: run creado (201)', { s: start.status, e: start.error });
      if (start.status !== 201) throw new Error(`E6: run no creado: ${start.status} ${start.error}`);
      c.runId = start.data.run.id;
      llm.st.tag = 'E6';
      // Fase 2 (review M6): E6 corre el banco de preguntas (el camino por defecto en producción): el diseño tiene que
      // llegar a cada parte del banco (task con caché, reparaciones). La rama GIFT la cubren E4 y test-50.
      S.front.DYN_EXAM_BANK_MODE_ENABLED = true;
      // Fase 2 (review I2): un navegador con una versión anterior (no declara que aplica el brief) no puede reclamar
      // un run con diseño: 409 rules_version_mismatch (pausa visible «recarga la página»), nada reclamado.
      const old = await api('POST', '/dynamic-generation/claim', { runId: c.runId, executorId: 'e2e-old-tab', types: ['content', 'course_plan', 'course_intro', 'module_intro', 'experience', 'video_interactions', 'activity', 'exam', 'final_exam'], leaseSeconds: 60 });
      const claimedOld = await q(`select count(*)::int n from public.generation_item_runs where job_id = $1 and worker_id = 'e2e-old-tab'`, [c.runId]);
      ok(old.status === 409 && /rules_version_mismatch/.test(String(old.error)) && /diseño pedagógico/.test(String(old.error)) && claimedOld[0].n === 0,
        'E6: ejecutor sin la capacidad pedagogy-brief-1 → 409 visible y ningún item reclamado', { s: old.status, e: old.error, n: claimedOld[0].n });
      // Fase 2: se graba cada prompt que el ejecutor REAL manda al LLM falso, con el item que lo pidió.
      const prompts = [];
      const respond0 = llm.respond;
      llm.respond = (b, h) => { prompts.push({ body: b, headers: h || {} }); return respond0(b, h); };
      let stt;
      try {
        const ctl = S.front.dynExecutorStart({ courseId: c.courseId, blueprintNumber: c.n, runId: c.runId });
        stt = await waitRunTerminal(ctl, 'E6 run', undefined, c.runId);
      } finally {
        llm.respond = respond0;
      }
      const items = await waitItemsDone(c.runId);
      ok(['preview', 'completed'].includes(stt.status) && stt.failed === 0 && !stt.fatalError, 'E6: ejecutor del navegador terminó sin fallidos', stt);
      ok(items.every((i) => i.status === 'completed'), `E6: los ${items.length} items completed (con diseño pedagógico en el Manifest)`, items.filter((i) => i.status !== 'completed').map((i) => [i.item_key, i.status, i.error_message && i.error_message.slice(0, 400)]));
      ok(llm.st.unknown.length === 0, 'E6: LLM falso sin prompts no reconocidos', llm.st.unknown);

      // ── Fase 2: el diseño de cada trabajo llegó al prompt / configuración FINAL de su generador ──
      const rules6 = M.features.activityTypeRules ?? null;
      const briefs = new Map(M.items.map((it) => [it.key, PED.buildItemPedagogyBrief({ item: it, snapshot: snap, activityTypeRules: rules6 })]));
      const runRows = await q(`select id, item_key, type, output_summary from public.generation_item_runs where job_id = $1`, [c.runId]);
      const keyOfRun = new Map(runRows.map((r) => [r.id, r.item_key]));
      const textOf = (b) => (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((x) => x.text || '').join(''))).join('\n');
      const hdr = (h, k) => (typeof h.get === 'function' ? h.get(k) : h[k]);
      const byItem = new Map();
      for (const p of prompts) {
        const key = keyOfRun.get(hdr(p.headers, 'x-cursia-item-run-id'));
        if (!key) continue;
        if (!byItem.has(key)) byItem.set(key, []);
        byItem.get(key).push({ role: hdr(p.headers, 'x-cursia-call-role') || 'main', text: textOf(p.body) });
      }
      const missing = [];
      const reached = new Set();
      for (const [key, calls] of byItem) {
        const br = briefs.get(key);
        const type = key.slice(0, key.indexOf(':'));
        if (!br) { missing.push(`${key}: prompt LLM sin diseño (${type})`); continue; }
        const want = br.text.replace(/^\n+/, '');
        // Sin bloque a propósito: el reintento SOLO del sidecar del contenido y la pasada que iguala la longitud de las
        // opciones GIFT (reparaciones de formato sobre un texto ya generado con el diseño; no escriben contenido nuevo).
        const formatRepair = (x) => x.role === 'context_summary_retry' || /^Estas preguntas GIFT de selección múltiple/.test(x.text);
        for (const call of calls.filter((x) => !formatRepair(x))) {
          if (!call.text.includes(want)) missing.push(`${key} (${call.role}): el prompt no trae su diseño`);
        }
        reached.add(type);
      }
      eq(missing, [], 'E6: TODO prompt LLM del ejecutor real trae el diseño de SU item (reintentos y correcciones incluidos)');
      eq([...reached].sort(), ['activity', 'content', 'course_intro', 'course_plan', 'exam', 'experience', 'final_exam', 'module_intro', 'video_interactions'], 'E6: generadores del navegador que recibieron diseño');
      const sumMismatch = runRows.filter((r) => byItem.has(r.item_key) && r.output_summary && briefs.get(r.item_key) && r.output_summary.pedagogySha256 !== briefs.get(r.item_key).textSha256).map((r) => r.item_key);
      eq(sumMismatch, [], 'E6: el summary de cada item registra la huella del diseño que recibió (pedagogySha256)');
      const vg = FAKES.videogen.submissions.slice(calls0.v);
      const vBrief = briefs.get(M.items.find((i) => i.type === 'video').key);
      ok(vg.length === 1 && vg[0].content_txt.includes(vBrief.text) && vg[0].content_txt.indexOf(vBrief.text) < 200, 'E6: Videogen FALSO recibió el estilo del video en la cabecera del content_txt', vg.map((x) => x.content_txt.slice(0, 300)));
      const gp = PFAKES.st.gammaPosts.slice(calls0.g);
      const pBriefs = M.items.filter((i) => i.type === 'presentation').map((i) => briefs.get(i.key).text);
      ok(gp.length === pBriefs.length && gp.every((b) => pBriefs.some((t) => String(b.additionalInstructions).endsWith(t)) && /^La diapositiva 1 es la portada/.test(b.additionalInstructions)),
        'E6: Gamma FALSO recibió el enfoque de las diapositivas al final de additionalInstructions (las reglas de siempre primero)', gp.map((b) => String(b.additionalInstructions).slice(-200)));
      const notConsumed = [...new Set(M.items.filter((i) => !briefs.get(i.key)).map((i) => i.type))].sort();
      eq(notConsumed, ['audio_welcome', 'audiobook_chapter'], 'E6: los únicos trabajos sin diseño son los de audio (narran contenido ya diseñado)');
      S.E6pedagogy = { llmCalls: prompts.length, itemsWithDesign: byItem.size, reached: [...reached].sort(), notConsumed };

      const ev = await q(`select count(*)::int n, coalesce(sum(amount), 0)::float usd from public.generation_cost_events where course_id = $1 and event_kind = 'CHARGE' and cost_source <> 'ZERO_BY_DESIGN'`, [c.courseId]);
      results.courses.E6 = { courseId: c.courseId, blueprintNumber: c.n, runId: c.runId, items: items.length, features: M.features,
        activities: acts.map((i) => ({ key: i.key, h5pType: i.h5pType, design: i.design })), chargedEvents: ev[0], pedagogyPrompts: S.E6pedagogy };
    }, { fatal: false });
    if (RUN_E5 && S.E6 && S.E6.runId) await step('v3-E6-pedagogia-empaquetado', async () => {
      const c = S.E6;
      const P = await packageRun('E6', c.courseId, c.n, c.runId);
      const os = P.job.output_summary || {};
      const libs = (os.h5pPackages || []).map((p) => p.mainLibrary);
      ok(libs.includes('H5P.DragText') || libs.includes('H5P.Blanks'), 'E6: el paquete trae las actividades del tipo elegido por el diseño pedagógico', libs);
      results.courses.E6.packageSummary = { h5pPackages: (os.h5pPackages || []).map((p) => ({ itemKey: p.itemKey, mainLibrary: p.mainLibrary })) };
    }, { fatal: false });

    // ═══ Fase 2 · Actividades de Aplicación — E7: capítulo de contenido + capítulo de PRÁCTICA con actividad ═══
    // Estructura → perfil (estudiante + resultados) → lock → Manifest con application_activity → run 100 % mock con el
    // ejecutor REAL del navegador (dos pasadas: actividad + solucionario; una respuesta inválida → reintento dirigido)
    // → empaque (página visible + PDF, solucionario OCULTO + PDF) → regenerar UNA actividad (solo ella) → reempaque.
    if (RUN_E5) await step('v3-E7-aplicacion-generacion', async () => {
      const AA = D('modules/course-shell/application-activity.js');
      const pedagogy = {
        pedagogyProfileVersion: 1, primaryApproach: 'competencias', secondaryApproaches: [],
        learner: { description: 'Técnicos de mantenimiento con experiencia en planta', ageGroup: 'adults', educationLevel: 'technical', priorKnowledge: 'basic', experience: 'some' },
        learningOutcomes: { know: ['Rangos de presión del circuito'], do: ['Inspeccionar un circuito hidráulico antes de liberarlo'], competencies: [] },
        learningModes: ['practice'], experienceTypes: ['teacher_guided'], assessmentMethods: ['quizzes'], principles: [], origin: 'manual',
      };
      const C = { key: 'E7', title: '[E2E Aplicación E7] Inspección de circuitos hidráulicos', theme: { themeFamily: 'aula-clara', mode: 'light' }, passing: 70, finalExam: false, engine: 'h5p', pedagogy, modules: [
        { title: 'Inspección del circuito', objective: 'Inspeccionar el circuito hidráulico antes de liberarlo', exam: true, chapters: [
          { title: 'Lectura de presión', v: false, a: true, app: 60, objective: 'Medir la presión del circuito en el puerto de prueba' },
          { title: 'Ajuste de válvulas', v: false, a: true, objective: 'Ajustar la válvula de alivio al valor de placa' },
          { title: 'Práctica integradora', v: false, a: false, kind: 'practice', app: 30, objective: 'Ejecutar la inspección completa del circuito' },
        ] }] };
      const c = await createCourse(C, llm);
      S.E7 = c;
      const M = c.manifest.manifest;
      const [chContent, chPlain, chPractice] = c.mods[0].chapters.map((x) => x.id);
      const apps = M.items.filter((i) => i.type === 'application_activity');
      eq(apps.map((i) => [i.key, i.applicationMinutes]), [[`application_activity:${chContent}`, 60], [`application_activity:${chPractice}`, 30]], 'E7: Manifest con una Actividad de Aplicación por capítulo marcado (60 y 30 min)');
      const ofPractice = M.items.filter((i) => i.chapterId === chPractice).map((i) => i.type).sort();
      eq(ofPractice, ['application_activity', 'experience'], 'E7: el capítulo de práctica con actividad NO activa video, Gamma, audiolibro ni Libro');
      eq(apps.find((i) => i.chapterId === chPractice).dependsOn.slice().sort(), [`content:${chContent}`, `content:${chPlain}`].sort(), 'E7: la actividad de la práctica depende de los contenidos del módulo');
      const bp = (await api('GET', `/courses/${c.courseId}/blueprints/${c.n}`)).data;
      const snap = bp && (bp.snapshot || (bp.blueprint && bp.blueprint.snapshot));
      ok(snap && snap.course.applicationContext && snap.course.applicationContext.learningOutcomes.do[0] === pedagogy.learningOutcomes.do[0], 'E7: Blueprint congela applicationContext (estudiante + resultados)', snap && snap.course.applicationContext);
      const mc = M.chapters ? M.chapters : M.modules.flatMap((m) => m.chapters);
      ok(mc.find((x) => x.chapterId === chContent).applicationMinutes === 60 && mc.find((x) => x.chapterId === chPlain).applicationMinutes === undefined, 'E7: ManifestChapter.applicationMinutes solo donde hay actividad');

      const ctx = { nombre: C.title, ...CTX, scormTemplateIds: S.templates };
      const start = await api('POST', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs`, { ...ctx, videoMode: 'mock', providerModes: { presentation: 'mock', audio: 'mock' } });
      ok(start.status === 201, 'E7: run 100 % mock creado (201) sin aprobación', { s: start.status, e: start.error });
      if (start.status !== 201) throw new Error(`E7: run no creado: ${start.status} ${start.error}`);
      c.runId = start.data.run.id;
      llm.st.tag = 'E7';
      // Review I3: una pestaña con la versión anterior (aplica el diseño pero no sabe generar Actividades de Aplicación)
      // recibe el 409 visible «recarga la página» y no reclama nada (nunca deja el run a medias renovando el lease).
      const old = await api('POST', '/dynamic-generation/claim?features=pedagogy-brief-1', { runId: c.runId, executorId: 'e2e-old-tab-app', types: ['content', 'course_plan', 'course_intro', 'module_intro', 'experience', 'video_interactions', 'activity', 'exam', 'final_exam'], leaseSeconds: 60 });
      const claimedOld = await q(`select count(*)::int n from public.generation_item_runs where job_id = $1 and worker_id = 'e2e-old-tab-app'`, [c.runId]);
      ok(old.status === 409 && /rules_version_mismatch/.test(String(old.error)) && /Actividades de Aplicación/.test(String(old.error)) && claimedOld[0].n === 0,
        'E7: ejecutor sin la capacidad application-activity-1 → 409 visible y ningún item reclamado', { s: old.status, e: old.error, n: claimedOld[0].n });
      const prompts = [];
      const respond0 = llm.respond;
      llm.respond = (b, h) => { prompts.push(b); return respond0(b, h); };
      let stt;
      try {
        const ctl = S.front.dynExecutorStart({ courseId: c.courseId, blueprintNumber: c.n, runId: c.runId });
        stt = await waitRunTerminal(ctl, 'E7 run', undefined, c.runId);
      } finally {
        llm.respond = respond0;
      }
      const items = await waitItemsDone(c.runId);
      ok(['preview', 'completed'].includes(stt.status) && stt.failed === 0 && !stt.fatalError, 'E7: ejecutor del navegador terminó sin fallidos', stt);
      ok(items.every((i) => i.status === 'completed'), `E7: los ${items.length} items completed (con Actividades de Aplicación)`, items.filter((i) => i.status !== 'completed').map((i) => [i.item_key, i.status, i.error_message && i.error_message.slice(0, 400)]));
      ok(llm.st.unknown.length === 0, 'E7: LLM falso sin prompts no reconocidos', llm.st.unknown);
      ok((llm.st.retriesSeen.application_activity || 0) >= 1, 'E7: la actividad inválida (pesos ≠ 100) pidió un reintento dirigido', llm.st.retriesSeen);
      const textOf = (b) => (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((x) => x.text || '').join(''))).join('\n');
      const appPrompts = prompts.map(textOf).filter((t) => t.includes('Diseña la ACTIVIDAD DE APLICACIÓN'));
      ok(appPrompts.length >= 2 && appPrompts.every((t) => t.includes(pedagogy.learningOutcomes.do[0]) && t.includes(pedagogy.learner.description)), 'E7: el prompt de la actividad trae el estudiante y los resultados de aprendizaje congelados', appPrompts.length);
      ok(appPrompts.some((t) => t.includes('para 30 minutos') && t.includes('CAPÍTULO DE PRÁCTICA')) && appPrompts.some((t) => t.includes('para 60 minutos') && !t.includes('CAPÍTULO DE PRÁCTICA')), 'E7: minutos y tipo de capítulo de cada actividad llegan a su prompt');
      const arts = await q(`select g.item_key k, a.type t, a.metadata from public.artifacts a join public.generation_item_runs g on g.id = a.item_run_id
                            where g.job_id = $1 and a.type = 'dynamic_application_json' order by g.item_key`, [c.runId]);
      eq(arts.map((a) => a.k).sort(), apps.map((i) => i.key).sort(), 'E7: un artifact dynamic_application_json por actividad');
      const sums = await q(`select item_key, output_summary from public.generation_item_runs where job_id = $1 and type = 'application_activity'`, [c.runId]);
      const byKey = new Map(sums.map((r) => [r.item_key, r.output_summary]));
      eq([byKey.get(`application_activity:${chContent}`).genre, byKey.get(`application_activity:${chPractice}`).genre, byKey.get(`application_activity:${chPractice}`).chapterKind], ['case_analysis', 'procedure', 'practice'], 'E7: las dos actividades no tienen la misma forma (género por capítulo) y la práctica se registra como tal');
      eq([byKey.get(`application_activity:${chContent}`).minutes, byKey.get(`application_activity:${chPractice}`).minutes], [60, 30], 'E7: summary con los minutos del Manifest');
      results.courses.E7 = { courseId: c.courseId, blueprintNumber: c.n, runId: c.runId, items: items.length, applications: apps.map((i) => ({ key: i.key, minutes: i.applicationMinutes })), summaries: Object.fromEntries(byKey) };
      void AA;
    }, { fatal: false });
    if (RUN_E5 && S.E7 && S.E7.runId) await step('v3-E7-aplicacion-empaquetado-y-regeneracion', async () => {
      const c = S.E7;
      const [chContent, , chPractice] = c.mods[0].chapters.map((x) => x.id);
      const pagesOf = async (buf) => {
        const zip = await JSZip.loadAsync(buf);
        const out = new Map();
        for (const f of Object.keys(zip.files).filter((n) => /^activities\/page_\d+\/module\.xml$/.test(n))) {
          const mx = await zip.file(f).async('string');
          const idn = (/<idnumber>([^<]*)<\/idnumber>/.exec(mx) || [])[1] || '';
          if (!/:application(_solution)?$/.test(idn)) continue;
          const px = await zip.file(f.replace('module.xml', 'page.xml')).async('string');
          out.set(idn, { visible: Number((/<visible>(\d)<\/visible>/.exec(mx) || [])[1]), content: px });
        }
        return out;
      };
      const P1 = await packageRun('E7', c.courseId, c.n, c.runId);
      const pg = await pagesOf(P1.buf);
      for (const ch of [chContent, chPractice]) {
        const s = pg.get(`cv3:ch:${ch}:application`);
        const t = pg.get(`cv3:ch:${ch}:application_solution`);
        ok(s && s.visible === 1 && /\.pdf/.test(s.content) && !s.content.includes('Verificar primero la presión'), `E7: ${ch === chPractice ? 'práctica' : 'contenido'}: página del estudiante visible, con PDF y sin respuestas`, s && { visible: s.visible });
        ok(t && t.visible === 0 && /\.pdf/.test(t.content) && t.content.includes('Verificar primero la presión'), `E7: ${ch === chPractice ? 'práctica' : 'contenido'}: solucionario docente OCULTO (visible 0) con respuestas y PDF`, t && { visible: t.visible });
      }
      ok(![...pg.keys()].some((k) => k.includes(c.mods[0].chapters[1].id)), 'E7: el capítulo sin actividad no tiene páginas de aplicación');

      // Regenerar SOLO la actividad de la práctica: el plan no arrastra nada más.
      const key = `application_activity:${chPractice}`;
      const base = `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs/${c.runId}/items/${encodeURIComponent(key)}/regenerate`;
      const dry = await api('POST', base, { dryRun: true });
      ok(dry.status === 200 && dry.data.costKind === 'llm' && JSON.stringify(dry.data.affected.map((x) => [x.itemKey, x.action])) === JSON.stringify([[key, 'REGENERATE']]) && dry.data.blockers.length === 0,
        'E7: dryRun de regenerar una actividad → solo esa actividad (LLM), sin trabas', { s: dry.status, e: dry.error, d: dry.data });
      const noConfirm = await api('POST', base, {});
      ok(noConfirm.status === 400 && /confirm_paid_required/.test(String(noConfirm.error)), 'E7: regenerar sin confirmPaid → 400 confirm_paid_required', { s: noConfirm.status, e: noConfirm.error });
      const before = await q(`select item_key, max(generation)::int g from public.generation_item_runs where job_id = $1 group by item_key`, [c.runId]);
      const regen = await api('POST', base, { confirmPaid: true });
      ok(regen.status === 201 && regen.data.created === true, 'E7: regeneración creada (201)', { s: regen.status, e: regen.error });
      const calls0 = llm.st.v3calls.length;
      const ctl = S.front.dynExecutorStart({ courseId: c.courseId, blueprintNumber: c.n, runId: c.runId });
      const stt = await waitRunTerminal(ctl, 'E7 regeneración', undefined, c.runId);
      await waitItemsDone(c.runId);
      ok(stt.failed === 0 && !stt.fatalError, 'E7: el ejecutor completó la regeneración', stt);
      const after = await q(`select item_key, max(generation)::int g from public.generation_item_runs where job_id = $1 group by item_key`, [c.runId]);
      const bumped = after.filter((r) => r.g !== (before.find((b) => b.item_key === r.item_key) || {}).g).map((r) => r.item_key);
      eq(bumped, [key], 'E7: solo la actividad regenerada tiene una generación nueva');
      const [latest] = await q(`select status from public.generation_item_runs where job_id = $1 and item_key = $2 order by generation desc limit 1`, [c.runId, key]);
      eq(latest && latest.status, 'completed', 'E7: la generación nueva de la actividad quedó completed');
      const kinds = llm.st.v3calls.slice(calls0).map((x) => x.kind);
      ok(kinds.length >= 2 && kinds.every((k) => k === 'application_activity' || k === 'application_solution'), 'E7: la regeneración solo llamó al LLM para la actividad y su solucionario', kinds);
      const P2 = await packageRun('E7-regen', c.courseId, c.n, c.runId);
      const pg2 = await pagesOf(P2.buf);
      ok(pg2.get(`cv3:ch:${chPractice}:application_solution`).visible === 0 && pg2.get(`cv3:ch:${chContent}:application`).visible === 1, 'E7: reempaque tras regenerar: páginas y solucionario oculto intactos');
      results.courses.E7.regeneration = { key, dryRunAffected: dry.data.affected.map((x) => x.itemKey), llmCalls: kinds };
    }, { fatal: false });


    // ═══ Fase 3 · Contexto académico — E8: microcurrículo (DOCX real) → contexto → perfil → 64 h → diseño → Blueprint → Manifest ═══
    // Sin proveedores: la extracción es determinista y el run no se ejecuta (un claim real comprueba el brief y se cancela).
    if (RUN_E5) await step('v3-E8-contexto-academico-diseno', async () => {
      const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));
      const fc = crypto.randomUUID();
      const cr = await api('POST', '/courses/dynamic', { frontendCourseId: fc, title: '[E2E Contexto E8] Contabilidad de Costos' });
      ok(cr.status === 201, 'E8: POST /courses/dynamic → 201', { s: cr.status, e: cr.error });
      const courseId = Number(cr.data.id);
      // 1. Documento → extracción (sin guardar, sin proveedores)
      const docx = await AF.fixture('consistent', 'docx');
      const net0 = fs.existsSync(NET_LOG) ? fs.readFileSync(NET_LOG, 'utf8').length : 0;
      const ex = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'microcurriculo-costos.docx', dataBase64: docx.toString('base64') }] });
      ok(ex.status === 200 && ex.data.saved === false && ex.data.stats.providersCalled === 0, 'E8: extract → 200, determinista, sin guardar y sin proveedores', { s: ex.status, e: ex.error });
      const draft = ex.data.draft;
      eq([draft.identity.subjectName.value, draft.outcomes.length, draft.competencies.length, draft.units.length, draft.hours.total.value, draft.evaluation.length], ['Contabilidad de Costos', 6, 2, 5, 64, 5], 'E8: el contexto trae asignatura, 6 RA, 2 competencias, 5 unidades, 64 h y 5 evaluaciones');
      eq([ex.data.validation.canProceed, ex.data.validation.counts], [true, { error: 0, warning: 0, missing: 0 }], 'E8: validación limpia');
      eq((await q(`select count(*)::int n from public.course_profiles where course_id = $1`, [courseId]))[0].n, 0, 'E8: la extracción no guardó nada');
      ok(fs.existsSync(NET_LOG) && fs.readFileSync(NET_LOG, 'utf8').length === net0, 'E8: 0 conexiones fuera de 127.0.0.1 durante la extracción (netguard activo)');
      const bad = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'foto.bin', dataBase64: Buffer.from([0, 1, 2, 3, 255]).toString('base64') }] });
      ok(bad.status === 400 && /UNSUPPORTED_DOCUMENT/.test(String(bad.error)), 'E8: archivo no soportado → 400 UNSUPPORTED_DOCUMENT', { s: bad.status, e: bad.error });
      const inc = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'inconsistente.pdf', dataBase64: (await AF.fixture('inconsistent', 'pdf')).toString('base64') }] });
      ok(inc.status === 200 && inc.data.validation.issues.some((i) => i.message === 'El documento indica 64 horas, pero la suma de componentes reportada es 48 horas.'), 'E8: PDF inconsistente → advertencia de horas exacta (sin bloquear)', inc.data && inc.data.validation && inc.data.validation.counts);
      // 2. Guardar (versionado) — sin contexto, vincular resultados responde 400. Un curso nuevo no trae módulos (el
      //    esqueleto 1×1 lo arma el editor): se crea el primero, con su capítulo automático.
      let st = await readStructure(courseId);
      if (!st.modules.length) {
        const c0 = await api('POST', `/courses/${courseId}/modules`, { title: 'Módulo 1', examEnabled: true, expectedCounter: st.structureVersionCounter });
        if (c0.status !== 201) throw new Error(`E8: primer módulo ${c0.status} ${c0.error}`);
        st = await readStructure(courseId);
      }
      const [m0] = st.modules;
      ok(m0 && m0.chapters.length === 1 && 'outcomeIds' in m0.chapters[0] && m0.chapters[0].outcomeIds === null, 'E8: el GET de la estructura informa outcomeIds (null) con la migración aplicada', m0 && m0.chapters[0]);
      const pre = await api('PATCH', `/courses/${courseId}/modules/${m0.id}/chapters/${m0.chapters[0].id}`, { outcomeIds: ['RA1'], expectedCounter: st.structureVersionCounter });
      ok(pre.status === 400 && /NO_ACADEMIC_CONTEXT/.test(String(pre.error)), 'E8: vincular sin contexto guardado → 400 NO_ACADEMIC_CONTEXT', { s: pre.status, e: pre.error });
      const sv = await api('POST', `/courses/${courseId}/profiles/academic`, { data: draft, expectedVersion: 0 });
      ok(sv.status === 201 && sv.data.profile.version === 1 && sv.data.profile.academicValidation.canProceed === true, 'E8: POST profiles/academic → 201 (versión 1, con validación)', { s: sv.status, e: sv.error });
      const again = await api('POST', `/courses/${courseId}/profiles/academic`, { data: draft });
      ok(again.status === 200 && again.data.created === false, 'E8: guardar el mismo contexto es idempotente (200, sin versión nueva)', { s: again.status });
      // 3. Diseño desde el contexto
      const dz = await api('GET', `/courses/${courseId}/academic-context/design`);
      ok(dz.status === 200 && dz.data.available === true && dz.data.providersCalled === 0, 'E8: GET design → 200', { s: dz.status, e: dz.error });
      const sug = dz.data.profileSuggestion;
      const prop = dz.data.structureProposal;
      eq([sug.profile.targetHours, sug.profile.learningOutcomes.do.length, sug.approachHints], [64, 5, ['problemas']], 'E8: el contexto sugiere 64 h, 5 resultados de saber hacer y nombra ABP');
      eq([prop.counts.modules, prop.counts.chapters, prop.counts.outcomesCovered], [5, 18, 6], 'E8: estructura propuesta 5 × 18 con los 6 RA vinculados');
      // 4. Perfil pedagógico desde el contexto (+ el enfoque que elige el docente)
      const profile = { ...sug.profile, primaryApproach: 'problemas', secondaryApproaches: [] };
      const pg = await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: profile, expectedVersion: 0 });
      ok(pg.status === 201 && pg.data.profile.profile.targetHours === 64, 'E8: perfil pedagógico guardado con las 64 h y los resultados del documento', { s: pg.status, e: pg.error });
      // 5. Estructura desde el microcurrículo (lo que hace el panel con la vía de 48), con descripción y vínculos
      st = await readStructure(courseId);
      let counter = st.structureVersionCounter;
      for (let mi = 0; mi < prop.modules.length; mi++) {
        const pm = prop.modules[mi];
        let mod;
        if (mi === 0) {
          mod = st.modules[0];
          const u = await api('PATCH', `/courses/${courseId}/modules/${mod.id}`, { title: pm.title, objective: pm.objective, description: pm.description || undefined, examEnabled: true, expectedCounter: counter });
          counter = u.data.structureVersionCounter;
          mod = { ...mod, chapters: mod.chapters };
        } else {
          const cm = await api('POST', `/courses/${courseId}/modules`, { title: pm.title, objective: pm.objective, examEnabled: true, expectedCounter: counter });
          counter = cm.data.structureVersionCounter;
          mod = cm.data.module;
        }
        for (let ci = 0; ci < pm.chapters.length; ci++) {
          const pc = pm.chapters[ci];
          const body = { title: pc.title, videoEnabled: pc.videoEnabled, activityEnabled: pc.activityEnabled, ...(pc.description ? { description: pc.description } : {}), ...(pc.outcomeIds.length ? { outcomeIds: pc.outcomeIds } : {}), expectedCounter: counter };
          const auto = (mod.chapters || [])[0];
          const r = ci === 0 && auto ? await api('PATCH', `/courses/${courseId}/modules/${mod.id}/chapters/${auto.id}`, body) : await api('POST', `/courses/${courseId}/modules/${mod.id}/chapters`, body);
          if (![200, 201].includes(r.status)) throw new Error(`E8 capítulo ${pc.title}: ${r.status} ${r.error}`);
          counter = r.data.structureVersionCounter;
        }
      }
      st = await readStructure(courseId);
      eq(st.modules.map((m) => m.chapters.length), [4, 4, 4, 3, 3], 'E8: estructura viva = la del microcurrículo');
      eq(st.modules[4].chapters.map((c) => c.outcomeIds), [['RA5', 'RA6'], ['RA5'], ['RA5', 'RA6']], 'E8: vínculos persistidos y devueltos por el GET (orden canónico)');
      const badLink = await api('PATCH', `/courses/${courseId}/modules/${st.modules[0].id}/chapters/${st.modules[0].chapters[0].id}`, { outcomeIds: ['RA9'], expectedCounter: st.structureVersionCounter });
      ok(badLink.status === 400 && /UNKNOWN_OUTCOME_REF/.test(String(badLink.error)), 'E8: vincular un resultado inexistente → 400 UNKNOWN_OUTCOME_REF', { s: badLink.status, e: badLink.error });
      // 6. 64 h: dry-run del distribuidor con la estructura del documento → aplicar el diseño
      const dr = await api('POST', `/courses/${courseId}/pedagogy/dry-run`, {});
      const dist = dr.data && dr.data.distribution;
      ok(dr.status === 201 || dr.status === 200, 'E8: dry-run del curso → OK', { s: dr.status, e: dr.error });
      ok(dist && dist.status === 'within_tolerance' && dist.targetHours === 64 && dist.materialized.manifestErrors.length === 0, 'E8: con el microcurrículo, 64 h quedan DENTRO de la tolerancia (la estructura 3 × 3 del baseline no alcanzaba)', dist && { status: dist.status, h: dist.estimatedHours, c: dist.counts });
      ok(dr.data.pedagogical && dr.data.pedagogical.blueprint.course.academicContext && dr.data.pedagogical.blueprint.course.academicContext.outcomes.length === 6, 'E8: el Blueprint del dry-run lleva el contexto académico congelado');
      const ap = await api('POST', `/courses/${courseId}/modules/apply-distribution`, { expectedCounter: st.structureVersionCounter, proposalSha256: dist.proposalSha256 });
      ok([200, 201].includes(ap.status) && ap.data.addedChapters >= 1, 'E8: «Aplicar diseño» → estructura con la práctica y las Actividades de Aplicación del diseño', { s: ap.status, e: ap.error, d: ap.data });
      st = await readStructure(courseId);
      const linkedBefore = st.modules.flatMap((m) => m.chapters).filter((c) => Array.isArray(c.outcomeIds)).length;
      eq(linkedBefore, 18, 'E8: «Aplicar diseño» no tocó los vínculos de los capítulos');
      // 7. Lock → Blueprint con contexto y vínculos; Manifest válido
      const lock = await api('POST', `/courses/${courseId}/blueprints`, { expectedCounter: st.structureVersionCounter });
      ok(lock.status === 201, 'E8: lock → 201', { s: lock.status, e: lock.error });
      const snap = lock.data.blueprint.snapshot;
      const ac = snap.course.academicContext;
      ok(ac && ac.outcomes.map((o) => o.id).join() === 'RA1,RA2,RA3,RA4,RA5,RA6' && ac.competencies.length === 2 && ac.contextSha256 === sv.data.profile.sha256, 'E8: Blueprint congela los resultados y competencias del contexto (con su huella)', ac && { o: ac.outcomes.length, sha: ac.contextSha256 });
      eq(snap.modules.flatMap((m) => m.chapters).filter((c) => c.outcomeIds).length, 18, 'E8: Blueprint con los vínculos de los 18 capítulos del documento');
      ok(snap.course.pedagogy && snap.course.targetHours === 64, 'E8: Blueprint con el diseño pedagógico y las 64 h');
      const st2 = await readStructure(courseId);
      ok(st2.liveMatchesCurrentBlueprint === true, 'E8: la estructura viva coincide con el Blueprint (el contexto entra igual en la comparación)');
      const n = lock.data.blueprint.blueprintNumber;
      const man = await api('POST', `/courses/${courseId}/blueprints/${n}/manifest`);
      ok(man.status === 201 && man.data.manifest.rulesVersion === 3, 'E8: Manifest v3 → 201', { s: man.status, e: man.error });
      const M = man.data.manifest.manifest;
      ok(M.totals.applicationActivityCount >= 18 && M.modules.length === 5, 'E8: Manifest con 5 módulos y las Actividades de Aplicación del diseño', M.totals);
      // 8. El brief que el claim entregaría a cada generador (misma función que el scheduler, sobre el Blueprint y el
      //    Manifest GUARDADOS). El claim real con el ejecutor del navegador lo prueba E8-mini (sin videos: este app de
      //    prueba no publica en YouTube, requisito para crear runs con video).
      const GD = D('modules/pedagogy/generator-directives.js');
      const fe = M.items.find((i) => i.type === 'final_exam');
      const fb = GD.buildItemPedagogyBrief({ item: fe, snapshot: snap, activityTypeRules: M.features && M.features.activityTypeRules });
      ok(fb && /RESULTADOS DE APRENDIZAJE QUE ESTE RECURSO DEBE EVIDENCIAR/.test(fb.text) && fb.outcomes.join() === 'RA1,RA2,RA3,RA4,RA5,RA6' && fb.text.length <= 4000 && fb.directives.length > 0,
        'E8: el examen final recibe el diseño pedagógico + los 6 resultados (≤ 4000 caracteres)', fb && { outcomes: fb.outcomes, len: fb.text.length });
      const appItem = M.items.find((i) => i.type === 'application_activity' && snap.modules[1].chapters.some((c) => c.id === i.chapterId && c.outcomeIds));
      const ab = GD.buildItemPedagogyBrief({ item: appItem, snapshot: snap, activityTypeRules: M.features && M.features.activityTypeRules });
      ok(ab && ab.outcomes.join() === 'RA2' && /criterios de evaluación deben referirse a ellos/.test(ab.text), 'E8: la Actividad de Aplicación del módulo 2 recibe RA2 y la indicación de evidenciarlo', ab && ab.outcomes);
      const pres = M.items.find((i) => i.type === 'presentation');
      ok(!GD.buildItemPedagogyBrief({ item: pres, snapshot: snap }) || !/RESULTADOS DE APRENDIZAJE/.test(GD.buildItemPedagogyBrief({ item: pres, snapshot: snap }).text), 'E8: los proveedores (Gamma) no reciben el bloque de resultados');
      // Review I1: una versión nueva del contexto que ya no define RA6 limpia los vínculos (misma transacción) y el
      // curso se puede volver a confirmar (sin quedar trabado con un vínculo roto).
      const v2 = JSON.parse(JSON.stringify(draft));
      v2.outcomes = v2.outcomes.filter((o) => o.id !== 'RA6');
      v2.units = v2.units.map((u) => ({ ...u, outcomeIds: u.outcomeIds.filter((x) => x !== 'RA6'), contents: u.contents.map((c) => ({ ...c, outcomeIds: c.outcomeIds.filter((x) => x !== 'RA6') })) }));
      v2.evaluation = v2.evaluation.map((e) => ({ ...e, outcomeIds: e.outcomeIds.filter((x) => x !== 'RA6') }));
      const sv2 = await api('POST', `/courses/${courseId}/profiles/academic`, { data: v2 });
      ok(sv2.status === 201 && (sv2.data.prunedOutcomeLinks || []).length === 2 && sv2.data.prunedOutcomeLinks.every((p) => p.removed.join() === 'RA6'),
        'E8: guardar una versión sin RA6 quita RA6 de los 2 capítulos que lo vinculaban', sv2.data && sv2.data.prunedOutcomeLinks);
      const st3 = await readStructure(courseId);
      ok(!st3.modules.flatMap((m) => m.chapters).some((c) => (c.outcomeIds || []).includes('RA6')) && st3.liveMatchesCurrentBlueprint === false, 'E8: sin vínculos rotos; el Blueprint confirmado ya no coincide (hay que reconfirmar)');
      const relock = await api('POST', `/courses/${courseId}/blueprints`, { expectedCounter: st3.structureVersionCounter });
      ok(relock.status === 201 && relock.data.blueprint.snapshot.course.academicContext.outcomes.length === 5, 'E8: el curso se vuelve a confirmar con la versión nueva del contexto', { s: relock.status, e: relock.error });
      results.courses.E8 = { courseId, blueprintNumber: n, hours: dist.estimatedHours, counts: dist.counts, outcomes: ac.outcomes.length, manifestTotals: M.totals, usd: dist.materialized.providers.estimateUsd.expected };
    }, { fatal: false });

    // E8-mini: curso chico desde su microcurrículo, generado de punta a punta con el ejecutor REAL del navegador (LLM falso):
    // los resultados vinculados llegan a los prompts del contenido, la actividad y el examen; empaque OK.
    if (RUN_E5) await step('v3-E8-contexto-academico-generacion', async () => {
      const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));
      const AC = D('modules/academic-context/index.js');
      const ext = await AC.extractAcademicContext([{ name: 'mini.docx', data: await AF.fixture('mini', 'docx') }]);
      const prop = AC.proposeStructureFromContext(ext.context);
      const C = { key: 'E8m', title: '[E2E Contexto E8-mini] Inspección de circuitos hidráulicos', theme: { themeFamily: 'aula-clara', mode: 'light' }, passing: 70, finalExam: true, engine: 'h5p', academic: ext.context,
        modules: prop.modules.map((m) => ({ title: m.title, objective: m.objective, exam: true, chapters: m.chapters.map((c) => ({ title: c.title, v: false, a: true, objective: `Aplicar ${c.title.toLowerCase()}`, description: c.description || undefined, outcomeIds: c.outcomeIds })) })) };
      const c = await createCourse(C, llm);
      S.E8m = c;
      const bp = (await api('GET', `/courses/${c.courseId}/blueprints/${c.n}`)).data;
      const snap = bp && (bp.snapshot || (bp.blueprint && bp.blueprint.snapshot));
      ok(snap && snap.course.academicContext && snap.modules[0].chapters[0].outcomeIds.join() === 'RA1,RA2', 'E8-mini: Blueprint con el contexto y los vínculos', snap && snap.modules[0].chapters[0].outcomeIds);
      const start = await api('POST', `/courses/${c.courseId}/blueprints/${c.n}/manifest/runs`, { nombre: C.title, ...CTX, scormTemplateIds: S.templates, videoMode: 'mock', providerModes: { presentation: 'mock', audio: 'mock' } });
      ok(start.status === 201, 'E8-mini: run 100 % mock creado', { s: start.status, e: start.error });
      if (start.status !== 201) throw new Error(`E8-mini: run no creado: ${start.status} ${start.error}`);
      c.runId = start.data.run.id;
      llm.st.tag = 'E8m';
      const prompts = [];
      const respond0 = llm.respond;
      llm.respond = (b, h) => { prompts.push(b); return respond0(b, h); };
      let stt;
      try {
        const ctl = S.front.dynExecutorStart({ courseId: c.courseId, blueprintNumber: c.n, runId: c.runId });
        stt = await waitRunTerminal(ctl, 'E8-mini run', undefined, c.runId);
      } finally {
        llm.respond = respond0;
      }
      const items = await waitItemsDone(c.runId);
      ok(['preview', 'completed'].includes(stt.status) && stt.failed === 0 && !stt.fatalError, 'E8-mini: el ejecutor del navegador terminó sin fallidos', stt);
      ok(items.every((i) => i.status === 'completed'), `E8-mini: los ${items.length} items completed`, items.filter((i) => i.status !== 'completed').map((i) => [i.item_key, i.status, i.error_message && i.error_message.slice(0, 300)]));
      ok(llm.st.unknown.length === 0, 'E8-mini: LLM falso sin prompts no reconocidos', llm.st.unknown);
      const textOf = (b) => (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((x) => x.text || '').join(''))).join('\n');
      const all = prompts.map(textOf);
      const withBlock = all.filter((t) => t.includes('RESULTADOS DE APRENDIZAJE QUE ESTE RECURSO DEBE EVIDENCIAR'));
      ok(withBlock.length >= 6, `E8-mini: ${withBlock.length} prompts con el bloque de resultados (plan, contenido, actividades, exámenes)`, withBlock.length);
      ok(withBlock.some((t) => /RA3 \(saber hacer · aplicar\): Ajustar la válvula de alivio/.test(t) && /evidencia observable/.test(t)), 'E8-mini: la actividad del capítulo de ajuste pide evidencia de RA3');
      ok(withBlock.some((t) => /al menos una pregunta/.test(t) && t.includes('RA1') && t.includes('RA2')), 'E8-mini: el examen del módulo 1 cubre RA1 y RA2');
      const allowed = new Set([...ext.context.outcomes.map((o) => o.id), ...ext.context.competencies.map((o) => o.id)]);
      const mentioned = new Set(withBlock.flatMap((t) => [...t.matchAll(/^- ((?:RA|CO)\d+) \(/gm)].map((m) => m[1])));
      ok(mentioned.size > 0 && [...mentioned].every((id) => allowed.has(id)), 'E8-mini: los prompts solo nombran resultados del contexto (ninguno inventado)', [...mentioned]);
      const P = await packageRun('E8m', c.courseId, c.n, c.runId);
      ok(P && P.buf && P.buf.length > 0, 'E8-mini: paquete .mbz construido (el contexto no cambia el empaque)');
      results.courses.E8m = { courseId: c.courseId, runId: c.runId, items: items.length, promptsWithOutcomes: withBlock.length };
    }, { fatal: false });


    // ═══ Fase 4 · Coherence Engine — E9: alineación resultado → evidencia sobre el curso del E8 (DB real, sin proveedores) ═══
    if (RUN_E5 && results.courses.E8) await step('v3-E9-coherencia-alineacion', async () => {
      const courseId = results.courses.E8.courseId;
      const net0 = fs.existsSync(NET_LOG) ? fs.readFileSync(NET_LOG, 'utf8').length : 0;
      const dr = async () => {
        const r = await api('POST', `/courses/${courseId}/pedagogy/dry-run`, {});
        if (![200, 201].includes(r.status)) throw new Error(`E9: dry-run ${r.status} ${r.error}`);
        return r.data;
      };
      const d0 = await dr();
      const a0 = d0.alignment;
      ok(a0 && a0.available === true && a0.ruleset === 'alignment-rules@1' && a0.outcomes.length === 7, 'E9: el dry-run del curso trae el mapa de alineación (5 RA de la versión 2 + 2 competencias)', a0 && a0.coverage);
      // Review F4 I2: el flujo de Cursia no vincula competencias → advertencia transversal (A1c), nunca crítico.
      ok(a0.findings.filter((f) => f.rule === 'A1c' && f.severity === 'warning').map((f) => f.outcomeIds[0]).join() === 'CO1,CO2' && !a0.findings.some((f) => f.rule === 'A1'),
        'E9: las competencias sin capítulos → advertencia transversal A1c (el documento no las vincula), sin críticos A1', a0.findings.map((f) => f.rule + ':' + f.outcomeIds.join('+')));
      const ra2 = a0.outcomes.find((o) => o.id === 'RA2');
      ok(['instruction', 'practice', 'application', 'assessment'].every((k) => ra2.evidence.some((e) => e.kind === k)) && ra2.evidence.every((e) => /:/.test(e.itemKey)), 'E9: RA2 con evidencias tipadas (instrucción, práctica, aplicación, evaluación) del Manifest');
      const pa = d0.distribution && d0.distribution.materialized.alignment;
      ok(pa && pa.available === true && pa.outcomes.length === 7 && pa.counts.critical <= a0.counts.critical, 'E9: también la alineación del diseño propuesto (mismos resultados, sin más críticos)', pa && pa.counts);
      ok(a0.thresholds.missingPracticeIsCritical === false && a0.thresholds.practiceMinutesForComplex === 95, 'E9: umbrales del enfoque guardado (problemas: práctica 0,7 → 95 min)', a0.thresholds);
      // Caso incompleto: quitar los vínculos de un capítulo → A4; de todos los capítulos de RA4 → A1.
      let st = await readStructure(courseId);
      const m4 = st.modules[3];
      let counter = st.structureVersionCounter;
      for (const c of m4.chapters.filter((x) => Array.isArray(x.outcomeIds))) {
        const u = await api('PATCH', `/courses/${courseId}/modules/${m4.id}/chapters/${c.id}`, { outcomeIds: null, expectedCounter: counter });
        if (u.status !== 200) throw new Error(`E9: quitar vínculos ${u.status} ${u.error}`);
        counter = u.data.structureVersionCounter;
      }
      const a1 = (await dr()).alignment;
      ok(a1.findings.some((f) => f.rule === 'A1' && f.severity === 'critical' && f.outcomeIds[0] === 'RA4') && a1.findings.filter((f) => f.rule === 'A4').length >= 3,
        'E9: sin vínculos en el módulo 4 → RA4 sin cobertura (crítico) y sus capítulos «no asociados a ningún resultado»', a1.findings.map((f) => f.rule + ':' + (f.outcomeIds[0] || f.chapterIds[0])));
      // Caso pedagógico: el mismo curso con aprendizaje significativo cambia umbrales, severidades y sugerencias.
      const ped = (await api('GET', `/courses/${courseId}/profiles/pedagogy`)).data;
      const sig = await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: { ...ped.profile, primaryApproach: 'significativo', secondaryApproaches: [] }, expectedVersion: ped.version });
      ok(sig.status === 201, 'E9: perfil cambiado a aprendizaje significativo', { s: sig.status, e: sig.error });
      const a2 = (await dr()).alignment;
      ok(a2.thresholds.practiceMinutesForComplex === 70 && a2.thresholds.priorKnowledgeChecks === true && a2.approach.approaches[0].id === 'significativo', 'E9: significativo → 70 min para resultados complejos y control de conocimientos previos', a2.thresholds);
      // Review F4 M8: aserción concreta. Las A6 se miden contra el umbral del enfoque vigente, y bajar el umbral nunca agrega A6.
      const a6 = (r) => r.findings.filter((f) => f.rule === 'A6');
      ok(a6(a1).every((f) => f.evidence.requiredMinutes === 95) && a6(a2).every((f) => f.evidence.requiredMinutes === 70) && a6(a2).length <= a6(a1).length && a2.reportSha256 !== a1.reportSha256,
        'E9: cambiar el enfoque recalcula las advertencias de tiempo con el umbral nuevo (95 → 70 min)', { a1: a6(a1).length, a2: a6(a2).length });
      ok(fs.existsSync(NET_LOG) && fs.readFileSync(NET_LOG, 'utf8').length === net0, 'E9: 0 conexiones fuera de 127.0.0.1 (netguard activo)');
      results.courses.E9 = { courseId, initial: a0.counts, incomplete: a1.counts, significativo: a2.counts };
    }, { fatal: false });


    // ═══ Fase 5 · Regeneración parcial — E10: vista previa del impacto de los cambios (DB real, sin proveedores, USD 0) ═══
    if (RUN_E5 && results.courses.E8m) await step('v3-E10-impacto-de-cambios', async () => {
      const net0 = fs.existsSync(NET_LOG) ? fs.readFileSync(NET_LOG, 'utf8').length : 0;
      const courseId = results.courses.E8m.courseId;
      const jobs0 = (await q(`select count(*)::int n from public.production_jobs where course_id = $1`, [courseId]))[0].n;
      const persisted = async () => (await q(`select (select count(*) from public.course_blueprints where course_id = $1)::int b,
          (select count(*) from public.course_generation_manifests where course_id = $1)::int m,
          (select count(*) from public.course_profiles where course_id = $1)::int p`, [courseId]))[0];
      const persisted0 = await persisted();
      const imp = async (body) => {
        const r = await api('POST', `/courses/${courseId}/change-impact`, body || {});
        if (r.status !== 200) throw new Error(`E10: change-impact ${r.status} ${r.error}`);
        return r.data;
      };
      // Sin cambios: nada que regenerar, USD 0.
      const d0 = await imp();
      ok(d0.available === true && d0.fromRunId === results.courses.E8m.runId && d0.blueprintChanged === false && d0.impact.toRun.length === 0 && d0.impact.untouchedChapters === d0.impact.chapters.length,
        'E10: curso generado sin cambios → todo intacto, nada que regenerar', d0.impact && d0.impact.totals);
      // Cambiar UN capítulo: solo él (y lo que lo incluye).
      let st = await readStructure(courseId);
      const m0 = st.modules[0];
      const ch = m0.chapters[1];
      const u = await api('PATCH', `/courses/${courseId}/modules/${m0.id}/chapters/${ch.id}`, { title: `${ch.title} (revisado)`, expectedCounter: st.structureVersionCounter });
      ok(u.status === 200, 'E10: editar el título de un capítulo', { s: u.status, e: u.error });
      const d1 = await imp();
      const c1 = d1.impact.chapters.find((x) => x.chapterId === ch.id);
      ok(c1 && !c1.untouched && c1.regenerate.some((k) => k.startsWith('content:')) && d1.impact.untouchedChapters === d1.impact.chapters.length - 1,
        'E10: solo el capítulo editado cambia; los demás quedan intactos', d1.impact.chapters.map((x) => [x.title, x.untouched]));
      ok(d1.impact.toRun.every((k) => k.includes(ch.id) || /^(course_plan|course_intro|module_intro|exam|final_exam):/.test(k)), 'E10: fuera del capítulo solo lo que lo incluye (plan, intros, exámenes)', d1.impact.toRun);
      ok(Number(d1.impact.cost.toRun.estimateUsd.expected) > 0 && d1.impact.dryRun === true && d1.impact.spendUsd === '0.00', 'E10: costo estimado de los cambios (simulado, USD 0 gastado)', d1.impact.cost.toRun.estimateUsd);
      ok(d1.impact.estimatedChangeCostUsd === Number(d1.impact.cost.toRun.estimateUsd.expected).toFixed(2), 'E10: «Costo estimado de los cambios: USD X» = todo lo que se ejecutaría', d1.impact.estimatedChangeCostUsd);
      // Cambio pedagógico de vista previa (sin guardar): qué depende de esa decisión.
      const ped = (await api('GET', `/courses/${courseId}/profiles/pedagogy`)).data;
      const preview = { ...ped.profile, primaryApproach: 'significativo', secondaryApproaches: [] };
      const d2 = await imp({ profile: preview });
      ok(d2.impact.toRun.length > d1.impact.toRun.length && d2.impact.toRun.every((k) => (d2.impact.reasons[k] || []).length > 0), 'E10: cambiar el enfoque (vista previa) → más items, cada uno con su motivo', d2.impact.totals);
      const pedAfter = (await api('GET', `/courses/${courseId}/profiles/pedagogy`)).data;
      ok(pedAfter.version === ped.version, 'E10: la vista previa no guardó el perfil');
      // Review F5 I1: perfil inválido → 400 (no 500); run inexistente → 404.
      const bad = await api('POST', `/courses/${courseId}/change-impact`, { profile: { ...ped.profile, targetHours: -3 }, applyDistribution: true });
      ok(bad.status === 400, 'E10: perfil de vista previa inválido → 400', { s: bad.status, e: bad.error });
      const bad2 = await api('POST', `/courses/${courseId}/change-impact`, { profile: { ...ped.profile, primaryApproach: 'no-existe' } });
      ok(bad2.status === 400, 'E10: enfoque desconocido → 400', { s: bad2.status, e: bad2.error });
      const nf = await api('POST', `/courses/${courseId}/change-impact`, { fromRunId: '99999999-9999-4999-8999-999999999999' });
      ok(nf.status === 404, 'E10: run de origen inexistente → 404', { s: nf.status, e: nf.error });
      ok((await q(`select count(*)::int n from public.production_jobs where course_id = $1`, [courseId]))[0].n === jobs0, 'E10: no se creó ningún run ni trabajo');
      ok(JSON.stringify(await persisted()) === JSON.stringify(persisted0), 'E10: la vista previa no escribió Blueprints, Manifests ni perfiles', persisted0);
      // Curso sin generar (E8): nada que conservar, costo del curso completo.
      if (results.courses.E8) {
        const r = await api('POST', `/courses/${results.courses.E8.courseId}/change-impact`, {});
        ok(r.status === 200 && r.data.available === false && r.data.reason === 'NO_PREVIOUS_RUN' && Number(r.data.fullGeneration.estimateUsd.expected) > 0, 'E10: curso no generado → costo de generarlo completo', { s: r.status, d: r.data && r.data.reason });
      }
      ok(fs.existsSync(NET_LOG) && fs.readFileSync(NET_LOG, 'utf8').length === net0, 'E10: 0 conexiones fuera de 127.0.0.1 (netguard activo)');
      results.courses.E10 = { courseId, unchanged: d0.impact.totals, oneChapter: { toRun: d1.impact.toRun.length, usd: d1.impact.cost.toRun.estimateUsd.expected }, approachPreview: { toRun: d2.impact.toRun.length } };
    }, { fatal: false });

    // ═══ LOOP 7 · E11 — FLUJO COMPLETO en un solo curso (solo mocks, USD 0): microcurrículo → contexto académico →
    // enfoque → 64 h → «Cursia recomienda» → Ver diseño → Ajustar → nuevo diseño → Aplicar → Blueprint → Manifest →
    // Actividades de Aplicación → coherencia → costo simulado → generación → empaque → impacto de un cambio →
    // regeneración parcial (= el impacto previsto) → re-empaque → restauración en Moodle (abajo, con estudiante real).
    if (RUN_E5) await step('v3-E11-flujo-completo', async () => {
      const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));
      const DRY = D('modules/pedagogy/dry-run.js');
      const STI = D('modules/study-time/index.js');
      const MIN = D('modules/study-time/manifest-input.js');
      const usd = (plan) => (plan && plan.estimateUsd ? Number(plan.estimateUsd.expected) : null);
      const net0 = fs.existsSync(NET_LOG) ? fs.readFileSync(NET_LOG, 'utf8').length : 0;
      const title = '[E2E Flujo completo E11] Contabilidad de Costos';
      const cr = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title });
      ok(cr.status === 201, 'E11: curso dinámico creado', { s: cr.status, e: cr.error });
      const courseId = Number(cr.data.id);

      // 1. Microcurrículo → contexto académico (determinista, sin proveedores) → guardado.
      const ex = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'microcurriculo.docx', dataBase64: (await AF.fixture('consistent', 'docx')).toString('base64') }] });
      ok(ex.status === 200 && ex.data.stats.providersCalled === 0 && ex.data.validation.canProceed, 'E11: microcurrículo → contexto académico (0 proveedores)', { s: ex.status, e: ex.error });
      const sv = await api('POST', `/courses/${courseId}/profiles/academic`, { data: ex.data.draft, expectedVersion: 0 });
      ok(sv.status === 201, 'E11: contexto académico guardado (versión 1)', { s: sv.status, e: sv.error });
      const dz = (await api('GET', `/courses/${courseId}/academic-context/design`)).data;
      const prop = dz.structureProposal;

      // 2. Estructura del microcurrículo (lo que hace «Proponer estructura»).
      let st = await readStructure(courseId);
      let counter = st.structureVersionCounter;
      for (const m of st.modules) counter = (await api('DELETE', `/courses/${courseId}/modules/${m.id}`, { expectedCounter: counter })).data.structureVersionCounter;
      const setg = await api('PATCH', `/courses/${courseId}/structure-settings`, { finalExam: true, activityEngine: 'h5p', expectedCounter: counter });
      counter = setg.data.structureVersionCounter;
      for (const pm of prop.modules) {
        const cm = await api('POST', `/courses/${courseId}/modules`, { title: pm.title, objective: pm.objective, examEnabled: true, expectedCounter: counter });
        if (cm.status !== 201) throw new Error(`E11 módulo: ${cm.status} ${cm.error}`);
        counter = cm.data.structureVersionCounter;
        const auto = cm.data.module.chapters || [];
        for (let ci = 0; ci < pm.chapters.length; ci++) {
          const pc = pm.chapters[ci];
          const body = { title: pc.title, objective: pc.objective || `Aplicar ${pc.title.toLowerCase()}`, videoEnabled: pc.videoEnabled, activityEnabled: pc.activityEnabled, ...(pc.description ? { description: pc.description } : {}), ...(pc.outcomeIds.length ? { outcomeIds: pc.outcomeIds } : {}), expectedCounter: counter };
          const r = ci === 0 && auto.length === 1 ? await api('PATCH', `/courses/${courseId}/modules/${cm.data.module.id}/chapters/${auto[0].id}`, body) : await api('POST', `/courses/${courseId}/modules/${cm.data.module.id}/chapters`, body);
          if (![200, 201].includes(r.status)) throw new Error(`E11 capítulo ${pc.title}: ${r.status} ${r.error}`);
          counter = r.data.structureVersionCounter;
        }
      }
      const A = D('modules/course-profiles/course-profiles.js');
      const assessment = { ...A.defaultAssessmentProfile({ finalExam: true }), passingGrade: 70 };
      ok((await api('POST', `/courses/${courseId}/profiles/assessment`, { data: assessment })).status === 201, 'E11: perfil de evaluación');
      ok((await api('POST', `/courses/${courseId}/profiles/presentation`, { data: { themeFamily: 'aula-clara', mode: 'light', brandSeed: null, themeVersion: 1 } })).status === 201, 'E11: perfil de presentación');

      // 3. Enfoque (el docente lo elige sobre la sugerencia del contexto) + 64 h.
      const profile1 = { ...dz.profileSuggestion.profile, primaryApproach: 'competencias', secondaryApproaches: [], targetHours: 64 };
      const pg1 = await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: profile1, expectedVersion: 0 });
      ok(pg1.status === 201, 'E11: enfoque competencias + 64 h guardados', { s: pg1.status, e: pg1.error });

      // 4. «Cursia recomienda»: cada número sale del diseño materializado (Manifest), nunca de otra cuenta.
      const card = (dr) => {
        const d = dr.distribution;
        const t = d.materialized.totals;
        ok(d.materialized.manifestErrors.length === 0, 'E11: diseño materializado sin errores (DISTRIBUTION_MODEL_MISMATCH incluido)', d.materialized.manifestErrors);
        eq([d.counts.chapters, d.counts.videoChapters, d.counts.applicationActivities, d.counts.evaluations, d.estimatedHours],
          [t.experienceCount, t.videoCount, t.applicationActivityCount, t.examCount + t.finalExamCount, d.materialized.generableHours], 'E11: tarjeta = Manifest materializado (capítulos, videos, Actividades de Aplicación, evaluaciones, horas)');
        ok(d.materialized.providers.byCategory && d.materialized.providers.assumptions.length >= 3 && Number(d.materialized.providers.estimateUsd.min) < Number(d.materialized.providers.estimateUsd.expected),
          'E11: costo con rango, desglose y supuestos (estimación, no precio)', d.materialized.providers.byCategory);
        return d;
      };
      const dr1 = await api('POST', `/courses/${courseId}/pedagogy/dry-run`, {});
      ok([200, 201].includes(dr1.status), 'E11: «Cursia recomienda» (dry-run) → OK', { s: dr1.status, e: dr1.error });
      const d1 = card(dr1.data);
      ok(d1.status === 'within_tolerance' && d1.targetHours === 64, `E11: 64 h dentro de la tolerancia (${d1.estimatedHours} h)`, { st: d1.status, h: d1.estimatedHours });

      // 5. Ajustar (énfasis en profundidad) → nuevo diseño, distinto, con la misma garantía.
      const profile2 = { ...profile1, designPreferences: { emphasis: 'depth' } };
      const pg2 = await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: profile2, expectedVersion: 1 });
      ok(pg2.status === 201, 'E11: «Ajustar» guardado (énfasis profundidad)', { s: pg2.status, e: pg2.error });
      const dr2 = await api('POST', `/courses/${courseId}/pedagogy/dry-run`, {});
      const d2 = card(dr2.data);
      ok(d2.proposalSha256 !== d1.proposalSha256 && d2.policy.kind === 'depth_first', 'E11: «Ajustar» produce un diseño nuevo (política de profundidad)', { p: d2.policy.kind });

      // 6. Aplicar diseño: la huella vieja da 409; la nueva aplica.
      st = await readStructure(courseId);
      const stale = await api('POST', `/courses/${courseId}/modules/apply-distribution`, { expectedCounter: st.structureVersionCounter, proposalSha256: d1.proposalSha256 });
      ok(stale.status === 409 && /PROPOSAL_CHANGED/.test(String(stale.error)), 'E11: aplicar el diseño anterior al «Ajustar» → 409 PROPOSAL_CHANGED', { s: stale.status, e: stale.error });
      const ap = await api('POST', `/courses/${courseId}/modules/apply-distribution`, { expectedCounter: st.structureVersionCounter, proposalSha256: d2.proposalSha256 });
      ok([200, 201].includes(ap.status), 'E11: «Aplicar diseño» → estructura con práctica y Actividades de Aplicación', { s: ap.status, e: ap.error });

      // 7. Blueprint + Manifest congelados = lo que mostró la vista previa (preview = generación).
      st = await readStructure(courseId);
      const lock = await api('POST', `/courses/${courseId}/blueprints`, { expectedCounter: st.structureVersionCounter });
      ok(lock.status === 201, 'E11: lock → Blueprint', { s: lock.status, e: lock.error });
      const snap = lock.data.blueprint.snapshot;
      const n = lock.data.blueprint.blueprintNumber;
      const man = await api('POST', `/courses/${courseId}/blueprints/${n}/manifest`);
      ok(man.status === 201 && man.data.manifest.rulesVersion === 3, 'E11: Manifest v3', { s: man.status, e: man.error });
      const M = man.data.manifest.manifest;
      const hoursFrozen = STI.estimateCourseStudyTime(MIN.studyTimeInputFromManifest(M, snap)).courseEstimatedHours;
      eq([M.totals.experienceCount, M.totals.videoCount, M.totals.applicationActivityCount, M.totals.examCount + M.totals.finalExamCount, hoursFrozen],
        [d2.counts.chapters, d2.counts.videoChapters, d2.counts.applicationActivities, d2.counts.evaluations, d2.estimatedHours], 'E11: lo congelado = «Cursia recomienda» después de Ajustar (capítulos, videos, actividades, evaluaciones, horas)');
      ok(Math.abs(usd(DRY.providerPlanFor(M)) - usd(d2.materialized.providers)) < 0.005, 'E11: costo del Manifest congelado = costo mostrado', { frozen: usd(DRY.providerPlanFor(M)), shown: usd(d2.materialized.providers) });
      ok(snap.course.academicContext && snap.course.pedagogy && snap.course.targetHours === 64, 'E11: Blueprint con contexto académico, diseño pedagógico y 64 h');

      // 8. Actividades de Aplicación: una por capítulo marcado, con sus minutos; ninguna en un capítulo sin marca.
      const apps = M.items.filter((i) => i.type === 'application_activity');
      const marked = M.modules.flatMap((m) => m.chapters).filter((c) => c.applicationMinutes !== undefined);
      eq(apps.map((i) => i.chapterId).sort(), marked.map((c) => c.chapterId).sort(), `E11: ${apps.length} Actividades de Aplicación, una por capítulo marcado`);
      ok(marked.some((c) => c.kind === 'practice'), 'E11: también en capítulos de práctica');

      // 9. Coherencia del diseño congelado.
      const co = (await api('POST', `/courses/${courseId}/pedagogy/dry-run`, {})).data.alignment;
      ok(co && co.available === true && co.outcomes.length === 8 && co.counts.critical === 0, 'E11: coherencia: 6 RA + 2 competencias, 0 críticos', co && co.counts);

      // 10. Costo simulado antes de generar = el del Manifest (USD 0 gastado).
      const pre = await api('POST', `/courses/${courseId}/change-impact`, {});
      ok(pre.status === 200 && pre.data.available === false && pre.data.reason === 'NO_PREVIOUS_RUN' && Math.abs(usd(pre.data.fullGeneration) - usd(DRY.providerPlanFor(M))) < 0.005,
        'E11: sin generar aún → el impacto ofrece el costo de generarlo completo (= Manifest)', { s: pre.status, d: pre.data && pre.data.reason });

      // 11. Generación completa con proveedores FALSOS (Videogen local, Gamma/TTS mock, LLM falso).
      const mods = st.modules;
      llm.st.courseId = courseId;
      llm.st.chapterByTitle.clear(); llm.st.moduleByTitle.clear(); llm.st.moduleOfChapter.clear();
      for (const m of mods) { llm.st.moduleByTitle.set(m.title, m.id); for (const x of m.chapters) { llm.st.chapterByTitle.set(x.title, x.id); llm.st.moduleOfChapter.set(x.id, m.id); } }
      const ctx = { nombre: title, ...CTX, scormTemplateIds: S.templates };
      const body = { ...ctx, videoMode: 'real', providerModes: { presentation: 'mock', audio: 'mock' } };
      let start = await api('POST', `/courses/${courseId}/blueprints/${n}/manifest/runs`, body);
      const estM = /estimateId=([0-9a-f-]{36})/.exec(String(start.error || ''));
      if (start.status === 409 && estM) {
        await q(`insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, decision, approved_by, reason)
                 values ($1, $2, 1000, 'ADMIN_APPROVED', 'e2e-admin@cursia.test', 'e2e E11: aprobación del run (proveedores FALSOS locales)')`, [courseId, estM[1]]);
        start = await api('POST', `/courses/${courseId}/blueprints/${n}/manifest/runs`, body);
      }
      ok(start.status === 201, 'E11: run creado (Videogen falso, Gamma/TTS mock)', { s: start.status, e: start.error });
      if (start.status !== 201) throw new Error(`E11: run no creado: ${start.status} ${start.error}`);
      const runA = start.data.run.id;
      llm.st.tag = 'E11';
      S.front.DYN_EXAM_BANK_MODE_ENABLED = false;
      let stt = await waitRunTerminal(S.front.dynExecutorStart({ courseId, blueprintNumber: n, runId: runA }), 'E11 run', undefined, runA);
      const itemsA = await waitItemsDone(runA);
      ok(stt.failed === 0 && !stt.fatalError && itemsA.every((i) => i.status === 'completed'), `E11: los ${itemsA.length} items generados sin fallos`, itemsA.filter((i) => i.status !== 'completed').map((i) => [i.item_key, i.status, (i.error_message || '').slice(0, 200)]));
      ok(llm.st.unknown.length === 0, 'E11: LLM falso sin prompts no reconocidos', llm.st.unknown);
      eq(itemsA.map((i) => i.item_key).sort(), M.items.map((i) => i.key).sort(), 'E11: items generados = items del Manifest');

      // 12. Empaque (.mbz) con solucionarios ocultos y prohibidos al estudiante.
      const P1 = await packageRun('E11', courseId, n, runA);
      const z1 = await JSZip.loadAsync(P1.buf);
      const solDirs = [];
      for (const f of Object.keys(z1.files).filter((x) => /^activities\/page_\d+\/module\.xml$/.test(x))) {
        if (/:application_solution<\/idnumber>/.test(await z1.file(f).async('string'))) solDirs.push(f.replace('/module.xml', ''));
      }
      const solOk = await Promise.all(solDirs.map(async (d) => /<roleid>5<\/roleid>\s*<capability>mod\/page:view<\/capability>\s*<permission>-1000<\/permission>/.test(await z1.file(`${d}/roles.xml`).async('string'))));
      ok(solDirs.length === apps.length && solOk.every(Boolean), `E11: ${solDirs.length} solucionarios con mod/page:view PROHIBIDO al estudiante`);

      // 13. Impacto de un cambio (un capítulo) = lo que después se regenera de verdad.
      const m0 = st.modules[0];
      const ch = m0.chapters.find((c) => c.kind !== 'practice');
      const newTitle = `${ch.title} (revisado)`;
      let st2 = await readStructure(courseId);
      const up = await api('PATCH', `/courses/${courseId}/modules/${m0.id}/chapters/${ch.id}`, { title: newTitle, expectedCounter: st2.structureVersionCounter });
      ok(up.status === 200, 'E11: el docente edita el título de un capítulo', { s: up.status, e: up.error });
      llm.st.chapterByTitle.set(newTitle, ch.id);
      const imp = await api('POST', `/courses/${courseId}/change-impact`, {});
      const I = imp.data && imp.data.impact;
      // Cambia ESE capítulo y, por dependencia, las prácticas de SU módulo (integran los contenidos del módulo); nada más.
      const practiceOfM0 = new Set(m0.chapters.filter((c) => c.kind === 'practice').map((c) => c.id));
      const changedCh = I ? I.chapters.filter((c) => !c.untouched).map((c) => c.chapterId) : [];
      ok(imp.status === 200 && imp.data.fromRunId === runA && changedCh.includes(ch.id) && changedCh.every((id) => id === ch.id || practiceOfM0.has(id)) && I.toRun.some((k) => k === `content:${ch.id}`) && Number(I.estimatedChangeCostUsd) > 0,
        'E11: impacto: cambian ese capítulo y las prácticas de su módulo (dependen de él); nada más; costo estimado > 0', I && { changed: changedCh.length, practiceInModule: practiceOfM0.size, toRun: I.toRun.length, usd: I.estimatedChangeCostUsd });
      st2 = await readStructure(courseId);
      const lock2 = await api('POST', `/courses/${courseId}/blueprints`, { expectedCounter: st2.structureVersionCounter });
      const n2 = lock2.data.blueprint.blueprintNumber;
      const man2 = await api('POST', `/courses/${courseId}/blueprints/${n2}/manifest`);
      ok(lock2.status === 201 && man2.status === 201, 'E11: nueva versión congelada (Blueprint + Manifest)', { l: lock2.status, m: man2.status });
      const plan = await api('GET', `/courses/${courseId}/blueprints/${n2}/manifest/invalidation-plan?fromRun=${runA}`);
      const regen = plan.data.plan.actions.filter((a) => a.inTargetManifest && (a.action === 'REGENERATE' || a.action === 'GENERATE')).map((a) => a.itemKey).sort();
      eq(regen, [...I.toRun, ...I.paidNew, ...I.paidRetry].sort(), 'E11: el plan real de regeneración = el impacto previsto (mismos items)');
      eq(plan.data.costEstimate.estimatedChangeCostUsd, I.estimatedChangeCostUsd, 'E11: «Generar solo lo que cambió» muestra el mismo costo que el impacto');

      // 14. Regeneración parcial real: solo los items del plan tienen una generación nueva.
      let runB = await api('POST', `/courses/${courseId}/blueprints/${n2}/manifest/runs`, { fromRun: runA });
      const estB = /estimateId=([0-9a-f-]{36})/.exec(String(runB.error || ''));
      if (runB.status === 409 && estB) {
        await q(`insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, decision, approved_by, reason)
                 values ($1, $2, 1000, 'ADMIN_APPROVED', 'e2e-admin@cursia.test', 'e2e E11: regeneración parcial (LLM falso)')`, [courseId, estB[1]]);
        runB = await api('POST', `/courses/${courseId}/blueprints/${n2}/manifest/runs`, { fromRun: runA });
      }
      ok(runB.status === 201 && runB.data.invalidation && runB.data.invalidation.planSha256 === plan.data.plan.planSha256, 'E11: regeneración parcial creada con el plan previsto (planSha256)', { s: runB.status, e: runB.error });
      const runBId = runB.data.run.id;
      const calls0 = llm.st.v3calls.length;
      stt = await waitRunTerminal(S.front.dynExecutorStart({ courseId, blueprintNumber: n2, runId: runBId }), 'E11 regeneración', undefined, runBId);
      const itemsB = await waitItemsDone(runBId);
      ok(stt.failed === 0 && !stt.fatalError, 'E11: la regeneración parcial terminó sin fallos', stt);
      const generatedB = itemsB.filter((i) => i.status === 'completed' && !(i.output_summary && i.output_summary.carriedFrom)).map((i) => i.item_key);
      ok(regen.every((k) => itemsB.some((i) => i.item_key === k && i.status === 'completed')), 'E11: cada item del plan quedó regenerado', regen.filter((k) => !itemsB.some((i) => i.item_key === k && i.status === 'completed')));
      ok(llm.st.v3calls.length - calls0 > 0 && llm.st.v3calls.length - calls0 <= regen.length * 3, `E11: solo se llamó al LLM para lo que cambió (${llm.st.v3calls.length - calls0} llamadas para ${regen.length} items)`);
      void generatedB;
      const P2 = await packageRun('E11-regen', courseId, n2, runBId);
      const z2 = await JSZip.loadAsync(P2.buf);
      const titles = await Promise.all(Object.keys(z2.files).filter((x) => /^sections\/section_\d+\/section\.xml$/.test(x)).map((f) => z2.file(f).async('string')));
      ok(titles.some((x) => x.includes(newTitle.replace(/&/g, '&amp;'))), 'E11: el re-empaque lleva el capítulo editado');
      ok(fs.existsSync(NET_LOG) && fs.readFileSync(NET_LOG, 'utf8').length === net0, 'E11: 0 conexiones fuera de 127.0.0.1 en todo el flujo (netguard)');
      const reviewIds = (P) => ((P.job.output_summary || {}).h5pPackages || []).filter((p) => /^review_cards:/.test(p.itemKey)).map((p) => p.itemKey.slice('review_cards:'.length));
      const modsOf = async () => (await readStructure(courseId)).modules.map((m) => ({ id: m.id, title: m.title, chapters: m.chapters.map((x) => ({ id: x.id, title: x.title })) }));
      const modsB = await modsOf();
      const modsA = modsB.map((m) => ({ ...m, chapters: m.chapters.map((x) => (x.id === ch.id ? { ...x, title: ch.title } : x)) }));
      const info = (manifest, P, modules) => ({ courseId, spec: { passing: 70, engine: 'h5p' }, assessment, manifestModules: manifest.modules, features: manifest.features, applications: apps.length, reviewCardsChapterIds: reviewIds(P), modules });
      results.courses.E11 = { ...info(M, P1, modsA), blueprintNumber: n, runId: runA, items: itemsA.length, hours: hoursFrozen, usd: usd(DRY.providerPlanFor(M)), adjust: { from: d1.proposalSha256, to: d2.proposalSha256 } };
      results.courses.E11regen = { ...info(man2.data.manifest.manifest, P2, modsB), blueprintNumber: n2, runId: runBId, regenerated: regen.length, usd: I.estimatedChangeCostUsd };
    }, { fatal: false });

    // ═══ LOOP 8.0 · E12 — el microcurrículo manda sobre la estructura (hallazgo O1), por HTTP real: la IA armó la
    // estructura → el documento la reemplaza sin preguntar; con cambios del docente → 409 hasta confirmar.
    if (RUN_E5) await step('v3-E12-microcurriculo-manda', async () => {
      const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));
      const cr = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: '[E2E E12] Contabilidad de Costos' });
      ok(cr.status === 201, 'E12: curso dinámico creado', { s: cr.status, e: cr.error });
      const courseId = Number(cr.data.id);
      // Esqueleto del editor (R8) y la propuesta de la IA tal como la aplica 48: 4 módulos con mutaciones sueltas.
      let counter = (await readStructure(courseId)).structureVersionCounter;
      const sk = await api('POST', `/courses/${courseId}/modules`, { title: 'Módulo 1', expectedCounter: counter });
      counter = sk.data.structureVersionCounter;
      let st = await readStructure(courseId);
      ok(st.structureAuthority && st.structureAuthority.pristine === true && st.structureAuthority.replaceReasons.length === 0, 'E12: esqueleto vacío → reemplazable sin preguntar', st.structureAuthority);
      counter = (await api('PATCH', `/courses/${courseId}/modules/${st.modules[0].id}`, { title: 'IA módulo 1', objective: 'Objetivo propuesto por la IA', expectedCounter: counter })).data.structureVersionCounter;
      for (let i = 2; i <= 4; i++) counter = (await api('POST', `/courses/${courseId}/modules`, { title: `IA módulo ${i}`, objective: 'Objetivo propuesto por la IA', expectedCounter: counter })).data.structureVersionCounter;
      const badSrc = await api('POST', `/courses/${courseId}/modules/structure-origin`, { source: 'academic_context', expectedCounter: counter });
      ok(badSrc.status === 400, 'E12: el cliente no puede declarar el origen «academic_context» (DTO)', { s: badSrc.status, e: badSrc.error });
      const ro = await api('POST', `/courses/${courseId}/modules/structure-origin`, { source: 'ai_proposal', expectedCounter: counter });
      ok(ro.status === 200 && ro.data.structureVersionCounter === counter, 'E12: origen IA registrado sin cambiar el contador', { s: ro.status, e: ro.error });
      st = await readStructure(courseId);
      eq([st.modules.length, st.structureAuthority.source, st.structureAuthority.untouched, st.structureAuthority.replaceReasons], [4, 'ai_proposal', true, []], 'E12: estructura de la IA intacta');
      // Microcurrículo → contexto guardado → su estructura reemplaza a la de la IA, en una transacción.
      const ex = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'microcurriculo.docx', dataBase64: (await AF.fixture('consistent', 'docx')).toString('base64') }] });
      const sv = await api('POST', `/courses/${courseId}/profiles/academic`, { data: ex.data.draft, expectedVersion: 0 });
      ok(sv.status === 201, 'E12: contexto académico guardado (versión 1)', { s: sv.status, e: sv.error });
      const prop = (await api('GET', `/courses/${courseId}/academic-context/design`)).data.structureProposal;
      const noVer = await api('POST', `/courses/${courseId}/modules/apply-academic-structure`, { expectedCounter: counter });
      ok(noVer.status === 400, 'E12: sin contextVersion → 400 (DTO)', { s: noVer.status });
      const ap = await api('POST', `/courses/${courseId}/modules/apply-academic-structure`, { expectedCounter: counter, contextVersion: 1 });
      ok(ap.status === 201 && ap.data.replaced.confirmed === false && ap.data.structureVersionCounter === counter + 1, 'E12: el microcurrículo reemplaza la estructura de la IA sin preguntar (un contador)', { s: ap.status, e: ap.error });
      st = await readStructure(courseId);
      eq([st.modules.length, st.modules.reduce((a, m) => a + m.chapters.length, 0), st.structureAuthority.source, st.structureAuthority.contextVersion], [prop.counts.modules, prop.counts.chapters, 'academic_context', 1], 'E12: forma y origen del documento');
      eq(st.modules.flatMap((m) => m.chapters.map((c) => c.outcomeIds || [])), prop.modules.flatMap((m) => m.chapters.map((c) => c.outcomeIds)), 'E12: vínculos a resultados del documento');
      ok(!st.modules.some((m) => /^IA /.test(m.title)), 'E12: no queda nada de la estructura de la IA');
      // El docente edita → el documento ya no la pisa sin confirmación (409, nada cambia); con confirmación, sí.
      const c0 = st.modules[0].chapters[0];
      counter = (await api('PATCH', `/courses/${courseId}/modules/${st.modules[0].id}/chapters/${c0.id}`, { title: 'Título del docente', expectedCounter: st.structureVersionCounter })).data.structureVersionCounter;
      const nc = await api('POST', `/courses/${courseId}/modules/apply-academic-structure`, { expectedCounter: counter, contextVersion: 1 });
      ok(nc.status === 409 && /^STRUCTURE_REPLACE_NEEDS_CONFIRMATION/.test(String(nc.error)), 'E12: con cambios del docente → 409 STRUCTURE_REPLACE_NEEDS_CONFIRMATION', { s: nc.status, e: nc.error });
      st = await readStructure(courseId);
      eq([st.structureVersionCounter, st.modules[0].chapters[0].title], [counter, 'Título del docente'], 'E12: el 409 no cambió nada');
      const yc = await api('POST', `/courses/${courseId}/modules/apply-academic-structure`, { expectedCounter: counter, contextVersion: 1, confirmReplace: true });
      ok(yc.status === 201 && yc.data.replaced.confirmed === true, 'E12: confirmado → reemplazada', { s: yc.status, e: yc.error });
      results.courses.E12 = { courseId, modules: prop.counts.modules, chapters: prop.counts.chapters };
    }, { fatal: false });

    // ═══ Moodle: restore + inspección + simulación de notas (4 MBZ) ═══
    const MOODLE_JOBS = ONLY_REAL_PROVIDERS ? [] : [['E1', 'E1'], ['E1-repack', 'E1repack'], ['E2', 'E2'], ['E3', 'E3']];
    // EV6 H5P v2: E5 entra al mismo restore + inspección (con los «Repaso» del paquete).
    if (results.mbz.E5) MOODLE_JOBS.push(['E5', 'E5']);
    // LOOP 7 · E11: el curso del flujo completo y su re-empaque tras la regeneración parcial.
    if (results.mbz.E11 && results.courses.E11) MOODLE_JOBS.push(['E11', 'E11']);
    if (results.mbz['E11-regen'] && results.courses.E11regen) MOODLE_JOBS.push(['E11-regen', 'E11regen']);
    const SHELL = D('modules/course-shell/index.js');
    const AS = D('package/assessment/index.js');
    const { mp3DurationSeconds } = D('package/audio/mp3-parser.js');
    const { formatDurationEs } = D('package/audio/format-duration.js');
    const PHP = process.env.PHP_BIN;
    const PHPINI = process.env.MOODLE_PHPINI;
    const kindOf = (idn) => (/:video$/.test(idn) ? 'video' : /:activity$/.test(idn) ? 'activity' : /^cv3:exam:/.test(idn) ? 'exam' : idn === 'cv3:final_exam' ? 'finalExam' : null);
    results.moodle = {};
    if (!ONLY_REAL_PROVIDERS) await step('moodle-preflight-h5p', async () => {
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
        // EV6: una sección por capítulo (la presentación del módulo arriba del primero), una por
        // evaluación de módulo, la evaluación final y, ÚLTIMO, el cierre del curso.
        const want = [];
        // UX r18 (problema 1): hero de bienvenida primero (bajo el encabezado de Moodle), foro de avisos al final.
        want.push([0, ['cv3:shell:welcome', 'cv3:shell:audio_welcome', 'cv3:shell:competencies', 'cv3:shell:methodology', 'cv3:shell:start', 'cv3:shell:forum']]);
        want.push([1, ['cv3:shell:route', 'cv3:shell:libro', 'cv3:shell:audiobook', 'cv3:shell:route_start']]); // #583: sin libro_card
        const secOfCh = {}; const secOfExam = {}; const firstSecOfMod = {};
        let sn = 2;
        // EV6 P2-B4: sin evaluación final (= sin certificado) la nota oculta para docentes de «Respuestas
        // explicadas» abre la PRIMERA sección de evaluación; cada quiz va seguido de su página.
        let examsTeacherNote = !M.features.finalExam;
        for (const mod of M.modules) {
          mod.chapters.forEach((ch, ci) => {
            const ids = ci === 0 ? [`cv3:module_intro:${mod.moduleId}`] : [];
            // EV6 H5P v2: los «Repaso» salen de los paquetes H5P del empaque (vacío en E1–E4: secuencia de siempre).
            const reviewSet = new Set(info.reviewCardsChapterIds || []);
            // LOOP 7: capítulos de práctica y Actividades de Aplicación (página + solucionario) en su lugar.
            for (const s of SHELL.chapterSlotSequence({ videoEnabled: ch.videoEnabled, activityEnabled: ch.activityEnabled, reviewCards: reviewSet.has(ch.chapterId), practice: ch.kind === 'practice', application: ch.applicationMinutes !== undefined })) {
              const role = s.startsWith('label:') ? s.slice(6) : s === 'video_h5p' ? 'video' : s;
              ids.push(`cv3:ch:${ch.chapterId}:${role}`);
            }
            // EV6 fix 1 (I1): sin examen no hay module_next (el cierre del último capítulo es el siguiente paso).
            if (ci === 0) firstSecOfMod[mod.moduleId] = sn;
            secOfCh[ch.chapterId] = sn;
            want.push([sn++, ids]);
          });
          if (mod.examEnabled) {
            secOfExam[mod.moduleId] = sn;
            const ids = [`cv3:exam_info:${mod.moduleId}`, `cv3:exam:${mod.moduleId}`, `cv3:exam_explanations:${mod.moduleId}`, `cv3:module_next:${mod.moduleId}`];
            if (examsTeacherNote) ids.unshift('cv3:shell:exams_teacher');
            examsTeacherNote = false;
            want.push([sn++, ids]);
          }
        }
        const finalSec = M.features.finalExam ? sn : null;
        if (M.features.finalExam) want.push([sn++, ['cv3:final_exam_info', 'cv3:final_exam', 'cv3:final_exam_explanations', 'cv3:final_exam_next']]);
        const closingSec = sn;
        // EV6 T3: + label oculto para docentes (activar la insignia-certificado) al final del cierre;
        // fix round 1b: el certificado existe SOLO con evaluación final.
        want.push([closingSec, M.features.finalExam ? ['cv3:shell:closing', 'cv3:shell:certificate_teacher'] : ['cv3:shell:closing']]);
        eq((o.badges || []).length, M.features.finalExam ? 1 : 0, `${label}: insignia-certificado ${M.features.finalExam ? 'presente (hay evaluación final)' : 'ausente (sin evaluación final)'}`);
        eq(o.sections.map((s) => [s.section, s.cms.map((c) => c.idnumber)]), want, `${label}: secciones × actividades por UUID = orden del ensamblador de capítulo (una sección por capítulo / evaluación)`);
        const secIdx = (idn) => o.sections.findIndex((s) => s.cms.some((c) => c.idnumber === idn));
        ok(secIdx('cv3:shell:closing') === o.sections.length - 1 && (!M.features.finalExam || secIdx('cv3:final_exam') < secIdx('cv3:shell:closing')),
          `${label}: el cierre del curso es la última sección y va DESPUÉS de la evaluación final`, o.sections.map((s) => s.name));
        eq(o.courseFormat, { format: 'topics', coursedisplay: 1 }, `${label}: formato topics, una sección por página (coursedisplay = 1)`);
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
        const lb = (cm['cv3:shell:libro'] || { files: [] }).files.find((f) => /^libro_guia_.*\.pdf$/.test(f.name));
        // r19 L (3.13.0): el Libro Guía restaurado es un PDF real (application/pdf, firma %PDF-).
        if (lb) { const lbb = await blobByHash(lb.hash); ok(lb.mime === 'application/pdf' && lbb && lbb.subarray(0, 5).toString() === '%PDF-', `${label}: el Libro Guía restaurado es un PDF`, { mime: lb.mime }); }
        ok(aw && ab && lb, `${label}: audio de bienvenida, audiolibro y Libro Guía restaurados`, { aw, ab, lb });
        // LOOP 7 (A4 I1/I2): con un ESTUDIANTE y un DOCENTE reales en el curso restaurado: el estudiante ve su Actividad
        // de Aplicación y NO el solucionario — tampoco si un docente lo muestra por error (override PROHIBIT); el docente sí.
        if (info.applications) {
          const vPath = path.join(V3OUT, `moodle-${label}.app.json`);
          const vr = spawnSync(PHP, ['-c', PHPINI, path.join(REPO, 'scripts/moodle/v21-application-visibility.php'), inPath, vPath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
          ok(vr.status === 0, `${label}: chequeo de visibilidad con usuarios reales sin error`, (vr.stderr || '').slice(-400));
          const v = JSON.parse(fs.readFileSync(vPath, 'utf8'));
          const bad = v.pages.filter((p) => {
            const sol = /:application_solution$/.test(p.idnumber);
            return JSON.stringify([p.visible, p.studentVisible, p.studentCanView, p.teacherVisible]) !== JSON.stringify(sol ? [0, false, false, true] : [1, true, true, true]) || p.files.length !== 1;
          }).map((p) => p.idnumber);
          eq([v.pages.length, bad], [2 * info.applications, []], `${label}: ${info.applications} Actividades de Aplicación visibles al estudiante con su PDF; solucionarios ocultos`);
          const leak = v.shownByMistake.filter((x) => !(x.visible === 1 && x.studentOverride === -1000 && !x.studentHasView && !x.studentCanOpen && x.teacherCanOpen)).map((x) => x.idnumber);
          eq([v.shownByMistake.length, leak], [info.applications, []], `${label}: solucionario mostrado por error → el estudiante NO puede abrirlo ni su PDF; el docente sí`);
        }
        const labels = spawnSync(PHP, ['-c', PHPINI, path.join(HERE, 'moodle-v3-labels.php'), process.env.MOODLE_ROOT, String(courseid)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        const L = JSON.parse((labels.stdout || '{}').split('\n').find((l) => l.startsWith('{')) || '{}');
        ok(labels.status === 0 && L.labels, `${label}: textos de labels leídos de la DB`, (labels.stderr || '').slice(0, 300));
        // Guiones suaves (&shy;) que el shell inserta en palabras largas: no son parte del texto que se busca.
        const text = (idn) => ((L.labels || {})[idn] || '').replace(/<[^>]+>/g, ' ').replace(/&shy;|\u00ad/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
        if (aw && ab) {
          const awS = mp3DurationSeconds(await blobByHash(aw.hash));
          const abS = mp3DurationSeconds(await blobByHash(ab.hash));
          ok(text('cv3:shell:audio_welcome').includes(formatDurationEs(awS)), `${label}: el label del audio de bienvenida muestra la duración MEDIDA (${formatDurationEs(awS)})`, text('cv3:shell:audio_welcome').slice(0, 300));
          ok(text('cv3:shell:audiobook').includes(formatDurationEs(abS)), `${label}: el label del audiolibro muestra la duración total MEDIDA (${formatDurationEs(abS)})`, text('cv3:shell:audiobook').slice(0, 300));
          results.moodle[label].audio = { welcomeSec: awS, audiobookSec: abS };
        }
        const pres = cms.filter((c) => /:presentation$/.test(c.idnumber));
        // Motor de carga horaria: los capítulos de práctica no tienen presentación.
        const contentFlags = chFlags.filter((c) => c.kind !== 'practice');
        ok(pres.length === contentFlags.length && pres.every((c) => JSON.stringify(c.files.map((f) => f.mime).sort()) === JSON.stringify(['application/pdf', 'image/png'])), `${label}: ${contentFlags.length} tarjetas Gamma con portada PNG + PDF`, pres.map((c) => c.files.map((f) => f.mime)));
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
        // M4: la ruta de aprendizaje lista, por capítulo, exactamente sus recursos (V/A).
        const route = text('cv3:shell:route');
        const titleOf = Object.fromEntries(info.modules.flatMap((m) => m.chapters).map((x) => [x.id, x.title]));
        const routeBad = [];
        for (const ch of chFlags) {
          const t0 = route.indexOf(titleOf[ch.chapterId]);
          if (t0 < 0) { routeBad.push(`${ch.chapterId.slice(0, 8)}: no está en la ruta`); continue; }
          const rest = route.slice(t0 + titleOf[ch.chapterId].length);
          const seg = rest.slice(0, Math.max(0, rest.search(/Capítulo \d|Módulo \d|Evaluación|Examen/)) || rest.length);
          if (/video interactivo/.test(seg) !== ch.videoEnabled) routeBad.push(`${titleOf[ch.chapterId]}: video ${ch.videoEnabled}`);
          if (/actividad práctica/.test(seg) !== ch.activityEnabled) routeBad.push(`${titleOf[ch.chapterId]}: actividad ${ch.activityEnabled}`);
        }
        eq(routeBad, [], `${label}: la ruta de aprendizaje lista por capítulo exactamente video/actividad según sus flags`);
        // Edu EV3: los botones de navegación quedan como URLs reales de Moodle tras restaurar
        // (tokens decodificados por el restore): actividad, evaluación y sección siguiente.
        const hrefs = (idn) => Array.from(((L.labels || {})[idn] || '').matchAll(/href="([^"]+)"/g), (m) => m[1]);
        const ctaBad = [];
        for (const [idn, html] of Object.entries(L.labels || {})) if (/cursia-cta:|\$@[A-Z]/.test(html)) ctaBad.push(`${idn}: marcador o token sin resolver`);
        for (const ch of chFlags) {
          if (!ch.activityEnabled) continue;
          const hs = hrefs(`cv3:ch:${ch.chapterId}:activity_instruction`);
          // UX r18 (problema 4): SCORM se abre aparte → «Iniciar actividad» con enlace a la actividad; H5P va embebida
          // justo debajo → la instrucción NO lleva enlace a la actividad y el intro de la actividad conserva su
          // respaldo «Ábrela en su propia página →» (enlace real a /mod/h5pactivity/view.php tras restaurar).
          const actCm = cms.find((c) => c.idnumber === `cv3:ch:${ch.chapterId}:activity`);
          if (actCm && actCm.modname === 'h5pactivity') {
            if (hs.some((h) => /\/mod\/h5pactivity\/view\.php\?id=\d+$/.test(h))) ctaBad.push(`${ch.chapterId.slice(0, 8)}: «Iniciar actividad» hacia la actividad H5P que ya está embebida (${hs.join(' ')})`);
            if (!hrefs(`cv3:ch:${ch.chapterId}:activity`).some((h) => /\/mod\/h5pactivity\/view\.php\?id=\d+$/.test(h))) ctaBad.push(`${ch.chapterId.slice(0, 8)}: el intro de la actividad H5P perdió el respaldo «Ábrela en su propia página»`);
          } else if (!hs.some((h) => /\/mod\/scorm\/view\.php\?id=\d+$/.test(h))) ctaBad.push(`${ch.chapterId.slice(0, 8)}: «Iniciar actividad» sin enlace a la actividad (${hs.join(' ')})`);
        }
        // EV6: cada botón de sección → /course/section.php?id=<id REAL de la sección destino> (exactamente uno).
        const sidOf = (num) => (o.sections.find((x) => x.section === num) || {}).id;
        const secLinks = (idn) => hrefs(idn).map((h) => /\/course\/section\.php\?id=(\d+)$/.exec(h)).filter(Boolean).map((m) => Number(m[1]));
        const navWant = { 'cv3:shell:start': firstSecOfMod[M.modules[0].moduleId], 'cv3:shell:route_start': firstSecOfMod[M.modules[0].moduleId] };
        M.modules.forEach((m, mi) => {
          if (m.examEnabled && !hrefs(`cv3:exam_info:${m.moduleId}`).some((h) => /\/mod\/quiz\/view\.php\?id=\d+$/.test(h))) ctaBad.push(`${m.moduleId.slice(0, 8)}: «Presentar evaluación» sin enlace al cuestionario`);
          const nm = M.modules[mi + 1];
          const after = nm ? firstSecOfMod[nm.moduleId] : finalSec ?? closingSec;
          if (m.examEnabled) navWant[`cv3:module_next:${m.moduleId}`] = after;
          m.chapters.forEach((ch, ci) => {
            const nc = m.chapters[ci + 1];
            navWant[`cv3:ch:${ch.chapterId}:closing`] = nc ? secOfCh[nc.chapterId] : m.examEnabled ? secOfExam[m.moduleId] : after;
          });
        });
        if (M.features.finalExam) {
          if (!hrefs('cv3:final_exam_info').some((h) => /\/mod\/quiz\/view\.php\?id=\d+$/.test(h))) ctaBad.push('evaluación final sin enlace');
          navWant['cv3:final_exam_next'] = closingSec;
        }
        for (const [idn, num] of Object.entries(navWant)) {
          const got = secLinks(idn);
          if (!(got.length === 1 && sidOf(num) && got[0] === sidOf(num))) ctaBad.push(`${idn}: botón de sección ${JSON.stringify(got)} ≠ sección ${num} (id ${sidOf(num)})`);
        }
        for (const idn of Object.keys(L.labels || {})) if (!(idn in navWant) && secLinks(idn).length) ctaBad.push(`${idn}: enlace de sección fuera de un botón de navegación`);
        for (const m of M.modules) if (!m.examEnabled && (`cv3:module_next:${m.moduleId}` in (L.labels || {}))) ctaBad.push(`${m.moduleId.slice(0, 8)}: module_next en un módulo sin examen (botón duplicado)`);
        // Fix 1 (I1): ninguna sección tiene dos botones al mismo destino.
        const dupNav = [];
        for (const sec of o.sections) {
          const seen = {};
          for (const c of sec.cms) for (const t of new Set(secLinks(c.idnumber))) (seen[t] = seen[t] || []).push(c.idnumber);
          for (const [t, ids] of Object.entries(seen)) if (ids.length > 1) dupNav.push(`sección ${sec.section} → ${t}: ${ids.join(', ')}`);
        }
        eq(dupNav, [], `${label}: ninguna sección repite un botón al mismo destino`);
        eq(ctaBad, [], `${label}: botones de navegación (actividad, evaluación, ${Object.keys(navWant).length} botones de sección — uno por cierre de capítulo) enlazan a la URL real de su destino tras el restore`);
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
        // P2-B1 (EV6 Fase 2 — exámenes): un quiz (exam/finalExam) con completionattemptsexhausted =
        // (attempts > 0) ya NO completa solo con la nota — reprobar con intentos REALES sin agotar
        // queda INCOMPLETE(0), no COMPLETE_FAIL(3) (ver P2-design.md §1). moodle-v3-grades.php escribe
        // la nota a mano (grade_update), nunca toma un intento real, así que un quiz reprobado aquí
        // nunca agota attempts y se queda INCOMPLETE; H5P/SCORM (video/activity) no dependen de
        // intentos agotados y siguen yendo directo a COMPLETE_FAIL bajo la nota aprobatoria.
        const isQuizKind = (idn) => { const k = kindOf(idn); return k === 'exam' || k === 'finalExam'; };
        for (const who of ['pass', 'fail', 'mixed']) {
          const r = so.sim[who];
          const badG = gradedList.filter((c) => r.grades[c.idnumber] !== plan[who][c.idnumber] || r.grades[c.idnumber] < 0 || r.grades[c.idnumber] > 100).map((c) => [c.idnumber, r.grades[c.idnumber]]);
          eq(badG, [], `${label} [${who}]: notas registradas en 0–100 = las simuladas`);
          const wantState = (c) => (plan[who][c.idnumber] >= passing ? 2 : isQuizKind(c.idnumber) ? 0 : 3);
          const badS = gradedList.filter((c) => r.states[c.idnumber] !== wantState(c)).map((c) => [c.idnumber, r.states[c.idnumber], plan[who][c.idnumber]]);
          eq(badS, [], `${label} [${who}]: COMPLETE_PASS(2) sobre la nota aprobatoria ${passing} / COMPLETE_FAIL(3) bajo nota sin intentos agotados (H5P, SCORM) / INCOMPLETE(0) en un quiz reprobado por nota SIN agotar intentos reales (P2-B1)`);
          const et = expectTotal(who);
          ok(r.courseTotal !== null && Math.abs(r.courseTotal - et) < 0.01, `${label} [${who}]: total ponderado del curso ${r.courseTotal} ≈ ${et.toFixed(2)}`, { got: r.courseTotal, want: et });
          if (who === 'pass') ok(r.courseComplete === true, `${label} [pass]: curso completo (criterios por actividad/examen cumplidos)`, r);
          if (who === 'fail') ok(r.courseComplete === false, `${label} [fail]: curso NO completo`, r);
          // EV6 P2-B5: «Respuestas explicadas» — una página por quiz; disponible SOLO si su quiz está aprobado
          // (con notas escritas nunca se agotan intentos: reprobado = INCOMPLETE → bloqueada).
          const pages = Object.entries(r.pages || {});
          const nQuiz = gradedList.filter((c) => isQuizKind(c.idnumber)).length;
          const badP = pages.filter(([, p]) => p.available !== (r.states[p.quiz] === 2) || p.uservisible !== p.available).map(([id, p]) => [id, p, r.states[p.quiz]]);
          ok(pages.length === nQuiz && badP.length === 0, `${label} [${who}]: ${pages.length} página(s) «Respuestas explicadas»: disponible ⇔ su quiz aprobado (P2-B5)`, { pages: r.pages, badP });
        }
        results.moodle[label].sim = so.sim;
        // P2-B1: la nota sola nunca basta para reprobar un quiz (arriba, INCOMPLETE). Para probar que
        // COMPLETE_FAIL(3) SIGUE siendo alcanzable, un usuario dedicado agota intentos REALES
        // (mod_quiz_generator, como simulate-b1.php) sobre el primer quiz calificable del curso.
        const quizForExhaust = gradedList.find((c) => isQuizKind(c.idnumber));
        if (quizForExhaust) {
          const exIn = path.join(V3OUT, `moodle-${label}.quizexhaust.in.json`);
          const exOut = path.join(V3OUT, `moodle-${label}.quizexhaust.json`);
          fs.writeFileSync(exIn, JSON.stringify({ moodleRoot: process.env.MOODLE_ROOT, courseid, idnumber: quizForExhaust.idnumber }));
          const exr = spawnSync(PHP, ['-c', PHPINI, path.join(HERE, 'moodle-v3-quiz-exhaust.php'), exIn, exOut], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
          ok(exr.status === 0 && !/warning|notice|deprecated/i.test(exr.stderr || ''), `${label}: agotar intentos REALES de ${quizForExhaust.idnumber} (PHP) sin error`, (exr.stderr || exr.stdout || '').slice(-800));
          const exo = JSON.parse(fs.readFileSync(exOut, 'utf8'));
          eq(exo.completionstate, 3, `${label}: ${quizForExhaust.idnumber} con sus ${exo.attemptsConfigured} intentos REALES agotados y reprobados → COMPLETE_FAIL(3) (P2-B1)`, exo);
          ok(exo.courseComplete === false, `${label}: curso NO completo tras agotar intentos reales de ${quizForExhaust.idnumber}`, exo);
        }
        // EV6 P2-B5: evaluaciones que certifican con intentos REALES (moodle-p2-exams.php): revisión solo
        // con nota tras un intento reprobado, «Respuestas explicadas» bloqueada → disponible al agotar (o
        // al aprobar; con intentos ilimitados solo al aprobar), curso completo solo aprobando, sorteo por
        // hoja si el examen es un banco. Usuarios propios (p2b5_*), nunca los de la simulación de notas.
        if (quizForExhaust) {
          const p2Out = path.join(V3OUT, `moodle-${label}.p2exams.json`);
          const p2 = spawnSync(PHP, ['-c', PHPINI, path.join(HERE, 'moodle-p2-exams.php'), process.env.MOODLE_ROOT, String(courseid), p2Out], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
          ok(!/warning|notice|deprecated/i.test(p2.stderr || '') && fs.existsSync(p2Out), `${label}: escenarios de evaluaciones (moodle-p2-exams.php) sin error de PHP`, (p2.stderr || p2.stdout || '').slice(-800));
          const p2o = fs.existsSync(p2Out) ? JSON.parse(fs.readFileSync(p2Out, 'utf8')) : { pass: false, failed: ['sin salida'], assertions: 0 };
          ok(p2.status === 0 && p2o.pass === true && p2o.assertions > 0, `${label}: ${p2o.assertions} aserciones de evaluaciones con intentos reales (revisión, página gated, completion del curso${Object.values(p2o.quizzes || {}).some((q) => q.mode === 'bank') ? ', sorteo por hoja' : ''})`, p2o.failed);
          const modes = Object.values(p2o.quizzes || {}).map((q) => q.mode);
          ok(modes.length > 0 && modes.every((m) => m === 'bank' || m === 'gift'), `${label}: quizzes todo-aleatorio (banco) o todo-fijo (GIFT): ${modes.join(',')}`, p2o.quizzes);
          // P2-B6: E1/E1-repack/E3 son bancos (sorteo por hoja con intentos reales); E2 sigue GIFT.
          const wantMode = info.examBank ? 'bank' : 'gift';
          ok(modes.length > 0 && modes.every((m) => m === wantMode), `${label}: todas las evaluaciones restauradas en modo ${wantMode} (${info.examBank ? 'banco generado por el ejecutor real' : 'GIFT'})`, p2o.quizzes);
          results.moodle[label].p2exams = { pass: p2o.pass, assertions: p2o.assertions, quizzes: p2o.quizzes, steps: p2o.steps };
        }
        // ── EV6 H5P v2 (E5): BS calificado y criterio; «Repaso» sin nota, por vista, fuera de los criterios ──
        if (label === 'E5') {
          const bsIdn = `cv3:ch:${info.decideChapterId}:activity`;
          const bsH = o.h5ps[bsIdn];
          ok(bsH && bsH.deploy.h5pid && bsH.deploy.library === 'H5P.BranchingScenario 1.10' && bsH.grade === 100 && bsH.enabletracking === 1, `${label}: el caso ramificado despliega (H5P.BranchingScenario 1.10, librerías del paquete con restore de administrador) y califica sobre 100`, bsH);
          const bsItem = o.items.find((i) => i.idnumber === bsIdn);
          ok(bsItem && bsItem.gradepass === 70 && bsItem.grademax === 100, `${label}: BS con ítem de calificación (aprobación 70, máximo 100)`, bsItem);
          ok(o.criteria.filter((x) => x.criteriatype === 4).some((x) => x.idnumber === bsIdn), `${label}: BS es criterio de completion del curso`, o.criteria);
          const reviews = cms.filter((c) => /:review_cards$/.test(c.idnumber));
          eq(reviews.length, (info.reviewCardsChapterIds || []).length, `${label}: ${reviews.length} «Repaso» restaurados (uno por capítulo del paquete)`);
          const badR = reviews.filter((c) => {
            const h = o.h5ps[c.idnumber];
            return !(c.completion === 2 && c.completionview === 1 && c.completionpassgrade === 0 && h && h.grade === 0 && h.enabletracking === 0
              && h.deploy.h5pid && h.deploy.library === 'H5P.Dialogcards 1.9' && !o.items.some((i) => i.idnumber === c.idnumber));
          }).map((c) => [c.idnumber, c.completion, c.completionview, o.h5ps[c.idnumber]]);
          eq(badR, [], `${label}: cada «Repaso» = Dialog Cards 1.9 desplegado, grade 0, sin tracking, sin ítem de calificación, completion por vista`);
          ok(!o.criteria.some((x) => reviews.some((r) => r.idnumber === x.idnumber)), `${label}: ningún «Repaso» es criterio de completion del curso`, o.criteria);
          ok(!Object.values((L.labels || {})).some((h) => /Repaso[^<]{0,40}calificab/i.test(h)), `${label}: ningún texto presenta el «Repaso» como calificable`);
          results.moodle[label].h5p2 = { bs: bsIdn, reviews: reviews.map((c) => ({ cmid: c.cmid, idnumber: c.idnumber })) };
        }
        results.moodle[label].cms = cms.map((c) => ({ cmid: c.cmid, idnumber: c.idnumber, modname: c.modname, visible: c.visible }));
        // EV6 (browser QA): una página por sección → el QA recorre /course/section.php?id=<id>.
        results.moodle[label].sections = o.sections.map((x) => ({ section: x.section, id: x.id, name: x.name, cmids: x.cms.map((c) => c.cmid) }));
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
    if (PFAKES) await PFAKES.close().catch(() => {});
    await db.end().catch(() => {});
    results.finishedAt = new Date().toISOString();
    results.pass = !results.aborted && Object.values(results.steps).every((s) => s.pass) && results.assertions.every((a) => a.ok);
    results.totals = { assertions: results.assertions.length, failed: results.assertions.filter((a) => !a.ok).length };
    save();
    console.log(`\nE2E V2.1 (rulesVersion 3): ${results.pass ? 'PASS' : 'FAIL'} — ${results.totals.assertions} aserciones, ${results.totals.failed} fallidas`);
    process.exit(results.pass ? 0 : 1);
  }
})();
