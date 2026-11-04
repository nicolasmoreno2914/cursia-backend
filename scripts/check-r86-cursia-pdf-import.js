#!/usr/bin/env node
/* eslint-disable */
// r86 · Importar un PDF de microcurrículo generado por Cursia — contra el código COMPILADO en dist/. USD 0: sin red, sin DB.
//
//   CP1  ida y vuelta (5 tipos de institución): PDF con copia adjunta → extractAcademicContext = toAcademicContext(mc)
//        exacto; nota CURSIA_MICROCURRICULUM_EXACT; 0 líneas leídas; sin proveedores
//   CP2  la copia NO lleva learners.specialNeeds (sensible, no visible en el PDF); sí lo que usa el puente
//   CP3  copia alterada (huella), de otro esquema, con forma inválida o demasiado grande → se ignora: misma lectura que el
//        PDF sin copia (nunca falla la importación)
//   CP4  PDF de Cursia SIN copia (descargado antes de r86): ningún rótulo de la plantilla queda como resultado
//        («Verbo · Bloom», «6 — Competencias», «Horas (D / P / A) — …»); resultados, unidades, horas y vínculos correctos;
//        sin conflictos
//   CP5  rótulos de la plantilla = los del renderizador (cada uno aparece en un PDF real: la prueba avisa si cambian)
//   CP6  documentos que no son de Cursia: sin firma → sin cambios (un «Criterio» o «Verbo · Bloom» en un sílabo ajeno se
//        lee igual que antes; la firma sola, sin secciones de la plantilla, no basta)
//   CP7  determinismo: mismo documento + fecha → mismos bytes con copia; las páginas (texto) son idénticas con y sin copia
//   CP8  PDF sin copia + microcurrículo guardado del docente: nombre y contenido coinciden → contexto exacto (nota
//        CURSIA_MICROCURRICULUM_MATCHED); otro nombre, documento editado, dos candidatos distintos o un fallo del
//        buscador → lectura del texto
//   CP9  la búsqueda del servicio se acota al docente (owner_id = $1 con su id) y un fallo de la DB no rompe la lectura
//   CP10 varios documentos: el PDF de Cursia exacto se fusiona con otro documento como cualquier otro
//
// Uso: node scripts/check-r86-cursia-pdf-import.js [path/to/dist]
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.resolve(process.argv[2] || path.join(REPO, 'dist'));
const D = (rel) => {
  try { return require(path.join(DIST, rel)); } catch (e) { console.error(`❌ No se pudo cargar ${rel} (¿corriste "npm run build"?): ${e.message}`); process.exit(1); }
};
let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n   ')}`); }
}
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y.slice(0, 400)}, encontrado ${x.slice(0, 400)}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };

const A = D('modules/microcurriculum/answers.js');
const DOC = D('modules/microcurriculum/document.js');
const PDF = D('modules/microcurriculum/microcurriculum-pdf.js');
const PAY = D('modules/microcurriculum/pdf-payload.js');
const LBL = D('modules/microcurriculum/pdf-template-labels.js');
const TAC = D('modules/microcurriculum/to-academic-context.js');
const EX = D('modules/academic-context/extract/extractor.js');
const CT = D('modules/academic-context/extract/cursia-template.js');
const VAL = D('modules/academic-context/academic-context.js');

const FIX_DIR = path.join(REPO, 'scripts/fixtures/microcurriculum/r81');
const KINDS = ['universidad', 'colegio', 'etdh', 'tecnica', 'corporativa'];
const fixture = (k) => JSON.parse(fs.readFileSync(path.join(FIX_DIR, `${k}.json`), 'utf8'));
function docOf(k) {
  const f = fixture(k);
  const answers = A.normalizeAnswers(f.answers);
  return { answers, mc: DOC.documentFromGenerated(f.tool, answers), author: f.answers.references && f.answers.references.author };
}
const DATE = new Date(Date.UTC(2026, 10, 1, 15, 0, 0));
const MCID = '5b0c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
const render = (d, embed = true, extra = {}) => PDF.renderMicrocurriculumPdf(d.mc, { logo: null, author: d.author, date: DATE, issues: [], ...(embed ? { embed: { microcurriculumId: MCID, answers: d.answers } } : {}), ...extra });
async function textOf(buf) {
  const { PDFParse } = require(require.resolve('pdf-parse', { paths: [REPO] }));
  const p = new PDFParse({ data: new Uint8Array(buf) });
  try { return (await p.getText()).text; } finally { await p.destroy().catch(() => {}); }
}
const flat = (s) => s.replace(/\s+/g, ' ');
const core = (c) => ({ o: c.outcomes.map((x) => [x.id, x.text]), u: c.units.map((x) => [x.id, x.title, x.hours, x.outcomeIds]), e: c.evaluation.map((x) => [x.weightPct, x.outcomeIds]), h: c.hours.total.value });

(async () => {
  await check('CP1 ida y vuelta (5 tipos): PDF con copia → contexto = toAcademicContext(mc) exacto; nota EXACT; 0 líneas; USD 0', async () => {
    for (const k of KINDS) {
      const d = docOf(k);
      const r = await render(d);
      const x = await EX.extractAcademicContext([{ name: `microcurriculo-${k}.pdf`, data: r.pdf }]);
      const want = TAC.toAcademicContext(d.mc, PAY.embeddableAnswers(d.answers));
      eq(x.context, want, `${k}: contexto`);
      assert(x.notes.some((n) => n.code === 'CURSIA_MICROCURRICULUM_EXACT'), `${k}: nota EXACT`);
      assert(!x.notes.some((n) => n.code === 'PAGE_FURNITURE_DROPPED'), `${k}: no se leyó el texto`);
      eq(x.stats.lines, 0, `${k}: líneas`);
      eq(x.stats.providersCalled, 0, `${k}: proveedores`);
      eq(x.requirements.requirements.length, 0, `${k}: requisitos`);
      assert(x.stats.sectionsFound.includes('outcomes') && x.stats.sectionsFound.includes('contents'), `${k}: secciones`);
      eq(x.context.outcomes.length, d.mc.outcomes.length, `${k}: resultados`);
      eq(x.context.units.length, d.mc.units.length, `${k}: unidades`);
    }
  });

  await check('CP2 la copia adjunta no lleva learners.specialNeeds; sí horas, calendario, contexto y notas; id del microcurrículo', async () => {
    const d = docOf('etdh');
    assert(d.answers.learners && d.answers.learners.specialNeeds, 'el fixture trae specialNeeds');
    const r = await render(d);
    const e = await PAY.readMicrocurriculumPdfPayload(r.pdf);
    assert(e, 'copia legible');
    assert(!(e.answers.learners && e.answers.learners.specialNeeds), 'specialNeeds no viaja');
    eq(e.answers.time, d.answers.time, 'time');
    eq(e.microcurriculumId, MCID, 'id');
    eq(e.mc, d.mc, 'documento exacto');
    const raw = r.pdf.toString('latin1');
    assert(!raw.includes('baja visión') && !raw.includes('baja visi'), 'el texto sensible no está en los bytes');
    const u = docOf('universidad');
    const eu = await PAY.readMicrocurriculumPdfPayload((await render(u)).pdf);
    eq(eu.answers.learners, { context: 'Bogotá, Colombia' }, 'contexto del grupo');
    // Sin specialNeeds, el contexto importado es el mismo que el del puente «Crear curso con este microcurrículo».
    eq(TAC.toAcademicContext(eu.mc, eu.answers), TAC.toAcademicContext(u.mc, u.answers), 'igual al puente');
  });

  await check('CP3 copia alterada / otro esquema / forma inválida / demasiado grande → se ignora y se lee el texto como sin copia', async () => {
    const d = docOf('universidad');
    const plain = await EX.extractAcademicContext([{ name: 'u.pdf', data: (await render(d, false)).pdf }]);
    const orig = PAY.buildMicrocurriculumPdfPayload;
    const variants = {
      huella: (mc, a, id) => { const env = JSON.parse(orig(mc, a, id).toString('utf8')); env.json = env.json.replace('Finanzas Corporativas', 'Finanzas Alteradas'); return Buffer.from(JSON.stringify(env)); },
      esquema: (mc, a, id) => { const env = JSON.parse(orig(mc, a, id).toString('utf8')); env.schema = 'cursia-microcurriculum/9'; return Buffer.from(JSON.stringify(env)); },
      forma: (mc, a, id) => orig({ ...mc, outcomes: [{ id: 'RA1', text: 5 }] }, a, id),
      vacia: (mc, a, id) => orig({ ...mc, units: [{ ...mc.units[0], id: '' }, ...mc.units.slice(1)] }, a, id), // forma ok, contexto inválido
      grande: (mc, a, id) => orig({ ...mc, resources: [...mc.resources, 'x'.repeat(PAY.MC_PDF_MAX_BYTES)] }, a, id),
      basura: () => Buffer.from('no es json'),
    };
    try {
      for (const [k, fn] of Object.entries(variants)) {
        PAY.buildMicrocurriculumPdfPayload = fn;
        const r = await render(d);
        assert(r.pdf.length > 1000, `${k}: pdf`);
        const x = await EX.extractAcademicContext([{ name: 'u.pdf', data: r.pdf }]);
        assert(!x.notes.some((n) => /^CURSIA_MICROCURRICULUM_/.test(n.code)), `${k}: no debe usar la copia`);
        eq(core(x.context), core(plain.context), `${k}: misma lectura que sin copia`);
      }
    } finally { PAY.buildMicrocurriculumPdfPayload = orig; }
    assert(PAY.parseMicrocurriculumPdfPayload(Buffer.alloc(0)) === null && PAY.parseMicrocurriculumPdfPayload(Buffer.from('{}')) === null, 'parse nulo');
    eq(PAY.microcurriculumShapeProblems(d.mc), [], 'forma válida del fixture');
  });

  await check('CP4 PDF de Cursia sin copia: sin rótulos de la plantilla como resultados; resultados, unidades, horas, vínculos; sin conflictos', async () => {
    for (const k of KINDS) {
      const d = docOf(k);
      const x = await EX.extractAcademicContext([{ name: `${k}.pdf`, data: (await render(d, false)).pdf }]);
      const c = x.context;
      for (const o of c.outcomes) assert(!CT.isCursiaTemplateLabel(o.text), `${k}: rótulo como resultado «${o.text}»`);
      eq(c.outcomes.map((o) => o.id), d.mc.outcomes.map((o) => o.id), `${k}: ids`);
      c.outcomes.forEach((o, i) => assert(o.text.replace(/\s+/g, ' ').startsWith(d.mc.outcomes[i].text.slice(0, 40)), `${k}: ${o.id} «${o.text.slice(0, 60)}»`));
      eq(c.competencies.length, d.mc.competencies.length, `${k}: competencias`);
      eq(c.units.map((u) => u.title), d.mc.units.map((u) => u.title), `${k}: unidades`);
      eq(c.units.map((u) => u.hours), d.mc.units.map((u) => u.hours.contact + u.hours.practice + u.hours.autonomous), `${k}: horas por unidad`);
      eq(c.units.map((u) => [...u.outcomeIds].sort()), d.mc.units.map((u) => [...u.outcomeIds].sort()), `${k}: vínculos de unidades`);
      eq(c.hours.total.value, d.mc.totalHours, `${k}: total`);
      eq(c.evaluation.map((e) => e.weightPct), d.mc.evaluation.map((e) => e.percent), `${k}: evaluación`);
      eq(c.conflicts.map((x) => x.path), [], `${k}: conflictos`);
    }
    for (const t of ['Verbo · Bloom', 'Criterio', 'Id', '6 — Competencias', '7 — Unidades temáticas', 'Horas (D / P / A) — 2,5 / 2,5 / 2,5', 'Distribución de horas', 'Semana', 'Finanzas Corporativas — Página 3 de 6']) {
      assert(CT.isCursiaTemplateLabel(t), `rótulo «${t}»`);
    }
    for (const t of ['Analizar textos narrativos con conectores', 'Redactar párrafos cohesionados, usando conectores y ortografía', 'Competencias ciudadanas en el aula']) {
      assert(!CT.isCursiaTemplateLabel(t), `no es rótulo «${t}»`);
    }
  });

  await check('CP5 cada rótulo de la plantilla aparece en un PDF real del renderizador', async () => {
    let all = '';
    for (const k of KINDS) all += flat(await textOf((await render(docOf(k), false)).pdf));
    const e = docOf('etdh');
    e.mc.resources = []; e.mc.bibliography = [];
    all += flat(await textOf((await render(e, false, { issues: [{ code: 'V2', severity: 'error', message: 'x' }] })).pdf));
    const nos = all.replace(/ /g, '');
    const L = LBL.microcurriculumTemplateLabels();
    for (const lab of [...L.sections, ...L.columns, ...L.rows, ...L.subheadings, ...L.fixed, L.signature]) {
      assert(all.includes(lab) || nos.includes(lab.replace(/ /g, '')), `el PDF no trae «${lab}»`);
    }
  });

  await check('CP6 documentos que no son de Cursia: sin firma → sin cambios; la firma sola no basta', async () => {
    const lines = (arr) => arr.map((t, i) => (Array.isArray(t) ? { text: t.join(' '), cells: t, page: 1, line: i + 1 } : { text: t, page: 1, line: i + 1 }));
    const foreign = lines(['Sílabo de Lengua', ['5', 'Resultados de aprendizaje'], ['6', 'Competencias'], ['7', 'Unidades temáticas'], 'Criterio', 'Verbo · Bloom']);
    assert(!CT.isCursiaMicrocurriculumText(foreign), 'sin la línea de portada no es de Cursia');
    assert(!CT.isCursiaMicrocurriculumText(lines(['Preparado con Cursia · Microcurrículo', 'Resultados de aprendizaje', 'Unidad 1'])), 'firma sin secciones numeradas');
    assert(CT.isCursiaMicrocurriculumText(lines(['Preparado con Cursia · Microcurrículo', ['1', 'Identificación'], ['5', 'Resultados de aprendizaje'], ['7', 'Unidades temáticas']])), 'plantilla');
    // Extracción de un sílabo ajeno (Markdown y PDF): un «Criterio» suelto en sus resultados se conserva como hasta ahora.
    const md = ['# Sílabo de Lengua', '## Resultados de aprendizaje', '- RA1 Analizar textos narrativos.', '- RA2 Verbo · Bloom', '## Contenidos', '- Unidad 1: Narrativa'].join('\n');
    const x = await EX.extractAcademicContext([{ name: 'silabo.md', data: Buffer.from(md, 'utf8') }]);
    eq(x.context.outcomes.map((o) => o.text), ['Analizar textos narrativos.', 'Verbo · Bloom'], 'sílabo ajeno sin cambios');
    const PDFDocument = require(require.resolve('pdfkit', { paths: [REPO] }));
    const pdf = await new Promise((res) => {
      const p = new PDFDocument({ info: { CreationDate: DATE } }); const ch = []; p.on('data', (b) => ch.push(b)); p.on('end', () => res(Buffer.concat(ch)));
      p.fontSize(16).text('Resultados de aprendizaje'); p.fontSize(10).text('RA1 Analizar textos narrativos con criterio.'); p.text('RA2 Verbo · Bloom'); p.end();
    });
    const y = await EX.extractAcademicContext([{ name: 'ajeno.pdf', data: pdf }]);
    assert(!y.notes.some((n) => /^CURSIA_/.test(n.code)), 'sin notas de Cursia');
    assert(y.context.outcomes.some((o) => o.text === 'Verbo · Bloom'), 'un PDF ajeno no pasa por el filtro de la plantilla');
    assert(await PAY.readMicrocurriculumPdfPayload(pdf) === null, 'sin copia');
  });

  await check('CP7 determinismo: mismos bytes con copia; el texto de las páginas es idéntico con y sin copia', async () => {
    const d = docOf('universidad');
    const a = await render(d); const b = await render(d);
    assert(Buffer.compare(a.pdf, b.pdf) === 0, 'bytes distintos con la misma entrada');
    const plain = await render(d, false);
    eq(a.pages, plain.pages, 'páginas');
    eq(await textOf(a.pdf), await textOf(plain.pdf), 'texto visible');
    const other = await PDF.renderMicrocurriculumPdf(d.mc, { logo: null, author: d.author, date: new Date(Date.UTC(2026, 10, 2)), issues: [], embed: { microcurriculumId: MCID, answers: d.answers } });
    assert(Buffer.compare(other.pdf, a.pdf) !== 0, 'otra fecha → otros bytes');
  });

  await check('CP8 PDF sin copia + microcurrículo guardado del docente: coincide → exacto (MATCHED); si no, lectura del texto', async () => {
    const d = docOf('colegio');
    const legacy = (await render(d, false)).pdf;
    const row = { id: MCID, document: d.mc, answers: d.answers };
    const resolver = (rows) => async (hint) => { const h = CT.pickCursiaMicrocurriculum(rows, hint); return h ? { mc: h.document, answers: h.answers, microcurriculumId: h.id } : null; };
    const x = await EX.extractAcademicContext([{ name: 'c.pdf', data: legacy }], { resolveCursiaMicrocurriculum: resolver([row]) });
    eq(x.context, TAC.toAcademicContext(d.mc, d.answers), 'contexto exacto del guardado');
    assert(x.notes.some((n) => n.code === 'CURSIA_MICROCURRICULUM_MATCHED'), 'nota MATCHED');
    const plain = await EX.extractAcademicContext([{ name: 'c.pdf', data: legacy }]);
    const cases = {
      'otro nombre': [{ ...row, document: { ...d.mc, identification: { ...d.mc.identification, courseName: 'Otra materia' } } }],
      editado: [{ ...row, document: { ...d.mc, outcomes: d.mc.outcomes.map((o) => ({ ...o, text: `Otro resultado distinto número ${o.id}` })), units: d.mc.units.map((u) => ({ ...u, title: `Unidad renombrada ${u.id}` })) } }],
      ambiguo: [row, { ...row, id: '00000000-0000-4000-8000-000000000001', document: { ...d.mc, description: 'otra versión' } }],
      ninguno: [],
    };
    for (const [k, rows] of Object.entries(cases)) {
      const y = await EX.extractAcademicContext([{ name: 'c.pdf', data: legacy }], { resolveCursiaMicrocurriculum: resolver(rows) });
      assert(!y.notes.some((n) => n.code === 'CURSIA_MICROCURRICULUM_MATCHED'), `${k}: no debe coincidir`);
      eq(core(y.context), core(plain.context), `${k}: lectura del texto`);
    }
    const z = await EX.extractAcademicContext([{ name: 'c.pdf', data: legacy }], { resolveCursiaMicrocurriculum: async () => { throw new Error('db caída'); } });
    eq(core(z.context), core(plain.context), 'fallo del buscador → lectura del texto');
    // Dos copias idénticas del mismo documento no son ambiguas.
    const same = CT.pickCursiaMicrocurriculum([row, { ...row, id: '00000000-0000-4000-8000-000000000002' }], { courseName: d.mc.identification.courseName, text: flat(await textOf(legacy)) });
    assert(same && same.id === MCID, 'duplicado idéntico');
  });

  await check('CP9 servicio: la búsqueda se acota al docente (owner_id = $1) y un fallo de la DB devuelve null', async () => {
    const SVC = D('modules/academic-context/academic-context.service.js');
    const d = docOf('universidad');
    const calls = [];
    const ds = { query: async (sql, params) => { calls.push({ sql, params }); return [{ id: MCID, answers: d.answers, document: d.mc }, { id: 'x', answers: {}, document: { broken: true } }]; } };
    const svc = new SVC.AcademicContextService(ds, {}, undefined, { transcribe: async () => { throw new Error('no'); } });
    const legacy = (await render(d, false)).pdf;
    const hint = { courseName: d.mc.identification.courseName, text: flat(await textOf(legacy)) };
    const hit = await svc.ownerMicrocurriculum('owner-123', hint);
    assert(hit && hit.microcurriculumId === MCID, 'encontrado');
    eq(calls.length, 1, 'una consulta');
    assert(/from public\.microcurricula where owner_id = \$1/.test(calls[0].sql), `SQL acotado: ${calls[0].sql}`);
    eq(calls[0].params, ['owner-123'], 'parámetros');
    const bad = new SVC.AcademicContextService({ query: async () => { throw new Error('relation does not exist'); } }, {}, undefined, { transcribe: async () => null });
    eq(await bad.ownerMicrocurriculum('owner-123', hint), null, 'fallo → null');
  });

  await check('CP10 varios documentos: el PDF exacto de Cursia se fusiona con otro documento (sus resultados primero)', async () => {
    const d = docOf('tecnica');
    const md = ['# Anexo', '## Bibliografía', '- Kurose, J. (2021). Redes de computadoras.'].join('\n');
    const x = await EX.extractAcademicContext([{ name: 'mc.pdf', data: (await render(d)).pdf }, { name: 'anexo.md', data: Buffer.from(md, 'utf8') }]);
    eq(x.context.outcomes.map((o) => o.text), TAC.toAcademicContext(d.mc, d.answers).outcomes.map((o) => o.text), 'resultados del microcurrículo');
    eq(x.context.documents.map((doc) => doc.id), ['D1', 'D2'], 'documentos');
    eq(x.context.documents[0].extractor.id, 'cursia-microcurriculum', 'D1 es el microcurrículo');
    assert(x.context.bibliography.some((b) => /Kurose/.test(b.text)), 'bibliografía del anexo');
  });

  console.log(`\n${ok} OK, ${fail} fallidas`);
  process.exit(fail ? 1 : 0);
})();
