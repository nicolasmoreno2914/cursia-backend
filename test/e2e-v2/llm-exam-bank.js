// EV6 P2-B6 — LLM falso de los BANCOS de preguntas (dynamic_exam_bank_json) para el E2E v3.
//
// Reconoce los prompts del ejecutor por su marcador de tarea (F1/F2, 44; BANKOPT: prompt en partes
// «EXAM_BANK_SOURCE v2» + tarea + tail, mandado como bloques con cache_control):
//   EXAM_BANK_CHAPTER v2        examen del módulo, un capítulo (hojas completas o partes)
//   EXAM_BANK_FINAL_CHAPTER v2  examen final, un capítulo de un módulo
//   EXAM_BANK_FINAL_MODULE v1   examen final, un módulo con todos sus capítulos (prompt de F1; F2 ya no lo usa)
//   EXAM_BANK_REPAIR v2         reparación dirigida (mismo prefijo fuente + tarea; la lista va en el tail)
// y responde EXACTAMENTE los ids pedidos, con el esquema que ve el LLM (5 distractores por
// selección múltiple) y la evidencia copiada TEXTUAL del Markdown del capítulo que trae el prompt.
//
// Falla inyectada UNA vez por corrida (primer prompt de banco de un examen de módulo): tres preguntas
// con evidencia que NO está en el capítulo y una selección múltiple cuyos 5 distractores son todos
// mucho más cortos que la correcta. BANKOPT: la hoja MC pide 2s+2 (holgura 2) → con 4 fallas faltan 2
// para el objetivo; el ejecutor elige entre las válidas (la «solo más larga» queda fuera sin reparar) y
// pide UNA reparación (EXAM_BANK_REPAIR v2) solo con 2 de las evidencias falsas, que la respuesta corrige.
//
// A1 (contrato): ANTES de devolver, cada pregunta se proyecta al esquema del contrato (3 distractores)
// y se valida con `validateExamBank` de B2 (dist compilado, con el Markdown del capítulo). Las
// preguntas sanas deben salir sin errores propios y las fallas inyectadas EXACTAMENTE con su código
// (EXAM_BANK_EVIDENCE / EXAM_BANK_LENGTH_BIAS). Un desvío del contrato hace fallar AL FAKE (lanza →
// el LLM falso responde 400 y lo registra en st.unknown), nunca al producto.
'use strict';

const BANK_MARKERS = {
  'EXAM_BANK_CHAPTER v2': 'module',
  'EXAM_BANK_FINAL_CHAPTER v2': 'final',
  'EXAM_BANK_FINAL_MODULE v1': 'final',
};
const REPAIR_MARKER = 'EXAM_BANK_REPAIR v2';
const SOURCE_MARKER = 'EXAM_BANK_SOURCE v2';
const TYPE_IDX = { multichoice: 0, truefalse: 1, match: 2 };

// ── Vocabulario (palabras disjuntas por ranura, ≥ 3 letras: el ejecutor descarta enunciados con
// Jaccard ≥ 0,8; con 5 ranuras de tamaños primos dos k distintos difieren en ≥ 2 palabras + el número).
const SLOT = [
  ['madrugada', 'tarde', 'noche', 'mañana', 'jornada', 'víspera', 'semana'], // 7
  ['Rosa', 'Iván', 'Lucía', 'Mateo', 'Sara', 'Julián', 'Elena', 'Tomás', 'Paula', 'Andrés', 'Marta'], // 11
  ['chancador', 'harnero', 'espesador', 'molino', 'correa', 'grúa', 'cargador', 'perforadora', 'camión', 'excavadora', 'bulldozer', 'pala', 'compresor'], // 13
  ['Antofagasta', 'Calama', 'Copiapó', 'Iquique', 'Taltal', 'Mejillones', 'Tocopilla', 'Vallenar', 'Ovalle', 'Arica', 'Chañaral', 'Huasco', 'Caldera', 'Andacollo', 'Illapel', 'Salamanca', 'Pozo'], // 17
  ['polvo', 'calor', 'viento', 'altura', 'humedad', 'vibración', 'sal', 'arena', 'frío', 'lluvia', 'neblina', 'barro', 'ruido', 'helada', 'sequedad', 'pendiente', 'oscuridad', 'carga', 'urgencia'], // 19
];
function words(k) { return SLOT.map((s, i) => s[k % s.length]); }

// Selección múltiple: la correcta lleva «presión» (palabra del capítulo: el ejecutor exige una palabra de
// contenido del texto). Distractores de la misma categoría, sin cifras ni unidades ni palabras absolutas,
// 2–4 más cortos (≥ 0,85×) y 1–3 más largos (≤ 1,15×): ninguna combinación de 3 es atípica (B2 LENGTH_BIAS).
const MC_T = [
  ['Medir la presión de trabajo con un manómetro calibrado', ['Cambiar el aceite sin revisar antes el circuito', 'Ajustar la válvula de alivio guiándose por el oído', 'Aumentar la velocidad del motor hasta que cese el ruido raro', 'Esperar a que el actuador se detenga para anotar la falla', 'Reemplazar la bomba de inmediato sin tomar lecturas previas']],
  ['Comparar la presión medida con la especificación del equipo', ['Comparar el color del aceite con el de la semana pasada', 'Confiar en la experiencia del operador más antiguo', 'Revisar la presión recién después de cambiar los sellos', 'Anotar el horómetro y continuar la operación del turno', 'Consultar el manual del motor eléctrico y ajustar los fusibles']],
  ['Bloquear la energía y descargar la presión acumulada', ['Abrir el acople rápido con el equipo encendido', 'Aflojar la manguera para escuchar si sale aire', 'Pedir al operador que mantenga el mando en posición neutra', 'Desconectar el sensor de temperatura del panel local', 'Colocar una bandeja bajo la fuga y seguir trabajando']],
  ['Revisar si el caudal de la bomba baja con la presión', ['Revisar si el estanque está pintado del color correcto', 'Medir el largo de las mangueras de retorno', 'Cambiar el filtro de succión aunque esté limpio y nuevo', 'Aumentar la carga del cilindro para provocar la falla', 'Revisar la marca del aceite en la orden de compra anterior']],
];
const MC_WHY = 'Confunde una acción sin medición con el diagnóstico que pide el procedimiento.';
// Falla inyectada: los 5 distractores son MUCHO más cortos (≈ 0,55×) que la correcta (54).
const FAULT_SHORT_DISTRACTORS = ['Cambiar el filtro del retorno', 'Revisar el nivel del estanque', 'Limpiar la carcasa del equipo', 'Apretar los acoples de entrada', 'Purgar el aire de los cilindros'];
// Falla inyectada: evidencia que NO está en el capítulo.
const FAULT_EVIDENCE = 'La norma interna de la faena exige cambiar el aceite hidráulico cada quinientas horas de operación continua.';

const MATCH_PAIRS = [
  { term: 'Presión', definition: 'Fuerza que el fluido ejerce sobre cada superficie del circuito' },
  { term: 'Caudal', definition: 'Volumen de aceite que circula en un tiempo dado' },
  { term: 'Manómetro', definition: 'Instrumento que indica la fuerza del fluido en un punto' },
  { term: 'Bomba', definition: 'Componente que convierte energía mecánica en flujo de aceite' },
];

function parseId(id) {
  // módulo: M<m>-C<c>-<TAG>-<nn> · final: EF-M<m>-<TAG>-<nn>
  const m = /^(?:EF-M(\d+)|M\d+-C(\d+))-(MC|TF|EM)-(\d+)$/.exec(id);
  if (!m) throw new Error(`fake banco: id con formato inesperado "${id}"`);
  const final = m[1] !== undefined;
  const owner = Number(final ? m[1] : m[2]);
  const type = { MC: 'multichoice', TF: 'truefalse', EM: 'match' }[m[3]];
  const n = Number(m[4]);
  return { final, owner, type, n, k: owner * 1000 + TYPE_IDX[type] * 100 + n + (final ? 500 : 0) };
}

function expandIds(line) {
  const exact = /exactamente estos ids: (.*);/.exec(line);
  if (exact) return [...exact[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const m = /ids "([^"]+)" a "([^"]+)"/.exec(line);
  if (!m) throw new Error(`fake banco: línea de cantidades sin ids: ${line.slice(0, 160)}`);
  const pre = m[1].replace(/\d+$/, '');
  const width = m[1].length - pre.length;
  const a = Number(m[1].slice(pre.length));
  const b = Number(m[2].slice(pre.length));
  const out = [];
  for (let i = a; i <= b; i++) out.push(pre + String(i).padStart(width, '0'));
  return out;
}

/** Bloques de capítulo del prompt: [{ chapterId|null, md }]. */
function chapterBlocks(base) {
  const out = [];
  for (const m of base.matchAll(/<<<CAPITULO(?: chapterId="([^"]+)"[^\n]*)?\n([\s\S]*?)\nCAPITULO>>>/g)) out.push({ chapterId: m[1] || null, md: m[2] });
  return out;
}

function parseBankPrompt(prompt) {
  const lines = prompt.split('\n');
  const taskMarker = lines.find((l) => BANK_MARKERS[l]);
  const repairAt = lines.indexOf(REPAIR_MARKER);
  const isRepair = repairAt >= 0;
  if (!taskMarker) {
    if (isRepair || lines[0] === SOURCE_MARKER) throw new Error('fake banco: prompt de banco sin marcador de tarea');
    return null;
  }
  if (taskMarker !== 'EXAM_BANK_FINAL_MODULE v1' && lines[0] !== SOURCE_MARKER) throw new Error(`fake banco: la fuente del capítulo no va primero (línea 1 "${lines[0]}")`);
  const marker = isRepair ? REPAIR_MARKER : taskMarker;
  const base = prompt;
  const scope = BANK_MARKERS[taskMarker];
  const chm = /Todas las preguntas llevan "chapterId": "([^"]+)"(?: y "moduleId": "([^"]+)")?/.exec(base);
  const mom = /Todas las preguntas llevan "moduleId": "([^"]+)"/.exec(base);
  const blocks = chapterBlocks(base);
  if (!blocks.length) throw new Error('fake banco: el prompt no trae el texto del capítulo (<<<CAPITULO … CAPITULO>>>)');
  let chapters;
  if (chm) {
    if (blocks.length !== 1) throw new Error(`fake banco: ${blocks.length} bloques de capítulo en un prompt de un capítulo`);
    chapters = [{ id: chm[1], md: blocks[0].md }];
  } else {
    if (blocks.some((b) => !b.chapterId)) throw new Error('fake banco: prompt de módulo sin chapterId en un bloque');
    chapters = blocks.map((b) => ({ id: b.chapterId, md: b.md }));
  }
  const moduleId = scope === 'final' ? ((chm && chm[2]) || (mom && mom[1]) || null) : null;
  if (scope === 'final' && !moduleId) throw new Error('fake banco: prompt del examen final sin moduleId');
  const asks = [];
  if (isRepair) {
    const head = lines.slice(repairAt).join('\n');
    for (const m of head.matchAll(/^- id "([^"]+)" \(type "([a-z]+)"[^)]*\) → (.*)$/gm)) asks.push({ id: m[1], type: m[2], reasons: m[3] });
  } else {
    for (const line of base.split('\n')) {
      const t = /^- type "([a-z]+)" .*EXACTAMENTE (\d+) preguntas/.exec(line);
      if (!t) continue;
      const ids = expandIds(line);
      if (ids.length !== Number(t[2])) throw new Error(`fake banco: la línea pide ${t[2]} preguntas y lista ${ids.length} ids`);
      for (const id of ids) asks.push({ id, type: t[1] });
    }
  }
  if (!asks.length) throw new Error(`fake banco: ${isRepair ? 'reparación' : 'pedido'} sin ids`);
  return { marker, isRepair, scope, chapters, moduleId, asks };
}

/** Evidencia: la primera línea de prosa del capítulo de 40–220 caracteres, copiada TEXTUAL. */
function pickEvidence(md) {
  const line = md.split('\n').map((l) => l.trim()).find((l) => l.length >= 40 && l.length <= 220 && /^[A-ZÁÉÍÓÚÑ]/.test(l) && !/[{}|]/.test(l));
  if (!line) throw new Error('fake banco: el capítulo no tiene una línea de prosa de 40–220 caracteres para la evidencia');
  return line;
}

function makeQuestion(ask, ch, scope, moduleId, fault) {
  const p = parseId(ask.id);
  if (p.type !== ask.type) throw new Error(`fake banco: id ${ask.id} no es de tipo ${ask.type}`);
  if (p.final !== (scope === 'final')) throw new Error(`fake banco: id ${ask.id} fuera del alcance ${scope}`);
  const [w1, w2, w3, w4, w5] = words(p.k);
  const where = scope === 'final' ? `Evaluación integradora, orden ${p.k}` : `Faena ${w4}, orden ${p.k}`;
  const q = { id: ask.id, type: ask.type, chapterId: ch.id };
  if (scope === 'final') q.moduleId = moduleId;
  q.level = p.n % 3 === 0 ? 'recordar' : p.n % 3 === 1 ? 'aplicar' : 'analizar';
  q.evidence = fault === 'evidence' ? FAULT_EVIDENCE : pickEvidence(ch.md);
  if (ask.type === 'multichoice') {
    const [correct, ds] = MC_T[p.k % MC_T.length];
    q.stem = `${where}: en la ${w1}, ${w2} atiende el ${w3} de ${w4} con ${w5} y nota una respuesta lenta del circuito. ¿Qué debe hacer primero?`;
    q.explanation = 'Antes de intervenir se mide y se compara con la especificación: la lectura objetiva separa una falla real de una impresión del turno.';
    q.correct = { text: fault === 'short' ? MC_T[0][0] : correct, why: 'Es la acción que se apoya en una medición antes de decidir.' };
    q.distractors = (fault === 'short' ? FAULT_SHORT_DISTRACTORS : ds).map((text) => ({ text, why: MC_WHY }));
  } else if (ask.type === 'truefalse') {
    const forced = /debe ser answer: (true|false)/.exec(ask.reasons || '');
    q.answer = forced ? forced[1] === 'true' : p.n % 2 === 1;
    q.stem = q.answer
      ? `${where}: en la ${w1}, ${w2} confirma que la presión del ${w3} de ${w4} debe medirse antes de intervenir, aun con ${w5}.`
      : `${where}: en la ${w1}, ${w2} afirma que la presión del ${w3} de ${w4} puede estimarse a ojo, sin manómetro, si hay ${w5}.`;
    q.explanation = 'La presión se mide con un instrumento calibrado antes de intervenir; estimarla a ojo lleva a diagnósticos equivocados.';
    q.whyWrong = q.answer ? 'Quien marca falso cree que basta la impresión del operador.' : 'Quien marca verdadero confía en una estimación sin instrumento.';
  } else {
    q.stem = `${where}: en la ${w1}, ${w2} repasa con su equipo del ${w3} de ${w4} los conceptos del circuito antes de la ronda con ${w5}.`;
    q.explanation = 'Cada concepto del circuito tiene un significado preciso: confundirlos lleva a medir o registrar el dato equivocado.';
    q.pairs = MATCH_PAIRS.map((x) => ({ ...x }));
  }
  return q;
}

/** A1: proyección al contrato (3 distractores) + validateExamBank de B2 con el Markdown del capítulo. */
function assertContract(contract, parsed, qs, faults) {
  const examModule = parsed.scope === 'module' ? '00000000-0000-4000-8000-0000000b6000' : null;
  const chapters = parsed.chapters.map((c) => ({ id: c.id, moduleId: parsed.scope === 'final' ? parsed.moduleId : examModule }));
  const chapterMd = new Map(parsed.chapters.map((c) => [c.id, c.md]));
  const projected = qs.map((q) => (q.type === 'multichoice' ? { ...q, distractors: q.distractors.slice(0, 3) } : q));
  const r = contract.validateExamBank({ questions: projected }, { scope: parsed.scope, chapters, chapterMd });
  const perQ = new Map();
  for (const e of r.errors) {
    const m = /^\$\.questions\[(\d+)\]/.exec(e.path);
    if (!m) continue; // reglas de banco (conteo por hoja, balance V/F, % de «correcta más larga»): aplican al banco completo, no a una parte
    const id = qs[Number(m[1])].id;
    if (!perQ.has(id)) perQ.set(id, new Set());
    perQ.get(id).add(e.code);
  }
  const bad = [];
  for (const q of qs) {
    const got = [...(perQ.get(q.id) || [])].sort();
    const want = faults[q.id] ? [faults[q.id]] : [];
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${q.id}: códigos ${JSON.stringify(got)} (se esperaba ${JSON.stringify(want)})`);
  }
  if (bad.length) throw new Error(`fake banco: desvío del contrato B2 (validateExamBank): ${bad.join('; ')}`);
}

/**
 * contract = módulo compilado course-shell/exam-bank.js (validateExamBank).
 * hooks = { rec(kind, id, extra), once(kind), st } del LLM falso v3.
 * Devuelve respond(prompt) → { text } | null (no es un prompt de banco).
 */
function createExamBankFake({ contract, rec, once, st }) {
  st.examBank = st.examBank || { prompts: 0, repairs: [], faults: [], blockShapes: [] };
  // blocks: contenido del mensaje tal como llegó (bloques de texto con cache_control) o null si era texto.
  return function respondBank(prompt, blocks) {
    const parsed = parseBankPrompt(prompt);
    if (!parsed) return null;
    st.examBank.blockShapes.push(Array.isArray(blocks) ? blocks.map((b) => (b && b.cache_control ? b.cache_control.type : null)) : null);
    if (!contract || typeof contract.validateExamBank !== 'function') throw new Error('fake banco: falta el contrato B2 (validateExamBank) para validar las respuestas');
    const retry = /TU RESPUESTA ANTERIOR NO SE PUDO USAR/.test(prompt);
    const faults = {};
    // Falla UNA vez por corrida: primer pedido (no reparación ni reintento) de un examen de módulo con ≥ 4 MC
    // (más fallas que la holgura de la hoja: si no, el ejecutor las absorbe sin reparar).
    const mcIds = parsed.asks.filter((a) => a.type === 'multichoice').map((a) => a.id);
    if (!parsed.isRepair && !retry && parsed.scope === 'module' && mcIds.length >= 4 && once('exam_bank')) {
      faults[mcIds[0]] = 'EXAM_BANK_LENGTH_BIAS';
      faults[mcIds[1]] = 'EXAM_BANK_EVIDENCE';
      faults[mcIds[2]] = 'EXAM_BANK_EVIDENCE';
      faults[mcIds[3]] = 'EXAM_BANK_EVIDENCE';
    }
    // Pedido de un capítulo: todas al mismo; prompt de módulo (F1): reparto en ronda entre sus capítulos.
    const qs = parsed.asks.map((a, i) => {
      const ch = parsed.chapters[i % parsed.chapters.length];
      const fault = faults[a.id] === 'EXAM_BANK_LENGTH_BIAS' ? 'short' : faults[a.id] === 'EXAM_BANK_EVIDENCE' ? 'evidence' : null;
      return makeQuestion(a, ch, parsed.scope, parsed.moduleId, fault);
    });
    assertContract(contract, parsed, qs, faults);
    const chapterId = parsed.chapters[0].id;
    st.examBank.prompts++;
    if (parsed.isRepair) {
      st.retriesSeen.exam_bank = (st.retriesSeen.exam_bank || 0) + 1;
      st.examBank.repairs.push({ chapterId, ids: parsed.asks.map((a) => a.id), reasons: parsed.asks.map((a) => a.reasons) });
      rec('exam_bank_repair', chapterId, { scope: parsed.scope, ids: parsed.asks.map((a) => a.id) });
    } else {
      const ids = Object.keys(faults);
      if (ids.length) st.examBank.faults.push({ chapterId, faults });
      rec(parsed.scope === 'final' ? 'final_exam_bank' : 'exam_bank', chapterId, { invalid: ids.length > 0, faults: ids.length ? faults : undefined, retry, count: qs.length });
    }
    // JSON minificado, como pide el prompt.
    return { text: JSON.stringify({ questions: qs }) };
  };
}

module.exports = { createExamBankFake, parseBankPrompt, BANK_MARKERS, REPAIR_MARKER, SOURCE_MARKER };
