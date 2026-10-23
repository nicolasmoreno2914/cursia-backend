/* eslint-disable */
// r61 (F) — MODELAB · proyección analítica de costo por componente y por curso (USD 0, sin red).
//
// Fuente de tokens: ledger de staging (generation_cost_events) de #1353 (M 3×4, 12 capítulos) y #1510 (S 1×1), copiado
// de ~/cursia-test-env/work/r60/evidence-ledger.md. Son TOTALES por componente (incluyen reintentos reales): el ledger
// disponible offline NO trae distribución por llamada → los «p95» de abajo son PROMEDIOS por llamada (se dice así en
// el informe). Los factores «con fixes r60» vienen de B-model-audit §4.2/§4.4 (exam 1,631 USD/banco; final_exam 3,3 USD
// × caps/12; experience 1,15 intentos) y son [H] con n pequeño.
'use strict';
const { ratesOf } = require('./catalog');

/** Tokens por componente. unit: course|module|chapter. cap: max_tokens actual de la llamada principal. */
const EVIDENCE_M = Object.freeze({
  course_plan: { unit: 'course', items: 1, calls: 1, in: 3171, out: 8012, cr: 0, cw: 0, cap: 'plan' },
  course_intro: { unit: 'course', items: 1, calls: 1, in: 3031, out: 1372, cr: 0, cw: 0, cap: 3000 },
  module_intro: { unit: 'module', items: 3, calls: 5, in: 17413, out: 6869, cr: 0, cw: 0, cap: 3000 },
  content: { unit: 'chapter', items: 12, calls: 13, in: 50550, out: 73422, cr: 0, cw: 0, cap: 8000 },
  experience: { unit: 'chapter', items: 12, calls: 43, in: 3667, out: 239723, cr: 316575, cw: 247496, cap: 8000, fix: 1.15 / 1.6, fixNote: 'intentos 1,6→1,15 [H]' },
  activity: { unit: 'chapter', items: 12, calls: 18, in: 792, out: 4517, cr: 49347, cw: 101145, cap: 5000 },
  video_interactions: { unit: 'chapter', items: 12, calls: 31, in: 2236, out: 57710, cr: 144390, cw: 92945, cap: 4000 },
  guided_practice: { unit: 'chapter', items: 12, calls: 31, in: 2780, out: 125919, cr: 126290, cw: 118332, cap: 8000 },
  application_activity: { unit: 'module', items: 3, calls: 11, in: 566, out: 64497, cr: 46177, cw: 56767, cap: 9000 },
  exam: { unit: 'module', items: 3, calls: 244, in: 188451, out: 587873, cr: 1938233, cw: 294225, cap: 12000, partEst: 7000, fix: 1.631 / (11.0683 / 3), fixNote: 'D: 1,631 USD/banco [D n=1]' },
  final_exam: { unit: 'course_scaled', items: 1, calls: 93, in: 172221, out: 314059, cr: 361674, cw: 689581, cap: 12000, partEst: 7000, fix: 3.3 / 7.922, fixNote: '3,3 USD × caps/12 [H]' },
  audiobook_chapter: { unit: 'chapter', items: 12, calls: 87, in: 166493, out: 75926, cr: 0, cw: 0, cap: 'audiobook' },
});
/** #1510 (S 1×1 sin exámenes, real). Mismo formato; los ítems son 1. */
const EVIDENCE_S = Object.freeze({
  course_plan: { unit: 'course', items: 1, calls: 1, in: 1497, out: 587, cr: 0, cw: 0, cap: 'plan' },
  course_intro: { unit: 'course', items: 1, calls: 1, in: 2307, out: 1096, cr: 0, cw: 0, cap: 3000 },
  module_intro: { unit: 'module', items: 1, calls: 1, in: 2344, out: 683, cr: 0, cw: 0, cap: 3000 },
  content: { unit: 'chapter', items: 1, calls: 1, in: 2707, out: 5448, cr: 0, cw: 0, cap: 8000 },
  experience: { unit: 'chapter', items: 1, calls: 1, in: 3, out: 5259, cr: 0, cw: 11490, cap: 8000 },
  activity: { unit: 'chapter', items: 1, calls: 1, in: 3, out: 3037, cr: 0, cw: 7203, cap: 5000 },
  video_interactions: { unit: 'chapter', items: 1, calls: 1, in: 3, out: 1440, cr: 0, cw: 6994, cap: 4000 },
  audiobook_chapter: { unit: 'chapter', items: 1, calls: 7, in: 12492, out: 5098, cr: 0, cw: 0, cap: 'audiobook' },
});
/** Costos NO-LLM por curso (Videogen + Gamma + TTS), constantes entre brazos (B-model-audit §4.4, «con fixes»). */
const NON_LLM_USD = Object.freeze({ S: 2.52, M: 19.82, L: 33.0 });
const SIZES = Object.freeze({ S: { modules: 1, chapters: 1, evidence: 'S' }, M: { modules: 3, chapters: 12, evidence: 'M' }, L: { modules: 4, chapters: 20, evidence: 'M' } });

const planCap = (n) => Math.min(16000, 2000 + 700 * n); // 45-…: _dynPlanTokenBudget
const audiobookCap = (targetWords) => Math.min(3000, Math.max(800, Math.ceil(targetWords * 2) + 200)); // audio-scripts.ts: sectionMaxTokens

/** Tokens (tokenizer 4.6) de un componente para un tamaño de curso, con o sin los fixes r60. */
function componentTokens(name, size, { fixes = true } = {}) {
  const sz = SIZES[size];
  const ev = (sz.evidence === 'S' ? EVIDENCE_S : EVIDENCE_M)[name];
  if (!ev) return null;
  let mult;
  if (ev.unit === 'chapter') mult = sz.chapters / ev.items;
  else if (ev.unit === 'module') mult = sz.modules / ev.items;
  else if (ev.unit === 'course_scaled') mult = sz.chapters / 12;
  else mult = 1;
  let t = { in: ev.in * mult, out: ev.out * mult, cr: ev.cr * mult, cw: ev.cw * mult, calls: ev.calls * mult };
  if (name === 'course_plan' && size !== 'S') {
    // Lineal en capítulos entre #1510 (n=1) y #1353 (n=12) [H para L].
    const n = sz.chapters;
    t = { in: 1497 + (3171 - 1497) * (n - 1) / 11, out: 587 + (8012 - 587) * (n - 1) / 11, cr: 0, cw: 0, calls: 1 };
  }
  if (fixes && ev.fix) t = { in: t.in * ev.fix, out: t.out * ev.fix, cr: t.cr * ev.fix, cw: t.cw * ev.fix, calls: t.calls * ev.fix };
  return t;
}

function usd(t, model, factor) {
  const r = ratesOf(model);
  const f = model === 'claude-sonnet-4-6' ? 1 : factor;
  return (t.in * r.in + t.out * r.out + t.cr * r.cr + t.cw * r.cw) * f / 1e6;
}

const COMPONENTS = Object.keys(EVIDENCE_M);
const HAIKU_CONSERVATIVE = ['audiobook_chapter', 'course_intro', 'module_intro'];
const HAIKU_AGGRESSIVE = [...HAIKU_CONSERVATIVE, 'video_interactions', 'course_plan'];

/** Políticas: componente → modelo. */
const POLICIES = Object.freeze({
  'A·S4.6 (baseline+fixes r60)': () => 'claude-sonnet-4-6',
  'B·S5.5 todo': () => 'claude-sonnet-5-5',
  'C·S5.5 + H5.5 (audio, intros)': (c) => (HAIKU_CONSERVATIVE.includes(c) ? 'claude-haiku-5-5' : 'claude-sonnet-5-5'),
  'D·S5.5 + H5.5 (audio, intros, VI, plan)': (c) => (HAIKU_AGGRESSIVE.includes(c) ? 'claude-haiku-5-5' : 'claude-sonnet-5-5'),
  'E·S4.6 + H5.5 solo audio': (c) => (c === 'audiobook_chapter' ? 'claude-haiku-5-5' : 'claude-sonnet-4-6'),
  'F·H5.5 todo (piso teórico)': () => 'claude-haiku-5-5',
});

function projectCourse(size, policyFn, factor, opts = {}) {
  const rows = [];
  let llm = 0;
  for (const c of COMPONENTS) {
    const t = componentTokens(c, size, opts);
    if (!t) continue;
    const model = policyFn(c);
    const v = usd(t, model, factor) * (opts.retryStress && ['exam', 'final_exam', 'experience'].includes(c) && model !== 'claude-sonnet-4-6' ? opts.retryStress : 1);
    rows.push({ component: c, model, usd: v, calls: t.calls });
    llm += v;
  }
  return { size, llmUsd: llm, totalUsd: llm + NON_LLM_USD[size], rows };
}

/** Riesgo de truncado: salida media por llamada × factor contra el max_tokens actual. */
function truncationRisk(factors = [1.15, 1.3, 1.4]) {
  const out = [];
  for (const c of COMPONENTS) {
    const ev = EVIDENCE_M[c];
    const evS = EVIDENCE_S[c];
    const cases = [];
    if (ev.cap === 'plan') {
      for (const [label, n] of [['S', 1], ['M', 12], ['L', 20]]) {
        const t = componentTokens('course_plan', label);
        cases.push({ where: `${label} (${n} caps)`, basis: label === 'L' ? 'interpolación lineal [H]' : 'ledger (1 llamada)', out46: t.out, cap: planCap(n) });
      }
    } else if (ev.cap === 'audiobook') {
      // 1,8 tokens/palabra es el supuesto del propio código (sectionMaxTokens); bloque máx. 900 palabras fuente, objetivo 0,9× y banda hasta 1,1×.
      for (const w of [600, 900]) cases.push({ where: `bloque de ${w} palabras (salida hasta 1,1×)`, basis: 'supuesto del código 1,8 tok/palabra', out46: Math.round(w * 1.1 * 1.8), cap: audiobookCap(Math.round(0.9 * w)) });
      cases.push({ where: 'promedio por llamada (#1353)', basis: 'ledger', out46: Math.round(ev.out / ev.calls), cap: audiobookCap(Math.round(0.9 * 900)) });
    } else {
      cases.push({ where: 'promedio por llamada (#1353)', basis: 'ledger', out46: Math.round(ev.out / ev.calls), cap: ev.cap });
      if (evS && evS.calls === 1) cases.push({ where: 'llamada única (#1510)', basis: 'ledger', out46: evS.out, cap: ev.cap });
      if (ev.partEst) cases.push({ where: 'parte del banco (diseño)', basis: 'EXAM_BANK_WORKER_OUTPUT_EST', out46: ev.partEst, cap: ev.cap });
    }
    for (const k of cases) {
      const ratios = factors.map((f) => k.out46 * f / k.cap);
      const r13 = k.out46 * 1.3 / k.cap;
      k.ratios = ratios;
      k.risk = r13 >= 1 ? 'TRUNCA' : r13 >= 0.85 ? 'ALTO' : r13 >= 0.7 ? 'MEDIO' : 'BAJO';
    }
    out.push({ component: c, cases });
  }
  return out;
}

function costTable(factors = [1.15, 1.3, 1.4]) {
  const t = {};
  for (const size of ['S', 'M', 'L']) {
    t[size] = {};
    for (const [name, fn] of Object.entries(POLICIES)) {
      t[size][name] = factors.map((f) => projectCourse(size, fn, f));
    }
  }
  return t;
}

/** Costo por componente en M para A y B a 1,30 (para el informe). */
function perComponentM(factor = 1.3) {
  const a = projectCourse('M', POLICIES['A·S4.6 (baseline+fixes r60)'], factor);
  const b = projectCourse('M', POLICIES['B·S5.5 todo'], factor);
  const h = projectCourse('M', () => 'claude-haiku-5-5', factor);
  return a.rows.map((r, i) => ({ component: r.component, s46: r.usd, s55: b.rows[i].usd, h55: h.rows[i].usd, calls: r.calls }));
}

module.exports = { EVIDENCE_M, EVIDENCE_S, NON_LLM_USD, SIZES, POLICIES, COMPONENTS, HAIKU_CONSERVATIVE, HAIKU_AGGRESSIVE, componentTokens, projectCourse, truncationRisk, costTable, perComponentM, planCap, audiobookCap, usd };
