#!/usr/bin/env node
/* eslint-disable */
// Cursia EV6 P2-B4 — «Respuestas explicadas» (mod_page), nota para docentes y línea de la info del examen.
// Puro: sin DB, sin red (fetch prohibido).
//
// A1 (P2-task-B4.md):
//  - una página por quiz, en la MISMA sección justo después del quiz (exam_info → quiz → página →
//    module_next | final_exam_next), registrada en moodle_backup.xml (activity + settings);
//  - module.xml: availability BYTE-EXACTA con el moduleid de SU quiz — intentos > 0:
//    {"op":"|","show":false,"c":[{… "cm":QUIZ_MID,"e":1},{… "e":3}]}; intentos 0 (fix 1, C1): solo {… "e":1}
//    (sin completionattemptsexhausted un intento reprobado ya es COMPLETE_FAIL); completion 0, downloadcontent 0, visible 1; nunca en completion.xml;
//  - page.xml: nombre, contentformat 1, display 0, printintro/printlastmodified 0; contenido sin
//    <style>/<script>/<details>, CLEAN_SAFE y todo texto con nolink;
//  - banco: contiene el enunciado, la respuesta correcta y la explicación de CADA pregunta del banco
//    (MC: cada distractor y su why; V/F: whyWrong; emparejamiento «definición → término»), agrupada por
//    capítulo (módulo) / módulo (final) en el orden del plan;
//  - GIFT: cada respuesta correcta, sin «Por qué»;
//  - nota para docentes exactamente una vez, oculta, con las dos oraciones: (a) final + certificado →
//    en cv3:shell:certificate_teacher; (b) sin final con exámenes de módulo → cv3:shell:exams_teacher
//    primero de la primera sección de evaluación; (c) sin evaluaciones → ninguna;
//  - info del examen: la línea nueva con los intentos de facts (y la variante de intentos ilimitados);
//  - validateMbzV3 sin hallazgos en todos los casos.
//
// Usage: node scripts/check-p2-explanations.js [path/to/dist] [--out paquete-banco.mbz]  (también escribe <out>-nofinal.mbz y <out>-unlimited.mbz)
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : null;
const positional = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
const ROOT = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), positional[0] || path.join(ROOT, 'dist'));
function loadDist(rel) {
  try {
    return require(path.join(distRoot, rel));
  } catch (err) {
    console.error(`❌ No se pudo cargar ${rel} desde ${distRoot} (¿npm run build?): ${err.message}`);
    process.exit(1);
  }
}
require('reflect-metadata');
global.fetch = async (u) => { throw new Error(`NETWORK FORBIDDEN in check: ${u}`); };
const JSZip = require('jszip');

const EB = loadDist('modules/course-shell/exam-bank.js');
const S = loadDist('modules/course-shell/index.js');
const VC = loadDist('modules/visual-components/index.js');
const B = loadDist('package/dynamic-mbz-builder-v3.js');
const V = loadDist('package/v3/mbz-validator-v3.js');
const MC = loadDist('package/mbz-common.js');
const P = loadDist('modules/course-profiles/course-profiles.js');
const PF = require('./lib/v21-packaging-fixtures');
const EBF = require('./lib/exam-bank-fixtures');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`❌ ${name}\n   ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n   ') : err}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: esperado ${y.slice(0, 600)}, encontrado ${x.slice(0, 600)}`);
}
const dx = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, t) => {
  const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(xml);
  return m ? m[1] : null;
};
/** Texto visible normalizado (sin guiones suaves, espacios colapsados). */
const txt = (html) => VC.extractText(html).replace(/\u00AD/g, '').replace(/\s+/g, ' ').trim();
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// Textos con & < > " ' (escape de punta a punta).
function specialize(bank) {
  for (const q of bank.questions) {
    q.stem += ' ¿Vale «A & B» < 3 > 1 o "ya"?';
    q.explanation += " Ojo: a < b & c > d, con l'apóstrofo.";
    if (q.type === 'multichoice') for (const o of [q.correct, ...q.distractors]) { o.text += ' & <ok>'; o.why += ' (R&D "y")'; }
    else if (q.type === 'truefalse') q.whyWrong += ' (R&D "y")';
    else for (const p of q.pairs) { p.term += ' & "Q"'; p.definition += ' (R&D <i>)'; }
  }
  return bank;
}

/** Entrada con bancos válidos para TODOS los exámenes (mismo generador que check-p2-bank-xml). */
function bankInput(o = {}) {
  const input = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 744, ...o });
  const manifest = input.manifest;
  const all = manifest.modules.flatMap((m) => m.chapters.map((c) => ({ id: c.chapterId, moduleId: m.moduleId })));
  const gIndex = new Map(all.map((c, i) => [c.id, i]));
  const c = input.contents;
  for (const ch of all) c.contentMd.set(ch.id, `${c.contentMd.get(ch.id)}\n\n${EBF.chapterMarkdown(gIndex.get(ch.id), 'Reglas')}`);
  const banks = new Map();
  for (const m of manifest.modules) {
    if (!m.examEnabled) continue;
    const chs = all.filter((x) => x.moduleId === m.moduleId);
    const bank = specialize(EBF.makeExamBank({ scope: 'module', moduleId: m.moduleId, chapters: chs, chapterIndex: gIndex, prefix: `X${m.moduleNumber}L`, plan: EB.expectedExamPlan('module', chs) }));
    const r = EB.validateExamBank(bank, { scope: 'module', chapters: chs, chapterMd: c.contentMd });
    assert(r.ok, `fixture de banco inválido: ${JSON.stringify(r.errors.slice(0, 3))}`);
    banks.set(m.moduleId, bank);
  }
  let fin = null;
  if (manifest.features.finalExam) {
    fin = specialize(EBF.makeExamBank({ scope: 'final', moduleId: null, chapters: all, chapterIndex: gIndex, prefix: 'XF', plan: EB.expectedExamPlan('final', all) }));
    const r = EB.validateExamBank(fin, { scope: 'final', chapters: all, chapterMd: c.contentMd });
    assert(r.ok, `fixture de banco final inválido: ${JSON.stringify(r.errors.slice(0, 3))}`);
  }
  c.examGift = new Map();
  c.finalExamGift = null;
  c.examBanks = banks;
  c.finalExamBank = fin;
  return { input, banks, fin };
}

/** Lee del .mbz: actividades (orden de moodle_backup), secuencias, module.xml, page.xml, intro de labels. */
async function readPkg(mbz) {
  const z = await JSZip.loadAsync(mbz);
  const T = async (p) => (z.file(p) ? z.file(p).async('string') : null);
  const mb = await T('moodle_backup.xml');
  const acts = [];
  for (const m of tag(mb, 'activities').matchAll(/<activity>([\s\S]*?)<\/activity>/g)) {
    const b = m[1];
    const mid = Number(tag(b, 'moduleid'));
    const modname = tag(b, 'modulename');
    const dir = tag(b, 'directory');
    const module = await T(`${dir}/module.xml`);
    const act = await T(`${dir}/${modname}.xml`);
    acts.push({ mid, modname, dir, section: Number(tag(b, 'sectionid')), idnumber: dx(tag(module, 'idnumber')), module, act,
      intro: modname === 'label' ? dx(tag(act, 'intro')) : '', name: dx(tag(act, 'name')) });
  }
  const seq = {};
  for (const f of Object.keys(z.files).filter((n) => /^sections\/section_\d+\/section\.xml$/.test(n))) {
    const x = await T(f);
    seq[Number(tag(x, 'number'))] = (tag(x, 'sequence') || '').split(',').filter(Boolean).map(Number);
  }
  return { z, mb, acts, seq, completion: await T('completion.xml'), byId: (id) => acts.find((a) => a.idnumber === id) };
}

const AVAIL = (mid, attempts) => attempts === 0
  ? `{"op":"|","show":false,"c":[{"type":"completion","cm":${mid},"e":1}]}`
  : `{"op":"|","show":false,"c":[{"type":"completion","cm":${mid},"e":1},{"type":"completion","cm":${mid},"e":3}]}`;

/** Comprobaciones de estructura comunes a todo paquete con exámenes. */
function checkPages(R, manifest) {
  const quizzes = R.acts.filter((a) => a.modname === 'quiz');
  const pages = R.acts.filter((a) => a.modname === 'page');
  eq(pages.length, quizzes.length, 'una página por quiz');
  const critMids = [...(R.completion || '').matchAll(/<moduleinstance>(\d+)<\/moduleinstance>/g)].map((m) => Number(m[1]));
  for (const q of quizzes) {
    const final = q.idnumber === 'cv3:final_exam';
    const modId = final ? null : q.idnumber.replace('cv3:exam:', '');
    const pid = final ? 'cv3:final_exam_explanations' : `cv3:exam_explanations:${modId}`;
    const p = R.byId(pid);
    assert(p && p.modname === 'page', `${pid}: falta la página`);
    const s = R.seq[q.section];
    const i = s.indexOf(q.mid);
    eq(s[i + 1], p.mid, `${pid}: justo después de su quiz en section.xml`);
    eq(p.section, q.section, `${pid}: misma sección que el quiz`);
    const after = R.acts.find((a) => a.mid === s[i + 2]);
    eq(after && after.idnumber, final ? 'cv3:final_exam_next' : `cv3:module_next:${modId}`, `${pid}: seguida del siguiente paso`);
    const before = R.acts.find((a) => a.mid === s[i - 1]);
    eq(before && before.idnumber, final ? 'cv3:final_exam_info' : `cv3:exam_info:${modId}`, `${pid}: el quiz sigue a su info`);
    // module.xml
    const attempts = Number(tag(q.act, 'attempts_number'));
    assert(Number.isInteger(attempts), `${q.idnumber}: attempts_number`);
    eq(tag(p.module, 'availability'), AVAIL(q.mid, attempts), `${pid}: availability byte-exacta (intentos ${attempts})`);
    p.attempts = attempts;
    eq([tag(p.module, 'completion'), tag(p.module, 'downloadcontent'), tag(p.module, 'visible'), tag(p.module, 'modulename')], ['0', '0', '1', 'page'], `${pid}: completion/downloadcontent/visible`);
    assert(!critMids.includes(p.mid), `${pid}: es criterio de completion del curso`);
    // page.xml
    const mod = final ? null : manifest.modules.find((m) => m.moduleId === modId);
    eq(dx(tag(p.act, 'name')), final ? 'Respuestas explicadas — Evaluación final' : `Respuestas explicadas — Evaluación del módulo ${mod.moduleNumber}`, `${pid}: nombre`);
    eq([tag(p.act, 'contentformat'), tag(p.act, 'display'), tag(p.act, 'displayoptions'), tag(p.act, 'intro'), tag(p.act, 'revision')],
      ['1', '0', 'a:2:{s:10:"printintro";i:0;s:17:"printlastmodified";i:0;}', '', '1'], `${pid}: page.xml`);
    assert(new RegExp(`<activity id="\\d+" moduleid="${p.mid}" modulename="page" contextid="\\d+">`).test(p.act), `${pid}: cabecera de page.xml`);
    const html = dx(tag(p.act, 'content'));
    assert(!/<(style|script|details)\b/i.test(html), `${pid}: <style>/<script>/<details> en el contenido`);
    const lint = VC.lintCleanSafe(html);
    assert(lint.ok, `${pid}: CLEAN_SAFE ${JSON.stringify(lint.errors.slice(0, 2))}`);
    eq(S.unprotectedText(html), [], `${pid}: texto sin nolink`);
    // moodle_backup.xml
    assert(R.mb.includes(`<directory>activities/page_${p.mid}</directory>`) && R.mb.includes(`<name>page_${p.mid}_included</name>`), `${pid}: registro en moodle_backup.xml`);
    p.html = html;
    p.quiz = q;
  }
  return pages;
}

async function main() {
  // ── (a) Bancos + examen final + certificado ──
  const A = bankInput();
  const builtA = await B.buildDynamicMbzV3(A.input);
  if (OUT) {
    fs.writeFileSync(OUT, builtA.mbz);
    console.log(`   paquete con bancos → ${OUT}`);
  }
  const RA = await readPkg(builtA.mbz);
  const MA = A.input.manifest;

  await check('(a) bancos: validateMbzV3 sin hallazgos y versión 3.6.0', async () => {
    const v = await V.validateMbzV3(builtA.mbz, builtA.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 5)));
    eq(builtA.summary.builderVersion, '3.6.0', 'versión');
  });
  let pagesA = [];
  await check('(a) una página por quiz, después del quiz, availability exacta a SU quiz, completion 0, downloadcontent 0, fuera de completion.xml, registrada', () => {
    pagesA = checkPages(RA, MA);
    eq(pagesA.length, A.banks.size + 1, 'módulos con examen + final');
  });
  await check('fix 1 (M1/M5): sin h3 repetido (Moodle ya imprime el nombre), rótulo con la evaluación; «Pares correctos (definición → término):»', () => {
    for (const p of pagesA) {
      assert(!/<h[1-6]\b/.test(p.html), `${p.idnumber}: la página no lleva encabezados propios`);
      const t = txt(p.html);
      assert(!t.includes('Respuestas explicadas'), `${p.idnumber}: no repite el nombre de la página`);
      assert(t.startsWith(p.quiz.idnumber === 'cv3:final_exam' ? 'Evaluación final' : 'Evaluación del módulo'), `${p.idnumber}: rótulo`);
      assert(t.includes('Pares correctos (definición → término):') && !t.includes('cada definición con su término'), `${p.idnumber}: copy de emparejamiento`);
      eq(p.attempts, 3, `${p.idnumber}: perfil por defecto`);
    }
  });
  await check('(a) banco: la página trae TODAS las preguntas del banco con enunciado, correcta, explicación, distractores+why, whyWrong y pares «definición → término»', () => {
    for (const p of pagesA) {
      const final = p.quiz.idnumber === 'cv3:final_exam';
      const bank = final ? A.fin : A.banks.get(p.quiz.idnumber.replace('cv3:exam:', ''));
      const t = txt(p.html);
      assert(t.includes(S.EXAM_EXPLANATIONS_LEAD_BANK), `${p.idnumber}: lead`);
      let count = 0;
      for (const q of bank.questions) {
        const need = [q.stem, q.explanation];
        if (q.type === 'multichoice') need.push(q.correct.text, ...q.distractors.flatMap((d) => [d.text, d.why]));
        if (q.type === 'truefalse') need.push(q.whyWrong, `Respuesta correcta: ${q.answer ? 'Verdadero' : 'Falso'}`);
        if (q.type === 'match') need.push(...q.pairs.map((pr) => `${norm(pr.definition)} → ${norm(pr.term)}`));
        for (const n of need) assert(t.includes(norm(n)), `${p.idnumber} ${q.id}: falta «${norm(n).slice(0, 80)}»`);
        count++;
      }
      eq((t.match(/Pregunta \d+/g) || []).length, count, `${p.idnumber}: una entrada por pregunta del banco`);
      eq((t.match(/Por qué:/g) || []).length, count, `${p.idnumber}: un «Por qué» por pregunta`);
    }
  });
  await check('(a) banco: grupos por capítulo (módulo) / módulo (final) en el orden del Manifest y, dentro, por tipo del plan', () => {
    for (const p of pagesA) {
      const final = p.quiz.idnumber === 'cv3:final_exam';
      const bank = final ? A.fin : A.banks.get(p.quiz.idnumber.replace('cv3:exam:', ''));
      const t = txt(p.html);
      const groups = final
        ? MA.modules.map((m) => ({ id: m.moduleId, label: `Módulo ${m.moduleNumber}:` }))
        : MA.modules.find((m) => `cv3:exam:${m.moduleId}` === p.quiz.idnumber).chapters.map((c) => ({ id: c.chapterId, label: `Capítulo ${c.chapterNumber}:` }));
      let last = -1;
      for (const g of groups) {
        const at = t.indexOf(g.label);
        assert(at > last, `${p.idnumber}: grupo ${g.label} fuera de orden`);
        last = at;
      }
      const owner = (q) => (final ? q.moduleId : q.chapterId);
      const want = groups.flatMap((g) => ['multichoice', 'truefalse', 'match'].flatMap((ty) => bank.questions.filter((q) => q.type === ty && owner(q) === g.id)));
      let pos = -1;
      for (const q of want) {
        const at = t.indexOf(norm(q.stem));
        assert(at > pos, `${p.idnumber}: ${q.id} fuera de orden`);
        pos = at;
      }
    }
  });
  await check('(a) nota para docentes: en el label oculto del certificado (párrafo con las dos oraciones), exactamente una vez, sin cv3:shell:exams_teacher', () => {
    const holders = RA.acts.filter((a) => txt(a.intro).includes(S.EXAMS_TEACHER_NOTE_AVAILABILITY));
    eq(holders.map((h) => h.idnumber), ['cv3:shell:certificate_teacher'], 'portador');
    assert(txt(holders[0].intro).includes(S.EXAMS_TEACHER_NOTE), 'dos oraciones');
    eq([tag(holders[0].module, 'visible'), tag(holders[0].module, 'visibleold')], ['0', '0'], 'oculto');
    assert(!RA.byId('cv3:shell:exams_teacher'), 'sin label propio');
    eq(S.EXAMS_TEACHER_NOTE, 'Las páginas de “Respuestas explicadas” necesitan el acceso condicional de Moodle activado; si un estudiante las ve antes de presentar la evaluación, actívalo en Administración del sitio. Si el curso ya se restauró con el acceso condicional desactivado, actívalo y vuelve a restaurar el curso, o agrega a cada página “Respuestas explicadas” la restricción “Finalización de actividad” de su evaluación. Dar intentos adicionales a un estudiante que agotó una evaluación sin aprobar es decisión tuya: ten en cuenta que ya pudo leer sus “Respuestas explicadas”.', 'texto exacto');
    eq(RA.acts.filter((a) => tag(a.module, 'visible') !== '1').map((a) => a.idnumber), ['cv3:shell:certificate_teacher'], 'único oculto');
  });
  await check('(a) info del examen: «Al terminar cada intento…» con los intentos de facts; preguntas = slots', () => {
    const k = builtA.expectations.facts.assessment.kinds;
    for (const m of MA.modules.filter((x) => x.examEnabled)) {
      const t = txt(RA.byId(`cv3:exam_info:${m.moduleId}`).intro);
      const want = `Al terminar cada intento verás tu calificación. Las respuestas correctas y su explicación se habilitan en «Respuestas explicadas» cuando apruebes o cuando uses tus ${k.exam.attempts} intentos.`;
      assert(t.includes(want), `exam_info ${m.moduleNumber}: ${t.slice(0, 400)}`);
      assert(t.includes(`Preguntas: ${EB.planSlotCount(A.banks.get(m.moduleId).plan)}`), 'preguntas = slots');
    }
    const tf = txt(RA.byId('cv3:final_exam_info').intro);
    assert(tf.includes(`cuando uses tus ${k.finalExam.attempts} intentos.`), 'final');
    assert(tf.includes(`Preguntas: ${EB.planSlotCount(A.fin.plan)}`), 'final: preguntas = slots');
  });

  // ── GIFT (artifacts viejos) ──
  const G = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: true, courseId: 745 });
  const builtG = await B.buildDynamicMbzV3(G);
  const RG = await readPkg(builtG.mbz);
  await check('GIFT: validateMbzV3 sin hallazgos; página por quiz con cada respuesta correcta y SIN «Por qué»; info sin «su explicación»', async () => {
    const v = await V.validateMbzV3(builtG.mbz, builtG.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 5)));
    const pages = checkPages(RG, G.manifest);
    for (const p of pages) {
      const final = p.quiz.idnumber === 'cv3:final_exam';
      const gift = final ? G.contents.finalExamGift : G.contents.examGift.get(p.quiz.idnumber.replace('cv3:exam:', ''));
      const qs = MC.parseGIFT(gift);
      const t = txt(p.html);
      assert(t.includes(S.EXAM_EXPLANATIONS_LEAD_GIFT) && !t.includes('explicación.') && !t.includes('Por qué'), `${p.idnumber}: copy GIFT`);
      eq((t.match(/Pregunta \d+/g) || []).length, qs.length, `${p.idnumber}: una entrada por pregunta`);
      for (const q of qs) {
        assert(t.includes(norm(q.text)), `${p.idnumber}: enunciado «${q.text.slice(0, 60)}»`);
        const right = q.type === 'multichoice' ? q.options.filter((o) => o.correct).map((o) => o.text)
          : q.type === 'truefalse' ? [q.answer ? 'Verdadero' : 'Falso']
          : q.type === 'shortanswer' ? q.answers
          : q.pairs.map((pr) => `${norm(pr.q)} → ${norm(pr.a)}`);
        for (const r of right) assert(t.includes(norm(r)), `${p.idnumber}: respuesta «${r}»`);
      }
    }
    for (const id of ['cv3:final_exam_info', ...G.manifest.modules.filter((m) => m.examEnabled).map((m) => `cv3:exam_info:${m.moduleId}`)]) {
      const t = txt(RG.byId(id).intro);
      assert(t.includes('Las respuestas correctas se habilitan en «Respuestas explicadas» cuando apruebes o cuando uses tus 3 intentos.'), `${id}: ${t.slice(-300)}`);
    }
  });

  // ── (b) Sin examen final, con exámenes de módulo ──
  const NB = bankInput({ finalExam: false, courseId: 746 });
  const builtB = await B.buildDynamicMbzV3(NB.input);
  if (OUT) {
    const outB = OUT.replace(/\.mbz$/, '') + '-nofinal.mbz';
    fs.writeFileSync(outB, builtB.mbz);
    console.log(`   paquete con bancos sin evaluación final → ${outB}`);
  }
  const RB = await readPkg(builtB.mbz);
  await check('(b) sin final: validateMbzV3 ok; cv3:shell:exams_teacher oculto, PRIMERO de la primera sección de evaluación, dos oraciones; sin certificado', async () => {
    const v = await V.validateMbzV3(builtB.mbz, builtB.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 5)));
    checkPages(RB, NB.input.manifest);
    const t = RB.byId('cv3:shell:exams_teacher');
    assert(t && t.modname === 'label', 'falta el label');
    eq([tag(t.module, 'visible'), tag(t.module, 'visibleold')], ['0', '0'], 'oculto');
    const firstExamSec = Math.min(...RB.acts.filter((a) => a.modname === 'quiz').map((a) => a.section));
    eq(t.section, firstExamSec, 'primera sección con evaluación');
    eq(RB.seq[firstExamSec][0], t.mid, 'primero de su sección');
    const tt = txt(t.intro);
    assert(tt.includes(S.EXAMS_TEACHER_NOTE_AVAILABILITY) && tt.includes(S.EXAMS_TEACHER_NOTE_ATTEMPTS) && tt.includes('Solo docentes'), 'texto');
    eq(RB.acts.filter((a) => txt(a.intro).includes(S.EXAMS_TEACHER_NOTE_AVAILABILITY)).map((a) => a.idnumber), ['cv3:shell:exams_teacher'], 'una sola vez');
    assert(!RB.byId('cv3:shell:certificate_teacher'), 'sin certificado');
    eq(RB.acts.filter((a) => tag(a.module, 'visible') !== '1').map((a) => a.idnumber), ['cv3:shell:exams_teacher'], 'único oculto');
  });
  await check('(b) validador: un segundo módulo oculto o la nota fuera de lugar → hallazgo', async () => {
    const z = await JSZip.loadAsync(builtB.mbz);
    const libro = RB.byId('cv3:shell:route');
    z.file(`${libro.dir}/module.xml`, libro.module.replace('<visible>1</visible>', '<visible>0</visible>'));
    const bad = await z.generateAsync({ type: 'nodebuffer' });
    const v = await V.validateMbzV3(bad, builtB.expectations);
    assert(!v.ok && v.issues.some((i) => i.where === 'cv3:shell:route'), JSON.stringify(v.issues.slice(0, 3)));
    const z2 = await JSZip.loadAsync(builtB.mbz);
    const t = RB.byId('cv3:shell:exams_teacher');
    z2.file(`${t.dir}/module.xml`, t.module.replace('<visible>0</visible>', '<visible>1</visible>'));
    const v2 = await V.validateMbzV3(await z2.generateAsync({ type: 'nodebuffer' }), builtB.expectations);
    assert(!v2.ok && v2.issues.some((i) => i.where === 'cv3:shell:exams_teacher'), JSON.stringify(v2.issues.slice(0, 3)));
  });

  // ── (c) Sin evaluaciones ──
  await check('(c) sin evaluaciones: ni páginas ni nota para docentes; validateMbzV3 ok', async () => {
    const C = PF.packagingInput(distRoot, { engine: 'h5p', finalExam: false, courseId: 747,
      modules: [{ examEnabled: false, chapters: [{ video: true, activity: true }, { video: false, activity: true }] }] });
    const r = await B.buildDynamicMbzV3(C);
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 5)));
    const R = await readPkg(r.mbz);
    eq(R.acts.filter((a) => a.modname === 'page' || a.modname === 'quiz').length, 0, 'sin quiz ni página');
    assert(!R.byId('cv3:shell:exams_teacher') && !R.byId('cv3:shell:certificate_teacher'), 'sin nota');
    assert(!R.acts.some((a) => txt(a.intro).includes('Respuestas explicadas')), 'nadie menciona la página');
  });

  // ── Intentos ilimitados ──
  await check('fix 1 (C1) intentos ilimitados (exam 0): «… cuando apruebes.», availability SOLO e=1 en el examen de módulo y e=1|e=3 en el final (3 intentos)', async () => {
    const defaults = P.defaultAssessmentProfile({ finalExam: true });
    const X = bankInput({ courseId: 748, profile: { ...defaults, attempts: { ...defaults.attempts, exam: 0 } } });
    const r = await B.buildDynamicMbzV3(X.input);
    if (OUT) fs.writeFileSync(OUT.replace(/\.mbz$/, '') + '-unlimited.mbz', r.mbz);
    const v = await V.validateMbzV3(r.mbz, r.expectations);
    assert(v.ok, JSON.stringify(v.issues.slice(0, 5)));
    const R = await readPkg(r.mbz);
    const pg = checkPages(R, X.input.manifest);
    for (const p of pg) {
      const unl = p.quiz.idnumber !== 'cv3:final_exam';
      eq(p.attempts, unl ? 0 : 3, `${p.idnumber}: intentos`);
      eq(/"e":3/.test(tag(p.module, 'availability')), !unl, `${p.idnumber}: e=3 solo con intentos limitados`);
    }
    for (const m of X.input.manifest.modules.filter((x) => x.examEnabled)) {
      const t = txt(R.byId(`cv3:exam_info:${m.moduleId}`).intro);
      assert(t.includes('Las respuestas correctas y su explicación se habilitan en «Respuestas explicadas» cuando apruebes.'), t.slice(-300));
    }
    eq(S.examExplanationsInfoText(1, true), 'Al terminar cada intento verás tu calificación. Las respuestas correctas y su explicación se habilitan en «Respuestas explicadas» cuando apruebes o cuando uses tu único intento.', '1 intento');
  });

  await check('determinista: mismos insumos → mismos bytes', async () => {
    const r2 = await B.buildDynamicMbzV3(bankInput().input);
    assert(r2.mbz.equals(builtA.mbz), 'bytes distintos');
  });

  console.log(failures ? `\nHAY FALLOS (${passes} ✅, ${failures} ❌).` : `\nTodos los checks de P2-B4 pasaron (${passes} ✅, 0 ❌).`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
