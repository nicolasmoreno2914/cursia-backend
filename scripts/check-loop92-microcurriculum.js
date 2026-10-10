#!/usr/bin/env node
/**
 * LOOP 9.2 · Un microcurrículo institucional real (DOCX «Atención Integral en Salud a Víctimas de Violencia Sexual», 2 × 2)
 * de punta a punta, sin red ni base (USD 0): documento → lo que entendimos → requisitos → estructura → diseño → verificación.
 *   MC1  lectura académica: nombre (rótulo y valor en celdas), prerrequisitos recomendados, metodología («Enfoque pedagógico
 *        y metodología»), 2 módulos × 2 capítulos con sus temas, sin conflicto de objetivo por el «Propósito» de cada módulo
 *   MC2  sector inferido con evidencia (Salud) y tipo de conocimientos previos (exige / recomienda / ninguno / sin dato)
 *   MC3  requisitos: los 13 exactos; la sección «Información no prescriptiva» no aporta ninguno; «más de N» = al menos N+1
 *   MC4  estructura del documento: 2 × 2 con los títulos del documento y los 5 resultados vinculados
 *   MC5  diseño: 1 práctica por módulo, 1 Actividad de Aplicación por módulo EN la práctica, 4 actividades, 4 videos, 2 + 1
 *        evaluaciones, 8 h; aplicar el diseño es un punto fijo
 *   MC6  verificación: todo cumple salvo la limitación real de video (un video por capítulo, ver auditoría P0): «2 por capítulo
 *        de contenido» y «8 videos» son excepciones de capacidad con UN solo motivo (coveredBy); ningún crítico
 *   MC7  la capacidad solo es «imposible» si el documento fija la estructura; si no, faltan videos y es un incumplimiento
 *   MC8  enfoque desde la metodología del documento (casos → ABP); la decisión del docente sigue siendo una excepción
 *   MC16 (Fase 1 · «Pegar información») el MISMO microcurrículo pegado como texto (sin tablas ni estilos) da el mismo
 *        contexto y los mismos requisitos que el DOCX: nombre («Nombre» y valor en la línea siguiente), RA, unidades, horas
 *   MC15 (capacidades) Cursia recomienda solo lo que produce hoy; lo que el documento pida por encima (2 videos / 2 H5P /
 *        2 AA por capítulo, más videos de los que caben, más parciales que módulos, 2 finales, 2 evaluaciones por módulo,
 *        más de 500 h) es «Requisito no cubierto por Cursia» con lo que SÍ queda previsto; «sin evaluación final» se lee bien
 *   MC14 (QA staging) las Actividades de Aplicación de las prácticas llevan el mismo nivel y el diseño queda cerca de las
 *        horas del documento; si quedara por encima de la tolerancia, «8 horas» NO cumple (se compara con el diseño)
 *
 *   node scripts/check-loop92-microcurriculum.js   (requiere npm run build)
 */
const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..');
const D = (p) => require(path.join(REPO, 'dist', p));
const T = D('modules/academic-context/extract/text-sources.js');
const E = D('modules/academic-context/extract/extractor.js');
const X = D('modules/academic-context/requirements/requirements-extractor.js');
const RA = D('modules/academic-context/requirements/requirement-authority.js');
const DR = D('modules/academic-context/requirements/document-requirements.js');
const CD = D('modules/academic-context/context-design.js');
const F = D('modules/course-facts/course-facts.js');
const ST = D('modules/study-time/distributor.js');
const SNAP = D('modules/course-blueprints/blueprint-snapshot.js');
const DOCX = fs.readFileSync(path.join(REPO, 'scripts/fixtures/microcurriculum/atencion-violencia-sexual-2x2.docx'));

let ok = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); ok++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reqsOfText = (text) => X.requirementsFor(X.extractRequirements(T.readText(Buffer.from(text, 'utf8'), 'text/plain').lines), {});

(async () => {
  const ctx = (await E.extractAcademicContext([{ name: 'doc.docx', data: DOCX }])).context;
  const doc = await T.readDocument(DOCX, 'doc.docx');
  const ext = X.extractRequirements(doc.lines);
  const applicable = X.requirementsFor(ext, {});
  const required = applicable.filter((r) => r.obligation === 'required' && r.confidence === 'high');
  const proposal = CD.proposeStructureFromContext(ctx);
  const constraints = RA.constraintsFor(required, {});
  const course = { id: 1, title: 'Curso', finalExam: true, activityEngine: 'h5p', reviewCards: false, academicContext: null };
  const modules = proposal.modules.map((m, i) => ({ id: uuid(100 + i), position: i, title: m.title, objective: null, description: null, exam_enabled: true }));
  const chapters = [];
  proposal.modules.forEach((m, mi) => m.chapters.forEach((ch, ci) => chapters.push({ id: uuid(1000 + mi * 20 + ci), module_id: modules[mi].id, position: ci, title: ch.title, objective: 'Aplicar lo visto', description: ch.description, video_enabled: true, activity_enabled: true })));
  const distOf = (chs, cons = constraints) => ST.distributeCourseHours({ snapshot: SNAP.buildBlueprintSnapshotV2(course, modules, chs), rules: null, targetHours: 8, preferences: { audiovisual: 'recommended' }, pins: null, requirements: cons });
  const dist = distOf(chapters);
  // Igual que designForRequirements (course-design.service): con lo fijado por el docente.
  const designOf = (d, extra = {}) => ({ modules: d.modules.map((m) => ({ examEnabled: true, ...(m.practiceRemovedByTeacher ? { practiceRemovedByTeacher: true } : {}), chapters: m.chapters.map((c) => ({ kind: c.kind, proposed: c.proposed, videoEnabled: c.videoEnabled, activityEnabled: c.activityEnabled, activityPinned: !!c.activityPinned, applicationMinutes: c.applicationMinutes, hours: (c.targetMinutes || 60) / 60 })) })), evaluations: d.counts.evaluations, targetHours: 8, hoursSource: 'document', structureByTeacher: false, audiovisualByTeacher: false, applicationByTeacher: false, ...extra });
  const verify = (d, extra) => RA.requirementVerificationChecks(applicable, DR.compareRequirements(applicable, designOf(d, extra)), { status: d.status, baseHours: 1, estimatedHours: d.estimatedHours, modules: 2, moduleExams: 2, exceptionFields: {} });

  await check('MC1 lectura académica: nombre, prerrequisitos, metodología, 2 módulos × 2 capítulos con temas, sin conflicto de objetivo', () => {
    eq(ctx.identity.subjectName.value, 'Atención Integral en Salud a Víctimas de Violencia Sexual', 'nombre («Nombre | valor»)');
    assert(/^Se recomienda contar con conocimientos básicos de anatomía/.test(ctx.learner.priorKnowledge.value[0]), `prerrequisitos sin el rótulo: ${ctx.learner.priorKnowledge.value}`);
    assert(/razonamiento sobre casos/.test(ctx.methodology.value), 'metodología');
    eq(ctx.units.map((u) => u.title), ['Fundamentos, derechos y atención inicial', 'Atención integral, prevención de consecuencias y articulación'], 'módulos');
    eq(ctx.units.map((u) => u.contents.length), [2, 2], 'capítulos de contenido (la práctica y la evaluación parcial no son capítulos de contenido)');
    assert(/^Derechos, conceptos y enfoque de atención: Conceptos fundamentales/.test(ctx.units[0].contents[0].text), ctx.units[0].contents[0].text);
    eq(ctx.conflicts, [], 'el «Propósito» de un módulo no es otro objetivo general');
    assert(ctx.bibliography.length >= 5, 'referentes y fuentes');
  });

  await check('MC2 sector con evidencia y tipo de conocimientos previos', () => {
    eq(F.sectorFromKeywords(ctx), 'Salud', 'sector');
    eq(F.prerequisitesKindOf(ctx.learner.priorKnowledge.value), 'recommended', 'recomendados (aunque «no se exige un prerrequisito formal»)');
    eq(F.prerequisitesKindOf(['No se exige ningún prerrequisito.']), 'none', 'ninguno');
    eq(F.prerequisitesKindOf(['Contabilidad básica', 'Manejo de hoja de cálculo']), 'required', 'exigidos');
    eq(F.prerequisitesKindOf([]), null, 'sin dato');
    eq(F.sectorFromKeywords({ identity: { subjectName: { status: 'found', value: 'Curso de liderazgo' }, educationLevel: { status: 'missing', value: null }, description: { status: 'missing', value: null } }, learner: { profile: { status: 'missing', value: null } } }), null, 'sin evidencia: sin sector');
  });

  await check('MC3 requisitos: los 13 exactos; la sección no prescriptiva no aporta ninguno; «más de N» = al menos N+1', () => {
    eq(applicable.map((r) => `${r.key}=${r.value ?? r.shape}`), [
      'modules@course=2', 'chapters@module·each:content=2', 'chapters@module·each:practice=1', 'videos@course=8', 'videos@chapter·each:content=2',
      'activities@course=4', 'activities@chapter·each:content=1', 'application_activities@course=2', 'application_activities@module·each:practice=1',
      'evaluations@course#partial=2', 'evaluations@course#final=1', 'target_hours@course=8', 'structure@structure:content=2,2',
    ], 'requisitos');
    assert(applicable.every((r) => r.obligation === 'required' && r.confidence === 'high' && r.mode === 'exact'), 'todos obligatorios, exactos y con confianza alta');
    assert(ext.ignored.filter((i) => i.reason === 'not_prescriptive').length >= 3, 'sección 15 registrada como no prescriptiva');
    assert(!applicable.some((r) => r.obligation === 'permitted'), 'ningún «permitido» de la sección 15');
    eq(RA.requirementText(applicable.find((r) => r.key === 'chapters@module·each:practice')), '1 capítulo de práctica por módulo', 'texto práctica');
    eq(RA.requirementText(applicable.find((r) => r.key === 'application_activities@module·each:practice')), '1 Actividad de Aplicación por módulo, en el capítulo de práctica', 'texto Actividad de Aplicación');
    eq(RA.requirementText(applicable.find((r) => r.kind === 'structure')), 'estructura 2 × 2 (4 capítulos de contenido)', 'texto estructura');
    const more = reqsOfText('El curso tendrá más de 2 evaluaciones parciales.')[0];
    eq([more.mode, more.value], ['min', 3], '«más de 2» = al menos 3');
    const less = reqsOfText('El curso tendrá menos de 5 módulos.')[0];
    eq([less.mode, less.value], ['max', 4], '«menos de 5» = hasta 4');
    const nm = reqsOfText('El curso no tendrá menos de 5 módulos.')[0];
    eq([nm.mode, nm.value], ['min', 5], '«no tendrá menos de 5» = al menos 5');
    const nmx = reqsOfText('El curso no tendrá más de 5 módulos.')[0];
    eq([nmx.mode, nmx.value], ['max', 5], '«no tendrá más de 5» = hasta 5');
    // Una sección no prescriptiva no se extiende a la siguiente.
    const two = reqsOfText(['1. Información no prescriptiva', 'Algunos programas tendrán 3 módulos.', '2. Estructura del curso', 'El curso tendrá 2 módulos.'].join('\n'));
    eq(two.map((r) => `${r.key}=${r.value}`), ['modules@course=2'], 'solo la sección prescriptiva');
  });

  await check('MC4 estructura del documento: 2 × 2 con sus títulos y los 5 resultados vinculados', () => {
    eq(proposal.modules.map((m) => m.chapters.map((c) => c.title)), [['Derechos, conceptos y enfoque de atención', 'Recepción y valoración inicial'], ['Atención clínica integral y prevención de consecuencias', 'Evidencias, documentación y articulación de la ruta']], 'capítulos');
    eq(proposal.counts.outcomesCovered, 5, 'los 5 resultados con capítulo');
    assert(proposal.modules.flatMap((m) => m.chapters).every((c) => c.outcomeIds.length), 'todo capítulo con al menos un resultado');
  });

  await check('MC5 diseño: práctica por módulo, Actividad de Aplicación en la práctica, 4 actividades, 4 videos, 2 + 1 evaluaciones; punto fijo', () => {
    eq(dist.modules.map((m) => m.chapters.map((c) => c.kind)), [['content', 'content', 'practice'], ['content', 'content', 'practice']], 'forma');
    eq(dist.modules.map((m) => m.chapters.filter((c) => c.applicationMinutes).map((c) => c.kind)), [['practice'], ['practice']], '1 Actividad de Aplicación por módulo, en la práctica');
    eq([dist.counts.activities, dist.counts.videoChapters, dist.counts.evaluations, dist.counts.applicationActivities], [4, 4, 3, 2], 'actividades, videos, evaluaciones, Actividades de Aplicación');
    eq(dist.modules.flatMap((m) => m.chapters).filter((c) => c.kind === 'practice').map((c) => c.activityEnabled), [false, false], 'las prácticas no suman actividades (total exacto 4)');
    assert(dist.status === 'within_tolerance', `horas: ${dist.status} ${dist.estimatedHours}`);
    const ch2 = [];
    dist.modules.forEach((m, mi) => m.chapters.forEach((c, ci) => ch2.push({ id: c.proposed ? uuid(5000 + mi * 20 + ci) : c.chapterId || c.id, module_id: modules[mi].id, position: ci, title: c.title, objective: 'Aplicar lo visto', description: null, video_enabled: c.videoEnabled, activity_enabled: c.activityEnabled, application_minutes: c.applicationMinutes, ...(c.kind === 'practice' ? { chapter_kind: 'practice' } : {}) })));
    const again = distOf(ch2);
    eq([again.status, again.changes.length], ['within_tolerance', 0], 'aplicar el diseño es un punto fijo');
  });

  await check('MC6 verificación: todo cumple salvo la limitación de video, con UN motivo para «8 videos» y «2 por capítulo»; sin críticos', () => {
    const v = verify(dist);
    eq(v.filter((c) => c.severity === 'critical').map((c) => c.title), [], 'ningún crítico');
    const ex = v.filter((c) => c.capability);
    eq(ex.map((c) => c.capability.requirementKey).sort(), ['videos@chapter·each:content', 'videos@course'], 'dos excepciones de capacidad');
    const total = ex.find((c) => c.capability.requirementKey === 'videos@course');
    eq(total.capability.coveredBy, { requirementKey: 'videos@chapter·each:content', requirementText: '2 videos por capítulo de contenido' }, 'un solo motivo');
    // LOOP 9.2 (capacidades): «solicita / contempla» con lo que SÍ queda previsto; título «Requisito no cubierto por Cursia».
    eq(total.capability.produces, 'Cursia contempla 1 video por capítulo de contenido (4 videos previstos en total)', 'lo que Cursia contempla');
    assert(/^Requisito no cubierto por Cursia: 8 videos$/.test(total.title) && /^El microcurrículo solicita 8 videos\. Actualmente, Cursia contempla 1 video por capítulo de contenido \(4 videos previstos en total\)\. No se puede presentar como cumplido/.test(total.detail), JSON.stringify([total.title, total.detail]));
    eq(v.filter((c) => c.severity === 'ok').length, 11, 'los otros 11 requisitos cumplen');
  });

  await check('MC7 capacidad: «imposible» solo si el documento fija la estructura', () => {
    const free = reqsOfText('El curso tendrá 8 videos.');
    const d = { modules: [{ examEnabled: true, chapters: [{ kind: 'content', videoEnabled: true, activityEnabled: true, applicationMinutes: null, hours: 2 }] }], evaluations: 1, targetHours: 8, hoursSource: 'document', structureByTeacher: false, audiovisualByTeacher: false, applicationByTeacher: false };
    const c = DR.compareRequirements(free, d)[0];
    eq([c.status, !!c.impossible], ['unmet', false], 'sin estructura fija: faltan videos (se agregan capítulos), no es una limitación');
    const fixed = reqsOfText('El curso tendrá 2 módulos de 2 capítulos. El curso tendrá 8 videos.');
    const c2 = DR.compareRequirements(fixed, d).find((x) => fixed.find((r) => r.id === x.requirementId).kind === 'videos');
    eq([c2.status, !!c2.impossible, c2.actual.value], ['not_verifiable', true, 1], 'con 2 × 2 fijo y un diseño que no llega: imposible (dice cuántos tiene el diseño)');
    // Review I8: si el docente (o un formato) armó más capítulos y el diseño ya tiene los videos, se compara como siempre.
    const big = { ...d, modules: [0, 1, 2].map(() => ({ examEnabled: true, chapters: [0, 1, 2, 3].map(() => ({ kind: 'content', videoEnabled: true, activityEnabled: true, applicationMinutes: null, hours: 1 })) })) };
    const c3 = DR.compareRequirements(fixed, big).find((x) => fixed.find((r) => r.id === x.requirementId).kind === 'videos');
    eq([c3.status, !!c3.impossible], ['unmet', false], '12 videos en el diseño: no es una limitación (es exacto 8 → incumple, se explica)');
  });

  await check('MC8 enfoque desde la metodología; la decisión del docente sigue siendo una excepción visible', () => {
    eq(CD.approachFromMethodology(ctx.methodology.value), { id: 'problemas', strong: false }, 'casos clínicos → ABP (sugerido, confianza media; «autoaprendizaje» es la modalidad)');
    eq(CD.approachFromMethodology('Clases magistrales, lecturas y un estudio de caso final.'), null, 'un estudio de caso es una técnica, no el enfoque');
    eq(CD.approachFromMethodology('El curso sigue un enfoque por competencias; se usarán talleres y estudios de caso.'), { id: 'competencias', strong: true }, 'el enfoque nombrado manda (review I7)');
    eq(CD.approachFromMethodology('Aprendizaje experiencial centrado en situaciones reales.'), { id: 'experiencial', strong: true }, 'experiencial');
    // El docente quita la práctica del módulo 2: Cursia no la vuelve a poner sola y queda como excepción del docente.
    // (Diseño ya aplicado: nada queda «propuesto».)
    const noPractice = { ...dist, modules: dist.modules.map((m, i) => ({ ...m, chapters: (i === 1 ? m.chapters.filter((c) => c.kind !== 'practice') : m.chapters).map((c) => ({ ...c, proposed: false })) })) };
    const v = verify(noPractice, { structureByTeacher: true });
    const p = v.find((c) => /1 capítulo de práctica por módulo/.test(c.title));
    assert(p && p.severity === 'warning' && /^Excepción al requisito del documento/.test(p.title), JSON.stringify(p));
    const c = RA.constraintsFor(required, {}, { structureByTeacher: true });
    eq(c.contentChaptersPerModule, { max: 2 }, 'con estructura del docente: solo el máximo de contenido');
  });

  // ── Revisión independiente LOOP 9.2: otros documentos y desviaciones del docente ──
  const acx = async (text, name = 'doc.txt') => (await E.extractAcademicContext([{ name, data: Buffer.from(text, 'utf8') }])).context;
  await check('MC9 (review C1/I2/I3/I4) el árbol de módulos no secuestra «Contenidos», la evaluación ni el objetivo; «Nombre» solo en la ficha', async () => {
    const a = await acx(['Asignatura: Contabilidad general', 'Contenidos temáticos', 'Los contenidos se organizan en dos unidades.', 'Unidad 1: Fundamentos contables', '- Ecuación contable', '- Cuentas', 'Unidad 2: Estados financieros', '- Balance general', '- Estado de resultados'].join('\n'));
    eq(CD.proposeStructureFromContext(a).modules.map((m) => `${m.title}:${m.chapters.length}`), ['Fundamentos contables:2', 'Estados financieros:2'], 'Contenidos clásicos (sin módulo fantasma)');
    const b = await acx(['Asignatura: Seguridad industrial', 'Contenidos', 'Módulo 1: Gestión del riesgo', '- Identificación de peligros', '- Evaluación de riesgos', '- Controles de ingeniería', 'Módulo 2: Emergencias', '- Práctica de evacuación', '- Planes de emergencia', '- Brigadas'].join('\n'));
    eq(b.units.map((u) => u.contents.length), [3, 3], 'temas que empiezan con «Evaluación…» / «Práctica…» siguen siendo temas');
    const ev = await acx(['Asignatura: Redes', 'Evaluación', 'Módulo 1: 30 %', 'Módulo 2: 30 %', 'Examen final: 40 %'].join('\n'));
    eq([ev.evaluation.length, ev.units.length], [3, 0], '«Módulo N: 30 %» en la evaluación no son unidades');
    const g = await acx(['Asignatura: Redes', '1. Módulo 1 — Fundamentos de redes', 'Capítulo 1. Modelo OSI', 'Capas y protocolos', 'Objetivo general: Diseñar redes LAN seguras.'].join('\n'));
    eq(g.identity.generalObjective.value, 'Diseñar redes LAN seguras.', 'un objetivo general después del árbol no se pierde');
    const n = await acx(['Asignatura: Farmacología', 'Docente', 'Nombre: Juan Pérez', 'Objetivo general: Comprender los fármacos.'].join('\n'));
    eq([n.identity.subjectName.value, n.conflicts.length], ['Farmacología', 0], '«Nombre» del docente no es el curso');
    const pm = await acx(['Asignatura: Redes', '8. Módulo 1 — Fundamentos de redes locales', 'Propósito del módulo: comprender el modelo OSI.', 'Capítulo 1. Modelo OSI', 'Capas', 'Capítulo 2. Direccionamiento IP', 'Subredes'].join('\n'));
    eq(pm.units.map((u) => u.contents.length), [2], '«Propósito del módulo» no es un capítulo (review 2.ª I4)');
    const n2 = await acx(['Docente', 'Nombre: Juan Pérez', 'Objetivo general: Comprender los fármacos.'].join('\n'));
    assert(n2.identity.subjectName.status === 'missing', 'sin la ficha, un «Nombre» del docente nunca es el nombre del curso');
  });

  await check('MC10 (review C1/C2/I1/I2) desviaciones del docente: actividad fijada y práctica quitada se respetan y son SU excepción; un formato no relaja nada', () => {
    const ch = [];
    dist.modules.forEach((m, mi) => m.chapters.forEach((c, ci) => ch.push({ id: c.proposed ? uuid(7000 + mi * 20 + ci) : c.chapterId || c.id, module_id: modules[mi].id, position: ci, title: c.title, objective: 'Aplicar', description: null, video_enabled: c.videoEnabled, activity_enabled: c.activityEnabled, application_minutes: c.applicationMinutes, ...(c.kind === 'practice' ? { chapter_kind: 'practice' } : {}) })));
    const run = (chs, pins, cons = constraints) => ST.distributeCourseHours({ snapshot: SNAP.buildBlueprintSnapshotV2(course, modules, chs), rules: null, targetHours: 8, preferences: { audiovisual: 'recommended' }, pins, requirements: cons });
    // (a) El docente enciende la actividad de la práctica 1 (misma forma: no es «estructura del docente»).
    const p1 = ch.find((c) => c.chapter_kind === 'practice');
    const a = run(ch.map((c) => (c === p1 ? { ...c, activity_enabled: true } : c)), { [p1.id]: { activity: true } });
    eq(a.changes.filter((x) => x.type === 'set_activity').length, 0, 'su actividad no se revierte');
    const va = verify(a);
    const act = va.find((c) => /^Excepción al requisito del documento: 4 actividades interactivas/.test(c.title));
    assert(act && act.severity === 'warning', `actividad del docente = excepción: ${JSON.stringify(va.filter((c) => c.severity !== 'ok').map((c) => c.title))}`);
    // (b) El docente quita la práctica del módulo 2 (pin del módulo): no se re-propone; práctica y Actividades de Aplicación son su excepción.
    const ch2 = ch.filter((c) => !(c.chapter_kind === 'practice' && c.module_id === modules[1].id));
    const b = run(ch2, { [modules[1].id]: { noPractice: true } });
    eq(b.changes.filter((x) => x.type === 'add_practice_chapter').length, 0, 'sin re-proponer la práctica');
    const vb = verify(b, { structureByTeacher: true });
    eq(vb.filter((c) => c.severity === 'critical').map((c) => c.title), [], 'ningún crítico por la decisión del docente');
    for (const t of [/1 capítulo de práctica por módulo/, /^Excepción al requisito del documento: 2 Actividades de Aplicación/, /1 Actividad de Aplicación por módulo, en el capítulo de práctica/]) {
      const x = vb.find((c) => t.test(c.title));
      assert(x && x.severity === 'warning', `${t}: ${JSON.stringify(x)}`);
    }
    // (c) Formato elegido / estructura del docente sobre un 2 × 2 nuevo: Cursia SIGUE cumpliendo práctica y actividades.
    const f = distOf(chapters, RA.constraintsFor(required, {}, { structureByTeacher: true }));
    eq([f.counts.practiceChapters, f.counts.activities, f.counts.applicationActivities], [2, 4, 2], 'práctica en los dos módulos, 4 actividades, 2 Actividades de Aplicación');
    // (e) Review 3.ª I1: un pin que no cambia nada (actividad de un capítulo de contenido, encendida) no desactiva el ajuste.
    const c11 = ch.find((c) => !c.chapter_kind);
    const e = run(ch.map((c) => (c.chapter_kind === 'practice' ? { ...c, activity_enabled: true } : c)), { [c11.id]: { activity: true } });
    eq(e.counts.activities, 4, 'Cursia sigue ajustando las actividades que no fijó el docente');
    eq(verify(e).filter((x) => /actividad/.test(x.title) && x.severity !== 'ok').map((x) => x.title), [], 'sin excepción por un pin que no cambia nada');
    // (d) El docente agrega un 3.er capítulo de contenido al módulo 1: «8 videos» sigue siendo la limitación (no un crítico).
    const extra = [...ch, { id: uuid(8800), module_id: modules[0].id, position: 9, title: 'Capítulo extra', objective: 'Aplicar', description: null, video_enabled: true, activity_enabled: true }];
    const d = run(extra, null);
    const vd = verify(d, { structureByTeacher: true });
    const v8 = vd.find((c) => /8 videos$/.test(c.title));
    assert(v8 && v8.severity === 'warning' && v8.capability, `8 videos: ${JSON.stringify(v8)}`);
    // Review 3.ª I2: Cursia no apaga la actividad de un capítulo de contenido («1 por capítulo de contenido»); el 5.º capítulo
    // del docente deja 5 actividades: su excepción, sin críticos.
    eq(d.changes.filter((x) => x.type === 'set_activity').length, 0, 'sin apagar actividades de contenido');
    eq(vd.filter((x) => x.severity === 'critical').map((x) => x.title), [], 'sin críticos');
    const a5 = vd.find((x) => /4 actividades interactivas$/.test(x.title));
    assert(a5 && a5.severity === 'warning', JSON.stringify(a5));
  });

  await check('MC11 (review I1/I11) la práctica respeta el máximo por módulo; en el curso o con «cada módulo» a mitad de frase se cumple', () => {
    const run = (text, shape) => {
      const req = reqsOfText(text);
      const strict = req.filter((r) => r.obligation === 'required' && r.confidence === 'high');
      const mods = shape.map((_, i) => ({ id: uuid(300 + i), position: i, title: `Módulo ${i + 1}`, objective: null, description: null, exam_enabled: true }));
      const chs = [];
      mods.forEach((m, mi) => Array.from({ length: shape[mi] }).forEach((_, ci) => chs.push({ id: uuid(3000 + mi * 20 + ci), module_id: m.id, position: ci, title: `Cap ${mi + 1}.${ci + 1}`, objective: 'Aplicar', description: null, video_enabled: true, activity_enabled: true })));
      const r = ST.distributeCourseHours({ snapshot: SNAP.buildBlueprintSnapshotV2(course, mods, chs), rules: null, targetHours: 40, preferences: { audiovisual: 'recommended' }, pins: null, requirements: RA.constraintsFor(strict, {}) });
      return { r, v: RA.requirementVerificationChecks(req, DR.compareRequirements(req, designOf(r)), { status: r.status, baseHours: 1, estimatedHours: r.estimatedHours, modules: shape.length, moduleExams: shape.length, exceptionFields: {} }) };
    };
    const a = run('El curso tendrá 3 módulos de 4 capítulos. Cada módulo incluirá 1 capítulo de práctica.', [4, 4, 4]);
    assert(a.r.modules.every((m) => m.chapters.length <= 4), 'nunca 5 capítulos por módulo');
    const b = run('El curso tendrá 3 módulos. El curso tendrá 2 capítulos de práctica.', [3, 3, 3]);
    eq(b.r.counts.practiceChapters, 2, '2 prácticas en el curso');
    // Review 2.ª (I5): aplicar el diseño con prácticas del curso es un punto fijo (la prioridad audiovisual se aplica al final).
    const mods3 = [0, 1, 2].map((i) => ({ id: uuid(300 + i), position: i, title: `Módulo ${i + 1}`, objective: null, description: null, exam_enabled: true }));
    const req3 = reqsOfText('El curso tendrá 3 módulos. El curso tendrá 2 capítulos de práctica.').filter((r) => r.obligation === 'required');
    // (Con varios capítulos de profundización por módulo la convergencia toma 2 pasos: conflicto previo entre «la
    // profundización de Cursia va sin video» y «Recomendado: video salvo el cierre» — P2 documentado, igual en staging.)
    const r30 = (chs) => ST.distributeCourseHours({ snapshot: SNAP.buildBlueprintSnapshotV2(course, mods3, chs), rules: null, targetHours: 30, preferences: { audiovisual: 'recommended' }, pins: null, requirements: RA.constraintsFor(req3, {}) });
    const base3 = [];
    mods3.forEach((m, mi) => [0, 1, 2].forEach((ci) => base3.push({ id: uuid(3000 + mi * 20 + ci), module_id: m.id, position: ci, title: `Cap ${mi + 1}.${ci + 1}`, objective: 'Aplicar', description: null, video_enabled: true, activity_enabled: true })));
    const d30 = r30(base3);
    const ap30 = [];
    d30.modules.forEach((m, mi) => m.chapters.forEach((c, ci) => ap30.push({ id: c.proposed ? uuid(9500 + mi * 20 + ci) : c.chapterId || c.id, module_id: mods3[mi].id, position: ci, title: c.title, objective: 'Aplicar', description: null, video_enabled: c.videoEnabled, activity_enabled: c.activityEnabled, application_minutes: c.applicationMinutes, ...(c.kind === 'practice' ? { chapter_kind: 'practice' } : {}) })));
    eq(r30(ap30).changes.length, 0, 'punto fijo (caso de la revisión: 3 × 3, 2 prácticas, 30 h)');

    assert(!b.v.some((c) => c.severity === 'critical' && /práctica/.test(c.title)), 'sin crítico sobre el diseño de Cursia');
    eq(reqsOfText('El curso tendrá 2 módulos de 2 capítulos de contenido y cada módulo tendrá 1 capítulo de práctica.').filter((r) => (r.scope.chapterKind === 'practice')).map((r) => r.key), ['chapters@module·each:practice'], '«cada módulo» a mitad de frase');
  });

  await check('MC12 (review I5/I6) sector por puntaje (sin falsos positivos) y la elección de «Crear» manda sobre el documento', () => {
    const c = (name, profile, desc) => ({ identity: { subjectName: { status: 'found', value: name }, educationLevel: { status: 'missing', value: null }, description: desc ? { status: 'found', value: desc } : { status: 'missing', value: null } }, learner: { profile: profile ? { status: 'found', value: profile } : { status: 'missing', value: null } } });
    eq(F.sectorFromKeywords(c('Gestión de inventarios', null, 'Normas de seguridad y salud para cuidar la salud de los operarios en la bodega.')), 'Logística', 'inventarios');
    eq(F.sectorFromKeywords(c('Atención al cliente', 'Personal que atiende pacientes y pacientes nuevos.')), null, 'atención al cliente: sin evidencia');
    eq(F.sectorFromKeywords(c('Derecho administrativo')), null, 'derecho administrativo');
    eq(F.sectorFromKeywords(c('Python para análisis de datos', 'docentes de colegio')), 'Tecnología', 'python');
    eq(F.sectorFromKeywords(c('Seguridad y Salud en el Trabajo para supervisores')), 'Seguridad y Salud en el Trabajo', 'SST no es «Salud»');
  });

  await check('MC13 (review I9/I10/M2) negación ligada al verbo; bordes de la sección no prescriptiva; el reparto no aplica a evaluaciones', () => {
    const one = (t) => { const r = reqsOfText(t)[0]; return r ? [r.mode, r.value] : null; };
    eq(one('El curso no es presencial y tendrá menos de 5 módulos.'), ['max', 4], '«no» que no gobierna');
    eq(one('Cada capítulo tendrá sin más de 2 videos por capítulo.'), ['max', 2], '«sin más de 2» = hasta 2');
    eq(one('Se realizarán no más de 2 evaluaciones parciales.'), ['max', 2], '«no más de 2» = hasta 2');
    const np1 = reqsOfText(['15. Información no prescriptiva', '1. Algunos programas usan 6 módulos', '2. Otros programas tendrán 40 horas'].join('\n'));
    eq(np1.length, 0, 'los ítems numerados de la sección no la cierran');
    const np2 = reqsOfText(['15. Información no prescriptiva', 'Algunos programas usan 6 módulos.', 'ANEXO A - Estructura del curso', 'El curso tendrá 3 módulos de 4 capítulos.'].join('\n'));
    assert(np2.some((r) => r.key === 'modules@course' && r.value === 3), `un anexo cierra la sección: ${JSON.stringify(np2.map((r) => r.key))}`);
    eq(reqsOfText('El curso tendrá 2 evaluaciones parciales y 1 evaluación final: 1 por módulo.').map((r) => r.key), ['evaluations@course#partial', 'evaluations@course#final'], 'sin «1 evaluación final por módulo»');
    // Review 2.ª: «N módulos de M capítulos de contenido» conserva «de contenido»; «no podrá tener más de 4» es obligatorio.
    eq(reqsOfText('El curso tendrá 2 módulos de 2 capítulos de contenido.').map((r) => r.key), ['modules@course', 'chapters@module·each:content', 'structure@structure:content'], 'de contenido');
    const np = reqsOfText('El curso no podrá tener más de 4 módulos.')[0];
    eq([np.obligation, np.mode, np.value], ['required', 'max', 4], 'prohibición = máximo obligatorio');
  });

  await check('MC14 (QA staging) Actividades de Aplicación parejas en las prácticas; «8 horas» se compara con el diseño si se pasa', () => {
    const app = dist.modules.map((m) => m.chapters.filter((c) => c.kind === 'practice').map((c) => c.applicationMinutes)[0]);
    assert(app[0] !== null && app[0] === app[1], `mismo nivel en las dos prácticas (antes 120 y 30): ${JSON.stringify(app)}`);
    assert(Math.abs(dist.estimatedHours - 8) <= 0.5 + 1e-9, `cerca de 8 h (antes 8,9–9,4 h): ${dist.estimatedHours}`);
    // El requisito de horas frente a un diseño por encima de la tolerancia: no cumple y lo explica.
    const over = { ...dist, status: 'above_tolerance', estimatedHours: 9.4 };
    const hv = RA.requirementVerificationChecks(applicable, DR.compareRequirements(applicable, designOf(over, { estimatedHours: 9.4, hoursStatus: 'above_tolerance' })),
      { status: 'above_tolerance', baseHours: 1, estimatedHours: 9.4, modules: 2, moduleExams: 2, exceptionFields: {} }).find((c) => /8 horas/.test(c.title));
    assert(hv && hv.severity === 'critical' && /9,4 h/.test(hv.detail) && /por encima de la tolerancia/.test(hv.detail), JSON.stringify(hv));
    // Dentro de la tolerancia sigue cumpliendo (la meta del documento).
    const inTol = RA.requirementVerificationChecks(applicable, DR.compareRequirements(applicable, designOf(dist, { estimatedHours: dist.estimatedHours, hoursStatus: dist.status })),
      { status: dist.status, baseHours: 1, estimatedHours: dist.estimatedHours, modules: 2, moduleExams: 2, exceptionFields: {} }).find((c) => /8 horas/.test(c.title));
    eq(inTol.severity, 'ok', 'dentro de la tolerancia');
    // Review QA I2: las horas elegidas por el docente siguen siendo SU meta (no se reemplazan por las estimadas).
    const t = DR.compareRequirements(applicable, designOf(over, { estimatedHours: 9.4, hoursStatus: 'above_tolerance', hoursSource: 'user' })).find((c) => applicable.find((r) => r.id === c.requirementId).kind === 'target_hours');
    eq([t.status, t.actual.value, t.chosenBy], ['met', 8, 'teacher'], 'meta del docente');
    // Review QA M1: el exceso por una decisión del docente es SU excepción (no un conflicto que bloquea).
    const tv = RA.requirementVerificationChecks(applicable, DR.compareRequirements(applicable, designOf(over, { estimatedHours: 9.4, hoursStatus: 'above_tolerance' })),
      { status: 'above_tolerance', baseHours: 1, estimatedHours: 9.4, modules: 2, moduleExams: 2, structureByTeacher: true, exceptionFields: {} }).find((c) => /8 horas/.test(c.title));
    eq(tv.severity, 'warning', 'excepción del docente');
    // Review QA I1: una Actividad que agrega el mínimo del documento después del balance también queda pareja (3 × 2, 10 h).
    const mods3 = [0, 1, 2].map((i) => ({ id: uuid(300 + i), position: i, title: 'Módulo ' + i, objective: null, description: null, exam_enabled: true }));
    const chs3 = [];
    mods3.forEach((m, mi) => [0, 1].forEach((ci) => chs3.push({ id: uuid(3000 + mi * 20 + ci), module_id: m.id, position: ci, title: `Capítulo ${mi}.${ci}`, objective: 'Aplicar', description: null, video_enabled: true, activity_enabled: true })));
    const d3 = ST.distributeCourseHours({ snapshot: SNAP.buildBlueprintSnapshotV2(course, mods3, chs3), rules: null, targetHours: 10, preferences: { audiovisual: 'recommended' }, pins: null,
      requirements: { contentChaptersPerModule: { min: 2, max: 2 }, practicePerModule: { min: 1, max: 1 }, applicationPerModule: { min: 1, max: 1 }, applicationInPractice: true, sources: {} } });
    const apps3 = d3.modules.map((m) => m.chapters.filter((c) => c.kind === 'practice').map((c) => c.applicationMinutes)[0]);
    assert(apps3.every((a) => a !== null && a === apps3[0]), `prácticas parejas tras los mínimos: ${JSON.stringify(apps3)} (${d3.status} ${d3.estimatedHours} h)`);
  });

  await check('MC16 (Fase 1) pegado como texto = DOCX: mismo nombre, RA, unidades, horas y los mismos requisitos', async () => {
    const TXT = fs.readFileSync(path.join(REPO, 'scripts/fixtures/microcurriculum/atencion-violencia-sexual-2x2.txt'));
    const ct = (await E.extractAcademicContext([{ name: 'informacion-pegada.txt', data: TXT }])).context;
    eq([ct.identity.subjectName.value, ct.outcomes.length, ct.competencies.length, ct.units.length, ct.hours.total.value],
      [ctx.identity.subjectName.value, ctx.outcomes.length, ctx.competencies.length, ctx.units.length, ctx.hours.total.value], 'contexto');
    const rt = X.requirementsFor(X.extractRequirements(T.readText(TXT, 'text/plain').lines), {}).filter((r) => r.obligation === 'required' && r.confidence === 'high');
    eq(rt.map((r) => r.key).sort(), required.map((r) => r.key).sort(), 'mismos requisitos');
    // Guarda: «Nombre» fuera de la ficha (p. ej. del docente) no es el nombre del curso.
    const c4 = (await E.extractAcademicContext([{ name: 'c.txt', data: Buffer.from(['Docente', 'Nombre', 'Juan Pérez', 'Asignatura: Contabilidad'].join('\n'), 'utf8') }])).context;
    eq(c4.identity.subjectName.value, 'Contabilidad', 'el nombre del docente no es el del curso');
    // Review: un «Nombre» suelto de otra tabla (evaluación, bibliografía, grupo, contacto) no es la asignatura, y una clave
    // explícita («Asignatura», «Nombre del curso») siempre gana sobre un «Nombre» suelto.
    const subj = async (a) => (await E.extractAcademicContext([{ name: 'p.txt', data: Buffer.from(a.join('\n'), 'utf8') }])).context.identity.subjectName.value;
    for (const a of [['Evaluación', 'Nombre', 'Porcentaje'], ['Bibliografía', 'Nombre', 'Autor'], ['Integrantes del grupo', 'Nombre', 'María López'], ['Datos de contacto', 'Nombre', 'Ana Ruiz']]) eq(await subj(a), null, a[0]);
    eq(await subj(['Datos de contacto', 'Nombre', 'Ana Ruiz', 'Asignatura: Contabilidad de costos']), 'Contabilidad de costos', 'la clave explícita gana');
    eq(await subj(['Ficha', 'Nombre: Ana Ruiz', 'Nombre del curso: Excel básico']), 'Excel básico', '«Nombre del curso» gana a «Nombre:»');
  });

  await check('MC15 (capacidades) nunca se recomienda lo que Cursia no produce; lo pedido por encima es «Requisito no cubierto por Cursia»', () => {
    const base = ['El curso tendrá exactamente 2 módulos.', 'Cada módulo tendrá exactamente 2 capítulos de contenido.'];
    const mods2 = [0, 1].map((i) => ({ id: uuid(700 + i), position: i, title: 'M' + i, objective: null, description: null, exam_enabled: true }));
    const chs2 = [];
    mods2.forEach((m, mi) => [0, 1].forEach((ci) => chs2.push({ id: uuid(7000 + mi * 20 + ci), module_id: m.id, position: ci, title: `C${mi}${ci}`, objective: 'Aplicar', description: null, video_enabled: true, activity_enabled: true })));
    const run = (extra, hours = 'El curso tendrá 8 horas de trabajo del estudiante.') => {
      const app = reqsOfText([...base, hours, ...extra].join('\n'));
      const req = app.filter((r) => r.obligation === 'required' && r.confidence === 'high');
      const d = ST.distributeCourseHours({ snapshot: SNAP.buildBlueprintSnapshotV2(course, mods2, chs2), rules: null, targetHours: 8, preferences: { audiovisual: 'recommended' }, pins: null, requirements: RA.constraintsFor(req, {}) });
      const v = RA.requirementVerificationChecks(app, DR.compareRequirements(app, designOf(d, { estimatedHours: d.estimatedHours, hoursStatus: d.status })), { status: d.status, baseHours: 1, estimatedHours: d.estimatedHours, modules: 2, moduleExams: 2, exceptionFields: {} });
      return { d, v, cap: v.filter((c) => c.capability).map((c) => [c.title, c.capability.produces]) };
    };
    const expectCap = (extra, title, produces, hours) => { const r = run(extra, hours); eq(r.cap, [[title, produces]], title); return r; };
    expectCap(['Cada capítulo de contenido tendrá 2 actividades interactivas H5P.'], 'Requisito no cubierto por Cursia: 2 actividades interactivas por capítulo', 'Cursia contempla 1 actividad interactiva por capítulo (4 actividades interactivas previstas en total)');
    const aa2 = run(['Cada capítulo tendrá 2 Actividades de Aplicación.']).cap;
    assert(aa2.length === 1 && aa2[0][0] === 'Requisito no cubierto por Cursia: 2 Actividades de Aplicación por capítulo'
      && /^Cursia contempla como máximo 1 Actividad de Aplicación por capítulo \(\d+ Actividades? de Aplicación previstas? en total\)$/.test(aa2[0][1]), JSON.stringify(aa2));
    expectCap(['El curso tendrá 3 evaluaciones parciales.'], 'Requisito no cubierto por Cursia: 3 evaluaciones parciales', 'Cursia contempla 1 evaluación por módulo (2 evaluaciones parciales previstas en total)');
    expectCap(['El curso tendrá 2 evaluaciones finales.'], 'Requisito no cubierto por Cursia: 2 evaluaciones finales', 'Cursia contempla como máximo 1 evaluación final');
    expectCap(['Cada módulo tendrá 2 evaluaciones.'], 'Requisito no cubierto por Cursia: 2 evaluaciones por módulo', 'Cursia contempla 1 evaluación por módulo (2 evaluaciones parciales previstas en total)');
    expectCap([], 'Requisito no cubierto por Cursia: 600 horas', 'Cursia diseña cursos de 1 a 500 horas de trabajo del estudiante', 'El curso tendrá 600 horas de trabajo del estudiante.');
    // Más videos de los que caben: Cursia pone el máximo que produce (video en TODOS los capítulos de contenido), nunca menos.
    const v5 = expectCap(['El curso tendrá 5 videos.'], 'Requisito no cubierto por Cursia: 5 videos', 'Cursia contempla 1 video por capítulo de contenido (4 videos previstos en total)');
    eq(v5.d.counts.videoChapters, 4, 'el máximo que Cursia produce');
    // Review I3: más videos por módulo que capítulos de contenido fija el documento; horas en rango por encima de 500.
    expectCap(['Cada módulo tendrá 3 videos.'], 'Requisito no cubierto por Cursia: 3 videos por módulo', 'Cursia contempla 1 video por capítulo de contenido (4 videos previstos en total)');
    expectCap([], 'Requisito no cubierto por Cursia: 600–700 horas', 'Cursia diseña cursos de 1 a 500 horas de trabajo del estudiante', 'El curso tendrá entre 600 y 700 horas de trabajo del estudiante.');
    // Lo que Cursia sí produce no es «no cubierto»: 3 capítulos de práctica por módulo o 1 parcial por módulo se diseñan.
    eq(run(['Cada módulo tendrá 3 capítulos de práctica.']).cap, [], 'práctica: dentro de la capacidad');
    eq(run(['El curso tendrá 2 evaluaciones parciales y 1 evaluación final.']).cap, [], 'evaluaciones: dentro de la capacidad');
    // «no tendrá evaluación final» → sin evaluación final (no «ninguna evaluación»).
    const nf = reqsOfText('El curso no tendrá evaluación final.');
    eq(nf.map((r) => [r.key, r.mode, r.value]), [['evaluations@course#final', 'max', 0]], 'sin evaluación final');
    eq(RA.requirementText(nf[0]), 'sin evaluación final', 'texto');
  });

  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})();
