// ════ SCORM v2 — catálogo de plantillas (mecánica + diseño ya unidos) ════
// Motor 100% separado de 06-scorms.js/MECS. Nunca modifica ni depende de
// ese archivo. La IA genera SOLO el JSON de datos de una sala por llamada
// (ver scormV2PromptFor) — el HTML/CSS/JS de cada sala es siempre estático
// (ver Task 4/5), igual que ya hace pSCORM_data + buildScormHtml en el
// motor viejo, para que el truncamiento del motor sea imposible.

var SCORM_V2_TEMPLATES = [
  { id: 'equipar_escena', label: 'Equipar la escena', category: 'practica', description: 'El alumno prepara el equipo o las herramientas correctas para una tarea real del capítulo, tocando cada zona de una escena.' },
  { id: 'decision_consecuencia', label: 'Decisión con consecuencia', category: 'practica', description: 'El alumno enfrenta una situación crítica real y ve la consecuencia concreta de la decisión que tome.' },
  { id: 'sopa_letras', label: 'Sopa de letras', category: 'palabras', description: 'El alumno busca en una grilla los términos clave del capítulo, seleccionando sobre las letras para encontrarlos.' },
  { id: 'crucigrama', label: 'Crucigrama', category: 'palabras', description: 'El alumno completa un crucigrama con los términos clave del capítulo a partir de sus pistas.' },
  { id: 'ruleta_preguntas', label: 'Ruleta de preguntas', category: 'trivia', description: 'El alumno gira una ruleta de categorías del capítulo y responde la pregunta de la categoría que sale.' },
  { id: 'multicamino', label: 'Multicamino', category: 'narrativa', description: 'El alumno recorre un árbol corto de decisiones sobre una situación del capítulo, con distintos caminos y finales.' },
  { id: 'armar_proceso', label: 'Armar el proceso', category: 'construccion', description: 'El alumno ordena los pasos correctos de un procedimiento real del capítulo.' }
];

function scormV2SysPrompt() {
  return 'Eres experto en diseño instruccional y simulaciones de práctica para Moodle/SCORM. '
    + 'Generas EXCLUSIVAMENTE JSON válido con datos de una sala de práctica. '
    + 'NUNCA incluyas código HTML, bloques markdown, backticks o explicaciones. '
    + 'Responde SOLO con el objeto JSON puro, sin ningún texto antes ni después.';
}

function scormV2SchemaFor(templateId) {
  if (templateId === 'equipar_escena') {
    return {
      type: 'object',
      properties: {
        scenario: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              zone: { type: 'string' }
            },
            required: ['id', 'label', 'zone'],
            additionalProperties: false
          }
        }
      },
      required: ['scenario', 'items'],
      additionalProperties: false
    };
  }
  if (templateId === 'decision_consecuencia') {
    return {
      type: 'object',
      properties: {
        scenario: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              correct: { type: 'boolean' },
              consequence: { type: 'string' }
            },
            required: ['id', 'label', 'correct', 'consequence'],
            additionalProperties: false
          }
        }
      },
      required: ['scenario', 'options'],
      additionalProperties: false
    };
  }
  if (templateId === 'sopa_letras') {
    return {
      type: 'object',
      properties: {
        scenario: { type: 'string' },
        words: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, text: { type: 'string' } },
            required: ['id', 'text'],
            additionalProperties: false
          }
        }
      },
      required: ['scenario', 'words'],
      additionalProperties: false
    };
  }
  if (templateId === 'crucigrama') {
    return {
      type: 'object',
      properties: {
        scenario: { type: 'string' },
        pairs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, term: { type: 'string' }, clue: { type: 'string' }
            },
            required: ['id', 'term', 'clue'],
            additionalProperties: false
          }
        }
      },
      required: ['scenario', 'pairs'],
      additionalProperties: false
    };
  }
  if (templateId === 'ruleta_preguntas') {
    return {
      type: 'object',
      properties: {
        scenario: { type: 'string' },
        categories: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              questions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    text: { type: 'string' },
                    options: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' }, label: { type: 'string' }, correct: { type: 'boolean' }
                        },
                        required: ['id', 'label', 'correct'],
                        additionalProperties: false
                      }
                    }
                  },
                  required: ['id', 'text', 'options'],
                  additionalProperties: false
                }
              }
            },
            required: ['id', 'label', 'questions'],
            additionalProperties: false
          }
        }
      },
      required: ['scenario', 'categories'],
      additionalProperties: false
    };
  }
  if (templateId === 'multicamino') {
    return {
      type: 'object',
      properties: {
        scenario: { type: 'string' },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    leadsTo: { type: 'string' },
                    isGoodPath: { type: 'boolean' }
                  },
                  required: ['id', 'label', 'leadsTo', 'isGoodPath'],
                  additionalProperties: false
                }
              }
            },
            required: ['id', 'text', 'options'],
            additionalProperties: false
          }
        }
      },
      required: ['scenario', 'nodes'],
      additionalProperties: false
    };
  }
  if (templateId === 'armar_proceso') {
    return {
      type: 'object',
      properties: {
        scenario: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, label: { type: 'string' }, order: { type: 'number' }
            },
            required: ['id', 'label', 'order'],
            additionalProperties: false
          }
        }
      },
      required: ['scenario', 'steps'],
      additionalProperties: false
    };
  }
  throw new Error('scormV2SchemaFor: plantilla desconocida "' + templateId + '"');
}

function scormV2PromptFor(templateId, cap, c) {
  var sector = (typeof D !== 'undefined' && D.sector) || '';
  var pais = (typeof D !== 'undefined' && D.pais) || '';
  var capTitle = (cap && cap.t) || '';
  var capN = (cap && cap.n) || 0;
  var base = c + '\n\nCapítulo ' + capN + ': "' + capTitle + '"'
    + (sector ? ' | Sector: ' + sector : '')
    + (pais ? ' | País: ' + pais : '') + '\n\n';

  if (templateId === 'equipar_escena') {
    return base
      + 'Genera los datos para una simulación de práctica tipo "equipar la escena" — '
      + 'el alumno prepara el equipo/herramientas correctas para una tarea real de este capítulo.\n\n'
      + 'Responde SOLO con JSON válido (sin markdown, sin texto extra):\n'
      + '{\n'
      + '  "scenario": "1-2 oraciones que planteen la tarea real que el alumno va a simular",\n'
      + '  "items": [\n'
      + '    {"id":"i1","label":"elemento correcto para zone head","zone":"head"},\n'
      + '    {"id":"i2","label":"elemento correcto para zone torso","zone":"torso"},\n'
      + '    {"id":"i3","label":"elemento correcto para zone hands","zone":"hands"},\n'
      + '    {"id":"i4","label":"elemento correcto para zone feet","zone":"feet"},\n'
      + '    {"id":"i5","label":"elemento plausible pero incorrecto","zone":"none"},\n'
      + '    {"id":"i6","label":"otro elemento plausible pero incorrecto","zone":"none"}\n'
      + '  ]\n'
      + '}\n\n'
      + 'REGLAS:\n'
      + '- Exactamente 1 item por zone "head","torso","hands","feet" (4 correctos)\n'
      + '- Exactamente 2 items con zone:"none" (distractores plausibles del mismo dominio, nunca absurdos)\n'
      + '- label: máximo 4 palabras, nombre concreto, nunca genérico ("elemento 1")\n'
      + '- Específico de "' + capTitle + '"' + (sector ? ' en el sector ' + sector : '') + '\n'
      + '- SOLO el JSON, nada más';
  }

  if (templateId === 'decision_consecuencia') {
    return base
      + 'Genera los datos para una simulación de práctica tipo "decisión con consecuencia" — '
      + 'una situación crítica real de este capítulo donde el alumno debe decidir.\n\n'
      + 'Responde SOLO con JSON válido (sin markdown, sin texto extra):\n'
      + '{\n'
      + '  "scenario": "2-3 oraciones que planteen una situación crítica real",\n'
      + '  "options": [\n'
      + '    {"id":"o1","label":"decisión correcta","correct":true,"consequence":"qué pasa si eligen esto (1 oración)"},\n'
      + '    {"id":"o2","label":"decisión incorrecta plausible 1","correct":false,"consequence":"consecuencia negativa (1 oración)"},\n'
      + '    {"id":"o3","label":"decisión incorrecta plausible 2","correct":false,"consequence":"consecuencia negativa (1 oración)"}\n'
      + '  ]\n'
      + '}\n\n'
      + 'REGLAS:\n'
      + '- Exactamente 3 opciones, exactamente 1 con correct:true\n'
      + '- Las incorrectas son errores plausibles y realistas, nunca absurdas\n'
      + '- consequence: concreta y específica' + (sector ? ' del sector ' + sector : '') + ', nunca genérica\n'
      + '- Específico de "' + capTitle + '"\n'
      + '- SOLO el JSON, nada más';
  }

  if (templateId === 'sopa_letras') {
    return base
      + 'Genera los datos para una sopa de letras de práctica sobre este capítulo.\n\n'
      + 'Responde SOLO con JSON válido (sin markdown, sin texto extra):\n'
      + '{\n  "scenario": "1 oración que introduzca la búsqueda de términos",\n'
      + '  "words": [\n'
      + '    {"id":"w1","text":"TERMINO1"}, {"id":"w2","text":"TERMINO2"},\n'
      + '    {"id":"w3","text":"TERMINO3"}, {"id":"w4","text":"TERMINO4"},\n'
      + '    {"id":"w5","text":"TERMINO5"}, {"id":"w6","text":"TERMINO6"}\n'
      + '  ]\n}\n\n'
      + 'REGLAS:\n'
      + '- Exactamente 6 términos clave de "' + capTitle + '"' + (sector ? ' en el sector ' + sector : '') + '\n'
      + '- text en MAYÚSCULAS, SIN tildes, SIN espacios ni guiones (una sola palabra por término, 4 a 10 letras)\n'
      + '- Nunca un término que sea substring literal de otro de la lista (ej. no "SOL" y "SOLAR" juntos)\n'
      + '- SOLO el JSON, nada más';
  }

  if (templateId === 'crucigrama') {
    return base
      + 'Genera los datos para un crucigrama de práctica sobre este capítulo.\n\n'
      + 'Responde SOLO con JSON válido (sin markdown, sin texto extra):\n'
      + '{\n  "scenario": "1 oración que introduzca el crucigrama",\n'
      + '  "pairs": [\n'
      + '    {"id":"p1","term":"TERMINO1","clue":"pista concisa, no repite el término"},\n'
      + '    {"id":"p2","term":"TERMINO2","clue":"..."}, {"id":"p3","term":"TERMINO3","clue":"..."},\n'
      + '    {"id":"p4","term":"TERMINO4","clue":"..."}, {"id":"p5","term":"TERMINO5","clue":"..."},\n'
      + '    {"id":"p6","term":"TERMINO6","clue":"..."}\n'
      + '  ]\n}\n\n'
      + 'REGLAS:\n'
      + '- Exactamente 6 pares término+pista de "' + capTitle + '"' + (sector ? ' en el sector ' + sector : '') + '\n'
      + '- term en MAYÚSCULAS, SIN tildes, SIN espacios ni guiones (4 a 10 letras)\n'
      + '- clue: máximo 12 palabras, nunca contiene el término literal\n'
      + '- Nunca un término que sea substring literal de otro de la lista\n'
      + '- SOLO el JSON, nada más';
  }

  if (templateId === 'ruleta_preguntas') {
    return base
      + 'Genera los datos para una ruleta de preguntas de práctica sobre este capítulo.\n\n'
      + 'Responde SOLO con JSON válido (sin markdown, sin texto extra):\n'
      + '{\n  "scenario": "1 oración que introduzca la ruleta",\n'
      + '  "categories": [\n'
      + '    {"id":"c1","label":"Categoría 1","questions":[{"id":"q1","text":"pregunta","options":['
      + '{"id":"o1","label":"correcta","correct":true},{"id":"o2","label":"incorrecta","correct":false},'
      + '{"id":"o3","label":"incorrecta","correct":false}]}]},\n'
      + '    {"id":"c2", "...": "misma forma"}, {"id":"c3", "...": "misma forma"}\n'
      + '  ]\n}\n\n'
      + 'REGLAS:\n'
      + '- Exactamente 3 categorías, cada una con exactamente 1 pregunta de 3 opciones\n'
      + '- Exactamente 1 opción con correct:true por pregunta\n'
      + '- Categorías y preguntas específicas de "' + capTitle + '"' + (sector ? ' en el sector ' + sector : '') + '\n'
      + '- SOLO el JSON, nada más';
  }

  if (templateId === 'multicamino') {
    return base
      + 'Genera un árbol corto de decisiones de práctica sobre este capítulo.\n\n'
      + 'Responde SOLO con JSON válido (sin markdown, sin texto extra):\n'
      + '{\n  "scenario": "1-2 oraciones que planteen la situación inicial",\n'
      + '  "nodes": [\n'
      + '    {"id":"start","text":"situación inicial","options":['
      + '{"id":"o1","label":"decisión A","leadsTo":"n2","isGoodPath":true},'
      + '{"id":"o2","label":"decisión B","leadsTo":"n3","isGoodPath":false}]},\n'
      + '    {"id":"n2","text":"consecuencia de A, nueva decisión","options":['
      + '{"id":"o3","label":"decisión A2","leadsTo":"end","isGoodPath":true},'
      + '{"id":"o4","label":"decisión B2","leadsTo":"end","isGoodPath":false}]},\n'
      + '    {"id":"n3","text":"consecuencia de B, nueva decisión","options":['
      + '{"id":"o5","label":"decisión A3","leadsTo":"end","isGoodPath":false},'
      + '{"id":"o6","label":"decisión B3","leadsTo":"end","isGoodPath":false}]}\n'
      + '  ]\n}\n\n'
      + 'REGLAS:\n'
      + '- Exactamente 3 nodos (incluye el nodo "start"), 2 opciones cada uno\n'
      + '- Todo "leadsTo" apunta a un id real de "nodes" o al string exacto "end" — NUNCA inventes un id\n'
      + '- Al menos un camino completo desde "start" hasta "end" con isGoodPath:true en cada opción de ese camino\n'
      + '- Específico de "' + capTitle + '"' + (sector ? ' en el sector ' + sector : '') + '\n'
      + '- SOLO el JSON, nada más';
  }

  if (templateId === 'armar_proceso') {
    return base
      + 'Genera los pasos de un procedimiento real de este capítulo, en su orden correcto.\n\n'
      + 'Responde SOLO con JSON válido (sin markdown, sin texto extra):\n'
      + '{\n  "scenario": "1 oración que plantee el procedimiento a ordenar",\n'
      + '  "steps": [\n'
      + '    {"id":"s1","label":"paso 1","order":1}, {"id":"s2","label":"paso 2","order":2},\n'
      + '    {"id":"s3","label":"paso 3","order":3}, {"id":"s4","label":"paso 4","order":4},\n'
      + '    {"id":"s5","label":"paso 5","order":5}\n'
      + '  ]\n}\n\n'
      + 'REGLAS:\n'
      + '- Exactamente 5 pasos, order de 1 a 5 sin repetir\n'
      + '- label: máximo 6 palabras, un paso real y concreto de "' + capTitle + '"' + (sector ? ' en el sector ' + sector : '') + '\n'
      + '- Sin distractores — los 5 pasos son todos correctos, el desafío es el orden\n'
      + '- SOLO el JSON, nada más';
  }

  throw new Error('scormV2PromptFor: plantilla desconocida "' + templateId + '"');
}

// ════ Motor de rotación — evita repetir la misma plantilla en salas
// consecutivas. Distinto del pick(arr,used) que ya existe en 06-scorms.js:
// ese utilitario acumula uso hasta agotar el pool y recién ahí resetea,
// lo que en el punto de reset puede repetir la última plantilla elegida
// justo antes (probado: con pool de 2, el reset puede volver a elegir la
// misma). Acá se excluye explícitamente lastId en cada pick, garantía
// dura de "nunca dos veces seguidas" siempre que el pool tenga >= 2.
function pickRoomTemplate(pool, lastId) {
  var candidates = pool.length > 1 ? pool.filter(function (id) { return id !== lastId; }) : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function assignRoomTemplates(activeIds, totalRooms) {
  if (!Array.isArray(activeIds) || activeIds.length < 1) {
    throw new Error('assignRoomTemplates: activeIds vacío');
  }
  var result = [];
  var last = null;
  for (var i = 0; i < totalRooms; i++) {
    var id = pickRoomTemplate(activeIds, last);
    result.push(id);
    last = id;
  }
  return result;
}

// ════ Validación por sala — a diferencia de _validateScormData (motor
// viejo, 06-scorms.js:1760), que solo exige un mínimo agregado de salas/
// preguntas y NUNCA compara contra lo realmente asignado, acá cada sala
// se valida contra el esquema exacto de SU plantilla, y el capítulo se
// valida sala por sala contra lo que assignRoomTemplates() realmente
// asignó — ninguna sala puede faltar ni quedar incompleta sin que se
// reporte con su índice exacto.
function scormV2ValidateRoomData(templateId, data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'sala vacía' };

  if (templateId === 'equipar_escena') {
    if (!Array.isArray(data.items)) return { ok: false, reason: 'items ausente' };
    var zones = ['head', 'torso', 'hands', 'feet'];
    var byZone = {};
    data.items.forEach(function (it) {
      if (it && it.zone) byZone[it.zone] = (byZone[it.zone] || 0) + 1;
    });
    for (var zi = 0; zi < zones.length; zi++) {
      var z = zones[zi];
      if (!byZone[z]) return { ok: false, reason: 'falta item para zone "' + z + '"' };
      if (byZone[z] > 1) return { ok: false, reason: 'zone "' + z + '" repetida ' + byZone[z] + ' veces' };
    }
    if ((byZone.none || 0) < 1) return { ok: false, reason: 'sin distractores (zone:"none")' };
    return { ok: true, reason: 'ok' };
  }

  if (templateId === 'decision_consecuencia') {
    if (!Array.isArray(data.options) || data.options.length !== 3) {
      return { ok: false, reason: 'se esperan exactamente 3 options, hay ' + (data.options ? data.options.length : 0) };
    }
    var correctCount = data.options.filter(function (o) { return o && o.correct === true; }).length;
    if (correctCount !== 1) return { ok: false, reason: correctCount + ' opciones correct:true (se espera 1)' };
    var badOpt = data.options.some(function (o) {
      return !o || !o.label || !o.consequence || String(o.label).trim().length < 2 || String(o.consequence).trim().length < 2;
    });
    if (badOpt) return { ok: false, reason: 'una option sin label/consequence' };
    return { ok: true, reason: 'ok' };
  }

  if (templateId === 'sopa_letras') {
    if (!Array.isArray(data.words) || data.words.length !== 6) {
      return { ok: false, reason: 'se esperan exactamente 6 words, hay ' + (data.words ? data.words.length : 0) };
    }
    var wordRe = /^[A-ZÑ]{4,10}$/;
    // R25: recolecta TODOS los términos inválidos (no solo el primero) —
    // el reintento necesita saber cada uno para no repetir el resto.
    var _sv2SlInvalid = [];
    for (var wi = 0; wi < data.words.length; wi++) {
      var wtext = String(data.words[wi] && data.words[wi].text);
      if (!wordRe.test(wtext)) {
        _sv2SlInvalid.push({ text: wtext, len: wtext.length });
      }
    }
    if (_sv2SlInvalid.length > 0) {
      var _sv2SlInvalidList = _sv2SlInvalid.map(function (t) { return '"' + t.text + '" (' + t.len + ' letras)'; }).join(', ');
      return { ok: false, reason: 'word(s) inválido(s): ' + _sv2SlInvalidList, invalidTerms: _sv2SlInvalid };
    }
    var _sv2SlIds = data.words.map(function (w) { return w.id; });
    if (new Set(_sv2SlIds).size !== _sv2SlIds.length) {
      return { ok: false, reason: 'word ids duplicados' };
    }
    var wordTexts = data.words.map(function (w) { return w.text; });
    var _sv2SlTextSet = new Set();
    for (var _sv2Sli = 0; _sv2Sli < wordTexts.length; _sv2Sli++) {
      if (_sv2SlTextSet.has(wordTexts[_sv2Sli])) {
        return { ok: false, reason: 'palabra duplicada: "' + wordTexts[_sv2Sli] + '"' };
      }
      _sv2SlTextSet.add(wordTexts[_sv2Sli]);
    }
    for (var a = 0; a < wordTexts.length; a++) {
      for (var b = 0; b < wordTexts.length; b++) {
        if (a !== b && wordTexts[a] !== wordTexts[b] && wordTexts[b].indexOf(wordTexts[a]) !== -1) {
          return { ok: false, reason: '"' + wordTexts[a] + '" es substring de "' + wordTexts[b] + '"' };
        }
      }
    }
    var _sv2SlBuildCheck = sv2BuildWordSearchGrid(data.words);
    if (!_sv2SlBuildCheck.ok) {
      return { ok: false, reason: 'no se pudo armar la sopa de letras: ' + _sv2SlBuildCheck.reason };
    }
    return { ok: true, reason: 'ok' };
  }

  if (templateId === 'crucigrama') {
    if (!Array.isArray(data.pairs) || data.pairs.length !== 6) {
      return { ok: false, reason: 'se esperan exactamente 6 pairs, hay ' + (data.pairs ? data.pairs.length : 0) };
    }
    var termRe = /^[A-ZÑ]{4,10}$/;
    // R25: recolecta TODOS los términos inválidos antes de mirar las clues —
    // mismo criterio que sopa_letras, para que el reintento tenga la lista
    // completa en un solo turno.
    var _sv2CwInvalid = [];
    for (var pi = 0; pi < data.pairs.length; pi++) {
      var pair = data.pairs[pi];
      var _sv2CwTerm = String(pair && pair.term);
      if (!termRe.test(_sv2CwTerm)) {
        _sv2CwInvalid.push({ text: _sv2CwTerm, len: _sv2CwTerm.length });
      }
    }
    if (_sv2CwInvalid.length > 0) {
      var _sv2CwInvalidList = _sv2CwInvalid.map(function (t) { return '"' + t.text + '" (' + t.len + ' letras)'; }).join(', ');
      return { ok: false, reason: 'word(s) inválido(s): ' + _sv2CwInvalidList, invalidTerms: _sv2CwInvalid };
    }
    for (var pi2 = 0; pi2 < data.pairs.length; pi2++) {
      var pair2 = data.pairs[pi2];
      if (!pair2.clue || String(pair2.clue).trim().length < 3) {
        return { ok: false, reason: 'pair "' + pair2.id + '" sin clue válida' };
      }
      if (pair2.clue.toUpperCase().indexOf(pair2.term) !== -1) {
        return { ok: false, reason: 'clue de "' + pair2.term + '" repite el término' };
      }
    }
    var _sv2CwIds = data.pairs.map(function (p) { return p.id; });
    if (new Set(_sv2CwIds).size !== _sv2CwIds.length) {
      return { ok: false, reason: 'pair ids duplicados' };
    }
    var terms = data.pairs.map(function (p) { return p.term; });
    var _sv2CwTermSet = new Set();
    for (var _sv2Cwi = 0; _sv2Cwi < terms.length; _sv2Cwi++) {
      if (_sv2CwTermSet.has(terms[_sv2Cwi])) {
        return { ok: false, reason: 'término duplicado: "' + terms[_sv2Cwi] + '"' };
      }
      _sv2CwTermSet.add(terms[_sv2Cwi]);
    }
    for (var ta = 0; ta < terms.length; ta++) {
      for (var tb = 0; tb < terms.length; tb++) {
        if (ta !== tb && terms[ta] !== terms[tb] && terms[tb].indexOf(terms[ta]) !== -1) {
          return { ok: false, reason: '"' + terms[ta] + '" es substring de "' + terms[tb] + '"' };
        }
      }
    }
    var _sv2CwBuildCheck = sv2BuildCrosswordGrid(data.pairs);
    if (!_sv2CwBuildCheck.ok) {
      return { ok: false, reason: 'no se pudo armar el crucigrama: ' + _sv2CwBuildCheck.reason };
    }
    return { ok: true, reason: 'ok' };
  }

  if (templateId === 'ruleta_preguntas') {
    if (!Array.isArray(data.categories) || data.categories.length !== 3) {
      return { ok: false, reason: 'se esperan exactamente 3 categories, hay ' + (data.categories ? data.categories.length : 0) };
    }
    var _sv2RlCatIds = data.categories.map(function (c) { return c && c.id; });
    if (new Set(_sv2RlCatIds).size !== _sv2RlCatIds.length) {
      return { ok: false, reason: 'category ids duplicados' };
    }
    for (var ci = 0; ci < data.categories.length; ci++) {
      var cat = data.categories[ci];
      if (!cat || !Array.isArray(cat.questions) || cat.questions.length !== 1) {
        return { ok: false, reason: 'categoría ' + ci + ' inválida' };
      }
      var q = cat.questions[0];
      if (!Array.isArray(q.options) || q.options.length !== 3) {
        return { ok: false, reason: 'pregunta de "' + cat.id + '" no tiene exactamente 3 options' };
      }
      var correctN = q.options.filter(function (o) { return o && o.correct === true; }).length;
      if (correctN !== 1) {
        return { ok: false, reason: 'pregunta de "' + cat.id + '" tiene ' + correctN + ' opciones correct:true' };
      }
    }
    return { ok: true, reason: 'ok' };
  }

  if (templateId === 'multicamino') {
    if (!Array.isArray(data.nodes) || data.nodes.length !== 3) {
      return { ok: false, reason: 'se esperan exactamente 3 nodes, hay ' + (data.nodes ? data.nodes.length : 0) };
    }
    var _sv2McIdRe = /^[a-z0-9_-]+$/i;
    for (var _sv2Mcj = 0; _sv2Mcj < data.nodes.length; _sv2Mcj++) {
      if (!data.nodes[_sv2Mcj] || !_sv2McIdRe.test(String(data.nodes[_sv2Mcj].id))) {
        return { ok: false, reason: 'node id inválido: "' + (data.nodes[_sv2Mcj] && data.nodes[_sv2Mcj].id) + '"' };
      }
    }
    var _sv2McIds = data.nodes.map(function (n) { return n.id; });
    if (new Set(_sv2McIds).size !== _sv2McIds.length) {
      return { ok: false, reason: 'node ids duplicados' };
    }
    if (!data.nodes.some(function (n) { return n && n.id === 'start'; })) {
      return { ok: false, reason: 'falta el nodo "start"' };
    }
    var nodeIds = data.nodes.map(function (n) { return n && n.id; });
    for (var ni = 0; ni < data.nodes.length; ni++) {
      var node = data.nodes[ni];
      if (!node || !Array.isArray(node.options) || node.options.length !== 2) {
        return { ok: false, reason: 'nodo ' + ni + ' inválido' };
      }
      for (var oi = 0; oi < node.options.length; oi++) {
        var opt = node.options[oi];
        if (!opt) {
          return { ok: false, reason: 'option ' + oi + ' inválida' };
        }
        if (opt.leadsTo !== 'end' && nodeIds.indexOf(opt.leadsTo) === -1) {
          return { ok: false, reason: 'option "' + opt.id + '" tiene leadsTo:"' + opt.leadsTo + '" que no existe' };
        }
      }
    }
    // al menos un camino start→...→end con isGoodPath:true en cada tramo
    var hasGoodPath = false;
    var byId = {};
    data.nodes.forEach(function (n) { byId[n.id] = n; });
    (function walk(nodeId, depth) {
      if (hasGoodPath || depth > 5) return;
      var n = byId[nodeId];
      if (!n) return;
      n.options.forEach(function (opt) {
        if (!opt.isGoodPath) return;
        if (opt.leadsTo === 'end') { hasGoodPath = true; return; }
        walk(opt.leadsTo, depth + 1);
      });
    })('start', 0);
    if (!hasGoodPath) {
      return { ok: false, reason: 'ningún camino start→end con isGoodPath:true en cada tramo' };
    }
    // Cierra el bug de grafos con ciclo: cualquier camino (no solo el
    // bueno) que pueda revisitar un nodo antes de llegar a "end" deja
    // al alumno con botones deshabilitados sin forma de avanzar
    // (data-answered ya en "true" para ese nodo). Se recorre CADA rama
    // desde "start", nunca solo la marcada isGoodPath.
    var _sv2McStack = [{ id: 'start', visited: { start: true } }];
    var _sv2McSafe = true;
    while (_sv2McStack.length && _sv2McSafe) {
      var _sv2McFrame = _sv2McStack.pop();
      var _sv2McNode = byId[_sv2McFrame.id];
      for (var _sv2Mci = 0; _sv2Mci < _sv2McNode.options.length; _sv2Mci++) {
        var _sv2McOpt = _sv2McNode.options[_sv2Mci];
        if (_sv2McOpt.leadsTo === 'end') continue;
        if (_sv2McFrame.visited[_sv2McOpt.leadsTo]) { _sv2McSafe = false; break; }
        var _sv2McNextVisited = {};
        for (var _sv2Mck in _sv2McFrame.visited) _sv2McNextVisited[_sv2Mck] = true;
        _sv2McNextVisited[_sv2McOpt.leadsTo] = true;
        _sv2McStack.push({ id: _sv2McOpt.leadsTo, visited: _sv2McNextVisited });
      }
    }
    if (!_sv2McSafe) {
      return { ok: false, reason: 'grafo con ciclo — algún camino nunca llega a "end"' };
    }
    return { ok: true, reason: 'ok' };
  }

  if (templateId === 'armar_proceso') {
    if (!Array.isArray(data.steps) || data.steps.length !== 5) {
      return { ok: false, reason: 'se esperan exactamente 5 steps, hay ' + (data.steps ? data.steps.length : 0) };
    }
    for (var si = 0; si < data.steps.length; si++) {
      var s = data.steps[si];
      if (!s || typeof s.order !== 'number') {
        return { ok: false, reason: 'step ' + si + ' inválido' };
      }
    }
    var orders = data.steps.map(function (s) { return s.order; }).sort();
    for (var si = 0; si < 5; si++) {
      if (orders[si] !== si + 1) {
        return { ok: false, reason: 'orders deben ser 1..5 sin repetir, son ' + JSON.stringify(orders) };
      }
    }
    return { ok: true, reason: 'ok' };
  }

  return { ok: false, reason: 'plantilla desconocida "' + templateId + '"' };
}

function scormV2ValidateChapterRooms(assignedIds, roomsData) {
  if (!Array.isArray(roomsData) || roomsData.length !== assignedIds.length) {
    return {
      ok: false,
      roomIndex: Array.isArray(roomsData) ? roomsData.length : 0,
      reason: 'faltan salas: se esperaban ' + assignedIds.length + ', hay ' + (roomsData ? roomsData.length : 0)
    };
  }
  for (var i = 0; i < assignedIds.length; i++) {
    var room = roomsData[i];
    if (!room || !room.data) {
      return { ok: false, roomIndex: i, reason: 'sala ' + (i + 1) + ' sin datos' };
    }
    var v = scormV2ValidateRoomData(assignedIds[i], room.data);
    if (!v.ok) {
      return { ok: false, roomIndex: i, reason: 'sala ' + (i + 1) + ': ' + v.reason };
    }
  }
  return { ok: true, roomIndex: -1, reason: 'ok' };
}

// ════ Render estático — Equipar la escena ════
// Paleta local plana (--sv2-*), deliberadamente NO reutiliza STHEMES (eso
// es justo lo que este rediseño reemplaza) ni ningún tema global — mismo
// patrón de tokens locales que ya usa el sistema .cc-* del resto del
// rediseño v3 (ver STAGING_V3_HANDOFF.md), escopado a esta sala.
function _sv2Esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scormV2RoomHtml_equiparEscena(data) {
  var zoneLabel = { head: 'Cabeza', torso: 'Torso', hands: 'Manos', feet: 'Pies' };
  var zones = ['head', 'torso', 'hands', 'feet'];
  var items = data.items || [];
  var h = '<p class="sv2-scenario">' + _sv2Esc(data.scenario) + '</p>';
  h += '<div class="sv2-figure">';
  zones.forEach(function (z) {
    h += '<div class="sv2-zone sv2-zone-' + z + '" data-zone="' + z + '" role="button" tabindex="0" aria-label="' + zoneLabel[z] + '"></div>';
  });
  h += '</div>';
  h += '<p class="sv2-hint">Toca un elemento y después la zona del cuerpo donde va.</p>';
  h += '<div class="sv2-tray">';
  items.forEach(function (it) {
    h += '<button class="sv2-chip" data-item-id="' + _sv2Esc(it.id) + '" data-item-zone="' + _sv2Esc(it.zone) + '">' + _sv2Esc(it.label) + '</button>';
  });
  h += '</div>';
  h += '<p class="sv2-error" hidden></p>';
  return h;
}

// Función real (se referencia con .toString() desde el shell del Task 6 —
// ver nota de la interfaz arriba). Usa únicamente los ids/clases que
// scormV2RoomHtml_equiparEscena ya generó, y las funciones globales que el
// shell del Task 6 expone: sv2CompleteRoom(passed).
function scormV2RoomScript_equiparEscena(root) {
  var placed = {};
  var selected = null;
  var hadWrongAttempt = false;
  root.querySelectorAll('.sv2-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      if (chip.classList.contains('sv2-chip-placed')) return;
      root.querySelectorAll('.sv2-chip').forEach(function (c) { c.classList.remove('sv2-chip-selected'); });
      selected = chip;
      chip.classList.add('sv2-chip-selected');
    });
  });
  root.querySelectorAll('.sv2-zone').forEach(function (zone) {
    function activateZone() {
      var err = root.querySelector('.sv2-error');
      if (!selected) { err.hidden = false; err.textContent = 'Primero toca un elemento de la lista.'; return; }
      err.hidden = true;
      var itemZone = selected.getAttribute('data-item-zone');
      var zoneName = zone.getAttribute('data-zone');
      if (itemZone === zoneName) {
        zone.classList.add('sv2-zone-filled');
        selected.classList.add('sv2-chip-placed');
        selected.disabled = true;
        placed[zoneName] = true;
        selected = null;
        var allDone = ['head', 'torso', 'hands', 'feet'].every(function (z) { return placed[z]; });
        if (allDone) sv2CompleteRoom(!hadWrongAttempt);
      } else {
        hadWrongAttempt = true;
        zone.classList.add('sv2-zone-wrong');
        setTimeout(function () { zone.classList.remove('sv2-zone-wrong'); }, 450);
      }
    }
    zone.addEventListener('click', activateZone);
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        activateZone();
      }
    });
  });
}

// ════ Render estático — Decisión con consecuencia ════
function scormV2RoomHtml_decisionConsecuencia(data) {
  var options = data.options || [];
  var h = '<p class="sv2-scenario">' + _sv2Esc(data.scenario) + '</p>';
  h += '<div class="sv2-options">';
  options.forEach(function (o) {
    h += '<button class="sv2-option" data-option-id="' + _sv2Esc(o.id) + '" data-correct="' + (o.correct ? 'true' : 'false') + '">'
      + _sv2Esc(o.label) + '</button>';
    h += '<p class="sv2-consequence" data-consequence-for="' + _sv2Esc(o.id) + '" hidden>' + _sv2Esc(o.consequence) + '</p>';
  });
  h += '</div>';
  return h;
}

// Función real (referenciada por .toString() desde el shell del Task 6).
function scormV2RoomScript_decisionConsecuencia(root) {
  var answered = false;
  root.querySelectorAll('.sv2-option').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (answered) return;
      answered = true;
      var id = btn.getAttribute('data-option-id');
      var correct = btn.getAttribute('data-correct') === 'true';
      root.querySelectorAll('.sv2-option').forEach(function (b) { b.disabled = true; });
      btn.classList.add(correct ? 'sv2-option-correct' : 'sv2-option-wrong');
      var cons = root.querySelector('[data-consequence-for="' + id + '"]');
      if (cons) cons.hidden = false;
      setTimeout(function () { sv2CompleteRoom(correct); }, 900);
    });
  });
}

// ════ Sopa de letras — algoritmo determinístico de colocación (sin IA,
// spec §4). Intenta 10x10; si alguna palabra no entra tras varios
// intentos aleatorios, reintenta todo el proceso en 12x12 antes de
// fallar explícitamente (nunca arma una grilla con palabras faltantes).
var SV2_LETRAS_RELLENO = 'ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';
var SV2_WS_DIRS = [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]];

function _sv2TryPlaceWordSearch(words, size) {
  var grid = [];
  for (var r = 0; r < size; r++) { grid.push(new Array(size).fill(null)); }
  var sorted = words.slice().sort(function (a, b) { return b.text.length - a.text.length; });
  var placements = [];
  for (var wi = 0; wi < sorted.length; wi++) {
    var word = sorted[wi].text;
    var placed = false;
    for (var attempt = 0; attempt < 200 && !placed; attempt++) {
      var dir = SV2_WS_DIRS[Math.floor(Math.random() * SV2_WS_DIRS.length)];
      var row = Math.floor(Math.random() * size);
      var col = Math.floor(Math.random() * size);
      var endRow = row + dir[0] * (word.length - 1);
      var endCol = col + dir[1] * (word.length - 1);
      if (endRow < 0 || endRow >= size || endCol < 0 || endCol >= size) continue;
      var fits = true;
      for (var i = 0; i < word.length; i++) {
        var cell = grid[row + dir[0] * i][col + dir[1] * i];
        if (cell !== null && cell !== word[i]) { fits = false; break; }
      }
      if (!fits) continue;
      for (var j = 0; j < word.length; j++) {
        grid[row + dir[0] * j][col + dir[1] * j] = word[j];
      }
      placements.push({ id: sorted[wi].id, row: row, col: col, dr: dir[0], dc: dir[1], len: word.length });
      placed = true;
    }
    if (!placed) return null;
  }
  for (var gr = 0; gr < size; gr++) {
    for (var gc = 0; gc < size; gc++) {
      if (grid[gr][gc] === null) {
        grid[gr][gc] = SV2_LETRAS_RELLENO[Math.floor(Math.random() * SV2_LETRAS_RELLENO.length)];
      }
    }
  }
  return { grid: grid, placements: placements };
}

function sv2BuildWordSearchGrid(words) {
  if (!Array.isArray(words) || words.length < 1) {
    return { ok: false, reason: 'sv2BuildWordSearchGrid: words vacío' };
  }
  var sizes = [10, 12, 14];
  for (var si = 0; si < sizes.length; si++) {
    for (var attempt = 0; attempt < 8; attempt++) {
      var result = _sv2TryPlaceWordSearch(words, sizes[si]);
      if (result) return { ok: true, size: sizes[si], grid: result.grid, placements: result.placements };
    }
  }
  return { ok: false, reason: 'no se pudieron colocar todas las palabras ni en grilla 14x14' };
}

// ════ Render estático — Sopa de letras ════
function scormV2RoomHtml_sopaLetras(data, gridResult) {
  var built = gridResult || sv2BuildWordSearchGrid(data.words || []);
  if (!built.ok) throw new Error('scormV2RoomHtml_sopaLetras: ' + built.reason);
  var h = '<p class="sv2-scenario">' + _sv2Esc(data.scenario) + '</p>';
  h += '<div class="sv2-grid" style="grid-template-columns:repeat(' + built.size + ',1fr)" data-size="' + built.size + '">';
  for (var r = 0; r < built.size; r++) {
    for (var c = 0; c < built.size; c++) {
      h += '<div class="sv2-cell" data-row="' + r + '" data-col="' + c + '" role="button" tabindex="0">' + built.grid[r][c] + '</div>';
    }
  }
  h += '</div>';
  h += '<div class="sv2-tray" id="sv2-word-list">';
  (data.words || []).forEach(function (w) {
    h += '<span class="sv2-chip" data-word-id="' + _sv2Esc(w.id) + '">' + _sv2Esc(w.text) + '</span>';
  });
  h += '</div>';
  // placements/size viajan embebidos como JSON en un atributo data- para
  // que el script (que solo recibe `root`, sin acceso a `built` del closure
  // de render) pueda validar la selección sin recalcular la grilla.
  h += '<script type="application/json" class="sv2-ws-data">' + JSON.stringify(built.placements) + '</script>';
  return h;
}

function scormV2RoomScript_sopaLetras(root) {
  var placements = JSON.parse(root.querySelector('.sv2-ws-data').textContent);
  var found = {};
  var startCell = null;

  function clearSelection() {
    if (startCell) startCell.classList.remove('sv2-cell-selected');
    startCell = null;
  }

  function cellsBetween(r1, c1, r2, c2) {
    var dr = Math.sign(r2 - r1), dc = Math.sign(c2 - c1);
    var len = Math.max(Math.abs(r2 - r1), Math.abs(c2 - c1)) + 1;
    var cells = [];
    for (var i = 0; i < len; i++) cells.push({ r: r1 + dr * i, c: c1 + dc * i });
    return { cells: cells, dr: dr, dc: dc };
  }

  // Matchea la selección del alumno contra un placement en CUALQUIER
  // sentido (inicio→fin o fin→inicio). Exige longitud EXACTA de la
  // palabra real (p.len) — NUNCA la longitud de la selección del
  // alumno, que es controlable por el alumno y no prueba nada. Este es
  // el fix del bug crítico: antes se usaba selLen (longitud de la
  // selección) para proyectar el extremo esperado, lo que hacía que
  // una selección de 1 celda siempre "coincidiera" consigo misma.
  function tryMatch(r1, c1, r2, c2) {
    var path = cellsBetween(r1, c1, r2, c2);
    var selLen = path.cells.length;
    return placements.find(function (p) {
      if (found[p.id]) return false;
      if (selLen !== p.len) return false;
      var endR = p.row + p.dr * (p.len - 1);
      var endC = p.col + p.dc * (p.len - 1);
      var forward = (p.row === r1 && p.col === c1 && endR === r2 && endC === c2);
      var reverse = (endR === r1 && endC === c1 && p.row === r2 && p.col === c2);
      return forward || reverse;
    });
  }

  root.querySelectorAll('.sv2-cell').forEach(function (cell) {
    cell.addEventListener('click', function () {
      var r2 = parseInt(cell.getAttribute('data-row'), 10);
      var c2 = parseInt(cell.getAttribute('data-col'), 10);
      if (!startCell) {
        startCell = cell;
        cell.classList.add('sv2-cell-selected');
        return;
      }
      var r1 = parseInt(startCell.getAttribute('data-row'), 10);
      var c1 = parseInt(startCell.getAttribute('data-col'), 10);
      if (startCell === cell) { clearSelection(); return; }
      var match = tryMatch(r1, c1, r2, c2);
      if (match) {
        found[match.id] = true;
        var path = cellsBetween(r1, c1, r2, c2);
        path.cells.forEach(function (cellPos) {
          var el = root.querySelector('.sv2-cell[data-row="' + cellPos.r + '"][data-col="' + cellPos.c + '"]');
          if (el) el.classList.add('sv2-cell-found');
        });
        var chip = root.querySelector('.sv2-chip[data-word-id="' + match.id + '"]');
        if (chip) chip.classList.add('sv2-chip-found');
        clearSelection();
        if (Object.keys(found).length === placements.length) sv2CompleteRoom(true);
      } else {
        cell.classList.add('sv2-cell-wrong-flash');
        setTimeout(function () { cell.classList.remove('sv2-cell-wrong-flash'); }, 300);
        clearSelection();
        startCell = cell;
        cell.classList.add('sv2-cell-selected');
      }
    });
    cell.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        cell.click();
      }
    });
  });
}

// ════ Crucigrama — algoritmo determinístico de colocación con cruces
// (sin IA, spec §4). Coloca el primer término (el más largo) horizontal
// en el centro; cada término siguiente busca un cruce válido (letra
// compartida) con algún término ya colocado, en dirección perpendicular;
// si ningún cruce entra, reintenta desde cero con más tamaño de grilla.
function _sv2TryCrossword(pairs, size) {
  var sorted = pairs.slice().sort(function (a, b) { return b.term.length - a.term.length; });
  var grid = [];
  for (var r = 0; r < size; r++) grid.push(new Array(size).fill(null));
  var mid = Math.floor(size / 2);
  var first = sorted[0];
  var startCol = Math.max(0, mid - Math.floor(first.term.length / 2));
  if (startCol + first.term.length > size) return null;
  for (var i = 0; i < first.term.length; i++) grid[mid][startCol + i] = first.term[i];
  var placements = [{ id: first.id, term: first.term, clue: first.clue, row: mid, col: startCol, dir: 'across' }];

  for (var pi = 1; pi < sorted.length; pi++) {
    var term = sorted[pi].term;
    var candidates = [];
    for (var placedIdx = 0; placedIdx < placements.length; placedIdx++) {
      var placed = placements[placedIdx];
      for (var pj = 0; pj < placed.term.length; pj++) {
        for (var tj = 0; tj < term.length; tj++) {
          if (placed.term[pj] !== term[tj]) continue;
          var newDir = placed.dir === 'across' ? 'down' : 'across';
          var crossRow = placed.dir === 'across' ? placed.row : placed.row + pj;
          var crossCol = placed.dir === 'across' ? placed.col + pj : placed.col;
          var newRow = newDir === 'down' ? crossRow - tj : crossRow;
          var newCol = newDir === 'across' ? crossCol - tj : crossCol;
          candidates.push({ row: newRow, col: newCol, dir: newDir });
        }
      }
    }
    // orden aleatorio de candidatos para que reintentos den resultados distintos
    candidates.sort(function () { return Math.random() - 0.5; });
    var placedNow = false;
    for (var ci = 0; ci < candidates.length && !placedNow; ci++) {
      var cand = candidates[ci];
      var endRow = cand.dir === 'down' ? cand.row + term.length - 1 : cand.row;
      var endCol = cand.dir === 'across' ? cand.col + term.length - 1 : cand.col;
      if (cand.row < 0 || cand.col < 0 || endRow >= size || endCol >= size) continue;
      var fits = true;
      for (var k = 0; k < term.length; k++) {
        var rr = cand.dir === 'down' ? cand.row + k : cand.row;
        var cc = cand.dir === 'across' ? cand.col + k : cand.col;
        var existing = grid[rr][cc];
        if (existing !== null && existing !== term[k]) { fits = false; break; }
        // Celda que NO es un cruce (estaba vacía): sus vecinos
        // perpendiculares a la dirección de la palabra deben seguir
        // vacíos, o dos palabras se leerían pegadas como una sola.
        if (existing === null) {
          if (cand.dir === 'across') {
            if ((rr - 1 >= 0 && grid[rr - 1][cc] !== null) || (rr + 1 < size && grid[rr + 1][cc] !== null)) { fits = false; break; }
          } else {
            if ((cc - 1 >= 0 && grid[rr][cc - 1] !== null) || (cc + 1 < size && grid[rr][cc + 1] !== null)) { fits = false; break; }
          }
        }
      }
      if (fits) {
        var beforeR = cand.dir === 'down' ? cand.row - 1 : cand.row;
        var beforeC = cand.dir === 'across' ? cand.col - 1 : cand.col;
        var afterR = cand.dir === 'down' ? cand.row + term.length : cand.row;
        var afterC = cand.dir === 'across' ? cand.col + term.length : cand.col;
        if (beforeR >= 0 && beforeC >= 0 && beforeR < size && beforeC < size && grid[beforeR][beforeC] !== null) fits = false;
        if (fits && afterR >= 0 && afterC >= 0 && afterR < size && afterC < size && grid[afterR][afterC] !== null) fits = false;
      }
      if (!fits) continue;
      for (var m = 0; m < term.length; m++) {
        var mr = cand.dir === 'down' ? cand.row + m : cand.row;
        var mc = cand.dir === 'across' ? cand.col + m : cand.col;
        grid[mr][mc] = term[m];
      }
      placements.push({ id: sorted[pi].id, term: term, clue: sorted[pi].clue, row: cand.row, col: cand.col, dir: cand.dir });
      placedNow = true;
    }
    if (!placedNow) return null;
  }
  return { grid: grid, placements: placements };
}

function _sv2NumberCrossword(grid, placements, size) {
  var startsAt = {};
  placements.forEach(function (p) {
    var key = p.row + ',' + p.col;
    startsAt[key] = startsAt[key] || [];
    startsAt[key].push(p);
  });
  var number = 1;
  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      var key = r + ',' + c;
      if (startsAt[key]) {
        startsAt[key].forEach(function (p) { p.number = number; });
        number++;
      }
    }
  }
  return placements;
}

function sv2BuildCrosswordGrid(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 1) {
    return { ok: false, reason: 'sv2BuildCrosswordGrid: pairs vacío' };
  }
  var sizes = [12, 16, 20];
  for (var si = 0; si < sizes.length; si++) {
    for (var attempt = 0; attempt < 15; attempt++) {
      var result = _sv2TryCrossword(pairs, sizes[si]);
      if (result) {
        var numbered = _sv2NumberCrossword(result.grid, result.placements, sizes[si]);
        return { ok: true, size: sizes[si], grid: result.grid, placements: numbered };
      }
    }
  }
  return { ok: false, reason: 'no se pudo armar el crucigrama ni en grilla 20x20' };
}

// ════ Render estático — Crucigrama ════
function scormV2RoomHtml_crucigrama(data, gridResult) {
  var built = gridResult || sv2BuildCrosswordGrid(data.pairs || []);
  if (!built.ok) throw new Error('scormV2RoomHtml_crucigrama: ' + built.reason);
  var letterCells = {};
  built.placements.forEach(function (p) {
    for (var i = 0; i < p.term.length; i++) {
      var r = p.dir === 'down' ? p.row + i : p.row;
      var c = p.dir === 'across' ? p.col + i : p.col;
      letterCells[r + ',' + c] = { answer: p.term[i] };
    }
  });
  var numberAt = {};
  built.placements.forEach(function (p) { numberAt[p.row + ',' + p.col] = p.number; });

  var h = '<p class="sv2-scenario">' + _sv2Esc(data.scenario) + '</p>';
  h += '<div class="sv2-crossword-grid" style="grid-template-columns:repeat(' + built.size + ',1fr)">';
  for (var r = 0; r < built.size; r++) {
    for (var c = 0; c < built.size; c++) {
      var key = r + ',' + c;
      if (!letterCells[key]) { h += '<div class="sv2-cw-cell sv2-cw-blank"></div>'; continue; }
      var num = numberAt[key] ? '<span class="sv2-cw-number">' + numberAt[key] + '</span>' : '';
      h += '<div class="sv2-cw-cell" data-row="' + r + '" data-col="' + c + '" data-answer="' + _sv2Esc(letterCells[key].answer) + '">'
        + num + '<input class="sv2-cw-input" maxlength="1" data-row="' + r + '" data-col="' + c + '"></div>';
    }
  }
  h += '</div>';
  var across = built.placements.filter(function (p) { return p.dir === 'across'; }).sort(function (a, b) { return a.number - b.number; });
  var down = built.placements.filter(function (p) { return p.dir === 'down'; }).sort(function (a, b) { return a.number - b.number; });
  h += '<div class="sv2-clues"><div class="sv2-clue-list"><p class="sv2-hint">Horizontales</p>';
  across.forEach(function (p) { h += '<p class="sv2-clue">' + p.number + '. ' + _sv2Esc(p.clue) + '</p>'; });
  h += '</div><div class="sv2-clue-list"><p class="sv2-hint">Verticales</p>';
  down.forEach(function (p) { h += '<p class="sv2-clue">' + p.number + '. ' + _sv2Esc(p.clue) + '</p>'; });
  h += '</div></div>';
  h += '<button class="sv2-check-btn" type="button">Comprobar</button>';
  h += '<p class="sv2-error" hidden></p>';
  return h;
}

function scormV2RoomScript_crucigrama(root) {
  root.querySelectorAll('.sv2-cw-input').forEach(function (input) {
    input.addEventListener('input', function () {
      input.value = input.value.toUpperCase().replace(/[^A-ZÑ]/g, '');
    });
  });
  var checkBtn = root.querySelector('.sv2-check-btn');
  checkBtn.addEventListener('click', function () {
    var allCorrect = true;
    var allFilled = true;
    root.querySelectorAll('.sv2-cw-cell[data-answer]').forEach(function (cellEl) {
      var input = cellEl.querySelector('.sv2-cw-input');
      cellEl.classList.remove('sv2-cw-cell-wrong');
      if (!input.value) { allFilled = false; return; }
      if (input.value !== cellEl.getAttribute('data-answer')) {
        allCorrect = false;
        cellEl.classList.add('sv2-cw-cell-wrong');
      }
    });
    var err = root.querySelector('.sv2-error');
    if (!allFilled) {
      err.hidden = false;
      err.textContent = 'Completa todas las casillas antes de comprobar.';
      return;
    }
    err.hidden = true;
    if (allCorrect) {
      sv2CompleteRoom(true);
    } else {
      err.hidden = false;
      err.textContent = 'Hay respuestas incorrectas — revisa las casillas marcadas y vuelve a comprobar.';
    }
  });
}

// ════ Render estático — Ruleta de preguntas ════
// SVG en vez de imagen — permite colorear cada gajo con opacidades de
// --sv2-accent sin agregar ningún asset ni hue nuevo (brief §5.5).
function scormV2RoomHtml_ruletaPreguntas(data) {
  var cats = data.categories || [];
  var n = cats.length;
  var h = '<p class="sv2-scenario">' + _sv2Esc(data.scenario) + '</p>';
  h += '<div class="sv2-wheel-wrap">';
  h += '<svg class="sv2-wheel" id="sv2-wheel-svg" viewBox="-100 -100 200 200" width="220" height="220">';
  for (var i = 0; i < n; i++) {
    var startAngle = (i / n) * 2 * Math.PI - Math.PI / 2;
    var endAngle = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2;
    var x1 = 95 * Math.cos(startAngle), y1 = 95 * Math.sin(startAngle);
    var x2 = 95 * Math.cos(endAngle), y2 = 95 * Math.sin(endAngle);
    var largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;
    var opacity = 0.15 + (i % 2) * 0.15;
    h += '<path data-category-id="' + _sv2Esc(cats[i].id) + '" class="sv2-wheel-slice" '
      + 'd="M0,0 L' + x1.toFixed(2) + ',' + y1.toFixed(2) + ' A95,95 0 ' + largeArc + ' 1 ' + x2.toFixed(2) + ',' + y2.toFixed(2) + ' Z" '
      + 'fill="rgba(47,111,237,' + opacity + ')" stroke="#fff" stroke-width="1"></path>';
    var midAngle = (startAngle + endAngle) / 2;
    var lx = 60 * Math.cos(midAngle), ly = 60 * Math.sin(midAngle);
    h += '<text x="' + lx.toFixed(2) + '" y="' + ly.toFixed(2) + '" font-size="9" text-anchor="middle" fill="#171b26">' + _sv2Esc(cats[i].label) + '</text>';
  }
  h += '</svg>';
  h += '<div class="sv2-wheel-pointer"></div>';
  h += '</div>';
  h += '<button class="sv2-wheel-spin-btn" type="button">Girar</button>';
  cats.forEach(function (cat) {
    var q = cat.questions[0];
    h += '<div class="sv2-options" data-question-for="' + _sv2Esc(cat.id) + '" hidden>';
    h += '<p class="sv2-scenario">' + _sv2Esc(q.text) + '</p>';
    q.options.forEach(function (o) {
      h += '<button class="sv2-option" data-option-id="' + _sv2Esc(o.id) + '" data-correct="' + (o.correct ? 'true' : 'false') + '">' + _sv2Esc(o.label) + '</button>';
    });
    h += '</div>';
  });
  return h;
}

function scormV2RoomScript_ruletaPreguntas(root) {
  var done = {};
  var total = root.querySelectorAll('.sv2-wheel-slice').length;
  var results = [];
  var spinBtn = root.querySelector('.sv2-wheel-spin-btn');
  var wheel = root.querySelector('.sv2-wheel');
  var rotation = 0;

  var allCategoryIds = [];
  root.querySelectorAll('.sv2-wheel-slice').forEach(function (slice) {
    allCategoryIds.push(slice.getAttribute('data-category-id'));
  });

  spinBtn.addEventListener('click', function () {
    var remaining = allCategoryIds.filter(function (id) { return !done[id]; });
    if (remaining.length === 0) return;
    var target = remaining[Math.floor(Math.random() * remaining.length)];
    var targetIndex = allCategoryIds.indexOf(target);
    var n = allCategoryIds.length;
    var sliceCenterDeg = (targetIndex + 0.5) / n * 360; // matches the render's own slice-angle math
    // La ruleta gira en sentido horario; para que el gajo objetivo quede
    // bajo el puntero fijo (arriba, 0deg) tras rotar, el ángulo final
    // (mod 360) debe ser 360 - sliceCenterDeg. Se suman vueltas completas
    // para la animación, y se ajusta al múltiplo de 360 más cercano que
    // termine en el resto correcto.
    var currentMod = ((rotation % 360) + 360) % 360;
    var desiredMod = (360 - sliceCenterDeg + 360) % 360;
    var delta = ((desiredMod - currentMod) + 360) % 360;
    rotation += 720 + delta;
    wheel.style.transition = 'transform 1.6s cubic-bezier(0.17,0.67,0.23,1)';
    wheel.style.transform = 'rotate(' + rotation + 'deg)';
    spinBtn.disabled = true;
    setTimeout(function () {
      root.querySelectorAll('.sv2-options').forEach(function (opts) { opts.hidden = true; });
      var q = root.querySelector('.sv2-options[data-question-for="' + target + '"]');
      if (q) q.hidden = false;
    }, 1650);
  });

  root.querySelectorAll('.sv2-option').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var container = btn.closest('.sv2-options');
      if (container.getAttribute('data-answered') === 'true') return;
      container.setAttribute('data-answered', 'true');
      var catId = container.getAttribute('data-question-for');
      var correct = btn.getAttribute('data-correct') === 'true';
      container.querySelectorAll('.sv2-option').forEach(function (b) { b.disabled = true; });
      btn.classList.add(correct ? 'sv2-option-correct' : 'sv2-option-wrong');
      done[catId] = true;
      results.push(correct);
      var slice = root.querySelector('.sv2-wheel-slice[data-category-id="' + catId + '"]');
      if (slice) slice.classList.add('sv2-wheel-slice-done');
      setTimeout(function () {
        container.hidden = true;
        spinBtn.disabled = false;
        if (results.length === total) {
          sv2CompleteRoom(results.every(function (r) { return r; }));
        }
      }, 900);
    });
  });
}

// ════ Render estático — Multicamino ════
// Todos los nodos se renderizan de una — el script solo muestra/oculta,
// nunca reconsulta datos. Evita mostrar el árbol completo (spec brief
// §5.6: sin diagrama visible, mantiene tensión narrativa).
function scormV2RoomHtml_multicamino(data) {
  var nodes = data.nodes || [];
  var startNode = nodes.filter(function (n) { return n.id === 'start'; })[0];
  var otherNodes = nodes.filter(function (n) { return n.id !== 'start'; });
  nodes = startNode ? [startNode].concat(otherNodes) : nodes;
  var h = '<p class="sv2-scenario">' + _sv2Esc(data.scenario) + '</p>';
  nodes.forEach(function (node, idx) {
    h += '<div class="sv2-mc-node" id="sv2-node-' + _sv2Esc(node.id) + '" data-node-id="' + _sv2Esc(node.id) + '"' + (idx === 0 ? '' : ' hidden') + '>';
    h += '<p class="sv2-step-indicator">Paso ' + (idx + 1) + ' de ' + nodes.length + '</p>';
    h += '<p class="sv2-scenario">' + _sv2Esc(node.text) + '</p>';
    h += '<div class="sv2-options">';
    node.options.forEach(function (o) {
      h += '<button class="sv2-option" data-option-id="' + _sv2Esc(o.id) + '" data-leads-to="' + _sv2Esc(o.leadsTo) + '" data-good-path="' + (o.isGoodPath ? 'true' : 'false') + '">' + _sv2Esc(o.label) + '</button>';
    });
    h += '</div></div>';
  });
  return h;
}

function scormV2RoomScript_multicamino(root) {
  var allGoodPath = true;
  root.querySelectorAll('.sv2-option').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var currentNode = btn.closest('.sv2-mc-node');
      if (currentNode.getAttribute('data-answered') === 'true') return;
      currentNode.setAttribute('data-answered', 'true');
      var leadsTo = btn.getAttribute('data-leads-to');
      var good = btn.getAttribute('data-good-path') === 'true';
      if (!good) allGoodPath = false;
      currentNode.querySelectorAll('.sv2-option').forEach(function (b) { b.disabled = true; });
      btn.classList.add(good ? 'sv2-option-correct' : 'sv2-option-wrong');
      setTimeout(function () {
        if (leadsTo === 'end') {
          sv2CompleteRoom(allGoodPath);
          return;
        }
        currentNode.hidden = true;
        var next = root.querySelector('[data-node-id="' + leadsTo + '"]');
        if (next) next.hidden = false;
      }, 900);
    });
  });
}

// ════ Render estático — Armar el proceso ════
function scormV2RoomHtml_armarProceso(data) {
  var steps = data.steps || [];
  var h = '<p class="sv2-scenario">' + _sv2Esc(data.scenario) + '</p>';
  h += '<div class="sv2-sequence">';
  steps.forEach(function (s) {
    h += '<div class="sv2-slot" data-order="' + s.order + '" role="button" tabindex="0" aria-label="Paso ' + s.order + '"><span class="sv2-slot-number">' + s.order + '</span></div>';
  });
  h += '</div>';
  h += '<p class="sv2-hint">Toca un paso y después el número donde va.</p>';
  h += '<div class="sv2-tray">';
  // orden del tray deliberadamente distinto al orden correcto (shuffle
  // determinístico simple: orden inverso) — la IA no decide el layout.
  steps.slice().reverse().forEach(function (s) {
    h += '<button class="sv2-chip" data-item-id="' + _sv2Esc(s.id) + '" data-item-order="' + s.order + '">' + _sv2Esc(s.label) + '</button>';
  });
  h += '</div>';
  h += '<p class="sv2-error" hidden></p>';
  return h;
}

function scormV2RoomScript_armarProceso(root) {
  var placed = {};
  var totalSteps = root.querySelectorAll('.sv2-slot').length;
  var selected = null;
  var hadWrongAttempt = false;

  root.querySelectorAll('.sv2-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      if (chip.classList.contains('sv2-chip-placed')) return;
      root.querySelectorAll('.sv2-chip').forEach(function (c) { c.classList.remove('sv2-chip-selected'); });
      selected = chip;
      chip.classList.add('sv2-chip-selected');
    });
  });

  root.querySelectorAll('.sv2-slot').forEach(function (slot) {
    function activateSlot() {
      var err = root.querySelector('.sv2-error');
      if (!selected) { err.hidden = false; err.textContent = 'Primero toca un paso de la lista.'; return; }
      err.hidden = true;
      var itemOrder = selected.getAttribute('data-item-order');
      var slotOrder = slot.getAttribute('data-order');
      if (itemOrder === slotOrder) {
        slot.classList.add('sv2-slot-filled');
        slot.textContent = '';
        var label = document.createElement('span');
        label.textContent = selected.textContent;
        slot.appendChild(label);
        selected.classList.add('sv2-chip-placed');
        selected.disabled = true;
        placed[slotOrder] = true;
        selected = null;
        if (Object.keys(placed).length === totalSteps) sv2CompleteRoom(!hadWrongAttempt);
      } else {
        hadWrongAttempt = true;
        slot.classList.add('sv2-slot-wrong');
        setTimeout(function () { slot.classList.remove('sv2-slot-wrong'); }, 450);
      }
    }
    slot.addEventListener('click', activateSlot);
    slot.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        activateSlot();
      }
    });
  });
}

// ════ Shell del mapa de salas — ensambla el SCO completo ════
// Reusa EXACTAMENTE el wiring SCORM 1.2 ya probado en buildScormHtml()
// (06-scorms.js:1461-1463): _findAPI sube por window.parent, scSet hace
// LMSSetValue+LMSCommit. Se reporta una sola vez, al completar las 5
// salas — nunca sala por sala (spec §9).
var SV2_ROOM_RENDERERS = {
  equipar_escena: { html: scormV2RoomHtml_equiparEscena, script: scormV2RoomScript_equiparEscena },
  decision_consecuencia: { html: scormV2RoomHtml_decisionConsecuencia, script: scormV2RoomScript_decisionConsecuencia },
  sopa_letras: { html: scormV2RoomHtml_sopaLetras, script: scormV2RoomScript_sopaLetras },
  crucigrama: { html: scormV2RoomHtml_crucigrama, script: scormV2RoomScript_crucigrama },
  ruleta_preguntas: { html: scormV2RoomHtml_ruletaPreguntas, script: scormV2RoomScript_ruletaPreguntas },
  multicamino: { html: scormV2RoomHtml_multicamino, script: scormV2RoomScript_multicamino },
  armar_proceso: { html: scormV2RoomHtml_armarProceso, script: scormV2RoomScript_armarProceso }
};

// Extraído de buildScormV2Html para que la preview en vivo de la galería/
// picker (42-scorm-templates-ui.js) pueda reusar exactamente el mismo CSS
// que ve el alumno en el SCO real, sin duplicarlo — si el motor cambia
// visualmente, la preview cambia sola, nunca se desincroniza.
function sv2GetRoomCss() {
  return ':root{--sv2-bg:#f5f6f9;--sv2-surface:#ffffff;--sv2-ink:#171b26;'
    + '--sv2-ink-muted:#5b6272;--sv2-accent:#2f6fed;--sv2-success:#1f9d63;'
    + '--sv2-danger:#d64545;--sv2-border:#e2e4ea;}\n'
    + '*{box-sizing:border-box;}\n'
    + 'body{margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;background:var(--sv2-bg);color:var(--sv2-ink);}\n'
    + '.sv2-shell{max-width:640px;margin:0 auto;padding:20px 16px 40px;}\n'
    + '.sv2-progress{display:flex;gap:6px;margin-bottom:20px;}\n'
    + '.sv2-progress-dot{flex:1;height:4px;border-radius:2px;background:var(--sv2-border);}\n'
    + '.sv2-progress-dot.sv2-progress-done{background:var(--sv2-accent);}\n'
    + '.sv2-panel{background:var(--sv2-surface);border-radius:12px;padding:20px;border:1px solid var(--sv2-border);}\n'
    + '.sv2-scenario{font-size:14px;color:var(--sv2-ink-muted);margin:0 0 14px;}\n'
    + '.sv2-figure{position:relative;width:180px;height:210px;margin:0 auto 18px;}\n'
    + '.sv2-zone{position:absolute;background:var(--sv2-bg);border:1.5px solid var(--sv2-border);border-radius:12px;cursor:pointer;}\n'
    + '.sv2-zone-head{left:50%;top:0;transform:translateX(-50%);width:48px;height:48px;border-radius:50%;}\n'
    + '.sv2-zone-torso{left:50%;top:56px;transform:translateX(-50%);width:74px;height:84px;}\n'
    + '.sv2-zone-hands{left:20px;top:78px;width:28px;height:28px;border-radius:50%;}\n'
    + '.sv2-zone-feet{left:50%;top:148px;transform:translateX(-50%);width:68px;height:30px;}\n'
    + '.sv2-zone-filled{border-color:var(--sv2-accent);background:rgba(47,111,237,.12);}\n'
    + '.sv2-zone-wrong{border-color:var(--sv2-danger);background:rgba(214,69,69,.12);}\n'
    + '.sv2-tray{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;}\n'
    + '.sv2-chip{font-size:13px;padding:8px 14px;border-radius:8px;border:1px solid var(--sv2-border);background:var(--sv2-surface);cursor:pointer;}\n'
    + '.sv2-chip-selected{border-color:var(--sv2-accent);background:rgba(47,111,237,.08);}\n'
    + '.sv2-chip-placed{opacity:.4;}\n'
    + '.sv2-hint{font-size:13px;color:var(--sv2-ink-muted);text-align:center;margin:0 0 14px;}\n'
    + '.sv2-error{font-size:13px;color:var(--sv2-danger);text-align:center;}\n'
    + '.sv2-options{display:flex;flex-direction:column;gap:10px;}\n'
    + '.sv2-option{font-size:14px;text-align:left;padding:12px 14px;border-radius:10px;border:1px solid var(--sv2-border);background:var(--sv2-surface);cursor:pointer;}\n'
    + '.sv2-option-correct{border-color:var(--sv2-success);background:rgba(31,157,99,.1);}\n'
    + '.sv2-option-wrong{border-color:var(--sv2-danger);background:rgba(214,69,69,.1);}\n'
    + '.sv2-consequence{font-size:13px;margin:0 0 6px;color:var(--sv2-ink-muted);}\n'
    + '.sv2-report-row{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--sv2-border);font-size:14px;}\n'
    + '.sv2-grid{display:grid;gap:2px;max-width:420px;margin:0 auto 16px;font-family:"JetBrains Mono",monospace;}\n'
    + '.sv2-cell{aspect-ratio:1;display:flex;align-items:center;justify-content:center;background:var(--sv2-surface);border:1px solid var(--sv2-border);font-size:13px;cursor:pointer;user-select:none;}\n'
    + '.sv2-cell-found{background:rgba(31,157,99,.18);border-color:var(--sv2-success);}\n'
    + '.sv2-cell-selected{background:rgba(47,111,237,.18);outline:2px solid var(--sv2-accent);outline-offset:-2px;}\n'
    + '.sv2-cell-wrong-flash{background:rgba(214,69,69,.25);}\n'
    + '.sv2-chip-found{opacity:.4;text-decoration:line-through;}\n'
    + '.sv2-crossword-grid{display:grid;gap:1px;max-width:480px;margin:0 auto 16px;background:var(--sv2-border);}\n'
    + '.sv2-cw-cell{position:relative;aspect-ratio:1;background:var(--sv2-surface);}\n'
    + '.sv2-cw-blank{background:transparent;}\n'
    + '.sv2-cw-number{position:absolute;top:1px;left:2px;font-size:8px;color:var(--sv2-ink-muted);}\n'
    + '.sv2-cw-input{width:100%;height:100%;border:none;text-align:center;text-transform:uppercase;font-size:13px;background:transparent;padding:0;}\n'
    + '.sv2-cw-input:focus{outline:2px solid var(--sv2-accent);outline-offset:-2px;}\n'
    + '.sv2-cw-cell-wrong{background:rgba(214,69,69,.15);}\n'
    + '.sv2-clues{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:16px;}\n'
    + '.sv2-clue-list{flex:1;min-width:180px;}\n'
    + '.sv2-clue{font-size:13px;margin:0 0 6px;color:var(--sv2-ink);}\n'
    + '.sv2-check-btn{display:block;margin:0 auto;padding:10px 20px;border-radius:8px;border:none;background:var(--sv2-accent);color:#fff;font-size:14px;cursor:pointer;}\n'
    + '.sv2-wheel-wrap{position:relative;width:220px;height:220px;margin:0 auto 16px;}\n'
    + '.sv2-wheel{width:100%;height:100%;}\n'
    + '.sv2-wheel-slice-done{opacity:.25;}\n'
    + '.sv2-wheel-pointer{position:absolute;top:-6px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-top:14px solid var(--sv2-accent);}\n'
    + '.sv2-wheel-spin-btn{display:block;margin:0 auto 16px;padding:10px 24px;border-radius:8px;border:none;background:var(--sv2-accent);color:#fff;font-size:14px;cursor:pointer;}\n'
    + '.sv2-wheel-spin-btn:disabled{opacity:.5;cursor:default;}\n'
    + '.sv2-step-indicator{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--sv2-ink-muted);margin:0 0 8px;}\n'
    + '.sv2-sequence{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:14px;}\n'
    + '.sv2-slot{width:56px;height:56px;border:1.5px dashed var(--sv2-border);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:11px;cursor:pointer;text-align:center;padding:4px;}\n'
    + '.sv2-slot-number{font-size:16px;font-weight:700;color:var(--sv2-ink-muted);}\n'
    + '.sv2-slot-filled{border-style:solid;border-color:var(--sv2-accent);background:rgba(47,111,237,.1);font-weight:600;}\n'
    + '.sv2-slot-wrong{border-color:var(--sv2-danger);background:rgba(214,69,69,.12);}\n';
}

function buildScormV2Html(cap, roomAssignment, roomsData) {
  if (!Array.isArray(roomAssignment) || roomAssignment.length !== 5) {
    throw new Error('buildScormV2Html: se esperan exactamente 5 salas, hay ' + (roomAssignment ? roomAssignment.length : 0));
  }
  if (!Array.isArray(roomsData) || roomsData.length !== 5) {
    throw new Error('buildScormV2Html: se esperan datos de exactamente 5 salas, hay ' + (roomsData ? roomsData.length : 0));
  }
  var capTitle = _sv2Esc(cap.t);

  var roomsHtml = '';
  var roomScripts = '';
  for (var i = 0; i < 5; i++) {
    var templateId = roomAssignment[i];
    var renderer = SV2_ROOM_RENDERERS[templateId];
    if (!renderer) {
      throw new Error('buildScormV2Html: plantilla desconocida "' + templateId + '" en la sala ' + (i + 1));
    }
    if (!roomsData[i] || !roomsData[i].data) {
      throw new Error('buildScormV2Html: falta el contenido de la sala ' + (i + 1));
    }
    var roomData = roomsData[i].data;
    roomsHtml += '<div class="sv2-room" id="sv2-room-' + i + '" data-room-index="' + i + '"' + (i === 0 ? '' : ' hidden') + '>'
      + renderer.html(roomData) + '</div>';
    // Nota: .toString() de una function declaration incluye su nombre
    // literal (p.ej. "function scormV2RoomScript_equiparEscena(){...}").
    // Se despoja el nombre al embeberla — es una IIFE, nunca se referencia
    // por nombre — para no filtrar los nombres internos del motor en el
    // HTML final del SCO.
    roomScripts += '(' + renderer.script.toString().replace(/^function\s+\w+/, 'function') + ')(document.getElementById("sv2-room-' + i + '"));\n';
  }

  var css = sv2GetRoomCss();

  var script = 'var SV2={current:0,total:5,results:[null,null,null,null,null]};\n'
    + 'var _scAPI=null;\n'
    + 'function _findAPI(w){try{if(w.API)return w.API;if(w.parent&&w.parent!=w)return _findAPI(w.parent);return null;}catch(e){return null;}}\n'
    + 'function scSet(k,v){try{if(_scAPI){_scAPI.LMSSetValue(k,String(v));_scAPI.LMSCommit("");}}catch(e){}}\n'
    + 'function sv2ShowRoom(i){for(var r=0;r<SV2.total;r++){var el=document.getElementById("sv2-room-"+r);if(el)el.hidden=(r!==i);}'
    + 'for(var d=0;d<SV2.total;d++){var dot=document.getElementById("sv2-dot-"+d);if(dot)dot.classList.toggle("sv2-progress-done",d<=i);}}\n'
    + 'function sv2CompleteRoom(passed){SV2.results[SV2.current]=!!passed;'
    + 'if(SV2.current<SV2.total-1){SV2.current++;sv2ShowRoom(SV2.current);}else{sv2ShowReport();}}\n'
    + 'function sv2ShowReport(){var reportEl=document.getElementById("sv2-report");var roomsWrap=document.getElementById("sv2-rooms");'
    + 'if(roomsWrap)roomsWrap.hidden=true;if(reportEl){reportEl.hidden=false;var rows="";'
    + 'SV2.results.forEach(function(ok,i){rows+="<div class=\\"sv2-report-row\\"><span>Sala "+(i+1)+"</span><span style=\\"color:"+(ok?"var(--sv2-success)":"var(--sv2-danger)")+"\\">"+(ok?"Correcto":"A reforzar")+"</span></div>";});'
    + 'reportEl.innerHTML="<p style=\\"font-weight:600;margin:0 0 8px;\\">Informe de desempeño</p>"+rows;}'
    + 'var passedCount=SV2.results.filter(function(r){return r;}).length;'
    + 'var pct=Math.round(passedCount/SV2.total*100);'
    + 'scSet("cmi.core.score.raw",pct);scSet("cmi.core.lesson_status",pct>=60?"passed":"failed");'
    + 'try{_scAPI.LMSCommit("");_scAPI.LMSFinish("");}catch(x){}}\n'
    + roomScripts
    + 'window.onload=function(){try{_scAPI=_findAPI(window);if(_scAPI)_scAPI.LMSInitialize("");}catch(e){}sv2ShowRoom(0);};\n';

  var dots = '';
  for (var di = 0; di < 5; di++) dots += '<div class="sv2-progress-dot" id="sv2-dot-' + di + '"></div>';

  return '<!DOCTYPE html>\n<html lang="es">\n<head>\n<meta charset="UTF-8">\n'
    + '<meta name="viewport" content="width=device-width,initial-scale=1.0">\n'
    + '<title>' + capTitle + '</title>\n<style>' + css + '</style>\n</head>\n<body>\n'
    + '<div class="sv2-shell">'
    + '<div class="sv2-progress">' + dots + '</div>'
    + '<div class="sv2-panel" id="sv2-rooms">' + roomsHtml + '</div>'
    + '<div class="sv2-panel" id="sv2-report" hidden></div>'
    + '</div>\n<script>' + script + '</script>\n</body>\n</html>';
}

// ════ Orquestación — genera las 5 salas de un capítulo, con reintento
// por sala individual (no por capítulo completo) ante fallo de
// validación. Mismo patrón de "pedir menos en el reintento" que
// _pSCORM_data_retry (06-scorms.js:1847), pero acá no hay "menos salas"
// que pedir (siempre son 5 fijas) — el reintento simplemente repite la
// misma sala una vez más con un recordatorio explícito de formato.
var SCORM_V2_MAX_TOK = 4000; // ambas plantillas de este plan son datos
                              // chicos (6 items o 3 opciones) — muy por
                              // debajo del piso de 6000 que usa el motor
                              // viejo para sus mecánicas livianas.

// ════ R25 — robustez de plantillas basadas en palabras (Fase 5A blocker) ════
// El modelo repetía términos demasiado largos/cortos ("APUNTALAMIENTO" 14,
// "EPP" 3) porque el reintento solo nombraba el PRIMER término inválido —
// compartido acá (usado por genScormRoomV2 legacy y _dynGenScormRoomV2
// dynamic en 45-dynamic-generation-executor.js, que carga después de este
// archivo) para que ambos textos de reintento sean byte-idénticos.
var SCORM_V2_WORD_TEMPLATES = ['sopa_letras', 'crucigrama'];

function scormV2RetryPromptFor(basePrompt, v) {
  if (v && Array.isArray(v.invalidTerms) && v.invalidTerms.length > 0) {
    var _sv2RetryList = v.invalidTerms.map(function (t) {
      return '"' + t.text + '" (' + t.len + ' letras)';
    }).join(', ');
    return basePrompt + '\n\n⚠️ REINTENTO: ' + v.invalidTerms.length + ' término(s) no cumplen 4-10 letras/MAYÚSCULAS/sin tildes: '
      + _sv2RetryList + '. Reemplaza CADA UNO por un sinónimo o un término más corto, de 4 a 10 letras, en MAYÚSCULAS, '
      + 'sin tildes ni espacios — cuenta las letras de cada término antes de responder. '
      + 'Responde de nuevo con el JSON completo, respetando la estructura exacta pedida arriba.';
  }
  return basePrompt + '\n\n⚠️ REINTENTO: la respuesta anterior no cumplió el formato exacto ('
    + v.reason + '). Responde de nuevo con el JSON completo, respetando la estructura exacta pedida arriba.';
}

// Elige la plantilla de reemplazo para una sala de palabras que sigue
// fallando tras su reintento: la primera plantilla activa que NO sea de
// palabras, evitando —si es simple— la que ya usa una sala adyacente.
// Devuelve null si no hay ninguna plantilla activa elegible (se mantiene
// el fallo tal cual, sin reemplazo).
function scormV2PickFallbackTemplate(activeTemplateIds, roomAssignment, roomIndex) {
  var eligible = (activeTemplateIds || []).filter(function (id) {
    return SCORM_V2_WORD_TEMPLATES.indexOf(id) === -1;
  });
  if (eligible.length === 0) return null;
  var adjacent = [roomAssignment[roomIndex - 1], roomAssignment[roomIndex + 1]];
  var preferred = eligible.filter(function (id) { return adjacent.indexOf(id) === -1; });
  return preferred.length > 0 ? preferred[0] : eligible[0];
}

async function genScormRoomV2(cap, templateId, sys, c) {
  var prompt = scormV2PromptFor(templateId, cap, c);
  var schema = scormV2SchemaFor(templateId);
  try {
    var raw = await apiRetry(sys, prompt, SCORM_V2_MAX_TOK, 3, schema);
    var clean = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    var data = JSON.parse(clean);
    var v = scormV2ValidateRoomData(templateId, data);
    if (v.ok) return { ok: true, data: data, reason: 'ok' };

    // Reintento único, mismo templateId, prompt reforzado
    var retryPrompt = scormV2RetryPromptFor(prompt, v);
    var raw2 = await apiRetry(sys, retryPrompt, SCORM_V2_MAX_TOK, 3, schema);
    var clean2 = raw2.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    var data2 = JSON.parse(clean2);
    var v2 = scormV2ValidateRoomData(templateId, data2);
    if (v2.ok) return { ok: true, data: data2, reason: 'ok tras reintento' };
    return { ok: false, data: null, reason: v2.reason };
  } catch (e) {
    return { ok: false, data: null, reason: (e && (e.msg || e.message || String(e))) || 'error desconocido' };
  }
}

async function genScormChapterV2(cap, activeTemplateIds) {
  var sys = scormV2SysPrompt();
  var c = ctx();
  var roomAssignment = assignRoomTemplates(activeTemplateIds, 5);
  var roomsData = [];
  for (var i = 0; i < 5; i++) {
    var originalTemplateId = roomAssignment[i];
    var result = await genScormRoomV2(cap, originalTemplateId, sys, c);
    // R25: una sala de palabras que sigue fallando tras su propio reintento
    // se reintenta UNA vez más con una plantilla activa no-palabras, en vez
    // de tumbar el capítulo entero por un término demasiado largo/corto.
    if (!result.ok && SCORM_V2_WORD_TEMPLATES.indexOf(originalTemplateId) !== -1) {
      var fallbackId = scormV2PickFallbackTemplate(activeTemplateIds, roomAssignment, i);
      if (fallbackId) {
        console.warn('[scorm v2] sala ' + (i + 1) + ': fallback ' + originalTemplateId + '→' + fallbackId);
        var fbResult = await genScormRoomV2(cap, fallbackId, sys, c);
        if (fbResult.ok) roomAssignment[i] = fallbackId;
        result = fbResult;
      }
    }
    roomsData.push(result.ok ? { templateId: roomAssignment[i], data: result.data } : null);
    if (!result.ok) {
      console.error('[genScormChapterV2] Cap ' + cap.n + ' sala ' + (i + 1) + ' (' + roomAssignment[i] + '): ' + result.reason);
    }
  }
  var chapterValidation = scormV2ValidateChapterRooms(roomAssignment, roomsData);
  if (!chapterValidation.ok) {
    return { ok: false, reason: chapterValidation.reason };
  }
  var html = buildScormV2Html(cap, roomAssignment, roomsData);
  F['scorm_cap' + cap.n + '_index.html'] = html;
  F['scorm_cap' + cap.n + '_manifest.xml'] = defMf(cap);
  return { ok: true, reason: 'ok' };
}
