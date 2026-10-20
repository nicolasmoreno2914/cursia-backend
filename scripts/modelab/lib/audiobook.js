/* eslint-disable */
// r61 (F) — MODELAB · guion del audiolibro (fuera del ejecutor): el MISMO código del proveedor real
// (dist/workers/provider-real/audio-scripts.js: planAudiobookSections + generateSectionScript + findScriptRepetition,
// con sus validaciones deterministas de banda 85–110 %, continuación, condensación, truncado e idioma) con la llamada
// LLM inyectada (ScriptLlm) → callThrough del brazo. El pedido base es el que arma provider-clients.ts (AnthropicClient
// .messages: model, max_tokens, system, messages[user]) — sin thinking ni effort, como hoy.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { callThrough } = require('./runner');
const G = require('./grade');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Proveedor falso para dry-run: «narra» devolviendo el propio texto del bloque (cumple la banda), sin red. */
function echoNarrator() {
  return {
    name: 'modelab-echo-narrator', real: false,
    respond(body) {
      const u = body.messages[0].content;
      const m = /Texto del bloque \(\d+ palabras\):\n"""\n([\s\S]*?)\n"""/.exec(u) || /"""\n([\s\S]*?)\n"""/.exec(u);
      const w = (m ? m[1] : 'Narración simulada del bloque.').replace(/[#*_`>|]/g, ' ').split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x));
      return { text: w.slice(0, Math.max(1, Math.round(w.length * 0.95))).join(' ') + '.' }; // dentro de la banda 85–110 %
    },
  };
}

async function runAudiobookChapter(o) {
  const A = require(path.join(o.distRoot, 'workers/provider-real/audio-scripts.js'));
  const ctx = { distRoot: o.distRoot, arm: o.arm, client: o.client, guard: o.guard, calls: [], sink: o.sink || null, tags: o.tags || {}, resume: o.resume || null, onAnswer: o.onAnswer || null, backoffMs: o.backoffMs };
  if (o.client.kind === 'mock') o.client.providerRef.provider = echoNarrator();
  const plan = A.planAudiobookSections(o.contentMarkdown);
  const input = { courseTitle: o.courseTitle, chapterNumber: o.chapterNumber, chapterTitle: o.chapterTitle, sector: o.sector || null, nivel: o.nivel || null, pais: o.pais || null, contentMarkdown: o.contentMarkdown };
  const itemKey = `audiobook_chapter:${o.chapterId}`;
  const llm = async (prompt, role) => {
    const body = { model: 'claude-sonnet-4-6', max_tokens: prompt.maxTokens, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] };
    const { r } = await callThrough(ctx, body, { itemKey, componentType: 'audiobook_chapter', callRole: role, requestHash: sha(JSON.stringify(body)) });
    return { text: r.text, messageId: r.id || 'none', truncated: r.stopReason === 'max_tokens' };
  };
  const sections = [];
  const failures = [];
  let prev = null;
  for (const s of plan.sections) {
    try {
      const r = await A.generateSectionScript(input, s, plan.sections.length, prev, llm);
      sections.push(r);
      prev = r.text;
    } catch (e) {
      // Presupuesto, rechazo de la API, infraestructura y lint abortan la corrida (nunca son «fallas del guion»).
      // Solo los errores de VALIDACIÓN del guion (AudioScriptError) cuentan contra el brazo; presupuesto, rechazo de la
      // API, infraestructura, lint o un error inesperado abortan la corrida (nunca se degradan en silencio).
      if (!(e instanceof A.AudioScriptError)) throw e;
      failures.push({ idx: s.idx, code: (e && e.code) || 'ERROR', message: String((e && e.message) || e).slice(0, 200) });
      prev = null;
    }
  }
  const rep = A.findScriptRepetition(sections.map((x) => ({ idx: x.idx, text: x.text })), plan.sections.map((x) => ({ idx: x.idx, text: x.text })));
  const usd = ctx.calls.reduce((a, c) => a + c.usd, 0);
  const ok = failures.length === 0 && rep.idxs.length === 0;
  return {
    itemKey, ok, sections: plan.sections.length, narrated: sections.length, failures, repetition: rep,
    meanRatio: sections.length ? Math.round(sections.reduce((a, x) => a + x.ratio, 0) / sections.length * 1000) / 1000 : null,
    continued: sections.filter((x) => x.continued).length, condensed: sections.filter((x) => x.condensed).length,
    firstPassValid: ok && sections.every((x) => !x.continued && !x.condensed),
    calls: ctx.calls, usd, texts: sections.map((x) => x.text),
    quality: G.gradeDocs(o.distRoot, sections.map((x) => x.text)),
  };
}

module.exports = { runAudiobookChapter, echoNarrator };
