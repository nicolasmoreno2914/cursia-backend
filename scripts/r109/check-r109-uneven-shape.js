#!/usr/bin/env node
/* eslint-disable no-console */
// r109 M3b · estructura DESIGUAL desde el documento (p. ej. 4 / 5 / 4 / 4 capítulos por módulo) en vez de forzar N × M.
// Sin red, sin base y sin proveedores (USD 0): todo sobre funciones puras de dist/.
//
//   US1  forma del documento: los contenidos de cada unidad, sin agrupar en el tope de 5 (4/5/4/4 y 4/7/4/5)
//   US2  «Como el documento» (documentRecommendation, aparte de `recommended`): un capítulo por contenido, razón real; solo
//        si cumple TODOS los requisitos de módulos, capítulos por módulo (exacto / mínimo / máximo / rango) y estructura;
//        pareja 7/7/7 también; una unidad > 30 contenidos no se ofrece y se explica; sin contenidos por unidad, no se ofrece
//   US2b compatibilidad: la respuesta de structure-options para un cliente anterior (sin los campos nuevos) es IDÉNTICA a la
//        de origin/staging, también en documentos desiguales (huellas en el golden)
//   US3  la propuesta con esa forma: exactamente esos capítulos por módulo, en orden, sin omitir ni duplicar; cada unidad
//        es su módulo; trazabilidad (sourceContentIds) y cobertura de resultados iguales a la estructura del documento
//   US4  forma de entrada: normalizeShape / isValidShape (topes SHAPE_INPUT_MAX), DTO de preview y de aplicar
//   US5  vista previa y diferencias con el documento: «4 módulos (4, 7, 4, 5 capítulos)», requisito desigual exigido
//   US6  horas (distribuidor), costo estimado, ajuste al presupuesto (su texto «Hasta N…» dice qué módulos conservan más) y
//        verificación con la estructura desigual aplicada
//   US7  forma desigual que no sigue a las unidades (otra cantidad de módulos): reparto proporcional, sin pérdidas
//   US8  sin regresión: las formas N × M dan lo mismo que origin/staging (huellas en scripts/fixtures/r109/nxm-golden.json,
//        o en vivo con --base <dist de origin/staging>); sin documento / sin unidades: como hoy
//   US9  (--db) Postgres 16 local: options → preview → aplicar con variant «document» / «cursia» → vuelve preseleccionada
//
// Qué cambia A PROPÓSITO frente a origin/staging (y nada más): campos NUEVOS en structure-options (documentRecommendation,
// documentRecommendationNote, document.contentShape, current.variant), `label` en la vista previa de una forma desigual, y
// la entrada moduleChapters / variant. `recommended` y todo lo N × M quedan idénticos. El resultado esperado nuevo de los
// documentos de prueba está en el golden («intentional»), escrito a mano en EXPECTED_DOC_RECOMMENDATIONS.
//
// Uso: npm run build && node scripts/r109/check-r109-uneven-shape.js --ci [--dist dist] [--base <dist-base>]
//      node scripts/r109/check-r109-uneven-shape.js --bite          (cada mordida tiene que hacer fallar --ci)
//      node scripts/r109/check-r109-uneven-shape.js --write-golden --base <dist de origin/staging>
'use strict';
require('reflect-metadata');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DIST = path.resolve(arg('--dist', path.join(REPO, 'dist')));
const BASE = arg('--base', null) ? path.resolve(arg('--base')) : null;
const GOLDEN = path.join(REPO, 'scripts/fixtures/r109/nxm-golden.json');

if (process.argv.includes('--bite')) {
  const bites = [
    { name: 'splitEven en la forma del documento (todos los módulos con M capítulos)', file: 'modules/academic-context/context-design.js', from: 'splitEven(group, counts[mi])', to: 'splitEven(group, M)' },
    { name: 'la forma del documento no sigue a sus unidades', file: 'modules/academic-context/context-design.js', from: 'const byUnit = uneven && counts.length === units.length;', to: 'const byUnit = false;' },
    { name: '«Como el documento» ignora los requisitos (máximo / rango)', file: 'modules/course-design/structure-options.js', from: 'if (diffs.length)', to: 'if (false)' },
    { name: '«Como el documento» no se ofrece', file: 'modules/course-design/course-design.service.js', from: 'documentRecommendation: docRec.documentRecommendation,', to: 'documentRecommendation: null,' },
    { name: 'recommended cambia para el cliente anterior (P1-2)', file: 'modules/course-design/course-design.service.js', from: 'recommended: (0, structure_options_1.recommendShape)(auth.required, docShape, hours),', to: 'recommended: docRec.documentRecommendation || (0, structure_options_1.recommendShape)(auth.required, docShape, hours),' },
    { name: 'la forma del documento agrupada en el tope de 5', file: 'modules/academic-context/context-design.js', from: 'units.map((u) => u.contents.length)', to: 'units.map((u) => Math.min(5, u.contents.length))' },
    { name: 'N × M con otras notas (regresión)', file: 'modules/academic-context/context-design.js', from: 'const label = shapeLabel(shape);', to: 'const label = `${N} módulos`;' },
    { name: 'el preview ignora la forma desigual', file: 'modules/course-design/course-design.service.js', from: 'const shape = (0, context_design_1.normalizeShape)(input);', alt: 'const shape = normalizeShape(input);', to: 'const shape = (0, context_design_1.normalizeShape)({ modules: input.modules, chaptersPerModule: input.chaptersPerModule });' },
    { name: 'el texto del presupuesto promete «hasta N» en todos los módulos', file: 'modules/course-design/budget-fit.js', from: 'const over = s.contentByModule.map((n, i) => ({ n, i })).filter((x) => x.n > cap);', to: 'const over = [];' },
  ];
  const tmp = fs.mkdtempSync(path.join(REPO, '.r109-bite-'));
  let code = 0;
  try {
    for (const b of bites) {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(DIST, tmp, { recursive: true });
      const f = path.join(tmp, b.file);
      const src = fs.readFileSync(f, 'utf8');
      const cands = [b.from, b.alt].filter(Boolean).flatMap((x) => [x, x.replace(/'/g, '"')]);
      const from = cands.find((x) => src.includes(x));
      if (!from) { console.log(`❌ mordida «${b.name}»: no encontré el código`); code = 1; continue; }
      fs.writeFileSync(f, src.split(from).join(b.to));
      const r = spawnSync(process.execPath, [__filename, '--ci', '--dist', tmp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const bit = r.status !== 0 && /❌/.test(r.stdout || '');
      console.log(bit ? `✅ mordida «${b.name}»: el check FALLA (${((r.stdout || '').match(/❌ [^\n]*/g) || []).slice(0, 2).join(' · ').slice(0, 220)})` : `❌ mordida «${b.name}»: NO hizo fallar el check`);
      if (!bit) code = 1;
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(code);
}

// ── Red bloqueada (USD 0) ──
const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  const net = require('net'); net.connect = deny('net.connect'); net.createConnection = deny('net.createConnection');
  const tls = require('tls'); tls.connect = deny('tls.connect');
  globalThis.fetch = deny('fetch');
}
const { Logger } = require('@nestjs/common');
Logger.overrideLogger(false);

let ok = 0; let fail = 0;
async function check(name, fn) { try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n   ')}`); } }
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const loader = (root) => (rel) => { try { return require(path.join(root, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} de ${root} (¿npm run build?): ${e.message}`); process.exit(1); } };
const L = loader(DIST);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── Fixtures ──
// Contexto sintético con la forma del A1-A2 (licencia de conducción A1-A2): 4 unidades con contenidos desiguales. Se
// arma sobre un contexto real extraído (el de «Contabilidad de Costos»: mismos campos y validación) cambiando unidades,
// resultados y competencias.
const A1A2_UNITS = [
  { title: 'Movilidad segura y actores viales', ra: ['RA1'], contents: ['Actores de la vía y su vulnerabilidad', 'Factores de riesgo en la conducción de motocicletas', 'Percepción del riesgo y conducción defensiva', 'Elementos de protección personal del motociclista', 'Fatiga, alcohol y distracciones al conducir', 'Comportamiento del conductor en la vía', 'Velocidad y distancia de frenado'] },
  { title: 'Normas de tránsito', ra: ['RA2'], contents: ['Código Nacional de Tránsito: estructura y conceptos', 'Señales de tránsito verticales', 'Señales horizontales y demarcación', 'Prelación y derecho de vía', 'Adelantamiento, giros y cambios de carril', 'Infracciones y sanciones', 'Documentos del conductor y del vehículo'] },
  { title: 'El vehículo: motocicleta', ra: ['RA3'], contents: ['Partes de la motocicleta', 'Revisión preoperacional', 'Sistema de frenos y llantas', 'Sistema eléctrico y luces', 'Mantenimiento preventivo básico'] },
  { title: 'Primeros auxilios en la vía', ra: ['RA4'], contents: ['Actuación ante un siniestro vial', 'Valoración inicial del lesionado', 'Control de hemorragias e inmovilización', 'Activación de la cadena de socorro', 'Reanimación básica'] },
];
const A1A2_RA = [
  'RA1. Identificar los factores de riesgo de la movilidad en motocicleta y aplicar la conducción defensiva.',
  'RA2. Aplicar las normas de tránsito y las señales en la conducción de la motocicleta.',
  'RA3. Realizar la revisión preoperacional y el mantenimiento básico de la motocicleta.',
  'RA4. Actuar ante un siniestro vial con los primeros auxilios básicos.',
];
function ctxWith(base, counts) {
  const c = clone(base);
  c.outcomes = A1A2_RA.map((t, i) => ({ ...clone(base.outcomes[0]), id: `RA${i + 1}`, text: t.replace(/^RA\d\.\s*/, '') }));
  c.competencies = [{ ...clone(base.competencies[0]), text: 'Conduce motocicletas de forma segura y responsable en la vía pública.' }];
  const keep = new Set(c.outcomes.map((o) => o.id).concat(c.competencies.map((x) => x.id)));
  c.evaluation = c.evaluation.map((e) => ({ ...e, outcomeIds: (e.outcomeIds || []).filter((id) => keep.has(id)) }));
  const src0 = clone(base.units[0].contents[0]);
  c.units = A1A2_UNITS.slice(0, counts.length).map((u, i) => ({
    ...clone(base.units[0]), id: `U${i + 1}`, title: u.title, hours: null, outcomeIds: u.ra,
    contents: Array.from({ length: counts[i] }, (_, j) => ({ ...src0, id: `U${i + 1}.${j + 1}`, text: u.contents[j] || `${u.title}: tema ${j + 1}`, outcomeIds: [] })),
  }));
  return c;
}
const allIds = (ctx) => ctx.units.filter((u) => u.contents.length).flatMap((u) => u.contents.map((x) => x.id));
const assignedIds = (p) => p.modules.flatMap((m) => m.chapters.flatMap((ch) => ch.sourceContentIds));

async function contexts(root) {
  const E = loader(root)('modules/academic-context/extract/extractor.js');
  const AF = require(path.join(REPO, 'scripts/lib/academic-fixtures.js'));
  const ctxOf = async (name, data) => (await E.extractAcademicContext([{ name, data }])).context;
  const costos = await ctxOf('c.docx', await AF.fixture('consistent', 'docx'));
  const pilot = await ctxOf('p.docx', fs.readFileSync(path.join(REPO, 'scripts/fixtures/microcurriculum/atencion-violencia-sexual-2x2.docx')));
  return { costos, pilot, a1a2: ctxWith(costos, [4, 5, 4, 4]), a1a2b: ctxWith(costos, [4, 7, 4, 5]), even777: ctxWith(costos, [7, 7, 7]), big31: ctxWith(costos, [4, 31, 4, 4]) };
}

/**
 * structure-options con el servicio REAL y lecturas simuladas (el contexto guardado; sin requisitos, formato ni origen).
 * `legacy`: la respuesta que ve un cliente anterior (sin los campos que agrega r109 M3b).
 */
async function optionsOf(root, ctx) {
  const R = loader(root);
  const FEAT = R('modules/features/dynamic-features.js');
  const AC = R('modules/academic-context/academic-context.js');
  const SVC = R('modules/course-design/course-design.service.js');
  process.env[FEAT.DYNAMIC_FLAG_ENV] = 'true';
  process.env[FEAT.GENERAL_AVAILABILITY_ENV] = 'true';
  const stored = AC.normalizeAcademicContext(clone(ctx));
  const svc = Object.create(SVC.CourseDesignService.prototype);
  svc.loadCourse = async () => {};
  svc.dataSource = { query: async (sql) => (/from public\.course_profiles/.test(sql) && /'academic'/.test(sql) ? [{ id: 1, version: 3, data: stored, sha256: AC.academicContextSha256(stored) }] : []) };
  return svc.structureOptions(1, 'owner');
}
function legacyView(o) {
  const x = clone(o);
  delete x.documentRecommendation;
  delete x.documentRecommendationNote;
  if (x.document) delete x.document.contentShape;
  if (x.current) delete x.current.variant;
  return x;
}
async function legacyCases(root, ctxs) {
  const out = {};
  for (const [cn, ctx] of Object.entries(ctxs)) out[`options:${cn}`] = sha(legacyView(await optionsOf(root, ctx)));
  return out;
}

/** Resultado esperado NUEVO (a propósito) de «Como el documento» en los documentos de prueba. */
const EXPECTED_DOC_RECOMMENDATIONS = {
  a1a2: { documentRecommendation: { modules: 4, chaptersPerModule: 5, moduleChapters: [4, 5, 4, 4], reason: 'Como el documento: 4 unidades con 4 / 5 / 4 / 4 contenidos. Cada unidad es un módulo y cada uno de sus 17 contenidos, un capítulo, en el orden del documento.' }, note: null },
  a1a2b: { documentRecommendation: { modules: 4, chaptersPerModule: 7, moduleChapters: [4, 7, 4, 5], reason: 'Como el documento: 4 unidades con 4 / 7 / 4 / 5 contenidos. Cada unidad es un módulo y cada uno de sus 20 contenidos, un capítulo, en el orden del documento.' }, note: null },
  even777: { documentRecommendation: { modules: 3, chaptersPerModule: 7, moduleChapters: [7, 7, 7], reason: 'Como el documento: 3 unidades con 7 / 7 / 7 contenidos. Cada unidad es un módulo y cada uno de sus 21 contenidos, un capítulo, en el orden del documento.' }, note: null },
  big31: { documentRecommendation: null, note: '«Como el documento» no está disponible: la unidad U2 trae 31 contenidos y un módulo admite hasta 30 capítulos.' },
  costos: { documentRecommendation: { modules: 5, chaptersPerModule: 4, moduleChapters: [4, 4, 4, 3, 3], reason: 'Como el documento: 5 unidades con 4 / 4 / 4 / 3 / 3 contenidos. Cada unidad es un módulo y cada uno de sus 18 contenidos, un capítulo, en el orden del documento.' }, note: null },
};

/** Huellas N × M (las mismas funciones en dist y en origin/staging): propuesta, vista previa, diferencias, recomendación. */
const NXM_SHAPES = [[1, 1], [1, 4], [2, 2], [2, 3], [3, 3], [3, 4], [4, 1], [4, 4], [4, 5], [5, 3], [2, 9], [6, 2]];
function nxmCases(root, ctxs) {
  const R = loader(root);
  const CD = R('modules/academic-context/context-design.js');
  const SO = R('modules/course-design/structure-options.js');
  const CC = R('modules/academic-context/content-coverage.js');
  const X = R('modules/academic-context/requirements/requirements-extractor.js');
  const T = R('modules/academic-context/extract/text-sources.js');
  const reqsOf = (txt) => X.requirementsFor(X.extractRequirements(T.readText(Buffer.from(txt), 'text/plain').lines), {}).filter((r) => r.obligation === 'required' && r.confidence === 'high');
  const REQS = {
    none: [],
    mods4x4: reqsOf('El curso tendrá exactamente 4 módulos. Cada módulo tendrá exactamente 4 capítulos de contenido.'),
    mods5: reqsOf('El curso tendrá exactamente 5 módulos.'),
    hours30: reqsOf('Asignatura: Excel\nEl curso tendrá al menos 30 horas de trabajo del estudiante.'),
  };
  // La vista previa de origin/staging (course-design.service structurePreview), sin base: los mismos campos y en orden.
  const previewOld = (ctx, req, shape, code) => {
    const differences = SO.shapeDifferences(req, shape, code);
    const contents = CC.documentContents(ctx);
    const p = CD.proposeShapedStructureFromContext(ctx, shape);
    const assigned = p.modules.flatMap((m) => m.chapters.flatMap((c) => c.sourceContentIds));
    return {
      providersCalled: 0, shape, differences, notes: p.notes,
      plan: p.modules.map((m) => ({ title: m.title, chapters: m.chapters.map((c) => ({ title: c.title, contents: c.sourceContentIds.length, outcomeIds: c.outcomeIds })) })),
      coverage: { total: contents.length, assigned: new Set(assigned).size, duplicated: assigned.length - new Set(assigned).size },
    };
  };
  const out = {};
  const prevEnv = process.env.DYNAMIC_REAL_CHAPTERS;
  try {
    for (const [cn, ctx] of Object.entries(ctxs)) {
      for (const [n, m] of NXM_SHAPES) {
        for (const real of [false, true]) out[`proposal:${cn}:${n}x${m}:${real ? 'real' : 'plain'}`] = sha(CD.proposeShapedStructureFromContext(ctx, { modules: n, chaptersPerModule: m }, { realChapters: real }));
        for (const [rn, req] of Object.entries(REQS)) {
          for (const code of [null, 'S', 'M', 'L']) out[`diff:${cn}:${n}x${m}:${rn}:${code}`] = sha(SO.shapeDifferences(req, { modules: n, chaptersPerModule: m }, code));
        }
        process.env.DYNAMIC_REAL_CHAPTERS = 'false';
        out[`preview:${cn}:${n}x${m}`] = sha(previewOld(ctx, REQS.none, { modules: n, chaptersPerModule: m }, null));
      }
      out[`docShape:${cn}`] = sha(CD.documentStructureShape(ctx));
      out[`docProposal:${cn}`] = sha(CD.proposeStructureFromContext(ctx));
      for (const [rn, req] of Object.entries(REQS)) for (const h of [null, 8, 28, 40, 64]) out[`recommend3:${cn}:${rn}:${h}`] = sha(SO.recommendShape(req, CD.documentStructureShape(ctx), h));
    }
    for (const [rn, req] of Object.entries(REQS)) for (const h of [null, 8, 28, 40, 64]) out[`recommend3:nodoc:${rn}:${h}`] = sha(SO.recommendShape(req, null, h));
  } finally {
    if (prevEnv === undefined) delete process.env.DYNAMIC_REAL_CHAPTERS; else process.env.DYNAMIC_REAL_CHAPTERS = prevEnv;
  }
  return out;
}

(async () => {
  if (process.argv.includes('--write-golden')) {
    if (!BASE) { console.error('❌ --write-golden necesita --base <dist de origin/staging>'); process.exit(1); }
    const bctx = await contexts(BASE);
    const cases = nxmCases(BASE, bctx);
    const legacy = await legacyCases(BASE, bctx);
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify({
      generatedFrom: 'origin/staging 461d17ee (dist compilado)',
      note: 'r109 M3b: `cases` = huellas sha256 de las formas N × M; `legacyOptions` = huellas de la respuesta de structure-options que ve un cliente anterior (sin los campos nuevos), también en documentos desiguales; las dos se generan con origin/staging y tienen que quedar idénticas. `intentional` = lo que cambia A PROPÓSITO: «Como el documento» (documentRecommendation / documentRecommendationNote, campos nuevos), con su resultado esperado escrito a mano.',
      cases, legacyOptions: legacy, intentional: EXPECTED_DOC_RECOMMENDATIONS,
    }, null, 1) + '\n');
    console.log(`✅ golden: ${Object.keys(cases).length} huellas N × M y ${Object.keys(legacy).length} de structure-options en ${path.relative(REPO, GOLDEN)}`);
    process.exit(0);
  }

  const CD = L('modules/academic-context/context-design.js');
  const SO = L('modules/course-design/structure-options.js');
  const CC = L('modules/academic-context/content-coverage.js');
  const RA = L('modules/academic-context/requirements/requirement-authority.js');
  const DV = L('modules/course-design/design-verification.js');
  const CF = L('modules/prebrief/course-formats.js');
  const P = L('modules/pedagogy/index.js');
  const F = L('modules/course-design/budget-fit.js');
  const X = L('modules/academic-context/requirements/requirements-extractor.js');
  const T = L('modules/academic-context/extract/text-sources.js');
  const DTO = L('modules/course-design/dto/recommend.dto.js');
  const ADTO = L('modules/course-structure/dto/apply-academic-structure.dto.js');
  const SVC = L('modules/course-design/course-design.service.js');
  const { plainToInstance } = require('class-transformer');
  const { validate } = require('class-validator');
  const PF = require(path.join(REPO, 'scripts/fixtures/pedagogy/profiles.json'));
  const reqsOf = (txt) => X.requirementsFor(X.extractRequirements(T.readText(Buffer.from(txt), 'text/plain').lines), {}).filter((r) => r.obligation === 'required' && r.confidence === 'high');
  const ctxs = await contexts(DIST);
  const { a1a2, a1a2b, costos, pilot } = ctxs;
  const CASES = [{ name: 'A1-A2 4/5/4/4', ctx: a1a2, shape: [4, 5, 4, 4] }, { name: 'A1-A2 4/7/4/5', ctx: a1a2b, shape: [4, 7, 4, 5] }];

  await check('US1 forma del documento: contenidos por unidad, sin agrupar en el tope de 5', () => {
    eq(CD.documentContentShape(a1a2), [4, 5, 4, 4], 'A1-A2 (4/5/4/4)');
    eq(CD.documentContentShape(a1a2b), [4, 7, 4, 5], 'A1-A2 (4/7/4/5): la unidad de 7 contenidos son 7 capítulos');
    // La estructura «según el documento» de siempre (y document.shape de structure-options) sigue igual: agrupa en 5.
    eq(CD.documentStructureShape(a1a2b), [4, 5, 4, 5], 'documentStructureShape no cambia');
    eq(CD.documentContentShape(costos), [4, 4, 4, 3, 3], 'Contabilidad de Costos');
    eq(CD.documentContentShape(ctxs.big31), [4, 31, 4, 4], 'conteos reales (sin tope: quien la usa revisa los 30)');
    const empty = clone(a1a2); empty.units.forEach((u) => { u.contents = []; });
    eq(CD.documentContentShape(empty), null, 'sin contenidos: null');
    const partial = clone(a1a2); partial.units[1].contents = [];
    eq(CD.documentContentShape(partial), [4, 4, 4], 'una unidad sin contenidos no cuenta (como en la estructura del documento)');
  });

  await check('US2 «Como el documento»: un capítulo por contenido, razón real, solo si cumple TODOS los requisitos', () => {
    const DR = (ctx, req) => SO.documentShapeRecommendation(ctx, req || []);
    for (const [cn, exp] of Object.entries(EXPECTED_DOC_RECOMMENDATIONS)) eq(DR(ctxs[cn]), exp, `${cn}: resultado esperado`);
    // `recommended` sigue siendo la pareja de siempre (no se toca).
    for (const c of CASES) eq([SO.recommendShape([], CD.documentStructureShape(c.ctx), 28).modules, SO.recommendShape([], CD.documentStructureShape(c.ctx), 28).chaptersPerModule, SO.recommendShape([], CD.documentStructureShape(c.ctx), 28).moduleChapters], [4, 4, undefined], `${c.name}: recommended pareja`);
    // P1-1: máximo y rango de capítulos por módulo (contenidos 4/7/4/4).
    const c4744 = ctxWith(costos, [4, 7, 4, 4]);
    const max5 = DR(c4744, reqsOf('Cada módulo tendrá como máximo 5 capítulos de contenido.'));
    eq(max5.documentRecommendation, null, 'máximo 5 por módulo: no se ofrece (sería «Excepción al documento»)');
    eq(max5.note, '«Como el documento» (4 / 7 / 4 / 4) no cumple lo que exige el documento: El documento establece hasta 5 capítulos de contenido por módulo y has seleccionado 4 módulos (4, 7, 4, 4 capítulos de contenido): el módulo 2 no cumple. Cursia recomienda la forma pareja.', 'por qué');
    eq(DR(c4744, reqsOf('Cada módulo tendrá como máximo 7 capítulos de contenido.')).documentRecommendation.moduleChapters, [4, 7, 4, 4], 'máximo 7: se ofrece');
    eq(DR(c4744, reqsOf('Cada módulo tendrá entre 3 y 5 capítulos de contenido.')).documentRecommendation, null, 'rango 3–5: no');
    eq(DR(c4744, reqsOf('Cada módulo tendrá de 4 a 7 capítulos.')).documentRecommendation.moduleChapters, [4, 7, 4, 4], 'rango 4–7: sí');
    eq(DR(c4744, reqsOf('Cada módulo tendrá al menos 5 capítulos de contenido.')).documentRecommendation, null, 'mínimo 5: no');
    eq(DR(c4744, reqsOf('El curso tendrá exactamente 4 módulos. Cada módulo tendrá exactamente 4 capítulos de contenido.')).documentRecommendation, null, 'exige 4 × 4: no');
    eq(DR(c4744, reqsOf('El curso tendrá exactamente 5 módulos.')).documentRecommendation, null, 'exige 5 módulos: no');
    eq(DR(c4744, reqsOf('El curso tendrá exactamente 4 módulos.')).documentRecommendation.moduleChapters, [4, 7, 4, 4], 'exige 4 módulos: sí');
    const st = (shape) => ({ id: 'RQX', key: 'structure@structure', kind: 'structure', scope: { level: 'structure' }, mode: 'exact', value: null, shape, obligation: 'required', confidence: 'high', active: true, source: null });
    eq(DR(c4744, [st([4, 7, 4, 4])]).documentRecommendation.moduleChapters, [4, 7, 4, 4], 'estructura exigida igual: sí');
    eq(DR(c4744, [st([4, 5, 4, 4])]).documentRecommendation, null, 'estructura exigida distinta: no');
    // P2-3: una estructura desigual exigida SOLO por requisito (sin contenidos por unidad) no se ofrece como «Como el documento».
    const noUnits = clone(pilot); noUnits.units = [];
    eq(DR(noUnits, [st([4, 5, 4, 4])]), { documentRecommendation: null, note: null }, 'sin contenidos por unidad');
    eq(SO.recommendShape([st([4, 5, 4, 4])], null, 28).moduleChapters, undefined, 'y `recommended` no es desigual (como en staging)');
    eq(DR(null), { documentRecommendation: null, note: null }, 'sin documento');
    // La razón cuenta lo real (unidades sin contenidos se dicen).
    const withEmpty = clone(a1a2); withEmpty.units.push({ ...clone(withEmpty.units[0]), id: 'U5', title: 'Unidad vacía', contents: [] });
    eq(DR(withEmpty).documentRecommendation.reason, 'Como el documento: 4 unidades con 4 / 5 / 4 / 4 contenidos. Cada unidad es un módulo y cada uno de sus 17 contenidos, un capítulo, en el orden del documento. Una unidad sin contenidos no se usa.', 'unidad vacía');
  });

  await check('US2b compatibilidad: un cliente anterior ve structure-options IDÉNTICO a origin/staging (también desigual)', async () => {
    const now = await legacyCases(DIST, ctxs);
    const ref = BASE ? await legacyCases(BASE, await contexts(BASE)) : JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).legacyOptions;
    assert(ref && Object.keys(ref).length === Object.keys(ctxs).length, 'huellas de structure-options en el golden');
    eq(Object.keys(ref).filter((k) => now[k] !== ref[k]), [], 'respuestas distintas para un cliente anterior');
    const o = await optionsOf(DIST, a1a2b);
    eq([o.recommended, o.documentRecommendation && o.documentRecommendation.moduleChapters, o.document.contentShape, 'evenAlternative' in o], [SO.recommendShape([], [4, 5, 4, 5], 64), [4, 7, 4, 5], [4, 7, 4, 5], false], 'campos nuevos aparte; `recommended` de siempre');
    const big = await optionsOf(DIST, ctxs.big31);
    eq([big.documentRecommendation, big.documentRecommendationNote], [null, EXPECTED_DOC_RECOMMENDATIONS.big31.note], 'más de 30 contenidos: se explica');
    if (!BASE) eq(JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).intentional, EXPECTED_DOC_RECOMMENDATIONS, 'el golden documenta el cambio esperado');
  });

  await check('US3 propuesta con la forma del documento: esos capítulos por módulo, en orden, ni omitidos ni duplicados', () => {
    for (const c of CASES) {
      for (const real of [false, true]) {
        const shape = CD.normalizeShape({ modules: 4, chaptersPerModule: Math.max(...c.shape), moduleChapters: c.shape });
        const p = CD.proposeShapedStructureFromContext(c.ctx, shape, { realChapters: real });
        const tag = `${c.name}${real ? ' (capítulos reales)' : ''}`;
        eq(p.modules.map((m) => m.chapters.length), c.shape, `${tag}: capítulos por módulo`);
        eq(assignedIds(p), allIds(c.ctx), `${tag}: cada contenido una vez y en el orden del documento`);
        assert(p.modules.every((m) => m.chapters.every((ch) => ch.sourceContentIds.length === 1)), `${tag}: un contenido por capítulo`);
        eq(p.modules.map((m) => m.sourceUnitId), ['U1', 'U2', 'U3', 'U4'], `${tag}: cada unidad es su módulo`);
        eq(p.modules.map((m) => m.title), A1A2_UNITS.map((u) => u.title), `${tag}: títulos de las unidades`);
        eq(p.modules.flatMap((m) => m.chapters.map((ch) => ch.title)), c.ctx.units.flatMap((u) => u.contents.map((x) => x.text)), `${tag}: títulos de los contenidos, literales`);
        // Igual que la estructura del documento de siempre en lo que ya funcionaba: resultados cubiertos.
        const docP = CD.proposeStructureFromContext(c.ctx);
        eq([p.counts.outcomesCovered, p.counts.outcomesTotal], [docP.counts.outcomesCovered, docP.counts.outcomesTotal], `${tag}: cobertura de resultados`);
        eq(p.counts.outcomesCovered, 4, `${tag}: 4/4 RA`);
        eq(p.modules.map((m) => m.outcomeIds.filter((id) => /^RA/.test(id))), [['RA1'], ['RA2'], ['RA3'], ['RA4']], `${tag}: los RA de cada unidad en su módulo`);
        assert(p.notes[0] === `Como el documento: cada una de sus 4 unidades es un módulo y cada uno de sus ${c.shape.reduce((a, b) => a + b, 0)} contenidos, un capítulo, en su orden (ninguno se pierde ni se repite).`, `${tag}: nota ${JSON.stringify(p.notes)}`);
        assert(!p.notes.some((t) => /×/.test(t)), `${tag}: ninguna nota dice N × M: ${JSON.stringify(p.notes)}`);
        // Cobertura exacta por trazabilidad (la misma que usa Verificación).
        const map = { version: 1, contextVersion: 1, at: 't', chapters: Object.fromEntries(p.modules.flatMap((m) => m.chapters).map((ch, i) => [`ch${i}`, ch.sourceContentIds])) };
        const cov = CC.contentCoverage(c.ctx, 1, map, Object.keys(map.chapters));
        eq([cov.total, cov.covered, cov.omitted.length, cov.duplicated.length], [c.shape.reduce((a, b) => a + b, 0), c.shape.reduce((a, b) => a + b, 0), 0, 0], `${tag}: cobertura`);
      }
    }
    // El docente agranda un módulo (5/5/4/4 en un documento 4/5/4/4): se sigue a las unidades; el que sobra es profundización.
    const p = CD.proposeShapedStructureFromContext(a1a2, CD.normalizeShape({ moduleChapters: [5, 5, 4, 4] }), { realChapters: false });
    eq(p.modules.map((m) => m.chapters.length), [5, 5, 4, 4], '5/5/4/4');
    eq(assignedIds(p), allIds(a1a2), '5/5/4/4: sin pérdidas, en orden');
    eq(p.modules[0].chapters.filter((ch) => !ch.sourceContentIds.length).map((ch) => ch.title), ['Profundización 1: Movilidad segura y actores viales'], 'profundización');
    assert(p.notes.some((t) => t === 'El documento organiza sus contenidos en 4 unidades (4, 5, 4, 4 contenidos por unidad); la estructura elegida es 4 módulos (5, 5, 4, 4 capítulos).'), JSON.stringify(p.notes));
    // Un módulo más chico que su unidad: sus capítulos agrupan contenidos (ninguno se pierde).
    const q = CD.proposeShapedStructureFromContext(a1a2b, CD.normalizeShape({ moduleChapters: [4, 5, 4, 5] }), { realChapters: false });
    eq([q.modules.map((m) => m.chapters.length), assignedIds(q)], [[4, 5, 4, 5], allIds(a1a2b)], '4/5/4/5 sobre 4/7/4/5: agrupa sin perder');
    assert(q.notes.some((t) => /más contenidos que capítulos/.test(t)), JSON.stringify(q.notes));
  });

  await check('US4 forma de entrada: normalizeShape / isValidShape con los topes; DTO de vista previa y de aplicar', async () => {
    eq(CD.normalizeShape({ modules: 4, chaptersPerModule: 5, moduleChapters: [4, 5, 4, 4] }), { modules: 4, chaptersPerModule: 5, moduleChapters: [4, 5, 4, 4] }, 'desigual');
    eq(CD.normalizeShape({ moduleChapters: [4, 5, 4, 4] }), { modules: 4, chaptersPerModule: 5, moduleChapters: [4, 5, 4, 4] }, 'se deducen modules y chaptersPerModule');
    eq(CD.normalizeShape({ modules: 3, chaptersPerModule: 4, moduleChapters: [4, 4, 4] }), { modules: 3, chaptersPerModule: 4 }, 'todos iguales: N × M de siempre');
    eq(CD.normalizeShape({ modules: 3, chaptersPerModule: 4 }), { modules: 3, chaptersPerModule: 4 }, 'N × M');
    for (const bad of [{ modules: 3, chaptersPerModule: 5, moduleChapters: [4, 5, 4, 4] }, { modules: 4, chaptersPerModule: 4, moduleChapters: [4, 5, 4, 4] }, { moduleChapters: [4, 31] }, { moduleChapters: [0, 3] },
      { moduleChapters: [] }, { moduleChapters: Array.from({ length: 51 }, () => 2) }, { moduleChapters: [2.5, 3] }, { modules: 0, chaptersPerModule: 3 }, { modules: 51, chaptersPerModule: 3 }, null]) {
      eq(CD.normalizeShape(bad), null, `inválida ${JSON.stringify(bad && bad.moduleChapters ? { ...bad, moduleChapters: bad.moduleChapters.length > 5 ? `[${bad.moduleChapters.length}]` : bad.moduleChapters } : bad)}`);
    }
    eq([CD.isValidShape({ modules: 4, chaptersPerModule: 5, moduleChapters: [4, 5, 4, 4] }), CD.isValidShape({ modules: 4, chaptersPerModule: 4, moduleChapters: [4, 5, 4, 4] }), CD.isValidShape({ modules: 50, chaptersPerModule: 30 })], [true, false, true], 'isValidShape');
    eq(CD.shapeLabel({ modules: 4, chaptersPerModule: 5, moduleChapters: [4, 5, 4, 4] }), '4 módulos (4, 5, 4, 4 capítulos)', 'etiqueta desigual');
    eq(CD.shapeLabel({ modules: 3, chaptersPerModule: 4 }), '3 × 4', 'etiqueta N × M');
    const errs = async (Cls, body) => (await validate(plainToInstance(Cls, body), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);
    eq(await errs(DTO.StructurePreviewDto, { modules: 4, chaptersPerModule: 5, moduleChapters: [4, 5, 4, 4] }), [], 'preview: desigual válida');
    eq(await errs(DTO.StructurePreviewDto, { modules: 3, chaptersPerModule: 4, format: 'M' }), [], 'preview: N × M de siempre');
    eq(await errs(DTO.StructurePreviewDto, { modules: 4, chaptersPerModule: 5, moduleChapters: [4, 31] }), ['moduleChapters'], 'preview: tope 30');
    eq(await errs(DTO.StructurePreviewDto, { modules: 4, chaptersPerModule: 5, moduleChapters: [] }), ['moduleChapters'], 'preview: vacía');
    eq(await errs(ADTO.ApplyAcademicStructureDto, { expectedCounter: 3, contextVersion: 1, choice: 'cursia', shape: { modules: 4, chaptersPerModule: 7, moduleChapters: [4, 7, 4, 5] } }), [], 'aplicar: desigual válida');
    eq(await errs(ADTO.ApplyAcademicStructureDto, { expectedCounter: 3, contextVersion: 1, choice: 'cursia', shape: { modules: 4, chaptersPerModule: 7, moduleChapters: ['x'] } }), ['shape'], 'aplicar: inválida');
  });

  await check('US5 vista previa y diferencias: «4 módulos (4, 7, 4, 5 capítulos)»; servicio structurePreview con la forma desigual', async () => {
    const shape = CD.normalizeShape({ modules: 4, chaptersPerModule: 7, moduleChapters: [4, 7, 4, 5] });
    const pv = SO.structurePreviewOf(a1a2b, [], shape, null);
    eq([pv.label, pv.coverage, pv.plan.map((m) => m.chapters.length), pv.differences, pv.shape], ['4 módulos (4, 7, 4, 5 capítulos de contenido)', { total: 20, assigned: 20, duplicated: 0 }, [4, 7, 4, 5], [], shape], 'vista previa');
    const nodoc = SO.structurePreviewOf(null, [], shape, null);
    eq([nodoc.plan, nodoc.coverage, nodoc.notes], [null, null, []], 'sin documento');
    const req44 = reqsOf('El curso tendrá exactamente 4 módulos. Cada módulo tendrá exactamente 4 capítulos de contenido.');
    eq(SO.shapeDifferences(req44, shape).map((d) => d.text), ['El documento establece 4 capítulos de contenido por módulo y has seleccionado 4 módulos (4, 7, 4, 5 capítulos de contenido): los módulos 2, 4 no cumplen.',
      'El documento establece estructura 4 × 4 (16 capítulos de contenido) y has seleccionado 4 módulos (4, 7, 4, 5 capítulos).'], 'capítulos por módulo (módulo a módulo) y la estructura 4 × 4');
    const st = { id: 'RQX', key: 'structure@structure', kind: 'structure', scope: { level: 'structure' }, mode: 'exact', value: null, shape: [4, 5, 4, 4], obligation: 'required', confidence: 'high', active: true, source: null };
    eq(SO.shapeDifferences([st], CD.normalizeShape({ moduleChapters: [4, 5, 4, 4] })), [], 'cumple la estructura desigual exigida');
    eq(SO.shapeDifferences([st], shape).map((d) => d.text), ['El documento establece estructura 4, 5, 4, 4 (17 capítulos) y has seleccionado 4 módulos (4, 7, 4, 5 capítulos).'], 'no la cumple');
    eq(SO.shapeDifferences([st], { modules: 4, chaptersPerModule: 4 }).map((d) => d.text), ['El documento establece estructura 4, 5, 4, 4 (17 capítulos) y has seleccionado 4 × 4.'], 'N × M frente a la desigual');
    // El servicio (sin base: lecturas simuladas, el contexto A1-A2 guardado) normaliza la entrada y rechaza lo inválido.
    const FEAT = L('modules/features/dynamic-features.js');
    const AC = L('modules/academic-context/academic-context.js');
    process.env[FEAT.DYNAMIC_FLAG_ENV || 'DYNAMIC_COURSE_STRUCTURE_V2'] = 'true';
    process.env[FEAT.GENERAL_AVAILABILITY_ENV] = 'true';
    const stored = AC.normalizeAcademicContext(clone(a1a2b));
    const svc = Object.create(SVC.CourseDesignService.prototype);
    svc.loadCourse = async () => {};
    svc.dataSource = { query: async (sql) => (/from public\.course_profiles/.test(sql) && /'academic'/.test(sql) ? [{ id: 1, version: 3, data: stored, sha256: AC.academicContextSha256(stored) }] : []) };
    const sp = await svc.structurePreview(1, 'owner', { modules: 4, chaptersPerModule: 7, moduleChapters: [4, 7, 4, 5] }, null);
    eq([sp.label, sp.plan.map((m) => m.chapters.length), sp.coverage], ['4 módulos (4, 7, 4, 5 capítulos de contenido)', [4, 7, 4, 5], { total: 20, assigned: 20, duplicated: 0 }], 'servicio: vista previa desigual');
    const sn = await svc.structurePreview(1, 'owner', { modules: 3, chaptersPerModule: 4 }, null);
    eq([sn.shape, sn.label, sn.plan.map((m) => m.chapters.length)], [{ modules: 3, chaptersPerModule: 4 }, undefined, [4, 4, 4]], 'servicio: N × M de siempre');
    const se = await svc.structurePreview(1, 'owner', { modules: 4, chaptersPerModule: 4, moduleChapters: [4, 4, 4, 4] }, null);
    eq(se.shape, { modules: 4, chaptersPerModule: 4 }, 'servicio: desigual con todos iguales = N × M');
    const rejects = async (input, code, m) => { let msg = ''; try { await svc.structurePreview(1, 'owner', input, code); } catch (e) { msg = String((e && e.message) || e); } assert(/^INVALID_SHAPE/.test(msg), `${m}: ${msg || 'no rechazó'}`); };
    await rejects({ modules: 4, chaptersPerModule: 4, moduleChapters: [4, 7, 4, 5] }, null, 'chaptersPerModule distinto del mayor');
    await rejects({ modules: 3, chaptersPerModule: 7, moduleChapters: [4, 7, 4, 5] }, null, 'modules distinto del largo');
    await rejects({ modules: 4, chaptersPerModule: 7, moduleChapters: [4, 7, 4, 5] }, 'M', 'formato S/M/L con forma desigual');
  });

  // Estructura aplicada (como la deja apply-academic-structure) → dry-run / distribuidor / costo / presupuesto / verificación.
  const structureFrom = (p) => ({
    course: { title: 'Licencia de conducción A1-A2 (sintético)', finalExam: true, activityEngine: 'h5p' },
    modules: p.modules.map((m, i) => ({ id: `m${i + 1}`, title: m.title, objective: m.objective || 'Conducir de forma segura', examEnabled: true,
      chapters: m.chapters.map((ch, j) => ({ id: `m${i + 1}c${j + 1}`, title: ch.title, objective: 'Aplicar lo aprendido en la vía' })) })),
  });
  const profile = (h, dp = {}) => ({
    pedagogyProfileVersion: 1, primaryApproach: PF.profiles.competencias.primaryApproach, secondaryApproaches: PF.profiles.competencias.secondaryApproaches,
    learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual',
    targetHours: h, designPreferences: { audiovisual: 'recommended', ...dp },
  });
  const contentPerModule = (modules) => modules.map((m) => m.chapters.filter((c) => (c.kind || 'content') !== 'practice').length);

  await check('US6 horas, costo, presupuesto, verificación y Prebrief con la estructura desigual aplicada', () => {
    for (const c of CASES) {
      const p = CD.proposeShapedStructureFromContext(c.ctx, CD.normalizeShape({ moduleChapters: c.shape }), { realChapters: false });
      const structure = structureFrom(p);
      for (const h of [28, 40]) {
        const r = P.runPedagogyDryRun({ structure: clone(structure), profile: profile(h), activityTypeRules: 2, pricing: L('modules/pedagogy/dry-run.js').seedPricing() });
        const d = r.distribution;
        assert(d && typeof d.estimatedHours === 'number' && isFinite(d.estimatedHours), `${c.name} ${h} h: distribución`);
        assert(['within_tolerance', 'minimum_exceeds_target', 'cannot_reach_target'].includes(d.status), `${c.name} ${h} h: estado ${d.status}`);
        const per = contentPerModule(d.modules);
        eq(per.length, 4, `${c.name} ${h} h: 4 módulos`);
        assert(per.every((n, i) => n >= c.shape[i]), `${c.name} ${h} h: ningún capítulo de contenido se pierde (${per} vs ${c.shape})`);
        assert(d.modules.every((m) => m.chapters.every((ch) => (ch.minutes ?? ch.totalMinutes ?? 0) <= 240)), `${c.name} ${h} h: ningún capítulo > 4 h`);
        // Costo estimado del diseño que se congelaría (la propuesta materializada; los precios del seed, sin base).
        const est = d.materialized && d.materialized.providers && d.materialized.providers.estimateUsd;
        const exp = est ? Number(est.expected) : NaN;
        assert(isFinite(exp) && exp > 0, `${c.name} ${h} h: costo estimado (${JSON.stringify(est)})`);
        eq(d.materialized.manifestErrors, [], `${c.name} ${h} h: el Manifest se materializa`);
        if (h === 28) console.log(`   ${c.name} · 28 h → ${d.estimatedHours} h (${d.status}) · contenido por módulo ${per.join('/')} · costo esperado USD ${exp.toFixed(2)}`);
      }
      // Ajuste al presupuesto: holgado cabe; ningún diseño mostrado pierde capítulos de contenido de la estructura.
      const LEVERS = { audiovisual: { base: 'recommended', locked: false }, guidedPractice: { base: 'auto', locked: false }, emphasis: { base: 'balanced', locked: false } };
      for (const usd of [500, 15]) {
        const fit = F.fitDesignToBudget({ base: { structure: clone(structure), profile: profile(28), activityTypeRules: 2 }, budgetUsd: usd, levers: LEVERS });
        assert(fit && fit.status, `${c.name} USD ${usd}: resultado`);
        if (usd === 500) eq(fit.status, 'fits', `${c.name} USD 500: cabe`);
        const designs = [fit.chosen, ...(fit.alternatives || []).map((a) => a.design)].filter(Boolean);
        for (const dsg of designs) {
          const pp = profile(dsg.targetHours);
          pp.designPreferences = { audiovisual: dsg.preferences.audiovisual, ...(dsg.preferences.guidedPractice === 'none' ? { guidedPractice: 'none' } : {}), ...(dsg.preferences.emphasis !== 'balanced' ? { emphasis: dsg.preferences.emphasis } : {}), ...(dsg.preferences.maxContentChaptersPerModule !== null ? { maxContentChaptersPerModule: dsg.preferences.maxContentChaptersPerModule } : {}) };
          const dd = P.runPedagogyDryRun({ structure: clone(structure), profile: pp, activityTypeRules: 2 }).distribution;
          const per = contentPerModule(dd.modules);
          assert(per.every((n, i) => n >= c.shape[i]), `${c.name} USD ${usd}: el diseño mostrado conserva ${c.shape} (${per})`);
        }
        console.log(`   ${c.name} · presupuesto USD ${usd.toFixed(2)} → ${fit.status}`);
      }
      // El texto del tope («Hasta N capítulos de contenido por módulo») dice qué módulos conservan más (no los recorta).
      if (c.shape.some((n) => n > 5)) {
        const capped = [90, 100, 110].map((usd) => F.fitDesignToBudget({ base: { structure: clone(structure), profile: profile(80), activityTypeRules: 2 }, budgetUsd: usd, levers: LEVERS }))
          .flatMap((r) => (r.reasons || []).filter((t) => /^Hasta \d/.test(t)).map((t) => ({ t, per: r.chosen.structure.contentByModule })));
        assert(capped.length > 0, `${c.name}: algún diseño con tope`);
        for (const x of capped) {
          const cap = Number(x.t.match(/^Hasta (\d+)/)[1]);
          const over = x.per.map((n, i) => ({ n, i })).filter((y) => y.n > cap);
          assert(over.length > 0 && over.every((y) => x.t.includes(`${y.i + 1}`) && x.t.includes(`${y.n}`)) && /Cursia no quita capítulos/.test(x.t), `${c.name}: «${x.t}» con ${x.per}`);
        }
        console.log(`   ${c.name} · texto del tope: «${capped[0].t.slice(0, 120)}…»`);
      }
      // Verificación: la estructura desigual frente a un formato (siempre parejo) se dice con su forma real.
      const fit = CF.formatFit(CF.COURSE_FORMATS.M, structure.modules, 28);
      eq([fit.structureOk, fit.contentShape], [false, c.shape], `${c.name}: formato M`);
      const v = DV.verifyDesign({
        status: 'within_tolerance', targetHours: 28, estimatedHours: 28, toleranceHours: 1.4, baseHours: 20,
        counts: { modules: 4, chapters: c.shape.reduce((a, b) => a + b, 0), contentChapters: c.shape.reduce((a, b) => a + b, 0), practiceChapters: 0, videoChapters: 10, activities: 10, reviews: 0, applicationActivities: 0, applicationMinutes: 0, evaluations: 5 },
        manifestErrors: [], alignment: null, approach: { id: 'competencias', label: 'Competencias' }, policyKind: 'application_first', audiovisual: null, pinnedChapters: [],
        cost: { min: 1, expected: 2, max: 3 }, preferences: { emphasis: 'balanced', applicationActivities: 'auto' }, autoLink: { chapterIds: [], outcomeIds: [], preview: [] },
        proposedChapterIds: [], uncoveredContents: [], requiredEvaluations: [], pinnedApplicationsOutsideMode: [], uncoveredEvaluations: [], requirementChecks: [],
        contentCoverage: { available: true, stale: false, total: c.shape.reduce((a, b) => a + b, 0), covered: c.shape.reduce((a, b) => a + b, 0), omitted: [], duplicated: [] },
        format: { label: 'Formato M', modules: 3, chaptersPerModule: 4, hoursMin: 40, hoursMax: 44, ...fit },
      });
      const fc = v.checks.find((x) => x.id === 'format');
      assert(fc && fc.detail === `Capítulos de contenido por módulo: ${c.shape.join(', ')}. Las prácticas y las Actividades de Aplicación no cuentan.`, `${c.name}: verificación del formato: ${JSON.stringify(fc)}`);
      const cc = v.checks.find((x) => x.id === 'contents');
      eq([cc.severity, cc.title], ['ok', `Contenidos del documento: ${c.shape.reduce((a, b) => a + b, 0)} de ${c.shape.reduce((a, b) => a + b, 0)} en el diseño`], `${c.name}: cobertura en Verificación`);
      // Prebrief / requisitos: la forma real se dice tal cual (sin N × M).
      eq(RA.structureActualText(c.shape), `4 módulos con ${c.shape.join(', ')} capítulos de contenido`, `${c.name}: Prebrief`);
      eq(RA.requiredContentShape([{ kind: 'structure', shape: c.shape, obligation: 'required', confidence: 'high', scope: { level: 'structure' } }]), c.shape, `${c.name}: requisito de forma desigual`);
    }
  });

  await check('US7 desigual con otra cantidad de módulos que unidades: reparto proporcional en orden, sin pérdidas', () => {
    for (const mc of [[3, 6, 5, 2, 4], [10, 8], [2, 2, 2, 2, 2, 3, 3, 3]]) {
      const p = CD.proposeShapedStructureFromContext(costos, CD.normalizeShape({ moduleChapters: mc }), { realChapters: false });
      eq(p.modules.map((m) => m.chapters.length), mc, `${mc}: capítulos por módulo`);
      const ids = assignedIds(p);
      eq(ids, allIds(costos), `${mc}: los 18 contenidos una vez y en orden`);
      eq(p.counts.outcomesCovered, 6, `${mc}: 6/6 RA`);
      assert(!p.notes.some((t) => /×/.test(t)), `${mc}: sin N × M en las notas: ${JSON.stringify(p.notes)}`);
    }
  });

  await check('US8 sin regresión: N × M igual que origin/staging; sin documento / sin unidades igual que hoy', async () => {
    const now = nxmCases(DIST, ctxs);
    let ref;
    if (BASE) ref = nxmCases(BASE, await contexts(BASE));
    else {
      assert(fs.existsSync(GOLDEN), `falta ${path.relative(REPO, GOLDEN)} (genéralo con --write-golden --base <dist de origin/staging>)`);
      ref = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).cases;
    }
    const keys = Object.keys(ref);
    assert(keys.length > 1000, `huellas: ${keys.length}`);
    const diff = keys.filter((k) => now[k] !== ref[k]);
    eq(diff.slice(0, 8), [], `${diff.length} de ${keys.length} huellas N × M cambiaron`);
    eq(Object.keys(now).length, keys.length, 'mismas huellas');
    // La vista previa nueva (función pura del servicio) da lo mismo que la de siempre con N × M.
    for (const [n, m] of [[3, 4], [4, 4], [2, 9]]) {
      const s = { modules: n, chaptersPerModule: m };
      const pv = SO.structurePreviewOf(costos, [], s, null);
      eq(Object.keys(pv), ['providersCalled', 'shape', 'differences', 'notes', 'plan', 'coverage'], `${n}×${m}: los campos de siempre (sin label)`);
      eq(pv.shape, s, `${n}×${m}: shape`);
    }
    eq(Object.keys(SO.structurePreviewOf(null, [], { modules: 3, chaptersPerModule: 4 }, 'M')), ['providersCalled', 'shape', 'differences', 'plan', 'coverage', 'notes'], 'sin documento: los campos de siempre');
    // Un documento sin unidades con contenidos: ni forma del documento ni recomendación desigual.
    const noUnits = clone(pilot); noUnits.units = [];
    eq([CD.documentContentShape(noUnits), CD.proposeShapedStructureFromContext(noUnits, CD.normalizeShape({ moduleChapters: [2, 3] })).available], [null, false], 'documento sin unidades');
  });

  if (process.argv.includes('--db')) await dbChecks({ a1a2b, CD });
  else console.log('   (parte DB con Postgres 16 local: --db; no corre en CI)');

  console.log(`\n${ok} OK · ${fail} fallas · red ${netAttempts.length} · USD 0.00`);
  if (netAttempts.length) console.log(`❌ hubo ${netAttempts.length} intentos de red: ${netAttempts.slice(0, 3).join(', ')}`);
  process.exit(fail || netAttempts.length ? 1 : 0);
})().catch((e) => { console.log(`❌ error inesperado: ${e && e.stack ? e.stack : e}`); process.exit(1); });

// ── US9 (solo --db): de punta a punta con Postgres 16 local (las migraciones de siempre), sin proveedores ──
async function dbChecks({ a1a2b, CD }) {
  const os = require('os');
  const net = require('net');
  const findPgBin = () => {
    for (const d of [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'].filter(Boolean)) {
      const pg = path.join(d, 'postgres');
      if (fs.existsSync(pg) && /\b16\./.test(spawnSync(pg, ['--version'], { encoding: 'utf8' }).stdout || '')) return d;
    }
    throw new Error('No encontré Postgres 16 (setear PG_BIN)');
  };
  const freePort = () => new Promise((resolve, reject) => { const srv = net.createServer(); srv.on('error', reject); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });
  const cleanEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' });
  const { Client } = require('pg');
  const { DataSource } = require('typeorm');
  const { NotFoundException } = require('@nestjs/common');
  const { CourseProfilesService } = L('modules/course-profiles/course-profiles.service.js');
  const { CourseBlueprintsService } = L('modules/course-blueprints/course-blueprints.service.js');
  const { PedagogyService } = L('modules/pedagogy/pedagogy.service.js');
  const { CourseDesignService } = L('modules/course-design/course-design.service.js');
  const { CourseModule } = L('modules/course-structure/entities/course-module.entity.js');
  const { CourseChapter } = L('modules/course-structure/entities/course-chapter.entity.js');
  const { CourseStructureService } = L('modules/course-structure/course-structure.service.js');
  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-r109-pg16-'));
  const DB = 'r109db';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
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
        'supabase-migration-application-activities.sql', 'supabase-migration-guided-practice.sql', 'supabase-migration-academic-context.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    process.env.DYNAMIC_V2_GENERAL_AVAILABILITY = 'true';
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
    const design = new CourseDesignService(ds, coursesStub, pedagogy);
    const structure = new CourseStructureService(ds.getRepository(CourseModule), ds.getRepository(CourseChapter), coursesStub, ds, blueprints);
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const counter = async (cid) => (await ds.query(`select structure_version_counter c from public.courses where id = $1`, [cid]))[0].c;
    const live = async (cid) => (await ds.query(`select count(c.id)::int n from public.course_modules m left join public.course_chapters c on c.module_id = m.id where m.course_id = $1 group by m.id, m.position order by m.position`, [cid])).map((x) => x.n);
    const newCourse = async (title) => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, $2, 'dynamic', true, 'h5p') returning id`, [OWNER, title]);
      const [m] = await ds.query(`insert into public.course_modules (course_id, position, title) values ($1, 0, 'Módulo 1') returning id`, [c.id]);
      await ds.query(`insert into public.course_chapters (course_id, module_id, position, title) values ($1, $2, 0, 'Nuevo capítulo')`, [c.id, m.id]);
      await profiles.append(c.id, OWNER, 'academic', clone(a1a2b));
      return { id: c.id, v: (await profiles.getCurrent(c.id, OWNER, 'academic')).version };
    };

    await check('US9 DB: structure-options → preview → aplicar «Como el documento» 4/7/4/5 → diseño (horas y costo)', async () => {
      const c = await newCourse('A1-A2 desigual');
      const o = await design.structureOptions(c.id, OWNER);
      const dr = o.documentRecommendation;
      eq([o.document.shape, o.document.contentShape, dr && dr.moduleChapters, o.recommended.moduleChapters, [o.recommended.modules, o.recommended.chaptersPerModule]], [[4, 5, 4, 5], [4, 7, 4, 5], [4, 7, 4, 5], undefined, [4, 4]], 'opciones');
      const pv = await design.structurePreview(c.id, OWNER, { modules: dr.modules, chaptersPerModule: dr.chaptersPerModule, moduleChapters: dr.moduleChapters }, null);
      eq([pv.coverage, pv.label], [{ total: 20, assigned: 20, duplicated: 0 }, '4 módulos (4, 7, 4, 5 capítulos de contenido)'], 'vista previa');
      const shape = { modules: 4, chaptersPerModule: 7, moduleChapters: [4, 7, 4, 5] };
      // «Como el documento» con otra forma: rechazado.
      let vmsg = '';
      try { await structure.applyAcademicStructure(c.id, OWNER, { expectedCounter: await counter(c.id), contextVersion: c.v, choice: 'cursia', variant: 'document', shape: { modules: 4, chaptersPerModule: 4 } }); } catch (e) { vmsg = JSON.stringify((e.getResponse && e.getResponse()) || e.message); }
      assert(/INVALID_CHOICE/.test(vmsg), 'variante «document» con otra forma: ' + vmsg);
      let cmsg = '';
      try { await structure.applyAcademicStructure(c.id, OWNER, { expectedCounter: await counter(c.id), contextVersion: c.v, choice: 'custom', variant: 'document', shape }); } catch (e) { cmsg = JSON.stringify((e.getResponse && e.getResponse()) || e.message); }
      assert(/INVALID_CHOICE/.test(cmsg), 'variante sin «cursia»: ' + cmsg);
      const res = await structure.applyAcademicStructure(c.id, OWNER, { expectedCounter: await counter(c.id), contextVersion: c.v, choice: 'cursia', variant: 'document', shape });
      assert(res && res.replaced, 'aplicada: ' + JSON.stringify(res).slice(0, 200));
      eq(await live(c.id), [4, 7, 4, 5], 'estructura viva');
      // Trazabilidad guardada: cada capítulo vivo con su contenido del documento; los 20, una vez cada uno.
      const CCV = L('modules/academic-context/content-coverage.js');
      const cmap = await CCV.readContentMap(ds, c.id);
      const liveIds = (await ds.query(`select id from public.course_chapters where course_id = $1`, [c.id])).map((x) => x.id);
      const cv = CCV.contentCoverage(a1a2b, c.v, cmap, liveIds);
      eq([cv.available, cv.total, cv.covered, cv.omitted.length, cv.duplicated.length], [true, 20, 20, 0, 0], 'cobertura guardada');
      const after = await design.structureOptions(c.id, OWNER);
      eq([after.current.choice, after.current.shape, after.current.variant], ['cursia', [4, 7, 4, 5], 'document'], 'elección vigente, con su variante');
      const rec = await design.recommend(c.id, OWNER, {});
      eq([rec.design.manifestErrors, rec.providersCalled], [[], 0], 'diseño materializado, sin proveedores');
      const per = rec.design.modules.map((m) => m.chapters.filter((ch) => (ch.kind || 'content') !== 'practice').length);
      assert(per.every((n, i) => n >= [4, 7, 4, 5][i]), 'ningún capítulo del documento se pierde en el diseño: ' + per);
      assert(Number(rec.cost.expected) > 0, 'costo estimado: ' + JSON.stringify(rec.cost));
      const cov = rec.verification && rec.verification.checks ? rec.verification.checks.find((x) => x.id === 'contents') : null;
      assert(!cov || cov.severity === 'ok', 'Verificación de contenidos: ' + JSON.stringify(cov));
      console.log(`   DB · ${rec.hours.target} h (${rec.hours.source}) → ${rec.design.estimatedHours} h · contenido ${per.join('/')} · costo esperado USD ${Number(rec.cost.expected).toFixed(2)}`);
    });

    await check('US9b DB: N × M de siempre; formato con forma desigual y forma incoherente rechazados sin cambios', async () => {
      const c = await newCourse('A1-A2 parejo');
      await structure.applyAcademicStructure(c.id, OWNER, { expectedCounter: await counter(c.id), contextVersion: c.v, choice: 'custom', shape: { modules: 4, chaptersPerModule: 4 } });
      eq(await live(c.id), [4, 4, 4, 4], '4 × 4');
      const before = await counter(c.id);
      let msg = '';
      try { await structure.applyAcademicStructure(c.id, OWNER, { expectedCounter: before, contextVersion: c.v, choice: 'custom', confirmReplace: true, shape: { modules: 4, chaptersPerModule: 5, moduleChapters: [4, 7, 4, 5] } }); } catch (e) { msg = JSON.stringify((e.getResponse && e.getResponse()) || e.message); }
      assert(/INVALID_SHAPE/.test(msg), 'forma incoherente: ' + msg);
      eq([await live(c.id), await counter(c.id)], [[4, 4, 4, 4], before], 'sin cambios');
      const res = await structure.applyAcademicStructure(c.id, OWNER, { expectedCounter: before, contextVersion: c.v, choice: 'custom', confirmReplace: true, shape: { modules: 4, chaptersPerModule: 7, moduleChapters: [4, 7, 4, 5] } });
      assert(res, 'personalizada desigual');
      eq(await live(c.id), [4, 7, 4, 5], 'personalizada desigual aplicada');
      eq((await design.structureOptions(c.id, OWNER)).current.variant, undefined, 'personalizada: sin variante');
      await structure.applyAcademicStructure(c.id, OWNER, { expectedCounter: await counter(c.id), contextVersion: c.v, choice: 'cursia', variant: 'cursia', confirmReplace: true, shape: { modules: 4, chaptersPerModule: 4 } });
      const o = await design.structureOptions(c.id, OWNER);
      eq([o.current.choice, o.current.variant, o.current.shape], ['cursia', 'cursia', [4, 4, 4, 4]], 'la pareja recomendada, con su variante');
    });
  } finally {
    if (ds) await ds.destroy().catch(() => {});
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
