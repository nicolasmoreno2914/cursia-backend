#!/usr/bin/env node
/* eslint-disable */
// r73 UX-10 · El pedido del curso (courses.metadata.brief) se guarda por campo, con revisión, sin que un formulario viejo
// o vacío pise datos más nuevos del servidor. Contra el código COMPILADO en dist/ ("npm run build" antes). USD 0.
//
// Parte pura (mergeBrief / briefPatchFromBody):
//   BS1 caso #87: el servidor infirió sector «Educación»; un cliente con base vieja o un cliente anterior que no manda
//       sector (o lo manda vacío) NO lo borra, y el sector sigue «inferido»
//   BS2 borrar a propósito: `clear` lo quita (y su marca inferido); un texto vacío en `set` NO borra
//   BS3 conflicto: el servidor cambió el campo después de baseRevision → gana el servidor y vuelve en conflicts; un campo
//       que no cambió en el servidor sí se guarda en el mismo pedido
//   BS4 un valor del usuario deja de ser inferido; inferred.add lo mantiene; marca sola sin valor
//   BS5 sin cambios reales → changed:false (sin escritura, misma revisión); revisión y fieldRev suben solo en lo tocado
//   BS6 validación: dato desconocido, demasiado largo, set+clear del mismo dato, baseRevision inválida → error
//   BS7 compatibilidad: pedidos anteriores (sin revision) se leen igual; briefForClient siempre trae revision/fieldRev
// Parte DB (Postgres 16 local desechable; se salta SOLO con --pure-only, y lo dice):
//   BS8 PUT/GET reales + writeBriefField (autofix r71 «context_field», inferido) + PUT del formulario viejo del #87 →
//       el sector sobrevive; borrar a propósito persiste tras releer; 409 del formato anterior intacto
//   BS9 el #87 exacto solo con el formato anterior (también corre contra el código previo a UX-10, donde FALLA)
//
// Uso: node scripts/check-r73-brief-sync.js [--pure-only] [path/to/dist]
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
  try { return require(abs); } catch (err) { console.error(`❌ No se pudo cargar ${abs} (¿corriste "npm run build"?): ${err.message}`); process.exit(1); }
}
const CF = loadDist('modules/course-facts/course-facts.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
const throws = (fn, re, m) => { try { fn(); } catch (e) { assert(re.test(String(e && e.message)), `${m}: «${e && e.message}»`); return; } throw new Error(`${m}: no falló`); };
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

const T = '2026-10-25T20:29:41.000Z';
const merge = (prev, body) => CF.mergeBrief(prev, CF.briefPatchFromBody(body), T);
// El pedido del #87 justo antes del bug: lo del usuario + el sector que infirió el autofix r71 (writeBriefField inferido).
const P87 = { briefVersion: 1, fields: { nombre: 'Gestión Escolar', pais: 'Colombia', contexto: 'Universitario — x', nivel: 'Básico — sin conocimientos previos', tono: 'Conversacional', sector: 'Educación', inferidos: 'tono,pais,contexto,nivel,sector' }, updatedAt: '2026-10-25T18:00:00.000Z', revision: 4, fieldRev: { sector: 4 } };
// Lo que mandaba el formulario viejo del navegador al abrir #87 (cc_fields con c-sector = "").
const STALE_FORM_87 = { nombre: 'Gestión Escolar', pais: 'Colombia', contexto: 'Universitario — x', nivel: 'Básico — sin conocimientos previos', tono: 'Conversacional', sector: '', inferidos: 'tono,pais,contexto,nivel' };

(async () => {
  console.log('Parte pura');

  await check('BS1 caso #87: un formulario viejo con sector vacío no borra el sector inferido del servidor', () => {
    const legacy = merge(P87, STALE_FORM_87);
    eq(legacy.brief.fields.sector, 'Educación', 'cliente anterior (sin baseRevision): sector intacto');
    assert(legacy.brief.fields.inferidos.split(',').includes('sector'), 'sector sigue inferido');
    eq(legacy.changed, false, 'mismo pedido: sin escritura');
    const noSector = merge(P87, { ...STALE_FORM_87, sector: undefined });
    eq([noSector.brief.fields.sector, noSector.changed], ['Educación', false], 'sin sector en el cuerpo: intacto');
    // Cliente nuevo con una base anterior a la inferencia que (por error) intenta borrar el sector → conflicto, gana el servidor.
    const stale = merge(P87, { baseRevision: 3, clear: ['sector'] });
    eq([stale.brief.fields.sector, stale.changed, stale.conflicts], ['Educación', false, [{ field: 'sector', server: 'Educación', client: null }]], 'base vieja: conflicto');
    // Cliente nuevo que no tocó el sector: no lo manda → intacto aunque cambie otro dato.
    const other = merge(P87, { baseRevision: 4, set: { nombre: 'Gestión Escolar 2' } });
    eq([other.brief.fields.sector, other.brief.fields.nombre, other.brief.revision], ['Educación', 'Gestión Escolar 2', 5], 'otro dato: sector intacto');
    assert(other.brief.fields.inferidos.split(',').includes('sector'), 'sector sigue inferido tras otro guardado');
  });

  await check('BS2 borrar a propósito: clear quita el dato y su marca; texto vacío en set no borra', () => {
    const c = merge(P87, { baseRevision: 4, clear: ['sector'] });
    eq([c.changed, c.brief.fields.sector, c.brief.fields.inferidos, c.brief.fieldRev.sector, c.brief.revision], [true, undefined, 'tono,pais,contexto,nivel', 5, 5], 'borrado explícito');
    const e = merge(P87, { baseRevision: 4, set: { sector: '' } });
    eq([e.changed, e.brief.fields.sector], [false, 'Educación'], 'vacío = no mandado');
    const lc = merge(P87, { sector: '', clear: ['sector'] });
    eq(lc.brief.fields.sector, undefined, 'clear también vale en el formato anterior');
    const again = merge(c.brief, { baseRevision: 5, clear: ['sector'] });
    eq(again.changed, false, 'borrar lo ya borrado: sin escritura');
  });

  await check('BS3 conflicto por campo: gana lo más nuevo del servidor; el resto del pedido se guarda', () => {
    const r = merge(P87, { baseRevision: 2, set: { sector: 'Salud', obj: 'Planear el año escolar' } });
    eq([r.changed, r.brief.fields.sector, r.brief.fields.obj], [true, 'Educación', 'Planear el año escolar'], 'obj sí, sector no');
    eq(r.conflicts, [{ field: 'sector', server: 'Educación', client: 'Salud' }], 'conflicto informado');
    const ok = merge(P87, { baseRevision: 4, set: { sector: 'Salud' } });
    eq([ok.brief.fields.sector, ok.conflicts.length], ['Salud', 0], 'con la base vigente el usuario gana');
    assert(!ok.brief.fields.inferidos.split(',').includes('sector'), 'valor del usuario: deja de ser inferido');
    const same = merge(P87, { baseRevision: 1, set: { sector: 'Educación' } });
    eq([same.conflicts.length, same.changed], [0, false], 'mismo valor que el servidor: sin conflicto');
  });

  await check('BS4 marca «inferido»: add la conserva, remove/confirmar la quita sin tocar el valor', () => {
    const add = merge({ briefVersion: 1, fields: { obj: 'x' }, updatedAt: '' }, { baseRevision: 0, set: { sector: 'Educación' }, inferred: { add: ['sector'] } });
    eq([add.brief.fields.sector, add.brief.fields.inferidos], ['Educación', 'sector'], 'inferido desde el navegador (documento)');
    const conf = merge(P87, { baseRevision: 4, inferred: { remove: ['sector'] } });
    eq([conf.changed, conf.brief.fields.sector, conf.brief.fields.inferidos.includes('sector')], [true, 'Educación', false], 'confirmado por el usuario');
    const confStale = merge(P87, { baseRevision: 3, inferred: { remove: ['sector'] } });
    eq(confStale.changed, false, 'marca con base vieja: se queda la del servidor');
    const legacyInf = merge(P87, { ...STALE_FORM_87, sector: 'Educación' });
    assert(!legacyInf.brief.fields.inferidos.includes('sector') && legacyInf.brief.fields.sector === 'Educación', 'cliente anterior que MANDA sector: su inferidos decide la marca de ese campo');
  });

  await check('BS5 revisión: solo sube con cambios reales y solo en los campos tocados', () => {
    const r1 = merge(null, { baseRevision: 0, set: { obj: 'a', nombre: 'b' } });
    eq([r1.brief.revision, r1.brief.fieldRev], [1, { obj: 1, nombre: 1 }], 'primer guardado');
    const r2 = merge(r1.brief, { baseRevision: 1, set: { obj: 'a2', nombre: 'b' } });
    eq([r2.brief.revision, r2.brief.fieldRev, r2.applied], [2, { obj: 2, nombre: 1 }, ['obj']], 'solo obj');
    const r3 = merge(r2.brief, { baseRevision: 2, set: { obj: ' a2 ' } });
    eq([r3.changed, r3.brief.revision], [false, 2], 'sin cambios');
    const empty = merge(null, { baseRevision: 0 });
    eq(empty.changed, false, 'parche vacío');
  });

  await check('BS6 validación del parche', () => {
    throws(() => CF.briefPatchFromBody({ set: { foo: 'x' } }), /desconocido/, 'dato desconocido');
    throws(() => CF.briefPatchFromBody({ set: { pais: 'x'.repeat(101) } }), /hasta 100/, 'máximo');
    throws(() => CF.briefPatchFromBody({ set: { pais: 3 } }), /texto/, 'no texto');
    throws(() => CF.briefPatchFromBody({ set: { pais: 'x' }, clear: ['pais'] }), /set y en clear/, 'set+clear');
    throws(() => CF.briefPatchFromBody({ baseRevision: -1 }), /baseRevision/, 'baseRevision');
    throws(() => CF.briefPatchFromBody({ clear: ['inferidos'] }), /desconocido/, 'inferidos no se borra a mano');
    eq(CF.briefPatchFromBody({ baseRevision: 3, inferidos: 'sector' }).legacyInferidos, null, 'con base, inferidos suelto se ignora');
  });

  await check('BS7 compatibilidad de lectura', () => {
    const old = { briefVersion: 1, fields: { obj: 'a' }, updatedAt: 't' };
    eq(CF.parseBrief(old), old, 'pedido anterior: igual que antes');
    eq(CF.briefForClient(CF.parseBrief(old)), { ...old, revision: 0, fieldRev: {} }, 'la API siempre trae revision');
    eq(CF.parseBrief({ ...old, revision: 7, fieldRev: { obj: 7, x: 2, sector: 'y' } }), { ...old, revision: 7, fieldRev: { obj: 7 } }, 'fieldRev limpio');
    const r = merge(CF.parseBrief(old), { baseRevision: 0, set: { sector: 'S' } });
    eq([r.brief.revision, r.brief.fields.obj], [1, 'a'], 'merge sobre un pedido anterior');
  });

  if (PURE_ONLY) console.log('\n⚠️  --pure-only: se saltó la parte DB');
  else await dbChecks();
  console.log(`\n${passed} ok, ${failed} con error`);
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
  const { Logger } = require('@nestjs/common');
  const { CourseFactsService } = loadDist('modules/course-facts/course-facts.service.js');
  const { writeBriefField } = loadDist('modules/course-design/course-design.service.js');
  Logger.overrideLogger(false);
  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r73-brief-pg16-'));
  const DB = 'r73briefdb';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = { flag: process.env.DYNAMIC_COURSE_STRUCTURE, allow: process.env.DYNAMIC_V2_ALLOWED_OWNERS, ga: process.env.DYNAMIC_V2_GENERAL_AVAILABILITY };
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
        'supabase-migration-v21-blueprint-profiles.sql']) await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
    });
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    process.env.DYNAMIC_V2_GENERAL_AVAILABILITY = 'true';
    ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: DB, entities: [], synchronize: false });
    await ds.initialize();
    const facts = new CourseFactsService(ds);
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const cid = (await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, 'QA #87', 'dynamic', true, 'h5p') returning id`, [OWNER]))[0].id;

    await check('BS8 DB: inferencia del servidor + formulario viejo del #87 + borrar a propósito', async () => {
      const created = await facts.putBrief(cid, OWNER, { baseRevision: 0, set: { nombre: 'Gestión Escolar', pais: 'Colombia', contexto: 'Universitario — x', nivel: 'Básico — sin conocimientos previos', tono: 'Conversacional' }, inferred: { add: ['tono', 'pais', 'contexto', 'nivel'] } });
      eq([created.changed, created.brief.revision], [true, 1], 'creado');
      // r71: el autofix infiere el sector en el servidor (onlyIfEmpty, inferido).
      eq(await writeBriefField(ds, cid, 'sector', 'Educación', { inferred: true, onlyIfEmpty: true }), true, 'autofix escribe');
      const g1 = (await facts.getBrief(cid, OWNER)).brief;
      eq([g1.fields.sector, g1.revision, g1.fieldRev.sector], ['Educación', 2, 2], 'sector inferido con revisión');
      assert(g1.fields.inferidos.split(',').includes('sector'), 'marcado inferido');
      // El navegador del #87 (cliente ANTERIOR) manda su formulario completo con sector vacío y su updatedAt vigente.
      const old = await facts.putBrief(cid, OWNER, { ...STALE_FORM_87, expectedUpdatedAt: g1.updatedAt });
      eq(old.brief.fields.sector, 'Educación', 'cliente anterior: no borra');
      // Cliente nuevo con la base de ANTES de la inferencia (revision 1) que intenta borrar → conflicto.
      const st = await facts.putBrief(cid, OWNER, { baseRevision: 1, clear: ['sector'], set: { obj: 'Planear el año' } });
      eq([st.brief.fields.sector, st.brief.fields.obj, st.conflicts.map((c) => c.field)], ['Educación', 'Planear el año', ['sector']], 'base vieja');
      const g2 = (await facts.getBrief(cid, OWNER)).brief;
      eq(g2.fields.sector, 'Educación', 'tras releer, el sector sigue');
      // El usuario BORRA el sector a propósito con la base vigente → queda borrado tras releer.
      const cl = await facts.putBrief(cid, OWNER, { baseRevision: g2.revision, clear: ['sector'] });
      eq([cl.changed, cl.brief.fields.sector], [true, undefined], 'borrado');
      const g3 = (await facts.getBrief(cid, OWNER)).brief;
      eq([g3.fields.sector, (g3.fields.inferidos || '').includes('sector')], [undefined, false], 'tras recargar sigue borrado');
      // Un formulario viejo que no lo trae tampoco lo «revive» ni cambia nada.
      eq((await facts.putBrief(cid, OWNER, { ...STALE_FORM_87 })).changed, false, 'formulario viejo: sin escritura');
      // Formato anterior: 409 con updatedAt viejo intacto.
      await rejectsRe(facts.putBrief(cid, OWNER, { ...STALE_FORM_87, expectedUpdatedAt: '1999-01-01T00:00:00.000Z' }), /BRIEF_CHANGED/, '409 formato anterior', 409);
      await rejectsRe(facts.putBrief(cid, OWNER, { set: { sector: 'a' }, clear: ['sector'] }), /set y en clear/, '400 parche inválido', 400);
      // Deshacer del autofix (onlyIfValue): no toca un valor distinto.
      await facts.putBrief(cid, OWNER, { baseRevision: g3.revision, set: { sector: 'Pedagogía' } });
      eq(await writeBriefField(ds, cid, 'sector', null, { inferred: false, onlyIfValue: 'Educación' }), false, 'deshacer no pisa el valor del usuario');
      eq((await facts.getBrief(cid, OWNER)).brief.fields.sector, 'Pedagogía', 'valor del usuario');
    });

    // BS9 corre también contra el código ANTERIOR (sin mergeBrief ni writeBriefField exportado): reproduce el #87 tal cual.
    await check('BS9 regresión #87 exacta (formato anterior): abrir con cc_fields de sector vacío no borra el sector', async () => {
      const id = (await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, 'QA #87 exacto', 'dynamic', true, 'h5p') returning id`, [OWNER]))[0].id;
      await facts.putBrief(id, OWNER, { ...STALE_FORM_87, sector: undefined });
      // El autofix r71 infiere el sector en el servidor (lo mismo que writeBriefField inferido, escrito a mano para que
      // este caso corra también sobre el código anterior).
      await ds.query(`update public.courses set metadata = jsonb_set(metadata, '{brief,fields}', (metadata #> '{brief,fields}') || '{"sector":"Educación","inferidos":"tono,pais,contexto,nivel,sector"}'::jsonb) where id = $1`, [id]);
      const before = (await facts.getBrief(id, OWNER)).brief;
      eq(before.fields.sector, 'Educación', 'sector inferido en el servidor');
      // El navegador con el formulario local viejo (c-sector = "") guarda al abrir el curso, con el updatedAt vigente.
      await facts.putBrief(id, OWNER, { ...STALE_FORM_87, expectedUpdatedAt: before.updatedAt });
      const after = (await facts.getBrief(id, OWNER)).brief;
      eq(after.fields.sector, 'Educación', 'el sector sobrevive al formulario viejo');
      assert(String(after.fields.inferidos || '').split(',').includes('sector'), 'y sigue marcado inferido');
    });
  } finally {
    if (ds) await ds.destroy().catch(() => {});
    for (const [k, v] of [['DYNAMIC_COURSE_STRUCTURE', saved.flag], ['DYNAMIC_V2_ALLOWED_OWNERS', saved.allow], ['DYNAMIC_V2_GENERAL_AVAILABILITY', saved.ga]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
