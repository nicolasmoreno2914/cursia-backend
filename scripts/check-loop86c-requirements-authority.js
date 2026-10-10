#!/usr/bin/env node
/* eslint-disable */
// LOOP 8.6C · Los requisitos del documento tienen autoridad sobre «Cursia recomienda» (controlada). Contra dist/. USD 0.
// Jerarquía: requisito obligatorio del documento → decisión explícita del docente → Cursia recomienda → por defecto.
// Documentos SINTÉTICOS (escritos aquí). Ningún proveedor.
//
// Parte pura:
//   RC1 requisitos → restricciones: capítulos por módulo / estructura, video en cada capítulo, Actividades de Aplicación
//       por módulo y en el curso; las recomendaciones y lo aproximado NO restringen; una decisión del docente quita la
//       restricción de su campo
//   RC2 horas del documento: exacto, rango (la propuesta llevada dentro), mínimo, máximo, recomendado (sugerencia); una
//       lectura con confianza media («Revisa esta lectura») nunca tiene autoridad
//   RC3 distribuidor: completa el mínimo de capítulos con PROPUESTOS (práctica primero, D1), nunca pasa del máximo aunque
//       falten horas, video en todos los capítulos de contenido (lo fijado manda), exactamente N Actividades de Aplicación
//       por módulo; sin restricciones el resultado es IDÉNTICO al de antes
//   RC4 Verificación: cumple → ok; decisión del docente → «Excepción al requisito del documento» (advertencia); lo que
//       Cursia no puede resolver → conflicto CRÍTICO con su causa (parciales vs módulos, horas vs estructura, dos requisitos
//       del documento que chocan); lo que Cursia no puede producir (dos videos por capítulo) → excepción (LOOP 9); por revisar (unidades) → info
//   RC10 documentos reales (bugs anteriores que destapó 8.6C): un documento con tres o más valores largos distintos del
//        mismo dato (metodología, descripción) se lee sin TEXT_TOO_LONG; un documento con más de 12 resultados de
//        aprendizaje no rompe «Cursia recomienda» (el asistente admite 12 por lista)
// Parte DB (Postgres 16 desechable; --pure-only la salta):
//   RC5 BTO S/M/L: sin elegir, nada restringe; con M: horas 40–44, 4 capítulos por módulo (propuestos), «Usar este diseño»
//       aplica con la MISMA huella y después todo cumple; S y L restringen solo lo suyo; nunca se suman
//   RC6 excepción del docente: «Menos video» contra «1 video por capítulo» no se revierte: queda registrada, Verificación
//       la muestra como excepción y «Usar» aplica igual; «Volver al requisito» la quita
//   RC7 conflictos que Cursia no resuelve sola (4 módulos exigidos y el curso tiene 3, 3 parciales con 4 módulos, dos
//       videos por capítulo): críticos en Verificación con su causa; la generación NO se bloquea en el servidor
//   RC8 horas del docente contra el documento: se respetan y quedan como excepción
//   RC9 escenario completo del pedido: 4 módulos · 5 capítulos por módulo · 64 h · 1 Actividad de Aplicación por módulo ·
//       3 parciales + 1 final · 2 videos por capítulo → Cursia diseña dentro de lo que puede y explica lo que no
//
// Uso: node scripts/check-loop86c-requirements-authority.js [--pure-only] [path/to/dist]
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
  try { return require(path.join(distRoot, rel)); } catch (err) { console.error(`❌ No se pudo cargar ${rel} (¿npm run build?): ${err.message}`); process.exit(1); }
}
const RX = loadDist('modules/academic-context/requirements/requirements-extractor.js');
const DR = loadDist('modules/academic-context/requirements/document-requirements.js');
const RA = loadDist('modules/academic-context/requirements/requirement-authority.js');
const TS = loadDist('modules/academic-context/extract/text-sources.js');
const ST = loadDist('modules/study-time/index.js');
const SNAP = loadDist('modules/course-blueprints/blueprint-snapshot.js');
const F = require('./lib/academic-fixtures.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); } catch (err) { failed++; console.log(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n   ') : err}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };

const extract = (text) => RX.extractRequirements(TS.readText(Buffer.from(text, 'utf8'), 'text/plain').lines, 'D1');
const required = (text, sel = {}) => RX.requirementsFor(extract(text), sel).filter((r) => r.obligation === 'required');
const SML = 'Tamaños de curso\nTAMAÑO HORAS ESTRUCTURA\nS\n1 h/sem\n20–22 h 3 módulos\n× 3 capítulos\nM\n2 h/sem\n40–44 h 3 módulos\n× 4 capítulos\nL\n3 h/sem\n60–66 h 4 módulos\n× 5 capítulos\nLa institución elegirá un tamaño por asignatura.';
const FULL = 'El curso deberá tener 4 módulos con 5 capítulos por módulo. Cada capítulo tendrá 2 videos. Cada módulo tendrá una Actividad de Aplicación. Se realizarán 3 evaluaciones parciales y 1 evaluación final. La intensidad horaria total será de 64 horas.';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function snapshot(shape, { video = false, practiceLast = false } = {}) {
  const course = { id: 1, title: 'Curso', finalExam: true, activityEngine: 'h5p', reviewCards: false, academicContext: null };
  const modules = shape.map((_, i) => ({ id: uuid(100 + i), position: i, title: `Módulo ${i + 1}`, objective: null, description: null, exam_enabled: true }));
  const chapters = [];
  modules.forEach((m, mi) => Array.from({ length: shape[mi] }).forEach((_, ci) => chapters.push({
    id: uuid(1000 + mi * 20 + ci), module_id: m.id, position: ci, title: `Cap ${mi + 1}.${ci + 1}`, objective: 'Aplicar lo visto en un caso', description: null,
    video_enabled: video, activity_enabled: true, ...(practiceLast && ci === shape[mi] - 1 ? { chapter_kind: 'practice' } : {}),
  })));
  return SNAP.buildBlueprintSnapshotV2(course, modules, chapters);
}
const dist = (shape, targetHours, extra = {}) => ST.distributeCourseHours({ snapshot: snapshot(shape, extra.snap || {}), rules: null, targetHours, preferences: extra.preferences || { audiovisual: 'recommended' }, pins: extra.pins || null, requirements: extra.requirements || null });
const perModule = (d) => d.modules.map((m) => m.chapters.length);
const aaPerModule = (d) => d.modules.map((m) => m.chapters.filter((c) => c.applicationMinutes).length);

(async () => {
  console.log('Parte pura');

  await check('RC1 requisitos → restricciones; recomendaciones y aproximados no restringen; decisión del docente quita la restricción', async () => {
    const c = RA.constraintsFor(required(FULL), {});
    eq(c.chaptersPerModule, { min: 5, max: 5 }, 'capítulos por módulo');
    eq(c.videosAllContent, true, '2 videos por capítulo: lo más cercano que Cursia puede (uno en cada capítulo); el resto lo explica Verificación');
    eq(c.applicationPerModule, { min: 1, max: 1 }, '1 Actividad de Aplicación por módulo');
    const one = RA.constraintsFor(required('Cada capítulo tendrá un video.'), {});
    eq(one.videosAllContent, true, '1 video por capítulo → video en todos los de contenido');
    eq(RA.constraintsFor(required('Cada capítulo tendrá un video.'), { audiovisual: { value: 'less', at: '' } }), null, 'con la decisión del docente no restringe');
    eq(RA.constraintsFor(required('Se recomiendan 5 capítulos por módulo.'), {}), null, 'una recomendación no restringe');
    eq(RA.constraintsFor(RX.requirementsFor(extract('El curso tendrá aproximadamente 5 capítulos por módulo.'), {}), {}), null, 'aproximado no restringe');
    eq(RA.constraintsFor(required('El curso tendrá entre 3 y 5 capítulos por módulo.'), {}).chaptersPerModule, { min: 3, max: 5 }, 'rango');
    eq(RA.constraintsFor(required('El curso tendrá 4 módulos de 5 capítulos.'), {}).chaptersPerModule, { min: 5, max: 5 }, 'estructura N × M');
    eq(RA.constraintsFor(required('Cada capítulo tendrá entre 1 y 2 videos.'), {}).videosAllContent, true, 'review L86C M2: rango 1–2 → video en todos');
    eq(RA.constraintsFor(required('Cada capítulo tendrá como máximo 0 videos.'), {}) && RA.constraintsFor(required('Cada capítulo tendrá como máximo 0 videos.'), {}).videosNone, true, 'máximo 0 → ninguno');
    eq(RA.constraintsFor(required('El curso tendrá como mínimo 4 capítulos por módulo. El curso tendrá como máximo 3 capítulos por módulo.'), {}), null, 'review L86C I4: mínimo > máximo → no restringe (Cursia no elige)');
    const x = extract(SML);
    const gid = x.groups.find((g) => g.relation === 'oneOf').id;
    eq(RA.constraintsFor(RX.requirementsFor(x, {}).filter((r) => r.obligation === 'required'), {}), null, 'S/M/L sin elegir: nada restringe');
    eq(RA.constraintsFor(RX.requirementsFor(x, { options: { [gid]: 'M' } }).filter((r) => r.obligation === 'required'), {}).chaptersPerModule, { min: 4, max: 4 }, 'M: 4 por módulo');
    eq(RA.constraintsFor(RX.requirementsFor(x, { options: { [gid]: 'S' } }).filter((r) => r.obligation === 'required'), {}).chaptersPerModule, { min: 3, max: 3 }, 'S: 3 por módulo (no se suman)');
  });

  await check('RC2 horas del documento: exacto, rango, mínimo, máximo; recomendado = sugerencia', async () => {
    const h = (text, p, sel) => { const r = RA.hoursFromRequirements(RX.requirementsFor(extract(text), sel || {}), p); return r ? [r.value, r.required] : null; };
    eq(h(FULL, 48), [64, true], 'exacto');
    const x = extract(SML);
    const gid = x.groups.find((g) => g.relation === 'oneOf').id;
    const hM = (p) => { const r = RA.hoursFromRequirements(RX.requirementsFor(x, { options: { [gid]: 'M' } }), p); return r.value; };
    eq([hM(48), hM(32), hM(42), hM(null)], [44, 40, 42, 40], 'rango 40–44: la propuesta se lleva dentro');
    eq(RA.hoursFromRequirements(RX.requirementsFor(x, {}), 48), null, 'sin elegir tamaño: ninguna hora aplica');
    eq(h('El curso tendrá como mínimo 40 horas.', 32), [40, true], 'mínimo');
    eq(h('El curso tendrá como máximo 40 horas.', 48), [40, true], 'máximo');
    eq(h('Se recomienda una duración de 48 horas.', 32), [48, false], 'recomendado');
    eq(h('El curso trata de horas y minutos.', 32), null, 'sin horas');
    // Re-review L86C IMP-2: varias horas obligatorias COMPATIBLES se cumplen a la vez (intersección).
    eq(h('El curso tendrá como mínimo 32 horas.\nEl curso tendrá entre 40 y 44 horas.', 36), [40, true], 'mínimo 32 + 40–44 con propuesta 36 → 40');
    eq(h('El curso tendrá como máximo 44 horas.\nEl curso tendrá como mínimo 40 horas.', 30), [40, true], 'máximo 44 + mínimo 40 con propuesta 30 → 40');
    // Confianza media («Revisa esta lectura»: presente, totales calculados…): sugerencia, nunca autoridad.
    const med = RX.requirementsFor(extract('El curso tiene 64 horas.'), {});
    eq([med[0].obligation, med[0].confidence], ['required', 'medium'], 'lectura con dudas');
    eq(h('El curso tiene 64 horas.', 32), [64, false], 'confianza media → sugerencia, no obligatorio');
    eq(RA.requirementVerificationChecks(med, DR.compareRequirements(med, { modules: [{ examEnabled: true, chapters: [{ kind: 'content', videoEnabled: true, activityEnabled: true, applicationMinutes: null, hours: 3 }] }], evaluations: 1, targetHours: 40, hoursSource: 'proposed', structureByTeacher: false, audiovisualByTeacher: false, applicationByTeacher: false }),
      { status: 'within_tolerance', baseHours: 3, estimatedHours: 40, modules: 1, moduleExams: 1, exceptionFields: {} })[0].severity, 'info', 'sin cumplir, solo «por revisar» (no conflicto)');
  });

  await check('RC3 distribuidor: completa el mínimo con propuestos, nunca pasa del máximo, video en todos, N Actividades por módulo; sin restricciones idéntico', async () => {
    // Sin restricciones: idéntico (byte a byte) a no pasarlas.
    eq(JSON.stringify(dist([3, 3, 3], 40)), JSON.stringify(ST.distributeCourseHours({ snapshot: snapshot([3, 3, 3]), rules: null, targetHours: 40, preferences: { audiovisual: 'recommended' }, pins: null })), 'sin requisitos, mismo resultado');
    // Mínimo 5 por módulo: se completa con propuestos (práctica primero, D1) aunque las horas no lo pidan.
    let d = dist([3, 3, 3, 3], 20, { requirements: { chaptersPerModule: { min: 5, max: 5 }, sources: { chapters: 'RQ1' } } });
    eq(perModule(d), [5, 5, 5, 5], '4 × 5');
    const added = d.changes.filter((c) => c.requirementId === 'RQ1');
    eq(added.length, 8, '2 propuestos por módulo, atribuidos al requisito');
    assert(d.modules.every((m) => m.chapters.filter((c) => c.proposed && c.kind === 'practice').length === 1), 'uno de práctica por módulo');
    assert(added.every((c) => /el documento pide 5 capítulos por módulo/.test(c.detail)), 'el cambio dice por qué');
    // Máximo 3 por módulo: aunque falten horas, no agrega capítulos (crece con aplicación o lo dice).
    d = dist([3, 3], 60, { requirements: { chaptersPerModule: { max: 3 }, sources: {} } });
    eq(perModule(d), [3, 3], 'nunca pasa del máximo');
    const free = dist([3, 3], 60);
    assert(perModule(free).some((n) => n > 3), 'sin el requisito, el distribuidor sí agregaba capítulos');
    // Video en todos los capítulos de contenido (también los propuestos); lo fijado por el docente manda.
    d = dist([3, 3], 20, { preferences: { audiovisual: 'less' }, requirements: { videosAllContent: true, chaptersPerModule: { min: 4 }, sources: {} } });
    assert(d.modules.every((m) => m.chapters.filter((c) => c.kind === 'content').every((c) => c.videoEnabled)), 'video en todos los de contenido');
    const pinId = d.modules[0].chapters[0].id;
    d = dist([3, 3], 20, { preferences: { audiovisual: 'less' }, pins: { [pinId]: { video: false } }, requirements: { videosAllContent: true, sources: {} } });
    eq(d.modules[0].chapters[0].videoEnabled, false, 'el video fijado por el docente se respeta');
    // Exactamente 1 Actividad de Aplicación por módulo (aunque las horas pidieran más).
    d = dist([4, 4, 4], 70, { requirements: { applicationPerModule: { min: 1, max: 1 }, sources: {} } });
    eq(aaPerModule(d), [1, 1, 1], '1 por módulo');
    assert(aaPerModule(dist([4, 4, 4], 70)).some((n) => n > 1), 'sin el requisito había más');
    d = dist([4, 4, 4], 20, { requirements: { applicationPerModule: { min: 1, max: 1 }, sources: {} } });
    eq(aaPerModule(d), [1, 1, 1], 'y al menos 1 aunque las horas no lo pidan');
    d = dist([4, 4, 4], 20, { preferences: { audiovisual: 'recommended', applicationActivities: 'none' }, requirements: { applicationPerModule: { min: 1, max: 1 }, sources: {} } });
    eq(aaPerModule(d), [0, 0, 0], 'con «Ninguna» (decisión del docente) no se fuerza: queda como excepción');
    // Review L86C I2: las horas base incluyen los capítulos exigidos (la propuesta de horas de Cursia queda aplicable).
    const REC = loadDist('modules/course-design/design-recommendation.js');
    const probe = dist([2, 2, 2, 2], 8, { requirements: { chaptersPerModule: { min: 5, max: 5 }, sources: { chapters: 'RQ1' } } });
    const free2 = dist([2, 2, 2, 2], 8);
    assert(probe.baseHours > free2.baseHours, `base con los capítulos exigidos (${probe.baseHours} > ${free2.baseHours})`);
    const prop = REC.proposeTargetHours(probe.baseHours).value;
    const fit = dist([2, 2, 2, 2], prop, { requirements: { chaptersPerModule: { min: 5, max: 5 }, sources: { chapters: 'RQ1' } } });
    assert(fit.status !== 'minimum_exceeds_target', `propuesta ${prop} h → ${fit.status}`);
    // Review L86C M5: un requisito de un módulo que el diseño no tiene NO se cumple.
    const m3 = RX.requirementsFor(extract('El módulo 3 tendrá una duración de 6 horas.\nMódulo 3\nDuración: 6 horas'), {});
    const cm = DR.compareRequirements(m3.filter((r) => r.scope.level === 'module'), { modules: [{ examEnabled: true, chapters: [{ kind: 'content', videoEnabled: true, activityEnabled: true, applicationMinutes: null, hours: 3 }] }], evaluations: 1, targetHours: 8, hoursSource: 'proposed', structureByTeacher: false, audiovisualByTeacher: false, applicationByTeacher: false });
    assert(cm.length && cm.every((c) => c.status === 'unmet'), JSON.stringify(cm));
  });

  await check('RC4 Verificación: ok · excepción del docente (advertencia) · conflicto crítico con su causa · por revisar', async () => {
    const reqs = RX.requirementsFor(extract(FULL), {});
    const design = { modules: [0, 1, 2, 3].map(() => ({ examEnabled: true, chapters: Array.from({ length: 5 }, (_, i) => ({ kind: 'content', proposed: false, videoEnabled: true, activityEnabled: true, applicationMinutes: i === 0 ? 60 : null, hours: 3 })) })),
      evaluations: 5, targetHours: 64, hoursSource: 'document', structureByTeacher: false, audiovisualByTeacher: false, applicationByTeacher: false };
    const checks = DR.compareRequirements(reqs, design);
    const v = RA.requirementVerificationChecks(reqs, checks, { status: 'within_tolerance', baseHours: 50, estimatedHours: 64, modules: 4, moduleExams: 4, exceptionFields: {} });
    const by = (k, et) => v.find((c) => c.id === `requirement:${reqs.find((r) => r.kind === k && (!et || r.evaluationType === et)).id}`);
    eq(by('modules').severity, 'ok', 'módulos');
    // LOOP 9 (P0-2): lo que Cursia no puede producir es una excepción explícita (con motivo en la propuesta), no un crítico sin salida.
    eq(by('videos').severity, 'warning', '2 videos por capítulo: Cursia no puede → excepción');
    // LOOP 9.2 (capacidades): «Requisito no cubierto por Cursia» con lo que Cursia contempla y la aceptación pendiente.
    assert(/^Requisito no cubierto por Cursia/.test(by('videos').title), by('videos').title);
    assert(/1 video por capítulo/.test(by('videos').detail) && /aceptar esta diferencia/.test(by('videos').detail), 'con lo que Cursia contempla y la aceptación pendiente');
    const partial = by('evaluations', 'partial');
    eq(partial.severity, 'critical', '3 parciales con 4 módulos');
    assert(/Entra en conflicto con «4 módulos»/.test(partial.detail) && /El documento pide 3 evaluaciones parciales; el diseño tiene 4 evaluaciones parciales/.test(partial.detail), partial.detail);
    eq(partial.fix.kind, 'editor', 'se resuelve en el editor');
    // Decisión del docente → excepción (advertencia), no conflicto.
    const t = DR.compareRequirements(reqs, { ...design, targetHours: 48, hoursSource: 'adjusted' });
    const vh = RA.requirementVerificationChecks(reqs, t, { status: 'within_tolerance', baseHours: 30, estimatedHours: 48, modules: 4, moduleExams: 4, exceptionFields: {} }).find((c) => c.id === `requirement:${reqs.find((r) => r.kind === 'target_hours').id}`);
    eq(vh.severity, 'warning', 'horas del docente');
    eq(vh.title, 'Excepción al requisito del documento: 64 horas', 'título');
    assert(/Te estás apartando de un requisito del documento: el documento pide 64 horas; elegiste 48 horas/.test(vh.detail), vh.detail);
    // Horas que chocan con la estructura exigida.
    // Review L86C I3: las horas del documento son la meta (la comparación «cumple»), pero el diseño no puede llegar.
    const hs = DR.compareRequirements(reqs, { ...design, targetHours: 64 });
    eq(hs.find((c) => c.requirementId === reqs.find((r) => r.kind === 'target_hours').id).status, 'met', 'la meta es la del documento');
    const vc = RA.requirementVerificationChecks(reqs, hs, { status: 'minimum_exceeds_target', baseHours: 82.5, estimatedHours: 82.5, modules: 4, moduleExams: 4, exceptionFields: {} }).find((c) => c.id === `requirement:${reqs.find((r) => r.kind === 'target_hours').id}`);
    eq(vc.severity, 'critical', 'conflicto (sin forzar nada a mano)');
    assert(/Entra en conflicto con «estructura 4 × 5 \(20 capítulos\)»: esa estructura ya suma ≈ 82,5 h/.test(vc.detail), vc.detail);
    // Dos requisitos del mismo documento que chocan.
    const two = RX.requirementsFor(extract('El curso tendrá 64 horas.\nLa duración total será de 40 horas.'), {});
    const tc = DR.compareRequirements(two, { ...design, targetHours: 64 });
    const vts = RA.requirementVerificationChecks(two, tc, { status: 'within_tolerance', baseHours: 30, estimatedHours: 64, modules: 4, moduleExams: 4, exceptionFields: {} });
    eq(vts.map((c) => c.severity), ['critical', 'critical'], 'review L86C I4: conflicto en LOS DOS (aunque uno se cumpla)');
    assert(vts.every((c) => /no se pueden cumplir los dos\. Cursia no elige entre ellos/.test(c.detail)), JSON.stringify(vts));
    eq(RA.hoursFromRequirements(two, 48), null, 'y Cursia no elige ninguna de las dos horas');
    // Unidades: por revisar (info), no conflicto.
    const u = RX.requirementsFor(extract('El curso tendrá 3 unidades.'), {});
    eq(RA.requirementVerificationChecks(u, DR.compareRequirements(u, design), { status: 'within_tolerance', baseHours: 1, estimatedHours: 1, modules: 4, moduleExams: 4, exceptionFields: {} })[0].severity, 'info', 'unidades');
  });

  await check('RC10 documentos reales: valores largos repetidos se leen; más de 12 resultados no rompen la recomendación', async () => {
    const A = loadDist('modules/academic-context/index.js');
    const REC = loadDist('modules/course-design/design-recommendation.js');
    const p = (w) => ('El curso se desarrolla con ' + w + ' ').repeat(12).trim() + '.';
    const t = 'METODOLOGÍA\n' + p('talleres prácticos') + '\n\nMETODOLOGÍA\n' + p('estudios de caso') + '\n\nMETODOLOGÍA\n' + p('aprendizaje basado en proyectos') + '\n';
    const r = await A.extractAcademicContext([{ name: 'x.txt', data: Buffer.from(t, 'utf8') }]);
    const k = r.context.conflicts.find((c) => c.path === 'methodology');
    assert(k && k.values.length >= 3 && k.values.every((v) => v.value.length <= 200), JSON.stringify(r.context.conflicts));
    const outcomes = Array.from({ length: 20 }, (_, i) => `Aplicar el procedimiento ${i + 1} en un caso real del sector`);
    const inf = REC.inferWizardAnswers({ learner: null, outcomes, competencies: Array.from({ length: 15 }, (_, i) => `Competencia ${i + 1}`) });
    assert(inf.answers.q2.do.length === 12 && inf.answers.q2.competencies.length === 12, 'listas acotadas a 12');
    assert(/20 de 20 resultados piden hacer/.test(inf.basis[0]), 'la proporción usa todos: ' + inf.basis[0]);
    const s2 = REC.recommendApproachFromFacts({ learner: null, outcomes, competencies: [] });
    assert(s2 && s2.approach, 'recomienda un enfoque (antes: WIZARD_INVALID)');
  });

  if (PURE_ONLY) console.log('\n(--pure-only: parte DB omitida)');
  else await dbChecks();
  console.log(`\n${passed} OK · ${failed} fallas`);
  process.exit(failed ? 1 : 0);
})();

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
  const { NotFoundException, Logger } = require('@nestjs/common');
  const { CourseProfilesService } = loadDist('modules/course-profiles/course-profiles.service.js');
  const { CourseBlueprintsService } = loadDist('modules/course-blueprints/course-blueprints.service.js');
  const { PedagogyService } = loadDist('modules/pedagogy/pedagogy.service.js');
  const { CourseDesignService } = loadDist('modules/course-design/course-design.service.js');
  const { AcademicContextService } = loadDist('modules/academic-context/academic-context.service.js');
  const { CourseModule } = loadDist('modules/course-structure/entities/course-module.entity.js');
  const { CourseChapter } = loadDist('modules/course-structure/entities/course-chapter.entity.js');
  const { CourseStructureService } = loadDist('modules/course-structure/course-structure.service.js');
  const SA = loadDist('modules/course-structure/structure-authority.js');
  Logger.overrideLogger(false);

  const pgBin = findPgBin();
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursia-loop86c-pg16-'));
  const DB = 'loop86cdb';
  const pg = (bin, a) => spawnSync(path.join(pgBin, bin), a, { env: cleanEnv(), encoding: 'utf8' });
  const saved = { flag: process.env.DYNAMIC_COURSE_STRUCTURE, allow: process.env.DYNAMIC_V2_ALLOWED_OWNERS, unowned: process.env.ALLOW_UNOWNED_COURSES, rules: process.env.DYNAMIC_MANIFEST_RULES_VERSION, atr: process.env.DYNAMIC_ACTIVITY_TYPE_RULES };
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
        'supabase-migration-application-activities.sql', 'supabase-migration-academic-context.sql']) {
        await c.query(fs.readFileSync(path.join(REPO, f), 'utf8'));
      }
    });
    process.env.DYNAMIC_COURSE_STRUCTURE = 'true';
    delete process.env.DYNAMIC_V2_ALLOWED_OWNERS;
    delete process.env.ALLOW_UNOWNED_COURSES;
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
    const acx = new AcademicContextService(ds, coursesStub, null, null);
    const structure = new CourseStructureService(ds.getRepository(CourseModule), ds.getRepository(CourseChapter), coursesStub, ds, blueprints);
    const OWNER = '11111111-2222-4333-8444-555555555555';
    const counter = async (cid) => Number((await ds.query(`select structure_version_counter c from public.courses where id = $1`, [cid]))[0].c);
    const file = (name, text) => ({ name, dataBase64: Buffer.from(text, 'utf8').toString('base64') });
    // Un curso cuya estructura armó Cursia (origen registrado e intacto) y un documento SINTÉTICO con los requisitos.
    const courseWith = async (title, shape, docText) => {
      const [c] = await ds.query(`insert into public.courses (owner_id, title, structure_version, final_exam_enabled, activity_engine) values ($1, $2, 'dynamic', true, 'h5p') returning id`, [OWNER, title]);
      for (const [mi, n] of shape.entries()) {
        const [m] = await ds.query(`insert into public.course_modules (course_id, position, title, exam_enabled) values ($1, $2, $3, true) returning id`, [c.id, mi, `Módulo ${mi + 1}: tema ${mi + 1}`]);
        for (let ci = 0; ci < n; ci++) await ds.query(`insert into public.course_chapters (course_id, module_id, position, title, objective, video_enabled, activity_enabled) values ($1, $2, $3, $4, $4, true, true)`, [c.id, m.id, ci, `Tema ${mi + 1}.${ci + 1}`]);
      }
      await SA.writeStructureOrigin(ds, c.id, { source: 'ai_proposal', counter: await counter(c.id), contextVersion: null, at: '2026-10-07T00:00:00.000Z' });
      const ex = await acx.extract(c.id, OWNER, { files: [file('requisitos (sintético).txt', docText)] });
      await profiles.append(c.id, OWNER, 'academic', ex.draft);
      return c.id;
    };
    // «Usar este diseño» como lo hace el paso 3: guardar el perfil efectivo + decisiones → misma huella → aplicar.
    const useDesign = async (cid, adjust, extra = {}) => {
      const card = await design.recommend(cid, OWNER, { ...(adjust ? { adjust } : {}), ...(extra.clearDecisions ? { clearDecisions: extra.clearDecisions } : {}) });
      const cur = (await profiles.getCurrent(cid, OWNER, 'pedagogy').catch(() => null));
      await profiles.append(cid, OWNER, 'pedagogy', card.profile, cur && !cur.isDefault ? cur.version : undefined);
      await design.recordHoursOrigin(cid, OWNER, card.hours.source === 'proposed' || card.hours.source === 'requirement' ? card.hours.target : null);
      // Igual que el paso 3 (52-v2-design.js, v2dUse): decisiones del docente + lo que eligió Cursia.
      await design.saveRequirementDecisions(cid, OWNER, { ...card.requirements.authority.decisions, cursiaAudiovisual: card.requirements.authority.cursiaAudiovisual || null });
      const again = await design.recommend(cid, OWNER, {});
      eq(again.design.proposalSha256, card.design.proposalSha256, 'misma huella al volver a pedir el diseño (sin «Ajustar»)');
      if (!card.design.applicable) return { card, applied: null };
      const applied = await structure.applyDistribution(cid, OWNER, { proposalSha256: card.design.proposalSha256, expectedCounter: await counter(cid) });
      return { card, applied };
    };
    const reqCheck = (card, kind, opt) => {
      const item = card.requirements.items.find((i) => i.applies && i.kind === kind && (opt === undefined || i.optionId === opt));
      return item ? card.verification.checks.find((c) => c.id === `requirement:${item.id}`) : null;
    };
    const shapeOf = async (cid) => (await ds.query(`select m.position, count(ch.id)::int n from public.course_modules m left join public.course_chapters ch on ch.module_id = m.id where m.course_id = $1 group by m.id, m.position order by m.position`, [cid])).map((x) => x.n);

    await check('RC5 BTO S/M/L: sin elegir no restringe; M → 40–44 h y 4 capítulos por módulo; «Usar» aplica con la misma huella; S/L solo lo suyo', async () => {
      const cid = await courseWith('BTO', [3, 3, 3], SML);
      const free = await design.recommend(cid, OWNER, {});
      assert(free.requirements.checks.length === 0 && !free.requirements.authority.hours, 'sin elegir: nada aplica');
      const gid = free.requirements.alternatives[0].groupId;
      await acx.setRequirementSelection(cid, OWNER, gid, 'M');
      const card = await design.recommend(cid, OWNER, {});
      eq(card.hours.source, 'requirement', 'horas del documento');
      assert(card.hours.target >= 40 && card.hours.target <= 44, `horas ${card.hours.target}`);
      eq(card.design.modules.map((m) => m.chapters.length), [4, 4, 4], '4 capítulos por módulo (propuestos)');
      assert(card.requirements.authority.applied.some((a) => /capítulos? propuestos? para llegar a 4 capítulos por módulo/.test(a.text)), JSON.stringify(card.requirements.authority.applied));
      assert(card.requirements.checks.every((c) => c.status === 'met'), 'cada requisito, en su medida, se cumple: ' + JSON.stringify(card.requirements.checks));
      // Review L86C I3: con el modelo de tiempo de Cursia, 3 × 4 capítulos no llega a 40 h sin rellenar, y se dice.
      // Documentos imperfectos (2026-10-10): no es un bloqueo sin salida sino «Requisito no cubierto por Cursia» con las
      // horas reales y una alternativa; la institución decide (R68 exige su aceptación). Cursia no rellena ni lo da por cumplido.
      const bad = card.verification.checks.filter((c) => c.area === 'requirements' && c.severity !== 'ok');
      eq(bad.map((c) => [c.severity, c.title]), [['warning', 'Requisito no cubierto por Cursia: 40–44 horas']], 'solo las horas: no cubierto');
      assert(/el diseño de Cursia equivale a ≈ \d+(,\d)? horas de trabajo del estudiante/.test(bad[0].detail) && /^Proponemos/.test(bad[0].capability.proposal), JSON.stringify(bad[0]));
      eq(await shapeOf(cid), [3, 3, 3], 'nada se aplicó todavía (es una propuesta)');
      const { applied } = await useDesign(cid);
      assert(applied, '«Usar este diseño» aplica');
      eq(await shapeOf(cid), [4, 4, 4], 'aplicado: 3 × 4');
      const after = await design.recommend(cid, OWNER, {});
      assert(after.requirements.checks.every((c) => c.status === 'met'), 'después de aplicar, todo cumple');
      eq(after.design.modules.flatMap((m) => m.chapters).filter((c) => c.proposed).length, 0, 'sin nuevos propuestos (punto fijo)');
      // S: máximo 3 por módulo — los 4 que Cursia aplicó NO se quitan solos: conflicto crítico con su causa.
      await acx.setRequirementSelection(cid, OWNER, gid, 'S');
      const s = await design.recommend(cid, OWNER, {});
      assert(s.hours.target >= 20 && s.hours.target <= 22, `S: horas ${s.hours.target}`);
      const sc = reqCheck(s, 'chapters', 'S');
      eq(sc.severity, 'critical', 'S: conflicto');
      assert(/Cursia no quita capítulos existentes ni pasa del máximo por su cuenta/.test(sc.detail), sc.detail);
      eq(s.design.modules.map((m) => m.chapters.length), [4, 4, 4], 'nada se quitó');
      assert(!s.requirements.items.some((i) => i.applies && i.optionId !== 'S'), 'solo S aplica');
    });

    await check('RC6 excepción del docente: «Menos video» contra «1 video por capítulo» queda registrada, se muestra y «Usar» aplica; «Volver al requisito» la quita', async () => {
      const cid = await courseWith('Videos', [3, 3], 'Cada capítulo tendrá un video. El curso tendrá 3 capítulos por módulo.');
      const base = await design.recommend(cid, OWNER, {});
      assert(base.design.modules.every((m) => m.chapters.filter((c) => c.kind === 'content').every((c) => c.videoEnabled)), 'el documento manda: video en todos');
      const card = await design.recommend(cid, OWNER, { adjust: { audiovisual: 'less' } });
      eq(card.requirements.authority.decisions, { audiovisual: 'less', applicationActivities: null }, 'decisión del docente');
      const vc = reqCheck(card, 'videos');
      eq(vc.severity, 'warning', 'excepción, no conflicto');
      eq(vc.title, 'Excepción al requisito del documento: 1 video por capítulo', vc.title);
      eq(vc.fix.action, 'audiovisual', '«Volver al requisito del documento»');
      const { applied } = await useDesign(cid, { audiovisual: 'less' });
      assert(applied, 'aplica con la excepción');
      const later = await design.recommend(cid, OWNER, {});
      eq(later.preferences.audiovisual, 'less', 'la decisión registrada se respeta (no se revierte)');
      eq(reqCheck(later, 'videos').severity, 'warning', 'sigue como excepción');
      const back = await design.recommend(cid, OWNER, { clearDecisions: ['audiovisual'] });
      eq(back.requirements.authority.decisions.audiovisual, null, 'sin decisión');
      eq(back.preferences.audiovisual, 'more', 'review L86C I1: la tarjeta dice lo que hace (video en todos = «Más video», elegido por Cursia)');
      eq(back.requirements.authority.cursiaAudiovisual, 'more', 'registrado como elección de Cursia');
      eq(reqCheck(back, 'videos').severity, 'ok', 'vuelve a cumplir el documento');
      await useDesign(cid, null, { clearDecisions: ['audiovisual'] });
      eq((await design.recommend(cid, OWNER, {})).requirements.authority.decisions.audiovisual, null, 'excepción quitada');
    });

    await check('RC11 review L86C I1: «Ninguna» elegida en Avanzado (perfil) es decisión del docente → excepción, no conflicto; «Volver» la quita', async () => {
      const cid = await courseWith('Avanzado', [3, 3], 'Cada módulo tendrá una Actividad de Aplicación. El curso tendrá 3 capítulos por módulo.');
      // El panel Avanzado guarda la preferencia en el perfil (sin pasar por «Ajustar → Usar»).
      const first = await design.recommend(cid, OWNER, {});
      await profiles.append(cid, OWNER, 'pedagogy', { ...first.profile, designPreferences: { ...(first.profile.designPreferences || {}), applicationActivities: 'none' } });
      const card = await design.recommend(cid, OWNER, {});
      eq(card.preferences.applicationActivities, 'none', 'se respeta');
      const ac = reqCheck(card, 'application_activities');
      eq(ac.severity, 'warning', 'excepción del docente, no crítico');
      assert(/Excepción al requisito del documento/.test(ac.title) && ac.fix && ac.fix.action === 'applicationActivities' && ac.fix.value === 'requirement', JSON.stringify(ac));
      eq(card.verification.blocking, false, 'no bloquea el paso 4');
      const back = await design.recommend(cid, OWNER, { clearDecisions: ['applicationActivities'] });
      eq(back.preferences.applicationActivities, 'auto', 'vuelve al valor por defecto');
      eq(reqCheck(back, 'application_activities').severity, 'ok', 'cumple el documento');
      await useDesign(cid, null, { clearDecisions: ['applicationActivities'] });
      const after = await design.recommend(cid, OWNER, {});
      eq([after.preferences.applicationActivities, after.requirements.authority.decisions.applicationActivities, reqCheck(after, 'application_activities').severity], ['auto', null, 'ok'], 'el perfil quedó coherente');
    });

    await check('RC12 review L86C I2/I3: horas que propone Cursia caben en la estructura exigida; horas exigidas que chocan con ella → conflicto explicado', async () => {
      const cid = await courseWith('Relleno', [2, 2, 2, 2], 'El curso tendrá 5 capítulos por módulo.');
      const card = await design.recommend(cid, OWNER, {});
      eq(card.design.modules.map((m) => m.chapters.length), [5, 5, 5, 5], 'relleno');
      assert(card.design.applicable && card.design.status !== 'minimum_exceeds_target', `aplicable (${card.design.status}, ${card.hours.target} h)`);
      const c2 = await courseWith('Choque', [3, 3, 3, 3], 'El curso deberá tener 4 módulos con 5 capítulos por módulo. La intensidad horaria total será de 10 horas.');
      const k2 = await design.recommend(c2, OWNER, {});
      eq(k2.design.status, 'minimum_exceeds_target', 'la estructura exigida pasa de 10 h');
      const hc = reqCheck(k2, 'target_hours');
      eq(hc.severity, 'critical', 'horas: conflicto');
      assert(/Entra en conflicto con «(estructura 4 × 5|5 capítulos por módulo)/.test(hc.detail), hc.detail);
    });

    await check('RC13 review L86C I4: requisitos del documento que se contradicen → Cursia no elige (ni horas ni pasa del máximo) y lo dice en los dos', async () => {
      const cid = await courseWith('Contradicción', [3, 3], 'La intensidad horaria total será de 64 horas.\nEl curso tendrá entre 40 y 44 horas.\nEl curso tendrá como mínimo 5 capítulos por módulo. El curso tendrá como máximo 3 capítulos por módulo.');
      const card = await design.recommend(cid, OWNER, {});
      assert(card.hours.source !== 'requirement', 'no toma ninguna de las dos horas: ' + card.hours.source);
      eq(card.design.modules.map((m) => m.chapters.length).every((n) => n <= 3), true, 'nunca pasa del máximo');
      const crit = card.verification.checks.filter((c) => c.area === 'requirements' && c.severity === 'critical' && /no se pueden cumplir los dos/.test(c.detail));
      assert(crit.length >= 4, 'los dos de horas y los dos de capítulos: ' + JSON.stringify(crit.map((c) => c.title)));
    });

    await check('RC14 re-review L86C IMP-1: el «Más video» que eligió Cursia sigue siendo de Cursia aunque cambien los documentos', async () => {
      const cid = await courseWith('Docs', [3, 3], 'Cada capítulo tendrá un video. El curso tendrá 3 capítulos por módulo.');
      const { card } = await useDesign(cid);
      eq(card.requirements.authority.cursiaAudiovisual, 'more', 'Cursia eligió «Más video»');
      // El docente sube OTRO documento (otra huella) que pide no tener videos.
      const ex = await acx.extract(cid, OWNER, { files: [file('otro (sintético).txt', 'El curso no tendrá videos. El curso tendrá 3 capítulos por módulo.')] });
      const cur = await profiles.getCurrent(cid, OWNER, 'academic');
      await profiles.append(cid, OWNER, 'academic', ex.draft, cur.version);
      const after = await design.recommend(cid, OWNER, {});
      eq(after.requirements.authority.decisions.audiovisual, null, 'no es una decisión del docente');
      assert(after.design.modules.every((m) => m.chapters.every((c) => !c.videoEnabled)), 'el documento nuevo manda: sin videos');
      assert(!after.verification.checks.some((c) => c.area === 'requirements' && /Excepción/.test(c.title)), 'sin excepciones falsas');
    });

    await check('RC15 re-review L86C IMP-3: una decisión del docente que impide llegar a las horas es su excepción (no un conflicto de Cursia)', async () => {
      const cid = await courseWith('Límite', [4, 4, 4, 4], 'El curso deberá tener 4 módulos con 5 capítulos por módulo. La intensidad horaria total será de 50 horas.');
      eq(reqCheck(await design.recommend(cid, OWNER, {}), 'target_hours').severity, 'ok', 'sin la decisión del docente sí llega a 50 h');
      const card = await design.recommend(cid, OWNER, { adjust: { applicationActivities: 'none' } });
      eq(card.design.status, 'cannot_reach_target', 'sin Actividades de Aplicación no llega');
      const hc = reqCheck(card, 'target_hours');
      eq(hc.severity, 'warning', 'excepción del docente');
      assert(/«Actividades de Aplicación: Ninguna»/.test(hc.detail) && hc.fix.action === 'applicationActivities' && hc.fix.value === 'requirement', JSON.stringify(hc));
      const cm = card.requirements.checks.find((c) => c.requirementId === card.requirements.items.find((i) => i.applies && i.kind === 'target_hours').id);
      eq([cm.severity, /Ninguna/.test(cm.detail)], ['warning', true], 'la tarjeta recibe la misma severidad y explicación (m2)');
    });

    await check('RC16 re-review final L86C IMPORTANTE-1: un choque entre requisitos del documento sigue siendo crítico aunque el docente haya decidido algo', async () => {
      const cid = await courseWith('Doc contra doc', [4, 4, 4, 4], 'El curso deberá tener 4 módulos con 5 capítulos por módulo. La intensidad horaria total será de 70 horas.');
      const base = await design.recommend(cid, OWNER, {});
      eq(base.design.status, 'cannot_reach_target', '4 × 5 no llega a 70 h aunque el docente no decida nada');
      // Documentos imperfectos (2026-10-10): sin llegar a las horas por lo que fija el propio documento = «Requisito no cubierto
      // por Cursia» (horas reales + alternativa, aceptación de la institución), nunca atribuido al docente.
      const b0 = reqCheck(base, 'target_hours');
      eq([b0.severity, b0.title], ['warning', 'Requisito no cubierto por Cursia: 70 horas'], 'sin decisiones: no cubierto');
      for (const adjust of [{ applicationActivities: 'none' }, { audiovisual: 'less' }]) {
        const card = await design.recommend(cid, OWNER, { adjust });
        const hc = reqCheck(card, 'target_hours');
        eq([hc.severity, hc.title], ['warning', 'Requisito no cubierto por Cursia: 70 horas'], 'documento contra documento, con ' + JSON.stringify(adjust));
        assert(!/Excepción|elegiste|que armaste/.test(hc.title + hc.detail), 'no se atribuye al docente: ' + hc.title + ' ' + hc.detail);
        assert(hc.capability && hc.capability.requirementKey, 'exige la aceptación de la institución (R68)');
      }
    });

    await check('RC17 re-review final L86C IMPORTANTE-A: sin lectura de requisitos, el «Más video» del docente no se confunde con uno viejo de Cursia', async () => {
      const cid = await courseWith('Sin lectura', [3, 3], 'Cada capítulo tendrá un video. El curso tendrá 3 capítulos por módulo.');
      const { card } = await useDesign(cid);
      eq(card.requirements.authority.cursiaAudiovisual, 'more', 'Cursia eligió «Más video»');
      // El docente quita el documento: ya no hay lectura de requisitos.
      const cur = await profiles.getCurrent(cid, OWNER, 'academic');
      await profiles.append(cid, OWNER, 'academic', { ...cur.profile, documents: [] }, cur.version);
      await useDesign(cid);
      // Ahora el docente elige «Más video» en «Avanzado» y lo usa.
      const mine = await design.recommend(cid, OWNER, { adjust: { audiovisual: 'more' } });
      eq(mine.profile.designPreferences.audiovisual, 'more', 'vista previa con su elección');
      const pc = await profiles.getCurrent(cid, OWNER, 'pedagogy');
      await profiles.append(cid, OWNER, 'pedagogy', mine.profile, pc.version);
      await design.saveRequirementDecisions(cid, OWNER, { ...mine.requirements.authority.decisions, cursiaAudiovisual: mine.requirements.authority.cursiaAudiovisual || null });
      const again = await design.recommend(cid, OWNER, {});
      eq(again.profile.designPreferences.audiovisual, 'more', 'Cursia no revierte la decisión del docente');
    });

    await check('RC18 re-review final L86C: «Más video» es la única prioridad que cumple los videos del documento y se pasa de sus horas → crítico, no excepción', async () => {
      const cid = await courseWith('Videos y horas', [3, 3, 3], 'El curso tendrá 9 videos en total. La intensidad horaria total será de 11 horas.');
      const card = await design.recommend(cid, OWNER, { adjust: { audiovisual: 'more' } });
      eq(card.design.status, 'minimum_exceeds_target', 'con «Más video» se pasa de 11 h');
      const hc = reqCheck(card, 'target_hours');
      eq(hc.severity, 'critical', 'documento contra documento');
      assert(!/Excepción/.test(hc.title), hc.title);
      assert(/Entra en conflicto con «9 videos/.test(hc.detail), 'nombra el requisito con el que choca: ' + hc.detail);
      // Sin prioridad que llegue a los videos, Cursia se queda en «Recomendado», que cabe: el choque es del docente.
      const cid2 = await courseWith('Videos imposibles', [3, 3, 3], 'El curso tendrá 20 videos en total. La intensidad horaria total será de 11 horas.');
      eq(reqCheck(await design.recommend(cid2, OWNER, {}), 'target_hours').severity, 'ok', 'sin decisión cabe en 11 h');
      const c2 = await design.recommend(cid2, OWNER, { adjust: { audiovisual: 'more' } });
      eq(c2.design.status, 'minimum_exceeds_target', '«Más video» se pasa');
      eq(reqCheck(c2, 'target_hours').severity, 'warning', 'excepción del docente, no crítico falso');
    });

    await check('RC19 re-review final L86C: videos fijados por el docente que lo pasan de las horas → su excepción (Cursia sin ellos elegiría «Menos video» y cabría)', async () => {
      const cid = await courseWith('Pins', [3, 3, 3], 'El curso tendrá como máximo 3 videos. La intensidad horaria total será de 11 horas.');
      eq(reqCheck(await design.recommend(cid, OWNER, {}), 'target_hours').severity, 'ok', 'sin lo fijado cabe');
      const ch = await ds.query(`select id from public.course_chapters where course_id = $1`, [cid]);
      await ds.query(`update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{designPins}', $2::jsonb, true) where id = $1`, [cid, JSON.stringify(Object.fromEntries(ch.map((r) => [r.id, { video: true }])))]);
      const card = await design.recommend(cid, OWNER, {});
      eq(card.design.status, 'minimum_exceeds_target', 'con todos los videos fijados se pasa');
      const hc = reqCheck(card, 'target_hours');
      eq(hc.severity, 'warning', 'excepción del docente, no crítico falso');
      assert(/los videos o Actividades que fijaste a mano/.test(hc.detail), hc.detail);
    });

    await check('RC20 horas con decimales: «12,5 horas» es 12,5 h (no 12)', async () => {
      const cid = await courseWith('Decimales', [3, 3], 'La intensidad horaria total será de 12,5 horas.');
      const card = await design.recommend(cid, OWNER, {});
      eq([card.hours.target, card.hours.source], [12.5, 'requirement'], 'horas del documento');
      const cid2 = await courseWith('Miles', [3, 3], 'Duración total: 1.200 horas.');
      const ra = await acx.requirements(cid2, OWNER);
      eq(ra.items.filter((i) => i.kind === 'target_hours').map((i) => i.value), [1200], '«1.200 horas» son 1200 h (miles), ni 1 ni 1,2');
      const cid3 = await courseWith('Dos decimales', [3, 3], 'La intensidad horaria total será de 12,50 horas.');
      eq((await design.recommend(cid3, OWNER, {})).hours.target, 12.5, '«12,50 horas» → 12,5 h');
    });

    await check('RC21 piloto (review I5): corregir un título no cambia nada; si el docente cambia la FORMA de la estructura, Cursia no vuelve a proponer capítulos: es su excepción y se puede aprobar', async () => {
      const cid = await courseWith('Estructura del docente', [3, 3], 'El curso tendrá 4 capítulos por módulo.');
      const first = await design.recommend(cid, OWNER, {});
      eq(first.design.modules.map((m) => m.chapters.length), [4, 4], 'Cursia completa el mínimo en su estructura');
      // El docente corrige un título en «Avanzado»: la forma sigue igual → Cursia sigue completando el mínimo.
      const [ch] = await ds.query(`select id, module_id from public.course_chapters where course_id = $1 order by position limit 1`, [cid]);
      await structure.updateChapter(cid, ch.module_id, ch.id, OWNER, { title: 'Tema renombrado por el docente', expectedCounter: await counter(cid) });
      const renamed = await design.recommend(cid, OWNER, {});
      eq(renamed.design.modules.map((m) => m.chapters.length), [4, 4], 'un título corregido no cambia la propuesta');
      // El docente agrega un capítulo a mano al módulo 1 (forma 4 · 3): su estructura manda.
      await structure.createChapter(cid, ch.module_id, OWNER, { title: 'Capítulo agregado por el docente', objective: 'Aplicar lo visto', expectedCounter: await counter(cid) });
      const card = await design.recommend(cid, OWNER, {});
      eq(card.design.modules.map((m) => m.chapters.length), [4, 3], 'su estructura se respeta (sin capítulos propuestos)');
      eq(card.design.modules.flatMap((m) => m.chapters).filter((c) => c.proposed).length, 0, 'sin cambios pendientes de capítulos');
      const cc = reqCheck(card, 'chapters');
      eq(cc.severity, 'warning', 'excepción del docente');
      assert(/Excepción al requisito del documento/.test(cc.title), cc.title);
      eq(card.verification.blocking, false, 'no bloquea');
    });

    // ═══ R68 (piloto) · el gate de generación con el lock, «Cursia recomienda» y Postgres reales ═══
    const { GenerationDesignGate } = loadDist('modules/course-design/generation-design-gate.js');
    const gate = new GenerationDesignGate(ds, design);
    const lockNow = async (cid) => (await blueprints.lock(cid, OWNER, await counter(cid))).blueprint.blueprintNumber;
    const gateReason = async (cid, n) => { try { await gate.assertVerified(cid, OWNER, n); return 'ok'; } catch (e) { const r = e.getResponse ? e.getResponse() : {}; return r.reason || r.code || String(e.message); } };

    await check('RG1 R68: estructura sin el diseño aplicado → pending_changes; con el diseño aplicado → ok', async () => {
      const cid = await courseWith('Gate 1', [3, 3], 'El curso tendrá 4 capítulos por módulo.');
      eq(await gateReason(cid, await lockNow(cid)), 'pending_changes', 'Cursia propone capítulos que no se aplicaron');
      await useDesign(cid);
      eq(await gateReason(cid, await lockNow(cid)), 'ok', 'diseño aplicado y aprobado');
    });

    await check('RG2 R68 (review C1): cambiar el perfil (horas) DESPUÉS de aprobar → design_changed (lo verificado = lo congelado)', async () => {
      const cid = await courseWith('Gate 2', [3, 3], 'El curso tendrá 3 capítulos por módulo.');
      await useDesign(cid);
      const n = await lockNow(cid);
      eq(await gateReason(cid, n), 'ok', 'aprobado');
      const cur = await profiles.getCurrent(cid, OWNER, 'pedagogy');
      await profiles.append(cid, OWNER, 'pedagogy', { ...cur.profile, targetHours: (cur.profile.targetHours || 10) + 8 }, cur.version);
      eq(await gateReason(cid, n), 'design_changed', 'el Blueprint congeló otras horas');
    });

    await check('RG3 R68: estructura editada tras aprobar → structure_changed; Blueprint anterior → blueprint_not_current', async () => {
      const cid = await courseWith('Gate 3', [3, 3], 'El curso tendrá 3 capítulos por módulo.');
      await useDesign(cid);
      const n1 = await lockNow(cid);
      const [ch] = await ds.query(`select id, module_id from public.course_chapters where course_id = $1 order by position limit 1`, [cid]);
      await structure.updateChapter(cid, ch.module_id, ch.id, OWNER, { title: 'Editado después de aprobar', expectedCounter: await counter(cid) });
      eq(await gateReason(cid, n1), 'structure_changed', 'editado');
      const n2 = await lockNow(cid);
      eq(await gateReason(cid, n1), 'blueprint_not_current', 'el Blueprint anterior ya no es el vigente');
      eq(await gateReason(cid, n2), 'ok', 're-aprobado');
    });

    await check('RG5 R68 (re-review P1): sin cambios por aplicar pero con el perfil de la tarjeta SIN guardar → exactamente design_not_saved', async () => {
      const cid = await courseWith('Gate 5', [3, 3], 'El curso tendrá 3 capítulos por módulo.');
      // El docente conserva su estructura (fija videos y Actividades) y elige horas, pero nunca usa «Usar este diseño»:
      // el enfoque y el audiovisual que propone Cursia no se guardan.
      for (const ch of await ds.query(`select id, module_id, video_enabled from public.course_chapters where course_id = $1`, [cid])) {
        await structure.updateChapter(cid, ch.module_id, ch.id, OWNER, { videoEnabled: ch.video_enabled, pinVideo: true, applicationMinutes: null, pinApplication: true, expectedCounter: await counter(cid) });
      }
      const pre = await design.recommend(cid, OWNER, {});
      const cur = await profiles.getCurrent(cid, OWNER, 'pedagogy');
      await profiles.append(cid, OWNER, 'pedagogy', { ...cur.profile, targetHours: Math.ceil(pre.design.baseHours * 2) / 2 }, cur.isDefault ? undefined : cur.version);
      const card = await design.recommend(cid, OWNER, {});
      eq([card.design.changes.length, card.verification.blocking, card.profileChanged], [0, false, true], 'sin cambios ni críticos, pero el perfil de la tarjeta no es el guardado');
      eq(await gateReason(cid, await lockNow(cid)), 'design_not_saved', 'motivo exacto');
      await useDesign(cid);
      eq(await gateReason(cid, await lockNow(cid)), 'ok', 'con «Usar este diseño» el perfil queda guardado');
    });

    await check('RG6 re-review P2: corregir un título y DESPUÉS «Usar este diseño» → la estructura sigue siendo de Cursia (el origen avanza con la nueva forma)', async () => {
      const cid = await courseWith('Gate 6', [3, 3], 'El curso tendrá 4 capítulos por módulo.');
      const [ch] = await ds.query(`select id, module_id from public.course_chapters where course_id = $1 order by position limit 1`, [cid]);
      await structure.updateChapter(cid, ch.module_id, ch.id, OWNER, { title: 'Título corregido', expectedCounter: await counter(cid) });
      await useDesign(cid);
      const [{ o }] = await ds.query(`select metadata -> 'structureOrigin' o from public.courses where id = $1`, [cid]);
      eq(o.shape, [4, 4], 'el origen tiene la forma nueva');
      assert(o.counter < await counter(cid), 're-review R1: el contador del origen NO avanza (el título corregido sigue protegido contra un reemplazo sin confirmar)');
      const SAuth = loadDist('modules/course-structure/structure-authority.js');
      eq(SAuth.originAfterCursiaDesign({ source: 'ai_proposal', counter: 1, contextVersion: null, at: '', shape: [3, 3] }, 5, 6, [3, 3]) !== null, true, 'misma forma → la estructura sigue siendo de Cursia');
      const card = await design.recommend(cid, OWNER, {});
      eq(reqCheck(card, 'chapters').severity, 'ok', 'el requisito se cumple con el diseño de Cursia (no es una excepción del docente)');
      eq(await gateReason(cid, await lockNow(cid)), 'ok', 'aprobable');
    });

    await check('RG4 R68: un crítico de Verificación → critical con la lista de críticos', async () => {
      // LOOP 9: el crítico es un documento que se contradice (Cursia no elige); «2 videos por capítulo» ya es una excepción.
      const cid = await courseWith('Gate 4', [3, 3], 'El curso tendrá 3 capítulos por módulo. El curso tendrá 2 evaluaciones parciales. Se realizarán 3 evaluaciones parciales.');
      await useDesign(cid);
      const n = await lockNow(cid);
      let resp = null;
      try { await gate.assertVerified(cid, OWNER, n); } catch (e) { resp = e.getResponse(); }
      eq(resp && resp.reason, 'critical', 'crítico');
      assert(resp.criticals.some((c) => /evaluaci/i.test(c.title)), JSON.stringify(resp.criticals));
      assert(/GENERATION_NOT_VERIFIED/.test(resp.message), resp.message);
    });

    await check('RG4b R68 (LOOP 9 review BE-L9 I2): lo que Cursia no puede producir (2 videos por capítulo) no es un crítico, pero bloquea la generación hasta que la institución registre el motivo (también fuera del flujo de propuesta)', async () => {
      const cid = await courseWith('Gate 4b', [3, 3], 'El curso tendrá 3 capítulos por módulo. Cada capítulo debe incluir 2 videos.');
      await useDesign(cid);
      const card = await design.recommend(cid, OWNER, {});
      const vchk = card.verification.checks.find((c) => c.capability);
      assert(vchk && vchk.severity === 'warning' && !card.verification.blocking, 'excepción, no crítico');
      const n = await lockNow(cid);
      let resp = null;
      try { await gate.assertVerified(cid, OWNER, n); } catch (e) { resp = e.getResponse(); }
      eq(resp && resp.reason, 'critical', 'sin motivo: R68 bloquea');
      assert(resp.criticals.some((c) => /falta el motivo/.test(c.title)), JSON.stringify(resp.criticals));
      const key = vchk.capability.requirementKey;
      await ds.query(`update public.courses set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{requirementExceptionReasons}', $2::jsonb, true) where id = $1`,
        [cid, JSON.stringify({ [key]: { reason: 'La institución acepta un video por capítulo.', requirementText: vchk.capability.requirementText, by: 'test', at: new Date().toISOString() } })]);
      eq(await gateReason(cid, n), 'ok', 'con el motivo registrado: pasa');
    });

    await check('RC7 conflictos que Cursia no resuelve sola: críticos con su causa; Verificación los muestra (el bloqueo real de la generación es R68, en runs; aplicar el diseño no se bloquea)', async () => {
      const cid = await courseWith('Conflictos', [4, 4, 4, 4], 'El curso tendrá 3 módulos. Se realizarán 3 evaluaciones parciales y 1 evaluación final. Cada capítulo tendrá 2 videos.');
      const card = await design.recommend(cid, OWNER, {});
      const mods = reqCheck(card, 'modules');
      eq(mods.severity, 'critical', 'módulos');
      assert(/El documento pide 3 módulos; el diseño tiene 4 módulos\. Cursia no agrega ni quita módulos por su cuenta/.test(mods.detail), mods.detail);
      const part = card.verification.checks.find((c) => c.area === 'requirements' && /parciales/.test(c.title));
      eq(part.severity, 'critical', 'parciales');
      assert(/Entra en conflicto con «3 módulos»/.test(part.detail) || /4 evaluaciones parciales/.test(part.detail), part.detail);
      eq(reqCheck(card, 'videos').severity, 'warning', 'dos videos por capítulo → excepción (LOOP 9)');
      eq(card.verification.blocking, true, 'Verificación: hay críticos (el paso 4 lo muestra)');
      eq(card.design.modules.length, 4, 'Cursia no quitó ningún módulo');
      const { applied } = await useDesign(cid);
      assert(applied, 'aplicar el diseño no se bloquea (lo que se bloquea es GENERAR: R68, check-r68-generation-gate.js / E18)');
    });

    await check('RC8 horas del docente contra el documento: se respetan y quedan como excepción', async () => {
      const cid = await courseWith('Horas', [3, 3], 'La intensidad horaria total será de 40 horas.');
      const doc = await design.recommend(cid, OWNER, {});
      eq([doc.hours.target, doc.hours.source], [40, 'requirement'], 'el documento manda');
      const card = await design.recommend(cid, OWNER, { adjust: { targetHours: 48 } });
      eq([card.hours.target, card.hours.source], [48, 'adjusted'], 'la decisión del docente se respeta');
      const hc = reqCheck(card, 'target_hours');
      eq(hc.severity, 'warning', 'excepción');
      assert(/el documento pide 40 horas; elegiste 48 horas/.test(hc.detail), hc.detail);
      eq(hc.fix.action, 'targetHours', '«Volver al requisito del documento»');
    });

    await check('RC9 escenario completo (4 × 5, 64 h, 1 AA/mód., 3+1 eval., 2 videos/cap.): diseña dentro y explica lo que no puede', async () => {
      const cid = await courseWith('Completo', [3, 3, 3, 3], FULL);
      const card = await design.recommend(cid, OWNER, {});
      eq(card.design.modules.map((m) => m.chapters.length), [5, 5, 5, 5], '4 × 5 con propuestos');
      eq(card.design.modules.map((m) => m.chapters.filter((c) => c.applicationMinutes).length), [1, 1, 1, 1], '1 Actividad de Aplicación por módulo');
      eq(card.hours.target, 64, '64 h');
      eq(reqCheck(card, 'modules').severity, 'ok', '4 módulos');
      eq(reqCheck(card, 'chapters').severity, 'ok', '5 por módulo');
      eq(reqCheck(card, 'application_activities').severity, 'ok', 'AA');
      eq(reqCheck(card, 'videos').severity, 'warning', '2 videos por capítulo: no se puede → excepción explicada (LOOP 9)');
      const part = card.verification.checks.find((c) => c.area === 'requirements' && /parciales/.test(c.title));
      eq(part.severity, 'critical', '3 parciales con 4 módulos evaluados');
      assert(/Entra en conflicto con «4 módulos»/.test(part.detail), part.detail);
      const fin = card.verification.checks.find((c) => c.area === 'requirements' && /final/.test(c.title));
      eq(fin.severity, 'ok', '1 final');
    });
  } catch (err) {
    failed++;
    console.log(`❌ parte DB: ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n   ') : err}`);
  } finally {
    if (ds && ds.isInitialized) await ds.destroy().catch(() => {});
    if (started) pg('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const [k, envK] of [['flag', 'DYNAMIC_COURSE_STRUCTURE'], ['allow', 'DYNAMIC_V2_ALLOWED_OWNERS'], ['unowned', 'ALLOW_UNOWNED_COURSES'], ['rules', 'DYNAMIC_MANIFEST_RULES_VERSION'], ['atr', 'DYNAMIC_ACTIVITY_TYPE_RULES']]) {
      if (saved[k] === undefined) delete process.env[envK]; else process.env[envK] = saved[k];
    }
  }
}
