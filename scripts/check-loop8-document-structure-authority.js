#!/usr/bin/env node
/* eslint-disable */
// LOOP 8.0 · El microcurrículo manda sobre la estructura del curso (hallazgo O1 de la auditoría LOOP 8).
// Contra el código COMPILADO en dist/ ("npm run build" antes). USD 0: sin red, sin proveedores.
//
// Parte pura:
//   DA1 autoridad: esqueleto / estructura de Cursia intacta → reemplazo sin preguntar; editada o confirmada → confirmación
//   DA2 origen: parseo estricto, avance tras «Aplicar diseño» solo si nadie la tocó
// Parte DB (Postgres 16 local y desechable; se salta SOLO con --pure-only, y lo dice):
//   DA3 sin contexto / versión del contexto vieja / contador viejo → error claro, nada cambia
//   DA4 O1: la IA armó la estructura (con más módulos que el documento) → guardar el microcurrículo y usar su estructura
//       la reemplaza COMPLETA (sobrantes borrados), con descripciones y vínculos; origen = academic_context
//   DA5 el origen de la IA solo se registra con el contador vigente (409 si no) y no cambia la estructura
//   DA6 cambios del docente: 409 STRUCTURE_REPLACE_NEEDS_CONFIRMATION sin tocar nada; con confirmReplace, se reemplaza
//   DA7 versión confirmada (Blueprint): pide confirmación; con ella se reemplaza y el Blueprint queda intacto (ya no coincide)
//   DA8 «Aplicar diseño» de Cursia sobre la estructura del documento la mantiene «de Cursia»; editada, no
//   DA9 una versión NUEVA del contexto reemplaza la estructura del documento anterior sin preguntar (nadie la tocó)
//   DA10 cursos legacy: la API los rechaza; el GET de un curso sin origen informa «sin origen» (compatibilidad)
//   DA11 (review L80 I2) un contexto nuevo que quita un resultado poda vínculos SIN volver «editada» la estructura
//   DA12 (review L80 M2) con una generación en curso → 409 ACTIVE_RUN, nada cambia
//   (review L80 I3) el reemplazo reconcilia por posición: ids conservados (DA4, DA7, DA9)
//
// Uso: node scripts/check-loop8-document-structure-authority.js [--pure-only] [path/to/dist]
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
    console.error(`❌ No se pudo cargar ${abs} (¿corriste "npm run build"?): ${err.message}`);
    process.exit(1);
  }
}

const SA = loadDist('modules/course-structure/structure-authority.js');
const A = loadDist('modules/academic-context/index.js');
const F = require('./lib/academic-fixtures.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
async function rejectsRe(p, re, m, status) {
  try { await p; } catch (err) {
    const body = err && err.getResponse ? err.getResponse() : null;
    const text = [err && err.message, body && (typeof body === 'string' ? body : body.message || body.code)].filter(Boolean).join(' | ');
    assert(re.test(text), `${m}: error inesperado «${text}»`);
    if (status) eq(err.getStatus ? err.getStatus() : null, status, `${m}: status`);
    return;
  }
  throw new Error(`${m}: no falló`);
}

(async () => {
  console.log('Parte pura');
  const origin = (source, counter, contextVersion) => ({ source, counter, contextVersion: contextVersion ?? null, at: 't' });
  await check('DA1 autoridad: quién puede reemplazar sin preguntar', () => {
    const r = (o, counter, pristine, bp) => SA.structureAuthority(o, counter, pristine, bp).replaceReasons;
    eq(r(null, 3, true, false), [], 'esqueleto vacío');
    eq(r(origin('ai_proposal', 9), 9, false, false), [], 'IA intacta');
    eq(r(origin('academic_context', 9, 1), 9, false, false), [], 'documento intacto');
    eq(r(origin('ai_proposal', 9), 10, false, false), ['user_edits'], 'IA editada');
    eq(r(null, 4, false, false), ['user_edits'], 'sin origen y no vacía (curso anterior o armado a mano)');
    eq(r(origin('ai_proposal', 9), 9, false, true), ['confirmed_blueprint'], 'IA intacta pero confirmada');
    eq(r(null, 4, false, true), ['user_edits', 'confirmed_blueprint'], 'editada y confirmada');
    const a = SA.structureAuthority(origin('academic_context', 5, 2), 5, false, false);
    eq([a.source, a.contextVersion, a.originCounter, a.untouched, a.pristine], ['academic_context', 2, 5, true, false], 'forma');
    const sk = (t, ct, extra) => [{ title: t, objective: null, description: null, chapters: [{ title: ct, objective: null, description: null, ...(extra || {}) }] }];
    eq([SA.isPristineSkeleton(sk('Módulo 1', 'Nuevo capítulo')), SA.isPristineSkeleton(sk('Nuevo módulo', 'Nuevo capítulo')),
      SA.isPristineSkeleton(sk('Costos', 'Nuevo capítulo')), SA.isPristineSkeleton(sk('Módulo 1', 'Nuevo capítulo', { objective: 'x' })),
      SA.isPristineSkeleton([]), SA.isPristineSkeleton([...sk('Módulo 1', 'Nuevo capítulo'), ...sk('Módulo 1', 'Nuevo capítulo')])],
    [true, true, false, false, false, false], 'esqueleto');
  });
  await check('DA2 origen: parseo estricto y avance tras el diseño de Cursia', () => {
    eq(SA.parseStructureOrigin({ source: 'ai_proposal', counter: 3, at: 'x' }), { source: 'ai_proposal', counter: 3, contextVersion: null, at: 'x' }, 'válido');
    for (const bad of [null, [], 'x', { source: 'docente', counter: 1 }, { source: 'ai_proposal', counter: -1 }, { source: 'ai_proposal', counter: 1.5 }, { source: 'ai_proposal' }]) {
      eq(SA.parseStructureOrigin(bad), null, `inválido ${JSON.stringify(bad)}`);
    }
    eq(SA.originAfterCursiaDesign(origin('academic_context', 7, 1), 7, 8), origin('academic_context', 8, 1), 'intacta → avanza');
    eq(SA.originAfterCursiaDesign(origin('academic_context', 6, 1), 7, 8), null, 'editada → no avanza');
    eq(SA.originAfterCursiaDesign(null, 7, 8), null, 'sin origen');
  });

  if (PURE_ONLY) {
    console.log('\n⚠️  --pure-only: se SALTÓ la parte DB (no cuenta como probada).');
  } else {
    await dbChecks();
  }
  console.log(`\n${passed} OK, ${failed} fallidas`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

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
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
function cleanEnv() { return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' }; }

async function dbChecks() {
  console.log('\nParte DB');
  require('reflect-metadata');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { NotFoundException, Logger } = require('@nestjs/common');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { CourseProfilesService } = loadDist('modules/course-profiles/course-profiles.service.js');
  const { PedagogyService } = loadDist('modules/pedagogy/pedagogy.service.js');
  const { CourseModule } = loadDist('modules/course-structure/entities/course-module.entity.js');
  const { CourseChapter } = loadDist('modules/course-structure/entities/course-chapter.entity.js');
  const { CourseStructureService } = loadDist('modules/course-structure/course-structure.service.js');
  Logger.overrideLogger(false);

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-loop8-pg16-'));
  const DB = 'loop8db';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = { flag: process.env.DYNAMIC_COURSE_STRUCTURE, allow: process.env.DYNAMIC_V2_ALLOWED_OWNERS, rules: process.env.DYNAMIC_MANIFEST_RULES_VERSION, atr: process.env.DYNAMIC_ACTIVITY_TYPE_RULES, unowned: process.env.ALLOW_UNOWNED_COURSES };
  let started = false;
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`  Postgres ${pgBin} en 127.0.0.1:${port}`);
    const withClient = async (db, fn) => {
      const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db });
      await c.connect();
      try { return await fn(c); } finally { await c.end(); }
    };
    await withClient('postgres', (c) => c.query(`create database ${DB}`));
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql',
        'supabase-migration-v21-blueprint-profiles.sql', 'supabase-migration-pedagogy-profiles.sql', 'supabase-migration-practice-chapters.sql',
        'supabase-migration-application-activities.sql', 'supabase-migration-academic-context.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });

    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_ACTIVITY_TYPE_RULES = '2';
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [CourseModule, CourseChapter], synchronize: false });
    await ds.initialize();
    const coursesStub = {
      async findOne(id, ownerId) {
        const [row] = await ds.query(`select id, title, structure_version, structure_version_counter from public.courses where id = $1 and owner_id = $2`, [id, ownerId]);
        if (!row) throw new NotFoundException(`Course #${id} not found`);
        return { id: row.id, title: row.title, structureVersion: row.structure_version, structureVersionCounter: row.structure_version_counter };
      },
    };
    const profiles = new CourseProfilesService(ds, coursesStub);
    const blueprints = new CourseBlueprintsService(ds);
    const pedagogy = new PedagogyService(ds, coursesStub);
    const svc = new CourseStructureService(ds.getRepository(CourseModule), ds.getRepository(CourseChapter), coursesStub, ds, blueprints);

    const OWNER = '11111111-2222-4333-8444-555555555555';
    const ctx = (await A.extractAcademicContext([{ name: 'microcurriculo-costos.docx', data: await F.fixture('consistent', 'docx') }])).context;
    const proposal = A.proposeStructureFromContext(ctx);
    assert(proposal.available && proposal.counts.modules >= 2, 'el microcurrículo de prueba propone estructura');

    const newCourse = async (title) => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, $2, 'dynamic', false, 'h5p') returning id`, [OWNER, title]);
      const cid = c.id;
      // Esqueleto R8: el editor crea «Módulo 1» (el backend agrega «Nuevo capítulo»).
      await svc.createModule(cid, OWNER, { title: 'Módulo 1', expectedCounter: 0 });
      return cid;
    };
    const counter = async (cid) => (await ds.query(`select structure_version_counter c from public.courses where id = $1`, [cid]))[0].c;
    const get = (cid) => svc.getStructure(cid, OWNER);
    const shape = (st) => st.modules.map((m) => m.chapters.length);
    // La propuesta de la IA tal como la aplica el editor (48): actualiza el esqueleto y crea el resto, uno por uno.
    const aiApply = async (cid, nModules) => {
      let st = await get(cid);
      for (let mi = 0; mi < nModules; mi++) {
        let mod = st.modules[mi];
        if (!mod) mod = (await svc.createModule(cid, OWNER, { title: `IA módulo ${mi + 1}`, objective: 'Objetivo propuesto por la IA para este módulo', expectedCounter: await counter(cid) })).module;
        else await svc.updateModule(cid, mod.id, OWNER, { title: `IA módulo ${mi + 1}`, objective: 'Objetivo propuesto por la IA para este módulo', expectedCounter: await counter(cid) });
        await svc.updateChapter(cid, mod.id, mod.chapters[0].id, OWNER, { title: `IA capítulo ${mi + 1}.1`, objective: 'Objetivo de la IA', expectedCounter: await counter(cid) });
        await svc.createChapter(cid, mod.id, OWNER, { title: `IA capítulo ${mi + 1}.2`, objective: 'Objetivo de la IA', videoEnabled: true, expectedCounter: await counter(cid) });
        st = await get(cid);
      }
      return svc.recordStructureOrigin(cid, OWNER, { source: 'ai_proposal', expectedCounter: await counter(cid) });
    };
    const saveContext = (cid, data) => profiles.append(cid, OWNER, 'academic', data || ctx);
    const expectProposal = (st, m) => {
      eq(shape(st), proposal.modules.map((x) => x.chapters.length), `${m}: forma del documento`);
      eq(st.modules.map((x) => x.title), proposal.modules.map((x) => x.title), `${m}: títulos de los módulos`);
      eq(st.modules.flatMap((x) => x.chapters.map((c) => c.outcomeIds || [])), proposal.modules.flatMap((x) => x.chapters.map((c) => c.outcomeIds)), `${m}: vínculos a resultados`);
      eq(st.modules.flatMap((x) => x.chapters.map((c) => c.description)), proposal.modules.flatMap((x) => x.chapters.map((c) => c.description)), `${m}: descripciones`);
      assert(!st.modules.some((x) => /^IA /.test(x.title) || x.chapters.some((c) => /^IA /.test(c.title))), `${m}: no queda nada de la estructura anterior`);
    };

    await check('DA3 sin contexto / contexto viejo / contador viejo → error claro y nada cambia', async () => {
      const cid = await newCourse('Sin contexto');
      const c0 = await counter(cid);
      const st = await get(cid);
      eq([st.structureAuthority.source, st.structureAuthority.pristine, st.structureAuthority.replaceReasons], [null, true, []], 'esqueleto: sin origen, vacío');
      await rejectsRe(svc.applyAcademicStructure(cid, OWNER, { expectedCounter: c0, contextVersion: 1 }), /NO_ACADEMIC_CONTEXT/, 'sin contexto', 400);
      await saveContext(cid);
      await rejectsRe(svc.applyAcademicStructure(cid, OWNER, { expectedCounter: c0, contextVersion: 2 }), /CONTEXT_CHANGED/, 'versión vieja', 409);
      await rejectsRe(svc.applyAcademicStructure(cid, OWNER, { expectedCounter: c0 - 1, contextVersion: 1 }), /expectedCounter/, 'contador viejo', 409);
      eq([await counter(cid), shape(await get(cid))], [c0, [1]], 'nada cambió');
    });

    let o1Course = null;
    await check('DA4 O1: la IA armó 6 módulos → el microcurrículo la reemplaza completa, sin preguntar, con vínculos', async () => {
      const cid = o1Course = await newCourse('Contabilidad de Costos');
      await aiApply(cid, 6);
      let st = await get(cid);
      eq(shape(st), [2, 2, 2, 2, 2, 2], 'estructura de la IA');
      eq([st.structureAuthority.source, st.structureAuthority.untouched, st.structureAuthority.replaceReasons], ['ai_proposal', true, []], 'IA intacta');
      await saveContext(cid);
      const before = await counter(cid);
      const aiIds = st.modules.map((m) => m.id);
      const res = await svc.applyAcademicStructure(cid, OWNER, { expectedCounter: before, contextVersion: 1 });
      eq([res.structureVersionCounter, res.replaced.previous, res.replaced.confirmed], [before + 1, { modules: 6, chapters: 12 }, false], 'un solo contador, sin confirmación');
      st = await get(cid);
      expectProposal(st, 'reemplazo');
      eq(st.modules.flatMap((m) => m.chapters.map((c) => c.objective)).every((o) => o === null), true, 'objetivo del capítulo no inventado');
      const [row] = await ds.query(`select final_exam_enabled f, metadata -> 'structureOrigin' o from public.courses where id = $1`, [cid]);
      eq([row.f, row.o.source, row.o.counter, row.o.contextVersion], [true, 'academic_context', before + 1, 1], 'examen final del documento + origen');
      eq([st.structureAuthority.source, st.structureAuthority.untouched, st.structureAuthority.replaceReasons], ['academic_context', true, []], 'GET informa el documento');
      const leftovers = (await ds.query(`select count(*)::int n from public.course_chapters where course_id = $1`, [cid]))[0].n;
      eq(leftovers, proposal.counts.chapters, 'sin capítulos huérfanos');
      eq(st.modules.map((m) => m.id), aiIds.slice(0, proposal.counts.modules), 'reconciliación por posición: los módulos que siguen conservan su id; el sobrante se borró');
    });

    await check('DA5 origen de la IA: solo con el contador vigente y sin tocar la estructura', async () => {
      const cid = await newCourse('Origen');
      const c0 = await counter(cid);
      await rejectsRe(svc.recordStructureOrigin(cid, OWNER, { source: 'ai_proposal', expectedCounter: c0 + 3 }), /expectedCounter/, 'contador viejo', 409);
      eq((await get(cid)).structureAuthority.source, null, 'sin origen');
      const r = await svc.recordStructureOrigin(cid, OWNER, { source: 'ai_proposal', expectedCounter: c0 });
      eq([r.structureVersionCounter, await counter(cid), r.structureOrigin.source, r.structureOrigin.counter], [c0, c0, 'ai_proposal', c0], 'no cambia el contador');
    });

    await check('DA6 cambios del docente: 409 sin tocar nada; con confirmReplace se reemplaza', async () => {
      const cid = o1Course;
      let st = await get(cid);
      const m0 = st.modules[0];
      await svc.updateChapter(cid, m0.id, m0.chapters[0].id, OWNER, { title: 'Título escrito por el docente', expectedCounter: await counter(cid) });
      st = await get(cid);
      eq([st.structureAuthority.untouched, st.structureAuthority.replaceReasons], [false, ['user_edits']], 'editada');
      const c1 = await counter(cid);
      await rejectsRe(svc.applyAcademicStructure(cid, OWNER, { expectedCounter: c1, contextVersion: 1 }), /STRUCTURE_REPLACE_NEEDS_CONFIRMATION/, 'pide confirmación', 409);
      st = await get(cid);
      eq([await counter(cid), st.modules[0].chapters[0].title], [c1, 'Título escrito por el docente'], 'nada cambió');
      const res = await svc.applyAcademicStructure(cid, OWNER, { expectedCounter: c1, contextVersion: 1, confirmReplace: true });
      eq(res.replaced.confirmed, true, 'reemplazo confirmado');
      expectProposal(await get(cid), 'confirmado');
    });

    await check('DA7 versión confirmada: pide confirmación; con ella se reemplaza y el Blueprint queda intacto', async () => {
      const cid = o1Course;
      const lock = await blueprints.lock(cid, OWNER, await counter(cid));
      let st = await get(cid);
      eq([st.liveMatchesCurrentBlueprint, st.structureAuthority.replaceReasons], [true, ['confirmed_blueprint']], 'confirmada e intacta');
      await rejectsRe(svc.applyAcademicStructure(cid, OWNER, { expectedCounter: await counter(cid), contextVersion: 1 }), /STRUCTURE_REPLACE_NEEDS_CONFIRMATION/, 'pide confirmación', 409);
      const ids = st.modules.flatMap((m) => [m.id, ...m.chapters.map((c) => c.id)]);
      const res = await svc.applyAcademicStructure(cid, OWNER, { expectedCounter: await counter(cid), contextVersion: 1, confirmReplace: true });
      eq(res.hadBlueprint, true, 'informa el Blueprint');
      st = await get(cid);
      assert(typeof lock.blueprint.blueprintNumber === 'number' && st.currentBlueprint, 'hay Blueprint');
      eq([st.currentBlueprint.number, st.currentBlueprint.sha256], [lock.blueprint.blueprintNumber, lock.blueprint.sha256], 'Blueprint intacto');
      eq(st.modules.flatMap((m) => [m.id, ...m.chapters.map((c) => c.id)]), ids, 'el mismo documento conserva TODOS los ids (lo generado se puede reutilizar)');
      eq(st.liveMatchesCurrentBlueprint, true, 'mismo documento → la estructura sigue coincidiendo con la versión confirmada');
      expectProposal(st, 'tras Blueprint');
    });

    await check('DA8 «Aplicar diseño» de Cursia mantiene la estructura «de Cursia»; tras una edición, no', async () => {
      const cid = await newCourse('Con diseño');
      await saveContext(cid);
      await svc.applyAcademicStructure(cid, OWNER, { expectedCounter: await counter(cid), contextVersion: 1 });
      const design = A.suggestProfileFromContext(ctx, null).profile;
      await profiles.append(cid, OWNER, 'pedagogy', { ...design, primaryApproach: 'competencias', targetHours: 64, designPreferences: { emphasis: 'application', applicationActivities: 'auto' } });
      const dr = await pedagogy.dryRunCourse(cid, OWNER, {});
      assert(dr.distribution && dr.distribution.status !== 'minimum_exceeds_target', 'hay diseño que aplicar');
      const c0 = await counter(cid);
      const applied = await svc.applyDistribution(cid, OWNER, { expectedCounter: c0, proposalSha256: dr.distribution.proposalSha256 });
      assert(applied.addedChapters + applied.applicationActivities > 0, 'el diseño cambió la estructura');
      let st = await get(cid);
      eq([st.structureAuthority.source, st.structureAuthority.untouched, st.structureAuthority.originCounter], ['academic_context', true, c0 + 1], 'sigue siendo de Cursia');
      // Un contexto nuevo reemplaza la estructura (nadie la tocó) y avisa que el diseño de horas se perdió (review L80 M3).
      const ctx2 = JSON.parse(JSON.stringify(ctx));
      ctx2.units = ctx2.units.slice(0, 3);
      await saveContext(cid, ctx2);
      const rep2 = await svc.applyAcademicStructure(cid, OWNER, { expectedCounter: await counter(cid), contextVersion: 2 });
      eq([rep2.replaced.confirmed, rep2.previousHadDesign], [false, true], 'sin confirmación; avisa que había diseño de horas');
      st = await get(cid);
      eq(st.modules.flatMap((m) => m.chapters).filter((c) => c.kind === 'practice' || typeof c.applicationMinutes === 'number').length, 0, 'práctica y Actividades de Aplicación del diseño anterior quitadas');
      // Editada por el docente: un diseño de Cursia encima NO la vuelve «de Cursia».
      await svc.updateModule(cid, st.modules[0].id, OWNER, { title: 'Mi módulo', expectedCounter: await counter(cid) });
      await profiles.append(cid, OWNER, 'pedagogy', { ...design, primaryApproach: 'competencias', targetHours: 96, designPreferences: { emphasis: 'application', applicationActivities: 'auto' } });
      const dr2 = await pedagogy.dryRunCourse(cid, OWNER, {});
      assert(dr2.distribution && dr2.distribution.status !== 'minimum_exceeds_target', 'hay diseño para la estructura editada');
      const ap2 = await svc.applyDistribution(cid, OWNER, { expectedCounter: await counter(cid), proposalSha256: dr2.distribution.proposalSha256 });
      assert(ap2.addedChapters + ap2.applicationActivities > 0, 'el diseño sí cambió la estructura editada');
      st = await get(cid);
      eq([st.structureAuthority.untouched, st.structureAuthority.replaceReasons], [false, ['user_edits']], 'editada sigue editada');
    });

    await check('DA9 una versión nueva del contexto reemplaza la estructura del documento anterior sin preguntar', async () => {
      const cid = await newCourse('Contexto v2');
      await saveContext(cid);
      await svc.applyAcademicStructure(cid, OWNER, { expectedCounter: await counter(cid), contextVersion: 1 });
      const ctx2 = JSON.parse(JSON.stringify(ctx));
      ctx2.units = ctx2.units.slice(0, 2);
      const p2 = A.proposeStructureFromContext(ctx2);
      const ids1 = (await get(cid)).modules.map((m) => m.id);
      const v2 = await saveContext(cid, ctx2);
      eq(v2.profile.version, 2, 'versión 2');
      const res = await svc.applyAcademicStructure(cid, OWNER, { expectedCounter: await counter(cid), contextVersion: 2 });
      eq([res.replaced.confirmed, shape(await get(cid))], [false, p2.modules.map((m) => m.chapters.length)], 'sin confirmación, forma nueva');
      eq((await get(cid)).structureAuthority.contextVersion, 2, 'origen con la versión 2');
      eq((await get(cid)).modules.map((m) => m.id), ids1.slice(0, p2.counts.modules), 'módulos que siguen: mismo id; sobrantes borrados');
    });

    await check('DA11 un contexto nuevo con un resultado menos poda vínculos y la estructura del documento sigue «de Cursia»', async () => {
      const cid = await newCourse('Poda');
      await saveContext(cid);
      await svc.applyAcademicStructure(cid, OWNER, { expectedCounter: await counter(cid), contextVersion: 1 });
      const last = ctx.outcomes[ctx.outcomes.length - 1].id;
      const linked = (await get(cid)).modules.flatMap((m) => m.chapters).filter((c) => (c.outcomeIds || []).includes(last)).length;
      assert(linked > 0, `hay capítulos vinculados a ${last}`);
      const ctx3 = JSON.parse(JSON.stringify(ctx, (k, v) => (Array.isArray(v) ? v.filter((x) => x !== last) : v)));
      ctx3.outcomes = ctx3.outcomes.filter((o) => o.id !== last);
      const saved3 = await saveContext(cid, ctx3);
      assert((saved3.prunedOutcomeLinks || []).length > 0, 'podó vínculos');
      const a = (await get(cid)).structureAuthority;
      eq([a.source, a.untouched, a.replaceReasons], ['academic_context', true, []], 'la poda no cuenta como edición del docente');
      const res = await svc.applyAcademicStructure(cid, OWNER, { expectedCounter: await counter(cid), contextVersion: 2 });
      eq(res.replaced.confirmed, false, 'la versión nueva se usa sin preguntar');
    });

    await check('DA13 (review L80 R2-I1) documento → diseño de horas → Blueprint → mismo documento: TODOS sus capítulos conservan el id', async () => {
      const cid = await newCourse('Diseño y reemplazo');
      await saveContext(cid);
      await svc.applyAcademicStructure(cid, OWNER, { expectedCounter: await counter(cid), contextVersion: 1 });
      const docIds = new Map((await get(cid)).modules.flatMap((m) => m.chapters.map((c) => [`${m.position}|${c.title}`, c.id])));
      const design = A.suggestProfileFromContext(ctx, null).profile;
      await profiles.append(cid, OWNER, 'pedagogy', { ...design, primaryApproach: 'competencias', targetHours: 96, designPreferences: { emphasis: 'application', applicationActivities: 'auto' } });
      const dr = await pedagogy.dryRunCourse(cid, OWNER, {});
      const ap = await svc.applyDistribution(cid, OWNER, { expectedCounter: await counter(cid), proposalSha256: dr.distribution.proposalSha256 });
      let st = await get(cid);
      const practice = st.modules.flatMap((m) => m.chapters).filter((c) => c.kind === 'practice').length;
      assert(ap.addedChapters > 0 && practice > 0, 'el diseño intercaló capítulos de práctica');
      await blueprints.lock(cid, OWNER, await counter(cid));
      await svc.applyAcademicStructure(cid, OWNER, { expectedCounter: await counter(cid), contextVersion: 1, confirmReplace: true });
      st = await get(cid);
      const after = st.modules.flatMap((m) => m.chapters.map((c) => [`${m.position}|${c.title}`, c.id]));
      eq(after.length, docIds.size, 'solo los capítulos del documento');
      eq(after.filter(([k, id]) => docIds.get(k) === id).length, docIds.size, 'cada capítulo del documento conserva su id');
      eq(st.modules.flatMap((m) => m.chapters).filter((c) => c.kind === 'practice' || typeof c.applicationMinutes === 'number').length, 0, 'práctica y actividades del diseño, fuera');
    });

    await check('DA12 con una generación en curso → 409 ACTIVE_RUN y nada cambia', async () => {
      const cid = await newCourse('Run activo');
      await saveContext(cid);
      await svc.applyAcademicStructure(cid, OWNER, { expectedCounter: await counter(cid), contextVersion: 1 });
      await blueprints.lock(cid, OWNER, await counter(cid));
      // Base desechable sin la migración de la generación dinámica: se admite el execution_mode del run de prueba.
      await ds.query(`alter table public.production_jobs drop constraint if exists production_jobs_execution_mode_check`);
      const [job] = await ds.query(`insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status) values ($1, $2, 'dynamic_generation', 'running', 'running') returning id`, [OWNER, cid]);
      const c0 = await counter(cid);
      await rejectsRe(svc.applyAcademicStructure(cid, OWNER, { expectedCounter: c0, contextVersion: 1, confirmReplace: true }), /ACTIVE_RUN/, 'run en curso', 409);
      eq(await counter(cid), c0, 'nada cambió');
      await ds.query(`update public.production_jobs set worker_status = 'completed', status = 'completed' where id = $1`, [job.id]);
      const ok = await svc.applyAcademicStructure(cid, OWNER, { expectedCounter: c0, contextVersion: 1, confirmReplace: true });
      eq(ok.replaced.confirmed, true, 'terminado el run, se puede');
    });

    await check('DA10 compatibilidad: legacy rechazado; curso dinámico sin origen = «sin origen»', async () => {
      const [legacy] = await ds.query(`insert into public.courses (owner_id, title) values ($1, 'Curso legacy') returning id`, [OWNER]);
      await rejectsRe(svc.applyAcademicStructure(legacy.id, OWNER, { expectedCounter: 0, contextVersion: 1 }), /solo admite cursos "dynamic"/, 'legacy', 400);
      await rejectsRe(svc.recordStructureOrigin(legacy.id, OWNER, { source: 'ai_proposal', expectedCounter: 0 }), /solo admite cursos "dynamic"/, 'legacy', 400);
      const cid = await newCourse('Anterior a LOOP 8');
      const m = (await get(cid)).modules[0];
      await svc.updateModule(cid, m.id, OWNER, { title: 'Módulo armado a mano', expectedCounter: await counter(cid) });
      const a = (await get(cid)).structureAuthority;
      eq([a.source, a.originCounter, a.untouched, a.pristine, a.replaceReasons], [null, null, false, false, ['user_edits']], 'sin origen: nunca se pisa sin confirmar');
      await rejectsRe(svc.applyAcademicStructure(cid, '99999999-8888-4777-8666-555555555555', { expectedCounter: await counter(cid), contextVersion: 1 }), /not found/, 'otro dueño', 404);
    });
  } finally {
    if (ds) await ds.destroy().catch(() => {});
    for (const [k, v] of [['DYNAMIC_COURSE_STRUCTURE', saved.flag], ['DYNAMIC_V2_ALLOWED_OWNERS', saved.allow], ['DYNAMIC_MANIFEST_RULES_VERSION', saved.rules], ['DYNAMIC_ACTIVITY_TYPE_RULES', saved.atr], ['ALLOW_UNOWNED_COURSES', saved.unowned]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
