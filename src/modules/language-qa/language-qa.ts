/* eslint-disable */
// ════════════════════════════════════════════════════════════════════════════════════════════
// GENERADO desde el frontend (cursia: src/js/55-language-qa.js) — NO editar a mano: editar el frontend y
// regenerar con scripts/gen-language-qa.py. scripts/check-language-qa.js exige paridad exacta (tablas y salidas).
// ════════════════════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════════════════
// 55 · Language QA — español latinoamericano NEUTRO (piloto, 2026-10-07)
//
// Requisito del producto: todo texto que genera la IA (contenido, explicaciones, actividades,
// instrucciones, preguntas, respuestas, feedback, guiones, material de aplicación, solucionarios,
// audiolibros…) va en español latinoamericano neutro, profesional y académico: con tuteo («puedes»,
// «debes», «realiza»), sin voseo, sin «vosotros» y sin regionalismos de ningún país.
//
// Dos capas, además de la regla del prompt (44, dynLocaleRule):
//   1. lqaFixText / lqaFixDeep: corrección AUTOMÁTICA solo donde es segura — formas verbales del voseo
//      que no tienen otra lectura («podés» → «puedes», «hacé» → «haz», «sos» → «eres») y el pronombre
//      «vos» («para vos» → «para ti», «con vos» → «contigo», «vos» → «tú»). El sujeto sigue siendo la
//      segunda persona del singular, así que la concordancia no cambia. Formas ambiguas («salí», «elegí»,
//      «escribí» también son 1.ª persona del pretérito) NO se tocan.
//   2. lqaSentenceFindings: detección de lo que queda — voseo, «vosotros» y regionalismos léxicos fuertes
//      (Argentina/Uruguay, España, México, Colombia, Chile, Perú, Venezuela). Los regionalismos léxicos
//      no se reemplazan solos (el género y la concordancia cambian: «la heladera» ≠ «la refrigerador»):
//      el ejecutor (45) pide un reintento dirigido y, si persisten, el item falla visible.
// Lista curada, sin palabras con otra lectura neutra («padre», «vale la pena», «tinto», «camión», «piso»,
// «pata», «Tomás», «SOS»…). El backend aplica la MISMA tabla al completar cada item (paridad probada en
// scripts/check-language-qa.js del backend).
// Prefijo de globales: lqa / LQA_ (ver test-59-global-names).
// ═══════════════════════════════════════════════════════════════════════════════════════════

export const LQA_VERSION = 1;

/** Voseo → tuteo: formas sin otra lectura en español (presente, imperativo, subjuntivo y clíticos). */
export const LQA_VOSEO_FIX = {
  // ser / presente de indicativo
  'sos': 'eres', 'tenés': 'tienes', 'podés': 'puedes', 'querés': 'quieres', 'sabés': 'sabes', 'hacés': 'haces', 'decís': 'dices',
  'usás': 'usas', 'pensás': 'piensas', 'aprendés': 'aprendes', 'necesitás': 'necesitas', 'trabajás': 'trabajas', 'creás': 'creas',
  'elegís': 'eliges', 'escribís': 'escribes', 'revisás': 'revisas', 'preparás': 'preparas', 'evaluás': 'evalúas', 'enseñás': 'enseñas',
  'buscás': 'buscas', 'probás': 'pruebas', 'empezás': 'empiezas', 'seguís': 'sigues', 'entendés': 'entiendes', 'conocés': 'conoces',
  'ponés': 'pones', 'venís': 'vienes', 'salís': 'sales', 'vivís': 'vives', 'contás': 'cuentas', 'encontrás': 'encuentras',
  'recordás': 'recuerdas', 'sentís': 'sientes', 'andás': 'andas', 'llegás': 'llegas', 'mirás': 'miras', 'hablás': 'hablas',
  'comés': 'comes', 'leés': 'lees', 'volvés': 'vuelves', 'jugás': 'juegas', 'dormís': 'duermes', 'pedís': 'pides', 'medís': 'mides',
  'servís': 'sirves', 'resolvés': 'resuelves', 'movés': 'mueves', 'mostrás': 'muestras', 'comenzás': 'comienzas', 'cerrás': 'cierras',
  'perdés': 'pierdes', 'preferís': 'prefieres', 'aplicás': 'aplicas', 'identificás': 'identificas', 'analizás': 'analizas',
  'registrás': 'registras', 'completás': 'completas', 'calculás': 'calculas', 'verificás': 'verificas', 'validás': 'validas',
  'diseñás': 'diseñas', 'adaptás': 'adaptas', 'implementás': 'implementas', 'escalás': 'escalas', 'iterás': 'iteras',
  'traducís': 'traduces', 'prevenís': 'previenes', 'corrés': 'corres', 'atendés': 'atiendes', 'respondés': 'respondes',
  'considerás': 'consideras', 'decidís': 'decides', 'debés': 'debes', 'mantenés': 'mantienes', 'obtenés': 'obtienes',
  'reconocés': 'reconoces', 'organizás': 'organizas', 'gestionás': 'gestionas', 'controlás': 'controlas', 'comunicás': 'comunicas',
  'explicás': 'explicas', 'comprendés': 'comprendes', 'manejás': 'manejas', 'ayudás': 'ayudas', 'tomás': null, // «Tomás» es un nombre: nunca
  // imperativo
  'mirá': 'mira', 'fijate': 'fíjate', 'hacé': 'haz', 'decí': 'di', 'poné': 'pon', 'tené': 'ten', 'vení': 'ven', 'andá': 've',
  'pensá': 'piensa', 'contá': 'cuenta', 'probá': 'prueba', 'usá': 'usa', 'revisá': 'revisa', 'leé': 'lee', 'buscá': 'busca',
  'tomá': 'toma', 'prestá': 'presta', 'recordá': 'recuerda', 'identificá': 'identifica', 'aplicá': 'aplica', 'completá': 'completa',
  'respondé': 'responde', 'analizá': 'analiza', 'compará': 'compara', 'calculá': 'calcula', 'verificá': 'verifica', 'registrá': 'registra',
  'iterá': 'itera', 'reformulá': 'reformula', 'observá': 'observa', 'prepará': 'prepara', 'evaluá': 'evalúa', 'considerá': 'considera',
  'imaginá': 'imagina', 'mandá': 'manda', 'empezá': 'empieza', 'cerrá': 'cierra', 'bajá': 'baja', 'descargá': 'descarga',
  'ingresá': 'ingresa', 'organizá': 'organiza', 'explicá': 'explica', 'justificá': 'justifica',
  'trabajá': 'trabaja', 'ayudá': 'ayuda', 'hablá': 'habla', 'escuchá': 'escucha', 'llamá': 'llama', 'esperá': 'espera', 'pasá': 'pasa',
  'dejá': 'deja', 'sacá': 'saca', 'llevá': 'lleva', 'mostrá': 'muestra', 'encontrá': 'encuentra', 'volvé': 'vuelve', 'comé': 'come',
  'aprendé': 'aprende', 'corré': 'corre', 'atendé': 'atiende', 'entendé': 'entiende', 'definí': 'define', 'diseñá': 'diseña',
  'planificá': 'planifica', 'documentá': 'documenta', 'comunicá': 'comunica', 'reflexioná': 'reflexiona', 'practicá': 'practica',
  'guardá': 'guarda', 'llená': 'llena', 'tocá': 'toca', 'cargá': 'carga', 'limpiá': 'limpia', 'cortá': 'corta', 'apagá': 'apaga',
  'encendé': 'enciende', 'prendé': 'prende', 'instalá': 'instala', 'conectá': 'conecta', 'configurá': 'configura', 'chequeá': 'chequea',
  'consultá': 'consulta', 'solicitá': 'solicita', 'informá': 'informa', 'reportá': 'reporta', 'firmá': 'firma', 'enviá': 'envía',
  'creá': 'crea', 'agregá': 'agrega', 'sumá': 'suma', 'restá': 'resta', 'repasá': 'repasa', 'estudiá': 'estudia', 'participá': 'participa',
  'elaborá': 'elabora', 'redactá': 'redacta', 'seleccioná': 'selecciona', 'marcá': 'marca', 'arrastrá': 'arrastra',
  'relacioná': 'relaciona', 'ordená': 'ordena', 'clasificá': 'clasifica', 'resolvé': 'resuelve', 'entregá': 'entrega',
  'pensalo': 'piénsalo', 'hacelo': 'hazlo', 'decime': 'dime', 'contame': 'cuéntame', 'avisame': 'avísame', 'ponete': 'ponte',
  'acordate': 'acuérdate', 'sentate': 'siéntate', 'preguntate': 'pregúntate', 'tenelo': 'tenlo', // «animate» no: «Adobe Animate», element.animate()
  'revisalo': 'revísalo', 'anotalo': 'anótalo', 'escribilo': 'escríbelo', 'probalo': 'pruébalo', 'aplicalo': 'aplícalo',
  // subjuntivo voseante
  'tengás': 'tengas', 'puedás': 'puedas', 'querás': 'quieras', 'hagás': 'hagas', 'sepás': 'sepas', 'digás': 'digas', 'vayás': 'vayas',
};

/** Preposiciones tras las que «vos» es término: «para vos» → «para ti» («con vos» → «contigo»). */
export const LQA_VOS_PREPS = ['para', 'a', 'de', 'por', 'sin', 'hacia', 'sobre', 'contra', 'ante', 'desde', 'hasta'];

/**
 * Regionalismos léxicos fuertes (detección; sin reemplazo automático). `re` sobre el texto tal cual (con tildes);
 * `hint` = alternativa neutra para el reintento dirigido.
 */
export const LQA_REGIONAL = [
  // LOOP 9 (P1-8): «coger» es habitual en España (y en parte de Colombia) pero vulgar en México y el Cono Sur.
  { re: /(?:^|[^\p{L}])(coger|coge|coges|cogen|cogemos|cogió|cogieron|cogido|cogida|cogidos|cogidas|cogiendo)(?=$|[^\p{L}])/iu, term: 'coger', region: 'España', hint: 'tomar' },
  // Argentina / Uruguay
  // Solo como vocativo al inicio de la oración («Che, …»): «la figura del Che, …» no.
  { re: /(?:^|[.!?]\s+|[¡¿"«(]\s*)[Cc]he,/u, term: 'che', region: 'Argentina/Uruguay', hint: 'omítelo' },
  { re: /(?:^|[^\p{L}])(labur(?:o|os|ar|ás|a|an|ando|ante|antes))(?=$|[^\p{L}])/iu, term: 'laburo', region: 'Argentina/Uruguay', hint: 'trabajo / trabajar' },
  { re: /(?:^|[^\p{L}])(boludo|boluda|boludos|boludas|boludez)(?=$|[^\p{L}])/iu, term: 'boludo', region: 'Argentina/Uruguay', hint: 'omítelo' },
  { re: /(?:^|[^\p{L}])(pibe|piba|pibes|pibas)(?=$|[^\p{L}])/iu, term: 'pibe', region: 'Argentina/Uruguay', hint: 'joven' },
  { re: /(?:^|[^\p{L}])(guita)(?=$|[^\p{L}])/iu, term: 'guita', region: 'Argentina/Uruguay', hint: 'dinero' },
  { re: /(?:^|[^\p{L}])(quilombo|quilombos)(?=$|[^\p{L}])/iu, term: 'quilombo', region: 'Argentina/Uruguay', hint: 'desorden' },
  { re: /(?:^|[^\p{L}])(macanudo|macanuda)(?=$|[^\p{L}])/iu, term: 'macanudo', region: 'Argentina/Uruguay', hint: 'excelente' },
  { re: /(?:^|[^\p{L}])(chabón|chabones)(?=$|[^\p{L}])/iu, term: 'chabón', region: 'Argentina/Uruguay', hint: 'persona' },
  { re: /(?:^|[^\p{L}])(birome|biromes)(?=$|[^\p{L}])/iu, term: 'birome', region: 'Argentina/Uruguay', hint: 'bolígrafo' },
  { re: /(?:^|[^\p{L}])(heladera|heladeras)(?=$|[^\p{L}])/iu, term: 'heladera', region: 'Argentina/Uruguay', hint: 'refrigerador' },
  { re: /(?:^|[^\p{L}])(remera|remeras)(?=$|[^\p{L}])/iu, term: 'remera', region: 'Argentina/Uruguay', hint: 'camiseta' },
  // España
  // «ordenador del gasto / de pagos» es un cargo formal (contratación pública): no.
  { re: /(?:^|[^\p{L}])(ordenador|ordenadores)(?=$|[^\p{L}])(?!\s+(?:del?\s+(?:gasto|pagos?|giro)))/iu, term: 'ordenador', region: 'España', hint: 'computadora' },
  { re: /(?:^|[¡¿"«(]\s*)vale\s*[,.!]|[¿]\s*vale\s*\?|,\s*vale\s*[.?!]/i, term: 'vale (de acuerdo)', region: 'España', hint: 'de acuerdo' },
  { re: /(?:^|[^\p{L}])(guay|guays)(?=$|[^\p{L}])/iu, term: 'guay', region: 'España', hint: 'excelente' },
  { re: /(?:^|[^\p{L}])(curr(?:ar|o|os|as|a|an|ando|ante|antes))(?=$|[^\p{L}])/iu, term: 'currar', region: 'España', hint: 'trabajar / trabajo' },
  // «molar» (masa molar, el tercer molar) y «mola» (mola hidatiforme) tienen lectura técnica: solo «molan» / «mola mucho».
  { re: /(?:^|[^\p{L}])(molan|mola mucho)(?=$|[^\p{L}])/u, term: 'molar (gustar)', region: 'España', hint: 'gustar' },
  { re: /(?:^|[^\p{L}])(chaval|chavala|chavales|chavalas)(?=$|[^\p{L}])/iu, term: 'chaval', region: 'España', hint: 'joven' },
  { re: /(?:^|[^\p{L}])(zumo|zumos)(?=$|[^\p{L}])/iu, term: 'zumo', region: 'España', hint: 'jugo' },
  { re: /(?:^|[^\p{L}])(aparc(?:ar|a|as|an|ado|ada|amiento|amientos)|aparque|aparquen)(?=$|[^\p{L}])/iu, term: 'aparcar', region: 'España', hint: 'estacionar' },
  { re: /(?:^|[^\p{L}])(fontanero|fontanera|fontaneros|fontanería)(?=$|[^\p{L}])/iu, term: 'fontanero', region: 'España', hint: 'plomero' },
  { re: /(?:^|[^\p{L}])(patata|patatas)(?=$|[^\p{L}])/iu, term: 'patata', region: 'España', hint: 'papa' },
  { re: /(?:^|[^\p{L}])(melocotón|melocotones)(?=$|[^\p{L}])/iu, term: 'melocotón', region: 'España', hint: 'durazno' },
  { re: /(?:^|[^\p{L}])(flipar|flipante|flipa|flipas)(?=$|[^\p{L}])/iu, term: 'flipar', region: 'España', hint: 'sorprender' },
  { re: /(?:^|[^\p{L}])(majo|majos)(?=$|[^\p{L}])/iu, term: 'majo', region: 'España', hint: 'amable' },
  { re: /(?:^|[^\p{L}])(cutre|cutres)(?=$|[^\p{L}])/iu, term: 'cutre', region: 'España', hint: 'de mala calidad' },
  { re: /(?:^|[^\p{L}])(jolín|jolines|joder)(?=$|[^\p{L}])/iu, term: 'expresión coloquial de España', region: 'España', hint: 'omítela' },
  // México
  { re: /(?:^|[^\p{L}])(güey|wey|guey)(?=$|[^\p{L}])/iu, term: 'güey', region: 'México', hint: 'omítelo' },
  { re: /(?:^|[^\p{L}])(chamb(?:a|as|ear|ea|ean|eando))(?=$|[^\p{L}])/iu, term: 'chamba', region: 'México/Perú', hint: 'trabajo' },
  { re: /(?:^|[^\p{L}])(padrísimo|padrísima|padrísimos|padrísimas|qué padre)(?=$|[^\p{L}])/iu, term: 'padrísimo', region: 'México', hint: 'excelente' },
  { re: /(?:^|[^\p{L}])(chido|chida|chidos|chidas)(?=$|[^\p{L}])/iu, term: 'chido', region: 'México', hint: 'excelente' },
  { re: /(?:^|[^\p{L}])(ahorita)(?=$|[^\p{L}])/iu, term: 'ahorita', region: 'México/Caribe', hint: 'ahora / en este momento' },
  { re: /(?:^|[^\p{L}])(órale|híjole|ándale)(?=$|[^\p{L}])/iu, term: 'interjección de México', region: 'México', hint: 'omítela' },
  { re: /(?:^|[^\p{L}])(chavo|chava|chavos|chavas)(?=$|[^\p{L}])/iu, term: 'chavo', region: 'México', hint: 'joven' },
  { re: /(?:^|[^\p{L}])(alberca|albercas)(?=$|[^\p{L}])/iu, term: 'alberca', region: 'México', hint: 'piscina' },
  { re: /(?:^|[^\p{L}])(la neta)(?=$|[^\p{L}])/iu, term: 'la neta', region: 'México', hint: 'la verdad' },
  // Colombia / Venezuela
  { re: /(?:^|[^\p{L}])(parce|parcero|parcera|parceros)(?=$|[^\p{L}])/iu, term: 'parcero', region: 'Colombia', hint: 'compañero' },
  { re: /(?:^|[^\p{L}])(chévere|chéveres|chevere)(?=$|[^\p{L}])/iu, term: 'chévere', region: 'Colombia/Venezuela', hint: 'excelente' },
  { re: /(?:^|[^\p{L}])(bacano|bacana|bacanos|bacanísimo)(?=$|[^\p{L}])/iu, term: 'bacano', region: 'Colombia', hint: 'excelente' },
  { re: /(?:^|[^\p{L}])(berraco|berraca|verraco|verraca)(?=$|[^\p{L}])/iu, term: 'berraco', region: 'Colombia', hint: 'difícil / valiente' },
  { re: /(?:^|[^\p{L}])(camell(?:ar|o duro|ando|an))(?=$|[^\p{L}])/iu, term: 'camellar', region: 'Colombia', hint: 'trabajar' },
  { re: /(?:^|[^\p{L}])(chimba|chimbita)(?=$|[^\p{L}])/iu, term: 'chimba', region: 'Colombia', hint: 'excelente' },
  { re: /(?:^|[^\p{L}])(chamo|chamos)(?=$|[^\p{L}])/iu, term: 'chamo', region: 'Venezuela', hint: 'joven' },
  // Chile / Perú
  { re: /(?:^|[^\p{L}])(cachai|cachái|cachar|cachaste)(?=$|[^\p{L}])/iu, term: 'cachai', region: 'Chile', hint: '¿entiendes?' },
  { re: /(?:^|[^\p{L}])((?:[Ss]í|[Nn]o|[Yy]a)\s+po)(?=\s*[,.!?]|$)/u, term: 'po', region: 'Chile', hint: 'omítelo' },
  { re: /(?:^|[^\p{L}])(fome|fomes)(?=$|[^\p{L}])/iu, term: 'fome', region: 'Chile', hint: 'aburrido' },
  { re: /(?:^|[^\p{L}])(pololo|polola|pololos|pololear)(?=$|[^\p{L}])/iu, term: 'pololo', region: 'Chile', hint: 'novio' },
  { re: /(?:^|[^\p{L}])(huevón|weón|weon|huevones)(?=$|[^\p{L}])/iu, term: 'huevón', region: 'Chile', hint: 'omítelo' },
  // Solo cerrando la frase («Responde al tiro.»): «al tiro de esquina», «el tiro de la chimenea» no.
  { re: /(?:^|[^\p{L}])(al tiro)(?=\s*[,.;!?)]|\s*$)/iu, term: 'al tiro', region: 'Chile', hint: 'de inmediato' },
  { re: /(?:^|[^\p{L}])(bacán|bacanes)(?=$|[^\p{L}])/iu, term: 'bacán', region: 'Chile/Perú', hint: 'excelente' },
  { re: /(?:^|[^\p{L}])(flaite|flaites|cuático|cuática)(?=$|[^\p{L}])/iu, term: 'expresión coloquial de Chile', region: 'Chile', hint: 'usa un término neutro' },
  { re: /(?:^|[^\p{L}])(pituco|pituca|pitucos|jato)(?=$|[^\p{L}])/iu, term: 'expresión coloquial de Perú', region: 'Perú', hint: 'usa un término neutro' },
];

/** «vosotros» y sus formas (España). */
export const LQA_VOSOTROS_RE = /(?:^|[^\p{L}])(vosotr[oa]s|vuestr[oa]s?|os\s+(?:recomiendo|recomendamos|pido|pedimos|invito|invitamos|animo|animamos|propongo|proponemos|dejo|dejamos|explico|explicamos)|(?:sois|tenéis|podéis|sabéis|queréis|hacéis|estáis|habéis|debéis|necesitáis|vais|seáis|tengáis|podáis|revisad|haced|leed|abrid|escribid|completad|mirad|venid|prestad|tened|decid|poned|pensad|recordad|observad|analizad|responded|elegid|entregad|coged|tomad|usad|buscad|preparad|practicad|repasad|guardad|cread|enviad|subid|aplicad|calculad|identificad|comparad|evaluad|consultad|seguid))(?=$|[^\p{L}])/iu;

function _lqaCap(src, dst) {
  if (!dst) return dst;
  var c = src.charAt(0);
  return c !== c.toLowerCase() && c === c.toUpperCase() ? dst.charAt(0).toUpperCase() + dst.slice(1) : dst;
}

/** Línea de referencia bibliográfica («Apellido, X. (2020)…»): los títulos de obras citadas no se tocan. */
export const LQA_REFERENCE_RE = /^\s*(?:[-*•]|\d{1,3}[.)])?\s*[A-ZÁÉÍÓÚÑ][\p{L}'’-]+,\s+(?:[A-ZÁÉÍÓÚÑ]\.|[A-ZÁÉÍÓÚÑ][\p{L}'’-]+)[^\n]*?\(\s*(?:1[5-9]|20)\d{2}[a-z]?\s*\)/u;

export const LQA_VOSEO_WORD_RE = new RegExp('(^|[^\\p{L}])(' + Object.keys(LQA_VOSEO_FIX).filter(function (k) { return LQA_VOSEO_FIX[k]; }).sort(function (a, b) { return b.length - a.length; }).join('|') + ')(?=$|[^\\p{L}])', 'giu');
 /** «el vos», «del vos», «un vos»: el pronombre nombrado como palabra, no usado. */
// LOOP 9 (P1-8): imperativo del voseo con pronombre pegado («crealo», «guardalo», «revisalo», «decime»). En tuteo lleva tilde
// («créalo», «guárdalo», «revísalo», «dime»). Se deriva SOLO de los imperativos de la tabla (terminados en á/é/í), así que no
// toca palabras comunes; se detecta (el ejecutor pide un reintento dirigido), no se corrige solo.
export const LQA_CLITICS = ['lo', 'la', 'los', 'las', 'le', 'les', 'me', 'nos', 'te', 'melo', 'mela', 'telo', 'tela', 'selo', 'sela'];
function _lqaUnaccent(w) { return String(w).normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function _lqaSyllableGroups(w) {
  // Núcleos vocálicos: dos vocales fuertes seguidas son sílabas distintas («cre-a»); fuerte + débil, una («guar-da»).
  var g = [];
  var re = /[aeiouáéíóúü]+/gi;
  var m;
  while ((m = re.exec(w))) {
    var v = m[0];
    var parts = v.replace(/([aeoáéó])(?=[aeoáéó])/gi, '$1|').split('|');
    for (var i = 0; i < parts.length; i++) g.push({ text: parts[i], index: m.index + v.indexOf(parts[i], i ? v.indexOf(parts[i - 1]) + parts[i - 1].length : 0) });
  }
  return g;
}
function _lqaTuteoWithClitic(tu, clitic) {
  if (/[áéíóú]/.test(tu)) return tu + clitic;
  var g = _lqaSyllableGroups(tu);
  var total = g.length + _lqaSyllableGroups(clitic).length;
  if (total < 3 || !g.length) return tu + clitic;
  var t = g.length >= 2 ? g[g.length - 2] : g[0];
  var strong = /[aeo]/i.exec(t.text);
  var off = strong ? strong.index : t.text.length - 1;
  var at = t.index + off;
  var acc = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú' }[tu.charAt(at).toLowerCase()] || tu.charAt(at);
  return tu.slice(0, at) + acc + tu.slice(at + 1) + clitic;
}
// Palabras reales que coinciden con una forma derivada (no se marcan): «tomate», «mandala», «comete un error», y voces inglesas
// de textos técnicos («create», «evaluate», «iterate»).
export const LQA_VOSEO_CLITIC_EXCLUDE = { tomate: 1, mandala: 1, comete: 1, create: 1, evaluate: 1, iterate: 1, cometela: 1,
  // Review L9: voces inglesas de textos técnicos (menús, funciones) y «deciles» (estadística); «ándale» es mexicanismo, no voseo.
  calculate: 1, participate: 1, elaborate: 1, considerate: 1, mandate: 1, definite: 1, restate: 1, explicate: 1, reformulate: 1, probate: 1,
  decile: 1, deciles: 1, andale: 1 };
export const LQA_VOSEO_CLITIC = (function () {
  var map = {};
  Object.keys(LQA_VOSEO_FIX).forEach(function (k) {
    if (!/[áéí]$/.test(k) || !LQA_VOSEO_FIX[k]) return;
    var base = _lqaUnaccent(k);
    if (base.length < 3) return;
    LQA_CLITICS.forEach(function (c) { if (!map[base + c] && !LQA_VOSEO_CLITIC_EXCLUDE[base + c]) map[base + c] = _lqaTuteoWithClitic(LQA_VOSEO_FIX[k], c); });
  });
  return map;
})();
export const LQA_VOSEO_CLITIC_RE = new RegExp('(^|[^\\p{L}])(' + Object.keys(LQA_VOSEO_CLITIC).sort(function (a, b) { return b.length - a.length; }).join('|') + ')(?=$|[^\\p{L}])', 'iu');

export const LQA_VOS_NOUN_BEFORE_RE = /(?:^|[^\p{L}])(?:el|del|un|al)\s+$/iu;
export const LQA_VOS_RE = /(^|[^\p{L}])(?:(con)\s+vos|(para|a|de|por|sin|hacia|sobre|contra|ante|desde|hasta)\s+vos|(vos))(?=$|[^\p{L}])/giu;

/**
 * Review piloto I2: lo que no es prosa nunca se toca ni se marca — bloques e inline de código, URLs, destinos de enlaces
 * Markdown y atributos HTML. Se enmascaran (misma longitud) y se restauran después.
 */
export const LQA_NON_PROSE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\]\([^)\s]*\)|https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+|[\w-]+\s*=\s*"[^"]*"|[\w-]+\s*=\s*'[^']*'|\b[\w.-]+\.(?:com|org|net|edu|gov|co|io|js|ts|py|html|css|json)\b(?:\/[^\s]*)?/g;
function _lqaMask(text) {
  var saved = [];
  // El relleno usa \u0002 (nunca espacios): al restaurar no se come ningún espacio real. Los saltos de línea del bloque se
  // conservan para que la división por líneas siga igual.
  var masked = String(text).replace(LQA_NON_PROSE_RE, function (m) { saved.push(m); return '\u0000' + (saved.length - 1) + '\u0001' + m.replace(/[^\n]/g, '\u0002').slice(String(saved.length - 1).length + 2); });
  return { masked: masked, saved: saved };
}
/** Restaura cada marcador consumiendo EXACTAMENTE su relleno (nunca un salto de línea o espacio del texto real). */
function _lqaUnmask(masked, saved) {
  var out = '';
  var i = 0;
  while (i < masked.length) {
    var p = masked.indexOf('\u0000', i);
    if (p < 0) { out += masked.slice(i); break; }
    var q = masked.indexOf('\u0001', p);
    if (q < 0) { out += masked.slice(i); break; }
    var idx = Number(masked.slice(p + 1, q));
    out += masked.slice(i, p) + saved[idx];
    i = q + 1 + Math.max(0, saved[idx].length - (q + 1 - p));
  }
  return out;
}

/** Corrige el voseo (formas sin ambigüedad). Devuelve {text, fixes:[{from,to}]}. «SOS» (en mayúsculas) nunca. */
export function lqaFixText(text) {
  var fixes = [];
  if (typeof text !== 'string' || !text) return { text: text, fixes: fixes };
  var mk = _lqaMask(text);
  var out = mk.masked.split('\n').map(function (line) {
    if (LQA_REFERENCE_RE.test(line)) return line;
    var l = line.replace(LQA_VOSEO_WORD_RE, function (m, pre, w) {
      if (w === w.toUpperCase() && w.length > 1) return m; // siglas («SOS»)
      var to = LQA_VOSEO_FIX[w.toLowerCase()];
      if (!to) return m;
      var dst = _lqaCap(w, to);
      fixes.push({ from: w, to: dst });
      return pre + dst;
    });
    l = l.replace(LQA_VOS_RE, function (m, pre, con, prep, bare, offset, whole) {
      var src = m.slice(pre.length);
      if (/VOS/.test(src)) return m; // sigla
      if (bare && LQA_VOS_NOUN_BEFORE_RE.test(whole.slice(0, offset + pre.length))) return m; // «el vos» (uso metalingüístico)
      var dst;
      if (con) dst = _lqaCap(con, 'contigo');
      else if (prep) dst = prep + ' ti';
      else dst = _lqaCap(bare, 'tú');
      fixes.push({ from: src, to: dst });
      return pre + dst;
    });
    return l;
  }).join('\n');
  return { text: _lqaUnmask(out, mk.saved), fixes: fixes };
}

/** Claves que nunca son texto para el estudiante (ids, URLs, tipos). */
export const LQA_SKIP_KEYS = { id: 1, chapterId: 1, itemKey: 1, moduleId: 1, url: 1, href: 1, src: 1, type: 1, kind: 1, youtubeId: 1, videoId: 1, slug: 1 };

/** Corrige el voseo en todos los strings de un objeto JSON (en el lugar). Devuelve las correcciones. */
export function lqaFixDeep(obj) {
  var fixes = [];
  (function walk(v, parent, key) {
    if (typeof v === 'string') {
      if (parent && !LQA_SKIP_KEYS[key]) {
        var r = lqaFixText(v);
        if (r.fixes.length) { parent[key] = r.text; fixes.push.apply(fixes, r.fixes); }
      }
      return;
    }
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) walk(v[i], v, i); return; }
    if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k], v, k); });
  })(obj, null, null);
  return fixes;
}

/** Hallazgos de idioma en UNA oración: [{code: 'VOSEO'|'VOSOTROS'|'REGIONAL', term, region, hint}]. */
export function lqaSentenceFindings(sentence) {
  var s = _lqaMask(String(sentence || '')).masked;
  var out = [];
  if (!s.trim() || LQA_REFERENCE_RE.test(s)) return out;
  LQA_VOSEO_WORD_RE.lastIndex = 0;
  var m;
  var re = new RegExp(LQA_VOSEO_WORD_RE.source, 'giu');
  while ((m = re.exec(s))) {
    if (m[2] === m[2].toUpperCase() && m[2].length > 1) continue;
    out.push({ code: 'VOSEO', term: m[2], region: 'Argentina/Uruguay', hint: LQA_VOSEO_FIX[m[2].toLowerCase()] });
    break;
  }
  if (!out.length) {
    // Todas las coincidencias (review BE-L9 m3): si la primera es un nombre, una posterior real igual se detecta.
    var cre = new RegExp(LQA_VOSEO_CLITIC_RE.source, 'giu');
    var cm;
    while ((cm = cre.exec(s))) {
      // Con mayúscula en medio de la oración es un nombre (menú, función, marca): «la función Calculate» no es voseo.
      var midCap = /^[A-ZÁÉÍÓÚÑ]/.test(cm[2]) && /[^\s.!?¡¿"«:(\-—]\s*$/.test(s.slice(0, cm.index + cm[1].length));
      if (midCap || (cm[2] === cm[2].toUpperCase() && cm[2].length > 1)) continue;
      out.push({ code: 'VOSEO', term: cm[2], region: 'Argentina/Uruguay', hint: LQA_VOSEO_CLITIC[cm[2].toLowerCase()] });
      break;
    }
  }
  if (!out.length) {
    var vre = new RegExp(LQA_VOS_RE.source, 'giu');
    var v;
    while ((v = vre.exec(s))) {
      if (/VOS/.test(v[0])) continue;
      if (v[4] && LQA_VOS_NOUN_BEFORE_RE.test(s.slice(0, v.index + v[1].length))) continue;
      out.push({ code: 'VOSEO', term: 'vos', region: 'Argentina/Uruguay', hint: 'tú / ti' });
      break;
    }
  }
  // Review piloto I1: una sigla en MAYÚSCULAS («LEED», «PO», «CHE») nunca es «vosotros» ni un regionalismo.
  var upper = function (m) { var w = String(m || '').replace(/[^\p{L}]/gu, ''); return w.length > 1 && w === w.toUpperCase(); };
  var vo = LQA_VOSOTROS_RE.exec(s);
  if (vo && !upper(vo[1])) out.push({ code: 'VOSOTROS', term: vo[1], region: 'España', hint: 'tú (o ustedes)' });
  for (var i = 0; i < LQA_REGIONAL.length; i++) {
    var r = LQA_REGIONAL[i];
    var mm = r.re.exec(s);
    if (mm && !upper(mm[1] || mm[0])) out.push({ code: 'REGIONAL', term: r.term, region: r.region, hint: r.hint });
  }
  return out;
}

/** Referencia institucional APA («Organización Mundial de la Salud. (2020).»). */
export const LQA_REFERENCE_INST_RE = /^\s*(?:[-*•]|\d{1,3}[.)])?\s*[A-ZÁÉÍÓÚÑ][^().\n]{2,160}\.\s*\(\s*(?:1[5-9]|20)\d{2}[a-z]?\s*\)\s*\./u;
/** Título de sección (markdown #, negrita sola o numerado) y si ese título ES la bibliografía. */
export const LQA_HEADING_LINE_RE = /^\s*(?:#{1,6}\s*|\*\*[^*\n]{1,80}\*\*\s*$|\d{1,2}[.)]\s+[A-ZÁÉÍÓÚÑ][^.,:;()\n]{0,50}$)/;
export const LQA_BIB_HEADING_RE = /^(?:\d{1,2}[.)]\s*)?(?:evaluaci[oó]n\s+y\s+)?(?:bibliograf[íi]a|referencias(?:\s+bibliogr[áa]ficas)?|fuentes(?:\s+consultadas|\s+bibliogr[áa]ficas)?|lecturas\s+recomendadas|para\s+profundizar)(?:\s+y\s+(?:fuentes|referencias|bibliograf[íi]a|recursos))?\s*[:.]?$/i;

/**
 * Hallazgos en un texto completo (Markdown o texto plano; por oración; máx. `max`). Review piloto I4: es LA función que
 * usan el ejecutor (45) y el servidor: omite las secciones de bibliografía y las referencias (las dos formas), revisa
 * las filas de tabla como cualquier texto.
 */
export function lqaMarkdownFindings(text, max) {
  var lim = max || 12;
  var out = [];
  var inBib = false;
  var mk = _lqaMask(String(text || ''));
  mk.masked.split(/\n+/).forEach(function (line) {
    if (LQA_HEADING_LINE_RE.test(line)) inBib = LQA_BIB_HEADING_RE.test(line.replace(/^\s*#{1,6}\s*/, '').replace(/\*\*/g, '').trim());
    if (out.length >= lim || inBib || LQA_REFERENCE_RE.test(line) || LQA_REFERENCE_INST_RE.test(line)) return;
    line.split(/(?<=[.!?])\s+/).forEach(function (sent) {
      if (out.length >= lim) return;
      lqaSentenceFindings(sent).forEach(function (h) { if (out.length < lim) out.push(Object.assign({ text: _lqaUnmask(sent, mk.saved).trim().slice(0, 200) }, h)); });
    });
  });
  return out;
}
/** Alias histórico. */
export function lqaFindings(text, max) { return lqaMarkdownFindings(text, max); }

/** Cursos de idiomas o de lengua/literatura: citan inglés, «vosotros» o voseo a propósito (sin Language QA). */
// Review piloto I3: solo el NOMBRE y el SECTOR del curso, con palabras completas («lenguaje» SQL, «manuales en inglés» del
// contexto no eximen).
// Re-review piloto P3: nada de «interpretación» (de planos), «redacción» (de informes) ni «gramática» sueltas.
export const LQA_LANGUAGE_COURSE_RE = /(?:^|[^\p{L}])(?:ingl[eé]s|english|idiomas?|lenguas?|literatura|castellano|biling[üu]es?|traducci[oó]n|franc[eé]s|portugu[eé]s|alem[aá]n|italiano|japon[eé]s|chino|mandar[ií]n|coreano|ruso|ling[üu][íi]stica)(?=$|[^\p{L}])/iu;
export function lqaIsLanguageCourse(courseContext) {
  var c = courseContext || {};
  return LQA_LANGUAGE_COURSE_RE.test([c.nombre, c.sector].filter(function (x) { return typeof x === 'string'; }).join(' '));
}

/** Etiqueta para el reintento dirigido. */
export function lqaHitLabel(h) {
  if (h.code === 'VOSEO') return 'voseo («' + h.term + '»): usa tuteo (' + (h.hint || 'tú') + ')';
  if (h.code === 'VOSOTROS') return 'español de España («' + h.term + '»): usa tú (o ustedes)';
  return 'regionalismo de ' + h.region + ' («' + h.term + '»): usa un término neutro (' + h.hint + ')';
}

/** Regla de idioma para todos los prompts (la misma para cualquier país). */
export function lqaLanguageRule() {
  return 'IDIOMA: español latinoamericano NEUTRO, profesional y académico, con tuteo ("puedes", "debes", "realiza"). ' +
    'NUNCA voseo ("vos", "podés", "tenés", "hacé"), NUNCA "vosotros/vuestro", y sin regionalismos ni modismos de ningún país ' +
    '(Argentina, España, México, Colombia, Chile, Perú, Venezuela…): usa siempre el término neutro (trabajo, computadora, ' +
    'de acuerdo, excelente, joven). Los ejemplos pueden ser del país del curso; el idioma, no.';
}
