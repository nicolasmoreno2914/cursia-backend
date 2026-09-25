#!/usr/bin/env node
/* eslint-disable */
// Fase 9 — gating de la estructura dinámica de cursos (V2) detrás de flags de
// entorno. Sin DB y sin red externa: usa los módulos COMPILADOS de dist/, una
// app Nest HTTP real (guards/pipes/filtro global como en main.ts) con
// servicios falsos, y los workers compilados como procesos hijos contra un
// "Postgres" falso (un servidor TCP que solo cuenta conexiones).
//
//  G1  DYNAMIC_COURSE_STRUCTURE (solo 'true' activa; default OFF): con el flag
//      OFF TODA ruta dynamic responde 404 con el mismo shape que el 404 nativo
//      de Nest; las rutas legacy no cambian. Con el flag ON llegan al
//      controller.
//  G3  DYNAMIC_V2_ALLOWED_OWNERS (UUIDs separados por coma): OFF → nadie;
//      ON + vacía → todos; ON + lista → solo esos owners (403 al resto) en
//      crear/buscar curso dynamic, iniciar/reabrir run y pedir paquete.
//      Entradas inválidas → falla ruidosa SOLO en caminos dynamic.
//  I1  DYNAMIC_REAL_VIDEO_OWNERS (fail closed): sin lista → nadie inicia un
//      run con videoMode 'real' (403); 'mock' siempre permitido; un run 'real'
//      ya existente (activo) se sigue devolviendo.
//      GET /api/v1/features → { dynamicCourseStructure, realVideo, coherenceLlm } por usuario.
//  F78-BE2 DYNAMIC_COHERENCE_LLM (solo 'true' exacto; fail closed): coherenceLlm
//      solo para owners que ya tienen V2; regenerateItem hereda G3 + video real.
//  G4  dynamic-item-worker / dynamic-package-worker con el flag OFF: log claro,
//      quedan inactivos sin abrir ninguna conexión a la DB (sin reclamar) y
//      terminan limpio con SIGTERM; con el flag ON intentan conectar como hoy.
//
// Usage: node scripts/check-dynamic-feature-gating.js [path/to/dist]

const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');

const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ForbiddenException, InternalServerErrorException, Logger, NotFoundException } = require('@nestjs/common');
const { PATH_METADATA, METHOD_METADATA } = require('@nestjs/common/constants');
const { RequestMethod } = require('@nestjs/common');

const features = loadDist('modules/features/dynamic-features.js');
const { isDynamicRoute, DYNAMIC_CONTROLLERS } = loadDist('modules/features/dynamic-routes.js');
const { FeaturesModule } = loadDist('modules/features/features.module.js');
const { SupabaseJwtGuard } = loadDist('auth/supabase-jwt.guard.js');
const { AllExceptionsFilter } = loadDist('common/filters/http-exception.filter.js');
const { ResponseInterceptor } = loadDist('common/interceptors/response.interceptor.js');
const { AppController } = loadDist('app.controller.js');
const { AppService } = loadDist('app.service.js');
const { CoursesController } = loadDist('modules/courses/courses.controller.js');
const { CoursesService } = loadDist('modules/courses/courses.service.js');
const { CourseStructureController } = loadDist('modules/course-structure/course-structure.controller.js');
const { CourseStructureService } = loadDist('modules/course-structure/course-structure.service.js');
const { CourseBlueprintsController } = loadDist('modules/course-blueprints/course-blueprints.controller.js');
const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
const { GenerationManifestsController } = loadDist('modules/generation-manifests/generation-manifests.controller.js');
const { GenerationManifestsService } = loadDist('modules/generation-manifests/generation-manifests.service.js');
const { RunsController } = loadDist('modules/dynamic-generation/runs.controller.js');
const { ExecutorController } = loadDist('modules/dynamic-generation/executor.controller.js');
const { RunsService } = loadDist('modules/dynamic-generation/runs.service.js');
const { CoherenceController } = loadDist('modules/coherence/coherence.controller.js');
const { CoherenceService } = loadDist('modules/coherence/coherence.service.js');
const { InvalidationController } = loadDist('modules/invalidation/invalidation.controller.js');
const { InvalidationService } = loadDist('modules/invalidation/invalidation.service.js');
const { SchedulerService } = loadDist('modules/dynamic-generation/scheduler.service.js');
const { PackagingController } = loadDist('modules/dynamic-packaging/packaging.controller.js');
const { PackagingService } = loadDist('modules/dynamic-packaging/packaging.service.js');

// ─────────────────────────────────────────────────────────────────────────────
// M1 (fix wave / review): descubrimiento automático de TODOS los controllers
// compilados en dist/, en vez de una lista escrita a mano — un controller V2
// nuevo (Fase 7/8) que no se clasifique acá hace FALLAR el check, en vez de
// pasar en silencio sin gating.
// ─────────────────────────────────────────────────────────────────────────────
function findControllerFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findControllerFiles(p));
    else if (entry.isFile() && /\.controller\.js$/.test(entry.name)) out.push(p);
  }
  return out;
}
/** Cada .controller.js compilado → sus exports que son clases con @Controller (metadata PATH_METADATA). */
function discoverControllers() {
  const found = [];
  for (const file of findControllerFiles(distRoot)) {
    const mod = require(file);
    for (const key of Object.keys(mod)) {
      const val = mod[key];
      if (typeof val === 'function' && Reflect.getMetadata(PATH_METADATA, val) !== undefined) {
        found.push({ name: val.name || key, ctrl: val, file: path.relative(distRoot, file) });
      }
    }
  }
  return found;
}
/** Los 8 controllers 100% dynamic (G1 + Fase 7/8) — deben coincidir con DYNAMIC_CONTROLLERS de dynamic-routes.ts. */
const DYNAMIC_CONTROLLER_CLASS_NAMES = new Set([
  'CourseStructureController',
  'CourseBlueprintsController',
  'GenerationManifestsController',
  'RunsController',
  'ExecutorController',
  'PackagingController',
  'CoherenceController', // Fase 7 (F7-BE)
  'InvalidationController', // Fase 8 (F8-BE)
]);
/**
 * Todo lo demás: legacy sin ninguna ruta dynamic, EXCEPTO CoursesController
 * (mixto: legacy + el único handler POST /courses/dynamic, marcado a nivel de
 * método vía isDynamicRoute, no de controller) y CourseSetupController
 * (ungated por decisión explícita del controller — no crea datos dynamic,
 * ver flag-report.md #3 y review "declined to judge").
 */
const LEGACY_CONTROLLER_CLASS_NAMES = new Set([
  'AppController',
  'AuthController',
  'YoutubeController',
  'TtsController',
  'EventsController',
  'VideoEngineController',
  'AdminDashboardController',
  'InstitutionsController',
  'ArtifactsController',
  'ProductionJobsController',
  'BrandProfilesController',
  'FeaturesController',
  'CourseVersionsController',
  'CourseSetupController',
  'CoursesController',
]);

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
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
async function rejects(p, Cls, re, msg) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${msg}: no lanzó`);
  if (Cls) assert(err instanceof Cls, `${msg}: esperaba ${Cls.name}, fue ${err && err.constructor && err.constructor.name}: ${err.message}`);
  if (re) assert(re.test(err.message), `${msg}: mensaje inesperado "${err.message}"`);
  return err;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FLAG = 'DYNAMIC_COURSE_STRUCTURE';
const ALLOW = 'DYNAMIC_V2_ALLOWED_OWNERS';
const REAL = 'DYNAMIC_REAL_VIDEO_OWNERS';
const COH_LLM = 'DYNAMIC_COHERENCE_LLM';
const OWNER_A = 'aa2fa9a1-afb1-4b01-8646-94a0cb272b57';
const OWNER_B = '11111111-2222-4333-8444-555555555555';
const OWNER_C = '99999999-8888-4777-8666-555555555555';

/** Aplica `vars` (undefined = borrar) a process.env durante fn y restaura. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
const ENV_CLEAN = { [FLAG]: undefined, [ALLOW]: undefined, [REAL]: undefined, [COH_LLM]: undefined };

// ─────────────────────────────────────────────────────────────────────────────
// App Nest HTTP real con servicios falsos
// ─────────────────────────────────────────────────────────────────────────────
const serviceCalls = [];
function fakeService(name, overrides = {}) {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined;
      return async (...args) => {
        serviceCalls.push(`${name}.${String(prop)}`);
        return { ok: true, created: true };
      };
    },
  });
}

/** Guard JWT de test: el usuario sale del header x-test-user; sin header → 401. */
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
  const moduleRef = await Test.createTestingModule({
    imports: [FeaturesModule],
    controllers: [
      AppController,
      CoursesController,
      CourseStructureController,
      CourseBlueprintsController,
      GenerationManifestsController,
      RunsController,
      ExecutorController,
      PackagingController,
      CoherenceController,
      InvalidationController,
    ],
    providers: [
      AppService,
      { provide: CoursesService, useValue: fakeService('CoursesService') },
      { provide: CourseStructureService, useValue: fakeService('CourseStructureService') },
      { provide: CourseBlueprintsService, useValue: fakeService('CourseBlueprintsService') },
      { provide: GenerationManifestsService, useValue: fakeService('GenerationManifestsService') },
      { provide: RunsService, useValue: fakeService('RunsService') },
      { provide: SchedulerService, useValue: fakeService('SchedulerService') },
      { provide: PackagingService, useValue: fakeService('PackagingService') },
      { provide: CoherenceService, useValue: fakeService('CoherenceService') },
      { provide: InvalidationService, useValue: fakeService('InvalidationService') },
    ],
  })
    .overrideGuard(SupabaseJwtGuard)
    .useClass(FakeJwtGuard)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  // Mismo pipeline global que main.ts (filtro, interceptor, prefijo).
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  await app.init();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  return { app, base };
}

const PARAM_VALUES = {
  courseId: '7',
  number: '1',
  runId: '0b9c8d1e-2f3a-4b5c-8d6e-7f8091a2b3c4',
  moduleId: '0b9c8d1e-2f3a-4b5c-8d6e-7f8091a2b3c5',
  chapterId: '0b9c8d1e-2f3a-4b5c-8d6e-7f8091a2b3c6',
  id: '0b9c8d1e-2f3a-4b5c-8d6e-7f8091a2b3c7',
  itemKey: 'content%3Aabc',
};
function fillPath(p) {
  return p.replace(/:([A-Za-z]+)/g, (_, name) => PARAM_VALUES[name] || '1');
}
function joinPath(a, b) {
  return '/' + [a, b].filter((s) => s && s !== '/').map((s) => s.replace(/^\/|\/$/g, '')).filter(Boolean).join('/');
}
/** Enumera todas las rutas de un controller vía metadata de Nest. */
function routesOf(Ctrl) {
  const base = Reflect.getMetadata(PATH_METADATA, Ctrl) || '';
  const out = [];
  for (const name of Object.getOwnPropertyNames(Ctrl.prototype)) {
    if (name === 'constructor') continue;
    const handler = Ctrl.prototype[name];
    const method = Reflect.getMetadata(METHOD_METADATA, handler);
    const sub = Reflect.getMetadata(PATH_METADATA, handler);
    if (method === undefined || sub === undefined) continue;
    out.push({ ctrl: Ctrl, name, handler, method: RequestMethod[method], path: '/api/v1' + fillPath(joinPath(base, sub)) });
  }
  return out;
}

async function call(base, method, pathName, { user, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers['x-test-user'] = user;
  const res = await fetch(base + pathName, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker como proceso hijo contra un "Postgres" falso
// ─────────────────────────────────────────────────────────────────────────────
async function runWorkerProcess(script, env, { waitMs }) {
  let connections = 0;
  const sockets = new Set();
  const server = net.createServer((s) => { connections++; sockets.add(s); s.on('error', () => {}); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const childEnv = { ...process.env, ...env, DB_HOST: '127.0.0.1', DB_PORT: String(port), NODE_ENV: 'production' };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  // cwd temporal: el ConfigModule no debe leer ningún .env del repo.
  const child = spawn(process.execPath, [path.join(distRoot, 'workers', script)], {
    cwd: os.tmpdir(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  let exited = null;
  const exitP = new Promise((r) => child.on('exit', (code, signal) => { exited = { code, signal }; r(exited); }));
  await sleep(waitMs);
  const aliveAfterWait = exited === null;
  const connectionsAfterWait = connections;
  let termExit = exited;
  if (aliveAfterWait) {
    child.kill('SIGTERM');
    termExit = await Promise.race([exitP, sleep(8000).then(() => null)]);
    if (!termExit) { child.kill('SIGKILL'); await exitP; }
  }
  for (const s of sockets) s.destroy();
  server.close();
  return { output, aliveAfterWait, connectionsAfterWait, termExit };
}

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  // ── Lógica pura de flags ───────────────────────────────────────────────────
  await check('G1 flag: solo el string exacto "true" activa; ausente/false/TRUE/1 → OFF', () => {
    const f = features.isDynamicCourseStructureEnabled;
    eq(f({}), false, 'ausente');
    eq(f({ [FLAG]: 'false' }), false, 'false');
    eq(f({ [FLAG]: 'TRUE' }), false, 'TRUE');
    eq(f({ [FLAG]: '1' }), false, '1');
    eq(f({ [FLAG]: ' true' }), false, "' true'");
    eq(f({ [FLAG]: 'true' }), true, 'true');
  });

  await check('M6 (fix wave) warnIfNearMissDynamicFlag: avisa UNA vez por proceso ante True/TRUE/1/yes/on; nunca ante ausente/false/true/basura', () => {
    const warned = [];
    const fakeLogger = { warn: (m) => warned.push(m) };
    for (const raw of ['True', 'TRUE', '1', 'yes', 'YES', 'on', 'ON']) {
      features._resetNearMissFlagWarningForTests();
      warned.length = 0;
      features.warnIfNearMissDynamicFlag(fakeLogger, { [FLAG]: raw });
      assert(warned.length === 1, `"${raw}": esperaba 1 warning, hubo ${warned.length}`);
      assert(warned[0].includes(raw) && /no activa V2/.test(warned[0]), `"${raw}": mensaje inesperado: ${warned[0]}`);
    }
    for (const env of [{}, { [FLAG]: 'false' }, { [FLAG]: 'true' }, { [FLAG]: 'basura' }, { [FLAG]: ' true' }]) {
      features._resetNearMissFlagWarningForTests();
      warned.length = 0;
      features.warnIfNearMissDynamicFlag(fakeLogger, env);
      eq(warned, [], `no debería avisar con ${JSON.stringify(env)}`);
    }
    // "Una sola vez por proceso": una segunda llamada con OTRO near-miss no vuelve a loguear.
    features._resetNearMissFlagWarningForTests();
    warned.length = 0;
    features.warnIfNearMissDynamicFlag(fakeLogger, { [FLAG]: 'True' });
    features.warnIfNearMissDynamicFlag(fakeLogger, { [FLAG]: 'yes' });
    eq(warned.length, 1, 'debería avisar una sola vez pese a dos llamadas con valores near-miss distintos');
    features._resetNearMissFlagWarningForTests();
  });

  await check('G3 matriz resolveDynamicFeatures: off / on+vacía / on+listado / on+no listado', () => {
    const r = features.resolveDynamicFeatures;
    eq(r(OWNER_A, {}).dynamicCourseStructure, false, 'off');
    eq(r(OWNER_A, { [ALLOW]: OWNER_A }).dynamicCourseStructure, false, 'off aunque esté listado');
    eq(r(OWNER_A, { [FLAG]: 'true' }).dynamicCourseStructure, true, 'on + sin lista');
    eq(r(OWNER_A, { [FLAG]: 'true', [ALLOW]: '  ' }).dynamicCourseStructure, true, 'on + lista vacía');
    eq(r(OWNER_A, { [FLAG]: 'true', [ALLOW]: `${OWNER_B}, ${OWNER_A.toUpperCase()}` }).dynamicCourseStructure, true, 'on + listado (case-insensitive, espacios)');
    eq(r(OWNER_C, { [FLAG]: 'true', [ALLOW]: `${OWNER_B},${OWNER_A}` }).dynamicCourseStructure, false, 'on + no listado');
  });

  await check('I1 matriz realVideo (fail closed): sin lista → nadie; listado → sí; no listado → no; requiere V2 habilitada', () => {
    const r = features.resolveDynamicFeatures;
    eq(r(OWNER_A, { [FLAG]: 'true' }).realVideo, false, 'lista real ausente');
    eq(r(OWNER_A, { [FLAG]: 'true', [REAL]: '' }).realVideo, false, 'lista real vacía');
    eq(r(OWNER_A, { [FLAG]: 'true', [REAL]: `,${OWNER_A}` }).realVideo, true, 'listado (entrada vacía tolerada)');
    eq(r(OWNER_B, { [FLAG]: 'true', [REAL]: OWNER_A }).realVideo, false, 'no listado');
    eq(r(OWNER_A, { [REAL]: OWNER_A }).realVideo, false, 'flag OFF');
    eq(r(OWNER_A, { [FLAG]: 'true', [ALLOW]: OWNER_B, [REAL]: OWNER_A }).realVideo, false, 'V2 no permitida para el owner');
  });

  await check('G3 lista inválida: DynamicFeatureConfigError nombrando la variable y la entrada', () => {
    let err = null;
    try { features.resolveDynamicFeatures(OWNER_A, { [FLAG]: 'true', [ALLOW]: `${OWNER_A},no-es-uuid` }); } catch (e) { err = e; }
    assert(err instanceof features.DynamicFeatureConfigError, `esperaba DynamicFeatureConfigError, fue ${err}`);
    assert(/DYNAMIC_V2_ALLOWED_OWNERS/.test(err.message) && /no-es-uuid/.test(err.message), err.message);
    err = null;
    try { features.resolveDynamicFeatures(OWNER_A, { [FLAG]: 'true', [REAL]: 'xyz' }); } catch (e) { err = e; }
    assert(err instanceof features.DynamicFeatureConfigError && /DYNAMIC_REAL_VIDEO_OWNERS/.test(err.message), `real inválida: ${err}`);
    // Flag OFF: la lista ni se parsea (legacy/boot nunca se ven afectados).
    eq(features.resolveDynamicFeatures(OWNER_A, { [ALLOW]: 'basura' }), { dynamicCourseStructure: false, realVideo: false, coherenceLlm: false }, 'off ignora lista inválida');
  });

  await check('F78-BE2 matriz coherenceLlm (fail closed): solo "true" exacto y solo con V2 permitida', () => {
    const r = features.resolveDynamicFeatures;
    eq(r(OWNER_A, { [FLAG]: 'true' }).coherenceLlm, false, 'env ausente');
    eq(r(OWNER_A, { [FLAG]: 'true', [COH_LLM]: '' }).coherenceLlm, false, 'env vacío');
    eq(r(OWNER_A, { [FLAG]: 'true', [COH_LLM]: 'true' }).coherenceLlm, true, 'true + V2 sin lista');
    for (const v of ['TRUE', 'True', '1', 'yes', 'on', ' true']) eq(r(OWNER_A, { [FLAG]: 'true', [COH_LLM]: v }).coherenceLlm, false, `valor "${v}" no activa`);
    eq(r(OWNER_A, { [COH_LLM]: 'true' }).coherenceLlm, false, 'flag V2 OFF');
    eq(r(OWNER_C, { [FLAG]: 'true', [ALLOW]: OWNER_A, [COH_LLM]: 'true' }).coherenceLlm, false, 'owner fuera de la allow-list V2');
    eq(r(OWNER_A, { [FLAG]: 'true', [ALLOW]: OWNER_A, [COH_LLM]: 'true' }).coherenceLlm, true, 'owner en la allow-list V2');
    eq(r(OWNER_A, { [FLAG]: 'true', [COH_LLM]: 'true' }).realVideo, false, 'coherenceLlm no habilita video real');
  });

  await check('G1 set de rutas: los 8 controllers dynamic (incl. Coherence/Invalidation, Fase 7/8) + solo POST /courses/dynamic de CoursesController', () => {
    for (const C of [CourseStructureController, CourseBlueprintsController, GenerationManifestsController, RunsController, ExecutorController, PackagingController, CoherenceController, InvalidationController]) {
      assert(DYNAMIC_CONTROLLERS.has(C), `${C.name} no está en el set`);
    }
    assert(isDynamicRoute(CoursesController, CoursesController.prototype.createOrGetDynamic), 'POST /courses/dynamic');
    for (const r of routesOf(CoursesController)) {
      if (r.name === 'createOrGetDynamic') continue;
      assert(!isDynamicRoute(CoursesController, r.handler), `legacy ${r.method} ${r.path} marcado dynamic`);
    }
    assert(!isDynamicRoute(AppController, AppController.prototype.getHealth), 'health');
  });

  await check('M1 (fix wave) discovery automática: TODO controller compilado en dist/ debe estar clasificado dynamic o legacy (protege Fase 7/8)', () => {
    const discovered = discoverControllers();
    assert(discovered.length >= 20, `muy pocos controllers descubiertos en dist/ (¿corrió el build?): ${discovered.length}`);
    const seenNames = new Set();
    for (const { name, file } of discovered) {
      assert(!seenNames.has(name), `controller duplicado descubierto: ${name}`);
      seenNames.add(name);
      const inDynamic = DYNAMIC_CONTROLLER_CLASS_NAMES.has(name);
      const inLegacy = LEGACY_CONTROLLER_CLASS_NAMES.has(name);
      assert(
        inDynamic || inLegacy,
        `${name} (${file}) NO está clasificado en scripts/check-dynamic-feature-gating.js — ` +
          'agregalo a DYNAMIC_CONTROLLER_CLASS_NAMES o LEGACY_CONTROLLER_CLASS_NAMES antes de mergear',
      );
      assert(!(inDynamic && inLegacy), `${name} está en ambos mapas (dynamic y legacy) a la vez`);
    }
    // Todo lo clasificado como dynamic debe haberse descubierto de verdad en dist/ (nombre no es un typo).
    for (const name of DYNAMIC_CONTROLLER_CLASS_NAMES) {
      assert(discovered.some((d) => d.name === name), `"${name}" está en DYNAMIC_CONTROLLER_CLASS_NAMES pero no se descubrió ningún controller con ese nombre en dist/`);
    }
    for (const name of LEGACY_CONTROLLER_CLASS_NAMES) {
      assert(discovered.some((d) => d.name === name), `"${name}" está en LEGACY_CONTROLLER_CLASS_NAMES pero no se descubrió ningún controller con ese nombre en dist/`);
    }
    // El mapa dynamic de este check debe coincidir 1:1 con DYNAMIC_CONTROLLERS (dynamic-routes.ts): la
    // fuente de verdad real del guard, no solo la clasificación de este test.
    const dynamicRoutesNames = new Set([...DYNAMIC_CONTROLLERS].map((C) => C.name));
    eq([...dynamicRoutesNames].sort(), [...DYNAMIC_CONTROLLER_CLASS_NAMES].sort(), 'DYNAMIC_CONTROLLERS (dynamic-routes.ts) vs. clasificación de este check');
  });

  // ── HTTP real ──────────────────────────────────────────────────────────────
  const { app, base } = await buildApp();
  const dynamicRoutes = [
    ...[CourseStructureController, CourseBlueprintsController, GenerationManifestsController, RunsController, ExecutorController, PackagingController, CoherenceController, InvalidationController].flatMap(routesOf),
    ...routesOf(CoursesController).filter((r) => r.name === 'createOrGetDynamic'),
  ];
  const legacyRoutes = [
    { method: 'GET', path: '/health', expect: 200 },
    { method: 'GET', path: '/api/v1', expect: 200 },
    { method: 'GET', path: '/api/v1/courses', expect: 200, user: OWNER_C },
    { method: 'POST', path: '/api/v1/courses', expect: 201, user: OWNER_C },
    { method: 'GET', path: '/api/v1/courses/7', expect: 200, user: OWNER_C },
    { method: 'GET', path: '/api/v1/auth/me', expect: 200, user: OWNER_C },
  ];

  try {
    await check(`HTTP: se enumeraron las rutas dynamic (${dynamicRoutes.length})`, () => {
      assert(dynamicRoutes.length >= 25, `muy pocas rutas: ${dynamicRoutes.length}`);
    });

    for (const flagValue of [undefined, 'false', 'TRUE']) {
      await check(`G1 flag ${flagValue === undefined ? 'ausente' : `"${flagValue}"`}: TODAS las rutas dynamic → 404 (con y sin auth) y el servicio no se invoca`, () =>
        withEnv({ ...ENV_CLEAN, [FLAG]: flagValue }, async () => {
          serviceCalls.length = 0;
          for (const r of dynamicRoutes) {
            for (const user of [OWNER_A, undefined]) {
              const res = await call(base, r.method, r.path, { user });
              eq(res.status, 404, `${r.method} ${r.path} (user=${user ? 'sí' : 'no'})`);
              eq(res.json && res.json.error, `Cannot ${r.method} ${r.path}`, `mensaje 404 de ${r.method} ${r.path}`);
            }
          }
          eq(serviceCalls, [], 'llamadas a servicios con el flag OFF');
        }));
    }

    await check('G1 el 404 gateado tiene el MISMO shape que el 404 nativo de Nest', () =>
      withEnv(ENV_CLEAN, async () => {
        const native = await call(base, 'GET', '/api/v1/no-existe-esta-ruta');
        const gated = await call(base, 'GET', '/api/v1/courses/7/modules', { user: OWNER_A });
        eq(native.status, 404, 'nativo');
        eq(Object.keys(gated.json).sort(), Object.keys(native.json).sort(), 'claves del body');
        eq(gated.json.statusCode, native.json.statusCode, 'statusCode');
        assert(/^Cannot GET \//.test(native.json.error) && /^Cannot GET \//.test(gated.json.error), 'formato "Cannot METHOD url"');
      }));

    for (const flagValue of [undefined, 'true']) {
      await check(`G1 legacy intacto con flag ${flagValue === undefined ? 'OFF' : 'ON'} (health, root, courses CRUD, auth/me)`, () =>
        withEnv({ ...ENV_CLEAN, [FLAG]: flagValue, [ALLOW]: 'uuid-invalido-no-afecta-legacy' }, async () => {
          for (const r of legacyRoutes) {
            const res = await call(base, r.method, r.path, { user: r.user });
            eq(res.status, r.expect, `${r.method} ${r.path}`);
          }
        }));
    }

    await check('G1 flag ON: todas las rutas dynamic llegan al controller (nunca 404 del gate)', () =>
      withEnv({ ...ENV_CLEAN, [FLAG]: 'true' }, async () => {
        for (const r of dynamicRoutes) {
          serviceCalls.length = 0;
          const res = await call(base, r.method, r.path, { user: OWNER_A });
          assert(res.status < 400 || res.status === 400, `${r.method} ${r.path} → ${res.status} ${JSON.stringify(res.json)}`);
          assert(res.status !== 404, `${r.method} ${r.path} → 404`);
          if (res.status < 400) assert(serviceCalls.length > 0, `${r.method} ${r.path}: no llegó al servicio`);
        }
        // Sin auth: el guard JWT del controller sigue actuando (401), no el gate.
        const noAuth = await call(base, 'GET', '/api/v1/courses/7/modules');
        eq(noAuth.status, 401, 'sin auth con flag ON');
      }));

    await check('G3 flag ON + lista inválida: rutas dynamic → 500 ruidoso nombrando la variable; legacy intacto', () =>
      withEnv({ ...ENV_CLEAN, [FLAG]: 'true', [ALLOW]: `${OWNER_A},nope` }, async () => {
        serviceCalls.length = 0;
        const res = await call(base, 'GET', '/api/v1/courses/7/modules', { user: OWNER_A });
        eq(res.status, 500, 'status');
        assert(/DYNAMIC_V2_ALLOWED_OWNERS/.test(JSON.stringify(res.json)), `body: ${JSON.stringify(res.json)}`);
        eq(serviceCalls, [], 'no llega al servicio');
        eq((await call(base, 'GET', '/health')).status, 200, 'health');
        eq((await call(base, 'GET', '/api/v1/courses', { user: OWNER_A })).status, 200, 'GET /courses');
      }));

    // ── I4 (release review): POST /courses legacy con structureVersion 'dynamic' ──
    const DYN_BODY = { title: 'T', structureVersion: 'dynamic' };
    for (const flagValue of [undefined, 'false', 'TRUE']) {
      await check(`I4 POST /api/v1/courses {structureVersion:'dynamic'} con flag ${flagValue === undefined ? 'ausente' : `"${flagValue}"`} → 404 (mismo shape que las rutas dynamic) y el servicio no se invoca`, () =>
        withEnv({ ...ENV_CLEAN, [FLAG]: flagValue }, async () => {
          serviceCalls.length = 0;
          const res = await call(base, 'POST', '/api/v1/courses', { user: OWNER_A, body: DYN_BODY });
          eq(res.status, 404, 'status');
          eq(res.json && res.json.error, 'Cannot POST /api/v1/courses', 'mensaje 404');
          eq(serviceCalls, [], 'llamadas a servicios');
          const legacy = await call(base, 'POST', '/api/v1/courses', { user: OWNER_A, body: { title: 'T', structureVersion: 'legacy' } });
          eq(legacy.status, 201, "structureVersion 'legacy' sigue creando");
        }));
    }
    const i4Matrix = [
      { label: 'ON + no listado → 403', env: { [FLAG]: 'true', [ALLOW]: OWNER_B }, status: 403 },
      { label: 'ON + listado → 201', env: { [FLAG]: 'true', [ALLOW]: `${OWNER_B},${OWNER_A}` }, status: 201 },
      { label: 'ON + lista vacía (staging) → 201', env: { [FLAG]: 'true' }, status: 201 },
      { label: 'ON + lista inválida → 500 nombrando la variable', env: { [FLAG]: 'true', [ALLOW]: 'nope' }, status: 500 },
    ];
    for (const m of i4Matrix) {
      await check(`I4 POST /api/v1/courses {structureVersion:'dynamic'} — ${m.label}`, () =>
        withEnv({ ...ENV_CLEAN, ...m.env }, async () => {
          serviceCalls.length = 0;
          const res = await call(base, 'POST', '/api/v1/courses', { user: OWNER_A, body: DYN_BODY });
          eq(res.status, m.status, `status ${JSON.stringify(res.json)}`);
          if (m.status === 201) eq(serviceCalls, ['CoursesService.create'], 'llega al servicio');
          else eq(serviceCalls, [], 'no llega al servicio');
          if (m.status === 403) assert(/no está habilitad/.test(JSON.stringify(res.json)), JSON.stringify(res.json));
          if (m.status === 500) assert(/DYNAMIC_V2_ALLOWED_OWNERS/.test(JSON.stringify(res.json)), JSON.stringify(res.json));
        }));
    }

    // ── /features ────────────────────────────────────────────────────────────
    const featureMatrix = [
      { label: 'flag OFF', env: {}, user: OWNER_A, want: { dynamicCourseStructure: false, realVideo: false, coherenceLlm: false } },
      { label: 'flag OFF aunque esté en ambas listas', env: { [ALLOW]: OWNER_A, [REAL]: OWNER_A, [COH_LLM]: 'true' }, user: OWNER_A, want: { dynamicCourseStructure: false, realVideo: false, coherenceLlm: false } },
      { label: 'ON + lista vacía', env: { [FLAG]: 'true' }, user: OWNER_C, want: { dynamicCourseStructure: true, realVideo: false, coherenceLlm: false } },
      { label: 'ON + lista vacía + coherencia IA', env: { [FLAG]: 'true', [COH_LLM]: 'true' }, user: OWNER_C, want: { dynamicCourseStructure: true, realVideo: false, coherenceLlm: true } },
      { label: 'ON + listado + real', env: { [FLAG]: 'true', [ALLOW]: `${OWNER_B},${OWNER_A}`, [REAL]: OWNER_A }, user: OWNER_A, want: { dynamicCourseStructure: true, realVideo: true, coherenceLlm: false } },
      { label: 'ON + listado sin real', env: { [FLAG]: 'true', [ALLOW]: `${OWNER_B},${OWNER_A}`, [REAL]: OWNER_A }, user: OWNER_B, want: { dynamicCourseStructure: true, realVideo: false, coherenceLlm: false } },
      { label: 'ON + no listado', env: { [FLAG]: 'true', [ALLOW]: OWNER_A, [REAL]: OWNER_C, [COH_LLM]: 'true' }, user: OWNER_C, want: { dynamicCourseStructure: false, realVideo: false, coherenceLlm: false } },
    ];
    for (const m of featureMatrix) {
      await check(`GET /api/v1/features — ${m.label}`, () =>
        withEnv({ ...ENV_CLEAN, ...m.env }, async () => {
          const res = await call(base, 'GET', '/api/v1/features', { user: m.user });
          eq(res.status, 200, 'status');
          eq(res.json && res.json.data, m.want, 'features');
        }));
    }
    await check('GET /api/v1/features: requiere auth (401) aun con flag OFF; lista inválida con flag ON → 500', async () => {
      await withEnv(ENV_CLEAN, async () => {
        eq((await call(base, 'GET', '/api/v1/features')).status, 401, 'sin auth');
      });
      await withEnv({ ...ENV_CLEAN, [FLAG]: 'true', [REAL]: 'xx' }, async () => {
        const res = await call(base, 'GET', '/api/v1/features', { user: OWNER_A });
        eq(res.status, 500, 'lista real inválida');
        assert(/DYNAMIC_REAL_VIDEO_OWNERS/.test(JSON.stringify(res.json)), JSON.stringify(res.json));
      });
    });
  } finally {
    await app.close();
  }

  // ── Enforcement en servicios (entry points con ownerId) ────────────────────
  const allowMatrix = [
    { label: 'flag OFF', env: {}, owner: OWNER_A, allowed: false },
    { label: 'ON + lista vacía', env: { [FLAG]: 'true' }, owner: OWNER_C, allowed: true },
    { label: 'ON + listado', env: { [FLAG]: 'true', [ALLOW]: `${OWNER_B},${OWNER_A}` }, owner: OWNER_A, allowed: true },
    { label: 'ON + no listado', env: { [FLAG]: 'true', [ALLOW]: `${OWNER_B},${OWNER_A}` }, owner: OWNER_C, allowed: false },
  ];
  const SENTINEL = 'PASO_EL_GATE';

  for (const m of allowMatrix) {
    await check(`G3 CoursesService.findOrCreateDynamic — ${m.label} → ${m.allowed ? 'permitido' : '403'}`, () =>
      withEnv({ ...ENV_CLEAN, ...m.env }, async () => {
        let repoTouched = false;
        const repo = new Proxy({}, { get() { repoTouched = true; return () => { throw new Error(SENTINEL); }; } });
        const svc = new CoursesService(repo, {});
        const p = svc.findOrCreateDynamic(m.owner, 'x@example.com', 'front-1', 'T');
        if (m.allowed) {
          await rejects(p, null, new RegExp(SENTINEL), 'debería llegar al repo');
        } else {
          const err = await rejects(p, ForbiddenException, /no está habilitad/, 'debería ser 403');
          assert(!repoTouched, 'tocó el repo antes del 403');
          assert(!/[0-9a-f]{8}-/.test(err.message), 'el mensaje no debe filtrar UUIDs');
        }
      }));

    await check(`G3 RunsService.startRun — ${m.label} → ${m.allowed ? 'permitido' : '403'}`, () =>
      withEnv({ ...ENV_CLEAN, ...m.env }, async () => {
        let manifestsCalled = false;
        const svc = new RunsService({ query: async () => { throw new Error('DB no esperada'); } }, { async get() { manifestsCalled = true; throw new Error(SENTINEL); } }, {});
        const p = svc.startRun(1, m.owner, 1, { videoMode: 'mock' });
        if (m.allowed) await rejects(p, null, new RegExp(SENTINEL), 'debería llegar al manifest');
        else {
          await rejects(p, ForbiddenException, /no está habilitad/, 'debería ser 403');
          assert(!manifestsCalled, 'consultó el manifest antes del 403');
        }
      }));

    await check(`G3 PackagingService.requestPackage — ${m.label} → ${m.allowed ? 'permitido' : '403'}`, () =>
      withEnv({ ...ENV_CLEAN, ...m.env }, async () => {
        // Tras rulesVersion 2 (fix wave review-rv2) requestPackage resuelve el
        // Manifest DEL RUN (manifestOfRun: primero la DB, después getById): lo
        // primero que toca después del gate es la DB.
        let manifestsCalled = false;
        let dbCalled = false;
        const svc = new PackagingService(
          { query: async () => { dbCalled = true; throw new Error(SENTINEL); } },
          { async get() { manifestsCalled = true; throw new Error(SENTINEL); }, async getById() { manifestsCalled = true; throw new Error(SENTINEL); } },
          {},
        );
        const p = svc.requestPackage(1, m.owner, 1, PARAM_VALUES.runId);
        if (m.allowed) await rejects(p, null, new RegExp(SENTINEL), 'debería llegar a la DB/manifest');
        else {
          await rejects(p, ForbiddenException, /no está habilitad/, 'debería ser 403');
          assert(!manifestsCalled && !dbCalled, 'consultó la DB/el manifest antes del 403');
        }
      }));
  }

  for (const m of allowMatrix) {
    await check(`G3 RunsService.regenerateItem (F78-BE2) — ${m.label} → ${m.allowed ? 'permitido' : '403'}`, () =>
      withEnv({ ...ENV_CLEAN, ...m.env }, async () => {
        let touched = false;
        const svc = new RunsService({ query: async () => { touched = true; throw new Error(SENTINEL); } }, { async get() { touched = true; throw new Error(SENTINEL); }, async getById() { touched = true; throw new Error(SENTINEL); }, async assertBlueprintAccessible() { touched = true; throw new Error(SENTINEL); } }, {});
        const p = svc.regenerateItem(1, m.owner, 1, PARAM_VALUES.runId, 'video:x', true);
        if (m.allowed) await rejects(p, null, new RegExp(SENTINEL), 'debería llegar a la DB/manifest');
        else {
          await rejects(p, ForbiddenException, /no está habilitad/, 'debería ser 403');
          assert(!touched, 'tocó la DB/el manifest antes del 403');
        }
      }));
  }
  const cohLlmMatrix = [
    { label: 'V2 permitida sin DYNAMIC_COHERENCE_LLM → 403', env: { [FLAG]: 'true' }, owner: OWNER_A, allowed: false },
    { label: 'DYNAMIC_COHERENCE_LLM=TRUE (no exacto) → 403', env: { [FLAG]: 'true', [COH_LLM]: 'TRUE' }, owner: OWNER_A, allowed: false },
    { label: 'owner fuera de la allow-list V2 → 403', env: { [FLAG]: 'true', [ALLOW]: OWNER_B, [COH_LLM]: 'true' }, owner: OWNER_A, allowed: false },
    { label: 'V2 + DYNAMIC_COHERENCE_LLM=true → permitido', env: { [FLAG]: 'true', [COH_LLM]: 'true' }, owner: OWNER_A, allowed: true },
  ];
  for (const m of cohLlmMatrix) {
    await check(`F78-BE2 CoherenceService.mergeLlm (llm-findings) — ${m.label}`, () =>
      withEnv({ ...ENV_CLEAN, ...m.env }, async () => {
        let touched = false;
        const boom = async () => { touched = true; throw new Error(SENTINEL); };
        const svc = new CoherenceService({ query: boom }, { getByNumber: boom }, { getById: boom, assertBlueprintAccessible: boom }, {});
        const p = svc.mergeLlm(1, m.owner, 1, PARAM_VALUES.runId, { model: 'm', promptSha256: 'a'.repeat(64), findings: [] });
        if (m.allowed) await rejects(p, null, new RegExp(SENTINEL), 'debería llegar a la DB');
        else {
          await rejects(p, ForbiddenException, /no está habilitad/, 'debería ser 403');
          assert(!touched, 'tocó la DB antes del 403');
        }
      }));
    await check(`F78-BE2 CoherenceService.llmInput — ${m.label}`, () =>
      withEnv({ ...ENV_CLEAN, ...m.env }, async () => {
        let touched = false;
        const boom = async () => { touched = true; throw new Error(SENTINEL); };
        const svc = new CoherenceService({ query: boom }, { getByNumber: boom }, { getById: boom, assertBlueprintAccessible: boom }, {});
        const p = svc.llmInput(1, m.owner, 1, PARAM_VALUES.runId);
        if (m.allowed) await rejects(p, null, new RegExp(SENTINEL), 'debería llegar a la DB');
        else {
          await rejects(p, ForbiddenException, /no está habilitad/, 'debería ser 403');
          assert(!touched, 'tocó la DB antes del 403');
        }
      }));
  }

  // ── I4 (release review): defensa en profundidad en los servicios ─────────
  for (const m of allowMatrix) {
    const want = m.allowed ? 'permitido' : (m.label === 'flag OFF' ? '404' : '403');
    await check(`I4 CoursesService.create({structureVersion:'dynamic'}) — ${m.label} → ${want}`, () =>
      withEnv({ ...ENV_CLEAN, ...m.env }, async () => {
        let repoTouched = false;
        const repo = new Proxy({}, { get() { repoTouched = true; return () => { throw new Error(SENTINEL); }; } });
        const p = new CoursesService(repo, {}).create({ title: 'T', structureVersion: 'dynamic' }, m.owner, 'x@example.com');
        if (m.allowed) await rejects(p, null, new RegExp(SENTINEL), 'debería llegar al repo');
        else {
          await rejects(p, m.label === 'flag OFF' ? NotFoundException : ForbiddenException, null, 'rechazo');
          assert(!repoTouched, 'tocó el repo antes del rechazo');
        }
      }));
  }
  await check("I4 CoursesService.create legacy (sin structureVersion / 'legacy') con flag OFF → llega al repo como siempre", () =>
    withEnv(ENV_CLEAN, async () => {
      for (const dto of [{ title: 'T' }, { title: 'T', structureVersion: 'legacy' }]) {
        const repo = new Proxy({}, { get() { return () => { throw new Error(SENTINEL); }; } });
        await rejects(new CoursesService(repo, {}).create(dto, OWNER_A, 'x@example.com'), null, new RegExp(SENTINEL), JSON.stringify(dto));
      }
    }));

  const boomDeps = () => {
    const state = { touched: false };
    const boom = () => { state.touched = true; throw new Error(SENTINEL); };
    const px = new Proxy({}, { get(_t, prop) { if (prop === 'then') return undefined; return (...a) => boom(); } });
    return { state, px };
  };
  const writeCalls = [
    ['CourseStructureService.createModule', (d, o) => new CourseStructureService(d.px, d.px, d.px, d.px, d.px).createModule(1, o, { title: 'M', expectedCounter: 0 })],
    ['CourseStructureService.updateModule', (d, o) => new CourseStructureService(d.px, d.px, d.px, d.px, d.px).updateModule(1, PARAM_VALUES.moduleId, o, { title: 'M', expectedCounter: 0 })],
    ['CourseStructureService.deleteModule', (d, o) => new CourseStructureService(d.px, d.px, d.px, d.px, d.px).deleteModule(1, PARAM_VALUES.moduleId, o, 0)],
    ['CourseStructureService.createChapter', (d, o) => new CourseStructureService(d.px, d.px, d.px, d.px, d.px).createChapter(1, PARAM_VALUES.moduleId, o, { title: 'C', expectedCounter: 0 })],
    ['CourseStructureService.updateChapter', (d, o) => new CourseStructureService(d.px, d.px, d.px, d.px, d.px).updateChapter(1, PARAM_VALUES.moduleId, PARAM_VALUES.chapterId, o, { title: 'C', expectedCounter: 0 })],
    ['CourseStructureService.deleteChapter', (d, o) => new CourseStructureService(d.px, d.px, d.px, d.px, d.px).deleteChapter(1, PARAM_VALUES.moduleId, PARAM_VALUES.chapterId, o, 0)],
    ['CourseStructureService.reorderModules', (d, o) => new CourseStructureService(d.px, d.px, d.px, d.px, d.px).reorderModules(1, o, { ids: [PARAM_VALUES.moduleId], expectedCounter: 0 })],
    ['CourseStructureService.reorderChapters', (d, o) => new CourseStructureService(d.px, d.px, d.px, d.px, d.px).reorderChapters(1, PARAM_VALUES.moduleId, o, { ids: [PARAM_VALUES.chapterId], expectedCounter: 0 })],
    ['CourseStructureService.moveChapter', (d, o) => new CourseStructureService(d.px, d.px, d.px, d.px, d.px).moveChapter(1, PARAM_VALUES.moduleId, PARAM_VALUES.chapterId, o, { targetModuleId: PARAM_VALUES.moduleId, targetPosition: 1, expectedCounter: 0 })],
    ['CourseBlueprintsService.lock', (d, o) => new CourseBlueprintsService(d.px).lock(1, o, 0)],
    ['GenerationManifestsService.getOrCreate', (d, o) => new GenerationManifestsService(d.px, d.px).getOrCreate(1, o, 1)],
  ];
  for (const m of allowMatrix) {
    await check(`I4 escrituras de course-structure / blueprints / manifests — ${m.label} → ${m.allowed ? 'permitido' : '403'}`, () =>
      withEnv({ ...ENV_CLEAN, ...m.env }, async () => {
        for (const [name, fn] of writeCalls) {
          const d = boomDeps();
          let p;
          try { p = Promise.resolve(fn(d, m.owner)); } catch (e) { p = Promise.reject(e); }
          if (m.allowed) await rejects(p, null, new RegExp(SENTINEL), `${name}: debería llegar a la DB`);
          else {
            await rejects(p, ForbiddenException, /no está habilitad/, `${name}: debería ser 403`);
            assert(!d.state.touched, `${name}: tocó la DB antes del 403`);
          }
        }
      }));
  }

  await check('G3 lista inválida con flag ON → 500 (InternalServerError) en findOrCreateDynamic/startRun/requestPackage', () =>
    withEnv({ ...ENV_CLEAN, [FLAG]: 'true', [ALLOW]: 'x' }, async () => {
      await rejects(new CoursesService({}, {}).findOrCreateDynamic(OWNER_A, '', 'f', 't'), InternalServerErrorException, /DYNAMIC_V2_ALLOWED_OWNERS/, 'courses');
      await rejects(new RunsService({}, {}, {}).startRun(1, OWNER_A, 1, {}), InternalServerErrorException, /DYNAMIC_V2_ALLOWED_OWNERS/, 'runs');
      await rejects(new PackagingService({}, {}, {}).requestPackage(1, OWNER_A, 1, 'r'), InternalServerErrorException, /DYNAMIC_V2_ALLOWED_OWNERS/, 'package');
    }));

  // ── I1: videoMode 'real' ─────────────────────────────────────────────────
  const CONTEXT = { nombre: 'Curso', sector: 'Salud', pais: 'Chile', contexto: 'x', nivel: 'Básico', tono: 'Formal' };
  /**
   * RunsService con DB falsa a nivel de métodos privados. `scenario`:
   *  - 'new'    → sin runs previos: la creación pasa por tx (insertRun).
   *  - 'active' → hay un run activo con `frozenMode`.
   *  - 'reopen' → el último run está cancelled con `frozenMode` (mismo contexto).
   */
  function runsServiceFor(scenario, frozenMode) {
    const state = { created: false, reopened: false };
    const manifest = { id: 42, manifest: { items: [] } };
    const svc = new RunsService({ query: async () => [{ frontend_course_id: 'front-1' }] }, { async get() { return manifest; } }, {});
    const run = (status) => ({ id: 'run-1', status, worker_status: status, input_payload: { videoMode: frozenMode } });
    svc.findActiveRunRow = async () => (scenario === 'active' ? run('running') : null);
    // I1 (review-rv2): ningún run activo de OTRO Manifest del curso en estos escenarios.
    svc.findActiveRunOnOtherManifest = async () => null;
    // Fase 8 fix wave: ningún run reemplazó a este (sin B creado con fromRun).
    svc.findSupersedingRun = async () => null;
    svc.findLatestRunRow = async () => (scenario === 'reopen' ? run('cancelled') : null);
    svc.hasPreviousItems = async () => false;
    svc.assertNoPreviousItems = async () => {};
    let contextHash = null;
    svc.loadContextRow = async () => ({ context: CONTEXT, context_hash: contextHash });
    svc.buildRunDto = async (job) => ({ id: job.id, videoMode: frozenMode });
    svc.tx = async () => { state.created = true; return 'run-new'; };
    svc.loadJobById = async () => run('queued');
    svc.reopenRun = async () => { state.reopened = true; return { created: false, reopened: true, run: { id: 'run-1' } }; };
    const hashOf = loadDist('modules/dynamic-generation/run-hash.js');
    contextHash = hashOf.canonicalContextHash(hashOf.normalizeCourseContext(CONTEXT));
    return { svc, state };
  }
  const REAL_ON = { [FLAG]: 'true' };
  const realMatrix = [
    { label: 'lista real ausente + real → 403', env: REAL_ON, owner: OWNER_A, mode: 'real', scenario: 'new', ok: false },
    { label: 'lista real vacía + real → 403', env: { ...REAL_ON, [REAL]: '' }, owner: OWNER_A, mode: 'real', scenario: 'new', ok: false },
    { label: 'listado + real → crea', env: { ...REAL_ON, [REAL]: OWNER_A }, owner: OWNER_A, mode: 'real', scenario: 'new', ok: true },
    { label: 'no listado + real → 403', env: { ...REAL_ON, [REAL]: OWNER_A }, owner: OWNER_B, mode: 'real', scenario: 'new', ok: false },
    { label: 'lista real ausente + mock → crea', env: REAL_ON, owner: OWNER_B, mode: 'mock', scenario: 'new', ok: true },
    { label: 'no listado + sin videoMode (default mock) → crea', env: { ...REAL_ON, [REAL]: OWNER_A }, owner: OWNER_B, mode: undefined, scenario: 'new', ok: true },
    { label: 'run real ACTIVO existente, owner no listado → se reanuda (200)', env: REAL_ON, owner: OWNER_B, mode: 'real', scenario: 'active', ok: true },
    { label: 'reabrir run real cancelado, no listado → 403 (nuevo gasto)', env: REAL_ON, owner: OWNER_B, mode: 'real', scenario: 'reopen', ok: false },
    { label: 'reabrir run real cancelado, listado → reabre', env: { ...REAL_ON, [REAL]: OWNER_B }, owner: OWNER_B, mode: 'real', scenario: 'reopen', ok: true },
    { label: 'reabrir run mock cancelado, no listado → reabre', env: REAL_ON, owner: OWNER_B, mode: 'mock', scenario: 'reopen', ok: true },
  ];
  for (const m of realMatrix) {
    await check(`I1 startRun videoMode — ${m.label}`, () =>
      withEnv({ ...ENV_CLEAN, ...m.env }, async () => {
        const { svc, state } = runsServiceFor(m.scenario, m.mode === undefined ? 'mock' : m.mode);
        const body = { ...CONTEXT };
        if (m.mode !== undefined) body.videoMode = m.mode;
        const p = svc.startRun(1, m.owner, 1, body);
        if (m.ok) {
          const res = await p;
          if (m.scenario === 'new') assert(state.created && res.created === true, 'no creó el run');
          if (m.scenario === 'active') assert(!state.created && res.created === false && res.run.id === 'run-1', 'no devolvió el run activo');
          if (m.scenario === 'reopen') assert(state.reopened, 'no reabrió');
        } else {
          await rejects(p, ForbiddenException, /video real/i, 'debería ser 403');
          assert(!state.created && !state.reopened, 'creó/reabrió pese al 403');
        }
      }));
  }
  await check('I1 lista real inválida + real → 500 ruidoso; + mock → no afecta', () =>
    withEnv({ ...ENV_CLEAN, [FLAG]: 'true', [REAL]: 'zz' }, async () => {
      const a = runsServiceFor('new', 'real');
      await rejects(a.svc.startRun(1, OWNER_A, 1, { ...CONTEXT, videoMode: 'real' }), InternalServerErrorException, /DYNAMIC_REAL_VIDEO_OWNERS/, 'real');
      assert(!a.state.created, 'creó');
      const b = runsServiceFor('new', 'mock');
      await b.svc.startRun(1, OWNER_A, 1, { ...CONTEXT, videoMode: 'mock' });
      assert(b.state.created, 'mock no creó');
    }));

  // ── I1 (fix wave): retryItem NO debe poder reabrir/gastar video real
  // esquivando DYNAMIC_REAL_VIDEO_OWNERS (retry ≠ resume, ruling del
  // controller). También debe respetar DYNAMIC_V2_ALLOWED_OWNERS como
  // cualquier otro entry point. ──────────────────────────────────────────────
  /**
   * RunsService.retryItem con DB falsa a nivel de queryRunner: `job` es la fila
   * cruda de production_jobs (con input_payload.videoMode ya congelado),
   * `locked.worker_status` decide si el run está activo o terminal (reabre),
   * `items` es la única fila del item a reintentar (sin dependientes, para no
   * ejercitar dependentsToUnblock en este harness).
   */
  function retryItemServiceFor({ frozenMode, lockedStatus, itemType, itemError }) {
    const state = { targetUpdated: false, runReopened: false };
    const job = { id: 'run-1', status: lockedStatus, worker_status: lockedStatus, input_payload: { videoMode: frozenMode } };
    const locked = { id: 'run-1', status: lockedStatus, worker_status: lockedStatus };
    const target = {
      id: 'item-1',
      item_key: 'k1',
      status: 'failed',
      depends_on: [],
      type: itemType,
      error: itemError ?? 'some_error',
      output_summary: {},
    };
    const svc = new RunsService({ query: async () => [{ id: target.id, item_key: target.item_key, type: itemType, status: 'pending' }] }, { async get() { return { id: 42, manifest: { items: [] } }; } }, {});
    svc.loadRunRow = async () => job;
    // Fix wave review-rv2: retryItem resuelve el Manifest DEL RUN (manifestOfRun), no el configurado.
    svc.manifestOfRun = async () => svc.manifests.get();
    svc.reconcileCancellation = async (j) => j;
    svc.tx = async (fn) =>
      fn({
        query: async (sql, params) => {
          // I1 (review-rv2): lock por curso + "¿otro run activo en el curso?" (no hay).
          if (/pg_advisory_xact_lock/.test(sql)) return [];
          // Fase 8 fix wave: "¿otro run se creó desde este (fromRun)?" (no).
          if (/fromRunId/.test(sql)) return [];
          if (/from public\.production_jobs pj/.test(sql)) return [];
          if (/from public\.production_jobs where id = \$1\s*$/m.test(sql.trim()) || /select id, status, worker_status from public\.production_jobs/.test(sql)) {
            return [locked];
          }
          if (/select id, item_key, status, depends_on, type, error, output_summary/.test(sql)) {
            return [target];
          }
          if (/update public\.generation_item_runs/.test(sql) && /set status = 'pending'/.test(sql) && /where id = \$1 and status = 'failed'/.test(sql)) {
            state.targetUpdated = true;
            return [{ id: params[0] }];
          }
          if (/where id = any\(\$1::uuid\[\]\)/.test(sql)) {
            return [];
          }
          if (/update public\.production_jobs/.test(sql) && /set status = 'queued'/.test(sql)) {
            state.runReopened = true;
            return [];
          }
          throw new Error('SQL inesperado en fake qr de retryItem: ' + sql);
        },
      });
    return { svc, state };
  }
  const retryRealMatrix = [
    { label: 'real + item video, run activo, no listado → 403', frozenMode: 'real', lockedStatus: 'running', itemType: 'video', resubmit: false, ok: false },
    { label: 'real + item video, run activo, listado → reintenta', frozenMode: 'real', lockedStatus: 'running', itemType: 'video', resubmit: false, ok: true },
    { label: 'real + item no-video, run ACTIVO (no reabre), no listado → reintenta (no es gasto nuevo)', frozenMode: 'real', lockedStatus: 'running', itemType: 'content', resubmit: false, ok: true, forceUnlisted: true },
    { label: 'real + item no-video, run TERMINADO (reabre), no listado → 403', frozenMode: 'real', lockedStatus: 'failed', itemType: 'content', resubmit: false, ok: false },
    { label: 'real + item no-video, run TERMINADO (reabre), listado → reabre', frozenMode: 'real', lockedStatus: 'failed', itemType: 'content', resubmit: false, ok: true },
    { label: 'real + resubmitVideo=true, no listado → 403', frozenMode: 'real', lockedStatus: 'running', itemType: 'video', resubmit: true, itemError: 'videogen_failed', ok: false },
    { label: 'mock + item video, run activo, no listado → siempre permitido', frozenMode: 'mock', lockedStatus: 'running', itemType: 'video', resubmit: false, ok: true, forceUnlisted: true },
  ];
  for (const m of retryRealMatrix) {
    const env = m.ok && !m.forceUnlisted ? { ...REAL_ON, [REAL]: OWNER_A } : REAL_ON;
    await check(`I1 retryItem videoMode — ${m.label}`, () =>
      withEnv({ ...ENV_CLEAN, ...env }, async () => {
        const { svc, state } = retryItemServiceFor({ frozenMode: m.frozenMode, lockedStatus: m.lockedStatus, itemType: m.itemType, itemError: m.itemError });
        const p = svc.retryItem(1, OWNER_A, 1, 'run-1', 'k1', m.resubmit);
        if (m.ok) {
          await p;
          assert(state.targetUpdated, 'no reintentó el item');
        } else {
          await rejects(p, ForbiddenException, /video real/i, 'debería ser 403 (video real no habilitado)');
          assert(!state.targetUpdated && !state.runReopened, 'mutó DB pese al 403');
        }
      }));
  }
  await check('I1 retryItem: DYNAMIC_V2_ALLOWED_OWNERS también aplica (owner no listado → 403 sin tocar el run)', () =>
    withEnv({ ...ENV_CLEAN, [FLAG]: 'true', [ALLOW]: OWNER_B }, async () => {
      const { svc, state } = retryItemServiceFor({ frozenMode: 'mock', lockedStatus: 'running', itemType: 'content' });
      const err = await rejects(svc.retryItem(1, OWNER_A, 1, 'run-1', 'k1', false), ForbiddenException, /no está habilitad/, 'debería ser 403');
      assert(!state.targetUpdated, 'mutó DB pese al 403');
    }));
  await check('I1 retryItem: flag OFF → 403 antes de tocar el manifest/run', () =>
    withEnv(ENV_CLEAN, async () => {
      const { svc, state } = retryItemServiceFor({ frozenMode: 'mock', lockedStatus: 'running', itemType: 'content' });
      let manifestCalled = false;
      svc.manifests = { async get() { manifestCalled = true; throw new Error('no debería llamarse'); } };
      await rejects(svc.retryItem(1, OWNER_A, 1, 'run-1', 'k1', false), ForbiddenException, /no está habilitad/, 'debería ser 403');
      assert(!manifestCalled, 'llamó al manifest antes del 403');
      assert(!state.targetUpdated, 'mutó DB pese al 403');
    }));

  // ── G4 workers ─────────────────────────────────────────────────────────────
  for (const script of ['dynamic-item-worker.js', 'dynamic-package-worker.js']) {
    await check(`G4 ${script} flag OFF: log claro, sigue vivo, 0 conexiones a la DB, SIGTERM → exit 0`, async () => {
      const r = await runWorkerProcess(script, { [FLAG]: undefined, [ALLOW]: undefined, [REAL]: undefined }, { waitMs: 3500 });
      assert(/DYNAMIC_COURSE_STRUCTURE desactivado: el worker no reclama jobs/.test(r.output), `sin log claro:\n${r.output}`);
      assert(r.aliveAfterWait, `el proceso terminó solo (loop de restart en PM2): ${JSON.stringify(r.termExit)}\n${r.output}`);
      eq(r.connectionsAfterWait, 0, 'conexiones a la DB');
      assert(r.termExit && r.termExit.code === 0, `SIGTERM: ${JSON.stringify(r.termExit)}`);
    });
    await check(`G4 ${script} flag ON: arranca como hoy (intenta conectar a la DB)`, async () => {
      const r = await runWorkerProcess(script, { [FLAG]: 'true' }, { waitMs: 4000 });
      assert(!/el worker no reclama jobs/.test(r.output), 'no debería quedar inactivo');
      assert(r.connectionsAfterWait > 0, `no intentó conectar a la DB:\n${r.output}`);
    });
    await check(`M6 (fix wave) ${script} flag "True" (near-miss): sigue OFF (idle) Y avisa que no activó V2`, async () => {
      const r = await runWorkerProcess(script, { [FLAG]: 'True', [ALLOW]: undefined, [REAL]: undefined }, { waitMs: 3500 });
      assert(/DYNAMIC_COURSE_STRUCTURE desactivado: el worker no reclama jobs/.test(r.output), `sin log claro de OFF:\n${r.output}`);
      assert(/DYNAMIC_COURSE_STRUCTURE="True" no activa V2/.test(r.output), `sin warning de near-miss:\n${r.output}`);
      eq(r.connectionsAfterWait, 0, 'conexiones a la DB (debe seguir OFF)');
    });
  }

  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
