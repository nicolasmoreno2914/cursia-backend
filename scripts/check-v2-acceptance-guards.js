#!/usr/bin/env node
/* eslint-disable */
// Decisiones del owner (pre-aceptación V2). Sin DB ni red externa: módulos
// COMPILADOS de dist/, una app Nest HTTP real (ValidationPipe/filtro global
// como main.ts) con repos/DataSource falsos.
//
//  A1 Audio legacy con V2: toda ruta backend que puede producir audio legacy
//     (OpenAI TTS: POST /jobs/audio, POST /jobs/full (salvo generateAudio=false),
//     POST /jobs/:id/retry del job maestro, POST /tts/speech con courseId) con
//     un curso structure_version='dynamic' → 409 `v2_course_legacy_audio_disabled:`
//     ANTES de crear jobs/artifacts o llamar a OpenAI. Cursos legacy: igual que antes.
//  A2 audio-worker: un job backend_audio de un curso V2 se falla (no
//     reintentable) antes de cualquier gasto (orden verificado en dist/).
//  P1 Preview (DN-1 refinado): videoMode 'mock' → sin requisito de YouTube
//     (sin preflight); 'real' + ≥1 video → preflight obligatorio.
//  P2 Un .mbz nunca presenta videos mock como reales: 409 con prefijo
//     `mock_video_not_packageable:` (precheck HTTP) y el mismo prefijo en los
//     errores del parser que usa el worker.
//
// Usage: node scripts/check-v2-acceptance-guards.js [path/to/dist]

const path = require('path');
const fs = require('fs');

const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs} (¿npm run build?)\n   ${err.message}`);
    process.exit(1);
  }
}

require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ConflictException, Logger, ValidationPipe } = require('@nestjs/common');
const { DataSource } = require('typeorm');

const guard = loadDist('modules/production-jobs/legacy-audio-guard.js');
const { ProductionJobsService } = loadDist('modules/production-jobs/production-jobs.service.js');
const { ProductionJobsController } = loadDist('modules/production-jobs/production-jobs.controller.js');
const { TtsController } = loadDist('tts/tts.controller.js');
const { TtsService } = loadDist('tts/tts.service.js');
const { SupabaseJwtGuard } = loadDist('auth/supabase-jwt.guard.js');
const { AllExceptionsFilter } = loadDist('common/filters/http-exception.filter.js');
const { ResponseInterceptor } = loadDist('common/interceptors/response.interceptor.js');
const { PackagingService } = loadDist('modules/dynamic-packaging/packaging.service.js');
const resolver = loadDist('modules/dynamic-packaging/artifact-resolver.js');
const delivery = loadDist('modules/dynamic-generation/dynamic-video-delivery.js');
const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');

Logger.overrideLogger(false);

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
async function rejects(p, re, msg) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${msg}: no lanzó`);
  if (re) assert(re.test(err.message), `${msg}: mensaje inesperado "${err.message}"`);
  return err;
}

const PREFIX_AUDIO = 'v2_course_legacy_audio_disabled:';
const PREFIX_MOCK = 'mock_video_not_packageable:';
const OWNER_A = 'aa2fa9a1-afb1-4b01-8646-94a0cb272b57';
const OWNER_B = '11111111-2222-4333-8444-555555555555';
const DYN_UUID = '7f3a9c1e-1111-4222-8333-444455556666'; // empieza con dígitos a propósito
const LEG_UUID = '0b9c8d1e-2f3a-4b5c-8d6e-7f8091a2b3c4';

// ─────────────────────────────────────────────────────────────────────────────
// "DB" falsa de cursos: emula el SQL de legacy-audio-guard.ts LITERALMENTE por
// cláusulas (si el SQL no trae la exclusión de gemelos legacy o la
// preferencia por id numérico, la emulación tampoco las aplica → los tests
// I1 fallan con el SQL viejo). La semántica exacta contra Postgres real la
// valida además scratch/sa-be/i1-sql (ver reporte).
// ─────────────────────────────────────────────────────────────────────────────
const TWIN_UUID = '3c2b1a00-aaaa-4bbb-8ccc-dddddddddddd'; // legacy + gemelo V2 con el MISMO UUID
const COURSES = [
  { id: 7, owner: OWNER_A, sv: 'dynamic', frontend: DYN_UUID },
  { id: 8, owner: OWNER_A, sv: 'legacy', frontend: LEG_UUID },
  { id: 9, owner: OWNER_B, sv: 'dynamic', frontend: 'otro-front' },
  { id: 10, owner: OWNER_A, sv: 'legacy', frontend: TWIN_UUID },
  { id: 11, owner: OWNER_A, sv: 'dynamic', frontend: TWIN_UUID },
  { id: 12, owner: OWNER_B, sv: 'legacy', frontend: DYN_UUID }, // legacy de OTRO owner con el UUID V2 de A: no cuenta
];
function makeDataSource(log) {
  return {
    async query(sql, params) {
      log.push({ sql, params });
      if (/from public\.courses/.test(sql) && /structure_version = 'dynamic'/.test(sql)) {
        const [owner, numericId, raw] = params;
        const numericOnly = /\(\$2\)::bigint is null and/.test(sql); // UUID solo cuando no hay id numérico
        const excludesTwins = /not exists[\s\S]*structure_version is distinct from 'dynamic'/.test(sql);
        const byId = (c) => numericId !== null && c.id === numericId;
        const byUuid = (c) =>
          (!numericOnly || numericId === null) &&
          c.frontend === raw &&
          (!excludesTwins || !COURSES.some((l) => l.owner === owner && l.frontend === raw && l.sv !== 'dynamic'));
        return COURSES.filter((c) => c.owner === owner && c.sv === 'dynamic' && (byId(c) || byUuid(c)))
          .slice(0, 1)
          .map(() => ({ found: 1 }));
      }
      throw new Error('SQL inesperado en DataSource falso: ' + sql.slice(0, 120));
    },
  };
}
function makeRepos() {
  const state = { jobSaves: 0, stepSaves: 0, touched: [] };
  let seq = 0;
  const job = {
    create: (o) => { state.touched.push('job.create'); return { ...o }; },
    save: async (o) => { state.jobSaves++; state.touched.push('job.save'); if (!o.id) o.id = `job-${++seq}`; return o; },
    findOne: async () => { state.touched.push('job.findOne'); return state.jobForFindOne || null; },
    createQueryBuilder: () => {
      state.touched.push('job.createQueryBuilder');
      const qb = { where: () => qb, andWhere: () => qb, orderBy: () => qb, getOne: async () => null };
      return qb;
    },
  };
  const step = {
    create: (o) => ({ ...o }),
    findOne: async () => null,
    save: async (o) => { state.stepSaves++; return o; },
  };
  return { state, job, step };
}
function makeJobsService() {
  const log = [];
  const repos = makeRepos();
  const events = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : async () => undefined) });
  const svc = new ProductionJobsService(repos.job, repos.step, makeDataSource(log), events);
  svc.onModuleInit = () => {}; // sin reaper en el test
  return { svc, log, repos };
}

// ─────────────────────────────────────────────────────────────────────────────
// App HTTP real (mismo pipeline global que main.ts) con fakes
// ─────────────────────────────────────────────────────────────────────────────
class FakeJwtGuard {
  canActivate(ctx) {
    const req = ctx.switchToHttp().getRequest();
    const id = req.headers['x-test-user'];
    if (!id) {
      const { UnauthorizedException } = require('@nestjs/common');
      throw new UnauthorizedException('Token de acceso requerido');
    }
    req.user = { id, email: 'test@example.com', role: 'authenticated', raw: {} };
    return true;
  }
}
async function buildApp() {
  const jobs = makeJobsService();
  const ttsCalls = [];
  const fakeTts = {
    async synthesize(opts) {
      ttsCalls.push(opts);
      return { audioBuffer: Buffer.from('ID3fake'), voice: 'marin', model: 'gpt-4o-mini-tts', chars: String(opts.text).length };
    },
  };
  const dsLog = [];
  const moduleRef = await Test.createTestingModule({
    controllers: [ProductionJobsController, TtsController],
    providers: [
      { provide: ProductionJobsService, useValue: jobs.svc },
      { provide: TtsService, useValue: fakeTts },
      { provide: DataSource, useValue: makeDataSource(dsLog) },
    ],
  })
    .overrideGuard(SupabaseJwtGuard)
    .useClass(FakeJwtGuard)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  await app.init();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  return { app, base, jobs, ttsCalls, dsLog };
}
async function call(base, method, p, { user = OWNER_A, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch {}
  return { status: res.status, json, buf, type: res.headers.get('content-type') || '' };
}

(async () => {
  // ── A1 lógica pura ─────────────────────────────────────────────────────────
  await check('A1 isDynamicCourseFor: id numérico / UUID del frontend; UUID que empieza con dígitos NO se trata como id; otro owner no; vacío → sin query', async () => {
    const log = [];
    const q = (sql, params) => makeDataSource(log).query(sql, params);
    eq(await guard.isDynamicCourseFor(q, OWNER_A, '7'), true, 'id 7 dynamic');
    eq(await guard.isDynamicCourseFor(q, OWNER_A, 7), true, 'id 7 numérico');
    eq(await guard.isDynamicCourseFor(q, OWNER_A, DYN_UUID), true, 'uuid dynamic');
    eq(log[log.length - 1].params[1], null, 'un UUID "7f3a…" no debe convertirse en el id 7');
    eq(await guard.isDynamicCourseFor(q, OWNER_A, '8'), false, 'id 8 legacy');
    eq(await guard.isDynamicCourseFor(q, OWNER_A, LEG_UUID), false, 'uuid legacy');
    eq(await guard.isDynamicCourseFor(q, OWNER_A, '9'), false, 'curso dynamic de OTRO owner');
    eq(await guard.isDynamicCourseFor(q, OWNER_A, 'no-existe'), false, 'inexistente');
    const before = log.length;
    for (const v of [undefined, null, '', '   ']) eq(await guard.isDynamicCourseFor(q, OWNER_A, v), false, `vacío ${JSON.stringify(v)}`);
    eq(await guard.isDynamicCourseFor(q, '', '7'), false, 'sin owner');
    eq(log.length, before, 'no debe consultar la DB con id/owner vacío');
    assert(guard.v2CourseLegacyAudioDisabledMessage().startsWith(PREFIX_AUDIO), 'prefijo');
    assert(/estructura dinámica \(V2\)/.test(guard.v2CourseLegacyAudioDisabledMessage()), 'mensaje legible en español');
  });

  await check('I1 gemelos: curso legacy + gemelo V2 con el MISMO UUID → el legacy sigue con audio; id numérico decide solo por esa fila; V2 puro → bloquea', async () => {
    const log = [];
    const q = (sql, params) => makeDataSource(log).query(sql, params);
    eq(await guard.isDynamicCourseFor(q, OWNER_A, TWIN_UUID), false, 'UUID con fila legacy del mismo owner → NO bloquea');
    eq(await guard.isDynamicCourseFor(q, OWNER_A, '10'), false, 'id numérico de la fila legacy');
    eq(await guard.isDynamicCourseFor(q, OWNER_A, '11'), true, 'id numérico de la fila V2 (se actúa sobre el curso V2)');
    eq(await guard.isDynamicCourseFor(q, OWNER_A, DYN_UUID), true, 'V2 puro (el legacy con ese UUID es de OTRO owner)');
    eq(await guard.isDynamicCourseFor(q, OWNER_A, '8'), false, 'id legacy');
  });

  await check('I1 gemelos por HTTP/worker: /jobs/audio, /jobs/full, /tts/speech y el audio-worker dejan pasar el curso legacy con gemelo V2', async () => {
    const { svc, repos } = makeJobsService();
    const r = await svc.createAudioJob(OWNER_A, { courseId: TWIN_UUID, courseData: {} });
    assert(r.ok && r.jobId, `createAudioJob: ${JSON.stringify(r)}`);
    eq(repos.state.jobSaves, 1, 'job creado');
    const full = await svc.createFullCourseJob(OWNER_A, { courseId: TWIN_UUID });
    assert(full.ok && full.jobId, 'createFullCourseJob');
    // Worker: job legacy típico (frontendCourseId = UUID; courseId puede ser un parseInt() espurio
    // del UUID, p.ej. "3c2b…" → 3): nunca se falla por el gemelo V2.
    eq(await guard.isLegacyAudioBlockedForJob({ ownerId: OWNER_A, frontendCourseId: TWIN_UUID, courseId: 11 }, svc), null, 'worker: gemelo');
    eq(await guard.isLegacyAudioBlockedForJob({ ownerId: OWNER_A, frontendCourseId: TWIN_UUID, courseId: 3 }, svc), null, 'worker: parseInt espurio');
    eq(await guard.isLegacyAudioBlockedForJob({ ownerId: OWNER_A, frontendCourseId: null, courseId: 7 }, svc), guard.v2CourseLegacyAudioDisabledMessage(), 'worker: solo id numérico V2');
  });

  // ── A1 servicio (defensa en profundidad del worker maestro) ────────────────
  await check('A1 ProductionJobsService.createAudioJob (lo usa también el full-course-worker): V2 → 409 sin tocar repos; legacy → crea como siempre', async () => {
    for (const courseId of ['7', DYN_UUID]) {
      const { svc, repos } = makeJobsService();
      const err = await rejects(svc.createAudioJob(OWNER_A, { courseId, courseData: {} }), new RegExp('^' + PREFIX_AUDIO), `dynamic ${courseId}`);
      assert(err instanceof ConflictException, 'debe ser ConflictException (409)');
      eq(repos.state.touched, [], `dynamic ${courseId}: tocó repos`);
    }
    for (const courseId of ['8', LEG_UUID, 'curso-sin-fila']) {
      const { svc, repos } = makeJobsService();
      const r = await svc.createAudioJob(OWNER_A, { courseId, courseData: {} });
      assert(r.ok && r.jobId && r.executionMode === 'backend_audio', `legacy ${courseId}: ${JSON.stringify(r)}`);
      eq(repos.state.jobSaves, 1, `legacy ${courseId}: job guardado`);
    }
  });

  // ── A1 HTTP ────────────────────────────────────────────────────────────────
  const { app, base, jobs, ttsCalls } = await buildApp();
  try {
    await check('A1 POST /api/v1/jobs/audio: curso V2 (id y UUID) → 409 v2_course_legacy_audio_disabled; legacy → 201 como antes', async () => {
      for (const courseId of ['7', DYN_UUID]) {
        const before = jobs.repos.state.touched.length;
        const r = await call(base, 'POST', '/api/v1/jobs/audio', { body: { courseId, courseData: {} } });
        eq(r.status, 409, `status ${courseId}`);
        assert(String(r.json && r.json.error).startsWith(PREFIX_AUDIO), `error: ${JSON.stringify(r.json)}`);
        eq(jobs.repos.state.touched.length, before, `${courseId}: no debe tocar repos`);
      }
      for (const courseId of ['8', LEG_UUID]) {
        const r = await call(base, 'POST', '/api/v1/jobs/audio', { body: { courseId, courseData: {} } });
        eq(r.status, 201, `legacy ${courseId} ${JSON.stringify(r.json)}`);
      }
      // Otro owner con el id de un curso V2 ajeno: no es SU curso V2 → comportamiento legacy.
      eq((await call(base, 'POST', '/api/v1/jobs/audio', { user: OWNER_B, body: { courseId: '7', courseData: {} } })).status, 201, 'otro owner');
    });

    await check('A1 POST /api/v1/jobs/full: curso V2 → 409 (genera audio legacy); con generateAudio=false no aplica; legacy → 201', async () => {
      const r = await call(base, 'POST', '/api/v1/jobs/full', { body: { courseId: DYN_UUID } });
      eq(r.status, 409, 'status');
      assert(String(r.json && r.json.error).startsWith(PREFIX_AUDIO), JSON.stringify(r.json));
      eq((await call(base, 'POST', '/api/v1/jobs/full', { body: { courseId: DYN_UUID, options: { generateAudio: false } } })).status, 201, 'generateAudio=false');
      eq((await call(base, 'POST', '/api/v1/jobs/full', { body: { courseId: '8' } })).status, 201, 'legacy');
    });

    await check('A1 POST /api/v1/jobs/:id/retry (job maestro): curso V2 → 409 sin reencolar; legacy → ok', async () => {
      const mk = (frontendCourseId, options = {}) => ({
        id: 'full-1', ownerId: OWNER_A, executionMode: 'course_full_generation', status: 'failed', workerStatus: 'failed',
        frontendCourseId, courseId: null, inputPayload: { options }, outputSummary: {},
      });
      jobs.repos.state.jobForFindOne = mk(DYN_UUID);
      const saves = jobs.repos.state.jobSaves;
      const r = await call(base, 'POST', '/api/v1/jobs/full-1/retry');
      eq(r.status, 409, `status ${JSON.stringify(r.json)}`);
      assert(String(r.json && r.json.error).startsWith(PREFIX_AUDIO), JSON.stringify(r.json));
      eq(jobs.repos.state.jobSaves, saves, 'no debe reencolar');
      jobs.repos.state.jobForFindOne = mk(DYN_UUID, { generateAudio: false });
      const noAudio = await call(base, 'POST', '/api/v1/jobs/full-1/retry');
      eq(noAudio.status, 200, 'generateAudio=false: status');
      eq(jobs.repos.state.jobSaves, saves + 1, 'generateAudio=false: reencola');
      jobs.repos.state.jobForFindOne = mk(LEG_UUID);
      const ok = await call(base, 'POST', '/api/v1/jobs/full-1/retry');
      eq(ok.status, 200, 'legacy status');
      eq(jobs.repos.state.jobSaves, saves + 2, 'legacy: reencola');
      jobs.repos.state.jobForFindOne = null;
    });

    await check('A1 POST /api/v1/tts/speech: courseId de curso V2 → 409 sin llamar a OpenAI; sin courseId / legacy → audio como siempre', async () => {
      ttsCalls.length = 0;
      for (const courseId of ['7', DYN_UUID]) {
        const r = await call(base, 'POST', '/api/v1/tts/speech', { body: { text: 'Hola', courseId } });
        eq(r.status, 409, `status ${courseId}`);
        assert(String(r.json && r.json.error).startsWith(PREFIX_AUDIO), JSON.stringify(r.json));
      }
      eq(ttsCalls.length, 0, 'no debe sintetizar');
      for (const body of [{ text: 'Hola' }, { text: 'Hola', courseId: LEG_UUID }, { text: 'Hola', courseId: '8' }, { text: 'Hola', courseId: TWIN_UUID }]) {
        const r = await call(base, 'POST', '/api/v1/tts/speech', { body });
        eq(r.status, 200, `status ${JSON.stringify(body)}`);
        assert(/audio\/mpeg/.test(r.type) && r.buf.toString() === 'ID3fake', `respuesta de audio ${JSON.stringify(body)}`);
      }
      eq(ttsCalls.length, 4, 'sintetizó los 4 legacy (incluido el gemelo)');
      assert(ttsCalls.every((c) => !('courseId' in c)), 'courseId no se pasa a OpenAI');
    });
  } finally {
    await app.close();
  }

  // ── A2 audio-worker ────────────────────────────────────────────────────────
  await check('A2 isLegacyAudioBlockedForJob: V2 por frontendCourseId o courseId → mensaje; legacy → null; otros errores se propagan', async () => {
    const { svc } = makeJobsService();
    eq(await guard.isLegacyAudioBlockedForJob({ ownerId: OWNER_A, frontendCourseId: DYN_UUID, courseId: null }, svc), guard.v2CourseLegacyAudioDisabledMessage(), 'por frontendCourseId');
    eq(await guard.isLegacyAudioBlockedForJob({ ownerId: OWNER_A, frontendCourseId: null, courseId: 7 }, svc), guard.v2CourseLegacyAudioDisabledMessage(), 'por courseId');
    eq(await guard.isLegacyAudioBlockedForJob({ ownerId: OWNER_A, frontendCourseId: LEG_UUID, courseId: 8 }, svc), null, 'legacy');
    await rejects(guard.isLegacyAudioBlockedForJob({ ownerId: OWNER_A, frontendCourseId: 'x' }, { assertLegacyAudioAllowedForCourse: async () => { throw new Error('db caída'); } }), /db caída/, 'propaga');
  });

  await check('A2 audio-worker (dist): el guard V2 corre al inicio de handleAudioJob, antes del heartbeat, de OpenAI/TTS y de cualquier artifact; falla NO reintentable', () => {
    const src = fs.readFileSync(path.join(distRoot, 'workers', 'audio-worker.js'), 'utf8');
    const start = src.indexOf('async function handleAudioJob(');
    assert(start >= 0, 'handleAudioJob no encontrado');
    const body = src.slice(start);
    const g = body.indexOf('isLegacyAudioBlockedForJob)(job, jobsService)') >= 0
      ? body.indexOf('isLegacyAudioBlockedForJob)(job, jobsService)')
      : body.indexOf('isLegacyAudioBlockedForJob(job, jobsService)');
    assert(g >= 0, 'handleAudioJob no llama a isLegacyAudioBlockedForJob(job, jobsService)');
    for (const later of ['setInterval(', 'ttsService.synthesize', 'uploadMp3Artifact(', 'callOpenAiChat(', 'trackEvent(']) {
      const i = body.indexOf(later);
      assert(i < 0 || i > g, `${later} aparece antes del guard V2`);
    }
    const failCall = body.slice(g, g + 600);
    assert(/failAudioWorkerJob\(jobId, workerId, v2Blocked, false\)/.test(failCall), 'debe fallar el job como NO reintentable');
  });

  // ── P1 preview: mock sin YouTube ───────────────────────────────────────────
  await check('P1 resolveRunVideoDelivery/frozenRunVideoGate: mock (con videos) → sin preflight de YouTube; real + ≥1 video → preflight obligatorio', () => {
    const env = {};
    for (const configured of ['videogen_direct', 'youtube']) {
      const mock = delivery.resolveRunVideoDelivery({ videoCount: 3, videoMode: 'mock', configured, env });
      eq([mock.ok, mock.requiresYoutubePreflight], [true, false], `mock (${configured})`);
      const undef = delivery.resolveRunVideoDelivery({ videoCount: 3, videoMode: undefined, configured, env });
      eq([undef.ok, undef.requiresYoutubePreflight], [true, false], `sin videoMode (${configured})`);
      const none = delivery.resolveRunVideoDelivery({ videoCount: 0, videoMode: 'real', configured, env });
      eq([none.ok, none.requiresYoutubePreflight], [true, false], `real sin videos (${configured})`);
    }
    const real = delivery.resolveRunVideoDelivery({ videoCount: 1, videoMode: 'real', configured: 'youtube', env });
    eq([real.ok, real.strategy, real.requiresYoutubePreflight], [true, 'youtube', true], 'real + 1 video');
    const realDefault = delivery.resolveRunVideoDelivery({ videoCount: 1, videoMode: 'real', configured: 'videogen_direct', env });
    eq([realDefault.ok, realDefault.strategy, realDefault.requiresYoutubePreflight], [true, 'youtube', true], 'real + default');
    const frozenMock = delivery.frozenRunVideoGate({ videoWork: 2, videoMode: 'mock', strategy: 'youtube', env });
    eq([frozenMock.ok, frozenMock.requiresYoutubePreflight], [true, false], 'frozen mock');
  });

  await check('P1 RunsService.enforceVideoGate: gate mock → no llama al preflight de YouTube (sin red, sin gasto)', async () => {
    let preflightCalls = 0;
    const yt = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : async () => { preflightCalls++; return { ok: true }; }) });
    const svc = new RunsService({ query: async () => { throw new Error('DB no esperada'); } }, {}, {}, yt);
    const gate = delivery.resolveRunVideoDelivery({ videoCount: 4, videoMode: 'mock', configured: 'youtube', env: {} });
    await svc.enforceVideoGate(OWNER_A, gate);
    eq(preflightCalls, 0, 'llamadas al preflight');
  });

  // ── P2 mock nunca empaquetable ─────────────────────────────────────────────
  await check('P2 PackagingService.assertRunReady: run mock/sin videoMode con videos → 409 mock_video_not_packageable antes de tocar la DB; real o sin videos → sigue', async () => {
    const SENT = 'LLEGO_A_LA_DB';
    const mkSvc = () => {
      const st = { db: 0 };
      const svc = new PackagingService({ query: async () => { st.db++; throw new Error(SENT); } }, {}, {});
      return { svc, st };
    };
    const withVideo = { manifest: { items: [{ key: 'content:a', type: 'content' }, { key: 'video:a', type: 'video' }] } };
    const noVideo = { manifest: { items: [{ key: 'content:a', type: 'content' }] } };
    for (const payload of [{ videoMode: 'mock' }, {}, { videoMode: 'preview' }]) {
      const { svc, st } = mkSvc();
      const err = await rejects(svc.assertRunReady({ id: 'r1', input_payload: payload, worker_status: 'completed' }, withVideo), new RegExp('^' + PREFIX_MOCK), JSON.stringify(payload));
      assert(err instanceof ConflictException, '409');
      eq(st.db, 0, 'no debe tocar la DB');
      const filter = new AllExceptionsFilter();
      let sent = null;
      filter.catch(err, { switchToHttp: () => ({ getResponse: () => ({ status: () => ({ json: (b) => { sent = b; } }) }), getRequest: () => ({ url: '/x', method: 'POST' }) }) });
      eq(sent.statusCode, 409, 'filtro: status');
      assert(String(sent.error).startsWith(PREFIX_MOCK), `filtro: el body HTTP pierde el prefijo: ${JSON.stringify(sent)}`);
    }
    for (const [label, run, man] of [['real + videos', { videoMode: 'real' }, withVideo], ['mock sin videos', { videoMode: 'mock' }, noVideo]]) {
      const { svc, st } = mkSvc();
      await rejects(svc.assertRunReady({ id: 'r1', input_payload: run, worker_status: 'completed' }, man), new RegExp(SENT), label);
      eq(st.db, 1, `${label}: debe seguir al chequeo de items`);
    }
  });

  await check('P2 parseDynamicVideo (worker): mode mock / host mock / youtube mock → error con prefijo mock_video_not_packageable', () => {
    const base = { itemKey: 'video:a', videogenJobId: 'vg-1', mode: 'real', downloadUrl: 'https://cdn.videogen.io/x.mp4' };
    const cases = [
      [{ ...base, mode: 'mock' }, 'videogen_direct'],
      [{ ...base, mode: undefined }, 'videogen_direct'],
      [{ ...base, downloadUrl: 'https://mock-cdn.cursia.local/x.mp4' }, 'videogen_direct'],
      [{ ...base, mode: 'mock', delivery: 'youtube', youtubeUrl: 'https://www.youtube.com/watch?v=abcdefghijk', youtubeVideoId: 'abcdefghijk' }, 'youtube'],
    ];
    for (const [art, strategy] of cases) {
      let err = null;
      try { resolver.parseDynamicVideo(art, strategy); } catch (e) { err = e; }
      assert(err && err.message.startsWith(PREFIX_MOCK), `${JSON.stringify(art)}: ${err && err.message}`);
    }
    const ok = resolver.parseDynamicVideo(base, 'videogen_direct');
    eq(ok.url, base.downloadUrl, 'video real sigue siendo empaquetable');
    eq(resolver.MOCK_VIDEO_NOT_PACKAGEABLE, 'mock_video_not_packageable', 'constante exportada');
  });

  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
