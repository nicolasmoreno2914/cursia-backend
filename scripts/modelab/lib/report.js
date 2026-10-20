/* eslint-disable */
// r61 (F) — MODELAB · informes Markdown (los JSON son la fuente; esto solo los presenta).
'use strict';
const f2 = (x) => (x === null || x === undefined ? '—' : typeof x === 'number' ? x.toFixed(2) : String(x));
const f3 = (x) => (x === null || x === undefined ? '—' : typeof x === 'number' ? x.toFixed(3) : String(x));
const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(0)} %`);

function renderProjection(o) {
  const L = ['# MODELAB · proyección de costo (USD 0)', '', 'Tokens: ledger de staging #1353 (M) y #1510 (S); L = interpolación. «Con fixes r60» en exam/final_exam/experience. Factor del tokenizer nuevo: 1,15 / 1,30 / 1,40 (supuesto hasta count_tokens). Sin pensamiento (between_tools / disabled).', ''];
  L.push('## Costo LLM (Anthropic) por curso — USD, factor 1,15 / 1,30 / 1,40', '', '| Política | S 1×1 | M 3×4 | L 4×5 |', '|---|---|---|---|');
  const pols = Object.keys(o.costTable.M);
  for (const p of pols) L.push(`| ${p} | ${['S', 'M', 'L'].map((s) => o.costTable[s][p].map((x) => f2(x.llmUsd)).join(' / ')).join(' | ')} |`);
  L.push('', `## Total por curso (LLM + Videogen/Gamma/TTS constantes: S ${o.nonLlmUsd.S}, M ${o.nonLlmUsd.M}, L ${o.nonLlmUsd.L}) — factor 1,30`, '', '| Política | S | M | L |', '|---|---|---|---|');
  for (const p of pols) L.push(`| ${p} | ${['S', 'M', 'L'].map((s) => f2(o.costTable[s][p][1].totalUsd)).join(' | ')} |`);
  L.push('', '## Por componente en M (factor 1,30)', '', '| Componente | llamadas (#1353, con fixes) | S4.6 | S5.5 | H5.5 |', '|---|---|---|---|---|');
  for (const r of o.perComponentM) L.push(`| ${r.component} | ${f2(r.calls)} | ${f3(r.s46)} | ${f3(r.s55)} | ${f3(r.h55)} |`);
  L.push('', '## Riesgo de truncado (salida × factor / max_tokens actual)', '', 'OJO: el ledger offline solo da PROMEDIOS por llamada (no p95). Un promedio ≥ 0,85 del tope implica que la cola ya trunca.', '', '| Componente | caso | base | salida 4.6 | max_tokens | ×1,15 | ×1,30 | ×1,40 | riesgo |', '|---|---|---|---|---|---|---|---|---|');
  for (const c of o.truncation) for (const k of c.cases) L.push(`| ${c.component} | ${k.where} | ${k.basis} | ${Math.round(k.out46)} | ${k.cap} | ${k.ratios.map(f2).join(' | ')} | ${k.risk} |`);
  return L.join('\n') + '\n';
}

function renderBaseline(o) {
  const L = ['# MODELAB · baseline offline (USD 0)', ''];
  const p = o.package1510;
  if (p.available) {
    L.push(`## Salidas reales de ${p.course}`, '', '| Grupo | docs | palabras | MC | correcta más larga | esperado azar | z | repetición (shingles 12) | hits idioma | oraciones en inglés | marcadores editoriales |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const k of ['activity', 'video_interactions', 'content_libro', 'labels']) {
      const g = p[k]; if (!g || !g.answerLengthBias) continue;
      const e = g.editorial;
      L.push(`| ${k} | ${g.docs} | ${g.words} | ${g.answerLengthBias.mc} | ${pct(g.answerLengthBias.share)} | ${pct(g.answerLengthBias.expectedShare)} | ${f2(g.answerLengthBias.z)} | ${f3(g.repetition.ratio)} | ${e.VOSEO + e.VOSOTROS + e.REGIONAL} | ${e.ENGLISH_SENTENCES} | ${e.EDITORIAL_MARKERS} |`);
    }
  } else L.push('_(paquete #1510 no disponible en esta máquina)_');
  L.push('', '## Ledger: llamadas por ítem válido (proxy de reintentos, Sonnet 4.6)', '', '| Componente | ítems #1353 | llamadas | llamadas/ítem | salida media/llamada | #1510 llamadas |', '|---|---|---|---|---|---|');
  for (const r of o.ledger) L.push(`| ${r.component} | ${r.m1353_items} | ${r.m1353_calls} | ${f2(r.m1353_callsPerValidItem)} | ${r.m1353_avgOutPerCall} | ${r.s1510_calls ?? '—'} |`);
  L.push('', '## Banco de examen: rechazos de primera pasada (evidencia documentada)', '', '```json', JSON.stringify(o.examFirstPass, null, 2), '```', '', '## Advertencias', '', ...o.caveats.map((c) => `- ${c}`));
  return L.join('\n') + '\n';
}

function renderCapture(o) {
  const L = ['# MODELAB · pedidos del ejecutor por componente', '', `Modo: ${o.mode}. ${o.note}`, '', '| Componente | rol | max_tokens | chars prompt | caché | lint A/B/C | tok S4.6 | tok S5.5 | tok H5.5 | factor S5.5 |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of o.rows) {
    if (r.error) { L.push(`| ${r.type} | — | — | — | — | error: ${r.error} | | | | |`); continue; }
    L.push(`| ${r.type} | ${r.callRole} | ${r.maxTokens} | ${r.promptChars} | ${r.cached ? 'sí' : 'no'} | ${Object.values(r.lint).map((x) => (x.length ? x.join('+') : 'ok')).join(' / ')} | ${r['tokens_claude-sonnet-4-6'] ?? '—'} | ${r['tokens_claude-sonnet-5-5'] ?? '—'} | ${r['tokens_claude-haiku-5-5'] ?? '—'} | ${r.factor_s55 ?? '—'} |`);
  }
  return L.join('\n') + '\n';
}

function renderRun(o, cfg) {
  const L = [`# MODELAB · corrida ${o.mode} · ${o.experiment}`, '', `Presupuesto: aprobado ${o.budget.approvedUsd} USD · gastado ${o.budget.spentUsd} · llamadas ${o.budget.calls}. Proyección previa (evidencia) ${f3(o.plan.totalUsd)} USD (× margen = ${f3(o.preflight.withMarginUsd)}).`];
  if (o.mode === 'dry-run') L.push('', '> DRY-RUN: respuestas del LLM FALSO del E2E y uso SIMULADO (chars/4 × factor del tokenizer). Los costos y la calidad de esta tabla NO son de los modelos reales: demuestran el circuito completo (adaptación, lint, presupuesto, validadores, regla go/no-go).');
  if (o.aborted) L.push('', `**ABORTADO**: ${o.aborted.message}`);
  for (const c of o.components) {
    L.push('', `## ${c.component} (${c.input}) — ${c.targets.length} ítem(s)`, '', '| Brazo | modelo | ítems | válidos | 1.ª pasada | reintentos/ítem | fallas duras | truncados | refusal | USD | USD/ítem válido | correcta más larga | repetición | idioma/100 or. | veredicto |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const [id, a] of Object.entries(c.arms)) {
      const d = c.decisions[id];
      L.push(`| ${id} | ${a.model} | ${a.items} | ${a.completed} | ${pct(a.firstPassValidity)} | ${f2(a.retriesPerItem)} | ${a.hardFailures} | ${a.truncations} | ${a.refusals} | ${f3(a.usd)} | ${f3(a.usdPerValidItem)} | ${pct(a.answerLongestShare)} | ${f3(a.repetitionRatio)} | ${f2(a.languageHitsPer100Sentences)} | ${d ? d.verdict : 'baseline'} |`);
    }
    for (const [id, d] of Object.entries(c.decisions)) if (d.reasons.length) L.push(`- ${id}: ${d.reasons.join('; ')}`);
  }
  L.push('', '## Regla de decisión', '', `GO por componente si: rúbrica ≥ baseline − ${cfg.successCriteria.rubricMaxDrop}; validez de 1.ª pasada ≥ baseline − ${cfg.successCriteria.firstPassMaxDrop * 100} pts; 0 fallas duras nuevas (fallas, truncados, refusal, JSON inválido); ahorro ≥ ${cfg.successCriteria.minSavingPerValidItem * 100} % por ítem válido; sesgo de largo de la correcta no sube más de ${cfg.successCriteria.answerBiasMaxRise * 100} pts. Deterministas OK sin rúbrica = PENDING_RUBRIC.`);
  return L.join('\n') + '\n';
}

module.exports = { renderProjection, renderBaseline, renderCapture, renderRun };
