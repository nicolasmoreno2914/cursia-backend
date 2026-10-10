#!/usr/bin/env node
/* eslint-disable no-console */
// Documentos imperfectos (2026-10-10) — Cursia interpreta y normaliza lo que un cliente real entrega, sin pedirle un
// formato perfecto: EXTRAER → NORMALIZAR → RECONSTRUIR → VALIDAR → MOSTRAR (🟡 lo dudoso), nunca FALLAR → BLOQUEAR.
// Pruebas puras: sin proveedores, sin base, red bloqueada. Los PDF se arman con pdfkit poniendo cada texto en su
// posición (como los imprime un navegador: celdas que desbordan, pies con número de página, tablas partidas).
//
//   DI1  tabla con columnas mezcladas: la celda que desborda sobre la siguiente se parte en el borde de la columna
//   DI2  encabezado y pie de página repetidos (con número de página) se descartan; no hay contradicciones falsas
//   DI3  salto de página dentro de una tabla: la tabla sigue, su encabezado repetido no es un capítulo
//   DI4  módulos sin numeración («Módulo: título») y «Módulo 1» sin título con sus temas debajo
//   DI5  capítulos con numeración inconsistente: se conservan todos, en el orden del documento
//   DI6  texto dividido en varias líneas (celda partida y oración partida) = un solo dato
//   DI7  horas en rango (–, -, «a», «entre … y …») se conservan como rango; aproximadamente / mínimo / máximo
//   DI8  requisitos mezclados con contenido: ni la columna de recursos ni una oración que exige algo son temas
//   DI9  información administrativa (código, docente, créditos, fechas) no se vuelve requisito, tema ni resultado
//   DI10 contenido duplicado (tabla resumen + detalle): una unidad, cada tema una vez
//   DI11 estructura parcialmente definida: se conserva lo que hay; nada se inventa para completar
//   DI12 resultados en tabla: el encabezado, el pie de tabla y los títulos no son resultados; los códigos se conservan
//   DI13 «Asignatura — 40 horas» sigue siendo un documento de varias asignaturas; un rango NO lo es
//   DI14 texto cortado en el borde de la página: se usa y se marca 🟡 para confirmar (sin inventar el resto)
//   DI15 0 llamadas de red
//   DI16–DI21 (revisión independiente) PDF tipo Word, componentes de horas, «la plataforma» y artículos, datos de la
//        ficha, listas sin viñetas y celdas que ocupan varias columnas: lo normal no cambia
//
// Uso: node scripts/check-documentos-imperfectos.js [path/to/dist]   (después de npm run build)
'use strict';
const path = require('path');

const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  const net = require('net'); net.connect = deny('net.connect'); net.createConnection = deny('net.createConnection');
  const tls = require('tls'); tls.connect = deny('tls.connect');
  globalThis.fetch = deny('fetch');
}

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const E = require(path.join(distRoot, 'modules/academic-context/extract/extractor.js'));
const RX = require(path.join(distRoot, 'modules/academic-context/requirements/requirements-extractor.js'));
const PDFDocument = require('pdfkit');

let ok = 0;
let bad = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { bad++; console.log(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'falló'); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m || 'distinto'}: ${x} ≠ ${y}`); };

/**
 * PDF con textos en posición: pages = [[{ x, y, text, size?, width? }], …]. `width` fija el ancho de la caja (sin
 * cortar: el texto sale como un solo trozo, aunque desborde, igual que una celda de tabla impresa por un navegador).
 */
function pdfOf(pages, footer) {
  return new Promise((resolve) => {
    const d = new PDFDocument({ size: 'LETTER', margin: 0, info: { CreationDate: new Date(0) }, autoFirstPage: false });
    const ch = [];
    d.on('data', (x) => ch.push(x));
    d.on('end', () => resolve(Buffer.concat(ch)));
    pages.forEach((items, i) => {
      d.addPage({ size: 'LETTER', margin: 0 });
      for (const it of items) d.fontSize(it.size || 9).text(it.text, it.x, it.y, { lineBreak: false });
      if (footer) d.fontSize(7).text(footer.replace('{n}', String(i + 1)), 45, 760, { lineBreak: false }).text(`Página ${i + 1}`, 520, 760, { lineBreak: false });
    });
    d.end();
  });
}
const txt = (lines) => Buffer.from(lines.join('\n'), 'utf8');
const read = async (name, data) => E.extractAcademicContext([{ name, data }]);
const contentsOf = (ctx) => ctx.units.map((u) => [u.title, u.contents.map((c) => c.text)]);

(async () => {
  // Tabla de capítulos «Capítulo | Contenido principal | Recursos previstos», columnas en x = 80 / 131 / 386.
  const chapterTable = (y0, rows) => {
    const out = [{ x: 80, y: y0, text: 'Capítulo' }, { x: 131, y: y0, text: 'Contenido principal' }, { x: 386, y: y0, text: 'Recursos previstos' }];
    rows.forEach((r, i) => { const y = y0 + 20 * (i + 1); out.push({ x: 80, y, text: r[0] }); out.push({ x: 131, y, text: r[1] }); if (r[2]) out.push({ x: 386, y, text: r[2] }); });
    return out;
  };

  await check('DI1 tabla con columnas mezcladas: la celda que desborda se parte en el borde de la columna', async () => {
    // «…y respuesta en salud» es tan larga que pdfkit la dibuja encima de la columna de recursos: en el texto del PDF
    // queda pegada («salud2 videos…»). Las otras filas fijan dónde empieza la columna.
    const long = 'Conceptos fundamentales sobre violencia sexual y respuesta inicial en salud2 videos · 1 actividad H5P';
    const pdf = await pdfOf([[{ x: 51, y: 40, text: '1. Resultados de aprendizaje', size: 13 }, { x: 51, y: 60, text: 'RA1. Reconocer los conceptos fundamentales de la atención.' },
      { x: 51, y: 90, text: '2. Estructura académica', size: 13 }, { x: 51, y: 110, text: 'Módulo 1 · Fundamentos y derechos', size: 11 },
      ...chapterTable(130, [['1.1', long, null], ['1.2', 'Derechos y consentimiento', '2 videos · 1 actividad H5P'], ['1.3', 'Comunicación segura', '2 videos · 1 actividad H5P']])]]);
    const r = await read('tabla.pdf', pdf);
    eq(contentsOf(r.context), [['Fundamentos y derechos', ['Conceptos fundamentales sobre violencia sexual y respuesta inicial en salud', 'Derechos y consentimiento', 'Comunicación segura']]], 'contenidos sin la columna de recursos');
  });

  await check('DI2 encabezado y pie repetidos (con número de página): se descartan, sin contradicciones', async () => {
    const pdf = await pdfOf([
      [{ x: 51, y: 40, text: '1. Metodología', size: 13 }, { x: 51, y: 60, text: 'Aprendizaje basado en casos clínicos simulados con retroalimentación.' }],
      [{ x: 51, y: 40, text: 'El estudiante analiza situaciones y decide acciones seguras dentro de su rol.' }, { x: 51, y: 70, text: '2. Objetivo general', size: 13 }, { x: 51, y: 90, text: 'Fortalecer la atención inicial segura y humanizada.' }],
    ], 'Microcurrículo · Atención Integral en Salud');
    const r = await read('pies.pdf', pdf);
    assert(!/Página \d|Microcurrículo ·/.test(r.context.methodology.value || ''), r.context.methodology.value);
    assert(/Aprendizaje basado en casos/.test(r.context.methodology.value) && /decide acciones seguras/.test(r.context.methodology.value), r.context.methodology.value);
    eq(r.context.conflicts, [], 'sin contradicciones');
    assert(r.notes.some((n) => n.code === 'PAGE_FURNITURE_DROPPED'), 'se informa lo descartado');
  });

  await check('DI3 salto de página dentro de una tabla: la tabla sigue; su encabezado repetido no es un capítulo', async () => {
    const pdf = await pdfOf([
      [{ x: 51, y: 40, text: '1. Estructura', size: 13 }, { x: 51, y: 60, text: 'Módulo 1 · Valoración y apoyo inicial', size: 11 },
        ...chapterTable(80, [['1.1', 'Valoración inicial de riesgos', '1 video'], ['1.2', 'Apoyo inicial y cuidado', '1 video']])],
      [...chapterTable(40, [['1.3', 'Prevención según el caso', '1 video'], ['1.4', 'Rutas de atención', '1 video']])],
    ]);
    const r = await read('salto.pdf', pdf);
    eq(contentsOf(r.context), [['Valoración y apoyo inicial', ['Valoración inicial de riesgos', 'Apoyo inicial y cuidado', 'Prevención según el caso', 'Rutas de atención']]], 'los 4 capítulos en el mismo módulo');
  });

  await check('DI4 módulos sin numeración y «Módulo 1» sin título: se reconstruyen con sus temas', async () => {
    const a = await read('sin-numero.txt', txt(['Asignatura: Primeros auxilios', '', 'Módulo: Fundamentos de la atención', 'Conceptos básicos', 'Marco legal', '', 'Módulo: Atención en el lugar', 'Valoración primaria', 'Intervención inicial']));
    eq(contentsOf(a.context), [['Fundamentos de la atención', ['Conceptos básicos', 'Marco legal']], ['Atención en el lugar', ['Valoración primaria', 'Intervención inicial']]], 'sin número');
    const b = await read('sin-titulo.txt', txt(['Asignatura: Primeros auxilios', '', 'Módulo 1', 'Conceptos', 'Marco legal', 'Módulo 2', 'Atención', 'Intervención']));
    eq(contentsOf(b.context), [['Módulo 1', ['Conceptos', 'Marco legal']], ['Módulo 2', ['Atención', 'Intervención']]], 'sin título');
  });

  await check('DI5 capítulos con numeración inconsistente: todos, en el orden del documento', async () => {
    const r = await read('numeracion.txt', txt(['Asignatura: Seguridad del paciente', '', '8. Módulo 1 — Cultura de seguridad', '1.1 Conceptos de seguridad', '1.3 Reporte de eventos', '1.2 Barreras de seguridad', '9. Módulo 2 — Prácticas seguras', '2.1 Identificación correcta', '2.1 Higiene de manos']));
    eq(contentsOf(r.context), [['Cultura de seguridad', ['Conceptos de seguridad', 'Reporte de eventos', 'Barreras de seguridad']], ['Prácticas seguras', ['Identificación correcta', 'Higiene de manos']]], 'orden del documento, sin perder ni reordenar');
  });

  await check('DI6 texto dividido en varias líneas: una sola oración / una sola celda', async () => {
    const r = await read('partido.txt', txt(['Asignatura: Atención inicial', 'Prerrequisitos: conocimientos básicos de atención en salud y disposición para aplicar', 'protocolos institucionales vigentes.']));
    eq(r.context.learner.priorKnowledge.value, ['conocimientos básicos de atención en salud y disposición para aplicar protocolos institucionales vigentes.'], 'un solo conocimiento previo');
    // Celda partida en dos líneas dentro de una tabla de un PDF.
    const pdf = await pdfOf([[{ x: 51, y: 40, text: '1. Estructura', size: 13 }, { x: 51, y: 60, text: 'Módulo 1 · Fundamentos y derechos', size: 11 },
      { x: 80, y: 80, text: 'Capítulo' }, { x: 131, y: 80, text: 'Contenido principal' }, { x: 386, y: 80, text: 'Recursos' },
      { x: 80, y: 100, text: '1.1' }, { x: 131, y: 100, text: 'Derechos, dignidad, autonomía y' }, { x: 386, y: 100, text: '1 video' },
      { x: 131, y: 110, text: 'consentimiento informado' },
      { x: 80, y: 130, text: '1.2' }, { x: 131, y: 130, text: 'Comunicación segura' }, { x: 386, y: 130, text: '1 video' }]]);
    const p = await read('celda.pdf', pdf);
    eq(contentsOf(p.context), [['Fundamentos y derechos', ['Derechos, dignidad, autonomía y consentimiento informado', 'Comunicación segura']]], 'la celda partida es un solo contenido');
  });

  await check('DI7 horas en rango: se conserva el rango (nunca el extremo superior); aproximadamente / mínimo / máximo', async () => {
    for (const t of ['40–44 horas', '40 - 44 horas', '40-44 h', '40 a 44 horas', 'entre 40 y 44 horas']) {
      const s = E.hoursSpanOf(t);
      eq([s && s.min, s && s.max, s && s.value], [40, 44, 42], `«${t}»`);
    }
    eq(E.hoursSpanOf('48 horas'), { value: 48, raw: '48 horas' }, 'un número sigue siendo un número');
    eq([E.hoursSpanOf('Horas por módulo 13–15 h').min, E.hoursSpanOf('Cada módulo 13–15 h').max], [13, 15], 'por/cada módulo: rango');
    eq(E.hoursSpanOf('Semana 1 a 4 h').value, 4, '«Semana 1 a 4 h»: el 1 es la semana');
    const ctxOf = async (line) => (await read('h.txt', txt(['Asignatura: Curso', `Intensidad horaria total: ${line}`]))).context.hours.total;
    const r1 = await ctxOf('40–44 horas');
    eq([r1.value, r1.range, r1.status], [42, { min: 40, max: 44 }, 'inferred'], 'contexto: rango con meta en el punto medio');
    const reqOf = async (sentence) => {
      const r = await read('r.txt', txt(['Asignatura: Curso', '', '1. Requisitos institucionales', sentence]));
      return r.requirements.requirements.filter((q) => q.kind === 'target_hours').map((q) => [q.mode, q.value, q.valueMax ?? null]);
    };
    eq(await reqOf('El curso tendrá una duración de 40–44 horas de trabajo del estudiante.'), [['range', 40, 44]], 'rango (–)');
    eq(await reqOf('El curso tendrá una duración de 40 a 44 horas de trabajo del estudiante.'), [['range', 40, 44]], 'rango (a)');
    eq(await reqOf('El curso tendrá una duración de aproximadamente 40 horas de trabajo del estudiante.'), [['approx', 40, null]], 'aproximadamente');
    eq(await reqOf('El curso tendrá como mínimo 40 horas de trabajo del estudiante.'), [['min', 40, null]], 'mínimo');
    eq(await reqOf('El curso tendrá como máximo 44 horas de trabajo del estudiante.'), [['max', 44, null]], 'máximo');
  });

  await check('DI8 requisitos mezclados con contenido: ni los recursos de la tabla ni una oración que exige son temas', async () => {
    const r = await read('mezcla.txt', txt(['Asignatura: Atención inicial', '', '8. Módulo 1 — Fundamentos', '1.1 Conceptos fundamentales', 'Cada capítulo tendrá 2 videos de contenido.', '1.2 Derechos de las personas']));
    eq(contentsOf(r.context), [['Fundamentos', ['Conceptos fundamentales', 'Derechos de las personas']]], 'solo los temas');
    assert(r.requirements.requirements.some((q) => q.kind === 'videos' && q.value === 2), 'el requisito de videos se lee igual');
  });

  await check('DI9 información administrativa: no es requisito, tema ni resultado', async () => {
    const r = await read('admin.txt', txt(['Código: ENF-301', 'Asignatura: Cuidado de enfermería', 'Docente: Coordinación de Enfermería', 'Créditos: 3', 'Fecha de actualización: 15 de marzo de 2025', 'Versión 4 del documento', '', 'Resultados de aprendizaje', 'RA1. Aplicar el proceso de atención de enfermería.']));
    eq(r.context.outcomes.map((o) => o.id), ['RA1'], 'un resultado');
    eq(r.context.units, [], 'sin temas inventados');
    const active = r.requirements.requirements.filter((q) => q.active && q.kind !== 'target_hours');
    eq(active.map((q) => q.key), [], 'ningún requisito desde fechas, versiones ni códigos');
  });

  await check('DI10 contenido duplicado (tabla resumen + detalle): una unidad, cada tema una vez', async () => {
    const r = await read('duplicado.txt', txt(['Asignatura: Atención inicial', '', '7. Módulo 1 — Fundamentos', '1.1 Conceptos fundamentales', '1.2 Derechos', '8. Módulo 1 — Fundamentos', '1.1 Conceptos fundamentales', '1.2 Derechos', '1.3 Comunicación segura']));
    eq(contentsOf(r.context), [['Fundamentos', ['Conceptos fundamentales', 'Derechos', 'Comunicación segura']]], 'sin duplicar ni perder');
    assert(r.notes.some((n) => n.code === 'DUPLICATE_UNIT'), 'se informa');
  });

  await check('DI11 estructura parcialmente definida: se conserva lo que hay; nada se inventa', async () => {
    const r = await read('parcial.txt', txt(['Asignatura: Atención inicial', '', '1. Requisitos institucionales', 'El curso tendrá exactamente 3 módulos de contenido.', '', '8. Módulo 1 — Fundamentos', '1.1 Conceptos', '9. Módulo 2 — Valoración', '2.1 Valoración inicial']));
    eq(contentsOf(r.context), [['Fundamentos', ['Conceptos']], ['Valoración', ['Valoración inicial']]], 'solo los 2 módulos que trae');
    assert(r.requirements.requirements.some((q) => q.kind === 'modules' && q.value === 3 && q.active), 'el requisito de 3 módulos se conserva (el tercero se resuelve en el diseño, no se inventa aquí)');
  });

  await check('DI12 resultados en tabla: encabezado, pie de tabla y títulos no son resultados; los códigos del documento se conservan', async () => {
    const pdf = await pdfOf([[{ x: 51, y: 40, text: '4. Resultados de aprendizaje', size: 13 },
      { x: 81, y: 60, text: 'Código' }, { x: 120, y: 60, text: 'Resultado de aprendizaje' },
      { x: 81, y: 80, text: 'RA1' }, { x: 120, y: 80, text: 'Reconocer los conceptos fundamentales de la atención.' },
      { x: 81, y: 100, text: 'RA2' }, { x: 120, y: 100, text: 'Explicar la atención inicial sin revictimizar.' },
      { x: 81, y: 120, text: 'RA4' }, { x: 120, y: 120, text: 'Distinguir las responsabilidades del rol.' },
      { x: 51, y: 150, text: '5. Competencias', size: 13 }, { x: 51, y: 170, text: 'CO1. Atención humanizada.' }]]);
    const r = await read('ra.pdf', pdf);
    eq(r.context.outcomes.map((o) => [o.id, o.text]), [['RA1', 'Reconocer los conceptos fundamentales de la atención.'], ['RA2', 'Explicar la atención inicial sin revictimizar.'], ['RA4', 'Distinguir las responsabilidades del rol.']], 'códigos del documento, sin el encabezado');
    assert(E.isColumnHeaderRow({ text: 'Código Resultado de aprendizaje' }) && E.isColumnHeaderRow({ text: '', cells: ['Evaluación', 'Momento', 'Resultados principales'] }), 'encabezados');
    assert(!E.isColumnHeaderRow({ text: '', cells: ['Duración', '40–44 horas'] }) && !E.isColumnHeaderRow({ text: 'RA1 Reconocer los conceptos' }), 'un dato no es encabezado');
  });

  await check('DI13 «Asignatura — 40 horas» sigue siendo de varias asignaturas; un rango no', async () => {
    const multi = await read('malla.txt', txt(['Plan de estudios', 'Matemáticas básicas — 64 horas', 'Física general — 48 horas', 'Química — 48 horas']));
    eq(multi.requirements.multiCourse, true, 'malla con varias asignaturas');
    const one = await read('rango.txt', txt(['Asignatura: Atención inicial', 'Duración: 40–44 horas', 'Módulo 1: 13–15 h', 'Módulo 2: 13–15 h', 'Total: 40–44 h']));
    eq(one.requirements.multiCourse, false, 'rangos de un mismo curso');
    eq([RX.subjectHoursRow('Asignatura — 40 horas'), RX.subjectHoursRow('Duración: 40–44 horas'), RX.subjectHoursRow('Módulo 1 | 13–15 h'), RX.subjectHoursRow('Total | 40–44 h')],
      [{ subject: 'Asignatura', hours: 40, dash: true }, null, null, null], 'fila de asignatura vs. rangos');
  });

  await check('DI14 texto cortado en el borde de la página: se usa y se marca 🟡 (sin inventar el resto)', async () => {
    const pdf = await pdfOf([[{ x: 51, y: 40, text: '4. Resultados de aprendizaje', size: 13 },
      { x: 81, y: 60, text: 'RA1' }, { x: 120, y: 60, text: 'Reconocer los conceptos fundamentales, derechos y principios de atención relacionados con las violencias sexuales en el contexto' },
      { x: 81, y: 80, text: 'RA2' }, { x: 120, y: 80, text: 'Explicar la atención inicial.' }]]);
    const r = await read('cortado.pdf', pdf);
    const [ra1, ra2] = r.context.outcomes;
    assert(ra1 && /^Reconocer los conceptos/.test(ra1.text) && !!ra1.review, JSON.stringify(ra1));
    assert(ra2 && !ra2.review, 'un texto completo no pide revisión');
  });

  // ── Revisión independiente: lo que NO debe cambiar en documentos normales ──
  await check('DI16 PDF tipo Word: títulos numerados y viñetas con tabulación siguen siendo texto (no filas de tabla)', async () => {
    const pdf = await pdfOf([[{ x: 50, y: 40, text: 'Asignatura: Primeros auxilios' },
      { x: 50, y: 70, text: '1.' }, { x: 72, y: 70, text: 'Resultados de aprendizaje', size: 12 },
      { x: 60, y: 90, text: '•' }, { x: 80, y: 90, text: 'Aplicar el protocolo de atención inicial.' },
      { x: 60, y: 105, text: '•' }, { x: 80, y: 105, text: 'Reconocer los signos de alarma.' },
      { x: 50, y: 135, text: '2.' }, { x: 72, y: 135, text: 'Metodología', size: 12 }, { x: 50, y: 155, text: 'Aprendizaje basado en casos con simulación.' }]]);
    const r = await read('word.pdf', pdf);
    eq(r.context.outcomes.map((o) => o.text), ['Aplicar el protocolo de atención inicial.', 'Reconocer los signos de alarma.'], 'resultados sin «—»');
    eq(r.context.methodology.value, 'Aprendizaje basado en casos con simulación.', 'metodología');
  });

  await check('DI17 tabla de componentes de horas de UN curso: no es un documento de varias asignaturas', async () => {
    const r = await read('componentes.txt', txt(['Asignatura: Atención inicial', 'Acompañamiento docente | 16 h', 'Estudio independiente | 32 h', 'Prácticas - 16 horas', '', '1. Requisitos institucionales', 'El curso tendrá exactamente 4 módulos de contenido.']));
    eq(r.requirements.multiCourse, false, 'un solo curso');
    assert(r.requirements.requirements.some((q) => q.kind === 'modules' && q.value === 4 && q.active), 'el requisito sigue activo');
  });

  await check('DI18 «la plataforma» y los artículos no borran requisitos reales', async () => {
    const reqs = async (sentence) => (await read('r.txt', txt(['Asignatura: Curso', '', '1. Requisitos institucionales', sentence]))).requirements.requirements.filter((q) => q.active).map((q) => [q.kind, q.value]);
    eq(await reqs('El curso se desarrollará en la plataforma Moodle y tendrá exactamente 4 módulos.'), [['modules', 4]], 'plataforma');
    eq(await reqs('Se deben desarrollar las 3 evaluaciones parciales.'), [['evaluations', 3]], 'artículo + verbo');
    eq(await reqs('Las competencias atraviesan los tres módulos del curso.'), [], 'referencia a lo ya definido');
    eq(await reqs('No debe asumirse como cumplible si la plataforma solo puede producir 1 video por capítulo.'), [], 'nota sobre la capacidad de la plataforma');
  });

  await check('DI19 datos de la ficha («Módulo: Virtual», «Unidad: Facultad…») no son módulos del curso', async () => {
    const r = await read('ficha.txt', txt(['Asignatura: Atención inicial', 'Unidad: Facultad de Ciencias de la Salud', 'Programa: Enfermería', 'Módulo: Virtual', 'Duración del curso', '48 horas']));
    eq(r.context.units, [], 'sin unidades inventadas');
  });

  await check('DI20 una lista sin viñetas en minúscula sigue siendo una lista', async () => {
    const r = await read('lista.txt', txt(['Asignatura: Atención inicial', 'Resultados de aprendizaje', 'Aplicar el protocolo de atención inicial', 'reconocer los signos de alarma', 'comunicar el caso al equipo']));
    eq(r.context.outcomes.length, 3, 'tres resultados');
  });

  await check('DI21 una celda que ocupa varias columnas no se parte a mitad de frase', async () => {
    const pdf = await pdfOf([[{ x: 51, y: 40, text: 'Contenidos', size: 13 },
      { x: 80, y: 60, text: 'Unidad' }, { x: 131, y: 60, text: 'Tema' }, { x: 300, y: 60, text: 'Recursos' },
      { x: 80, y: 80, text: '1' }, { x: 131, y: 80, text: 'Conceptos básicos' }, { x: 300, y: 80, text: '1 video' },
      { x: 80, y: 100, text: '2' }, { x: 131, y: 100, text: 'Marco legal' }, { x: 300, y: 100, text: '1 video' },
      { x: 80, y: 120, text: 'Nota' }, { x: 131, y: 120, text: 'Todos los temas se trabajan con casos simulados y retroalimentación inmediata del tutor' }]]);
    const lines = (await require(path.join(distRoot, 'modules/academic-context/extract/text-sources.js')).readDocument(pdf, 'x.pdf')).lines.map((l) => l.text);
    assert(lines.includes('Nota | Todos los temas se trabajan con casos simulados y retroalimentación inmediata del tutor'), JSON.stringify(lines));
  });

  await check('DI15 0 llamadas de red', async () => { eq(netAttempts, [], 'red'); });

  console.log(`\n${ok} OK · ${bad} fallas`);
  process.exit(bad ? 1 : 0);
})();
