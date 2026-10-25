#!/usr/bin/env node
/* eslint-disable */
// r72 · «Verificación del diseño» y la Propuesta del caso real de producción #87 («Inglés Básico – Grado Sexto»).
// Contra dist/. USD 0: sin proveedores, sin IA, red bloqueada (solo el Postgres local en loopback).
//
// Fixture: scripts/fixtures/r72/course-87.json — capturado con GET de solo lectura en producción (estructura, pedido,
// contexto académico, perfil pedagógico, registro de la autocorrección y la readiness que veía el dueño). Sin emails ni
// ids de dueño o institución.
//
// Parte pura
//   OP1 #87: RA1 y RA7 (transversales) se AGREGAN a los capítulos de contenido con relación justificada (sin quitar ni
//       reemplazar vínculos), con su evidencia; ningún «before» pierde un id
//   OP2 #87: CO1 (sin prácticas integradoras) → los capítulos que integran los RA que agrupa, uno por módulo, con motivo
//   OP3 #87: el capítulo «Familia…» (módulo sin vínculos) → los resultados con relación justificada
//   OP4 #87: RA5 «Reconocer vocabulario fundamental» y RA6 «Comprender textos cortos» NO son «fragmentos»; Cursia propone
//       una redacción contextualizada (idioma + temas del curso) que conserva el verbo y la intención
//   OP5 registros obsoletos: un cambio cuyo capítulo ya no existe (la estructura se reemplazó) no se muestra como aplicado
//       ni cuenta como «deshecho por el docente»; un cambio deshecho de verdad sigue sin re-aplicarse
//   OP6 resultado sin relación → propuesta de ajuste de contenido (agregar el tema al capítulo más relacionado), no un
//       vínculo inventado; competencia faltante → propuesta revisable a partir del objetivo del documento
//   OP7 idempotente y nada pisa al docente (vínculos existentes, desvinculados, lo deshecho)
//   OP8 fragmentos de verdad siguen pidiendo confirmación (plantillas, «Unidad 1», textos cortados)
// Parte DB (Postgres 16 desechable; --pure-only la salta y lo dice)
//   OD1 réplica de #87: la propuesta muestra los MISMOS bloqueos que producción (RA1, RA7, 36 cambios, RA5/RA6 dudosos)
//       con el código de antes; con r72, después de la optimización: sin críticos, sin datos dudosos falsos, los 36 cambios
//       con su acción en línea (aplicar el diseño) y, aplicados, «Preparar para aprobación» habilitado
//   OD2 sin churn: aplicar el diseño + optimizar + volver a recomendar → 0 cambios pendientes; otra optimización → 0
//   OD3 redacción mejorada: aplicada con el texto original recuperable; «Deshacer» restaura el resultado del documento
//       (texto, origen y cita); lo deshecho no se re-aplica
//   OD4 conocimientos previos: una pregunta en línea con sugerencia; respondida, la verificación no la vuelve a pedir
//   OD5 recargar: GET /prebrief dos veces → misma readiness, sin advertencias viejas
//
// Uso: node scripts/check-r72-pedagogical-optimizer.js [--pure-only] [path/to/dist]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const netAttempts = [];
{
  const http = require('http'); const https = require('https');
  for (const m of [http, https]) { m.request = function () { netAttempts.push('http'); throw new Error('red prohibida'); }; m.get = m.request; }
  globalThis.fetch = () => { netAttempts.push('fetch'); throw new Error('red prohibida'); };
}

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
const EXPLORE = process.env.R72_EXPLORE === '1';
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), args.find((a) => !a.startsWith('--')) || 'dist');
const loadDist = (rel) => { try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar ${rel} (¿corriste "npm run build"?): ${err.message}`); process.exit(1); } };
const P = loadDist('modules/course-design/pedagogical-autofix.js');
const PL = loadDist('modules/prebrief/plausibility.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
const clone = (x) => JSON.parse(JSON.stringify(x));
const rejects = async (p, re, m) => { try { await p; } catch (e) { if (re.test(String(e && (e.message || (e.response && e.response.message)) || e))) return; throw new Error(`${m}: error inesperado ${e && e.message}`); } throw new Error(`${m}: no falló`); };

const FX = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/fixtures/r72/course-87.json'), 'utf8'));
const CTX = FX.academic;
const modulesOf = (fx) => fx.modules.map((m) => ({ id: m.id, position: m.position, title: m.title, objective: m.objective, description: m.description }));
const chaptersOf = (fx) => fx.modules.flatMap((m) => m.chapters.map((c) => ({ id: c.id, moduleId: m.id, position: c.position, title: c.title, objective: c.objective, description: c.description, kind: c.kind, outcomeIds: c.outcomeIds || [] })));
const titleOf = (id) => FX.modules.flatMap((m) => m.chapters).find((c) => c.id === id).title;
const short = (t) => t.split(',')[0];
const applyPlan = (chapters, plan) => chapters.map((c) => { const ch = plan.changes.filter((x) => x.target.chapterId === c.id).pop(); return ch ? { ...c, outcomeIds: ch.after } : c; });
const ctxWith = (plan, ctx) => {
  const out = clone(ctx);
  for (const ch of plan.changes.filter((x) => x.kind === 'outcome_wording')) { const o = out.outcomes.find((x) => x.id === ch.target.outcomeId); if (o) o.text = ch.after; }
  return out;
};
const input87 = (over = {}) => ({ ctx: CTX, modules: modulesOf(FX), chapters: chaptersOf(FX), context: { sector: 'Educación' }, hasDocument: true, course: { name: FX.brief.nombre }, ...over });

(async () => {
  console.log('Parte pura');

  await check('OP1 #87: RA1 y RA7 se AGREGAN a los capítulos con relación justificada, sin quitar vínculos', async () => {
    const plan = P.planAutofix(input87());
    if (EXPLORE) for (const c of plan.changes) console.log('   ', c.kind, c.id, c.target.chapterTitle || c.target.outcomeId || c.target.field, JSON.stringify(c.before), '→', JSON.stringify(c.after), '|', c.reason);
    if (EXPLORE) for (const p of plan.proposals) console.log('   P', p.kind, p.id, p.title, '|', p.detail);
    const cover = plan.changes.filter((c) => c.kind === 'cover_outcome');
    const by = (ra) => cover.filter((c) => c.target.outcomeIds && c.id.startsWith(`cover:${ra}`)).map((c) => short(titleOf(c.target.chapterId)));
    eq(by('RA1'), ['Rutinas', 'Integración de vocabulario'], 'RA1 (expresiones de la vida cotidiana)');
    eq(by('RA7'), ['Integración de vocabulario'], 'RA7 (preguntas y respuestas ↔ «diálogos»)');
    for (const c of plan.changes.filter((x) => x.target.chapterId)) {
      for (const id of c.before || []) assert(c.after.includes(id), `«${c.target.chapterTitle}» conserva ${id}`);
      assert(c.reason && /relaci|comparte|trabaja|desarrolla|integra/i.test(c.reason), 'motivo con evidencia: ' + c.reason);
    }
    eq(plan.proposals.filter((p) => p.kind === 'uncovered_outcome'), [], 'sin propuestas de vincular RA1/RA7 (se resolvieron con evidencia)');
  });

  await check('OP2 #87: CO1 → el capítulo que integra sus resultados en cada módulo (sin práctica integradora)', async () => {
    const plan = P.planAutofix(input87());
    const co = plan.changes.filter((c) => c.kind === 'competency');
    assert(co.length >= 3, 'CO1 en varios módulos: ' + co.length);
    for (const c of co) { assert(c.after.includes('CO1'), 'CO1'); for (const id of c.before) assert(c.after.includes(id), 'no quita'); assert(/CO1/.test(c.reason) && /RA\d/.test(c.reason), 'motivo con los RA que agrupa: ' + c.reason); }
    eq(plan.proposals.filter((p) => p.kind === 'competency'), [], 'CO1 ya no queda como propuesta');
  });

  await check('OP3 #87: «Familia…» (módulo sin vínculos) → resultados con relación justificada', async () => {
    const plan = P.planAutofix(input87());
    const fam = plan.changes.filter((c) => c.target.chapterTitle && /^Familia/.test(c.target.chapterTitle) && c.kind !== 'competency');
    assert(fam.length === 1, 'un cambio: ' + JSON.stringify(fam.map((x) => x.kind)));
    assert(fam[0].after.includes('RA3'), 'RA3 («Identificar personas…») ↔ «descripciones físicas, personalidad»: ' + JSON.stringify(fam[0].after));
  });

  await check('OP4 #87: RA5 / RA6 no son fragmentos; redacción contextualizada que conserva su intención', async () => {
    eq(PL.doubtOf('outcome', 'Reconocer vocabulario fundamental'), null, 'RA5 no es fragmento');
    eq(PL.doubtOf('outcome', 'Comprender textos cortos'), null, 'RA6 no es fragmento');
    const plan = P.planAutofix(input87());
    const w = plan.changes.filter((c) => c.kind === 'outcome_wording');
    eq(w.map((c) => c.target.outcomeId), ['RA5', 'RA6'], 'solo los poco claros');
    const [r5, r6] = w;
    assert(/^Reconocer vocabulario fundamental en inglés /.test(r5.after), 'RA5 conserva el verbo y el objeto: ' + r5.after);
    assert(/^Comprender textos cortos en inglés /.test(r6.after), 'RA6: ' + r6.after);
    for (const c of w) { assert(/saludos/i.test(c.after) && /rutinas/i.test(c.after), 'temas del curso: ' + c.after); assert(c.before === CTX.outcomes.find((o) => o.id === c.target.outcomeId).text, 'original recuperable'); assert(c.after.length <= 220, 'corto'); }
    assert(/documento|curso/.test(r5.reason), 'motivo: ' + r5.reason);
  });

  await check('OP5 registros obsoletos (capítulo que ya no existe) no cuentan como aplicados ni como deshechos', async () => {
    const st = P.parseAutofixState(FX.autofixState);
    const live = new Map(chaptersOf(FX).map((c) => [c.id, c.outcomeIds]));
    eq(P.appliedRecords(st).length, 16, 'el registro de producción: 16 «aplicadas»');
    const fresh = P.liveAutofixState(st, { chapters: live, sector: FX.brief.sector });
    eq(P.appliedRecords(fresh).map((r) => r.id), ['context:sector'], 'solo el sector sigue vigente: las 15 de capítulos apuntan a «Profundización» que ya no existen (la estructura se reemplazó)');
    eq(fresh.changes.filter((r) => r.status === 'obsolete').length, 15, '15 obsoletas');
    const declined = P.declinedKeys(fresh);
    assert(!declined.has('cover:RA1') && !declined.has('cover:RA7'), 'RA1 / RA7 no quedan como «deshechos por el docente»');
  });

  await check('OP6 sin relación → ajuste de contenido (propuesta); competencia faltante → propuesta revisable', async () => {
    const ctx = clone(CTX);
    ctx.outcomes.push({ ...ctx.outcomes[0], id: 'RA10', text: 'Gestionar inventarios de bodega con hojas de cálculo' });
    const plan = P.planAutofix(input87({ ctx }));
    assert(!plan.changes.some((c) => Array.isArray(c.after) && c.after.includes('RA10')), 'RA10 no se vincula solo');
    const pr = plan.proposals.find((p) => p.outcomeId === 'RA10');
    assert(pr && pr.kind === 'content_adjustment' && pr.chapterId && pr.topic, 'ajuste de contenido con capítulo y tema: ' + JSON.stringify(pr));
    const noCo = clone(CTX); noCo.competencies = [];
    const p2 = P.planAutofix(input87({ ctx: noCo }));
    const mc = p2.proposals.find((p) => p.kind === 'missing_competency');
    assert(mc && mc.text && mc.text.length > 20 && /inglés/i.test(mc.text), 'competencia propuesta desde el documento: ' + JSON.stringify(mc));
    assert(!p2.changes.some((c) => c.kind === 'competency'), 'no se aplica sola');
  });

  await check('OP7 idempotente; lo del docente manda', async () => {
    const plan = P.planAutofix(input87());
    const again = P.planAutofix(input87({ ctx: ctxWith(plan, CTX), chapters: applyPlan(chaptersOf(FX), plan) }));
    eq(again.changes.map((c) => c.id), [], 'idempotente');
    const declined = new Set(plan.changes.map((c) => c.id));
    const d = P.planAutofix(input87({ declined }));
    eq(d.changes.map((c) => c.id), [], 'lo deshecho no se re-aplica');
    const pinned = chaptersOf(FX).map((c) => (/^Rutinas/.test(c.title) ? { ...c, noLinks: true } : c));
    assert(!P.planAutofix(input87({ chapters: pinned })).changes.some((c) => /^Rutinas/.test(c.target.chapterTitle || '')), 'desvinculado a propósito');
  });

  await check('OP8 fragmentos de verdad siguen pidiendo confirmación', async () => {
    for (const [t, want] of [['Unidad 1', 'fragment'], ['Reconocer el', 'fragment'], ['Identificar los tipos de', 'fragment'], ['vocabulario fundamental', 'fragment'], ['Comprender', 'fragment'], ['INSTRUCCIÓN: Tomar ejemplos del sector', 'template']]) eq(PL.doubtOf('outcome', t), want, t);
    for (const t of ['Analiza la cadena de suministro de una organización.', 'Describir rutinas y preferencias']) eq(PL.doubtOf('outcome', t), null, t);
    // Verbo observable (regla A7): las formas pronominales («Presentarse…», «Comunicarse…») se reconocen.
    const B = loadDist('modules/academic-context/bloom.js');
    for (const t of ['Presentarse y proporcionar información personal', 'Comunicarse mediante oraciones sencillas en situaciones familiares y escolares', 'Expresarse con claridad']) assert(B.observableLevelOf(t), 'verbo observable: ' + t);
    eq(B.bloomLevelOf('Presentarse y proporcionar información personal'), null, 'el léxico de Bloom (extracción, clasificación de capítulos) no cambia');
    eq(B.observableLevelOf('Unidad 1'), null, 'sin verbo');
  });

  if (PURE_ONLY) console.log('\n(--pure-only: la parte DB NO corrió)');
  else await dbChecks();
  eq(netAttempts, [], 'red');
  console.log(`\n${passed} ok · ${failed} fallas · red fuera de loopback: ${netAttempts.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function findPgBin() {
  const cands = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean);
  for (const d of cands) {
    const pg = path.join(d, 'postgres');
    if (!fs.existsSync(pg)) continue;
    const v = spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '';
    if (/\b1[67]\./.test(v)) return d;
  }
  throw new Error('No encontré Postgres 16/17 (setear PG_BIN)');
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
  const { CourseProfilesService } = loadDist('modules/course-profiles/course-profiles.service.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { PedagogyService } = loadDist('modules/pedagogy/pedagogy.service.js');
  const { CourseDesignService } = loadDist('modules/course-design/course-design.service.js');
  const { PrebriefService } = loadDist('modules/prebrief/prebrief.service.js');
  const { CourseModule } = loadDist('modules/course-structure/entities/course-module.entity.js');
  const { CourseChapter } = loadDist('modules/course-structure/entities/course-chapter.entity.js');
  const { CourseStructureService } = loadDist('modules/course-structure/course-structure.service.js');
  Logger.overrideLogger(false);

  const pgBin = findPgBin();
  const port = Number(process.env.R72_PG_PORT) || await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r72-pg-'));
  const DB = 'r72optimizer';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  let started = false;
  let ds = null;
  try {
    let r = pg('initdb', ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
    if (r.status !== 0) throw new Error('initdb falló: ' + r.stderr);
    r = pg('pg_ctl', ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start']);
    if (r.status !== 0) throw new Error('pg_ctl start falló: ' + r.stderr + r.stdout);
    started = true;
    console.log(`  Postgres ${pgBin} en 127.0.0.1:${port}`);
    const withClient = async (db, fn) => { const c = new Client({ host: '127.0.0.1', port, user: 'postgres', database: db }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
    await withClient('postgres', (c) => c.query(`create database ${DB}`));
    await withClient(DB, async (c) => {
      for (const f of ['scripts/prod/test/fixtures/legacy-baseline.sql', 'supabase-migration-dynamic-course-structure.sql', 'supabase-migration-course-blueprints.sql',
        'supabase-migration-v21-blueprint-profiles.sql', 'supabase-migration-pedagogy-profiles.sql', 'supabase-migration-practice-chapters.sql',
        'supabase-migration-application-activities.sql', 'supabase-migration-guided-practice.sql', 'supabase-migration-academic-context.sql', 'supabase-migration-prebrief.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    process.env.DYNAMIC_V2_GENERAL_AVAILABILITY = 'true';
    delete process.env.ALLOW_UNOWNED_COURSES;
    process.env.DYNAMIC_MANIFEST_RULES_VERSION = '3';
    process.env.DYNAMIC_ACTIVITY_TYPE_RULES = '2';
    process.env.DYNAMIC_PREBRIEF_REQUIRED_SINCE = '2026-01-01T00:00:00Z';
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
    const design = new CourseDesignService(ds, coursesStub, pedagogy, profiles);
    const prebrief = new PrebriefService(ds, coursesStub, design, blueprints, profiles);
    const structure = new CourseStructureService(ds.getRepository(CourseModule), ds.getRepository(CourseChapter), coursesStub, ds, blueprints);
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const counter = async (cid) => Number((await ds.query(`select structure_version_counter c from public.courses where id = $1`, [cid]))[0].c);
    const links = async (cid) => (await ds.query(`select ch.title, ch.outcome_ids from public.course_chapters ch join public.course_modules m on m.id = ch.module_id where ch.course_id = $1 order by m.position, ch.position`, [cid])).map((x) => [x.title, x.outcome_ids]);
    const codes = (rd) => rd.blockers.map((b) => b.code + (b.outcomeIds ? ':' + b.outcomeIds.join(',') : b.code === 'doubtful_data' ? ':' + b.detail : ''));

    // Réplica de #87: el pedido, el contexto académico y el perfil pedagógico de producción; la estructura 6×1 que dejó
    // «Usar esta estructura» (con los vínculos de producción, los mismos ids de capítulo) y el registro de la
    // autocorrección que apunta a las «Profundización» que ya no existen.
    const replica = async (title, opts = {}) => {
      const meta = { brief: { briefVersion: 1, fields: FX.brief, updatedAt: '2026-10-25T14:19:01.031Z' }, structureOrigin: FX.metadata.structureOrigin, documentRequirements: FX.metadata.documentRequirements };
      if (!opts.noAutofixState) meta.pedagogicalAutofix = FX.autofixState;
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine, metadata) values ($1, $2, 'dynamic', true, 'h5p', $3::jsonb) returning id`, [OWNER, title, JSON.stringify(meta)]);
      await profiles.append(c.id, OWNER, 'academic', CTX);
      const pv = await profiles.getCurrent(c.id, OWNER, 'pedagogy').catch(() => null);
      const ped = clone(FX.pedagogy);
      await profiles.append(c.id, OWNER, 'pedagogy', ped, pv ? pv.version : 0);
      const ids = new Map();
      const fresh = (id) => (opts.sameIds ? id : require('crypto').randomUUID());
      for (const m of FX.modules) {
        const [mm] = await ds.query(`insert into public.course_modules (id, course_id, position, title, objective, description, exam_enabled) values ($1, $2, $3, $4, $5, $6, $7) returning id`, [fresh(m.id), c.id, m.position, m.title, m.objective, m.description, m.examEnabled]);
        for (const ch of m.chapters) {
          const [cc] = await ds.query(`insert into public.course_chapters (id, course_id, module_id, position, title, objective, description, video_enabled, activity_enabled, application_minutes, chapter_kind, outcome_ids) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) returning id`,
            [fresh(ch.id), c.id, mm.id, ch.position, ch.title, ch.objective, ch.description, ch.videoEnabled, ch.activityEnabled, ch.applicationMinutes, ch.kind, ch.outcomeIds ? JSON.stringify(ch.outcomeIds) : null]);
          ids.set(ch.id, cc.id);
        }
      }
      const cmap = { ...FX.metadata.contentMap, chapters: Object.fromEntries(Object.entries(FX.metadata.contentMap.chapters).map(([k, v]) => [ids.get(k) || k, v])) };
      await ds.query(`update public.courses set structure_version_counter = $2, metadata = metadata || jsonb_build_object('contentMap', $3::jsonb, 'structureOrigin', ($4::jsonb || jsonb_build_object('counter', $2::int))) where id = $1`, [c.id, FX.structureVersionCounter, JSON.stringify(cmap), JSON.stringify(FX.metadata.structureOrigin)]);
      return { id: c.id, ids };
    };
    const useDesign = async (cid) => {
      const card = await design.recommend(cid, OWNER, {});
      if ((card.design.changes || []).length || card.profileChanged) {
        if (card.profileChanged) { const cur = await profiles.getCurrent(cid, OWNER, 'pedagogy'); await profiles.append(cid, OWNER, 'pedagogy', card.profile, cur.version); }
        const c2 = await design.recommend(cid, OWNER, {});
        await structure.applyDistribution(cid, OWNER, { expectedCounter: await counter(cid), proposalSha256: c2.design.proposalSha256 });
      }
    };
    const FE = {};
    const exportFe = () => { if (process.env.R72_FE_FIXTURE) fs.writeFileSync(process.env.R72_FE_FIXTURE, JSON.stringify(FE, null, 1) + '\n'); };
    globalThis.__r72 = { ds, design, prebrief, profiles, structure, replica, useDesign, counter, links, codes, OWNER, FE, exportFe };

    if (EXPLORE) {
      const c = await replica('[R72] explorar');
      const d0 = await prebrief.draft(c.id, OWNER);
      console.log('readiness', JSON.stringify(codes(d0.readiness)), d0.readiness.blockers.map((b) => b.title).join(' | '));
      const card = await design.recommend(c.id, OWNER, {});
      console.log('changes', card.design.changes.length, JSON.stringify(card.design.changes.slice(0, 40).map((x) => x.type + ':' + (x.detail || '').slice(0, 70))));
      console.log('autofix', JSON.stringify({ pending: card.autofix.pending, applied: card.autofix.applied.length, proposals: card.autofix.proposals.map((p) => p.id) }));
      console.log('checks', JSON.stringify(card.verification.checks.filter((x) => x.severity !== 'ok').map((x) => [x.severity, x.id, x.title.slice(0, 90), x.fix && x.fix.label])));
      await useDesign(c.id);
      const k1 = await design.recommend(c.id, OWNER, {});
      console.log('explore: tras usar el diseño 1 vez:', k1.design.changes.length, JSON.stringify([...new Set(k1.design.changes.map((x) => x.type))]));
      console.log('explore: cambios', JSON.stringify(k1.design.changes.filter((x) => x.type === 'set_video').slice(0, 4).map((x) => x.detail)));
      console.log('explore: card0 m1', JSON.stringify(card.design.modules[0].chapters.map((x) => [x.title.slice(0, 18), x.proposed, x.videoEnabled, x.applicationMinutes, x.hours])));
      console.log('explore: k1 m1', JSON.stringify(k1.design.modules[0].chapters.map((x) => [x.title.slice(0, 18), x.proposed, x.videoEnabled, x.applicationMinutes, x.hours])));
      console.log('explore: live m1', JSON.stringify((await ds.query(`select ch.title, ch.video_enabled, ch.application_minutes from public.course_chapters ch join public.course_modules m on m.id = ch.module_id where ch.course_id = $1 and m.position = 0 order by ch.position`, [c.id])).map((x) => [x.title.slice(0, 18), x.video_enabled, x.application_minutes])));
      console.log('explore: hours', card.design.estimatedHours, k1.design.estimatedHours, card.design.status, k1.design.status);
      await useDesign(c.id);
      const k2 = await design.recommend(c.id, OWNER, {});
      console.log('explore: tras usar el diseño 2 veces:', k2.design.changes.length, JSON.stringify(k2.design.changes.slice(0, 3).map((x) => x.detail)));
      await useDesign(c.id);
      const k3 = await design.recommend(c.id, OWNER, {});
      console.log('explore: tras usar el diseño 3 veces:', k3.design.changes.length, 'horas', k1.design.estimatedHours, k2.design.estimatedHours, k3.design.estimatedHours);
    }
    await dbCases(globalThis.__r72);
  } finally {
    if (ds) await ds.destroy().catch(() => {});
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function dbCases(T) {
  const { ds, design, prebrief, profiles, structure, replica, useDesign, counter, links, codes, OWNER, FE, exportFe } = T;
  const linkMap = async (cid) => new Map((await links(cid)).map(([t, v]) => [t, v]));
  const short = (t) => t.split(',')[0];
  const ctxOutcome = async (cid, id) => (await profiles.getCurrent(cid, OWNER, 'academic')).profile.outcomes.find((o) => o.id === id);
  const D = {};

  await check('OD1 réplica de #87: mismos bloqueos que producción → optimizada: sin críticos, sin dudosos falsos, cambios del diseño con acción en línea; aplicados → lista', async () => {
    const c = await replica('QA r72 Inglés Básico (réplica #87)', { sameIds: true });
    D.c = c.id;
    const before = await prebrief.draft(c.id, OWNER);
    // Producción mostraba además RA5 / RA6 «fragmento incompleto» (falso positivo, corregido en plausibility.ts).
    const prodCodes = FX.readinessProd.blockers.map((b) => b.code + (b.outcomeIds ? ':' + b.outcomeIds.join(',') : b.code === 'doubtful_data' ? ':' + b.detail : ''));
    eq(prodCodes, ['critical:RA1', 'critical:RA7', 'pending_changes', 'doubtful_data:RA5', 'doubtful_data:RA6'], 'producción (fixture)');
    eq(codes(before.readiness), ['critical:RA1', 'critical:RA7', 'pending_changes'], 'réplica con r72 ANTES de optimizar: los mismos críticos y cambios; RA5/RA6 ya no son «dudosos»');
    const pc = before.readiness.blockers.find((b) => b.code === 'pending_changes');
    assert(pc.inline && pc.inline.kind === 'apply_design' && pc.inline.proposalSha256 && pc.inline.total >= 30, 'los cambios del diseño traen su acción en línea: ' + JSON.stringify(pc.inline));
    assert(/capítulos de profundización/.test(pc.inline.summary.join(' ')) && /60 h/.test(pc.inline.summary.join(' ')), 'resumen: ' + pc.inline.summary.join(' · '));
    const card0 = await design.recommend(c.id, OWNER, {});
    eq(card0.autofix.applied.map((x) => x.id), ['context:sector'], 'el resumen ya no muestra las 15 mejoras sobre capítulos que no existen');
    assert(card0.autofix.pending > 0, 'hay mejoras pendientes');
    const q = card0.autofix.questions.find((x) => x.key === 'priorKnowledge');
    assert(q && q.suggestion === 'none' && /Grado Sexto/.test(q.question) && /Básica Secundaria/.test(q.why), 'pregunta de conocimientos previos con sugerencia: ' + JSON.stringify(q));
    FE.before = await prebrief.state(c.id, OWNER);
    const fx = await design.fix(c.id, OWNER, 'autofix', await counter(c.id));
    FE.autofixResponse = fx;
    const kinds = fx.applied.map((x) => x.kind);
    for (const k of ['outcome_wording', 'cover_outcome', 'chapter_outcomes', 'competency']) assert(kinds.includes(k), `aplicó ${k}: ${kinds.join(',')}`);
    const l = await linkMap(c.id);
    const fam = [...l.keys()].find((t) => /^Familia/.test(t));
    assert(l.get(fam).includes('RA3'), '«Familia…» con resultados: ' + JSON.stringify(l.get(fam)));
    assert(l.get([...l.keys()].find((t) => /^Rutinas/.test(t))).includes('RA1') && l.get([...l.keys()].find((t) => /^Rutinas/.test(t))).includes('RA8'), 'RA1 agregado a «Rutinas» sin quitar RA8');
    for (const ch of FX.modules.flatMap((m) => m.chapters)) for (const id of ch.outcomeIds || []) assert(l.get(ch.title).includes(id), `vínculo de producción intacto: ${ch.title} ${id}`);
    assert(/^Reconocer vocabulario fundamental en inglés sobre /.test((await ctxOutcome(c.id, 'RA5')).text), 'RA5 precisado en el contexto académico');
    const after = await prebrief.draft(c.id, OWNER);
    eq(codes(after.readiness), ['pending_changes'], 'después de optimizar solo queda el diseño por aplicar: ' + JSON.stringify(after.readiness.blockers.map((b) => b.title)));
    const card1 = await design.recommend(c.id, OWNER, {});
    eq(card1.verification.counts.critical, 0, 'verificación sin críticos');
    const stale = card1.verification.checks.filter((x) => /^alignment:/.test(x.id) && x.severity !== 'ok').map((x) => x.title);
    assert(!stale.some((t) => /Familia/.test(t) && /no está claramente asociado/.test(t)), '«Familia…» ya no aparece como sin resultado: ' + stale.join(' | '));
    assert(!stale.some((t) => /CO1/.test(t)), 'CO1 vinculada: ' + stale.join(' | '));
    assert(!stale.some((t) => /RA2|RA4/.test(t) && /verbo observable/.test(t)), 'RA2 «Presentarse…» y RA4 «Comunicarse…» tienen verbo observable: ' + stale.join(' | '));
    FE.optimized = await prebrief.state(c.id, OWNER);
    // El docente aplica los cambios recomendados (lo mismo que «Usar este diseño» / la acción en línea).
    await useDesign(c.id);
    if (EXPLORE) { const k = await design.recommend(c.id, OWNER, {}); console.log('   tras usar el diseño:', k.design.changes.length, JSON.stringify(k.design.changes.slice(0, 6).map((x) => x.type + ' ' + x.detail))); }
    const fx2 = await design.fix(c.id, OWNER, 'autofix', await counter(c.id));
    if (EXPLORE) { const k = await design.recommend(c.id, OWNER, {}); console.log('   tras optimizar:', k.design.changes.length, JSON.stringify(k.design.changes.slice(0, 8).map((x) => x.type + ' ' + x.detail))); console.log('   applied2', JSON.stringify(fx2.applied.map((x) => x.id + ' ' + JSON.stringify(x.after)))); }
    assert(fx2.applied.every((x) => x.kind === 'chapter_outcomes'), 'los capítulos nuevos heredan los resultados de su módulo: ' + fx2.applied.map((x) => x.kind).join(','));
    const ready = await prebrief.draft(c.id, OWNER);
    for (const dd of ready.doubts) await prebrief.confirm(c.id, OWNER, { id: OWNER }, dd.confirmKey);
    const ready2 = await prebrief.draft(c.id, OWNER);
    eq([ready2.readiness.ready, codes(ready2.readiness)], [true, []], 'lista para preparar: ' + JSON.stringify(ready2.readiness.blockers.map((b) => b.title)));
    FE.ready = await prebrief.state(c.id, OWNER);
    exportFe();
  });

  await check('OD2 sin churn: diseño aplicado + optimizado → 0 cambios recomendados; optimizar otra vez → nada', async () => {
    const card = await design.recommend(D.c, OWNER, {});
    eq([card.design.changes.length, card.autofix.designApply], [0, null], 'el diseño recomendado ya es el aplicado (los vínculos del autofix no lo cambian)');
    const c0 = await counter(D.c);
    const again = await design.fix(D.c, OWNER, 'autofix', c0);
    eq([again.applied.length, await counter(D.c)], [0, c0], 'idempotente');
    eq((await design.recommend(D.c, OWNER, {})).design.changes.length, 0, 'sigue sin cambios');
  });

  await check('OD3 redacción precisada: original recuperable; «Deshacer» restaura texto, origen y cita; no se re-aplica', async () => {
    const c = await replica('[R72] Redacción');
    const orig = await ctxOutcome(c.id, 'RA6');
    await design.fix(c.id, OWNER, 'autofix', await counter(c.id));
    const imp = await ctxOutcome(c.id, 'RA6');
    assert(imp.text !== orig.text && imp.status === 'inferred' && imp.sources.length === orig.sources.length, 'precisado con las fuentes del documento');
    const card = await design.recommend(c.id, OWNER, {});
    const rec = card.autofix.applied.find((x) => x.id === 'wording:RA6');
    eq([rec.before, rec.after], [orig.text, imp.text], 'el resumen muestra antes / después');
    const u = await design.fix(c.id, OWNER, 'autofix_undo', await counter(c.id), { changeIds: ['wording:RA6'] });
    eq(u.reverted, ['wording:RA6'], 'deshecho');
    eq(await ctxOutcome(c.id, 'RA6'), orig, 'el resultado del documento vuelve completo (texto, origen, cita)');
    const again = await design.fix(c.id, OWNER, 'autofix', await counter(c.id));
    assert(!again.applied.some((x) => x.id === 'wording:RA6'), 'no se re-aplica');
    const d = await prebrief.draft(c.id, OWNER);
    assert(!d.readiness.blockers.some((b) => b.code === 'doubtful_data' && b.detail === 'RA6'), 'RA6 original tampoco es «fragmento»');
  });

  await check('OD4 conocimientos previos: pregunta en línea con sugerencia; respondida, no se vuelve a pedir; inválido → 400', async () => {
    const c = await replica('[R72] Conocimientos previos');
    const card = await design.recommend(c.id, OWNER, {});
    const p2 = card.verification.checks.find((x) => x.fix && x.fix.action === 'learner');
    assert(p2 && p2.question && p2.question.suggestion === 'none', 'P2 con la pregunta');
    await rejects(design.fix(c.id, OWNER, 'context_field', await counter(c.id), { field: 'priorKnowledge', value: 'mucho' }), /value/, 'valor inválido');
    await design.fix(c.id, OWNER, 'context_field', await counter(c.id), { field: 'priorKnowledge', value: 'none' });
    const card2 = await design.recommend(c.id, OWNER, {});
    assert(!card2.verification.checks.some((x) => x.fix && x.fix.action === 'learner'), 'ya no se pide');
    eq(card2.autofix.questions, [], 'sin preguntas');
    eq((await profiles.getCurrent(c.id, OWNER, 'pedagogy')).profile.learner.priorKnowledge, 'none', 'en el perfil del docente');
  });

  await check('OD5 recargar: GET /prebrief dos veces → misma readiness y mismo resumen (sin advertencias viejas)', async () => {
    const a = await prebrief.state(D.c, OWNER);
    const b = await prebrief.state(D.c, OWNER);
    eq(JSON.stringify(a.draft.readiness), JSON.stringify(b.draft.readiness), 'misma readiness');
    eq(a.draft.autofix.applied.map((x) => x.id), b.draft.autofix.applied.map((x) => x.id), 'mismo resumen');
    assert(a.draft.autofix.applied.length >= 10, 'el resumen persiste: ' + a.draft.autofix.applied.length);
  });

  await check('OD6 ajuste de contenido aceptado con un clic y deshecho; competencia faltante aceptada', async () => {
    const c = await replica('[R72] Ajuste de contenido');
    const academic = await profiles.getCurrent(c.id, OWNER, 'academic');
    const ctx = clone(academic.profile);
    ctx.outcomes.push({ ...ctx.outcomes[0], id: 'RA10', text: 'Gestionar inventarios de bodega con hojas de cálculo' });
    await profiles.append(c.id, OWNER, 'academic', ctx, academic.version);
    const card = await design.recommend(c.id, OWNER, {});
    const p = card.autofix.proposals.find((x) => x.id === 'content:RA10');
    assert(p && p.kind === 'content_adjustment', 'propuesta');
    const r = await design.fix(c.id, OWNER, 'accept_proposal', await counter(c.id), { proposalId: p.id });
    const [row] = await ds.query(`select description, outcome_ids from public.course_chapters where id = $1`, [p.chapterId]);
    assert(row.outcome_ids.includes('RA10') && /Incluye: Inventarios de bodega/.test(row.description), 'tema agregado y vinculado');
    const u = await design.fix(c.id, OWNER, 'autofix_undo', await counter(c.id), { changeIds: [r.applied[0].id] });
    eq(u.reverted, [r.applied[0].id], 'deshecho');
    const [row2] = await ds.query(`select description, outcome_ids from public.course_chapters where id = $1`, [p.chapterId]);
    assert(!(row2.outcome_ids || []).includes('RA10') && !/Inventarios/.test(row2.description || ''), 'vuelve como estaba');
    // Competencia faltante.
    const c2 = await replica('[R72] Sin competencia');
    const a2 = await profiles.getCurrent(c2.id, OWNER, 'academic');
    const ctx2 = clone(a2.profile); ctx2.competencies = [];
    await profiles.append(c2.id, OWNER, 'academic', ctx2, a2.version);
    const p2 = (await design.recommend(c2.id, OWNER, {})).autofix.proposals.find((x) => x.kind === 'missing_competency');
    assert(p2 && /inglés/i.test(p2.text), 'propuesta desde el objetivo del documento');
    await design.fix(c2.id, OWNER, 'accept_proposal', await counter(c2.id), { proposalId: p2.id, text: p2.text });
    eq((await profiles.getCurrent(c2.id, OWNER, 'academic')).profile.competencies.map((x) => x.id), ['CO1'], 'competencia guardada');
  });
}
