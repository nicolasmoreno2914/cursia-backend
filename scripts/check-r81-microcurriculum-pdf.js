#!/usr/bin/env node
/* eslint-disable */
// r81 · «Crear microcurrículo» — PDF (pdfkit) contra el código COMPILADO en dist/. USD 0: sin red, sin DB.
//
//   MP1  fixture universidad → PDF de más de una página; el texto extraíble (pdf-parse) trae las 12 secciones numeradas
//        en orden, la portada «MICROCURRÍCULO», el docente y el pie «Página x de y»
//   MP2  colegio (sin competencias) → 11 secciones, «Desempeños» en vez de «Resultados de aprendizaje», sin «Competencias»
//   MP3  determinista: mismo documento + misma fecha → mismos bytes; otra fecha → otros bytes
//   MP4  nota «Revisar» en la portada SOLO con issues (y con su código); bibliografía sugerida «verificar disponibilidad»
//   MP5  logo de la cuenta (bytes PNG) se acepta; textos fuera de WinAnsi no rompen el PDF
//
// Uso: node scripts/check-r81-microcurriculum-pdf.js [path/to/dist]
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
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${String((e && e.stack) || e).split('\n').slice(0, 5).join('\n   ')}`); }
}
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || ''}: esperado ${y}, encontrado ${x}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };

const A = D('modules/microcurriculum/answers.js');
const DOC = D('modules/microcurriculum/document.js');
const PDF = D('modules/microcurriculum/microcurriculum-pdf.js');
const LOGO = D('package/v3/libro-logo.js');

const FIX_DIR = path.join(REPO, 'scripts/fixtures/microcurriculum/r81');
const fixture = (k) => JSON.parse(fs.readFileSync(path.join(FIX_DIR, `${k}.json`), 'utf8'));
function docOf(k) {
  const f = fixture(k);
  const answers = A.normalizeAnswers(f.answers);
  return { answers, mc: DOC.documentFromGenerated(f.tool, answers), author: f.answers.references && f.answers.references.author };
}
async function textOf(buf) {
  const { PDFParse } = require('pdf-parse');
  const p = new PDFParse({ data: new Uint8Array(buf) });
  try { return (await p.getText()).text; } finally { await p.destroy().catch(() => {}); }
}
const DATE = new Date(Date.UTC(2026, 10, 1, 15, 0, 0));
const flat = (s) => s.replace(/\s+/g, ' ');

(async () => {
  const uni = docOf('universidad');
  const r1 = await PDF.renderMicrocurriculumPdf(uni.mc, { logo: null, author: uni.author, date: DATE, issues: [] });
  const t1 = flat(await textOf(r1.pdf));

  await check('MP1 universidad: > 1 página; 12 secciones numeradas en orden; portada, docente y pie', async () => {
    assert(r1.pages > 1, `páginas: ${r1.pages}`);
    assert(r1.pdf.slice(0, 5).toString() === '%PDF-', 'cabecera PDF');
    const titles = PDF.microcurriculumSectionTitles(uni.mc);
    eq(titles.length, 12, 'títulos');
    let at = 0;
    titles.forEach((title, i) => {
      const idx = t1.indexOf(`${i + 1} ${title}`, at);
      assert(idx >= 0, `falta «${i + 1} ${title}» (en orden)`);
      at = idx;
    });
    assert(t1.replace(/ /g, '').includes('MICROCURRÍCULO'), 'portada «MICROCURRÍCULO» (espaciado de letras)');
    for (const s of ['Finanzas Corporativas', 'Mg. Laura Pérez', 'Administración de Empresas', 'ADM-305', `Página 1 de ${r1.pages}`, `Página ${r1.pages} de ${r1.pages}`, '144 horas', 'Total 48 0 96 144', 'Total 100 %']) {
      assert(t1.includes(s), `falta «${s}»`);
    }
    assert(t1.includes('RA1') && t1.includes('Proyectar el flujo de caja'), 'resultados');
    assert(!/Revisar: quedan/.test(t1), 'sin issues no hay nota Revisar');
  });

  await check('MP2 colegio: sin competencias → 11 secciones; «Desempeños»; no aparece «Competencias»', async () => {
    const c = docOf('colegio');
    const r = await PDF.renderMicrocurriculumPdf(c.mc, { date: DATE, issues: [] });
    const t = flat(await textOf(r.pdf));
    const titles = PDF.microcurriculumSectionTitles(c.mc);
    eq(titles.length, 11);
    assert(t.includes('5 Desempeños') && !t.includes('Resultados de aprendizaje'), 'Desempeños');
    assert(!/\d+ Competencias/.test(t), 'sin sección de competencias');
    assert(t.includes('6 Unidades temáticas') && t.includes('11 Bibliografía'), 'renumeradas');
    assert(t.includes('Perfil del estudiante'), 'perfil');
  });

  await check('MP3 determinista: mismo documento y fecha → mismos bytes; otra fecha → bytes distintos', async () => {
    const again = await PDF.renderMicrocurriculumPdf(uni.mc, { logo: null, author: uni.author, date: DATE, issues: [] });
    assert(Buffer.compare(again.pdf, r1.pdf) === 0, 'bytes distintos con la misma entrada');
    const other = await PDF.renderMicrocurriculumPdf(uni.mc, { logo: null, author: uni.author, date: new Date(Date.UTC(2026, 10, 2)), issues: [] });
    assert(Buffer.compare(other.pdf, r1.pdf) !== 0, 'la fecha debe cambiar los bytes');
  });

  await check('MP4 con issues → nota «Revisar» en la portada con el código; sugeridas «verificar disponibilidad»', async () => {
    const issues = [{ code: 'V2', severity: 'error', message: 'Los porcentajes de evaluación suman 90 % (deben sumar 100 %).' }];
    const r = await PDF.renderMicrocurriculumPdf(uni.mc, { author: uni.author, date: DATE, issues });
    const t = flat(await textOf(r.pdf));
    assert(t.includes('Revisar: quedan comprobaciones sin resolver') && t.includes('V2 · Los porcentajes de evaluación suman 90 %'), 'nota');
    assert(t.includes('Sugerida por Cursia: verificar disponibilidad.'), 'sugerida marcada');
    const docentes = (t.match(/verificar disponibilidad/g) || []).length;
    eq(docentes, 1, 'solo la sugerida (la del docente no)');
  });

  await check('MP5 logo de la cuenta (PNG) aceptado; textos con emoji/símbolos fuera de WinAnsi no rompen el PDF', async () => {
    const png = LOGO.cursiaDefaultLogo().bytes;
    const c = docOf('corporativa');
    c.mc.description = `${c.mc.description} 🚀 ✓ → ≥`;
    const r = await PDF.renderMicrocurriculumPdf(c.mc, { logo: png, author: null, date: DATE, issues: [] });
    assert(r.pages >= 2, 'páginas');
    const t = flat(await textOf(r.pdf));
    assert(t.includes('Liderazgo de equipos remotos') && t.includes('participante'), 'contenido');
  });

  console.log(`\n${ok} OK, ${fail} fallidas`);
  process.exit(fail ? 1 : 0);
})();
