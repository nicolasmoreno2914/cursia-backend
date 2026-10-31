#!/usr/bin/env node
/* eslint-disable no-console */
// r80 · Capítulos reales en lugar de «Profundización N: <módulo>». Puro: sin IA, sin red, sin base. USD 0.
//
// Recorrido completo y determinista: documento (fixture) → contexto académico (extractor sin proveedores) → estructura del
// documento → motor de horas (distribuidor) → Manifest y costo estimado → «aplicar» → segunda pasada.
//
//   RC0  interruptor apagado: la salida es la de siempre, byte a byte (realChapters false = ausente = env sin definir)
//   RC1  Inglés 6.º (#87, documento real): 18 capítulos de contenido con temas del documento, 0 profundizaciones,
//        títulos únicos, cada subtema una sola vez y en orden, dentro de la tolerancia, punto fijo, más barato que antes
//   RC2  otros microcurrículos (Excel 40 h · SST 100 h · Contabilidad en prosa 60 h · Enfermería 120 h): ninguna
//        profundización genérica, nada inventado (cada palabra de un título nuevo viene del documento), cobertura exacta
//        de los subtemas, horas que suman, sin pasar del objetivo, ejercicios guiados ≤ 30 %, punto fijo
//   RC3  forma fijada por la institución (formatos M 3 × 4 y L 4 × 5 con el documento de Inglés): los capítulos extra
//        salen de los subtemas; cada contenido sigue en UN capítulo (cobertura sin duplicados); ninguno sin tema
//   RC4  «Ajustar al presupuesto» (r79) reutiliza el mismo motor: el diseño elegido no tiene profundizaciones
//   RC5  videos por necesidad: un capítulo de procedimiento / comunicación lleva video aunque cierre el módulo; la práctica
//        nunca lleva video; ningún módulo con 2+ capítulos de contenido queda sin video
//   RC7  impacto de cambios (applyProposalToRows) refleja la división como «Aplicar diseño»
//   RC8  resultados obligatorios con cobertura (contexto académico congelado, 40 / 60 / 100 / 120 h): ningún RA ni
//        competencia sin evidencia; los que el documento declara para todo el curso (Inglés: RA1, RA7, CO1) se evidencian
//        en las prácticas integradoras y el examen final (regla A1t, visible), nunca en un capítulo de contenido ajeno
//   RC9  edad desde el grado escolar del documento («Grado: Sexto (6.º)» → niños, inferido); sin grado, nada
//   RC6  parser de subtemas: enumeraciones en español, «;», viñetas, formas del idioma («like, love, don’t like y can»),
//        paréntesis; la prosa y los textos de una sola idea no se dividen
//
// Uso: npm run build && node scripts/check-r80-real-chapters.js [path/to/dist]
'use strict';
const fs = require('fs');
const path = require('path');
const netAttempts = [];
{
  const deny = (what) => function () { netAttempts.push(what); throw new Error(`red prohibida: ${what}`); };
  for (const mod of ['http', 'https']) { const m = require(mod); m.request = deny(`${mod}.request`); m.get = deny(`${mod}.get`); }
  globalThis.fetch = deny('fetch');
}
delete process.env.DYNAMIC_REAL_CHAPTERS;
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(REPO, 'dist'));
const L = (r) => require(path.join(distRoot, r));
const P = L('modules/pedagogy/index.js');
const E = L('modules/academic-context/extract/extractor.js');
const CD = L('modules/academic-context/context-design.js');
const TS = L('modules/study-time/topic-split.js');
const F = L('modules/course-design/budget-fit.js');
const FX = path.join(REPO, 'scripts/fixtures/microcurriculum');
const SNAP = L('modules/course-blueprints/blueprint-snapshot.js');
const AC = L('modules/academic-context/index.js');

let passes = 0;
let failures = 0;
async function check(name, fn) {
  try { await fn(); passes++; console.log(`  ✅ ${name}`); } catch (e) { failures++; console.log(`  ❌ ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: esperado ${JSON.stringify(b)}, encontrado ${JSON.stringify(a)}`); };
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'");
const wordsOf = (s) => norm(s).split(/[^a-z0-9'ñ]+/).filter(Boolean);

// ── Documentos ──────────────────────────────────────────────────────────────────────────────────────────────────────
const DOCS = [
  { key: 'ingles6', file: 'microcurriculo-ingles-grado-6.pdf', approach: 'significativo', level: 'secondary', title: 'Inglés Básico – Grado Sexto' },
  { key: 'excel40', file: 'r80/excel-auxiliares-40h.txt', approach: 'competencias', level: 'technical', title: 'Excel para auxiliares administrativos' },
  { key: 'sst100', file: 'r80/sst-supervisores-100h.txt', approach: 'competencias', level: 'technical', title: 'Seguridad y salud en el trabajo para supervisores' },
  { key: 'conta60', file: 'r80/contabilidad-basica-60h.txt', approach: 'significativo', level: 'adult', title: 'Contabilidad básica para emprendedores' },
  { key: 'enf120', file: 'r80/enfermeria-adulto-mayor-120h.txt', approach: 'competencias', level: 'technical', title: 'Cuidado de enfermería del adulto mayor' },
];
const structureOf = (doc, proposal) => ({
  course: { title: doc.title, finalExam: true, activityEngine: 'h5p', reviewCards: true },
  modules: proposal.modules.map((m, mi) => ({ id: `m${mi + 1}`, title: m.title, objective: m.objective, description: m.description, examEnabled: true,
    chapters: m.chapters.map((c, ci) => ({ id: `m${mi + 1}c${ci + 1}`, title: c.title, objective: c.objective, description: c.description, videoEnabled: true, activityEnabled: true })) })),
});
const profileOf = (doc, ctx, hours, prefs = { audiovisual: 'recommended' }) => ({
  pedagogyProfileVersion: 1, primaryApproach: doc.approach, secondaryApproaches: [],
  learner: { description: null, ageGroup: null, educationLevel: doc.level === 'adult' ? null : doc.level, priorKnowledge: null, experience: null },
  learningOutcomes: { know: ctx.outcomes.map((o) => o.text).slice(0, 8), do: [], competencies: [] },
  learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual', targetHours: hours, designPreferences: prefs,
});
const dry = (st, pr, realChapters) => P.runPedagogyDryRun({ structure: st, profile: pr, activityTypeRules: 2, ...(realChapters === undefined ? {} : { realChapters }) });
/** «Aplicar»: el diseño propuesto pasa a ser la estructura (lo mismo que escribe applyDistribution). */
const applied = (d, course) => {
  let k = 0;
  return { course, modules: d.modules.map((m) => ({ id: m.id, title: m.title, examEnabled: m.examEnabled, chapters: m.chapters.map((c) => ({
    id: c.proposed ? `ap${++k}` : c.id, title: c.title, objective: c.objective, description: c.description ?? null, kind: c.kind,
    videoEnabled: c.kind === 'content' ? c.videoEnabled : false, activityEnabled: c.activityEnabled, applicationMinutes: c.applicationMinutes, guidedPracticeMinutes: c.guidedPracticeMinutes })) })) };
};
const chaptersOf = (d) => d.modules.flatMap((m) => m.chapters.map((c) => ({ ...c, moduleId: m.id, moduleTitle: m.title })));
const generic = (d) => chaptersOf(d).filter((c) => /profundizaci[oó]n/i.test(c.title) || /analizar casos complejos/i.test(c.objective || ''));
const usd = (d) => Number(d.materialized.providers.estimateUsd.expected);

/** Invariantes de un diseño con capítulos reales sobre una estructura que salió del documento. */
function assertRealDesign(name, st, d, pr) {
  eq(generic(d).map((c) => c.title), [], `${name}: capítulos de profundización genéricos`);
  const content = chaptersOf(d).filter((c) => c.kind === 'content');
  const titles = content.map((c) => norm(c.title));
  eq(titles.filter((t, i) => titles.indexOf(t) !== i), [], `${name}: títulos de contenido repetidos`);
  const objs = content.map((c) => c.objective).filter(Boolean).map(norm);
  eq(objs.filter((t, i) => objs.indexOf(t) !== i), [], `${name}: objetivos repetidos`);
  // Cobertura y orden: los subtemas de cada contenido dividido aparecen una sola vez, en el orden del documento.
  const bySource = new Map();
  for (const c of content) if (c.split) { const a = bySource.get(c.split.sourceChapterId) || []; a.push(c); bySource.set(c.split.sourceChapterId, a); }
  for (const [srcId, parts] of bySource) {
    const src = st.modules.flatMap((m) => m.chapters).find((c) => c.id === srcId);
    assert(src, `${name}: el capítulo de origen ${srcId} existe`);
    const want = TS.chapterSubtopics({ title: src.title, description: src.description }).items;
    const got = parts.sort((a, b) => a.split.part - b.split.part).flatMap((p) => p.split.subtopics);
    eq(got, want, `${name}: subtemas de «${src.title.slice(0, 50)}» (una vez cada uno, en orden)`);
    eq(parts.map((p) => p.split.parts), parts.map(() => parts.length), `${name}: partes consistentes`);
    assert(parts.every((p) => p.split.subtopics.length >= 1) && parts.filter((p) => p.split.subtopics.length === 1).length <= 1, `${name}: al menos 2 subtemas por capítulo (uno puede llevar uno)`);
    // Nada inventado: cada palabra del título nuevo está en el texto del documento.
    const docWords = new Set(wordsOf(`${src.title} ${src.description || ''} y e otros temas`));
    for (const p of parts) {
      const extra = wordsOf(p.title).filter((w) => !docWords.has(w));
      eq(extra, [], `${name}: «${p.title}» usa solo palabras del documento`);
    }
  }
  // Los capítulos que no se dividieron conservan su título del documento.
  const srcTitles = new Map(st.modules.flatMap((m) => m.chapters).map((c) => [c.id, c.title]));
  for (const c of content) if (!c.proposed && !c.split) eq(c.title, srcTitles.get(c.id), `${name}: «${c.title.slice(0, 40)}» conserva su título`);
  // Horas: suman, no se pasan del objetivo, y los ejercicios guiados no son la mayoría del curso.
  const sum = Object.values(d.hoursByComponent).reduce((a, b) => a + b, 0);
  assert(Math.abs(sum - d.estimatedHours) <= 0.35, `${name}: las horas por componente suman ${sum.toFixed(1)} ≈ ${d.estimatedHours}`);
  assert(d.estimatedHours <= d.targetHours + d.toleranceHours + 1e-9, `${name}: ${d.estimatedHours} h no pasa del objetivo ${d.targetHours} ± ${d.toleranceHours}`);
  assert(d.status === 'within_tolerance' || (d.status === 'cannot_reach_target' && d.recommendations.length > 0), `${name}: estado ${d.status} (si no alcanza, lo dice)`);
  // «Dentro de la tolerancia» es verdad: el estado se calcula con los videos finales del diseño.
  if (d.status === 'within_tolerance') assert(Math.abs(d.estimatedHours - d.targetHours) <= d.toleranceHours + 0.05, `${name}: ${d.estimatedHours} h dentro de ${d.targetHours} ± ${d.toleranceHours}`);
  assert(((d.counts.guidedPracticeMinutes || 0) / 60) <= 0.3 * d.estimatedHours + 1e-9, `${name}: ejercicios guiados ≤ 30 % (${((d.counts.guidedPracticeMinutes || 0) / 60).toFixed(1)} h de ${d.estimatedHours})`);
  // Videos: la práctica nunca; ningún módulo con 2+ capítulos de contenido sin video.
  assert(chaptersOf(d).filter((c) => c.kind === 'practice').every((c) => !c.videoEnabled), `${name}: práctica sin video`);
  for (const m of d.modules) {
    const cc = m.chapters.filter((c) => c.kind === 'content');
    if (cc.length >= 2) assert(cc.some((c) => c.videoEnabled), `${name}: el módulo «${m.title}» tiene al menos un video`);
  }
  // Punto fijo: aplicar y volver a calcular no propone nada (cuando el diseño llega a la meta; un diseño que no llega se
  // rediseña al aplicarlo también sin r80 — comportamiento previo del distribuidor, ver RC2).
  if (d.status !== 'within_tolerance') return;
  const d2 = dry(applied(d, st.course), pr, true).distribution;
  eq(d2.changes.map((c) => `${c.type}:${c.detail}`), [], `${name}: punto fijo (cambios tras aplicar)`);
  eq(d2.estimatedHours, d.estimatedHours, `${name}: mismas horas tras aplicar`);
}

(async () => {
  const ctx = {};
  for (const doc of DOCS) {
    const r = await E.extractAcademicContext([{ name: path.basename(doc.file), data: fs.readFileSync(path.join(FX, doc.file)) }]);
    ctx[doc.key] = r.context;
  }
  const hoursOf = (k) => ctx[k].hours.total.value;
  const stOf = (k) => structureOf(DOCS.find((d) => d.key === k), CD.proposeStructureFromContext(ctx[k]));
  const prOf = (k, prefs) => profileOf(DOCS.find((d) => d.key === k), ctx[k], hoursOf(k), prefs);
  const report = [];

  console.log('r80 · capítulos reales');
  await check('RC0 interruptor apagado: salida byte a byte la de siempre (false = ausente = env sin definir)', () => {
    for (const doc of DOCS) {
      const st = stOf(doc.key);
      const pr = prOf(doc.key);
      const a = JSON.stringify(dry(st, pr, undefined).distribution);
      const b = JSON.stringify(dry(st, pr, false).distribution);
      eq(a === b, true, `${doc.key}: ausente vs false`);
      assert(!/"split"|split_content_chapter/.test(a), `${doc.key}: sin el interruptor no hay divisiones`);
    }
  });

  await check('RC1 Inglés 6.º (#87): 18 capítulos con temas del documento, 0 profundizaciones, punto fijo, más barato', () => {
    const st = stOf('ingles6');
    const pr = prOf('ingles6');
    const before = dry(st, pr, false).distribution;
    const d = dry(st, pr, true).distribution;
    eq([hoursOf('ingles6'), st.modules.length, st.modules.map((m) => m.chapters.length)], [60, 6, [1, 1, 1, 1, 1, 1]], 'documento de Inglés 6.º');
    eq(generic(before).length, 24, 'antes: 24 profundizaciones genéricas (el problema de #89)');
    eq([d.counts.contentChapters, d.counts.practiceChapters], [18, 6], '18 capítulos de contenido + 6 de práctica');
    eq(d.modules.map((m) => m.chapters.filter((c) => c.kind === 'content').length), [3, 3, 3, 3, 3, 3], '3 capítulos de contenido por módulo');
    eq(d.modules[0].chapters.filter((c) => c.kind === 'content').map((c) => c.title), ['Saludos y presentaciones', 'Alfabeto y números', 'Información personal y verbo to be'], 'módulo 1');
    eq(d.modules[4].chapters.filter((c) => c.kind === 'content').map((c) => c.title), ['Gustos', 'Preferencias y deportes', 'Actividades de tiempo libre y like, love, don’t like y can'], 'módulo 5 (formas del idioma juntas)');
    assertRealDesign('ingles6', st, d, pr);
    assert(d.status === 'within_tolerance', `dentro de la tolerancia (${d.estimatedHours} h)`);
    assert(d.counts.videoChapters >= 12, `al menos 12 videos (${d.counts.videoChapters})`);
    assert(usd(d) < usd(before), `más barato que el diseño con profundizaciones (${usd(d).toFixed(2)} < ${usd(before).toFixed(2)})`);
    // Barrido de metas: cada «dentro de la tolerancia» lo es de verdad y nunca aparece una profundización.
    for (const h of [20, 30, 40, 45, 50, 55, 60, 66, 80]) {
      const dh = dry(st, { ...pr, targetHours: h }, true).distribution;
      assertRealDesign(`ingles6@${h}h`, st, dh, { ...pr, targetHours: h });
    }
    report.push({ key: 'ingles6', before: { ch: before.counts.chapters, generic: generic(before).length, videos: before.counts.videoChapters, h: before.estimatedHours, usd: usd(before).toFixed(2) }, after: { ch: d.counts.chapters, content: d.counts.contentChapters, practice: d.counts.practiceChapters, generic: 0, videos: d.counts.videoChapters, h: d.estimatedHours, status: d.status, usd: usd(d).toFixed(2) } });
  });

  await check('RC2 otros microcurrículos (40 / 100 / 60 en prosa / 120 h): sin relleno genérico, nada inventado, horas honestas', () => {
    for (const k of ['excel40', 'sst100', 'conta60', 'enf120']) {
      const st = stOf(k);
      const pr = prOf(k);
      const before = dry(st, pr, false).distribution;
      const d = dry(st, pr, true).distribution;
      assertRealDesign(k, st, d, pr);
      report.push({ key: k, before: { ch: before.counts.chapters, generic: generic(before).length, videos: before.counts.videoChapters, h: before.estimatedHours, status: before.status, usd: usd(before).toFixed(2) }, after: { ch: d.counts.chapters, content: d.counts.contentChapters, practice: d.counts.practiceChapters, generic: 0, videos: d.counts.videoChapters, h: d.estimatedHours, status: d.status, usd: usd(d).toFixed(2) } });
    }
    // Contabilidad (contenidos en prosa): no hay subtemas que dividir → ningún capítulo de contenido nuevo.
    const dc = dry(stOf('conta60'), prOf('conta60'), true).distribution;
    eq(dc.counts.contentChapters, 3, 'contabilidad en prosa: no se dividen ni se inventan capítulos de contenido');
    // Enfermería ya trae un capítulo por subtema: tampoco se dividen.
    const de = dry(stOf('enf120'), prOf('enf120'), true).distribution;
    eq(chaptersOf(de).filter((c) => c.split).length, 0, 'enfermería: capítulos de un solo subtema no se dividen');
    // Excel (listas largas): crece con sus propios subtemas.
    const dx = dry(stOf('excel40'), prOf('excel40'), true).distribution;
    assert(chaptersOf(dx).filter((c) => c.split).length > 0, 'excel: los contenidos con listas largas se dividen');
  });

  await check('RC3 forma fijada (M 3 × 4 y L 4 × 5 con el documento de Inglés): extra = subtemas, cobertura sin duplicados', () => {
    const c6 = ctx.ingles6;
    const ids = c6.units.flatMap((u) => u.contents.map((c) => c.id));
    for (const [n, m] of [[3, 4], [4, 5]]) {
      const before = CD.proposeShapedStructureFromContext(c6, { modules: n, chaptersPerModule: m }, { realChapters: false });
      const p = CD.proposeShapedStructureFromContext(c6, { modules: n, chaptersPerModule: m }, { realChapters: true });
      const all = p.modules.flatMap((x) => x.chapters);
      eq(all.filter((c) => /profundizaci[oó]n/i.test(c.title)).map((c) => c.title), [], `${n}×${m}: sin profundizaciones`);
      eq(p.modules.flatMap((x) => x.chapters.flatMap((c) => c.sourceContentIds)), ids, `${n}×${m}: cada contenido en UN capítulo y en orden`);
      const t = all.map((c) => norm(c.title));
      eq(t.filter((x, i) => t.indexOf(x) !== i), [], `${n}×${m}: títulos únicos`);
      assert(p.notes.some((x) => /subtemas que el documento enumera/.test(x)), `${n}×${m}: la nota explica de dónde salen los capítulos`);
      report.push({ key: `forma ${n}×${m}`, before: { ch: before.modules.flatMap((x) => x.chapters).length, generic: before.modules.flatMap((x) => x.chapters).filter((c) => /profundizaci/i.test(c.title)).length }, after: { ch: all.length, generic: 0, created: all.length } });
    }
    // Con la forma 3 × 4 hay 12 capítulos y el documento da 18 piezas posibles: los 12 se llenan con temas del documento.
    eq(CD.proposeShapedStructureFromContext(c6, { modules: 3, chaptersPerModule: 4 }, { realChapters: true }).modules.map((x) => x.chapters.length), [4, 4, 4], '3 × 4 completo');
    // 4 × 5 = 20 capítulos > 18 piezas: los 2 que faltan NO se crean (sin tema) y la nota lo dice.
    const pl = CD.proposeShapedStructureFromContext(c6, { modules: 4, chaptersPerModule: 5 }, { realChapters: true });
    eq(pl.modules.flatMap((x) => x.chapters).length, 18, '4 × 5: 18 capítulos con tema (los 2 sin tema no se crean)');
    assert(pl.notes.some((x) => /no se crean/.test(x)), '4 × 5: la nota explica los capítulos que no se crean');
  });

  await check('RC4 «Ajustar al presupuesto» (r79) con capítulos reales: el diseño elegido no tiene profundizaciones', () => {
    const LEVERS = { audiovisual: { base: 'recommended', locked: false }, guidedPractice: { base: 'auto', locked: false }, emphasis: { base: 'balanced', locked: false }, activityKinds: { base: 'none', locked: false } };
    const r = F.fitDesignToBudget({ base: { structure: stOf('ingles6'), profile: prOf('ingles6'), activityTypeRules: 2, realChapters: true }, budgetUsd: 100, levers: LEVERS });
    eq(r.status, 'fits', `cabe en USD 100 (${r.message})`);
    const d = r.chosenResult.distribution;
    eq(generic(d).length, 0, 'sin profundizaciones en el diseño elegido');
    assert(Number(r.chosen.expectedUsd ?? r.chosen.usd?.expected ?? usd(d)) <= 100, 'dentro del presupuesto');
    report.push({ key: 'ajuste USD 100', after: { ch: d.counts.chapters, generic: 0, videos: d.counts.videoChapters, h: d.estimatedHours, usd: usd(d).toFixed(2) } });
  });

  await check('RC5 videos por necesidad: procedimiento / comunicación con video aunque cierre; práctica sin video', () => {
    const st = { course: { title: 'Atención al cliente', finalExam: true, activityEngine: 'h5p', reviewCards: true }, modules: [{ id: 'm1', title: 'Servicio', examEnabled: true,
      chapters: [{ id: 'c1', title: 'Protocolo de atención, saludo al cliente, escucha activa y manejo de objeciones', videoEnabled: true, activityEnabled: true }] }] };
    const pr = { ...prOf('excel40'), targetHours: 14 };
    const d = dry(st, pr, true).distribution;
    const cc = d.modules[0].chapters.filter((c) => c.kind === 'content');
    assert(cc.length >= 2, `se divide (${cc.map((c) => c.title).join(' | ')})`);
    const last = cc[cc.length - 1];
    const L2 = L('modules/pedagogy/learning-type.js');
    const needs = L2.classifyLearningType({ title: last.title, objective: null, description: null }).type;
    if (['procedimental', 'protocolo', 'comunicacion'].includes(needs)) assert(last.videoEnabled, `«${last.title}» (${needs}) lleva video aunque cierre el módulo`);
    else assert(!last.videoEnabled, `«${last.title}» (${needs}) sigue el reparto «Recomendado» (sin video al cerrar)`);
  });

  await check('RC6 parser de subtemas', () => {
    eq(TS.subtopicsOf('Saludos, presentaciones, alfabeto, números, información personal y verbo to be.'), ['Saludos', 'presentaciones', 'alfabeto', 'números', 'información personal', 'verbo to be'], 'enumeración con «y»');
    eq(TS.subtopicsOf('Gustos, preferencias, deportes, actividades de tiempo libre y like, love, don’t like y can.'), ['Gustos', 'preferencias', 'deportes', 'actividades de tiempo libre', 'like, love, don’t like y can'], 'formas del idioma juntas');
    eq(TS.subtopicsOf('Fórmulas, funciones (SUMA, PROMEDIO, SI), tablas dinámicas y gráficos'), ['Fórmulas', 'funciones (SUMA, PROMEDIO, SI)', 'tablas dinámicas', 'gráficos'], 'paréntesis');
    eq(TS.subtopicsOf('Higiene y confort; alimentación e hidratación; movilización'), ['Higiene y confort', 'alimentación e hidratación', 'movilización'], 'punto y coma (sin partir «y» internos)');
    eq(TS.subtopicsOf('- Marco legal\n- Responsabilidades\n- Comité paritario'), ['Marco legal', 'Responsabilidades', 'Comité paritario'], 'viñetas');
    eq(TS.subtopicsOf('La contabilidad como sistema de información que permite al emprendedor conocer la situación real de su negocio y tomar decisiones.'), [], 'prosa');
    eq(TS.subtopicsOf('Oferta y demanda'), [], 'una sola idea');
    eq(TS.partitionSubtopics(['a', 'b', 'c', 'd', 'e'], 3), [['a'], ['b', 'c'], ['d', 'e']], 'grupos consecutivos, el más chico primero');
    eq([TS.maxPartsFor(1), TS.maxPartsFor(2), TS.maxPartsFor(5), TS.maxPartsFor(6)], [1, 1, 3, 3], 'máximo de capítulos por contenido');
    assert(TS.partTitle(['a'.repeat(50), 'b'.repeat(50)]).length <= 80, 'título dentro de 80 caracteres');
    eq(TS.subtopicsOf('7 herramientas de calidad, 3 tipos de muda y 5S'), ['7 herramientas de calidad', '3 tipos de muda', '5S'], 'números que son parte del tema');
    eq(TS.subtopicsOf('Comunicación, liderazgo, y trabajo en equipo'), ['Comunicación', 'liderazgo', 'trabajo en equipo'], 'coma de Oxford');
    eq(TS.subtopicsOf('1. Marco legal\n2) Responsabilidades'), ['Marco legal', 'Responsabilidades'], 'listas numeradas');
    assert(TS.partTitle(['x'.repeat(120)]).length === 80, 'una palabra larguísima se recorta (nunca título vacío)');
  });

  await check('RC7 impacto de cambios: «aplicar» en memoria escribe los títulos y descripciones nuevos (como applyDistribution)', () => {
    const CI = L('modules/invalidation/change-impact.service.js');
    const st = stOf('ingles6');
    const d = dry(st, prOf('ingles6'), true).distribution;
    const rows = { modules: st.modules.map((m, i) => ({ id: m.id, position: i, title: m.title, objective: null, exam_enabled: true })),
      chapters: st.modules.flatMap((m) => m.chapters.map((c, i) => ({ id: c.id, module_id: m.id, position: i, title: c.title, objective: null, description: c.description ?? null, video_enabled: true, activity_enabled: true, outcome_ids: ['RA2'] }))) };
    const out = CI.applyProposalToRows(rows, d.modules);
    const src = out.chapters.find((c) => c.id === 'm1c1');
    eq([src.title, /^Subtemas: Saludos y presentaciones\./.test(src.description)], ['Saludos y presentaciones', true], 'el capítulo de origen toma su título nuevo (el contenido generado con el título viejo queda desactualizado)');
    const added = out.chapters.filter((c) => c.module_id === 'm1' && String(c.id).startsWith('proposed:content'));
    eq(added.map((c) => c.title), ['Alfabeto y números', 'Información personal y verbo to be'], 'capítulos nuevos del módulo 1');
    assert(added.every((c) => /^Subtemas: /.test(c.description)), 'con su descripción');
    // Lo que se ve es lo que se congela: el Blueprint materializado de la propuesta lleva los títulos, descripciones y
    // resultados que escribe «Aplicar diseño».
    const DR = L('modules/pedagogy/dry-run.js');
    const base = DR.snapshotFromStructure({ ...st, modules: st.modules.map((m) => ({ ...m, chapters: m.chapters.map((c) => ({ ...c })) })) });
    const bp = DR.materializeDistribution(base, d);
    eq(bp.modules.flatMap((m) => m.chapters.map((c) => c.title)), d.modules.flatMap((m) => m.chapters.map((c) => c.title)), 'Blueprint materializado = títulos de la propuesta');
    const bp11 = bp.modules[0].chapters[0];
    assert(/^Subtemas: Saludos y presentaciones\./.test(bp11.description || ''), 'materializado: descripción nueva del capítulo de origen');
    assert(bp.modules[0].chapters.filter((c) => c.kind !== 'practice').every((c) => /^Subtemas: /.test(c.description || '')), 'materializado: descripción en las partes nuevas');
  });

  await check('RC8 resultados obligatorios con cobertura a 40 / 60 / 100 / 120 h (transversales en prácticas y examen final)', () => {
    process.env.DYNAMIC_REAL_CHAPTERS = 'true';
    try {
      let n = 0;
      const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      const snapOf = (k) => {
        const prop = CD.proposeStructureFromContext(ctx[k]);
        const modules = []; const chapters = [];
        prop.modules.forEach((m, mi) => { const id = uuid(); modules.push({ id, position: mi, title: m.title, objective: m.objective, description: m.description, exam_enabled: true });
          m.chapters.forEach((c, ci) => chapters.push({ id: uuid(), module_id: id, position: ci, title: c.title, objective: c.objective, description: c.description, video_enabled: true, activity_enabled: true, ...(c.outcomeIds.length ? { outcome_ids: c.outcomeIds } : {}) })); });
        return SNAP.buildBlueprintSnapshotV2({ id: 9000, title: k, finalExam: true, activityEngine: 'h5p', reviewCards: true, academicContext: AC.academicBlueprintContext(ctx[k]) }, modules, chapters);
      };
      for (const [k, h] of [['excel40', 40], ['ingles6', 60], ['sst100', 100], ['enf120', 120]]) {
        const r = P.runPedagogyDryRun({ structure: snapOf(k), profile: prOf(k), activityTypeRules: 2, realChapters: true });
        const d = r.distribution;
        eq(d.targetHours, h, `${k}: meta`);
        eq(generic(d).length, 0, `${k}: sin profundizaciones`);
        const al = d.materialized.alignment;
        eq(al.outcomes.filter((o) => o.status === 'uncovered').map((o) => o.id), [], `${k}: resultados y competencias sin evidencia`);
        eq(al.findings.filter((f) => f.severity === 'critical').map((f) => `${f.rule}:${f.outcomeIds.join('+')}`), [], `${k}: hallazgos críticos`);
        const titles = chaptersOf(d).filter((c) => c.kind === 'content').map((c) => norm(c.title));
        eq(titles.filter((t, i) => titles.indexOf(t) !== i), [], `${k}: contenido duplicado`);
        if (k === 'ingles6') {
          eq(al.findings.filter((f) => f.rule === 'A1t').map((f) => f.outcomeIds[0]), ['RA1', 'RA7', 'CO1'], 'Inglés: RA1, RA7 y CO1 son transversales (A1t, visible)');
          for (const id of ['RA1', 'RA7']) {
            const o = al.outcomes.find((x) => x.id === id);
            const kinds = new Set(o.evidence.map((e) => e.type));
            assert(kinds.has('application_activity') && kinds.has('final_exam'), `${id}: evidencia en Actividades de las prácticas y en el examen final (${[...kinds].join(', ')})`);
            const contentCh = new Set(chaptersOf(d).filter((c) => c.kind === 'content').map((c) => c.id));
            assert(o.chapterIds.every((id2) => !contentCh.has(id2)), `${id}: no se pega a capítulos de contenido`);
          }
        }
        report.push({ key: `cobertura ${k}`, after: { h: d.estimatedHours, status: d.status, generic: 0, coverage: al.coverage, transversal: al.findings.filter((f) => f.rule === 'A1t').map((f) => f.outcomeIds[0]) } });
      }
      // Sin el interruptor: RA1 y RA7 siguen como siempre (críticos); el cambio solo existe con r80.
      delete process.env.DYNAMIC_REAL_CHAPTERS;
      const off = P.runPedagogyDryRun({ structure: snapOf('ingles6'), profile: prOf('ingles6'), activityTypeRules: 2 }).distribution.materialized.alignment;
      eq(off.findings.filter((f) => f.severity === 'critical').map((f) => f.outcomeIds[0]), ['RA1', 'RA7'], 'apagado: lo de siempre');
    } finally { delete process.env.DYNAMIC_REAL_CHAPTERS; }
  });

  await check('RC8b sin enmascarar vacíos: un resultado que un capítulo NOMBRA pero no vincula sigue crítico; lo bloqueado no cambia', () => {
    const outs = [...ctx.ingles6.outcomes.map((o) => ({ id: o.id, text: o.text })), ...ctx.ingles6.competencies.map((c) => ({ id: c.id, text: c.text }))];
    const chs = CD.proposeStructureFromContext(ctx.ingles6).modules.flatMap((m) => m.chapters);
    eq(CD.transversalOutcomeIds(outs, chs), ['RA1', 'RA7', 'CO1'], 'Inglés: transversales = los que ningún capítulo vincula ni nombra');
    // RA5 («Reconocer vocabulario fundamental») sin vínculo, pero «Integración de vocabulario…» lo nombra: vínculo olvidado.
    const forgot = chs.map((c) => ({ ...c, outcomeIds: c.outcomeIds.filter((id) => id !== 'RA5') }));
    assert(!CD.transversalOutcomeIds(outs, forgot).includes('RA5'), 'RA5 olvidado NO se vuelve transversal (sigue A1 crítico)');
    // La generación de un curso ya bloqueado no depende del interruptor (los vínculos son datos guardados, no derivados).
    const AB = L('modules/academic-context/alignment-brief.js');
    let n = 0; const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const mid = uuid();
    const snap = SNAP.buildBlueprintSnapshotV2({ id: 1, title: 'x', finalExam: true, activityEngine: 'h5p', academicContext: AC.academicBlueprintContext(ctx.ingles6) },
      [{ id: mid, position: 0, title: 'M', objective: null, exam_enabled: true }],
      [{ id: uuid(), module_id: mid, position: 0, title: 'Saludos', objective: null, video_enabled: true, activity_enabled: true, outcome_ids: ['RA2'] }, { id: uuid(), module_id: mid, position: 1, title: 'Práctica', objective: null, video_enabled: false, activity_enabled: true, chapter_kind: 'practice' }]);
    const items = [{ type: 'application_activity', moduleId: mid, chapterId: snap.modules[0].chapters[1].id }, { type: 'final_exam', moduleId: null, chapterId: null }];
    const off = JSON.stringify(items.map((it) => AB.itemOutcomeIds(snap, it)));
    process.env.DYNAMIC_REAL_CHAPTERS = 'true';
    const on = JSON.stringify(items.map((it) => AB.itemOutcomeIds(snap, it)));
    delete process.env.DYNAMIC_REAL_CHAPTERS;
    eq(on, off, 'brief y huellas de un Blueprint congelado: iguales con y sin el interruptor');
  });

  await check('RC9 edad desde el grado escolar del documento (inferido, visible); sin grado, nada', () => {
    process.env.DYNAMIC_REAL_CHAPTERS = 'true';
    try {
      eq(CD.schoolGradeOf(ctx.ingles6), 6, 'Inglés: grado 6');
      const s6 = CD.suggestProfileFromContext(ctx.ingles6, null);
      eq([s6.profile.learner.ageGroup, s6.changes.find((c) => c.path === 'learner.ageGroup').source], ['children', 'inferred'], 'grado 6.º → niños (inferido)');
      for (const k of ['excel40', 'sst100', 'conta60', 'enf120']) eq(CD.suggestProfileFromContext(ctx[k], null).profile.learner.ageGroup, null, `${k}: sin grado escolar no se sugiere edad`);
      const fake = (subject, level, extra) => ({ ...ctx.ingles6, identity: { ...ctx.ingles6.identity, subjectName: { ...ctx.ingles6.identity.subjectName, value: subject }, educationLevel: { ...ctx.ingles6.identity.educationLevel, value: level } }, additionalInfo: { ...ctx.ingles6.additionalInfo, value: extra } });
      eq(CD.schoolGradeOf(fake('Matemáticas de sexto grado', { text: 'Básica secundaria', level: 'secondary' }, [])), 6, '«sexto grado»');
      eq(CD.schoolGradeOf(fake('Cuidado de heridas', { text: 'Técnico laboral', level: 'technical' }, ['Grado: 2', 'Úlceras por presión grado 2'])), null, 'sin contexto escolar no hay grado (úlceras grado 2)');
      eq(CD.schoolGradeOf(fake('Grado en Enfermería', { text: 'Universitario', level: 'university' }, [])), null, '«Grado en Enfermería» (título universitario)');
      eq(CD.schoolGradeOf(fake('Ciencias 7', { text: 'Educación básica', level: 'basic' }, ['Clasificación de quemaduras grado 3', 'Grado: Séptimo'])), 7, 'solo el campo «Grado:»');
      const keep = CD.suggestProfileFromContext(ctx.ingles6, { ...CD.suggestProfileFromContext(ctx.ingles6, null).profile, learner: { ...s6.profile.learner, ageGroup: 'teens' } });
      eq(keep.profile.learner.ageGroup, 'teens', 'lo que eligió el docente se respeta');
    } finally { delete process.env.DYNAMIC_REAL_CHAPTERS; }
    eq(CD.suggestProfileFromContext(ctx.ingles6, null).profile.learner.ageGroup, null, 'apagado: lo de siempre');
  });

  eq(netAttempts, [], 'ningún intento de red');
  const out = process.env.R80_REPORT;
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  for (const r of report) console.log(`     · ${r.key}: antes ${JSON.stringify(r.before || {})} → después ${JSON.stringify(r.after)}`);
  console.log(`\n${passes} ok · ${failures} fallas · red ${netAttempts.length} · USD 0`);
  process.exit(failures ? 1 : 0);
})();
