#!/usr/bin/env node
/* eslint-disable no-console */
// r73 · UX-9 · Clasificación educativa y coherencia del contexto del pedido. USD 0: sin proveedores, sin base, red bloqueada.
//
//   E1  caso real producción #87 / staging #1672 («Inglés Básico – Grado Sexto», contexto «Universitario» inferido):
//       con el fixture del curso Y con el PDF real leído por el extractor gratis → Cursia corrige a Educación Básica
//       Secundaria, grado 6.º (11–12 años), sin registro universitario; el nivel del curso es 'secondary'
//   E2  tabla de niveles (nombre / documento / elección del usuario) → etapa, nivel del motor y acción
//       (auto = corrige lo inferido · warn = respeta al usuario y avisa · ask = una pregunta · none = coherente)
//   E3  idempotencia: con la corrección aplicada no hay nada más que corregir
//   E4  grado y edades: «6.º grado», «Grado: Sexto (6.º)», «grado 11»; «90 grados» / «atención primaria» no son nivel
//   E5  ida y vuelta de los textos del pedido (educationLevelFromBrief / contextLevelOf / alineación con el snapshot:
//       «Educación Básica Secundaria — …» ya NO se reescribe como «Bachillerato» ni cae en 'basic')
//   E6  registro: tono «Técnico y preciso» inferido para grado 3 → se propone uno cercano; «Avanzado» en un colegio → aviso
//   E7  0 llamadas de red
//
// Uso: node scripts/check-r73-education-level.js [path/to/dist]   (después de npm run build)
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
const load = (rel) => require(path.join(distRoot, rel));
const CF = load('modules/course-facts/course-facts.js');
const A = load('modules/academic-context/index.js');
let EL = null;
try { EL = load('modules/course-facts/education-level.js'); } catch (e) { EL = null; }
const C87 = require('./fixtures/r72/course-87.json');
const PDF6 = fs.readFileSync(path.join(REPO, 'scripts/fixtures/microcurriculum/microcurriculo-ingles-grado-6.pdf'));

let passes = 0;
let failures = 0;
const rows = [];
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const A1 = JSON.stringify(a); const B1 = JSON.stringify(b); if (A1 !== B1) throw new Error(`${m}: esperado ${B1}, encontrado ${A1}`); };

const UNIV = 'Universitario — estudiantes de pregrado universitario, con rigor académico y pensamiento crítico';
const TONE = 'Conversacional y cercano, como un mentor con ejemplos cotidianos';
const brief = (fields) => ({ briefVersion: 1, fields, updatedAt: '2026-10-25T00:00:00.000Z' });
const facts = (fields, academic, extra) => CF.resolveCourseFacts(Object.assign({
  courseTitle: fields.nombre || null, institutionId: null, brief: brief(fields), academic: academic ? { version: 1, context: academic } : null,
  pedagogy: null, derivation: null, suggested: null, proposedHours: null,
}, extra || {}));
const txtDoc = async (name, lines) => (await A.extractAcademicContext([{ name, data: Buffer.from(lines.join('\n'), 'utf8') }])).context;
const prof = (f) => {
  const p = f.educationProfile;
  if (!p) throw new Error('facts.educationProfile no existe (código anterior a r73: nadie compara el contexto con el curso)');
  return p;
};

(async () => {
  // ── E1 · #87 / #1672 ──
  await check('E1a #87 (fixture de producción): «Universitario» inferido + documento grado 6 → corrige a Educación Básica Secundaria, grado 6.º', async () => {
    const f = facts(C87.brief, C87.academic);
    const p = prof(f);
    rows.push(['#87 Inglés Básico – Grado Sexto + PDF grado 6 (contexto inferido «Universitario»)', p]);
    eq(p.action, 'auto', 'acción');
    eq(p.detected && p.detected.stage, 'basica_secundaria', 'etapa');
    eq(p.detected.grade, 6, 'grado');
    eq(p.detected.ages, [11, 12], 'edades');
    eq(p.detected.source, 'document', 'fuente');
    assert(/^Educación Básica Secundaria — estudiantes de grado 6\.º \(aprox\. 11–12 años\)/.test(p.proposal.contexto), `contexto propuesto: ${p.proposal.contexto}`);
    assert(!/rigor académico|pensamiento crítico|pregrado|universitari/i.test(p.proposal.contexto), 'sin registro universitario');
    assert(/grado 6\.º/.test(p.message) && /universitario/i.test(p.message), `mensaje: ${p.message}`);
    eq(f.educationLevel, { value: 'secondary', source: 'document' }, 'nivel del curso');
    eq(CF.educationLevelFromBrief(p.proposal.contexto), 'secondary', 'el texto propuesto se lee como secundaria');
  });
  await check('E1b PDF real «Microcurriculo_Ingles_Grado_6.pdf» por el extractor gratis → misma corrección', async () => {
    const ctx = (await A.extractAcademicContext([{ name: 'Microcurriculo_Ingles_Grado_6.pdf', data: PDF6 }])).context;
    const p = prof(facts({ nombre: 'Inglés Básico – Grado Sexto', contexto: UNIV, nivel: 'Básico — sin conocimientos previos', tono: TONE, pais: 'Colombia', inferidos: 'tono,pais,contexto,nivel' }, ctx));
    eq([p.action, p.detected && p.detected.stage, p.detected && p.detected.grade], ['auto', 'basica_secundaria', 6], 'acción / etapa / grado');
  });

  // ── E2 · tabla de niveles ──
  const T = [
    // [caso, campos del pedido, documento (líneas txt) o null, esperado {action, stage, level, grade}]
    ['Matemáticas Grado 3 (nombre)', { nombre: 'Matemáticas Grado 3', contexto: UNIV, inferidos: 'contexto,tono,pais,nivel' }, null, { action: 'auto', stage: 'primaria', level: 'basic', grade: 3 }],
    ['Física Grado 11 (nombre)', { nombre: 'Física Grado 11', contexto: UNIV, inferidos: 'contexto' }, null, { action: 'auto', stage: 'media', level: 'secondary', grade: 11 }],
    ['Técnico en Sistemas', { nombre: 'Técnico en Sistemas', contexto: UNIV, inferidos: 'contexto' }, null, { action: 'auto', stage: 'tecnico', level: 'technical', grade: null }],
    ['Tecnología en Gestión', { nombre: 'Tecnología en Gestión', contexto: UNIV, inferidos: 'contexto' }, null, { action: 'auto', stage: 'tecnologo', level: 'technical', grade: null }],
    ['Cálculo I – Ingeniería (pregrado)', { nombre: 'Cálculo I – Ingeniería (pregrado)', contexto: UNIV, inferidos: 'contexto' }, null, { action: 'none', stage: 'pregrado', level: 'university', grade: null }],
    ['Especialización en Gerencia', { nombre: 'Especialización en Gerencia', contexto: UNIV, inferidos: 'contexto' }, null, { action: 'auto', stage: 'posgrado', level: 'university', grade: null }],
    ['Excel para auxiliares administrativos (corporativo)', { nombre: 'Excel para auxiliares administrativos', contexto: UNIV, inferidos: 'contexto' }, null, { action: 'auto', stage: 'corporativo', level: 'professional', grade: null }],
    ['Sin señales («Fotografía digital») → pregunta', { nombre: 'Fotografía digital', contexto: UNIV, inferidos: 'contexto' }, null, { action: 'ask', stage: null, level: null, grade: null }],
    ['Conflicto: nombre grado 6 + el usuario eligió Universitario → se respeta y se avisa', { nombre: 'Inglés grado 6', contexto: UNIV }, null, { action: 'warn', stage: 'basica_secundaria', level: 'university', grade: 6 }],
    ['Documento «Nivel educativo: Educación Media» + «Grado: 10»', { nombre: 'Química', contexto: UNIV, inferidos: 'contexto' }, ['Nombre del curso: Química', 'Nivel educativo: Educación Media', 'Grado: 10'], { action: 'auto', stage: 'media', level: 'secondary', grade: 10 }],
    ['Documento «Pregrado» + nombre «Grado 6» (señales explícitas que chocan) → pregunta', { nombre: 'Biología Grado 6', contexto: UNIV, inferidos: 'contexto' }, ['Nombre del curso: Biología', 'Nivel de formación: Pregrado'], { action: 'ask', stage: 'pregrado', level: 'university', grade: null }],
    ['Bachillerato elegido por el usuario + grado 6 → coherente', { nombre: 'Biología para bachillerato grado 6', contexto: 'Bachillerato — estudiantes de secundaria y media (grado 6° a 11°), con lenguaje claro, ejemplos concretos y actividades dinámicas' }, null, { action: 'none', stage: 'basica_secundaria', level: 'secondary', grade: 6 }],
    ['Bachillerato inferido + grado 6 → se precisa el grado', { nombre: 'Biología para bachillerato grado 6', contexto: 'Bachillerato — estudiantes de secundaria y media (grado 6° a 11°), con lenguaje claro, ejemplos concretos y actividades dinámicas', inferidos: 'contexto' }, null, { action: 'auto', stage: 'basica_secundaria', level: 'secondary', grade: 6 }],
    ['Diplomado para docentes de primaria → corporativo (no primaria)', { nombre: 'Diplomado en evaluación para docentes de primaria', contexto: UNIV, inferidos: 'contexto' }, null, { action: 'auto', stage: 'corporativo', level: 'professional', grade: null }],
    ['«Atención primaria en salud» no es primaria', { nombre: 'Atención primaria en salud', contexto: UNIV, inferidos: 'contexto' }, null, { action: 'ask', stage: null, level: null, grade: null }],
    ['Edades en el documento («estudiantes de 8 a 9 años»)', { nombre: 'Ciencias naturales', contexto: UNIV, inferidos: 'contexto' }, ['Nombre del curso: Ciencias naturales', 'Perfil del estudiante: estudiantes de 8 a 9 años que inician la lectura científica.'], { action: 'auto', stage: 'primaria', level: 'basic', grade: null }],
    ['Sin contexto (vacío) + «Grado 6.º» → completa', { nombre: 'Sociales 6.º grado' }, null, { action: 'auto', stage: 'basica_secundaria', level: 'secondary', grade: 6 }],
    ['Sin señales y elegido por el usuario → nada que preguntar', { nombre: 'Fotografía digital', contexto: 'Corporativo — profesionales en ejercicio dentro de una organización, con enfoque práctico y aplicación inmediata' }, null, { action: 'none', stage: null, level: 'professional', grade: null }],
  ];
  for (const [name, fields, docLines, exp] of T) {
    await check(`E2 ${name}`, async () => {
      const ctx = docLines ? await txtDoc('micro.txt', docLines) : null;
      const f = facts(fields, ctx);
      const p = prof(f);
      rows.push([name, p, f]);
      eq(p.action, exp.action, 'acción');
      eq(p.detected ? p.detected.stage : null, exp.stage, 'etapa detectada');
      eq(p.detected ? p.detected.grade : null, exp.grade, 'grado');
      if (exp.level !== null) eq(f.educationLevel.value, exp.level, 'nivel del curso (facts.educationLevel)');
      if (p.action === 'auto') {
        assert(p.proposal && p.proposal.contexto && p.proposal.contexto !== fields.contexto, 'propone un contexto distinto');
        eq(CF.educationLevelFromBrief(p.proposal.contexto), exp.level, 'el texto propuesto vuelve al mismo nivel');
        if (['primaria', 'basica_secundaria', 'media'].includes(exp.stage)) assert(!/rigor académico|pensamiento crítico|universitari/i.test(p.proposal.contexto), 'sin registro universitario');
      }
      if (p.action === 'warn') {
        eq(p.current.source, 'user', 'la elección es del usuario');
        assert(/Mantenemos tu elección/.test(p.message), `aviso: ${p.message}`);
        eq(p.proposal.stage, exp.stage, 'alternativa coherente');
      }
      if (p.action === 'ask') {
        assert(p.question && p.question.options.length >= 2 && /¿Para quién es el curso\?/.test(p.question.text), 'una pregunta con opciones');
        assert(p.question.why, 'con la razón de la sugerencia');
        if (exp.stage) eq(p.question.suggestion, exp.stage, 'sugerencia');
      }
    });
  }

  // ── E3 · idempotencia ──
  await check('E3 con la corrección aplicada (inferida) no queda nada por corregir; y con «Deshacer» (usuario) solo se avisa', async () => {
    const p1 = prof(facts(C87.brief, C87.academic));
    const fixed = Object.assign({}, C87.brief, { contexto: p1.proposal.contexto });
    eq(prof(facts(fixed, C87.academic)).action, 'none', 'tras corregir');
    const undone = Object.assign({}, C87.brief, { inferidos: 'tono,pais,nivel,nombre,sector' }); // «Deshacer» = decisión del docente
    eq(prof(facts(undone, C87.academic)).action, 'warn', 'tras deshacer');
  });

  // ── E4 · grado y edades ──
  await check('E4 grado / edades / falsos positivos', async () => {
    if (!EL) throw new Error('education-level.js no existe');
    const g = [['6.º grado', 6], ['Grado: Sexto (6.º)', 6], ['grado 11', 11], ['Grado Sexto', 6], ['tercer grado', 3], ['undécimo grado', 11], ['ángulos de 90 grados', null], ['sube 5 grados la temperatura', null], ['ciclo 6.º–7.º', null], ['Grado 12', null]];
    for (const [t, n] of g) eq(EL.gradeOf(t), n, `gradeOf(${t})`);
    eq(EL.agesOf('niños entre 8 y 9 años'), [8, 9], 'edades');
    eq(EL.agesOf('profesionales con 5 años de experiencia'), null, 'experiencia no es edad');
    eq(EL.stageSignalOf('Lengua Extranjera – Inglés'), null, 'el área no es nivel');
    eq(EL.stageSignalOf('Dibujo técnico de planos'), null, '«técnico» adjetivo no es nivel');
  });

  // ── E5 · ida y vuelta de los textos del pedido ──
  await check('E5 educationLevelFromBrief / contextLevelOf / alineación con el snapshot', async () => {
    const t = (st, g) => EL.contextoForStage(st, g || null, g ? EL.agesOfGrade(g) : null);
    eq(CF.educationLevelFromBrief(t('primaria', 3)), 'basic', 'primaria');
    eq(CF.educationLevelFromBrief(t('basica_secundaria', 6)), 'secondary', 'básica secundaria');
    eq(CF.educationLevelFromBrief(t('media', 11)), 'secondary', 'media');
    eq(CF.educationLevelFromBrief(t('tecnologo')), 'technical', 'tecnólogo');
    eq(CF.educationLevelFromBrief(UNIV), 'university', 'universitario');
    eq(CF.educationLevelFromBrief('Educación básica — primeros niveles de escolaridad'), 'basic', 'texto anterior de básica');
    eq(CF.contextLevelOf(t('basica_secundaria', 6)), 'secondary', 'contextLevelOf ya no cae en basic');
    const ctx = { contexto: t('basica_secundaria', 6), nivel: 'Básico — sin conocimientos previos' };
    eq(CF.alignCourseContextWithSnapshot(ctx, { educationLevel: 'secondary', priorKnowledge: 'none' }).changed, [], 'el grado 6 no se reescribe como «Bachillerato»');
    eq(CF.alignCourseContextWithSnapshot({ contexto: UNIV, nivel: ctx.nivel }, { educationLevel: 'secondary' }).changed, ['contexto'], 'universitario sí se alinea');
  });

  // ── E6 · registro ──
  await check('E6 tono inferido «Técnico y preciso» para grado 3 → tono cercano; «Avanzado» en un colegio → aviso', async () => {
    const p = prof(facts({ nombre: 'Matemáticas Grado 3', contexto: UNIV, tono: 'Técnico y preciso, con terminología del sector', nivel: 'Avanzado — ya trabaja en el área', inferidos: 'contexto,tono' }, null));
    eq(p.proposal.tono, TONE, 'tono propuesto');
    assert(p.register.length === 2, `avisos de registro: ${JSON.stringify(p.register)}`);
    const p2 = prof(facts({ nombre: 'Matemáticas Grado 3', contexto: UNIV, tono: 'Técnico y preciso, con terminología del sector', inferidos: 'contexto' }, null));
    eq(p2.proposal.tono, null, 'un tono elegido por el usuario no se toca');
  });

  await check('E7 0 llamadas de red', async () => { eq(netAttempts, [], 'red'); });

  // Tabla (para el informe).
  console.log('\nCaso | acción | detectado | contexto propuesto');
  for (const [name, p] of rows) {
    const d = p.detected;
    console.log(`${name} | ${p.action} | ${d ? `${d.stage}${d.grade ? ` g${d.grade}` : ''} (${d.source})` : '—'} | ${p.proposal ? p.proposal.contexto.split(':')[0] : p.question ? `pregunta (sugiere ${p.question.suggestion || '—'})` : '—'}`);
  }
  console.log(`\n${passes} ok, ${failures} con fallas`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
