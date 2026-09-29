#!/usr/bin/env node
/* eslint-disable */
// Cursia V2.1 — Chapter/Module Title Normalization.
//
// Parte pura (siempre; CI con --pure-only):
//   - normalizeStructureTitle: título ≤ 80 separado de su descripción, sin
//     truncar ni «…», sin perder texto; nombres propios no cortan antes de
//     tiempo; sin corte natural → null (CHAPTER_TITLE_TOO_LONG);
//   - snapshot v2 y huellas de invalidación: SIN descripción son byte a byte
//     los de antes (Blueprints/runs existentes no cambian); CON descripción la
//     clave va detrás de objective y cambia la huella del capítulo.
// Parte DB (default; PG16 desechable, puerto libre ≠ 5570):
//   - migración (mismo archivo R3) agrega description a módulos/capítulos, 2×;
//   - API: título largo → se separa (≤ 80 + descripción), sin corte → 400
//     CHAPTER_TITLE_TOO_LONG / MODULE_TITLE_TOO_LONG, GET devuelve description;
//   - lock del Blueprint rechaza títulos > 80 (nunca congela uno inválido) y
//     congela la descripción;
//   - curso EXISTENTE con títulos largos: plan (dry) + apply → títulos ≤ 80,
//     descripción con el resto, contador +1, idempotente, sin pisar ediciones.
//
// Usage: node scripts/check-v21-structure-titles.js [--pure-only] [path/to/dist]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
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
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`);
}
async function rejectsRe(p, re, m, status) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert(err, `${m}: no lanzó`);
  const text = err.message + ' ' + JSON.stringify(err.getResponse ? err.getResponse() : '');
  assert(re.test(text), `${m}: mensaje inesperado "${text.slice(0, 300)}"`);
  if (status !== undefined) assert(err.getStatus && err.getStatus() === status, `${m}: status ${err.getStatus && err.getStatus()} (esperado ${status})`);
  return err;
}

const T = loadDist('modules/course-structure/structure-titles.js');
const snap = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const FP = loadDist('modules/invalidation/fingerprints.js');

const LONG_240 =
  'Almacenamiento y conservación de productos agrícolas Principios y técnicas de almacenamiento, condiciones de temperatura, ' +
  'humedad, ventilación e higiene, control de inventarios, manejo de plagas y prevención de pérdidas';
const REST_240 = 'Principios y técnicas de almacenamiento, condiciones de temperatura, humedad, ventilación e higiene, control de inventarios, manejo de plagas y prevención de pérdidas';

async function pureChecks() {
  await check('normalizador: título de 240 caracteres (nombre + descripción pegados) → título ≤ 80 sin «…» y la descripción conserva TODO el resto', () => {
    assert(LONG_240.length >= 200, `fixture ${LONG_240.length}`);
    const r = T.normalizeChapterTitle(LONG_240);
    assert(r, 'separable');
    eq(r.title, 'Almacenamiento y conservación de productos agrícolas', 'título');
    assert(r.title.length <= T.STRUCTURE_TITLE_MAX && !/…|\.\.\.$/.test(r.title), 'sin truncado');
    eq(r.description, REST_240, 'descripción = resto completo');
    eq(`${r.title} ${r.description}`, LONG_240, 'no se pierde texto');
    eq(r.changed, true, 'changed');
  });

  await check('normalizador: separadores explícitos (salto de línea, «:», « — »), nombres propios no cortan antes de tiempo, ≤ 80 intacto', () => {
    eq(T.normalizeStructureTitle('Gestión poscosecha de productos agrícolas\nProcesos de recolección, clasificación, empaque, embalaje y transporte bajo normas técnicas colombianas'),
      { title: 'Gestión poscosecha de productos agrícolas', description: 'Procesos de recolección, clasificación, empaque, embalaje y transporte bajo normas técnicas colombianas', changed: true }, 'salto de línea');
    const colon = T.normalizeStructureTitle('Gestión poscosecha: procesos de recolección, clasificación, empaque, transporte y almacenamiento de frutas y hortalizas frescas');
    eq([colon.title, colon.description.slice(0, 24)], ['Gestión poscosecha', 'Procesos de recolección,'], 'dos puntos (descripción capitalizada)');
    const dash = T.normalizeStructureTitle('Seguridad eléctrica en baja tensión — riesgos, protecciones, puesta a tierra, bloqueo y etiquetado, primeros auxilios');
    eq(dash.title, 'Seguridad eléctrica en baja tensión', 'guion largo');
    const pn = T.normalizeStructureTitle('Uso de Excel Avanzado para Análisis Financiero en Pymes de Colombia Tablas dinámicas, macros, escenarios y tableros para decisiones');
    eq(pn.title, 'Uso de Excel Avanzado para Análisis Financiero en Pymes de Colombia', 'nombres propios dentro del título');
    eq(T.normalizeStructureTitle('  Título   breve  '), { title: 'Título breve', description: null, changed: true }, 'corto: solo espacios');
    eq(T.normalizeStructureTitle('Título breve'), { title: 'Título breve', description: null, changed: false }, 'sin cambios');
  });

  await check('normalizador: sin corte natural (lista en minúsculas) → null → CHAPTER_TITLE_TOO_LONG; nunca inventa ni trunca', () => {
    eq(T.normalizeStructureTitle('gestión de procesos de recolección clasificación empaque transporte y almacenamiento de frutas y hortalizas frescas en cadenas cortas'), null, 'null');
    eq([T.CHAPTER_TITLE_TOO_LONG, T.MODULE_TITLE_TOO_LONG, T.STRUCTURE_TITLE_MAX], ['CHAPTER_TITLE_TOO_LONG', 'MODULE_TITLE_TOO_LONG', 80], 'códigos');
    eq(T.normalizeStructureTitle(T.normalizeStructureTitle(LONG_240).title).changed, false, 'idempotente');
  });

  await check('normalizador (review I1): prefijos estructurales, abreviaturas, números y palabras funcionales NUNCA producen un título malo (error claro en su lugar)', () => {
    eq(T.normalizeStructureTitle('Capítulo 3: Gestión de inventarios. Control de existencias, rotación FIFO, pérdidas y registro de movimientos en bodegas rurales'),
      { title: 'Gestión de inventarios', description: 'Control de existencias, rotación FIFO, pérdidas y registro de movimientos en bodegas rurales', changed: true }, 'prefijo "Capítulo 3:" quitado');
    const mod = T.normalizeStructureTitle('Módulo 1: Introducción a la gestión logística y comercialización de productos agrícolas en mercados locales');
    assert(mod === null || !/^M[oó]dulo 1$/.test(mod.title), `nunca "Módulo 1": ${JSON.stringify(mod)}`);
    for (const bad of [
      'Uso del EPP p. ej. guantes, gafas y botas en tareas de poscosecha y almacenamiento de productos perecederos en bodegas',
      'Liderazgo según el Sr. Pérez y la escuela humanista aplicada a equipos de trabajo rurales con enfoque participativo',
      'Excel 2019 - 2021 para contadores públicos que llevan la contabilidad de pymes agrícolas y cooperativas del sector',
    ]) {
      const r = T.normalizeStructureTitle(bad);
      assert(r === null || (!/(\bp|Sr|2019)$/.test(r.title)), `${bad.slice(0, 20)} → ${JSON.stringify(r && r.title)}`);
    }
    // Re-review m1: "Tema civil: …" no es un prefijo estructural (romano solo en mayúsculas).
    const civ = T.normalizeStructureTitle('Tema civil: responsabilidad extracontractual, daños y perjuicios en contratos agrarios y de arrendamiento rural');
    eq(civ && civ.title, 'Tema civil', 'no se come "Tema civil"');
    eq(T.normalizeStructureTitle('Unidad IV: Marketing digital para emprendedores. Redes sociales, comercio electrónico y posicionamiento de marca para productores rurales').title,
      'Marketing digital para emprendedores', 'romano en mayúsculas sí es prefijo');
    const fw = T.normalizeStructureTitle('Seguridad industrial Normas de Colombia y buenas prácticas de manufactura en plantas de beneficio y centros de acopio');
    eq(fw.title, 'Seguridad industrial', 'nunca termina en "de"');
    const allTitles = [LONG_240, 'Capítulo 3: Gestión de inventarios. Control de existencias', 'Seguridad industrial Normas de Colombia y más cosas para que supere el máximo de ochenta caracteres del título'];
    for (const t of allTitles) { const r = T.normalizeStructureTitle(t); if (r) assert(!/\s(de|del|la|y|en|para|con)$/i.test(r.title), r.title); }
  });

  await check('normalizador (review I2): nunca trunca — la descripción separada conserva todo el resto aunque sea larga; "p. ej." no se capitaliza', () => {
    const rest = 'Principios ' + 'y técnicas de almacenamiento '.repeat(40);
    const r = T.normalizeStructureTitle('Almacenamiento y conservación de productos agrícolas ' + rest);
    eq(r.description, rest.trim(), 'resto completo (> 1000)');
    eq(T.mergeDescription('x'.repeat(1500), 'y'.repeat(1500)).length, 3001, 'merge sin truncar (el caller decide)');
    eq(T.STRUCTURE_DESCRIPTION_MAX, 2000, 'máximo');
  });

  await check('mergeDescription: la existente se conserva y la separada se agrega (sin duplicar); vacías → null', () => {
    eq(T.mergeDescription(null, 'Resto'), 'Resto', 'solo separada');
    eq(T.mergeDescription('  Ya había  ', null), 'Ya había', 'solo existente');
    eq(T.mergeDescription('Ya había', 'Resto'), 'Ya había Resto', 'ambas');
    eq(T.mergeDescription('Ya había Resto', 'Resto'), 'Ya había Resto', 'sin duplicar');
    eq(T.mergeDescription('', ''), null, 'vacías');
  });

  const course = { id: 7, title: 'Curso', finalExam: true, activityEngine: 'h5p' };
  const mods = (d) => [{ id: 'm1', position: 0, title: 'Módulo', objective: null, exam_enabled: true, ...(d !== undefined ? { description: d } : {}) }];
  const chs = (d) => [{ id: 'c1', module_id: 'm1', position: 0, title: 'Capítulo', objective: 'Obj', video_enabled: true, activity_enabled: true, ...(d !== undefined ? { description: d } : {}) }];
  await check('snapshot v2: sin descripción (ausente / null / vacía) es byte a byte el de antes → Blueprints existentes conservan su sha', () => {
    const base = snap.canonicalJsonV2(snap.buildBlueprintSnapshotV2(course, mods(), chs()));
    assert(!base.includes('description'), 'sin clave description');
    for (const d of [null, '', '   ']) eq(snap.canonicalJsonV2(snap.buildBlueprintSnapshotV2(course, mods(d), chs(d))), base, `description=${JSON.stringify(d)}`);
    const stored = JSON.parse(base);
    eq(snap.snapshotSha256V2(snap.recanonicalizeBlueprintSnapshotV2(stored)), snap.snapshotSha256V2(snap.buildBlueprintSnapshotV2(course, mods(), chs())), 'recanonicalize igual');
  });
  await check('snapshot v2: con descripción la clave va detrás de objective (módulo y capítulo) y sobrevive a recanonicalize', () => {
    const s = snap.buildBlueprintSnapshotV2(course, mods('Detalle del módulo'), chs('Detalle del capítulo'));
    eq(Object.keys(s.modules[0]), ['id', 'position', 'title', 'objective', 'description', 'examEnabled', 'chapters'], 'orden módulo');
    eq(Object.keys(s.modules[0].chapters[0]), ['id', 'position', 'title', 'objective', 'description', 'videoEnabled', 'activityEnabled'], 'orden capítulo');
    const re = snap.recanonicalizeBlueprintSnapshotV2(JSON.parse(JSON.stringify(s)));
    eq(snap.canonicalJsonV2(re), snap.canonicalJsonV2(s), 'recanonicalize conserva la descripción');
  });
  await check('huellas de invalidación: sin descripción idénticas a antes; con descripción cambia la huella propia del capítulo (regenera lo que depende de él)', () => {
    const fpOf = (d) => FP.computeFingerprintsV3 ? FP.computeFingerprintsV3(snap.buildBlueprintSnapshotV2(course, mods(), chs(d)), {}) : FP.computeFingerprints(snap.buildBlueprintSnapshotV2(course, mods(), chs(d)), {});
    const a = fpOf(undefined);
    const b = fpOf(null);
    const c = fpOf('Detalle nuevo');
    eq(b.content.get('c1'), a.content.get('c1'), 'null = ausente');
    assert(c.content.get('c1').own !== a.content.get('c1').own, 'descripción cambia la huella propia');
    eq(c.content.get('c1').context, a.content.get('c1').context, 'contexto del módulo igual');
  });
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

async function dbChecks() {
  require('reflect-metadata');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { NotFoundException, Logger } = require('@nestjs/common');
  Logger.overrideLogger(false);
  const { CourseModule } = loadDist('modules/course-structure/entities/course-module.entity.js');
  const { CourseChapter } = loadDist('modules/course-structure/entities/course-chapter.entity.js');
  const { CourseStructureService } = loadDist('modules/course-structure/course-structure.service.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const M = require('./lib/structure-titles-migration');

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-v21-titles-pg16-'));
  const DB = 'titlesdb';
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
    console.log(`\nPostgres ${pgBin} en 127.0.0.1:${port} (data ${dataDir})`);
    const withClient = async (db, fn) => {
      const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db });
      await c.connect();
      try { return await fn(c); } finally { await c.end(); }
    };
    await withClient('postgres', (c) => c.query(`create database ${DB}`));
    const OWNER = '11111111-2222-4333-8444-555555555555';
    // Curso EXISTENTE con títulos largos creado ANTES de la columna description (estado de staging hoy).
    const pre = await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
      const course = (await c.query(`insert into public.courses (owner_id, title, structure_version) values ($1, 'Logística agrícola', 'dynamic') returning id`, [OWNER])).rows[0];
      const m1 = (await c.query(`insert into public.course_modules (course_id, position, title) values ($1, 0, 'Gestión logística') returning id`, [course.id])).rows[0];
      const ids = [];
      const titles = [LONG_240, 'Comercialización y distribución de productos agrícolas Canales de comercialización, análisis de costos y precios, identificación de mercados', 'lista sin corte natural de recolección clasificación empaque transporte y almacenamiento de frutas y hortalizas frescas'];
      for (let i = 0; i < titles.length; i++) {
        ids.push((await c.query(`insert into public.course_chapters (course_id, module_id, position, title, video_enabled) values ($1, $2, $3, $4, false) returning id`, [course.id, m1.id, i, titles[i]])).rows[0].id);
      }
      return { courseId: course.id, moduleId: m1.id, chapterIds: ids, titles };
    });

    await check('DB migración: el SQL R3 (mismo archivo que usan staging, E2E y harnesses) agrega description a módulos y capítulos; 2× idempotente; filas existentes NULL', async () => {
      await withClient(DB, async (c) => {
        for (let i = 0; i < 2; i++) await c.query(fs.readFileSync(path.join(REPO, 'supabase-migration-v21-blueprint-profiles.sql'), 'utf8'));
        for (const t of ['course_modules', 'course_chapters']) {
          const col = (await c.query(`select data_type, is_nullable from information_schema.columns where table_schema='public' and table_name=$1 and column_name='description'`, [t])).rows[0];
          eq(col, { data_type: 'text', is_nullable: 'YES' }, t);
        }
        eq((await c.query(`select count(*)::int n from public.course_chapters where description is not null`)).rows[0].n, 0, 'existentes NULL');
      });
      const src = fs.readFileSync(path.join(REPO, 'test/e2e-v2/setup-schema.js'), 'utf8');
      assert(src.includes("'supabase-migration-v21-blueprint-profiles.sql'"), 'E2E aplica el mismo archivo');
    });

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [CourseModule, CourseChapter], synchronize: false });
    await ds.initialize();
    const coursesStub = {
      async findOne(id, ownerId) {
        const [row] = await ds.query(`select id, title, structure_version, structure_version_counter from public.courses where id = $1 and owner_id = $2`, [id, ownerId]);
        if (!row) throw new NotFoundException(`Course #${id} not found`);
        return { id: row.id, title: row.title, structureVersion: row.structure_version, structureVersionCounter: row.structure_version_counter };
      },
    };
    const blueprints = new CourseBlueprintsService(ds);
    const structure = new CourseStructureService(ds.getRepository(CourseModule), ds.getRepository(CourseChapter), coursesStub, ds, blueprints);
    const cid = pre.courseId;
    const counter = async () => (await structure.getStructure(cid, OWNER)).structureVersionCounter;

    await check('DB lock: un Blueprint NUNCA congela títulos > 80 (curso existente sin migrar) → 400 CHAPTER_TITLE_TOO_LONG con cada capítulo', async () => {
      const err = await rejectsRe(blueprints.lock(cid, OWNER, await counter()), /CHAPTER_TITLE_TOO_LONG/, 'lock', 400);
      eq(err.getResponse().errors.length, 3, 'los 3 capítulos largos');
      assert(/el título del capítulo 1 \(«Almacenamiento/.test(err.getResponse().message), `mensaje accionable (número + título): ${err.getResponse().message.slice(0, 160)}`);
      eq((await ds.query(`select count(*)::int n from public.course_blueprints where course_id = $1`, [cid]))[0].n, 0, 'sin Blueprint');
    });

    await check('DB migración de cursos existentes: dry-run no escribe; apply separa (título ≤ 80 + descripción con el resto), sube el contador y deja sin tocar lo no separable', async () => {
      const c0 = await counter();
      const plan = await withClient(DB, (c) => M.planStructureTitleMigration(c, { distRoot, courseId: cid }));
      eq([plan.changes.length, plan.unresolved.length, plan.unresolved[0].code], [2, 1, 'CHAPTER_TITLE_TOO_LONG'], 'plan');
      eq(await counter(), c0, 'dry-run no escribe');
      const out = await withClient(DB, (c) => M.applyStructureTitleMigration(c, plan));
      eq([out.applied.length, out.skipped.length], [2, 0], 'apply');
      const s = await structure.getStructure(cid, OWNER);
      const [a, b, x] = s.modules[0].chapters;
      eq([a.title, a.description], ['Almacenamiento y conservación de productos agrícolas', REST_240], 'capítulo 1');
      eq(b.title, 'Comercialización y distribución de productos agrícolas', 'capítulo 2');
      assert(b.description.startsWith('Canales de comercialización'), 'descripción 2');
      eq(x.title, pre.titles[2], 'no separable: intacto (se corrige en el editor)');
      eq(await counter(), c0 + 1, 'contador +1 (un editor abierto recarga)');
      const again = await withClient(DB, (c) => M.planStructureTitleMigration(c, { distRoot, courseId: cid }));
      eq([again.changes.length, again.unresolved.length], [0, 1], 'idempotente');
    });

    await check('DB migración: una edición concurrente (el título cambió desde el plan) NO se pisa', async () => {
      const cid2 = (await ds.query(`insert into public.courses (owner_id, title, structure_version) values ($1, 'Curso 2', 'dynamic') returning id`, [OWNER]))[0].id;
      const m = (await ds.query(`insert into public.course_modules (course_id, position, title) values ($1, 0, 'Módulo') returning id`, [cid2]))[0].id;
      const ch = (await ds.query(`insert into public.course_chapters (course_id, module_id, position, title) values ($1, $2, 0, $3) returning id`, [cid2, m, LONG_240]))[0].id;
      const plan = await withClient(DB, (c) => M.planStructureTitleMigration(c, { distRoot, courseId: cid2 }));
      await ds.query(`update public.course_chapters set title = 'Editado por el usuario' where id = $1`, [ch]);
      const out = await withClient(DB, (c) => M.applyStructureTitleMigration(c, plan));
      eq([out.applied.length, out.skipped.length, out.skipped[0] && out.skipped[0].reason], [0, 1, 'changed_since_plan'], 'omitido');
      eq((await ds.query(`select title from public.course_chapters where id = $1`, [ch]))[0].title, 'Editado por el usuario', 'intacto');
      // Review minor: una DESCRIPCIÓN editada entre el plan y el apply tampoco se pisa.
      const ch2 = (await ds.query(`insert into public.course_chapters (course_id, module_id, position, title) values ($1, $2, 1, $3) returning id`, [cid2, m, LONG_240]))[0].id;
      const plan2 = await withClient(DB, (c) => M.planStructureTitleMigration(c, { distRoot, courseId: cid2 }));
      await ds.query(`update public.course_chapters set description = 'Escrita por el usuario' where id = $1`, [ch2]);
      const out2 = await withClient(DB, (c) => M.applyStructureTitleMigration(c, plan2));
      eq([out2.applied.length, out2.skipped.length], [0, 1], 'descripción concurrente');
      eq((await ds.query(`select title, description from public.course_chapters where id = $1`, [ch2]))[0], { title: LONG_240, description: 'Escrita por el usuario' }, 'intacto');
    });

    await check('DB API: crear/editar capítulo con título largo → se guarda título ≤ 80 + descripción (respuesta lo informa); GET devuelve description', async () => {
      const created = await structure.createChapter(cid, pre.moduleId, OWNER, { title: LONG_240, expectedCounter: await counter() });
      eq([created.chapter.title, created.chapter.description, created.titleNormalized], ['Almacenamiento y conservación de productos agrícolas', REST_240, true], 'create');
      const upd = await structure.updateChapter(cid, pre.moduleId, pre.chapterIds[2], OWNER, {
        title: 'Recolección y clasificación de frutas y hortalizas: empaque, transporte y almacenamiento en cadenas cortas de comercialización', expectedCounter: await counter(),
      });
      eq([upd.title, upd.titleNormalized], ['Recolección y clasificación de frutas y hortalizas', true], 'update separa');
      assert(/^Empaque, transporte/.test(upd.description), `descripción: ${upd.description}`);
      const s = await structure.getStructure(cid, OWNER);
      const ch3 = s.modules[0].chapters.find((c) => c.id === pre.chapterIds[2]);
      eq([ch3.title.length <= 80, !!ch3.description], [true, true], 'GET');
      const d = await structure.updateChapter(cid, pre.moduleId, pre.chapterIds[2], OWNER, { description: '  Nuevo   detalle ', expectedCounter: await counter() });
      eq(d.description, 'Nuevo detalle', 'editar solo la descripción');
      const clear = await structure.updateChapter(cid, pre.moduleId, pre.chapterIds[2], OWNER, { description: '', expectedCounter: await counter() });
      eq(clear.description, null, 'vaciar');
    });

    await check('DB API: sin corte natural → 400 CHAPTER_TITLE_TOO_LONG / MODULE_TITLE_TOO_LONG claro; no escribe ni sube el contador', async () => {
      const c0 = await counter();
      const bad = 'lista sin corte natural de recolección clasificación empaque transporte y almacenamiento de frutas y hortalizas frescas';
      const e1 = await rejectsRe(structure.updateChapter(cid, pre.moduleId, pre.chapterIds[0], OWNER, { title: bad, expectedCounter: c0 }), /CHAPTER_TITLE_TOO_LONG/, 'capítulo', 400);
      eq([e1.getResponse().code, e1.getResponse().max], ['CHAPTER_TITLE_TOO_LONG', 80], 'cuerpo');
      await rejectsRe(structure.createModule(cid, OWNER, { title: bad, expectedCounter: c0 }), /MODULE_TITLE_TOO_LONG/, 'módulo', 400);
      eq(await counter(), c0, 'sin escritura');
    });

    await check('DB lock: con títulos ≤ 80 el Blueprint congela la descripción (snapshot v2) y el sha cambia solo por ella', async () => {
      const s = await structure.getStructure(cid, OWNER);
      for (const ch of s.modules[0].chapters) {
        if (ch.title.length > 80) await structure.updateChapter(cid, pre.moduleId, ch.id, OWNER, { title: 'Capítulo corregido', expectedCounter: await counter() });
      }
      const res = await blueprints.lock(cid, OWNER, await counter());
      const [row] = await ds.query(`select snapshot_json from public.course_blueprints where id = $1`, [res.blueprint.id]);
      const snapJ = typeof row.snapshot_json === 'string' ? JSON.parse(row.snapshot_json) : row.snapshot_json;
      const ch1 = snapJ.modules[0].chapters.find((c) => c.id === pre.chapterIds[0]);
      eq([ch1.title, ch1.description], ['Almacenamiento y conservación de productos agrícolas', REST_240], 'congelado');
      assert(snapJ.modules.every((m) => m.title.length <= 80 && m.chapters.every((c) => c.title.length <= 80)), 'todos ≤ 80');
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
  await pureChecks();
  if (PURE_ONLY) {
    console.log('ℹ️  --pure-only: parte DB (PG16 desechable) NO ejecutada');
  } else {
    try {
      await dbChecks();
    } catch (err) {
      failures++;
      console.error(`❌ setup de la parte DB falló: ${err && err.stack ? err.stack : err}`);
    }
  }
  console.log(`\n${passes} ok, ${failures} fail`);
  process.exit(failures > 0 ? 1 : 0);
})();
