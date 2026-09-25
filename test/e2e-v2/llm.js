// LLM falso determinístico (responde en el lugar de /api/proxy). Cada salida
// lleva un marcador por UUID + tag de run (A/B) para poder verificar en el
// .mbz y en la DB de Moodle qué contenido vino de qué item/run:
//   MARKCH-<chapterUUID>-<tag>  capítulo (content)       MARKSC-<chapterUUID>-<tag> SCORM
//   MARKEX-<moduleUUID>-<tag>   examen (GIFT)            MARKMI-<moduleUUID>-<tag>  intro de módulo
//   MARKCI-<courseId>-<tag>     intro de curso            MARKBIB-<courseId>-<tag>   bibliografía sugerida
// El título que aparece en el prompt se resuelve a UUID con el mapa que
// mantiene el driver (identidad = UUID; el título solo es la vía de lookup).
'use strict';

function detectScormTemplate(prompt) {
  if (prompt.indexOf('tipo "equipar la escena"') >= 0) return 'equipar_escena';
  if (prompt.indexOf('tipo "decisión con consecuencia"') >= 0) return 'decision_consecuencia';
  if (prompt.indexOf('sopa de letras de práctica') >= 0) return 'sopa_letras';
  if (prompt.indexOf('crucigrama de práctica') >= 0) return 'crucigrama';
  if (prompt.indexOf('ruleta de preguntas de práctica') >= 0) return 'ruleta_preguntas';
  if (prompt.indexOf('árbol corto de decisiones') >= 0) return 'multicamino';
  if (prompt.indexOf('procedimiento real de este capítulo, en su orden correcto') >= 0) return 'armar_proceso';
  return null;
}

function giftBlock(id, type, marker, n) {
  if (type === 'multichoice') return `::${id}:: Pregunta ${n} ${marker}: ¿cuál es la práctica correcta? {\n =Opción correcta ${n}\n ~Opción errónea ${n}a\n ~Opción errónea ${n}b\n ~Opción errónea ${n}c\n}`;
  if (type === 'truefalse') return `::${id}:: Afirmación ${n} ${marker} sobre el mantenimiento. {TRUE}`;
  return `::${id}:: Relaciona los términos ${n} ${marker}. {\n =Bomba -> Genera caudal\n =Válvula -> Controla el flujo\n =Cilindro -> Movimiento lineal\n =Filtro -> Retiene partículas\n}`;
}
function buildGift(split, prefix, startNum, marker) {
  let n = startNum;
  const blocks = [];
  for (let i = 0; i < split.multichoice; i++) { blocks.push(giftBlock(`${prefix}-${String(n).padStart(2, '0')}`, 'multichoice', marker, n)); n++; }
  for (let i = 0; i < split.truefalse; i++) { blocks.push(giftBlock(`${prefix}-${String(n).padStart(2, '0')}`, 'truefalse', marker, n)); n++; }
  for (let i = 0; i < split.match; i++) { blocks.push(giftBlock(`${prefix}-${String(n).padStart(2, '0')}`, 'match', marker, n)); n++; }
  return blocks.join('\n\n');
}

function createLlm({ getFixtures, getSplit }) {
  const st = {
    tag: 'A',
    courseId: null,
    chapterByTitle: new Map(), // título → UUID
    moduleByTitle: new Map(),
    moduleOfChapter: new Map(), // chapter UUID → module UUID
    calls: [],
    unknown: [],
  };
  function rec(kind, id) { st.calls.push({ kind, id, tag: st.tag }); }
  function chapterId(title) {
    const id = st.chapterByTitle.get(title);
    if (!id) throw new Error(`fake LLM: título de capítulo desconocido "${title}"`);
    return id;
  }

  function respond(body) {
    const prompt = String((body.messages && body.messages[0] && body.messages[0].content) || '');
    const hasSchema = !!(body.output_config && body.output_config.format);
    const tag = st.tag;
    try {
      if (hasSchema) {
        const tpl = detectScormTemplate(prompt);
        const m = prompt.match(/Capítulo (\d+): "([^"]*)"/);
        const id = chapterId(m[2]);
        const fx = JSON.parse(JSON.stringify(getFixtures()[tpl]));
        fx.scenario = `${fx.scenario} MARKSC-${id}-${tag}`;
        rec(`scorm_room:${tpl}`, id);
        return { text: JSON.stringify(fx) };
      }
      if (prompt.indexOf('PLAN DE CONCEPTOS DEL CURSO') >= 0) {
        const plan = { modules: {}, chapters: {} };
        const re = /- Módulo (\d+) \[id: ([0-9a-f-]{36})\]: ([^\n]*)|- Capítulo (\d+) \[id: ([0-9a-f-]{36})\]: ([^\n]*)/g;
        let mm;
        while ((mm = re.exec(prompt))) {
          if (mm[2]) plan.modules[mm[2]] = { summary: `Propósito del módulo ${mm[1]}: ${mm[3]} (${tag}).` };
          else plan.chapters[mm[5]] = {
            summary: `El capítulo ${mm[4]} cubre ${mm[6]} y avanza sobre lo anterior (${tag}).`,
            concepts_introduced: [`Concepto clave de ${mm[6]}`, `Práctica de ${mm[6]}`],
            concepts_assumed: [],
            key_terms: [`Término de ${mm[6]}`],
          };
        }
        rec('course_plan', String(st.courseId));
        return { text: JSON.stringify(plan) };
      }
      if (prompt.indexOf('INTRODUCCIÓN GENERAL') >= 0) {
        rec('course_intro', String(st.courseId));
        return { text: `## Introducción\nEste curso forma técnicos de mantenimiento hidráulico. MARKCI-${st.courseId}-${tag}\n\n## Metodología\nLibro guía, juegos interactivos y evaluaciones por módulo.\n\n## Competencias\n- Diagnosticar fallas hidráulicas\n- Planificar el mantenimiento\n\n## Bibliografía sugerida\n- Parker Hannifin (2018). *Tecnología hidráulica industrial*. Parker. MARKBIB-${st.courseId}-${tag}\n- Vickers (2010). *Manual de hidráulica industrial*. Eaton.` };
      }
      if (prompt.indexOf('PRESENTACIÓN del Módulo') >= 0) {
        const m = prompt.match(/PRESENTACIÓN del Módulo (\d+): "([^"]*)"/);
        const id = st.moduleByTitle.get(m[2]);
        if (!id) throw new Error(`fake LLM: módulo desconocido "${m[2]}"`);
        rec('module_intro', id);
        return { text: `## Presentación del módulo\nMódulo ${m[1]}. MARKMI-${id}-${tag}\n\n## Qué vas a lograr\n- Aplicar lo aprendido en planta\n\n## Recorrido\n- Capítulos en orden\n\n## Bibliografía sugerida\n- Esposito, A. (2008). *Hidráulica y neumática*. Pearson.` };
      }
      if (prompt.indexOf('<<<CAPITULO') >= 0) {
        rec('sidecar_retry', null);
        return { text: '```json context_summary\n{"summary":"Resumen por reintento","concepts_introduced":["X"],"key_terms":["Y"]}\n```' };
      }
      if (prompt.indexOf('Genera el CAPÍTULO') >= 0) {
        const m = prompt.match(/Genera el CAPÍTULO (\d+) COMPLETO: "([^"]*)"/);
        const id = chapterId(m[2]);
        const v2 = prompt.indexOf('CONTEXTO DEL CURSO') >= 0;
        rec(v2 ? 'content_v2' : 'content_v1', id);
        const intro = (prompt.match(/Conceptos que ESTE capítulo introduce: ([^\n]*)/) || [])[1] || m[2];
        const terms = (prompt.match(/Términos clave: ([^\n]*)/) || [])[1] || m[2];
        const md = `# Capítulo ${m[1]}: ${m[2]}\n\n## ${m[1]}.1 Fundamentos\n\nTexto del capítulo MARKCH-${id}-${tag} con ejemplos del sector.\n\n| Parámetro | Valor |\n|---|---|\n| Presión | 210 bar |\n\n■ Glosario del Capítulo: bomba, caudal.`;
        if (!v2) return { text: md };
        const cs = { summary: `Se cubrió ${m[2]} (${tag}).`, concepts_introduced: intro.split('; ').slice(0, 12), key_terms: terms.split('; ').slice(0, 15) };
        return { text: `${md}\n\n\`\`\`json context_summary\n${JSON.stringify(cs)}\n\`\`\`` };
      }
      if (prompt.indexOf('preguntas ADICIONALES') >= 0) {
        rec('exam_correction', null);
        throw new Error('fake LLM: corrección de examen inesperada (el GIFT inicial ya es completo)');
      }
      const ex = prompt.match(/Examen UNIDAD (\d+)[\s\S]*?Capítulos cubiertos: ([^\n]+)/);
      if (ex) {
        const titles = ex[2].split(' | ');
        const mid = st.moduleOfChapter.get(chapterId(titles[0]));
        rec('exam', mid);
        return { text: buildGift(getSplit(titles.length), `U${ex[1]}`, 1, `MARKEX-${mid}-${tag}`) };
      }
      st.unknown.push(prompt.slice(0, 300));
      return { httpStatus: 400, error: 'fake LLM: prompt no reconocido' };
    } catch (e) {
      st.unknown.push(String(e && e.message));
      return { httpStatus: 400, error: String(e && e.message) };
    }
  }
  return { st, respond };
}

module.exports = { createLlm };
