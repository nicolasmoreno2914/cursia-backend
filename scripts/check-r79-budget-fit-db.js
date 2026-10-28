#!/usr/bin/env node
/* eslint-disable */
// r79 · «Ajustar al presupuesto» — servicio real (CourseDesignService.recommend + «Usar este diseño» + precios de la base)
// sobre Postgres 16 desechable. USD 0, sin proveedores, cursos sintéticos.
//
//   DB1  interruptor apagado: adjust.productionBudgetUsd se IGNORA (sin claves nuevas, perfil sin presupuesto, misma huella)
//   DB2  encendido sin presupuesto: productionBudget = null, budgetFit = null, la MISMA huella que apagado
//   DB3  60 h / USD 62 (6 × 1): «Cabe»; la tarjeta ES el diseño elegido (tope de contenidos), perfil con productionBudgetUsd
//   DB4  «Usar este diseño»: guardar el perfil → recalcular sin «Ajustar» = MISMA huella → aplicar → estructura real = tarjeta
//   DB5  60 h / USD 35: «No cabe»; tarjeta = diseño de siempre; dos alternativas; mínimo explicado por factores
//   DB6  quitar el presupuesto (null): sin presupuesto ni tope; vuelve el diseño de siempre
//   DB7  precios de la base (pricing_catalog): la tarjeta lo dice; Gamma sin verificar → «estimación provisional…»; el
//        SuperAdmin guarda un precio verificado (fila nueva) → deja de ser provisional y cambia el costo de Gamma
//   DB8  presupuesto inválido (0,5 / 6000) → 400; el presupuesto nunca es el «Tope autorizado» (isAuthorizedCap false)
//
// Uso: node scripts/check-r79-budget-fit-db.js [path/to/dist]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), args.find((a) => !a.startsWith('--')) || 'dist');
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
const TOPICS = ['Peligros', 'Riesgos', 'Controles', 'Protección', 'Incidentes', 'Emergencias'];

(async () => {
  console.log('r79 · Ajustar al presupuesto (servicio real, Postgres 16)');
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
  const { FinopsBudgetService } = loadDist('modules/finops/finops-budget.service.js');
  const PC = loadDist('modules/finops/pricing-catalog-db.js');
  Logger.overrideLogger(false);

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r79-pg16-'));
  const DB = 'r79db';
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
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'check-r79')`,
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
    const finops = new FinopsBudgetService(ds, null);
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const counter = async (cid) => (await ds.query(`select structure_version_counter c from public.courses where id = $1`, [cid]))[0].c;
    const newCourse = async (title) => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, $2, 'dynamic', true, 'h5p') returning id`, [OWNER, title]);
      for (let mi = 0; mi < 6; mi++) {
        const [m] = await ds.query(`insert into public.course_modules (course_id, position, title, exam_enabled) values ($1, $2, $3, true) returning id`, [c.id, mi, TOPICS[mi]]);
        await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, objective, video_enabled, activity_enabled) values ($1, $2, 0, $3, 'Analizar riesgos y proponer controles', true, true)`, [c.id, m.id, `${TOPICS[mi]}: caso de análisis en planta`]);
      }
      const base = { pedagogyProfileVersion: 1, primaryApproach: 'competencias', secondaryApproaches: [], learner: { description: 'Supervisores de planta', ageGroup: 'adults', educationLevel: 'technical', priorKnowledge: 'basic', experience: 'some' },
        learningOutcomes: { know: ['Los tipos de riesgo'], do: ['Evaluar riesgos de una tarea', 'Proponer controles'], competencies: ['Gestiona la prevención en su área'] }, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', targetHours: 60 };
      await profiles.append(c.id, OWNER, 'pedagogy', base);
      return c.id;
    };
    const liveCounts = async (cid) => {
      const rows = await ds.query(`select to_jsonb(ch) ->> 'chapter_kind' k, video_enabled v, (to_jsonb(ch) ->> 'application_minutes')::int a from public.course_chapters ch where course_id = $1`, [cid]);
      return { chapters: rows.length, practiceChapters: rows.filter((r) => r.k === 'practice').length, videoChapters: rows.filter((r) => r.v).length, applicationActivities: rows.filter((r) => r.a).length };
    };

    const cid = await newCourse('Curso 60 h');
    let offSha;
    await check('DB1 interruptor apagado: el presupuesto se ignora (sin claves nuevas, misma huella)', async () => {
      const a = await design.recommend(cid, OWNER, {});
      const b = await design.recommend(cid, OWNER, { adjust: { productionBudgetUsd: 35 } });
      offSha = a.design.proposalSha256;
      eq([b.design.proposalSha256, 'budgetFit' in b, 'productionBudget' in b, 'productionBudgetUsd' in b.profile], [offSha, false, false, false], 'apagado = ignorado');
    });
    process.env.DYNAMIC_BUDGET_FIT = 'true';
    await check('DB2 encendido sin presupuesto: productionBudget = null, budgetFit = null, la misma huella', async () => {
      const a = await design.recommend(cid, OWNER, {});
      eq([a.design.proposalSha256, a.productionBudget, a.budgetFit, 'productionBudgetUsd' in a.profile], [offSha, null, null, false], 'sin presupuesto, todo igual');
    });
    let card62;
    await check('DB3 60 h / USD 62: «Cabe»; la tarjeta ES el diseño elegido; perfil con productionBudgetUsd y el tope', async () => {
      card62 = await design.recommend(cid, OWNER, { adjust: { productionBudgetUsd: 62 } });
      const f = card62.budgetFit;
      eq([f.status, card62.productionBudget.usd, card62.productionBudget.isAuthorizedCap, card62.profile.productionBudgetUsd], ['fits', 62, false, 62], 'cabe');
      eq(card62.design.proposalSha256, f.chosen.proposalSha256, 'la tarjeta es el elegido');
      assert(f.chosen.preferences.maxContentChaptersPerModule !== null && card62.profile.designPreferences.maxContentChaptersPerModule === f.chosen.preferences.maxContentChaptersPerModule, 'tope en el perfil');
      assert(Number(card62.cost.expected) * 1.1 <= 62 + 1e-9, `costo ${card62.cost.expected}`);
      assert(card62.design.proposalSha256 !== offSha && card62.profileChanged === true, 'diseño distinto del de siempre');
      eq(card62.cost.pricingSource, 'pricing_catalog', 'precios de la base');
    });
    await check('DB4 «Usar este diseño»: guardar → recalcular sin «Ajustar» = misma huella → aplicar → estructura real = tarjeta', async () => {
      const v = (await profiles.getCurrent(cid, OWNER, 'pedagogy')).version;
      await profiles.append(cid, OWNER, 'pedagogy', card62.profile, v);
      const again = await design.recommend(cid, OWNER, {});
      eq([again.profileChanged, again.design.proposalSha256, again.budgetFit.status], [false, card62.design.proposalSha256, 'fits'], 'punto fijo');
      const ap = await structure.applyDistribution(cid, OWNER, { expectedCounter: await counter(cid), proposalSha256: card62.design.proposalSha256 });
      eq(ap.estimatedHours, card62.design.estimatedHours, 'horas aplicadas');
      const c = card62.design.counts;
      eq(await liveCounts(cid), { chapters: c.chapters, practiceChapters: c.practiceChapters, videoChapters: c.videoChapters, applicationActivities: c.applicationActivities }, 'estructura real = tarjeta');
      const after = await design.recommend(cid, OWNER, {});
      eq(after.design.status, 'within_tolerance', 'estable después de aplicar');
    });
    const cid2 = await newCourse('Curso 60 h con USD 35');
    let off2 = null;
    await check('DB5 60 h / USD 35: «No cabe»; la tarjeta es la de siempre; dos alternativas; mínimo con factores', async () => {
      off2 = (await design.recommend(cid2, OWNER, {})).design.proposalSha256;
      const r35 = await design.recommend(cid2, OWNER, { adjust: { productionBudgetUsd: 35 } });
      const f = r35.budgetFit;
      eq([f.status, r35.design.proposalSha256 === off2], ['does_not_fit', true], 'no cabe, tarjeta de siempre');
      eq(f.alternatives.map((a) => a.kind).sort(), ['budget_for_hours', 'hours_at_budget'], 'dos alternativas');
      const m = f.minimumExplanation;
      const sum = m.factors.reduce((n, x) => n + x.usd, 0);
      assert(Math.abs(sum - m.minimumUsd) <= Math.max(1, 0.01 * m.minimumUsd), `factores ${sum} vs ${m.minimumUsd}`);
      assert(!('chosenResult' in f) && !('cheapestReachingUsd' in f), 'campos internos expuestos');
      const alt = f.alternatives.find((a) => a.kind === 'budget_for_hours');
      const r2 = await design.recommend(cid2, OWNER, { adjust: { productionBudgetUsd: alt.adjust.productionBudgetUsd } });
      eq(r2.budgetFit.status, 'fits', 'la alternativa aplicada cabe');
    });
    await check('DB6 quitar el presupuesto (null): sin presupuesto ni tope; vuelve el diseño de siempre', async () => {
      const r = await design.recommend(cid2, OWNER, { adjust: { productionBudgetUsd: null } });
      eq([r.productionBudget, r.budgetFit, 'productionBudgetUsd' in r.profile, 'maxContentChaptersPerModule' in (r.profile.designPreferences || {}), r.design.proposalSha256], [null, null, false, false, off2], 'sin presupuesto');
    });
    await check('DB7 Gamma: sin verificar → provisional; precio verificado del SuperAdmin (fila nueva) → definitivo y otro costo', async () => {
      const a = await design.recommend(cid2, OWNER, {});
      eq([a.cost.provisionalPricing.gamma, a.cost.provisionalPricing.label], [true, 'estimación provisional (precio de Gamma sin verificar)'], 'provisional');
      const before = (await finops.gammaPrice()).current;
      eq([before.provisional, before.source], [true, 'placeholder'], 'placeholder del seed');
      await rejectsRe(finops.setGammaPrice({ plan: 'P', pricePaidUsd: 0, creditsIncluded: 10, verified: true }, 'admin'), /GAMMA_PRICE_INVALID/, 'precio inválido');
      await rejectsRe(finops.setGammaPrice({ plan: 'Pro', pricePaidUsd: 20, creditsIncluded: 5000, verified: true, extra: 1 }, 'admin'), /campo no permitido/, 'campo extra');
      const n0 = Number((await ds.query(`select count(*) n from public.pricing_catalog`))[0].n);
      const set = await finops.setGammaPrice({ plan: 'Pro anual', pricePaidUsd: 20, creditsIncluded: 5000, verified: true, note: 'Factura de octubre' }, '0000-admin');
      eq([set.current.plan, set.current.creditsIncluded, set.current.unitPriceUsd, set.current.verified, set.current.provisional], ['Pro anual', 5000, '0.0040000000', true, false], 'precio verificado');
      eq(Number((await ds.query(`select count(*) n from public.pricing_catalog`))[0].n), n0 + 1, 'una fila nueva (append-only)');
      const b = await design.recommend(cid2, OWNER, {});
      eq([b.cost.provisionalPricing.gamma, b.cost.provisionalPricing.label], [false, null], 'definitivo');
      assert(Number(b.cost.expected) < Number(a.cost.expected), `el costo de Gamma verificado no se usó: ${a.cost.expected} → ${b.cost.expected}`);
      eq(b.design.proposalSha256, a.design.proposalSha256, 'el precio no mueve la huella del diseño');
      const hist = (await finops.gammaPrice()).history;
      assert(hist.length >= 2 && hist[0].verified === true, 'historial con la fila nueva primero');
    });
    await check('DB8 presupuesto inválido → 400; nunca es el «Tope autorizado»', async () => {
      await rejectsRe(design.recommend(cid2, OWNER, { adjust: { productionBudgetUsd: 0.5 } }), /productionBudgetUsd/, '0,5', 400);
      await rejectsRe(design.recommend(cid2, OWNER, { adjust: { productionBudgetUsd: 6000 } }), /productionBudgetUsd/, '6000', 400);
      const r = await design.recommend(cid2, OWNER, { adjust: { productionBudgetUsd: 500 } });
      eq([r.productionBudget.isAuthorizedCap, r.budgetFit.status], [false, 'fits'], 'solo referencia');
      const auth = await ds.query(`select count(*) n from public.cost_budget_authorizations`);
      eq(Number(auth[0].n), 0, 'ninguna autorización escrita');
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
