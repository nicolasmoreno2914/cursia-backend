#!/usr/bin/env node
/* eslint-disable */
// Cursia R16 — rendimiento del editor de estructura (course-structure.service).
//
// PG16 desechable (puerto libre ≠ 5570), mismas migraciones que staging:
//   - reorder de módulos / capítulos y move de capítulo = UNA sentencia
//     set-based con el +1 del counter plegado (4 idas y vueltas por request,
//     +1 solo si hay Blueprint vigente para calcular liveMatchesCurrentBlueprint);
//   - el resultado es el mismo que el algoritmo anterior (loop por fila), las
//     posiciones quedan contiguas y los unique deferrable no molestan;
//   - 409 con counter viejo (mismo cuerpo {message, currentCounter}), sin
//     escribir; dos reorders concurrentes con el mismo counter → uno 409;
//   - los 400/404 de siempre, con la misma precedencia;
//   - la respuesta trae lo que usa el editor para no pedir el GET:
//     structureVersionCounter + filas cambiadas (+ liveMatchesCurrentBlueprint),
//     y coincide con lo que devolvería el GET.
//   - edición de campos / altas / toggles de curso con el counter plegado
//     (menos idas y vueltas, misma respuesta).
//
// Usage: node scripts/check-course-structure-set-based.js [path/to/dist]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const distArg = args.find((a) => !a.startsWith('--'));
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), distArg || 'dist');

function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}\n   ¿Corriste \`npm run build\`?\n   ${err.message}`);
    process.exit(1);
  }
}

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`);
}
async function rejectsWith(p, status, re, m) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${m}: no lanzó`);
  const st = err.getStatus ? err.getStatus() : undefined;
  assert(st === status, `${m}: status ${st} (esperado ${status}) — ${err.message}`);
  if (re) {
    const text = err.message + ' ' + JSON.stringify(err.getResponse ? err.getResponse() : '');
    assert(re.test(text), `${m}: mensaje inesperado "${text.slice(0, 300)}"`);
  }
  return err;
}

function findPgBin() {
  const cands = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean);
  for (const d of cands) {
    const pg = path.join(d, 'postgres');
    if (!fs.existsSync(pg)) continue;
    const v = spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '';
    if (/\b16\./.test(v)) return d;
  }
  throw new Error('No encontré Postgres 16 (setear PG_BIN)');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => (port === 5570 ? freePort().then(resolve, reject) : resolve(port)));
    });
  });
}
function cleanEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) env[k] = String(v);
  return env;
}

// Algoritmo ANTERIOR del move (loop por fila), como referencia pura.
function referenceMove(sourceIds, targetIds, chapterId, targetPosition) {
  const src = sourceIds.filter((id) => id !== chapterId);
  const clamped = Math.min(targetPosition, targetIds.length);
  const tgt = targetIds.slice();
  tgt.splice(clamped, 0, chapterId);
  return { src, tgt };
}

async function main() {
  require('reflect-metadata');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { NotFoundException, Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const { CourseModule } = loadDist('modules/course-structure/entities/course-module.entity.js');
  const { CourseChapter } = loadDist('modules/course-structure/entities/course-chapter.entity.js');
  const { CourseStructureService } = loadDist('modules/course-structure/course-structure.service.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r16-structure-pg16-'));
  const DB = 'structdb';
  let started = false;
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = {
    flag: process.env.DYNAMIC_COURSE_STRUCTURE, allow: process.env.DYNAMIC_V2_ALLOWED_OWNERS,
    rules: process.env.DYNAMIC_MANIFEST_RULES_VERSION, unowned: process.env.ALLOW_UNOWNED_COURSES,
  };
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`Postgres ${pgBin} en 127.0.0.1:${port} (data ${dataDir})`);
    const withClient = async (db, fn) => {
      const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db });
      await c.connect();
      try { return await fn(c); } finally { await c.end(); }
    };
    await withClient('postgres', (c) => c.query(`create database ${DB}`));
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql',
        'supabase-migration-course-blueprints.sql', 'supabase-migration-v21-blueprint-profiles.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });

    await check('migraciones: los unique de posición de módulos y capítulos son DEFERRABLE INITIALLY DEFERRED (requisito del UPDATE set-based)', async () => {
      const rows = await withClient(DB, async (c) => (await c.query(
        `select conrelid::regclass::text as t, condeferrable, condeferred, pg_get_constraintdef(oid) as def
           from pg_constraint where contype = 'u' and conrelid in ('public.course_modules'::regclass, 'public.course_chapters'::regclass)
          order by 1`)).rows);
      const pos = rows.filter((x) => /\(course_id, "?position"?\)|\(module_id, "?position"?\)/.test(x.def));
      eq(pos.map((x) => [x.t, x.condeferrable, x.condeferred]), [['course_chapters', true, true], ['course_modules', true, true]], 'unique de posición');
    });

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [CourseModule, CourseChapter], synchronize: false, extra: { max: 6 } });
    await ds.initialize();

    // Contador de idas y vueltas por request: cada queryRunner.query (TypeORM manda
    // START TRANSACTION / COMMIT / ROLLBACK también por query(), así que cuentan).
    const rt = { n: 0 };
    const origCreate = ds.createQueryRunner.bind(ds);
    ds.createQueryRunner = function (...a) {
      const qr = origCreate(...a);
      const orig = qr.query.bind(qr);
      qr.query = function (...b) { rt.n++; return orig(...b); };
      return qr;
    };
    const measure = async (fn) => { rt.n = 0; const out = await fn(); return { out, rts: rt.n }; };

    const OWNER = '11111111-2222-4333-8444-555555555555';
    const coursesStub = {
      async findOne(id) { throw new NotFoundException(`Course #${id} not found (stub)`); },
    };
    const blueprints = new CourseBlueprintsService(ds);
    const S = new CourseStructureService(ds.getRepository(CourseModule), ds.getRepository(CourseChapter), coursesStub, ds, blueprints);

    const newCourse = async (title) => (await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, $2, 'dynamic') returning id`, [OWNER, title]))[0].id;
    const counter = async (cid) => (await S.getStructure(cid, OWNER)).structureVersionCounter;
    const sortedMods = (s) => s.modules.slice().sort((a, b) => a.position - b.position);
    const capsOf = (s, mid) => s.modules.find((m) => m.id === mid).chapters.slice().sort((a, b) => a.position - b.position);
    const rawRows = async (cid) => ds.query(
      `select 'm' as k, id, null::uuid as module_id, position from public.course_modules where course_id = $1
       union all select 'c', id, module_id, position from public.course_chapters where course_id = $1 order by 1, 3, 4`, [cid]);

    // Curso de trabajo: 3 módulos × 3 capítulos.
    const cid = await newCourse('R16 editor');
    const M = [];
    for (let i = 0; i < 3; i++) {
      const res = await S.createModule(cid, OWNER, { title: `Módulo ${i + 1}`, expectedCounter: await counter(cid) });
      for (let j = 0; j < 2; j++) await S.createChapter(cid, res.module.id, OWNER, { title: `Cap ${i + 1}.${j + 2}`, expectedCounter: await counter(cid) });
      M.push(res.module.id);
    }

    await check('reorderModules: una sentencia (4 idas y vueltas: BEGIN, lock, UPDATE+counter, COMMIT), posiciones 0..N-1 en el orden pedido, counter +1', async () => {
      const c0 = await counter(cid);
      const order = [M[2], M[0], M[1]];
      const { out, rts } = await measure(() => S.reorderModules(cid, OWNER, { order, expectedCounter: c0 }));
      eq(rts, 4, 'idas y vueltas');
      eq(out.structureVersionCounter, c0 + 1, 'counter');
      const s = await S.getStructure(cid, OWNER);
      eq(sortedMods(s).map((m) => [m.id, m.position]), order.map((id, i) => [id, i]), 'GET');
      eq(s.structureVersionCounter, c0 + 1, 'counter persistido');
    });

    await check('reorderModules: la respuesta trae lo que usa el editor (counter + {id, position} de cada módulo + liveMatchesCurrentBlueprint) y coincide con el GET', async () => {
      const c0 = await counter(cid);
      const order = [M[0], M[1], M[2]];
      const out = await S.reorderModules(cid, OWNER, { order, expectedCounter: c0 });
      eq(Object.keys(out).sort(), ['liveMatchesCurrentBlueprint', 'modules', 'structureVersionCounter'], 'campos');
      eq(typeof out.structureVersionCounter, 'number', 'counter numérico');
      eq(out.liveMatchesCurrentBlueprint, false, 'sin Blueprint → false (igual que el GET)');
      const s = await S.getStructure(cid, OWNER);
      eq(out.modules, sortedMods(s).map((m) => ({ id: m.id, position: m.position })), 'filas = GET');
      eq(out.liveMatchesCurrentBlueprint, s.liveMatchesCurrentBlueprint, 'liveMatches = GET');
    });

    await check('reorderModules 409: counter viejo → ConflictException {message, currentCounter}, sin escribir nada (ni posiciones ni counter)', async () => {
      const c0 = await counter(cid);
      const before = await rawRows(cid);
      const err = await rejectsWith(S.reorderModules(cid, OWNER, { order: [M[1], M[2], M[0]], expectedCounter: c0 - 1 }), 409, /expectedCounter desactualizado/, '409');
      eq(err.getResponse(), { message: 'expectedCounter desactualizado', currentCounter: c0 }, 'cuerpo del 409 (byte a byte el de antes)');
      eq(await rawRows(cid), before, 'sin cambios');
      eq(await counter(cid), c0, 'counter intacto');
    });

    await check('reorderModules 400: set distinto (falta, sobra, duplicado, id ajeno, mayúsculas) → el mismo 400 de antes y sin escribir', async () => {
      const c0 = await counter(cid);
      const before = await rawRows(cid);
      const other = await newCourse('ajeno');
      const om = (await S.createModule(other, OWNER, { title: 'X', expectedCounter: 0 })).module.id;
      for (const order of [[M[0], M[1]], [M[0], M[1], M[2], om], [M[0], M[0], M[1]], [M[0], M[1], om], [M[0].toUpperCase(), M[1], M[2]]]) {
        await rejectsWith(S.reorderModules(cid, OWNER, { order, expectedCounter: c0 }), 400, /no coincide exactamente con los módulos existentes del curso/, JSON.stringify(order));
      }
      eq(await rawRows(cid), before, 'sin cambios');
      eq(await counter(cid), c0, 'counter intacto');
    });

    await check('reorderModules: dos requests concurrentes con el mismo counter → exactamente uno gana y el otro recibe 409', async () => {
      const c0 = await counter(cid);
      const res = await Promise.allSettled([
        S.reorderModules(cid, OWNER, { order: [M[1], M[0], M[2]], expectedCounter: c0 }),
        S.reorderModules(cid, OWNER, { order: [M[2], M[1], M[0]], expectedCounter: c0 }),
      ]);
      const ok = res.filter((x) => x.status === 'fulfilled');
      const ko = res.filter((x) => x.status === 'rejected');
      eq([ok.length, ko.length], [1, 1], 'uno y uno');
      eq(ko[0].reason.getStatus(), 409, '409');
      eq(await counter(cid), c0 + 1, 'un solo +1');
      const s = await S.getStructure(cid, OWNER);
      eq(sortedMods(s).map((m) => m.position), [0, 1, 2], 'posiciones contiguas');
      await S.reorderModules(cid, OWNER, { order: [M[0], M[1], M[2]], expectedCounter: c0 + 1 });
    });

    await check('reorderChapters: una sentencia (4 idas y vueltas), orden pedido, counter +1; la respuesta trae {id, moduleId, position} = GET', async () => {
      const c0 = await counter(cid);
      const caps = capsOf(await S.getStructure(cid, OWNER), M[1]).map((c) => c.id);
      const order = [caps[2], caps[0], caps[1]];
      const { out, rts } = await measure(() => S.reorderChapters(cid, M[1], OWNER, { order, expectedCounter: c0 }));
      eq(rts, 4, 'idas y vueltas');
      eq(out.structureVersionCounter, c0 + 1, 'counter');
      eq(Object.keys(out).sort(), ['chapters', 'liveMatchesCurrentBlueprint', 'structureVersionCounter'], 'campos');
      const s = await S.getStructure(cid, OWNER);
      eq(capsOf(s, M[1]).map((c) => c.id), order, 'GET');
      eq(out.chapters, capsOf(s, M[1]).map((c) => ({ id: c.id, moduleId: M[1], position: c.position })), 'filas = GET');
    });

    await check('reorderChapters: 404 módulo inexistente (antes que el 400 del set), 400 set distinto, 409 counter viejo — sin escribir', async () => {
      const c0 = await counter(cid);
      const before = await rawRows(cid);
      const caps = capsOf(await S.getStructure(cid, OWNER), M[1]).map((c) => c.id);
      await rejectsWith(S.reorderChapters(cid, '00000000-0000-4000-8000-000000000000', OWNER, { order: caps, expectedCounter: c0 }), 404, /Module .* not found in course/, '404');
      await rejectsWith(S.reorderChapters(cid, M[1], OWNER, { order: caps.slice(0, 2), expectedCounter: c0 }), 400, /no coincide exactamente con los capítulos existentes del módulo/, 'falta uno');
      const capsM0 = capsOf(await S.getStructure(cid, OWNER), M[0]).map((c) => c.id);
      await rejectsWith(S.reorderChapters(cid, M[1], OWNER, { order: [caps[0], caps[1], capsM0[0]], expectedCounter: c0 }), 400, /no coincide exactamente/, 'capítulo de otro módulo');
      const e = await rejectsWith(S.reorderChapters(cid, M[1], OWNER, { order: caps, expectedCounter: c0 + 7 }), 409, /expectedCounter desactualizado/, '409');
      eq(e.getResponse().currentCounter, c0, 'currentCounter');
      eq(await rawRows(cid), before, 'sin cambios');
      eq(await counter(cid), c0, 'counter intacto');
    });

    await check('moveChapter: una sentencia (4 idas y vueltas) y el MISMO resultado que el algoritmo anterior para cada posición destino (0, medio, final, > T)', async () => {
      for (const [targetPosition, pick] of [[0, 0], [1, 1], [3, 2], [99, 0], [2, 2]]) {
        const s0 = await S.getStructure(cid, OWNER);
        const src = capsOf(s0, M[0]).map((c) => c.id);
        const tgt = capsOf(s0, M[2]).map((c) => c.id);
        if (src.length <= 1) throw new Error('fixture: origen sin capítulos suficientes');
        const chapterId = src[pick % src.length];
        const ref = referenceMove(src, tgt, chapterId, targetPosition);
        const c0 = s0.structureVersionCounter;
        const { out, rts } = await measure(() => S.moveChapter(cid, M[0], chapterId, OWNER, { targetModuleId: M[2], targetPosition, expectedCounter: c0 }));
        eq(rts, 4, `idas y vueltas (targetPosition=${targetPosition})`);
        eq(out.structureVersionCounter, c0 + 1, 'counter');
        const s1 = await S.getStructure(cid, OWNER);
        eq(capsOf(s1, M[0]).map((c) => [c.id, c.position]), ref.src.map((id, i) => [id, i]), `origen (targetPosition=${targetPosition})`);
        eq(capsOf(s1, M[2]).map((c) => [c.id, c.position]), ref.tgt.map((id, i) => [id, i]), `destino (targetPosition=${targetPosition})`);
        const expectRows = [M[0], M[2]].sort().flatMap((mid) => capsOf(s1, mid).map((c) => ({ id: c.id, moduleId: mid, position: c.position })));
        eq(out.chapters, expectRows, 'filas cambiadas = GET de los dos módulos');
        eq(out.liveMatchesCurrentBlueprint, false, 'liveMatches');
        // devolverlo para que el origen no se vacíe
        await S.moveChapter(cid, M[2], chapterId, OWNER, { targetModuleId: M[0], targetPosition: 0, expectedCounter: c0 + 1 });
      }
    });

    await check('moveChapter: mismos rechazos y precedencia (404 capítulo no está en el origen, 400 destino ajeno, 400 mismo módulo, 400 último capítulo, 409) sin escribir', async () => {
      const c0 = await counter(cid);
      const before = await rawRows(cid);
      const s = await S.getStructure(cid, OWNER);
      const srcCap = capsOf(s, M[0])[0].id;
      const other = await newCourse('ajeno 2');
      const om = (await S.createModule(other, OWNER, { title: 'X', expectedCounter: 0 })).module.id;
      await rejectsWith(S.moveChapter(cid, M[1], srcCap, OWNER, { targetModuleId: M[2], targetPosition: 0, expectedCounter: c0 }), 404, /Chapter .* not found in module/, 'no está en el origen');
      await rejectsWith(S.moveChapter(cid, M[0], srcCap, OWNER, { targetModuleId: om, targetPosition: 0, expectedCounter: c0 }), 400, /módulo destino no existe o no pertenece/, 'destino ajeno');
      await rejectsWith(S.moveChapter(cid, M[0], srcCap, OWNER, { targetModuleId: M[0], targetPosition: 0, expectedCounter: c0 }), 400, /destino es igual al origen/, 'mismo módulo');
      // precedencia: capítulo inexistente + mismo módulo → 404 (como antes)
      await rejectsWith(S.moveChapter(cid, M[0], '00000000-0000-4000-8000-000000000000', OWNER, { targetModuleId: M[0], targetPosition: 0, expectedCounter: c0 }), 404, /not found in module/, '404 antes que mismo módulo');
      const e = await rejectsWith(S.moveChapter(cid, M[0], srcCap, OWNER, { targetModuleId: M[2], targetPosition: 0, expectedCounter: c0 - 1 }), 409, /expectedCounter desactualizado/, '409');
      eq(e.getResponse(), { message: 'expectedCounter desactualizado', currentCounter: c0 }, 'cuerpo 409');
      eq(await rawRows(cid), before, 'sin cambios');
      eq(await counter(cid), c0, 'counter intacto');
      // último capítulo del origen
      const solo = (await S.createModule(cid, OWNER, { title: 'Solo', expectedCounter: c0 })).module;
      await rejectsWith(S.moveChapter(cid, solo.id, solo.chapters[0].id, OWNER, { targetModuleId: M[2], targetPosition: 0, expectedCounter: c0 + 1 }), 400, /último capítulo del módulo origen/, 'último');
      eq(await counter(cid), c0 + 1, 'solo el alta');
      await S.deleteModule(cid, solo.id, OWNER, c0 + 1);
    });

    await check('delete módulo / capítulo: 4 idas y vueltas, counter +1, respuesta con el id borrado; 400 último, 404 inexistente, 409 — sin escribir', async () => {
      const c0 = await counter(cid);
      const extra = (await S.createModule(cid, OWNER, { title: 'Para borrar', expectedCounter: c0 })).module;
      const cap2 = (await S.createChapter(cid, extra.id, OWNER, { title: 'Otro', expectedCounter: c0 + 1 })).chapter;
      let c = c0 + 2;
      const before = await rawRows(cid);
      await rejectsWith(S.deleteChapter(cid, extra.id, cap2.id, OWNER, c - 1), 409, /expectedCounter desactualizado/, '409 capítulo');
      await rejectsWith(S.deleteModule(cid, extra.id, OWNER, c + 3), 409, /expectedCounter desactualizado/, '409 módulo');
      await rejectsWith(S.deleteChapter(cid, extra.id, '00000000-0000-4000-8000-000000000000', OWNER, c), 404, /not found in module/, '404 capítulo');
      await rejectsWith(S.deleteModule(cid, '00000000-0000-4000-8000-000000000000', OWNER, c), 404, /not found in course/, '404 módulo');
      eq(await rawRows(cid), before, 'sin cambios');
      eq(await counter(cid), c, 'counter intacto');
      const dc = await measure(() => S.deleteChapter(cid, extra.id, cap2.id, OWNER, c));
      eq(dc.rts, 4, 'idas y vueltas (capítulo)');
      eq(dc.out, { structureVersionCounter: c + 1, deletedChapterId: cap2.id, moduleId: extra.id, liveMatchesCurrentBlueprint: false }, 'respuesta capítulo');
      c++;
      await rejectsWith(S.deleteChapter(cid, extra.id, extra.chapters[0].id, OWNER, c), 400, /último capítulo del módulo/, 'último capítulo');
      const dm = await measure(() => S.deleteModule(cid, extra.id, OWNER, c));
      eq(dm.rts, 4, 'idas y vueltas (módulo)');
      eq(dm.out, { structureVersionCounter: c + 1, deletedModuleId: extra.id, liveMatchesCurrentBlueprint: false }, 'respuesta módulo');
      const s = await S.getStructure(cid, OWNER);
      assert(!s.modules.some((m) => m.id === extra.id), 'módulo borrado');
      eq((await ds.query(`select count(*)::int n from public.course_chapters where module_id = $1`, [extra.id]))[0].n, 0, 'capítulos en cascada');
      const solo = await newCourse('uno solo');
      const sm = (await S.createModule(solo, OWNER, { title: 'Único', expectedCounter: 0 })).module;
      await rejectsWith(S.deleteModule(solo, sm.id, OWNER, 1), 400, /último módulo del curso/, 'último módulo');
    });

    await check('con Blueprint vigente: +1 ida y vuelta (lectura en la misma transacción) y liveMatchesCurrentBlueprint = lo que diría el GET (false al cambiar, true al volver)', async () => {
      const c0 = await counter(cid);
      await blueprints.lock(cid, OWNER, c0);
      const s0 = await S.getStructure(cid, OWNER);
      eq(s0.liveMatchesCurrentBlueprint, true, 'recién confirmado');
      const orig = sortedMods(s0).map((m) => m.id);
      const moved = [orig[1], orig[0], ...orig.slice(2)];
      const a = await measure(() => S.reorderModules(cid, OWNER, { order: moved, expectedCounter: s0.structureVersionCounter }));
      eq(a.rts, 5, 'idas y vueltas con Blueprint');
      eq(a.out.liveMatchesCurrentBlueprint, false, 'cambió');
      eq((await S.getStructure(cid, OWNER)).liveMatchesCurrentBlueprint, false, 'GET coincide');
      const b = await S.reorderModules(cid, OWNER, { order: orig, expectedCounter: a.out.structureVersionCounter });
      eq(b.liveMatchesCurrentBlueprint, true, 'volvió a la versión confirmada');
      eq((await S.getStructure(cid, OWNER)).liveMatchesCurrentBlueprint, true, 'GET coincide');
      const caps = capsOf(await S.getStructure(cid, OWNER), orig[0]).map((x) => x.id);
      const mv = await S.moveChapter(cid, orig[0], caps[0], OWNER, { targetModuleId: orig[1], targetPosition: 0, expectedCounter: b.structureVersionCounter });
      eq(mv.liveMatchesCurrentBlueprint, false, 'move');
      const back = await S.moveChapter(cid, orig[1], caps[0], OWNER, { targetModuleId: orig[0], targetPosition: 0, expectedCounter: mv.structureVersionCounter });
      eq(back.liveMatchesCurrentBlueprint, true, 'move de vuelta');
    });

    await check('posiciones siempre contiguas y únicas tras todas las operaciones (los unique deferred se verifican al COMMIT)', async () => {
      const s = await S.getStructure(cid, OWNER);
      eq(sortedMods(s).map((m) => m.position), s.modules.map((_, i) => i), 'módulos');
      for (const m of s.modules) {
        const ps = capsOf(s, m.id).map((c) => c.position);
        eq(ps, ps.map((_, i) => i), `capítulos de ${m.title}`);
      }
    });

    await check('edición de campos / altas / toggles de curso: counter plegado en la mutación (update 4, create 4, settings 4 idas y vueltas) y la misma respuesta', async () => {
      let c = await counter(cid);
      const s = await S.getStructure(cid, OWNER);
      const m0 = sortedMods(s)[0];
      const ch0 = capsOf(s, m0.id)[0];
      const um = await measure(() => S.updateModule(cid, m0.id, OWNER, { title: 'Módulo renombrado', expectedCounter: c }));
      eq(um.out, { structureVersionCounter: c + 1, title: 'Módulo renombrado', titleNormalized: false }, 'updateModule');
      eq(um.rts, 4, 'updateModule idas y vueltas');
      c++;
      const uc = await measure(() => S.updateChapter(cid, m0.id, ch0.id, OWNER, { objective: 'Obj', videoEnabled: true, expectedCounter: c }));
      eq(uc.out, { structureVersionCounter: c + 1 }, 'updateChapter');
      eq(uc.rts, 4, 'updateChapter idas y vueltas');
      c++;
      // LOOP 8.3 (gate L83B): fijar el video también va en el MISMO UPDATE del contador.
      const up = await measure(() => S.updateChapter(cid, m0.id, ch0.id, OWNER, { videoEnabled: false, pinVideo: true, expectedCounter: c }));
      eq([up.out, up.rts], [{ structureVersionCounter: c + 1, videoPinned: true }, 4], 'updateChapter fijando el video');
      eq((await ds.query(`select metadata -> 'designPins' -> $2::text p from public.courses where id = $1`, [cid, ch0.id]))[0].p, { video: false }, 'valor fijado guardado');
      c++;
      const un = await measure(() => S.updateChapter(cid, m0.id, ch0.id, OWNER, { videoEnabled: true, expectedCounter: c }));
      eq([un.rts, (await ds.query(`select metadata -> 'designPins' -> $2::text -> 'video' p from public.courses where id = $1`, [cid, ch0.id]))[0].p], [4, null], 'sin fijar: libera el valor fijado (4 idas y vueltas)');
      c++;
      const e0 = await measure(() => S.updateChapter(cid, m0.id, ch0.id, OWNER, { expectedCounter: c }));
      eq(e0.out, { structureVersionCounter: c + 1 }, 'updateChapter sin campos: igual sube el counter (como antes)');
      c++;
      const cc = await measure(() => S.createChapter(cid, m0.id, OWNER, { title: 'Cap nuevo', expectedCounter: c }));
      eq(cc.rts, 4, 'createChapter idas y vueltas');
      eq(Object.keys(cc.out.chapter), ['id', 'position', 'title', 'objective', 'description', 'videoEnabled', 'activityEnabled'], 'forma del capítulo');
      eq([cc.out.structureVersionCounter, cc.out.chapter.position, cc.out.chapter.videoEnabled, cc.out.chapter.activityEnabled, cc.out.titleNormalized], [c + 1, capsOf(s, m0.id).length, false, true, false], 'createChapter');
      c++;
      const cm = await measure(() => S.createModule(cid, OWNER, { title: 'Mod nuevo', expectedCounter: c }));
      eq(cm.rts, 4, 'createModule idas y vueltas');
      eq(Object.keys(cm.out.module), ['id', 'position', 'title', 'objective', 'description', 'examEnabled', 'chapters'], 'forma del módulo');
      eq(Object.keys(cm.out.module.chapters[0]), ['id', 'position', 'title', 'objective', 'description', 'videoEnabled', 'activityEnabled'], 'forma del capítulo default');
      eq([cm.out.structureVersionCounter, cm.out.module.position, cm.out.module.examEnabled, cm.out.module.chapters[0].title, cm.out.module.chapters[0].position], [c + 1, s.modules.length, true, 'Nuevo capítulo', 0], 'createModule');
      c++;
      const st = await measure(() => S.updateSettings(cid, OWNER, { finalExam: false, activityEngine: 'scorm', expectedCounter: c }));
      eq(st.out, { structureVersionCounter: c + 1, finalExam: false, activityEngine: 'scorm' }, 'updateSettings');
      eq(st.rts, 4, 'updateSettings idas y vueltas');
      c++;
      eq(await counter(cid), c, 'counter final');
      const g = await S.getStructure(cid, OWNER);
      eq([g.finalExam, g.activityEngine], [false, 'scorm'], 'toggles persistidos');
    });

    await check('edición de campos: 404 / 400 / 409 con la misma precedencia de antes y sin escribir', async () => {
      const c = await counter(cid);
      const before = await rawRows(cid);
      const s = await S.getStructure(cid, OWNER);
      const m0 = sortedMods(s)[0];
      const ch0 = capsOf(s, m0.id)[0];
      const noCut = 'lista sin corte natural de recolección clasificación empaque transporte y almacenamiento de frutas y hortalizas frescas';
      const ghost = '00000000-0000-4000-8000-000000000000';
      await rejectsWith(S.updateModule(cid, ghost, OWNER, { title: noCut, expectedCounter: c }), 404, /Module .* not found/, 'updateModule: 404 antes que el título inválido');
      await rejectsWith(S.updateModule(cid, m0.id, OWNER, { title: noCut, expectedCounter: c }), 400, /MODULE_TITLE_TOO_LONG/, 'updateModule 400');
      await rejectsWith(S.updateChapter(cid, m0.id, ghost, OWNER, { title: noCut, expectedCounter: c }), 404, /Chapter .* not found/, 'updateChapter: 404 antes que el título inválido');
      await rejectsWith(S.updateChapter(cid, ghost, ch0.id, OWNER, { objective: 'x', expectedCounter: c }), 404, /Chapter .* not found/, 'updateChapter: módulo equivocado');
      // Revisión final Fase 1 (M1): encender el video lleva la guarda «práctica» en el UPDATE; un capítulo o módulo
      // inexistente sigue siendo 404 (nunca 400 PRACTICE_CHAPTER_VIDEO).
      await rejectsWith(S.updateChapter(cid, m0.id, ghost, OWNER, { videoEnabled: true, expectedCounter: c }), 404, /Chapter .* not found/, 'updateChapter video: capítulo inexistente');
      await rejectsWith(S.updateChapter(cid, ghost, ch0.id, OWNER, { videoEnabled: true, expectedCounter: c }), 404, /Chapter .* not found/, 'updateChapter video: módulo equivocado');
      await rejectsWith(S.updateChapter(cid, m0.id, ch0.id, OWNER, { title: noCut, expectedCounter: c }), 400, /CHAPTER_TITLE_TOO_LONG/, 'updateChapter 400');
      await rejectsWith(S.createChapter(cid, ghost, OWNER, { title: noCut, expectedCounter: c }), 404, /Module .* not found/, 'createChapter: 404 antes que el título inválido');
      await rejectsWith(S.createChapter(cid, m0.id, OWNER, { title: noCut, expectedCounter: c }), 400, /CHAPTER_TITLE_TOO_LONG/, 'createChapter 400');
      await rejectsWith(S.createModule(cid, OWNER, { title: noCut, expectedCounter: c }), 400, /MODULE_TITLE_TOO_LONG/, 'createModule 400');
      await rejectsWith(S.updateModule(cid, m0.id, OWNER, { title: 'x', expectedCounter: c - 1 }), 409, /expectedCounter desactualizado/, 'updateModule 409');
      await rejectsWith(S.createChapter(cid, ghost, OWNER, { title: 'x', expectedCounter: c - 1 }), 409, /expectedCounter desactualizado/, '409 antes que 404');
      await rejectsWith(S.updateSettings(cid, OWNER, { finalExam: true, expectedCounter: c - 1 }), 409, /expectedCounter desactualizado/, 'updateSettings 409');
      eq(await rawRows(cid), before, 'sin cambios');
      eq(await counter(cid), c, 'counter intacto');
    });

    await check('edición de título largo: separa título + descripción conservando la descripción existente (lee la fila solo en ese caso)', async () => {
      let c = await counter(cid);
      const s = await S.getStructure(cid, OWNER);
      const m0 = sortedMods(s)[0];
      const ch0 = capsOf(s, m0.id)[0];
      await S.updateChapter(cid, m0.id, ch0.id, OWNER, { description: 'Ya había', expectedCounter: c++ });
      const long = 'Almacenamiento y conservación de productos agrícolas Principios y técnicas de almacenamiento, condiciones de temperatura, humedad, ventilación e higiene';
      const r = await measure(() => S.updateChapter(cid, m0.id, ch0.id, OWNER, { title: long, expectedCounter: c }));
      eq(r.out.title, 'Almacenamiento y conservación de productos agrícolas', 'título');
      eq(r.out.description, 'Ya había Principios y técnicas de almacenamiento, condiciones de temperatura, humedad, ventilación e higiene', 'descripción = existente + resto');
      eq(r.rts, 5, 'idas y vueltas (con lectura de la descripción existente)');
      const g = capsOf(await S.getStructure(cid, OWNER), m0.id)[0];
      eq([g.title, g.description], [r.out.title, r.out.description], 'persistido');
    });

    await check('coherencia en vivo (liveSnapshot): UNA consulta y el mismo snapshot que las 4 consultas de antes; 404 dueño ajeno, 400 legacy', async () => {
      const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
      const [course] = await ds.query(`select id, title from public.courses where id = $1`, [cid]);
      const mods = await ds.query(`select id, position, title, objective, exam_enabled from public.course_modules where course_id = $1`, [cid]);
      const chs = await ds.query(`select id, module_id, position, title, objective, video_enabled from public.course_chapters where course_id = $1`, [cid]);
      const expected = snap.buildBlueprintSnapshot({ id: course.id, title: course.title }, mods, chs);
      let n = 0;
      const origQuery = ds.query.bind(ds);
      ds.query = (...a) => { n++; return origQuery(...a); };
      let got;
      try { got = await blueprints.liveSnapshot(cid, OWNER); } finally { ds.query = origQuery; }
      eq(n, 1, 'consultas');
      eq(snap.snapshotSha256(got), snap.snapshotSha256(expected), 'sha del snapshot');
      eq(got, expected, 'snapshot');
      await rejectsWith(blueprints.liveSnapshot(cid, '99999999-2222-4333-8444-555555555555'), 404, /not found/, 'dueño ajeno');
      const legacy = (await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, 'L', 'legacy') returning id`, [OWNER]))[0].id;
      await rejectsWith(blueprints.liveSnapshot(legacy, OWNER), 400, /solo admite cursos "dynamic"/, 'legacy');
    });
  } finally {
    if (ds && ds.isInitialized) await ds.destroy().catch(() => {});
    for (const [k, envk] of [['flag', 'DYNAMIC_COURSE_STRUCTURE'], ['allow', 'DYNAMIC_V2_ALLOWED_OWNERS'], ['rules', 'DYNAMIC_MANIFEST_RULES_VERSION'], ['unowned', 'ALLOW_UNOWNED_COURSES']]) {
      if (saved[k] === undefined) delete process.env[envk]; else process.env[envk] = saved[k];
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('PG16 descartable destruido');
  }
}

(async () => {
  try {
    await main();
  } catch (err) {
    failures++;
    console.error(`❌ setup falló: ${err && err.stack ? err.stack : err}`);
  }
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures > 0 ? 1 : 0);
})();
