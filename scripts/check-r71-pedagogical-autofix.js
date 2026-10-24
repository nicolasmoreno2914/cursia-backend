#!/usr/bin/env node
/* eslint-disable */
// r71 · «Cursia optimizó tu curso» (autocorrección pedagógica) y la propuesta sin callejones sin salida. Contra dist/.
// USD 0: sin proveedores, sin IA, red bloqueada (solo el Postgres local en loopback).
//
// Parte pura (planAutofix / withInlineActions):
//   AF1 curso real #1672 (estructura capturada de staging + contexto del PDF real): RA1 y RA7 → capítulos SIN vínculos del
//       módulo «Let’s Communicate!» (Profundización 1 y 2), con su motivo; las profundizaciones heredan los resultados de su
//       módulo; CO1 → las prácticas integradoras; sector «Educación» inferido del nivel educativo del documento; nada
//       pisa un vínculo existente; correr otra vez con lo aplicado no cambia nada (idempotente)
//   AF2 datos incompletos (sin documento, pocos campos): no se infiere el sector ni se fuerzan vínculos de capítulos que
//       no son profundizaciones; sin contexto académico, nada (ni se inventa)
//   AF3 competencias: sin competencias no se inventa ninguna; una competencia sin prácticas integradoras → propuesta
//   AF4 resultado sin capítulo plausible → PROPUESTA (vincular / agregar capítulo), nunca un cambio silencioso; sin
//       capítulo libre en el módulo plausible → propuesta «Vincular a…» al capítulo del módulo
//   AF5 decisiones del docente: vínculos existentes, capítulos desvinculados a propósito, sector escrito y lo deshecho
//       (declined) no se tocan
//   AF6 propuesta: cada bloqueo que Cursia no resuelve sola trae su acción en línea (vincular a <capítulo>, campo con la
//       sugerencia); la verificación lleva los resultados del hallazgo
// Parte DB (Postgres 16 desechable; --pure-only la salta y lo dice):
//   AD1 réplica de #1672: la propuesta muestra los MISMOS 3 bloqueos que staging (RA1, RA7, sector); «Cursia optimizó tu
//       curso» (design/fix autofix) los resuelve; la propuesta queda lista y «Preparar para aprobación» funciona de verdad
//   AD2 idempotente: otra vez → nada aplicado, el contador no sube
//   AD3 deshacer RA1: vuelve el bloqueo con «Vincular a…»; autofix NO lo re-aplica; el docente vincula en línea → lista
//   AD4 deshacer todo restaura los vínculos y el pedido originales (sector incluido); el contador sube una vez
//   AD5 lo del docente manda: sector escrito no se pisa; un dato completado en línea queda como del docente (no inferido)
//   AD6 contador viejo → 409; propuesta lista/aprobada → no se cambia sola (skipped PREBRIEF_FROZEN)
//   AD7 rendimiento con 150 ms por consulta (base remota): GET /prebrief < 1,5 s
//   AD8 conexiones (incidente de producción r71): con el caché, GET /prebrief usa a lo sumo las conexiones simultáneas que
//       sin caché (1) y responde igual; /prebrief + /modules concurrentes con el pool de producción (5) y un tope de
//       clientes chico (rol con CONNECTION LIMIT, rechaza al instante como el pooler) → 0 errores; una anticipada rota no
//       rompe la petición
//
// Uso: node scripts/check-r71-pedagogical-autofix.js [--pure-only] [path/to/dist]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const netAttempts = [];
{
  const http = require('http'); const https = require('https');
  for (const m of [http, https]) { const orig = m.request; m.request = function (...a) { netAttempts.push('http'); throw new Error('red prohibida'); }; m.get = m.request; void orig; }
  globalThis.fetch = () => { netAttempts.push('fetch'); throw new Error('red prohibida'); };
}

const args = process.argv.slice(2);
const PURE_ONLY = args.includes('--pure-only');
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), args.find((a) => !a.startsWith('--')) || 'dist');
const loadDist = (rel) => { try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar ${rel} (¿corriste "npm run build"?): ${err.message}`); process.exit(1); } };
const P = loadDist('modules/course-design/pedagogical-autofix.js');
const R = loadDist('modules/prebrief/prebrief-readiness.js');
const V = loadDist('modules/course-design/design-verification.js');
const E = loadDist('modules/academic-context/extract/extractor.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
const clone = (x) => JSON.parse(JSON.stringify(x));

const FX = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/fixtures/r71/course-1672.json'), 'utf8'));
const PDF = fs.readFileSync(path.join(REPO, 'scripts/fixtures/microcurriculum/microcurriculo-ingles-grado-6.pdf'));
const modulesOf = (fx) => fx.modules.map((m) => ({ id: m.id, position: m.position, title: m.title, objective: m.objective, description: m.description }));
const chaptersOf = (fx) => fx.modules.flatMap((m) => m.chapters.map((c) => ({ id: c.id, moduleId: m.id, position: c.position, title: c.title, objective: c.objective, description: c.description, kind: c.kind, outcomeIds: c.outcomeIds || [] })));
const titleOf = (fx, id) => fx.modules.flatMap((m) => m.chapters).find((c) => c.id === id).title;
const applyPlan = (chapters, plan) => chapters.map((c) => { const ch = plan.changes.find((x) => x.target.chapterId === c.id); return ch ? { ...c, outcomeIds: ch.after } : c; });

(async () => {
  const ctx1672 = (await E.extractAcademicContext([{ name: 'Microcurriculo_Ingles_Grado_6.pdf', data: PDF }])).context;
  console.log('Parte pura');

  await check('AF1 #1672: RA1/RA7 a capítulos libres de «Let’s Communicate!», profundizaciones al módulo, CO1 a prácticas, sector inferido; idempotente', async () => {
    const chapters = chaptersOf(FX);
    const plan = P.planAutofix({ ctx: ctx1672, modules: modulesOf(FX), chapters, context: { sector: null }, hasDocument: true });
    const cover = plan.changes.filter((c) => c.kind === 'cover_outcome');
    eq(cover.map((c) => [c.id, titleOf(FX, c.target.chapterId), c.after]), [
      ['cover:RA1', 'Profundización 1: Let’s Communicate!', ['RA1']],
      ['cover:RA7', 'Profundización 2: Let’s Communicate!', ['RA7']],
    ], 'RA1 y RA7');
    assert(/«expresiones», «inglés»/.test(cover[0].reason) && /interacción oral/.test(cover[1].reason), 'motivo con la evidencia: ' + cover.map((c) => c.reason).join(' | '));
    for (const c of plan.changes) { eq(c.origin, 'cursia-autofix', 'origen'); assert(c.reason && c.title, 'título y motivo'); }
    // Nunca pisa un vínculo existente (del documento): before siempre vacío en capítulos.
    for (const c of plan.changes.filter((x) => x.target.chapterId)) eq(c.before, [], `«${c.target.chapterTitle}» no tenía vínculos`);
    const deep = plan.changes.filter((c) => c.kind === 'chapter_outcomes');
    eq(deep.length, 13, 'capítulos sin resultado → los de su módulo (12 profundizaciones + «Familia…»)');
    eq(deep.find((c) => c.target.chapterTitle === 'Profundización 1: My School and My World').after, ['RA3', 'RA4', 'RA8'], 'resultados del módulo');
    const comp = plan.changes.filter((c) => c.kind === 'competency');
    eq(comp.map((c) => c.target.chapterTitle.replace(/^Práctica integradora: /, '')), ['Hello! Getting to Know You', 'My School and My World', 'My Likes and Hobbies', 'Let’s Communicate!'], 'CO1 → prácticas integradoras');
    eq(comp[3].after, ['RA5', 'RA6', 'RA9', 'CO1'], 'la práctica integra lo que el módulo ya tenía y la competencia');
    const sector = plan.changes.find((c) => c.kind === 'context_field');
    eq([sector.id, sector.after, sector.before], ['context:sector', 'Educación', null], 'sector');
    assert(/Educación Básica Secundaria/.test(sector.reason), 'evidencia del sector: ' + sector.reason);
    eq(plan.proposals, [], 'sin propuestas: todo se resolvió con evidencia');
    const again = P.planAutofix({ ctx: ctx1672, modules: modulesOf(FX), chapters: applyPlan(chapters, plan), context: { sector: 'Educación' }, hasDocument: true });
    eq([again.changes.length, again.proposals.length], [0, 0], 'idempotente');
  });

  await check('AF2 datos incompletos: sin documento no se infiere el sector ni se fuerzan capítulos; sin contexto, nada', async () => {
    const ctx = clone(ctx1672);
    ctx.documents = []; ctx.units = [];
    ctx.outcomes = ctx.outcomes.slice(1, 3); // RA2, RA3 (del perfil)
    ctx.competencies = [];
    const chapters = chaptersOf(FX);
    const plan = P.planAutofix({ ctx, modules: modulesOf(FX), chapters, context: { sector: null }, hasDocument: false });
    assert(!plan.changes.some((c) => c.kind === 'context_field'), 'sin documento no hay evidencia del sector');
    assert(!plan.changes.some((c) => c.target.chapterTitle === 'Familia, descripciones físicas, personalidad, pronombres y adjetivos posesivos.'), 'un capítulo que no es profundización no se vincula a la fuerza');
    assert(plan.changes.filter((c) => c.kind === 'chapter_outcomes').every((c) => /^Profundización/.test(c.target.chapterTitle)), 'solo profundizaciones');
    const none = P.planAutofix({ ctx: null, modules: modulesOf(FX), chapters, context: { sector: null }, hasDocument: false });
    eq([none.changes, none.proposals], [[], []], 'sin contexto académico no se inventa nada');
    eq(P.inferSector(null), null, 'inferSector(null)');
    const uni = clone(ctx1672); uni.identity.educationLevel.value = { text: 'Pregrado', level: 'university' };
    eq(P.inferSector(uni), null, 'universidad no dice el área: sin sector');
  });

  await check('AF3 competencias: sin competencias no se inventa; sin prácticas integradoras → propuesta', async () => {
    const ctx = clone(ctx1672); ctx.competencies = [];
    const p1 = P.planAutofix({ ctx, modules: modulesOf(FX), chapters: chaptersOf(FX), context: { sector: 'Educación' }, hasDocument: true });
    assert(!p1.changes.some((c) => c.kind === 'competency') && !p1.proposals.some((x) => x.kind === 'competency'), 'nada de competencias');
    const noPractice = chaptersOf(FX).filter((c) => c.kind !== 'practice');
    const p2 = P.planAutofix({ ctx: ctx1672, modules: modulesOf(FX), chapters: noPractice, context: { sector: 'Educación' }, hasDocument: true });
    eq(p2.proposals.filter((x) => x.kind === 'competency').map((x) => [x.id, x.chapterId]), [['competency:CO1', null]], 'propuesta, sin vínculo forzado');
    assert(!p2.changes.some((c) => c.kind === 'competency'), 'ningún cambio de competencias');
  });

  await check('AF4 resultado sin capítulo plausible → propuesta (no un cambio); sin capítulo libre → «Vincular a…»', async () => {
    const ctx = clone(ctx1672);
    ctx.outcomes.push({ ...ctx.outcomes[0], id: 'RA10', text: 'Gestionar inventarios de bodega con hojas de cálculo' });
    const plan = P.planAutofix({ ctx, modules: modulesOf(FX), chapters: chaptersOf(FX), context: { sector: 'Educación' }, hasDocument: true });
    assert(!plan.changes.some((c) => (c.after || []).includes && c.after.includes('RA10')), 'RA10 no se vincula solo');
    const pr = plan.proposals.find((x) => x.outcomeId === 'RA10');
    assert(pr && pr.kind === 'uncovered_outcome' && /agrega un capítulo/.test(pr.detail), 'propuesta: ' + JSON.stringify(pr));
    eq(pr.chapterId, null, 'sin capítulo plausible');
    // Módulo plausible pero sin capítulos libres: propuesta con el capítulo del módulo (el docente decide).
    const full = chaptersOf(FX).map((c) => (c.kind === 'content' && !c.outcomeIds.length ? { ...c, outcomeIds: ['RA2'] } : c));
    const p2 = P.planAutofix({ ctx: ctx1672, modules: modulesOf(FX), chapters: full, context: { sector: 'Educación' }, hasDocument: true });
    const ra1 = p2.proposals.find((x) => x.outcomeId === 'RA1');
    assert(ra1 && ra1.chapterTitle === 'Integración de vocabulario, comprensión de textos, diálogos', 'propuesta «Vincular a…»: ' + JSON.stringify(ra1));
    assert(!p2.changes.some((c) => c.kind === 'cover_outcome'), 'sin cambio');
  });

  await check('AF5 lo del docente manda: vínculos, desvinculados a propósito, sector escrito y lo deshecho', async () => {
    const chapters = chaptersOf(FX).map((c) => (c.title === 'Profundización 1: Let’s Communicate!' ? { ...c, noLinks: true } : c));
    const declined = new Set(['cover:RA7', 'context:sector']);
    const plan = P.planAutofix({ ctx: ctx1672, modules: modulesOf(FX), chapters, declined, context: { sector: null }, hasDocument: true });
    assert(!plan.changes.some((c) => c.target.chapterTitle === 'Profundización 1: Let’s Communicate!'), 'desvinculado a propósito: intacto');
    eq(plan.changes.find((c) => c.id === 'cover:RA1').target.chapterTitle, 'Profundización 2: Let’s Communicate!', 'RA1 va al siguiente libre');
    assert(!plan.changes.some((c) => c.id === 'cover:RA7') && plan.proposals.some((x) => x.id === 'cover:RA7'), 'RA7 deshecho → solo propuesta');
    assert(!plan.changes.some((c) => c.id === 'context:sector'), 'sector deshecho: no se re-infiere');
    const p2 = P.planAutofix({ ctx: ctx1672, modules: modulesOf(FX), chapters: chaptersOf(FX), context: { sector: 'Idiomas' }, hasDocument: true });
    assert(!p2.changes.some((c) => c.kind === 'context_field'), 'sector escrito: no se pisa');
    for (const c of p2.changes.filter((x) => x.target.chapterId)) {
      const orig = chaptersOf(FX).find((x) => x.id === c.target.chapterId);
      eq(orig.outcomeIds, [], `solo capítulos sin vínculos (${orig.title})`);
    }
    const st = P.parseAutofixState({ changes: [{ id: 'a', status: 'applied' }, { id: 'a', status: 'reverted' }, { id: 'b', status: 'superseded' }, { id: 'c', status: 'reverted' }, { id: 'c', status: 'applied' }] });
    eq([...P.declinedKeys(st)].sort(), ['a', 'b'], 'el último registro manda');
    const st2 = P.parseAutofixState({ changes: [{ id: 'cover:RA1', status: 'reverted', target: { chapterId: 'X' } }] });
    eq([...P.declinedKeys(st2)].sort(), ['chapter:X', 'competency:X', 'cover:RA1'], 'el capítulo deshecho no se vuelve a tocar');
  });

  await check('AF6 propuesta: acciones en línea (vincular a <capítulo>, campo con sugerencia); la verificación lleva los resultados', async () => {
    const r = { ready: false, blockers: clone(FX.readinessBefore.blockers) };
    r.blockers[0].outcomeIds = ['RA1']; r.blockers[1].outcomeIds = ['RA7'];
    r.blockers[2].fields = [{ key: 'sector', label: 'Sector', editable: true, suggestion: null }];
    const plan = P.planAutofix({ ctx: ctx1672, modules: modulesOf(FX), chapters: chaptersOf(FX), context: { sector: null }, hasDocument: true });
    const out = R.withInlineActions(r, { pending: plan.changes.length, suggestions: plan.suggestions, chapters: [{ id: 'x', title: 'X', moduleTitle: 'M' }], contextSuggestions: { sector: 'Educación' } });
    eq(out.blockers[0].inline, { kind: 'link_outcome', outcomeId: 'RA1', chapterId: plan.suggestions.RA1.chapterId, chapterTitle: 'Profundización 1: Let’s Communicate!' }, 'RA1');
    eq(out.blockers[1].inline.chapterTitle, 'Profundización 2: Let’s Communicate!', 'RA7');
    eq(out.blockers[2].fields, [{ key: 'sector', label: 'Sector', editable: true, suggestion: 'Educación' }], 'sector con la sugerencia');
    eq([out.autofixPending, out.ready], [plan.changes.length, false], 'pendientes; nunca «lista» con bloqueos');
    eq(R.withInlineActions(r, null), r, 'sin vista previa, igual');
    const v = V.verifyDesign({ status: 'within_tolerance', targetHours: 10, estimatedHours: 10, toleranceHours: 1, baseHours: 8, counts: { modules: 1, chapters: 1, contentChapters: 1, practiceChapters: 0, videoChapters: 1, activities: 1, applicationActivities: 0, evaluations: 1 },
      manifestErrors: [], approach: null, policyKind: null, audiovisual: 'recommended', pinnedChapters: 0, cost: null, preferences: { emphasis: 'balanced', applicationActivities: 'auto' },
      autoLink: { chapterIds: [], outcomeIds: [], preview: [] }, proposedChapterIds: [], uncoveredContents: [], requiredEvaluations: [], uncoveredEvaluations: [],
      alignment: { available: true, outcomes: [{ id: 'RA1', status: 'uncovered', domain: 'know' }], findings: [{ id: 'AL001', rule: 'A1', severity: 'critical', outcomeIds: ['RA1'], chapterIds: [], message: 'El resultado RA1 no está cubierto.', suggestion: 's' }] } });
    eq(v.checks.find((c) => c.id === 'alignment:AL001').outcomeIds, ['RA1'], 'la verificación lleva el resultado');
    const rd = R.prebriefReadiness({ structure: { totals: { chapters: 1 } }, goals: { outcomes: [{ id: 'RA1' }] }, exceptions: [], generationContext: { nombre: 'x', pais: 'Colombia', contexto: 'c', nivel: 'n', tono: 't' } }, { design: { applicable: true, modules: [], changes: [] }, verification: v }, [], []);
    eq(rd.blockers.map((b) => [b.code, b.outcomeIds || null, (b.fields || []).map((f) => f.key)]), [['critical', ['RA1'], []], ['context_incomplete', null, ['sector']]], 'readiness con resultados y campos');
  });

  await check('AF7 caché de lecturas por petición: una lectura por consulta, copias independientes, escrituras invalidan, metadata en una sola lectura, nada fuera del ámbito', async () => {
    const C = loadDist('common/db/request-read-cache.js');
    C.resetRequestReadCacheTemplates();
    const log = [];
    let meta = { a: { x: 1 }, b: 'v' };
    const fake = { query: async (sql, params) => { log.push(sql); if (/^select metadata from/.test(sql)) return [{ metadata: JSON.parse(JSON.stringify(meta)) }]; if (/^update/.test(sql)) { meta = { a: { x: 2 }, b: 'v' }; return [[], 1]; } return [{ v: params && params[0], o: { n: 1 } }]; }, createQueryRunner() { return { query: async () => [], startTransaction: async () => {}, release: async () => {} }; } };
    await C.withRequestReadCache(fake, 't', { course: 7, owner: 'u' }, async () => {
      const r1 = await fake.query('select v from t where id = $1', [7]);
      r1[0].o.n = 99;
      const r2 = await fake.query('select v from t where id = $1', [7]);
      eq(r2[0].o.n, 1, 'copias independientes');
      eq(log.filter((q) => q.startsWith('select v')).length, 1, 'una lectura');
      const m1 = await fake.query("select metadata -> 'a' as aa, metadata -> 'z' as zz from public.courses where id = $1", [7]);
      const m2 = await fake.query("select metadata -> 'b' as bb from public.courses where id = $1", [7]);
      eq([m1, m2], [[{ aa: { x: 1 }, zz: null }], [{ bb: 'v' }]], 'proyección de metadata');
      eq(log.filter((q) => q.startsWith('select metadata')).length, 1, 'metadata en una lectura');
      await fake.query('update public.courses set metadata = $2 where id = $1', [7, '{}']);
      const m3 = await fake.query("select metadata -> 'a' as aa from public.courses where id = $1", [7]);
      eq(m3[0].aa, { x: 2 }, 'después de escribir se vuelve a leer');
      const qr = fake.createQueryRunner(); await qr.startTransaction(); await qr.release();
      const sv = () => log.filter((q) => q.startsWith('select v')).length;
      const n = sv(); await fake.query('select v from t where id = $1', [7]);
      eq(sv(), n + 1, 'un QueryRunner con transacción invalida al soltarse');
    });
    const n = log.length; await fake.query('select v from t where id = $1', [7]); await fake.query('select v from t where id = $1', [7]);
    eq(log.length, n + 2, 'fuera del ámbito no hay caché');
    // Lectura anticipada (fix r71 conexiones): la primera lectura de la segunda petición lleva consigo, en UN viaje y por
    // la MISMA conexión, lo que la primera petición leyó (curso / usuario). Nunca una conexión extra.
    {
      C.resetRequestReadCacheTemplates();
      const trips = []; let open = 0; let peak = 0; let failBatch = false;
      const run = async (text, params) => { await new Promise((r) => setTimeout(r, 5)); return { rows: [{ text, params: params || null }] }; };
      const fk = {
        query: async (sql, params) => { open++; peak = Math.max(peak, open); try { trips.push([sql]); return (await run(sql, params)).rows; } finally { open--; } },
        createQueryRunner() {
          return { connect: async () => { open++; peak = Math.max(peak, open); return { query: async (text) => { const parts = text.split('\n;\n'); trips.push(parts); if (failBatch) throw new Error('relation does not exist'); return parts.length > 1 ? Promise.all(parts.map((t) => run(t))) : run(text); } }; },
            release: async () => { open--; }, query: async () => [] };
        },
      };
      await C.withRequestReadCache(fk, 'pf', { course: 7, owner: 'u' }, async () => {
        await fk.query('select a from t where id = $1', [7]);
        await fk.query("select b from t where o = $1 and k = $2 and f = $3 and n = $4", ['u', "it's", true, null]);
        await fk.query('select d from t where id = $1 -- comentario al final', [7]);
        await fk.query('select c from t where x = $1', [{ no: 'objeto' }]); // depende de algo leído: no se anticipa
      });
      trips.length = 0; peak = 0;
      let got;
      await C.withRequestReadCache(fk, 'pf', { course: 8, owner: 'u' }, async () => {
        const a = await fk.query('select a from t where id = $1', [8]);
        const b = await fk.query("select b from t where o = $1 and k = $2 and f = $3 and n = $4", ['u', "it's", true, null]);
        got = [a[0].text, b[0].text];
      });
      eq(trips, [["select a from t where id = '8'", "select b from t where o = 'u' and k = 'it''s' and f = 'true' and n = NULL", "select d from t where id = '8' -- comentario al final"]], 'un viaje con las anticipadas (curso nuevo, literales escapados, comentario final sin tragarse el «;»)');
      eq(got, trips[0].slice(0, 2), 'cada lectura recibe su resultado');
      eq(peak, 1, 'una sola conexión a la vez');
      // El viaje combinado falla (p. ej. falta una tabla): el código no ve el error; cada lectura va sola, como sin caché.
      trips.length = 0; peak = 0; failBatch = true;
      await C.withRequestReadCache(fk, 'pf', { course: 9, owner: 'u' }, async () => {
        const a = await fk.query('select a from t where id = $1', [9]);
        eq(a[0].text, 'select a from t where id = $1', 'la lectura sola, con parámetros');
      });
      failBatch = false;
      eq(trips.length, 2, 'combinado (falló) + la lectura sola');
      eq(peak, 1, 'tampoco al fallar hay dos conexiones');
      eq(C.inlineParams("select 'a$1' x, \"c$1\" from t where id = $1 -- $2\n and y = $2::jsonb", [3, '{"k":1}']), "select 'a$1' x, \"c$1\" from t where id = '3' -- $2\n and y = '{\"k\":1}'::jsonb", 'reemplaza solo fuera de literales y comentarios');
      for (const bad of ['select $$x$$', "select E'\\n' where a = $1", 'select 1; select 2', 'select $2', 'select $1']) eq(C.inlineParams(bad, bad === 'select $1' ? [{}] : [1]), null, `no combina «${bad}»`);
      eq(C.inlineParams('select $1', ['a\\b']), "select  E'a\\\\b'", 'barra invertida como E-string');
    }
    eq(C.metadataProjection("select metadata -> 'designPins' as pins from public.courses where id = $1"), [['designPins', 'pins']], 'reconoce la proyección');
    eq(C.metadataProjection('select metadata, title from public.courses where id = $1'), null, 'otra consulta no');
  });

  if (PURE_ONLY) {
    console.log('\n(--pure-only: la parte DB NO corrió)');
  } else {
    await dbChecks(ctx1672);
  }
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

async function dbChecks(ctx1672) {
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
  const CF = loadDist('modules/prebrief/course-formats.js');
  Logger.overrideLogger(false);

  const pgBin = findPgBin();
  const port = Number(process.env.R71_PG_PORT) || await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r71-autofix-pg-'));
  const DB = 'r71autofix';
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
    process.env.DYNAMIC_PREBRIEF_REQUIRED_SINCE = '2026-01-01T00:00:00Z'; // como staging: los cursos nuevos van por la propuesta
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
    const prebrief = new PrebriefService(ds, coursesStub, design, blueprints, profiles);
    const structure = new CourseStructureService(ds.getRepository(CourseModule), ds.getRepository(CourseChapter), coursesStub, ds, blueprints);
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const counter = async (cid) => Number((await ds.query(`select structure_version_counter c from public.courses where id = $1`, [cid]))[0].c);
    const links = async (cid) => (await ds.query(`select ch.title, ch.outcome_ids from public.course_chapters ch join public.course_modules m on m.id = ch.module_id where ch.course_id = $1 order by m.position, ch.position`, [cid])).map((x) => [x.title, x.outcome_ids]);
    const brief = async (cid) => (await ds.query(`select metadata -> 'brief' -> 'fields' f from public.courses where id = $1`, [cid]))[0].f;
    const codes = (rd) => rd.blockers.map((b) => b.code + (b.ref ? ':' + b.ref : '') + (b.outcomeIds ? ':' + b.outcomeIds.join(',') : ''));
    const BRIEF = { nombre: 'Inglés Básico – Grado Sexto', pais: 'Colombia', contexto: 'Bachillerato — estudiantes de secundaria y media', nivel: 'Básico — sin conocimientos previos', tono: 'Conversacional y cercano, como un mentor con ejemplos cotidianos', inferidos: 'pais,tono' };

    // Réplica de #1672: pedido sin sector, contexto académico del PDF real, Formato L y la estructura capturada (con sus vínculos).
    const replica = async (title, briefFields = BRIEF) => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine, metadata) values ($1, $2, 'dynamic', true, 'h5p', $3::jsonb) returning id`,
        [OWNER, title, JSON.stringify({ brief: { briefVersion: 1, fields: briefFields, updatedAt: '2026-10-23T00:00:00.000Z' } })]);
      await profiles.append(c.id, OWNER, 'academic', ctx1672);
      const pv = await profiles.getCurrent(c.id, OWNER, 'pedagogy').catch(() => null);
      if (pv) await profiles.append(c.id, OWNER, 'pedagogy', { ...pv.profile, targetHours: 63 }, pv.version);
      await CF.writeCourseFormat(ds, c.id, { code: 'L', catalogVersion: CF.COURSE_FORMAT_CATALOG_VERSION, at: '2026-10-23T00:00:00.000Z', by: OWNER });
      const ids = new Map();
      for (const m of FX.modules) {
        const [mm] = await ds.query(`insert into public.course_modules (course_id, position, title, objective, description, exam_enabled) values ($1, $2, $3, $4, $5, $6) returning id`, [c.id, m.position, m.title, m.objective, m.description, m.examEnabled]);
        for (const ch of m.chapters) {
          const [cc] = await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, objective, description, video_enabled, activity_enabled, application_minutes, chapter_kind, outcome_ids) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) returning id`,
            [c.id, mm.id, ch.position, ch.title, ch.objective, ch.description, ch.videoEnabled, ch.activityEnabled, ch.applicationMinutes, ch.kind, ch.outcomeIds ? JSON.stringify(ch.outcomeIds) : null]);
          ids.set(ch.id, cc.id);
        }
      }
      return { id: c.id, ids };
    };
    // Lo que hace la interfaz al «Usar este diseño» (si el diseño trae cambios pendientes en la réplica).
    const useDesign = async (cid) => {
      const card = await design.recommend(cid, OWNER, {});
      if ((card.design.changes || []).length || card.profileChanged) {
        if (card.profileChanged) { const cur = await profiles.getCurrent(cid, OWNER, 'pedagogy'); await profiles.append(cid, OWNER, 'pedagogy', card.profile, cur.version); }
        const c2 = await design.recommend(cid, OWNER, {});
        await structure.applyDistribution(cid, OWNER, { expectedCounter: await counter(cid), proposalSha256: c2.design.proposalSha256 });
      }
      // Los datos dudosos del documento que el dueño ya confirmó en staging («Es correcto: confirmar»).
      for (const dd of (await prebrief.draft(cid, OWNER)).doubts) await prebrief.confirm(cid, OWNER, { id: OWNER }, dd.confirmKey);
    };
    const D = {};
    // Fixture del frontend (harness test-64): respuestas REALES de GET /prebrief y de design/fix (R71_FE_FIXTURE=ruta).
    const FE = {};
    const exportFe = () => { if (process.env.R71_FE_FIXTURE) fs.writeFileSync(process.env.R71_FE_FIXTURE, JSON.stringify(FE, null, 1) + '\n'); };

    await check('AD1 réplica de #1672: los MISMOS 3 bloqueos de staging; autofix los resuelve; «Preparar para aprobación» funciona', async () => {
      const c = await replica('[R71] Inglés Básico – Grado Sexto');
      await useDesign(c.id);
      const before = await prebrief.draft(c.id, OWNER);
      eq(codes(before.readiness), ['critical:alignment:AL001:RA1', 'critical:alignment:AL002:RA7', 'context_incomplete'], 'bloqueos (staging: ' + JSON.stringify(FX.readinessBefore.blockers.map((b) => b.title)) + ')');
      eq(before.readiness.blockers.map((b) => b.title), FX.readinessBefore.blockers.map((b) => b.title), 'mismos textos que staging');
      assert(before.readiness.autofixPending > 0, 'hay correcciones pendientes');
      eq(before.readiness.blockers[0].inline.chapterTitle, 'Profundización 1: Let’s Communicate!', 'acción en línea RA1');
      eq(before.readiness.blockers[2].fields.find((f) => f.key === 'sector').suggestion, 'Educación', 'sugerencia del sector');
      const c0 = await counter(c.id);
      const linksBefore = await links(c.id);
      FE.blocked = await prebrief.state(c.id, OWNER);
      const fx = await design.fix(c.id, OWNER, 'autofix', c0);
      FE.autofixResponse = fx;
      FE.optimized = await prebrief.state(c.id, OWNER);
      assert(fx.batchId && fx.applied.length === 20, 'aplicó 20 mejoras: ' + fx.applied.length);
      eq(fx.structureVersionCounter, c0 + 1, 'el contador sube una vez');
      const after = await prebrief.draft(c.id, OWNER);
      eq(codes(after.readiness), [], 'sin bloqueos: ' + JSON.stringify(after.readiness.blockers.map((b) => b.title)));
      eq([after.readiness.ready, after.readiness.autofixPending], [true, 0], 'lista');
      const l = new Map(await links(c.id));
      eq(l.get('Profundización 1: Let’s Communicate!'), ['RA1'], 'RA1');
      eq(l.get('Profundización 2: Let’s Communicate!'), ['RA7'], 'RA7');
      for (const [t, v] of linksBefore) if (v && v.length) eq(l.get(t), v, `vínculo del documento intacto: ${t}`);
      const b = await brief(c.id);
      eq([b.sector, b.inferidos.split(',').includes('sector')], ['Educación', true], 'sector inferido (editable)');
      const facts = await (loadDist('modules/course-facts/course-facts-db.js')).loadCourseFacts(ds, c.id);
      eq([facts.sector.value, facts.sector.source], ['Educación', 'inferred'], '«Lo que entendimos»: inferido');
      const card = await design.recommend(c.id, OWNER, {});
      eq(card.verification.counts.critical, 0, 'verificación sin críticos');
      eq(card.autofix.applied.length, 20, 'el resumen «Cursia optimizó tu curso» viene del servidor');
      assert(card.verification.counts.warning < 16, `menos advertencias que en staging (16): ${card.verification.counts.warning}`);
      const st = await prebrief.state(c.id, OWNER);
      const prep = await prebrief.prepare(c.id, OWNER, { id: OWNER, email: 'qa@example.test' }, st.draft.modelSha256);
      eq([prep.created, prep.version.status], [true, 'ready'], '«Preparar para aprobación» funciona');
      D.prepared = c.id;
    });

    await check('AD2 idempotente: otra vez → nada aplicado y el contador no sube', async () => {
      const c = await replica('[R71] Idempotente');
      await useDesign(c.id);
      const c0 = await counter(c.id);
      const a = await design.fix(c.id, OWNER, 'autofix', c0);
      const c1 = await counter(c.id);
      const l1 = await links(c.id);
      const b = await design.fix(c.id, OWNER, 'autofix', c1);
      eq([b.applied.length, b.batchId, b.structureVersionCounter, await counter(c.id)], [0, null, c1, c1], 'nada');
      eq(await links(c.id), l1, 'mismos vínculos');
      assert(a.applied.length > 0, 'la primera sí');
      D.idem = c.id;
    });

    await check('AD3 deshacer RA1: vuelve el bloqueo con «Vincular a…»; autofix no lo re-aplica; el docente vincula en línea → lista', async () => {
      const cid = D.idem;
      const u = await design.fix(cid, OWNER, 'autofix_undo', await counter(cid), { changeIds: ['cover:RA1'] });
      eq([u.reverted, u.changed], [['cover:RA1'], []], 'deshecho');
      eq(new Map(await links(cid)).get('Profundización 1: Let’s Communicate!'), null, 'vuelve a sin vínculos');
      const d1 = await prebrief.draft(cid, OWNER);
      eq(codes(d1.readiness), ['critical:alignment:AL001:RA1'], 'vuelve el bloqueo (solo ese)');
      const inl = d1.readiness.blockers[0].inline;
      eq([inl.kind, inl.outcomeId, inl.chapterTitle], ['link_outcome', 'RA1', 'Profundización 1: Let’s Communicate!'], 'acción en línea');
      eq(d1.readiness.autofixPending, 0, 'lo deshecho no queda «pendiente»');
      const again = await design.fix(cid, OWNER, 'autofix', await counter(cid));
      eq(again.applied, [], 'autofix NO re-aplica lo deshecho');
      assert(again.proposals.some((p) => p.id === 'cover:RA1'), 'queda como propuesta');
      const lk = await design.fix(cid, OWNER, 'link_outcome', await counter(cid), { outcomeId: 'RA1', chapterId: inl.chapterId });
      eq([lk.linked, lk.outcomeIds], [true, ['RA1']], 'vinculado por el docente');
      const d2 = await prebrief.draft(cid, OWNER);
      eq([d2.readiness.ready, codes(d2.readiness)], [true, []], 'lista');
      await rejects(design.fix(cid, OWNER, 'link_outcome', await counter(cid), { outcomeId: 'RA99', chapterId: inl.chapterId }), /UNKNOWN_OUTCOME/, 'resultado desconocido');
    });

    await check('AD4 deshacer todo restaura los vínculos y el pedido originales', async () => {
      const c = await replica('[R71] Deshacer todo');
      await useDesign(c.id);
      const l0 = await links(c.id);
      const b0 = await brief(c.id);
      const c0 = await counter(c.id);
      await design.fix(c.id, OWNER, 'autofix', c0);
      const c1 = await counter(c.id);
      const u = await design.fix(c.id, OWNER, 'autofix_undo', c1);
      eq([u.reverted.length, u.changed.length, u.structureVersionCounter], [20, 0, c1 + 1], 'todo deshecho, una subida del contador');
      eq(await links(c.id), l0, 'vínculos originales');
      eq(await brief(c.id), b0, 'pedido original (sin sector)');
      const d = await prebrief.draft(c.id, OWNER);
      FE.undoneAll = await prebrief.state(c.id, OWNER);
      FE.undoResponse = u;
      exportFe();
      eq(codes(d.readiness), ['critical:alignment:AL001:RA1', 'critical:alignment:AL002:RA7', 'context_incomplete'], 'los bloqueos vuelven, cada uno con su acción en línea');
      assert(d.readiness.blockers.every((b) => b.inline || b.fields), 'acción en línea en cada bloqueo');
      const card = await design.recommend(c.id, OWNER, {});
      eq([card.autofix.pending, card.autofix.applied.length], [0, 0], 'nada pendiente ni aplicado (lo deshecho es decisión del docente): ' + JSON.stringify(card.autofix.changes.map((x) => x.id + ' ' + x.title)));
    });

    await check('AD5 lo del docente manda: sector escrito no se pisa; dato completado en línea queda como del docente', async () => {
      const c = await replica('[R71] Sector del docente', { ...BRIEF, sector: 'Idiomas' });
      await useDesign(c.id);
      const fx = await design.fix(c.id, OWNER, 'autofix', await counter(c.id));
      assert(!fx.applied.some((x) => x.kind === 'context_field'), 'no infiere sobre lo escrito');
      eq((await brief(c.id)).sector, 'Idiomas', 'sector del docente');
      const c2 = await replica('[R71] Sector en línea');
      await useDesign(c2.id);
      await design.fix(c2.id, OWNER, 'autofix', await counter(c2.id));
      const s = await design.fix(c2.id, OWNER, 'context_field', await counter(c2.id), { field: 'sector', value: '  Educación básica  ' });
      eq(s.value, 'Educación básica', 'normalizado');
      const b = await brief(c2.id);
      eq([b.sector, (b.inferidos || '').split(',').includes('sector')], ['Educación básica', false], 'del docente (no inferido)');
      const card = await design.recommend(c2.id, OWNER, {});
      assert(!card.autofix.applied.some((x) => x.id === 'context:sector'), 'el sector inferido ya no se puede «deshacer» (lo reemplazó el docente)');
      const u = await design.fix(c2.id, OWNER, 'autofix_undo', await counter(c2.id), { changeIds: ['context:sector'] });
      eq((await brief(c2.id)).sector, 'Educación básica', 'deshacer no borra lo del docente');
      eq(u.reverted, [], 'nada');
      await rejects(design.fix(c2.id, OWNER, 'context_field', await counter(c2.id), { field: 'nombre', value: 'x' }), /Dato desconocido/, 'solo datos que se completan en línea');
      // El docente borra en «Lo que entendimos» el sector que infirió Cursia: no se vuelve a inferir solo (queda la sugerencia en línea).
      const c3 = await replica('[R71] Sector borrado');
      await useDesign(c3.id);
      await design.fix(c3.id, OWNER, 'autofix', await counter(c3.id));
      const f3 = await brief(c3.id);
      delete f3.sector; f3.inferidos = 'pais,tono';
      await ds.query(`update public.courses set metadata = jsonb_set(metadata, '{brief,fields}', $2::jsonb) where id = $1`, [c3.id, JSON.stringify(f3)]);
      const again = await design.fix(c3.id, OWNER, 'autofix', await counter(c3.id));
      eq(again.applied.map((x) => x.id), [], 'no se re-infiere lo que el docente borró');
      const d3 = await prebrief.draft(c3.id, OWNER);
      eq(d3.readiness.blockers.map((b) => [b.code, (b.fields || []).map((f) => [f.key, f.suggestion])]), [['context_incomplete', [['sector', 'Educación']]]], 'bloqueo con el campo y la sugerencia');
      // Y un vínculo que el docente cambió en el editor tampoco se vuelve a tocar.
      const [p1] = await ds.query(`select id from public.course_chapters where course_id = $1 and title = 'Profundización 1: Let’s Communicate!'`, [c3.id]);
      await ds.query(`update public.course_chapters set outcome_ids = '["RA5"]'::jsonb where id = $1`, [p1.id]);
      const again2 = await design.fix(c3.id, OWNER, 'autofix', await counter(c3.id));
      eq(again2.applied.map((x) => x.id), [], 'lo cambiado por el docente se respeta');
      eq(new Map(await links(c3.id)).get('Profundización 1: Let’s Communicate!'), ['RA5'], 'vínculo del docente intacto');
    });

    await check('AD7 rendimiento: con 150 ms por consulta (base remota), GET /prebrief de la réplica de #1672 < 1,5 s y «Preparar» rápido', async () => {
      const c = await replica('[R71] Rendimiento');
      await useDesign(c.id);
      await design.fix(c.id, OWNER, 'autofix', await counter(c.id));
      await prebrief.state(c.id, OWNER); // calienta (require, JIT)
      const prof = new Map();
      const wrap = (obj, name, label) => { const orig = obj[name]; obj[name] = async function (...a) { const t = Date.now(); try { return await orig.apply(this, a); } finally { const e = prof.get(label) || { n: 0, ms: 0 }; e.n++; e.ms += Date.now() - t; prof.set(label, e); } }; return () => { obj[name] = orig; }; };
      const undo = [
        wrap(Object.getPrototypeOf(design), 'recommend', 'design.recommend'),
        wrap(Object.getPrototypeOf(pedagogy), 'dryRunCourse', 'pedagogy.dryRunCourse'),
        wrap(Object.getPrototypeOf(design), 'autofixPreview', 'design.autofixPreview'),
        wrap(ds, 'query', 'db.query'),
      ];
      // Todas las consultas que llegan al driver (DataSource, QueryRunner, repositorios), con su texto (para el perfil).
      const PgClient = require('pg').Client;
      const origQ = PgClient.prototype.query;
      const sqls = [];
      const lat = Number(process.env.R71_DB_LATENCY_MS || 150); // latencia simulada por consulta (pooler remoto de Supabase)
      PgClient.prototype.query = function (q, ...rest) {
        const text = typeof q === 'string' ? q : q && q.text;
        sqls.push(String(Date.now() - (globalThis.__r71t0 || 0)).padStart(5) + ' ' + String(text || '').replace(/\s+/g, ' ').slice(0, 100));
        if (!lat) return origQ.call(this, q, ...rest);
        const self = this;
        return new Promise((r) => setTimeout(r, lat)).then(() => origQ.call(self, q, ...rest));
      };
      undo.push(() => { PgClient.prototype.query = origQ; });
      const t0 = Date.now(); globalThis.__r71t0 = t0;
      const st = await prebrief.state(c.id, OWNER);
      const ms = Date.now() - t0;
      const nState = sqls.length;
      const t1 = Date.now(); globalThis.__r71t0 = t1;
      const prep = await prebrief.prepare(c.id, OWNER, { id: OWNER }, st.draft.modelSha256);
      const msPrep = Date.now() - t1;
      undo.forEach((u) => u());
      eq(prep.version.status, 'ready', 'preparada');
      console.log(`   POST /prebrief/versions: ${msPrep} ms · consultas: ${sqls.length - nState}`);
      if (process.env.R71_PROFILE === '2') console.log(sqls.slice(nState).map((q) => `     ${q}`).join('\n'));
      console.log(`   GET /prebrief: ${ms} ms (latencia simulada ${lat} ms/consulta) · consultas al driver: ${nState} · ` + [...prof].map(([k, v]) => `${k} ×${v.n} ${v.ms} ms`).join(' · '));
      if (process.env.R71_PROFILE) console.log(sqls.slice(0, nState).map((q) => `     ${q}`).join('\n'));
      if (process.env.CURSIA_READ_CACHE !== 'off') assert(ms < 1500, `GET /prebrief tardó ${ms} ms (objetivo < 1500)`);
      if (process.env.CURSIA_READ_CACHE !== 'off') assert(msPrep < 7000, `POST /prebrief/versions tardó ${msPrep} ms (objetivo < 7000: dos verificaciones + congelar el Blueprint + la versión, en transacción)`);
    });

    await check('AD8 conexiones: con el caché, GET /prebrief usa a lo sumo las conexiones simultáneas de sin caché (1); /prebrief + /modules concurrentes con pool de producción (5) y un tope de clientes chico → 0 errores', async () => {
      // Incidente r71 en producción: GET /prebrief concurrente con GET /modules → 500 en 1–2,6 s. La lectura anticipada
      // abría hasta 3 conexiones EXTRA por petición; con pool 5 por proceso, el pooler de Supabase en modo sesión rechaza
      // de inmediato los clientes de más (EMAXCONNSESSION). Aquí: un rol con CONNECTION LIMIT chico hace de pooler (rechaza
      // al instante, código 53300) y el DataSource usa el pool por defecto de producción (sin PROD_DB_POOL_MAX → 5).
      const c = await replica('[R71] Conexiones');
      await useDesign(c.id);
      await design.fix(c.id, OWNER, 'autofix', await counter(c.id));
      const LIMIT = Number(process.env.R71_CONN_LIMIT || 3); // 2 peticiones concurrentes (1 conexión c/u) + 1 de margen
      await ds.query(`drop role if exists r71lim`);
      await ds.query(`create role r71lim login bypassrls connection limit ${LIMIT}`);
      for (const sch of (await ds.query(`select nspname from pg_namespace where nspname not like 'pg\\_%' and nspname <> 'information_schema'`)).map((r) => r.nspname)) {
        await ds.query(`grant usage on schema "${sch}" to r71lim`);
        await ds.query(`grant select, insert, update, delete on all tables in schema "${sch}" to r71lim`);
        await ds.query(`grant usage, select on all sequences in schema "${sch}" to r71lim`);
        await ds.query(`grant execute on all functions in schema "${sch}" to r71lim`);
      }
      const { dbPoolConfig } = loadDist('database/db-pool-config.js');
      const poolMax = dbPoolConfig({}, '/srv/dist/main.js').max;
      eq(poolMax, 5, 'pool por defecto de producción');
      const ds2 = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'r71lim', database: DB, entities: [CourseModule, CourseChapter], synchronize: false,
        extra: { max: poolMax, min: 0, idleTimeoutMillis: 20000, connectionTimeoutMillis: 10000 } });
      await ds2.initialize();
      const PgClient = require('pg').Client;
      const origQ = PgClient.prototype.query;
      const prevCache = process.env.CURSIA_READ_CACHE;
      try {
        const stub2 = { async findOne(id, ownerId) {
          const [row] = await ds2.query(`select id, title, structure_version, structure_version_counter from public.courses where id = $1 and owner_id = $2`, [id, ownerId]);
          if (!row) throw new NotFoundException(`Course #${id} not found`);
          return { id: row.id, title: row.title, structureVersion: row.structure_version, structureVersionCounter: row.structure_version_counter };
        } };
        const profiles2 = new CourseProfilesService(ds2, stub2);
        const blueprints2 = new CourseBlueprintsService(ds2);
        const pedagogy2 = new PedagogyService(ds2, stub2);
        const design2 = new CourseDesignService(ds2, stub2, pedagogy2);
        const prebrief2 = new PrebriefService(ds2, stub2, design2, blueprints2, profiles2);
        const structure2 = new CourseStructureService(ds2.getRepository(CourseModule), ds2.getRepository(CourseChapter), stub2, ds2, blueprints2);
        // Conexiones del pool en uso a la vez (checkout → release).
        const pool = ds2.driver.master;
        let out = 0; let peak = 0;
        pool.on('acquire', () => { out++; if (out > peak) peak = out; });
        pool.on('release', () => { out--; });
        const lat = Number(process.env.R71_DB_LATENCY_MS || 150);
        PgClient.prototype.query = function (q, ...rest) { const self = this; return new Promise((r) => setTimeout(r, lat)).then(() => origQ.call(self, q, ...rest)); };
        const settle = () => new Promise((r) => setTimeout(r, lat * 4)); // nada en vuelo de una petición anterior
        const alone = async (fn) => { await settle(); peak = out; const t = Date.now(); let err = null; let res = null; try { res = await fn(); } catch (e) { err = e; } const ms = Date.now() - t; const p = peak; await settle(); return { ms, peak: Math.max(p, peak), err, res }; };
        await alone(() => prebrief2.state(c.id, OWNER)); // aprende las lecturas de la petición
        process.env.CURSIA_READ_CACHE = 'off';
        const off = await alone(() => prebrief2.state(c.id, OWNER));
        if (prevCache === undefined) delete process.env.CURSIA_READ_CACHE; else process.env.CURSIA_READ_CACHE = prevCache;
        const on = await alone(() => prebrief2.state(c.id, OWNER));
        console.log(`   conexiones simultáneas máx. por GET /prebrief: sin caché ${off.peak} (${off.ms} ms) · con caché ${on.peak} (${on.ms} ms${on.err ? ' · ERROR ' + String(on.err.message).slice(0, 80) : ''})`);
        // Lo que hace «Paso 5 · Propuesta» al abrir: GET /prebrief y GET /modules a la vez, varias veces.
        const errs = [];
        let pairPeak = 0;
        for (let i = 0; i < 6; i++) {
          await settle(); peak = out;
          const rs = await Promise.allSettled([prebrief2.state(c.id, OWNER), structure2.getStructure(c.id, OWNER)]);
          pairPeak = Math.max(pairPeak, peak);
          rs.forEach((r, k) => { if (r.status === 'rejected') errs.push(`${i}:${k ? 'modules' : 'prebrief'}: ${String(r.reason && r.reason.message).slice(0, 90)}`); });
        }
        console.log(`   /prebrief + /modules ×6 (tope ${LIMIT} clientes, pool ${poolMax}): ${12 - errs.length}/12 OK · conexiones simultáneas máx. ${pairPeak}`);
        assert(!off.err, 'sin caché falló: ' + (off.err && off.err.message));
        assert(!on.err, 'con caché falló: ' + (on.err && on.err.message));
        assert(on.peak <= off.peak, `con caché usa ${on.peak} conexiones simultáneas; sin caché ${off.peak}`);
        assert(on.peak <= 1, `con caché usa ${on.peak} conexiones simultáneas (objetivo 1)`);
        eq(on.res, off.res, 'con caché (lectura combinada) la respuesta es idéntica a sin caché');
        // Una anticipada que ya no funciona (tabla borrada) no rompe la petición: la lectura va sola y se re-aprende.
        const { withRequestReadCache } = loadDist('common/db/request-read-cache.js');
        await ds.query(`create table if not exists public.r71_tmp (course_id int, v text)`);
        await ds.query(`grant select on public.r71_tmp to r71lim`);
        const readCourse = () => ds2.query(`select id from public.courses where id = $1`, [c.id]);
        await withRequestReadCache(ds2, 'r71.tmp', { course: c.id, owner: OWNER }, async () => [await readCourse(), await ds2.query(`select v from public.r71_tmp where course_id = $1`, [c.id])]);
        await ds.query(`drop table public.r71_tmp`);
        await settle(); peak = out;
        const first = await withRequestReadCache(ds2, 'r71.tmp', { course: c.id, owner: OWNER }, readCourse).catch((e) => e);
        assert(Array.isArray(first) && first[0] && first[0].id === c.id, 'la lectura del curso no debe fallar por una anticipada rota: ' + (first && first.message));
        assert(peak <= 1, `fallback con ${peak} conexiones`);
        eq(errs, [], 'errores con /prebrief + /modules concurrentes');
        assert(pairPeak <= 2, `el par usa ${pairPeak} conexiones (objetivo 2: una por petición)`);
      } finally {
        PgClient.prototype.query = origQ;
        if (prevCache === undefined) delete process.env.CURSIA_READ_CACHE; else process.env.CURSIA_READ_CACHE = prevCache;
        await ds2.destroy().catch(() => {});
      }
    });

    await check('AD6 contador viejo → 409; propuesta preparada → no se cambia sola', async () => {
      const c = await replica('[R71] Contador');
      await useDesign(c.id);
      await rejects(design.fix(c.id, OWNER, 'autofix', (await counter(c.id)) + 7), /STRUCTURE_CHANGED/, 'contador viejo');
      const cid = D.prepared;
      const l = await links(cid);
      const fx = await design.fix(cid, OWNER, 'autofix', await counter(cid));
      eq([fx.skipped, fx.applied.length], ['PREBRIEF_FROZEN', 0], 'no toca una propuesta lista');
      eq(await links(cid), l, 'sin cambios');
    });
  } finally {
    if (ds) await ds.destroy().catch(() => {});
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function rejects(p, re, m) {
  try { await p; } catch (err) {
    const body = err && err.getResponse ? err.getResponse() : null;
    const text = [err && err.message, body && (typeof body === 'string' ? body : body.message || body.code)].filter(Boolean).join(' | ');
    if (!re.test(text)) throw new Error(`${m}: error inesperado «${text}»`);
    return;
  }
  throw new Error(`${m}: no falló`);
}
