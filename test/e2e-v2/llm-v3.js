// V2.1 R13 — LLM falso determinístico para los tipos LLM de rulesVersion 3
// (experience, course_intro/module_intro JSON, video_interactions, activity
// h5p por tipo derivado del UUID, final_exam GIFT). Envuelve al LLM falso v2
// (llm.js: course_plan, content, exam de módulo, salas SCORM) y responde el
// resto con salidas VÁLIDAS para los validadores del cliente (45) y del
// servidor (R11a).
//
// Una respuesta INVÁLIDA por tipo, UNA sola vez en toda la corrida (primer
// prompt de ese tipo), para probar el reintento dirigido (validation_retry) o,
// en el examen final, la llamada de corrección (continuation). Todo lo demás es
// válido a la primera.
//
// EV6 P2-B6: los BANCOS de preguntas (modo banco del ejecutor, prompts EXAM_BANK_* v1) los
// responde llm-exam-bank.js (falla inyectada una vez → una reparación; cada respuesta validada
// contra validateExamBank de B2 antes de salir). Las ramas GIFT de abajo siguen para los cursos
// que corren con el modo banco apagado (E2, E4).
//
// EV6 H5P v2 (H4): con `h5p2` (fixtures del frontend H3, fixtures/h5p2/fake-llm-h5p2.json) responde
// el CASO RAMIFICADO (primera respuesta con BS_FORWARD_ONLY → reintento dirigido → válida) y, en el
// prompt v2 de video_interactions («PAUSAS PARA PENSAR (fijas»), agrega `reflections` (una por línea
// «- reflexión index N:»).
//
// Los textos de intros y experiencia NO llevan dígitos ni marcadores con UUID
// (las reglas v3 los prohíben): la identidad por UUID se verifica por el
// idnumber cv3:… del paquete y por los artifacts de cada item run.
'use strict';

const { createExamBankFake } = require('./llm-exam-bank');

const RETRY_MARK = 'TU RESPUESTA ANTERIOR FUE RECHAZADA';

function words(n, seed) {
  const base = ('La hidráulica móvil exige criterio técnico en cada intervención de mantenimiento. ' +
    'En faenas del norte de Chile el polvo, el calor y los turnos largos ponen a prueba cada componente. ' +
    'Vas a reconocer cómo se comporta el aceite bajo presión, cómo se degrada y qué señales anticipan una falla. ' +
    'Aprenderás a leer un circuito, a registrar lo que observas y a decidir con tu equipo antes de intervenir. ' +
    'Cada tema se apoya en situaciones reales de planta y en decisiones que tomas a diario. ' +
    'El objetivo es que trabajes con seguridad, que cuides los equipos y que expliques lo que haces con palabras simples.').split(/\s+/);
  const out = [];
  for (let i = 0; i < n; i++) out.push(base[(i + (seed || 0)) % base.length]);
  let s = out.join(' ');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.replace(/[.,;]?$/, '.');
}

const BIB = [
  // R14: el Libro publica solo obras del catálogo verificado (package/v3/verified-bibliography.ts).
  { author: 'Hattie, John', title: 'Visible Learning: A Synthesis of Over 800 Meta-Analyses Relating to Achievement', year: 2009, publisher: 'Routledge' },
  { author: 'Wiggins, Grant y McTighe, Jay', title: 'Understanding by Design (2.ª ed.)', year: 2005, publisher: 'ASCD' },
  { author: 'Biggs, John y Tang, Catherine', title: 'Teaching for Quality Learning at University: What the Student Does (4.ª ed.)', year: 2011, publisher: 'Open University Press' },
  { author: 'Mayer, Richard E.', title: 'Multimedia Learning (2.ª ed.)', year: 2009, publisher: 'Cambridge University Press' },
  { author: 'Kolb, David A.', title: 'Experiential Learning: Experience as the Source of Learning and Development', year: 1984, publisher: 'Prentice Hall' },
];

function courseIntro() {
  return {
    schemaVersion: 1,
    welcome: words(120, 0),
    competencies: [
      'Reconocer el comportamiento del aceite bajo presión en equipos de planta.',
      'Seleccionar el procedimiento de inspección adecuado para cada componente.',
      'Registrar observaciones técnicas con precisión y lenguaje claro.',
      'Coordinar con el equipo una intervención segura antes de actuar.',
    ],
    methodology_note: 'Estudia cada tema con ejemplos de tu propia faena y anota las decisiones que tomarías en terreno.',
    closing: 'Tu criterio técnico es la mejor herramienta de mantenimiento que puedes llevar a la planta.',
    bibliography: BIB.map((b) => ({ ...b })),
  };
}
function moduleIntro(chapterIds) {
  return {
    schemaVersion: 1,
    presentation: 'En esta parte del curso conectas los fundamentos con las decisiones de mantenimiento que tomas a diario en una faena minera del norte de Chile.',
    outcomes: ['Explicar el comportamiento del sistema con tus propias palabras.', 'Aplicar criterios de inspección en terreno.', 'Decidir con tu equipo cuándo intervenir.'],
    journey: chapterIds.map((id) => ({ chapterId: id, line: 'Construye sobre lo anterior con un enfoque práctico de planta.' })),
    bibliography: BIB.slice(0, 2).map((b) => ({ ...b })),
  };
}
// EV6: los capítulos alternan (en orden de primera generación) un flujo y un árbol de decisión, así el
// E2E lleva ambos por generación → validación → empaque → restauración en Moodle real.
const DIAGRAM_KIND_BY_CHAPTER = new Map();
function diagramFor(chapterId) {
  if (!DIAGRAM_KIND_BY_CHAPTER.has(chapterId)) DIAGRAM_KIND_BY_CHAPTER.set(chapterId, DIAGRAM_KIND_BY_CHAPTER.size % 2 === 0 ? 'decision' : 'flow');
  if (DIAGRAM_KIND_BY_CHAPTER.get(chapterId) === 'decision') {
    return {
      type: 'diagram',
      kind: 'decision',
      title: 'Qué hacer ante un ruido anormal',
      tree: {
        question: '¿La presión está dentro de la especificación?',
        yes: { tree: { question: '¿La temperatura del aceite es normal?', yes: { action: 'Registra la observación y sigue operando.' }, no: { label: 'Alta', action: 'Revisa el enfriador y el nivel de aceite.' } } },
        no: { action: 'Detén el equipo y revisa la bomba antes de volver a operar.' },
      },
    };
  }
  return { type: 'diagram', kind: 'flow', title: 'Del síntoma a la decisión', nodes: [{ label: 'Observar el síntoma', detail: 'Ruido, temperatura o respuesta lenta.' }, { label: 'Medir presión y caudal' }, { label: 'Comparar con la especificación' }, { label: 'Decidir la intervención' }] };
}
function experience(chapterId, title) {
  return {
    vcSchemaVersion: 1,
    chapterId,
    movements: {
      opening: [
        { type: 'hero', title: title.slice(0, 80), lead: 'Lo que ocurre dentro de un circuito cerrado define si un equipo trabaja seguro o si falla en plena operación.' },
        { type: 'learning_objectives', items: ['Explicar el fenómeno central de este tema.', 'Relacionar lo observado en terreno con una decisión de **mantenimiento**.'] },
      ],
      deepening: [
        // P3 (prompt v21-exp-6): «por qué importa» / «cómo lo aplicas» en al menos 2 bloques; el E2E los restaura en Moodle real.
        { type: 'concept_cards', why: 'Nombrar bien lo que ves te deja explicar una falla sin ambigüedad.', apply: 'Anota la presión y el caudal en tu próxima ronda de inspección.', cards: [{ term: 'Presión', definition: 'Fuerza que el fluido ejerce sobre cada superficie del circuito.' }, { term: 'Caudal', definition: 'Volumen de aceite que circula en un tiempo dado.' }] },
        { type: 'accordion', items: [{ heading: 'Señales tempranas', body: 'Ruido anormal, temperatura elevada y respuesta lenta de los actuadores.' }, { heading: 'Consecuencias', body: 'Desgaste acelerado, fugas y detenciones no programadas.' }] },
        // Edu Phase A: el E2E restaura en Moodle real un ejemplo resuelto (con datos ilustrativos) y un diagrama.
        { type: 'worked_example', why: 'Volver a operar una bomba que no cumple acelera el desgaste de todo el circuito.', apply: 'Repite el cálculo con los datos de placa de una bomba de tu planta.', title: 'Estimar el caudal que entrega una bomba', situation: 'Un técnico debe confirmar si la bomba de un circuito entrega el caudal que pide el fabricante antes de volver a operar.', data: ['Desplazamiento de la bomba: 20 cm³ por vuelta', 'Velocidad del motor: 1.500 rpm', 'Eficiencia volumétrica: 90 %'], steps: [{ action: 'Calcula el caudal teórico', detail: '20 cm³ × 1.500 rpm = 30.000 cm³ por minuto, es decir 30 litros por minuto.' }, { action: 'Aplica la eficiencia', detail: '30 litros por minuto × 0,90 = 27 litros por minuto reales.' }, { action: 'Compara con la especificación', detail: 'Si el fabricante pide 25 litros por minuto, la bomba cumple con margen.' }], result: 'La bomba entrega 27 litros por minuto reales: cumple la especificación y puede volver a operar.', takeaway: 'Nunca compares el caudal teórico con la especificación sin aplicar la eficiencia.' },
        diagramFor(chapterId),
      ],
      synthesis: [{ type: 'summary_visual', central: 'Criterio técnico', points: ['Observa antes de intervenir.', 'Registra lo que ves.', 'Decide con tu equipo.'] }],
      closing: [{ type: 'reflection', prompt: '¿Qué señal de tu equipo pasarías por alto si trabajaras con prisa?' }],
      video_primer: [{ type: 'callout', variant: 'info', body: 'Fíjate en cómo cambia la respuesta del sistema cuando aumenta la carga.' }],
      self_check: [{ type: 'self_check', items: [{ q: '¿Qué indica una temperatura elevada del aceite?', a: 'Pérdidas internas o un enfriamiento insuficiente del circuito.' }, { q: '¿Por qué se registra cada observación?', a: 'Porque permite comparar el estado del equipo en el tiempo.' }] }],
    },
    bridge_to_next: 'Con esta base, el siguiente paso es aplicar el mismo criterio a un caso nuevo.',
  };
}
// #542 (I1, FE fix/v542-fe): V/F alternados empezando por el valor que pide el prompt («la PRIMERA afirmación
// truefalse es VERDADERA|FALSA») y un distractor tan largo como la correcta: sin esto, el lint de sesgo del
// cliente pide un reintento dirigido más por item (retriesSeen.video_interactions > 1).
function interactions(indices, firstTrue) {
  let tf = 0;
  return {
    checkpoints: indices.map((index, i) => (i % 2 === 0
      ? { index, kind: 'multichoice', question: '¿Qué señal indica una pérdida de presión en este tramo?', answers: [{ text: 'Respuesta lenta del actuador', correct: true }, { text: 'Color de la pintura del equipo', correct: false }, { text: 'Marca del filtro', correct: false }], feedbackCorrect: 'Exacto: la respuesta lenta es la primera señal.', feedbackIncorrect: 'Revisa cómo responde el actuador bajo carga.' }
      : { index, kind: 'truefalse', question: 'Registrar la temperatura ayuda a anticipar fallas.', correct: (tf++ % 2 === 0) === (firstTrue !== false), feedbackCorrect: 'Correcto: la tendencia anticipa la falla.', feedbackIncorrect: 'Sí ayuda: la tendencia anticipa la falla.' })),
  };
}
// Respuestas correctas conocidas (las usa el QA de navegador para responder en el reproductor real).
const H5P = {
  questionset: {
    title: 'Comprueba tu comprensión',
    questions: [
      { kind: 'multichoice', question: '¿Qué mide un manómetro en el circuito?', answers: [{ text: 'La presión del fluido', correct: true, feedback: 'Bien.' }, { text: 'El caudal total del fluido', correct: false }, { text: 'La viscosidad', correct: false }, { text: 'La temperatura', correct: false }] },
      { kind: 'multichoice', question: '¿Qué componente genera el caudal?', answers: [{ text: 'La bomba', correct: true }, { text: 'El filtro', correct: false }, { text: 'El estanque', correct: false }, { text: 'La manguera', correct: false }] },
      { kind: 'multichoice', question: '¿Qué indica un aceite oscuro y con olor a quemado?', answers: [{ text: 'Degradación térmica', correct: true }, { text: 'Aceite nuevo', correct: false }, { text: 'Nivel correcto del aceite', correct: false }, { text: 'Filtro limpio', correct: false }] },
      { kind: 'truefalse', question: 'El bloqueo de energía se aplica antes de intervenir.', correct: true, feedbackCorrect: 'Sí.', feedbackWrong: 'Siempre se bloquea antes.' },
      { kind: 'truefalse', question: 'Una fuga pequeña nunca afecta la presión del sistema.', correct: false, feedbackCorrect: 'Correcto.', feedbackWrong: 'Toda fuga afecta la presión.' },
    ],
  },
  dragtext: { title: 'Completa el concepto', taskDescription: 'Arrastra cada término a su lugar.', text: 'La *bomba* genera el caudal, la *válvula* dirige el flujo, el *cilindro* entrega movimiento lineal y el *filtro* retiene partículas.' },
  blanks: { title: 'Completa las frases', text: 'Escribe la palabra que falta.', questions: ['La bomba genera el *caudal*.', 'El manómetro mide la *presión*.', 'El filtro retiene *partículas*.', 'Antes de intervenir se aplica el *bloqueo*.'] },
};
const INVALID = {
  // Calibración #2: la experience repara sola violaciones en movimientos con margen (autoRepairs); la
  // inválida va en synthesis (sin margen) para seguir ejercitando el reintento dirigido.
  experience: (id, title) => { const e = experience(id, title); e.movements.synthesis[0].central = 'Mira el video y resuelve la actividad interactiva.'; return e; },
  course_intro: () => { const c = courseIntro(); c.welcome = `Este curso tiene 3 módulos y 12 capítulos. ${c.welcome}`; return c; },
  module_intro: (ids) => { const m = moduleIntro(ids); m.journey = m.journey.slice(1); return m; },
  video_interactions: (indices) => interactions(indices.slice(0, Math.max(1, indices.length - 1))),
  questionset: () => { const q = JSON.parse(JSON.stringify(H5P.questionset)); q.questions = q.questions.slice(0, 1); return q; },
  dragtext: () => ({ ...H5P.dragtext, text: 'Un texto sin ningún hueco marcado.' }),
  blanks: () => ({ ...H5P.blanks, questions: ['La velocidad se mide en *km/h*.'] }),
};

function giftBlocks(prefix, from, split, typesOnly) {
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  const out = [];
  let id = from;
  const want = typesOnly || split;
  for (let i = 0; i < (want.multichoice || 0); i++) out.push(`::${prefix}-${pad(id++)}:: ¿Qué práctica de mantenimiento corresponde a la situación ${i + 1} de la faena? {\n =Registrar y bloquear antes de intervenir\n ~Intervenir sin registrar nada\n ~Esperar a que el equipo falle\n ~Cambiar piezas al azar\n}`);
  for (let i = 0; i < (want.truefalse || 0); i++) out.push(`::${prefix}-${pad(id++)}:: El análisis de aceite permite anticipar fallas en la situación ${i + 1}. {${i % 2 ? 'FALSE' : 'TRUE'}}`);
  for (let i = 0; i < (want.match || 0); i++) out.push(`::${prefix}-${pad(id++)}:: Relaciona cada componente con su función (grupo ${i + 1}). {\n =Bomba -> Genera caudal\n =Válvula -> Dirige el flujo\n =Cilindro -> Movimiento lineal\n =Filtro -> Retiene partículas\n}`);
  return out.join('\n\n');
}

// examBankContract: módulo compilado course-shell/exam-bank.js (validateExamBank) para validar las
// respuestas de banco ANTES de devolverlas (A1 de P2-B6).
function createLlmV3({ base, chapterIdFromText, examBankContract, h5p2 }) {
  const st = base.st;
  st.v3calls = st.v3calls || [];
  st.invalidSent = st.invalidSent || {}; // kind → número de respuestas inválidas enviadas
  st.retriesSeen = st.retriesSeen || {}; // kind → prompts de reintento recibidos
  function rec(kind, id, extra) { st.v3calls.push({ kind, id, tag: st.tag, ...(extra || {}) }); st.calls.push({ kind, id, tag: st.tag }); }
  function once(kind) { if (st.invalidSent[kind]) return false; st.invalidSent[kind] = 1; return true; }
  const respondBank = createExamBankFake({ contract: examBankContract, rec, once, st });
  function chapterFromContent(prompt) {
    const m = /MARKCH-([0-9a-f-]{36})-/.exec(prompt);
    if (!m) throw new Error('fake LLM v3: el prompt no trae el contenido del capítulo con su marcador');
    return m[1];
  }

  function respond(body) {
    const prompt = String((body.messages && body.messages[0] && body.messages[0].content) || '');
    const hasSchema = !!(body.output_config && body.output_config.format);
    if (hasSchema) return base.respond(body);
    const retry = prompt.indexOf(RETRY_MARK) >= 0;
    const J = (o) => ({ text: JSON.stringify(o) });
    try {
      // Bancos de preguntas (marcador en la 1.ª línea): antes que cualquier otra rama (el prompt trae
      // <<<CAPITULO, que el LLM v2 tomaría por un reintento del sidecar).
      const bank = respondBank(prompt);
      if (bank) return bank;
      if (prompt.indexOf('Genera la EXPERIENCIA del capítulo') >= 0) {
        const title = (/CAPÍTULO: "([^"]*)"/.exec(prompt) || [])[1] || '';
        const id = st.chapterByTitle.get(title) || chapterFromContent(prompt);
        if (retry) st.retriesSeen.experience = (st.retriesSeen.experience || 0) + 1;
        const bad = !retry && once('experience');
        rec('experience', id, { invalid: bad, retry });
        return J(bad ? INVALID.experience(id, title) : experience(id, title));
      }
      if (prompt.indexOf('Puntos de pausa (fijos') >= 0) {
        const id = chapterFromContent(prompt);
        const indices = [...prompt.matchAll(/^- index (\d+) \(segundo/gm)].map((m) => Number(m[1]));
        if (retry) st.retriesSeen.video_interactions = (st.retriesSeen.video_interactions || 0) + 1;
        const bad = !retry && once('video_interactions');
        // EV6 IV avanzado (v2): una reflexión por cada pausa planificada que trae el prompt.
        const v2 = !!(h5p2 && prompt.indexOf(h5p2.markers.videoInteractionsV2Prompt) >= 0);
        const reflIdx = v2 ? [...prompt.matchAll(new RegExp(h5p2.markers.reflectionLineRegex, 'gm'))].map((m) => Number(m[1])) : [];
        rec(v2 ? 'video_interactions_v2' : 'video_interactions', id, { invalid: bad, retry, checkpoints: indices.length, reflections: reflIdx.length });
        const doc = bad ? INVALID.video_interactions(indices) : interactions(indices, !/la PRIMERA afirmación truefalse es FALSA/.test(prompt));
        if (v2 && reflIdx.length) {
          const R = h5p2.videoInteractionsV2.reflections;
          doc.reflections = reflIdx.map((index, i) => ({ index, ...R[i % R.length] }));
        }
        return J(doc);
      }
      // EV6 H5P v2: caso ramificado (marcador del prompt de H3). Inválido UNA vez (BS_FORWARD_ONLY).
      if (h5p2 && prompt.indexOf(h5p2.markers.branchingScenarioPrompt) >= 0) {
        const id = chapterFromContent(prompt);
        const k = 'h5p_branchingscenario';
        if (retry) st.retriesSeen[k] = (st.retriesSeen[k] || 0) + 1;
        const bad = !retry && once(k);
        rec(k, id, { invalid: bad, retry });
        const doc = JSON.parse(JSON.stringify(h5p2.branchingScenario.valid));
        if (bad) {
          const { path: pth, value } = h5p2.branchingScenario.invalidForwardOnly.patch;
          let o = doc;
          for (const seg of pth.slice(0, -1)) o = o[seg];
          o[pth[pth.length - 1]] = value;
        }
        return J(doc);
      }
      const h5pType = prompt.indexOf('Genera un CUESTIONARIO de comprensión') >= 0 ? 'questionset'
        : prompt.indexOf('Genera un ejercicio de ARRASTRAR PALABRAS') >= 0 ? 'dragtext'
          : prompt.indexOf('Genera un ejercicio de COMPLETAR FRASES') >= 0 ? 'blanks' : null;
      if (h5pType) {
        const id = chapterFromContent(prompt);
        const k = `h5p_${h5pType}`;
        if (retry) st.retriesSeen[k] = (st.retriesSeen[k] || 0) + 1;
        const bad = !retry && once(k);
        rec(k, id, { invalid: bad, retry });
        return J(bad ? INVALID[h5pType]() : JSON.parse(JSON.stringify(H5P[h5pType])));
      }
      if (prompt.indexOf('Genera la INTRODUCCIÓN GENERAL') >= 0 && prompt.indexOf('"schemaVersion": 1') >= 0) {
        if (retry) st.retriesSeen.course_intro = (st.retriesSeen.course_intro || 0) + 1;
        const bad = !retry && once('course_intro');
        rec('course_intro_v3', String(st.courseId), { invalid: bad, retry });
        return J(bad ? INVALID.course_intro() : courseIntro());
      }
      if (prompt.indexOf('Genera la PRESENTACIÓN del módulo "') >= 0) {
        const title = (/Genera la PRESENTACIÓN del módulo "([^"]*)"/.exec(prompt) || [])[1];
        const id = st.moduleByTitle.get(title);
        if (!id) throw new Error(`fake LLM v3: módulo desconocido "${title}"`);
        const chapterIds = [...prompt.matchAll(/\[chapterId: ([0-9a-f-]{36})\]/g)].map((m) => m[1]);
        if (retry) st.retriesSeen.module_intro = (st.retriesSeen.module_intro || 0) + 1;
        const bad = !retry && once('module_intro');
        rec('module_intro_v3', id, { invalid: bad, retry });
        return J(bad ? INVALID.module_intro(chapterIds) : moduleIntro(chapterIds));
      }
      if (prompt.indexOf('Examen FINAL del curso') >= 0) {
        const m = /\n(\d+) PREGUNTAS distribuidas así:\n- (\d+) selección múltiple[^\n]*\n- (\d+) Verdadero\/Falso[^\n]*\n- (\d+) emparejamiento/.exec(prompt);
        if (!m) throw new Error('fake LLM v3: prompt de examen final sin reparto');
        const split = { multichoice: Number(m[2]), truefalse: Number(m[3]), match: Number(m[4]) };
        // Inválido una vez: faltan los emparejamientos → el ejecutor pide la corrección (continuation).
        const bad = once('final_exam');
        rec('final_exam', String(st.courseId), { invalid: bad, split });
        return { text: giftBlocks('EF', 1, split, bad ? { multichoice: split.multichoice, truefalse: split.truefalse, match: 0 } : split) };
      }
      // EV5 (P4): corrección dirigida de preguntas cuya correcta es la opción más larga. Devuelve
      // los mismos ::ID:: y enunciados con opciones de longitud pareja (el ejecutor lo re-valida).
      if (prompt.indexOf('la respuesta correcta (=) es claramente la opción más larga') >= 0) {
        const blocks = [...prompt.matchAll(/::([A-Z0-9-]+)::([^{]*)\{/g)];
        rec('exam_balance', String(st.courseId), { count: blocks.length });
        return { text: blocks.map((b) => `::${b[1]}::${b[2]}{\n =Registrar y bloquear el equipo\n ~Intervenir sin registrar nada\n ~Esperar a que el equipo falle\n ~Cambiar las piezas al azar\n}`).join('\n\n') };
      }
      if (prompt.indexOf('Generaste el examen FINAL de') >= 0) {
        const from = Number((/desde ::EF-(\d+)::/.exec(prompt) || [])[1]);
        const miss = {};
        for (const mm of prompt.matchAll(/^- (\d+) de (selección múltiple|verdadero\/falso|emparejamiento)/gm)) {
          miss[mm[2].startsWith('sel') ? 'multichoice' : mm[2].startsWith('ver') ? 'truefalse' : 'match'] = Number(mm[1]);
        }
        st.retriesSeen.final_exam = (st.retriesSeen.final_exam || 0) + 1;
        rec('final_exam_correction', String(st.courseId), { miss });
        return { text: giftBlocks('EF', from, miss, miss) };
      }
    } catch (e) {
      st.unknown.push(String(e && e.message));
      return { httpStatus: 400, error: String(e && e.message) };
    }
    return base.respond(body);
  }
  return { st, respond, H5P };
}

module.exports = { createLlmV3, H5P_ANSWERS: H5P };
