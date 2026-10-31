// ════ Fase 5A — Builders de prompt DYNAMIC (puros) ════
// Contraparte pura de los prompts legacy (05-libro.js/06-scorms.js/07-examenes.js)
// para el ejecutor dynamic (Task 6). Reglas duras (spec §7 condición 1):
//   - NUNCA leen el objeto de estado global del curso ni el mapa de archivos generados — todo entra por parámetros.
//   - Reciben (courseContext, blueprintSlice, ...): courseContext = el
//     contexto de run congelado (`generation_run_contexts`, mismos campos
//     que CourseContextDto/normalizeCourseContext en el backend); las
//     piezas de blueprint (module/chapter/chapterTitles) vienen del
//     ClaimedItem.blueprint del scheduler — nunca de la estructura viva.
//   - Los legacy correspondientes (`ctx`, `pLibro`, `sysL`, `pSCORM_data`,
//     `sysScormData`, `pGIFT`, `sysG`) NO se tocan.
//
// courseContext (ver course-context.dto.ts / run-hash.ts CONTEXT_STRING_FIELDS):
//   { nombre, sector, pais, ciudad?, contexto, nivel, tono, obj?, comp?,
//     prevCourse?: { nombre, caps: string[] } }
// Campos opcionales AUSENTES (normalizeCourseContext los borra si están
// vacíos/blancos) se tratan igual que un campo equivalente vacío del estado
// global en legacy — nunca como `undefined` literal.
//
// outline (R18 — ClaimedItem.blueprint.outline, armado en scheduler.service.ts
// desde el snapshot congelado del Blueprint + la numeración del Manifest,
// NUNCA de la estructura viva — condición 1): el curso COMPLETO, en orden del
// Manifest, con numeración global de capítulo:
//   [{ moduleNumber, id, title, chapters: [{ chapterNumber, id, title }] }]

// ── dynCtx — equivalente puro de ctx() (02-run.js:19) ──
// R18: ctx() legacy SIEMPRE inyecta la competencia ("Competencia") y una línea
// "Estructura" + el detalle de los módulos en TODO prompt — omitirlos degradaba el
// contexto en silencio (Ruling R18; spec §3.5 los había dejado fuera por
// descuido). Con `comp` ahora en courseContext y `outline` en el blueprint
// slice, dynCtx los reproduce:
//   - "Competencia: <comp>" SOLO si `comp` está presente. Legacy imprime la
//     línea SIEMPRE, incluso con la competencia vacía/`undefined` ("Competencia: " o
//     "Competencia: undefined") — pero `comp` normalizado nunca distingue
//     "vacío" de "ausente" (igual que `obj`/`ciudad`), así que no hay forma
//     de reproducir ese caso vacío-pero-presente. Decisión: cuando `comp`
//     está ausente, OMITIR la línea entera (no imprimir "Competencia: " ni
//     "Competencia: undefined") — divergencia documentada, no aplica al caso
//     de equivalencia (la competencia siempre viene poblada en los cursos reales).
//   - "Estructura: N módulos · M capítulos" — legacy hardcodea literalmente
//     "3 módulos · 9 capítulos" SIN mirar la cantidad real de módulos; dynamic calcula N/M
//     reales desde `outline`. Para un curso 3×3 da el mismo texto byte a
//     byte; para cualquier otro (ver casos dynamic-only) el texto legacy
//     sería directamente incorrecto — el propósito de Task 5/R18 es evitar
//     ese hardcode, no reproducirlo.
//   - Una línea por módulo "Módulo N: título | Cap G1: título1 | Cap G2:
//     título2 …", con G = chapterNumber GLOBAL de `outline` (no `i*3+ci+1`).
// R14 — veracidad y localización, comunes a TODOS los prompts dinámicos (el Libro Guía anterior
// EXIGÍA "datos numéricos verificables" y "empresa real con datos": el modelo no puede verificar y
// los inventaba —estudios, encuestas, porcentajes—; y derivaba al voseo en un curso para Colombia).
var DYN_TRUTH_RULES = 'VERACIDAD (obligatorio): no inventes estadísticas, porcentajes, encuestas, estudios, informes, instituciones, autores, fechas ni citas, ni presentes cifras como datos reales. '
  + 'Si un número ayuda a ilustrar, preséntalo explícitamente como ejemplo hipotético ("imagina un grupo de 30 estudiantes"). '
  + 'Solo menciona investigación ampliamente reconocida (p. ej., Hattie sobre retroalimentación) y sin cifras exactas ni multiplicadores (nunca digas que una práctica duplica, triplica o multiplica el aprendizaje). '
  + 'No afirmes capacidades ni limitaciones permanentes de las herramientas de IA (acceso a internet, memoria entre conversaciones, "no hará"): varían y cambian; di que depende de la herramienta. '
  + 'Cita las leyes por su nombre oficial en el país del curso (en Colombia, protección de datos = Ley 1581 de 2012 / Habeas Data); nunca siglas de leyes de otros países (LOPD es de España). '
  + 'No asignes formatos a "estudiantes visuales, auditivos o kinestésicos" (neuromito); varía formatos por necesidad, accesibilidad o preferencia observada. '
  + 'Los casos, personajes y ejemplos que escribas son ilustrativos: nunca los rotules ni presentes como «caso real», «ejemplo real» o «historia real». '
  + 'No afirmes capacidades, versiones ni fechas de corte de productos concretos (ChatGPT, Copilot, Gemini, Claude…): habla de "herramientas de IA generativa".';
// Language QA (piloto, 2026-10-07): español latinoamericano NEUTRO para cualquier país (antes Argentina, Uruguay y
// Paraguay tenían voseo). Se conserva dynUsesVoseo por compatibilidad: siempre false.
function dynUsesVoseo() { return false; }
function dynLocaleRule() {
  if (typeof lqaLanguageRule === 'function') return lqaLanguageRule();
  return 'IDIOMA: español latinoamericano NEUTRO, profesional y académico, con tuteo ("puedes", "debes", "realiza"); NUNCA voseo, "vosotros" ni regionalismos de ningún país.';
}

function dynCtx(courseContext, outline) {
  var ctx = courseContext || {};
  var nombre = ctx.nombre || '';
  var sector = ctx.sector || '';
  var pais = ctx.pais || '';
  var ciudad = ctx.ciudad || '';
  var contexto = ctx.contexto || '';
  var nivel = ctx.nivel || '';
  var tono = ctx.tono || '';
  var obj = ctx.obj || '';

  var s = 'Curso: "' + nombre + '" | Sector: ' + sector + ' | País: ' + pais + (ciudad ? ' | Ciudad: ' + ciudad : '');
  s += '\nContexto educativo: ' + contexto;
  s += '\nNivel de conocimiento: ' + nivel + ' | Tono: ' + tono;
  if (ctx.prevCourse && ctx.prevCourse.caps && ctx.prevCourse.caps.length) {
    s += '\nSECUENCIA CURRICULAR: Este curso es la continuación de "' + ctx.prevCourse.nombre + '".';
    s += '\nTemas YA CUBIERTOS por el estudiante (NO repetir, construir sobre ellos): ' + ctx.prevCourse.caps.join(' | ');
    s += '\nAsegúrate de que los nuevos temas profundicen o avancen desde los anteriores.';
  }
  s += '\nObjetivo: ' + obj;
  s += '\n' + DYN_TRUTH_RULES + '\n' + dynLocaleRule(courseContext);
  if (ctx.comp) {
    s += '\nCompetencia: ' + ctx.comp;
  }
  if (outline && outline.length) {
    var chapterCount = outline.reduce(function (t, mo) { return t + ((mo.chapters && mo.chapters.length) || 0); }, 0);
    s += '\nEstructura: ' + outline.length + ' módulos · ' + chapterCount + ' capítulos';
    outline.forEach(function (mo) {
      s += '\nMódulo ' + mo.moduleNumber + ': ' + mo.title;
      (mo.chapters || []).forEach(function (c) {
        s += ' | Cap ' + c.chapterNumber + ': ' + c.title;
      });
    });
  }
  return s;
}

// ── dynSysL — equivalente puro de sysL() (05-libro.js) ──
// sysL() lee el tono del curso desde el estado global; el resto del texto es estático. Copia carácter por
// carácter (incluyendo el escape \\| de la regla 10) salvo por ese campo.
function dynSysL(courseContext) {
  var tono = (courseContext && courseContext.tono) || '';
  return 'Eres diseñador instruccional experto de CampusCloud. Generas libros guía para cursos virtuales. REGLAS: (1) Cada concepto lleva ejemplo concreto del sector y país — NUNCA genérico. (2) PROHIBIDO: "en el mundo actual", "es fundamental entender", "cabe destacar", "en la era digital", "hoy en día". (3) Cada sección 250-400 palabras; sin cifras, estudios ni fuentes inventadas (si ilustras con números, di que son hipotéticos). (4) Tono: ' + tono + '. (5) Tutear al estudiante (tú), nunca voseo. (6) Actividades concretas y accionables con pasos numerados. (7) Incluir mínimo 1 tabla comparativa por capítulo. (8) Caso ilustrativo del sector, presentado como hipotético (sin nombres de empresas reales ni cifras inventadas). (9) Glosario con 8-12 términos por capítulo. (10) TABLAS MARKDOWN — REGLA CRÍTICA: si una celda contiene la barra vertical | (por ejemplo en fórmulas matemáticas como |f(x)|), escápala como \\| para que no rompa la tabla. Ejemplo correcto: | \\|f(x)-g(x)\\| dx |. Solo Markdown limpio sin explicaciones adicionales, sin bloques de código.';
}

// ── dynLibroChapterPrompt — equivalente puro de pLibro({t:'cap',cn,cap,mi}, c) ──
// (05-libro.js:57). qLibro (05-libro.js:37) calcula cn = mi*3+ci+1 — dynamic
// usa en su lugar el chapterNumber GLOBAL del blueprint (ClaimedItem), que
// ya viene resuelto por el Manifest y no asume 3 capítulos por módulo.
//   outline        = blueprint.outline (R18, ver arriba) — para el prefijo de ctx
//   chapter        = blueprint.chapter  → { title, ... }   (item.cap legacy)
//   module         = blueprint.module   → { title, ... }   (nombre del módulo en el estado global, legacy)
//   chapterNumber  = ClaimedItem.chapterNumber              (item.cn legacy)
//   moduleNumber   = ClaimedItem.moduleNumber (1-based)     (item.mi+1 legacy)
//   seed           = opcional; si no se pasa, Math.random() (igual que legacy)
function dynLibroChapterPrompt(courseContext, outline, chapter, module, chapterNumber, moduleNumber, seed) {
  var c = dynCtx(courseContext, outline);
  var sector = (courseContext && courseContext.sector) || '';
  var pais = (courseContext && courseContext.pais) || '';
  var capTitle = (chapter && chapter.title) || '';
  var modTitle = (module && module.title) || '';
  var s = (typeof seed === 'number') ? seed : Math.random();

  var capScope = (chapter && typeof chapter.description === 'string' && chapter.description.trim())
    ? '\nAlcance del capítulo (qué temas debe cubrir; úsalo como guía, el título del capítulo es el de arriba): ' + chapter.description.replace(/\s+/g, ' ').trim()
    : '';
  // Loop 9 (B-extra-1): con ejercicios guiados propios (blueprint.chapter.guidedPracticeMinutes) el capítulo NO pide además
  // las 2 «Actividades de Apoyo» (serían una práctica duplicada): una línea remite a ellos. Sin ellos, el texto de siempre.
  var hasGuided = !!(chapter && typeof chapter.guidedPracticeMinutes === 'number' && chapter.guidedPracticeMinutes > 0);
  var practiceItems = hasGuided
    ? '4. ✏ Ejercicios guiados: este capítulo tiene sus propios ejercicios guiados, que el estudiante hace al terminarlo. NO escribas actividades de apoyo ni ejercicios propios; cierra con una línea que invite a hacer los ejercicios guiados del capítulo.\n5. ■ Glosario del Capítulo: 8-12 términos con definición clara de 1-2 líneas cada uno'
    : '4. ✏ Actividad de Apoyo ' + chapterNumber + '.1: ejercicio concreto con pasos numerados\n5. ✏ Actividad de Apoyo ' + chapterNumber + '.2: segundo ejercicio práctico con pasos numerados\n6. ■ Glosario del Capítulo: 8-12 términos con definición clara de 1-2 líneas cada uno';
  return c + '\n\nGenera el CAPÍTULO ' + chapterNumber + ' COMPLETO: "' + capTitle + '"\nMódulo ' + moduleNumber + ': ' + modTitle + capScope + '\n\nIncluye:\n1. Secciones ' + chapterNumber + '.1 a ' + chapterNumber + '.5 — 250-400 palabras c/u, ejemplos concretos y plausibles de ' + sector + ' en ' + pais + ' (sin cifras, estudios ni fuentes inventadas)\n2. Mínimo 1 tabla comparativa con criterios cualitativos (sin cifras inventadas)\n3. ■ Caso ' + pais + ': situación ilustrativa de una institución del sector aplicando el tema (en cursiva; hipotética: sin nombres reales ni cifras inventadas)\n' + practiceItems + '\n\nNO generes portada ni tabla de contenido. Empieza directamente con # Capítulo...\nSemilla:' + s;
}

// ── dynScormDataPrompt — equivalente puro de pSCORM_data(item,c) (06-scorms.js:1129) ──
// item.mec  → mechanic { name, qf? }
// item.cap  → chapter  { n: chapterNumber, t: title, mn: moduleTitle }
// item.pack → pack (opcional, misma forma que NFAMILIES: label,id,icon,visualMetaphor,promptStyle,compatibleSectors,readableFontStrategy)
// item.salas→ salas (número de salas pedidas)
// outline   → blueprint.outline (R18) — para el prefijo de ctx
// sysScormData() no lee el estado global del curso — se reutiliza el global
// tal cual (dispatch: "si no lee D, reutilizar tal cual, llamando al
// global"). R18 (d): el system prompt REAL que Task 6 debe usar para el
// SCORM dynamic es `sysS()` (05-libro.js), NO `sysScormData()` — es el que
// usa hoy el único callsite activo de pSCORM_data (15-validator.js:192,
// `_repairScorm`). `sysS()` tampoco lee el estado global del curso, así que
// se reutiliza igual, llamando al global directamente (sin wrapper en este
// archivo) — ver task-5-report.md, sección R18.
function dynScormDataPrompt(courseContext, outline, chapter, mechanic, salas, pack) {
  var c = dynCtx(courseContext, outline);
  var sector = (courseContext && courseContext.sector) || '';
  var pais = (courseContext && courseContext.pais) || '';
  var cap = chapter || {};
  var mec = mechanic || {};
  var mecName = mec.name || 'Quiz';
  var isSeq = mecName === 'Secuencia de Proceso';
  var isSeqPro = mecName === 'Secuencia de Proceso Pro';
  var isInspect = mecName === 'Inspector de Planta';
  var isTurno = mecName === 'Turno de Operario';
  var isChecklist = mecName === 'Checklist Crítico';
  var isErrorHunter = mecName === 'Error Hunter';
  var qf;
  if (isSeqPro) {
    qf = mec.qf ? mec.qf : '{"q":"¿En qué orden se ejecutan los pasos de este procedimiento?","steps":[{"id":"s1","label":"Primer paso","order":1},{"id":"s2","label":"Segundo paso","order":2},{"id":"s3","label":"Tercer paso","order":3},{"id":"s4","label":"Cuarto paso","order":4}],"fb":"Explicación del orden correcto","tolerance":0}';
  } else if (isSeq) {
    qf = '{"q":"nombre del procedimiento a ordenar","steps":["Paso 1 en orden correcto","Paso 2","Paso 3","Paso 4"],"fb":"retroalimentación"} — steps es el orden CORRECTO; NO incluyas opts ni correct';
  } else if (isInspect) {
    qf = '{"q":"¿Qué anomalía o riesgo debes identificar?","scene":"descripción de la escena 2 oraciones","opts":["anomalía real","observación normal 1","observación normal 2","observación normal 3"],"correct":"anomalía real","fb":"retroalimentación"}';
  } else if (isTurno) {
    qf = '{"q":"situación operacional crítica que requiere decisión","opts":["decisión correcta","decisión incorrecta 1","decisión incorrecta 2","decisión incorrecta 3"],"correct":"decisión correcta","consequence":"qué ocurre en la instalación si se decide mal (1 oración dramática)","fb":"retroalimentación"}';
  } else if (isChecklist) {
    qf = mec.qf ? mec.qf : '{"q":"Caso o protocolo a verificar","items":[{"label":"Paso crítico 1","required":true},{"label":"Paso crítico 2","required":true},{"label":"Paso crítico 3","required":true},{"label":"Paso recomendado 1","required":false},{"label":"Paso recomendado 2","required":false}],"minRequired":3,"fb":"feedback"}';
  } else if (isErrorHunter) {
    qf = mec.qf ? mec.qf : '{"q":"¿Qué fragmento contiene el error?","context":"Texto con el error intencionado","errorSpans":[{"id":"e1","text":"fragmento erróneo","isError":true},{"id":"e2","text":"fragmento correcto","isError":false},{"id":"e3","text":"otro fragmento correcto","isError":false}],"correct":"e1","fb":"Explicación del error"}';
  } else {
    qf = mec.qf ? mec.qf : '{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback"}';
  }
  var is2opts = qf.indexOf('["VERDADERO","FALSO"]') >= 0 || qf.indexOf('["CORRECTO","INCORRECTO"]') >= 0;
  var optsRule = is2opts
    ? '- opts: EXACTAMENTE 2 opciones como se indica\n'
    : isSeqPro
      ? '- steps: entre 4 y 7 objetos {id,label,order}; id=s1…s7; label texto plano máx 12 palabras sin HTML; order entero único consecutivo empezando en 1; NO incluyas opts ni correct\n'
      : isSeq
        ? '- steps: exactamente 4 pasos EN ORDEN CORRECTO — sin opts ni correct\n'
        : isChecklist
          ? '- items: entre 5 y 8 objetos {label,required}; mínimo 2 required:true y 2 required:false; minRequired=número total de required:true; NO incluyas opts ni correct\n'
          : isErrorHunter
            ? '- context: texto plano 300-900 chars con el error intencionado; errorSpans: 3-6 objetos {id,text,isError}; exactamente 1 isError:true; correct=id del error; cada text debe aparecer literalmente en context; NO incluyas opts\n'
            : '- opts: exactamente 4 opciones; "correct" debe ser EXACTAMENTE igual a una de opts\n';
  var packCtx = '';
  if (pack) {
    packCtx = '\nFamilia narrativa asignada: ' + pack.label + ' (' + pack.id + ')'
      + '\n  Icono: ' + pack.icon
      + '\n  Metáfora visual: ' + pack.visualMetaphor
      + '\n  Tono y estilo: ' + pack.promptStyle
      + '\n  Sectores compatibles: ' + (pack.compatibleSectors || []).join(', ')
      + '\n  Legibilidad tipográfica: ' + pack.readableFontStrategy
      + '\n  → Aplica esta metáfora en: gameName, tagline, scenario.location, scenario.character, scenario.intro y nombres de salas.'
      + '\n  → El contenido educativo (preguntas, opciones, feedback) debe mantener claridad y legibilidad absoluta, independientemente del estilo narrativo.\n';
  }
  return c + '\n\nGenera las preguntas para un juego SCORM educativo.\n'
    + 'Mecánica: ' + mecName + ' | Capítulo ' + cap.n + ': "' + cap.t + '" | Módulo: ' + cap.mn + ' | Sector: ' + sector + ' | País: ' + pais
    + packCtx + '\n\n'
    + 'Responde SOLO con JSON válido (sin markdown, sin texto extra):\n'
    + '{\n'
    + '  "gameName": "Nombre narrativo con metáfora fuerte (máx 6 palabras) — estilo: Operación Ecosistema, Sala de Crisis, El Infiltrado, UCI Comunitaria, Bóveda de Decisiones, Mapa de Tendencias. NUNCA uses: Quiz de..., Evaluación de..., Actividad de..., Reto de aprendizaje...",\n'
    + '  "tagline": "Subtítulo de 5 a 9 palabras que refuerce la misión, tensión o urgencia de la experiencia",\n'
    + '  "emoji": "un solo emoji representativo de la metáfora del juego",\n'
    + '  "scenario": {\n'
    + '    "location": "Nombre real de instalación/empresa del sector ' + sector + ' en ' + pais + '",\n'
    + '    "character": "Nombre y cargo del personaje (ej: Técnico Andrés Morales, Inspectora HSEQ María Torres)",\n'
    + '    "intro": "3 oraciones cinematográficas: (1) contexto — dónde estás y qué está ocurriendo, (2) conflicto — el problema o riesgo que se ha detectado, (3) misión — qué debe hacer el estudiante para resolverlo."\n'
    + '  },\n'
    + '  "salas": [\n'
    + '    {\n'
    + '      "name": "Nombre dramático que combine ubicación + tensión o reto (ej: Zona de Validación — Hipótesis en Riesgo, Cámara de Clientes — Señales Confusas, Radar de Mercado — Competidor Detectado)",\n'
    + '      "preguntas": [\n'
    + '        ' + qf + ',\n'
    + '        ... 4 preguntas por sala\n'
    + '      ]\n'
    + '    }\n'
    + '  ]\n'
    + '}\n\n'
    + 'REGLAS CRÍTICAS:\n'
    + '- Genera exactamente ' + salas + ' salas con exactamente 4 preguntas cada una\n'
    + optsRule
    + '- gameName: metáfora narrativa fuerte, máx 6 palabras. PROHIBIDO: "Quiz", "Evaluación", "Actividad", "Reto de aprendizaje"\n'
    + '- tagline: 5 a 9 palabras, tono de misión o urgencia, diferente al gameName\n'
    + '- scenario.location: instalación o empresa real del sector en ' + pais + ' (ej petróleo: "Planta Caño Limón, Arauca")\n'
    + '- scenario.character: nombre latinoamericano realista, cargo relacionado con "' + cap.t + '"\n'
    + '- scenario.intro: exactamente 3 oraciones — contexto, conflicto, misión del estudiante\n'
    + '- salas[].name: ubicación real + estado de tensión, no genérico (NUNCA "Sala 1", "Sala A")\n'
    + '- Preguntas específicas sobre "' + cap.t + '" con ejemplos de ' + sector + ' en ' + pais + '\n'
    + '- Variar tipos: conceptual, aplicada, caso real, identificar el error\n'
    + '- LONGITUD: pregunta (campo q) máximo 250 caracteres; cada opción máximo 120 caracteres; feedback (fb) máximo 200 caracteres; sé concreto y directo\n'
    + '- DISTRACTORES: deben representar errores conceptuales reales y típicos del estudiante, no respuestas absurdas; deben ser plausibles, del mismo dominio; PROHIBIDO usar "todas las anteriores" o "ninguna de las anteriores"\n'
    + '- LONGITUD IGUALADA (regla dura, no aproximada): mide en caracteres la opción correcta y cada distractor. La diferencia entre la MÁS LARGA y la MÁS CORTA de las 4 opciones —incluida la correcta— NO debe superar 15 caracteres. La respuesta correcta JAMÁS puede ser la opción más larga del grupo — si el hecho correcto necesita más matiz o detalle, alarga los distractores para igualar, nunca acortes la correcta a costa de precisión. Un estudiante NUNCA debe poder adivinar la respuesta solo por ser la más larga.\n'
    + '- SOLO el JSON, nada más\n'
    + '- IMPORTANTE: cierra todos los arrays y objetos JSON correctamente antes de terminar';
}

// ── dynScormV2RoomPrompt — equivalente puro de scormV2PromptFor(templateId,
// cap, c) (06b-scorm-templates.js:218), el motor SCORM realmente activo hoy
// (Ruling R19 — ver genScormChapterV2, no pSCORM_data). scormV2PromptFor lee
// D (sector/pais) directo del estado global (no del string `c`); acá se
// reciben de `courseContext` en su lugar — el resto del cuerpo es una copia
// literal (misma redacción de reglas por plantilla) para que el prompt salga
// byte a byte igual. `cap` tiene la misma forma que el `cap` legacy:
// { n: chapterNumber GLOBAL, t: title } — construida por el llamador
// (executor, Task 6) desde el ClaimedItem, nunca desde `D`/F.
// Cubre las 7 plantillas del catálogo (SCORM_V2_TEMPLATES, 06b:8) — probado
// por equivalencia exacta contra scormV2PromptFor para cada una (harness).
function dynScormV2RoomPrompt(templateId, cap, courseContext, outline, ped) {
  var c = dynCtx(courseContext, outline);
  var sector = (courseContext && courseContext.sector) || '';
  var pais = (courseContext && courseContext.pais) || '';
  var capTitle = (cap && cap.t) || '';
  var capN = (cap && cap.n) || 0;
  var base = c + '\n\nCapítulo ' + capN + ': "' + capTitle + '"'
    + (sector ? ' | Sector: ' + sector : '')
    + (pais ? ' | País: ' + pais : '') + '\n\n'
    + _dynPedagogyInline(ped);

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

  throw new Error('dynScormV2RoomPrompt: plantilla desconocida "' + templateId + '"');
}

// ── dynExamUnitPrompt — equivalente puro de pGIFT({t:'u',mi,m:{caps}}, c) (07-examenes.js:186) ──
// Legacy pGIFT('u') SIEMPRE pide 25 preguntas (15/5/5) sin importar cuántos
// capítulos tenga el módulo — hoy eso "funciona" porque todo módulo legacy
// tiene exactamente 3 capítulos. Dynamic permite módulos con cualquier
// cantidad de capítulos (Manifest), así que el reparto se deriva de la
// cantidad real de capítulos en vez de asumir 3:
//   total        = round(chapterCount * 25/3)   → 3 caps ⇒ 25 (igual a legacy)
//   multichoice  = round(total * 0.6)            → 3 caps ⇒ 15
//   truefalse    = round(total * 0.2)            → 3 caps ⇒ 5
//   match        = total - multichoice - truefalse (resto, nunca negativo)  → 3 caps ⇒ 5
// Para chapterCount===3 el texto generado es byte-idéntico al legacy
// (verificado en el harness). chapterTitles = blueprint.moduleChapters[].title
// del módulo (item.m.caps.join(' | ') legacy).
function dynExamQuestionSplit(chapterCount) {
  var cc = Math.max(1, chapterCount || 0);
  var total = Math.round(cc * 25 / 3);
  var multichoice = Math.round(total * 0.6);
  var truefalse = Math.round(total * 0.2);
  var match = Math.max(0, total - multichoice - truefalse);
  return { total: multichoice + truefalse + match, multichoice: multichoice, truefalse: truefalse, match: match };
}

function dynExamUnitPrompt(courseContext, outline, module, moduleNumber, chapterTitles, ped) {
  var c = dynCtx(courseContext, outline);
  var nombre = (courseContext && courseContext.nombre) || '';
  var sector = (courseContext && courseContext.sector) || '';
  var pais = (courseContext && courseContext.pais) || '';
  var titles = chapterTitles || [];
  var split = dynExamQuestionSplit(titles.length);
  var syntax = dynGiftSyntaxRef(courseContext);

  var qTypes = '- ' + split.multichoice + ' selección múltiple (distractores plausibles, opciones misma longitud)\n- ' + split.truefalse + ' Verdadero/Falso (mezcla TRUE y FALSE, no más de 3 iguales)\n- ' + split.match + ' emparejamiento (4 pares cada uno, términos específicos de ' + sector + ')\n';
  return c + '\n\nExamen UNIDAD ' + moduleNumber + ' del curso "' + nombre + '" (' + sector + ', ' + pais + ').\nCapítulos cubiertos: ' + titles.join(' | ') + '\n\n' + split.total + ' PREGUNTAS distribuidas así:\n' + qTypes
    + '\n$CATEGORY: ' + nombre + ' - Unidad ' + moduleNumber + '\n'
    + 'IDs: U' + moduleNumber + '-01 a U' + moduleNumber + '-' + split.total + '\n'
    + 'Cada pregunta específica para el sector ' + sector + ' en ' + pais + ' — NUNCA genérica.\n'
    + _dynPedagogyLine(ped)
    + syntax;
}

// EV5 (auditoría P3): el examen se escribía solo con los TÍTULOS de los capítulos y preguntaba
// por temas que el curso nunca enseñó. Bloque con lo que cada capítulo enseñó de verdad (resumen,
// conceptos y términos del context_summary del content + objetivo del Blueprint). Vacío si no hay
// resúmenes (v1): el prompt queda idéntico.
function dynExamContentBlock(chapters) {
  var all = (chapters || []).filter(Boolean);
  var withContent = all.filter(function (c) { return c.summary || (c.concepts && c.concepts.length) || (c.keyTerms && c.keyTerms.length); });
  if (!withContent.length) return '';
  // Todos los capítulos (aunque alguno no tenga resumen: va con título y objetivo) para no
  // sesgar el examen hacia los resumidos ni dejar temas sin preguntas.
  var list = all;
  function clip(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') : s; }
  var lines = list.map(function (c) {
    var out = '- Capítulo ' + c.number + ': ' + clip(c.title, 120);
    if (c.objective) out += '\n  Objetivo: ' + clip(c.objective, 300);
    if (c.summary) out += '\n  Qué enseñó: ' + clip(c.summary, 700);
    if (c.concepts && c.concepts.length) out += '\n  Conceptos: ' + c.concepts.slice(0, 12).map(function (x) { return clip(x, 80); }).join('; ');
    if (c.keyTerms && c.keyTerms.length) out += '\n  Términos: ' + c.keyTerms.slice(0, 15).map(function (x) { return clip(x, 60); }).join('; ');
    return out;
  });
  return '\n\nCONTENIDO QUE ENSEÑÓ EL CURSO (fuente principal de las preguntas):\n' + lines.join('\n')
    + '\n\nREGLAS DE COBERTURA: cada capítulo listado recibe preguntas. No preguntes por productos, cifras, normas, entidades o casos que el curso no enseñó; '
    + 'si necesitas un dato concreto, usa uno de los que aparecen arriba. Prioriza preguntas de aplicación (una situación del sector en la que el estudiante decide) sobre definiciones.\n';
}

// EV5 (auditoría P4): corrección dirigida de preguntas donde la correcta es la opción más larga.
function dynGiftBalancePrompt(courseContext, giftBlocks) {
  var sector = (courseContext && courseContext.sector) || '';
  return 'Estas preguntas GIFT de selección múltiple (' + sector + ') tienen un defecto: la respuesta correcta (=) es claramente la opción más larga, '
    + 'y un estudiante la adivina sin saber.\n\n' + giftBlocks + '\n\n'
    + 'Reescríbelas manteniendo el MISMO ::ID::, el mismo enunciado y el mismo significado de la respuesta correcta. '
    + 'Iguala las longitudes: acorta la correcta y/o completa los distractores para que las 4 opciones midan lo mismo (±5 caracteres); la correcta NO puede ser la más larga. '
    + 'Distractores plausibles del mismo dominio, nunca absurdos. Devuelve SOLO esas preguntas en GIFT puro, sin comentarios.';
}

// giftSyntaxRef (07-examenes.js) lee el sector del curso desde el estado global — versión pura equivalente.
function dynGiftSyntaxRef(courseContext) {
  var sector = (courseContext && courseContext.sector) || '';
  return '\n\nFORMATO GIFT — SINTAXIS OBLIGATORIA POR TIPO:\n\n'
    + '// Selección múltiple (1 correcta):\n'
    + '::ID-01:: Pregunta completa sobre ' + sector + '? {\n'
    + '  =Respuesta correcta\n'
    + '  ~Distractor plausible 1\n'
    + '  ~Distractor plausible 2\n'
    + '  ~Distractor plausible 3\n'
    + '}\n\n'
    + '// Verdadero/Falso:\n'
    + '::ID-02:: Afirmación sobre ' + sector + ' que es verdadera. {TRUE}\n'
    + '::ID-03:: Afirmación incorrecta sobre el proceso. {FALSE}\n\n'
    + '// Emparejamiento (matching):\n'
    + '::ID-04:: Relaciona términos de ' + sector + '. {\n'
    + '  =Término A -> Definición de A\n'
    + '  =Término B -> Definición de B\n'
    + '  =Término C -> Definición de C\n'
    + '  =Término D -> Definición de D\n'
    + '}\n\n'
    + 'COHERENCIA CON EL CURSO (obligatorio): la opción correcta, los pares de emparejamiento y las afirmaciones VERDADERAS deben coincidir con lo que enseña el curso. '
    + 'Nunca premies un neuromito (p. ej., «estilos de aprendizaje» visual/auditivo/kinestésico) ni una práctica que el curso desaconseja (como bajar la exigencia según el perfil del estudiante): esos errores solo pueden aparecer como distractores. '
    + 'No atribuyas intención, voluntad ni deseos a la IA en una respuesta correcta o afirmación VERDADERA. En emparejamiento, cada término tiene una sola definición posible (nunca pares intercambiables).\n\n'
    + 'REGLAS ABSOLUTAS DEL FORMATO:\n'
    + '- Cada pregunta DEBE tener ::ID-NN:: único\n'
    + '- Selección múltiple: EXACTAMENTE 1 "=" y 3 "~"\n'
    + '- Matching: mínimo 4 pares "=término -> definición"\n'
    + '- PROHIBIDO generar preguntas de completar/rellenar espacio ({=respuesta}) ni numéricas ({#valor:tolerancia}) — Moodle las califica por coincidencia exacta de texto y generan falsos negativos. SOLO usa selección múltiple, verdadero/falso y emparejamiento.\n'
    + '- LONGITUD IGUALADA en selección múltiple (regla dura, no aproximada): mide en caracteres la respuesta correcta y los 3 distractores. La diferencia entre la opción MÁS LARGA y la MÁS CORTA —incluida la correcta— NO debe superar 15 caracteres. La correcta JAMÁS puede ser la opción más larga; si necesita más detalle, alarga los distractores para igualar. Un estudiante no debe poder adivinar la respuesta solo por ser la más larga.\n'
    + '- PROHIBIDO: texto explicativo entre preguntas\n'
    + '- PROHIBIDO: ```gift ``` bloques de código\n'
    + '- SOLO GIFT puro, sin comentarios entre preguntas\n';
}

// ════════════════════════════════════════════════════════════════════════
// rulesVersion 2 (R2 — 5B.2.B + Fase 6). Prompts NUEVOS, puros, solo para
// items de Manifests v2. Los builders de arriba (v1/legacy) quedan
// byte-idénticos: el prompt de `content` v2 es el prompt v1 EXACTO +
// un bloque de contexto agregado al final (dynContentV2Prompt).
// ════════════════════════════════════════════════════════════════════════

// Title Normalization: el título es breve; el alcance (descripción) viaja como contexto, solo si existe.
function _dynScopeSuffix(x) {
  var d = x && typeof x.description === 'string' ? x.description.replace(/\s+/g, ' ').trim() : '';
  return d ? ' (alcance: ' + d + ')' : '';
}

// Línea compacta de un outline con UUIDs, para que el modelo devuelva las
// claves exactas del Manifest (identidad por UUID, nunca por número).
function _dynOutlineWithIds(outline) {
  var s = '';
  (outline || []).forEach(function (mo) {
    s += '\n- Módulo ' + mo.moduleNumber + ' [id: ' + mo.id + ']: ' + mo.title + _dynScopeSuffix(mo);
    (mo.chapters || []).forEach(function (c) {
      s += '\n    - Capítulo ' + c.chapterNumber + ' [id: ' + c.id + ']: ' + c.title + _dynScopeSuffix(c)
        // Motor de carga horaria: el capítulo de práctica se marca (sin práctica, el outline de siempre).
        + (c.kind === 'practice' ? ' (CAPÍTULO DE PRÁCTICA: integra y practica lo del módulo; no enseña conceptos nuevos)' : '');
    });
  });
  return s;
}

function _dynOutlineHasPractice(outline) {
  return (outline || []).some(function (mo) { return (mo.chapters || []).some(function (c) { return c.kind === 'practice'; }); });
}

// ── course_plan: plan de conceptos del curso (JSON estricto) ──
function dynCoursePlanSys() {
  return 'Eres diseñador instruccional experto de CampusCloud. Planificas la progresión de conceptos de un curso virtual completo ANTES de que se escriba cada capítulo, para que los capítulos no se repitan, no se adelanten y construyan unos sobre otros. Respondes SOLO con JSON válido, sin markdown, sin texto adicional.';
}

function dynCoursePlanPrompt(courseContext, outline, ped) {
  var c = dynCtx(courseContext, outline);
  var L = (typeof DYN_PLAN_LIMITS !== 'undefined') ? DYN_PLAN_LIMITS : { summaryMax: 400, listMax: 12, itemMax: 120 };
  return c + '\n\nPLAN DE CONCEPTOS DEL CURSO.\nEstructura con identificadores (usa EXACTAMENTE estos ids como claves):' + _dynOutlineWithIds(outline)
    + (ped || '')
    + '\n\nResponde SOLO con este JSON (sin markdown, sin texto extra):\n'
    + '{\n'
    + '  "modules": { "<id del módulo>": { "summary": "qué logra el estudiante en este módulo (1-2 oraciones)" } },\n'
    + '  "chapters": { "<id del capítulo>": {\n'
    + '      "summary": "qué cubre el capítulo y cómo avanza sobre los anteriores (2-3 oraciones)",\n'
    + '      "concepts_introduced": ["concepto nuevo que este capítulo enseña por primera vez"],\n'
    + '      "concepts_assumed": ["concepto que el capítulo da por sabido (de capítulos anteriores o del nivel del curso)"],\n'
    + '      "key_terms": ["término clave del capítulo"]\n'
    + '  } }\n'
    + '}\n\n'
    + 'REGLAS CRÍTICAS:\n'
    + '- Incluye TODOS los módulos y TODOS los capítulos de la estructura, con su id exacto como clave; no agregues ids que no estén en la lista\n'
    + '- summary: máximo ' + L.summaryMax + ' caracteres\n'
    + '- concepts_introduced y key_terms: entre 1 y ' + L.listMax + ' elementos; concepts_assumed: entre 0 y ' + L.listMax + '; cada elemento máximo ' + L.itemMax + ' caracteres, texto plano\n'
    + '- Un concepto se introduce UNA sola vez en todo el curso: si un capítulo posterior lo usa, va en su concepts_assumed, nunca de nuevo en concepts_introduced\n'
    + '- Respeta el orden del curso: un capítulo solo puede asumir conceptos introducidos en capítulos ANTERIORES (de cualquier módulo) o propios del nivel del curso\n'
    + (_dynOutlineHasPractice(outline) ? '- CAPÍTULO DE PRÁCTICA: concepts_introduced es [] (no enseña nada nuevo); concepts_assumed = los conceptos del módulo que practica; summary = qué practica y cómo integra el módulo\n' : '')
    + '- Conceptos específicos del sector y del país del curso, nunca genéricos\n'
    + '- SOLO el JSON, nada más; cierra todos los objetos y arrays';
}

// Reintento dirigido: mismo prompt + la lista exacta de errores del
// validador (dynValidateCoursePlan, 46). Nunca pide "lo que falte": pide el
// plan COMPLETO de nuevo (nunca se fusiona un plan parcial).
function dynCoursePlanRetryPrompt(basePrompt, errors) {
  var list = (errors || []).slice(0, 25).map(function (e) { return '- ' + e; }).join('\n');
  return basePrompt + '\n\nTU RESPUESTA ANTERIOR FUE RECHAZADA por estos errores de validación:\n' + list
    + '\nVuelve a generar el JSON COMPLETO corrigiendo TODOS los errores: todos los ids de la estructura presentes, ninguno extra, arrays de strings, límites de tamaño respetados. SOLO el JSON.';
}

// ── Bloque compacto de contexto para el content v2 ──
// Derivado SOLO del Context Package (46). Tamaño acotado sin importar el
// largo del curso (accumulated_concepts ya viene capado).
function dynContextBlock(pkg) {
  var p = pkg || {};
  var ch = p.chapter || {};
  var mo = p.module || {};
  function list(a) { return (a && a.length) ? a.join('; ') : '(ninguno)'; }
  var s = '\n\n── CONTEXTO DEL CURSO (plan congelado, v' + p.contextPackageVersion + ') ──';
  s += '\nMódulo actual: ' + (mo.title || '') + (mo.objective ? ' — objetivo: ' + mo.objective : '');
  s += '\nPropósito del módulo: ' + (mo.summary || '');
  s += '\nEste capítulo: ' + (ch.title || '') + (ch.objective ? ' — objetivo: ' + ch.objective : '');
  s += '\nConceptos que ESTE capítulo introduce: ' + list(ch.concepts_introduced);
  s += '\nConceptos que este capítulo puede dar por sabidos: ' + list(ch.concepts_assumed);
  s += '\nTérminos clave: ' + list(ch.key_terms);
  s += '\nCapítulo anterior (resumen planeado): ' + (p.previous_chapter_summary || '(este es el primer capítulo del curso)');
  s += '\nConceptos YA introducidos en capítulos anteriores (NO los vuelvas a explicar desde cero; puedes referenciarlos brevemente): ' + list(p.accumulated_concepts);
  s += '\nSiguiente capítulo: ' + (p.next_chapter ? (p.next_chapter.title + (p.next_chapter.objective ? ' — ' + p.next_chapter.objective : '')) : '(este es el último capítulo del curso)');
  s += '\nNO adelantes el contenido del siguiente capítulo: como mucho, una frase de cierre que lo anticipe.';
  return s;
}

function dynContextSummaryInstruction() {
  return '\n\nCIERRE OBLIGATORIO (excepción a la regla de no usar bloques de código): después de terminar el capítulo, agrega AL FINAL, como lo último de tu respuesta, exactamente un bloque con este formato:\n'
    + '```json context_summary\n'
    + '{"summary":"resumen real de lo que cubriste (máx 800 caracteres)","concepts_introduced":["concepto que realmente introdujiste"],"key_terms":["término clave realmente usado"]}\n'
    + '```\n'
    + 'concepts_introduced: 1 a 12 elementos; key_terms: 1 a 15 elementos; texto plano. Nada después del bloque.';
}

// Prompt de content v2 = prompt v1 EXACTO (dynLibroChapterPrompt) + contexto + sidecar.
// Fase 2 (motor pedagógico): `ped` = bloque del diseño del capítulo (dynPedagogyBlock), antes del cierre
// obligatorio del sidecar (que sigue siendo lo último). Sin `ped`, byte a byte el de siempre.
function dynContentV2Prompt(v1Prompt, pkg, ped) {
  return v1Prompt + dynContextBlock(pkg) + (ped || '') + dynContextSummaryInstruction();
}

// Reintento dirigido SOLO del sidecar (no regenera el capítulo): se le da el
// capítulo ya escrito y se le pide únicamente el bloque context_summary.
function dynContextSummaryRetryPrompt(chapterTitle, markdown) {
  return 'Este es el capítulo "' + (chapterTitle || '') + '" ya escrito de un curso virtual:\n\n<<<CAPITULO\n' + String(markdown || '') + '\nCAPITULO>>>\n\n'
    + 'Devuelve SOLO el bloque de resumen del capítulo, basado en lo que el texto REALMENTE cubre, con este formato exacto y nada más:\n'
    + '```json context_summary\n'
    + '{"summary":"resumen real (máx 800 caracteres)","concepts_introduced":["concepto introducido"],"key_terms":["término clave"]}\n'
    + '```\n'
    + 'concepts_introduced: 1 a 12 elementos; key_terms: 1 a 15 elementos; texto plano.';
}

// ── course_intro / module_intro (markdown) ──
function dynIntroSys(courseContext) {
  var tono = (courseContext && courseContext.tono) || '';
  return 'Eres diseñador instruccional experto de CampusCloud. Escribes textos de presentación para cursos virtuales. REGLAS: (1) Específico del sector y país del curso, nunca genérico. (2) PROHIBIDO: "en el mundo actual", "es fundamental entender", "cabe destacar", "en la era digital", "hoy en día". (3) Tono: ' + tono + '. (4) Tutear al estudiante. (5) Solo Markdown limpio sin explicaciones adicionales, sin bloques de código. (6) BIBLIOGRAFÍA: cita solo obras reales y verificables (autor, título, año, editorial u organismo). NUNCA inventes URLs, enlaces, DOIs ni ISBN: no incluyas ningún enlace ni DOI. Si no estás seguro de que una obra existe, no la incluyas.';
}

function _dynPlanModuleLines(outline, plan) {
  var s = '';
  (outline || []).forEach(function (mo) {
    var pm = plan && plan.modules && plan.modules[mo.id];
    s += '\n- Módulo ' + mo.moduleNumber + ': ' + mo.title + (pm && pm.summary ? ' — ' + pm.summary : '');
  });
  return s;
}

function dynCourseIntroPrompt(courseContext, outline, plan) {
  var c = dynCtx(courseContext, outline);
  var nombre = (courseContext && courseContext.nombre) || '';
  return c + '\n\nGenera la INTRODUCCIÓN GENERAL del curso "' + nombre + '".\nRecorrido planeado del curso:' + _dynPlanModuleLines(outline, plan)
    + '\n\nIncluye, en este orden y con estos títulos de sección (##):\n'
    + '## Introducción — 150-250 palabras: por qué este curso importa para el sector y el país, qué va a lograr el estudiante\n'
    + '## Metodología — cómo se estudia el curso (libro guía, actividades prácticas, juegos interactivos, evaluaciones por módulo), 100-150 palabras\n'
    + '## Competencias — 4 a 6 competencias concretas y observables que desarrolla el curso, en viñetas\n'
    + '## Bibliografía sugerida — 5 a 8 referencias reales (autor, título, año, editorial u organismo), en viñetas\n\n'
    + 'REGLA DE BIBLIOGRAFÍA: solo obras reales y verificables. NO inventes URLs, enlaces, DOIs ni ISBN (no incluyas ninguno). Si no estás seguro de que una obra existe, no la incluyas.\n'
    + 'Empieza directamente con ## Introducción. Sin portada ni tabla de contenido.';
}

function dynModuleIntroPrompt(courseContext, outline, module, moduleNumber, plan) {
  var c = dynCtx(courseContext, outline);
  var mod = module || {};
  var pm = plan && plan.modules && plan.modules[mod.id];
  var chapters = [];
  (outline || []).forEach(function (mo) {
    if (mo.id === mod.id) chapters = mo.chapters || [];
  });
  var chLines = chapters.map(function (ch) {
    var pc = plan && plan.chapters && plan.chapters[ch.id];
    return '\n- Capítulo ' + ch.chapterNumber + ': ' + ch.title + (pc && pc.summary ? ' — ' + pc.summary : '');
  }).join('');
  return c + '\n\nGenera la PRESENTACIÓN del Módulo ' + moduleNumber + ': "' + (mod.title || '') + '".'
    + (mod.objective ? '\nObjetivo del módulo: ' + mod.objective : '')
    + (pm && pm.summary ? '\nPropósito planeado: ' + pm.summary : '')
    + '\nCapítulos del módulo:' + chLines
    + '\n\nIncluye, en este orden y con estos títulos de sección (##):\n'
    + '## Presentación del módulo — 120-200 palabras: qué aprende el estudiante y por qué importa en el sector y el país\n'
    + '## Qué vas a lograr — 3 a 5 logros concretos en viñetas\n'
    + '## Recorrido — una línea por capítulo explicando cómo se conectan\n'
    + '## Bibliografía sugerida — 2 a 4 referencias reales (autor, título, año, editorial u organismo), en viñetas\n\n'
    + 'REGLA DE BIBLIOGRAFÍA: solo obras reales y verificables. NO inventes URLs, enlaces, DOIs ni ISBN (no incluyas ninguno). Si no estás seguro de que una obra existe, no la incluyas.\n'
    + 'Empieza directamente con ## Presentación del módulo. Sin portada.';
}

// Reintento dirigido de una intro a la que le falta una sección obligatoria.
function dynIntroRetryPrompt(basePrompt, missingSections) {
  return basePrompt + '\n\nTU RESPUESTA ANTERIOR NO INCLUYÓ estas secciones obligatorias: ' + (missingSections || []).join(', ')
    + '. Vuelve a generar el texto COMPLETO incluyéndolas todas con su título ## exacto.';
}

function dynContextSummaryRetrySys() {
  return 'Eres diseñador instruccional experto de CampusCloud. Resumes con precisión lo que un capítulo ya escrito realmente cubre. Respondes SOLO con el bloque solicitado, sin texto adicional.';
}

// ── course_plan por partes (M7, fix wave review-rv2) ──
// Para outlines grandes el plan se pide por partes (un módulo, o un tramo de
// ≤20 capítulos de un módulo): el modelo ve la estructura COMPLETA del curso
// (dynCtx, sin ids) pero solo recibe con [id: …] las claves de ESTA parte, y
// los conceptos ya introducidos en partes anteriores para no reintroducirlos.
// El ejecutor valida cada parte, las fusiona en UN plan y lo valida entero.
function dynCoursePlanChunkPrompt(courseContext, outline, subOutline, partIndex, partCount, priorConcepts, ped) {
  var c = dynCtx(courseContext, outline);
  var L = (typeof DYN_PLAN_LIMITS !== 'undefined') ? DYN_PLAN_LIMITS : { summaryMax: 400, listMax: 12, itemMax: 120 };
  var prior = (priorConcepts || []).length
    ? '\n\nConceptos YA introducidos en partes anteriores del curso (NO los vuelvas a poner en concepts_introduced; si un capítulo de esta parte los usa, van en su concepts_assumed): ' + priorConcepts.join('; ')
    : '';
  return c + '\n\nPLAN DE CONCEPTOS DEL CURSO — PARTE ' + partIndex + ' de ' + partCount + '.\n'
    + 'El curso es largo y el plan se arma por partes, en orden. Genera el plan SOLO de esta parte (usa EXACTAMENTE estos ids como claves):' + _dynOutlineWithIds(subOutline)
    + prior
    + (ped || '')
    + '\n\nResponde SOLO con este JSON (sin markdown, sin texto extra):\n'
    + '{\n'
    + '  "modules": { "<id del módulo>": { "summary": "qué logra el estudiante en este módulo (1-2 oraciones)" } },\n'
    + '  "chapters": { "<id del capítulo>": {\n'
    + '      "summary": "qué cubre el capítulo y cómo avanza sobre los anteriores (2-3 oraciones)",\n'
    + '      "concepts_introduced": ["concepto nuevo que este capítulo enseña por primera vez"],\n'
    + '      "concepts_assumed": ["concepto que el capítulo da por sabido (de capítulos anteriores o del nivel del curso)"],\n'
    + '      "key_terms": ["término clave del capítulo"]\n'
    + '  } }\n'
    + '}\n\n'
    + 'REGLAS CRÍTICAS:\n'
    + '- Incluye el módulo y TODOS los capítulos de ESTA PARTE, con su id exacto como clave; no agregues ids que no estén en la lista de esta parte\n'
    + '- summary: máximo ' + L.summaryMax + ' caracteres\n'
    + '- concepts_introduced y key_terms: entre 1 y ' + L.listMax + ' elementos; concepts_assumed: entre 0 y ' + L.listMax + '; cada elemento máximo ' + L.itemMax + ' caracteres, texto plano\n'
    + '- Un concepto se introduce UNA sola vez en todo el curso: si ya fue introducido (en esta parte o en una anterior), va en concepts_assumed, nunca de nuevo en concepts_introduced\n'
    + '- Respeta el orden del curso: un capítulo solo puede asumir conceptos introducidos en capítulos ANTERIORES o propios del nivel del curso\n'
    + '- Conceptos específicos del sector y del país del curso, nunca genéricos\n'
    + '- SOLO el JSON, nada más; cierra todos los objetos y arrays';
}

// ════════════════════════════════════════════════════════════════════════
// rulesVersion 3 (V2.1 — R11b). Prompts NUEVOS, puros, solo para items de
// Manifests v3: experience, course_intro/module_intro (JSON), video_interactions,
// activity (h5p) y final_exam. Los builders v1/v2 de arriba quedan
// byte-idénticos. Reglas (audit §F.2 / §O.1):
//   - Ningún prompt recibe flags de video/actividad/examen/Gamma/audio: el
//     contenido es independiente de los recursos (el ON/OFF no cambia huellas).
//   - El LLM NUNCA menciona recursos ni escribe cantidades de estructura ni
//     navegación: las transiciones las escribe Cursia (plantillas
//     determinísticas). Los lints RESOURCE_MENTION / QUANTITY_CLAIM (R2) lo
//     verifican del lado del cliente (45) y del servidor (R11a, autoritativo).
// ════════════════════════════════════════════════════════════════════════

// Espejo del schema de Visual Components vcSchemaVersion 1 (R2,
// src/modules/visual-components/schema.ts, VC_COMPONENT_SPECS). Data, no
// lógica: el catálogo del prompt y el validador del cliente (45) se generan
// de acá. Si R2 cambia un límite, se cambia en ambos lados (el backend manda).
var DYN_VC_SCHEMA_VERSION = 1;
var DYN_VC_COMPONENT_SPECS = (function () {
  function T(max, optional) { return { kind: 'text', max: max, optional: !!optional }; }
  var TITLE = T(120, true);
  // P3 (espejo de EDU en schema.ts): «¿Por qué importa?» / «¿Cómo lo aplicas?», opcionales en el schema.
  var WHY = T(160, true);
  var APPLY = T(200, true);
  function E(spec) { var o = { why: WHY, apply: APPLY }; Object.keys(spec).forEach(function (k) { o[k] = spec[k]; }); return o; }
  return {
    hero: { eyebrow: T(60, true), title: T(120), lead: T(400) },
    learning_objectives: { title: TITLE, items: { kind: 'textList', min: 2, max: 6, itemMax: 200 } },
    concept_cards: E({ title: TITLE, cards: { kind: 'objList', min: 2, max: 6, fields: { term: T(80), definition: T(400) } } }),
    reveal_cards: { title: TITLE, cards: { kind: 'objList', min: 2, max: 6, fields: { front: T(200), back: T(500) } } },
    accordion: E({ title: TITLE, items: { kind: 'objList', min: 2, max: 8, fields: { heading: T(120), body: T(900) } } }),
    tabs: E({ title: TITLE, tabs: { kind: 'objList', min: 2, max: 5, fields: { label: T(40), body: T(900) } } }),
    timeline: E({ title: TITLE, events: { kind: 'objList', min: 3, max: 8, fields: { marker: T(40), heading: T(120), body: T(400) } } }),
    process_steps: E({ title: TITLE, steps: { kind: 'objList', min: 3, max: 8, fields: { heading: T(120), body: T(400) } } }),
    comparison: E({
      title: TITLE,
      columns: { kind: 'textList', min: 2, max: 4, itemMax: 60 },
      rows: { kind: 'objList', min: 2, max: 8, fields: { label: T(80), cells: { kind: 'textList', min: 2, max: 4, itemMax: 240 } } }
    }),
    myth_reality: E({ title: TITLE, pairs: { kind: 'objList', min: 1, max: 5, fields: { myth: T(240), reality: T(500) } } }),
    case_scenario: E({ title: T(120), narrative: T(1200), questions: { kind: 'textList', min: 1, max: 4, itemMax: 240 } }),
    checklist: E({ title: TITLE, items: { kind: 'textList', min: 3, max: 10, itemMax: 200 } }),
    reflection: { prompt: T(400), hint: T(400, true) },
    callout: { variant: { kind: 'enum', values: ['tip', 'warning', 'info', 'example'] }, title: T(80, true), body: T(600), apply: APPLY },
    summary_visual: { central: T(120), points: { kind: 'textList', min: 3, max: 5, itemMax: 200 } },
    self_check: { title: TITLE, items: { kind: 'objList', min: 2, max: 4, fields: { q: T(300), a: T(600) } } },
    // Edu Phase A (espejo de R2 schema.ts): ejemplo resuelto y diagrama educativo.
    worked_example: E({
      title: T(120), situation: T(500),
      data: { kind: 'textList', min: 2, max: 6, itemMax: 160 },
      steps: { kind: 'objList', min: 3, max: 6, fields: { action: T(120), detail: T(400) } },
      result: T(400), takeaway: T(300, true)
    }),
    diagram: E({
      kind: { kind: 'enum', values: ['cycle', 'flow', 'hierarchy', 'matrix', 'decision'] },
      title: T(120), caption: T(300, true),
      nodes: { kind: 'objList', min: 2, max: 8, fields: { label: T(48), detail: T(160, true) } },
      x_axis: T(48, true), y_axis: T(48, true)
    })
  };
})();
// Nodos por forma de diagrama (espejo de VC_DIAGRAM_NODES) y tipos con datos ilustrativos.
var DYN_VC_DIAGRAM_NODES = { cycle: [3, 6], flow: [3, 6], hierarchy: [3, 6], matrix: [4, 4] };
// EV6 (espejo de VC_DECISION_LIMITS / VC_DECISION_DIAGRAM_SPEC, schema.ts): árbol de decisión (kind "decision").
// El árbol es recursivo: lo valida 45 (dynValidateVcComponent), no el spec genérico.
var DYN_VC_DECISION_LIMITS = { questionMax: 90, actionMax: 90, labelMax: 24, maxDepth: 3, maxQuestions: 4 };
var DYN_VC_DECISION_DIAGRAM_SPEC = {
  kind: { kind: 'enum', values: ['decision'] },
  title: { kind: 'text', max: 120, optional: true },
  caption: { kind: 'text', max: 300, optional: true },
  why: { kind: 'text', max: 160, optional: true },
  apply: { kind: 'text', max: 200, optional: true }
};
// P3 (espejo de VC_EDU_WHY_TYPES / VC_EDU_APPLY_TYPES / VC_EDU_FIELDS_MIN): bloques que admiten why/apply
// y mínimo exigido desde v21-exp-6.
var DYN_VC_EDU_WHY_TYPES = ['concept_cards', 'accordion', 'tabs', 'timeline', 'process_steps', 'comparison', 'myth_reality', 'case_scenario', 'checklist', 'worked_example', 'diagram'];
var DYN_VC_EDU_APPLY_TYPES = DYN_VC_EDU_WHY_TYPES.concat(['callout']);
var DYN_VC_EDU_FIELDS_MIN = 2;
var DYN_VC_ILLUSTRATIVE_TYPES = ['worked_example'];
var DYN_VC_MOVEMENT_IDS = ['opening', 'deepening', 'synthesis', 'closing', 'video_primer', 'self_check'];
var DYN_VC_MOVEMENT_LIMITS = { opening: [1, 3], deepening: [1, 5], synthesis: [1, 2], closing: [1, 2], video_primer: [1, 2], self_check: [1, 1] };
// Edu EV2 (espejo de VC_PEDAGOGY, pedagogy.ts): estructura educativa mínima de un capítulo NUEVO.
var DYN_VC_PEDAGOGY = {
  visualIntro: ['hero'],
  keyConcepts: ['concept_cards'],
  example: ['worked_example', 'case_scenario'],
  visual: ['diagram', 'comparison', 'process_steps', 'timeline'],
  denseMax: 600
};
var DYN_VC_MIN_DISTINCT_TYPES = 2;
var DYN_VC_MAX_SAME_TYPE = 2;
var DYN_VC_BRIDGE_MAX = 300;

// Uso pedagógico de cada componente (audit §G.2) — solo para el catálogo del prompt.
var DYN_VC_COMPONENT_USES = {
  hero: 'apertura del capítulo: título + gancho',
  learning_objectives: 'objetivos del capítulo',
  concept_cards: 'conceptos clave (término + definición)',
  reveal_cards: 'pregunta o término al frente, explicación o ejemplo al reverso',
  accordion: 'profundización por partes',
  tabs: 'comparar enfoques o perspectivas',
  timeline: 'historia o secuencia temporal',
  process_steps: 'procedimiento paso a paso',
  comparison: 'tabla A vs B: columns = SOLO los sujetos comparados (2 a 4); cada fila = {label: el criterio, cells: una celda por sujeto}. El nombre del criterio va en label, NUNCA como columna',
  myth_reality: 'desmontar errores frecuentes',
  case_scenario: 'caso aplicado: narrative + questions (1 a 4 preguntas guía, OBLIGATORIO; nunca dentro de narrative)',
  checklist: 'lista de verificación práctica',
  reflection: 'pregunta abierta con pista opcional',
  callout: 'consejo, alerta, dato o ejemplo (variant: tip|warning|info|example)',
  summary_visual: 'síntesis: concepto central + ideas clave',
  self_check: 'repaso no calificado: pregunta + respuesta (SOLO en el movimiento self_check)',
  worked_example: 'EJEMPLO RESUELTO: un caso COMPLETO del sector con datos concretos (hipotéticos) → resolución paso a paso → resultado. No expliques "cómo se hace": muestra un caso resuelto de principio a fin. Va en deepening (o closing). situation = contexto concreto e HIPOTÉTICO del caso (nunca lo rotules "caso real"); data = los datos del caso ("Costo por unidad: $12.000"); steps = cada paso con su cálculo o decisión; result = el resultado concreto; takeaway = el error típico a evitar. Aquí SÍ se permiten cifras y porcentajes ilustrativos (datos del caso, no estadísticas: nunca "el N % de los trabajadores/estudiantes…" como dato del mundo, ni instituciones o estudios con nombre); verifica que cada cálculo sea correcto. Si un dato necesita las palabras actividades, videos, preguntas o módulos junto a un número, reformúlalo (p. ej. "tareas")',
  diagram: 'DIAGRAMA educativo (Cursia lo dibuja; va en deepening, nunca en video_primer): kind = "cycle" (etapas que se repiten, 3–6 nodos en orden) | "flow" (proceso con pasos en orden, 3–6) | "hierarchy" (nodes[0] = concepto raíz; los demás, 2 a 5, son sus tipos o partes) | "matrix" (EXACTAMENTE 4 nodos en orden [arriba-izquierda, arriba-derecha, abajo-izquierda, abajo-derecha] + x_axis e y_axis, que crecen hacia la derecha y hacia arriba) | "decision" (árbol de decisión, ver ÁRBOL DE DECISIÓN abajo: lleva "tree" en lugar de nodes). label ≤ 48 caracteres; x_axis/y_axis SOLO en matrix'
};

// Términos que el LLM nunca debe escribir en textos de experiencia/intros
// (espejo de RESOURCE_WORDS de R2, en palabras legibles para el prompt).
// Fix round 1 (review G5 I1 / ledger R-004): se prohíben REFERENCIAS a piezas
// del curso, no el vocabulario del dominio (mismo criterio que el lint por
// frases RESOURCE_MENTION de R2 y su espejo en 45).
var DYN_V3_BANNED_RESOURCE_REFERENCES = ['el video', 'los videos', 'la actividad interactiva / de práctica / calificada', 'la siguiente actividad', 'el examen', 'la evaluación del módulo / final', 'la presentación (del capítulo)', 'las diapositivas', 'el quiz', 'SCORM', 'H5P', 'un juego interactivo / de práctica', 'el siguiente recurso'];
var DYN_V3_ALLOWED_DOMAIN_EXAMPLES = ['juego de roles', 'evaluación de riesgos', 'presentación de resultados', 'actividad económica', 'examen médico'];

// T1 (r57): el prompt nombra los bloques por su id técnico y rotula el capítulo como «texto fuente»; el modelo a veces
// copiaba ese vocabulario en la prosa («la situación ilustrativa del worked_example»). Espejo de la reparación
// determinística y del check INTERNAL_VOCABULARY del backend (visual-components/internal-vocabulary.ts).
function _dynInternalVocabularyBan() {
  return '- NUNCA escribas en el texto los nombres técnicos de los bloques, movimientos o campos de este JSON (p.ej. worked_example, case_scenario, concept_cards, process_steps, summary_visual, self_check, deepening, bridge_to_next) ni «texto fuente», «[S1]» o delimitadores como «<<<CAPITULO»: para el lector son «el ejemplo resuelto», «el caso», «los conceptos clave», «el procedimiento», «la síntesis» o «el Libro Guía».';
}

// T1 (r57): un curso real repetía las mismas aperturas y cierres en casi todos los capítulos («Ya sabes… Ahora
// viene…» 9/15, «Piensa en…» 11/15). Regla de estilo (no un validador): el backend mide la repetición entre capítulos
// (lintFormulaicOpenings) y la deja como aviso de calidad del paquete.
function _dynFormulaVarietyRule() {
  return '- ESTILO: cada capítulo abre y cierra con una entrada PROPIA de su tema; nada de fórmulas repetidas entre capítulos: no abras el hero con «Ya sabes… / Hasta aquí… → Ahora viene…», no empieces la reflexión con «Piensa en…», no arranques why/apply siempre con la misma muletilla («Porque…», «Úsalo cuando…»): escribe directamente la razón o la acción concreta.\n';
}

// Reglas duras comunes a experience / course_intro / module_intro.
function _dynV3StrictBans() {
  return '\n\nPROHIBICIONES ABSOLUTAS (un validador automático rechaza la respuesta si las incumples):\n'
    + '- NUNCA menciones los recursos, materiales o piezas del curso (lo que el estudiante verá, jugará, rendirá o descargará): nada de referencias como ' + DYN_V3_BANNED_RESOURCE_REFERENCES.map(function (w) { return '"' + w + '"'; }).join(', ') + '. Cursia agrega esas referencias por su cuenta. '
    + 'El vocabulario propio del tema SÍ está permitido (p.ej. ' + DYN_V3_ALLOWED_DOMAIN_EXAMPLES.map(function (w) { return '"' + w + '"'; }).join(', ') + '); habla de CONCEPTOS del tema.\n'
    + '- NUNCA escribas cantidades de la estructura del curso: nada de números junto a módulos, capítulos, videos, actividades, preguntas, intentos, minutos, horas o páginas, ni porcentajes ("30%"), ni "capítulo 3" / "módulo 2". Para referirte a otra parte del curso, usa su TÍTULO, nunca su número. ÚNICA excepción: dentro de un "worked_example" los datos del caso pueden llevar cifras, porcentajes, horas o minutos ilustrativos (nunca módulos, capítulos, videos, actividades, preguntas ni intentos).\n'
    + '- NUNCA escribas navegación ni instrucciones de interfaz ("haz clic", "a continuación verás", "en la siguiente sección", "continúa con…"): las transiciones las pone Cursia.\n'
    + _dynInternalVocabularyBan() + '\n'
    + '- Solo texto plano: sin HTML, sin Markdown (salvo **énfasis** puntual, siempre cerrado), sin URLs.';
}

// Fix round 1 (review G5 C1): reglas extra de los textos de intro que el shell
// muestra (todo salvo la bibliografía). Espejo de dynLintShellProse (45) /
// lintShellProse (R11a).
function _dynV3ShellSlotBans() {
  // #542 (M1) fix round 3: espejo del servidor (lintShellProse, V542): solo se prohíben las cifras que CUENTAN
  // la estructura o la duración del curso; las normas y los números del contenido van con cifras.
  return '\n- En TODOS los campos de texto salvo "bibliography": NINGUNA cifra que cuente la estructura o la duración del curso ("4 capítulos", "12 lecciones", "6 semanas"), ni números escritos en palabras junto a unidades de tiempo o de estructura ("tres módulos", "cuatro semanas", "una docena de ejercicios"): las cantidades del curso las pone Cursia desde datos reales.\n'
    + '- NUNCA prometas certificados, certificación ni diplomas, PDF ni "narración profesional", y no escribas las palabras "horas", "minutos" ni "semanas".'
    + '\n- Las normas y los números del contenido van con cifras: «Ley 1480 de 2011», «ISO 9001», «15 días hábiles». NUNCA escribas números en palabras («mil cuatrocientos ochenta», «dos mil once»): eso es solo para el audio.';
}

// Reglas livianas para prompts cuyo texto no pasa por el lint de recursos
// (video_interactions, activity h5p, final_exam): igual se pide no nombrar
// otras piezas del curso ni cantidades de estructura.
function _dynV3LightBans() {
  return '\n\nREGLAS DE COHERENCIA:\n'
    + '- No menciones otras piezas del curso (video, presentación, diapositivas, juego, actividad, examen, quiz) ni instrucciones de navegación: pregunta sobre CONCEPTOS del tema.\n'
    + '- No escribas cantidades de la estructura del curso (números de módulos, capítulos, videos, actividades, preguntas, intentos, minutos u horas, ni "capítulo 3").\n'
    + '- Solo texto plano: sin HTML, sin entidades HTML (&amp; etc.), sin Markdown, sin URLs.\n'
    + '- ' + DYN_TRUTH_RULES + '\n'
    + '- Español latinoamericano con tuteo (tú); nunca voseo.';
}

// Contexto del curso para prompts v3: dynCtx SIN la línea "Estructura: N
// módulos · M capítulos" ni números de módulo/capítulo (el LLM tendería a
// copiarlos: QUANTITY_CLAIM). El recorrido va por títulos, en orden.
function _dynCtxV3(courseContext, outline) {
  var s = dynCtx(courseContext, null);
  if (outline && outline.length) {
    s += '\nRecorrido del curso (en orden, por títulos):';
    outline.forEach(function (mo) {
      s += '\n- ' + mo.title + ': ' + (mo.chapters || []).map(function (c) { return c.title; }).join(' → ');
    });
  }
  return s;
}

function _dynVcFieldLine(name, spec) {
  var opt = spec.optional ? ' (opcional)' : '';
  if (spec.kind === 'text') return name + ': texto ≤ ' + spec.max + ' caracteres' + opt;
  if (spec.kind === 'enum') return name + ': uno de ' + spec.values.join('|') + opt;
  if (spec.kind === 'textList') return name + ': lista de ' + spec.min + '–' + spec.max + ' textos (≤ ' + spec.itemMax + ' c/u)' + opt;
  var inner = Object.keys(spec.fields).map(function (k) { return _dynVcFieldLine(k, spec.fields[k]); }).join('; ');
  return name + ': lista de ' + spec.min + '–' + spec.max + ' objetos {' + inner + '}' + opt;
}

// Catálogo de componentes con sus campos y límites (generado desde el espejo del schema).
function dynVcCatalogText(opts) {
  var edu = !opts || opts.eduFields !== false;
  return Object.keys(DYN_VC_COMPONENT_SPECS).map(function (type) {
    var spec = DYN_VC_COMPONENT_SPECS[type];
    // P3 (fix I3): sin soporte del backend (v21-exp-5), el catálogo no ofrece why/apply.
    if (!edu && (spec.why || spec.apply)) { spec = Object.assign({}, spec); delete spec.why; delete spec.apply; }
    // P3 (fix I2): el catálogo muestra los límites del PROMPT (más estrictos que los del schema).
    if (edu && (spec.why || spec.apply)) { spec = Object.assign({}, spec); if (spec.why) spec.why = Object.assign({}, spec.why, { max: DYN_VC_EDU_PROMPT_MAX.why }); if (spec.apply) spec.apply = Object.assign({}, spec.apply, { max: DYN_VC_EDU_PROMPT_MAX.apply }); }
    // Edu EV2: el catálogo muestra el máximo EDUCATIVO de los bloques de explicación (el schema admite
    // 900, pero la estructura educativa pide ≤ 600: una sola cifra, sin contradicción en el prompt).
    if ((type === 'accordion' || type === 'tabs') && typeof DYN_VC_PEDAGOGY !== 'undefined') {
      spec = JSON.parse(JSON.stringify(spec));
      var lk = type === 'accordion' ? 'items' : 'tabs';
      spec[lk].fields.body.max = Math.min(spec[lk].fields.body.max, DYN_VC_PEDAGOGY.denseMax);
    }
    var fields = Object.keys(spec).map(function (k) { return _dynVcFieldLine(k, spec[k]); }).join('; ');
    // Fix round 1 (M3): los campos de arriba son los de las formas con nodos; el árbol de decisión tiene los suyos.
    if (type === 'diagram') fields += '. EXCEPCIÓN kind "decision": campos kind, title (opcional), caption (opcional) y tree (obligatorio); SIN nodes, x_axis ni y_axis (forma en ÁRBOL DE DECISIÓN)';
    return '- "' + type + '" — ' + DYN_VC_COMPONENT_USES[type] + '. Campos: ' + fields;
  }).join('\n');
}

function dynExperienceSys(courseContext) {
  var tono = (courseContext && courseContext.tono) || '';
  return 'Eres diseñador instruccional experto de CampusCloud. Conviertes un capítulo ya escrito en una EXPERIENCIA de aprendizaje estructurada en componentes visuales. Respondes SOLO con JSON válido (sin markdown, sin texto extra). Todo texto es plano, específico del sector y país del curso, en español, tuteando al estudiante. Tono: ' + tono + '.';
}

// EV6 — árbol de decisión y prohibición de diagramas dibujados con texto (espejo de los lints
// DIAGRAM_BRANCHING_IN_SEQUENCE / TEXT_SIMULATED_DIAGRAM de 45 y de pedagogy.ts).
function dynDecisionDiagramText() {
  var L = DYN_VC_DECISION_LIMITS;
  return '\n\nÁRBOL DE DECISIÓN ({"type": "diagram", "kind": "decision"}): úsalo cuando el contenido tiene CONDICIONES que cambian lo que se hace ("si pasa X, haz Y; si no, haz Z"): protocolos, triage, diagnóstico de fallas, criterios para escalar o derivar. Forma EXACTA:\n'
    + '{"type": "diagram", "kind": "decision", "title": "…", "tree": {"question": "¿…?", "yes": {"action": "…"}, "no": {"tree": {"question": "¿…?", "yes": {"action": "…"}, "no": {"action": "…"}}}}}\n'
    + '- Cada nodo es {"question", "yes", "no"}; "question" ≤ ' + L.questionMax + ' caracteres y termina en "?".\n'
    + '- Cada rama ("yes"/"no") lleva EXACTAMENTE uno de: "action" (acción final, ≤ ' + L.actionMax + ' caracteres) o "tree" (otra pregunta). "label" es opcional (≤ ' + L.labelMax + ' caracteres; por defecto Cursia muestra «Sí» / «No»).\n'
    + '- Como máximo ' + L.maxDepth + ' preguntas encadenadas en un camino y ' + L.maxQuestions + ' preguntas en total. SIN "nodes", "x_axis" ni "y_axis".\n'
    + '- Una decisión NUNCA va como "flow", "cycle", "process_steps" o "timeline" con pasos tipo «Sí → …», «No: …», «Si no…» o «En caso contrario…»: eso enseña como secuencia algo que se ramifica.\n'
    + '\nDIAGRAMAS REALES, NUNCA DIBUJADOS CON TEXTO: no escribas cadenas de flechas en ningún texto («Paso 1 → Paso 2 → Paso 3», «A -> B -> C»). Una secuencia va en "process_steps" (o un "diagram" kind "flow"); una decisión, en un "diagram" kind "decision". Una sola flecha suelta está permitida.';
}

// P3 — «¿Por qué importa?» / «¿Cómo lo aplicas?» (campos why / apply; el backend los exige desde v21-exp-6).
// P3 (fix I2): límites del PROMPT, más estrictos que los del schema (160/200): margen para que un campo
// opcional nunca llegue al límite; uno inválido igual se quita sin reintento (45, EDU_FIELD_DROPPED).
var DYN_VC_EDU_PROMPT_MAX = { why: 120, apply: 150 };
function dynEduFieldsText() {
  return '\n\nPOR QUÉ IMPORTA Y CÓMO LO APLICAS (obligatorio en ' + DYN_VC_EDU_FIELDS_MIN + ' a 6 bloques de contenido; un validador lo verifica): en los bloques que más lo necesiten agrega '
    + '"why" (≤ ' + DYN_VC_EDU_PROMPT_MAX.why + ' caracteres: UNA frase corta sobre la consecuencia concreta para el estudiante en su trabajo, no una definición) y '
    + '"apply" (≤ ' + DYN_VC_EDU_PROMPT_MAX.apply + ' caracteres: UNA acción concreta y observable que puede hacer en su contexto, empezando por un verbo). '
    + 'En why/apply: NINGÚN número (ni minutos, horas, días, porcentajes ni cantidades), y NUNCA las palabras video, actividad, evaluación, examen, presentación, módulo ni capítulo. '
    + 'Admiten why/apply: ' + DYN_VC_EDU_WHY_TYPES.join(', ') + ' (callout solo admite "apply"). '
    + 'Al menos ' + DYN_VC_EDU_FIELDS_MIN + ' bloques con "why" y al menos ' + DYN_VC_EDU_FIELDS_MIN + ' con "apply"; nunca en hero, learning_objectives, summary_visual, self_check, reflection ni reveal_cards. '
    + 'Sin estadísticas inventadas ni cifras del curso, sin repetir el título del bloque, sin mencionar recursos del curso.';
}

// ── experience:<ch> → vcSchemaVersion 1 (R2) ──
// contentMd = artifact dynamic_content_md del capítulo; contextPackage =
// dynamic_context_package_json (46) o null. chapter = blueprint.chapter.
// Motor de carga horaria: un CAPÍTULO DE PRÁCTICA no enseña teoría nueva; integra y practica lo que enseñan
// los capítulos de contenido de su módulo (su texto llega como fuente, posiblemente recortado).
var DYN_PRACTICE_PAGE_WORDS = 900;
function dynPracticeExperienceBlock() {
  return '\n\n── CAPÍTULO DE PRÁCTICA ──\nEste capítulo NO enseña teoría nueva: integra y practica lo que enseñan los capítulos de contenido del módulo (el texto de arriba; puede venir recortado). '
    + 'Escribe una PÁGINA DE PRÁCTICA GUIADA breve (unas ' + DYN_PRACTICE_PAGE_WORDS + ' palabras en total, sumando todos los componentes): '
    + 'opening = hero que plantea el desafío práctico + objetivos de PRÁCTICA (qué va a poder hacer); '
    + 'deepening = concept_cards SOLO como repaso breve de lo indispensable, un case_scenario o worked_example INTEGRADOR (una situación completa que combine lo del módulo) y un process_steps con el procedimiento para resolverlo; '
    + 'synthesis = criterios para saber si lo hizo bien; closing = una aplicación en su contexto; self_check = preguntas de repaso de todo el módulo. '
    + 'Usa SOLO lo que está en el texto de los capítulos; no agregues conceptos nuevos ni menciones capítulos por número.';
}
function dynPracticeActivityBlock() {
  return '── CAPÍTULO DE PRÁCTICA ──\nEsta actividad INTEGRA lo de todos los capítulos de contenido del módulo (el texto de arriba): cada pregunta o decisión combina al menos dos ideas del módulo en una situación completa del sector. No agregues conceptos que no estén en el texto.\n\n';
}

function dynExperiencePrompt(courseContext, outline, chapter, contentMd, contextPackage, opts) {
  var eduFields = !!(opts && opts.eduFields);
  var ch = chapter || {};
  var chapterId = ch.id || '';
  var limits = DYN_VC_MOVEMENT_IDS.map(function (m) {
    return m + ': ' + DYN_VC_MOVEMENT_LIMITS[m][0] + '–' + DYN_VC_MOVEMENT_LIMITS[m][1] + ' componentes';
  }).join('; ');
  return _dynCtxV3(courseContext, outline)
    + (contextPackage ? dynContextBlock(contextPackage) : '')
    + '\n\nCAPÍTULO: "' + (ch.title || '') + '"'
    + (opts && opts.practice
      ? '\nTexto de los capítulos de contenido del módulo (fuente ÚNICA de los conceptos; no inventes datos que no estén acá, salvo los datos HIPOTÉTICOS de un worked_example):\n<<<CAPITULO\n' + String(contentMd || '') + '\nCAPITULO>>>' + dynPracticeExperienceBlock()
      : '\nTexto completo del capítulo (fuente ÚNICA de los conceptos; no inventes datos que no estén acá, salvo los datos HIPOTÉTICOS de un worked_example):\n<<<CAPITULO\n' + String(contentMd || '') + '\nCAPITULO>>>')
    + ((opts && opts.pedagogy) || '')
    + '\n\nGenera la EXPERIENCIA del capítulo como JSON con vcSchemaVersion 1, EXACTAMENTE con esta forma:\n'
    + '{\n'
    + '  "vcSchemaVersion": 1,\n'
    + '  "chapterId": "' + chapterId + '",\n'
    + '  "movements": {\n'
    + '    "opening":      [ 1) INTRODUCCIÓN VISUAL: empieza SIEMPRE con un "hero" (gancho), luego objetivos ],\n'
    + '    "deepening":    [ EN ESTE ORDEN: 2) CONCEPTOS CLAVE ("concept_cards") → 3) EXPLICACIÓN breve ("accordion", "tabs" o "reveal_cards") → 4) EJEMPLO PRÁCTICO ("worked_example"; o "case_scenario") → 5) RECURSO VISUAL ("diagram", "comparison", "process_steps" o "timeline") ],\n'
    + '    "synthesis":    [ componentes de síntesis: ideas clave ],\n'
    + '    "closing":      [ componentes de cierre: reflexión o aplicación ],\n'
    + '    "video_primer": [ "qué observar": los conceptos a los que el estudiante debe prestar atención, escrito SOLO sobre conceptos ],\n'
    + '    "self_check":   [ exactamente 1 componente "self_check" con preguntas de repaso y su respuesta ]\n'
    + '  },\n'
    + '  "bridge_to_next": "una frase conceptual (≤ ' + DYN_VC_BRIDGE_MAX + ' caracteres) que conecta con lo que sigue, sin mencionar recursos ni números"\n'
    + '}\n'
    + '\nCada componente es un objeto {"type": "<tipo>", ...campos}. CATÁLOGO (únicos tipos y campos permitidos; ningún campo extra):\n'
    + dynVcCatalogText({ eduFields: eduFields })
    + '\n\nESTRUCTURA EDUCATIVA (obligatoria; un validador la verifica): el capítulo NO puede ser "título + párrafos". Debe tener introducción visual (hero al inicio de opening), conceptos clave (concept_cards), un ejemplo práctico (worked_example o case_scenario) y al menos un recurso visual en deepening (diagram, comparison, process_steps o timeline). Escribe breve: cada bloque de explicación (accordion/tabs) tiene como máximo ' + DYN_VC_PEDAGOGY.denseMax + ' caracteres (2–3 frases); si una idea no cabe, pásala a un recurso visual.'
    + dynDecisionDiagramText()
    + (eduFields ? dynEduFieldsText() : '')
    + '\n\nREGLAS DEL SCHEMA:\n'
    + '- Los SEIS movimientos son obligatorios, siempre (Cursia decide cuáles mostrar). Límites: ' + limits + '.\n'
    + '- "self_check" solo existe dentro del movimiento self_check; el movimiento self_check solo admite un componente "self_check".\n'
    + '- Al menos ' + DYN_VC_MIN_DISTINCT_TYPES + ' tipos distintos en todo el documento, y ningún tipo más de ' + DYN_VC_MAX_SAME_TYPE + ' veces.\n'
    + '- comparison: "columns" lista SOLO los sujetos comparados (sin una columna tipo "Aspecto"/"Característica"/"Criterio": el criterio va en "label"); cada fila tiene exactamente tantas celdas como columnas.\n'
    + '- Antes de responder, cuenta los componentes de cada movimiento: nunca más que el máximo indicado.\n'
    + '- hero.eyebrow (opcional): 1 a 3 palabras del TEMA (p. ej. "Evaluación auténtica"); nunca "Capítulo N" ni "Módulo N": Cursia ya muestra la ubicación.\n'
    + '- Respeta TODOS los límites de caracteres; ningún texto vacío; los campos de texto no llevan HTML.\n'
    + _dynFormulaVarietyRule()
    + '- "chapterId" es exactamente "' + chapterId + '".'
    + _dynV3StrictBans()
    + '\n\nSOLO el JSON, nada más; cierra todos los objetos y arrays.';
}

// ── course_intro v3 (JSON, schema R11a) ──
var DYN_COURSE_INTRO_V3_LIMITS = { welcomeMinWords: 80, welcomeMaxWords: 220, competenciesMin: 4, competenciesMax: 6, methodologyMaxWords: 80, bibliographyMin: 5, bibliographyMax: 8 };
var DYN_MODULE_INTRO_V3_LIMITS = { outcomesMin: 3, outcomesMax: 5, bibliographyMin: 2, bibliographyMax: 4 };

function dynIntroV3Sys(courseContext) {
  var tono = (courseContext && courseContext.tono) || '';
  return 'Eres diseñador instruccional experto de CampusCloud. Escribes textos de presentación para cursos virtuales y respondes SOLO con JSON válido (sin markdown, sin texto extra). REGLAS: (1) Específico del sector y país del curso, nunca genérico. (2) PROHIBIDO: "en el mundo actual", "es fundamental entender", "cabe destacar", "en la era digital", "hoy en día". (3) Tono: ' + tono + '. (4) Tutear al estudiante. (5) BIBLIOGRAFÍA: solo obras reales y verificables; NUNCA inventes URLs, enlaces, DOIs ni ISBN.';
}

function _dynBibliographyRule(min, max) {
  return '- bibliography: ' + min + ' a ' + max + ' obras REALES y verificables, cada una {"author","title","year","publisher"}; year es un número entero de 4 dígitos; SIN URLs, enlaces, DOIs ni ISBN en ningún campo. Si no estás seguro de que una obra existe, no la incluyas.\n';
}

function dynCourseIntroV3Prompt(courseContext, outline, plan, ped) {
  var L = DYN_COURSE_INTRO_V3_LIMITS;
  var nombre = (courseContext && courseContext.nombre) || '';
  var lines = '';
  (outline || []).forEach(function (mo) {
    var pm = plan && plan.modules && plan.modules[mo.id];
    lines += '\n- ' + mo.title + (pm && pm.summary ? ' — ' + pm.summary : '');
  });
  return _dynCtxV3(courseContext, outline)
    + '\n\nGenera la INTRODUCCIÓN GENERAL del curso "' + nombre + '".\nPropósito planeado de cada parte del curso:' + lines
    + (ped || '')
    + '\n\nResponde SOLO con este JSON (sin markdown, sin texto extra):\n'
    + '{\n'
    + '  "schemaVersion": 1,\n'
    + '  "welcome": "bienvenida en texto plano: por qué este curso importa para el sector y el país y qué va a lograr el estudiante",\n'
    + '  "competencies": ["competencia concreta y observable"],\n'
    + '  "methodology_note": "cómo conviene estudiar este tema (hábitos, enfoque), sin nombrar recursos del curso",\n'
    + '  "closing": "cierre motivador en texto plano",\n'
    + '  "bibliography": [{"author": "…", "title": "…", "year": 2019, "publisher": "…"}]\n'
    + '}\n\n'
    + 'REGLAS DEL SCHEMA:\n'
    + '- welcome: entre ' + L.welcomeMinWords + ' y ' + L.welcomeMaxWords + ' palabras.\n'
    + '- competencies: entre ' + L.competenciesMin + ' y ' + L.competenciesMax + ' elementos, una oración cada uno que empieza con un verbo en infinitivo (Aplicar, Identificar, Resolver…): se muestran después de «Al terminar podrás:» (nunca «Aplicas…» ni «El estudiante…»).\n'
    + '- methodology_note: máximo ' + L.methodologyMaxWords + ' palabras, independiente de los recursos (Cursia describe los recursos por su cuenta).\n'
    + '- closing: 1 a 3 oraciones.\n'
    + _dynBibliographyRule(L.bibliographyMin, L.bibliographyMax)
    + '- Ningún campo extra.'
    + _dynV3StrictBans()
    + _dynV3ShellSlotBans()
    + '\n\nSOLO el JSON, nada más.';
}

function dynModuleIntroV3Prompt(courseContext, outline, module, plan, ped) {
  var L = DYN_MODULE_INTRO_V3_LIMITS;
  var mod = module || {};
  var pm = plan && plan.modules && plan.modules[mod.id];
  var chapters = [];
  (outline || []).forEach(function (mo) { if (mo.id === mod.id) chapters = mo.chapters || []; });
  var chLines = chapters.map(function (ch) {
    var pc = plan && plan.chapters && plan.chapters[ch.id];
    return '\n- [chapterId: ' + ch.id + '] ' + ch.title + (pc && pc.summary ? ' — ' + pc.summary : '');
  }).join('');
  var journeyShape = chapters.map(function (ch) { return '{"chapterId": "' + ch.id + '", "line": "…"}'; }).join(', ');
  return _dynCtxV3(courseContext, outline)
    + '\n\nGenera la PRESENTACIÓN del módulo "' + (mod.title || '') + '".'
    + (mod.objective ? '\nObjetivo del módulo: ' + mod.objective : '')
    + (pm && pm.summary ? '\nPropósito planeado: ' + pm.summary : '')
    + '\nPartes del módulo (en orden):' + chLines
    + (ped || '')
    + '\n\nResponde SOLO con este JSON (sin markdown, sin texto extra):\n'
    + '{\n'
    + '  "schemaVersion": 1,\n'
    + '  "presentation": "qué aprende el estudiante en este módulo y por qué importa en el sector y el país (uno o dos párrafos breves, máximo 2000 caracteres)",\n'
    + '  "outcomes": ["logro concreto"],\n'
    + '  "journey": [' + journeyShape + '],\n'
    + '  "bibliography": [{"author": "…", "title": "…", "year": 2019, "publisher": "…"}]\n'
    + '}\n\n'
    + 'REGLAS DEL SCHEMA:\n'
    + '- outcomes: entre ' + L.outcomesMin + ' y ' + L.outcomesMax + ' elementos; cada uno empieza con un verbo en infinitivo (Seleccionar, Aplicar…): se muestran después de «Al terminar este módulo podrás:» (nunca «Seleccionas…» ni «Aplicas…»).\n'
    + '- journey: EXACTAMENTE un elemento por parte del módulo, con esos chapterId, en ese mismo orden; "line" es una oración que explica cómo esa parte se conecta con las demás (sin números).\n'
    + _dynBibliographyRule(L.bibliographyMin, L.bibliographyMax)
    + '- Ningún campo extra.'
    + _dynV3StrictBans()
    + _dynV3ShellSlotBans()
    + '\n\nSOLO el JSON, nada más.';
}

// #542 (I1): reglas anti-patrón de respuesta (mismos umbrales que el banco de exámenes). `tfFirst` es el
// valor sembrado por el ejecutor para la PRIMERA afirmación V/F (mitad de los sets empieza con verdadera).
function _dynAnswerBalanceRules(tfFirst) {
  return '- multichoice: respuestas de extensión parecida; la correcta NO es la más larga: en la mayoría de las preguntas al menos un distractor es igual o más largo y detallado que la correcta.\n'
    + '- truefalse: si hay varias, mezcla verdaderas y falsas (entre 40 y 60 % verdaderas)'
    + (typeof tfFirst === 'boolean' ? '; la PRIMERA afirmación truefalse es ' + (tfFirst ? 'VERDADERA (correct: true)' : 'FALSA (correct: false)') : '') + '.\n';
}

// ── video_interactions:<ch> (schema R8, schemaVersion 1) ──
// checkpoints: [{index, atSec, segmentStart, segmentEnd}] (plan determinístico
// del backend, R8 planInteractionCheckpoints; el LLM NO decide cuántas ni cuándo).
// El LLM devuelve SOLO {"checkpoints":[…]}; el ejecutor agrega schemaVersion,
// videoItemKey y durationSec (datos de Cursia, no del LLM).
var DYN_VIDEO_INTERACTIONS_LIMITS = { questionMax: 250, answerMax: 120, feedbackMax: 250, minAnswers: 3, maxAnswers: 4 };

function dynVideoInteractionsSys() {
  return 'Eres diseñador instruccional experto de CampusCloud. Escribes preguntas breves que aparecen en pausas de un recurso audiovisual sobre un capítulo de un curso virtual. Respondes SOLO con JSON válido, sin markdown ni texto extra.';
}

// EV6 IV avanzado (schemaVersion 2): `reflections` = pausas del plan del servidor
// (claim video.reflectionPlan.reflections: [{index, atSec, afterCheckpoint}]). Con
// `reflections` (aunque sea []), el prompt pide además "reflections" SOLO para esos
// index (prompt + hint opcional; nunca segundos). Sin `reflections` (undefined/null)
// el prompt es byte a byte el de schemaVersion 1.
var DYN_VIDEO_REFLECTION_LIMITS = { promptMax: 200, hintMax: 200 };

// opts (#542 I1, opcional): { tfFirst } → reglas anti-patrón de respuesta (sin opts: prompt de siempre).
// r61 Q-04: opts.videoScenes (claim video.videoScenes, escenas reales de Videogen [{order, startSec, endSec,
// narration}]; los checkpoints ya vienen anclados al final de una escena) → el prompt muestra el guion del
// video por tramos y cada pregunta evalúa lo que la NARRACIÓN ya dijo en su tramo. Sin escenas: el prompt
// de siempre, byte a byte.
function _dynVideoSec(x) { return Math.round(x); }
// Review M-4: la narración de Videogen no puede cerrar ni abrir los bloques del prompt (<<<X / X>>>).
function _dynNeutralizePromptFence(t) { return String(t || '').replace(/<{3,}/g, '«').replace(/>{3,}/g, '»'); }
function _dynVideoScenesHead(contentMd, cps, scenes) {
  var script = scenes.map(function (s) {
    return 'Escena ' + s.order + ' [' + _dynVideoSec(s.startSec) + '–' + _dynVideoSec(s.endSec) + ' s]: ' + _dynNeutralizePromptFence(s.narration);
  }).join('\n');
  var cpLines = cps.map(function (c) {
    // Misma partición que dynScenesForCheckpoint (escenas que TERMINAN en el tramo).
    var cov = scenes.filter(function (s) { var e = Math.ceil(s.endSec - 1e-6); return e > c.segmentStart && e <= c.atSec; });
    var lastSc = cov.length ? cov[cov.length - 1] : null;
    var orders = cov.map(function (s) { return s.order; });
    var range = orders.length > 1 ? 'escenas ' + orders[0] + ' a ' + orders[orders.length - 1] : 'escena ' + (orders[0] !== undefined ? orders[0] : '?');
    return '- index ' + c.index + ' (segundo ' + c.atSec + (lastSc ? ', justo al terminar la escena ' + lastSc.order : '') + '): lo narrado entre el segundo ' + c.segmentStart + ' y el ' + c.atSec + ' (' + range + ')' + (lastSc && orders.length > 1 ? '; de preferencia la escena ' + lastSc.order : '');
  }).join('\n');
  return 'El video tiene su PROPIO guion, narrado por escenas (no recorre el capítulo de forma pareja). Guion real del video (escena, tramo en segundos, narración):\n<<<GUION\n' + script + '\nGUION>>>'
    + '\n\nTexto del capítulo (solo como referencia de términos, datos y contexto):\n<<<CAPITULO\n' + String(contentMd || '') + '\nCAPITULO>>>'
    + '\n\nPuntos de pausa (fijos, cada uno al final de una escena; genera EXACTAMENTE una pregunta por cada uno, en este orden y con este index):\n' + cpLines
    + '\n\nCada pregunta evalúa SOLO algo que la narración del video ya dijo en ESE tramo (las escenas indicadas): nunca algo de escenas posteriores ni algo que el video no narra, aunque esté en el capítulo.';
}

function dynVideoInteractionsPrompt(contentMd, checkpoints, reflections, opts) {
  if (Array.isArray(reflections)) return dynVideoInteractionsPromptV2(contentMd, checkpoints, reflections, opts);
  var L = DYN_VIDEO_INTERACTIONS_LIMITS;
  var cps = checkpoints || [];
  var scenes = opts && Array.isArray(opts.videoScenes) && opts.videoScenes.length ? opts.videoScenes : null;
  var head;
  if (scenes) {
    head = _dynVideoScenesHead(contentMd, cps, scenes);
  } else {
    var first = cps.length ? cps[0].segmentStart : 0;
    var last = cps.length ? cps[cps.length - 1].segmentEnd : 0;
    var span = Math.max(1, last - first);
    var cpLines = cps.map(function (c) {
      var from = Math.round(((c.segmentStart - first) / span) * 100);
      var to = Math.round(((c.segmentEnd - first) / span) * 100);
      return '- index ' + c.index + ' (segundo ' + c.atSec + '): conceptos del tramo que va aproximadamente del ' + from + '% al ' + to + '% del recorrido del capítulo';
    }).join('\n');
    head = 'El recorrido audiovisual sigue el capítulo en orden, de principio a fin. Texto completo del capítulo:\n<<<CAPITULO\n' + String(contentMd || '') + '\nCAPITULO>>>'
      + '\n\nPuntos de pausa (fijos; genera EXACTAMENTE una pregunta por cada uno, en este orden y con este index):\n' + cpLines
      + '\n\nCada pregunta evalúa un concepto que el estudiante acaba de ver en ESE tramo del capítulo (no de tramos posteriores).';
  }
  return head
    + ((opts && opts.pedagogy) || '')
    + '\n\nResponde SOLO con este JSON:\n'
    + '{"checkpoints": [\n'
    + '  {"index": 1, "kind": "multichoice", "question": "…", "answers": [{"text": "…", "correct": true}, {"text": "…", "correct": false}, {"text": "…", "correct": false}], "feedbackCorrect": "…", "feedbackIncorrect": "…"},\n'
    + '  {"index": 2, "kind": "truefalse", "question": "afirmación…", "correct": false, "feedbackCorrect": "…", "feedbackIncorrect": "…"}\n'
    + ']}\n\n'
    + 'REGLAS:\n'
    + '- Exactamente ' + cps.length + ' elementos, con index ' + cps.map(function (c) { return c.index; }).join(', ') + ' en ese orden.\n'
    + '- kind "multichoice": ' + L.minAnswers + ' a ' + L.maxAnswers + ' respuestas, EXACTAMENTE 1 con correct:true, sin respuestas repetidas; sin campo "correct" suelto.\n'
    + '- kind "truefalse": "correct" booleano y sin "answers". Mezcla multichoice y truefalse (mayoría multichoice).\n'
    + '- question ≤ ' + L.questionMax + ' caracteres; cada respuesta ≤ ' + L.answerMax + ' (apunta a ~' + Math.round(L.answerMax * 0.66) + ': una respuesta es una frase corta, no una explicación; el porqué va en el feedback); feedbackCorrect y feedbackIncorrect ≤ ' + L.feedbackMax + ' (explican el porqué). Todo en UNA sola línea.\n'
    + '- Distractores plausibles del mismo dominio; nada de "todas las anteriores".\n'
    + (opts ? _dynAnswerBalanceRules(opts.tfFirst) : '')
    + '- feedbackCorrect es lo que ve el estudiante que ACERTÓ y feedbackIncorrect lo que ve el que FALLÓ (no dicen si la afirmación es verdadera o falsa): feedbackCorrect nunca empieza con «Incorrecto» ni «Falso».\n'
    + '- Ningún campo extra.'
    + _dynV3LightBans()
    + '\n\nSOLO el JSON, nada más.';
}

// schemaVersion 2: mismo prompt de v1 (sin cambiar una coma de sus reglas) + el bloque de pausas para pensar.
function dynVideoInteractionsPromptV2(contentMd, checkpoints, reflections, opts) {
  var R = DYN_VIDEO_REFLECTION_LIMITS;
  var v1 = dynVideoInteractionsPrompt(contentMd, checkpoints, undefined, opts);
  var refl = reflections || [];
  if (!refl.length) {
    return v1.replace('\n\nSOLO el JSON, nada más.', '\n- Este recorrido no lleva pausas para pensar: no agregues "reflections".\n\nSOLO el JSON, nada más.');
  }
  var lines = refl.map(function (r) {
    return '- reflexión index ' + r.index + ': va justo después de la pregunta index ' + r.afterCheckpoint + ' (sobre lo visto hasta ese punto del capítulo)';
  }).join('\n');
  var shape = refl.map(function (r) { return '{"index": ' + r.index + ', "prompt": "…", "hint": "…"}'; }).join(', ');
  return v1.replace('\n\nSOLO el JSON, nada más.', '')
    + '\n\nPAUSAS PARA PENSAR (fijas; Cursia decide cuántas y dónde van, sin puntaje):\n' + lines
    + '\n\nAgrega al MISMO JSON, junto a "checkpoints", la lista "reflections": [' + shape + ']\n'
    + 'REGLAS DE LAS PAUSAS:\n'
    + '- Exactamente ' + refl.length + ' elementos en "reflections", con index ' + refl.map(function (r) { return r.index; }).join(', ') + ' en ese orden; solo los campos index, prompt y hint.\n'
    + '- prompt (≤ ' + R.promptMax + ' caracteres): una pregunta abierta que invita a conectar lo visto con el trabajo del estudiante («¿Qué harías en tu turno si…?»); no tiene respuesta correcta ni se califica.\n'
    + '- hint (opcional, ≤ ' + R.hintMax + ' caracteres): una pista breve para pensar, no la respuesta.\n'
    + '- Nunca escribas segundos, tiempos ni números de pausa: Cursia los pone.\n'
    + '\nSOLO el JSON, nada más.';
}

// ── activity:<ch> variante h5p (schemas de entrada R7) ──
// El LLM devuelve solo el contenido; el ejecutor agrega itemKey y
// passPercentage (datos de Cursia) y arma el payload {type, data}.
//
// R-011 (evidencia técnica de un player Moodle 4.5 real): Moodle core NO
// califica H5P.SingleChoiceSet 1.11 (el intento queda guardado sin disparar
// completion/grade) — por eso 'singlechoiceset' se excluyó de la rotación de
// actividades calificadas. El generador de prompt para ese tipo se conserva
// más abajo (dynH5pActivityPrompt) por si se reutiliza para una actividad NO
// calificada, pero ya no es alcanzable desde esta rotación.
var DYN_H5P_ACTIVITY_TYPES = ['questionset', 'dragtext', 'blanks'];

function dynH5pActivitySys() {
  return 'Eres diseñador instruccional experto de CampusCloud. Diseñas ejercicios de práctica calificables sobre un capítulo de un curso virtual. Respondes SOLO con JSON válido, sin markdown ni texto extra. Todo texto es plano, específico del sector y país del curso.';
}

// EV5-C: `focus` = { objective, title } del capítulo (claim.blueprint.chapter). La actividad practica
// el objetivo: el cuestionario es de situaciones (aplicar/decidir), no de definiciones.
// focus.tfFirst (#542 I1, opcional): valor de la primera afirmación V/F del cuestionario; focus.chapterCase
// (opcional): el caso ya resuelto en el capítulo, que el caso ramificado NO debe repetir.
function dynH5pActivityPrompt(type, contentMd, contextPackage, focus) {
  var objective = focus && typeof focus.objective === 'string' ? focus.objective.replace(/\s+/g, ' ').trim() : '';
  var head = (contextPackage ? dynContextBlock(contextPackage) + '\n\n' : '')
    + (objective ? 'Objetivo del capítulo (la actividad lo practica): ' + objective + '\n\n' : '')
    + (focus && focus.practice
      ? 'Texto de los capítulos de contenido del módulo (fuente ÚNICA de los conceptos):\n<<<CAPITULO\n' + String(contentMd || '') + '\nCAPITULO>>>\n\n' + dynPracticeActivityBlock()
      : 'Texto completo del capítulo (fuente ÚNICA de los conceptos):\n<<<CAPITULO\n' + String(contentMd || '') + '\nCAPITULO>>>\n\n')
    + _dynPedagogyInline(focus && focus.pedagogy);
  var common = '- title: título corto y descriptivo del ejercicio (≤ 120 caracteres).\n'
    + '- Preguntas sobre los conceptos centrales del capítulo, aplicadas al sector y país; distractores plausibles del mismo dominio.\n';
  var body;
  if (type === 'questionset') {
    body = 'Genera un CUESTIONARIO de comprensión. Responde SOLO con este JSON:\n'
      + '{"title": "…", "questions": [\n'
      + '  {"kind": "multichoice", "question": "…", "answers": [{"text": "…", "correct": true, "feedback": "por qué"}, {"text": "…", "correct": false, "feedback": "por qué no"}, {"text": "…", "correct": false}, {"text": "…", "correct": false}]},\n'
      + '  {"kind": "truefalse", "question": "afirmación…", "correct": true, "feedbackCorrect": "…", "feedbackWrong": "…"}\n'
      + ']}\n\nREGLAS:\n' + common
      + '- Entre 5 y 8 preguntas, mayoría multichoice y al menos 1 truefalse.\n'
      + '- multichoice: 4 respuestas, EXACTAMENTE 1 correcta, sin repetidas; question ≤ 400 caracteres, respuesta ≤ 200, feedback ≤ 300.\n'
      + '- SITUACIONES, no definiciones: cada pregunta abre con una situación concreta del sector y el país (un rol y un dato: «Eres jefe de bodega y…», «En la planta, el indicador marca…») y pregunta qué hacer, qué decidir o por qué. PROHIBIDO «¿Qué es…?», «¿Cómo se define…?», «Se denomina…».\n'
      + '- truefalse: afirmaciones sobre las consecuencias de una situación, no definiciones.\n'
      + '- truefalse: "correct" booleano, sin "answers". feedbackCorrect es para quien ACERTÓ y feedbackWrong para quien FALLÓ (no dicen si la afirmación es verdadera): feedbackCorrect nunca empieza con «Incorrecto» ni «Falso».\n'
      + (focus && typeof focus.tfFirst === 'boolean' ? _dynAnswerBalanceRules(focus.tfFirst) : '');
  } else if (type === 'singlechoiceset') {
    body = 'Genera una PRÁCTICA RÁPIDA de selección única. Responde SOLO con este JSON:\n'
      + '{"title": "…", "questions": [{"question": "…", "answers": [{"text": "…", "correct": true}, {"text": "…", "correct": false}, {"text": "…", "correct": false}]}]}\n\nREGLAS:\n' + common
      + '- Entre 5 y 8 preguntas; cada una con 3 o 4 respuestas, EXACTAMENTE 1 correcta, sin repetidas.\n'
      + '- question ≤ 400 caracteres; respuesta ≤ 200.\n';
  } else if (type === 'dragtext' && focus && focus.dragTextMobile) {
    // #583 (I2): se resuelve en un teléfono — el texto y el banco de palabras caben en una pantalla.
    var M = typeof DYN_DRAGTEXT_MOBILE !== 'undefined' ? DYN_DRAGTEXT_MOBILE : { maxText: 300, minBlanks: 4, maxBlanks: 5, distractors: 2, wordMax: 14 };
    body = 'Genera un ejercicio de ARRASTRAR PALABRAS a un texto CORTO que se resuelve en un teléfono. Responde SOLO con este JSON:\n'
      + '{"title": "…", "taskDescription": "instrucción breve para el estudiante", "text": "Un párrafo breve donde cada término clave va entre asteriscos, por ejemplo: El *término* se usa para…", "distractors": ["…", "…"]}\n\nREGLAS:\n' + common
      + '- text: UN solo párrafo de 200 a ' + M.maxText + ' caracteres (contando todo) con ' + M.minBlanks + ' o ' + M.maxBlanks + ' huecos marcados *así*; cada hueco es la palabra o expresión exacta que el estudiante arrastra, de 1 o 2 palabras y como máximo ' + M.wordMax + ' caracteres. Frases cortas: en un teléfono los huecos y el banco de palabras deben verse en la misma pantalla.\n'
      + '- El texto describe un procedimiento o un caso del sector: los huecos son pasos, causas, consecuencias o relaciones que sirven al objetivo, no un glosario.\n'
      + '- distractors: EXACTAMENTE ' + M.distractors + ' palabras o expresiones cortas (≤ ' + M.wordMax + ' caracteres), plausibles y del mismo tipo que los huecos (para que el último hueco no salga por descarte), que NO son la respuesta de ningún hueco ni sinónimos de una respuesta.\n'
      + '- Asteriscos siempre en pares; nunca "**", nunca huecos anidados, sin espacios pegados al asterisco por dentro ("* hueco*" está mal).\n'
      + '- Dentro de un hueco y en cada distractor: ≤ 80 caracteres, sin saltos de línea, sin los caracteres * : \\ & < >.\n'
      + '- taskDescription ≤ 200 caracteres, una sola línea.\n';
  } else if (type === 'dragtext') {
    body = 'Genera un ejercicio de ARRASTRAR PALABRAS a un texto. Responde SOLO con este JSON:\n'
      + '{"title": "…", "taskDescription": "instrucción breve para el estudiante", "text": "Un párrafo sobre el tema donde cada término clave va entre asteriscos, por ejemplo: El *término* se usa para…"}\n\nREGLAS:\n' + common
      + '- text: 1 a 3 párrafos (≤ 3000 caracteres) con ENTRE 4 Y 10 huecos marcados *así*; cada hueco es la palabra o expresión exacta que el estudiante arrastra.\n'
      + '- El texto describe un procedimiento o un caso del sector: los huecos son pasos, causas, consecuencias o relaciones que sirven al objetivo, no un glosario.\n'
      + '- Asteriscos siempre en pares; nunca "**", nunca huecos anidados, sin espacios pegados al asterisco por dentro ("* hueco*" está mal).\n'
      + '- Dentro de un hueco: ≤ 80 caracteres, sin saltos de línea, sin los caracteres : \\ & < >.\n'
      + '- taskDescription ≤ 400 caracteres, una sola línea.\n';
  } else if (type === 'blanks') {
    body = 'Genera un ejercicio de COMPLETAR FRASES. Responde SOLO con este JSON:\n'
      + '{"title": "…", "text": "instrucción breve para el estudiante", "questions": ["Frase con un *hueco* que el estudiante escribe.", "Otra frase con *respuesta/variante aceptada*."]}\n\nREGLAS:\n' + common
      + '- questions: entre 4 y 8 frases, cada una con al menos 1 hueco *así* (entre 4 y 12 huecos en total); cada frase ≤ 500 caracteres, una sola línea.\n'
      + '- Un hueco puede aceptar variantes separadas por "/" (p.ej. *EPP/equipo de protección personal*); ninguna variante vacía; como "/" SIEMPRE separa variantes, nunca pongas unidades o fracciones dentro de un hueco ("km/h", "1/2").\n'
      + '- Cada hueco es un término de 1 a 3 palabras (nunca frases largas ni metáforas); ofrece variantes con "/" para sinónimos razonables.\n'
      + '- Las frases aplican el capítulo a situaciones del sector (qué se hace, en qué orden, qué pasa si…), no son definiciones de glosario.\n'
      + '- Respuestas cortas e inequívocas (el estudiante las TIPEA): ≤ 80 caracteres, sin : \\ & < >, sin espacios pegados al asterisco por dentro.\n'
      + '- text (instrucción) ≤ 400 caracteres, una sola línea.\n';
  } else if (type === 'branchingscenario') {
    body = dynBranchingScenarioPromptBody(focus && focus.chapterCase, focus && focus.chapterProcedure);
  } else {
    throw new Error('dynH5pActivityPrompt: tipo h5p desconocido "' + type + '"');
  }
  return head + body + '- Ningún campo extra.' + _dynV3LightBans() + '\n\nSOLO el JSON, nada más.';
}

// ── EV6 H5P v2: activity:<ch> tipo branchingscenario (solo Manifests con activityTypeRules = 2) ──
// Contrato del backend (src/package/h5p/types/branching-scenario.ts): el LLM escribe SOLO situación,
// decisiones (d1..d6), opciones (texto, next, consecuencia) y finales (e1..e5 con su calidad). Nunca
// índices de nodo, puntajes ni campos H5P: Cursia mapea a H5P.BranchingScenario y pone el puntaje
// (óptimo 10 / aceptable 7 / malo 0). Límites = BRANCHING_SCENARIO_LIMITS del backend.
var DYN_BS_LIMITS = {
  titleMax: 120, situationMax: 700, questionMax: 250, optionTextMax: 200, consequenceMax: 250,
  endingTitleMax: 80, endingTextMax: 300, minDecisions: 2, maxDecisions: 6, minOptions: 2, maxOptions: 3,
  minEndings: 3, maxEndings: 5, minDepth: 1, maxDepth: 4, maxPaths: 16, maxContentNodes: 8, maxOptimal: 2
};

// chapterCase (#542 I5, opcional): extracto del caso ya resuelto en el capítulo; el caso ramificado usa OTRO.
// chapterProcedure (#583 I4, opcional): los pasos del procedimiento del capítulo (lo que recorre el ejemplo
// resuelto): el caso ramificado plantea otra decisión, no esos pasos uno tras otro.
function dynBranchingScenarioPromptBody(chapterCase, chapterProcedure) {
  var L = DYN_BS_LIMITS;
  return 'Genera un CASO RAMIFICADO de decisiones profesionales. Responde SOLO con este JSON:\n'
    + '{"title": "…", "situation": "…", "decisions": [\n'
    + '  {"id": "d1", "question": "…", "options": [{"text": "…", "next": "d2", "consequence": "…"}, {"text": "…", "next": "end:e3", "consequence": "…"}]},\n'
    + '  {"id": "d2", "question": "…", "options": [{"text": "…", "next": "end:e1"}, {"text": "…", "next": "end:e2", "consequence": "…"}]}\n'
    + '], "endings": [\n'
    + '  {"id": "e1", "quality": "optimal", "title": "…", "text": "…"},\n'
    + '  {"id": "e2", "quality": "acceptable", "title": "…", "text": "…"},\n'
    + '  {"id": "e3", "quality": "poor", "title": "…", "text": "…"}\n'
    + ']}\n\nREGLAS DEL CASO:\n'
    + '- title: título corto del caso (≤ ' + L.titleMax + ' caracteres).\n'
    + '- situation (≤ ' + L.situationMax + ' caracteres): abre con un ROL y un dato concreto de la situación en el sector y el país (una lectura, un plazo, un pedido: «Eres supervisor de turno en … y el indicador marca …»). El dato es parte del caso, nunca una estadística.\n'
    + '- decisions: entre ' + L.minDecisions + ' y ' + L.maxDecisions + ', con id "d1", "d2"… en orden; question ≤ ' + L.questionMax + ' caracteres. Cada decisión es un dilema profesional plausible del capítulo y pregunta qué harías. PROHIBIDO «¿Qué es…?», «¿Cómo se define…?» o cualquier pregunta de definición.\n'
    + '- options: ' + L.minOptions + ' o ' + L.maxOptions + ' por decisión, con textos distintos entre sí (≤ ' + L.optionTextMax + ' caracteres). "consequence" (opcional, ≤ ' + L.consequenceMax + ') explica POR QUÉ esa decisión lleva a lo que sigue.\n'
    + '- next (obligatorio en TODAS las opciones): "dN" de una decisión declarada MÁS ABAJO en la lista (nunca hacia atrás ni a la misma: sin ciclos) o "end:eK" de un final que exista.\n'
    + '- Todas las decisiones y todos los finales se alcanzan desde "d1". Ningún camino recorre más de ' + L.maxDepth + ' decisiones y hay como máximo ' + L.maxPaths + ' caminos distintos.\n'
    + '- endings: entre ' + L.minEndings + ' y ' + L.maxEndings + ', con id "e1", "e2"…; quality "optimal" (la mejor práctica), "acceptable" (razonable pero mejorable) o "poor" (un error común); title ≤ ' + L.endingTitleMax + ', text ≤ ' + L.endingTextMax + ' caracteres y explica el resultado.\n'
    + '- Al menos 1 final "poor" y como máximo ' + L.maxOptimal + ' "optimal". El camino a un final "optimal" exige decidir bien al menos 2 veces (pasa por 2 o más decisiones).\n'
    + '- Las opciones que llevan a un final "poor" reflejan errores comunes que el capítulo enseña a evitar.\n'
    + '- Nunca escribas puntajes, números de nodo ni campos de H5P: Cursia los calcula.\n'
    + '- Todo texto en una sola línea, salvo situation.\n'
    + '- Las opciones de una misma decisión tienen extensión parecida (± 20 %): en CADA decisión la mejor opción NO es la más larga ni la más detallada (que una opción peor sea igual o más larga); a veces la mejor es la más breve.\n'
    + '- El capítulo ya trae un ejemplo resuelto que aplica su procedimiento de principio a fin: el caso NO es otro recorrido de ese procedimiento paso a paso. Plantea una COMPLICACIÓN del tema (un imprevisto, un error de otra persona, un conflicto con un cliente o un proveedor, un dato que falta o una presión de tiempo) donde decidir bien exige aplicar el capítulo de otra manera.\n'
    + (Array.isArray(chapterProcedure) && chapterProcedure.length
      ? '- NO recorras estos pasos del capítulo en orden (cada decisión = un paso): ' + chapterProcedure.map(function (s) { return '«' + String(s).replace(/\s+/g, ' ').trim() + '»'; }).join(' → ') + '.\n'
      : '')
    + (typeof chapterCase === 'string' && chapterCase.trim()
      ? '- CASO NUEVO: el capítulo ya resuelve este caso, NO lo repitas (ni su producto, ni su canal, ni sus datos): usa otro producto o servicio, otra situación o una condición distinta que obligue a decidir de verdad.\n<<<CASO_DEL_CAPITULO\n' + chapterCase.trim() + '\nCASO_DEL_CAPITULO>>>\n'
      : '');
}

// ── final_exam:<courseId> (GIFT) ──
// Mismo estilo que dynExamUnitPrompt; reparto derivado de la cantidad real de
// capítulos del curso (dynExamQuestionSplit) con tope de 40 preguntas.
var DYN_FINAL_EXAM_MAX_QUESTIONS = 40;

function dynFinalExamQuestionSplit(chapterCount) {
  var s = dynExamQuestionSplit(chapterCount);
  if (s.total <= DYN_FINAL_EXAM_MAX_QUESTIONS) return s;
  var total = DYN_FINAL_EXAM_MAX_QUESTIONS;
  var multichoice = Math.round(total * 0.6);
  var truefalse = Math.round(total * 0.2);
  var match = Math.max(0, total - multichoice - truefalse);
  return { total: multichoice + truefalse + match, multichoice: multichoice, truefalse: truefalse, match: match };
}

function _dynPad2(n) { return n < 10 ? '0' + n : String(n); }

function dynFinalExamPrompt(courseContext, outline, allChapterTitles, ped) {
  var c = dynCtx(courseContext, outline);
  var nombre = (courseContext && courseContext.nombre) || '';
  var sector = (courseContext && courseContext.sector) || '';
  var pais = (courseContext && courseContext.pais) || '';
  var titles = allChapterTitles || [];
  var split = dynFinalExamQuestionSplit(titles.length);
  var qTypes = '- ' + split.multichoice + ' selección múltiple (distractores plausibles, opciones misma longitud)\n- ' + split.truefalse + ' Verdadero/Falso (mezcla TRUE y FALSE, no más de 3 iguales)\n- ' + split.match + ' emparejamiento (4 pares cada uno, términos específicos de ' + sector + ')\n';
  return c + '\n\nExamen FINAL del curso "' + nombre + '" (' + sector + ', ' + pais + ').\nTemas cubiertos (todo el curso): ' + titles.join(' | ') + '\n\n' + split.total + ' PREGUNTAS distribuidas así:\n' + qTypes
    + '\n$CATEGORY: ' + nombre + ' - Examen Final\n'
    + 'IDs: EF-01 a EF-' + _dynPad2(split.total) + '\n'
    + 'Cobertura proporcional de TODOS los temas listados (ninguno sin preguntas), integrando conceptos de distintas partes del curso.\n'
    + 'Cada pregunta específica para el sector ' + sector + ' en ' + pais + ' — NUNCA genérica.\n'
    + 'No menciones otras piezas del curso (video, presentación, juego, actividad) ni números de capítulo o módulo en los enunciados.\n'
    + _dynPedagogyLine(ped)
    + dynGiftSyntaxRef(courseContext);
}

function dynFinalExamCorrectionPrompt(courseContext, outline, faltantes, nextIdNum, ped) {
  var c = dynCtx(courseContext, outline);
  var nombre = (courseContext && courseContext.nombre) || '';
  var sector = (courseContext && courseContext.sector) || '';
  var pais = (courseContext && courseContext.pais) || '';
  var totalMissing = faltantes.reduce(function (s, f) { return s + f.count; }, 0);
  var typeLabels = { multichoice: 'selección múltiple (4 opciones, 1 correcta)', truefalse: 'verdadero/falso', match: 'emparejamiento (mínimo 4 pares cada una)' };
  var detalle = faltantes.map(function (f) { return '- ' + f.count + ' de ' + (typeLabels[f.type] || f.type); }).join('\n');
  return c + '\n\nGeneraste el examen FINAL de "' + nombre + '" pero faltaron preguntas de tipos específicos: tu respuesta anterior solo llegó hasta EF-' + _dynPad2(nextIdNum - 1) + '.\nGenera EXACTAMENTE estas ' + totalMissing + ' preguntas ADICIONALES, del tipo EXACTO indicado en cada caso (no las repongas con otro tipo):\n' + detalle + '\nContinuando la numeración desde ::EF-' + _dynPad2(nextIdNum) + ':: en adelante (sin saltos ni repetir preguntas anteriores). Mismo rigor: preguntas concretas del sector ' + sector + ' en ' + pais + ', nunca genéricas.\nENTREGA SOLO las ' + totalMissing + ' preguntas nuevas en formato GIFT puro, sin repetir ninguna pregunta anterior, sin texto explicativo.'
    + (ped ? '\n' + _dynPedagogyLine(ped) : '')
    + dynGiftSyntaxRef(courseContext);
}

// ── Reintento dirigido para los items JSON v3 ──
// Mismo prompt + la lista exacta de errores del validador del cliente (45).
// Pide el JSON COMPLETO de nuevo (nunca se fusiona una respuesta parcial).
function dynV3RetryPrompt(basePrompt, errors) {
  var list = (errors || []).slice(0, 30).map(function (e) { return '- ' + e; }).join('\n');
  var resource = (errors || []).some(function (e) { return /RESOURCE_MENTION/.test(e); });
  var quantity = (errors || []).some(function (e) { return /QUANTITY_CLAIM/.test(e); });
  var branching = (errors || []).some(function (e) { return /DIAGRAM_BRANCHING_IN_SEQUENCE/.test(e); });
  var arrows = (errors || []).some(function (e) { return /TEXT_SIMULATED_DIAGRAM/.test(e); });
  var bsGraph = (errors || []).some(function (e) { return /\[BS_(REF|FORWARD_ONLY|UNREACHABLE|DEAD_END|ENDINGS|DEPTH|PATHS|NODES)\]/.test(e); });
  return basePrompt + '\n\nTU RESPUESTA ANTERIOR FUE RECHAZADA por estos errores de validación:\n' + list
    + (resource ? '\nRESOURCE_MENTION: reescribe esos textos SIN esas palabras (habla solo de conceptos; usa sinónimos si el tema lo exige).' : '')
    + (quantity ? '\nQUANTITY_CLAIM: elimina esos números de estructura (usa títulos en lugar de números).' : '')
    + (branching ? '\nDIAGRAM_BRANCHING_IN_SEQUENCE: ese flujo/proceso/línea de tiempo esconde una decisión («Sí → …», «No: …», «Si no…»). Una secuencia no se ramifica: REEMPLAZA ese mismo componente (no agregues uno nuevo) por {"type": "diagram", "kind": "decision", "title": "…", "tree": {"question": "¿…?", "yes": {"action": "…"}, "no": {"action": "…"}}} (cada rama lleva "action" o "tree", nunca ambos), o reescribe los pasos como pasos reales sin «Sí/No». Respeta los límites: ningún tipo más de ' + DYN_VC_MAX_SAME_TYPE + ' veces en todo el documento (si ya hay ' + DYN_VC_MAX_SAME_TYPE + ' "diagram", convierte en árbol uno de ellos en lugar de sumar otro) y el máximo de componentes de cada movimiento.' : '')
    + (arrows ? '\nTEXT_SIMULATED_DIAGRAM: no dibujes diagramas con flechas en el texto («Paso 1 → Paso 2 → Paso 3»). Escribe frases normales; si es una secuencia usa "process_steps" (o un "diagram" kind "flow"); si hay condiciones, un "diagram" kind "decision".' : '')
    + (bsGraph ? '\nCASO RAMIFICADO: corrige el grafo, no solo el texto. Cada "next" apunta a una decisión declarada MÁS ABAJO o a "end:eK" de un final que exista; todas las decisiones y todos los finales se alcanzan desde "d1"; al menos un final "poor" y un "optimal" al que se llega tras 2 o más decisiones.' : '')
    + '\nVuelve a generar el JSON COMPLETO corrigiendo TODOS los errores. SOLO el JSON.';
}

// ════════════════════════════════════════════════════════════════════════
// EV6 P2 (F1) — Banco de preguntas de los exámenes (dynamic_exam_bank_json).
// Contrato: scratchpad P2-task-B2.md §1/§2 (backend course-shell/exam-bank.ts).
// Puros, sin estado global. Todavía SIN ruta de llamada activa: el ejecutor
// (F2) los conecta; los builders GIFT de arriba siguen intactos.
// ════════════════════════════════════════════════════════════════════════

// Orden fijo de tipos (B2 §1: multichoice, truefalse, match).
var DYN_EXAM_BANK_TYPES = ['multichoice', 'truefalse', 'match'];
var DYN_EXAM_BANK_ID_TAG = { multichoice: 'MC', truefalse: 'TF', match: 'EM' };
// Palabras absolutas: la MISMA lista para el prompt y para el ejecutor (45 la normaliza).
var DYN_EXAM_ABSOLUTE_WORDS_LIST = ['siempre', 'nunca', 'jamás', 'todos', 'todas', 'ninguno', 'ninguna', 'solo', 'únicamente'];

// Piso / objetivo / pedido / máximo aceptado por hoja (B2 §1).
function dynExamBankFloor(slots) { return Math.max(slots + 1, Math.ceil(1.5 * slots)); }
function dynExamBankTarget(slots) { return 2 * slots; }
// BANKOPT (opción 1): holgura dentro del contrato — se piden 2·slots+1 por hoja (selección múltiple
// 2·slots+2, la que más se rechaza) y el ensamblado conserva el objetivo 2·slots. Un rechazo suelto ya
// no dispara una llamada de reparación (que reenvía todo el capítulo). Nunca más que el máximo del
// contrato (bankMax = 2s+2): el banco subido sigue con 2·slots por hoja.
// Exam-bank D2 (#1353): pool moderado — selección múltiple 2·slots+4, V/F y emparejamiento 2·slots+2. En el piloto
// #1353 el ~40 % de las candidatas pasó la validación en la primera pasada y la holgura de 1–2 dejaba hojas cortas que
// se cerraban con reparaciones (177 de 227 llamadas). El banco subido sigue con 2·slots por hoja (bankMax 2s+2).
function dynExamBankAskCount(slots, type) { return 2 * slots + (type === 'multichoice' ? 4 : 2); }
function dynExamBankMaxCount(slots) { return 2 * slots + 2; }

// Id de capítulo/módulo de entrada: string, o objeto con chapterId|moduleId|id
// (capítulo del outline o del claim). Cualquier otra forma LANZA (nunca hojas
// con ids undefined).
function _dynExamBankId(x, kind) {
  var id = x;
  if (x && typeof x === 'object') id = kind === 'module' ? (x.moduleId != null ? x.moduleId : x.id) : (x.chapterId != null ? x.chapterId : x.id);
  if (typeof id !== 'string' || !id) throw new Error('EXAM_BANK_PLAN: ' + (kind === 'module' ? 'módulo' : 'capítulo') + ' sin id válido (' + JSON.stringify(x) + ')');
  return id;
}
function _dynExamBankUnique(ids) {
  var seen = {};
  ids.forEach(function (id) {
    if (Object.prototype.hasOwnProperty.call(seen, id)) throw new Error('EXAM_BANK_PLAN: id repetido "' + id + '"');
    seen[id] = true;
  });
}

// Espejo de moduleExamPlan(chapterIds[]): hojas { chapterId, type, slots } en
// orden tipo → capítulo (orden del Manifest). Sin capítulos lanza (igual que B2).
// Por tipo T: base = floor(n_T / k)
// y los primeros n_T − base·k capítulos reciben +1. Hojas con 0 slots se omiten.
// `chapters` = ids (string), capítulos del outline ({ id, … }) o del claim
// ({ chapterId, … }); otra forma, ids vacíos o repetidos → lanza EXAM_BANK_PLAN.
function dynExamSlotPlan(chapters) {
  if (!Array.isArray(chapters)) throw new Error('EXAM_BANK_PLAN: se esperaba una lista de capítulos');
  var ids = chapters.map(function (c) { return _dynExamBankId(c, 'chapter'); });
  _dynExamBankUnique(ids);
  var k = ids.length;
  if (!k) throw new Error('EXAM_BANK_PLAN: un examen de módulo necesita al menos un capítulo');
  var split = dynExamQuestionSplit(k);
  var leaves = [];
  DYN_EXAM_BANK_TYPES.forEach(function (type) {
    var n = split[type];
    var base = Math.floor(n / k);
    var extra = n - base * k;
    ids.forEach(function (chapterId, i) {
      var slots = base + (i < extra ? 1 : 0);
      if (slots > 0) leaves.push({ chapterId: chapterId, type: type, slots: slots });
    });
  });
  return leaves;
}

// Espejo de finalExamPlan(modules): hojas { moduleId, type, slots }. Por tipo T:
// resto mayor de n_T · capítulos_m / totalCapítulos (aritmética entera), empates
// → módulo anterior. `modules` = [{ moduleId | id, chapterIds[] | chapters[] }];
// forma inválida, ids vacíos o repetidos → lanza EXAM_BANK_PLAN.
function dynFinalExamSlotPlan(modules) {
  if (!Array.isArray(modules)) throw new Error('EXAM_BANK_PLAN: se esperaba una lista de módulos');
  var allChapters = [];
  var mods = modules.map(function (m) {
    if (!m || typeof m !== 'object') throw new Error('EXAM_BANK_PLAN: módulo inválido (' + JSON.stringify(m) + ')');
    var chs = m.chapterIds || m.chapters;
    if (!Array.isArray(chs)) throw new Error('EXAM_BANK_PLAN: el módulo no trae chapterIds[]');
    chs.forEach(function (c) { allChapters.push(_dynExamBankId(c, 'chapter')); });
    return { moduleId: _dynExamBankId(m, 'module'), count: chs.length };
  });
  _dynExamBankUnique(mods.map(function (m) { return m.moduleId; }));
  _dynExamBankUnique(allChapters);
  var total = mods.reduce(function (t, m) { return t + m.count; }, 0);
  if (!total) throw new Error('EXAM_BANK_PLAN: un examen final necesita al menos un capítulo');
  var split = dynFinalExamQuestionSplit(total);
  var leaves = [];
  DYN_EXAM_BANK_TYPES.forEach(function (type) {
    var n = split[type];
    var rows = mods.map(function (m, i) {
      var num = n * m.count;
      return { i: i, slots: Math.floor(num / total), rem: num % total };
    });
    var left = n - rows.reduce(function (t, r) { return t + r.slots; }, 0);
    rows.slice().sort(function (a, b) { return (b.rem - a.rem) || (a.i - b.i); })
      .slice(0, left).forEach(function (r) { r.slots++; });
    rows.forEach(function (r) {
      if (r.slots > 0) leaves.push({ moduleId: mods[r.i].moduleId, type: type, slots: r.slots });
    });
  });
  return leaves;
}

function _dynExamBankClip(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') : s; }

// Mismo estilo que dynExamContentBlock (Objetivo / Qué enseñó / Conceptos /
// Términos) pero por TÍTULO, sin número de capítulo (el modelo no debe copiar
// números de estructura en las preguntas). summary: string u objeto
// { summary, concepts, keyTerms } (context_summary del content).
function _dynExamBankSummaryLines(chapter, summary) {
  var s = (summary && typeof summary === 'object') ? summary : { summary: summary };
  var out = '- ' + _dynExamBankClip(chapter && chapter.title, 120);
  var objective = (chapter && chapter.objective) || s.objective;
  if (objective) out += '\n  Objetivo: ' + _dynExamBankClip(objective, 300);
  if (s.summary) out += '\n  Qué enseñó: ' + _dynExamBankClip(s.summary, 700);
  var concepts = s.concepts || s.concepts_introduced;
  var terms = s.keyTerms || s.key_terms;
  if (concepts && concepts.length) out += '\n  Conceptos: ' + concepts.slice(0, 12).map(function (x) { return _dynExamBankClip(x, 80); }).join('; ');
  if (terms && terms.length) out += '\n  Términos: ' + terms.slice(0, 15).map(function (x) { return _dynExamBankClip(x, 60); }).join('; ');
  return out;
}

function _dynExamBankFindModule(outline, chapterId) {
  var found = null;
  (outline || []).forEach(function (mo) {
    (mo.chapters || []).forEach(function (c) { if (c.id === chapterId) found = { module: mo, chapter: c }; });
  });
  return found;
}

function _dynPad2Bank(n) { return n < 10 ? '0' + n : String(n); }

// Recordar/comprender ≈ 30 %, aplicar/analizar ≈ 70 % por hoja.
function _dynExamBankLevelSplit(ask) {
  var low = Math.round(ask * 0.3);
  return { low: low, high: ask - low };
}

// ── Pedidos parciales de una hoja (review I3) ──
// Una hoja del plan pide dynExamBankAskCount(slots, type) preguntas con ids <prefijo><TAG>-01…NN. Para
// no exceder el tamaño de una llamada, F2 puede pedir una PARTE de la hoja:
//   { …hoja, from, count }  → ids from…from+count−1 (1-based) de esa hoja, o
//   { …hoja, ids: [...] }   → exactamente esos ids (p.ej. faltantes).
// Los ids son los mismos sin importar cómo se parta la hoja (deterministas).
// Recomendación para F2: ≤ DYN_EXAM_BANK_MAX_QUESTIONS_PER_CALL preguntas por
// llamada (dynExamBankChunkLeaves) y max_tokens ≥ DYN_EXAM_BANK_RECOMMENDED_MAX_TOKENS
// (≈ 380 tokens de salida por pregunta: 20 → ≈ 7,6 k; 16 k deja margen al JSON).
var DYN_EXAM_BANK_MAX_QUESTIONS_PER_CALL = 20;
var DYN_EXAM_BANK_RECOMMENDED_MAX_TOKENS = 16384;
var DYN_EXAM_BANK_QID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function _dynExamBankLeafRequest(leaf) {
  if (!leaf || DYN_EXAM_BANK_TYPES.indexOf(leaf.type) === -1 || !(leaf.slots > 0) || Math.floor(leaf.slots) !== leaf.slots) {
    throw new Error('EXAM_BANK_LEAF: hoja inválida (' + JSON.stringify(leaf) + ')');
  }
  var ask = dynExamBankAskCount(leaf.slots, leaf.type);
  if (leaf.ids != null) {
    if (!Array.isArray(leaf.ids) || !leaf.ids.length || leaf.ids.some(function (id) { return typeof id !== 'string' || !DYN_EXAM_BANK_QID_RE.test(id); })) {
      throw new Error('EXAM_BANK_LEAF: ids inválidos (' + JSON.stringify(leaf.ids) + ')');
    }
    return { ask: ask, ids: leaf.ids.slice() };
  }
  var from = leaf.from == null ? 1 : leaf.from;
  var count = leaf.count == null ? ask - from + 1 : leaf.count;
  if (Math.floor(from) !== from || Math.floor(count) !== count || from < 1 || count < 1 || from + count - 1 > ask) {
    throw new Error('EXAM_BANK_LEAF: rango fuera de la hoja (from ' + from + ', count ' + count + ', máximo ' + ask + ')');
  }
  return { ask: ask, from: from, count: count };
}

// Ids que pide una hoja (o una parte de ella) con el prefijo de la llamada.
function dynExamBankLeafIds(idPrefix, leaf) {
  var r = _dynExamBankLeafRequest(leaf);
  if (r.ids) return r.ids;
  var tag = DYN_EXAM_BANK_ID_TAG[leaf.type];
  var out = [];
  for (var n = r.from; n < r.from + r.count; n++) out.push(idPrefix + tag + '-' + _dynPad2Bank(n));
  return out;
}

// Parte las hojas (en orden) en llamadas de ≤ maxPerCall preguntas; una hoja
// grande se reparte con { from, count }. Puro y determinista.
function dynExamBankChunkLeaves(leaves, maxPerCall) {
  var cap = maxPerCall || DYN_EXAM_BANK_MAX_QUESTIONS_PER_CALL;
  if (!(cap >= 1)) throw new Error('EXAM_BANK_LEAF: maxPerCall inválido');
  var calls = [];
  var cur = [];
  var room = cap;
  (leaves || []).forEach(function (leaf) {
    var ask = _dynExamBankLeafRequest(leaf).ask;
    var from = 1;
    while (from <= ask) {
      var count = Math.min(room, ask - from + 1);
      var part = {};
      Object.keys(leaf).forEach(function (k) { if (k !== 'from' && k !== 'count' && k !== 'ids') part[k] = leaf[k]; });
      part.from = from;
      part.count = count;
      cur.push(part);
      from += count;
      room -= count;
      if (!room) { calls.push(cur); cur = []; room = cap; }
    }
  });
  if (cur.length) calls.push(cur);
  return calls;
}

// Prefijos de id. Sin número de módulo/capítulo usa la posición en el outline
// (review M10); si tampoco está en el outline, LANZA (ids repetidos entre
// capítulos romperían el banco).
function dynExamBankChapterIdPrefix(outline, chapter) {
  var ch = chapter || {};
  var chId = ch.id != null ? ch.id : ch.chapterId;
  var mNum = null;
  var cNum = ch.chapterNumber != null ? ch.chapterNumber : null;
  var gi = 0;
  (outline || []).forEach(function (mo, mi) {
    (mo.chapters || []).forEach(function (c) {
      gi++;
      if (c.id === chId) {
        mNum = mo.moduleNumber != null ? mo.moduleNumber : mi + 1;
        if (cNum == null) cNum = c.chapterNumber != null ? c.chapterNumber : gi;
      }
    });
  });
  if (mNum == null || cNum == null) throw new Error('EXAM_BANK_ID: el capítulo "' + chId + '" no está en el outline');
  return 'M' + mNum + '-C' + cNum + '-';
}
function dynFinalExamBankIdPrefix(outline, module) {
  var mo = module || {};
  var mNum = mo.moduleNumber;
  if (mNum == null) {
    (outline || []).forEach(function (x, i) { if (x.id === mo.id) mNum = x.moduleNumber != null ? x.moduleNumber : i + 1; });
  }
  if (mNum == null) throw new Error('EXAM_BANK_ID: el módulo "' + mo.id + '" no está en el outline');
  return 'EF-M' + mNum + '-';
}

function _dynExamBankRequestCount(leaves) {
  return (leaves || []).reduce(function (t, l) { return t + dynExamBankLeafIds('x', l).length; }, 0);
}

function _dynExamBankLeafLines(leaves, idPrefix) {
  var labels = { multichoice: 'selección múltiple', truefalse: 'verdadero/falso', match: 'emparejamiento' };
  return (leaves || []).map(function (leaf) {
    var ids = dynExamBankLeafIds(idPrefix, leaf);
    var n = ids.length;
    var lv = _dynExamBankLevelSplit(n);
    var idText = (leaf.ids != null)
      ? 'exactamente estos ids: ' + ids.map(function (id) { return '"' + id + '"'; }).join(', ')
      : 'ids "' + ids[0] + '" a "' + ids[n - 1] + '"';
    var line = '- type "' + leaf.type + '" (' + labels[leaf.type] + '): EXACTAMENTE ' + n + ' preguntas, ' + idText + '; '
      + 'nivel: ' + lv.low + ' de "recordar"/"comprender" y ' + lv.high + ' de "aplicar"/"analizar".';
    if (leaf.type === 'truefalse') {
      line += ' Balance: ' + Math.floor(n / 2) + ' o ' + Math.ceil(n / 2) + ' con "answer": true y el resto false.';
    }
    return line;
  }).join('\n');
}

// Esquema que ve el LLM (= B2 §2 salvo: 5 distractores y sin plan/bankVersion/scope,
// que arma el ejecutor). withModule: preguntas del examen final llevan moduleId.
function _dynExamBankSchemaText(withModule) {
  var common = '"id": "<id indicado>", "type": "multichoice|truefalse|match", "chapterId": "<id del capítulo>", '
    + (withModule ? '"moduleId": "<id del módulo>", ' : '')
    + '"level": "recordar|comprender|aplicar|analizar", "stem": "…", "explanation": "…", "evidenceRef": "S<n>"';
  return '\n\nFORMATO DE SALIDA — SOLO JSON, sin texto antes ni después, sin bloques de código:\n'
    + '{ "questions": [ … ] }\n'
    + 'Cada pregunta tiene las claves comunes { ' + common + ' } más las de su tipo, y NINGUNA otra clave:\n'
    + '- multichoice: "correct": { "text": "…", "why": "…" }, "distractors": [ { "text": "…", "why": "…" } × EXACTAMENTE 5 ]\n'
    + '- truefalse: "answer": true|false, "whyWrong": "…"\n'
    + '- match: "pairs": [ { "term": "…", "definition": "…" } × EXACTAMENTE 4 ]\n'
    + 'Longitudes (caracteres): stem 20–600; explanation 60–350; text de opción 1–200; why 20–200; whyWrong 20–200; term 1–60; definition 1–200. Sé breve: "why" en una oración, "explanation" en dos como máximo.\n'
    + 'Todo texto plano: sin HTML, sin Markdown, sin sintaxis GIFT, sin URLs.\n'
    + 'JSON MINIFICADO: en una sola línea, sin saltos de línea ni sangría.';
}

function _dynExamBankRules(scopeFinal) {
  return '\n\nREGLAS DE LAS PREGUNTAS (un validador automático rechaza las que no las cumplan):\n'
    + '- CONTENIDO ENSEÑADO: pregunta SOLO por hechos, criterios y procedimientos que enseña el texto del capítulo' + (scopeFinal ? ' que indicas en "chapterId"' : '') + '. Nada de datos, normas, cifras, entidades ni casos que el texto no trae.\n'
    + '- EVIDENCIA POR REFERENCIA: en el texto del capítulo' + (scopeFinal ? ' de su "chapterId"' : '') + ' cada fragmento que se puede citar empieza con una marca [S1], [S2]… Cada pregunta indica en "evidenceRef" la marca del fragmento que respalda la respuesta correcta, la afirmación del verdadero/falso o los pares (por ejemplo "evidenceRef": "S12"); Cursia copia el texto exacto. Usa SOLO marcas que aparecen en ESE texto: nunca inventes una marca ni escribas el fragmento. En emparejamiento elige un fragmento que nombre o defina los términos de los pares. Nunca escribas las marcas [S#] dentro del enunciado, las opciones, los pares ni las explicaciones.\n'
    + '- NIVEL: ≈ 30 % recordar/comprender y ≈ 70 % aplicar/analizar. Las de aplicar/analizar plantean una situación concreta del sector en la que el estudiante decide, diagnostica o elige un procedimiento.\n'
    + '- SELECCIÓN MÚLTIPLE: escribe EXACTAMENTE 5 distractores (Cursia elige después cuáles se usan). Cada distractor es de la misma categoría y con las mismas unidades que la opción correcta, y representa un error conceptual real del tema; su "why" explica esa confusión. '
    + 'LONGITUD: de los 5 distractores, 2 o 3 son MÁS LARGOS y 2 o 3 MÁS CORTOS que la opción correcta (en caracteres), ninguno de menos de la mitad ni de más de 1,7 veces su longitud. '
    + 'NUNCA «todas las anteriores», «ninguna de las anteriores» ni «todas son correctas» (Moodle baraja las opciones). Palabras absolutas (' + DYN_EXAM_ABSOLUTE_WORDS_LIST.join(', ') + ') no pueden aparecer únicamente en los distractores. "correct.why" explica por qué es la correcta.\n'
    + '- VERDADERO/FALSO: afirmaciones TRUE y FALSE balanceadas' + (scopeFinal ? ' (y dentro de cada capítulo cuando haya varias)' : ' en el capítulo') + '. Una afirmación falsa contiene un error concreto y plausible, no una negación artificial. "whyWrong" explica el error de quien elige la respuesta contraria.\n'
    + '- EMPAREJAMIENTO: EXACTAMENTE 4 pares; cada término tiene una sola definición posible (nunca pares intercambiables), términos y definiciones no se repiten, y una definición nunca contiene su propio término. "term" ≤ 60 caracteres y SIN los símbolos < ni > (Moodle los borra del desplegable).\n'
    + '- EXPLICACIÓN: "explanation" enseña el concepto (cita la idea, no el capítulo). Nunca menciones letras ni posiciones de opciones («la opción b», «la primera»), «la más larga», otros recursos del curso (video, juego, presentación, actividad, examen) ni números de capítulo o módulo.\n'
    + '- COHERENCIA CON EL CURSO: la opción correcta, los pares y las afirmaciones VERDADERAS coinciden con lo que enseña el curso. Nunca premies un neuromito (p. ej., «estilos de aprendizaje» visual/auditivo/kinestésico) ni una práctica que el curso desaconseja: esos errores solo pueden aparecer como distractores o afirmaciones FALSAS. '
    + 'No atribuyas intención, voluntad ni deseos a la IA en una respuesta correcta o afirmación VERDADERA.\n'
    + '- Preguntas distintas entre sí (ningún enunciado repetido ni reformulado), específicas del sector, nunca genéricas. Español latinoamericano con tuteo; nunca voseo.';
}

// ── BANKOPT (opción 2): prompts en 3 partes para el caché de prompts (5 min) ──
// El prompt de un capítulo es source + task + tail, en ese orden:
//   source = contexto del curso + resumen + Markdown COMPLETO del capítulo. Idéntico byte a byte para
//            el examen del módulo y el examen final del MISMO capítulo (y para todas sus partes y
//            reparaciones) → primer punto de caché.
//   task   = marcador + tarea + reglas + esquema; estable por capítulo y alcance → segundo punto.
//   tail   = lo que cambia por llamada: CANTIDADES/ids, «no repitas», lista de reparación.
// El ejecutor manda source y task como bloques con cache_control (dynExamBankUserContent); el texto
// plano (dynExamBankPromptText) es el mismo contenido para las claves de caché, tamaños y harnesses.
var DYN_EXAM_BANK_CACHE_CONTROL = { type: 'ephemeral' }; // 5 min: el precio de escritura del ledger es el de 5 min (1,25×)
function _dynExamBankSourceBlock(courseContext, outline, chapter, chapterMd, summary) {
  var ch = chapter || {};
  return 'EXAM_BANK_SOURCE v2\n'
    + _dynCtxV3(courseContext, outline)
    + '\n\nLO QUE ENSEÑÓ EL CAPÍTULO (resumen):\n' + _dynExamBankSummaryLines(ch, summary)
    + '\n\nTEXTO COMPLETO DEL CAPÍTULO (única fuente de las preguntas; los fragmentos citables llevan su marca [S#] para "evidenceRef"):\n<<<CAPITULO\n' + String(chapterMd || '') + '\nCAPITULO>>>';
}
function _dynExamBankQuantitiesTail(leaves, idPrefix) {
  return '\n\nCANTIDADES (' + _dynExamBankRequestCount(leaves) + ' preguntas en total):\n' + _dynExamBankLeafLines(leaves, idPrefix)
    + '\n\nSOLO el JSON { "questions": [...] }, nada más.';
}
function dynExamBankPromptText(parts) {
  if (typeof parts === 'string') return parts;
  return String((parts && parts.source) || '') + String((parts && parts.task) || '') + String((parts && parts.tail) || '');
}
// Contenido del mensaje del usuario para api(): bloques de texto, con cache_control al final de
// source y de task (2 de los 4 puntos de caché que admite la API). Sin `tail` vacío.
function dynExamBankUserContent(parts) {
  var out = [
    { type: 'text', text: String(parts.source || ''), cache_control: { type: DYN_EXAM_BANK_CACHE_CONTROL.type } },
    { type: 'text', text: String(parts.task || ''), cache_control: { type: DYN_EXAM_BANK_CACHE_CONTROL.type } },
  ];
  if (parts.tail) out.push({ type: 'text', text: String(parts.tail) });
  return out;
}
function dynExamBankWithTail(parts, tail) {
  return { source: parts.source, task: parts.task, tail: tail };
}

// ── exam:<moduleId> — un capítulo del banco del examen del módulo ──
// chapter = capítulo del outline { id, title, chapterNumber, objective? };
// leaves  = hojas del plan de ESE capítulo (dynExamSlotPlan filtrado por chapterId),
//           completas o parciales ({ from, count } | { ids }, ver dynExamBankChunkLeaves);
// chapterMd = Markdown COMPLETO del content del capítulo; summary = context_summary.
function dynExamBankChapterPromptParts(courseContext, outline, chapter, leaves, chapterMd, summary, ped) {
  var ch = chapter || {};
  var hit = _dynExamBankFindModule(outline, ch.id);
  var sector = (courseContext && courseContext.sector) || '';
  var pais = (courseContext && courseContext.pais) || '';
  var idPrefix = dynExamBankChapterIdPrefix(outline, ch);
  return {
    source: _dynExamBankSourceBlock(courseContext, outline, ch, chapterMd, summary),
    task: '\n\nEXAM_BANK_CHAPTER v2\n'
      + 'TAREA: escribe el banco de preguntas de evaluación del capítulo «' + (ch.title || '') + '»' + (hit ? ' (módulo «' + hit.module.title + '»)' : '') + ' para el sector ' + sector + ' en ' + pais + '. '
      + 'Moodle sortea preguntas de este banco para cada estudiante, así que todas deben tener la misma calidad.\n'
      + 'Todas las preguntas llevan "chapterId": "' + ch.id + '".'
      + (ped || '')
      + _dynExamBankRules(false)
      + _dynExamBankSchemaText(false),
    tail: _dynExamBankQuantitiesTail(leaves, idPrefix),
  };
}
function dynExamBankChapterPrompt(courseContext, outline, chapter, leaves, chapterMd, summary, ped) {
  return dynExamBankPromptText(dynExamBankChapterPromptParts(courseContext, outline, chapter, leaves, chapterMd, summary, ped));
}

// ── final_exam — un módulo del banco del examen final ──
// module = módulo del outline { id, moduleNumber, title, chapters[] }; leaves =
// hojas del plan final de ESE módulo (completas o parciales, como arriba);
// chaptersMd[] y summaries[] alineados con
// module.chapters (o mapas por chapterId).
function dynFinalExamBankModulePrompt(courseContext, outline, module, leaves, chaptersMd, summaries, ped) {
  var mo = module || {};
  var chapters = mo.chapters || [];
  var sector = (courseContext && courseContext.sector) || '';
  var pais = (courseContext && courseContext.pais) || '';
  function pick(src, c, i) {
    if (!src) return '';
    if (Array.isArray(src)) return src[i];
    return src[c.id];
  }
  var idPrefix = dynFinalExamBankIdPrefix(outline, mo);
  var total = _dynExamBankRequestCount(leaves);
  var summaryBlock = chapters.map(function (c, i) { return _dynExamBankSummaryLines(c, pick(summaries, c, i)) + '\n  chapterId: "' + c.id + '"'; }).join('\n');
  var mdBlock = chapters.map(function (c, i) {
    return '<<<CAPITULO chapterId="' + c.id + '" título="' + c.title + '"\n' + String(pick(chaptersMd, c, i) || '') + '\nCAPITULO>>>';
  }).join('\n\n');
  return 'EXAM_BANK_FINAL_MODULE v1\n'
    + _dynCtxV3(courseContext, outline)
    + '\n\nTAREA: escribe la parte del banco de preguntas de la evaluación FINAL del curso que corresponde al módulo «' + (mo.title || '') + '», para el sector ' + sector + ' en ' + pais + '. '
    + 'Son preguntas INTEGRADORAS: plantea situaciones que combinen ideas de distintos capítulos de este módulo. Moodle sortea preguntas de este banco para cada estudiante, así que todas deben tener la misma calidad.\n'
    + 'Todas las preguntas llevan "moduleId": "' + mo.id + '". El "chapterId" de cada pregunta es el del capítulo que contiene su "evidence"; reparte las preguntas entre todos los capítulos del módulo.\n'
    + '\nCANTIDADES (' + total + ' preguntas en total):\n' + _dynExamBankLeafLines(leaves, idPrefix)
    + '\n\nLO QUE ENSEÑÓ CADA CAPÍTULO (resumen):\n' + summaryBlock
    + '\n\nTEXTO COMPLETO DE LOS CAPÍTULOS (única fuente de las preguntas y de "evidence"):\n' + mdBlock
    + (ped || '')
    + _dynExamBankRules(true)
    + _dynExamBankSchemaText(true)
    + '\n\nSOLO el JSON { "questions": [...] }, nada más.';
}

// ── final_exam — UN capítulo de un módulo del banco del examen final (EV6 P2 F2, fix 1) ──
// Los límites del proxy (8000 tokens de salida, 64 KB de cuerpo) no admiten el
// Markdown de todo un módulo: cada llamada lleva SOLO el texto de su capítulo y
// la parte de las hojas del módulo que le toca (ids deterministas del módulo,
// prefijo EF-M<m>-). Los resúmenes de los demás capítulos del módulo dan el
// contexto integrador (son cortos); la evidencia sale siempre de ESTE capítulo.
function dynFinalExamBankChapterPromptParts(courseContext, outline, module, chapter, leaves, chapterMd, summaries, ped) {
  var mo = module || {};
  var ch = chapter || {};
  var chapters = mo.chapters || [];
  var sector = (courseContext && courseContext.sector) || '';
  var pais = (courseContext && courseContext.pais) || '';
  var pick = function (c) { return summaries ? summaries[c.id] : null; };
  var idPrefix = dynFinalExamBankIdPrefix(outline, mo);
  var others = chapters.filter(function (c) { return c.id !== ch.id; });
  return {
    // Misma fuente que el examen del módulo de este capítulo (caché compartido entre ambos ítems).
    source: _dynExamBankSourceBlock(courseContext, outline, ch, chapterMd, pick(ch) || null),
    task: '\n\nEXAM_BANK_FINAL_CHAPTER v2\n'
      + 'TAREA: escribe una parte del banco de preguntas de la evaluación FINAL del curso: preguntas sobre el capítulo «' + (ch.title || '') + '» del módulo «' + (mo.title || '') + '», para el sector ' + sector + ' en ' + pais + '. '
      + 'Son preguntas INTEGRADORAS de evaluación final: situaciones completas del sector en las que el estudiante aplica lo que enseña este capítulo' + (others.length ? ' en relación con las ideas de los otros capítulos del módulo (resumidos abajo)' : '') + '. Moodle sortea preguntas de este banco para cada estudiante, así que todas deben tener la misma calidad.\n'
      + 'Todas las preguntas llevan "chapterId": "' + ch.id + '" y "moduleId": "' + mo.id + '"; su "evidenceRef" es una marca [S#] SOLO del texto completo de ESTE capítulo (arriba).'
      + (others.length ? '\n\nOTROS CAPÍTULOS DEL MÓDULO (solo contexto; no copies evidencia de aquí):\n' + others.map(function (c) { return _dynExamBankSummaryLines(c, pick(c)); }).join('\n') : '')
      + (ped || '')
      + _dynExamBankRules(true)
      + _dynExamBankSchemaText(true),
    tail: _dynExamBankQuantitiesTail(leaves, idPrefix),
  };
}
function dynFinalExamBankChapterPrompt(courseContext, outline, module, chapter, leaves, chapterMd, summaries, ped) {
  return dynExamBankPromptText(dynFinalExamBankChapterPromptParts(courseContext, outline, module, chapter, leaves, chapterMd, summaries, ped));
}

// ── Reparación dirigida (una vez por llamada) ──
// rejected = [{ id, type?, chapterId?, moduleId?, reasons: [{ code, message }] }]
// (también acepta errors[] o code/message sueltos). Pide SOLO reemplazos con el
// mismo id y la misma hoja (type + chapterId/moduleId).
// Errores a nivel de banco (TF_BALANCE, LENGTH_BIAS…): F2 los asigna a ids
// concretos y pone el objetivo en `message` (p.ej. «debe ser answer: false»).
// accepted (opcional) = preguntas ya aceptadas de la misma llamada (objetos con
// `stem` o strings): se listan sus enunciados para que el reemplazo no las repita.
// BANKOPT: base = partes del pedido original ({ source, task, tail }); la reparación conserva
// source + task (mismo prefijo → lectura de caché) y cambia solo el tail.
// Exam-bank D3: `memory` (opcional) = bloque de memoria / estrategia alternativa por hoja que arma el ejecutor
// (fragmentos y términos ya usados o rechazados; con DYN_EXAM_BANK_STRATEGY_MARKER, el cambio de enfoque).
var DYN_EXAM_BANK_STRATEGY_MARKER = 'ESTRATEGIA ALTERNATIVA';
function dynExamBankRepairParts(baseParts, rejected, accepted, memory) {
  var final = /EXAM_BANK_FINAL_/.test(String((baseParts && baseParts.task) || ''));
  var list = (rejected || []).slice(0, 60).map(function (r) {
    var reasons = r.reasons || r.errors || (r.code ? [{ code: r.code, message: r.message }] : []);
    var leaf = [r.type ? 'type "' + r.type + '"' : '', r.chapterId ? 'chapterId "' + r.chapterId + '"' : '', r.moduleId ? 'moduleId "' + r.moduleId + '"' : ''].filter(Boolean).join(', ');
    var why = reasons.map(function (e) {
      if (typeof e === 'string') return e;
      return (e.code || '') + (e.message ? ': ' + String(e.message).slice(0, 200) : '');
    }).join('; ');
    return '- id "' + r.id + '"' + (leaf ? ' (' + leaf + ')' : '') + ' → ' + why;
  }).join('\n');
  var acc = (accepted || []).slice(0, 60).map(function (q) { return '- ' + _dynExamBankClip(typeof q === 'string' ? q : (q && q.stem), 140); }).filter(function (x) { return x !== '- '; });
  return dynExamBankWithTail(baseParts, '\n\nEXAM_BANK_REPAIR v2\n'
    + 'Estas preguntas del banco hay que escribirlas (RECHAZADAS por el validador automático, o ADICIONALES para completar la hoja):\n' + list
    + (acc.length ? '\n\nEnunciados YA ACEPTADOS (no los repitas ni los reformules):\n' + acc.join('\n') : '')
    + (memory ? '\n\n' + String(memory) : '')
    + '\n\nEscribe UNA pregunta de reemplazo por cada id rechazado: el MISMO "id", el MISMO "type" y el MISMO "chapterId"' + (final ? ' y "moduleId"' : '') + ' (la misma hoja), corrigiendo el motivo indicado y cumpliendo TODAS las reglas de arriba. '
    + 'No repitas preguntas aceptadas ni devuelvas las que no están en la lista.'
    + '\n\nDevuelve SOLO el JSON { "questions": [...] } con los reemplazos, nada más.');
}
// ── Revisión de FORMA (2026-10-15, examen final #1353) ──
// La mayoría de las candidatas rechazadas del examen final tenían el contenido bien (situación, respuesta,
// evidencia) y fallaban SOLO por forma: opciones demasiado largas, distractores fuera de rango de longitud,
// "explanation"/"evidenceRef" omitidos. Reescribirlas desde cero (reparación) repetía el mismo patrón; la
// revisión pide corregir SOLO los campos indicados de la pregunta ya escrita y devolverlos como parche.
// items = [{ id, type, chapterId, moduleId?, question (objeto rechazado), fixes: [texto] }]. Mismo prefijo
// (source + task) que las partes del capítulo → lectura de caché. El parche se re-valida con el MISMO validador.
function dynExamBankRevisionParts(baseParts, items) {
  var list = (items || []).slice(0, typeof DYN_EXAM_BANK_REVISION_MAX_ITEMS === "number" ? DYN_EXAM_BANK_REVISION_MAX_ITEMS : 40).map(function (it) {
    return '- id "' + it.id + '" (type "' + it.type + '", chapterId "' + it.chapterId + '"' + (it.moduleId ? ', moduleId "' + it.moduleId + '"' : '') + ')\n'
      + '  PREGUNTA: ' + JSON.stringify(it.question || {}) + '\n'
      + '  CORREGIR: ' + (it.fixes || []).join(' | ');
  }).join('\n');
  return dynExamBankWithTail(baseParts, '\n\nEXAM_BANK_REVISION v1\n'
    + 'Estas preguntas ya escritas fueron RECHAZADAS por el validador automático SOLO por FORMA (longitudes o campos que faltan). Su situación, su respuesta correcta y su evidencia se conservan: NO las reescribas desde cero ni cambies de qué tratan. '
    + 'Corrige EXCLUSIVAMENTE lo indicado en CORREGIR, conservando el sentido, la respuesta correcta y el nivel, y cumpliendo TODAS las reglas de arriba. Al acortar un texto, condensa la idea (no la cortes a la mitad).\n'
    + list
    + '\n\nDevuelve SOLO el JSON { "revisions": [ { "id": "<id>", …solo los campos corregidos… } ] }, una entrada por id, nada más. '
    + 'Campos que puedes devolver: "stem", "explanation", "evidenceRef", "whyWrong", "correct" ({ "text", "why" }), "distractors" (los 5, en el MISMO orden, cada uno { "text", "why" }), "pairs" (todos, en el mismo orden, cada uno { "term", "definition" }). '
    + 'Un campo que no devuelves queda como estaba. JSON MINIFICADO en una sola línea.');
}
function dynExamBankRepairPrompt(baseParts, rejected, accepted) {
  return dynExamBankPromptText(dynExamBankRepairParts(baseParts, rejected, accepted));
}

// EV6 P2 (F2): system prompt de las llamadas del banco (generación y reparación).
// Sin nombre de modelo; el modelo es DYN_GENERATION_MODEL (45-dynamic-generation-executor.js, Loop 6).
function dynExamBankSys() {
  return 'Eres experto en evaluación educativa de CampusCloud. Escribes bancos de preguntas de evaluación para Moodle a partir del texto de un curso: '
    + 'solo preguntas sobre lo que el texto enseña, con la evidencia copiada textualmente. Respondes SOLO con JSON válido, sin markdown ni texto extra. '
    + 'Todo texto es plano, en español latinoamericano con tuteo, específico del sector y país del curso.';
}

// ════ Motor pedagógico Fase 2 — el diseño del item llega al prompt de SU generador ════
// El backend arma el brief al entregar el claim (src/modules/pedagogy/generator-directives.ts):
// `item.pedagogy.text` es el bloque listo («── DISEÑO PEDAGÓGICO DE ESTE RECURSO ──» + las
// indicaciones que le tocan a ESTE generador). Cada builder lo inserta en un lugar fijo, ANTES del
// formato de salida y de las reglas del schema (que siguen mandando y siguen siendo lo último).
// Sin `item.pedagogy` → '' → el prompt es byte a byte el de siempre (cursos sin perfil).
// Un brief presente pero roto falla fuerte (CLAUDE.md: nunca degradar en silencio).
// Sin bloque a propósito: las reparaciones de FORMATO sobre un texto ya generado con el diseño (reintento solo del
// sidecar context_summary y dynGiftBalancePrompt, que iguala la longitud de las opciones sin cambiar su sentido).
var DYN_PEDAGOGY_MARKER = 'DISEÑO PEDAGÓGICO DE ESTE RECURSO';
var DYN_PEDAGOGY_TEXT_MAX = 4000;
// Tipo de item → generadores del brief que acepta (activity: H5P, escenario ramificado o salas SCORM).
var DYN_PEDAGOGY_GENERATORS = {
  course_plan: ['course_plan'], course_intro: ['course_intro'], module_intro: ['module_intro'], content: ['content'],
  experience: ['experience'], video_interactions: ['video_interactions'],
  activity: ['activity', 'branching_scenario', 'scorm_activity'], exam: ['exam'], final_exam: ['final_exam'],
  application_activity: ['application_activity'],
  guided_practice: ['guided_practice']
};
function dynPedagogyBlock(item) {
  var p = item && item.pedagogy;
  if (p === undefined || p === null) return '';
  var allowed = DYN_PEDAGOGY_GENERATORS[item.type];
  if (typeof p !== 'object' || typeof p.text !== 'string' || p.text.indexOf(DYN_PEDAGOGY_MARKER) < 0
    || p.text.length > DYN_PEDAGOGY_TEXT_MAX || !allowed || allowed.indexOf(p.generator) < 0) {
    throw new Error('PEDAGOGY_BRIEF_INVALID: el diseño pedagógico del item ' + (item && item.itemKey) + ' llegó con una forma inválida (generador ' + JSON.stringify(p && p.generator) + ')');
  }
  return p.text;
}
// Bloque sin los saltos iniciales, para insertarlo después de un texto que ya termina en "\n\n".
function _dynPedagogyInline(ped) { return ped ? String(ped).replace(/^\n+/, '') + '\n\n' : ''; }
// Bloque como línea propia (prompts GIFT: antes de la referencia de sintaxis).
function _dynPedagogyLine(ped) { return ped ? String(ped).replace(/^\n+/, '') + '\n' : ''; }
// Huella del brief usado (va al summary del item: auditoría de qué diseño recibió el prompt).
function dynPedagogySummary(item) {
  var p = item && item.pedagogy;
  return p && typeof p.textSha256 === 'string' ? { pedagogySha256: p.textSha256, pedagogyGenerator: p.generator, pedagogyDirectivesVersion: p.version } : {};
}

// ════ Fase 2 · Actividades de Aplicación (actividad del estudiante + solucionario docente) ════
// Contrato: course-shell/application-activity.ts (backend). Las cantidades salen del nivel de minutos del Manifest
// (DYN_APPLICATION_EXERCISES_BY_MINUTES, espejo de EXERCISES_BY_MINUTES); el GÉNERO lo elige la IA según la
// disciplina para que una actividad de Matemáticas no tenga la misma forma que una de Ética o de SST.
var DYN_APPLICATION_GENRES = ['calculation', 'case_analysis', 'procedure', 'production', 'design_build', 'decision', 'inquiry'];
var DYN_APPLICATION_GENRES_REQUIRING_EXAMPLE = ['calculation', 'procedure', 'design_build'];
var DYN_APPLICATION_DIFFICULTIES = ['basico', 'intermedio', 'avanzado'];
var DYN_APPLICATION_EXERCISES_BY_MINUTES = {
  30: { min: 6, max: 7, examplesMax: 1 },
  // r79.2: 60/90/120 exigen trabajo PROPORCIONAL a sus minutos (ejemplo, más consignas, hitos del taller): STANDARD_SPEC_V2.
  60: { min: 8, max: 10, examplesMax: 2 },
  90: { min: 11, max: 13, examplesMax: 2 },
  120: { min: 14, max: 16, examplesMax: 2 }
};
var DYN_APPLICATION_STANDARD_SPEC = {
  1: {
    30: { exercises: [6, 7], examples: [0, 1], workshopInstructions: [2, 8], workshopMilestones: [0, 0], selfCheck: [4, 8], criteria: [3, 4], floors: {} },
    60: { exercises: [6, 8], examples: [0, 2], workshopInstructions: [2, 8], workshopMilestones: [0, 0], selfCheck: [4, 8], criteria: [3, 4], floors: {} },
    90: { exercises: [8, 10], examples: [0, 2], workshopInstructions: [2, 8], workshopMilestones: [0, 0], selfCheck: [4, 8], criteria: [3, 4], floors: {} },
    120: { exercises: [9, 10], examples: [0, 2], workshopInstructions: [2, 8], workshopMilestones: [0, 0], selfCheck: [4, 8], criteria: [3, 4], floors: {} }
  },
  2: {
    30: { exercises: [6, 7], examples: [0, 1], workshopInstructions: [2, 8], workshopMilestones: [0, 0], selfCheck: [4, 8], criteria: [3, 4], floors: {} },
    60: { exercises: [8, 10], examples: [1, 2], workshopInstructions: [3, 8], workshopMilestones: [2, 2], selfCheck: [5, 8], criteria: [4, 4], floors: { workshop: 20, exercises: 25 } },
    90: { exercises: [11, 13], examples: [1, 2], workshopInstructions: [5, 8], workshopMilestones: [3, 3], selfCheck: [6, 8], criteria: [4, 4], floors: { workshop: 30, exercises: 35 } },
    120: { exercises: [14, 16], examples: [1, 2], workshopInstructions: [5, 8], workshopMilestones: [4, 4], selfCheck: [6, 8], criteria: [4, 4], floors: { workshop: 40, exercises: 45 } }
  }
};
var DYN_APPLICATION_MINUTES_TOLERANCE = 0.2;
var DYN_APPLICATION_GENRE_TEXT = {
  calculation: 'calculation — problemas con datos, procedimiento y resultado verificable (matemáticas, estadística, finanzas, dosificación)',
  case_analysis: 'case_analysis — casos con dilemas o situaciones para analizar y decidir con argumentos (ética, derecho, farmacia, servicio)',
  procedure: 'procedure — ejecutar o revisar un procedimiento paso a paso con verificación y seguridad (SST, enfermería, laboratorio, mantenimiento)',
  production: 'production — producir un texto, pieza o mensaje que cumpla criterios (comunicación, idiomas, marketing)',
  design_build: 'design_build — diseñar, construir o depurar algo y probarlo (informática, ingeniería, diseño)',
  decision: 'decision — elegir entre alternativas con criterios explícitos y justificar (gestión, logística, planeación)',
  inquiry: 'inquiry — formular preguntas, buscar evidencia en el material y concluir (ciencias, ciencias sociales, investigación)'
};

function dynApplicationSys(courseContext) {
  var tono = (courseContext && courseContext.tono) || '';
  return 'Eres diseñador instruccional experto de CampusCloud. Diseñas ACTIVIDADES DE APLICACIÓN: trabajo práctico que el estudiante hace por su cuenta (en Moodle o impreso en papel) para usar lo aprendido. Respondes SOLO con JSON válido (sin markdown, sin texto extra). Todo texto es plano (sin HTML ni markdown), específico del sector y país del curso, en español, tuteando al estudiante. Tono: ' + tono + '.';
}

// LOOP 7 (A1 I4): marcador del bloque de alineación del contexto académico (backend alignment-brief.ts).
var DYN_ALIGNMENT_BLOCK_MARKER = 'RESULTADOS DE APRENDIZAJE QUE ESTE RECURSO DEBE EVIDENCIAR';

function _dynApplicationLearnerBlock(app, pedagogy) {
  var ctx = app && app.context;
  if (!ctx || typeof ctx !== 'object') return '';
  var l = ctx.learner || {};
  var o = ctx.learningOutcomes || {};
  // LOOP 7 (A1 I4): con contexto académico, el brief ya trae los resultados CONGELADOS que este recurso debe evidenciar;
  // repetir aquí los del perfil (copiados antes, quizá desactualizados) le daba al modelo dos listas que podían
  // contradecirse. Se conserva el perfil del estudiante.
  var outcomesFromAlignment = String(pedagogy || '').indexOf(DYN_ALIGNMENT_BLOCK_MARKER) >= 0;
  var lines = [];
  if (l.description) lines.push('Estudiante: ' + l.description);
  var lv = [l.educationLevel && ('nivel ' + l.educationLevel), l.priorKnowledge && ('conocimiento previo ' + l.priorKnowledge), l.experience && ('experiencia ' + l.experience), l.ageGroup && ('edad ' + l.ageGroup)].filter(Boolean);
  if (lv.length) lines.push('Perfil: ' + lv.join(', ') + ' (este perfil prevalece sobre el «Nivel de conocimiento» general del curso)');
  if (!outcomesFromAlignment) ['know', 'do', 'competencies'].forEach(function (k) {
    var xs = Array.isArray(o[k]) ? o[k] : [];
    if (xs.length) lines.push((k === 'know' ? 'Resultados (saber)' : k === 'do' ? 'Resultados (saber hacer)' : 'Competencias') + ': ' + xs.join('; '));
  });
  if (!lines.length) return '';
  return outcomesFromAlignment
    ? '\n\nESTUDIANTE (los resultados que debe evidenciar esta actividad van en el bloque de resultados de abajo):\n- ' + lines.join('\n- ')
    : '\n\nESTUDIANTE Y RESULTADOS DE APRENDIZAJE DEL CURSO (la actividad debe trabajarlos; elige los que este capítulo aporta):\n- ' + lines.join('\n- ');
}

// r80: estudiantes niños o adolescentes (learner.ageGroup del perfil congelado). La actividad conserva sus minutos y sus
// cantidades (el validador no cambia); cambia la forma: tramos cortos, consignas breves, situaciones de su vida y
// entregables propios de la edad. Sin ageGroup de niños / adolescentes → '' (el prompt de siempre, byte a byte).
function _dynApplicationAgeBlock(app) {
  var l = app && app.context && app.context.learner;
  var g = l && l.ageGroup;
  if (g !== 'children' && g !== 'teens') return '';
  var kids = g === 'children';
  return '\n\nESTUDIANTES ' + (kids ? 'NIÑOS (educación básica, unos 6–12 años)' : 'ADOLESCENTES (unos 13–17 años)') + ': la actividad conserva sus minutos y las cantidades de abajo, pero:'
    + '\n- organízala en tramos de máximo ' + (kids ? '20' : '30') + ' minutos (cada ejemplo, bloque de ejercicios o hito del taller es un tramo que se puede hacer en una sesión y termina con algo hecho);'
    + '\n- consignas breves y concretas: una acción por consigna, frases cortas' + (kids ? ' y, en los ejercicios básicos, un ejemplo de respuesta' : '') + ';'
    + '\n- situaciones de su vida (' + (kids ? 'casa, colegio, amigos, juegos' : 'colegio, amigos, aficiones, su barrio') + '), nunca del trabajo ni de empresas;'
    + '\n- entregables propios de su edad (p. ej. diálogo escrito, audio corto, póster o tarjeta, tabla' + (kids ? ' con dibujos' : '') + '), no informes formales de oficina (si el curso trabaja una herramienta, el producto se hace con ella a su nivel);'
    + '\n- criterios de evaluación y autoevaluación en palabras que el estudiante entienda.';
}

// r58 (I4-3): archivos de trabajo ADJUNTOS al capítulo (claim application.practiceFiles, del perfil de evaluación). La
// actividad los nombra tal cual (título y archivo) y nunca inventa otros. Sin archivos → '' (el prompt de siempre).
function _dynApplicationPracticeFilesBlock(app) {
  var fs = app && Array.isArray(app.practiceFiles) ? app.practiceFiles.filter(function (f) { return f && typeof f.filename === 'string' && f.filename; }) : [];
  if (!fs.length) return '';
  return '\n\nARCHIVOS DE TRABAJO ADJUNTOS (el estudiante los descarga junto a la actividad):\n- ' + fs.map(function (f) {
    return '«' + String(f.title || f.filename) + '» (archivo ' + f.filename + ')' + (f.relation === 'chapter' ? ' — material del capítulo' : ' — de esta actividad') + (f.instructions ? ': ' + String(f.instructions) : '');
  }).join('\n- ') +
    '\nCuando una consigna use un archivo, nómbralo EXACTAMENTE como arriba (título y nombre del archivo). No menciones otros archivos, plantillas ni hojas de cálculo «adjuntas» que no estén en esta lista.';
}

// 1.ª pasada: la actividad del ESTUDIANTE (sin respuestas).
function dynApplicationActivityPrompt(courseContext, outline, chapter, sourceMd, app, pedagogy) {
  var ch = chapter || {};
  var minutes = app.minutes;
  var b = DYN_APPLICATION_EXERCISES_BY_MINUTES[minutes];
  var sp = DYN_APPLICATION_STANDARD_SPEC[2][minutes];
  var practice = app.chapterKind === 'practice';
  return _dynCtxV3(courseContext, outline)
    + '\n\nCAPÍTULO: "' + (ch.title || '') + '"' + (ch.objective ? '\nObjetivo del capítulo: ' + ch.objective : '')
    + (practice
      ? '\nEs un CAPÍTULO DE PRÁCTICA: integra lo de los capítulos de contenido del módulo (abajo), sin teoría nueva.'
      : '')
    + '\nTexto del capítulo en el Libro Guía (ÚNICA fuente de los conceptos; los datos de ejercicios y casos son HIPOTÉTICOS e ilustrativos):\n<<<FUENTE\n' + String(sourceMd || '') + '\nFUENTE>>>'
    + '\n' + _dynInternalVocabularyBan()
    + _dynApplicationLearnerBlock(app, pedagogy)
    + (pedagogy || '')
    + _dynApplicationPracticeFilesBlock(app)
    + _dynApplicationAgeBlock(app)
    + '\n\nDiseña la ACTIVIDAD DE APLICACIÓN de este capítulo para ' + minutes + ' minutos de trabajo del estudiante.'
    + '\n1) Elige el GÉNERO que mejor encaja con la disciplina y el tema (no uses siempre el mismo):\n- ' + DYN_APPLICATION_GENRES.map(function (g) { return DYN_APPLICATION_GENRE_TEXT[g]; }).join('\n- ')
    + '\n2) Responde con JSON EXACTAMENTE con esta forma (sin campos extra):\n'
    + '{\n'
    + '  "genre": "<uno de: ' + DYN_APPLICATION_GENRES.join(', ') + '>",\n'
    + '  "title": "título breve de la actividad (≤ 120 caracteres)",\n'
    + '  "objective": "qué debe lograr el estudiante: verbo observable + condición",\n'
    + '  "context": "situación realista relacionada con el tema (3–6 frases, del sector y país del curso)",\n'
    + '  "examples": [ { "title": "…", "problem": "planteamiento", "steps": ["paso 1", "paso 2", "…"], "result": "resultado o conclusión" } ],\n'
    + '  "exercises": [ { "id": "E1", "prompt": "enunciado autocontenido", "difficulty": "basico|intermedio|avanzado", "answerLines": <renglones para responder en papel, 1–15> } ],\n'
    + '  "workshop": { "title": "…", "situation": "situación contextualizada más rica que los ejercicios", "instructions": ["consigna 1", "consigna 2", "…"]' + (sp.workshopMilestones[1] > 0 ? ', "milestones": [ { "title": "hito 1", "product": "producto intermedio" } ]' : '') + ' },\n'
    + '  "deliverable": { "description": "qué produce o entrega el estudiante", "format": "p. ej. informe de 1 página, tabla, cálculo, video corto, código", "extent": "extensión o alcance" },\n'
    + '  "selfCheck": ["pregunta de autoevaluación verificable", "…"],\n'
    + '  "criteria": [ { "name": "criterio", "description": "qué se evalúa", "weight": <entero> } ],\n'
    + '  "minutesBySection": { "examples": <min>, "exercises": <min>, "workshop": <min>, "selfCheck": <min> }\n'
    + '}\n'
    + '\nREGLAS (un validador las verifica):'
    + (sp.examples[0] > 0
      ? '\n- "examples": de ' + sp.examples[0] + ' a ' + b.examplesMax + ' ejemplos RESUELTOS (2–10 pasos cada uno): este nivel exige al menos ' + sp.examples[0] + '.'
      : '\n- "examples": de 0 a ' + b.examplesMax + ' ejemplos RESUELTOS (2–10 pasos cada uno); en ' + DYN_APPLICATION_GENRES_REQUIRING_EXAMPLE.join(', ') + ' al menos 1. Úsalos cuando ayuden a ver el procedimiento.')
    + '\n- "exercises": entre ' + b.min + ' y ' + b.max + ' ejercicios con id "E1", "E2"… en orden, de MENOR a MAYOR dificultad (basico → intermedio → avanzado; al menos uno intermedio o avanzado). Cada uno se puede responder sin ver los otros. NUNCA incluyas la respuesta en el enunciado.'
    + '\n- "workshop": la aplicación integradora (' + sp.workshopInstructions[0] + '–' + sp.workshopInstructions[1] + ' consignas) donde el estudiante usa lo aprendido en una situación concreta.'
    + (sp.workshopMilestones[1] > 0
      ? '\n- "workshop.milestones": EXACTAMENTE entre ' + sp.workshopMilestones[0] + ' y ' + sp.workshopMilestones[1] + ' HITOS del taller, cada uno { "title": "…", "product": "producto intermedio concreto que entrega en ese hito" } (son los ' + minutes + ' minutos de trabajo real: más etapas y entregables, no solo más tiempo).'
      : '')
    + '\n- "selfCheck": ' + sp.selfCheck[0] + '–' + sp.selfCheck[1] + ' ítems que el estudiante puede marcar para revisar su propio trabajo.'
    + (sp.criteria[0] === sp.criteria[1]
      ? '\n- "criteria": EXACTAMENTE ' + sp.criteria[0] + ' criterios distintos con pesos enteros (5–70) que suman EXACTAMENTE 100.'
      : '\n- "criteria": ' + sp.criteria[0] + ' o ' + sp.criteria[1] + ' criterios distintos con pesos enteros (5–70) que suman EXACTAMENTE 100.')
    + '\n- "minutesBySection": enteros que suman ' + minutes + ' minutos (±' + Math.round(DYN_APPLICATION_MINUTES_TOLERANCE * 100) + ' %)' + (Object.keys(sp.floors).length ? '; como mínimo ' + Object.keys(sp.floors).map(function (k) { return k + ' ≥ ' + sp.floors[k]; }).join(', ') + ' min' : '') + '.'
    + '\n- Datos hipotéticos claramente ilustrativos: sin nombres de personas reales, empresas reales ni estadísticas inventadas presentadas como reales.'
    + '\n- Sin mencionar videos, presentaciones, audiolibros ni otras actividades del curso.'
    + '\n- Esta parte la ve el ESTUDIANTE: nunca escribas «Respuesta:», «Solución esperada», «Guía de corrección» ni «Solucionario» (el espacio para responder son los renglones de answerLines).';
}

// 2.ª pasada: el SOLUCIONARIO docente de ESA actividad (nunca lo ve el estudiante).
function dynApplicationSolutionPrompt(courseContext, chapter, activity, sourceMd) {
  var ch = chapter || {};
  var ids = (activity.exercises || []).map(function (e) { return e.id; });
  var names = (activity.criteria || []).map(function (c) { return c.name; });
  return _dynCtxV3(courseContext, null)
    + '\n\nCAPÍTULO: "' + (ch.title || '') + '"'
    + '\nTexto del capítulo en el Libro Guía (para que las respuestas sean correctas y consistentes con lo enseñado):\n<<<FUENTE\n' + String(sourceMd || '') + '\nFUENTE>>>'
    + '\n\nACTIVIDAD DEL ESTUDIANTE (ya aprobada; NO la cambies):\n' + JSON.stringify(activity)
    + '\n\nEscribe el SOLUCIONARIO DOCENTE de esa actividad como JSON EXACTAMENTE con esta forma:\n'
    + '{\n'
    + '  "answers": [ { "exerciseId": "E1", "answer": "respuesta esperada (con el resultado o los elementos clave)", "explanation": "por qué es así / procedimiento" } ],\n'
    + '  "workshopSolution": "solución esperada del taller: qué debería contener un buen trabajo, paso a paso",\n'
    + '  "correctionGuide": [ { "criterion": "<nombre exacto del criterio>", "achieved": "logrado: …", "developing": "en proceso: …", "insufficient": "insuficiente: …" } ],\n'
    + '  "teacherNotes": ["observación para el docente: errores frecuentes, variantes aceptables, cómo dar retroalimentación"]\n'
    + '}\n'
    + '\nREGLAS (un validador las verifica):'
    + '\n- "answers": EXACTAMENTE una por ejercicio, en este orden de ids: ' + ids.join(', ') + '.'
    + '\n- "correctionGuide": EXACTAMENTE uno por criterio, en este orden y con estos nombres: ' + names.map(function (n) { return '«' + n + '»'; }).join(', ') + '.'
    + '\n- "teacherNotes": 1–6 observaciones concretas.'
    + '\n- Respuestas correctas según el capítulo; si un cálculo usa datos hipotéticos del enunciado, muestra el resultado.'
    + '\n- Cuando remitas al material, di «el Libro Guía» o «el capítulo» (nunca «texto fuente», «la fuente» ni nombres técnicos del JSON).'
    + '\n' + _dynInternalVocabularyBan();
}

// ════ r79.1 · Tipos de Actividad de Aplicación: estudio de caso, proyecto integrador, retroalimentación formativa ════
// Contrato: course-shell/application-kinds.ts (backend). El claim trae el tipo, su especificación (esquema + cantidades y
// pisos del nivel: `application.kindSpec`) y los resultados del capítulo (`application.outcomes`). Las cantidades del
// prompt salen de esos datos (las mismas que valida el servidor). Sin respuestas en la parte del estudiante.
function _dynKindRange(c, k) { var r = (c && c[k]) || [0, 0]; return r[0] === r[1] ? String(r[0]) : r[0] + ' a ' + r[1]; }
function _dynKindOutcomesBlock(app) {
  var os = (app && Array.isArray(app.outcomes)) ? app.outcomes : [];
  if (!os.length) return '';
  return '\n\nRESULTADOS DE APRENDIZAJE QUE TRABAJA ESTE CAPÍTULO (cita sus ids EXACTOS en "outcomeLinks"; cada uno con la parte del producto que lo evidencia):\n- ' +
    os.map(function (o) { return o.id + ': ' + o.text; }).join('\n- ');
}
function _dynKindFloorsText(spec, minutes) {
  var f = (spec && spec.floors) || {};
  var ks = Object.keys(f);
  return '"minutesBySection": enteros que suman ' + minutes + ' minutos (±' + Math.round(((spec && spec.tolerance) || 0.2) * 100) + ' %)' + (ks.length ? '; como mínimo ' + ks.map(function (k) { return k + ' ≥ ' + f[k]; }).join(', ') + ' min' : '') + '.';
}
var DYN_KIND_COMMON_RULES = function (c) {
  return '\n- "outcomeLinks": ' + _dynKindRange(c, 'outcomeLinks') + ' vínculos { "outcomeId": "<id de la lista de resultados>", "evidence": "qué parte del producto lo evidencia" }, sin repetir ids.'
    + '\n- "selfCheck": ' + _dynKindRange(c, 'selfCheck') + ' ítems verificables para revisar el propio trabajo.'
    + '\n- "criteria": ' + _dynKindRange(c, 'criteria') + ' criterios distintos { "name", "description", "weight" } con pesos enteros (5–70) que suman EXACTAMENTE 100.'
    + '\n- Datos hipotéticos claramente ilustrativos: personas y organizaciones ficticias, sin estadísticas inventadas presentadas como reales.'
    + '\n- Sin mencionar videos, presentaciones, audiolibros ni otras actividades del curso (salvo lo que se pide revisar).'
    + '\n- Esta parte la ve el ESTUDIANTE: nunca escribas «Respuesta:», «Solución esperada», «Guía de corrección» ni «Solucionario».';
};

function dynApplicationKindActivityPrompt(courseContext, outline, chapter, sourceMd, app, pedagogy) {
  var ch = chapter || {};
  var minutes = app.minutes;
  var spec = app.kindSpec || {};
  var c = spec.counts || {};
  var kind = app.kind;
  var head = _dynCtxV3(courseContext, outline)
    + '\n\nCAPÍTULO: "' + (ch.title || '') + '"' + (ch.objective ? '\nObjetivo del capítulo: ' + ch.objective : '')
    + (app.chapterKind === 'practice' ? '\nEs un CAPÍTULO DE PRÁCTICA: integra lo de los capítulos de contenido del módulo (abajo), sin teoría nueva.' : '')
    + '\nTexto del capítulo en el Libro Guía (ÚNICA fuente de los conceptos; los datos son HIPOTÉTICOS e ilustrativos):\n<<<FUENTE\n' + String(sourceMd || '') + '\nFUENTE>>>'
    + '\n' + _dynInternalVocabularyBan()
    + _dynApplicationLearnerBlock(app, pedagogy)
    + (pedagogy || '')
    + _dynKindOutcomesBlock(app)
    + _dynApplicationPracticeFilesBlock(app);
  var common = '  "title": "título breve (≤ 120 caracteres)",\n  "objective": "qué debe lograr el estudiante: verbo observable + condición",\n  "outcomeLinks": [ { "outcomeId": "<id>", "evidence": "…" } ],\n';
  var tail = '  "deliverable": { "description": "qué entrega el estudiante", "format": "…", "extent": "extensión o alcance" },\n  "selfCheck": ["…"],\n  "criteria": [ { "name": "…", "description": "…", "weight": <entero> } ],\n';
  if (kind === 'case_study') {
    return head
      + '\n\nDiseña un ESTUDIO DE CASO de ' + minutes + ' minutos de trabajo del estudiante: un caso realista del sector y país del curso, con datos (anexos), preguntas de análisis que suben de nivel y una DECISIÓN que el estudiante toma y justifica con los conceptos del capítulo.'
      + '\nResponde con JSON EXACTAMENTE con esta forma (sin campos extra):\n{\n' + common
      + '  "case": { "title": "…", "organization": "organización ficticia", "narrative": "relato del caso en párrafos separados por \\n\\n: contexto, actores, problema y datos clave", "exhibits": [ { "title": "…", "kind": "table|data|document|testimony", "content": "datos del anexo (una línea por dato, separadas por \\n)" } ] },\n'
      + '  "questions": [ { "id": "Q1", "prompt": "pregunta de análisis autocontenida", "level": "comprender|analizar|evaluar|proponer", "answerLines": <2–15> } ],\n'
      + '  "decision": { "prompt": "la decisión o recomendación que debe tomar y justificar", "constraints": ["condición que debe respetar"] },\n'
      + tail + '  "minutesBySection": { "reading": <min>, "analysis": <min>, "decision": <min>, "selfCheck": <min> }\n}\n'
      + '\nREGLAS (un validador las verifica):'
      + '\n- "case.narrative": entre ' + _dynKindRange(c, 'narrative') + ' caracteres; "case.exhibits": ' + _dynKindRange(c, 'exhibits') + ' anexos con datos concretos y coherentes entre sí.'
      + '\n- "questions": ' + _dynKindRange(c, 'questions') + ' preguntas con id "Q1", "Q2"… en orden, de menor a mayor nivel (comprender → analizar → evaluar → proponer), con AL MENOS una de nivel analizar y una de nivel evaluar. Cada una exige usar los datos del caso; nunca incluyas la respuesta.'
      + '\n- "decision.constraints": ' + _dynKindRange(c, 'constraints') + ' condiciones concretas (presupuesto, plazos, normas, personas) que la decisión debe respetar.'
      + DYN_KIND_COMMON_RULES(c)
      + '\n- ' + _dynKindFloorsText(spec, minutes);
  }
  if (kind === 'integrative_project') {
    var mods = Array.isArray(app.moduleChapters) ? app.moduleChapters : [];
    return head
      + (mods.length ? '\n\nCAPÍTULOS DE CONTENIDO DEL MÓDULO (cada etapa se apoya en uno de ellos; "linkedChapter" = su título EXACTO):\n- ' + mods.join('\n- ') : '')
      + '\n\nDiseña un PROYECTO INTEGRADOR de ' + minutes + ' minutos en etapas: el estudiante construye un producto final del módulo paso a paso, con un entregable intermedio por etapa que se apoya en un capítulo, y al final integra todo.'
      + '\nResponde con JSON EXACTAMENTE con esta forma (sin campos extra):\n{\n' + common
      + '  "brief": { "situation": "encargo realista del sector y país del curso", "finalProduct": "producto final que integra el módulo" },\n'
      + '  "stages": [ { "id": "S1", "title": "…", "purpose": "qué se construye en esta etapa", "linkedChapter": "<título del capítulo>", "tasks": ["tarea concreta"], "intermediateDeliverable": "entregable de la etapa", "minutes": <10–45> } ],\n'
      + '  "integration": { "instructions": ["cómo unir los entregables en el producto final"], "presentation": "cómo se presenta o socializa el producto" },\n'
      + tail + '  "minutesBySection": { "stages": <suma de los minutos de las etapas>, "integration": <min>, "selfCheck": <min> }\n}\n'
      + '\nREGLAS (un validador las verifica):'
      + '\n- "stages": EXACTAMENTE ' + _dynKindRange(c, 'stages') + ' etapas con id "S1", "S2"… en orden; cada una con ' + _dynKindRange(c, 'stageTasks') + ' tareas, un entregable intermedio concreto y sus minutos (10–45); "minutesBySection.stages" = la suma de esos minutos.'
      + '\n- "integration.instructions": ' + _dynKindRange(c, 'integration') + ' instrucciones para integrar los entregables.'
      + '\n- "outcomeLinks": cita al menos 2 resultados distintos de la lista (o el único que haya).'
      + DYN_KIND_COMMON_RULES(c)
      + '\n- ' + _dynKindFloorsText(spec, minutes);
  }
  var targets = Array.isArray(app.reviewTargets) ? app.reviewTargets : [];
  var peer = (c.peerReview || [0, 0])[0] > 0;
  return head
    + (targets.length ? '\n\nPRÁCTICAS EVALUABLES ANTERIORES DEL MÓDULO (lo que el estudiante revisa y mejora):\n- ' + targets.map(function (t) { return t.kindLabel + ' del capítulo «' + t.chapterTitle + '»'; }).join('\n- ') : '')
    + '\n\nDiseña una actividad de RETROALIMENTACIÓN FORMATIVA de ' + minutes + ' minutos: el estudiante revisa el producto que entregó en la práctica evaluable del módulo con criterios claros, un ejemplar comentado y los errores frecuentes, ' + (peer ? 'lo intercambia con un compañero para una revisión entre pares, ' : '') + 'lo MEJORA, lo vuelve a entregar y reflexiona.'
    + '\nResponde con JSON EXACTAMENTE con esta forma (sin campos extra):\n{\n' + common
    + '  "target": { "product": "qué producto anterior revisa", "sourceActivity": "de qué actividad viene" },\n'
    + '  "reviewCriteria": [ { "id": "R1", "name": "…", "lookFor": "cómo se ve un buen trabajo en este criterio", "questions": ["pregunta para revisar"] } ],\n'
    + '  "exemplar": { "strong": "fragmento ejemplar sólido", "weak": "fragmento por mejorar", "commentary": "por qué uno funciona y el otro no" },\n'
    + '  "commonErrors": [ { "error": "…", "howToSpot": "cómo detectarlo", "howToFix": "cómo corregirlo" } ],\n'
    + '  "revision": { "steps": ["paso del plan de mejora"], "resubmission": "qué entrega de nuevo y cómo muestra los cambios" },\n'
    + (peer ? '  "peerReview": { "instructions": ["instrucción para comentar el trabajo del compañero"], "protocol": "cómo se hace el intercambio con respeto" },\n' : '')
    + '  "reflection": ["pregunta de reflexión"],\n'
    + tail + '  "minutesBySection": { "study": <min>, "review": <min>, "revision": <min>, ' + (peer ? '"peerReview": <min>, ' : '') + '"reflection": <min> }\n}\n'
    + '\nREGLAS (un validador las verifica):'
    + '\n- "reviewCriteria": EXACTAMENTE ' + _dynKindRange(c, 'reviewCriteria') + ' criterios con id "R1", "R2"… en orden y nombres distintos; cada uno con ' + _dynKindRange(c, 'reviewQuestions') + ' preguntas.'
    + '\n- "commonErrors": ' + _dynKindRange(c, 'commonErrors') + ' errores frecuentes de ESTE tipo de producto; "revision.steps": ' + _dynKindRange(c, 'revisionSteps') + ' pasos; "reflection": ' + _dynKindRange(c, 'reflection') + ' preguntas.'
    + (peer ? '\n- "peerReview.instructions": ' + _dynKindRange(c, 'peerInstructions') + ' instrucciones.' : '\n- Sin "peerReview" en este nivel.')
    + DYN_KIND_COMMON_RULES(c)
    + '\n- ' + _dynKindFloorsText(spec, minutes);
}

// 2.ª pasada de un tipo nuevo: el SOLUCIONARIO docente de ESA actividad.
function dynApplicationKindSolutionPrompt(courseContext, chapter, activity, sourceMd, app) {
  var ch = chapter || {};
  var spec = app.kindSpec || {};
  var c = spec.counts || {};
  var kind = app.kind;
  var names = (activity.criteria || []).map(function (x) { return '«' + x.name + '»'; }).join(', ');
  var head = _dynCtxV3(courseContext, null)
    + '\n\nCAPÍTULO: "' + (ch.title || '') + '"'
    + '\nTexto del capítulo en el Libro Guía (para que la guía sea correcta y consistente con lo enseñado):\n<<<FUENTE\n' + String(sourceMd || '') + '\nFUENTE>>>'
    + '\n\nACTIVIDAD DEL ESTUDIANTE (ya aprobada; NO la cambies):\n' + JSON.stringify(activity)
    + '\n\nEscribe el SOLUCIONARIO DOCENTE de esa actividad como JSON EXACTAMENTE con esta forma:\n';
  var guide = '  "correctionGuide": [ { "criterion": "<nombre exacto>", "achieved": "logrado: …", "developing": "en proceso: …", "insufficient": "insuficiente: …" } ],\n  "teacherNotes": ["observación para el docente"]\n}\n';
  var rules = '\n- "correctionGuide": EXACTAMENTE uno por criterio, en este orden y con estos nombres: ' + names + '.'
    + '\n- "teacherNotes": 1–6 observaciones concretas (errores frecuentes, variantes aceptables, cómo dar retroalimentación).'
    + '\n- Cuando remitas al material, di «el Libro Guía» o «el capítulo».'
    + '\n' + _dynInternalVocabularyBan();
  if (kind === 'case_study') {
    var qids = (activity.questions || []).map(function (q) { return q.id; }).join(', ');
    return head + '{\n'
      + '  "questionGuides": [ { "questionId": "Q1", "expectedAnalysis": "análisis esperado con los datos del caso", "keyPoints": ["punto clave"] } ],\n'
      + '  "decisionDiscussion": { "recommended": "decisión recomendada", "alternatives": ["alternativa aceptable y cuándo"], "justification": "por qué, con los conceptos del capítulo" },\n'
      + '  "discussionQuestions": ["pregunta para la discusión en clase"],\n' + guide
      + '\nREGLAS (un validador las verifica):'
      + '\n- "questionGuides": EXACTAMENTE una por pregunta, en este orden de ids: ' + qids + '; cada una con ' + _dynKindRange(c, 'keyPoints') + ' puntos clave.'
      + '\n- "decisionDiscussion.alternatives": ' + _dynKindRange(c, 'alternatives') + '; "discussionQuestions": ' + _dynKindRange(c, 'discussion') + '.'
      + rules;
  }
  if (kind === 'integrative_project') {
    var sids = (activity.stages || []).map(function (x) { return x.id; }).join(', ');
    return head + '{\n'
      + '  "stageGuides": [ { "stageId": "S1", "expectedOutput": "qué debería contener un buen entregable de la etapa", "commonErrors": ["error frecuente"], "checkpointQuestions": ["pregunta de control para el docente"] } ],\n'
      + '  "finalProductExemplar": "cómo se ve un buen producto final, por partes (al menos 200 caracteres)",\n' + guide
      + '\nREGLAS (un validador las verifica):'
      + '\n- "stageGuides": EXACTAMENTE una por etapa, en este orden de ids: ' + sids + '; cada una con ' + _dynKindRange(c, 'stageErrors') + ' errores frecuentes y ' + _dynKindRange(c, 'checkpoints') + ' preguntas de control.'
      + rules;
  }
  var rnames = (activity.reviewCriteria || []).map(function (x) { return '«' + x.name + '»'; }).join(', ');
  return head + '{\n'
    + '  "feedbackBank": [ { "criterion": "<nombre exacto del criterio de revisión>", "achieved": "…", "developing": "…", "insufficient": "…", "feedbackComment": "comentario de retroalimentación listo para usar", "nextStep": "siguiente paso concreto para el estudiante" } ],\n'
    + '  "errorGuide": [ { "error": "error frecuente", "diagnosis": "de dónde suele venir y cómo orientarlo" } ],\n' + guide
    + '\nREGLAS (un validador las verifica):'
    + '\n- "feedbackBank": EXACTAMENTE uno por criterio de revisión, en este orden y con estos nombres: ' + rnames + '.'
    + '\n- "errorGuide": ' + _dynKindRange(c, 'errorGuide') + ' entradas.'
    + rules;
}

// ════ Loop 9 B · «Ejercicios guiados» del capítulo (formativos, sin nota, con respuesta modelo; clave guided_practice) ════
// Contrato: course-shell/guided-practice.ts (backend). Cuántos ejercicios y sus minutos los fija Cursia (plan del claim,
// `guidedPractice.exercises`, según el nivel 40/60/80/120 del Manifest); la IA escribe solo el contenido de cada uno.
// NO es una Actividad de Aplicación: sin solucionario oculto, sin pesos ni nota, más corta y dentro del capítulo.
var DYN_GUIDED_PRACTICE_KINDS = ['case_analysis', 'worked_problem', 'decision_analysis'];
var DYN_GUIDED_PRACTICE_KIND_TEXT = {
  case_analysis: 'case_analysis — analizar un caso concreto y decidir o recomendar con argumentos del capítulo',
  worked_problem: 'worked_problem — resolver un problema o procedimiento paso a paso con datos coherentes',
  decision_analysis: 'decision_analysis — comparar alternativas con criterios del capítulo y justificar la elección'
};

function dynGuidedPracticeSys(courseContext) {
  var tono = (courseContext && courseContext.tono) || '';
  return 'Eres diseñador instruccional experto de CampusCloud. Diseñas los EJERCICIOS GUIADOS de un capítulo: ejercicios formativos (sin nota) que el estudiante resuelve justo después de estudiar el capítulo y que luego compara con una respuesta modelo. Respondes SOLO con JSON válido (sin markdown, sin texto extra). Todo texto es plano (sin HTML ni markdown), específico del sector y país del curso, en español latinoamericano, tuteando al estudiante. Tono: ' + tono + '.';
}

// Fix C1: lo que exige cada ejercicio según sus minutos (espejo de DYN_GUIDED_PRACTICE_FLOORS del ejecutor).
var DYN_GUIDED_PRACTICE_PROMPT_FLOORS = {
  20: { situation: 300, tasks: 3, answer: 450 },
  30: { situation: 550, tasks: 4, answer: 950 },
  40: { situation: 800, tasks: 5, answer: 1400 }
};
// Fix I5: lo que no hay que repetir (práctica del módulo y casos de sus Actividades de Aplicación), desde el claim.
function _dynGuidedPracticeAvoidBlock(gp) {
  var a = gp && gp.avoid;
  if (!a || typeof a !== 'object') return '';
  var lines = [];
  (a.practiceChapterTitles || []).forEach(function (t) { if (t) lines.push('- Capítulo de práctica del módulo: «' + t + '»'); });
  (a.applicationCases || []).forEach(function (c) {
    if (!c) return;
    var bits = [];
    if (c.title) bits.push('«' + c.title + '»');
    if (c.workshopTitle) bits.push('taller «' + c.workshopTitle + '»');
    if ((c.names || []).length) bits.push('protagonistas: ' + c.names.join(', '));
    if (bits.length) lines.push('- Actividad de Aplicación del módulo: ' + bits.join('; '));
  });
  var block = lines.length ? '\n\nNO REPITAS estos casos del módulo (ni su título, ni sus personas, empresas o lugares; usa otra situación):\n' + lines.join('\n') : '';
  // Loop 10 C1-b: ejercicios guiados ya escritos para otros capítulos del curso (solo sus títulos; el validador compara
  // también la situación).
  var prev = [];
  (Array.isArray(a.previousExercises) ? a.previousExercises : []).forEach(function (x) { if (x && x.title && prev.indexOf(x.title) < 0) prev.push(x.title); });
  if (prev.length) block += '\n\nNO REPITAS los ejercicios guiados de otros capítulos del curso (ni su título ni su situación; cada capítulo practica con situaciones propias):\n' + prev.slice(0, 40).map(function (t) { return '- «' + t + '»'; }).join('\n');
  return block;
}

function dynGuidedPracticePrompt(courseContext, outline, chapter, sourceMd, gp, pedagogy) {
  var ch = chapter || {};
  var plan = (gp && gp.exercises) || [];
  var n = plan.length;
  var planText = plan.map(function (e, i) { return 'Ejercicio ' + (i + 1) + ': ~' + e.minutes + ' min de trabajo del estudiante'; }).join('; ');
  var floorText = plan.map(function (e, i) {
    var f = DYN_GUIDED_PRACTICE_PROMPT_FLOORS[e.minutes] || DYN_GUIDED_PRACTICE_PROMPT_FLOORS[20];
    return 'Ejercicio ' + (i + 1) + ' (~' + e.minutes + ' min): situación de al menos ' + f.situation + ' caracteres, al menos ' + f.tasks + ' consignas y respuesta modelo de al menos ' + f.answer + ' caracteres' + (e.minutes >= 40 ? '; producto esperado concreto (qué entrega, con qué partes)' : '');
  }).join('\n- ');
  return _dynCtxV3(courseContext, outline)
    + '\n\nCAPÍTULO: "' + (ch.title || '') + '"' + (ch.objective ? '\nObjetivo del capítulo: ' + ch.objective : '')
    + (ch.description ? '\nAlcance del capítulo: ' + String(ch.description).replace(/\s+/g, ' ').trim() : '')
    + '\nTexto del capítulo (ÚNICA fuente de los conceptos; los datos de las situaciones son HIPOTÉTICOS e ilustrativos):\n<<<FUENTE\n' + String(sourceMd || '') + '\nFUENTE>>>'
    + '\n' + _dynInternalVocabularyBan()
    + _dynApplicationLearnerBlock(gp, pedagogy)
    + (pedagogy || '')
    + _dynGuidedPracticeAvoidBlock(gp)
    + '\n\nDiseña los EJERCICIOS GUIADOS de este capítulo: EXACTAMENTE ' + n + ' ejercicios (' + planText + ', ' + gp.minutes + ' min en total).'
    + '\nEs FORMATIVA y SIN NOTA: el estudiante intenta cada ejercicio y después revisa la respuesta modelo. No es una Actividad de Aplicación: nada de solucionario oculto, puntajes, pesos ni calificaciones.'
    + '\nResponde con JSON EXACTAMENTE con esta forma (sin campos extra; los ids y los minutos los pone Cursia):\n'
    + '{\n'
    + '  "exercises": [\n'
    + '    {\n'
    + '      "kind": "<uno de: ' + DYN_GUIDED_PRACTICE_KINDS.join(', ') + '>",\n'
    + '      "title": "título breve (≤ 90 caracteres)",\n'
    + '      "situation": "situación concreta del sector y país del curso, basada en el capítulo (según sus minutos, hasta 1400 caracteres)",\n'
    + '      "tasks": ["consigna 1 en imperativo", "consigna 2", "consigna 3", "consigna 4", "consigna 5"],\n'
    + '      "expectedProduct": "qué produce el estudiante (≤ 300 caracteres)",\n'
    + '      "criteria": [ { "name": "criterio", "descriptor": "cómo se ve un buen trabajo en ese criterio" } ],\n'
    + '      "modelAnswer": "1. …\\n2. …\\n3. …\\n4. …\\n5. … (una línea por consigna, en el mismo orden; según sus minutos, hasta 2200 caracteres)"\n'
    + '    }\n'
    + '  ]\n'
    + '}\n'
    + '\nTipos de ejercicio (elige el que mejor practique cada parte del capítulo; con ' + n + ' ejercicios usa AL MENOS 2 tipos distintos):\n- ' + DYN_GUIDED_PRACTICE_KINDS.map(function (k) { return DYN_GUIDED_PRACTICE_KIND_TEXT[k]; }).join('\n- ')
    + '\n\nREGLAS (un validador las verifica):'
    + '\n- "exercises": EXACTAMENTE ' + n + ', en el orden del plan; cada uno dimensionado para sus minutos (los minutos se acreditan al estudiante: tienen que tener trabajo real detrás):\n- ' + floorText
    + '\n- "situation": como máximo 1400 caracteres; una situación NUEVA y concreta (personas y organizaciones ficticias, sin nombres reales). NO reutilices el caso que trae el capítulo («■ Caso …») ni su empresa, persona o producto, ni el caso de la práctica o de la Actividad de Aplicación del módulo.'
    + '\n- Si usas datos o cifras, deben ser coherentes entre sí y con la respuesta modelo (las cuentas tienen que dar); sin estadísticas ni normas inventadas presentadas como reales.'
    + '\n- "tasks": hasta 6 consignas en imperativo; cada una pide PRODUCIR algo con lo que enseña el capítulo: analizar, decidir, calcular, comparar, justificar, proponer o redactar. Nunca consignas de solo recordar («Define…», «Menciona…», «Enumera…», «¿Qué es…?»).'
    + '\n- "expectedProduct": hasta 300 caracteres; concreto (qué entrega el estudiante y qué contiene).'
    + '\n- "criteria": de 3 a 5 criterios para que el estudiante revise su propio trabajo, solo { "name", "descriptor" } (sin pesos ni puntajes).'
    + '\n- "modelAnswer": como máximo 2200 caracteres; responde TODAS las consignas EN ORDEN, UNA LÍNEA POR CONSIGNA (separadas con \\n), y cada línea EMPIEZA con su número: «1. », «2. », «3. »… Cada línea DESARROLLA la respuesta a su consigna (al menos 60 caracteres, con el razonamiento o el resultado), nunca remite a otra parte («ver la tabla del capítulo»). Es la respuesta que el estudiante ve después de intentarlo.'
    + '\n- Los ' + n + ' ejercicios son DISTINTOS entre sí: otra situación (otras personas, otra organización, otro problema), otro título y otras consignas; nunca el mismo caso con otras palabras.'
    + '\n- Dentro del alcance de ESTE capítulo: sin teoría de otros capítulos.'
    + '\n- No menciones otros recursos del curso (videos, actividades interactivas, Actividad de Aplicación, exámenes o evaluaciones, audiolibro, presentación, Libro Guía): la práctica se lee sola.';
}
