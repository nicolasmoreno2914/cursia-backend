#!/usr/bin/env node
/* eslint-disable */
// Motor pedagógico Fase 2 — el diseño de cada trabajo llega a SU generador.
// Check sin Jest contra el código COMPILADO en dist/ ("npm run build" antes). Sin red, sin
// proveedores, sin DB, sin gasto. Curso de prueba: «RCP Básico para Auxiliares de Enfermería»
// (scripts/fixtures/pedagogy) con los 5 enfoques.
//
//   G1  perfil → Blueprint                      G10 diseño → video interactivo (solo con video)
//   G2  Blueprint → Manifest                    G11 dos enfoques → prompts/configuraciones distintos
//   G3  Manifest → diseño del trabajo (brief)   G12 mismo enfoque + mismos datos → resultado determinista
//   G4  diseño → prompt de contenido            G13 sin perfil → comportamiento anterior (byte a byte)
//   G5  diseño → video (content_txt Videogen)   G14 las reglas técnicas/producto siguen mandando (+ traza)
//   G6  diseño → actividad (tipo + brief)       G15 el dry-run de generadores no llama proveedores
//   G7  diseño → evaluación                     G16 activar el perfil no aumenta el costo estimado
//   G8  diseño → retroalimentación              G17 los workers reales arman la configuración final
//   G9  diseño → escenario ramificado           G18 el Manifest sigue validando
//   COV cobertura: todo trabajo generable consume el diseño o dice por qué no
// La parte de prompts del NAVEGADOR (builders 44 + ejecutor 45) la prueban el harness del frontend
// (test-50-pedagogy-prompts.mjs) y el E2E v3 E6 (prompts reales capturados por el LLM falso).
//
// Usage: node scripts/check-pedagogy-generators.js [path/to/dist]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const distArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const REPO = path.resolve(__dirname, '..');
const distRoot = path.resolve(process.cwd(), distArg || 'dist');
const FIX = path.join(REPO, 'scripts/fixtures/pedagogy');

function loadDist(rel) {
  const abs = path.join(distRoot, rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`❌ No se pudo cargar el módulo compilado en ${abs}`);
    console.error(`   (¿corriste "npm run build" antes? — dist/ no se versiona)`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }
}

const P = loadDist('modules/pedagogy/index.js');
const mb = loadDist('modules/generation-manifests/generation-manifest-builder.js');
const RP = loadDist('workers/provider-real/real-providers.js');
const IW = loadDist('workers/dynamic-item-worker.js');
const PV3 = loadDist('modules/invalidation/plan-v3.js');
const RES = loadDist('modules/dynamic-packaging/artifact-resolver.js');
const SNAP = loadDist('modules/course-blueprints/blueprint-snapshot.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}\n      ${String((err && err.stack) || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}: esperado ${jb}, obtenido ${ja}`);
}

const RCP = JSON.parse(fs.readFileSync(path.join(FIX, 'rcp-course.json'), 'utf8'));
const PF = JSON.parse(fs.readFileSync(path.join(FIX, 'profiles.json'), 'utf8'));
const APPROACHES = ['competencias', 'problemas', 'experiencial', 'significativo', 'autodirigido'];
function profileOf(key) {
  const p = PF.profiles[key];
  return {
    pedagogyProfileVersion: 1, primaryApproach: p.primaryApproach, secondaryApproaches: p.secondaryApproaches,
    learner: p.learner || PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual',
  };
}
// Igual que el lock real: el diseño entra, la estructura del docente NO cambia (sin sugerencias).
function dry(key, extra = {}) {
  return P.runPedagogyDryRun({ structure: RCP, profile: key ? profileOf(key) : null, applyStructureAdjustments: false, ...extra });
}
const DR = Object.fromEntries(APPROACHES.map((a) => [a, dry(a)]));
const BASE = dry(null);
const briefOf = (dr, type, nth = 0) => dr.generators.filter((g) => g.type === type)[nth].brief;
const genRows = (dr, generator) => dr.generators.filter((g) => g.brief && g.brief.generator === generator);
const has = (text, needle, msg) => assert(String(text).includes(needle), `${msg}: falta «${needle.slice(0, 80)}»`);

(async () => {
  console.log('Motor pedagógico Fase 2 — diseño → generadores (dry-run, sin proveedores)');

  await check('G1 perfil → Blueprint: el lock congela course.pedagogy y el diseño de cada módulo y capítulo', () => {
    for (const a of APPROACHES) {
      const bp = DR[a].pedagogical.blueprint;
      eq(bp.course.pedagogy.approaches[0].id, a, `${a}: enfoque principal`);
      assert(bp.modules.every((m) => m.design && m.chapters.every((c) => c.design)), `${a}: diseño en todos los módulos y capítulos`);
    }
  });

  await check('G2 Blueprint → Manifest: cada trabajo que lo consume lleva su design; audio no', () => {
    for (const a of APPROACHES) {
      for (const it of DR[a].pedagogical.manifest.items) {
        const want = P.PEDAGOGY_GENERATOR_COVERAGE[it.type].consumes;
        eq(it.design !== undefined, want, `${a}: ${it.key} design`);
      }
    }
  });

  await check('G3 Manifest → diseño del trabajo: el brief de cada trabajo sale de SU design (valores = diseño efectivo del capítulo)', () => {
    for (const a of APPROACHES) {
      const dr = DR[a];
      const snap = dr.pedagogical.blueprint;
      for (const g of dr.generators) {
        if (!g.consumes) { eq(g.brief, null, `${a}: ${g.itemKey} sin brief`); continue; }
        assert(g.brief && g.brief.text && g.brief.directives.length >= 1, `${a}: ${g.itemKey} con brief`);
        const it = dr.pedagogical.manifest.items.find((i) => i.key === g.itemKey);
        const val = (target) => (g.brief.directives.find((d) => d.target === target) || {}).value;
        if (it.chapterId && g.type !== 'audiobook_chapter') {
          const eff = P.effectiveChapterDesign(snap, it.chapterId);
          if (g.type === 'content') eq([val('content.type'), val('content.depth'), val('scenarios.type')], [eff.contentType, eff.depth, eff.scenario.type], `${a}: ${g.itemKey}`);
          if (g.type === 'video') eq(val('video.style'), eff.video.style, `${a}: ${g.itemKey}`);
          if (g.type === 'video_interactions') eq([val('video.interactions'), val('feedback.mode')], [eff.video.interactions, eff.feedback.mode], `${a}: ${g.itemKey}`);
          if (g.type === 'activity') eq([val('activity.intent'), val('scenarios.type'), val('feedback.mode')], [eff.activity.intent, eff.scenario.type, eff.feedback.mode], `${a}: ${g.itemKey}`);
        }
        if (g.type === 'exam') eq(val('assessment.examStyle'), snap.course.pedagogy.assessment.examStyle, `${a}: ${g.itemKey}`);
        if (g.type === 'final_exam') eq(val('assessment.finalExamStyle'), snap.course.pedagogy.assessment.finalExamStyle, `${a}: ${g.itemKey}`);
      }
    }
  });

  await check('G4 diseño → prompt de contenido: secuencia, tipo de contenido, objetivos, profundidad y caso en el bloque del capítulo', () => {
    const b = briefOf(DR.problemas, 'content');
    has(b.text, P.PEDAGOGY_PROMPT_MARKER, 'marcador');
    has(b.text, 'Presenta primero el problema o caso y explica la teoría solo cuando el caso la necesita', 'ABP: problema antes que la teoría');
    has(b.text, '1.ª sección: Problema detonante', 'ABP: la secuencia abre con el problema');
    has(b.text, 'analizar situaciones, decidir y resolver problemas', 'objetivos ABP');
    has(briefOf(DR.competencias, 'content').text, 'guía de desempeño', 'competencias: guía de desempeño');
    has(briefOf(DR.significativo, 'content').text, 'Activar lo que ya sabes', 'significativo: conocimientos previos primero');
    has(briefOf(DR.autodirigido, 'content').text, 'Mis metas', 'autodirigido: metas');
    has(briefOf(DR.experiencial, 'content').text, 'Experiencia concreta', 'experiencial: experiencia primero');
    assert(!/\brol\b|apertura del módulo|cierre del módulo/i.test(b.text), 'el texto no imprime el rol (la huella de N2 no lo incluye)');
  });

  await check('G5 diseño → video: estilo del video en el content_txt real que recibe Videogen (cabecera, antes del capítulo)', () => {
    const item = (brief) => ({ blueprint: { course: { title: 'RCP Básico' }, chapter: { title: 'Cadena de supervivencia' } }, chapterNumber: 1, pedagogy: brief });
    const md = '# Capítulo 1\n\nTexto del capítulo.';
    const abp = IW.buildContentTxt(item(briefOf(DR.problemas, 'video')), md);
    has(abp, '[Indicación para el guion, no narrar] Estilo del video: planteamiento del caso', 'ABP: video que plantea el caso, marcado como indicación');
    assert(abp.indexOf('[Indicación para el guion') < abp.indexOf('Texto del capítulo'), 'la línea va antes del capítulo');
    has(IW.buildContentTxt(item(briefOf(DR.competencias, 'video')), md), 'demostración', 'competencias: demostración');
    has(IW.buildContentTxt(item(briefOf(DR.experiencial, 'video')), md), 'situación dramatizada', 'experiencial: dramatización');
    // Un brief de otro generador nunca entra al video.
    eq(IW.buildContentTxt(item(briefOf(DR.problemas, 'content')), md), IW.buildContentTxt(item(undefined), md), 'brief ajeno ignorado');
  });

  await check('G6 diseño → actividad: tipo H5P elegido por el diseño + intención/escenario en el brief de la actividad', () => {
    const acts = (a) => genRows(DR[a], 'activity').concat(genRows(DR[a], 'branching_scenario'));
    for (const a of APPROACHES) assert(acts(a).length === 9, `${a}: 9 actividades con brief`);
    has(acts('competencias').find((g) => g.brief.generator === 'activity').brief.text, 'aplicar el procedimiento', 'competencias: aplicar');
    has(acts('significativo').find((g) => g.brief.generator === 'activity').brief.text, 'relacionar conceptos', 'significativo: relacionar');
    has(acts('autodirigido').find((g) => g.brief.generator === 'activity').brief.text, 'autocomprobación', 'autodirigido: autocomprobación');
    const engine = P.runPedagogyDryRun({ structure: { ...RCP, course: { ...RCP.course, activityEngine: 'scorm' } }, profile: profileOf('problemas'), applyStructureAdjustments: false });
    const sc = genRows(engine, 'scorm_activity');
    assert(sc.length === 9 && sc[0].brief.text.includes('Las salas plantean decisiones'), 'motor SCORM: las salas reciben la intención');
    assert(sc[0].brief.overridden.some((o) => o.by === 'product' && /SCORM/.test(o.rule)), 'SCORM: la plantilla manda (traza)');
  });

  await check('G7 diseño → evaluación: estrategia y estilo en el brief de cada examen (módulo y final)', () => {
    has(briefOf(DR.problemas, 'exam').text, 'analizar y resolver el problema, no la memoria de conceptos', 'ABP: evaluar la solución');
    has(briefOf(DR.problemas, 'final_exam').text, 'integran el curso en problemas', 'ABP final integrador');
    has(briefOf(DR.competencias, 'exam').text, 'Evalúa el desempeño', 'competencias: desempeño');
    has(briefOf(DR.significativo, 'exam').text, 'relacionar conceptos', 'significativo: comprensión');
    has(briefOf(DR.autodirigido, 'exam').text, 'autocomprobación', 'autodirigido');
    has(briefOf(DR.experiencial, 'exam').text, 'parten de experiencias', 'experiencial');
  });

  await check('G8 diseño → retroalimentación: el modo de retroalimentación llega a actividades, video interactivo, experiencia y exámenes', () => {
    for (const a of APPROACHES) {
      const mode = DR[a].pedagogical.blueprint.course.pedagogy.assessment.feedbackMode;
      for (const t of ['video_interactions', 'experience', 'exam', 'final_exam']) {
        const b = briefOf(DR[a], t);
        eq((b.directives.find((d) => d.target === 'feedback.mode') || {}).target, 'feedback.mode', `${a}/${t}`);
      }
      const act = genRows(DR[a], 'activity')[0] || genRows(DR[a], 'branching_scenario')[0];
      assert(act.brief.directives.some((d) => d.target === 'feedback.mode'), `${a}: actividad con retroalimentación`);
      assert(mode, `${a}: modo`);
    }
    has(briefOf(DR.competencias, 'exam').text, 'qué criterio se cumplió', 'competencias: por criterios');
    has(briefOf(DR.problemas, 'exam').text, 'pistas', 'ABP: pistas guiadas');
  });

  await check('G9 diseño → escenario ramificado: recibe EXPLÍCITAMENTE la intención de toma de decisiones (o simulación)', () => {
    const bs = genRows(DR.problemas, 'branching_scenario');
    assert(bs.length >= 1, 'ABP tiene al menos un escenario ramificado');
    has(bs[0].brief.text, 'TOMA DE DECISIONES', 'ABP: decisión explícita');
    const comp = genRows(DR.competencias, 'branching_scenario');
    assert(comp.length >= 1 && comp[0].brief.text.includes('SIMULACIÓN'), 'competencias: el cierre del módulo simula');
    for (const a of APPROACHES) for (const g of genRows(DR[a], 'branching_scenario')) {
      eq(DR[a].pedagogical.manifest.items.find((i) => i.key === g.itemKey).h5pType, 'branchingscenario', `${a}: ${g.itemKey} es BS`);
    }
  });

  await check('G10 diseño → video interactivo SOLO cuando corresponde: sin video no hay preguntas de video y queda la traza del curso', () => {
    const off = JSON.parse(JSON.stringify(RCP));
    off.modules[0].chapters[1].videoEnabled = false;
    const dr = P.runPedagogyDryRun({ structure: off, profile: profileOf('problemas'), applyStructureAdjustments: false });
    const cid = off.modules[0].chapters[1].id;
    assert(!dr.generators.some((g) => g.itemKey === `video_interactions:${cid}` || g.itemKey === `video:${cid}`), 'sin video ni preguntas en ese capítulo');
    const tr = dr.courseOverrides.find((o) => o.chapterId === cid && o.target === 'video.style');
    assert(tr && tr.by === 'course', 'traza: el toggle del docente (curso) gana');
    const vi = genRows(dr, 'video_interactions');
    assert(vi.length === 8 && vi.every((g) => g.brief.text.includes('punto de decisión')), 'los demás capítulos sí: puntos de decisión');
  });

  await check('G11 dos enfoques distintos producen prompts/configuraciones distintos en CADA generador', () => {
    const gens = ['course_plan', 'course_intro', 'module_intro', 'content', 'experience', 'presentation', 'video', 'video_interactions', 'exam', 'final_exam'];
    for (const t of gens) {
      const texts = APPROACHES.map((a) => briefOf(DR[a], t).text);
      eq(new Set(texts).size, 5, `${t}: 5 textos distintos`);
    }
    const actTexts = APPROACHES.map((a) => DR[a].generators.filter((g) => g.type === 'activity').map((g) => g.brief.text).join('|'));
    eq(new Set(actTexts).size, 5, 'actividades: 5 conjuntos distintos');
  });

  await check('G12 mismo enfoque + mismos datos → briefs idénticos (determinista)', () => {
    for (const a of APPROACHES) {
      const again = dry(a);
      eq(again.generators.map((g) => g.brief && g.brief.textSha256), DR[a].generators.map((g) => g.brief && g.brief.textSha256), `${a}: sha de cada brief`);
    }
  });

  await check('G13 sin perfil pedagógico: sin design, sin brief, Videogen y Gamma byte a byte como antes', () => {
    assert(BASE.pedagogical === null && BASE.generators.length === 0, 'dry-run sin generadores');
    assert(BASE.baseline.manifest.items.every((i) => i.design === undefined), 'Manifest sin design');
    for (const it of BASE.baseline.manifest.items) eq(P.buildItemPedagogyBrief({ item: it, snapshot: BASE.baseline.blueprint }), null, `${it.key} sin brief`);
    const md = '# Cap\n\nTexto.';
    const plain = { blueprint: { course: { title: 'C' }, chapter: { title: 'T' } }, chapterNumber: 3 };
    eq(IW.buildContentTxt(plain, md), 'Capítulo 3: T\nCurso: C\n\n' + IW.bookMarkdownToNarrationText(md), 'content_txt de siempre');
    const g0 = RP.gammaGenerationBody({ chapterTitle: 'T', contentMarkdown: 'x', themeId: 't' });
    eq(RP.gammaGenerationBody({ chapterTitle: 'T', contentMarkdown: 'x', themeId: 't', pedagogyInstructions: null }), g0, 'Gamma sin pedagogía');
    eq(RP.gammaPedagogyInstructions({}), null, 'sin brief → null');
  });

  await check('G14 las reglas técnicas y de producto siguen mandando, con traza cuando el diseño pierde', () => {
    const order = P.OVERRIDE_PRIORITY;
    assert(order.technical < order.product && order.product < order.course && order.course < order.pedagogy, 'orden 1 técnica · 2 producto · 3 curso · 4 pedagogía');
    for (const a of APPROACHES) for (const g of DR[a].generators.filter((x) => x.brief && !['presentation', 'video'].includes(x.brief.generator))) {
      has(g.brief.text, 'Si alguna choca con esas reglas, mandan las reglas', `${a}: ${g.itemKey}`);
    }
    const ex = briefOf(DR.problemas, 'exam');
    assert(ex.overridden.some((o) => o.by === 'product' && /tipos, cantidades, niveles/.test(o.rule)), 'examen: el banco manda');
    const ct = briefOf(DR.problemas, 'content');
    assert(ct.overridden.some((o) => o.target === 'sequence' && o.by === 'product'), 'contenido: 7 pasos → 5 secciones (producto)');
    const vi = briefOf(DR.problemas, 'video_interactions');
    assert(vi.overridden.some((o) => o.by === 'product' && /cuántas preguntas/.test(o.rule)), 'video interactivo: el plan de puntos manda');
    // Recursos que piden fuentes chocan con la veracidad: nunca se piden.
    const sig = DR.problemas.rules.lists.resources;
    if (sig.includes('research_sources')) {
      assert(!ct.text.includes('Fuentes para investigar') && ct.overridden.some((o) => o.by === 'technical' && o.value === 'research_sources'), 'veracidad: no se piden fuentes');
    }
    // Tope de escenarios ramificados: la traza dice que el producto ganó.
    const capped = DR.problemas.generators.filter((g) => g.type === 'activity' && g.brief.overridden.some((o) => /Tope de escenarios ramificados/.test(o.rule)));
    assert(capped.length >= 1, 'tope de escenarios ramificados trazado');
    // Gamma: si la línea no cabe en el tope de la API, se omite entera (la regla técnica gana).
    const big = 'Enfoque didáctico: ' + 'x'.repeat(2000);
    const body = RP.gammaGenerationBody({ chapterTitle: 'T', contentMarkdown: 'x', themeId: 't', pedagogyInstructions: big });
    assert(!String(body.additionalInstructions).includes('xxxx') && body.additionalInstructions.length <= RP.GAMMA_ADDITIONAL_INSTRUCTIONS_MAX, 'Gamma: tope respetado');
    // H5P: el momento de la retroalimentación lo fija la plataforma.
    const fbAfter = DR.problemas.rules.targets['feedback.timing'] === 'after_attempt';
    if (fbAfter) assert(genRows(DR.problemas, 'activity')[0].brief.overridden.some((o) => o.target === 'feedback.timing' && o.by === 'technical'), 'momento de la retroalimentación (técnica)');
  });

  await check('G15 el plan de generadores del dry-run no llama proveedores: proceso aislado con TODA la red bloqueada', () => {
    const child = `
      const net = require('net'), dns = require('dns'), http = require('http'), https = require('https');
      let attempts = 0;
      const deny = (what) => function () { attempts++; throw new Error('RED BLOQUEADA: ' + what); };
      net.Socket.prototype.connect = deny('net.connect');
      net.connect = net.createConnection = deny('net.createConnection');
      dns.lookup = deny('dns.lookup'); dns.resolve = deny('dns.resolve');
      http.request = http.get = deny('http.request'); https.request = https.get = deny('https.request');
      globalThis.fetch = deny('fetch');
      const P = require(${JSON.stringify(path.join(distRoot, 'modules/pedagogy/index.js'))});
      const RCP = require(${JSON.stringify(path.join(FIX, 'rcp-course.json'))});
      const PF = require(${JSON.stringify(path.join(FIX, 'profiles.json'))});
      let briefs = 0;
      for (const k of ${JSON.stringify(APPROACHES)}) {
        const p = PF.profiles[k];
        const r = P.runPedagogyDryRun({ structure: RCP, profile: { pedagogyProfileVersion: 1, primaryApproach: p.primaryApproach, secondaryApproaches: p.secondaryApproaches, learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual' } });
        briefs += r.generators.filter((g) => g.brief).length;
        if (r.providersCalled !== 0 || r.spendUsd !== '0.00') throw new Error('gasto');
      }
      const loaded = Object.keys(require.cache).filter((f) => /[\\\\/](services|workers|provider-real|youtube|gamma|elevenlabs|openai|anthropic|axios|node-fetch)[\\\\/.]/i.test(f) && !/node_modules[\\\\/](typeorm|@nestjs)/.test(f));
      console.log(JSON.stringify({ attempts, loaded, briefs }));
    `;
    const res = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    assert(res.status === 0, `exit ${res.status}: ${res.stderr}`);
    const out = JSON.parse(res.stdout.trim().split('\n').pop());
    eq([out.attempts, out.loaded], [0, []], 'red y módulos de proveedor');
    assert(out.briefs > 5 * 50, `briefs armados (${out.briefs})`);
    // generator-directives.ts no importa nada de proveedores, DB ni workers.
    const src = fs.readFileSync(path.join(REPO, 'src/modules/pedagogy/generator-directives.ts'), 'utf8');
    for (const i of [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])) assert(!/typeorm|@nestjs|workers\/|axios|provider|youtube|gamma|openai|anthropic|elevenlabs/.test(i), `importa ${i}`);
  });

  await check('G16 activar el perfil NO aumenta el costo: mismos trabajos, mismas operaciones de proveedor, misma estimación', () => {
    for (const a of APPROACHES) {
      const dr = DR[a];
      eq(dr.pedagogical.manifest.totals, dr.baseline.manifest.totals, `${a}: mismos trabajos`);
      eq(dr.pedagogical.providers.byProvider, dr.baseline.providers.byProvider, `${a}: mismas operaciones`);
      eq(dr.pedagogical.providers.estimateUsd, dr.baseline.providers.estimateUsd, `${a}: misma estimación`);
      eq(dr.diff.itemsAdded.concat(dr.diff.itemsRemoved), [], `${a}: sin trabajos nuevos`);
    }
    // Gamma: la línea no cambia la cantidad de diapositivas ni el formato (el costo de Gamma es por diapositiva).
    const pres = briefOf(DR.problemas, 'presentation');
    const with_ = RP.gammaGenerationBody({ chapterTitle: 'T', contentMarkdown: 'x', themeId: 't', pedagogyInstructions: pres.text });
    const without = RP.gammaGenerationBody({ chapterTitle: 'T', contentMarkdown: 'x', themeId: 't' });
    eq([with_.numCards, with_.textOptions, with_.format], [without.numCards, without.textOptions, without.format], 'Gamma: mismas diapositivas');
    // Tamaño acotado de cada bloque (el costo por token de entrada es marginal; el harness del frontend lo mide en el prompt final).
    const max = Math.max(...APPROACHES.flatMap((a) => DR[a].generators.filter((g) => g.brief).map((g) => g.brief.text.length)));
    assert(max <= 1600, `bloque más largo ${max} caracteres (≤ 1600)`);
    console.log(`      (bloque pedagógico más largo: ${max} caracteres)`);
  });

  await check('G17 los workers reales arman la configuración final con el brief (Gamma y Videogen)', () => {
    for (const a of APPROACHES) {
      const pres = briefOf(DR[a], 'presentation');
      const body = RP.gammaGenerationBody({ chapterTitle: 'T', contentMarkdown: 'x', themeId: 't', pedagogyInstructions: RP.gammaPedagogyInstructions({ pedagogy: pres }) });
      assert(String(body.additionalInstructions).endsWith(pres.text), `${a}: Gamma con el enfoque al final`);
      assert(String(body.additionalInstructions).startsWith('La diapositiva 1 es la portada'), `${a}: las reglas de siempre primero`);
      eq(RP.gammaPedagogyInstructions({ pedagogy: briefOf(DR[a], 'video') }), null, `${a}: el brief del video no va a Gamma`);
    }
    has(RP.gammaGenerationBody({ chapterTitle: 'T', contentMarkdown: 'x', themeId: 't', pedagogyInstructions: briefOf(DR.problemas, 'presentation').text }).additionalInstructions, 'Orden de las diapositivas: Problema detonante', 'ABP: diapositivas que abren con el problema');
  });

  await check('G18 el Manifest sigue validando (5 enfoques, motor h5p y scorm, H5P v1 y v2)', () => {
    for (const a of APPROACHES) eq(DR[a].pedagogical.manifestErrors, [], `${a}`);
    for (const rules of [1, 2]) for (const engine of ['h5p', 'scorm']) {
      const dr = P.runPedagogyDryRun({ structure: { ...RCP, course: { ...RCP.course, activityEngine: engine } }, profile: profileOf('competencias'), activityTypeRules: rules, applyStructureAdjustments: false });
      eq(dr.pedagogical.manifestErrors, [], `reglas ${rules} / ${engine}`);
      if (rules === 1 && engine === 'h5p') {
        assert(!dr.generators.some((g) => g.brief && g.brief.generator === 'branching_scenario'), 'H5P v1: sin escenarios ramificados');
        assert(dr.generators.some((g) => g.brief && g.brief.overridden.some((o) => o.value === 'branchingscenario' && o.by === 'product')), 'H5P v1: traza del tipo no disponible');
      }
    }
  });

  await check('Invalidación: un reorden regenera SOLO el trabajo cuyo brief cambió por el rol (ningún proveedor pagado, contenido reusado)', () => {
    const rules = P.deriveDesignRules(profileOf('competencias'));
    const bpOf = (st) => P.applyPedagogyToSnapshot(P.snapshotFromStructure(st), rules);
    const manOf = (bp, n, rules = 2) => mb.buildGenerationManifestV3(bp, { courseId: bp.course.id, blueprintId: n, blueprintNumber: n, blueprintSha256: SNAP.snapshotSha256V2(bp) }, { activityTypeRules: rules });
    const re = JSON.parse(JSON.stringify(RCP));
    re.modules[0].chapters.reverse();
    const bpA = bpOf(RCP), bpB = bpOf(re);
    const mA = manOf(bpA, 1), mB = manOf(bpB, 2);
    const items = mA.items.map((it) => ({
      itemKey: it.key, itemRunId: `A#${it.key}`, status: 'completed', artifactIds: RES.requiredArtifactTypesV3(it.type, it.variant).map((r) => `A|${it.key}|${r}`),
      artifactStatus: 'ready', inputFingerprint: null, outputIdentity: `out/A/${it.key}`,
      ...(it.type === 'video_interactions' ? { consumedVideoIdentity: `out/A/video:${it.chapterId}` } : {}),
    }));
    const plan = PV3.computeInvalidationPlanV3({ from: { blueprint: bpA, manifest: mA, items }, to: { blueprint: bpB, manifest: mB } });
    const fresh = plan.actions.filter((a) => ['REGENERATE', 'GENERATE', 'STALE_NO_AUTO'].includes(a.action));
    const first = '8a0d1f00-0000-4000-8000-000000000011', last = '8a0d1f00-0000-4000-8000-000000000013';
    eq(fresh.map((a) => a.itemKey).sort(), [`activity:${first}`, `activity:${last}`].sort(), 'solo las 2 actividades cuyo rol cambió (viejo y nuevo cierre)');
    assert(fresh.every((a) => a.reasons.some((r) => r === 'pedagogy_role_design_changed' || r === 'activity_type_changed')), `motivos: ${JSON.stringify(fresh.map((a) => a.reasons))}`);
    assert(!fresh.some((a) => ['content', 'presentation', 'video', 'audiobook_chapter', 'experience'].includes(a.type)), `nada de contenido ni proveedores pagados: ${fresh.map((a) => a.itemKey + '=' + a.action).join(', ')}`);
    // H5P v1 (el tipo no cambia con el rol): el motivo es la indicación pedagógica que cambió.
    const m1A = manOf(bpA, 1, 1), m1B = manOf(bpB, 2, 1);
    const p1 = PV3.computeInvalidationPlanV3({ from: { blueprint: bpA, manifest: m1A, items: m1A.items.map((it) => ({ ...items.find((x) => x.itemKey === it.key) })) }, to: { blueprint: bpB, manifest: m1B } });
    const f1 = p1.actions.filter((a) => ['REGENERATE', 'GENERATE', 'STALE_NO_AUTO'].includes(a.action));
    eq(f1.map((a) => [a.itemKey, a.reasons]).sort(), [[`activity:${first}`, ['pedagogy_role_design_changed']], [`activity:${last}`, ['pedagogy_role_design_changed']]].sort(), 'H5P v1: solo las 2 actividades, por el diseño pedagógico');
    // Sin variación por rol (perfil cuyo diseño no depende de la posición): el reorden no regenera nada por pedagogía.
    const flat = P.deriveDesignRules(profileOf('significativo'));
    if (Object.keys(flat.roleTargets).length === 0) {
      const a2 = P.applyPedagogyToSnapshot(P.snapshotFromStructure(RCP), flat), b2 = P.applyPedagogyToSnapshot(P.snapshotFromStructure(re), flat);
      const p2 = PV3.computeInvalidationPlanV3({ from: { blueprint: a2, manifest: manOf(a2, 1), items: manOf(a2, 1).items.map((it) => ({ ...items.find((x) => x.itemKey === it.key) })) }, to: { blueprint: b2, manifest: manOf(b2, 2) } });
      assert(!p2.actions.some((a) => a.reasons.includes('pedagogy_role_design_changed')), 'sin variación por rol no hay regeneración pedagógica');
    }
  });

  await check('Huellas: BRIEF_ROLE_SENSITIVE_FIELDS cubre todo lo que el rol puede cambiar en un brief (si un brief cambia por el rol, su trabajo tiene delta)', () => {
    const V = loadDist('modules/pedagogy/vocabulary.js');
    const base = P.deriveDesignRules(profileOf('competencias'));
    const last = '8a0d1f00-0000-4000-8000-000000000013';
    const briefs = (rules) => {
      const bp = P.applyPedagogyToSnapshot(P.snapshotFromStructure(RCP), rules);
      const m = mb.buildGenerationManifestV3(bp, { courseId: bp.course.id, blueprintId: 1, blueprintNumber: 1, blueprintSha256: SNAP.snapshotSha256V2(bp) }, { activityTypeRules: 1 });
      const out = {};
      for (const it of m.items) if (it.chapterId === last) { const b = P.buildItemPedagogyBrief({ item: it, snapshot: bp, activityTypeRules: 1 }); if (b) out[it.type] = b.text; }
      return { out, bp };
    };
    const ref = briefs({ ...base, roleTargets: {} }).out;
    // Toda meta que el diseño por rol puede variar (CHAPTER_TARGET_FIELDS de pedagogical-blueprint.ts), con cada valor.
    const targets = ['objectives.style', 'content.type', 'video.style', 'video.interactions', 'activity.intent', 'scenarios.type', 'feedback.mode', 'feedback.timing'];
    const missed = [];
    let probes = 0;
    for (const t of targets) for (const v of V.ENUM_TARGETS[t]) {
      const res = briefs({ ...base, roleTargets: { module_closing: { [t]: v } } });
      probes++;
      const delta = Object.keys(P.roleDesignDelta(res.bp, last));
      for (const k of Object.keys(res.out)) if (res.out[k] !== ref[k] && !delta.includes(k)) missed.push(`${t}=${v} → ${k}`);
    }
    eq(missed, [], 'briefs que cambian por el rol sin delta en la huella');
    assert(probes >= 35, `sondas ${probes}`);
  });

  await check('COV todo trabajo generable consume el diseño o declara por qué no (sin casos ocultos)', () => {
    // Manifest con TODO encendido: examen final, video y actividad en todos, motor h5p (y scorm aparte).
    const kinds = new Set();
    for (const engine of ['h5p', 'scorm']) {
      // Fase 2: una Actividad de Aplicación en el primer capítulo (el Manifest emite application_activity).
      const withApp = JSON.parse(JSON.stringify(RCP));
      withApp.modules[0].chapters[0].applicationMinutes = 60;
      const dr = P.runPedagogyDryRun({ structure: { ...withApp, course: { ...withApp.course, activityEngine: engine, finalExam: true, reviewCards: true } }, profile: profileOf('competencias'), applyStructureAdjustments: false });
      for (const it of dr.pedagogical.manifest.items) kinds.add(it.type);
      for (const g of dr.generators) {
        const cov = P.PEDAGOGY_GENERATOR_COVERAGE[g.type];
        assert(cov, `${g.type} sin entrada de cobertura`);
        eq(!!g.brief, cov.consumes, `${g.itemKey}: brief ⇔ consume`);
        if (!cov.consumes) assert(cov.reason.length > 20, `${g.type}: motivo explícito`);
      }
    }
    const registered = Object.keys(P.PEDAGOGY_GENERATOR_COVERAGE).sort();
    eq([...kinds].sort(), registered, 'el registro de cobertura = los tipos que emite el Manifest v3');
    eq(P.missingGeneratorTexts(), [], 'todo valor del vocabulario tiene texto para su generador');
    const no = registered.filter((t) => !P.PEDAGOGY_GENERATOR_COVERAGE[t].consumes);
    console.log(`      Trabajos que NO consumen diseño (${no.length}): ${no.map((t) => `${t} — ${P.PEDAGOGY_GENERATOR_COVERAGE[t].reason}`).join(' | ')}`);
  });

  await check('Un enfoque nuevo (solo datos) produce briefs sin tocar generator-directives.ts', () => {
    const flipped = {
      ...JSON.parse(JSON.stringify(P.APPROACH_SIGNIFICATIVO)),
      id: 'aula_invertida', label: 'Aula invertida', shortLabel: 'Invertida', summary: 'El estudiante estudia antes y el curso se usa para practicar.',
      sequence: ['learning_goals', 'modular_content', 'self_assessment', 'guided_practice', 'application', 'reflection_plan'], signatureSteps: [], objectiveVerbs: ['preparar', 'aplicar'],
    };
    flipped.votes = { ...flipped.votes, 'activity.intent': { value: 'apply', weight: 0.9, ruleId: 'inv.activity.apply', rationale: 'Práctica aplicada.' } };
    const reg = P.defaultApproachRegistry().with(flipped);
    const dr = P.runPedagogyDryRun({ structure: RCP, profile: { ...profileOf('significativo'), primaryApproach: 'aula_invertida', secondaryApproaches: [] }, registry: reg, applyStructureAdjustments: false });
    has(briefOf(dr, 'course_intro').text, 'El estudiante estudia antes y el curso se usa para practicar.', 'la bienvenida explica el enfoque nuevo (sin su nombre técnico)');
    has(briefOf(dr, 'course_plan').text, 'Aula invertida', 'el plan del curso recibe el enfoque nuevo');
    has(briefOf(dr, 'content').text, '1.ª sección: Mis metas', 'la secuencia propia llega al contenido');
    const src = fs.readFileSync(path.join(REPO, 'src/modules/pedagogy/generator-directives.ts'), 'utf8');
    for (const id of APPROACHES) assert(!new RegExp(`['"\`]${id}['"\`]`).test(src), `generator-directives.ts menciona '${id}'`);
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} check-pedagogy-generators: ${passed} OK, ${failed} fallidas`);
  process.exit(failed === 0 ? 0 : 1);
})();
