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
const { keepTeacherDesign } = require('./design-approval');
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
/** LOOP 8.1: versión vigente del perfil pedagógico (guardar el contexto académico lo deriva y sube la versión). */
async function pedagogyVersion(courseId) {
  const r = await api('GET', `/courses/${courseId}/profiles/pedagogy`);
  return r.status === 200 && r.data ? Number(r.data.version) : 0;
}

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
    // LOOP 8.1: con contexto académico guardado, el perfil ya se derivó (versión 1): se guarda sobre la vigente, como el panel.
    const pg = await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: C.pedagogy, expectedVersion: await pedagogyVersion(courseId) });
    ok(pg.status === 201 && pg.data.profile.designRules && pg.data.profile.designRules.engineVersion === 1, `${C.key}: POST profiles/pedagogy (${C.pedagogy.primaryApproach}) → 201 con reglas del servidor`, { s: pg.status, e: pg.error });
  }
  // R68: el docente conserva su estructura (video/Actividad fijados y sus horas) antes de aprobarla.
  await keepTeacherDesign(api, courseId, C.key);
  st = await readStructure(courseId);
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
      // R68: el perfil congelado es el del escenario + las horas que eligió el docente para conservar su estructura.
      const savedPed = (await api('GET', `/courses/${c.courseId}/profiles/pedagogy`)).data.profile;
      // (el perfil guardado sin las reglas que el servidor deriva de él)
      const frozenPed = Object.fromEntries(Object.entries(savedPed).filter(([k]) => k !== 'designRules'));
      eq(MB.validateGenerationManifestV3(M, PED.applyPedagogyToSnapshot(snap, PED.deriveDesignRules(frozenPed)), M.source), [], 'E6: el Manifest guardado valida contra el diseño recalculado del perfil');
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
      // LOOP 8.1: guardar el contexto ya derivó el perfil (64 h y resultados); el docente elige el enfoque sobre la versión vigente.
      const pv = await api('GET', `/courses/${courseId}/profiles/pedagogy`);
      ok(pv.status === 200 && pv.data.version === 1 && pv.data.profile.targetHours === 64 && pv.data.derivedFromAcademic && pv.data.derivedFromAcademic.untouched === true, 'E8: guardar el contexto derivó el perfil (64 h y resultados del documento)', { s: pv.status, v: pv.data && pv.data.version });
      const pg = await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: profile, expectedVersion: pv.data.version });
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
      // LOOP 9.2 (QA): un nombre propio nunca se pisa al aplicar el diseño.
      ok(!ap.data.adoptedTitle && snap.course.title === '[E2E Contexto E8] Contabilidad de Costos', 'E8: «Aplicar diseño» conserva el nombre propio del curso', { adopted: ap.data.adoptedTitle, t: snap.course.title });
      {
        // LOOP 9.2 (QA): un curso «Curso sin título» toma el nombre del documento al aplicar el diseño → Blueprint con nombre.
        const cr2 = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: 'Curso sin título' });
        const c2 = Number(cr2.data.id);
        let s2 = await readStructure(c2);
        if (!s2.modules.length) { await api('POST', `/courses/${c2}/modules`, { title: 'Módulo 1', examEnabled: true, expectedCounter: s2.structureVersionCounter }); s2 = await readStructure(c2); }
        await api('POST', `/courses/${c2}/profiles/academic`, { data: draft, expectedVersion: 0 });
        eq((await q(`select title from public.courses where id = $1`, [c2]))[0].title, 'Contabilidad de Costos', 'E8: guardar el contexto da nombre a un «Curso sin título» (antes de cualquier Blueprint)');
        const d2 = (await api('POST', `/courses/${c2}/pedagogy/dry-run`, {})).data.distribution;
        const a2 = await api('POST', `/courses/${c2}/modules/apply-distribution`, { expectedCounter: s2.structureVersionCounter, proposalSha256: d2.proposalSha256 });
        s2 = await readStructure(c2);
        const l2 = await api('POST', `/courses/${c2}/blueprints`, { expectedCounter: s2.structureVersionCounter });
        eq([a2.status < 300, l2.status, l2.data && l2.data.blueprint.snapshot.course.title], [true, 201, 'Contabilidad de Costos'],
          'E8: el Blueprint de un curso que empezó «Curso sin título» lleva el nombre del documento');
        // Un curso anterior a este arreglo (contexto ya guardado, todavía sin nombre) lo toma al aplicar el diseño.
        await q(`update public.courses set title = 'Curso sin título' where id = $1`, [c2]);
        s2 = await readStructure(c2);
        const d3 = (await api('POST', `/courses/${c2}/pedagogy/dry-run`, {})).data.distribution;
        const a3 = await api('POST', `/courses/${c2}/modules/apply-distribution`, { expectedCounter: s2.structureVersionCounter, proposalSha256: d3.proposalSha256 });
        eq([a3.status < 300, a3.data && a3.data.adoptedTitle], [true, 'Contabilidad de Costos'], 'E8: «Usar este diseño» también da nombre a un curso sin nombre propio');
        // QA staging: «Crear» rellenó el nombre del pedido con el del documento («inferido»): vale el nombre leído del documento.
        await q(`update public.courses set title = 'Curso sin título', metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('brief', jsonb_build_object('briefVersion', 1, 'updatedAt', now()::text, 'fields', jsonb_build_object('nombre', 'Contabilidad de Costos', 'inferidos', 'nombre'))) where id = $1`, [c2]);
        s2 = await readStructure(c2);
        const d4 = (await api('POST', `/courses/${c2}/pedagogy/dry-run`, {})).data.distribution;
        const a4 = await api('POST', `/courses/${c2}/modules/apply-distribution`, { expectedCounter: s2.structureVersionCounter, proposalSha256: d4.proposalSha256 });
        eq([a4.status < 300, a4.data && a4.data.adoptedTitle], [true, 'Contabilidad de Costos'], 'E8: con el nombre del pedido rellenado desde el documento («inferido») se adopta el nombre leído del documento');
      }
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
      await keepTeacherDesign(api, courseId, 'E8 relock'); // R68
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

    // LOOP 8.5 · Generación con proveedores FALSOS → empaque → impacto de un cambio → regeneración parcial → re-empaque.
    // Compartido por E11 (endpoints de diseño de siempre) y E17 (flujo V2); deja results.courses[tag] y [tag + 'regen'].
    const fullGenerationFlow = async (tag, { courseId, title, n, st, M, apps, assessment, hoursFrozen, net0, extra = {}, courseCtx = CTX }) => {
      const DRY = D('modules/pedagogy/dry-run.js');
      const usd = (plan) => (plan && plan.estimateUsd ? Number(plan.estimateUsd.expected) : null);
      // 11. Generación completa con proveedores FALSOS (Videogen local, Gamma/TTS mock, LLM falso).
      const mods = st.modules;
      llm.st.courseId = courseId;
      llm.st.chapterByTitle.clear(); llm.st.moduleByTitle.clear(); llm.st.moduleOfChapter.clear();
      for (const m of mods) { llm.st.moduleByTitle.set(m.title, m.id); for (const x of m.chapters) { llm.st.chapterByTitle.set(x.title, x.id); llm.st.moduleOfChapter.set(x.id, m.id); } }
      const ctx = { nombre: title, ...courseCtx, scormTemplateIds: S.templates };
      const body = { ...ctx, videoMode: 'real', providerModes: { presentation: 'mock', audio: 'mock' } };
      let start = await api('POST', `/courses/${courseId}/blueprints/${n}/manifest/runs`, body);
      const estM = /estimateId=([0-9a-f-]{36})/.exec(String(start.error || ''));
      if (start.status === 409 && estM) {
        await q(`insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, decision, approved_by, reason)
                 values ($1, $2, 1000, 'ADMIN_APPROVED', 'e2e-admin@cursia.test', 'e2e ${tag}: aprobación del run (proveedores FALSOS locales)')`, [courseId, estM[1]]);
        start = await api('POST', `/courses/${courseId}/blueprints/${n}/manifest/runs`, body);
      }
      ok(start.status === 201, `${tag}: run creado (Videogen falso, Gamma/TTS mock)`, { s: start.status, e: start.error });
      if (start.status !== 201) throw new Error(`${tag}: run no creado: ${start.status} ${start.error}`);
      const runA = start.data.run.id;
      llm.st.tag = tag;
      S.front.DYN_EXAM_BANK_MODE_ENABLED = false;
      let stt = await waitRunTerminal(S.front.dynExecutorStart({ courseId, blueprintNumber: n, runId: runA }), `${tag} run`, undefined, runA);
      const itemsA = await waitItemsDone(runA);
      ok(stt.failed === 0 && !stt.fatalError && itemsA.every((i) => i.status === 'completed'), `${tag}: los ${itemsA.length} items generados sin fallos`, itemsA.filter((i) => i.status !== 'completed').map((i) => [i.item_key, i.status, (i.error_message || '').slice(0, 200)]));
      ok(llm.st.unknown.length === 0, `${tag}: LLM falso sin prompts no reconocidos`, llm.st.unknown);
      eq(itemsA.map((i) => i.item_key).sort(), M.items.map((i) => i.key).sort(), `${tag}: items generados = items del Manifest`);

      // 12. Empaque (.mbz) con solucionarios ocultos y prohibidos al estudiante.
      const P1 = await packageRun(tag, courseId, n, runA);
      const z1 = await JSZip.loadAsync(P1.buf);
      const solDirs = [];
      for (const f of Object.keys(z1.files).filter((x) => /^activities\/page_\d+\/module\.xml$/.test(x))) {
        if (/:application_solution<\/idnumber>/.test(await z1.file(f).async('string'))) solDirs.push(f.replace('/module.xml', ''));
      }
      const solOk = await Promise.all(solDirs.map(async (d) => /<roleid>5<\/roleid>\s*<capability>mod\/page:view<\/capability>\s*<permission>-1000<\/permission>/.test(await z1.file(`${d}/roles.xml`).async('string'))));
      ok(solDirs.length === apps.length && solOk.every(Boolean), `${tag}: ${solDirs.length} solucionarios con mod/page:view PROHIBIDO al estudiante`);

      // 13. Impacto de un cambio (un capítulo) = lo que después se regenera de verdad.
      const m0 = st.modules[0];
      const ch = m0.chapters.find((c) => c.kind !== 'practice');
      const newTitle = `${ch.title} (revisado)`;
      let st2 = await readStructure(courseId);
      const up = await api('PATCH', `/courses/${courseId}/modules/${m0.id}/chapters/${ch.id}`, { title: newTitle, expectedCounter: st2.structureVersionCounter });
      ok(up.status === 200, `${tag}: el docente edita el título de un capítulo`, { s: up.status, e: up.error });
      llm.st.chapterByTitle.set(newTitle, ch.id);
      const imp = await api('POST', `/courses/${courseId}/change-impact`, {});
      const I = imp.data && imp.data.impact;
      // Cambia ESE capítulo y, por dependencia, las prácticas de SU módulo (integran los contenidos del módulo); nada más.
      const practiceOfM0 = new Set(m0.chapters.filter((c) => c.kind === 'practice').map((c) => c.id));
      const changedCh = I ? I.chapters.filter((c) => !c.untouched).map((c) => c.chapterId) : [];
      ok(imp.status === 200 && imp.data.fromRunId === runA && changedCh.includes(ch.id) && changedCh.every((id) => id === ch.id || practiceOfM0.has(id)) && I.toRun.some((k) => k === `content:${ch.id}`) && Number(I.estimatedChangeCostUsd) > 0,
        `${tag}: impacto: cambian ese capítulo y las prácticas de su módulo (dependen de él); nada más; costo estimado > 0`, I && { changed: changedCh.length, practiceInModule: practiceOfM0.size, toRun: I.toRun.length, usd: I.estimatedChangeCostUsd });
      await keepTeacherDesign(api, courseId, `${tag} relock`); // R68
      st2 = await readStructure(courseId);
      const lock2 = await api('POST', `/courses/${courseId}/blueprints`, { expectedCounter: st2.structureVersionCounter });
      const n2 = lock2.data.blueprint.blueprintNumber;
      const man2 = await api('POST', `/courses/${courseId}/blueprints/${n2}/manifest`);
      ok(lock2.status === 201 && man2.status === 201, `${tag}: nueva versión congelada (Blueprint + Manifest)`, { l: lock2.status, m: man2.status });
      const plan = await api('GET', `/courses/${courseId}/blueprints/${n2}/manifest/invalidation-plan?fromRun=${runA}`);
      const regen = plan.data.plan.actions.filter((a) => a.inTargetManifest && (a.action === 'REGENERATE' || a.action === 'GENERATE')).map((a) => a.itemKey).sort();
      eq(regen, [...I.toRun, ...I.paidNew, ...I.paidRetry].sort(), `${tag}: el plan real de regeneración = el impacto previsto (mismos items)`);
      eq(plan.data.costEstimate.estimatedChangeCostUsd, I.estimatedChangeCostUsd, `${tag}: «Generar solo lo que cambió» muestra el mismo costo que el impacto`);

      // 14. Regeneración parcial real: solo los items del plan tienen una generación nueva.
      let runB = await api('POST', `/courses/${courseId}/blueprints/${n2}/manifest/runs`, { fromRun: runA });
      const estB = /estimateId=([0-9a-f-]{36})/.exec(String(runB.error || ''));
      if (runB.status === 409 && estB) {
        await q(`insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, decision, approved_by, reason)
                 values ($1, $2, 1000, 'ADMIN_APPROVED', 'e2e-admin@cursia.test', 'e2e ${tag}: regeneración parcial (LLM falso)')`, [courseId, estB[1]]);
        runB = await api('POST', `/courses/${courseId}/blueprints/${n2}/manifest/runs`, { fromRun: runA });
      }
      ok(runB.status === 201 && runB.data.invalidation && runB.data.invalidation.planSha256 === plan.data.plan.planSha256, `${tag}: regeneración parcial creada con el plan previsto (planSha256)`, { s: runB.status, e: runB.error });
      const runBId = runB.data.run.id;
      const calls0 = llm.st.v3calls.length;
      stt = await waitRunTerminal(S.front.dynExecutorStart({ courseId, blueprintNumber: n2, runId: runBId }), `${tag} regeneración`, undefined, runBId);
      const itemsB = await waitItemsDone(runBId);
      ok(stt.failed === 0 && !stt.fatalError, `${tag}: la regeneración parcial terminó sin fallos`, stt);
      const generatedB = itemsB.filter((i) => i.status === 'completed' && !(i.output_summary && i.output_summary.carriedFrom)).map((i) => i.item_key);
      ok(regen.every((k) => itemsB.some((i) => i.item_key === k && i.status === 'completed')), `${tag}: cada item del plan quedó regenerado`, regen.filter((k) => !itemsB.some((i) => i.item_key === k && i.status === 'completed')));
      ok(llm.st.v3calls.length - calls0 > 0 && llm.st.v3calls.length - calls0 <= regen.length * 3, `${tag}: solo se llamó al LLM para lo que cambió (${llm.st.v3calls.length - calls0} llamadas para ${regen.length} items)`);
      void generatedB;
      const P2 = await packageRun(`${tag}-regen`, courseId, n2, runBId);
      const z2 = await JSZip.loadAsync(P2.buf);
      const titles = await Promise.all(Object.keys(z2.files).filter((x) => /^sections\/section_\d+\/section\.xml$/.test(x)).map((f) => z2.file(f).async('string')));
      ok(titles.some((x) => x.includes(newTitle.replace(/&/g, '&amp;'))), `${tag}: el re-empaque lleva el capítulo editado`);
      ok(fs.existsSync(NET_LOG) && fs.readFileSync(NET_LOG, 'utf8').length === net0, `${tag}: 0 conexiones fuera de 127.0.0.1 en todo el flujo (netguard)`);
      const reviewIds = (P) => ((P.job.output_summary || {}).h5pPackages || []).filter((p) => /^review_cards:/.test(p.itemKey)).map((p) => p.itemKey.slice('review_cards:'.length));
      const modsOf = async () => (await readStructure(courseId)).modules.map((m) => ({ id: m.id, title: m.title, chapters: m.chapters.map((x) => ({ id: x.id, title: x.title })) }));
      const modsB = await modsOf();
      const modsA = modsB.map((m) => ({ ...m, chapters: m.chapters.map((x) => (x.id === ch.id ? { ...x, title: ch.title } : x)) }));
      const info = (manifest, P, modules) => ({ courseId, spec: { passing: 70, engine: 'h5p' }, assessment, manifestModules: manifest.modules, features: manifest.features, applications: apps.length, reviewCardsChapterIds: reviewIds(P), modules });
      results.courses[tag] = { ...info(M, P1, modsA), blueprintNumber: n, runId: runA, items: itemsA.length, hours: hoursFrozen, usd: usd(DRY.providerPlanFor(M)), ...extra };
      results.courses[tag + 'regen'] = { ...info(man2.data.manifest.manifest, P2, modsB), blueprintNumber: n2, runId: runBId, regenerated: regen.length, usd: I.estimatedChangeCostUsd };
      return { runA, itemsA, M2: man2.data.manifest.manifest, regen, I };
    };

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
      const pg1 = await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: profile1, expectedVersion: await pedagogyVersion(courseId) });
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
      const pg2 = await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: profile2, expectedVersion: pg1.data.profile.version });
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
      // R68: E11 usa los endpoints de diseño de siempre (la vista previa con «Ajustar» no guarda el perfil): el docente
      // conserva el diseño aplicado antes de aprobarlo (sin cambios si ya coincide).
      await keepTeacherDesign(api, courseId, 'E11');
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

      // 11–14. Generación, empaque, impacto, regeneración parcial y re-empaque (compartido con E17).
      await fullGenerationFlow('E11', { courseId, title, n, st, M, apps, assessment, hoursFrozen, net0, extra: { adjust: { from: d1.proposalSha256, to: d2.proposalSha256 } } });
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
      // Review L80 M1: el origen solo lo escribe el backend de la estructura; un PATCH del curso no lo cambia.
      const pm = await api('PATCH', `/courses/${courseId}`, { metadata: { structureOrigin: { source: 'ai_proposal', counter: 0 } } });
      st = await readStructure(courseId);
      ok(pm.status === 200 && st.structureAuthority.source === 'academic_context' && st.structureAuthority.untouched === true, 'E12: un PATCH del curso no cambia el origen de la estructura', { s: pm.status, a: st.structureAuthority });
      results.courses.E12 = { courseId, modules: prop.counts.modules, chapters: prop.counts.chapters };
    }, { fatal: false });

    // ═══ LOOP 8.1 · E13 — una sola fuente de verdad + cargador único, por HTTP real (USD 0, sin proveedores).
    if (RUN_E5) await step('v3-E13-fuente-unica', async () => {
      const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));
      const cr = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: '[E2E E13] Contabilidad de Costos' });
      ok(cr.status === 201, 'E13: curso dinámico creado', { s: cr.status, e: cr.error });
      const courseId = Number(cr.data.id);
      const brief = { nombre: 'Contabilidad de Costos', obj: 'Calcular y controlar los costos de producción', sector: 'Contabilidad', pais: 'Colombia', contexto: 'Técnico / Tecnólogo — formación técnica', nivel: 'Básico — sin conocimientos previos' };
      const bad = await api('PUT', `/courses/${courseId}/brief`, { ...brief, obj: 'x'.repeat(601) });
      ok(bad.status === 400, 'E13: pedido inválido → 400 (DTO)', { s: bad.status });
      const pb = await api('PUT', `/courses/${courseId}/brief`, brief);
      ok(pb.status === 200 && pb.data.changed === true && pb.data.brief.fields.sector === 'Contabilidad', 'E13: PUT brief guarda lo que dijo el usuario', { s: pb.status, e: pb.error });
      const gb = await api('GET', `/courses/${courseId}/brief`);
      ok(gb.status === 200 && gb.data.brief.fields.obj === brief.obj, 'E13: GET brief', { s: gb.status });
      let f = await api('GET', `/courses/${courseId}/facts`);
      ok(f.status === 200 && f.data.topic.source === 'user' && f.data.educationLevel.value === 'technical' && f.data.document.present === false, 'E13: «Lo que sabemos» desde el pedido', { s: f.status, d: f.data && f.data.topic });
      // Cargador único: extracción gratuita con calidad; lectura avanzada apagada en el gate (USD 0).
      const ex = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'microcurriculo.docx', dataBase64: (await AF.fixture('consistent', 'docx')).toString('base64') }] });
      ok(ex.status === 200 && ex.data.quality && ex.data.quality.sufficient === true && ex.data.quality.advancedAvailable === false, 'E13: la extracción gratuita informa su calidad', { s: ex.status, q: ex.data && ex.data.quality });
      const pdf = (await AF.fixture('consistent', 'pdf')).toString('base64');
      const est = await api('POST', `/courses/${courseId}/academic-context/extract-advanced`, { files: [{ name: 'micro.pdf', dataBase64: pdf }], mode: 'estimate' });
      ok(est.status === 200 && est.data.available === false && est.data.providersCalled === 0 && est.data.estimateUsd.max > 0, 'E13: lectura avanzada: estimación sin proveedor (apagada en este entorno)', { s: est.status, e: est.error });
      const run = await api('POST', `/courses/${courseId}/academic-context/extract-advanced`, { files: [{ name: 'micro.pdf', dataBase64: pdf }], mode: 'run', acceptedMaxUsd: 99 });
      ok(run.status === 409 && /^ADVANCED_DISABLED/.test(String(run.error)), 'E13: apagada → 409 ADVANCED_DISABLED (nunca llama al proveedor)', { s: run.status, e: run.error });
      // Guardar el contexto deriva el perfil pedagógico solo (sin «Usar en el perfil»).
      const sv = await api('POST', `/courses/${courseId}/profiles/academic`, { data: ex.data.draft, expectedVersion: 0 });
      ok(sv.status === 201 && sv.data.derivedPedagogy && sv.data.derivedPedagogy.applied === true, 'E13: guardar el contexto deriva el perfil pedagógico', { s: sv.status, d: sv.data && sv.data.derivedPedagogy });
      const pg = await api('GET', `/courses/${courseId}/profiles/pedagogy`);
      ok(pg.status === 200 && pg.data.profile.targetHours === 64 && pg.data.derivedFromAcademic && pg.data.derivedFromAcademic.untouched === true, 'E13: perfil con las 64 h del documento, marcado como derivado', { s: pg.status, d: pg.data && pg.data.derivedFromAcademic });
      f = await api('GET', `/courses/${courseId}/facts`);
      ok(f.status === 200 && f.data.outcomes.source === 'document' && f.data.targetHours.value === 64 && f.data.pedagogy.derivedFromDocument === true, 'E13: «Lo que sabemos» con el documento como dueño', { d: f.data && { o: f.data.outcomes.source, h: f.data.targetHours } });
      // Las claves de la fuente única no se pisan con un PATCH del curso.
      const pm = await api('PATCH', `/courses/${courseId}`, { metadata: { brief: { briefVersion: 1, fields: { obj: 'pisado' } } } });
      const gb2 = await api('GET', `/courses/${courseId}/brief`);
      ok(pm.status === 200 && gb2.data.brief.fields.obj === brief.obj, 'E13: un PATCH del curso no pisa el pedido', { s: pm.status });
      results.courses.E13 = { courseId };
    }, { fatal: false });

    // ═══ LOOP 8.2 · E14 — «Lo que entendimos» sin documento: propuesta, edición y confirmación por HTTP real (USD 0:
    // la interpretación del pedido corre en el cliente; aquí solo se guarda lo interpretado).
    if (RUN_E5) await step('v3-E14-lo-que-entendimos', async () => {
      const cr = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: '[E2E E14] Excel básico' });
      ok(cr.status === 201, 'E14: curso dinámico creado', { s: cr.status, e: cr.error });
      const courseId = Number(cr.data.id);
      const pb = await api('PUT', `/courses/${courseId}/brief`, { obj: 'Quiero un curso de Excel básico para estudiantes de Administración', contexto: 'Universitario — estudiantes de pregrado universitario, con rigor académico y pensamiento crítico', sector: 'Administración', pais: 'Colombia', inferidos: 'sector,pais' });
      ok(pb.status === 200 && pb.data.brief.fields.inferidos === 'sector,pais', 'E14: el pedido guarda qué llenó Cursia', { s: pb.status, e: pb.error });
      const proposal = { expectedVersion: 0, subjectName: 'Excel básico para la gestión', learnerProfile: 'Estudiantes de primeros semestres de Administración',
        outcomes: ['Organiza datos de gestión en tablas con formato', 'Calcula indicadores con fórmulas y funciones', 'Explica cuándo usar cada tipo de gráfico'] };
      const bad = await api('POST', `/courses/${courseId}/academic-context/proposal`, { ...proposal, outcomes: [] });
      ok(bad.status === 400, 'E14: propuesta sin resultados → 400 (DTO)', { s: bad.status });
      const sp = await api('POST', `/courses/${courseId}/academic-context/proposal`, proposal);
      ok(sp.status === 200 && sp.data.created === true && sp.data.profile.version === 1 && sp.data.derivedPedagogy && sp.data.derivedPedagogy.applied === true, 'E14: propuesta guardada y perfil pedagógico derivado', { s: sp.status, e: sp.error });
      let f = await api('GET', `/courses/${courseId}/facts`);
      ok(f.status === 200 && f.data.document.present === false && f.data.document.proposed === true && f.data.outcomes.value.every((o) => o.origin === 'proposed') &&
        f.data.title.source === 'inferred' && f.data.sector.source === 'inferred' && f.data.topic.source === 'user' && f.data.conflicts.length === 0, 'E14: «Lo que sabemos» = propuesto e inferido, sin documento', { d: f.data && { doc: f.data.document, t: f.data.title, s: f.data.sector } });
      const stale = await api('POST', `/courses/${courseId}/academic-context/proposal`, proposal);
      ok(stale.status === 409 && /^ACADEMIC_CHANGED/.test(String(stale.error)), 'E14: propuesta con versión vieja → 409', { s: stale.status, e: stale.error });
      const ed = await api('PUT', `/courses/${courseId}/academic-context/outcomes`, { expectedVersion: 1, outcomes: [{ id: 'RA1', text: proposal.outcomes[0] }, { id: 'RA2', text: 'Calcula indicadores de gestión con funciones' }, { text: 'Diseña un tablero de control' }] });
      ok(ed.status === 200 && ed.data.profile.version === 2, 'E14: editar resultados crea la versión 2', { s: ed.status, e: ed.error });
      f = await api('GET', `/courses/${courseId}/facts`);
      ok(JSON.stringify(f.data.outcomes.value.map((o) => [o.id, o.origin])) === JSON.stringify([['RA1', 'proposed'], ['RA2', 'user'], ['RA4', 'user']]), 'E14: ids conservados, orígenes por resultado', { o: f.data.outcomes.value });
      const acc = await api('PUT', `/courses/${courseId}/academic-context/outcomes`, { expectedVersion: 2, accept: true, outcomes: f.data.outcomes.value.map((o) => ({ id: o.id, text: o.text })) });
      ok(acc.status === 200 && acc.data.profile.version === 3, 'E14: «Sí, usar estos» confirma (versión 3)', { s: acc.status, e: acc.error });
      f = await api('GET', `/courses/${courseId}/facts`);
      ok(f.data.document.proposed === false && f.data.outcomes.value.every((o) => o.origin === 'user'), 'E14: confirmados = escritos por el docente', { d: f.data.document });
      // El documento manda: sobre un contexto leído de un documento, la propuesta se rechaza.
      const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));
      const ex = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'microcurriculo.docx', dataBase64: (await AF.fixture('consistent', 'docx')).toString('base64') }] });
      const sv = await api('POST', `/courses/${courseId}/profiles/academic`, { data: ex.data.draft, expectedVersion: 3 });
      ok(sv.status === 201, 'E14: el documento reemplaza la propuesta confirmada', { s: sv.status, e: sv.error });
      const over = await api('POST', `/courses/${courseId}/academic-context/proposal`, { ...proposal, expectedVersion: 4 });
      ok(over.status === 409 && /^DOCUMENT_CONTEXT/.test(String(over.error)), 'E14: propuesta sobre un documento → 409 DOCUMENT_CONTEXT', { s: over.status, e: over.error });
      f = await api('GET', `/courses/${courseId}/facts`);
      ok(f.data.document.present === true && f.data.outcomes.source === 'document' && f.data.targetHours.value === 64, 'E14: ahora todo viene del documento', { d: f.data && f.data.document });
      results.courses.E14 = { courseId };
    }, { fatal: false });

    // ═══ LOOP 8.2.1 · E14b — PUT desde un NAVEGADOR real contra el backend completo (dist/main.js, su CORS real).
    // Node no aplica CORS: sin este paso, PUT /brief y PUT /outcomes «pasaban» aunque en Chrome fallaban.
    if (RUN_E5) await step('v3-E14b-navegador-put', async () => {
      const { launchChrome } = require(path.join(REPO, 'scripts/lib/v21-cdp.js'));
      const http = require('http');
      const cr = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: '[E2E E14b] PUT desde el navegador' });
      ok(cr.status === 201, 'E14b: curso dinámico creado', { s: cr.status });
      const courseId = Number(cr.data.id);
      const sp = await api('POST', `/courses/${courseId}/academic-context/proposal`, { expectedVersion: 0, subjectName: 'Excel básico', outcomes: ['Organiza datos en tablas', 'Calcula indicadores con funciones'] });
      ok(sp.status === 200, 'E14b: propuesta guardada (POST)', { s: sp.status, e: sp.error });
      const srv = await new Promise((r) => { const s = http.createServer((q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>front</title>'); }); s.listen(0, '127.0.0.1', () => r(s)); });
      let chrome = null;
      try {
        chrome = await launchChrome();
        await chrome.navigate(`http://127.0.0.1:${srv.address().port}/`);
        const r = await chrome.evaluate(`(async () => {
          const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ${TOKEN}' };
          const call = async (m, p, b) => { try { const x = await fetch(${JSON.stringify(BASE)} + p, { method: m, headers: h, body: JSON.stringify(b) }); return x.status; } catch (e) { return 'ERR:' + e.message; } };
          return {
            brief: await call('PUT', '/courses/${courseId}/brief', { obj: 'Excel básico', sector: 'Administración', pais: 'Colombia', inferidos: 'pais' }),
            outcomes: await call('PUT', '/courses/${courseId}/academic-context/outcomes', { expectedVersion: 1, accept: true, outcomes: [{ id: 'RA1', text: 'Organiza datos en tablas' }, { id: 'RA2', text: 'Calcula indicadores con funciones' }] }),
          };
        })()`);
        ok(r.brief === 200, 'E14b: PUT /brief desde Chrome (otro origen) responde 200', r);
        ok(r.outcomes === 200, 'E14b: PUT /academic-context/outcomes desde Chrome (otro origen) responde 200', r);
      } finally {
        if (chrome) chrome.close();
        srv.close();
      }
      const f = await api('GET', `/courses/${courseId}/facts`);
      ok(f.data.sector.value === 'Administración' && f.data.country.source === 'inferred' && f.data.document.proposed === false && f.data.outcomes.value.every((o) => o.origin === 'user'),
        'E14b: lo guardado desde el navegador está en «Lo que sabemos»', { d: f.data && { s: f.data.sector, c: f.data.country, p: f.data.document } });
    }, { fatal: false });

    // ═══ LOOP 8.3 · E15 — «Cursia recomienda» por HTTP real: recomendación → Ajustar → guardar → aplicar (huella) → lock →
    // Manifest = tarjeta; video fijado respetado; «Liberar». USD 0 (nada se genera).
    if (RUN_E5) await step('v3-E15-cursia-recomienda', async () => {
      const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));
      const cr = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: '[E2E E15] Contabilidad de Costos' });
      const courseId = Number(cr.data.id);
      const m0 = await api('POST', `/courses/${courseId}/modules`, { title: 'Módulo 1', expectedCounter: 0 });
      ok(m0.status === 201, 'E15: esqueleto', { s: m0.status, e: m0.error });
      const ex = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'microcurriculo.docx', dataBase64: (await AF.fixture('consistent', 'docx')).toString('base64') }] });
      const sv = await api('POST', `/courses/${courseId}/profiles/academic`, { data: ex.data.draft, expectedVersion: 0 });
      ok(sv.status === 201, 'E15: microcurrículo guardado', { s: sv.status });
      let st = await readStructure(courseId);
      const aa = await api('POST', `/courses/${courseId}/modules/apply-academic-structure`, { expectedCounter: st.structureVersionCounter, contextVersion: sv.data.profile.version });
      ok([200, 201].includes(aa.status), 'E15: estructura del documento', { s: aa.status, e: aa.error });
      const r1 = await api('POST', `/courses/${courseId}/design/recommendation`, {});
      ok(r1.status === 200 && r1.data.hours.target === 64 && r1.data.hours.source === 'document' && r1.data.approach && r1.data.approach.source === 'recommended' && r1.data.preferences.audiovisual === 'recommended',
        'E15: Cursia recomienda (64 h del documento, enfoque recomendado, audiovisual recomendado)', { s: r1.status, h: r1.data && r1.data.hours, a: r1.data && r1.data.approach });
      ok(r1.data.design && r1.data.design.applicable && r1.data.design.manifestErrors.length === 0 && r1.data.cost && Number(r1.data.cost.expected) > 0 && r1.data.providersCalled === 0,
        'E15: tarjeta aplicable, = Manifest materializado, con costo; 0 proveedores', { d: r1.data.design && r1.data.design.status });
      const less = await api('POST', `/courses/${courseId}/design/recommendation`, { adjust: { audiovisual: 'less' } });
      const more = await api('POST', `/courses/${courseId}/design/recommendation`, { adjust: { audiovisual: 'more' } });
      ok(less.data.design.counts.videoChapters < r1.data.design.counts.videoChapters && r1.data.design.counts.videoChapters <= more.data.design.counts.videoChapters
        && Math.abs(less.data.design.estimatedHours - 64) <= 3.5 && Math.abs(more.data.design.estimatedHours - 64) <= 3.5,
        'E15: Menos < Recomendado ≤ Más video, las tres con 64 h', { l: less.data.design.counts.videoChapters, r: r1.data.design.counts.videoChapters, m: more.data.design.counts.videoChapters });
      const bad = await api('POST', `/courses/${courseId}/design/recommendation`, { adjust: { audiovisual: 'mucho' } });
      ok(bad.status === 400, 'E15: Ajustar inválido → 400 (DTO)', { s: bad.status });
      // «Usar este diseño» (Menos video): guardar el perfil efectivo → misma huella → aplicar → lock → Manifest = tarjeta.
      const card = less.data;
      const pv = await api('GET', `/courses/${courseId}/profiles/pedagogy`);
      const sp = await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: card.profile, expectedVersion: pv.data.version });
      ok(sp.status === 201, 'E15: perfil del diseño guardado', { s: sp.status, e: sp.error });
      const r2 = await api('POST', `/courses/${courseId}/design/recommendation`, {});
      ok(r2.data.profileChanged === false && r2.data.design.proposalSha256 === card.design.proposalSha256, 'E15: guardado = la misma huella que la tarjeta', { a: r2.data.design.proposalSha256, b: card.design.proposalSha256 });
      st = await readStructure(courseId);
      const ap = await api('POST', `/courses/${courseId}/modules/apply-distribution`, { expectedCounter: st.structureVersionCounter, proposalSha256: card.design.proposalSha256 });
      ok([200, 201].includes(ap.status), 'E15: aplicar el diseño', { s: ap.status, e: ap.error });
      st = await readStructure(courseId);
      const lock = await api('POST', `/courses/${courseId}/blueprints`, { expectedCounter: st.structureVersionCounter });
      const man = await api('POST', `/courses/${courseId}/blueprints/${lock.data.blueprint.blueprintNumber}/manifest`);
      const T = man.data.manifest.manifest.totals;
      const c = card.design.counts;
      eq([T.experienceCount, T.videoCount, T.applicationActivityCount, T.examCount + T.finalExamCount], [c.chapters, c.videoChapters, c.applicationActivities, c.evaluations], 'E15: Manifest congelado = tarjeta «Cursia recomienda» (capítulos, videos, Actividades de Aplicación, evaluaciones)');
      // Video fijado a mano en el editor → la recomendación lo respeta; «Liberar».
      const ch = st.modules[0].chapters.find((x) => x.kind !== 'practice' && x.videoEnabled);
      const pin = await api('PATCH', `/courses/${courseId}/modules/${st.modules[0].id}/chapters/${ch.id}`, { videoEnabled: false, pinVideo: true, expectedCounter: st.structureVersionCounter });
      ok(pin.status === 200 && pin.data.videoPinned === true, 'E15: video fijado por el docente', { s: pin.status, e: pin.error });
      const r3 = await api('POST', `/courses/${courseId}/design/recommendation`, { adjust: { audiovisual: 'more' } });
      const ch3 = r3.data.design.modules[0].chapters.find((x) => x.id === ch.id);
      ok(ch3 && ch3.videoEnabled === false && ch3.videoPinned === true && r3.data.pinnedChapters === 1, 'E15: «Más video» respeta lo fijado', { ch3 });
      const cl = await api('POST', `/courses/${courseId}/design/pins/clear`, {});
      ok(cl.status === 200 && cl.data.released === 1, 'E15: «Liberar»', { s: cl.status, d: cl.data });
      results.courses.E15 = { courseId };
    }, { fatal: false });

    // ═══ LOOP 8.4 · E16 — verificación del diseño por HTTP real: hallazgos con «Corregir»; el automático vincula solo los
    // capítulos sin vínculos y la verificación queda limpia. USD 0.
    if (RUN_E5) await step('v3-E16-verificacion', async () => {
      const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));
      const cr = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: '[E2E E16] Contabilidad de Costos' });
      const courseId = Number(cr.data.id);
      const m = await api('POST', `/courses/${courseId}/modules`, { title: 'Costos', expectedCounter: 0 });
      ok(m.status === 201, 'E16: módulo', { s: m.status, e: m.error });
      let st = await readStructure(courseId);
      const mod = st.modules[0];
      const first = mod.chapters[0];
      let r = await api('PATCH', `/courses/${courseId}/modules/${mod.id}/chapters/${first.id}`, { title: 'Elementos del costo y su clasificación', expectedCounter: st.structureVersionCounter });
      for (const title of ['Costo de materiales y mano de obra', 'Sistema de costeo por órdenes de producción']) {
        st = await readStructure(courseId);
        r = await api('POST', `/courses/${courseId}/modules/${mod.id}/chapters`, { title, objective: title, expectedCounter: st.structureVersionCounter });
        ok(r.status === 201, `E16: capítulo «${title}»`, { s: r.status, e: r.error });
      }
      const ex = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'microcurriculo.docx', dataBase64: (await AF.fixture('consistent', 'docx')).toString('base64') }] });
      await api('POST', `/courses/${courseId}/profiles/academic`, { data: ex.data.draft, expectedVersion: 0 });
      const v1 = await api('POST', `/courses/${courseId}/design/recommendation`, {});
      const ver = v1.data && v1.data.verification;
      ok(v1.status === 200 && ver && ver.verificationVersion === 1 && Array.isArray(ver.checks), 'E16: la recomendación trae la verificación', { s: v1.status });
      const areas = new Set(ver.checks.map((c) => c.area));
      ok(['hours', 'outcomes', 'structure', 'activities', 'practice', 'audiovisual', 'evaluations', 'pedagogy', 'cost'].every((a) => areas.has(a)), 'E16: verifica horas, resultados, estructura, actividades, práctica, audiovisual, evaluaciones, pedagogía y costo', [...areas]);
      const auto = ver.checks.find((c) => c.fix && c.fix.kind === 'auto');
      ok(auto && auto.fix.action === 'link_outcomes', 'E16: capítulos sin vínculos → «Corregir» automático', ver.checks.filter((c) => c.severity !== 'ok').map((c) => c.title));
      st = await readStructure(courseId);
      const stale = await api('POST', `/courses/${courseId}/design/fix`, { action: 'link_outcomes', expectedCounter: st.structureVersionCounter + 3 });
      ok(stale.status === 409, 'E16: contador viejo → 409', { s: stale.status });
      const badA = await api('POST', `/courses/${courseId}/design/fix`, { action: 'borrar', expectedCounter: st.structureVersionCounter });
      ok(badA.status === 400, 'E16: acción desconocida → 400 (DTO)', { s: badA.status });
      const fx = await api('POST', `/courses/${courseId}/design/fix`, { action: 'link_outcomes', expectedCounter: st.structureVersionCounter });
      ok(fx.status === 200 && fx.data.linkedChapters >= 1 && fx.data.structureVersionCounter === st.structureVersionCounter + 1, 'E16: corregido (capítulos vinculados, contador +1)', { s: fx.status, d: fx.data });
      const v2 = await api('POST', `/courses/${courseId}/design/recommendation`, {});
      ok(!v2.data.verification.checks.some((c) => c.fix && c.fix.kind === 'auto'), 'E16: después de corregir no queda nada automático pendiente', v2.data.verification.checks.filter((c) => c.severity !== 'ok').map((c) => c.title));
      results.courses.E16 = { courseId };
    }, { fatal: false });

    // ═══ R68 (piloto) · E18 — el SERVIDOR no genera un diseño sin verificación aprobable (API directa, sin la interfaz) ═══
    if (RUN_E5) await step('v3-E18-r68-bloqueo-servidor', async () => {
      const mkCourse = async (title, docText, videos = true) => {
        const cr = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title });
        const courseId = Number(cr.data.id);
        let counter = 0;
        for (let mi = 0; mi < 2; mi++) {
          const m = await api('POST', `/courses/${courseId}/modules`, { title: `Módulo ${mi + 1} de seguridad eléctrica`, objective: 'Aplicar el procedimiento seguro', examEnabled: true, expectedCounter: counter });
          if (m.status !== 201) throw new Error(`E18 módulo: ${m.status} ${m.error}`);
          counter = m.data.structureVersionCounter;
          const mid = m.data.module.id;
          const auto = m.data.module.chapters || [];
          for (let ci = 0; ci < 2; ci++) {
            const body = { title: `Tema ${mi + 1}.${ci + 1} del bloqueo de energía`, objective: `Aplicar el paso ${ci + 1} del bloqueo y etiquetado`, videoEnabled: videos && ci === 0, expectedCounter: counter };
            const c = ci === 0 && auto.length === 1
              ? await api('PATCH', `/courses/${courseId}/modules/${mid}/chapters/${auto[0].id}`, body)
              : await api('POST', `/courses/${courseId}/modules/${mid}/chapters`, body);
            if (![200, 201].includes(c.status)) throw new Error(`E18 capítulo: ${c.status} ${c.error}`);
            counter = c.data.structureVersionCounter;
          }
        }
        // Configuración del curso (como cualquier curso v3): evaluación y presentación.
        const AP = D('modules/course-profiles/course-profiles.js');
        ok((await api('POST', `/courses/${courseId}/profiles/assessment`, { data: { ...AP.defaultAssessmentProfile({ finalExam: true }), passingGrade: 70 } })).status === 201, `E18: perfil de evaluación (${title})`);
        ok((await api('POST', `/courses/${courseId}/profiles/presentation`, { data: { themeFamily: 'aula-clara', mode: 'light', brandSeed: null, themeVersion: 1 } })).status === 201, `E18: perfil de presentación (${title})`);
        if (docText) {
          const ex = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'requisitos (sintético).txt', dataBase64: Buffer.from(docText, 'utf8').toString('base64') }] });
          ok(ex.status === 200, `E18: documento leído (${title})`, { s: ex.status, e: ex.error });
          const sv = await api('POST', `/courses/${courseId}/profiles/academic`, { data: ex.data.draft, expectedVersion: 0 });
          ok(sv.status === 201, `E18: contexto guardado (${title})`, { s: sv.status, e: sv.error });
        }
        return courseId;
      };
      const lockAndManifest = async (courseId) => {
        const st = await readStructure(courseId);
        const lock = await api('POST', `/courses/${courseId}/blueprints`, { expectedCounter: st.structureVersionCounter });
        const n = lock.data.blueprint.blueprintNumber;
        const man = await api('POST', `/courses/${courseId}/blueprints/${n}/manifest`);
        ok(man.status === 201, `E18: Manifest del Blueprint ${n}`, { s: man.status, e: man.error });
        return n;
      };
      const ctx = { nombre: '[E2E R68 E18] Bloqueo de generación', ...CTX, scormTemplateIds: S.templates, videoMode: 'mock', providerModes: { presentation: 'mock', audio: 'mock' } };
      const expect409 = (r, reason, label) => {
        const raw = r.raw || {};
        ok(r.status === 409 && /GENERATION_NOT_VERIFIED/.test(String(r.error)) && (raw.reason === reason || JSON.stringify(raw).includes(`"reason":"${reason}"`)),
          `E18: ${label} → 409 GENERATION_NOT_VERIFIED (${reason})`, { s: r.status, e: r.error, reason: raw.reason });
      };
      const runsBase = (id, n) => `/courses/${id}/blueprints/${n}/manifest/runs`;

      // A · Verificación con un crítico que el docente no puede resolver con su estructura: el documento se contradice
      // (2 y 3 evaluaciones parciales): Cursia no elige cuál manda. (LOOP 9: «2 videos por capítulo», que Cursia no puede
      // producir, ya no es un crítico sin salida sino una excepción con motivo — lo prueba E20.)
      const cA = await mkCourse('[E2E R68 E18-A] Crítico', 'El curso tendrá 2 evaluaciones parciales.\nSe realizarán 3 evaluaciones parciales.');
      await keepTeacherDesign(api, cA, 'E18-A', { allowCritical: true });
      const recA = await api('POST', `/courses/${cA}/design/recommendation`, {});
      ok(recA.data.verification.blocking === true, 'E18-A: Verificación tiene un crítico (el documento se contradice)', recA.data.verification.checks.filter((c) => c.severity === 'critical').map((c) => c.title));
      const nA = await lockAndManifest(cA);
      const rA = await api('POST', runsBase(cA, nA), ctx);
      expect409(rA, 'critical', 'POST runs (API directa) con un crítico');
      ok(Array.isArray(rA.raw && rA.raw.criticals) && rA.raw.criticals.some((c) => /evaluaci/i.test(c.title)), 'E18-A: la respuesta lista el crítico', rA.raw && rA.raw.criticals);
      expect409(await api('POST', `${runsBase(cA, nA)}/estimate-preview`, ctx), 'critical', 'estimate-preview con un crítico');
      expect409(await api('POST', `${runsBase(cA, nA)}/approve-and-start`, { ...ctx, estimateHash: 'a'.repeat(64) }), 'critical', 'approve-and-start con un crítico');

      // B · Cambios recomendados sin aplicar (la estructura armada a mano, sin «Usar este diseño» ni decisiones del docente).
      const cB = await mkCourse('[E2E R68 E18-B] Sin aplicar', null, false);
      const nB = await lockAndManifest(cB);
      expect409(await api('POST', runsBase(cB, nB), ctx), 'pending_changes', 'POST runs con cambios sin aplicar');

      // C · Diseño verificado → pasa; después: estructura cambiada, Blueprint viejo.
      // Sin videos: el gate pasa y la generación (mock) no necesita la entrega por YouTube de los cursos con video.
      const cC = await mkCourse('[E2E R68 E18-C] Verificado', null, false);
      await keepTeacherDesign(api, cC, 'E18-C');
      const nC = await lockAndManifest(cC);
      const pv = await api('POST', `${runsBase(cC, nC)}/estimate-preview`, ctx);
      ok(pv.status === 200, 'E18-C: diseño verificado → el estimado de la generación pasa el gate (200)', { s: pv.status, e: pv.error });
      // Review piloto C1: cambiar el perfil (horas) DESPUÉS de aprobar no avanza el contador de estructura, pero el Blueprint
      // congeló otro diseño → 409 design_changed. Volver al perfil aprobado lo destraba (misma huella).
      const curP = (await api('GET', `/courses/${cC}/profiles/pedagogy`)).data;
      const verP = () => api('GET', `/courses/${cC}/profiles/pedagogy`).then((r) => (r.data && !r.data.isDefault ? Number(r.data.version) : 0));
      const chg = await api('POST', `/courses/${cC}/profiles/pedagogy`, { data: { ...curP.profile, targetHours: (curP.profile.targetHours || 10) + 8 }, expectedVersion: await verP() });
      ok(chg.status === 201, 'E18-C: el docente cambia las horas después de aprobar', { s: chg.status, e: chg.error });
      expect409(await api('POST', runsBase(cC, nC), ctx), 'design_changed', 'POST runs con el perfil cambiado tras aprobar');
      const back = await api('POST', `/courses/${cC}/profiles/pedagogy`, { data: curP.profile, expectedVersion: await verP() });
      ok(back.status === 201, 'E18-C: vuelve a las horas aprobadas', { s: back.status, e: back.error });
      const pvBack = await api('POST', `${runsBase(cC, nC)}/estimate-preview`, ctx);
      ok(pvBack.status === 200, 'E18-C: con el diseño aprobado de nuevo, el gate pasa', { s: pvBack.status, e: pvBack.error });
      let st = await readStructure(cC);
      const ch = st.modules[0].chapters[0];
      const ed = await api('PATCH', `/courses/${cC}/modules/${st.modules[0].id}/chapters/${ch.id}`, { title: 'Tema 1.1 editado después de aprobar', expectedCounter: st.structureVersionCounter });
      ok(ed.status === 200, 'E18-C: el docente edita la estructura después de aprobarla', { s: ed.status, e: ed.error });
      expect409(await api('POST', runsBase(cC, nC), ctx), 'structure_changed', 'POST runs con la estructura cambiada');
      const nC2 = await lockAndManifest(cC);
      expect409(await api('POST', runsBase(cC, nC), ctx), 'blueprint_not_current', 'POST runs con el Blueprint anterior');
      const pv2 = await api('POST', `${runsBase(cC, nC2)}/estimate-preview`, ctx);
      ok(pv2.status === 200, 'E18-C: re-aprobado → pasa de nuevo', { s: pv2.status, e: pv2.error });

      // D · Frontend antiguo / jobs legacy: un curso V2 nunca se genera por fuera del flujo verificado.
      for (const [p, body] of [['/jobs/content', { courseId: String(cA) }], ['/jobs/full', { courseId: String(cA), options: { generateAudio: false } }], ['/jobs/videos', { courseId: String(cC) }]]) {
        const r = await api('POST', p, body);
        ok(r.status === 409 && /v2_course_legacy_generation_disabled/.test(String(r.error)), `E18-D: ${p} con un curso V2 → 409 v2_course_legacy_generation_disabled`, { s: r.status, e: r.error });
      }

      // Nada se creó: ni runs ni jobs para estos cursos.
      const made = await q(`select count(*)::int n from public.production_jobs where course_id = any($1::bigint[]) or frontend_course_id = any($2::text[])`, [[cA, cB, cC], [String(cA), String(cB), String(cC)]]);
      ok(made[0].n === 0, 'E18: no se creó ninguna generación ni job para cursos sin verificación aprobable', made[0]);
    });

    // ═══ Prebrief pedagógico · E19 — propuesta versionada, PDF, aprobación, barrera del servidor y generación MOCK sobre lo
    // aprobado. Formato M (3 × 4, 40–44 h) frente a un documento que exige 4 × 5 y 64 h: excepciones con motivo. USD 0. ═══
    if (RUN_E5) await step('v3-E19-prebrief', async () => {
      const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));
      const { PDFParse } = require('pdf-parse');
      const pdfTextOf = async (buf) => { const p = new PDFParse({ data: new Uint8Array(buf) }); try { return (await p.getText()).text.replace(/\s+/g, ' '); } finally { await p.destroy().catch(() => {}); } };
      const getPdf = async (p) => { const r = await fetch(BASE + p, { headers: { authorization: `Bearer ${TOKEN}` } }); return { status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), buf: Buffer.from(await r.arrayBuffer()) }; };
      const title = '[E2E Prebrief E19] Contabilidad de Costos';
      const cr = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title });
      ok(cr.status === 201, 'E19: curso dinámico creado', { s: cr.status, e: cr.error });
      const courseId = Number(cr.data.id);
      // Pedido del curso (el contexto de generación que se aprueba).
      const brief = { nombre: 'Contabilidad de Costos', obj: 'Calcular y controlar los costos de producción', sector: 'Contabilidad', pais: 'Colombia', contexto: 'Técnico / Tecnólogo — formación técnica', nivel: 'Básico — sin conocimientos previos', tono: 'cercano y claro' };
      ok((await api('PUT', `/courses/${courseId}/brief`, brief)).status === 200, 'E19: pedido guardado');
      // Microcurrículo sintético + requisito «4 módulos × 5 capítulos».
      const docText = AF.toText('consistent').toString('utf8') + '\nEl curso tendrá 4 módulos con 5 capítulos cada uno.\n';
      const ex = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'microcurriculo-sintetico.txt', dataBase64: Buffer.from(docText, 'utf8').toString('base64') }] });
      ok(ex.status === 200 && ex.data.stats.providersCalled === 0, 'E19: documento leído (0 proveedores)', { s: ex.status, e: ex.error });
      ok((await api('POST', `/courses/${courseId}/profiles/academic`, { data: ex.data.draft, expectedVersion: 0 })).status === 201, 'E19: contexto académico guardado');
      // Estructura 3 × 4 con capítulos vinculados a los resultados (la arma el docente, como en «Avanzado»).
      const TITLES = [
        ['Fundamentos y elementos del costo', [['Elementos del costo y su clasificación', ['RA1']], ['Estado de costo de productos vendidos', ['RA1']], ['Valoración de inventarios de materiales', ['RA2']], ['Liquidación de nómina y mano de obra', ['RA2']]]],
        ['Costeo por órdenes y por procesos', [['Costos indirectos de fabricación', ['RA3']], ['Hoja de costos por orden de producción', ['RA3']], ['Producción equivalente en costeo por procesos', ['RA4']], ['Informe de cantidades y costos por procesos', ['RA4']]]],
        ['Análisis de costos para decidir', [['Margen de contribución', ['RA5']], ['Punto de equilibrio y relación costo-volumen-utilidad', ['RA5']], ['Toma de decisiones con información de costos', ['RA6']], ['Informe de costos para una decisión gerencial', ['RA6']]]],
      ];
      let counter = 0;
      for (const [mt, chs] of TITLES) {
        const m = await api('POST', `/courses/${courseId}/modules`, { title: mt, objective: `Aplicar ${mt.toLowerCase()}`, examEnabled: true, expectedCounter: counter });
        if (m.status !== 201) throw new Error(`E19 módulo: ${m.status} ${m.error}`);
        counter = m.data.structureVersionCounter;
        const auto = m.data.module.chapters || [];
        for (let ci = 0; ci < chs.length; ci++) {
          const body = { title: chs[ci][0], objective: `Aplicar ${chs[ci][0].toLowerCase()} en una empresa`, videoEnabled: ci === 0, outcomeIds: chs[ci][1], expectedCounter: counter };
          const c = ci === 0 && auto.length === 1 ? await api('PATCH', `/courses/${courseId}/modules/${m.data.module.id}/chapters/${auto[0].id}`, body) : await api('POST', `/courses/${courseId}/modules/${m.data.module.id}/chapters`, body);
          if (![200, 201].includes(c.status)) throw new Error(`E19 capítulo: ${c.status} ${c.error}`);
          counter = c.data.structureVersionCounter;
        }
      }
      const AP = D('modules/course-profiles/course-profiles.js');
      ok((await api('POST', `/courses/${courseId}/profiles/assessment`, { data: { ...AP.defaultAssessmentProfile({ finalExam: true }), passingGrade: 70 } })).status === 201, 'E19: perfil de evaluación');
      ok((await api('POST', `/courses/${courseId}/profiles/presentation`, { data: { themeFamily: 'aula-clara', mode: 'light', brandSeed: null, themeVersion: 1 } })).status === 201, 'E19: perfil de presentación');

      // Formato M: alternativa (S y L no aplican), meta 42 h (punto medio), decisión de la institución.
      const fm = await api('PUT', `/courses/${courseId}/format`, { code: 'M' });
      ok(fm.status === 200 && fm.data.format.code === 'M', 'E19: formato M seleccionado', { s: fm.status, e: fm.error });
      ok((await api('PUT', `/courses/${courseId}/format`, { code: 'XL' })).status === 400, 'E19: formato inexistente → 400');
      ok((await api('PUT', `/courses/${courseId}/format`, { code: ['S', 'M'] })).status === 400, 'E19: nunca dos formatos a la vez → 400');
      // «Usar este diseño» (lo que hace la interfaz): perfil, vínculos y cambios recomendados, hasta que quede estable.
      const useDesign = async (label) => {
        for (let i = 0; i < 8; i++) {
          const card = (await api('POST', `/courses/${courseId}/design/recommendation`, {})).data;
          const pending = Math.max((card.design.changes || []).length, card.design.modules.reduce((n, m) => n + m.chapters.filter((c) => c.proposed).length, 0));
          const auto = card.verification.checks.some((c) => c.id === 'outcome_links');
          if (!card.profileChanged && !pending && !auto) return card;
          const st = await readStructure(courseId);
          if (card.profileChanged) {
            const pv = (await api('GET', `/courses/${courseId}/profiles/pedagogy`)).data;
            const r = await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: card.profile, expectedVersion: pv && !pv.isDefault ? Number(pv.version) : 0 });
            if (r.status !== 201) throw new Error(`${label}: perfil ${r.status} ${r.error}`);
          } else if (auto) {
            const r = await api('POST', `/courses/${courseId}/design/fix`, { action: 'link_outcomes', expectedCounter: st.structureVersionCounter });
            if (r.status !== 200) throw new Error(`${label}: vínculos ${r.status} ${r.error}`);
          } else {
            const r = await api('POST', `/courses/${courseId}/modules/apply-distribution`, { expectedCounter: st.structureVersionCounter, proposalSha256: card.design.proposalSha256 });
            if (![200, 201].includes(r.status)) throw new Error(`${label}: aplicar ${r.status} ${r.error}`);
          }
        }
        throw new Error(`${label}: el diseño no quedó estable`);
      };
      const card = await useDesign('E19');
      ok(card.hours.target === 42, 'E19: meta de horas = punto medio del formato M (42 h)', card.hours);
      const fmtCheck = card.verification.checks.find((c) => c.id === 'format');
      ok(fmtCheck && fmtCheck.severity === 'ok', 'E19: Verificación: la estructura respeta el formato M (prácticas fuera del N×M)', fmtCheck);
      ok(!card.verification.blocking, 'E19: verificación sin críticos', card.verification.checks.filter((c) => c.severity === 'critical').map((c) => c.title));

      // Prebrief (borrador): excepciones visibles y sin motivo → no se puede preparar.
      let S0 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      ok(S0.status === 'draft' && S0.draft.readiness.ready === false, 'E19: borrador no preparable todavía', S0.draft.readiness);
      const exKeys = S0.draft.model.exceptions.map((e) => e.requirementKey);
      ok(exKeys.length >= 1 && S0.draft.model.exceptions.some((e) => /4 × 5/.test(e.requirementText)), 'E19: excepción «4 × 5» del documento frente al formato M', S0.draft.model.exceptions);
      // LOOP 9.2: una excepción cubierta por otra de la misma limitación no pide su propio motivo.
      const ownKeys = S0.draft.model.exceptions.filter((e) => !(e.coveredBy && exKeys.includes(e.coveredBy))).map((e) => e.requirementKey);
      ok(JSON.stringify(S0.draft.readiness.blockers.filter((b) => b.code === 'exception_reason').map((b) => b.ref).sort()) === JSON.stringify(ownKeys.sort()), 'E19: cada excepción pide su motivo (una sola vez por limitación)');
      ok(S0.draft.model.duration.format && S0.draft.model.duration.format.code === 'M' && S0.draft.model.structure.origin === 'format', 'E19: «Formato M · Configuración seleccionada»');
      const prep0 = await api('POST', `/courses/${courseId}/prebrief/versions`, { expectedModelSha: S0.draft.modelSha256 });
      ok(prep0.status === 409 && prep0.raw && prep0.raw.code === 'PREBRIEF_NOT_READY', 'E19: preparar sin motivos → 409 PREBRIEF_NOT_READY', { s: prep0.status, e: prep0.error });
      ok((await api('PUT', `/courses/${courseId}/prebrief/exception-reasons`, { requirementKey: exKeys[0], reason: 'corto' })).status === 400, 'E19: motivo demasiado corto → 400');
      for (const k of exKeys) {
        const r = await api('PUT', `/courses/${courseId}/prebrief/exception-reasons`, { requirementKey: k, reason: 'La institución prioriza una duración menor para el piloto.' });
        ok(r.status === 200, `E19: motivo de la excepción ${k}`, { s: r.status, e: r.error });
      }
      S0 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      // Datos dudosos (si los hubiera) se confirman explícitamente.
      for (const b of S0.draft.readiness.blockers.filter((x) => x.code === 'doubtful_data')) await api('POST', `/courses/${courseId}/prebrief/confirmations`, { confirmKey: b.ref });
      S0 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      ok(S0.draft.readiness.ready === true, 'E19: con los motivos, la propuesta se puede preparar', S0.draft.readiness.blockers);
      const docTxt = JSON.stringify(S0.draft.document);
      ok(!/USD|costo estimado|Gamma|Videogen|OpenAI/i.test(docTxt), 'E19: el documento no tiene costos ni proveedores');
      const dpdf = await getPdf(`/courses/${courseId}/prebrief/draft.pdf`);
      ok(dpdf.status === 200 && /application\/pdf/.test(dpdf.type) && /BORRADOR/i.test(await pdfTextOf(dpdf.buf)), 'E19: PDF del borrador (marca BORRADOR)', { s: dpdf.status });

      // Antes de aprobar: la barrera no deja ni estimar ni generar (API directa, approve-and-start).
      const prep = await api('POST', `/courses/${courseId}/prebrief/versions`, { expectedModelSha: S0.draft.modelSha256 });
      ok(prep.status === 201 && prep.data.version.version === 1 && prep.data.version.status === 'ready', 'E19: v1 preparada (Listo para aprobación)', { s: prep.status, e: prep.error });
      const again = await api('POST', `/courses/${courseId}/prebrief/versions`, { expectedModelSha: S0.draft.modelSha256 });
      ok(again.status === 200 && again.data.version.version === 1, 'E19: preparar de nuevo la misma huella es idempotente (sigue v1)');
      const n1 = prep.data.version.blueprintNumber;
      ok((await api('POST', `/courses/${courseId}/blueprints/${n1}/manifest`)).status === 201, 'E19: Manifest del Blueprint congelado por la v1');
      const runsBase = `/courses/${courseId}/blueprints/${n1}/manifest/runs`;
      const ctxLie = { nombre: 'OTRO NOMBRE', ...CTX, sector: 'Sector inventado', tono: 'SUSURRADO', scormTemplateIds: S.templates, videoMode: 'real', providerModes: { presentation: 'mock', audio: 'mock' } };
      const expect409 = (r, reason, label) => ok(r.status === 409 && r.raw && r.raw.reason === reason, `E19: ${label} → 409 ${reason}`, { s: r.status, e: r.error, reason: r.raw && r.raw.reason });
      expect409(await api('POST', runsBase, ctxLie), 'prebrief_not_approved', 'POST runs sin aprobar');
      expect409(await api('POST', `${runsBase}/estimate-preview`, ctxLie), 'prebrief_not_approved', 'costo (estimate-preview) sin aprobar');
      expect409(await api('POST', `${runsBase}/approve-and-start`, { ...ctxLie, estimateHash: 'a'.repeat(64) }), 'prebrief_not_approved', 'approve-and-start sin aprobar');
      const rpdf = await getPdf(`/courses/${courseId}/prebrief/versions/1/pdf?variant=ready`);
      const rtxt = await pdfTextOf(rpdf.buf);
      ok(rpdf.status === 200 && /PENDIENTE DE APROBACIÓN/i.test(rtxt) && /Versión 1/.test(rtxt) && /v1_para-aprobacion\.pdf/.test(rpdf.disp || ''), 'E19: PDF v1 «para aprobación»', { s: rpdf.status, d: rpdf.disp });

      // Aprobación: huella equivocada, sin confirmar, sin nombre → rechazadas; la buena se registra.
      const v1sha = prep.data.version.modelSha256;
      ok((await api('POST', `/courses/${courseId}/prebrief/versions/1/approve`, { expectedModelSha: 'f'.repeat(64), name: 'María Gómez', role: 'Coordinadora académica', confirm: true })).status === 409, 'E19: aprobar con otra huella → 409');
      ok((await api('POST', `/courses/${courseId}/prebrief/versions/1/approve`, { expectedModelSha: v1sha, name: 'María Gómez', role: 'Coordinadora académica', confirm: false })).status === 400, 'E19: aprobar sin confirmar → 400');
      ok((await api('POST', `/courses/${courseId}/prebrief/versions/1/approve`, { expectedModelSha: v1sha, name: '', role: 'Coordinadora académica', confirm: true })).status === 400, 'E19: aprobar sin nombre → 400');
      const apv = await api('POST', `/courses/${courseId}/prebrief/versions/1/approve`, { expectedModelSha: v1sha, name: 'María Gómez', role: 'Coordinadora académica', confirm: true });
      ok(apv.status === 200 && apv.data.version.status === 'approved' && apv.data.version.approval.name === 'María Gómez', 'E19: v1 APROBADA (nombre, cargo, usuario, fecha, huella)', { s: apv.status, e: apv.error });
      const [arow] = await q(`select approval, model_sha256 from public.course_prebrief_versions where course_id = $1 and version = 1`, [courseId]);
      ok(arow.approval.userId === OWNER && arow.approval.role === 'Coordinadora académica' && arow.approval.modelSha256 === arow.model_sha256 && !!arow.approval.at, 'E19: la aprobación guarda usuario, cargo, fecha y huella', arow.approval);
      const apdf = await getPdf(`/courses/${courseId}/prebrief/versions/1/pdf?variant=approved`);
      const atxt = await pdfTextOf(apdf.buf);
      ok(apdf.status === 200 && /Aprobado por: María Gómez/.test(atxt) && /Cargo: Coordinadora académica/.test(atxt), 'E19: PDF v1 APROBADO (quién y cargo)');
      let immut = null; try { await q(`update public.course_prebrief_versions set model_json = '{}'::jsonb where course_id = $1`, [courseId]); } catch (e) { immut = e; }
      ok(immut && /PREBRIEF_VERSION_IMMUTABLE/.test(immut.message), 'E19: la versión aprobada es inmutable en la base (trigger)');

      // Costo DESPUÉS de aprobar; el contexto del run es el APROBADO aunque el navegador mande otro.
      const pv = await api('POST', `${runsBase}/estimate-preview`, ctxLie);
      ok(pv.status === 200, 'E19: con la propuesta aprobada, se muestra el costo (estimate-preview 200)', { s: pv.status, e: pv.error });
      const mods = (await readStructure(courseId)).modules;
      llm.st.courseId = courseId;
      llm.st.chapterByTitle.clear(); llm.st.moduleByTitle.clear(); llm.st.moduleOfChapter.clear();
      for (const m of mods) { llm.st.moduleByTitle.set(m.title, m.id); for (const x of m.chapters) { llm.st.chapterByTitle.set(x.title, x.id); llm.st.moduleOfChapter.set(x.id, m.id); } }
      let start = await api('POST', runsBase, ctxLie);
      const estM = /estimateId=([0-9a-f-]{36})/.exec(String(start.error || ''));
      if (start.status === 409 && estM) {
        // Autorización del gasto (FinOps): el administrador autoriza el run (proveedores FALSOS locales, USD 0).
        await q(`insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, decision, approved_by, reason)
                 values ($1, $2, 1000, 'ADMIN_APPROVED', 'e2e-admin@cursia.test', 'e2e E19: autorización de producción (proveedores FALSOS locales)')`, [courseId, estM[1]]);
        start = await api('POST', runsBase, ctxLie);
      }
      ok(start.status === 201, 'E19: run MOCK creado sobre la v1 aprobada', { s: start.status, e: start.error });
      if (start.status !== 201) throw new Error(`E19: run no creado: ${start.status} ${start.error}`);
      const runA = start.data.run.id;
      const [ctxRow] = await q(`select context from public.generation_run_contexts where job_id = $1`, [runA]);
      const approvedCtx = S0.draft.model.generationContext;
      eq(['nombre', 'sector', 'pais', 'tono', 'obj'].map((k) => ctxRow.context[k]), ['nombre', 'sector', 'pais', 'tono', 'obj'].map((k) => approvedCtx[k]), 'E19: el run congeló EXACTAMENTE el contexto aprobado (no el del navegador)');
      ok(ctxRow.context.tono !== 'SUSURRADO' && ctxRow.context.sector !== 'Sector inventado', 'E19: el contexto inventado por el navegador se ignoró');
      const ev = await api('GET', `/courses/${courseId}/prebrief/events`);
      ok(ev.data.some((e) => e.type === 'generation_started' && e.version === 1 && e.payload.runId === runA), 'E19: historial: generación iniciada con la v1');
      // Review BE-2 I1: durante la producción sobre la propuesta aprobada, el tema y la evaluación no cambian.
      const presNow = (await api('GET', `/courses/${courseId}/profiles/presentation`)).data;
      const lockTry = await api('POST', `/courses/${courseId}/profiles/presentation`, { data: { themeFamily: 'tecnico', mode: 'dark', brandSeed: null, themeVersion: 1 }, expectedVersion: presNow && !presNow.isDefault ? Number(presNow.version) : 0 });
      ok(lockTry.status === 409 && lockTry.raw && lockTry.raw.code === 'PROFILE_LOCKED_DURING_PRODUCTION', 'E19: cambiar el tema durante la producción → 409 (bloqueado)', { s: lockTry.status, e: lockTry.error });
      llm.st.tag = 'E19';
      S.front.DYN_EXAM_BANK_MODE_ENABLED = false;
      const stt = await waitRunTerminal(S.front.dynExecutorStart({ courseId, blueprintNumber: n1, runId: runA }), 'E19 run', undefined, runA);
      const itemsA = await waitItemsDone(runA);
      ok(stt.failed === 0 && !stt.fatalError && itemsA.every((i) => i.status === 'completed'), `E19: generación MOCK completa (${itemsA.length} items, proveedores falsos)`, itemsA.filter((i) => i.status !== 'completed').map((i) => [i.item_key, i.status, (i.error_message || '').slice(0, 160)]));
      const [manRow] = await q(`select m.blueprint_id, b.snapshot_sha256 from public.course_generation_manifests m join public.course_blueprints b on b.id = m.blueprint_id
         join public.production_jobs j on (j.input_payload->>'manifestId')::int = m.id where j.id = $1`, [runA]);
      const [vRow] = await q(`select blueprint_id, blueprint_sha256 from public.course_prebrief_versions where course_id = $1 and version = 1`, [courseId]);
      ok(manRow && Number(manRow.blueprint_id) === Number(vRow.blueprint_id) && manRow.snapshot_sha256 === vRow.blueprint_sha256, 'E19: lo generado usa el Blueprint EXACTO de la versión aprobada', { manRow, vRow });

      // Review BE-1 C1: un PATCH del curso no puede borrar el flujo de propuesta ni falsificar motivos o confirmaciones.
      const pm = await api('PATCH', `/courses/${courseId}`, { metadata: { approvalFlow: null, requirementExceptionReasons: {}, courseFormat: null, otra: 1 } });
      ok(pm.status === 200, 'E19: PATCH del curso con metadata', { s: pm.status, e: pm.error });
      const [meta1] = await q(`select metadata from public.courses where id = $1`, [courseId]);
      ok(meta1.metadata.approvalFlow === 'prebrief' && meta1.metadata.courseFormat && meta1.metadata.courseFormat.code === 'M' && Object.keys(meta1.metadata.requirementExceptionReasons || {}).length >= 1,
        'E19: el PATCH no borra el flujo de propuesta, el formato ni los motivos (claves protegidas)', meta1.metadata);
      // Cambios después de aprobar → la aprobación se invalida y el servidor bloquea (datos de producción, motivo, horas…).
      const nb = await api('PUT', `/courses/${courseId}/brief`, { ...brief, tono: 'formal y académico' });
      ok(nb.status === 200, 'E19: el docente cambia el tono después de aprobar');
      const S1 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      const v1 = S1.versions.find((v) => v.version === 1);
      ok(v1.status === 'invalidated' && v1.invalidationDiff.some((l) => /tono/.test(l)), 'E19: v1 INVALIDADA con la diferencia («Datos del curso para producir: tono»)', v1);
      expect409(await api('POST', runsBase, ctxLie), 'prebrief_stale', 'POST runs con la propuesta obsoleta');
      // Review BE-1 I2: regenerar un item (gasto nuevo) con la aprobación obsoleta → bloqueado; el estimado de video también.
      const itemKey0 = itemsA.find((i) => /^content:/.test(i.item_key)).item_key;
      expect409(await api('POST', `${runsBase}/${runA}/items/${encodeURIComponent(itemKey0)}/regenerate`, { confirmPaid: true }), 'prebrief_stale', 'regenerar un item con la propuesta obsoleta');
      expect409(await api('GET', `${runsBase}/estimate`), 'prebrief_stale', 'estimado de video con la propuesta obsoleta');
      ok((await api('POST', `/courses/${courseId}/prebrief/versions/1/approve`, { expectedModelSha: v1sha, name: 'María Gómez', role: 'Coordinadora académica', confirm: true })).status === 409, 'E19: volver a aprobar la v1 invalidada → 409');
      // v2 con el tono nuevo; la v1 no se puede aprobar (no es la última); la regeneración hereda el contexto viejo → bloqueada.
      const S2 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      const p2 = await api('POST', `/courses/${courseId}/prebrief/versions`, { expectedModelSha: S2.draft.modelSha256 });
      ok(p2.status === 201 && p2.data.version.version === 2, 'E19: v2 preparada', { s: p2.status, e: p2.error });
      const ap2 = await api('POST', `/courses/${courseId}/prebrief/versions/2/approve`, { expectedModelSha: p2.data.version.modelSha256, name: 'María Gómez', role: 'Coordinadora académica', confirm: true });
      ok(ap2.status === 200, 'E19: v2 aprobada', { s: ap2.status, e: ap2.error });
      const n2 = p2.data.version.blueprintNumber;
      if (n2 !== n1) await api('POST', `/courses/${courseId}/blueprints/${n2}/manifest`);
      const regen = await api('POST', `/courses/${courseId}/blueprints/${n2}/manifest/runs`, { fromRun: runA });
      ok(regen.status === 409 && regen.raw && ['context_mismatch', 'prebrief_stale'].includes(regen.raw.reason), 'E19: regeneración fromRun con el contexto de la v1 → 409 (no se genera sobre otro contexto)', { s: regen.status, e: regen.error, r: regen.raw && regen.raw.reason });
      // Motivo de excepción cambiado → la v2 queda obsoleta.
      await api('PUT', `/courses/${courseId}/prebrief/exception-reasons`, { requirementKey: exKeys[0], reason: 'La institución decidió otra duración por calendario académico.' });
      expect409(await api('POST', `/courses/${courseId}/blueprints/${n2}/manifest/runs`, ctxLie), 'prebrief_stale', 'POST runs tras cambiar un motivo de excepción');
      // Estructura cambiada → el gate de diseño ya lo bloquea antes (R68) y la v2 queda invalidada.
      const st2 = await readStructure(courseId);
      await api('PATCH', `/courses/${courseId}/modules/${st2.modules[0].id}/chapters/${st2.modules[0].chapters[0].id}`, { title: 'Elementos del costo (revisado)', expectedCounter: st2.structureVersionCounter });
      const r3 = await api('POST', `/courses/${courseId}/blueprints/${n2}/manifest/runs`, ctxLie);
      ok(r3.status === 409 && /GENERATION_NOT_VERIFIED/.test(String(r3.error)), 'E19: estructura cambiada tras aprobar → 409', { s: r3.status, r: r3.raw && r3.raw.reason });
      const S3 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      ok(S3.versions.find((v) => v.version === 2).status === 'invalidated', 'E19: v2 invalidada por los cambios');
      // Legacy: nunca por fuera del flujo.
      const lg = await api('POST', '/jobs/content', { courseId: String(courseId) });
      ok(lg.status === 409 && /v2_course_legacy_generation_disabled/.test(String(lg.error)), 'E19: endpoint legacy → 409', { s: lg.status });
      // Historial completo y de solo inserción.
      const evAll = (await api('GET', `/courses/${courseId}/prebrief/events`)).data;
      const ev2 = evAll.map((e) => e.type);
      for (const t of ['format_selected', 'exception_reason', 'prepared', 'pdf_generated', 'approved', 'generation_started', 'invalidated']) ok(ev2.includes(t), `E19: historial registra «${t}»`);
      // QA staging: UPDATE … RETURNING devuelve [filas, cantidad] con TypeORM; sin returningRows aparecían eventos «superseded»
      // falsos (sin versión) en cada preparación y los de una versión perdían su id.
      const versionEvents = ['superseded', 'prepared', 'approved', 'invalidated', 'changes_requested', 'withdrawn'];
      const orphan = evAll.filter((e) => versionEvents.includes(e.type) && (e.version === null || e.version === undefined));
      ok(orphan.length === 0, 'E19: todo evento de una versión lleva su versión (sin «superseded» falsos)', orphan.map((e) => e.type));
      ok(ev2.filter((t) => t === 'superseded').length <= ev2.filter((t) => t === 'prepared').length, 'E19: «superseded» solo cuando una versión se reemplaza', ev2);
      let del = null; try { await q(`delete from public.course_prebrief_events where course_id = $1`, [courseId]); } catch (e) { del = e; }
      ok(del && /PREBRIEF_APPEND_ONLY/.test(del.message), 'E19: el historial no se puede borrar');
      // Review BE-1 I1: el empaque usa los perfiles APROBADOS: cambiar el tema después de aprobar bloquea el paquete del run.
      const pres = (await api('GET', `/courses/${courseId}/profiles/presentation`)).data;
      const verPres = pres && !pres.isDefault ? Number(pres.version) : 0;
      ok((await api('POST', `/courses/${courseId}/profiles/presentation`, { data: { themeFamily: 'oscuro-premium', mode: 'dark', brandSeed: null, themeVersion: 1 }, expectedVersion: verPres })).status === 201, 'E19: el docente cambia el tema después de aprobar');
      const pk = await api('POST', `/courses/${courseId}/blueprints/${n1}/manifest/runs/${runA}/package`, {});
      ok(pk.status === 409 && pk.raw && pk.raw.code === 'PREBRIEF_PROFILES_CHANGED', 'E19: empaque con el tema cambiado → 409 PREBRIEF_PROFILES_CHANGED', { s: pk.status, e: pk.error });
      // Review BE-1 I4: un curso con historial de propuesta se puede borrar (la cascada borra su historial).
      const cdel = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: '[E2E Prebrief E19] Curso para borrar' });
      const cdelId = Number(cdel.data.id);
      const fs0 = await api('PUT', `/courses/${cdelId}/format`, { code: 'S' });
      ok(fs0.status === 200 && fs0.data.format.code === 'S', 'E19: elegir formato en un curso nuevo (sin perfil pedagógico) funciona', { s: fs0.status, e: fs0.error });
      const pf = (await api('GET', `/courses/${cdelId}/profiles/pedagogy`)).data;
      ok(pf && pf.profile && pf.profile.targetHours === 21, 'E19: el formato S fija la meta en 21 h (punto medio)', pf && pf.profile && pf.profile.targetHours);
      const [evN] = await q(`select count(*)::int n from public.course_prebrief_events where course_id = $1`, [cdelId]);
      const dl = await api('DELETE', `/courses/${cdelId}`);
      const [evN2] = await q(`select count(*)::int n from public.course_prebrief_events where course_id = $1`, [cdelId]);
      ok(evN.n >= 1 && [200, 204].includes(dl.status) && evN2.n === 0, 'E19: borrar un curso con historial de propuesta funciona (cascada)', { before: evN.n, s: dl.status, e: dl.error, after: evN2.n });
      results.courses.E19 = { courseId, runId: runA };
    }, { fatal: false });

    // ═══ LOOP 9 · E20 — PILOT READINESS: el caso del piloto de punta a punta por HTTP real (USD 0, proveedores FALSOS):
    // microcurrículo (64 h · 4 × 5 · 2 videos por capítulo · 1 Actividad de Aplicación por módulo · 3 parciales + final) →
    // «Lo que entendimos» (sin RA inventados; el valor de partida no es «decisión») → requisitos → Formato M (choca con el
    // documento) → «Cursia recomienda» → Verificación (excepciones explícitas, incluida la que Cursia no puede producir) →
    // propuesta → PDF → aprobación → CONTRATO: cada dato que cambia el producto invalida la aprobación, R68 bloquea, una versión
    // nueva se aprueba y recién ahí se puede seguir → generación MOCK → Blueprint = propuesta → Manifest = Blueprint → empaque →
    // Moodle (restore, permisos y notas) → permisos de otro usuario.
    if (RUN_E5) await step('v3-E20-pilot-readiness', async () => {
      const T = (label) => `E20: ${label}`;
      const title = '[E2E Pilot E20] Seguridad y Salud en el Trabajo para Supervisores';
      const cr = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title });
      ok(cr.status === 201, T('curso dinámico creado'), { s: cr.status, e: cr.error });
      const courseId = Number(cr.data.id);
      // Pedido: lo que el usuario escribió; «¿Para quién?» y el nivel quedaron en su valor de partida (inferidos).
      const brief = { nombre: 'Seguridad y Salud en el Trabajo para Supervisores', obj: 'Curso de seguridad y salud en el trabajo para supervisores de planta.', sector: 'Seguridad y Salud en el Trabajo', pais: 'Colombia',
        contexto: 'Universitario — estudiantes de pregrado universitario, con rigor académico y pensamiento crítico', nivel: 'Básico — sin conocimientos previos', tono: 'cercano y claro', inferidos: 'contexto,nivel,pais,tono' };
      ok((await api('PUT', `/courses/${courseId}/brief`, brief)).status === 200, T('pedido guardado'));
      const docText = [
        'MICROCURRÍCULO', 'Asignatura: Seguridad y Salud en el Trabajo para Supervisores', 'Programa: Tecnología en Gestión de la Seguridad y Salud en el Trabajo', 'Modalidad: Virtual',
        'Intensidad horaria total: 64 horas', '', '1. Descripción', 'La asignatura forma a supervisores de planta para identificar peligros, evaluar riesgos y liderar la prevención de accidentes.', '',
        '2. Perfil del estudiante', 'Supervisores y líderes de turno de empresas manufactureras, con experiencia operativa y formación técnica básica en seguridad.', '',
        'Conocimientos previos', '- Procesos productivos básicos', '- Uso de equipos de protección personal', '',
        '3. Objetivo general', 'Desarrollar en los supervisores la capacidad de gestionar los riesgos laborales de su área y liderar una cultura preventiva.', '',
        '4. Resultados de aprendizaje',
        'RA1. Identificar los peligros presentes en un área de trabajo industrial y clasificarlos por tipo.',
        'RA2. Evaluar los riesgos laborales con una matriz de valoración y priorizar controles.',
        'RA3. Aplicar la jerarquía de controles para reducir la exposición a riesgos críticos.',
        'RA4. Investigar incidentes y accidentes con un método de análisis de causas.',
        'RA5. Liderar acciones de prevención y comunicación del riesgo con el equipo de trabajo.', '',
        '5. Estructura del curso', 'El curso tendrá 4 módulos con 5 capítulos cada uno.', 'Cada capítulo debe incluir 2 videos.', 'Cada módulo incluye 1 Actividad de Aplicación.', '',
        '6. Evaluación', 'El curso tendrá 3 evaluaciones parciales y 1 evaluación final.', '',
        '7. Bibliografía', '- Organización Internacional del Trabajo (2019). Seguridad y salud en el centro del futuro del trabajo. OIT. Capítulo 3, páginas 45-60.', '- Decreto 1072 de 2015, artículo 2.2.4.6.8.', '',
      ].join('\n');
      const ex = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'microcurriculo-e20.txt', dataBase64: Buffer.from(docText, 'utf8').toString('base64') }] });
      ok(ex.status === 200 && ex.data.stats.providersCalled === 0, T('documento leído sin proveedores (USD 0)'), { s: ex.status, e: ex.error });
      eq(ex.data.draft.outcomes.map((o) => o.id), ['RA1', 'RA2', 'RA3', 'RA4', 'RA5'], T('«Lo que entendimos»: 5 resultados; la sección «5. Estructura del curso» no se suma como RA6 (P1-1)'));
      ok((await api('POST', `/courses/${courseId}/profiles/academic`, { data: ex.data.draft, expectedVersion: 0 })).status === 201, T('contexto académico guardado'));
      // Requisitos explícitos (con su cita), sin inventar: bibliografía, artículos y páginas no son requisitos.
      const rv = (await api('GET', `/courses/${courseId}/academic-context/requirements`)).data;
      const reqs = (rv && rv.items || []).filter((r) => r.applies && r.obligation === 'required');
      const has = (kind, value, extra) => reqs.some((r) => r.kind === kind && r.value === value && Object.entries(extra || {}).every(([k, v]) => JSON.stringify(r[k]) === JSON.stringify(v)));
      ok(has('target_hours', 64) && has('modules', 4) && has('chapters', 5) && has('videos', 2) && has('application_activities', 1) && has('evaluations', 3, { evaluationType: 'partial' }) && has('evaluations', 1, { evaluationType: 'final' }),
        T('requisitos: 64 h, 4 módulos, 5 capítulos por módulo, 2 videos por capítulo, 1 Actividad de Aplicación por módulo («incluye», P1-3), 3 parciales + final'), reqs.map((r) => `${r.kind}=${r.value}${r.evaluationType ? ':' + r.evaluationType : ''}`));
      ok(!reqs.some((r) => [3, 45, 60, 2015].includes(r.value) && r.kind === 'chapters'), T('capítulos de un libro, páginas y artículos NO son requisitos'), reqs.map((r) => `${r.kind}=${r.value}`));
      // «Lo que entendimos»: el documento manda sin preguntar (el «Universitario» de partida no era una decisión) y el nivel
      // de partida es de Cursia, no «tu pedido» (P1-2 / P1-4).
      const facts = (await api('GET', `/courses/${courseId}/facts`)).data;
      ok(facts.educationLevel.value === 'technical' && facts.educationLevel.source === 'document' && !facts.conflicts.some((c) => c.field === 'educationLevel'),
        T('nivel educativo del documento, sin pregunta falsa («elegiste Universitario»)'), { lvl: facts.educationLevel, conflicts: facts.conflicts });
      // LOOP 9.2: con conocimientos previos en el documento (exigidos), el dato sale del documento (no el «sin conocimientos» de partida).
      eq([facts.priorKnowledge.source, facts.priorKnowledge.value, facts.documentPrerequisites, facts.documentPrerequisitesKind], ['document', 'basic', ['Procesos productivos básicos', 'Uso de equipos de protección personal'], 'required'], T('conocimientos previos: los del documento mandan sobre el de partida (exigidos)'));

      // Formato M (3 × 4, 40–44 h): decisión de la institución que choca con el documento (4 × 5, 64 h).
      const fm = await api('PUT', `/courses/${courseId}/format`, { code: 'M' });
      ok(fm.status === 200 && fm.data.format.code === 'M', T('Formato M elegido'));
      // Estructura 3 × 4 (lo que la propuesta de estructura arma con el formato elegido, P1-6), con los resultados vinculados.
      const TIT = [
        ['Identificación de peligros', [['Peligros físicos y mecánicos', ['RA1']], ['Peligros químicos y biológicos', ['RA1']], ['Matriz de valoración de riesgos', ['RA2']], ['Priorización de controles', ['RA2']]]],
        ['Control de riesgos', [['Jerarquía de controles', ['RA3']], ['Controles de ingeniería en planta', ['RA3']], ['Equipos de protección personal', ['RA3']], ['Investigación de incidentes', ['RA4']]]],
        ['Liderazgo preventivo', [['Análisis de causas', ['RA4']], ['Comunicación del riesgo', ['RA5']], ['Cultura preventiva en el turno', ['RA5']], ['Plan de prevención del área', ['RA5']]]],
      ];
      let counter = 0;
      for (const [mt, chs] of TIT) {
        const m = await api('POST', `/courses/${courseId}/modules`, { title: mt, objective: `Aplicar ${mt.toLowerCase()} en planta`, examEnabled: true, expectedCounter: counter });
        if (m.status !== 201) throw new Error(`E20 módulo: ${m.status} ${m.error}`);
        counter = m.data.structureVersionCounter;
        const auto = m.data.module.chapters || [];
        for (let ci = 0; ci < chs.length; ci++) {
          const body = { title: chs[ci][0], objective: `Aplicar ${chs[ci][0].toLowerCase()} en el área de trabajo`, videoEnabled: true, outcomeIds: chs[ci][1], expectedCounter: counter };
          const c = ci === 0 && auto.length === 1 ? await api('PATCH', `/courses/${courseId}/modules/${m.data.module.id}/chapters/${auto[0].id}`, body) : await api('POST', `/courses/${courseId}/modules/${m.data.module.id}/chapters`, body);
          if (![200, 201].includes(c.status)) throw new Error(`E20 capítulo: ${c.status} ${c.error}`);
          counter = c.data.structureVersionCounter;
        }
      }
      const AP = D('modules/course-profiles/course-profiles.js');
      const assessment = { ...AP.defaultAssessmentProfile({ finalExam: true }), passingGrade: 70 };
      ok((await api('POST', `/courses/${courseId}/profiles/assessment`, { data: assessment })).status === 201, T('perfil de evaluación'));
      ok((await api('POST', `/courses/${courseId}/profiles/presentation`, { data: { themeFamily: 'aula-clara', mode: 'light', brandSeed: null, themeVersion: 1 } })).status === 201, T('perfil de presentación'));
      const useDesign = async (label) => {
        for (let i = 0; i < 8; i++) {
          const card = (await api('POST', `/courses/${courseId}/design/recommendation`, {})).data;
          const pending = Math.max((card.design.changes || []).length, card.design.modules.reduce((n, m) => n + m.chapters.filter((c) => c.proposed).length, 0));
          const autoFix = card.verification.checks.some((c) => c.id === 'outcome_links');
          if (!card.profileChanged && !pending && !autoFix) return card;
          const st = await readStructure(courseId);
          if (card.profileChanged) {
            const pv = (await api('GET', `/courses/${courseId}/profiles/pedagogy`)).data;
            const r = await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: card.profile, expectedVersion: pv && !pv.isDefault ? Number(pv.version) : 0 });
            if (r.status !== 201) throw new Error(`${label}: perfil ${r.status} ${r.error}`);
          } else if (autoFix) {
            const r = await api('POST', `/courses/${courseId}/design/fix`, { action: 'link_outcomes', expectedCounter: st.structureVersionCounter });
            if (r.status !== 200) throw new Error(`${label}: vínculos ${r.status} ${r.error}`);
          } else {
            const r = await api('POST', `/courses/${courseId}/modules/apply-distribution`, { expectedCounter: st.structureVersionCounter, proposalSha256: card.design.proposalSha256 });
            if (![200, 201].includes(r.status)) throw new Error(`${label}: aplicar ${r.status} ${r.error}`);
          }
        }
        throw new Error(`${label}: el diseño no quedó estable`);
      };
      const card = await useDesign('E20');
      const sev = (kind, et) => {
        const r = (card.requirements.items || []).find((x) => x.applies && x.kind === kind && (!et || x.evaluationType === et));
        const c = r && card.verification.checks.find((k) => k.id === `requirement:${r.id}`);
        return c ? `${c.severity}|${c.title}` : null;
      };
      ok(card.hours.target === 42 && !card.verification.blocking, T('«Cursia recomienda»: Formato M (meta 42 h) y Verificación sin críticos'), card.verification.checks.filter((c) => c.severity === 'critical').map((c) => c.title));
      ok(/^warning\|Requisito no cubierto por Cursia/.test(sev('videos')), T('2 videos por capítulo (Cursia produce uno) → requisito no cubierto, explícito; no un crítico sin salida (P0-2)'), sev('videos'));
      ok(/^warning\|Excepción/.test(sev('modules')) && /^warning\|Excepción/.test(sev('target_hours')), T('4 módulos y 64 h → excepciones (el Formato M es decisión de la institución)'), [sev('modules'), sev('target_hours')]);
      ok(/^ok\|/.test(sev('evaluations', 'partial')) && /^ok\|/.test(sev('evaluations', 'final')), T('3 parciales + final: se cumplen (un parcial por módulo del Formato M y la final)'), [sev('evaluations', 'partial'), sev('evaluations', 'final')]);
      ok(sev('application_activities') && !/^critical/.test(sev('application_activities')), T('1 Actividad de Aplicación por módulo («incluye»: lectura de confianza media): visible, sin crítico'), sev('application_activities'));

      // Propuesta: no se prepara sin el motivo de CADA excepción (también la de lo que Cursia no puede producir).
      let S0 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      ok(S0.status === 'draft', T('propuesta en borrador'));
      const exKeys = S0.draft.readiness.blockers.filter((b) => b.code === 'exception_reason').map((b) => b.ref);
      ok(exKeys.length >= 3 && exKeys.some((k) => /^videos/.test(k)), T('la propuesta pide el motivo de cada excepción, incluida la de los videos'), exKeys);
      for (const k of exKeys) ok((await api('PUT', `/courses/${courseId}/prebrief/exception-reasons`, { requirementKey: k, reason: 'La institución aprueba el Formato M con un video por capítulo para el piloto.' })).status === 200, T(`motivo guardado: ${k}`));
      S0 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      for (const b of S0.draft.readiness.blockers.filter((x) => x.code === 'doubtful_data')) await api('POST', `/courses/${courseId}/prebrief/confirmations`, { confirmKey: b.ref });
      S0 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      ok(S0.draft.readiness.ready, T('propuesta lista para preparar'), S0.draft.readiness.blockers);
      const learnerRows = JSON.stringify(S0.draft.document.sections.find((s) => s.id === 'audience'));
      ok(/Técnico \/ tecnológico/.test(learnerRows) && /Procesos productivos básicos/.test(learnerRows) && !/"value":"(none|basic|intermediate|advanced|technical|university)"/.test(learnerRows) && !/rigor académico y pensamiento crítico/.test(learnerRows),
        T('Público objetivo para personas: nivel y previos con rótulo y origen, previos del documento, sin códigos ni texto interno (P1-9)'), learnerRows.slice(0, 400));
      const exDoc = S0.draft.model.exceptions.find((e) => /^videos/.test(e.requirementKey));
      ok(exDoc && exDoc.reason && exDoc.capability === true && /^Cursia contempla 1 video por capítulo de contenido/.test(exDoc.appliedText), T('«Excepciones al documento»: la de los videos (no cubierta por Cursia) con la aceptación de la institución y lo que Cursia contempla'), exDoc);

      const getPdfE20 = async (p) => { const r = await fetch(BASE + p, { headers: { authorization: `Bearer ${TOKEN}` } }); return { status: r.status, disp: r.headers.get('content-disposition'), buf: Buffer.from(await r.arrayBuffer()) }; };
      const prepareApprove = async (label) => {
        const s = (await api('GET', `/courses/${courseId}/prebrief`)).data;
        if (!s.draft.readiness.ready) throw new Error(`${label}: no está lista: ${JSON.stringify(s.draft.readiness.blockers)}`);
        const p = await api('POST', `/courses/${courseId}/prebrief/versions`, { expectedModelSha: s.draft.modelSha256 });
        if (![200, 201].includes(p.status)) throw new Error(`${label}: preparar ${p.status} ${p.error}`);
        const v = p.data.version;
        await api('POST', `/courses/${courseId}/blueprints/${v.blueprintNumber}/manifest`);
        const a = await api('POST', `/courses/${courseId}/prebrief/versions/${v.version}/approve`, { expectedModelSha: v.modelSha256, name: 'Coordinación Académica Demo', role: 'Directora académica', confirm: true });
        if (a.status !== 200) throw new Error(`${label}: aprobar ${a.status} ${a.error}`);
        return a.data.version;
      };
      let ver = await prepareApprove('E20 v1');
      ok(ver.status === 'approved' && ver.version === 1, T('v1 preparada y APROBADA'));
      ok((await api('GET', `/courses/${courseId}/prebrief`)).data.approvalFlow === true, T('preparar la propuesta deja el curso en el flujo (la generación exige la versión aprobada)'));
      const fingerprints = [ver.modelSha256];
      const pdf1 = await getPdfE20(`/courses/${courseId}/prebrief/versions/1/pdf?variant=approved`);
      ok(pdf1.status === 200 && pdf1.buf.slice(0, 5).toString() === '%PDF-' && /v1_aprobado\.pdf/.test(pdf1.disp || ''), T('PDF de la v1 aprobada'), { s: pdf1.status, d: pdf1.disp });
      const fingerprint1 = ver.modelSha256;

      // ═══ CONTRATO: después de aprobar, cada dato que cambia el producto invalida la aprobación; R68 bloquea; una versión
      // nueva se aprueba y recién ahí se puede seguir. Nunca se genera algo distinto de lo aprobado.
      const runsBaseOf = (n) => `/courses/${courseId}/blueprints/${n}/manifest/runs`;
      const ctxRun = { nombre: brief.nombre, sector: brief.sector, pais: brief.pais, contexto: brief.contexto, nivel: brief.nivel, tono: brief.tono, obj: brief.obj, scormTemplateIds: S.templates, videoMode: 'real', providerModes: { presentation: 'mock', audio: 'mock' } };
      const BLOCK = ['prebrief_stale', 'prebrief_not_approved', 'design_changed', 'structure_changed', 'pending_changes', 'stale_blueprint', 'blueprint_mismatch'];
      const pedNow = async () => (await api('GET', `/courses/${courseId}/profiles/pedagogy`)).data;
      const acNow = async () => (await api('GET', `/courses/${courseId}/profiles/academic`)).data;
      const firstChapter = async () => { const st = await readStructure(courseId); const m = st.modules[0]; return { st, m, c: m.chapters.find((x) => x.kind !== 'practice') }; };
      // LOOP 9.1 (F): también el nombre del curso y el enfoque pedagógico (además de los 14 de LOOP 9).
      let ped0 = null;
      const must2xx = (r, what) => { if (!r || r.status < 200 || r.status >= 300) throw new Error(`E20 ${what}: ${r && r.status} ${r && r.error}`); return r; };
      const MUT = [
        ['nombre', async () => { must2xx(await api('PUT', `/courses/${courseId}/brief`, { ...brief, nombre: `${brief.nombre} (versión corta)` }), 'cambiar el nombre'); },
          async () => { must2xx(await api('PUT', `/courses/${courseId}/brief`, brief), 'restaurar el nombre'); }],
        ['enfoque', async () => {
          const p = await pedNow(); ped0 = { primaryApproach: p.profile.primaryApproach || null, secondaryApproaches: p.profile.secondaryApproaches || [] };
          const next = ped0.primaryApproach === 'problemas' ? 'experiencial' : 'problemas';
          must2xx(await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: { ...p.profile, primaryApproach: next, secondaryApproaches: ped0.secondaryApproaches.filter((x) => x !== next) }, expectedVersion: Number(p.version) }), 'cambiar el enfoque');
        }, async () => {
          const p = await pedNow();
          must2xx(await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: { ...p.profile, ...ped0 }, expectedVersion: Number(p.version) }), 'restaurar el enfoque');
        }],
        ['tono', async () => { await api('PUT', `/courses/${courseId}/brief`, { ...brief, tono: 'formal y técnico' }); }, async () => { await api('PUT', `/courses/${courseId}/brief`, brief); }],
        ['horas', async () => { const p = await pedNow(); await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: { ...p.profile, targetHours: 40 }, expectedVersion: Number(p.version) }); },
          async () => { const p = await pedNow(); await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: { ...p.profile, targetHours: 42 }, expectedVersion: Number(p.version) }); }],
        ['estructura (título de capítulo)', async () => { const { st, m, c } = await firstChapter(); await api('PATCH', `/courses/${courseId}/modules/${m.id}/chapters/${c.id}`, { title: `${c.title} (revisado)`, expectedCounter: st.structureVersionCounter }); },
          async () => { const { st, m, c } = await firstChapter(); await api('PATCH', `/courses/${courseId}/modules/${m.id}/chapters/${c.id}`, { title: c.title.replace(/ \(revisado\)$/, ''), expectedCounter: st.structureVersionCounter }); }],
        ['resultados', async () => { const a = await acNow(); await api('PUT', `/courses/${courseId}/academic-context/outcomes`, { expectedVersion: Number(a.version), outcomes: a.profile.outcomes.map((o, i) => ({ id: o.id, text: i === 0 ? `${o.text} Incluye zonas de carga.` : o.text })), accept: true }); },
          async () => { const a = await acNow(); await api('PUT', `/courses/${courseId}/academic-context/outcomes`, { expectedVersion: Number(a.version), outcomes: a.profile.outcomes.map((o) => ({ id: o.id, text: o.text.replace(/ Incluye zonas de carga\.$/, '') })), accept: true }); }],
        ['estudiante', async () => { const p = await pedNow(); await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: { ...p.profile, learner: { ...p.profile.learner, description: 'Supervisores de planta con más de cinco años de experiencia.' } }, expectedVersion: Number(p.version) }); },
          null],
        ['nivel', async () => { const p = await pedNow(); await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: { ...p.profile, learner: { ...p.profile.learner, educationLevel: 'professional' } }, expectedVersion: Number(p.version) }); }, null],
        ['requisitos (motivo de una excepción)', async () => { await api('PUT', `/courses/${courseId}/prebrief/exception-reasons`, { requirementKey: exKeys[0], reason: 'Otro motivo: la coordinación pide reducir la carga del piloto.' }); }, null],
        ['formato S/M/L', async () => { await api('PUT', `/courses/${courseId}/format`, { code: 'L' }); }, async () => { await api('PUT', `/courses/${courseId}/format`, { code: 'M' }); }],
        ['videos', async () => { const { st, m, c } = await firstChapter(); await api('PATCH', `/courses/${courseId}/modules/${m.id}/chapters/${c.id}`, { videoEnabled: !c.videoEnabled, expectedCounter: st.structureVersionCounter }); },
          async () => { const { st, m, c } = await firstChapter(); await api('PATCH', `/courses/${courseId}/modules/${m.id}/chapters/${c.id}`, { videoEnabled: !c.videoEnabled, expectedCounter: st.structureVersionCounter }); }],
        ['actividades', async () => { const { st, m, c } = await firstChapter(); await api('PATCH', `/courses/${courseId}/modules/${m.id}/chapters/${c.id}`, { activityEnabled: !c.activityEnabled, expectedCounter: st.structureVersionCounter }); },
          async () => { const { st, m, c } = await firstChapter(); await api('PATCH', `/courses/${courseId}/modules/${m.id}/chapters/${c.id}`, { activityEnabled: !c.activityEnabled, expectedCounter: st.structureVersionCounter }); }],
        ['sector', async () => { await api('PUT', `/courses/${courseId}/brief`, { ...brief, sector: 'Gestión industrial' }); }, async () => { await api('PUT', `/courses/${courseId}/brief`, brief); }],
        ['tema (presentación)', async () => { const pr = (await api('GET', `/courses/${courseId}/profiles/presentation`)).data; await api('POST', `/courses/${courseId}/profiles/presentation`, { data: { themeFamily: 'oscuro-premium', mode: 'dark', brandSeed: null, themeVersion: 1 }, expectedVersion: Number(pr.version) }); },
          async () => { const pr = (await api('GET', `/courses/${courseId}/profiles/presentation`)).data; await api('POST', `/courses/${courseId}/profiles/presentation`, { data: { themeFamily: 'aula-clara', mode: 'light', brandSeed: null, themeVersion: 1 }, expectedVersion: Number(pr.version) }); }],
        ['evaluación final', async () => { const st = await readStructure(courseId); await api('PATCH', `/courses/${courseId}/structure-settings`, { finalExam: false, expectedCounter: st.structureVersionCounter }); },
          async () => { const st = await readStructure(courseId); await api('PATCH', `/courses/${courseId}/structure-settings`, { finalExam: true, expectedCounter: st.structureVersionCounter }); }],
        ['evaluación (nota mínima)', async () => { const a = (await api('GET', `/courses/${courseId}/profiles/assessment`)).data; await api('POST', `/courses/${courseId}/profiles/assessment`, { data: { ...a.profile, passingGrade: 75 }, expectedVersion: Number(a.version) }); },
          async () => { const a = (await api('GET', `/courses/${courseId}/profiles/assessment`)).data; await api('POST', `/courses/${courseId}/profiles/assessment`, { data: { ...a.profile, passingGrade: 70 }, expectedVersion: Number(a.version) }); }],
      ];
      for (const [label, mutate, revert] of MUT) {
        const before = (await api('GET', `/courses/${courseId}/prebrief`)).data.current;
        await mutate();
        const s1 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
        const latest = s1.versions[0];
        const stale = latest.version === before.version && latest.status === 'invalidated' && latest.invalidationReason === 'design_changed' && (latest.invalidationDiff || []).length > 0;
        // Un cambio de estructura que Cursia todavía no aplicó al diseño (p. ej. apagar el video de un capítulo en el editor)
        // no cambia la propuesta hasta «Usar este diseño»; mientras tanto R68 NO deja generar (la estructura viva ≠ Blueprint).
        const pendingOnly = !stale && latest.status === 'approved';
        ok(stale || pendingOnly, T(`contrato · ${label}: ${stale ? `cambiar después de aprobar invalida la v${before.version} (con lo que cambió)` : 'cambio sin aplicar al diseño: la aprobación no cubre lo que se generaría'}`), { status: latest.status, reason: latest.invalidationReason, diff: latest.invalidationDiff });
        const r = await api('POST', `${runsBaseOf(before.blueprintNumber)}/estimate-preview`, ctxRun);
        const g = await api('POST', runsBaseOf(before.blueprintNumber), ctxRun);
        ok(r.status === 409 && g.status === 409 && BLOCK.includes(g.raw && g.raw.reason), T(`contrato · ${label}: R68 bloquea el costo y la generación (409)`), { r: [r.status, r.raw && r.raw.reason], g: [g.status, g.raw && g.raw.reason, g.error] });
        if (stale) ok((await api('POST', `/courses/${courseId}/prebrief/versions/${before.version}/approve`, { expectedModelSha: before.modelSha256, name: 'Coordinación Académica Demo', role: 'Directora académica', confirm: true })).status === 409, T(`contrato · ${label}: la versión invalidada ya no se puede aprobar`));
        if (revert) await revert();
        const sR = (await api('GET', `/courses/${courseId}/prebrief`)).data;
        if (!stale) {
          // Deshacer el cambio sin aplicar: la estructura vuelve a ser la aprobada y la aprobación vigente sigue cubriéndola.
          const r2 = await api('POST', `${runsBaseOf(before.blueprintNumber)}/estimate-preview`, ctxRun);
          ok(sR.status === 'approved' && sR.current.version === before.version && r2.status === 200, T(`contrato · ${label}: deshecho, la versión aprobada vuelve a cubrir exactamente lo que se genera`), { st: sR.status, r2: [r2.status, r2.raw && r2.raw.reason] });
          continue;
        }
        ok(sR.status === 'draft' && sR.versions[0].status === 'invalidated', T(`contrato · ${label}: deshacer el cambio NO revive la aprobación (hace falta una versión nueva)`));
        if (label === 'formato S/M/L' || label === 'estructura (título de capítulo)' || label === 'videos' || label === 'actividades') await useDesign(`E20 ${label}`);
        ver = await prepareApprove(`E20 ${label}`);
        ok(ver.status === 'approved' && ver.version === before.version + 1, T(`contrato · ${label}: nueva versión v${ver.version} aprobada`));
        fingerprints.push(ver.modelSha256);
      }
      const S1 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      ok(S1.versions.filter((v) => v.status === 'approved').length === 1 && S1.current.version === ver.version, T('una sola versión aprobada vigente; las anteriores invalidadas'), S1.versions.map((v) => `v${v.version}:${v.status}`));
      ok(S1.current.modelSha256 === ver.modelSha256 && S1.draft.modelSha256 === ver.modelSha256 && fingerprints.length >= 8, T(`huella capturada en cada aprobación (${fingerprints.length}); la vigente = el borrador actual`), { fingerprints: fingerprints.length });
      ok(fingerprint1 === fingerprints[0], T('la huella de la v1 es la que se aprobó'));

      // Generación MOCK sobre la versión vigente: contexto, Blueprint y Manifest = lo aprobado.
      const n = ver.blueprintNumber;
      const runsBase = runsBaseOf(n);
      const pvw = await api('POST', `${runsBase}/estimate-preview`, ctxRun);
      ok(pvw.status === 200, T('con la versión aprobada vigente, el costo se muestra (200)'), { s: pvw.status, e: pvw.error });
      const st = await readStructure(courseId);
      llm.st.courseId = courseId;
      llm.st.chapterByTitle.clear(); llm.st.moduleByTitle.clear(); llm.st.moduleOfChapter.clear();
      for (const m of st.modules) { llm.st.moduleByTitle.set(m.title, m.id); for (const x of m.chapters) { llm.st.chapterByTitle.set(x.title, x.id); llm.st.moduleOfChapter.set(x.id, m.id); } }
      let start = await api('POST', runsBase, { ...ctxRun, tono: 'SUSURRADO', sector: 'Inventado' });
      const estM = /estimateId=([0-9a-f-]{36})/.exec(String(start.error || ''));
      if (start.status === 409 && estM) {
        await q(`insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, decision, approved_by, reason)
                 values ($1, $2, 1000, 'ADMIN_APPROVED', 'e2e-admin@cursia.test', 'e2e E20: autorización (proveedores FALSOS locales)')`, [courseId, estM[1]]);
        start = await api('POST', runsBase, { ...ctxRun, tono: 'SUSURRADO', sector: 'Inventado' });
      }
      ok(start.status === 201, T('run MOCK creado sobre la versión aprobada vigente'), { s: start.status, e: start.error });
      if (start.status !== 201) throw new Error(`E20: run no creado: ${start.status} ${start.error}`);
      const runId = start.data.run.id;
      const [ctxRow] = await q(`select context from public.generation_run_contexts where job_id = $1`, [runId]);
      const approvedCtx = S1.current.model ? S1.current.model.generationContext : (await api('GET', `/courses/${courseId}/prebrief/versions/${ver.version}`)).data.model.generationContext;
      eq(['nombre', 'sector', 'pais', 'tono', 'obj'].map((k) => ctxRow.context[k]), ['nombre', 'sector', 'pais', 'tono', 'obj'].map((k) => approvedCtx[k]), T('el run congeló el contexto APROBADO (el del navegador se ignora)'));
      llm.st.tag = 'E20';
      S.front.DYN_EXAM_BANK_MODE_ENABLED = false;
      const stt = await waitRunTerminal(S.front.dynExecutorStart({ courseId, blueprintNumber: n, runId }), 'E20 run', undefined, runId);
      const items = await waitItemsDone(runId);
      ok(stt.failed === 0 && !stt.fatalError && items.every((i) => i.status === 'completed'), T(`generación MOCK completa (${items.length} items, proveedores falsos, USD 0)`), items.filter((i) => i.status !== 'completed').map((i) => [i.item_key, i.status, (i.error_message || '').slice(0, 160)]));
      const [manRow] = await q(`select m.id, m.blueprint_id, m.manifest_json as manifest, b.snapshot_sha256 from public.course_generation_manifests m join public.course_blueprints b on b.id = m.blueprint_id
         join public.production_jobs j on (j.input_payload->>'manifestId')::int = m.id where j.id = $1`, [runId]);
      const [vRow] = await q(`select blueprint_id, blueprint_sha256 from public.course_prebrief_versions where course_id = $1 and version = $2`, [courseId, ver.version]);
      ok(manRow && Number(manRow.blueprint_id) === Number(vRow.blueprint_id) && manRow.snapshot_sha256 === vRow.blueprint_sha256, T('Blueprint generado = Blueprint de la propuesta aprobada'), { manRow: manRow && { b: manRow.blueprint_id, s: manRow.snapshot_sha256 }, vRow });
      const M = typeof manRow.manifest === 'string' ? JSON.parse(manRow.manifest) : manRow.manifest;
      const Mm = M.manifest || M;
      const verModel = (await api('GET', `/courses/${courseId}/prebrief/versions/${ver.version}`)).data.model;
      eq([Mm.modules.length, Mm.totals.videoCount, Mm.totals.applicationActivityCount], [verModel.structure.modules.length, verModel.structure.modules.reduce((a, m) => a + m.chapters.filter((c) => c.video).length, 0), verModel.structure.modules.reduce((a, m) => a + m.chapters.filter((c) => !!c.applicationMinutes).length, 0)],
        T('Manifest = Blueprint = propuesta (módulos, videos, Actividades de Aplicación)'));
      eq(items.map((i) => i.item_key).sort(), Mm.items.map((i) => i.key).sort(), T('items generados = items del Manifest'));
      // Empaque + Moodle (restore, permisos y notas): lo hace el bloque Moodle de este E2E.
      const P = await packageRun('E20', courseId, n, runId);
      const apps = Mm.items.filter((i) => i.type === 'application_activity');
      const reviewIds = ((P.job.output_summary || {}).h5pPackages || []).filter((p) => /^review_cards:/.test(p.itemKey)).map((p) => p.itemKey.slice('review_cards:'.length));
      results.courses.E20 = { courseId, spec: { passing: 70, engine: 'h5p' }, assessment, manifestModules: Mm.modules, features: Mm.features, applications: apps.length, reviewCardsChapterIds: reviewIds,
        modules: st.modules.map((m) => ({ id: m.id, title: m.title, chapters: m.chapters.map((x) => ({ id: x.id, title: x.title })) })), blueprintNumber: n, runId, items: items.length, prebriefVersions: S1.versions.length };
      // Permisos: otro usuario no ve ni aprueba la propuesta ni su PDF.
      const OTHER = jwt.sign({ sub: crypto.randomUUID(), email: 'e2e-otro@example.com', role: 'authenticated', aud: 'authenticated' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
      const o1 = await api('GET', `/courses/${courseId}/prebrief`, undefined, OTHER);
      const o2 = await api('POST', `/courses/${courseId}/prebrief/versions/${ver.version}/approve`, { expectedModelSha: ver.modelSha256, name: 'Intruso', role: 'Nadie', confirm: true }, OTHER);
      const o3 = await fetch(BASE + `/courses/${courseId}/prebrief/versions/${ver.version}/pdf`, { headers: { authorization: `Bearer ${OTHER}` } });
      ok([403, 404].includes(o1.status) && [403, 404].includes(o2.status) && [403, 404].includes(o3.status), T('otro usuario: ni ver, ni aprobar, ni descargar el PDF (403/404)'), [o1.status, o2.status, o3.status]);
    }, { fatal: false });

    // ═══ Fase 2/3 · E21 — «¿Cómo quieres estructurar tu curso?» + redistribución segura por HTTP real (USD 0, proveedores
    // FALSOS): documento de 5 unidades (18 contenidos) → forma personalizada 3 × 4 → cada contenido en un solo capítulo
    // (trazabilidad) → borrar un capítulo = «Contenido no cubierto» (crítico, bloquea) → «Incluirlos» → diseño → propuesta
    // → aprobación → Blueprint/Manifest = lo aprobado → generación MOCK → empaque → Moodle → R68 bloquea un cambio posterior.
    if (RUN_E5) await step('v3-E21-estructura-redistribucion', async () => {
      const T = (label) => `E21: ${label}`;
      const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));
      const title = '[E2E Estructura E21] Contabilidad de Costos 3 × 4';
      const cr = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title });
      ok(cr.status === 201, T('curso dinámico creado'), { s: cr.status, e: cr.error });
      const courseId = Number(cr.data.id);
      await api('POST', `/courses/${courseId}/modules`, { title: 'Módulo 1', expectedCounter: 0 });
      const brief = { nombre: 'Contabilidad de Costos', obj: 'Calcular y controlar los costos de producción', sector: 'Contabilidad', pais: 'Colombia', contexto: 'Técnico / Tecnólogo — formación técnica', nivel: 'Básico — sin conocimientos previos' };
      ok((await api('PUT', `/courses/${courseId}/brief`, brief)).status === 200, T('pedido guardado'));
      const ex = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'microcurriculo.docx', dataBase64: (await AF.fixture('consistent', 'docx')).toString('base64') }] });
      ok(ex.status === 200 && ex.data.stats.providersCalled === 0, T('documento leído (0 proveedores)'), { s: ex.status, e: ex.error });
      const sv = await api('POST', `/courses/${courseId}/profiles/academic`, { data: ex.data.draft, expectedVersion: 0 });
      ok(sv.status === 201, T('contexto académico guardado'), { s: sv.status, e: sv.error });
      const contextVersion = sv.data.profile.version;
      const A = D('modules/course-profiles/course-profiles.js');
      const assessment = { ...A.defaultAssessmentProfile({ finalExam: true }), passingGrade: 70 };
      ok((await api('POST', `/courses/${courseId}/profiles/assessment`, { data: assessment })).status === 201, T('perfil de evaluación'));
      ok((await api('POST', `/courses/${courseId}/profiles/presentation`, { data: { themeFamily: 'aula-clara', mode: 'light', brandSeed: null, themeVersion: 1 } })).status === 201, T('perfil de presentación'));

      // Paso «Estructura»: lo que encontró Cursia, lo que recomienda y los formatos (solo lectura).
      const op = await api('GET', `/courses/${courseId}/design/structure-options`);
      ok(op.status === 200 && op.data.providersCalled === 0 && op.data.hasDocumentContents && op.data.contentsCount === 18, T('opciones de estructura (18 contenidos del documento)'), { s: op.status, e: op.error });
      eq([op.data.document.shape, op.data.recommended.modules, op.data.recommended.chaptersPerModule, op.data.formats.map((f) => `${f.code}:${f.modules}x${f.chaptersPerModule}`)],
        [[4, 4, 4, 3, 3], 5, 3, ['S:3x3', 'M:3x4', 'L:4x5']], T('documento 5 unidades; Cursia recomienda un módulo por unidad (sin inventar capítulos); S/M/L son alternativas'));
      const pv1 = await api('POST', `/courses/${courseId}/design/structure-preview`, { modules: 3, chaptersPerModule: 4 });
      ok(pv1.status === 200 && pv1.data.differences.length === 0 && pv1.data.coverage.total === 18 && pv1.data.coverage.assigned === 18 && pv1.data.coverage.duplicated === 0 && pv1.data.plan.length === 3 && pv1.data.plan.every((m) => m.chapters.length === 4),
        T('vista previa 3 × 4: los 18 contenidos en 12 capítulos, sin duplicados; sin diferencias (el documento no exige una forma)'), pv1.data);
      const pvS = await api('POST', `/courses/${courseId}/design/structure-preview`, { modules: 3, chaptersPerModule: 3, format: 'S' });
      eq(pvS.data.differences.map((d) => d.text), ['El documento establece 64 horas y el Formato S es de 20–22 horas.'], T('el Formato S se aparta de las horas del documento: se dice antes de elegir'));
      const badPv = await api('POST', `/courses/${courseId}/design/structure-preview`, { modules: 0, chaptersPerModule: 4 });
      ok(badPv.status === 400, T('forma inválida → 400'), badPv.status);

      // «Usar esta estructura» (personalizada 3 × 4): redistribución con trazabilidad.
      let st = await readStructure(courseId);
      const aa = await api('POST', `/courses/${courseId}/modules/apply-academic-structure`, { expectedCounter: st.structureVersionCounter, contextVersion, shape: { modules: 3, chaptersPerModule: 4 }, choice: 'custom' });
      ok([200, 201].includes(aa.status) && aa.data.replaced.choice === 'custom' && aa.data.replaced.notes.some((t) => /ninguno se pierde ni se repite/.test(t)), T('estructura personalizada aplicada (con su nota de cobertura)'), { s: aa.status, e: aa.error, r: aa.data && aa.data.replaced });
      st = await readStructure(courseId);
      eq(st.modules.map((m) => m.chapters.length), [4, 4, 4], T('3 módulos × 4 capítulos'));
      const [meta] = await q(`select metadata -> 'contentMap' as cm, metadata -> 'structureOrigin' as so from public.courses where id = $1`, [courseId]);
      const cm = typeof meta.cm === 'string' ? JSON.parse(meta.cm) : meta.cm;
      const so = typeof meta.so === 'string' ? JSON.parse(meta.so) : meta.so;
      const liveIds = new Set(st.modules.flatMap((m) => m.chapters.map((c) => c.id)));
      const mapped = Object.values(cm.chapters).flat();
      ok(cm.contextVersion === contextVersion && Object.keys(cm.chapters).every((id) => liveIds.has(id)) && mapped.length === 18 && new Set(mapped).size === 18 && so.choice === 'custom',
        T('trazabilidad guardada: cada uno de los 18 contenidos → un capítulo vivo; elección «personalizada» en el origen'), { cm, so });
      let rec = await api('POST', `/courses/${courseId}/design/recommendation`, {});
      const contentsCheck = (r) => r.data.verification.checks.find((c) => c.id === 'contents');
      eq([contentsCheck(rec).severity, contentsCheck(rec).title], ['ok', 'Contenidos del documento: 18 de 18 en el diseño'], T('verificación: 18 de 18 contenidos'));

      // Borrar un capítulo en el editor → sus contenidos quedan sin cubrir: crítico (nunca en silencio) y la propuesta no se prepara.
      st = await readStructure(courseId);
      const victim = st.modules[1].chapters[1];
      const del = await api('DELETE', `/courses/${courseId}/modules/${st.modules[1].id}/chapters/${victim.id}`, { expectedCounter: st.structureVersionCounter });
      ok([200, 204].includes(del.status), T('capítulo borrado en el editor'), { s: del.status, e: del.error });
      rec = await api('POST', `/courses/${courseId}/design/recommendation`, {});
      const cc = contentsCheck(rec);
      ok(cc.severity === 'critical' && /^Contenido no cubierto: /.test(cc.title) && cc.fix && cc.fix.action === 'cover_contents' && rec.data.verification.blocking === true,
        T('«Contenido no cubierto» (crítico, bloquea) con «Incluirlos en un capítulo»'), cc);
      const pb0 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      ok(pb0.draft.readiness.blockers.some((b) => b.code === 'critical' && /Contenido no cubierto/.test(b.title)), T('la propuesta no se puede preparar con contenido sin cubrir'), pb0.draft.readiness.blockers.map((b) => b.title));
      st = await readStructure(courseId);
      const fx = await api('POST', `/courses/${courseId}/design/fix`, { action: 'cover_contents', expectedCounter: st.structureVersionCounter });
      ok(fx.status === 200 && fx.data.coveredContents >= 1, T('«Incluirlos en un capítulo»: los contenidos vuelven a un capítulo vecino'), { s: fx.status, d: fx.data });
      const stale = await api('POST', `/courses/${courseId}/design/fix`, { action: 'cover_contents', expectedCounter: st.structureVersionCounter });
      ok(stale.status === 409, T('con un contador viejo → 409 (concurrencia)'), stale.status);
      rec = await api('POST', `/courses/${courseId}/design/recommendation`, {});
      eq(contentsCheck(rec).severity, 'ok', T('cobertura completa otra vez'));

      // «Cursia recomienda» dentro de la forma elegida → «Usar este diseño» (igual que el cliente).
      const card = rec.data;
      const pvp = await api('GET', `/courses/${courseId}/profiles/pedagogy`);
      if (card.profileChanged) ok((await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: card.profile, expectedVersion: pvp.data.version })).status === 201, T('perfil del diseño guardado'));
      await api('POST', `/courses/${courseId}/design/hours-origin`, { proposed: card.hours.source === 'proposed' ? card.hours.target : null });
      if (card.verification.checks.some((c) => c.id === 'outcome_links')) {
        st = await readStructure(courseId);
        await api('POST', `/courses/${courseId}/design/fix`, { action: 'link_outcomes', expectedCounter: st.structureVersionCounter });
      }
      const card2 = (await api('POST', `/courses/${courseId}/design/recommendation`, {})).data;
      st = await readStructure(courseId);
      const ap = await api('POST', `/courses/${courseId}/modules/apply-distribution`, { expectedCounter: st.structureVersionCounter, proposalSha256: card2.design.proposalSha256 });
      ok([200, 201].includes(ap.status), T('diseño aplicado'), { s: ap.status, e: ap.error });
      st = await readStructure(courseId);
      eq(st.modules.map((m) => m.chapters.filter((c) => c.kind !== 'practice').length), [4, 3, 4], T('la forma elegida se conserva (Cursia no agrega ni quita capítulos de contenido)'));

      // Propuesta → aprobación (motivos de excepción y confirmaciones si las hay).
      let S0 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      for (const b of S0.draft.readiness.blockers.filter((x) => x.code === 'exception_reason')) await api('PUT', `/courses/${courseId}/prebrief/exception-reasons`, { requirementKey: b.ref, reason: 'La institución acepta esta diferencia para la prueba E21.' });
      S0 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      for (const b of S0.draft.readiness.blockers.filter((x) => x.code === 'doubtful_data')) await api('POST', `/courses/${courseId}/prebrief/confirmations`, { confirmKey: b.ref });
      S0 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      ok(S0.draft.readiness.ready, T('propuesta lista para preparar'), S0.draft.readiness.blockers);
      const rows = S0.draft.document.sections.find((x) => x.id === 'structure').blocks.filter((b) => b.t === 'kv').flatMap((b) => b.rows);
      const row = (l) => (rows.find((r) => r.label === l) || {}).value || '';
      eq([S0.draft.model.structure.selected, S0.draft.model.structure.contents], [{ choice: 'custom', label: 'Elegida por la institución' }, { total: 18, covered: 18 }], T('modelo: forma elegida por la institución; 18 de 18 contenidos'));
      ok(/^3 módulos · 11 capítulos de contenido.* · Elegida por la institución$/.test(row('Diseño seleccionado')), T('propuesta: «Diseño seleccionado … · Elegida por la institución»'), row('Diseño seleccionado'));
      eq(row('Contenidos del documento'), 'Los 18 contenidos del documento están en el diseño, cada uno en un capítulo.', T('propuesta: los 18 contenidos del documento están en el diseño'));
      ok(!/contentMap|structureOrigin|custom|undefined|null/.test(JSON.stringify(rows)), T('sin texto técnico en la propuesta'));
      const prep = await api('POST', `/courses/${courseId}/prebrief/versions`, { expectedModelSha: S0.draft.modelSha256 });
      ok(prep.status === 201, T('propuesta preparada'), { s: prep.status, e: prep.error });
      const ver = prep.data.version;
      await api('POST', `/courses/${courseId}/blueprints/${ver.blueprintNumber}/manifest`);
      const apv = await api('POST', `/courses/${courseId}/prebrief/versions/${ver.version}/approve`, { expectedModelSha: ver.modelSha256, name: 'Coordinación Académica E21', role: 'Directora académica', confirm: true });
      ok(apv.status === 200 || apv.status === 201, T('propuesta aprobada'), { s: apv.status, e: apv.error });
      const n = ver.blueprintNumber;
      const [bp] = await q(`select snapshot from public.course_blueprints where course_id = $1 and blueprint_number = $2`, [courseId, n]);
      const snap = typeof bp.snapshot === 'string' ? JSON.parse(bp.snapshot) : bp.snapshot;
      eq(snap.modules.map((m) => m.chapters.filter((c) => c.kind !== 'practice').length), [4, 3, 4], T('Blueprint = la forma aprobada'));

      // Generación MOCK sobre lo aprobado → empaque → Moodle.
      const runsBase = `/courses/${courseId}/blueprints/${n}/manifest/runs`;
      const ctxRun = { nombre: brief.nombre, sector: brief.sector, pais: brief.pais, contexto: brief.contexto, nivel: brief.nivel, tono: 'cercano y claro', obj: brief.obj, scormTemplateIds: S.templates, videoMode: 'real', providerModes: { presentation: 'mock', audio: 'mock' } };
      llm.st.courseId = courseId;
      llm.st.chapterByTitle.clear(); llm.st.moduleByTitle.clear(); llm.st.moduleOfChapter.clear();
      for (const m of st.modules) { llm.st.moduleByTitle.set(m.title, m.id); for (const x of m.chapters) { llm.st.chapterByTitle.set(x.title, x.id); llm.st.moduleOfChapter.set(x.id, m.id); } }
      let start = await api('POST', runsBase, ctxRun);
      const estM = /estimateId=([0-9a-f-]{36})/.exec(String(start.error || ''));
      if (start.status === 409 && estM) {
        await q(`insert into public.cost_budget_authorizations (course_id, estimate_id, authorized_budget, decision, approved_by, reason)
                 values ($1, $2, 1000, 'ADMIN_APPROVED', 'e2e-admin@cursia.test', 'e2e E21: autorización (proveedores FALSOS locales)')`, [courseId, estM[1]]);
        start = await api('POST', runsBase, ctxRun);
      }
      ok(start.status === 201, T('run MOCK sobre la versión aprobada'), { s: start.status, e: start.error });
      if (start.status !== 201) throw new Error(`E21: run no creado: ${start.status} ${start.error}`);
      const runId = start.data.run.id;
      llm.st.tag = 'E21';
      S.front.DYN_EXAM_BANK_MODE_ENABLED = false;
      const stt = await waitRunTerminal(S.front.dynExecutorStart({ courseId, blueprintNumber: n, runId }), 'E21 run', undefined, runId);
      const items = await waitItemsDone(runId);
      ok(stt.failed === 0 && !stt.fatalError && items.every((i) => i.status === 'completed'), T(`generación MOCK completa (${items.length} items, USD 0)`), items.filter((i) => i.status !== 'completed').map((i) => [i.item_key, i.status]));
      const [manRow] = await q(`select m.manifest_json as manifest from public.course_generation_manifests m join public.production_jobs j on (j.input_payload->>'manifestId')::int = m.id where j.id = $1`, [runId]);
      const Mf = typeof manRow.manifest === 'string' ? JSON.parse(manRow.manifest) : manRow.manifest;
      const Mm = Mf.manifest || Mf;
      eq(Mm.modules.length, 3, T('Manifest = Blueprint (3 módulos)'));
      eq(items.map((i) => i.item_key).sort(), Mm.items.map((i) => i.key).sort(), T('items generados = items del Manifest'));
      const P = await packageRun('E21', courseId, n, runId);
      results.courses.E21 = { courseId, spec: { passing: 70, engine: 'h5p' }, assessment, manifestModules: Mm.modules, features: Mm.features, applications: Mm.items.filter((i) => i.type === 'application_activity').length,
        reviewCardsChapterIds: ((P.job.output_summary || {}).h5pPackages || []).filter((p) => /^review_cards:/.test(p.itemKey)).map((p) => p.itemKey.slice('review_cards:'.length)),
        modules: st.modules.map((m) => ({ id: m.id, title: m.title, chapters: m.chapters.map((x) => ({ id: x.id, title: x.title })) })), blueprintNumber: n, runId, items: items.length };

      // R68: un cambio de estructura después de aprobar invalida la aprobación y bloquea producir (también por la API).
      st = await readStructure(courseId);
      const ch0 = st.modules[0].chapters[0];
      await api('PATCH', `/courses/${courseId}/modules/${st.modules[0].id}/chapters/${ch0.id}`, { title: `${ch0.title} (cambio)`, expectedCounter: st.structureVersionCounter });
      const blocked = await api('POST', runsBase, ctxRun);
      const BLOCK = ['prebrief_stale', 'structure_changed', 'pending_changes', 'blueprint_not_current'];
      ok(blocked.status === 409 && blocked.raw && BLOCK.includes(blocked.raw.reason), T('R68: cambio posterior → producir bloqueado por el servidor (409)'), { s: blocked.status, e: blocked.error, reason: blocked.raw && blocked.raw.reason });
      const blockedEst = await api('POST', `${runsBase}/estimate-preview`, ctxRun);
      ok(blockedEst.status === 409 && blockedEst.raw && BLOCK.includes(blockedEst.raw.reason), T('R68: tampoco el costo por la API directa'), { s: blockedEst.status, reason: blockedEst.raw && blockedEst.raw.reason });
      const S2 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      const v1 = (S2.versions || []).find((v) => v.version === ver.version);
      ok(v1 && v1.status === 'invalidated', T('la aprobación quedó invalidada'), v1 && v1.status);
      // Deshacer el cambio no revive la versión invalidada (Fase 16).
      st = await readStructure(courseId);
      await api('PATCH', `/courses/${courseId}/modules/${st.modules[0].id}/chapters/${ch0.id}`, { title: ch0.title, expectedCounter: st.structureVersionCounter });
      const S3 = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      ok((S3.versions || []).find((v) => v.version === ver.version).status === 'invalidated' && !(S3.versions || []).some((v) => v.status === 'approved'), T('deshacer el cambio NO revive la aprobación invalidada'), (S3.versions || []).map((v) => [v.version, v.status]));
      const OTHER = jwt.sign({ sub: crypto.randomUUID(), email: 'e2e-otro21@example.com', role: 'authenticated', aud: 'authenticated' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
      const o1 = await api('GET', `/courses/${courseId}/design/structure-options`, undefined, OTHER);
      const o2 = await api('POST', `/courses/${courseId}/modules/apply-academic-structure`, { expectedCounter: 0, contextVersion, shape: { modules: 2, chaptersPerModule: 2 }, choice: 'custom' }, OTHER);
      ok([403, 404].includes(o1.status) && [403, 404].includes(o2.status), T('otro usuario: ni ver las opciones ni cambiar la estructura (403/404)'), [o1.status, o2.status]);
    }, { fatal: false });

    // ═══ Fase 2.1 · E21b — documento que EXIGE 4 × 5 → la institución elige 3 × 4: la diferencia se dice antes, queda como
    // «Excepción al requisito del documento» con motivo obligatorio; volver a «según el documento» no deja excepción.
    if (RUN_E5) await step('v3-E21b-documento-vs-diseno', async () => {
      const T = (label) => `E21b: ${label}`;
      const cr = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title: '[E2E E21b] Seguridad industrial 4 × 5' });
      const courseId = Number(cr.data.id);
      await api('POST', `/courses/${courseId}/modules`, { title: 'Módulo 1', expectedCounter: 0 });
      // Documento con sección de contenidos por unidad (lo que el extractor reconoce) y estructura obligatoria 4 × 5.
      const temas = ['Peligros', 'Riesgos', 'Controles', 'Incidentes'];
      const lines = ['MICROCURRÍCULO', 'Asignatura: Seguridad industrial', 'Modalidad: Virtual', 'Intensidad horaria total: 40 horas', '',
        '1. Descripción', 'La asignatura desarrolla la gestión de la seguridad en plantas industriales.', '',
        '2. Resultados de aprendizaje', 'RA1. Identificar peligros del área de trabajo.', 'RA2. Aplicar controles de riesgo en planta.', '',
        '3. Estructura del curso', 'El curso tendrá exactamente 4 módulos. Cada módulo tendrá exactamente 5 capítulos de contenido.', '',
        '4. Contenidos', 'Unidad | Contenidos | Horas | RA'];
      temas.forEach((t, mi) => lines.push(`Unidad ${mi + 1}: ${t} en planta | ${[1, 2, 3, 4, 5].map((ci) => `${t}: tema ${ci}`).join('; ')} | 10 | RA${mi < 2 ? 1 : 2}`));
      const ex = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'seguridad.txt', dataBase64: Buffer.from(lines.join('\n'), 'utf8').toString('base64') }] });
      ok(ex.status === 200, T('documento leído'), { s: ex.status, e: ex.error });
      const sv = await api('POST', `/courses/${courseId}/profiles/academic`, { data: ex.data.draft, expectedVersion: 0 });
      const contextVersion = sv.data.profile.version;
      const op = (await api('GET', `/courses/${courseId}/design/structure-options`)).data;
      eq([op.document && op.document.shape, op.recommended.modules, op.recommended.chaptersPerModule, op.recommended.reason, op.contentsCount], [[5, 5, 5, 5], 4, 5, 'Es la estructura que exige el documento.', 20], T('el documento exige 4 × 5: Cursia recomienda esa forma'));
      const pv = (await api('POST', `/courses/${courseId}/design/structure-preview`, { modules: 3, chaptersPerModule: 4 })).data;
      ok(pv.differences.some((d) => d.text === 'El documento establece 4 módulos y has seleccionado 3 módulos.') && pv.differences.some((d) => /5 capítulos de contenido por módulo y has seleccionado 4 capítulos de contenido por módulo\.$/.test(d.text))
        && pv.coverage.assigned === 20 && pv.coverage.duplicated === 0, T('vista previa 3 × 4: «El documento establece 4 módulos y has seleccionado 3» y los 20 contenidos cubiertos'), pv);
      let st = await readStructure(courseId);
      const badDoc = await api('POST', `/courses/${courseId}/modules/apply-academic-structure`, { expectedCounter: st.structureVersionCounter, contextVersion, shape: { modules: 3, chaptersPerModule: 4 }, choice: 'document' });
      const badFmt = await api('POST', `/courses/${courseId}/modules/apply-academic-structure`, { expectedCounter: st.structureVersionCounter, contextVersion, shape: { modules: 3, chaptersPerModule: 4 }, choice: 'format' });
      ok(badDoc.status === 400 && /INVALID_CHOICE/.test(String(badDoc.error)) && badFmt.status === 400 && /FORMAT_CHOICE_MISMATCH/.test(String(badFmt.error)), T('elección incoherente → 400 (según el documento con forma; formato sin guardarlo)'), [badDoc.status, badDoc.error, badFmt.status, badFmt.error]);
      const aa = await api('POST', `/courses/${courseId}/modules/apply-academic-structure`, { expectedCounter: st.structureVersionCounter, contextVersion, shape: { modules: 3, chaptersPerModule: 4 }, choice: 'custom' });
      ok([200, 201].includes(aa.status), T('forma personalizada aplicada'), { s: aa.status, e: aa.error });
      const rec = (await api('POST', `/courses/${courseId}/design/recommendation`, {})).data;
      const exc = rec.verification.checks.filter((c) => /^Excepción al requisito del documento/.test(c.title)).map((c) => c.title);
      ok(exc.some((t) => /4 módulos/.test(t)), T('verificación: «Excepción al requisito del documento: 4 módulos» (decisión de la institución, no un conflicto)'), rec.verification.checks.filter((c) => c.severity !== 'ok').map((c) => `${c.severity} ${c.title}`));
      ok(!rec.verification.checks.some((c) => c.severity === 'critical' && /m[oó]dulos|cap[ií]tulos/.test(c.title)), T('sin críticos de estructura (no bloquea automáticamente)'));
      ok(rec.verification.checks.find((c) => c.id === 'contents').severity === 'ok', T('los 20 contenidos siguen cubiertos en 3 × 4'));
      const pb = (await api('GET', `/courses/${courseId}/prebrief`)).data;
      ok(pb.draft.readiness.blockers.some((b) => b.code === 'exception_reason' && /4 módulos/.test(b.title)), T('la propuesta pide el motivo de la excepción antes de aprobar'), pb.draft.readiness.blockers.map((b) => b.title));
      // Volver a «Según el documento»: sin excepción de estructura.
      st = await readStructure(courseId);
      const back = await api('POST', `/courses/${courseId}/modules/apply-academic-structure`, { expectedCounter: st.structureVersionCounter, contextVersion, choice: 'document', confirmReplace: true });
      ok([200, 201].includes(back.status), T('«Según el documento» aplicado'), { s: back.status, e: back.error });
      const rec2 = (await api('POST', `/courses/${courseId}/design/recommendation`, {})).data;
      ok(!rec2.verification.checks.some((c) => /^Excepción al requisito del documento: 4 módulos/.test(c.title)), T('según el documento: la estructura cumple (sin excepción)'), rec2.verification.checks.filter((c) => c.severity !== 'ok').map((c) => c.title));
    }, { fatal: false });

    // ═══ LOOP 8.5 · E17 — flujo DEFINITIVO de Cursia V2 por HTTP real, en el orden de la pantalla: pedido → microcurrículo →
    // «Lo que entendimos» (facts) → «Cursia recomienda» → Ajustar → «Usar este diseño» (perfil, horas, vínculos, aplicar) →
    // verificación → «Aprobar» (Blueprint) → Manifest = tarjeta → generación con proveedores FALSOS → Actividades de
    // Aplicación → empaque → regeneración parcial → re-empaque → Moodle (restore, permisos, notas). USD 0.
    if (RUN_E5) await step('v3-E17-flujo-v2-definitivo', async () => {
      const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));
      const DRY = D('modules/pedagogy/dry-run.js');
      const STI = D('modules/study-time/index.js');
      const MIN = D('modules/study-time/manifest-input.js');
      const usd = (plan) => (plan && plan.estimateUsd ? Number(plan.estimateUsd.expected) : null);
      const net0 = fs.existsSync(NET_LOG) ? fs.readFileSync(NET_LOG, 'utf8').length : 0;
      const title = '[E2E Flujo V2 E17] Contabilidad de Costos';
      const cr = await api('POST', '/courses/dynamic', { frontendCourseId: crypto.randomUUID(), title });
      ok(cr.status === 201, 'E17: curso dinámico creado', { s: cr.status, e: cr.error });
      const courseId = Number(cr.data.id);
      // El cliente asegura el esqueleto mínimo (1 módulo, 1 capítulo) al abrir el curso, igual que en E15.
      const sk = await api('POST', `/courses/${courseId}/modules`, { title: 'Módulo 1', expectedCounter: 0 });
      ok(sk.status === 201, 'E17: esqueleto del curso', { s: sk.status, e: sk.error });

      // Paso 1 · el pedido (lo que escribe el docente) + el microcurrículo.
      const brief = { nombre: 'Contabilidad de Costos', obj: 'Calcular y controlar los costos de producción', sector: 'Contabilidad', pais: 'Colombia', contexto: 'Técnico / Tecnólogo — formación técnica', nivel: 'Básico — sin conocimientos previos' };
      const pb = await api('PUT', `/courses/${courseId}/brief`, brief);
      ok(pb.status === 200, 'E17: pedido guardado', { s: pb.status, e: pb.error });
      const ex = await api('POST', `/courses/${courseId}/academic-context/extract`, { files: [{ name: 'microcurriculo.docx', dataBase64: (await AF.fixture('consistent', 'docx')).toString('base64') }] });
      ok(ex.status === 200 && ex.data.stats.providersCalled === 0, 'E17: microcurrículo leído (0 proveedores)', { s: ex.status, e: ex.error });
      const sv = await api('POST', `/courses/${courseId}/profiles/academic`, { data: ex.data.draft, expectedVersion: 0 });
      ok(sv.status === 201 && sv.data.derivedPedagogy && sv.data.derivedPedagogy.applied === true, 'E17: contexto guardado; el perfil pedagógico se deriva solo', { s: sv.status });

      // Paso 2 · «Lo que entendimos»: lo que sabe Cursia, con su origen.
      const f = await api('GET', `/courses/${courseId}/facts`);
      ok(f.status === 200 && f.data.outcomes.source === 'document' && f.data.targetHours.value === 64 && f.data.targetHours.source === 'document' && f.data.document.present === true,
        'E17: «Lo que entendimos»: resultados y 64 h del documento', { o: f.data && f.data.outcomes.source, h: f.data && f.data.targetHours });
      let st = await readStructure(courseId);
      const aa = await api('POST', `/courses/${courseId}/modules/apply-academic-structure`, { expectedCounter: st.structureVersionCounter, contextVersion: sv.data.profile.version });
      ok([200, 201].includes(aa.status), 'E17: «Diseñar el curso» → estructura del microcurrículo', { s: aa.status, e: aa.error });

      // Configuración del curso (evaluación y presentación) antes de diseñar: la revisión no cambia después.
      const A = D('modules/course-profiles/course-profiles.js');
      const assessment = { ...A.defaultAssessmentProfile({ finalExam: true }), passingGrade: 70 };
      ok((await api('POST', `/courses/${courseId}/profiles/assessment`, { data: assessment })).status === 201, 'E17: perfil de evaluación');
      ok((await api('POST', `/courses/${courseId}/profiles/presentation`, { data: { themeFamily: 'aula-clara', mode: 'light', brandSeed: null, themeVersion: 1 } })).status === 201, 'E17: perfil de presentación');

      // Paso 3 · «Cursia recomienda»: el docente no decide módulos, capítulos, práctica, audiovisual ni cómo llegar a las horas.
      const r1 = await api('POST', `/courses/${courseId}/design/recommendation`, {});
      ok(r1.status === 200 && r1.data.providersCalled === 0 && r1.data.hours.target === 64 && r1.data.hours.source === 'document' && r1.data.approach && r1.data.approach.source === 'recommended'
        && r1.data.preferences.audiovisual === 'recommended' && r1.data.design.applicable, 'E17: Cursia recomienda (64 h del documento, enfoque y audiovisual recomendados, aplicable)', { s: r1.status, e: r1.error });
      // Ajustar: «Más aplicación» (la meta explícita de 64 h no se toca; nada de video para inflar horas).
      const r2 = await api('POST', `/courses/${courseId}/design/recommendation`, { adjust: { emphasis: 'application' } });
      const card = r2.data;
      ok(r2.status === 200 && card.hours.target === 64 && card.design.status === 'within_tolerance' && card.design.counts.videoChapters <= r1.data.design.counts.videoChapters,
        'E17: Ajustar «Más aplicación»: mismas 64 h, sin más video', { st: card.design && card.design.status, v: [r1.data.design.counts.videoChapters, card.design && card.design.counts.videoChapters] });
      const ver0 = card.verification;
      ok(ver0 && ver0.blocking === false, 'E17: verificación sin bloqueos antes de usar el diseño', ver0 && ver0.checks.filter((c) => c.severity === 'critical').map((c) => c.title));

      // «Usar este diseño» — lo mismo que hace el cliente (52-v2-design.js v2dUse).
      const pv = await api('GET', `/courses/${courseId}/profiles/pedagogy`);
      const sp = card.profileChanged ? await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data: card.profile, expectedVersion: pv.data.version }) : { status: 201 };
      ok(sp.status === 201, 'E17: perfil del diseño guardado', { s: sp.status, e: sp.error });
      const ho = await api('POST', `/courses/${courseId}/design/hours-origin`, { proposed: card.hours.source === 'proposed' ? card.hours.target : null });
      ok(ho.status === 200, 'E17: origen de las horas registrado', { s: ho.status, e: ho.error });
      if (ver0.checks.some((c) => c.id === 'outcome_links')) {
        st = await readStructure(courseId);
        const fx = await api('POST', `/courses/${courseId}/design/fix`, { action: 'link_outcomes', expectedCounter: st.structureVersionCounter });
        ok(fx.status === 200 && fx.data.linkedChapters >= 1, 'E17: vinculación automática mostrada en la verificación, aplicada', { s: fx.status, d: fx.data });
      }
      const r3 = await api('POST', `/courses/${courseId}/design/recommendation`, {});
      ok(r3.data.profileChanged === false && r3.data.design.proposalSha256 === card.design.proposalSha256, 'E17: lo guardado = la misma huella que la tarjeta', { a: r3.data.design.proposalSha256, b: card.design.proposalSha256 });
      st = await readStructure(courseId);
      const ap = await api('POST', `/courses/${courseId}/modules/apply-distribution`, { expectedCounter: st.structureVersionCounter, proposalSha256: card.design.proposalSha256 });
      ok([200, 201].includes(ap.status), 'E17: diseño aplicado', { s: ap.status, e: ap.error });

      // Paso 4 · «Revisar y generar»: la estructura aplicada = la tarjeta; la verificación sigue limpia.
      st = await readStructure(courseId);
      const chs = st.modules.flatMap((m) => m.chapters);
      eq([chs.length, chs.filter((c) => c.kind === 'practice').length, chs.filter((c) => c.videoEnabled).length, chs.filter((c) => c.applicationMinutes).length],
        [card.design.counts.chapters, card.design.counts.practiceChapters, card.design.counts.videoChapters, card.design.counts.applicationActivities], 'E17: estructura aplicada = tarjeta (capítulos, práctica, video, Actividades de Aplicación)');
      // Capítulo por capítulo (review L85-1 M6): título, tipo, video y minutos de Actividad en el mismo orden; evaluaciones por módulo.
      const shape = (mods) => mods.map((m) => ({ exam: !!m.examEnabled, chapters: m.chapters.map((c) => [c.title, c.kind === 'practice' ? 'practice' : 'content', !!c.videoEnabled, c.applicationMinutes || null]) }));
      const cardShape = shape(card.design.modules);
      eq(shape(st.modules), cardShape, 'E17: estructura aplicada = tarjeta, capítulo por capítulo');
      const r4 = await api('POST', `/courses/${courseId}/design/recommendation`, {});
      eq(shape(r4.data.design.modules), cardShape, 'E17: «Revisar y generar» muestra la estructura aplicada, capítulo por capítulo');
      ok(r4.data.verification && r4.data.verification.blocking === false && !r4.data.verification.checks.some((c) => c.fix && c.fix.kind === 'auto') && r4.data.design.changes.length === 0,
        'E17: revisión: verificación sin bloqueos, sin correcciones automáticas pendientes y sin cambios por aplicar', r4.data.verification && r4.data.verification.checks.filter((c) => c.severity !== 'ok' && c.severity !== 'info').map((c) => c.title));
      eq([r4.data.design.counts.chapters, r4.data.design.counts.videoChapters, r4.data.design.counts.applicationActivities, r4.data.design.counts.evaluations, r4.data.design.estimatedHours],
        [card.design.counts.chapters, card.design.counts.videoChapters, card.design.counts.applicationActivities, card.design.counts.evaluations, card.design.estimatedHours], 'E17: lo que muestra «Revisar y generar» = la tarjeta usada');
      // «Aprobar y continuar»: Blueprint + Manifest = la tarjeta (capítulos, videos, actividades, evaluaciones, horas, costo).
      st = await readStructure(courseId);
      const lock = await api('POST', `/courses/${courseId}/blueprints`, { expectedCounter: st.structureVersionCounter });
      ok(lock.status === 201, 'E17: aprobado → Blueprint', { s: lock.status, e: lock.error });
      const snap = lock.data.blueprint.snapshot;
      const n = lock.data.blueprint.blueprintNumber;
      const man = await api('POST', `/courses/${courseId}/blueprints/${n}/manifest`);
      ok(man.status === 201 && man.data.manifest.rulesVersion === 3, 'E17: Manifest v3', { s: man.status, e: man.error });
      const M = man.data.manifest.manifest;
      const hoursFrozen = STI.estimateCourseStudyTime(MIN.studyTimeInputFromManifest(M, snap)).courseEstimatedHours;
      const c = card.design.counts;
      const bySnapPos = (xs) => [...xs].sort((a, b) => a.position - b.position);
      eq(shape(bySnapPos(snap.modules).map((m) => ({ ...m, chapters: bySnapPos(m.chapters) }))), cardShape, 'E17: Blueprint congelado = tarjeta, capítulo por capítulo');
      eq([M.totals.experienceCount, M.totals.videoCount, M.totals.applicationActivityCount, M.totals.examCount + M.totals.finalExamCount, hoursFrozen],
        [c.chapters, c.videoChapters, c.applicationActivities, c.evaluations, card.design.estimatedHours], 'E17: Manifest congelado = tarjeta «Cursia recomienda» (capítulos, videos, actividades, evaluaciones, horas)');
      ok(Math.abs(usd(DRY.providerPlanFor(M)) - Number(card.cost.expected)) < 0.005, 'E17: costo del Manifest = costo de la tarjeta', { frozen: usd(DRY.providerPlanFor(M)), shown: card.cost.expected });
      const apps = M.items.filter((i) => i.type === 'application_activity');
      ok(apps.length === c.applicationActivities && apps.length > 0, `E17: ${apps.length} Actividades de Aplicación en el Manifest`);

      // Generación (mock) → empaque → impacto → regeneración parcial → re-empaque; Moodle después (restore, permisos, notas).
      // Contexto del propio curso (el pedido), no el del curso de otros escenarios.
      const courseCtx = { sector: brief.sector, pais: brief.pais, contexto: brief.contexto, nivel: brief.nivel, obj: brief.obj, comp: 'Calcula y controla los costos de producción', tono: 'cercano y claro', ciudad: '' };
      await fullGenerationFlow('E17', { courseId, title, n, st, M, apps, assessment, hoursFrozen, net0, extra: { v2: true }, courseCtx });
    }, { fatal: false });

    // ═══ Moodle: restore + inspección + simulación de notas (4 MBZ) ═══
    const MOODLE_JOBS = ONLY_REAL_PROVIDERS ? [] : [['E1', 'E1'], ['E1-repack', 'E1repack'], ['E2', 'E2'], ['E3', 'E3']];
    // EV6 H5P v2: E5 entra al mismo restore + inspección (con los «Repaso» del paquete).
    if (results.mbz.E5) MOODLE_JOBS.push(['E5', 'E5']);
    // LOOP 7 · E11: el curso del flujo completo y su re-empaque tras la regeneración parcial.
    if (results.mbz.E11 && results.courses.E11) MOODLE_JOBS.push(['E11', 'E11']);
    if (results.mbz['E11-regen'] && results.courses.E11regen) MOODLE_JOBS.push(['E11-regen', 'E11regen']);
    // LOOP 8.5 · E17: el flujo V2 definitivo y su re-empaque.
    if (results.mbz.E17 && results.courses.E17) MOODLE_JOBS.push(['E17', 'E17']);
    if (results.mbz['E17-regen'] && results.courses.E17regen) MOODLE_JOBS.push(['E17-regen', 'E17regen']);
    // LOOP 9 · E20: el curso del piloto (propuesta aprobada tras el contrato) → restore, permisos y notas en Moodle.
    if (results.mbz.E20 && results.courses.E20) MOODLE_JOBS.push(['E20', 'E20']);
    // Fase 2/3 · E21: el curso con la estructura personalizada (contenidos redistribuidos) → restore, permisos y notas.
    if (results.mbz.E21 && results.courses.E21) MOODLE_JOBS.push(['E21', 'E21']);
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
