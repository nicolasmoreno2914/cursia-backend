#!/usr/bin/env node
/* eslint-disable no-console */
// r70 · E1 — Extractor académico gratuito (cursia-academic-extractor v1) con el formato colombiano de microcurrículo
// («¿Qué aprenderá el estudiante…?», «Unidad de competencia», «Distribución temática y duración»). Sin IA, sin red, sin
// base: el PDF real del dueño (scripts/fixtures/microcurriculum/microcurriculo-ingles-grado-6.pdf) y variantes armadas.
//
//   X1  PDF real «Microcurrículo Inglés Grado 6»: 9 resultados (inferidos, con su regla), 6 unidades × 10 h, total 60 h,
//       nombre, nivel, competencia, objetivo general inferido; sin «as» (rótulo «Hor/as» partido) ni el pie de página
//   X2  calidad del PDF real: suficiente, sin «escaneado» ni lectura avanzada
//   X3  «Resultados de aprendizaje: RA1…» (formato de siempre): códigos y estado «found», nunca partidos
//   X4  DOCX con la misma estructura (pregunta + unidad de competencia + tabla Unidad temática | Contenidos | Horas)
//   X5  encabezados nuevos: «¿Qué será capaz de hacer…?», «Desempeños», «Logros», «Propósitos de formación»,
//       «Unidades de competencia», «Distribución temática», «Temas»
//   X6  documento con texto SIN lo esencial: partial=true, lo encontrado se dice y se conserva, sin «escaneado», sin
//       lectura avanzada; PDF sin texto: SCANNED + advancedMayHelp, partial=false
//   X7  «Duración | 60 horas» / «8 horas de trabajo del estudiante» son valores (no encabezados de tabla ni rótulos)
//   X8  splitProseOutcomes: sin anuncio no parte; sustantivos en -ar no abren un resultado
//   X9  0 llamadas de red
//
// Uso: node scripts/check-r70-extractor-formats.js [path/to/dist]   (después de npm run build)
'use strict';
const path = require('path');
const fs = require('fs');

const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  const net = require('net'); net.connect = deny('net.connect'); net.createConnection = deny('net.createConnection');
  const tls = require('tls'); tls.connect = deny('tls.connect');
  globalThis.fetch = deny('fetch');
}

const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const E = require(path.join(distRoot, 'modules/academic-context/extract/extractor.js'));
const Q = require(path.join(distRoot, 'modules/academic-context/extraction-quality.js'));
const V = require(path.join(distRoot, 'modules/academic-context/validate.js'));
const A = require(path.join(distRoot, 'modules/academic-context/academic-context.js'));
const PDFDocument = require('pdfkit');
const JSZip = require('jszip');

let ok = 0;
let bad = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { bad++; console.log(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || 'distinto'}: ${x} ≠ ${y}`); };
const read = async (name, data) => E.extractAcademicContext([{ name, data }]);
const txt = (lines) => Buffer.from(lines.join('\n'), 'utf8');
const unitsOf = (ctx) => ctx.units.map((u) => [u.title, u.hours]);

const REAL = fs.readFileSync(path.join(REPO, 'scripts/fixtures/microcurriculum/microcurriculo-ingles-grado-6.pdf'));
const EXPECTED_UNITS = [
  ['Hello! Getting to Know You', 10], ['My Family and Friends', 10], ['My School and My World', 10],
  ['My Daily Routine', 10], ['My Likes and Hobbies', 10], ['Let’s Communicate!', 10],
];
const EXPECTED_OUTCOMES = [
  'Comprender y utilizar expresiones básicas en inglés relacionadas con su vida cotidiana',
  'Presentarse y proporcionar información personal',
  'Identificar personas, objetos, lugares y actividades',
  'Comunicarse mediante oraciones sencillas en situaciones familiares y escolares',
  'Reconocer vocabulario fundamental',
  'Comprender textos cortos',
  'Formular y responder preguntas básicas',
  'Describir rutinas y preferencias',
  'Desarrollar habilidades iniciales de comprensión auditiva, lectura, escritura y expresión oral en inglés',
];

function blankPdf() {
  return new Promise((resolve) => {
    const d = new PDFDocument({ size: 'LETTER', margin: 0, info: { CreationDate: new Date(0) } });
    const ch = [];
    d.on('data', (x) => ch.push(x));
    d.on('end', () => resolve(Buffer.concat(ch)));
    d.rect(50, 50, 400, 300).fill('#888888'); // una «imagen» sin texto (un escaneo)
    d.end();
  });
}

(async () => {
  let real;
  await check('X1 PDF real «Inglés Grado 6»: resultados, unidades con horas, total y ficha', async () => {
    real = await read('Microcurriculo_Ingles_Grado_6.pdf', REAL);
    const c = real.context;
    eq(c.identity.subjectName.value, 'Inglés Básico – Grado Sexto', 'nombre');
    eq([c.identity.educationLevel.value && c.identity.educationLevel.value.level], ['secondary'], 'nivel');
    eq([c.hours.total.status, c.hours.total.value], ['found', 60], 'total de horas');
    eq(unitsOf(c), EXPECTED_UNITS, 'unidades con sus horas');
    eq(c.units.map((u) => u.contents.length), [1, 1, 1, 1, 1, 1], 'un contenido por fila');
    eq(c.units[0].contents[0].text, 'Saludos, presentaciones, alfabeto, números, información personal y verbo to be.', 'la celda partida en dos líneas es UN contenido');
    eq(c.outcomes.map((o) => o.text), EXPECTED_OUTCOMES, 'resultados');
    assert(c.outcomes.every((o) => o.status === 'inferred' && /cada capacidad/.test(o.basis || '')), 'resultados inferidos con su regla');
    eq(c.outcomes.map((o) => o.id), EXPECTED_OUTCOMES.map((_x, i) => `RA${i + 1}`), 'ids');
    eq(c.competencies.length, 1, 'la unidad de competencia es una competencia');
    assert(/^Comprender y utilizar estructuras gramaticales/.test(c.competencies[0].text), c.competencies[0].text);
    eq([c.identity.generalObjective.status, /Unidad de competencia/.test(c.identity.generalObjective.basis || '')], ['inferred', true], 'objetivo general inferido de la unidad de competencia');
    const all = JSON.stringify(c.units) + JSON.stringify(c.additionalInfo);
    assert(!/"as"|Microcurrículo ·/.test(all), 'ni el rótulo partido «as» ni el pie de página son datos');
    assert((c.additionalInfo.value || []).some((x) => /^Orientación curricular: propuesta formativa .* desempeño del estudiante\.$/.test(x)), 'la nota al pie de la tabla queda entera en «Información adicional»');
    assert((c.additionalInfo.value || []).includes('Grado: Sexto (6.º)'), 'grado');
    eq(A.validateAcademicContextShape(c), [], 'forma válida (se puede guardar)');
    assert(!V.validateAcademicContext(c).issues.some((i) => i.severity === 'error' || i.code === 'UNIT_HOURS_MISMATCH'), 'sin errores ni horas que no cuadran');
    eq(real.stats.providersCalled, 0, 'sin proveedores');
  });

  await check('X2 calidad del PDF real: suficiente, sin escaneo ni lectura avanzada', async () => {
    const q = Q.extractionQuality(real.context);
    eq([q.sufficient, q.issues, q.advancedMayHelp, q.partial, q.missing], [true, [], false, false, []], 'calidad');
    assert(q.found.includes('60 horas') && q.found.includes('6 unidades') && q.found.includes('9 resultados de aprendizaje'), q.found.join(', '));
  });

  await check('X3 «Resultados de aprendizaje: RA1…» (formato de siempre): códigos, «found», sin partir', async () => {
    const r = await read('ra.txt', txt([
      'Asignatura: Inglés Básico',
      'Resultados de aprendizaje',
      'RA1. Al finalizar, el estudiante podrá presentarse, describir su familia y comprender textos cortos.',
      'RA2. Formular y responder preguntas básicas sobre rutinas.',
      'Contenidos',
      'Unidad 1: Saludos (10 h)',
      '- Alfabeto y números',
      'Unidad 2: Familia (10 h)',
      '- Pronombres posesivos',
    ]));
    const c = r.context;
    eq(c.outcomes.map((o) => [o.id, o.status]), [['RA1', 'found'], ['RA2', 'found']], 'resultados');
    eq(unitsOf(c), [['Saludos', 10], ['Familia', 10]], 'unidades');
  });

  await check('X4 DOCX con la misma estructura (pregunta, unidad de competencia, tabla con «Horas»)', async () => {
    const wp = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    const wtc = (t) => `<w:tc>${t ? wp(t) : '<w:p/>'}</w:tc>`;
    const wtr = (...c) => `<w:tr>${c.map(wtc).join('')}</w:tr>`;
    const body = wp('Microcurrículo', 'Heading1')
      + `<w:tbl>${wtr('Nombre del curso', 'Inglés Básico – Grado Sexto')}${wtr('Nivel educativo', 'Educación Básica Secundaria')}${wtr('Duración', '60 horas')}</w:tbl>`
      + wp('2. ¿Qué aprenderá el estudiante al finalizar el curso?', 'Heading2')
      + wp('Al finalizar el curso, el estudiante estará en capacidad de comprender expresiones básicas, presentarse y proporcionar información personal, así como comunicarse mediante oraciones sencillas.')
      + wp('3. Unidad de competencia', 'Heading2')
      + wp('Comprender y utilizar estructuras gramaticales básicas del inglés para comunicarse en situaciones cotidianas.')
      + wp('4. Distribución temática y duración', 'Heading2')
      + `<w:tbl>${wtr('Unidad temática', 'Contenidos principales', 'Horas')}${wtr('1. Hello! Getting to Know You', 'Saludos, presentaciones y verbo to be.', '10')}${wtr('2. My Family and Friends', 'Familia y adjetivos posesivos.', '10')}${wtr('TOTAL', '', '20')}</w:tbl>`;
    const z = new JSZip();
    z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
    const r = await read('ingles.docx', await z.generateAsync({ type: 'nodebuffer' }));
    const c = r.context;
    eq(unitsOf(c), [['Hello! Getting to Know You', 10], ['My Family and Friends', 10]], 'unidades');
    eq(c.outcomes.map((o) => o.text), ['Comprender expresiones básicas', 'Presentarse y proporcionar información personal', 'Comunicarse mediante oraciones sencillas'], 'resultados');
    eq(c.competencies.length, 1, 'competencia');
    eq(c.hours.total.value, 60, 'total (la ficha manda; TOTAL 20 de la tabla queda como conflicto visible)');
    assert(c.conflicts.some((k) => k.path === 'hours.total'), 'el TOTAL distinto de la tabla es un conflicto, no se pisa');
    assert(Q.extractionQuality(c).sufficient, 'suficiente');
  });

  await check('X5 encabezados nuevos (pregunta, desempeños, logros, propósitos, unidades de competencia, temas)', async () => {
    const r = await read('variantes.txt', txt([
      'Nombre del curso: Matemáticas 7',
      'Propósitos de formación',
      'Desarrollar el pensamiento numérico de los estudiantes de séptimo grado.',
      '¿Qué será capaz de hacer el estudiante?',
      '- Resolver operaciones con números enteros.',
      '- Interpretar gráficas sencillas.',
      'Unidades de competencia',
      '- Usar el razonamiento matemático en problemas cotidianos.',
      'Distribución temática',
      'Unidad 1: Números enteros (20 h)',
      'Unidad 2: Estadística básica (20 h)',
    ]));
    const c = r.context;
    eq(c.identity.generalObjective.status, 'found', 'propósitos de formación = objetivo general');
    eq(c.outcomes.map((o) => [o.text, o.status]), [['Resolver operaciones con números enteros.', 'found'], ['Interpretar gráficas sencillas.', 'found']], 'resultados');
    eq(c.competencies.map((o) => o.text), ['Usar el razonamiento matemático en problemas cotidianos.'], 'competencias');
    eq(unitsOf(c), [['Números enteros', 20], ['Estadística básica', 20]], 'unidades');
    for (const h of ['Desempeños', 'Logros', 'Logros esperados', 'Indicadores de logro', '¿Qué aprenderán los estudiantes?']) {
      const x = await read('h.txt', txt([h, '- Identificar los saludos en inglés.', '- Describir su rutina diaria.']));
      eq(x.context.outcomes.length, 2, `«${h}» es la sección de resultados`);
    }
    const t = await read('temas.txt', txt(['Temas', 'Unidad 1: Saludos', '- Alfabeto']));
    eq(unitsOf(t.context), [['Saludos', null]], '«Temas» es la sección de contenidos');
  });

  await check('X6 texto sin lo esencial → parcial (sin «escaneado»); PDF sin texto → escaneo', async () => {
    const r = await read('ficha.pdf.txt', txt(['Nombre del curso: Inglés Básico', 'Nivel educativo: Educación Básica Secundaria', 'Duración: 60 horas', 'Este curso es para estudiantes de sexto grado.']));
    // Mismo contexto como si viniera de un PDF con texto (la calidad mira el tipo y los caracteres por página).
    const ctx = { ...r.context, documents: r.context.documents.map((d) => ({ ...d, mediaType: 'application/pdf', pages: 1, characters: 2000 })) };
    const q = Q.extractionQuality(ctx);
    eq([q.sufficient, q.partial, q.advancedMayHelp, q.issues.map((i) => i.code)], [false, true, false, ['MISSING_ESSENTIALS']], 'calidad parcial');
    eq(q.found, ['nombre del curso', 'nivel educativo', '60 horas'], 'lo encontrado');
    eq(q.missing, ['resultados de aprendizaje', 'unidades'], 'lo que falta');
    const msg = q.issues[0].message;
    assert(/encontramos: nombre del curso, nivel educativo, 60 horas/.test(msg) && /completarlos a mano/.test(msg) && !/escanead|avanzada/i.test(msg), msg);
    eq(A.validateAcademicContextShape(r.context), [], 'el borrador parcial tiene forma válida (se puede guardar)');
    const s = await read('escaneo.pdf', await blankPdf());
    const qs = Q.extractionQuality(s.context);
    eq([qs.sufficient, qs.partial, qs.advancedMayHelp, qs.issues.map((i) => i.code)], [false, false, true, ['SCANNED', 'MISSING_ESSENTIALS']], 'escaneo');
    assert(s.notes.some((n) => n.code === 'DOCUMENT_WITHOUT_TEXT'), 'nota de documento sin texto');
  });

  await check('X7 «Duración | 60 horas» y «8 horas de trabajo del estudiante» son valores', async () => {
    eq(E.isColumnHeaderRow({ text: 'Duración | 60 horas', cells: ['Duración', '60 horas'] }), false, 'fila clave | valor');
    eq(E.isColumnHeaderRow({ text: 'Unidad temática | Contenidos principales | Hor', cells: ['Unidad temática', 'Contenidos principales', 'Hor'] }), true, 'encabezado con «Hor» partido');
    eq(E.isHeaderFragment({ cells: ['Unidad temática', 'Contenidos principales', 'Hor'] }, { text: 'as' }), true, '«as» completa «Hor»');
    eq(E.isHeaderFragment({ cells: ['Unidad temática', 'Contenidos principales', 'Hor'] }, { text: 'Saludos' }), false, 'un dato no es parte del encabezado');
    const r = await read('dur.txt', txt(['Asignatura: Inglés', 'Duración', '8 horas de trabajo del estudiante.']));
    eq([r.context.hours.total.status, r.context.hours.total.value, r.context.hours.components.length], ['found', 8, 0], 'total, no un componente');
  });

  await check('X8 splitProseOutcomes: solo con anuncio y verbos en infinitivo', async () => {
    eq(E.splitProseOutcomes('El curso aborda saludos, familia y rutinas.'), null, 'sin anuncio no se parte');
    eq(E.splitProseOutcomes('El estudiante podrá ubicar su lugar en el mapa y describir su hogar familiar.'), ['Ubicar su lugar en el mapa', 'Describir su hogar familiar'], 'sustantivos en -ar no abren resultados');
    eq(E.splitProseOutcomes('El estudiante será capaz de leer.'), null, 'una sola capacidad no se parte');
  });

  await check('X9 0 llamadas de red', async () => { eq(netAttempts, [], 'red'); });

  console.log(`\n${ok} OK · ${bad} fallas`);
  process.exit(bad ? 1 : 0);
})();
