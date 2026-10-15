// Exam-bank Monte Carlo — LLM falso con FALLAS REALES (no etiquetas): cada pregunta defectuosa falla el
// validador REAL del ejecutor con su código (SCHEMA / EVIDENCE / DISTRACTORS / LENGTH_BIAS). Las sanas pasan
// todo (esquema, evidencia textual afirmada del capítulo REAL, palabra de contenido, distractores, duplicados).
//
// Perfiles (seeded):
//   a  calibrado con #1353: tasa y mezcla de rechazos de los primeros intentos (SCHEMA 33 / EVIDENCE 32 /
//      DISTRACTORS 26 / LENGTH_BIAS 7 %). Con evidencia por referencia, una fracción `refFix` de las fallas
//      de EVIDENCE desaparece (supuesto, configurable; 0 = la referencia no mejora nada).
//   b  hoja atascada: capítulo `stuck.chapterId` × `stuck.type` da como mucho `stuck.capacity` preguntas
//      válidas «ingenuas»; las siguientes inventan evidencia SALVO que el pedido traiga la estrategia
//      alternativa (marcador ESTRATEGIA ALTERNATIVA) → entonces salen válidas.
//   c  capacidad agotada: igual que b, pero la estrategia alternativa TAMPOCO sirve (un solo código: EVIDENCE).
//   c2 capacidad agotada con códigos MEZCLADOS (EVIDENCE / SCHEMA / enunciado duplicado) — rev. I2.
// b, c y c2 llevan además el ruido calibrado de a en todas las hojas. En b la estrategia alternativa sirve solo con
// probabilidad `pB` por candidata (0,6; rev. I3), no siempre.
// Ruido de formato (rev. I3, `noise: 'realistic'`, igual para el código actual y el nuevo): ids omitidos (3 %), lista a
// medias (2 %), JSON inválido (2 %), respuesta truncada por max_tokens (1 %) y enunciado duplicado (3 %).
//
// Revisión de forma (2026-10-15, «EXAM_BANK_REVISION v1»): con probabilidad `pRev` (0,75) por candidata el modelo
// corrige lo pedido (parche con los campos de una pregunta sana del mismo id); si no, la devuelve igual.
//
// Costo (USD) con la tabla real de Sonnet 4.6: salida por pregunta con los tokens medidos en #1542/#1353
// (MC 660, V/F 265, EM 335); entrada = caracteres/3,6 (prefijo en caché: escritura la 1.ª llamada de cada
// capítulo por intento, lectura después).
'use strict';

const PRICE = { input: 3 / 1e6, output: 15 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };
const TOKENS_EST = { multichoice: 660, truefalse: 265, match: 335 };
const REVISION_TOKENS_EST = { multichoice: 450, truefalse: 160, match: 260 };
const STRATEGY_MARKER = 'ESTRATEGIA ALTERNATIVA';

function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function rngFor(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const SLOT = [
  ['madrugada', 'tarde', 'noche', 'mañana', 'jornada', 'víspera', 'semana'],
  ['Rosa', 'Iván', 'Lucía', 'Mateo', 'Sara', 'Julián', 'Elena', 'Tomás', 'Paula', 'Andrés', 'Marta'],
  ['urgencias', 'consulta', 'hospitalización', 'triage', 'farmacia', 'laboratorio', 'admisión', 'enfermería', 'psicología', 'trabajo', 'vacunación', 'odontología', 'ginecología'],
  ['Bogotá', 'Cali', 'Medellín', 'Pasto', 'Neiva', 'Tunja', 'Ibagué', 'Pereira', 'Armenia', 'Montería', 'Sincelejo', 'Riohacha', 'Yopal', 'Leticia', 'Quibdó', 'Florencia', 'Mocoa'],
  ['lluvia', 'turno', 'congestión', 'demanda', 'ruido', 'espera', 'calor', 'aglomeración', 'traslado', 'reunión', 'auditoría', 'capacitación', 'visita', 'brigada', 'campaña', 'jornada', 'feria', 'ronda', 'alerta'],
];
const words = (k) => SLOT.map((s) => s[k % s.length]);
const TYPE_IDX = { multichoice: 0, truefalse: 1, match: 2 };

const MATCH_REST = [
  { term: 'Registro del caso', definition: 'Documento donde quedan anotados los hallazgos y las decisiones tomadas' },
  { term: 'Remisión', definition: 'Envío de la persona a otro servicio con la información necesaria' },
  { term: 'Seguimiento', definition: 'Contacto posterior para verificar que la atención continúa' },
];
const MATCH_DEF0 = 'Aspecto central que el texto vincula con el procedimiento descrito';
const DISTRACTOR_BASES = [
  'Esperar la indicación de otra área antes de intervenir con la persona afectada',
  'Registrar el caso y posponer cualquier medida hasta el siguiente turno de trabajo',
  'Pedir a la persona que repita su relato varias veces para confirmar los hechos',
  'Derivar de inmediato sin explicar a la persona lo que va a ocurrir después',
  'Consultar la opinión de los acompañantes antes de hablar a solas con la persona',
];
const FILLER = ['del', 'equipo', 'de', 'turno', 'en', 'el', 'servicio', 'local'];
function fitLen(base, target) {
  const ws = base.split(' ');
  let out = '';
  for (const w of ws.concat(FILLER, FILLER)) { const next = out ? out + ' ' + w : w; if (next.length > target + 2) break; out = next; if (out.length >= target - 2) break; }
  return out;
}

const PARAPHRASE = 'Es importante valorar con calma el contexto de la persona en cada intervención que realiza el equipo.';

/**
 * front = contexto vm del frontend (funciones REALES del ejecutor para elegir evidencia válida).
 * opts = { profile: 'a'|'b'|'c', seed, x (prob. base por código), refFix, stuck: { chapterId, type, capacity } }.
 */
function createSimLlm(front, opts) {
  // xLong (2026-10-15, #1353 intento 3): prob. de una MC VÁLIDA con los 5 distractores más cortos que la correcta (0,8–0,95×:
  // entra solo de relleno y cuenta para la regla de conjunto ≤ 30 %). 0 = como antes. pLen: la revisión de longitud se cumple.
  const o = Object.assign({ x: 0.18, refFix: 0.5, profile: 'a', pB: 0.6, noise: 'realistic', pRev: 0.75, xLong: 0, pLen: 0.75 }, opts);
  const NZ = o.noise === 'realistic' ? { omit: 0.03, partial: 0.02, badJson: 0.02, truncate: 0.01, dup: 0.03 } : { omit: 0, partial: 0, badJson: 0, truncate: 0, dup: 0 };
  const firstStem = new Map(); // chapter|type → enunciado de la primera válida (para duplicados)
  const st = { calls: 0, repairCalls: 0, mainCalls: 0, revisionCalls: 0, revisionAsked: 0, revisionFixed: 0, strategyCalls: 0, questions: 0, outputTokens: 0, inTail: 0, cacheRead: 0, cacheWrite: 0, usd: 0, faults: {}, stuckValid: 0, warm: new Set(), unknownPrompts: 0 };
  const citCache = new Map();
  function citable(md) {
    if (citCache.has(md)) return citCache.get(md);
    const idx = front.dynExamEvidenceIndex(md);
    const units = front.dynExamEvidenceUnits(md)
      .map((u) => String(u).replace(/\*\*|__|`/g, '').replace(/^[ \t>#]+/, '').replace(/\|/g, '').replace(/\s+/g, ' ').trim())
      .filter((u) => u.length >= 40 && u.length <= 220 && front.dynExamEvidenceSupport(idx, u).ok);
    citCache.set(md, units);
    return units;
  }
  const BANNED = new Set();
  [MATCH_DEF0].concat(MATCH_REST.map((p) => p.term + ' ' + p.definition)).forEach((t) => front.dynExamTokens(front.dynNormalizeExamText(t)).forEach((w) => BANNED.add(w)));
  function contentWord(text) {
    const toks = front.dynExamTokens(front.dynNormalizeExamText(text)).filter((t) => /^\p{L}+$/u.test(t) && t.length >= 5 && !front.DYN_EXAM_STOPWORDS[t] && !BANNED.has(t));
    return toks[0] || null;
  }
  function parse(prompt) {
    const lines = prompt.split('\n');
    const isModule = lines.includes('EXAM_BANK_CHAPTER v2') || /\nEXAM_BANK_CHAPTER v\d+\n/.test(prompt);
    if (!isModule) return null;
    const chapterId = (/Todas las preguntas llevan "chapterId": "([^"]+)"/.exec(prompt) || [])[1];
    const md = (/<<<CAPITULO\n([\s\S]*?)\nCAPITULO>>>/.exec(prompt) || [])[1] || '';
    const refs = [...md.matchAll(/\[(S\d+)\]\s*([^\n[]+)/g)].map((m) => ({ ref: m[1], text: m[2].trim() }));
    const repairAt = prompt.search(/\nEXAM_BANK_REPAIR v\d+\n/);
    const revisionAt = prompt.search(/\nEXAM_BANK_REVISION v\d+\n/);
    const asks = [];
    if (revisionAt >= 0) {
      for (const m of prompt.slice(revisionAt).matchAll(/^- id "([^"]+)" \(type "([a-z]+)"[^\n]*\n {2}PREGUNTA: (.*)\n {2}CORREGIR: (.*)$/gm)) asks.push({ id: m[1], type: m[2], question: JSON.parse(m[3]), fixes: m[4] });
    } else if (repairAt >= 0) {
      for (const m of prompt.slice(repairAt).matchAll(/^- id "([^"]+)" \(type "([a-z]+)"[^)]*\) → (.*)$/gm)) asks.push({ id: m[1], type: m[2], reasons: m[3] });
    } else {
      for (const line of lines) {
        const t = /^- type "([a-z]+)" .*EXACTAMENTE (\d+) preguntas, (.*)$/.exec(line);
        if (!t) continue;
        let ids;
        const ex = /exactamente estos ids: (.*?);/.exec(t[3]);
        if (ex) ids = [...ex[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        else {
          const r = /ids "([^"]+)" a "([^"]+)"/.exec(t[3]);
          const pre = r[1].replace(/\d+$/, ''); const w = r[1].length - pre.length;
          ids = []; for (let i = Number(r[1].slice(pre.length)); i <= Number(r[2].slice(pre.length)); i++) ids.push(pre + String(i).padStart(w, '0'));
        }
        ids.forEach((id) => asks.push({ id, type: t[1] }));
      }
    }
    return { chapterId, md, refs, refMode: refs.length > 0 && /evidenceRef/.test(prompt), isRepair: repairAt >= 0, isRevision: revisionAt >= 0, strategy: prompt.includes(STRATEGY_MARKER), asks };
  }
  function pickFault(rng, type) {
    const x = o.x;
    const r = rng();
    // Exclusivas: SCHEMA x, EVIDENCE x (todas), DISTRACTORS 1,34x y LENGTH_BIAS 0,36x (solo MC) — mezcla de #1353.
    if (r < x) return 'SCHEMA';
    if (r < 2 * x) return 'EVIDENCE';
    if (type === 'multichoice') { if (r < 3.34 * x) return 'DISTRACTORS'; if (r < 3.7 * x) return 'LENGTH_BIAS'; }
    return null;
  }
  function build(ask, p, rng, ctx) {
    const m = /-(MC|TF|EM)-(\d+)$/.exec(ask.id);
    const n = Number(m[2]);
    const k = fnv(ask.id) % 100000;
    const [w1, w2, w3, w4, w5] = words(k);
    const units = p.refMode ? p.refs : citable(p.md).map((t) => ({ ref: null, text: t }));
    let unit = units[Math.floor(rng() * units.length)];
    let W = contentWord(unit.text);
    for (let tries = 0; !W && tries < 20; tries++) { unit = units[Math.floor(rng() * units.length)]; W = contentWord(unit.text); }
    const q = { id: ask.id, type: ask.type, chapterId: p.chapterId, level: n % 3 === 0 ? 'recordar' : n % 3 === 1 ? 'aplicar' : 'analizar' };
    const fault = ctx.fault;
    if (p.refMode) {
      if (fault === 'EVIDENCE') q.evidenceRef = 'S99999';
      else q.evidenceRef = unit.ref;
    } else {
      q.evidence = fault === 'EVIDENCE' ? PARAPHRASE : unit.text;
    }
    q.explanation = fault === 'SCHEMA' ? 'Breve.' : 'El texto describe este criterio como parte de la atención; aplicarlo bien evita errores frecuentes en el caso.';
    const where = `Servicio de ${w3} en ${w4}, caso ${k}`;
    if (ask.type === 'multichoice') {
      q.stem = `${where}: en la ${w1}, ${w2} atiende a una persona durante la ${w5} y debe decidir el paso siguiente. ¿Qué corresponde hacer?`;
      const correct = `Aplicar el criterio de ${W} descrito para la atención`;
      const L = correct.length;
      q.correct = { text: correct, why: 'Es lo que el texto indica para este momento de la atención.' };
      let ds;
      if (fault === 'DISTRACTORS') ds = ['Esperar', 'Registrar', 'Pedir ayuda', fitLen(DISTRACTOR_BASES[3], Math.round(L * 1.05)), fitLen(DISTRACTOR_BASES[4], Math.round(L * 1.1))];
      else if (fault === 'LENGTH_BIAS') ds = DISTRACTOR_BASES.map((b, i) => fitLen(b, Math.round(L * (0.58 + 0.02 * i))));
      else if (ctx.longest) ds = DISTRACTOR_BASES.map((b, i) => fitLen(b, Math.round(L * [0.8, 0.84, 0.88, 0.91, 0.94][i])));
      else ds = DISTRACTOR_BASES.map((b, i) => fitLen(b, Math.round(L * [0.86, 0.92, 0.97, 1.07, 1.13][i])));
      q.distractors = ds.map((text) => ({ text, why: 'Confunde una acción sin criterio con lo que pide el procedimiento.' }));
    } else if (ask.type === 'truefalse') {
      const forced = /debe ser answer: (true|false)/.exec(ask.reasons || '');
      q.answer = forced ? forced[1] === 'true' : n % 2 === 1;
      q.stem = q.answer
        ? `${where}: en la ${w1}, ${w2} confirma que el criterio de ${W} forma parte de la atención durante la ${w5}.`
        : `${where}: en la ${w1}, ${w2} afirma que el criterio de ${W} puede dejarse de lado durante la ${w5}.`;
      q.whyWrong = q.answer ? 'Quien marca falso pasa por alto lo que el texto indica.' : 'Quien marca verdadero ignora lo que el texto indica.';
    } else {
      q.stem = `${where}: en la ${w1}, ${w2} repasa con su equipo los conceptos clave antes de la ${w5}.`;
      q.pairs = [{ term: W, definition: MATCH_DEF0 }].concat(MATCH_REST.map((x) => ({ ...x })));
    }
    return q;
  }
  function respond(body) {
    const c = body.messages[0].content;
    const blocks = Array.isArray(c) ? c : [{ text: String(c) }];
    const prompt = blocks.map((b) => b.text).join('');
    const p = parse(prompt);
    if (!p) { st.unknownPrompts++; return { httpStatus: 400, error: 'sim: prompt no reconocido' }; }
    st.calls++;
    if (p.isRevision) return reviseCall(p, blocks, prompt);
    if (p.isRepair) st.repairCalls++; else st.mainCalls++;
    if (p.strategy) st.strategyCalls++;
    const rng = rngFor(fnv(`${o.seed}|${st.calls}`));
    const callR = rng();
    let asks = p.asks;
    if (callR < NZ.partial) asks = asks.slice(0, Math.ceil(asks.length / 2));
    asks = asks.filter(() => rng() >= NZ.omit);
    const qs = asks.map((ask) => {
      let fault = pickFault(rng, ask.type);
      if (p.refMode && fault === 'EVIDENCE' && rng() < o.refFix) fault = null;
      const isStuck = o.stuck && o.profile !== 'a' && p.chapterId === o.stuck.chapterId && ask.type === o.stuck.type;
      if (isStuck && st.stuckValid >= o.stuck.capacity) {
        if (o.profile === 'b' && p.strategy) { if (rng() >= o.pB) fault = fault || 'EVIDENCE'; }
        else if (o.profile === 'c2') fault = ['EVIDENCE', 'SCHEMA', 'DUP'][st.calls % 3];
        else fault = 'EVIDENCE';
      }
      let dupStem = false;
      if (fault === 'DUP') { fault = null; dupStem = true; }
      else if (!fault && rng() < NZ.dup) dupStem = true;
      if (fault) st.faults[fault] = (st.faults[fault] || 0) + 1;
      const q = build(ask, p, rng, { fault, longest: o.xLong > 0 && !fault && ask.type === 'multichoice' && rng() < o.xLong });
      const key = p.chapterId + '|' + ask.type;
      if (dupStem && firstStem.has(key)) { q.stem = firstStem.get(key); st.faults.DUP = (st.faults.DUP || 0) + 1; }
      else if (!fault) {
        if (!firstStem.has(key)) firstStem.set(key, q.stem);
        if (isStuck) st.stuckValid++;
      }
      return q;
    });
    // Costo
    const prefix = blocks.length >= 2 ? (blocks[0].text + blocks[1].text).length : 0;
    const tail = prompt.length - prefix;
    const key = `${p.chapterId}|${o.attempt || 1}`;
    const outTok = qs.reduce((t, q) => t + TOKENS_EST[q.type], 0);
    const inTail = Math.ceil(tail / 3.6);
    const pre = Math.ceil(prefix / 3.6);
    let usd = outTok * PRICE.output + inTail * PRICE.input;
    if (!st.warm.has(key)) { st.warm.add(key); st.cacheWrite += pre; usd += pre * PRICE.cacheWrite; } else { st.cacheRead += pre; usd += pre * PRICE.cacheRead; }
    st.questions += qs.length; st.outputTokens += outTok;
    if (callR >= NZ.partial && callR < NZ.partial + NZ.badJson) { st.faults.BAD_JSON = (st.faults.BAD_JSON || 0) + 1; st.usd += usd; return { text: '{"questions": [ esto no es JSON' }; }
    if (callR >= NZ.partial + NZ.badJson && callR < NZ.partial + NZ.badJson + NZ.truncate) { st.faults.TRUNCATED = (st.faults.TRUNCATED || 0) + 1; st.usd += usd; return { text: JSON.stringify({ questions: qs }).slice(0, 200), stopReason: 'max_tokens' }; } if (p.isRepair) st.repairQuestions = (st.repairQuestions || 0) + qs.length; else st.mainQuestions = (st.mainQuestions || 0) + qs.length; st.inTail += inTail; st.usd += usd;
    return { text: JSON.stringify({ questions: qs }) };
  }
  // Revisión: el modelo corrige los campos de forma (pregunta sana del mismo id) con probabilidad pRev; si no, nada cambia.
  function reviseCall(p, blocks, prompt) {
    st.revisionCalls++;
    const rng = rngFor(fnv(`${o.seed}|rev|${st.calls}`));
    // rev. M9: el mismo ruido de formato que las demás llamadas (ids omitidos, JSON inválido).
    const callR = rng();
    const revisions = p.asks.filter(() => rng() >= NZ.omit).map((ask) => {
      st.revisionAsked++;
      if (/alárgalos a (\d+)–(\d+)/.test(ask.fixes || '')) {
        // Revisión de longitud: alarga SOLO los 2 distractores indicados (mismo error, más detalle) con prob. pLen.
        st.lengthAsked = (st.lengthAsked || 0) + 1;
        if (rng() >= o.pLen) return { id: ask.id };
        const lo = Number(/alárgalos a (\d+)–/.exec(ask.fixes)[1]);
        const which = (/distractores (\d+) y (\d+)/.exec(ask.fixes) || []).slice(1).map((x) => Number(x) - 1);
        st.lengthFixed = (st.lengthFixed || 0) + 1;
        return { id: ask.id, distractors: ask.question.distractors.map((d, i) => ({ text: which.includes(i) ? fitLen(d.text + ' en la atención del servicio local', lo + 4) : d.text })) };
      }
      if (rng() >= o.pRev) return { id: ask.id };
      // La capacidad de la hoja atascada (perfiles b/c/c2) acota TODAS las válidas, también las corregidas por revisión.
      const isStuck = o.stuck && o.profile !== 'a' && p.chapterId === o.stuck.chapterId && ask.type === o.stuck.type;
      if (isStuck && st.stuckValid >= o.stuck.capacity) return { id: ask.id };
      if (isStuck) st.stuckValid++;
      st.revisionFixed++;
      const ok = build(ask, p, rng, { fault: null });
      const patch = { id: ask.id, explanation: ok.explanation };
      if (!('evidence' in ask.question) && !('evidenceRef' in ask.question)) patch.evidenceRef = ok.evidenceRef;
      if (ask.type === 'multichoice') { patch.correct = ok.correct; patch.distractors = ok.distractors; }
      if (ask.type === 'truefalse') patch.whyWrong = ok.whyWrong;
      if (ask.type === 'match') patch.pairs = ok.pairs;
      return patch;
    });
    const prefix = blocks.length >= 2 ? (blocks[0].text + blocks[1].text).length : 0;
    const inTail = Math.ceil((prompt.length - prefix) / 3.6);
    const pre = Math.ceil(prefix / 3.6);
    const outTok = p.asks.reduce((t, a) => t + REVISION_TOKENS_EST[a.type], 0);
    // Sale justo después de la llamada principal del capítulo: el prefijo ya está en caché (lectura).
    const key = `${p.chapterId}|${o.attempt || 1}`;
    let usd = outTok * PRICE.output + inTail * PRICE.input;
    if (!st.warm.has(key)) { st.warm.add(key); st.cacheWrite += pre; usd += pre * PRICE.cacheWrite; } else { st.cacheRead += pre; usd += pre * PRICE.cacheRead; }
    st.outputTokens += outTok; st.inTail += inTail; st.usd += usd;
    if (callR < NZ.badJson) { st.faults.BAD_JSON = (st.faults.BAD_JSON || 0) + 1; return { text: '{"revisions": [ esto no es JSON' }; }
    return { text: JSON.stringify({ revisions }) };
  }
  return { respond, st, setAttempt: (a) => { o.attempt = a; }, citable };
}

module.exports = { createSimLlm, STRATEGY_MARKER, PRICE, TOKENS_EST };
