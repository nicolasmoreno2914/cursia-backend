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
// Los textos de intros y experiencia NO llevan dígitos ni marcadores con UUID
// (las reglas v3 los prohíben): la identidad por UUID se verifica por el
// idnumber cv3:… del paquete y por los artifacts de cada item run.
'use strict';

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
  { author: 'Parker Hannifin', title: 'Tecnología hidráulica industrial', year: 2018, publisher: 'Parker Hannifin' },
  { author: 'Eaton Vickers', title: 'Manual de hidráulica industrial', year: 2010, publisher: 'Eaton' },
  { author: 'Antonio Creus Solé', title: 'Neumática e hidráulica', year: 2011, publisher: 'Marcombo' },
  { author: 'Werner Deppert y Kurt Stoll', title: 'Aplicaciones de la neumática', year: 2001, publisher: 'Marcombo' },
  { author: 'Antonio Serrano Nicolás', title: 'Oleohidráulica', year: 2002, publisher: 'McGraw-Hill' },
];

function courseIntro() {
  return {
    schemaVersion: 1,
    welcome: words(120, 0),
    competencies: [
      'Reconoce el comportamiento del aceite bajo presión en equipos de planta.',
      'Selecciona el procedimiento de inspección adecuado para cada componente.',
      'Registra observaciones técnicas con precisión y lenguaje claro.',
      'Coordina con su equipo una intervención segura antes de actuar.',
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
        { type: 'concept_cards', cards: [{ term: 'Presión', definition: 'Fuerza que el fluido ejerce sobre cada superficie del circuito.' }, { term: 'Caudal', definition: 'Volumen de aceite que circula en un tiempo dado.' }] },
        { type: 'accordion', items: [{ heading: 'Señales tempranas', body: 'Ruido anormal, temperatura elevada y respuesta lenta de los actuadores.' }, { heading: 'Consecuencias', body: 'Desgaste acelerado, fugas y detenciones no programadas.' }] },
      ],
      synthesis: [{ type: 'summary_visual', central: 'Criterio técnico', points: ['Observa antes de intervenir.', 'Registra lo que ves.', 'Decide con tu equipo.'] }],
      closing: [{ type: 'reflection', prompt: '¿Qué señal de tu equipo pasarías por alto si trabajaras con prisa?' }],
      video_primer: [{ type: 'callout', variant: 'info', body: 'Fíjate en cómo cambia la respuesta del sistema cuando aumenta la carga.' }],
      self_check: [{ type: 'self_check', items: [{ q: '¿Qué indica una temperatura elevada del aceite?', a: 'Pérdidas internas o un enfriamiento insuficiente del circuito.' }, { q: '¿Por qué se registra cada observación?', a: 'Porque permite comparar el estado del equipo en el tiempo.' }] }],
    },
    bridge_to_next: 'Con esta base, el siguiente paso es aplicar el mismo criterio a un caso nuevo.',
  };
}
function interactions(indices) {
  return {
    checkpoints: indices.map((index, i) => (i % 2 === 0
      ? { index, kind: 'multichoice', question: '¿Qué señal indica una pérdida de presión en este tramo?', answers: [{ text: 'Respuesta lenta del actuador', correct: true }, { text: 'Color de la pintura', correct: false }, { text: 'Marca del filtro', correct: false }], feedbackCorrect: 'Exacto: la respuesta lenta es la primera señal.', feedbackIncorrect: 'Revisa cómo responde el actuador bajo carga.' }
      : { index, kind: 'truefalse', question: 'Registrar la temperatura ayuda a anticipar fallas.', correct: true, feedbackCorrect: 'Correcto: la tendencia anticipa la falla.', feedbackIncorrect: 'Sí ayuda: la tendencia anticipa la falla.' })),
  };
}
// Respuestas correctas conocidas (las usa el QA de navegador para responder en el reproductor real).
const H5P = {
  questionset: {
    title: 'Comprueba tu comprensión',
    questions: [
      { kind: 'multichoice', question: '¿Qué mide un manómetro en el circuito?', answers: [{ text: 'La presión del fluido', correct: true, feedback: 'Bien.' }, { text: 'El caudal del fluido', correct: false }, { text: 'La viscosidad', correct: false }, { text: 'La temperatura', correct: false }] },
      { kind: 'multichoice', question: '¿Qué componente genera el caudal?', answers: [{ text: 'La bomba', correct: true }, { text: 'El filtro', correct: false }, { text: 'El estanque', correct: false }, { text: 'La manguera', correct: false }] },
      { kind: 'multichoice', question: '¿Qué indica un aceite oscuro y con olor a quemado?', answers: [{ text: 'Degradación térmica', correct: true }, { text: 'Aceite nuevo', correct: false }, { text: 'Nivel correcto', correct: false }, { text: 'Filtro limpio', correct: false }] },
      { kind: 'truefalse', question: 'El bloqueo de energía se aplica antes de intervenir.', correct: true, feedbackCorrect: 'Sí.', feedbackWrong: 'Siempre se bloquea antes.' },
      { kind: 'truefalse', question: 'Una fuga pequeña nunca afecta la presión del sistema.', correct: false, feedbackCorrect: 'Correcto.', feedbackWrong: 'Toda fuga afecta la presión.' },
    ],
  },
  dragtext: { title: 'Completa el concepto', taskDescription: 'Arrastra cada término a su lugar.', text: 'La *bomba* genera el caudal, la *válvula* dirige el flujo, el *cilindro* entrega movimiento lineal y el *filtro* retiene partículas.' },
  blanks: { title: 'Completa las frases', text: 'Escribe la palabra que falta.', questions: ['La bomba genera el *caudal*.', 'El manómetro mide la *presión*.', 'El filtro retiene *partículas*.', 'Antes de intervenir se aplica el *bloqueo*.'] },
};
const INVALID = {
  experience: (id, title) => { const e = experience(id, title); e.movements.opening[0].lead = 'Mira el video y luego resuelve la actividad interactiva.'; return e; },
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

function createLlmV3({ base, chapterIdFromText }) {
  const st = base.st;
  st.v3calls = st.v3calls || [];
  st.invalidSent = st.invalidSent || {}; // kind → número de respuestas inválidas enviadas
  st.retriesSeen = st.retriesSeen || {}; // kind → prompts de reintento recibidos
  function rec(kind, id, extra) { st.v3calls.push({ kind, id, tag: st.tag, ...(extra || {}) }); st.calls.push({ kind, id, tag: st.tag }); }
  function once(kind) { if (st.invalidSent[kind]) return false; st.invalidSent[kind] = 1; return true; }
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
        rec('video_interactions', id, { invalid: bad, retry, checkpoints: indices.length });
        return J(bad ? INVALID.video_interactions(indices) : interactions(indices));
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
