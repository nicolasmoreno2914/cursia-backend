#!/usr/bin/env node
/* eslint-disable no-console */
// Fase 4 · Coherence Engine — alineación resultado → evidencia (capa A). USD 0: puro, sin proveedores, red bloqueada.
//
//   AL1  mapa: cada resultado lista evidencias TIPADAS (instrucción / práctica / aplicación / evaluación) con su item del
//        Manifest y sus minutos; la práctica sin vínculos integra los resultados de su módulo
//   AL2  caso correcto: todo cubierto → 0 críticos, 0 advertencias; estados «covered»
//   AL3  caso incompleto: resultado sin capítulos → A1 crítico (competencia: A1c advertencia); capítulo sin resultado → A4;
//        sin práctica → A3 (también si solo hay preguntas del video)
//   AL4  caso desalineado: resultado de saber hacer con evaluación solo conceptual → A5 (y desaparece con una Actividad de
//        Aplicación); tiempo de práctica insuficiente para un resultado complejo → A6
//   AL5  caso pedagógico: el MISMO curso con competencias vs significativo cambia severidades y umbrales (dimensiones del
//        motor pedagógico, sin reglas por nombre de enfoque); problemas → sugerencias P1
//   AL6  dry-run: `alignment` del diseño que se ve y del diseño PROPUESTO (materializado); sin contexto, sin la clave
//   AL7  determinismo (mismo sha) y 0 llamadas de red
//
// Uso: node scripts/check-coherence-alignment.js [path/to/dist]
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
const load = (rel) => require(path.join(distRoot, rel));
const A = load('modules/academic-context/index.js');
const AL = load('modules/coherence/alignment.js');
const SNAP = load('modules/course-blueprints/blueprint-snapshot.js');
const P = load('modules/pedagogy/index.js');
const F = require('./lib/academic-fixtures.js');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`✅ ${name}`); } catch (e) { failures++; console.log(`❌ ${name}\n   ${e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const A1 = JSON.stringify(a); const B1 = JSON.stringify(b); if (A1 !== B1) throw new Error(`${m}: esperado ${B1}, encontrado ${A1}`); };
const rules = (r) => r.findings.map((f) => `${f.severity}:${f.rule}:${f.outcomeIds.join('+') || f.chapterIds.length || f.moduleIds.length}`);

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
/** Curso desde el microcurrículo: opciones para variar vínculos, actividades, aplicación y exámenes. */
function course(ctx, o = {}) {
  const prop = A.proposeStructureFromContext(ctx);
  const modules = [];
  const chapters = [];
  prop.modules.forEach((m, mi) => {
    const id = uuid();
    modules.push({ id, position: mi, title: m.title, objective: m.objective, description: m.description, exam_enabled: o.exams !== false });
    m.chapters.forEach((c, ci) => {
      let ids = c.outcomeIds.slice();
      if (o.links) ids = o.links(mi, ci, ids);
      chapters.push({
        id: uuid(), module_id: id, position: ci, title: c.title, objective: c.objective, description: c.description, video_enabled: o.video ? o.video(mi, ci) : true,
        activity_enabled: o.activity ? o.activity(mi, ci) : true,
        ...(o.app && o.app(mi, ci) ? { application_minutes: o.app(mi, ci) } : {}),
        ...(ids.length ? { outcome_ids: ids } : {}),
      });
    });
  });
  return SNAP.buildBlueprintSnapshotV2({ id: 7001, title: 'Contabilidad de Costos', finalExam: true, activityEngine: 'h5p', academicContext: A.academicBlueprintContext(ctx) }, modules, chapters);
}
const profile = (ctx, approach) => {
  const p = { ...A.suggestProfileFromContext(ctx, null).profile, primaryApproach: approach, secondaryApproaches: [] };
  delete p.targetHours;
  return approach ? p : null;
};
const align = (snap, ctx, approach, extras) => P.runPedagogyDryRun({ structure: snap, profile: profile(ctx, approach), activityTypeRules: 2, ...(extras ? { alignment: extras } : {}) }).alignment;

(async () => {
  const ctx = (await A.extractAcademicContext([{ name: 'm.docx', data: await F.fixture('consistent', 'docx') }])).context;
  // Las competencias del documento no vinculan unidades: el curso «correcto» las vincula (CO1 → módulos 2–4, CO2 → 5).
  // El módulo 5 trabaja RA5, RA6 y CO2 en sus tres capítulos (RA6 «crear» necesita práctica suficiente).
  const linksAll = (mi, ci, ids) => (mi >= 1 && mi <= 3 ? [...ids, 'CO1'] : mi === 4 ? ['RA5', 'RA6', 'CO2'] : ids);
  const appAll = (mi, ci) => (ci === 0 ? 120 : 60);

  await check('AL1 mapa: evidencias tipadas por resultado, con item del Manifest y minutos; práctica hereda del módulo', () => {
    const snap = course(ctx, { links: linksAll, app: appAll });
    const r = align(snap, ctx, 'competencias');
    const ra2 = r.outcomes.find((o) => o.id === 'RA2');
    eq([...new Set(ra2.evidence.map((e) => e.kind))].sort(), ['application', 'assessment', 'check', 'instruction', 'practice'], 'tipos de evidencia (las preguntas del video son «check»)');
    assert(ra2.evidence.every((e) => /^(content|experience|activity|video_interactions|application_activity|exam|final_exam):/.test(e.itemKey)), 'cada evidencia apunta a un item del Manifest');
    const exam = ra2.evidence.find((e) => e.type === 'exam');
    eq([exam.style, exam.moduleId], ['situational_cases', snap.modules[1].id], 'evaluación del módulo con el estilo del diseño');
    assert(ra2.minutes.application > 0 && ra2.minutes.practice > 0, 'minutos de práctica y aplicación');
    eq(ra2.chapterIds.length, 4, 'capítulos que lo trabajan');
    // Minutos disponibles por resultado: la Actividad de Aplicación del capítulo cuenta para cada resultado que integra.
    const m5 = snap.modules[4].chapters[0];
    const appEv = r.outcomes.filter((o) => o.evidence.some((e) => e.itemKey === `application_activity:${m5.id}`)).map((o) => o.evidence.find((e) => e.itemKey === `application_activity:${m5.id}`).minutes);
    eq(appEv, [120, 120, 120], 'una tarea integradora practica cada uno de sus resultados durante todo su tiempo');
    // Práctica sin vínculos (la agrega el distribuidor): integra los resultados de su módulo.
    const withPractice = P.runPedagogyDryRun({ structure: snap, profile: { ...profile(ctx, 'competencias'), targetHours: 64 }, activityTypeRules: 2 });
    const pr = withPractice.distribution.materialized.alignment;
    const practiceRows = pr.chapters.filter((c) => c.kind === 'practice');
    assert(practiceRows.length > 0 && practiceRows.every((c) => c.outcomeIds.length === 0 && c.effectiveOutcomeIds.length > 0), 'la práctica evidencia los resultados de su módulo');
  });

  await check('AL2 caso correcto: todo cubierto → 0 críticos y 0 advertencias', () => {
    const r = align(course(ctx, { links: linksAll, app: appAll }), ctx, 'competencias');
    eq([r.counts.critical, r.counts.warning], [0, 0], `hallazgos: ${rules(r).join(', ')}`);
    eq(r.coverage, { outcomes: 8, covered: 8, partial: 0, uncovered: 0 }, 'cobertura');
  });

  await check('AL3 caso incompleto: sin capítulos → A1 crítico; capítulo sin resultado → A4; sin práctica → A3', () => {
    // RA4 sin capítulos; un capítulo del módulo 1 sin vínculos; las actividades del módulo 3 apagadas y sin aplicación.
    const snap = course(ctx, {
      links: (mi, ci, ids) => (mi === 3 ? [] : mi === 0 && ci === 3 ? [] : linksAll(mi, ci, ids)),
      activity: (mi) => mi !== 2,
      video: (mi) => mi !== 2,
      app: (mi, ci) => (mi === 2 ? null : appAll(mi, ci)),
    });
    const r = align(snap, ctx, 'competencias');
    const got = rules(r);
    for (const want of ['critical:A1:RA4', 'critical:A3:RA3']) assert(got.includes(want), `${want} en ${got.join(', ')}`);
    assert(r.findings.some((f) => f.rule === 'A4' && f.severity === 'warning' && /no está claramente asociado a ningún resultado/.test(f.message)), 'A4');
    assert(r.findings.some((f) => f.rule === 'A3' && f.message === 'El resultado RA3 no tiene suficiente evidencia práctica.'), 'mensaje A3');
    eq(r.outcomes.find((o) => o.id === 'RA4').status, 'uncovered', 'RA4 sin cobertura');
    // Review F4 I1: actividades apagadas con videos ENCENDIDOS — las preguntas de comprensión del video no son práctica.
    const soloVideo = align(course(ctx, { links: linksAll, activity: () => false }), ctx, 'competencias');
    const a3 = soloVideo.findings.filter((f) => f.rule === 'A3').map((f) => f.outcomeIds[0]);
    for (const id of ['RA2', 'RA3', 'RA4']) assert(a3.includes(id), `A3 con solo video para ${id}: ${rules(soloVideo).join(', ')}`);
    assert(soloVideo.findings.some((f) => f.rule === 'A3' && /solo preguntas de comprensión en el video/.test(f.message)), 'el mensaje dice que solo hay preguntas del video');
    assert(!a3.includes('RA1'), 'RA1 (saber) se cubre con instrucción y comprensión');
    eq(soloVideo.outcomes.find((o) => o.id === 'RA2').status, 'partial', 'RA2 ya no figura «Cubierto»');
    // Review F4 I2: competencias sin capítulos (el flujo de Cursia no las vincula) → advertencia transversal, no crítico.
    const sinCo = align(course(ctx, { app: appAll }), ctx, 'competencias');
    const co = sinCo.findings.filter((f) => /^CO/.test(f.outcomeIds[0] || ''));
    eq(co.filter((f) => f.rule.startsWith('A1')).map((f) => `${f.severity}:${f.rule}:${f.outcomeIds[0]}`), ['warning:A1c:CO1', 'warning:A1c:CO2'], 'competencias sin vínculos');
    assert(!sinCo.findings.some((f) => f.rule === 'A1' && /^CO/.test(f.outcomeIds[0])), 'nunca A1 crítico para una competencia');
  });

  await check('AL4 caso desalineado: saber hacer con evaluación solo conceptual → A5; tiempo insuficiente → A6', () => {
    // Significativo: examen «conceptual_relations». Sin Actividades de Aplicación, los resultados de aplicar quedan desalineados.
    const sinApp = align(course(ctx, { links: linksAll }), ctx, 'significativo');
    const a5 = sinApp.findings.filter((f) => f.rule === 'A5').map((f) => f.outcomeIds[0]);
    eq(a5, ['RA2', 'RA3', 'RA4', 'RA5', 'RA6', 'CO1', 'CO2'], 'A5 en los resultados de desempeño');
    eq(sinApp.findings.find((f) => f.rule === 'A5').message, 'El resultado RA2 requiere aplicación, pero su evaluación es solo conceptual.', 'mensaje A5');
    assert(!a5.includes('RA1'), 'RA1 (identificar: saber) no pide aplicación');
    const conApp = align(course(ctx, { links: linksAll, app: appAll }), ctx, 'significativo');
    eq(conApp.findings.filter((f) => f.rule === 'A5').length, 0, 'una Actividad de Aplicación corrige el desalineamiento');
    // Tiempo: RA6 (crear) con una sola actividad de 30 min en competencias (exige 105).
    const poco = align(course(ctx, { links: linksAll, app: (mi, ci) => (mi === 4 && ci === 0 ? 30 : null) }), ctx, 'competencias');
    const a6 = poco.findings.find((f) => f.rule === 'A6' && f.outcomeIds[0] === 'RA6');
    assert(a6 && /RA6 tiene alta complejidad pero solo dispone de \d+ minutos de práctica/.test(a6.message) && a6.evidence.requiredMinutes === 105, `A6: ${rules(poco).join(', ')}`);
  });

  await check('AL5 caso pedagógico: cambiar el enfoque cambia severidades, umbrales y sugerencias', () => {
    const snap = course(ctx, { links: linksAll, activity: (mi) => mi !== 2, video: (mi) => mi !== 2 });
    const comp = align(snap, ctx, 'competencias');
    const sig = align(snap, ctx, 'significativo');
    const abp = align(snap, ctx, 'problemas');
    const sev = (r) => r.findings.find((f) => f.rule === 'A3' && f.outcomeIds[0] === 'RA3').severity;
    eq([sev(comp), sev(sig)], ['critical', 'warning'], 'sin práctica: crítico con competencias (evidencia 0,95), advertencia con significativo');
    eq([comp.thresholds.practiceMinutesForComplex, sig.thresholds.practiceMinutesForComplex, abp.thresholds.practiceMinutesForComplex], [105, 70, 95], 'minutos exigidos según la dimensión «práctica»');
    eq([comp.thresholds.priorKnowledgeChecks, sig.thresholds.priorKnowledgeChecks, abp.thresholds.problemChecks, comp.thresholds.problemChecks], [false, true, true, false], 'qué sugerencias enciende cada enfoque');
    assert(abp.findings.some((f) => f.rule === 'P1') && !comp.findings.some((f) => f.rule === 'P1'), 'ABP: módulos sin problema para decidir → P1');
    const sigPk = align(snap, ctx, 'significativo', { priorKnowledgeDeclared: false });
    assert(sigPk.findings.some((f) => f.rule === 'P2') && !align(snap, ctx, 'competencias', { priorKnowledgeDeclared: false }).findings.some((f) => f.rule === 'P2'), 'significativo + sin conocimientos previos → P2');
    eq(comp.approach.approaches.map((a) => a.id), ['competencias'], 'dimensiones del enfoque congelado en el Blueprint');
  });

  await check('AL6 dry-run: alineación del diseño actual y del propuesto; sin contexto, sin la clave', () => {
    const snap = course(ctx, { links: linksAll });
    const dr = P.runPedagogyDryRun({ structure: snap, profile: { ...profile(ctx, 'competencias'), targetHours: 64 }, activityTypeRules: 2 });
    assert(dr.alignment && dr.distribution.materialized.alignment, 'las dos vistas');
    assert(dr.distribution.materialized.alignment.counts.warning <= dr.alignment.counts.warning, 'el diseño propuesto (con práctica y aplicación) no empeora la alineación');
    const plain = SNAP.buildBlueprintSnapshotV2({ id: 7001, title: 'C', finalExam: true, activityEngine: 'h5p' }, snap.modules.map((m) => ({ id: m.id, position: m.position, title: m.title, objective: m.objective, exam_enabled: m.examEnabled })), snap.modules.flatMap((m) => m.chapters.map((c) => ({ id: c.id, module_id: m.id, position: c.position, title: c.title, objective: c.objective, video_enabled: c.videoEnabled, activity_enabled: c.activityEnabled }))));
    const d2 = P.runPedagogyDryRun({ structure: plain, profile: { ...profile(ctx, 'competencias'), targetHours: 64 }, activityTypeRules: 2 });
    eq(['alignment' in d2, 'alignment' in d2.distribution.materialized], [false, false], 'sin contexto: dry-run de siempre');
    const un = AL.buildAlignmentReport({ snapshot: plain, manifest: d2.baseline.manifest, studyTime: d2.baseline.studyTime });
    eq([un.available, un.reason], [false, 'NO_ACADEMIC_CONTEXT'], 'reporte no disponible');
  });

  await check('AL7 determinismo y red', () => {
    const snap = course(ctx, { links: linksAll });
    const a = align(snap, ctx, 'competencias');
    const b = align(JSON.parse(JSON.stringify(snap)), ctx, 'competencias');
    eq(a.reportSha256, b.reportSha256, 'mismo sha');
    eq(netAttempts, [], 'red');
  });

  console.log(`\n${passes} OK, ${failures} fallidas`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
