#!/usr/bin/env node
/* eslint-disable */
// r79.1 · Tipos de Actividad de Aplicación — servicio REAL (CourseDesignService.recommend, «Usar este diseño», lock del
// Blueprint, editor) sobre Postgres 16 desechable con la migración de staging. USD 0, sin proveedores, cursos sintéticos.
//
//   KD1 sin la migración: un diseño con tipos NO se aplica en silencio (503 schema_not_migrated_application_kind); la
//       lectura de la estructura no informa `applicationKind`; con la migración, el CHECK rechaza un tipo sin Actividad
//   KD2 «Ajustar» con tipos «automático»: la tarjeta trae los tipos por capítulo y su informe; mismas horas y capítulos que
//       sin tipos; preferencia explícita en la respuesta
//   KD3 «Usar este diseño»: guardar el perfil → recalcular sin «Ajustar» = MISMA huella → aplicar → course_chapters con
//       application_kind = tarjeta; la lectura de la estructura los informa; recalcular = «ya cumple» (misma huella)
//   KD4 lock del Blueprint: el snapshot congela applicationKind; el Manifest lo lleva en el item; su validador lo acepta
//   KD5 editor: cambiar a mano los minutos de una Actividad con tipo la vuelve la de siempre (application_kind null)
//   KD6 ajuste al presupuesto (DYNAMIC_BUDGET_FIT): con presupuesto holgado elige los tipos (calidad) y el perfil los guarda
//
// Uso: node scripts/check-r79-1-activity-kinds-db.js [path/to/dist] [--dump=<dir>]   (--dump: respuestas reales para el
//      arnés de la interfaz)
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), args.find((a) => !a.startsWith('--')) || 'dist');
const DUMP = (args.find((a) => a.startsWith('--dump=')) || '').slice(7) || null;
const loadDist = (rel) => require(path.join(distRoot, rel));
const seedJson = require('../src/modules/finops/pricing-seed.v1.json');

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
  return new Promise((resolve, reject) => { const srv = net.createServer(); srv.on('error', reject); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });
}
const cleanEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' });
const TOPICS = ['Identificación de peligros', 'Evaluación de riesgos', 'Controles de ingeniería', 'Elementos de protección'];

(async () => {
  console.log('r79.1 · Tipos de Actividad de Aplicación (servicio real, Postgres 16)');
  require('reflect-metadata');
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { NotFoundException, Logger } = require('@nestjs/common');
  const { CourseProfilesService } = loadDist('modules/course-profiles/course-profiles.service.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { PedagogyService } = loadDist('modules/pedagogy/pedagogy.service.js');
  const { CourseDesignService } = loadDist('modules/course-design/course-design.service.js');
  const { CourseModule } = loadDist('modules/course-structure/entities/course-module.entity.js');
  const { CourseChapter } = loadDist('modules/course-structure/entities/course-chapter.entity.js');
  const { CourseStructureService } = loadDist('modules/course-structure/course-structure.service.js');
  const SG = loadDist('modules/course-structure/v21-schema-guard.js');
  const MB = loadDist('modules/generation-manifests/generation-manifest-builder.js');
  const SNAP = loadDist('modules/course-blueprints/blueprint-snapshot.js');
  Logger.overrideLogger(false);

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r791-pg16-'));
  const DB = 'r791db';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const KEYS = ['DYNAMIC_COURSE_STRUCTURE', 'DYNAMIC_V2_ALLOWED_OWNERS', 'DYNAMIC_V2_GENERAL_AVAILABILITY', 'ALLOW_UNOWNED_COURSES', 'DYNAMIC_MANIFEST_RULES_VERSION', 'DYNAMIC_ACTIVITY_TYPE_RULES', 'DYNAMIC_BUDGET_FIT', 'BUDGET_FIT_MARGIN'];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  let started = false;
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', (c) => c.query(`create database ${DB}`));
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql',
        'supabase-migration-v21-blueprint-profiles.sql', 'supabase-migration-pedagogy-profiles.sql', 'supabase-migration-practice-chapters.sql',
        'supabase-migration-application-activities.sql', 'supabase-migration-guided-practice.sql', 'supabase-migration-academic-context.sql', 'supabase-migration-v21-finops.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
      for (const row of seedJson.rows) {
        await c.query(`insert into public.pricing_catalog (provider, service, product_or_model, meter, unit_size, unit_price, currency, pricing_version, effective_from, effective_to, source, source_ref, verified, created_by)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'check-r791')`,
          [row.provider, row.service, row.product_or_model, row.meter, row.unit_size, row.unit_price, row.currency, row.pricing_version, row.effective_from, row.effective_to ?? null, row.source, row.source_ref ?? null, row.verified]);
      }
    });
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    process.env.DYNAMIC_V2_GENERAL_AVAILABILITY = 'true';
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_ACTIVITY_TYPE_RULES = '2';
    delete process.env.DYNAMIC_BUDGET_FIT;
    delete process.env.BUDGET_FIT_MARGIN;
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
    const design = new CourseDesignService(ds, coursesStub, pedagogy);
    const structure = new CourseStructureService(ds.getRepository(CourseModule), ds.getRepository(CourseChapter), coursesStub, ds, blueprints);
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const counter = async (cid) => (await ds.query(`select structure_version_counter c from public.courses where id = $1`, [cid]))[0].c;
    const newCourse = async (title, hours = 50) => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, $2, 'dynamic', true, 'h5p') returning id`, [OWNER, title]);
      for (let mi = 0; mi < 4; mi++) {
        const [m] = await ds.query(`insert into public.course_modules (course_id, position, title, exam_enabled) values ($1, $2, $3, true) returning id`, [c.id, mi, TOPICS[mi]]);
        for (let j = 0; j < 2; j++) {
          await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, objective, video_enabled, activity_enabled) values ($1, $2, $3, $4, $5, true, true)`,
            [c.id, m.id, j, `${TOPICS[mi]}: tema ${j + 1}`, j === 0 ? 'Analizar riesgos y proponer controles' : 'Diseñar un plan de controles para la planta']);
        }
      }
      const base = { pedagogyProfileVersion: 1, primaryApproach: 'competencias', secondaryApproaches: [], learner: { description: 'Supervisores de planta', ageGroup: 'adults', educationLevel: 'technical', priorKnowledge: 'basic', experience: 'some' },
        learningOutcomes: { know: ['Los tipos de riesgo'], do: ['Evaluar riesgos de una tarea', 'Proponer controles'], competencies: ['Gestiona la prevención en su área'] }, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', targetHours: hours };
      await profiles.append(c.id, OWNER, 'pedagogy', base);
      return c.id;
    };
    const kindsOf = (d) => d.modules.flatMap((m) => m.chapters).filter((c) => c.applicationKind).map((c) => [c.id, c.applicationKind]);
    const dump = (name, v) => { if (!DUMP) return; fs.mkdirSync(DUMP, { recursive: true }); fs.writeFileSync(path.join(DUMP, `${name}.json`), JSON.stringify(v, null, 1)); };

    const cid = await newCourse('Curso 50 h con tipos');
    let cardAuto = null;
    await check('KD1 sin la migración: un diseño con tipos NO se aplica (503) y la lectura no informa applicationKind', async () => {
      const off = await design.recommend(cid, OWNER, {});
      cardAuto = await design.recommend(cid, OWNER, { adjust: { activityKinds: 'auto' } });
      assert(kindsOf(cardAuto.design).length > 0, 'el diseño tiene tipos');
      const v = (await profiles.getCurrent(cid, OWNER, 'pedagogy')).version;
      await profiles.append(cid, OWNER, 'pedagogy', cardAuto.profile, v);
      SG._resetApplicationKindSchemaGuardForTests();
      await rejectsRe(structure.applyDistribution(cid, OWNER, { expectedCounter: await counter(cid), proposalSha256: cardAuto.design.proposalSha256 }), /schema_not_migrated_application_kind/, 'sin migración', 503);
      const st = await structure.getStructure(cid, OWNER);
      assert(st.modules.every((m) => m.chapters.every((c) => !('applicationKind' in c))), 'sin columna, sin clave');
      void off;
    });
    await withClient(DB, async (c) => c.query(fs.readFileSync(path.join(REPO, 'supabase-migration-r79-1-application-kinds.sql'), 'utf8')));
    await withClient(DB, async (c) => c.query(fs.readFileSync(path.join(REPO, 'supabase-migration-r79-1-application-kinds.sql'), 'utf8'))); // idempotente
    await check('KD1b con la migración: el CHECK rechaza un tipo sin Actividad o desconocido', async () => {
      const [ch] = await ds.query(`select id from public.course_chapters where course_id = $1 limit 1`, [cid]);
      await rejectsRe(ds.query(`update public.course_chapters set application_kind = 'case_study', application_minutes = null where id = $1`, [ch.id]), /course_chapters_application_kind_check/, 'tipo sin minutos');
      await rejectsRe(ds.query(`update public.course_chapters set application_kind = 'taller', application_minutes = 60 where id = $1`, [ch.id]), /course_chapters_application_kind_check/, 'tipo desconocido');
    });
    await check('KD2 «Ajustar» con tipos «automático»: tipos por capítulo e informe; mismas horas y capítulos que sin tipos', async () => {
      const none = await design.recommend(cid, OWNER, { adjust: { activityKinds: 'none' } });
      const auto = await design.recommend(cid, OWNER, { adjust: { activityKinds: 'auto' } });
      eq([none.preferences.activityKinds, auto.preferences.activityKinds], ['none', 'auto'], 'preferencia en la respuesta');
      eq(kindsOf(none.design), [], 'sin tipos');
      assert(kindsOf(auto.design).length >= 2, `tipos: ${JSON.stringify(kindsOf(auto.design))}`);
      assert(auto.design.activityKinds && auto.design.activityKinds.decisions.length === kindsOf(auto.design).length, 'informe');
      eq([auto.design.estimatedHours, auto.design.counts], [none.design.estimatedHours, none.design.counts], 'mismas horas y conteos');
      assert(Number(auto.cost.expected) >= Number(none.cost.expected), 'los tipos nunca abaratan');
      dump('recommend-auto', auto);
      dump('recommend-none', none);
    });
    await check('KD3 «Usar este diseño»: misma huella al recalcular → aplicar → application_kind = tarjeta → «ya cumple»', async () => {
      const again = await design.recommend(cid, OWNER, {});
      eq([again.profileChanged, again.design.proposalSha256], [false, cardAuto.design.proposalSha256], 'punto fijo');
      SG._resetApplicationKindSchemaGuardForTests();
      const ap = await structure.applyDistribution(cid, OWNER, { expectedCounter: await counter(cid), proposalSha256: cardAuto.design.proposalSha256 });
      eq(ap.estimatedHours, cardAuto.design.estimatedHours, 'horas aplicadas');
      const rows = await ds.query(`select ch.title, ch.application_minutes, ch.application_kind, to_jsonb(ch) ->> 'chapter_kind' k from public.course_chapters ch where course_id = $1 order by title`, [cid]);
      const want = cardAuto.design.modules.flatMap((m) => m.chapters).filter((c) => c.applicationKind).map((c) => [c.title, c.applicationKind]).sort();
      eq(rows.filter((x) => x.application_kind).map((x) => [x.title, x.application_kind]).sort(), want, 'tipos en la base = tarjeta');
      const st = await structure.getStructure(cid, OWNER);
      const stKinds = st.modules.flatMap((m) => m.chapters).filter((c) => c.applicationKind).map((c) => [c.title, c.applicationKind]).sort();
      eq(stKinds, want, 'la lectura de la estructura los informa');
      const after = await design.recommend(cid, OWNER, {});
      eq([after.design.status, after.design.changes.filter((x) => /application_kind/.test(x.type)).length], ['within_tolerance', 0], 'ya cumple, sin cambios de tipo');
      eq(kindsOf(after.design).length, want.length, 'mismos tipos');
      dump('recommend-applied', after);
    });
    await check('KD4 lock del Blueprint: el snapshot congela applicationKind; el Manifest lo lleva y su validador lo acepta', async () => {
      const lk = await blueprints.lock(cid, OWNER, await counter(cid));
      const snap = lk.blueprint.snapshot;
      const chs = snap.modules.flatMap((m) => m.chapters).filter((c) => c.applicationKind);
      assert(chs.length >= 2, `snapshot con tipos: ${chs.length}`);
      const src = { courseId: cid, blueprintId: 1, blueprintNumber: lk.blueprint.blueprintNumber, blueprintSha256: SNAP.snapshotSha256V2(snap) };
      const man = MB.buildGenerationManifestV3(snap, src, { activityTypeRules: 2 });
      eq(man.items.filter((i) => i.applicationKind).length, chs.length, 'items con tipo');
      eq(MB.validateGenerationManifestV3(man, snap, src), [], 'Manifest válido');
    });
    await check('KD5 editor: cambiar a mano los minutos de una Actividad con tipo la vuelve la de siempre', async () => {
      const [row] = await ds.query(`select id, module_id, application_minutes from public.course_chapters where course_id = $1 and application_kind is not null order by title limit 1`, [cid]);
      await structure.updateChapter(cid, row.module_id, row.id, OWNER, { applicationMinutes: row.application_minutes === 60 ? 90 : 60, expectedCounter: await counter(cid) });
      const [after] = await ds.query(`select application_kind, application_minutes from public.course_chapters where id = $1`, [row.id]);
      eq(after.application_kind, null, 'sin tipo');
    });
    process.env.DYNAMIC_BUDGET_FIT = 'true';
    const cid2 = await newCourse('Curso 50 h con presupuesto');
    await check('KD6 ajuste al presupuesto: con presupuesto holgado elige los tipos (calidad) y el perfil los guarda', async () => {
      const r = await design.recommend(cid2, OWNER, { adjust: { productionBudgetUsd: 150 } });
      eq(r.budgetFit.status, 'fits', 'cabe');
      eq(r.budgetFit.chosen.preferences.activityKinds, 'auto', 'elige tipos');
      eq(r.profile.designPreferences.activityKinds, 'auto', 'el perfil los guarda');
      assert(kindsOf(r.design).length > 0, 'la tarjeta es el elegido (con tipos)');
      eq(r.design.proposalSha256, r.budgetFit.chosen.proposalSha256, 'misma huella');
      const r35 = await design.recommend(cid2, OWNER, { adjust: { productionBudgetUsd: 35 } });
      assert(['does_not_fit', 'impossible'].includes(r35.budgetFit.status), r35.budgetFit.status);
      eq(r35.budgetFit.searchSpace.activityKinds, ['none', 'auto'], 'la palanca se exploró');
      dump('recommend-budget-150', r);
      dump('recommend-budget-35', r35);
      // Bloqueada por el docente («Tipos de actividad: Solo las de siempre» en «Ajustar»): no la toca.
      const lock = await design.recommend(cid2, OWNER, { adjust: { productionBudgetUsd: 150, activityKinds: 'none' } });
      eq([lock.budgetFit.searchSpace.activityKinds, kindsOf(lock.design).length], [['none'], 0], 'bloqueada');
    });
  } finally {
    if (ds) await ds.destroy().catch(() => {});
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(`\n${passed} OK, ${failed} fallidas`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
