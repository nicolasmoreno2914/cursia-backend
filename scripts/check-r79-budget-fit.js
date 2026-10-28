#!/usr/bin/env node
/* eslint-disable no-console */
// r79 · «Ajustar al presupuesto» (src/modules/course-design/budget-fit.ts) — función pura sobre el mismo dry-run.
//
//   BF1   cabe holgado (60 h / USD 200): el diseño elegido es el de siempre (mismas horas, misma huella)
//   BF2   60 h / USD 35: «No cabe» con dos alternativas aplicables con un clic (horas que alcanzan; presupuesto mínimo)
//   BF3   las alternativas, aplicadas, CABEN (re-ajuste con su adjust)
//   BF4   20 h / USD 10: nunca «Cabe»; mínimo realista explicado
//   BF5   (e) 60 h / USD 2: nunca «Cabe»; mínimo realista ≥ piso de la estructura; factores
//   BF6   (d) factores del mínimo suman el mínimo (±1 %) y salen del estimador (tipos de item)
//   BF7   (a) «No cabe» solo con el espacio agotado: se probaron TODAS las combinaciones válidas (tope mínimo, menos video,
//         sin ejercicios guiados, aplicación primero)
//   BF8   (b) ningún candidato pierde un capítulo de contenido obligatorio (los del curso y el mínimo del documento)
//   BF9   (c) una Actividad más larga que en el diseño sin presupuesto tiene un nivel con más trabajo especificado en el
//         generador (ejercicios / ejemplos de EXERCISES_BY_MINUTES; pisos de la práctica guiada), nunca solo minutos
//   BF10  microcurrículo con 6 contenidos y presupuesto chico: «Imposible» por el documento; los 6 siguen ahí
//   BF11  garantía 2: la proporción de Actividades de Aplicación no supera la habitual del enfoque (ni la de base)
//   BF12  D4: cada módulo que tenía video conserva al menos uno; nunca 0 videos
//   BF13  palanca audiovisual bloqueada (docente / documento): se respeta
//   BF14  pines del docente (video y Actividad fijados) se respetan en el elegido
//   BF15  4 h por capítulo como máximo en todo diseño que se muestra
//   BF16  margen D1: esperado × 1,10 frente al presupuesto (justo abajo no cabe; justo arriba cabe); BUDGET_FIT_MARGIN
//   BF17  interruptor: solo DYNAMIC_BUDGET_FIT === 'true'
//   BF18  perfil: productionBudgetUsd 1–5000 (2 decimales) y maxContentChaptersPerModule 1–5; ausentes = bytes de siempre
//   BF19  huellas: sin tope la huella de la propuesta es la de siempre; con tope cambia; distributionOnly = misma distribución
//   BF20  enfoque de profundidad: se explora «aplicación primero» y el elegido sigue siendo válido
//   BF21  determinista (dos corridas = mismo JSON)
//   BF22  Gamma: precio sin verificar → «estimación provisional (precio de Gamma sin verificar)»; verificado → no
//   BF23  condición 7: el resultado no autoriza nada (sin campos de autorización; dryRun, 0 proveedores)
//   BF24  rendimiento: curso L (8 × 2) a 100 h en < 6 s; red bloqueada (0 intentos)
//   BF25  cursos S/M/L × 20/60/100 h × 3 presupuestos: el estado es coherente con el costo (cabe ⇔ esperado×1,1 ≤ USD)
//
// Uso: node scripts/check-r79-budget-fit.js [path/to/dist]   (después de npm run build)
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
const P = require(path.join(distRoot, 'modules/pedagogy/index.js'));
const F = require(path.join(distRoot, 'modules/course-design/budget-fit.js'));
const AA = require(path.join(distRoot, 'modules/course-shell/application-activity.js'));
const GP = require(path.join(distRoot, 'modules/course-shell/guided-practice.js'));
const GPT = require(path.join(distRoot, 'modules/study-time/guided-practice-tiers.js'));
const PF = require('./fixtures/pedagogy/profiles.json');

let passes = 0;
let failures = 0;
const failed = [];
function check(name, fn) {
  try {
    fn();
    passes++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures++;
    failed.push(name);
    console.log(`  ❌ ${name}\n      ${(err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err)}`);
  }
}
function assert(c, msg) { if (!c) throw new Error(msg); }

const clone = (o) => JSON.parse(JSON.stringify(o));
const TOPICS = ['Identificación de peligros', 'Evaluación de riesgos', 'Controles de ingeniería', 'Elementos de protección', 'Investigación de incidentes', 'Plan de emergencias', 'Indicadores de seguridad', 'Cultura preventiva'];
function course(mods, chs, opts = {}) {
  return {
    course: { title: 'Seguridad y salud en el trabajo (sintético)', finalExam: true, activityEngine: 'h5p' },
    modules: Array.from({ length: mods }, (_, i) => ({
      id: `m${i + 1}`, title: `${TOPICS[i % TOPICS.length]}`, objective: 'Aplicar procedimientos de prevención en planta', examEnabled: true,
      chapters: Array.from({ length: chs }, (_, j) => ({ id: `m${i + 1}c${j + 1}`, title: `${TOPICS[i % TOPICS.length]}: caso ${j + 1} de análisis en planta`, objective: 'Analizar riesgos y proponer controles', ...(opts.chapter ? opts.chapter(i, j) : {}) })),
    })),
  };
}
const profile = (h, approach = 'competencias', dp = {}) => ({
  pedagogyProfileVersion: 1, primaryApproach: PF.profiles[approach].primaryApproach, secondaryApproaches: PF.profiles[approach].secondaryApproaches,
  learner: PF.learner, learningOutcomes: PF.outcomes, learningModes: [], experienceTypes: [], assessmentMethods: [], principles: [], origin: 'manual',
  targetHours: h, designPreferences: { audiovisual: 'recommended', ...dp },
});
const LEVERS = { audiovisual: { base: 'recommended', locked: false }, guidedPractice: { base: 'auto', locked: false }, emphasis: { base: 'balanced', locked: false } };
const fit = (structure, h, usd, extra = {}) => F.fitDesignToBudget({ base: { structure, profile: profile(h, extra.approach, extra.dp), activityTypeRules: 2, ...(extra.base || {}) }, budgetUsd: usd, levers: extra.levers || LEVERS, ...(extra.margin !== undefined ? { margin: extra.margin } : {}) });
const designsOf = (r) => [r.chosen, ...r.alternatives.map((a) => a.design)].filter(Boolean);
/** Corre el dry-run del diseño mostrado (mismas palancas) para mirar sus capítulos. */
const rerun = (structure, d, extra = {}) => {
  const p = profile(d.targetHours, extra.approach, {});
  p.designPreferences = { audiovisual: d.preferences.audiovisual, ...(d.preferences.guidedPractice === 'none' ? { guidedPractice: 'none' } : {}), ...(d.preferences.emphasis !== 'balanced' ? { emphasis: d.preferences.emphasis } : {}), ...(d.preferences.maxContentChaptersPerModule !== null ? { maxContentChaptersPerModule: d.preferences.maxContentChaptersPerModule } : {}) };
  return P.runPedagogyDryRun({ structure, profile: p, activityTypeRules: 2, ...(extra.base || {}) }).distribution;
};
const S = () => course(3, 2);
const M = () => course(6, 1);
const L = () => course(8, 2);

console.log('r79 · Ajustar al presupuesto');

const rGenerous = fit(M(), 60, 200);
check('BF1 cabe holgado (60 h / USD 200): el elegido es el diseño de siempre (misma huella que sin presupuesto)', () => {
  assert(rGenerous.status === 'fits', `status ${rGenerous.status}`);
  const plain = P.runPedagogyDryRun({ structure: M(), profile: profile(60), activityTypeRules: 2 }).distribution;
  assert(rGenerous.chosen.proposalSha256 === plain.proposalSha256, 'la huella del elegido difiere de la de siempre');
  assert(rGenerous.chosen.preferences.maxContentChaptersPerModule === null, 'no debería poner tope');
  assert(rGenerous.reasons.some((x) => /mismo diseño/.test(x)), 'falta la razón «mismo diseño»');
});

const r35 = fit(M(), 60, 35);
check('BF2 60 h / USD 35: «No cabe» con las dos alternativas (horas que alcanzan · presupuesto mínimo)', () => {
  assert(r35.status === 'does_not_fit', `status ${r35.status}`);
  const kinds = r35.alternatives.map((a) => a.kind);
  assert(kinds.includes('hours_at_budget') && kinds.includes('budget_for_hours'), `alternativas ${kinds}`);
  const h = r35.alternatives.find((a) => a.kind === 'hours_at_budget');
  assert(h.adjust.targetHours < 60 && h.adjust.productionBudgetUsd === 35, JSON.stringify(h.adjust));
  const b = r35.alternatives.find((a) => a.kind === 'budget_for_hours');
  assert(b.adjust.productionBudgetUsd > 35 && Number.isInteger(b.adjust.productionBudgetUsd), JSON.stringify(b.adjust));
  assert(r35.chosen === null, 'no hay elegido si no cabe');
});

check('BF3 cada alternativa, aplicada con su adjust, CABE', () => {
  for (const a of r35.alternatives) {
    const r = fit(M(), a.adjust.targetHours || 60, a.adjust.productionBudgetUsd);
    assert(r.status === 'fits', `${a.kind} → ${r.status}`);
  }
});

const r10 = fit(S(), 20, 10);
check('BF4 20 h / USD 10: nunca «Cabe»; mínimo realista explicado', () => {
  assert(r10.status !== 'fits', 'no puede caber');
  assert(r10.minimumExplanation && r10.minimumExplanation.minimumUsd > 10, JSON.stringify(r10.minimumExplanation && r10.minimumExplanation.minimumUsd));
});

const r2 = fit(M(), 60, 2);
check('BF5 (e) 60 h / USD 2: nunca «Cabe»; mínimo realista ≥ piso de la estructura', () => {
  assert(r2.status !== 'fits', r2.status);
  const min = r2.minimumExplanation;
  assert(min && min.basis === 'target_hours' && min.targetHours === 60, JSON.stringify(min && { basis: min.basis, h: min.targetHours }));
  const floor = r2.alternatives.find((a) => a.kind === 'minimum_budget');
  assert(floor && min.minimumUsd >= floor.adjust.productionBudgetUsd, 'el mínimo de las horas no puede ser menor que el de la estructura');
  assert(min.minimumUsd >= 20, `mínimo irreal: ${min.minimumUsd}`);
});

check('BF6 (d) los factores del mínimo suman el mínimo (±1 %) y salen de los tipos de item del estimador', () => {
  for (const r of [r35, r10, r2]) {
    const m = r.minimumExplanation;
    const sum = m.factors.reduce((n, f) => n + f.usd, 0);
    assert(Math.abs(sum - m.minimumUsd) <= Math.max(0.01 * m.minimumUsd, 1), `suma ${sum} vs mínimo ${m.minimumUsd}`);
    assert(Math.abs(m.expectedUsd * (1 + m.margin) - sum) <= 0.06, `esperado×(1+m) ${m.expectedUsd * (1 + m.margin)} ≠ suma ${sum}`);
    assert(m.factors.find((f) => f.key === 'content' && f.count > 0 && f.itemTypes.includes('presentation') && f.itemTypes.includes('audiobook_chapter')), 'falta el factor de contenidos');
    assert(m.factors.find((f) => f.key === 'assessment'), 'falta el factor de evaluaciones');
    assert(m.factors.find((f) => f.key === 'margin'), 'falta el margen');
  }
});

check('BF7 (a) «No cabe» solo después de probar todas las combinaciones válidas (incluidas las más económicas)', () => {
  for (const r of [r35, r2, r10]) {
    const s = r.searchSpace;
    const minCap = Math.max(...[1]);
    assert(s.audiovisual.includes('less') && s.guidedPractice.includes('none'), JSON.stringify(s));
    assert(s.caps.includes(null) && (s.caps.length === 1 || s.caps.includes(minCap)), `topes ${JSON.stringify(s.caps)}`);
    const full = s.caps.length * s.audiovisual.length * s.guidedPractice.length * s.emphasis.length;
    assert(s.candidates === full, `se evaluaron ${s.candidates} de ${full} combinaciones`);
  }
  // Y si existe una combinación más económica que entra, el resultado es «Cabe».
  const cheap = r35.alternatives.find((a) => a.kind === 'budget_for_hours');
  const rr = fit(M(), 60, cheap.adjust.productionBudgetUsd);
  assert(rr.status === 'fits' && Number(rr.chosen.cost.expected) * 1.1 <= cheap.adjust.productionBudgetUsd + 1e-9, 'con el mínimo informado debería caber');
});

check('BF8 (b) ningún diseño mostrado pierde un capítulo de contenido del curso (cada concepto conserva su teoría)', () => {
  for (const [st, r] of [[M, r35], [M, r2], [S, r10], [M, rGenerous]]) {
    const ids = st().modules.flatMap((m) => m.chapters.map((c) => c.id));
    for (const d of designsOf(r)) {
      const dist = rerun(st(), d);
      const content = new Set(dist.modules.flatMap((m) => m.chapters.filter((c) => c.kind === 'content').map((c) => c.id)));
      for (const id of ids) assert(content.has(id), `falta el capítulo de contenido ${id} en un diseño de ${d.targetHours} h`);
    }
  }
});

check('BF9 (c) más minutos ⇒ más trabajo especificado en el generador (no solo minutos)', () => {
  const tiers = Object.keys(AA.EXERCISES_BY_MINUTES).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < tiers.length; i++) {
    const a = AA.EXERCISES_BY_MINUTES[tiers[i - 1]];
    const b = AA.EXERCISES_BY_MINUTES[tiers[i]];
    assert(b.min >= a.min && b.max >= a.max && b.examplesMax >= a.examplesMax && (b.min > a.min || b.max > a.max || b.examplesMax > a.examplesMax),
      `Actividad de Aplicación ${tiers[i]} min no especifica más trabajo que ${tiers[i - 1]} min`);
  }
  const gTiers = [...GPT.GUIDED_PRACTICE_TIERS];
  const work = (m) => GPT.guidedPracticeExercisePlan(m).reduce((n, e) => n + GP.GUIDED_PRACTICE_FLOORS[e.minutes].tasksMin * 1000 + GP.GUIDED_PRACTICE_FLOORS[e.minutes].modelAnswerMin, 0);
  for (let i = 1; i < gTiers.length; i++) assert(work(gTiers[i]) > work(gTiers[i - 1]), `práctica guiada ${gTiers[i]} min sin más trabajo especificado`);
  // En cada diseño mostrado: una Actividad que sube de nivel respecto del diseño sin presupuesto (mismo capítulo) va a un
  // nivel con más trabajo especificado; y todo nivel usado existe en la especificación del generador.
  const spec = (t) => { const x = AA.EXERCISES_BY_MINUTES[t]; return x ? x.min * 100 + x.max * 10 + x.examplesMax : -1; };
  for (const [st, r] of [[M, r35], [M, rGenerous], [L, fit(L(), 100, 80)]]) {
    const refD = P.runPedagogyDryRun({ structure: st(), profile: profile(r.targetHours), activityTypeRules: 2 }).distribution;
    const refTier = new Map(refD.modules.flatMap((m) => m.chapters).map((c) => [c.id, c.applicationMinutes]));
    for (const d of designsOf(r)) {
      const dist = rerun(st(), d);
      for (const c of dist.modules.flatMap((m) => m.chapters)) {
        if (!c.applicationMinutes) continue;
        assert(spec(c.applicationMinutes) > 0, `nivel ${c.applicationMinutes} sin especificación`);
        const was = refTier.get(c.id);
        if (was && c.applicationMinutes > was && d.targetHours === r.targetHours) assert(spec(c.applicationMinutes) > spec(was), `${c.id}: ${was} → ${c.applicationMinutes} min sin más trabajo`);
      }
    }
  }
});

// Microcurrículo sintético: 2 módulos × 3 contenidos (6 contenidos obligatorios), forma fija por el documento.
const DOC6 = { sources: { chapters: 'REQ-1' }, modulesFixed: 2, contentChaptersPerModule: { min: 3, max: 3 }, noContentAdditions: true };
const doc6 = () => course(2, 3);
const rDoc = fit(doc6(), 30, 12, { base: { requirementConstraints: DOC6 } });
check('BF10 microcurrículo con 6 contenidos y USD 12: «Imposible» por el documento; los 6 contenidos siguen', () => {
  assert(rDoc.status === 'impossible' && rDoc.reason === 'document_requirements', `${rDoc.status} ${rDoc.reason}`);
  assert(/exige 6 capítulos de contenido/.test(rDoc.message), rDoc.message);
  for (const d of designsOf(rDoc)) assert(d.structure.contentChapters >= 6, `un diseño con ${d.structure.contentChapters} contenidos`);
  const m = rDoc.minimumExplanation;
  assert(m && m.factors.find((f) => f.key === 'content').count >= 6, 'el mínimo no cuenta los 6 contenidos');
});

check('BF11 garantía 2: la proporción de Actividades de Aplicación no supera la habitual del enfoque (ni la de base)', () => {
  for (const [st, r] of [[M, r35], [M, rGenerous], [S, fit(S(), 20, 40)], [L, fit(L(), 100, 80)]]) {
    const refD = P.runPedagogyDryRun({ structure: st(), profile: profile(r.targetHours), activityTypeRules: 2 }).distribution;
    for (const d of designsOf(r)) {
      if (d.targetHours !== r.targetHours) continue;
      const pol = rerun(st(), d).policy.maxApplicationShare;
      assert(d.quality.applicationShare <= Math.max(pol, refD.applicationShare) + 1e-9, `proporción ${d.quality.applicationShare} > ${Math.max(pol, refD.applicationShare)}`);
    }
  }
});

check('BF12 D4: cada módulo con video en el diseño de base conserva al menos uno; nunca 0 videos', () => {
  for (const [st, r] of [[M, r35], [S, fit(S(), 20, 26)], [L, fit(L(), 100, 80)]]) {
    for (const d of designsOf(r)) {
      if (d.kind === 'minimum_budget') continue;
      assert(d.structure.videoChapters >= d.structure.modules, `${d.structure.videoChapters} videos para ${d.structure.modules} módulos`);
    }
  }
});

check('BF13 palanca audiovisual bloqueada (docente o documento): el ajuste no la toca', () => {
  const r = fit(M(), 60, 70, { levers: { ...LEVERS, audiovisual: { base: 'more', locked: true } }, dp: { audiovisual: 'more' } });
  assert(r.searchSpace.audiovisual.length === 1 && r.searchSpace.audiovisual[0] === 'more', JSON.stringify(r.searchSpace.audiovisual));
  for (const d of designsOf(r)) assert(d.preferences.audiovisual === 'more', d.preferences.audiovisual);
});

check('BF14 los pines del docente (video y Actividad de Aplicación fijados) se respetan', () => {
  const pins = { m1c1: { video: false }, m2c1: { application: 60 } };
  const r = fit(M(), 60, 200, { base: { designPins: pins } });
  assert(r.status === 'fits', r.status);
  const dist = rerun(M(), r.chosen, { base: { designPins: pins } });
  const c = dist.modules.flatMap((m) => m.chapters);
  assert(c.find((x) => x.id === 'm1c1').videoEnabled === false, 'video fijado no respetado');
  assert(c.find((x) => x.id === 'm2c1').applicationMinutes === 60, 'Actividad fijada no respetada');
});

check('BF15 ningún capítulo de un diseño mostrado supera 4 h', () => {
  for (const [st, r] of [[M, r35], [M, rGenerous], [L, fit(L(), 100, 80)]]) {
    for (const d of designsOf(r)) for (const c of rerun(st(), d).modules.flatMap((m) => m.chapters)) assert(c.targetMinutes <= 240, `${c.id} ${c.targetMinutes} min`);
  }
});

check('BF16 margen D1: esperado × (1 + 0,10) frente al presupuesto; BUDGET_FIT_MARGIN', () => {
  const exp = Number(rGenerous.chosen.cost.expected);
  const need = Math.ceil(exp * 1.1 * 100) / 100;
  assert(fit(M(), 60, need).status === 'fits', 'justo arriba debería caber');
  assert(fit(M(), 60, Math.floor(exp * 1.1 * 100) / 100 - 0.01).status !== 'fits' || fit(M(), 60, Math.floor(exp * 1.1 * 100) / 100 - 0.01).chosen.proposalSha256 !== rGenerous.chosen.proposalSha256, 'justo abajo no puede caber el mismo diseño');
  assert(F.readBudgetFitMargin({}) === 0.1 && F.readBudgetFitMargin({ BUDGET_FIT_MARGIN: '0.2' }) === 0.2, 'margen');
  let threw = false; try { F.readBudgetFitMargin({ BUDGET_FIT_MARGIN: 'diez' }); } catch { threw = true; }
  assert(threw, 'un margen inválido debe fallar fuerte');
  assert(fit(M(), 60, need, { margin: 0.3 }).status !== 'fits' || Number(fit(M(), 60, need, { margin: 0.3 }).chosen.cost.expected) * 1.3 <= need, 'con margen 30 % el mismo presupuesto no alcanza para el mismo esperado');
});

check('BF17 interruptor: solo DYNAMIC_BUDGET_FIT === "true"', () => {
  assert(F.isBudgetFitEnabled({ DYNAMIC_BUDGET_FIT: 'true' }) === true, 'true');
  for (const v of [undefined, '', 'TRUE', '1', 'yes', 'false']) assert(F.isBudgetFitEnabled({ DYNAMIC_BUDGET_FIT: v }) === false, `«${v}» no enciende`);
});

check('BF18 perfil: productionBudgetUsd 1–5000 y tope 1–5 validados; ausentes = bytes y sha de siempre', () => {
  const base = profile(60);
  const ok = P.normalizePedagogicalProfile({ ...base, productionBudgetUsd: 35 });
  assert(ok.productionBudgetUsd === 35, 'no conservó el presupuesto');
  for (const bad of [0, 0.5, 5001, '35', 12.345, -1]) assert(P.validatePedagogicalProfile({ ...base, productionBudgetUsd: bad }).some((e) => e.code === 'INVALID_PRODUCTION_BUDGET'), `aceptó ${bad}`);
  for (const bad of [0, 6, 2.5, '2']) assert(P.validatePedagogicalProfile({ ...base, designPreferences: { maxContentChaptersPerModule: bad } }).length > 0, `aceptó tope ${bad}`);
  const plain = P.normalizePedagogicalProfile(base);
  assert(!('productionBudgetUsd' in plain) && !('maxContentChaptersPerModule' in (plain.designPreferences || {})), 'claves nuevas en un perfil sin ellas');
  assert(P.pedagogicalProfileSha256(plain) === P.pedagogicalProfileSha256(P.normalizePedagogicalProfile(clone(base))), 'sha inestable');
  assert(!('maxContentChaptersPerModule' in P.profileDesignPreferences({ designPreferences: { audiovisual: 'less', maxContentChaptersPerModule: 2 } })), 'el tope no es una preferencia del distribuidor');
});

check('BF19 huellas: sin tope, la de siempre; con tope, otra; distributionOnly = misma distribución', () => {
  const a = P.runPedagogyDryRun({ structure: M(), profile: profile(60), activityTypeRules: 2 }).distribution;
  const withBudget = P.runPedagogyDryRun({ structure: M(), profile: { ...profile(60), productionBudgetUsd: 35 }, activityTypeRules: 2 }).distribution;
  assert(a.proposalSha256 === withBudget.proposalSha256, 'el presupuesto solo (sin tope) no debe mover la huella');
  const capped = P.runPedagogyDryRun({ structure: M(), profile: profile(60, 'competencias', { maxContentChaptersPerModule: 2 }), activityTypeRules: 2 }).distribution;
  assert(capped.proposalSha256 !== a.proposalSha256 && capped.contentChaptersMax === 2, 'el tope debe entrar a la huella');
  assert(capped.modules.every((m) => m.chapters.filter((c) => c.kind === 'content').length <= 2), 'el tope no se respetó');
  const lite = P.runPedagogyDryRun({ structure: M(), profile: profile(60), activityTypeRules: 2, distributionOnly: true }).distribution;
  assert(JSON.stringify(lite) === JSON.stringify(a), 'distributionOnly cambió la distribución');
});

check('BF20 enfoque de profundidad: se explora «aplicación primero» y el diseño mostrado sigue siendo válido', () => {
  const r = fit(M(), 60, 60, { approach: 'significativo' });
  assert(r.searchSpace.emphasis.includes('application'), JSON.stringify(r.searchSpace.emphasis));
  for (const d of designsOf(r)) assert(rerun(M(), d, { approach: 'significativo' }).materialized.manifestErrors.length === 0, 'diseño no materializable');
});

check('BF21 determinista (dos corridas = mismo JSON)', () => {
  const a = F.publicBudgetFit(fit(M(), 60, 35));
  const b = F.publicBudgetFit(fit(M(), 60, 35));
  assert(JSON.stringify(a) === JSON.stringify(b), 'dos corridas distintas');
});

check('BF22 Gamma sin verificar → «estimación provisional (precio de Gamma sin verificar)»; verificado → definitivo', () => {
  const seed = P.seedPricing();
  const unver = fit(S(), 20, 200, { base: { pricing: seed } });
  assert(unver.provisionalPricing.gamma === true && unver.provisionalPricing.label === 'estimación provisional (precio de Gamma sin verificar)', JSON.stringify(unver.provisionalPricing));
  const verified = { ...seed, source: 'pricing_catalog', catalog: [...seed.catalog, { id: 'g2', provider: 'gamma', service: 'generations', product_or_model: 'gamma-generate', meter: 'gamma_credit', unit_size: '1', unit_price: '0.0080000000', currency: 'USD', pricing_version: 'gamma-superadmin-2026-10-27', effective_from: '2026-10-27T00:00:00Z', effective_to: null, source: 'contract', verified: true }] };
  const ver = fit(S(), 20, 200, { base: { pricing: verified } });
  assert(ver.provisionalPricing.gamma === false && ver.provisionalPricing.label === null, JSON.stringify(ver.provisionalPricing));
  assert(Number(ver.chosen.cost.byProvider.gamma) < Number(unver.chosen.cost.byProvider.gamma), 'el precio verificado (más bajo) no se usó');
});

check('BF23 condición 7: solo diseña (dryRun, 0 proveedores, sin campos de autorización)', () => {
  const j = JSON.stringify(F.publicBudgetFit(r35));
  assert(r35.dryRun === true && r35.providersCalled === 0, 'dryRun');
  assert(!/authoriz|approval|"(cap|amount|authorizedBudget)"\s*:/i.test(j), 'el resultado lleva campos de autorización');
});

check('BF24 rendimiento: L (8 × 2) a 100 h en < 6 s; red bloqueada (0 intentos)', () => {
  const t = Date.now();
  const r = fit(L(), 100, 80);
  const ms = Date.now() - t;
  assert(ms < 6000, `${ms} ms`);
  assert(r.status === 'does_not_fit' && r.alternatives.length === 2, `${r.status} ${r.alternatives.length}`);
  assert(netAttempts.length === 0, `intentos de red: ${netAttempts.join(', ')}`);
});

check('BF25 matriz S/M/L × 20/60/100 h × 3 presupuestos: «Cabe» ⇔ esperado × 1,1 ≤ USD (y nunca un mínimo irreal)', () => {
  const rows = [];
  for (const [name, st] of [['S', S], ['M', M], ['L', L]]) {
    for (const h of [20, 60, 100]) {
      for (const usd of [15, 60, 150]) {
        const r = fit(st(), h, usd);
        if (r.status === 'fits') assert(Number(r.chosen.cost.expected) * 1.1 <= usd + 1e-9, `${name} ${h} h USD ${usd}: cabe con ${r.chosen.cost.expected}`);
        // Si la estructura no llega a las horas (sin rellenar), el límite no es el presupuesto: se dice y se ofrecen las horas posibles.
        else if (r.reason === 'hours_unreachable') assert(/no llega/.test(r.message) && r.minimumExplanation, `${name} ${h} h USD ${usd}: ${r.message}`);
        else assert(r.minimumExplanation && r.minimumExplanation.minimumUsd > usd, `${name} ${h} h USD ${usd}: mínimo ${r.minimumExplanation && r.minimumExplanation.minimumUsd}`);
        rows.push(`${name}/${h}/${usd}:${r.status}`);
      }
    }
  }
  assert(rows.some((x) => /fits/.test(x)) && rows.some((x) => /does_not_fit|impossible/.test(x)), rows.join(' '));
});

check('BF26 «Usar este diseño» es un punto fijo: re-ajustar desde lo elegido (sin «Ajustar») da el MISMO diseño', () => {
  let adjusted = 0;
  for (const [st, h, usd, ap] of [[M, 60, 62, 'competencias'], [L, 100, 85, 'competencias'], [M, 60, 200, 'significativo'], [S, 20, 40, 'competencias']]) {
    const a = fit(st(), h, usd, { approach: ap });
    assert(a.status === 'fits', `${h} h USD ${usd}: ${a.status}`);
    if (a.chosen.preferences.maxContentChaptersPerModule !== null) adjusted++;
    const cp = a.chosen.preferences;
    const levers = { audiovisual: { base: cp.audiovisual, locked: false }, guidedPractice: { base: cp.guidedPractice, locked: false }, emphasis: { base: cp.emphasis, locked: false } };
    const dp = { audiovisual: cp.audiovisual, ...(cp.guidedPractice === 'none' ? { guidedPractice: 'none' } : {}), ...(cp.emphasis !== 'balanced' ? { emphasis: cp.emphasis } : {}) };
    const b = fit(st(), h, usd, { approach: ap, levers, dp });
    assert(b.status === 'fits' && b.chosen.proposalSha256 === a.chosen.proposalSha256, `${h} h USD ${usd} ${ap}: ${a.chosen.proposalSha256} → ${b.chosen && b.chosen.proposalSha256}`);
  }
  assert(adjusted >= 2, 'faltan casos donde el ajuste cambie el diseño');
});

check('BF27 §11.1 el ajuste SÍ optimiza: 60 h y 100 h caben con menos que el diseño de siempre (menos profundización + práctica real)', () => {
  for (const [st, h, usd] of [[M, 60, 62], [L, 100, 85]]) {
    const plain = P.runPedagogyDryRun({ structure: st(), profile: profile(h), activityTypeRules: 2 }).distribution;
    const r = fit(st(), h, usd);
    assert(r.status === 'fits' && Number(plain.materialized.providers.estimateUsd.expected) * 1.1 > usd, 'el diseño de siempre ya cabía: caso sin ajuste');
    const d = r.chosen;
    assert(d.preferences.maxContentChaptersPerModule !== null && d.structure.contentChapters < plain.counts.contentChapters, 'no redujo la profundización');
    assert(d.quality.guidedShare <= 0.3 + 1e-9, `ejercicios guiados ${d.quality.guidedShare}`);
    assert(d.structure.practiceChapters >= plain.counts.practiceChapters, 'no puede perder práctica');
    assert(/práctica real/.test(r.reasons.join(' ')), r.reasons.join(' | '));
  }
});

console.log(`\n${passes} OK, ${failures} fallidas`);
if (failures) {
  console.log('Fallos:');
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
