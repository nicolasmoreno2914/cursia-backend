#!/usr/bin/env node
/* eslint-disable no-console */
// T6 (r57) — «Guía del docente» por curso (opt-in `teacherGuide` del perfil de evaluación), determinística y sin IA.
// USD 0: sin red, sin LLM, sin base. Fixtures genéricos («Curso de ejemplo»).
//
//   G1  perfil: teacherGuide { include: boolean } con códigos estables; sin la clave, el perfil (y su sha) es el de
//       siempre; normalización estable
//   G2  apagada = byte a byte: sin la clave y con { include: false } el .mbz es idéntico (y el dorado de T4/T5 sigue
//       valiendo: check-application-deliverables D3)
//   G3  encendida: UNA página oculta solo para docentes en la sección 0 (antes del foro), estudiante PROHIBIDO, sin nota
//       ni completion; nombra módulos y capítulos con objetivos, recursos, Actividades de Aplicación con criterios y
//       pesos, el solucionario por su nombre (sin enlace ni archivo), archivos de trabajo, evaluación (categorías, pesos,
//       nota mínima, intentos) y la regla de aprobación; validador en verde; determinística (dos builds = mismos bytes)
//   G4  con plan de aprendizaje: tipo de aprendizaje por capítulo y la metodología con sus fases
//   G5  validador: visible, sin override, faltante o de más, enlazada desde otra actividad, capítulo omitido → TEACHER_GUIDE
//
// Uso: node scripts/check-t6-teacher-guide.js [dist]   (después de npm run build)
'use strict';
require('reflect-metadata');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };

const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || 'dist');
const L = (rel) => require(path.join(distRoot, rel));
const B = L('package/dynamic-mbz-builder-v3.js');
const V = L('package/v3/mbz-validator-v3.js');
const P = L('modules/course-profiles/course-profiles.js');
const TG = L('modules/course-shell/teacher-guide-page.js');
const THEME = L('modules/theme-engine/index.js');
const DF = require('./lib/deliverable-fixtures');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${name}\n   ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : e}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: esperado ${y}, encontrado ${x}`); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const codes = (errs) => [...new Set(errs.map((e) => e.code))].sort();
const tag = (x, t) => ((x || '').match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1];
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const text = (html) => unxml(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

async function actsOf(z) {
  const mb = await z.file('moodle_backup.xml').async('string');
  const out = [];
  for (const m of mb.matchAll(/<activity>\s*<moduleid>(\d+)<\/moduleid>\s*<sectionid>(\d+)<\/sectionid>\s*<modulename>([a-z0-9_]+)<\/modulename>\s*<title>([^<]*)<\/title>\s*<directory>([^<]+)<\/directory>/g)) {
    const mod = await z.file(`${m[5]}/module.xml`).async('string');
    out.push({ mid: Number(m[1]), sec: Number(m[2]), mod: m[3], dir: m[5], idnumber: (mod.match(/<idnumber>([^<]*)<\/idnumber>/) || [])[1], moduleXml: mod });
  }
  return out;
}
async function mutate(mbz, fn) {
  const z = await JSZip.loadAsync(mbz);
  await fn(z);
  return z.generateAsync({ type: 'nodebuffer' });
}
async function edit(z, p, fn) {
  const t = await z.file(p).async('string');
  const n = fn(t);
  if (n === t) throw new Error(`la mutación no cambió ${p}`);
  z.file(p, n);
}

(async () => {
  const base = P.defaultAssessmentProfile({ finalExam: true });
  await check('G1 perfil: teacherGuide { include: boolean } con códigos estables; sin la clave, el sha de siempre', () => {
    eq(P.validateAssessmentProfile({ ...base, teacherGuide: { include: true } }, { finalExam: true }), [], 'include true');
    eq(P.validateAssessmentProfile({ ...base, teacherGuide: { include: false } }, { finalExam: true }), [], 'include false');
    eq(codes(P.validateAssessmentProfile({ ...base, teacherGuide: true }, { finalExam: true })), ['INVALID_TEACHER_GUIDE'], 'no objeto');
    eq(codes(P.validateAssessmentProfile({ ...base, teacherGuide: { include: 'sí' } }, { finalExam: true })), ['INVALID_TEACHER_GUIDE'], 'include no booleano');
    eq(codes(P.validateAssessmentProfile({ ...base, teacherGuide: { include: true, pdf: true } }, { finalExam: true })), ['UNKNOWN_FIELD'], 'campo extra');
    eq(codes(P.validateAssessmentProfile({ ...base, teacherGuide: {} }, { finalExam: true })), ['MISSING_FIELD'], 'sin include');
    eq(P.profileSha256(P.normalizeAssessmentProfile(base)), P.profileSha256(base), 'sin la clave: sha de siempre');
    const on = P.normalizeAssessmentProfile({ ...base, teacherGuide: { include: true } });
    eq(on.teacherGuide, { include: true }, 'normalizada');
    assert(P.profileSha256(on) !== P.profileSha256(base), 'encendida cambia el sha (clave de reuse → re-empaque sin costo)');
    eq(P.teacherGuideEnabled(on), true, 'enabled');
    eq(P.teacherGuideEnabled(base), false, 'apagada');
  });

  // Curso de Fase 2 (4 AA, una de práctica) + Tareas calificadas con rúbrica + archivos de trabajo.
  const course = DF.courseInput(distRoot, { courseId: 770 });
  const appChapterIds = course.manifest.items.filter((i) => i.type === 'application_activity').map((i) => i.key.slice('application_activity:'.length));
  const delivery = DF.deliveryProfile(base, { graded: true, category: 'applications', rubric: true });
  const offIn = DF.withProfile(course, delivery);
  const withFiles = await DF.withPracticeFiles(distRoot, course, delivery, appChapterIds);
  const onProfile = { ...withFiles.input.assessmentProfile, teacherGuide: { include: true } };
  const onIn = DF.withProfile(withFiles.input, onProfile, withFiles.input.contents.practiceFiles);
  const off = await B.buildDynamicMbzV3(offIn);
  const on = await B.buildDynamicMbzV3(onIn);

  await check('G2 apagada = byte a byte (sin la clave = { include: false })', async () => {
    const offFalse = await B.buildDynamicMbzV3(DF.withProfile(course, { ...delivery, teacherGuide: { include: false } }));
    eq(sha(offFalse.mbz), sha(off.mbz), '.mbz idéntico');
    assert(!off.expectations.facts.teacherGuide && !offFalse.expectations.facts.teacherGuide, 'facts sin teacherGuide');
    const z = await JSZip.loadAsync(off.mbz);
    assert(!(await actsOf(z)).some((a) => a.idnumber === 'cv3:shell:teacher_guide'), 'sin la página');
  });

  let guide;
  let guideTxt;
  await check('G3 encendida: página oculta solo docentes en la sección 0, contenido completo, validador en verde, determinística', async () => {
    const v = await V.validateMbzV3(on.mbz, on.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 6)));
    eq(on.expectations.facts.teacherGuide, true, 'facts');
    const z = await JSZip.loadAsync(on.mbz);
    const acts = await actsOf(z);
    const sec0 = acts.filter((a) => a.sec === 0).map((a) => a.idnumber);
    guide = acts.find((a) => a.idnumber === 'cv3:shell:teacher_guide');
    assert(guide && guide.mod === 'page', 'una página');
    eq(sec0.slice(-2), ['cv3:shell:teacher_guide', 'cv3:shell:forum'], 'antes del foro, en la sección 0');
    eq([tag(guide.moduleXml, 'visible'), tag(guide.moduleXml, 'visibleold'), tag(guide.moduleXml, 'completion')], ['0', '0', '0'], 'oculta, sin completion');
    const roles = await z.file(`${guide.dir}/roles.xml`).async('string');
    assert(/<capability>mod\/page:view<\/capability>[\s\S]*<permission>-1000<\/permission>/.test(roles), 'estudiante prohibido');
    assert(!(await z.file(`${guide.dir}/grades.xml`).async('string')).includes('<grade_item '), 'sin ítem de nota');
    const page = await z.file(`${guide.dir}/page.xml`).async('string');
    eq(unxml(tag(page, 'name')), TG.TEACHER_GUIDE_PAGE_NAME, 'nombre');
    guideTxt = text(tag(page, 'content'));
    const f = on.expectations.facts;
    for (const m of f.modules) assert(guideTxt.includes(`Módulo ${m.number}: ${m.title}`), `módulo ${m.number}`);
    for (const ch of f.chapters) assert(guideTxt.includes(`Capítulo ${ch.number}: ${ch.title}`), `capítulo ${ch.number}`);
    for (const id of appChapterIds) {
      const doc = onIn.contents.applications.get(id);
      const ch = f.chapters.find((c) => c.id === id);
      assert(guideTxt.includes(doc.activity.title), `AA ${ch.number}: título`);
      for (const cr of doc.activity.criteria) assert(guideTxt.includes(`${cr.name} (${cr.weight} %)`), `AA ${ch.number}: criterio ${cr.name}`);
      assert(guideTxt.includes(`«Solucionario docente · Actividad de Aplicación del capítulo ${ch.number}»`), `solucionario ${ch.number} nombrado`);
      assert(guideTxt.includes('Tarea de Moodle calificada'), 'entrega');
    }
    for (const fn of ['datos-taller.xlsx', 'plantilla-informe.docx', 'guia-lectura.pdf', 'ventas.csv', 'inventario.xlsx']) assert(guideTxt.includes(fn), `archivo de trabajo ${fn}`);
    for (const c of on.expectations.resolved.categories) assert(guideTxt.includes(`${c.weight} % de la nota final`), `peso ${c.key}`);
    assert(guideTxt.includes(`calificación final del curso ≥ ${on.expectations.resolved.courseGradepass}/100`), 'aprobación');
    assert(/El curso se aprueba solo por la calificación final/.test(guideTxt), 'regla de aprobación para docentes');
    assert(/intentos ilimitados|\d intentos/.test(guideTxt), 'intentos');
    assert(/Tiempo de estudio estimado|Carga horaria/.test(guideTxt), 'horas');
    assert(!/@@PLUGINFILE@@|VIEWBYID/.test(unxml(tag(page, 'content'))), 'sin enlaces (ni al solucionario ni a archivos)');
    assert(!/solucionario-docente\.pdf/.test(guideTxt), 'sin el PDF del solucionario');
    const again = await B.buildDynamicMbzV3(DF.withProfile(withFiles.input, onProfile, withFiles.input.contents.practiceFiles));
    eq(sha(again.mbz), sha(on.mbz), 'determinística');
  });

  await check('G4 con plan de aprendizaje: tipo de aprendizaje por capítulo y metodología con sus fases', () => {
    const bp = JSON.parse(JSON.stringify(onIn.blueprint));
    bp.course.pedagogy = { ...(bp.course.pedagogy || {}), learningPlan: { version: 1, framework: 'gagne_9_eventos', phaseLabels: true } };
    const first = bp.modules[0].chapters[0];
    first.design = { ...(first.design || {}), learningType: { type: 'procedimental', source: 'override', rulesVersion: 1, ruleId: 'override', level: null, evidence: [], suggested: 'conceptual' }, framework: 'teoria_demostracion_practica' };
    const theme = THEME.resolveTheme({ themeFamily: 'aula-clara', mode: 'light' });
    const pg = TG.teacherGuidePage({ facts: on.expectations.facts, resolved: on.expectations.resolved, blueprint: bp, applications: onIn.contents.applications }, theme);
    const t = text(pg.html);
    assert(/Metodología: /.test(t) && /Los estudiantes ven el nombre de cada fase/.test(t), 'metodología del curso');
    assert(t.includes('Tipo de aprendizaje: Procedimental (elegido por el equipo)'), 'tipo de aprendizaje con override');
    assert(/Metodología: Teor/.test(t), 'metodología propia del capítulo');
    let err = null;
    try { TG.teacherGuidePage({ facts: on.expectations.facts, resolved: on.expectations.resolved, blueprint: bp, applications: new Map() }, theme); } catch (e) { err = e.message; }
    assert(err && /sin documento/.test(err), `AA sin documento → falla fuerte: ${err}`);
  });

  await check('G5 validador: visible, sin override, faltante / de más, enlazada, capítulo omitido → TEACHER_GUIDE', async () => {
    const expectIssue = async (mbz, exp, re, label) => {
      const v = await V.validateMbzV3(mbz, exp);
      assert(!v.ok && v.issues.some((i) => i.code === 'TEACHER_GUIDE' && (!re || re.test(i.message))), `${label}: ${JSON.stringify(v.issues.slice(0, 4))}`);
    };
    await expectIssue(await mutate(on.mbz, (z) => edit(z, `${guide.dir}/module.xml`, (x) => x.replace('<visible>0</visible>', '<visible>1</visible>'))), on.expectations, /oculta/, 'visible');
    await expectIssue(await mutate(on.mbz, (z) => edit(z, `${guide.dir}/roles.xml`, (x) => x.replace('<permission>-1000</permission>', '<permission>1</permission>'))), on.expectations, /prohíbe/, 'override');
    await expectIssue(on.mbz, { ...on.expectations, facts: { ...on.expectations.facts, teacherGuide: undefined } }, /no la pide/, 'de más');
    await expectIssue(off.mbz, { ...off.expectations, facts: { ...off.expectations.facts, teacherGuide: true } }, /la pide/, 'faltante');
    const z = await JSZip.loadAsync(on.mbz);
    const label = (await actsOf(z)).find((a) => a.idnumber === 'cv3:shell:route');
    await expectIssue(await mutate(on.mbz, (zz) => edit(zz, `${label.dir}/label.xml`, (x) => x.replace('<intro>', () => `<intro>&lt;a href=&quot;$@PAGEVIEWBYID*${guide.mid}@$&quot;&gt;x&lt;/a&gt;`))), on.expectations, /enlaza a la Guía/, 'enlazada');
    const ch = on.expectations.facts.chapters[0];
    await expectIssue(await mutate(on.mbz, (zz) => edit(zz, `${guide.dir}/page.xml`, (x) => x.split(`Capítulo ${ch.number}: `).join(`Cap. ${ch.number}: `))), on.expectations, new RegExp(`capítulo ${ch.number}`), 'capítulo omitido');
  });

  console.log(`\n${passes} ok, ${failures} fallos`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
