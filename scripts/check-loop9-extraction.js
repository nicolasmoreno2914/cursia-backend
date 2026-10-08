#!/usr/bin/env node
/**
 * LOOP 9 (auditoría de readiness para el piloto) — lectura de microcurrículos y requisitos. Sin red, sin base.
 *   LX1 una sección no modelada y numerada a continuación («5. Estructura del curso») cierra la anterior: no se suma un RA6
 *   LX2 los resultados numerados («1. …», «2. …») y las unidades con estilo de encabezado (Markdown «#») NO se cortan
 *   LX3 «incluye / contiene / contempla» fija el curso solo si el sujeto es el curso o una de sus partes
 *   LX4 trampas: artículos, capítulos de libro, páginas, códigos, precios, horas del experto, ejemplos, texto genérico,
 *       «curso estándar», condicionales, pesos y opciones sin elegir NO son requisitos; Cursia nunca inventa uno obligatorio
 *   LX5 un choque del documento se explica con palabras (nunca la clave interna «target_hours@course»)
 *
 *   node scripts/check-loop9-extraction.js   (requiere npm run build)
 */
const path = require('path');
const REPO = path.resolve(__dirname, '..');
const D = (p) => require(path.join(REPO, 'dist', p));
const E = D('modules/academic-context/extract/extractor.js');
const X = D('modules/academic-context/requirements/requirements-extractor.js');
const T = D('modules/academic-context/extract/text-sources.js');

let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
const ctxOf = async (text, name = 'doc.txt') => (await E.extractAcademicContext([{ name, data: Buffer.from(text, 'utf8') }])).context;
const reqs = (text, mt = 'text/plain') => {
  const x = X.extractRequirements(T.readText(Buffer.from(text, 'utf8'), mt).lines);
  return { x, req: X.requirementsFor(x, {}).filter((r) => r.obligation === 'required').map((r) => `${r.kind}=${r.value}`) };
};

(async () => {
  await check('LX1 «5. Estructura del curso» (sección no modelada, numeración 4 → 5) cierra «Resultados»: 5 RA, sin RA6', async () => {
    const c = await ctxOf(['1. Descripción', 'Curso de seguridad.', '4. Resultados de aprendizaje', 'RA1. Identificar peligros del área.', 'RA2. Evaluar riesgos con una matriz.',
      '5. Estructura del curso', 'El curso tendrá 4 módulos con 5 capítulos cada uno.', '6. Evaluación', 'Parcial 1 — 30 %'].join('\n'));
    eq(c.outcomes.map((o) => o.id), ['RA1', 'RA2'], 'resultados');
  });

  await check('LX2 resultados numerados («1. …», «5. …») y unidades con «#» dentro de «Contenidos» no se cortan', async () => {
    const c1 = await ctxOf(['4. Resultados de aprendizaje', '1. Identificar los peligros del área de trabajo.', '2. Evaluar los riesgos con una matriz.', '3. Aplicar la jerarquía de controles.',
      '4. Investigar incidentes con análisis de causas.', '5. Liderar la prevención con el equipo.', '6. Comunicar el riesgo en el turno.'].join('\n'));
    eq(c1.outcomes.length, 6, 'seis resultados numerados (el «5.» no es un encabezado: la sección numera sus ítems)');
    const md = ['# Contenidos', '## Unidad 1: Fundamentos del costo', '- Elementos del costo', '- Clasificación', '## Unidad 2: Costeo por órdenes', '- Hoja de costos', '# Evaluación', '- Parcial — 30 %'].join('\n');
    const c2 = await ctxOf(md, 'doc.md');
    assert(c2.units.length === 2, `dos unidades con estilo de encabezado (Markdown) dentro de «Contenidos»: ${c2.units.length}`);
  });

  await check('LX3 «incluye»: con el curso o sus partes como sujeto, sí; bibliografía y otros sujetos, no', async () => {
    eq(reqs('Estructura\nCada módulo incluye 1 Actividad de Aplicación.').req, ['application_activities=1'], 'cada módulo incluye');
    eq(reqs('El curso incluye 2 videos por capítulo.').req, ['videos=2'], 'el curso incluye');
    eq(reqs('La bibliografía incluye 3 capítulos del libro de García.').req, [], 'bibliografía');
    eq(reqs('La bibliografía de cada módulo incluye 3 capítulos del libro.').req, [], 'bibliografía de cada módulo (el sujeto abre la oración)');
    eq(reqs('El kit del estudiante incluye 4 videos de bienvenida.').req, [], 'otro sujeto');
  });

  await check('LX4 trampas: nada de esto es un requisito obligatorio', async () => {
    const traps = {
      articulo: 'Marco legal\nDecreto 1072 de 2015, artículo 2.2.4.6.8 y Resolución 0312 de 2019, artículo 16.',
      libro: 'Bibliografía\nGarcía, J. (2014). Contabilidad de costos. McGraw-Hill. Capítulos 3 a 5, páginas 45-60.',
      codigo: 'Código: CON-204\nVersión 3\nSemestre IV',
      precio: 'Se reconocerá al experto un pago de 2.500.000 por el diseño de 4 módulos.',
      horas_experto: 'El docente experto dedicará 40 horas al diseño del curso.',
      ejemplo: 'Por ejemplo, un curso de 3 módulos y 12 videos puede servir de referencia.',
      generico: 'En general, los cursos virtuales tienen entre 3 y 5 módulos.',
      estandar: 'Nuestro curso estándar de Cursia tiene 3 módulos de 3 capítulos.',
      condicional: 'Si el curso es presencial, tendrá 2 evaluaciones parciales.',
      pesos: 'La evaluación final vale 40 %.',
      semanas: 'Semana 3: módulo 2, capítulo 4.',
      componentes: 'Horas de acompañamiento docente: 32 horas\nHoras de trabajo autónomo: 32 horas',
    };
    for (const [k, t] of Object.entries(traps)) eq(reqs(t).req, [], k);
    const rec = reqs('Se recomienda incluir 2 videos por capítulo.').x.requirements;
    eq(rec.map((r) => r.obligation), ['recommended'], 'una recomendación no es obligatoria');
    const alt = reqs('Opciones de formato\nOpción S: 3 módulos de 3 capítulos (20 a 22 horas)\nOpción M: 3 módulos de 4 capítulos (40 a 44 horas)');
    eq(X.requirementsFor(alt.x, {}).length, 0, 'alternativas S/M/L sin elegir: no se aplica ninguna (nunca se suman)');
  });

  await check('LX5 un choque del documento se explica con palabras', async () => {
    const h = reqs('Intensidad horaria total: 64 horas\nDuración: el curso tendrá 48 horas.').x.conflicts;
    assert(h.length === 1 && /sobre las horas de trabajo del estudiante/.test(h[0].message) && !/@/.test(h[0].message), JSON.stringify(h));
    const m = reqs('El curso tendrá 3 módulos.\nEl curso tendrá 4 módulos con 5 capítulos cada uno.').x.conflicts;
    assert(m.length >= 1 && m.every((c) => !/@/.test(c.message)) && /la cantidad de módulos/.test(m[0].message), JSON.stringify(m));
  });

  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})();
