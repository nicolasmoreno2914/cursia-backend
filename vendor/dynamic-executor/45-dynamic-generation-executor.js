// ════ Fase 5A Task 6a — ejecutor de generación dynamic en el navegador ════
// Reclama items ('content'|'scorm'|'exam') de un run del backend
// (dynamic-generation, Task 3) y los resuelve en el navegador con los
// builders puros de 44-dynamic-prompt-builders.js + el motor SCORM v2 real
// (06b-scorm-templates.js, R19) + la validación GIFT real (07-examenes.js /
// 08-downloads.js, reutilizadas tal cual porque son puras).
//
// Regla dura (spec §7 condición 1): este archivo NUNCA lee `D`/`F`/`SEL`,
// salvo la única función marcada como "freeze point" al final
// (dynBuildCourseContextFromCurrentFields) — todo lo demás recibe su
// contexto/blueprint EXCLUSIVAMENTE de la respuesta del claim del backend.
// `video` nunca se reclama acá — solo lo reclama el worker del backend
// (spec §3.9 D1; ver executor.controller.ts).
//
// Nunca escribe `F`/`D`/`SI`/`EI` legacy.
//
// R2 (rulesVersion 2 + Context Package, Fase 6): con un Manifest v2 también
// reclama 'course_plan'|'course_intro'|'module_intro', y el `content` v2 usa
// el Context Package puro de 46-dynamic-context-package.js. Un run v1 nunca
// invoca código v2 (ver _dynRunItem / _dynClaimTypesFor).

// ════ Mapeo fatal vs. transitorio derivado de 04-api.js (ver task-6a-report.md) ════
// api()/apiRetry() (04-api.js) clasifican un error como `{fatal:true,...}`
// (irrecuperable: 401/403, falta de crédito, modelo mal configurado, 400
// no relacionado al modelo) o `{fatal:false,...}` (transitorio: red,
// 429/5xx/502/503/529, respuesta vacía). `_dynLlmCall` (abajo, R21) agota
// sus propios reintentos internos con el mismo backoff que `apiRetry` y,
// si los agota, re-lanza el error envuelto como
// `{fatal:true, msg:'❌ Falló después de N intentos: '+msg}` — igual que
// `apiRetry` — así que agotar reintentos de algo transitorio TAMBIÉN queda
// marcado `fatal:true`, sin ser irrecuperable. Por eso el prefijo del
// mensaje es la única señal para distinguir "agotó reintentos de algo
// transitorio" (retryable=true — dejar que el scheduler reintente el ITEM
// en un nuevo lease) de "irrecuperable" (retryable=false — R21: además
// dispara la pausa fatal del ejecutor, ver dynExecutorStart).
var DYN_EXHAUSTED_RETRIES_RE = /Fall[oó] despu[eé]s de \d+ intentos/i;

// M2 (final review): solo un `.fatal === true` explícito (auth/crédito/
// config, agotamiento de reintentos ya envuelto arriba con el mismo shape) es
// irrecuperable. CUALQUIER excepción sin esa forma (TypeError sobre una
// salida de IA rara, un JSON.parse suelto, etc.) es transitoria por defecto:
// retryable=true y SIN pausa fatal del ejecutor — antes, `e.fatal ===
// undefined` caía en el mismo `return` que un fatal real y mataba el item
// permanentemente además de pausar las otras lanes por un glitch cualquiera.
function _dynMapApiError(e) {
  var msg = (e && (e.msg || e.message)) || String(e);
  if (DYN_EXHAUSTED_RETRIES_RE.test(msg)) return { retryable: true, msg: msg };
  // Piloto #1209 (review I1): resultado AMBIGUO (524) → solo ESTA parte queda fallida, no reintentable; las demás
  // lanes siguen (no es un fallo de la pestaña ni de la cuenta, no pausa el ejecutor entero).
  if (e && e.ambiguous === true) return { retryable: false, msg: msg, itemOnly: true };
  // Loop Cost Efficiency: el guard de gasto del servidor negó la llamada.
  //  - itemBudget: ESTA parte agotó su presupuesto de recuperación → solo ella queda fallida (no reintentable);
  //  - runPaused: el run está pausado (usuario, disyuntor de consumo anómalo o tope) → la parte vuelve a la cola
  //    y el ejecutor se detiene; solo «Reanudar generación» lo vuelve a arrancar.
  if (e && e.itemBudget === true) return { retryable: false, msg: msg, itemOnly: true };
  if (e && e.runPaused === true) return { retryable: true, msg: msg, itemOnly: true, runPaused: true };
  if (e && e.fatal === true) return { retryable: false, msg: msg };
  return { retryable: true, msg: msg };
}

// ════ R21 — _dynLlmCall: proxy de IA propio del ejecutor, NUNCA GEN_STOPPED ════
// `apiRetry` (04-api.js, legacy, intocado) es un recurso COMPARTIDO por toda
// la pestaña: revisa `GEN_STOPPED` al principio de cada intento y lo pone en
// `true` en cualquier error fatal — sea cual sea el llamador. Con
// concurrency>1, un fatal en el item de la lane A pondría `GEN_STOPPED=true`
// y la lane B (un item sano, sin relación) fallaría de inmediato con
// "Generación detenida por el usuario", una causa falsa. `_dynLlmCall`
// reimplementa el MISMO bucle de reintento con backoff (2s·2^n, tope 30s) y
// la MISMA semántica de reintentos agotados que `apiRetry`, llamando a
// `api()` (04-api.js, también intocado — `api()` en sí no lee ningún flag
// global) directamente — nunca lee ni escribe `GEN_STOPPED`. Un fatal real
// se relanza tal cual (sin envolver, sin reintentar) — el `processItem` de
// más abajo es quien decide la pausa fatal del ejecutor (R21), no esta
// función.
var DYN_LLM_BACKOFF_BASE_MS = 2000; // same base as apiRetry (2s·2^attempt)
var DYN_LLM_BACKOFF_MAX_MS = 30000; // same cap as apiRetry; both overridable by a harness

// metaOut (opcional, fix wave review-rv2 I2): se pasa a api() para recibir
// el stop_reason de ESA respuesta (p.ej. 'max_tokens' = truncada). Sin
// metaOut la llamada a api() es exactamente la de siempre (v1 intacto).
//
// attr (opcional, V2.1 RF-b): atribución FinOps de la llamada — {itemRunId,
// callRole}. Cada intento viaja con x-cursia-item-run-id / x-cursia-call-role /
// x-cursia-attempt (1 = primer intento de ese callRole) para que el proxy LLM
// registre el usage en el ledger. Es solo una PISTA: el backend verifica que
// el item run sea del usuario del JWT; nunca se mandan costos ni owner.
var DYN_CALL_ROLES = ['main', 'validation_retry', 'continuation', 'context_summary_retry'];

function _dynAttr(item, callRole) {
  if (!item || !item.itemRunId) return null;
  return { itemRunId: item.itemRunId, callRole: DYN_CALL_ROLES.indexOf(callRole) >= 0 ? callRole : 'main' };
}

function _dynAttrHeaders(attr, attemptNumber) {
  if (!attr || typeof attr !== 'object') return null;
  if (!attr.itemRunId) {
    // Headers crudos (hook R11b sobreescrito): se reenvían tal cual; vacío → sin headers.
    return Object.keys(attr).length ? attr : null;
  }
  return {
    'x-cursia-item-run-id': attr.itemRunId,
    'x-cursia-call-role': attr.callRole || 'main',
    'x-cursia-attempt': String(attemptNumber)
  };
}

// R11b (_dynV3Llm) pasa el resultado de _dynLlmCallHeaders: el mismo descriptor
// {itemRunId, callRole}; por compatibilidad también se acepta un objeto de
// headers crudos (se reenvía tal cual). Vacío/ausente = llamada idéntica a la de siempre.
// Task 2 (failures_report: course_plan "No tienes acceso"): en una pestaña en
// segundo plano el auto-refresh de Supabase se atrasa y api() (token síncrono)
// sale sin Authorization → 401 → fatal → pausa del ejecutor. Antes de cada
// intento se renueva el token si está por vencer; y ante un 401 se fuerza UNA
// renovación y se reintenta una vez (el proxy rechaza el 401 antes de llamar
// al proveedor: sin gasto). Si sigue sin sesión, el fatal se propaga como antes.
// Tope de espera: un getSession() trabado (locks de supabase-js en pestañas en
// segundo plano) nunca bloquea la lane; sin token, api() sigue como siempre.
var DYN_TOKEN_TIMEOUT_MS = 10000;
async function _dynFreshToken(force) {
  if (typeof getSupabaseTokenAsync !== 'function') return null;
  // force: marginMs enorme → getSupabaseTokenAsync SIEMPRE llama a refreshSession (no solo salta la caché).
  var p = getSupabaseTokenAsync(force ? { forceRefresh: true, marginMs: 24 * 3600 * 1000 } : undefined);
  var timer;
  var timeout = new Promise(function (res) { timer = setTimeout(function () { res(null); }, DYN_TOKEN_TIMEOUT_MS); });
  try { return await Promise.race([p, timeout]); } catch (e) { return null; } finally { clearTimeout(timer); }
}

// BANKOPT fix round 1 (M2): metaOut.usage = SUMA del usage de todos los intentos de esta llamada (una
// respuesta vacía se paga y se reintenta; antes solo quedaba el último intento).
function _dynAddUsage(acc, u) {
  if (!u || typeof u !== 'object') return acc;
  var out = acc || {};
  ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].forEach(function (k) {
    var v = u[k];
    if (typeof v === 'number' && isFinite(v) && v > 0) out[k] = (out[k] || 0) + v; else if (!(k in out)) out[k] = 0;
  });
  return out;
}
async function _dynLlmCall(system, user, maxTok, maxRetries, schema, metaOut, attr) {
  maxRetries = (typeof maxRetries === 'number') ? maxRetries : 3;
  var authRetried = false;
  var usageAcc = null;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await _dynFreshToken(false);
      var extra = _dynAttrHeaders(attr, attempt + 1);
      if (metaOut) {
        metaOut.stopReason = null;
        metaOut.usage = null;
        try {
          if (extra) return await api(system, user, maxTok, schema, undefined, metaOut, extra);
          return await api(system, user, maxTok, schema, undefined, metaOut);
        } finally {
          usageAcc = _dynAddUsage(usageAcc, metaOut.usage);
          metaOut.usage = usageAcc;
        }
      }
      if (extra) return await api(system, user, maxTok, schema, undefined, undefined, extra);
      return await api(system, user, maxTok, schema);
    } catch (e) {
      if (e && e.fatal && e.status === 401 && !authRetried && (await _dynFreshToken(true))) {
        authRetried = true;
        attempt--; // la renovación de sesión no consume un intento
        continue;
      }
      if (e && e.fatal) {
        throw e; // irrecuperable: nunca se reintenta, se propaga tal cual
      }
      if (e && e.ambiguous) {
        // Piloto #1209: la respuesta se perdió pero el proveedor pudo cobrarla (524). Nunca se repite sola:
        // el mensaje («ambiguo») queda fuera del auto-heal (deny-list) → el item espera a una persona.
        throw { fatal: true, ambiguous: true, status: e.status, msg: '⚠️ Resultado ambiguo de la IA (HTTP ' + (e.status || 524) + ': la respuesta se perdió y el proveedor pudo cobrarla). No se reintenta solo para no pagarla dos veces.' };
      }
      if (attempt < maxRetries) {
        var wait = Math.min(DYN_LLM_BACKOFF_BASE_MS * Math.pow(2, attempt), DYN_LLM_BACKOFF_MAX_MS);
        await _dynSleep(wait);
      } else {
        throw { fatal: true, msg: '❌ Falló después de ' + (maxRetries + 1) + ' intentos: ' + ((e && e.msg) || (e && e.message) || String(e)) };
      }
    }
  }
}

// ════ SCORM v2 — asignación de plantillas con RNG inyectable ════
// assignRoomTemplates/pickRoomTemplate (06b-scorm-templates.js, legacy
// congelado) usan Math.random() directo, no inyectable — para que el
// harness pueda probar la asignación de forma determinística sin pisar
// Math.random global (contaminaría otras llamadas concurrentes del
// ejecutor), se reimplementa acá el MISMO algoritmo (nunca dos plantillas
// iguales seguidas si el pool tiene >= 2) con un `rng` explícito.
function _dynPickRoomTemplate(pool, lastId, rng) {
  var candidates = pool.length > 1 ? pool.filter(function (id) { return id !== lastId; }) : pool;
  return candidates[Math.floor(rng() * candidates.length)];
}
function _dynAssignRoomTemplates(activeIds, totalRooms, rng) {
  if (!Array.isArray(activeIds) || activeIds.length < 1) {
    throw new Error('_dynAssignRoomTemplates: activeIds vacío');
  }
  var _rng = typeof rng === 'function' ? rng : Math.random;
  var result = [];
  var last = null;
  for (var i = 0; i < totalRooms; i++) {
    var id = _dynPickRoomTemplate(activeIds, last, _rng);
    result.push(id);
    last = id;
  }
  return result;
}

// Task 2 (failures_report: "SCORM v2 inválido: sala N sin datos") — plantilla
// de reemplazo para CUALQUIER sala que sigue fallando tras su reintento, no
// solo las de palabras: una sala fallida tumbaba el item entero y el
// reintento regeneraba las 5 salas. Salas de palabras: misma regla R25
// (primera no-palabras activa). Resto: otra plantilla activa distinta de la
// que falló (preferente no-palabras y no adyacente). null si no hay otra.
function _dynPickRoomFallback(activeIds, roomAssignment, roomIndex, failedId) {
  if (SCORM_V2_WORD_TEMPLATES.indexOf(failedId) !== -1) {
    return scormV2PickFallbackTemplate(activeIds, roomAssignment, roomIndex);
  }
  var others = (activeIds || []).filter(function (id) { return id !== failedId; });
  if (others.length === 0) return null;
  var adjacent = [roomAssignment[roomIndex - 1], roomAssignment[roomIndex + 1]];
  var rank = function (id) {
    return (SCORM_V2_WORD_TEMPLATES.indexOf(id) !== -1 ? 2 : 0) + (adjacent.indexOf(id) !== -1 ? 1 : 0);
  };
  return others.slice().sort(function (a, b) { return rank(a) - rank(b); })[0];
}

// ════ GIFT — prompt de corrección puro (equivalente de pGIFTCorreccion, ──
// 07-examenes.js:172, que lee el estado global D directo). Dynamic
// solo tiene exámenes de UNIDAD (nunca 'final' — ver generation-manifest-
// builder.ts: ManifestItemType 'exam' siempre scope:'module'), así que el
// branch item.t==='f' de la versión legacy no aplica acá.
function _dynGiftCorreccionPrompt(courseContext, outline, moduleNumber, faltantes, nextIdNum, ped) {
  var c = dynCtx(courseContext, outline);
  var nombre = (courseContext && courseContext.nombre) || '';
  var sector = (courseContext && courseContext.sector) || '';
  var pais = (courseContext && courseContext.pais) || '';
  var prefix = 'U' + moduleNumber;
  var totalLabel = 'examen de UNIDAD ' + moduleNumber;
  var totalMissing = faltantes.reduce(function (s, f) { return s + f.count; }, 0);
  var typeLabels = {
    multichoice: 'selección múltiple (4 opciones, 1 correcta)',
    truefalse: 'verdadero/falso',
    match: 'emparejamiento (mínimo 4 pares cada una)'
  };
  var detalle = faltantes.map(function (f) { return '- ' + f.count + ' de ' + (typeLabels[f.type] || f.type); }).join('\n');
  return c + '\n\nGeneraste el ' + totalLabel + ' de "' + nombre + '" pero faltaron preguntas de tipos específicos: tu respuesta anterior solo llegó hasta ' + prefix + '-' + (nextIdNum - 1) + '.\nGenera EXACTAMENTE estas ' + totalMissing + ' preguntas ADICIONALES, del tipo EXACTO indicado en cada caso (no las repongas con otro tipo):\n' + detalle + '\nContinuando la numeración desde ::' + prefix + '-' + nextIdNum + ':: en adelante (sin saltos ni repetir preguntas anteriores). Mismo rigor: preguntas concretas del sector ' + sector + ' en ' + pais + ', nunca genéricas.\nENTREGA SOLO las ' + totalMissing + ' preguntas nuevas en formato GIFT puro, sin repetir ninguna pregunta anterior, sin texto explicativo.'
    + (ped ? '\n' + _dynPedagogyLine(ped) : '')
    + dynGiftSyntaxRef(courseContext);
}

// ════ Por-tipo: content ════
async function _dynRunContent(item) {
  var bp = item.blueprint;
  var courseContext = item.context.courseContext;
  var sys = dynSysL(courseContext);
  var prompt = dynLibroChapterPrompt(courseContext, bp.outline, bp.chapter, bp.module, item.chapterNumber, item.moduleNumber);
  var md = await _dynLlmCall(sys, prompt, 4096, 3, undefined, undefined, _dynAttr(item, 'main'));
  if (!md || !md.trim()) {
    return { ok: false, error: 'contenido vacío tras generación', retryable: true };
  }
  var fname = (item.chapterId || item.itemRunId) + '_dynamic_content_md.md';
  return {
    ok: true,
    artifacts: [{ type: 'dynamic_content_md', content: md, filename: fname, mimeType: 'text/markdown' }],
    summary: { chapterId: item.chapterId, chars: md.length }
  };
}

// ════ Por-tipo: scorm (motor v2 real — R19) ════
// El item SCORM depende de su item de contenido en el Manifest (dependencia
// literal, condición 4) pero el motor v2 NUNCA lee el libro guía (a
// diferencia del motor viejo pSCORM_data) — por eso este ejecutor no
// descarga `item.dependencyArtifacts` para 'scorm': la dependencia existe
// solo para SECUENCIAR (el scheduler no deja reclamar scorm hasta que el
// content del mismo capítulo esté completed), no para consumir su artifact.
async function _dynRunScorm(item) {
  var bp = item.blueprint;
  var courseContext = item.context.courseContext;
  var cap = { n: item.chapterNumber, t: (bp.chapter && bp.chapter.title) || '' };
  var templateIds = sv2ResolveActiveTemplateIds(courseContext.scormTemplateIds, SCORM_V2_TEMPLATES);
  var sys = scormV2SysPrompt();
  var ped = dynPedagogyBlock(item); // Fase 2: diseño de la actividad (solo activity v3 con perfil pedagógico)
  // Motor de carga horaria: en un capítulo de PRÁCTICA las salas integran los capítulos de contenido del módulo.
  var practice = _dynPracticeClaim(item);
  if (practice) ped = (ped || '') + _dynScormPracticeBlock(bp, practice);
  var roomAssignment = _dynAssignRoomTemplates(templateIds, 5);
  var roomsData = [];
  for (var i = 0; i < 5; i++) {
    var templateId = roomAssignment[i];
    var result = await _dynGenScormRoomV2(cap, templateId, sys, courseContext, bp.outline, _dynAttr(item, 'main'), ped);
    // R25 + Task 2: una sala que sigue fallando tras su reintento se
    // reintenta UNA vez más con otra plantilla activa (_dynPickRoomFallback),
    // en vez de tumbar el item entero y regenerar las 5 salas.
    // Proveedor caído/saturado (reintentos agotados): otra plantilla no ayuda; se falla ya.
    if (!result.ok && !DYN_EXHAUSTED_RETRIES_RE.test(result.reason || '')) {
      var fallbackId = _dynPickRoomFallback(templateIds, roomAssignment, i, templateId);
      if (fallbackId) {
        console.warn('[scorm v2] sala ' + (i + 1) + ': fallback ' + templateId + '→' + fallbackId);
        var fbResult = await _dynGenScormRoomV2(cap, fallbackId, sys, courseContext, bp.outline, _dynAttr(item, 'validation_retry'), ped);
        if (fbResult.ok) {
          roomAssignment[i] = fallbackId;
          templateId = fallbackId;
        }
        result = fbResult;
      }
    }
    if (!result.ok) {
      console.error('[dynExecutor:scorm] Cap ' + cap.n + ' sala ' + (i + 1) + ' (' + templateId + '): ' + result.reason);
      // El item va a fallar igual: no se generan (ni se pagan) las salas restantes.
      return { ok: false, error: 'SCORM v2 inválido: sala ' + (i + 1) + ' sin datos (' + String(result.reason || '').slice(0, 200) + ')', retryable: true };
    }
    roomsData.push({ templateId: templateId, data: result.data });
  }
  var chapterValidation = scormV2ValidateChapterRooms(roomAssignment, roomsData);
  if (!chapterValidation.ok) {
    return { ok: false, error: 'SCORM v2 inválido: ' + chapterValidation.reason, retryable: true };
  }
  var html = buildScormV2Html(cap, roomAssignment, roomsData);
  var manifest = defMf(cap);
  var base = (item.chapterId || item.itemRunId);
  return {
    ok: true,
    artifacts: [
      { type: 'dynamic_scorm_html', content: html, filename: base + '_dynamic_scorm_html.html', mimeType: 'text/html' },
      { type: 'dynamic_scorm_manifest', content: manifest, filename: base + '_dynamic_scorm_manifest.xml', mimeType: 'application/xml' }
    ],
    summary: Object.assign({ chapterId: item.chapterId, roomAssignment: roomAssignment }, dynPedagogySummary(item))
  };
}

// Equivalente puro de genScormRoomV2 (06b-scorm-templates.js:1501) que usa
// dynScormV2RoomPrompt en vez de scormV2PromptFor (courseContext en vez de
// D/ctx()) — mismo presupuesto de tokens, mismo único reintento por sala.
// Fix round 1 (review Critical 1): legacy genScormRoomV2 envuelve TODO el
// cuerpo en try/catch — cualquier throw (JSON.parse sobre salida truncada/
// inválida, un error transitorio de _dynLlmCall) se convierte en
// {ok:false, reason}, nunca se propaga. Antes de este fix, acá faltaba ese
// try/catch: un JSON.parse fallido en cualquiera de los 2 intentos escapaba
// hasta processItem, donde _dynMapApiError no sabe clasificar un
// SyntaxError plano (sin .fatal) y lo trataba como retryable=false —
// fallaba el item PERMANENTEMENTE por un glitch de formato recuperable.
// Excepción (R21): un error FATAL real de _dynLlmCall (auth/crédito/config)
// no se traga como "sala fallida" — se relanza tal cual para que
// processItem dispare la pausa fatal del ejecutor, igual que en content/exam.
/** Motor de carga horaria: bloque de práctica para las salas SCORM (títulos y objetivos de las fuentes del módulo). */
function _dynScormPracticeBlock(bp, practice) {
  var ids = Array.isArray(practice.sourceChapterIds) ? practice.sourceChapterIds : [];
  var byId = {};
  ((bp && bp.outline) || []).forEach(function (m) { (m.chapters || []).forEach(function (c) { byId[c.id] = c; }); });
  var lines = ids.map(function (id) { var c = byId[id] || {}; return '- ' + (c.title || id) + (c.objective ? ': ' + c.objective : ''); }).join('\n');
  return '\n\n── CAPÍTULO DE PRÁCTICA ──\nEste juego INTEGRA lo que enseñan los capítulos de contenido del módulo:\n' + lines
    + '\nCada sala combina al menos dos de esos temas en una situación completa del sector; no agregues conceptos que no estén en esos capítulos.';
}

async function _dynGenScormRoomV2(cap, templateId, sys, courseContext, outline, attr, ped) {
  var prompt = dynScormV2RoomPrompt(templateId, cap, courseContext, outline, ped);
  var schema = scormV2SchemaFor(templateId);
  // RF-b: el reintento de validación de la sala es un retry pagado.
  var retryAttr = attr ? { itemRunId: attr.itemRunId, callRole: 'validation_retry' } : null;
  try {
    var raw = await _dynLlmCall(sys, prompt, 4000, 3, schema, undefined, attr);
    var clean = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    var data = JSON.parse(clean);
    var v = scormV2ValidateRoomData(templateId, data);
    if (v.ok) return { ok: true, data: data, reason: 'ok' };

    // R25: scormV2RetryPromptFor (06b-scorm-templates.js, cargado antes que
    // este archivo) para que el texto de reintento sea byte-idéntico al del
    // motor legacy (genScormRoomV2).
    var retryPrompt = scormV2RetryPromptFor(prompt, v);
    var raw2 = await _dynLlmCall(sys, retryPrompt, 4000, 3, schema, undefined, retryAttr);
    var clean2 = raw2.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    var data2 = JSON.parse(clean2);
    var v2 = scormV2ValidateRoomData(templateId, data2);
    if (v2.ok) return { ok: true, data: data2, reason: 'ok tras reintento' };
    return { ok: false, data: null, reason: v2.reason };
  } catch (e) {
    if (e && e.fatal === true && !DYN_EXHAUSTED_RETRIES_RE.test((e.msg || e.message || ''))) {
      throw e; // fatal genuino (R21) — no es una "sala fallida", es toda la generación la que debe pausar
    }
    return { ok: false, data: null, reason: (e && (e.msg || e.message || String(e))) || 'error desconocido' };
  }
}

// ════ Por-tipo: exam ════
// Reutiliza tal cual (puras, no leen D/F): _trimExcessQuestions, parseGIFT,
// giftFeedbackHeader, dynGiftSyntaxRef. NO reutiliza examTypeExpectations
// (fija 25 preguntas sin mirar la cantidad real de capítulos del módulo,
// asunción legacy de 3 caps/módulo) — usa dynExamQuestionSplit (44), que
// deriva el reparto de la cantidad REAL de capítulos del módulo (R18/Task5).
//
// Divergencia deliberada de 07-examenes.js/genExamenGift (CLAUDE.md "falla
// silenciosa es el patrón de bug más común… preferir fallar fuerte y
// visible"): el legacy, si el reintento de corrección falla o sigue
// incompleto, GUARDA lo que haya y marca el paso 'done' igual (comentario
// propio: "se guarda incompleto"). El ejecutor dynamic, tras el reintento de
// corrección, vuelve a contar por tipo — si SIGUE faltando algo, falla el
// item (retryable) en vez de subir un examen incompleto como si estuviera
// completo.
async function _dynRunExam(item) {
  var bp = item.blueprint;
  var courseContext = item.context.courseContext;
  var moduleNumber = item.moduleNumber;
  // Motor de carga horaria: la evaluación cubre los capítulos de CONTENIDO (la práctica no tiene texto propio).
  var examModuleChapters = (bp.moduleChapters || []).filter(function (c) { return c.kind !== 'practice'; });
  var chapterTitles = examModuleChapters.map(function (c) { return c.title; });
  var sys = sysG();
  var examChapters = _dynExamChapters(examModuleChapters, await _dynLoadContextSummaries(item));
  var ped = dynPedagogyBlock(item); // Fase 2: estrategia de evaluación (solo exam v3 con perfil pedagógico)
  var prompt = dynExamUnitPrompt(courseContext, bp.outline, bp.module, moduleNumber, chapterTitles, ped) + dynExamContentBlock(examChapters);
  var raw = await _dynLlmCall(sys, prompt, 4096, 3, undefined, undefined, _dynAttr(item, 'main'));
  var cl = raw.replace(/```gift|```/g, '').trim();

  var split = dynExamQuestionSplit(chapterTitles.length);
  var expectedTypes = { multichoice: split.multichoice, truefalse: split.truefalse, match: split.match };
  cl = _trimExcessQuestions(cl, expectedTypes);

  function countByType(text) {
    var parsed = (typeof parseGIFT === 'function') ? parseGIFT(text) : [];
    var byType = { multichoice: 0, truefalse: 0, match: 0, shortanswer: 0 };
    parsed.forEach(function (q) { if (byType[q.type] !== undefined) byType[q.type]++; });
    return byType;
  }

  var byType = countByType(cl);
  var faltantes = [];
  Object.keys(expectedTypes).forEach(function (t) {
    var missing = expectedTypes[t] - (byType[t] || 0);
    if (missing > 0) faltantes.push({ type: t, count: missing });
  });

  if (faltantes.length > 0) {
    var prefix = 'U' + moduleNumber;
    var idNums = [];
    var idRe = new RegExp('::' + prefix + '-(\\d+)::', 'g');
    var idm;
    while ((idm = idRe.exec(cl))) idNums.push(parseInt(idm[1], 10));
    var nextIdNum = (idNums.length ? Math.max.apply(null, idNums) : 0) + 1;
    var correctionPrompt = _dynGiftCorreccionPrompt(courseContext, bp.outline, moduleNumber, faltantes, nextIdNum, ped) + dynExamContentBlock(examChapters);
    var raw2 = await _dynLlmCall(sys, correctionPrompt, 2048, 2, undefined, undefined, _dynAttr(item, 'continuation'));
    var cl2 = raw2.replace(/```gift|```/g, '').trim();
    cl = _trimExcessQuestions(cl + '\n\n' + cl2, expectedTypes);
  }

  var finalByType = countByType(cl);
  var stillMissing = Object.keys(expectedTypes).filter(function (t) { return (finalByType[t] || 0) < expectedTypes[t]; });
  if (stillMissing.length > 0) {
    return { ok: false, error: 'GIFT incompleto tras corrección: faltan ' + stillMissing.join(', '), retryable: true };
  }

  var bal = await _dynBalanceExamAnswers(courseContext, cl, function (p) { return _dynLlmCall(sys, p, 4096, 2, undefined, undefined, _dynAttr(item, 'continuation')); });
  cl = bal.gift;
  var gift = giftFeedbackHeader() + cl;
  var nmErrU = _dynExamNeuromythError(gift);
  if (nmErrU) return nmErrU;
  var fname = (item.moduleId || item.itemRunId) + '_dynamic_exam_gift.gift';
  return {
    ok: true,
    artifacts: [{ type: 'dynamic_exam_gift', content: gift, filename: fname, mimeType: 'text/plain' }],
    summary: Object.assign({ moduleId: item.moduleId, questionCount: split.total, contentGroundedChapters: examChapters.filter(function (c) { return c.summary; }).length, answerBias: bal.stats }, dynPedagogySummary(item))
  };
}

// ════════════════════════════════════════════════════════════════════════
// rulesVersion 2 (R2 — 5B.2.B + Fase 6)
// ════════════════════════════════════════════════════════════════════════
// Despacho por rulesVersion del Manifest del run. v1: exactamente el
// comportamiento de arriba (claim ['content','scorm','exam'], ningún código
// v2 invocado). v2: además course_plan / course_intro / module_intro, y el
// `content` v2 (prompt v1 + Context Package + sidecar context_summary).
var DYN_CLAIM_TYPES_V1 = ['content', 'scorm', 'exam'];
var DYN_CLAIM_TYPES_V2 = ['course_plan', 'course_intro', 'module_intro', 'content', 'scorm', 'exam'];
var DYN_V2_ONLY_TYPES = ['course_plan', 'course_intro', 'module_intro'];
// V2.1 (R11b): rulesVersion 3. `scorm` ya no existe como tipo (pasa a
// `activity` con variant); presentation/video/audio_* los reclama solo el
// worker del backend (scheduler WORKER_ONLY_TYPES), nunca el navegador.
var DYN_CLAIM_TYPES_V3 = ['course_plan', 'course_intro', 'module_intro', 'content', 'experience', 'video_interactions', 'activity', 'exam', 'final_exam'];
var DYN_V3_ONLY_TYPES = ['experience', 'video_interactions', 'activity', 'final_exam', 'presentation', 'audio_welcome', 'audiobook_chapter'];

// Fase 2: `application_activity` se reclama SOLO si el run lo tiene (un backend anterior no conoce el tipo y
// rechazaría el claim entero): el run es la prueba de que el backend lo soporta.
function _dynRunHasApplication(run) {
  return !!(run && Array.isArray(run.items) && run.items.some(function (it) { return it && it.type === 'application_activity'; }));
}
function _dynClaimTypesFor(rulesVersion, withApplication) {
  if (rulesVersion === 3) return DYN_CLAIM_TYPES_V3.slice().concat(withApplication ? ['application_activity'] : []);
  return rulesVersion === 2 ? DYN_CLAIM_TYPES_V2.slice() : DYN_CLAIM_TYPES_V1.slice();
}

// rulesVersion de un run (RunDto de GET …/runs/:id). Contrato R1: el run
// expone `rulesVersion`; si un backend todavía no lo expone, se deriva de
// sus items (un Manifest v1 nunca tiene tipos de scope curso/intro).
function _dynRunRulesVersion(run) {
  if (run && typeof run.rulesVersion === 'number') return run.rulesVersion;
  var items = (run && Array.isArray(run.items)) ? run.items : [];
  for (var j = 0; j < items.length; j++) {
    if (items[j] && DYN_V3_ONLY_TYPES.indexOf(items[j].type) >= 0) return 3;
  }
  for (var i = 0; i < items.length; i++) {
    if (items[i] && DYN_V2_ONLY_TYPES.indexOf(items[i].type) >= 0) return 2;
  }
  return 1;
}

// rulesVersion de un item reclamado. Contrato R1: ClaimedItem.rulesVersion.
// Sin el campo: tipos v2 o un `content` que depende de course_plan ⇒ 2
// (nunca se corre un content v2 por el camino v1 sin contexto).
function _dynItemRulesVersion(item) {
  if (item && typeof item.rulesVersion === 'number') return item.rulesVersion;
  if (item && (DYN_V3_ONLY_TYPES.indexOf(item.type) >= 0 || item.variant !== undefined)) return 3;
  if (item && DYN_V2_ONLY_TYPES.indexOf(item.type) >= 0) return 2;
  var deps = (item && item.dependsOn) || [];
  for (var i = 0; i < deps.length; i++) {
    if (String(deps[i]).indexOf('course_plan:') === 0) return 2;
  }
  return 1;
}

// Carga el artifact course_plan del run desde las dependencias del claim
// (enlazado por item_run_id en el backend) y lo RE-valida contra el outline
// congelado: un plan corrupto o que no calza con el Manifest es un error
// fuerte, nunca un contexto a medias.
async function _dynLoadCoursePlan(item) {
  var deps = (item.dependencyArtifacts || []).filter(function (a) { return a && a.type === 'dynamic_course_plan_json'; });
  if (deps.length === 0) {
    return { ok: false, result: { ok: false, error: 'missing_course_plan_artifact: el item ' + item.itemKey + ' no recibió el artifact dynamic_course_plan_json', retryable: false } };
  }
  if (deps.length > 1) {
    return { ok: false, result: { ok: false, error: 'ambiguous_course_plan_artifact: ' + deps.length + ' artifacts dynamic_course_plan_json para ' + item.itemKey, retryable: false } };
  }
  var dl;
  try {
    dl = await openArtifactJsonById(deps[0].artifactId);
  } catch (e) {
    dl = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!dl || !dl.ok) {
    return { ok: false, result: { ok: false, error: 'course_plan_download_failed: ' + ((dl && dl.error) || 'desconocido'), retryable: true } };
  }
  var v = dynValidateCoursePlan(dl.json, (item.blueprint && item.blueprint.outline) || []);
  if (!v.ok) {
    return { ok: false, result: { ok: false, error: 'course_plan_invalid: el plan del run no calza con el Manifest — ' + v.errors.slice(0, 5).join('; '), retryable: false } };
  }
  return { ok: true, plan: dl.json, artifactId: deps[0].artifactId };
}

function _dynOutlineChapterCount(outline) {
  return (outline || []).reduce(function (t, mo) { return t + ((mo.chapters && mo.chapters.length) || 0); }, 0);
}

// ── course_plan ──
// M7 (fix wave review-rv2): presupuesto de tokens por capítulo con tope. Un
// outline que no entra en UNA llamada (más de DYN_PLAN_CHUNK_MAX_CHAPTERS
// capítulos, o presupuesto estimado > DYN_PLAN_MAX_TOKENS) se planifica por
// partes: un módulo, o tramos de ≤ DYN_PLAN_CHUNK_MAX_CHAPTERS capítulos de un
// módulo grande, en el orden del Manifest (UUIDs del outline). Cada parte se
// valida contra SU sub-outline (con su propio reintento dirigido); el plan
// fusionado se valida contra el outline COMPLETO y se sube como UN artifact.
// Cualquier parte que siga inválida → item fallado retryable, sin artifact
// (nunca un plan parcial). Un stop_reason 'max_tokens' cuenta como inválido.
var DYN_PLAN_MAX_TOKENS = 16000;
var DYN_PLAN_TOKENS_BASE = 2000;
var DYN_PLAN_TOKENS_PER_CHAPTER = 700;
var DYN_PLAN_CHUNK_MAX_CHAPTERS = 20;
var DYN_PLAN_PRIOR_CONCEPTS_CAP = 80;

function _dynPlanTokenBudget(chapterCount) {
  return Math.min(DYN_PLAN_MAX_TOKENS, DYN_PLAN_TOKENS_BASE + chapterCount * DYN_PLAN_TOKENS_PER_CHAPTER);
}

function _dynPlanNeedsChunking(chapterCount) {
  return chapterCount > DYN_PLAN_CHUNK_MAX_CHAPTERS || (DYN_PLAN_TOKENS_BASE + chapterCount * DYN_PLAN_TOKENS_PER_CHAPTER) > DYN_PLAN_MAX_TOKENS;
}

// Partes en orden del Manifest: [{ subOutline: [módulo con su tramo de capítulos] }].
function _dynPlanChunks(outline) {
  var chunks = [];
  (outline || []).forEach(function (mo) {
    var chapters = mo.chapters || [];
    // Un módulo sin capítulos no existe en un Manifest; si apareciera, el
    // plan fusionado no lo tendría y la validación contra el outline completo
    // falla fuerte (retryable), nunca en silencio.
    for (var i = 0; i < chapters.length; i += DYN_PLAN_CHUNK_MAX_CHAPTERS) {
      chunks.push({ subOutline: [Object.assign({}, mo, { chapters: chapters.slice(i, i + DYN_PLAN_CHUNK_MAX_CHAPTERS) })] });
    }
  });
  return chunks;
}

// Una llamada de plan con su reintento dirigido. Devuelve {ok, plan, retried} o {ok:false, errors}.
async function _dynPlanCallWithRetry(sys, prompt, subOutline, maxTok, label, item) {
  var meta = {};
  var raw = await _dynLlmCall(sys, prompt, maxTok, 3, undefined, meta, _dynAttr(item, 'main'));
  var parsed = dynParseCoursePlan(raw, subOutline);
  if (meta.stopReason === 'max_tokens') parsed = { ok: false, errors: ['respuesta truncada (stop_reason=max_tokens)'].concat(parsed.errors || []) };
  if (parsed.ok) return { ok: true, plan: parsed.plan, retried: false };
  console.warn('[dynExecutor:course_plan] ' + label + ' inválido, reintento dirigido: ' + parsed.errors.slice(0, 5).join('; '));
  var meta2 = {};
  var raw2 = await _dynLlmCall(sys, dynCoursePlanRetryPrompt(prompt, parsed.errors), maxTok, 3, undefined, meta2, _dynAttr(item, 'validation_retry'));
  var parsed2 = dynParseCoursePlan(raw2, subOutline);
  if (meta2.stopReason === 'max_tokens') parsed2 = { ok: false, errors: ['respuesta truncada (stop_reason=max_tokens)'].concat(parsed2.errors || []) };
  // Calibración #2: el reintento dirigido también se cortó → no es transitorio (nunca una ronda idéntica más).
  if (!parsed2.ok) return { ok: false, errors: parsed2.errors, truncated: meta2.stopReason === 'max_tokens' };
  return { ok: true, plan: parsed2.plan, retried: true };
}

async function _dynRunCoursePlan(item) {
  var bp = item.blueprint || {};
  var courseContext = item.context.courseContext;
  var outline = bp.outline || [];
  var chapterCount = _dynOutlineChapterCount(outline);
  if (!chapterCount) return { ok: false, error: 'course_plan: el outline del claim no tiene capítulos', retryable: false };
  var sys = dynCoursePlanSys();
  var ped = dynPedagogyBlock(item); // Fase 2: estilo de objetivos y profundidad (solo v3 con perfil pedagógico)
  var plan;
  var retried = false;
  var chunkCount = 0;

  if (!_dynPlanNeedsChunking(chapterCount)) {
    var one = await _dynPlanCallWithRetry(sys, dynCoursePlanPrompt(courseContext, outline, ped), outline, _dynPlanTokenBudget(chapterCount), 'plan', item);
    if (!one.ok) {
      return { ok: false, error: 'plan de conceptos inválido tras reintento dirigido: ' + one.errors.slice(0, 5).join('; '), retryable: !one.truncated };
    }
    plan = one.plan;
    retried = one.retried;
  } else {
    var chunks = _dynPlanChunks(outline);
    chunkCount = chunks.length;
    var merged = { chapters: {}, modules: {} };
    var prior = [];
    var seen = {};
    for (var ci = 0; ci < chunks.length; ci++) {
      var sub = chunks[ci].subOutline;
      var subCount = _dynOutlineChapterCount(sub);
      var label = 'parte ' + (ci + 1) + '/' + chunks.length;
      var prompt = dynCoursePlanChunkPrompt(courseContext, outline, sub, ci + 1, chunks.length, prior.slice(-DYN_PLAN_PRIOR_CONCEPTS_CAP), ped);
      var part = await _dynPlanCallWithRetry(sys, prompt, sub, _dynPlanTokenBudget(subCount), label, item);
      if (!part.ok) {
        return { ok: false, error: 'plan de conceptos inválido tras reintento dirigido (' + label + ', módulo ' + sub[0].id + '): ' + part.errors.slice(0, 5).join('; '), retryable: !part.truncated };
      }
      retried = retried || part.retried;
      var mid = sub[0].id;
      if (!merged.modules[mid]) merged.modules[mid] = part.plan.modules[mid];
      (sub[0].chapters || []).forEach(function (ch) {
        var pc = part.plan.chapters[ch.id];
        merged.chapters[ch.id] = pc;
        (pc.concepts_introduced || []).forEach(function (cpt) {
          var key = String(cpt).trim().toLowerCase().replace(/\s+/g, ' ');
          if (key && !seen[key]) { seen[key] = true; prior.push(String(cpt).trim()); }
        });
      });
    }
    var whole = dynParseCoursePlan(JSON.stringify(merged), outline);
    if (!whole.ok) {
      return { ok: false, error: 'plan de conceptos fusionado inválido: ' + whole.errors.slice(0, 5).join('; '), retryable: true };
    }
    plan = whole.plan;
  }

  var json = dynCanonicalJson(plan);
  var summary = {
    coursePlanSha256: dynSha256Hex(json),
    chapterCount: chapterCount,
    moduleCount: outline.length,
    retried: retried
  };
  if (chunkCount) { summary.chunked = true; summary.chunkCount = chunkCount; }
  Object.assign(summary, dynPedagogySummary(item));
  return {
    ok: true,
    artifacts: [{ type: 'dynamic_course_plan_json', content: json, filename: item.itemRunId + '_dynamic_course_plan_json.json', mimeType: 'application/json' }],
    summary: summary
  };
}

// ── course_intro / module_intro ──
function _dynStripMdFence(raw) {
  return String(raw == null ? '' : raw).trim().replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n?```\s*$/, '').trim();
}

var DYN_URL_OR_DOI_RE = /(https?:\/\/|www\.|\bdoi\s*:|\b10\.\d{4,9}\/\S+)/i;

// I3 (fix wave review-rv2): "Bibliografía sugerida" se valida con la MISMA
// regla y extracción que usa el backend al empaquetar
// (dynExtractSuggestedBibliographyMd, 46): encabezado tolerante y sección no
// vacía. Una intro que el builder no podría separar falla acá, retryable, al
// generarse — nunca se completa para después romper el empaquetado.
function _dynIntroProblems(md, requiredHeadings) {
  var problems = [];
  requiredHeadings.forEach(function (h) {
    if (h === 'Bibliografía sugerida') {
      if (dynExtractSuggestedBibliographyMd(md) === null) problems.push('## Bibliografía sugerida (con al menos una referencia)');
      return;
    }
    var re = new RegExp('^#{1,3}\\s*' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'im');
    if (!re.test(md)) problems.push('## ' + h);
  });
  if (DYN_URL_OR_DOI_RE.test(md)) problems.push('sin URLs ni DOIs (la respuesta incluyó un enlace o DOI: elimínalo)');
  return problems;
}

async function _dynRunIntro(item, kind) {
  var bp = item.blueprint || {};
  var courseContext = item.context.courseContext;
  var planRes = await _dynLoadCoursePlan(item);
  if (!planRes.ok) return planRes.result;
  var sys = dynIntroSys(courseContext);
  var prompt, required, type, fname, summary;
  if (kind === 'course') {
    prompt = dynCourseIntroPrompt(courseContext, bp.outline, planRes.plan);
    required = ['Introducción', 'Metodología', 'Competencias', 'Bibliografía sugerida'];
    type = 'dynamic_course_intro_md';
    fname = item.itemRunId + '_dynamic_course_intro_md.md';
    summary = {};
  } else {
    if (!bp.module || !bp.module.id) return { ok: false, error: 'module_intro: el claim no trae blueprint.module', retryable: false };
    prompt = dynModuleIntroPrompt(courseContext, bp.outline, bp.module, item.moduleNumber, planRes.plan);
    required = ['Presentación del módulo', 'Qué vas a lograr', 'Recorrido', 'Bibliografía sugerida'];
    type = 'dynamic_module_intro_md';
    fname = (item.moduleId || item.itemRunId) + '_dynamic_module_intro_md.md';
    summary = { moduleId: item.moduleId };
  }
  var meta = {};
  var md = _dynStripMdFence(await _dynLlmCall(sys, prompt, 3000, 3, undefined, meta, _dynAttr(item, 'main')));
  var problems = md ? _dynIntroProblems(md, required) : ['texto vacío'];
  if (meta.stopReason === 'max_tokens') problems.unshift('respuesta completa (la anterior se cortó por límite de tokens: stop_reason=max_tokens)');
  var retried = false;
  if (problems.length) {
    retried = true;
    console.warn('[dynExecutor:' + item.type + '] reintento dirigido: ' + problems.join('; '));
    var meta2 = {};
    md = _dynStripMdFence(await _dynLlmCall(sys, dynIntroRetryPrompt(prompt, problems), 3000, 3, undefined, meta2, _dynAttr(item, 'validation_retry')));
    problems = md ? _dynIntroProblems(md, required) : ['texto vacío'];
    if (meta2.stopReason === 'max_tokens') problems.unshift('respuesta truncada (stop_reason=max_tokens)');
    if (problems.length) {
      return { ok: false, error: item.type + ' inválido tras reintento dirigido: falta ' + problems.join('; '), retryable: meta2.stopReason !== 'max_tokens' };
    }
  }
  return {
    ok: true,
    artifacts: [{ type: type, content: md, filename: fname, mimeType: 'text/markdown' }],
    summary: Object.assign(summary, { chars: md.length, coursePlanArtifactId: planRes.artifactId, retried: retried })
  };
}

// ── content v2: prompt v1 + Context Package + sidecar context_summary ──
// Calibración #2: tope de salida del capítulo. El contrato del prompt (5 secciones de 250-400
// palabras + tabla + caso + 2 actividades + glosario de 8-12 términos + sidecar JSON) llega a
// ~3300 palabras ≈ 6300 tokens en español; 13 capítulos reales de staging midieron 12-13.1k
// caracteres (≈3.3-4.1k tokens) y con 4608 Haiku 4.5 truncó 3/3. 8000 = tope del proxy.
var DYN_CONTENT_MAX_TOKENS = 8000;

// Mínimos pedagógicos del capítulo (medidos, no bloquean): quedan en el output_summary para auditar.
function dynContentPedagogy(md, chapterNumber) {
  var text = String(md || '');
  var n = String(chapterNumber || '');
  var sections = 0;
  for (var i = 1; i <= 5; i++) {
    if (new RegExp('^#{1,4}\\s*(?:\\*\\*)?' + n + '\\.' + i + '(?![0-9])', 'm').test(text)) sections++;
  }
  var gIdx = text.search(/^(?:#{1,4}\s*)?(?:\*\*)?[■\s]*Glosario/im);
  var glossaryTerms = 0;
  if (gIdx >= 0) {
    var tail = text.slice(gIdx).split('\n').slice(1);
    for (var j = 0; j < tail.length; j++) {
      if (/^#{1,4}\s/.test(tail[j])) break;
      var isRow = /^\s*\|/.test(tail[j]);
      if (isRow && (/^\s*\|\s*:?-+/.test(tail[j]) || /T[ée]rmino/i.test(tail[j]))) continue; // separador / encabezado de tabla
      if (/^\s*(?:[-*]|\d+\.|\|)\s*\S/.test(tail[j]) || /^\s*\*\*[^*]+\*\*\s*[:—–-]/.test(tail[j])) glossaryTerms++;
    }
  }
  return {
    sections: sections,
    hasTable: /^\s*\|.*\|\s*$\n^\s*\|\s*:?-{3,}/m.test(text),
    activities: (text.match(/Actividad de Apoyo/gi) || []).length,
    glossaryTerms: glossaryTerms,
    words: text.split(/\s+/).filter(Boolean).length
  };
}

async function _dynRunContentV2(item) {
  var bp = item.blueprint;
  var courseContext = item.context.courseContext;
  var planRes = await _dynLoadCoursePlan(item);
  if (!planRes.ok) return planRes.result;

  var built;
  try {
    built = dynBuildContextPackage(dynPackageManifestFromClaim(item), courseContext, planRes.plan, item.chapterId);
  } catch (e) {
    return { ok: false, error: 'context_package_failed: ' + ((e && e.message) || String(e)), retryable: false };
  }

  var sys = dynSysL(courseContext);
  var v1Prompt = dynLibroChapterPrompt(courseContext, bp.outline, bp.chapter, bp.module, item.chapterNumber, item.moduleNumber);
  var prompt = dynContentV2Prompt(v1Prompt, built.contextPackage, dynPedagogyBlock(item));
  var meta = {};
  var raw = await _dynLlmCall(sys, prompt, DYN_CONTENT_MAX_TOKENS, 3, undefined, meta, _dynAttr(item, 'main'));
  if (!raw || !raw.trim()) {
    return { ok: false, error: 'contenido vacío tras generación', retryable: true };
  }
  // I2 (fix wave review-rv2): una respuesta truncada nunca es un capítulo "completo".
  // Calibración #2: stop_reason=max_tokens NO es transitorio — regenerar lo mismo con el mismo
  // tope vuelve a cortarse (3/3 en la calibración #1) y paga cada vez. Falla NO reintentable,
  // visible, con un código estable; la decisión (otro modelo / otro tope) es humana.
  if (meta.stopReason === 'max_tokens') {
    return { ok: false, error: 'CONTENT_TRUNCATED_MAX_TOKENS: el capítulo superó el tope de salida (' + DYN_CONTENT_MAX_TOKENS + ' tokens, stop_reason=max_tokens). No se regenera a ciegas; revisa el modelo elegido o el contrato del capítulo.', retryable: false };
  }
  var ex = dynExtractContextSummary(raw);
  if (ex.status === 'truncated') {
    return { ok: false, error: 'CONTENT_TRUNCATED: ' + ex.errors.join('; ') + '. No se regenera a ciegas.', retryable: false };
  }
  if (!ex.markdown || !ex.markdown.trim()) {
    return { ok: false, error: 'contenido vacío tras quitar el sidecar context_summary', retryable: true };
  }
  // Language QA: el voseo sin otra lectura se corrige solo antes de verificar.
  ex.markdown = _dynLqaFixText(ex.markdown, courseContext);
  // R14: veracidad + tuteo. Un reintento dirigido del capítulo completo; si persiste, falla visible.
  var truthHits = dynLintContentTruth(ex.markdown, courseContext);
  var truthRetried = false;
  // #542 (M2): la concordancia de persona («lo que dijiste el cliente») es barata solo si ya hay un
  // reintento: sola no reescribe un capítulo entero (≈ 16k tokens) ni lo hace fallar; queda en el summary.
  var hardTruth = function (hs) { return hs.filter(function (h) { return !DYN_SOFT_LANG_CODES[h.code]; }); };
  if (hardTruth(truthHits).length) {
    console.warn('[dynExecutor:content] ' + item.itemKey + ': ' + truthHits.length + ' oraciones con datos no verificables/voseo — reintento dirigido');
    var metaT = {};
    var rawT = await _dynLlmCall(sys, prompt + dynContentTruthRetrySuffix(truthHits), DYN_CONTENT_MAX_TOKENS, 3, undefined, metaT, _dynAttr(item, 'validation_retry'));
    if (metaT.stopReason === 'max_tokens') {
      return { ok: false, error: 'CONTENT_TRUNCATED_MAX_TOKENS (reintento de veracidad): el capítulo superó el tope de salida.', retryable: false };
    }
    var exT = dynExtractContextSummary(rawT || '');
    if (exT.status === 'truncated' || !exT.markdown || !exT.markdown.trim()) {
      return { ok: false, error: 'CONTENT_TRUTH_RETRY_INVALID: el reintento de veracidad no produjo un capítulo válido.', retryable: true };
    }
    exT.markdown = _dynLqaFixText(exT.markdown, courseContext);
    var still = hardTruth(dynLintContentTruth(exT.markdown, courseContext));
    if (still.length) {
      return { ok: false, error: 'CONTENT_TRUTH: persisten ' + still.length + ' oraciones con datos no verificables, casos rotulados como reales o voseo tras el reintento dirigido: ' + still.slice(0, 3).map(function (h) { return '[' + h.code + '] ' + h.text.slice(0, 90); }).join(' | '), retryable: true };
    }
    ex = exT;
    truthRetried = true;
  }

  // #583 (M4): un solo formato de moneda en el curso (es-CO «$180.000»): el Markdown sale normalizado, así que
  // todo lo que se genera desde él (experiencia, video, actividad, banco con evidencia textual) lo cita igual.
  var contentMd = ex.markdown;
  var moneyNormalized = 0;
  if (dynCourseIsColombia(courseContext)) {
    var mn = dynNormalizeMoneyEsCo(contentMd);
    contentMd = mn.text;
    moneyNormalized = mn.changed;
  }
  // #583 (M3): listas con nombre del capítulo contra su objetivo (se mide; el capítulo es la fuente de las demás partes).
  var enumLint = dynLintEnumerationsVsObjective(contentMd, (bp.chapter && bp.chapter.objective) || '');
  var contextSummary = ex.contextSummary;
  var source = contextSummary ? 'inline' : null;
  var summaryErrors = ex.errors.slice();
  if (!contextSummary) {
    // Reintento dirigido SOLO del sidecar (no se regenera el capítulo).
    console.warn('[dynExecutor:content] ' + item.itemKey + ': sidecar context_summary ' + ex.status + ' — reintento dirigido');
    try {
      var raw2 = await _dynLlmCall(dynContextSummaryRetrySys(), dynContextSummaryRetryPrompt((bp.chapter && bp.chapter.title) || '', contentMd), 1200, 2, undefined, undefined, _dynAttr(item, 'context_summary_retry'));
      var p2 = dynParseContextSummaryOnly(raw2);
      if (p2.ok) { contextSummary = p2.contextSummary; source = 'retry'; }
      else summaryErrors = summaryErrors.concat(p2.errors);
    } catch (e) {
      if (e && e.fatal === true && !DYN_EXHAUSTED_RETRIES_RE.test((e.msg || e.message || ''))) throw e; // fatal real (R21)
      summaryErrors.push('reintento del sidecar falló: ' + ((e && (e.msg || e.message)) || String(e)));
    }
  }

  var base = (item.chapterId || item.itemRunId);
  var artifacts = [
    { type: 'dynamic_content_md', content: contentMd, filename: base + '_dynamic_content_md.md', mimeType: 'text/markdown' },
    { type: 'dynamic_context_package_json', content: built.canonicalJson, filename: base + '_dynamic_context_package_json.json', mimeType: 'application/json' }
  ];
  var summary = {
    chapterId: item.chapterId,
    chars: contentMd.length,
    maxTokens: DYN_CONTENT_MAX_TOKENS,
    pedagogy: dynContentPedagogy(contentMd, item.chapterNumber),
    contextPackageVersion: built.contextPackage.contextPackageVersion,
    contextPackageSha256: built.contextPackageSha256,
    coursePlanArtifactId: planRes.artifactId,
    truthRetried: truthRetried,
    truthHits: truthHits.slice(0, 8)
  };
  Object.assign(summary, dynPedagogySummary(item));
  if (enumLint.length) summary.enumerationLint = enumLint.slice(0, 5);
  if (contextSummary) {
    // Fix round 1 (m2): el resumen del capítulo (lo leen los exámenes) con el mismo formato de moneda.
    if (dynCourseIsColombia(courseContext)) moneyNormalized += dynNormalizeMoneyDeep(contextSummary);
    var csJson = dynCanonicalJson({
      contextSummaryVersion: 1,
      chapterId: item.chapterId,
      source: source,
      summary: contextSummary.summary,
      concepts_introduced: contextSummary.concepts_introduced,
      key_terms: contextSummary.key_terms
    });
    artifacts.push({ type: 'dynamic_context_summary_json', content: csJson, filename: base + '_dynamic_context_summary_json.json', mimeType: 'application/json' });
    summary.contextSummary = 'present';
    summary.contextSummarySource = source;
  } else {
    // Contenido válido, sidecar ausente: se completa CON MARCA visible
    // (output_summary + auditoría), nunca en silencio.
    console.warn('[dynExecutor:content] ' + item.itemKey + ': context_summary AUSENTE tras reintento — se completa con contextSummary="missing"');
    summary.contextSummary = 'missing';
    summary.contextSummaryErrors = summaryErrors.slice(0, 5);
  }
  if (moneyNormalized) summary.moneyNormalized = moneyNormalized;
  return { ok: true, artifacts: artifacts, summary: summary };
}

// ════ R14 — veracidad del Libro Guía: detector de datos inventados y voseo ════
// Una oración con un porcentaje sobre una población ("el 72% de los docentes"), o con un porcentaje
// junto a una institución/año ("encuesta de la Federación X, 2024: 67%"), o una cita "según el
// estudio/encuesta/informe … (2023)" es casi siempre inventada por el modelo. Un hallazgo → un
// reintento dirigido del capítulo completo; si persiste, el item falla visible (nunca se recorta).
var _DYN_FAB_POP = '(?:docentes|estudiantes|profesores|instituciones|empresas|universidades|ies|aprendices|empleadores|egresados|colegios|usuarios|trabajadores|organizaciones|participantes|encuestados|jovenes|familias)';
// Precisión antes que cobertura (el prompt es el control principal; un falso positivo cuesta un
// reintento pagado): (1) "N% de los <población>"; (2) "según <estudio|encuesta|…> … <año> … N%";
// (3) un porcentaje junto a una INSTITUCIÓN NOMBRADA (con mayúscula) o una sigla conocida.
var DYN_FAB_RES = [
  // Umbrales y metas pedagógicas ("si el 40% de los estudiantes falla", "más del 30% de…", "el 100% de…") NO son datos.
  new RegExp('(?<!\\b(?:si|cuando|mas del|menos del|al menos|hasta el|sobre el|bajo el|supera el|superan el|que el)\\s(?:el\\s)?)\\b(?!100\\s?%)\\d{1,3}(?:[.,]\\d+)?\\s?%\\s+de\\s+(?:los\\s+|las\\s+)?' + _DYN_FAB_POP + '\\b'),
  /segun\s+(?:el|la|un|una|los|las)?\s*(?:estudio|estudios|encuesta|investigacion|informe|reporte|analisis|medicion|diagnostico)\b[^.\n]{0,160}?\b(?:19|20)\d{2}\b[^.\n]{0,160}?\d{1,3}(?:[.,]\d+)?\s?%/,
];
var DYN_FAB_PCT_RE = /\d{1,3}(?:[.,]\d+)?\s?%/;
// Sobre el texto ORIGINAL (mayúsculas): institución nombrada o sigla.
var DYN_FAB_NAMED_RE = /\b(?:Universidad|Corporaci[oó]n Universitaria|Asociaci[oó]n|Federaci[oó]n|Ministerio|Instituto|C[aá]mara de Comercio|Banco Interamericano|Banco Mundial|Fundaci[oó]n|Observatorio|Consejo Nacional)(?:\s+(?:de la|de los|de|del))?\s+[A-ZÁÉÍÓÚÑ]|\b(?:CNA|SENA|ICFES|OCDE|OECD|UNESCO|BID|CEPAL|DANE|MEN|FEDUCC|ASCUN)\b/;
// R14-11: un MULTIPLICADOR atribuido a investigación ("según Hattie, la retroalimentación triplica el
// aprendizaje") es una cifra inventada con otra forma. Solo con atribución en la misma oración: el
// lenguaje figurado ("multiplicar tu impacto", "sin duplicar trabajo") no se marca.
// Solo formas verbales / comparativas (nunca el sustantivo "multiplicación" de un curso de matemáticas).
var DYN_FAB_MULT_RE = /\b(?:duplic(?!acion|ad[oa]s\b)\w*|triplic(?!acion)\w*|cuadruplic(?!acion)\w*|multiplic(?!acion)\w*|(?:\d+|dos|tres|cuatro|cinco|diez)\s+veces\s+(?:mas|mayor|mejor)|(?:el|al) doble|(?:el|al) triple)\b/;
// Atribución REAL (no la mera palabra "estudio"/"evidencia"): sustantivo de investigación + verbo de
// reporte cercano, "según <investigación|expertos|datos>", un autor conocido, o "según <Nombre>".
var _DYN_RESEARCH_NOUN = '(?:investigaci\\w*|investigador\\w*|estudios?|evidencia|meta-?analisis|neurociencia|ciencia|expertos)';
var _DYN_REPORT_VERB = '(?:muestra\\w*|demuestra\\w*|indica\\w*|revela\\w*|encontr\\w*|sugiere\\w*|senala\\w*|destaca\\w*|confirma\\w*|comprueba\\w*|comprob\\w*|afirma\\w*|report\\w*|document\\w*)';
var DYN_FAB_RESEARCH_RE = new RegExp(
  '\\b' + _DYN_RESEARCH_NOUN + '\\b[^.;:]{0,70}?\\b' + _DYN_REPORT_VERB + '\\b'
  + '|\\bsegun\\s+(?:(?:el|la|los|las)\\s+)?(?:' + _DYN_RESEARCH_NOUN + '|datos)\\b'
  + '|\\b(?:hattie|wiliam|marzano|ebbinghaus|dweck|sweller)\\b');
// Expresiones de estudio/evidencia que NO atribuyen nada ("estudios de caso", "evidencia de aprendizaje").
var DYN_FAB_NOT_RESEARCH_RE = /\b(?:casos? de estudio|estudios? de caso|(?:plan|planes|tiempo|habitos|tecnicas|grupo|unidad|objeto|metodo|hoja) de estudios?|estudio independiente|evidencias? de (?:aprendizaje|proceso|desempeno))\b/g;
// R14-12: los casos del curso son ilustrativos; rotularlos "Caso real:" / "Ejemplo real:" presenta una
// historia inventada como verídica (#241: experiencia cap. 4 y 3 presentaciones). Solo el RÓTULO (seguido
// de ":" o raya): "describe un caso real que conozcas" o "¿se parece al caso real?" no se marcan.
// Rótulo al inicio del segmento (tras #, *, ■, -, >, «, comillas o raya), con ":" o raya con espacios,
// o un encabezado markdown sin ":". Se excluye cuando lo que sigue invita al docente a usar SU caso
// ("un caso real: el de tu aula", "elige…"). Sustantivos: caso/ejemplo/historia (no "situación real:",
// que es una consigna habitual).
var DYN_FAB_REAL_LABEL_RE = /(?:^|[#*>\u25a0\u00ab\u2014"(-])\s*(?:basad[oa] en\s+)?(?:un[ao]?\s+)?(?:caso|ejemplo|historia)s?\s+(?:real(?:es)?|veridic[oa]s?|verdader[oa]s?)\b[*_\u00bb"']*\s*(?::|\s[\u2014\u2013-]\s)(?!\s*(?:el de tu|la de tu|tu propi[oa]|tus propi[oa]s|elige|piensa|recuerda|describe))/;
// R14-13 (review final #241): (1) capacidades/limitaciones de la IA afirmadas como permanentes ("no
// accede a internet", "(y no hará)") — falsas o caducas en 2026 según la herramienta; salvo que la frase
// ya las relativice; (2) siglas de leyes de otro país (LOPD es España) en un curso de otro país;
// (3) el neuromito VAK aplicado ("para quien es visual", "estudiantes kinestésicos").
// El sujeto debe ser la IA (review: "los estudiantes no acceden a internet desde casa" es un dato de
// conectividad legítimo, no una afirmación sobre la herramienta).
// "modelo/herramienta/asistente" solo con contexto de IA (review: "la herramienta de videollamada", "el
// modelo de gestión escolar", un asistente humano).
var _DYN_AI_SUBJ = '(?:\\bia\\b|inteligencia artificial|generativ\\w*|chatbot|(?:modelo|herramienta|asistente)s?\\s+(?:de\\s+(?:ia|lenguaje|inteligencia artificial)|conversacional))';
// También sin sujeto explícito cuando la oración EMPIEZA con la negación (ítem de lista sobre la herramienta)
// o la acompaña "fecha de corte".
var DYN_OUTDATED_CLAIM_RE = new RegExp('\\((?:y )?no hara\\)|^[\\s\\-*\\u2022|]*(?:no|nunca)\\s+(?:accede|tiene acceso|busca|navega)\\s+(?:a |en |por )?(?:la web|internet)|\\b(?:no|nunca)\\s+(?:accede|tiene acceso|busca|navega)\\s+(?:a |en |por )?(?:la web|internet)[^.]{0,80}fecha de corte|' + _DYN_AI_SUBJ + '[^.;]{0,40}?\\b(?:no|nunca)\\s+(?:accede|acceden|puede acceder|pueden acceder|tiene acceso|tienen acceso|podra acceder|busca|buscan|navega|navegan|puede navegar)\\s+(?:a |en |por )?(?:la web|internet)|\\bbusca informacion (?:de|en) internet\\b[^.]{0,20}\\bno\\b|' + _DYN_AI_SUBJ + '[^.;]{0,40}?\\bno (?:recuerda (?:conversaciones|sesiones) anteriores|tiene memoria entre (?:sesiones|conversaciones))');
var DYN_OUTDATED_HEDGE_RE = /\b(?:algunas|algunos|ciertas|depende|segun la herramienta|varia[n]?|salvo)\b/;
var DYN_OUTDATED_CONNECTIVITY_RE = /\b(?:estable|conexion|senal|sede|rural(?:es)?|en casa|desde casa|conectividad)\b/;
var DYN_OUTDATED_NOT_AI_RE = /\b(?:estudiantes?|alumnos?|aprendices|colegios?|escuelas?|zonas?|hogar(?:es)?|familias?|grupo|conectividad|sede)\b[^.;]{0,30}\bno\s+(?:acceden?|tienen?|pueden)/;
var DYN_FOREIGN_LAW_RE = /\blopd(?:gdd)?\b/;
var DYN_FOREIGN_LAW_CONTEXT_RE = /espan|europe|rgpd|gdpr|a diferencia/;
var DYN_CONTENT_NEUROMYTH_RE = /\bquien(?:es)? (?:es|son) (?:visual(?:es)?|auditiv\w*|kinestesic\w*)\b|\b(?:estudiantes?|alumnos?|aprendices?) (?:visuales|auditivos|kinestesicos)\b/;
var DYN_FAB_REAL_HEADING_RE = /^\s*#+\s*(?:un[ao]?\s+)?(?:caso|ejemplo|historia)s?\s+(?:real(?:es)?|veridic[oa]s?)\b/;
// Oraciones explícitamente hipotéticas o ilustrativas: nunca se marcan (así lo pide el prompt).
var DYN_FAB_HYPO_RE = /(hipotetic|imagina|supon|supongamos|por ejemplo|ejemplo ilustrativo|digamos que|pongamos que)/;
var DYN_VOSEO_RE = /(?:^|[^\p{L}])(vos|tenés|podés|querés|sabés|hacés|decís|usás|pensás|aprendés|diseñás|adaptás|verificás|validás|traducís|conocés|implementás|comenzás|ponés|corrés|escalás|prevenís|violás|iterás|necesitás|trabajás|creás|elegís|escribís|revisás|preparás|evaluás|enseñás|buscás|probás|empezás|seguís|entendés|iterá|mirá|revisá|reformulá|fijate|tené|hacé|pensá|probá|usá|decí|poné|vení|andá|contá|prestá|tomá|guardá|compará|anotá|buscá|creá|diseñá|adaptá|verificá|validá|aplicá|analizá|identificá|imaginá|recordá|acordate|imaginate|preguntate)(?=$|[^\p{L}])/iu;

function _dynFold(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

// EV5 (auditoría P12): español de España en un curso latinoamericano («vuestras entregas») y palabras
// en inglés que el modelo dejó sin traducir («es contextualized»). Lista corta y sin préstamos
// aceptados (software, feedback, marketing…): solo conectores y palabras que nunca se usan en español.
var DYN_VOSOTROS_RE = /(?:^|[^\p{L}])(vosotr[oa]s|vuestr[oa]s?|os\s+(?:recomiendo|recomendamos|pido|pedimos|invito|invitamos|animo|animamos|propongo|proponemos))(?=$|[^\p{L}])/iu;
var DYN_ENGLISH_RE = /(?:^|[^\p{L}])(contextualized|however|therefore|furthermore|moreover|nevertheless|meanwhile|whereas|although|meaningful)(?=$|[^\p{L}])/iu;
// #542 (M2): concordancia de persona — un verbo en 2.ª persona (pretérito: «dijiste», «atendiste») con una
// persona como sujeto o sin la «a» personal: «lo que dijiste el cliente» (→ «lo que dijo el cliente»),
// «cuando atendiste el cliente» (→ «al cliente»). Sobre texto plegado (sin tildes). Barato y acotado: solo
// tras que/cuando/como/si/donde y con un sustantivo de persona; fuera las palabras que terminan igual.
var DYN_GRAMMAR_PERSON_RE = /(?:^|[^a-z])(?:que|cuando|como|si|donde)\s+(?:(?:le|les|lo|la|los|las|me|nos|te)\s+)?([a-z]{3,}(?:aste|iste))\s+(?:el|la|los|las)\s+(?:client[ea]s?|usuari[oa]s?|pacientes?|estudiantes?|alumn[oa]s?|colaborador(?:a|es|as)?|trabajador(?:a|es|as)?|jef[ea]s?|supervisor(?:a|es|as)?|proveedor(?:a|es|as)?|comprador(?:a|es|as)?|consumidor(?:a|es|as)?|emplead[oa]s?|asesor(?:a|es|as)?|vendedor(?:a|es|as)?|companer[oa]s?|docentes?|profesor(?:a|es|as)?|operari[oa]s?|tecnic[oa]s?|gerentes?|huespedes|huesped|visitantes?|ciudadan[oa]s?)(?![a-z])/;
var DYN_GRAMMAR_PERSON_NOT_VERB = { viste: 1, triste: 1, existe: 1, consiste: 1, insiste: 1, resiste: 1, asiste: 1, persiste: 1, desiste: 1, subsiste: 1, gaste: 1, desgaste: 1, baste: 1, contraste: 1, traste: 1, embiste: 1, reviste: 1 };
// Códigos de idioma «blandos»: piden reintento en los items JSON (1.er intento) pero nunca hacen fallar
// una parte, y en el capítulo (markdown) solo viajan con un reintento que ya iba a ocurrir.
var DYN_SOFT_LANG_CODES = { GRAMMAR_PERSON: true };
function dynLintGrammarPerson(text) {
  var m = DYN_GRAMMAR_PERSON_RE.exec(_dynFold(text));
  return !!(m && !DYN_GRAMMAR_PERSON_NOT_VERB[m[1]]);
}
// Cursos de idiomas o de lengua/literatura citan inglés o textos con «vosotros» a propósito: no se marcan.
var DYN_LANGUAGE_COURSE_RE = /ingl[eé]s|english|idioma|lengua|literatura|castellano|biling|traduc/i;
function _dynIsLanguageCourse(courseContext) {
  var c = courseContext || {};
  return DYN_LANGUAGE_COURSE_RE.test([c.nombre, c.sector, c.contexto, c.obj, c.comp].filter(function (x) { return typeof x === 'string'; }).join(' '));
}
// Citas y referencias: una obra en inglés («Understanding by Design: … Meaningful Learning»), un texto
// citado entre comillas o una referencia con año entre paréntesis no son el idioma del curso.
// Una línea es referencia si tiene forma de cita («Apellido, X. … (año)» o «Apellido, Nombre (año)») o
// está bajo un título de Bibliografía/Referencias; no basta con mencionar un año o la palabra «editorial».
// Formas de cita: «Apellido, X. … (año)» / «Apellido, Nombre (año)», o autor institucional APA
// «Organización Mundial de la Salud. (2020).» (punto justo después del año entre paréntesis).
var DYN_REFERENCE_RE = /^\s*(?:[-*•]|\d{1,3}[.)])?\s*(?:[A-ZÁÉÍÓÚÑ][\p{L}'’-]+,\s+(?:[A-ZÁÉÍÓÚÑ]\.|[A-ZÁÉÍÓÚÑ][\p{L}'’-]+)[^\n]*?\(\s*(?:1[5-9]|20)\d{2}[a-z]?\s*\)|[A-ZÁÉÍÓÚÑ][^().\n]{2,160}\.\s*\(\s*(?:1[5-9]|20)\d{2}[a-z]?\s*\)\s*\.)/u;
// Título de sección (markdown #, negrita o numerado) que menciona la bibliografía en cualquier posición
// («## Evaluación y Bibliografía», «**Referencias**», «## 5. Fuentes consultadas»).
var DYN_HEADING_LINE_RE = /^\s*(?:#{1,6}\s*|\*\*[^*\n]{1,80}\*\*\s*$|\d{1,2}[.)]\s+[A-ZÁÉÍÓÚÑ][^.,:;()\n]{0,50}$)/;
// El título debe SER la bibliografía («Bibliografía», «Evaluación y bibliografía», «Referencias
// bibliográficas», «Fuentes consultadas», «5. Bibliografía y fuentes»), no un tema que contenga la
// palabra («Fuentes de energía renovable», «Referencias cruzadas»).
var DYN_BIB_HEADING_RE = /^(?:\d{1,2}[.)]\s*)?(?:evaluaci[oó]n\s+y\s+)?(?:bibliograf[íi]a|referencias(?:\s+bibliogr[áa]ficas)?|fuentes(?:\s+consultadas|\s+bibliogr[áa]ficas)?|lecturas\s+recomendadas|para\s+profundizar)(?:\s+y\s+(?:fuentes|referencias|bibliograf[íi]a|recursos))?\s*[:.]?$/i;
function _dynHeadingText(line) { return String(line).replace(/^\s*#{1,6}\s*/, '').replace(/\*\*/g, '').trim(); }
function _dynStripQuotes(s) { return String(s).replace(/«[^»]*»|"[^"]*"|“[^”]*”/g, ' '); }

/** Oraciones sospechosas (máx. 8) del texto: datos inventados y, si el país no usa voseo, voseo. */
function dynLintContentTruth(text, courseContext, illustrative, noLang) {
  var hits = [];
  // Language QA (piloto): español neutro para cualquier país (sin excepción de voseo ni de España).
  var voseoOk = false;
  var langCourse = _dynIsLanguageCourse(courseContext);
  // Una referencia (línea con año entre paréntesis, «Ed.», DOI…) se parte en varias «oraciones» al
  // separar por «. »: se decide por línea si es referencia, antes de partir.
  var sents = [];
  var inBibSection = false;
  String(text || '').split(/\n+/).forEach(function (line) {
    if (DYN_HEADING_LINE_RE.test(line)) inBibSection = DYN_BIB_HEADING_RE.test(_dynHeadingText(line));
    var lineRef = inBibSection || DYN_REFERENCE_RE.test(line);
    line.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"«(])/).forEach(function (s) { sents.push({ s: s, ref: lineRef }); });
  });
  sents.forEach(function (entry) {
    var sent = entry.s;
    if (hits.length >= 8 || !sent.trim()) return;
    var f = _dynFold(sent);
    var isTableRow = /^\s*\|/.test(sent);
    // Todos los códigos de la oración (review: un retorno temprano ocultaba voseo o datos en la misma frase).
    var t200 = sent.trim().slice(0, 200);
    var paisF = _dynFold((courseContext && courseContext.pais) || '');
    var special = false;
    if (DYN_FAB_REAL_LABEL_RE.test(f) || DYN_FAB_REAL_HEADING_RE.test(f)) { hits.push({ code: 'REAL_LABEL', text: t200 }); special = true; }
    if (DYN_OUTDATED_CLAIM_RE.test(f) && !DYN_OUTDATED_HEDGE_RE.test(f) && !DYN_OUTDATED_NOT_AI_RE.test(f) && !DYN_OUTDATED_CONNECTIVITY_RE.test(f)) { hits.push({ code: 'OUTDATED_CLAIM', text: t200 }); special = true; }
    if (paisF && paisF.indexOf('espana') < 0 && DYN_FOREIGN_LAW_RE.test(f) && !DYN_FOREIGN_LAW_CONTEXT_RE.test(f)) { hits.push({ code: 'FOREIGN_LAW', text: t200 }); special = true; }
    if (DYN_CONTENT_NEUROMYTH_RE.test(f) && !DYN_NEUROMYTH_DEBUNK_RE.test(f)) { hits.push({ code: 'NEUROMYTH', text: t200 }); special = true; }
    // Además de los códigos especiales, la misma oración pasa por el chequeo de datos inventados / voseo.
    // Edu Phase A: en un worked_example los datos son hipotéticos y Cursia los rotula «Datos del caso
    // (ilustrativos)»: solo se omite la regla "N % de los <población>" (un dato del caso, p. ej. "18 % de
    // los trabajadores"). Siguen marcándose "según <estudio> … año … N %", el % junto a una institución
    // nombrada y los multiplicadores atribuidos a investigación, además de «real», IA, leyes, neuromitos y voseo.
    var fabRes = illustrative ? DYN_FAB_RES.slice(1) : DYN_FAB_RES;
    var fab = !isTableRow && !DYN_FAB_HYPO_RE.test(f) && (fabRes.some(function (re) { return re.test(f); })
      || (DYN_FAB_PCT_RE.test(f) && DYN_FAB_NAMED_RE.test(sent))
      || (DYN_FAB_MULT_RE.test(f) && (DYN_FAB_RESEARCH_RE.test(f.replace(DYN_FAB_NOT_RESEARCH_RE, ' ')) || (DYN_FAB_NAMED_RE.test(sent) && new RegExp('\\b' + _DYN_REPORT_VERB + '\\b').test(f)))));
    if (fab) hits.push({ code: 'FABRICATED_DATA', text: sent.trim().slice(0, 200) });
    // Re-review piloto M-a: el código y las URLs no son prosa (mismo enmascarado que Language QA).
    else if (!voseoOk && DYN_VOSEO_RE.test(typeof _lqaMask === 'function' ? _lqaMask(sent).masked : sent)) hits.push({ code: 'VOSEO', text: sent.trim().slice(0, 200) });
    if (!langCourse && !noLang && !isTableRow && !entry.ref) {
      var unquoted = _dynStripQuotes(sent);
      if (DYN_VOSOTROS_RE.test(unquoted)) hits.push({ code: 'VOSOTROS', text: t200 });

      if (DYN_ENGLISH_RE.test(unquoted)) hits.push({ code: 'ENGLISH', text: t200 });
      if (dynLintGrammarPerson(unquoted)) hits.push({ code: 'GRAMMAR_PERSON', text: t200 });
    }
  });
  // Language QA (review piloto I4): la MISMA función que el servidor (lqaMarkdownFindings: bibliografía y referencias fuera,
  // tablas dentro, código/URLs fuera), sobre el texto completo; exención solo por nombre/sector del curso (I3).
  if (!noLang && typeof lqaMarkdownFindings === 'function' && !(typeof lqaIsLanguageCourse === 'function' && lqaIsLanguageCourse(courseContext))) {
    lqaMarkdownFindings(text, 8).forEach(function (h) {
      if (hits.length >= 12) return;
      if (hits.some(function (x) { return x.code === h.code && x.text === h.text; })) return;
      hits.push({ code: h.code, text: h.text, lqa: h });
    });
  }
  return hits;
}

/** Language QA: corrección automática del voseo (nunca en cursos de idiomas o de lengua/literatura). */
function _dynLqaExempt(courseContext) { return typeof lqaIsLanguageCourse === 'function' && lqaIsLanguageCourse(courseContext); }
function _dynLqaFixText(text, courseContext) {
  if (typeof lqaFixText !== 'function' || _dynLqaExempt(courseContext)) return text;
  return lqaFixText(text).text;
}
function _dynLqaFixDeep(obj, courseContext) {
  if (typeof lqaFixDeep !== 'function' || _dynLqaExempt(courseContext)) return 0;
  return lqaFixDeep(obj).length;
}

/** Hallazgos de veracidad/tuteo en todos los strings de un JSON (cada string por separado). */
function _dynJsonTruthHits(value, courseContext) {
  var out = [];
  var inBib = false;
  (function walk(v, k, ill) {
    if (out.length >= 8) return;
    if (typeof v === 'string') { if (k !== 'chapterId' && k !== 'itemKey' && k !== 'id') out.push.apply(out, dynLintContentTruth(v, courseContext, ill, inBib)); return; }
    if (Array.isArray(v)) { v.forEach(function (x) { walk(x, k, ill); }); return; }
    if (v && typeof v === 'object') {
      var ill2 = ill || (typeof DYN_VC_ILLUSTRATIVE_TYPES !== 'undefined' && DYN_VC_ILLUSTRATIVE_TYPES.indexOf(v.type) >= 0);
      Object.keys(v).forEach(function (kk) {
        var was = inBib;
        if (kk === 'bibliography' || kk === 'references' || kk === 'referencias') inBib = true;
        walk(v[kk], kk, ill2);
        inBib = was;
      });
    }
  })(value, null, false);
  return out.slice(0, 8);
}

function _dynTruthHitLabel(code, hit) {
  if (hit && hit.lqa && typeof lqaHitLabel === 'function') return lqaHitLabel(hit.lqa);
  if (code === 'VOSEO') return 'voseo';
  if (code === 'VOSOTROS') return 'español de España (vosotros/vuestro): usa tú o ustedes';
  if (code === 'ENGLISH') return 'palabra en inglés sin traducir: escríbela en español';
  if (code === 'GRAMMAR_PERSON') return 'concordancia de persona: el sujeto es la otra persona, no tú («lo que dijiste el cliente» → «lo que dijo el cliente»; «atendiste el cliente» → «atendiste al cliente»)';
  if (code === 'REAL_LABEL') return 'caso ilustrativo rotulado como real: quita el rótulo «real», usa «Caso ilustrativo»';
  if (code === 'OUTDATED_CLAIM') return 'capacidad o limitación de la IA afirmada como permanente: dilo como "depende de la herramienta" (algunas buscan en la web o recuerdan conversaciones)';
  if (code === 'FOREIGN_LAW') return 'sigla o ley de otro país: usa el nombre oficial de la ley del país del curso (en Colombia, Ley 1581 de 2012 / Habeas Data)';
  if (code === 'NEUROMYTH') return 'neuromito de los estilos VAK: no asignes formatos a "estudiantes visuales/auditivos/kinestésicos"; varía formatos por necesidad o accesibilidad';
  return 'dato/estudio/cifra no verificable, quítalo o preséntalo como hipotético';
}

function dynContentTruthRetrySuffix(hits) {
  return '\n\nCORRECCIÓN OBLIGATORIA: tu versión anterior incluía estas oraciones no aceptables:\n'
    + hits.map(function (h) { return '- [' + _dynTruthHitLabel(h.code, h) + '] ' + h.text; }).join('\n')
    + '\nReescribe el capítulo COMPLETO: sin estadísticas, porcentajes, estudios, encuestas, instituciones ni citas inventadas (si ilustras con números, di que son hipotéticos) y en español latinoamericano neutro con tuteo (tú): nunca voseo, «vosotros» ni regionalismos.';
}

async function _dynRunItemV2(item) {
  if (item.type === 'course_plan') return _dynRunCoursePlan(item);
  if (item.type === 'course_intro') return _dynRunIntro(item, 'course');
  if (item.type === 'module_intro') return _dynRunIntro(item, 'module');
  if (item.type === 'content') return _dynRunContentV2(item);
  if (item.type === 'scorm') return _dynRunScorm(item); // igual que v1 (spec §3)
  if (item.type === 'exam') return _dynRunExam(item);   // igual que v1 (spec §3)
  return { ok: false, error: 'tipo no soportado por el ejecutor del navegador (v2): ' + item.type, retryable: false };
}

async function _dynRunItem(item) {
  var rulesVersion = _dynItemRulesVersion(item);
  if (rulesVersion === 3) {
    // Motor pedagógico Fase 2: un brief pedagógico roto es un desfase de contrato (determinista), no un error
    // transitorio: falla SOLO este item, visible y sin reintentos (nunca se genera sin el diseño).
    try { return await _dynRunItemV3(item); }
    catch (e) {
      if (/PEDAGOGY_BRIEF_INVALID/.test(String((e && e.message) || e))) {
        return { ok: false, error: 'PEDAGOGY_BRIEF_INVALID: el diseño pedagógico del item ' + item.itemKey + ' llegó con una forma inválida (versiones de Cursia desalineadas); recarga la página', retryable: false };
      }
      throw e;
    }
  }
  if (rulesVersion === 2) return _dynRunItemV2(item);
  if (rulesVersion !== 1) {
    return { ok: false, error: 'rulesVersion no soportado por el ejecutor del navegador: ' + rulesVersion, retryable: false };
  }
  if (item.type === 'content') return _dynRunContent(item);
  if (item.type === 'scorm') return _dynRunScorm(item);
  if (item.type === 'exam') return _dynRunExam(item);
  return { ok: false, error: 'tipo no soportado por el ejecutor del navegador: ' + item.type, retryable: false };
}

// ════════════════════════════════════════════════════════════════════════
// rulesVersion 3 (V2.1 — R11b): items LLM del navegador
//   experience · course_intro/module_intro (JSON) · video_interactions ·
//   activity (h5p; scorm = motor SCORM v2 de siempre) · final_exam
// ════════════════════════════════════════════════════════════════════════
// Contrato (fail loud, CLAUDE.md "Trampas conocidas"):
//   - JSON estricto (fence-stripping de 46, _dynStripJsonFence) + validación
//     del cliente con espejos de los validadores del backend (R2 / R7 / R8 /
//     R11a). Inválido → UN reintento dirigido con la lista de errores →
//     inválido otra vez → el item FALLA (retryable). Nunca se completa un
//     payload inválido. El backend re-valida al completar y es autoritativo.
//   - Todo dato estructural (chapterId, itemKey, duración del video, plan de
//     checkpoints, tipo h5p, passPercentage) lo pone Cursia, nunca el LLM.

// Versiones de prompt (metadata del item run, audit §N.3).
var DYN_V3_PROMPT_VERSIONS = {
  experience: 'v21-exp-6',
  course_intro: 'v21-cintro-4', // #542 (M1): normas con cifras (fix round 3, antes v21-cintro-3: sin número) + logros en infinitivo
  module_intro: 'v21-mintro-4', // ídem (antes v21-mintro-3)
  video_interactions: 'v21-vint-4', // #542 (I1): reglas anti-patrón de respuesta (antes v21-vint-2)
  activity: 'v21-h5p-3',
  final_exam: 'v21-final-2'
};
// Fase 2: Actividad de Aplicación + solucionario (2 pasadas). Aparte para no mover DYN_V3_PROMPT_VERSIONS.
var DYN_V3_APPLICATION_PROMPT_VERSION = 'v21-app-1';
// EV6 IV avanzado: video_interactions schemaVersion 2 (pausas para pensar). La ruta schemaVersion 1
// (Manifests sin `ivAdvanced`) sigue reportando DYN_V3_PROMPT_VERSIONS.video_interactions.
var DYN_V3_VINT_V2_PROMPT_VERSION = 'v21-vint-5'; // #542 (I1) (antes v21-vint-3)
// EV6 H5P v2 (H3 fix round 1): versión del prompt del caso ramificado (branchingscenario). Los prompts de
// questionset/dragtext/blanks no cambiaron y siguen reportando DYN_V3_PROMPT_VERSIONS.activity. El backend
// no exige una versión única por tipo de item (promptVersion solo gatea reglas de la experiencia).
// #542 (I1) fix round 1 (m8): solo el prompt del cuestionario cambió (dragtext/blanks siguen en v21-h5p-3).
var DYN_V3_QS_PROMPT_VERSION = 'v21-h5p-5';
var DYN_V3_BS_PROMPT_VERSION = 'v21-h5p-8'; // #583 (I4): no recorrer el procedimiento del capítulo + mejor opción nunca la más larga por decisión (antes v21-h5p-6)
// #583 (I2): DragText para teléfono (objetivo DYN_DRAGTEXT_MOBILE: ≤ 300 caracteres, 4–5 huecos de ≤ 14, 2 distractores;
// pasarse es blando salvo > 600 caracteres o > 6 huecos); sin el anuncio del backend sigue v21-h5p-3.
var DYN_V3_DT_PROMPT_VERSION = 'v21-h5p-7';
function dynDragTextMobileSupported(item) {
  var f = _dynClaimField(item, ['activityFeatures']);
  return _dynIsPlainObject(f) && f.dragTextDistractors === true;
}
// #583: códigos de los lints de calidad (observabilidad en output_summary.qualLint).
var DYN_QUAL_LINT_CODES = ['WE_ARITH', 'WE_TOTAL', 'WE_REMAINDER', 'ENUM_MISMATCH', 'BS_OPTION_LONGEST', 'BS_CASE_SKELETON', 'DRAGTEXT_MOBILE'];
function _dynQualSummary(res) {
  var pick = function (errs) { return _dynErrCodes(errs).filter(function (c) { return DYN_QUAL_LINT_CODES.indexOf(c) >= 0; }); };
  var first = pick(res && res.firstErrors);
  var kept = pick(res && res.softWarnings);
  var o = {};
  if (first.length || kept.length) o.qualLint = { firstCodes: first, keptCodes: kept, softAccepted: kept.length > 0 };
  if (res && res.moneyNormalized) o.moneyNormalized = res.moneyNormalized;
  return o;
}
// EV6 H5P v2: tipos de actividad h5p que SOLO existen en Manifests con activityTypeRules = 2. Nunca
// salen de la rotación por hash: el ejecutor los acepta solo si el claim dice activityTypeSource 'manifest'.
var DYN_H5P_MANIFEST_ONLY_TYPES = ['branchingscenario'];
// EV6 P2 (F1): versiones del banco JSON (dynamic_exam_bank_json). Solo las lee
// el modo banco (F2); la ruta GIFT vigente sigue con DYN_V3_PROMPT_VERSIONS.
// #542 (I3): final con «no repitas» de los módulos (v21-final-4). BANKOPT: holgura por hoja + prompt en
// partes con caché (fuente del capítulo primero, cantidades al final) → v21-exam-3 / v21-final-5.
// Fix round 4 (R3): pedir la oración completa como evidencia (sin cortar negación/condición) → v21-exam-4 / v21-final-6.
var DYN_V3_BANK_PROMPT_VERSIONS = { exam: 'v21-exam-4', final_exam: 'v21-final-6' };

// P3 (fix I3): el prompt v21-exp-6 (why/apply) se usa SOLO si el backend anuncia que los acepta
// (claim de la experiencia: `experienceFeatures.eduFields === true`). Con un backend anterior (deploy
// del frontend primero), el ejecutor se comporta como v21-exp-5: sin why/apply en el prompt ni en el JSON.
var DYN_V3_EXPERIENCE_PROMPT_FALLBACK = 'v21-exp-5';
function _dynExperienceEduFields(item) {
  var f = _dynClaimField(item, ['experienceFeatures']);
  return _dynIsPlainObject(f) && f.eduFields === true;
}
function _dynExperiencePromptVersion(item) {
  return _dynExperienceEduFields(item) ? DYN_V3_PROMPT_VERSIONS.experience : DYN_V3_EXPERIENCE_PROMPT_FALLBACK;
}
// Sin soporte del backend: why/apply se quitan (el validador anterior los rechazaría como UNKNOWN_FIELD).
function _dynStripEduFields(doc, repairs) {
  var mv = _dynIsPlainObject(doc) && _dynIsPlainObject(doc.movements) ? doc.movements : null;
  if (!mv) return;
  DYN_VC_MOVEMENT_IDS.forEach(function (m) {
    (Array.isArray(mv[m]) ? mv[m] : []).forEach(function (c, i) {
      if (!_dynIsPlainObject(c)) return;
      ['why', 'apply'].forEach(function (k) {
        if (k in c) { delete c[k]; repairs.push({ code: 'EDU_FIELD_DROPPED', path: '$.movements.' + m + '[' + i + '].' + k, reason: 'BACKEND_WITHOUT_EDU_FIELDS' }); }
      });
    });
  });
}

// passingGrade por defecto (DECISIONES VIGENTES: 70). Solo se usa si el
// claim no trae el passPercentage del perfil de evaluación; queda marcado en
// output_summary.passPercentageSource ('claim' | 'default').
var DYN_DEFAULT_PASSING_GRADE = 70;

// ── Hook de atribución FinOps (RF-b, integrado) ──
// Devuelve el descriptor {itemRunId, callRole} del item reclamado; _dynLlmCall
// arma por intento x-cursia-item-run-id / x-cursia-call-role / x-cursia-attempt
// (1 = primer intento de ese rol) y los pasa como `extraHeaders` de api().
// Sin item run → {} (llamada idéntica a la de siempre).
// role ∈ 'main' | 'validation_retry' | 'continuation' | 'context_summary_retry'.
function _dynLlmCallHeaders(item, role, attempt) {
  return _dynAttr(item, role) || {};
}

function _dynV3Llm(item, role, sys, prompt, maxTok, metaOut) {
  return _dynLlmCall(sys, prompt, maxTok, 3, undefined, metaOut, _dynLlmCallHeaders(item, role, item && item.attempt));
}

// ════ Espejos de los lints R2 (RESOURCE_MENTION / QUANTITY_CLAIM) ════
// Misma normalización (NFD, sin diacríticos, minúsculas) y mismos límites de
// palabra Unicode que src/modules/visual-components/validate.ts.
function _dynLintNormalize(text) {
  return String(text == null ? '' : text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
var _DYN_WB_START = '(?<![\\p{L}\\p{N}_])';
var _DYN_WB_END = '(?![\\p{L}\\p{N}_])';
// Fix round 1 (review G5 I1 / ledger R-004): RESOURCE_MENTION es por FRASES,
// copia literal de RESOURCE_PATTERNS del backend integrado
// (src/modules/visual-components/validate.ts): detecta REFERENCIAS a recursos
// o navegación del curso ("en el video", "la actividad interactiva", "el
// examen"), no el vocabulario del dominio ("juego de roles", "evaluación de
// riesgos", "presentación de resultados", "actividad económica").
var _DYN_DET_SG_M = '(?:el|este|ese|del|al|un|en el|siguiente|proximo|ultimo)';
var _DYN_DET_PL_M = '(?:los|estos|esos|unos|en los|siguientes|proximos)';
var _DYN_DET_SG_F = '(?:la|esta|esa|una|en la|siguiente|proxima|ultima)';
var _DYN_DET_PL_F = '(?:las|estas|esas|unas|en las|siguientes|proximas)';
var _DYN_COURSE_UNIT = '(?:(?:este|esta|el|la)\\s+)?(?:capitulo|modulo|tema|curso|unidad|leccion)';
var _DYN_EXAM_DOMAIN = '(?:fisico|medico|clinico|oftalmologico|visual|de sangre|de laboratorio|de conciencia)';
// R14 — espejo del backend: examen/diapositivas/quiz solo con determinantes REFERENCIALES (un indefinido es vocabulario del tema); video conserva los indefinidos.
var _DYN_REF_SG_M = '(?:el|este|ese|del|al|en el|siguiente|proximo|ultimo)';
var _DYN_REF_PL_M = '(?:los|estos|esos|en los|siguientes|proximos)';
var _DYN_REF_F = '(?:la|las|esta|estas|esa|esas|en la|en las|siguientes?|proximas?|ultimas?)';
var DYN_RESOURCE_PATTERNS = [
  _DYN_DET_SG_M + '\\s+video',
  _DYN_DET_PL_M + '\\s+videos',
  _DYN_DET_SG_F + '\\s+actividad\\s+(?:interactiva|practica|gamificada|de practica|calificada|evaluada|siguiente|final)',
  _DYN_DET_PL_F + '\\s+actividades\\s+(?:interactivas|practicas|gamificadas|de practica|calificadas|evaluadas)',
  '(?:en|con)\\s+la\\s+siguiente\\s+actividad',
  _DYN_REF_SG_M + '\\s+examen(?!\\s+' + _DYN_EXAM_DOMAIN + ')',
  _DYN_REF_PL_M + '\\s+examenes(?!\\s+' + _DYN_EXAM_DOMAIN + ')',
  _DYN_DET_SG_F + '\\s+evaluacion\\s+(?:del modulo|de la unidad|del capitulo|del curso|final|calificada|siguiente)',
  _DYN_DET_SG_F + '\\s+presentacion(?!\\s+(?:de|del)\\s+(?!' + _DYN_COURSE_UNIT + '))',
  _DYN_DET_PL_F + '\\s+presentaciones(?!\\s+(?:de|del)\\s+(?!' + _DYN_COURSE_UNIT + '))',
  _DYN_REF_F + '\\s+diapositivas?',
  '(?:' + _DYN_REF_SG_M + '|' + _DYN_REF_PL_M + ')\\s+quiz(?:zes|es)?',
  'scorm',
  'h5p',
  'juegos?\\s+(?:interactivos?|gamificados?|educativos?|de practica|del capitulo|del modulo)',
  '(?:el|este|al|del)\\s+(?:siguiente|proximo)\\s+recurso'
];
// Invisibles (mismo conjunto que INVISIBLE_CHARS_RE del backend, text.ts).
var DYN_INVISIBLE_CHARS_SRC = '[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\uE000-\\uF8FF]';
var _DYN_INVISIBLE_RE = new RegExp(DYN_INVISIBLE_CHARS_SRC);
// Vista de texto para lints (espejo de lintView): sin invisibles, sin `**`, espacios simples.
function _dynLintView(text) {
  return String(text == null ? '' : text).replace(new RegExp(DYN_INVISIBLE_CHARS_SRC, 'g'), '').split('**').join('').replace(/\s+/g, ' ').trim();
}
var DYN_QUANTITY_WORDS_RE_SRC = ['modulos?', 'capitulos?', 'videos?', 'actividad(?:es)?', 'preguntas?', 'intentos?', 'minutos?', 'horas?', 'paginas?'].join('|');
var _DYN_NUM = '\\d+(?:[.,]\\d+)?';
var DYN_RESOURCE_RE = new RegExp(_DYN_WB_START + '(?:' + DYN_RESOURCE_PATTERNS.join('|') + ')' + _DYN_WB_END, 'gu');
// Edu Phase A (espejo de QUANTITY_ILLUSTRATIVE_RE): en un worked_example los datos son ilustrativos:
// se permiten %, horas, minutos…; se siguen prohibiendo las cantidades de la ESTRUCTURA del curso.
var DYN_COURSE_STRUCTURE_WORDS_RE_SRC = ['modulos?', 'capitulos?', 'videos?', 'actividad(?:es)?', 'preguntas?', 'intentos?'].join('|');
var DYN_QUANTITY_ILLUSTRATIVE_RE = new RegExp([
  _DYN_WB_START + _DYN_NUM + '\\s*(?:' + DYN_COURSE_STRUCTURE_WORDS_RE_SRC + ')' + _DYN_WB_END,
  _DYN_WB_START + '(?:' + DYN_COURSE_STRUCTURE_WORDS_RE_SRC + ')\\s*(?:n\\s*[°º.]?\\s*)?' + _DYN_NUM
].join('|'), 'gu');
var DYN_QUANTITY_RE = new RegExp([
  _DYN_WB_START + _DYN_NUM + '\\s*%',
  _DYN_WB_START + _DYN_NUM + '\\s*(?:' + DYN_QUANTITY_WORDS_RE_SRC + ')' + _DYN_WB_END,
  _DYN_WB_START + '(?:' + DYN_QUANTITY_WORDS_RE_SRC + ')\\s*(?:n\\s*[°º.]?\\s*)?' + _DYN_NUM
].join('|'), 'gu');

function _dynMatchAll(re, s) {
  var out = [];
  var r = new RegExp(re.source, re.flags);
  var m;
  while ((m = r.exec(s)) !== null) {
    out.push(m[0]);
    if (m[0] === '') r.lastIndex++;
  }
  return out;
}
function dynLintResourceMentions(text) {
  return _dynMatchAll(DYN_RESOURCE_RE, _dynLintNormalize(_dynLintView(text))).map(function (m) { return { code: 'RESOURCE_MENTION', match: m }; });
}
function dynLintQuantityClaims(text, illustrative) {
  return _dynMatchAll(illustrative ? DYN_QUANTITY_ILLUSTRATIVE_RE : DYN_QUANTITY_RE, _dynLintNormalize(_dynLintView(text))).map(function (m) { return { code: 'QUANTITY_CLAIM', match: m }; });
}

function _dynIsPlainObject(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function _dynCharLen(s) { return Array.from(s).length; }
function _dynWordCount(s) { var t = String(s || '').trim(); return t ? t.split(/\s+/).length : 0; }

// Errores {path, code, message} → líneas para el reintento dirigido y el error del item.
function _dynFormatErrors(errors) {
  return (errors || []).map(function (e) { return e.path + ' ' + e.code + ': ' + e.message; });
}

// ════ Espejo de validateExperience (R2, vcSchemaVersion 1) ════
var _DYN_VC_HTML_TAG_RE = /<(?:\/?[a-zA-Z]|!|\?)/;
var _DYN_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function _dynVcCheckText(value, path, max, errors, illustrative) {
  if (typeof value !== 'string') { errors.push({ path: path, code: 'TYPE_MISMATCH', message: 'se esperaba texto (string)' }); return; }
  if (value.trim().length === 0) { errors.push({ path: path, code: 'TEXT_EMPTY', message: 'texto vacío' }); return; }
  var len = _dynCharLen(value);
  if (len > max) errors.push({ path: path, code: 'TEXT_TOO_LONG', message: len + ' caracteres > máximo ' + max });
  if (_DYN_VC_HTML_TAG_RE.test(value)) errors.push({ path: path, code: 'HTML_IN_TEXT', message: 'el texto contiene algo con forma de etiqueta HTML' });
  if (_DYN_CONTROL_RE.test(value)) errors.push({ path: path, code: 'TEXT_FORMAT', message: 'caracteres de control no permitidos' });
  if (_DYN_INVISIBLE_RE.test(value)) errors.push({ path: path, code: 'TEXT_FORMAT', message: 'caracteres invisibles/de formato (ancho cero, guion suave, bidi, uso privado) no permitidos' });
  if ((value.split('**').length - 1) % 2 !== 0) errors.push({ path: path, code: 'TEXT_FORMAT', message: 'énfasis **…** sin cerrar' });
  dynLintResourceMentions(value).forEach(function (h) { errors.push({ path: path, code: 'RESOURCE_MENTION', message: 'menciona un recurso: "' + h.match + '"' }); });
  dynLintQuantityClaims(value, illustrative).forEach(function (h) { errors.push({ path: path, code: 'QUANTITY_CLAIM', message: 'afirma una cantidad: "' + h.match + '"' }); });
}

function _dynVcCheckField(spec, value, path, errors, illustrative) {
  if (spec.kind === 'text') { _dynVcCheckText(value, path, spec.max, errors, illustrative); return; }
  if (spec.kind === 'enum') {
    if (typeof value !== 'string' || spec.values.indexOf(value) < 0) errors.push({ path: path, code: 'ENUM_VALUE', message: 'valor inválido; permitido: ' + spec.values.join(', ') });
    return;
  }
  if (!Array.isArray(value)) {
    errors.push({ path: path, code: 'TYPE_MISMATCH', message: spec.kind === 'textList' ? 'se esperaba una lista de textos' : 'se esperaba una lista de objetos' });
    return;
  }
  if (value.length < spec.min || value.length > spec.max) errors.push({ path: path, code: 'COUNT_RANGE', message: value.length + ' elementos, se esperaban ' + spec.min + '–' + spec.max });
  value.forEach(function (it, i) {
    if (spec.kind === 'textList') _dynVcCheckText(it, path + '[' + i + ']', spec.itemMax, errors, illustrative);
    else _dynVcCheckObject(spec.fields, it, path + '[' + i + ']', errors, [], illustrative);
  });
}

function _dynVcCheckObject(fields, value, path, errors, implicit, illustrative) {
  if (!_dynIsPlainObject(value)) { errors.push({ path: path, code: 'NOT_OBJECT', message: 'se esperaba un objeto' }); return; }
  Object.keys(value).forEach(function (k) {
    if (!Object.prototype.hasOwnProperty.call(fields, k) && implicit.indexOf(k) < 0) errors.push({ path: path + '.' + k, code: 'UNKNOWN_FIELD', message: 'campo no permitido "' + k + '"' });
  });
  Object.keys(fields).forEach(function (k) {
    var spec = fields[k];
    if (value[k] === undefined) {
      if (!spec.optional) errors.push({ path: path + '.' + k, code: 'MISSING_FIELD', message: 'falta "' + k + '"' });
      return;
    }
    _dynVcCheckField(spec, value[k], path + '.' + k, errors, illustrative);
  });
}

// ════ Edu EV2 — estructura educativa (espejo de validatePedagogy, pedagogy.ts) ════
// Solo para experiencias NUEVAS (el empaque no la exige). Espera un doc que ya pasó el schema.
function dynValidatePedagogyV3(doc) {
  var errors = [];
  var P = DYN_VC_PEDAGOGY;
  var mv = (doc && doc.movements) || {};
  var typesIn = function (ms) {
    var out = [];
    ms.forEach(function (m) { (Array.isArray(mv[m]) ? mv[m] : []).forEach(function (c) { if (c && typeof c.type === 'string') out.push(c.type); }); });
    return out;
  };
  var hasAny = function (ts, want) { return ts.some(function (t) { return want.indexOf(t) >= 0; }); };
  var first = Array.isArray(mv.opening) && mv.opening[0] ? mv.opening[0].type : null;
  if (!first || P.visualIntro.indexOf(first) < 0) errors.push({ path: '$.movements.opening[0]', code: 'PEDAGOGY_MISSING', message: 'la apertura debe empezar con una introducción visual ("hero")' });
  if (!hasAny(typesIn(['opening', 'deepening']), P.keyConcepts)) errors.push({ path: '$.movements.deepening', code: 'PEDAGOGY_MISSING', message: 'faltan los conceptos clave: agrega un "concept_cards" en opening o deepening (o reemplaza un componente de menor prioridad: deepening admite hasta 5)' });
  if (!hasAny(typesIn(['deepening', 'closing']), P.example)) errors.push({ path: '$.movements.deepening', code: 'PEDAGOGY_MISSING', message: 'falta un ejemplo práctico: agrega un "worked_example" (o un "case_scenario") en deepening (o reemplaza un componente de menor prioridad: deepening admite hasta 5)' });
  if (!hasAny(typesIn(['deepening']), P.visual)) errors.push({ path: '$.movements.deepening', code: 'PEDAGOGY_MISSING', message: 'falta un recurso visual en deepening: agrega un "diagram", "comparison", "process_steps" o "timeline" (o reemplaza un componente de menor prioridad: deepening admite hasta 5)' });
  ['opening', 'deepening', 'synthesis', 'closing', 'video_primer'].forEach(function (m) {
    (Array.isArray(mv[m]) ? mv[m] : []).forEach(function (c, i) {
      if (!c || (c.type !== 'accordion' && c.type !== 'tabs')) return;
      var key = c.type === 'accordion' ? 'items' : 'tabs';
      (Array.isArray(c[key]) ? c[key] : []).forEach(function (p, j) {
        var len = p && typeof p.body === 'string' ? _dynCharLen(p.body) : 0;
        if (len > P.denseMax) errors.push({ path: '$.movements.' + m + '[' + i + '].' + key + '[' + j + '].body', code: 'TEXT_DENSE', message: len + ' caracteres: un bloque de explicación lleva como máximo ' + P.denseMax + ' (2–3 frases); divide la idea o pásala a un recurso visual' });
      });
    });
  });
  return errors;
}

// ════ P3 — why / apply (espejo de validateEduFields, pedagogy.ts) ════
// Solo experiencias NUEVAS (prompt v21-exp-6+); el empaque nunca lo exige. Espera un doc que ya pasó el schema.
function dynValidateEduFieldsV3(doc) {
  var mv = (doc && doc.movements) || {};
  var all = [];
  DYN_VC_MOVEMENT_IDS.forEach(function (m) { (Array.isArray(mv[m]) ? mv[m] : []).forEach(function (c) { if (_dynIsPlainObject(c)) all.push(c); }); });
  var filled = function (v) { return typeof v === 'string' && v.trim().length > 0; };
  var whyOk = all.filter(function (c) { return DYN_VC_EDU_WHY_TYPES.indexOf(c.type) >= 0; });
  var applyOk = all.filter(function (c) { return DYN_VC_EDU_APPLY_TYPES.indexOf(c.type) >= 0; });
  var needWhy = Math.min(DYN_VC_EDU_FIELDS_MIN, whyOk.length);
  var needApply = Math.min(DYN_VC_EDU_FIELDS_MIN, applyOk.length);
  var haveWhy = whyOk.filter(function (c) { return filled(c.why); }).length;
  var haveApply = applyOk.filter(function (c) { return filled(c.apply); }).length;
  var errors = [];
  if (haveWhy < needWhy) errors.push({ path: '$.movements', code: 'EDU_FIELDS_MISSING', message: haveWhy + ' bloque(s) con "why": agrega "why" (por qué le importa al estudiante, una frase) en al menos ' + needWhy + ' bloques de contenido (' + DYN_VC_EDU_WHY_TYPES.join(', ') + ')' });
  if (haveApply < needApply) errors.push({ path: '$.movements', code: 'EDU_FIELDS_MISSING', message: haveApply + ' bloque(s) con "apply": agrega "apply" (una acción concreta en su trabajo, una frase) en al menos ' + needApply + ' bloques de contenido' });
  return errors;
}

// ════ EV6 — árbol de decisión (espejo de checkDecisionNode, validate.ts) ════
function _dynVcCheckDecisionNode(node, path, errors, depth, count) {
  var L = DYN_VC_DECISION_LIMITS;
  if (!_dynIsPlainObject(node)) { errors.push({ path: path, code: 'NOT_OBJECT', message: 'se esperaba un nodo {question, yes, no}' }); return; }
  count.n += 1;
  if (depth > L.maxDepth) { errors.push({ path: path, code: 'DIAGRAM_SHAPE', message: 'un árbol de decisión tiene como máximo ' + L.maxDepth + ' preguntas encadenadas en un camino' }); return; }
  Object.keys(node).forEach(function (k) {
    if (['question', 'yes', 'no'].indexOf(k) < 0) errors.push({ path: path + '.' + k, code: 'UNKNOWN_FIELD', message: 'campo no permitido "' + k + '"' });
  });
  if (node.question === undefined) errors.push({ path: path + '.question', code: 'MISSING_FIELD', message: 'falta "question"' });
  else {
    _dynVcCheckText(node.question, path + '.question', L.questionMax, errors);
    if (typeof node.question === 'string' && node.question.trim() && !/\?$/.test(node.question.trim())) errors.push({ path: path + '.question', code: 'DIAGRAM_SHAPE', message: 'la pregunta de una decisión termina en "?"' });
  }
  ['yes', 'no'].forEach(function (side) {
    var b = node[side];
    var bpath = path + '.' + side;
    if (b === undefined) { errors.push({ path: bpath, code: 'MISSING_FIELD', message: 'falta la rama "' + side + '"' }); return; }
    if (!_dynIsPlainObject(b)) { errors.push({ path: bpath, code: 'NOT_OBJECT', message: 'una rama es un objeto {label?, action | tree}' }); return; }
    Object.keys(b).forEach(function (k) {
      if (['label', 'action', 'tree'].indexOf(k) < 0) errors.push({ path: bpath + '.' + k, code: 'UNKNOWN_FIELD', message: 'campo no permitido "' + k + '"' });
    });
    if (b.label !== undefined) _dynVcCheckText(b.label, bpath + '.label', L.labelMax, errors);
    var hasAction = b.action !== undefined;
    var hasTree = b.tree !== undefined;
    if (hasAction && hasTree) errors.push({ path: bpath, code: 'DIAGRAM_SHAPE', message: 'una rama lleva "action" (acción final) o "tree" (otra pregunta), no ambos' });
    else if (!hasAction && !hasTree) errors.push({ path: bpath, code: 'DIAGRAM_SHAPE', message: 'una rama necesita "action" (acción final) o "tree" (otra pregunta)' });
    if (hasAction) _dynVcCheckText(b.action, bpath + '.action', L.actionMax, errors);
    if (hasTree) _dynVcCheckDecisionNode(b.tree, bpath + '.tree', errors, depth + 1, count);
  });
}

// ════ EV6 — diagramas simulados con texto (espejo de validateSimulatedDiagrams, pedagogy.ts) ════
// Solo experiencias NUEVAS (el empaque no lo exige). Espera un doc que ya pasó el schema.
var DYN_VC_ARROW_CHAIN_MIN = 2;
var _DYN_ARROW_RE = /→|->|⇒/g;
// Fix round 3: espejo literal de STRONG_HEAD_RE / WEAK_HEAD_RE (pedagogy.ts), sobre el texto normalizado
// sin comillas ni numeración inicial. FUERTE (marca solo): «Sí»/«No» solos o con flecha; «Si no…», «En caso
// contrario…», «De lo contrario…»; condición corta con flecha («Si responde → …»). DÉBIL: «Sí»/«No» + «,» «;»
// «(» o «:»/«-»/«–»/«—» + espacio, y condición corta con «:» («Si respira: …»): solo cuenta con otro encabezado
// de polaridad opuesta en la misma secuencia o justo después de una pregunta «¿…?» («No, nunca la muevas»,
// «Sí - revisa el manómetro cada hora» solos son pasos normales).
var _DYN_WORD_END = '(?![\\p{L}\\p{N}_])';
var _DYN_SHORT_CLAUSE = '[^\\s,;:→]+(?:\\s+[^\\s,;:→]+){0,3}';
var _DYN_STRONG_HEAD_RE = new RegExp('^(?:' + [
  '(?:si|no)[.!]?$',
  '(?:si|no)\\s*(?:→|->|⇒)',
  'si\\s+no' + _DYN_WORD_END,
  'en\\s+caso\\s+contrario' + _DYN_WORD_END,
  'de\\s+lo\\s+contrario' + _DYN_WORD_END,
  'si\\s+' + _DYN_SHORT_CLAUSE + '\\s*(?:→|->|⇒)'
].join('|') + ')', 'u');
var _DYN_WEAK_HEAD_RE = new RegExp('^(?:(?:si|no)\\s*(?:[,;(]|[:\\-–—](?=\\s|$))|si\\s+' + _DYN_SHORT_CLAUSE + '\\s*:)', 'u');
var _DYN_NEGATIVE_HEAD_RE = new RegExp('^(?:no' + _DYN_WORD_END + '|si\\s+no' + _DYN_WORD_END + '|en\\s+caso\\s+contrario|de\\s+lo\\s+contrario)', 'u');
var _DYN_QUOTES_RE = /["'«»“”‘’„]/g;
var _DYN_LEAD_NUM_RE = /^\s*\d{1,2}\s*[.)\-–:]?\s+/;
var _DYN_QUESTION_HEAD_RE = /^¿.*\?$/su;
function _dynHeadView(text) { return _dynLintNormalize(_dynLintView(text)).replace(_DYN_QUOTES_RE, '').replace(_DYN_LEAD_NUM_RE, '').trim(); }
// M1: flechas por LÍNEA («A → B\nC → D» son dos pares, no una cadena).
function dynArrowChainLength(text) {
  var best = 0;
  String(text == null ? '' : text).split(/\r?\n/).forEach(function (line) {
    var n = (line.match(_DYN_ARROW_RE) || []).length;
    if (n > best) best = n;
  });
  return best;
}
function dynBranchHead(text) {
  var h = _dynHeadView(text);
  var strength = _DYN_STRONG_HEAD_RE.test(h) ? 'strong' : _DYN_WEAK_HEAD_RE.test(h) ? 'weak' : null;
  return strength ? { strength: strength, polarity: _DYN_NEGATIVE_HEAD_RE.test(h) ? 'no' : 'yes' } : null;
}
function dynIsBranchHead(text) { var k = dynBranchHead(text); return !!k && k.strength === 'strong'; }
// Encabezados-rama de UNA secuencia: FUERTES; DÉBILES con polaridad opuesta en la secuencia o tras una pregunta.
function dynBranchingHeadIndexes(heads) {
  var kinds = heads.map(function (h) { return h ? dynBranchHead(h) : null; });
  var isQ = heads.map(function (h) { return !!h && dynIsQuestionHead(h); });
  var out = [];
  kinds.forEach(function (k, j) {
    if (!k) return;
    if (k.strength === 'strong') out.push(j);
    else if ((j > 0 && isQ[j - 1]) || kinds.some(function (o, i) { return i !== j && !!o && o.polarity !== k.polarity; })) out.push(j);
  });
  return out;
}
function dynIsQuestionHead(text) { return _DYN_QUESTION_HEAD_RE.test(_dynHeadView(text)); }
function _dynSequenceHeads(c) {
  if (c.type === 'diagram' && (c.kind === 'flow' || c.kind === 'cycle')) return { list: 'nodes', field: 'label' };
  if (c.type === 'process_steps') return { list: 'steps', field: 'heading' };
  if (c.type === 'timeline') return { list: 'events', field: 'heading' };
  return null;
}
function _dynWalkTexts(v, path, out) {
  if (typeof v === 'string') out.push({ path: path, text: v });
  else if (Array.isArray(v)) v.forEach(function (x, i) { _dynWalkTexts(x, path + '[' + i + ']', out); });
  else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { if (k !== 'type' && k !== 'kind' && k !== 'variant') _dynWalkTexts(v[k], path + '.' + k, out); });
}
var _DYN_ARROW_MSG = 'el texto dibuja un diagrama con flechas («A → B → C»): escribe frases o usa process_steps o un diagram';
function dynValidateSimulatedDiagramsV3(doc) {
  var errors = [];
  var mv = (doc && doc.movements) || null;
  if (!mv) return errors;
  DYN_VC_MOVEMENT_IDS.forEach(function (m) {
    (Array.isArray(mv[m]) ? mv[m] : []).forEach(function (c, i) {
      if (!c || typeof c !== 'object') return;
      var cpath = '$.movements.' + m + '[' + i + ']';
      var seq = _dynSequenceHeads(c);
      if (seq && Array.isArray(c[seq.list])) {
        var heads = c[seq.list].map(function (it) { var h = it && typeof it === 'object' ? it[seq.field] : undefined; return typeof h === 'string' ? h : ''; });
        var flagged = dynBranchingHeadIndexes(heads);
        var branchAt = heads.map(function (_h, j) { return flagged.indexOf(j) >= 0; });
        heads.forEach(function (h, j) {
          var p = cpath + '.' + seq.list + '[' + j + '].' + seq.field;
          if (branchAt[j]) errors.push({ path: p, code: 'DIAGRAM_BRANCHING_IN_SEQUENCE', message: 'este paso codifica una rama («Sí → …», «No: …», «Si no…»): una secuencia no se ramifica; si hay condiciones usa un diagram con kind "decision"' });
          // Señal estructural: una pregunta seguida de pasos-rama es un árbol aplanado (auditoría #413).
          else if (h && dynIsQuestionHead(h) && branchAt.some(function (x, k) { return x && k > j; })) errors.push({ path: p, code: 'DIAGRAM_BRANCHING_IN_SEQUENCE', message: 'una pregunta seguida de pasos «Sí/No» es un árbol de decisión aplanado: usa un diagram con kind "decision" (la pregunta es "question" y cada respuesta, una rama)' });
        });
      }
      var texts = [];
      _dynWalkTexts(c, cpath, texts);
      texts.forEach(function (t) {
        if (dynArrowChainLength(t.text) >= DYN_VC_ARROW_CHAIN_MIN) errors.push({ path: t.path, code: 'TEXT_SIMULATED_DIAGRAM', message: _DYN_ARROW_MSG });
      });
    });
  });
  if (typeof doc.bridge_to_next === 'string' && dynArrowChainLength(doc.bridge_to_next) >= DYN_VC_ARROW_CHAIN_MIN) errors.push({ path: '$.bridge_to_next', code: 'TEXT_SIMULATED_DIAGRAM', message: _DYN_ARROW_MSG });
  return errors;
}

function dynValidateVcComponent(c, path) {
  var errors = [];
  if (!_dynIsPlainObject(c)) { errors.push({ path: path, code: 'NOT_OBJECT', message: 'se esperaba un objeto componente' }); return errors; }
  if (typeof c.type !== 'string' || !Object.prototype.hasOwnProperty.call(DYN_VC_COMPONENT_SPECS, c.type)) {
    errors.push({ path: path + '.type', code: 'UNKNOWN_COMPONENT', message: 'tipo de componente desconocido "' + String(c.type) + '"' });
    return errors;
  }
  if (c.type === 'diagram' && c.kind === 'decision') {
    // EV6: el árbol reemplaza a nodes/ejes (no se mezclan formas).
    _dynVcCheckObject(DYN_VC_DECISION_DIAGRAM_SPEC, c, path, errors, ['type', 'tree', 'nodes', 'x_axis', 'y_axis'], false);
    ['nodes', 'x_axis', 'y_axis'].forEach(function (k) {
      if (c[k] !== undefined) errors.push({ path: path + '.' + k, code: 'DIAGRAM_SHAPE', message: '"' + k + '" no aplica a diagramas "decision" (usa "tree")' });
    });
    if (c.tree === undefined) errors.push({ path: path + '.tree', code: 'MISSING_FIELD', message: 'falta "tree"' });
    else {
      var count = { n: 0 };
      _dynVcCheckDecisionNode(c.tree, path + '.tree', errors, 1, count);
      if (count.n > DYN_VC_DECISION_LIMITS.maxQuestions) errors.push({ path: path + '.tree', code: 'DIAGRAM_SHAPE', message: 'un árbol de decisión lleva como máximo ' + DYN_VC_DECISION_LIMITS.maxQuestions + ' preguntas (hay ' + count.n + ')' });
    }
    return errors;
  }
  _dynVcCheckObject(DYN_VC_COMPONENT_SPECS[c.type], c, path, errors, c.type === 'diagram' ? ['type', 'tree'] : ['type'], DYN_VC_ILLUSTRATIVE_TYPES.indexOf(c.type) >= 0);
  if (c.type === 'diagram' && c.tree !== undefined) errors.push({ path: path + '.tree', code: 'DIAGRAM_SHAPE', message: '"tree" solo aplica a diagramas "decision"' });
  if (c.type === 'diagram' && typeof c.kind === 'string' && Object.prototype.hasOwnProperty.call(DYN_VC_DIAGRAM_NODES, c.kind)) {
    var lim = DYN_VC_DIAGRAM_NODES[c.kind];
    if (Array.isArray(c.nodes) && (c.nodes.length < lim[0] || c.nodes.length > lim[1])) {
      errors.push({ path: path + '.nodes', code: 'DIAGRAM_SHAPE', message: 'un diagrama "' + c.kind + '" lleva ' + (lim[0] === lim[1] ? lim[0] : lim[0] + '–' + lim[1]) + ' nodos (hay ' + c.nodes.length + ')' });
    }
    ['x_axis', 'y_axis'].forEach(function (ax) {
      if (c.kind === 'matrix' && c[ax] === undefined) errors.push({ path: path + '.' + ax, code: 'DIAGRAM_SHAPE', message: 'una matriz necesita "' + ax + '"' });
      if (c.kind !== 'matrix' && c[ax] !== undefined) errors.push({ path: path + '.' + ax, code: 'DIAGRAM_SHAPE', message: '"' + ax + '" solo aplica a diagramas "matrix"' });
    });
  }
  if (c.type === 'comparison' && Array.isArray(c.columns) && Array.isArray(c.rows)) {
    c.rows.forEach(function (row, i) {
      var cells = _dynIsPlainObject(row) ? row.cells : undefined;
      if (Array.isArray(cells) && cells.length !== c.columns.length) {
        errors.push({ path: path + '.rows[' + i + '].cells', code: 'ARITY_MISMATCH', message: cells.length + ' celdas, pero hay ' + c.columns.length + ' columnas' });
      }
    });
  }
  return errors;
}

function dynValidateExperienceV3(doc) {
  var errors = [];
  if (!_dynIsPlainObject(doc)) return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'el documento debe ser un objeto' }] };
  Object.keys(doc).forEach(function (k) {
    if (['vcSchemaVersion', 'chapterId', 'movements', 'bridge_to_next'].indexOf(k) < 0) errors.push({ path: '$.' + k, code: 'UNKNOWN_FIELD', message: 'campo no permitido "' + k + '"' });
  });
  if (doc.vcSchemaVersion !== DYN_VC_SCHEMA_VERSION) errors.push({ path: '$.vcSchemaVersion', code: 'SCHEMA_VERSION', message: 'vcSchemaVersion debe ser ' + DYN_VC_SCHEMA_VERSION });
  if (typeof doc.chapterId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:.-]*$/.test(doc.chapterId) || doc.chapterId.length > 80) {
    errors.push({ path: '$.chapterId', code: 'CHAPTER_ID', message: 'chapterId debe ser un identificador [A-Za-z0-9_:.-] de hasta 80 caracteres' });
  }
  if (doc.bridge_to_next === undefined) errors.push({ path: '$.bridge_to_next', code: 'MISSING_FIELD', message: 'falta "bridge_to_next"' });
  else _dynVcCheckText(doc.bridge_to_next, '$.bridge_to_next', DYN_VC_BRIDGE_MAX, errors);
  var mv = doc.movements;
  if (!_dynIsPlainObject(mv)) {
    errors.push({ path: '$.movements', code: mv === undefined ? 'MISSING_FIELD' : 'NOT_OBJECT', message: 'movements debe ser un objeto' });
    return { ok: false, errors: errors };
  }
  Object.keys(mv).forEach(function (k) {
    if (DYN_VC_MOVEMENT_IDS.indexOf(k) < 0) errors.push({ path: '$.movements.' + k, code: 'UNKNOWN_FIELD', message: 'movimiento desconocido "' + k + '"' });
  });
  var typeCounts = {};
  DYN_VC_MOVEMENT_IDS.forEach(function (m) {
    var mpath = '$.movements.' + m;
    var list = mv[m];
    if (list === undefined) { errors.push({ path: mpath, code: 'MISSING_FIELD', message: 'falta el movimiento "' + m + '"' }); return; }
    if (!Array.isArray(list)) { errors.push({ path: mpath, code: 'TYPE_MISMATCH', message: 'un movimiento es una lista de componentes' }); return; }
    var lim = DYN_VC_MOVEMENT_LIMITS[m];
    if (list.length < lim[0] || list.length > lim[1]) errors.push({ path: mpath, code: 'MOVEMENT_RANGE', message: list.length + ' componentes, se esperaban ' + lim[0] + '–' + lim[1] });
    list.forEach(function (c, i) {
      var cpath = mpath + '[' + i + ']';
      Array.prototype.push.apply(errors, dynValidateVcComponent(c, cpath));
      var type = _dynIsPlainObject(c) ? c.type : undefined;
      if (typeof type === 'string' && Object.prototype.hasOwnProperty.call(DYN_VC_COMPONENT_SPECS, type)) {
        typeCounts[type] = (typeCounts[type] || 0) + 1;
        if (m === 'self_check' && type !== 'self_check') errors.push({ path: cpath + '.type', code: 'COMPONENT_NOT_ALLOWED', message: 'el movimiento self_check solo admite un componente "self_check"' });
        if (m !== 'self_check' && type === 'self_check') errors.push({ path: cpath + '.type', code: 'COMPONENT_NOT_ALLOWED', message: '"self_check" solo puede ir en el movimiento self_check' });
      }
    });
  });
  var distinct = Object.keys(typeCounts);
  if (distinct.length > 0 && distinct.length < DYN_VC_MIN_DISTINCT_TYPES) errors.push({ path: '$.movements', code: 'TYPE_DIVERSITY', message: 'se requieren al menos ' + DYN_VC_MIN_DISTINCT_TYPES + ' tipos distintos de componente' });
  distinct.sort().forEach(function (t) {
    if (typeCounts[t] > DYN_VC_MAX_SAME_TYPE) errors.push({ path: '$.movements', code: 'TYPE_REPEATED', message: '"' + t + '" aparece ' + typeCounts[t] + ' veces (máximo ' + DYN_VC_MAX_SAME_TYPE + ')' });
  });
  return { ok: errors.length === 0, errors: errors };
}

// ════ Calibración #2 — reparación determinística y ACOTADA de la experience ════
// La calibración #2 mostró 5/5 intentos rechazados (Haiku 4.5 y Sonnet 4.6) por detalles
// mecánicos distintos cada vez (respuesta 20 % más larga, fila de tabla con una celda de más,
// un campo extra, una frase que el lint marca). Cada rechazo re-paga el JSON completo. Antes de
// rechazar se aplican SOLO estas reparaciones, visibles en el output_summary (autoRepairs):
//   TEXT_TOO_LONG   ≤ 1.5× el máximo → recorte en fin de frase o de palabra (con "…");
//   ARITY_MISMATCH  → celdas completadas con "—" o recortadas al número de columnas;
//   UNKNOWN_FIELD   → se descarta el campo (nunca un campo del schema);
//   RESOURCE_MENTION / QUANTITY_CLAIM → se quita ESE componente si su movimiento conserva el mínimo.
// Cualquier otro error, más de DYN_VC_REPAIR_MAX reparaciones o un resultado que no valida →
// sin reparar (el flujo de siempre: reintento dirigido y, si sigue inválido, falla visible).
var DYN_VC_REPAIR_MAX = 8;
var DYN_VC_TRUNC_MAX_RATIO = 1.5;

function _dynPathTokens(path) {
  var toks = [];
  String(path || '').replace(/^\$/, '').replace(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g, function (_, k, i) { toks.push(k !== undefined ? k : Number(i)); return ''; });
  return toks;
}
function _dynPathParent(doc, toks) {
  var o = doc;
  for (var i = 0; i < toks.length - 1; i++) { if (o === null || typeof o !== 'object') return null; o = o[toks[i]]; }
  return (o !== null && typeof o === 'object') ? o : null;
}
function _dynTruncateText(value, max) {
  var out0 = _dynTruncateTextRaw(value, max);
  // R14: nunca dejar un paréntesis abierto colgando ("… presencia real (4…"): se corta antes del "(".
  var open = out0.lastIndexOf('(');
  if (open > 0 && out0.indexOf(')', open) === -1) {
    var cut = out0.slice(0, open).replace(/[\s,;:—-]+$/, '');
    if (Array.from(cut).length >= Math.floor(max * 0.5)) return cut;
  }
  return out0;
}

var DYN_VC_NO_ELLIPSIS_TYPES = ['hero', 'summary_visual', 'case_scenario'];
var DYN_VC_NO_ELLIPSIS_KEYS = ['title', 'central', 'term', 'heading', 'label'];
// Recorte SOLO en fin de oración (≥ 60 % del máximo); null si no hay un corte limpio.
function _dynTruncateAtSentence(value, max) {
  var t = Array.from(value).slice(0, max).join('');
  var cut = Math.max(t.lastIndexOf('. '), t.lastIndexOf('? '), t.lastIndexOf('! '), t.lastIndexOf('.\n'));
  if (t.length === Array.from(value).length) return value;
  if (cut < Math.floor(max * 0.6)) return null;
  var out = t.slice(0, cut + 1).trim();
  return (out.split('**').length - 1) % 2 !== 0 ? null : out;
}

var DYN_LABEL_TAIL_WORDS = ['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'o', 'u', 'en', 'para', 'con', 'por', 'a', 'al', 'que', 'un', 'una', 'su', 'sus', 'sin', 'sobre', 'entre'];
function _dynTruncateLabel(value, max) {
  var cps = Array.from(value);
  if (cps.length <= max) return value;
  var t = cps.slice(0, max).join('');
  var min = Math.floor(max * 0.6);
  var seps = [': ', ' — ', ' – ', ' (', '; ', ', '];
  var cut = -1;
  for (var i = 0; i < seps.length && cut < 0; i++) { var k = t.lastIndexOf(seps[i]); if (k >= min) cut = k; }
  if (cut < 0) { var w = t.lastIndexOf(' '); if (w >= min) cut = w; }
  if (cut < 0) return null;
  var words = t.slice(0, cut).replace(/[\s,;:.\-–—(]+$/, '').split(' ');
  while (words.length > 2 && DYN_LABEL_TAIL_WORDS.indexOf(words[words.length - 1].toLowerCase()) >= 0) words.pop();
  var out = words.join(' ').replace(/[\s,;:.\-–—(]+$/, '');
  if ((out.split('**').length - 1) % 2 !== 0 || Array.from(out).length < min) return null;
  return out;
}

function _dynTruncateTextRaw(value, max) {
  var chars = Array.from(value);
  var t = chars.slice(0, max).join('');
  var cut = Math.max(t.lastIndexOf('. '), t.lastIndexOf('? '), t.lastIndexOf('! '), t.lastIndexOf('.\n'));
  var out;
  if (cut >= Math.floor(max * 0.6)) out = t.slice(0, cut + 1).trim();
  else {
    var base = chars.slice(0, max - 1).join('');
    var w = base.lastIndexOf(' ');
    out = (w >= Math.floor(max * 0.6) ? base.slice(0, w) : base).replace(/[\s,;:.\-–—]+$/, '') + '…';
  }
  if ((out.split('**').length - 1) % 2 !== 0) out = out.replace(/\*\*(?!.*\*\*)/, '');
  return out;
}

/**
 * R14 — comparación con la columna del rótulo metida en `columns`: si TODAS las filas tienen
 * exactamente una celda menos que las columnas, la primera columna es el encabezado del
 * criterio (que ya está en `label`), no un sujeto comparado. Se quita sin perder contenido.
 * Solo si ese encabezado PARECE un rótulo de criterio (vacío, "Aspecto", "Criterio"...): si no,
 * podría ser un sujeto real cuyas celdas faltan, y se deja al relleno visible "—" de ARITY.
 */
var DYN_CRITERION_HEADER_RE = /^(?:|aspectos?|criterios?|caracteristicas?|dimension(?:es)?|elementos?|factor(?:es)?|variables?|rasgos?|categorias?|indicador(?:es)?|parametros?|atributos?|conceptos?|puntos?|temas?|ejes?|ambitos?|items?|comparacion|dato|tipos?|nivel(?:es)?|clases?|modalidad(?:es)?|fases?|etapas?|momentos?|situacion(?:es)?|escenarios?|casos?|opcion(?:es)?|enfoques?)(?:\s.*)?$/;
function _dynNormalizeComparisonHeaders(doc, repairs) {
  var movs = (doc && doc.movements) || {};
  Object.keys(movs).forEach(function (m) {
    (Array.isArray(movs[m]) ? movs[m] : []).forEach(function (c, ix) {
      if (!c || c.type !== 'comparison' || !Array.isArray(c.columns) || !Array.isArray(c.rows) || c.columns.length < 3 || !c.rows.length) return;
      var n = c.columns.length;
      var allShort = c.rows.every(function (r) { return r && Array.isArray(r.cells) && r.cells.length === n - 1; });
      if (!allShort) return;
      var h0 = String(c.columns[0] == null ? '' : c.columns[0]).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      if (!DYN_CRITERION_HEADER_RE.test(h0) || _dynHeaderIsSeries(c.columns)) return;
      repairs.push({ code: 'COMPARISON_LABEL_COLUMN_REMOVED', path: '$.movements.' + m + '[' + ix + '].columns[0]', from: n, to: n - 1 });
      c.columns = c.columns.slice(1);
    });
  });
}

/** R14 — "Opción A / Opción B", "Nivel básico / Nivel intermedio", "Fase 1 / Fase 2": serie de sujetos, no un criterio. */
function _dynFoldHeader(x) { return String(x == null ? '' : x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
function _dynHeaderIsSeries(columns) {
  var w0 = _dynFoldHeader(columns[0]).split(/\s+/)[0];
  if (!w0) return false;
  for (var i = 1; i < columns.length; i++) if (_dynFoldHeader(columns[i]).split(/\s+/)[0] === w0) return true;
  return false;
}

/** Tipos que se recortan primero cuando un movimiento excede su máximo (menos centrales). */
// Edu EV2: categoría pedagógica de cada tipo (para recortar el redundante y no el único).
var DYN_VC_PEDAGOGY_CATEGORIES = {
  diagram: 'visual', comparison: 'visual', process_steps: 'visual', timeline: 'visual',
  worked_example: 'example', case_scenario: 'example',
  accordion: 'explanation', tabs: 'explanation', reveal_cards: 'explanation'
};
// R14: primero los no centrales; recortar uno central dispara la regla de integridad (reintento dirigido).
var DYN_VC_TRIM_PRIORITY = ['callout', 'checklist', 'reveal_cards', 'myth_reality', 'tabs', 'accordion', 'timeline', 'concept_cards'];

function _dynTrimIndex(list) {
  // Primero lo no central (callout, checklist, reveal_cards, myth_reality), luego un tipo repetido,
  // luego el resto por prioridad (un central recortado dispara la regla de integridad).
  for (var a = 0; a < 4; a++) {
    for (var k = list.length - 1; k >= 0; k--) if (list[k] && list[k].type === DYN_VC_TRIM_PRIORITY[a]) return k;
  }
  var counts = {};
  list.forEach(function (c) { var t = c && c.type; counts[t] = (counts[t] || 0) + 1; });
  for (var i = list.length - 1; i >= 0; i--) if (counts[list[i] && list[i].type] > 1) return i;
  // Edu EV2: antes que un central único, el miembro REDUNDANTE de una categoría pedagógica (un segundo
  // recurso visual, una segunda explicación o un segundo ejemplo): la estructura educativa sigue completa.
  var catOf = function (t) { return DYN_VC_PEDAGOGY_CATEGORIES[t] || null; };
  var catCount = {};
  list.forEach(function (c) { var k = catOf(c && c.type); if (k) catCount[k] = (catCount[k] || 0) + 1; });
  for (var q = list.length - 1; q >= 0; q--) { var cq = catOf(list[q] && list[q].type); if (cq && catCount[cq] > 1) return q; }
  for (var p = 0; p < DYN_VC_TRIM_PRIORITY.length; p++) {
    for (var j = list.length - 1; j >= 0; j--) if (list[j] && list[j].type === DYN_VC_TRIM_PRIORITY[p]) return j;
  }
  return list.length - 1;
}

/**
 * R14 — TYPE_REPEATED: quita las instancias sobrantes de un tipo (máx. DYN_VC_MAX_SAME_TYPE en todo
 * el capítulo), empezando por el movimiento con más holgura sobre su mínimo y por la última
 * instancia. La primera apertura (hero) nunca se toca. false si no se puede sin violar mínimos.
 */
/**
 * R14 — case_scenario sin questions: si narrative termina con 1–4 preguntas (¿…?), se mueven a
 * questions y se quitan de narrative. Solo si queda narrativa suficiente (≥ 80 caracteres).
 */
function _dynCaseQuestionsFromNarrative(c) {
  if (!c || typeof c.narrative !== 'string') return false;
  // Preguntas al final: como lista en líneas propias ("- ¿…?", "1. ¿…?"), numeradas en línea
  // SOLO si la numeración es 1..n (n ≥ 2), o sueltas. Un número del texto ("grado 5. ¿…?") nunca es viñeta.
  var n0 = c.narrative;
  var m = /((?:\n[ \t]*(?:[-•*]|\d{1,2}[.)])[ \t]*¿[^¿?\n]{3,238}\?[ \t]*)+)\s*$/.exec(n0);
  if (!m) {
    var mi = /((?:\s*\d{1,2}[.)]\s*¿[^¿?]{3,238}\?){2,})\s*$/.exec(n0);
    var nums = mi ? (mi[1].match(/\d{1,2}(?=[.)]\s*¿)/g) || []).map(Number) : [];
    if (mi && nums.every(function (x, i) { return x === i + 1; })) m = mi;
  }
  if (!m) m = /((?:\s*¿[^¿?]{3,238}\?)+)\s*$/.exec(n0);
  if (!m) return false;
  var qs = m[1].match(/¿[^¿?]+\?/g) || [];
  // Un encabezado propio de la lista ("Preguntas guía:") se va con ella.
  var rest = c.narrative.slice(0, m.index).trim().replace(/(?:^|\n|\.\s+)\s*(?:preguntas(?: gu[ií]a| para reflexionar| de reflexi[oó]n)?|para reflexionar|reflexiona)\s*:\s*$/i, function (x) { return x.charAt(0) === '.' ? '.' : ''; }).trim();
  // Si queda texto roto (otra pregunta, dos puntos o viñeta colgando) no es una lista de preguntas guía.
  if (!qs.length || qs.length > 4 || _dynCharLen(rest) < 80 || rest.indexOf('¿') !== -1 || /(?:[:\-•*]|(?:^|\n)[ \t]*\d{1,2}[.)])$/.test(rest)) return false;
  c.narrative = rest;
  c.questions = qs.map(function (q) { return q.trim(); });
  return true;
}

/** R14 — ¿el texto tiene alguna mención de recurso o cantidad? */
function _dynTextHasLintHit(t) {
  return dynLintResourceMentions(t).length > 0 || dynLintQuantityClaims(t).length > 0;
}

/** R14 — campos de PROSA donde quitar una oración no deja la pieza hueca (nunca títulos, preguntas ni respuestas). */
var DYN_SENTENCE_REPAIR_KEYS = ['body', 'narrative', 'lead', 'definition', 'back', 'reality'];
/** Abreviaturas cuyo punto NO cierra oración ("Dr. Pérez", "p. ej. una clase"). */
// Sin letras sueltas ni "etc": un "plan B." o "etc." SÍ pueden cerrar oración (una inicial mal cortada
// deja un fragmento hueco "J." y la reparación se aborta).
var _DYN_ABBR_RE = /(?:^|[\s(])(?:dr|dra|sr|sra|srta|lic|ing|prof|profa|ej|p\. ej|pag|pags|num|nro|vol|cap|aprox|vs|art|fig|tel|av|dpto|depto|ud|uds)\.$/i;
/** Conectores que dependen de la oración anterior: si esa se quita, el sentido cambia. */
var _DYN_CONNECTOR_RE = /^\s*(?:por eso|por ello|por lo tanto|por tanto|as[ií] que|as[ií],|entonces|esto|eso|ello|de ah[ií]|en ese caso|con eso|con ello|adem[aá]s|sin embargo|aun as[ií]|en cambio|tambi[eé]n|luego)\b/i;

function _dynSplitSentences(line) {
  // Corte solo en [.!?…] + espacio + mayúscula / ¿ / ¡ (nunca "3.5", URLs, "1. ", minúscula).
  var parts = [];
  var re = /[.!?…]+["»”)]*\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/g;
  var last = 0, m;
  while ((m = re.exec(line))) {
    var cut = m.index + m[0].length;
    var piece = line.slice(last, cut);
    if (_DYN_ABBR_RE.test(piece.trim())) continue; // la abreviatura sigue en la misma oración
    parts.push(piece);
    last = cut;
  }
  parts.push(line.slice(last));
  return parts.filter(function (x) { return x.trim(); });
}

/**
 * R14 — quita de obj[key] (solo campos de prosa) las ORACIONES con una mención de recurso/cantidad,
 * línea por línea. false (→ se quita el componente, como antes) si: no es prosa, no se quitó nada,
 * no queda texto, queda una mención, queda un fragmento hueco ("2.", "Dr."), la oración siguiente
 * dependía de la quitada ("Por eso…"), o el énfasis (**) quedaría desbalanceado.
 */
function _dynDropLintSentences(obj, key) {
  if (DYN_SENTENCE_REPAIR_KEYS.indexOf(key) === -1) return false;
  var removed = 0;
  var broken = false;
  var prevRemoved = false; // cruza saltos de línea simples ("…20 minutos.\nPor eso…")
  var lines = String(obj[key]).split('\n').map(function (line) {
    if (!line.trim()) { prevRemoved = false; return line; }
    // Viñeta/numeración de lista: se conserva y solo se parte el texto que sigue.
    var lead = (/^\s*(?:(?:[-*•]|\d{1,3}[.)])\s+)?/.exec(line) || [''])[0];
    var rest = line.slice(lead.length);
    // Lista numerada DENTRO de la línea ("1. … 2. … 3. …"): recortarla renumera por accidente → no se toca.
    var inlineList = /\s\d{1,3}[.)]\s+\S/.test(rest);
    var sents = _dynSplitSentences(rest);
    var kept = [];
    sents.forEach(function (x) {
      if (_dynTextHasLintHit(x)) { removed++; prevRemoved = true; if (inlineList) broken = true; return; }
      if (prevRemoved && _DYN_CONNECTOR_RE.test(x)) broken = true;
      if (/^\s*(?:\d{1,3}|[A-Za-z]{1,3})[.)]\s*$/.test(x)) broken = true;
      prevRemoved = false;
      kept.push(x.trim());
    });
    if (!kept.length) return null; // la línea entera era la mención (p. ej. un ítem de lista)
    return lead + kept.join(' ');
  }).filter(function (l) { return l !== null; });
  var res = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (broken || !removed || !res || _dynTextHasLintHit(res) || ((res.match(/\*\*/g) || []).length % 2)) return false;
  obj[key] = res;
  return true;
}

/** R14 — componentes centrales: nunca se quitan enteros por una reparación determinista (mismo set que MAJOR_TYPES del renderer). */
var DYN_VC_CORE_TYPES = ['hero', 'process_steps', 'comparison', 'summary_visual', 'case_scenario', 'timeline', 'accordion', 'concept_cards', 'tabs', 'worked_example', 'diagram'];

/**
 * R14 + Task 2 — integridad pedagógica de una reparación. Devuelve los tipos que se perderían (→ el
 * ejecutor escala al reintento dirigido) o null si la reparación es aceptable. Los componentes
 * SOBRANTES quitados por exceder el máximo del movimiento (COMPONENT_REMOVED/MOVEMENT_RANGE) no
 * cuentan como contenido perdido —el modelo produjo de más—, salvo que un tipo central
 * desaparezca por completo del capítulo.
 */
function _dynRepairIntegrity(before, after, repairs) {
  var lost = _dynComponentsLost(before, after);
  // Edu EV2: recortes por exceso del movimiento (COMPONENT_TRIMMED/REMOVED, MOVEMENT_RANGE) no son
  // contenido perdido si la estructura educativa del resultado sigue completa (el modelo produjo de más).
  var pedagogyOk = typeof dynValidatePedagogyV3 === 'function' && dynValidatePedagogyV3(after).length === 0;
  // Solo si OTRO miembro de su categoría pedagógica sigue en el capítulo (un segundo recurso visual, una
  // segunda explicación…): nunca se acepta en silencio perder la única explicación u otro tipo sin categoría.
  var remainingTypes = [];
  var mvA = (after && after.movements) || {};
  Object.keys(mvA).forEach(function (m) { (Array.isArray(mvA[m]) ? mvA[m] : []).forEach(function (x) { if (x && x.type) remainingTypes.push(x.type); }); });
  var covered = function (t) {
    var cat = DYN_VC_PEDAGOGY_CATEGORIES[t];
    return !!cat && remainingTypes.some(function (u) { return DYN_VC_PEDAGOGY_CATEGORIES[u] === cat; });
  };
  var rangeTrimmed = [];
  (repairs || []).forEach(function (r) {
    if (r && (r.code === 'COMPONENT_REMOVED' || r.code === 'COMPONENT_TRIMMED') && r.reason === 'MOVEMENT_RANGE' && (r.code === 'COMPONENT_REMOVED' || (pedagogyOk && covered(r.type)))) {
      var k = lost.indexOf(r.type);
      if (k !== -1) { lost.splice(k, 1); rangeTrimmed.push(r.type); }
    }
  });
  var remaining = {};
  var mv = (after && after.movements) || {};
  Object.keys(mv).forEach(function (m) { (Array.isArray(mv[m]) ? mv[m] : []).forEach(function (x) { if (x && x.type) remaining[x.type] = true; }); });
  var goneCore = _dynComponentsLost(before, after).filter(function (t, i, arr) {
    return DYN_VC_CORE_TYPES.indexOf(t) !== -1 && !remaining[t] && arr.indexOf(t) === i && !(pedagogyOk && rangeTrimmed.indexOf(t) !== -1 && covered(t));
  });
  if (lost.length >= 2 || lost.some(function (t) { return DYN_VC_CORE_TYPES.indexOf(t) !== -1; }) || goneCore.length) {
    return lost.concat(goneCore.filter(function (t) { return lost.indexOf(t) === -1; }));
  }
  return null;
}

/** R14 — tipos de componente (con repetición) que están en `before` y faltan en `after`. */
function _dynComponentsLost(before, after) {
  function counts(d) {
    var c = {};
    var mv = (d && d.movements) || {};
    Object.keys(mv).forEach(function (m) { (Array.isArray(mv[m]) ? mv[m] : []).forEach(function (x) { var t = x && x.type; c[t] = (c[t] || 0) + 1; }); });
    return c;
  }
  var b = counts(before), a = counts(after), lost = [];
  Object.keys(b).forEach(function (t) { for (var k = (a[t] || 0); k < b[t]; k++) lost.push(t); });
  return lost;
}

/** R14 — listas cuyos elementos son independientes entre sí (quitar uno no rompe la secuencia). */
// (learning_objectives NO: son los resultados declarados del capítulo; quitar uno en silencio es peor que reintentar.)
var DYN_VC_INDEPENDENT_LISTS = { self_check: 'items', accordion: 'items', concept_cards: 'cards', reveal_cards: 'cards', tabs: 'tabs', myth_reality: 'pairs', checklist: 'items' };

/** Encola quitar movements.<m>[i].<lista>[j] si la lista es independiente y conserva su mínimo. */
function _dynQueueListItemRemoval(doc, toks, listRemovals, reason, match) {
  if (toks[0] !== 'movements' || typeof toks[1] !== 'string' || typeof toks[2] !== 'number' || typeof toks[3] !== 'string' || typeof toks[4] !== 'number') return false;
  var comp = doc.movements && doc.movements[toks[1]] && doc.movements[toks[1]][toks[2]];
  if (!comp || DYN_VC_INDEPENDENT_LISTS[comp.type] !== toks[3] || !Array.isArray(comp[toks[3]])) return false;
  var spec = (DYN_VC_COMPONENT_SPECS[comp.type] || {})[toks[3]];
  var k = toks[1] + '|' + toks[2] + '|' + toks[3];
  var set = listRemovals[k] = listRemovals[k] || {};
  if (set[toks[4]]) return true; // ese elemento ya se va
  var queued = Object.keys(set).length;
  if (!spec || comp[toks[3]].length - queued - 1 < (spec.min || 1)) return false;
  set[toks[4]] = { reason: reason, match: match };
  return true;
}

/**
 * Aplica las remociones de elementos (índices descendentes), salvo en componentes que se quitan
 * enteros, y registra cada una. Devuelve los paths (índices originales) de lo que ya no existe.
 */
function _dynApplyListRemovals(doc, listRemovals, removals, repairs) {
  var gone = [];
  Object.keys(listRemovals).forEach(function (k) {
    var parts = k.split('|');
    var m = parts[0], i = Number(parts[1]), key = parts[2];
    if (removals[m] && removals[m][i]) return;
    var list = doc.movements[m][i][key];
    Object.keys(listRemovals[k]).map(Number).sort(function (a, b) { return b - a; }).forEach(function (j) {
      var p = '$.movements.' + m + '[' + i + '].' + key + '[' + j + ']';
      var info = listRemovals[k][j];
      list.splice(j, 1);
      gone.push(p);
      repairs.push({ code: 'LIST_ITEM_REMOVED', path: p, reason: info.reason, match: info.match });
    });
  });
  return gone;
}

/** Quita de repairs los registros de piezas que al final se eliminaron (no cuentan ni se auditan como aplicados). */
function _dynDropRepairsUnder(repairs, gone) {
  if (!gone.length) return repairs;
  return repairs.filter(function (r) {
    if (r.code === 'LIST_ITEM_REMOVED' || r.code === 'COMPONENT_REMOVED' || r.code === 'COMPONENT_TRIMMED') return true;
    return !gone.some(function (g) { return r.path.indexOf(g + '.') === 0 || r.path.indexOf(g + '[') === 0; });
  });
}

/** R14 — antes de validar/truncar: case_scenario sin questions cuyas preguntas guía están en narrative. */
function _dynExtractCaseQuestions(doc, repairs) {
  var movs = (doc && doc.movements) || {};
  Object.keys(movs).forEach(function (m) {
    (Array.isArray(movs[m]) ? movs[m] : []).forEach(function (c, ix) {
      if (!c || c.type !== 'case_scenario' || c.questions !== undefined) return;
      if (_dynCaseQuestionsFromNarrative(c)) repairs.push({ code: 'CASE_QUESTIONS_EXTRACTED', path: '$.movements.' + m + '[' + ix + '].questions', count: c.questions.length });
    });
  });
}

function _dynReduceRepeatedTypes(doc, repairs) {
  var movs = (doc && doc.movements) || {};
  var names = Object.keys(movs).filter(function (m) { return Array.isArray(movs[m]); });
  for (var guard = 0; guard < 20; guard++) {
    var counts = {};
    names.forEach(function (m) { movs[m].forEach(function (c) { var t = c && c.type; counts[t] = (counts[t] || 0) + 1; }); });
    var over = Object.keys(counts).filter(function (t) { return counts[t] > DYN_VC_MAX_SAME_TYPE; });
    if (!over.length) return true;
    var t = over[0];
    var best = null;
    names.forEach(function (m) {
      var lim = DYN_VC_MOVEMENT_LIMITS[m];
      var list = movs[m];
      if (!lim || list.length - 1 < lim[0]) return;
      for (var i = list.length - 1; i >= 0; i--) {
        if (!list[i] || list[i].type !== t || (m === 'opening' && i === 0)) continue;
        var slack = list.length - lim[0];
        // Empate → el movimiento posterior (menos central que la apertura).
        if (!best || slack >= best.slack) best = { m: m, i: i, slack: slack };
        break;
      }
    });
    if (!best) return false;
    repairs.push({ code: 'COMPONENT_REMOVED', path: '$.movements.' + best.m + '[' + best.i + ']', reason: 'TYPE_REPEATED', type: t });
    movs[best.m].splice(best.i, 1);
  }
  return false;
}

/**
 * Task 2 (failures_report, causa raíz de los fallos de "experience"): un movimiento con MÁS
 * componentes que su máximo se recorta PRIMERO, quitando de preferencia los componentes que
 * además tienen errores (texto demasiado largo, cantidades, menciones…) y, si no, los últimos.
 * Antes, un error sin reparación dentro de un componente que igual sobraba abortaba toda la
 * reparación y el item terminaba fallido. Nunca quita el primer componente de la apertura.
 */
function _dynTrimOverfullMovements(doc, errors, repairs) {
  var movs = (doc && doc.movements) || {};
  var changed = false;
  Object.keys(DYN_VC_MOVEMENT_LIMITS).forEach(function (m) {
    var list = movs[m];
    var lim = DYN_VC_MOVEMENT_LIMITS[m];
    if (!Array.isArray(list) || list.length <= lim[1]) return;
    var bad = {};
    var re = new RegExp('^\\$\\.movements\\.' + m + '\\[(\\d+)\\]');
    (errors || []).forEach(function (e) { var mm = re.exec((e && e.path) || ''); if (mm) bad[Number(mm[1])] = true; });
    // Solo se quitan acá los sobrantes CON errores; el resto del exceso lo recorta la lógica de
    // prioridad de siempre (tipo repetido / baja prioridad), más abajo.
    while (list.length > lim[1]) {
      var idx = -1;
      for (var i = list.length - 1; i >= 0; i--) {
        if (bad[i] && !(m === 'opening' && i === 0)) { idx = i; break; }
      }
      if (idx < 0) break;
      repairs.push({ code: 'COMPONENT_REMOVED', path: '$.movements.' + m + '[' + idx + ']', reason: 'MOVEMENT_RANGE', type: list[idx] && list[idx].type });
      list.splice(idx, 1);
      var nb = {};
      Object.keys(bad).forEach(function (k) { k = Number(k); if (k < idx) nb[k] = true; else if (k > idx) nb[k - 1] = true; });
      bad = nb;
      changed = true;
    }
  });
  return changed;
}

// Tipo del componente que contiene la ruta ($.movements.<m>[i]…), o null.
function _dynComponentTypeAt(doc, toks) {
  if (!doc || toks[0] !== 'movements' || typeof toks[1] !== 'string' || typeof toks[2] !== 'number') return null;
  var list = doc.movements && doc.movements[toks[1]];
  var c = Array.isArray(list) ? list[toks[2]] : null;
  return c && typeof c.type === 'string' ? c.type : null;
}

function dynRepairExperienceV3(doc) {
  var v0 = dynValidateExperienceV3(doc);
  if (v0.ok) return { ok: true, doc: doc, repairs: [] };
  var r = _dynRepairExperienceCore(doc, v0, false);
  if (r.ok) return r;
  // Task 2 — solo si la reparación de siempre no alcanzó: segundo intento que primero quita los
  // componentes SOBRANTES que traen errores (movimiento con más componentes que el máximo). Nunca
  // cambia un resultado que ya funcionaba; si tampoco alcanza, se devuelve el fallo original.
  var r2 = _dynRepairExperienceCore(doc, v0, true);
  return r2.ok ? r2 : r;
}

function _dynRepairExperienceCore(doc, v0, trimFirst) {
  var fixed = JSON.parse(JSON.stringify(doc));
  var repairs = [];
  _dynNormalizeComparisonHeaders(fixed, repairs);
  _dynExtractCaseQuestions(fixed, repairs);
  var v = repairs.length ? dynValidateExperienceV3(fixed) : v0;
  if (v.ok) return { ok: true, doc: fixed, repairs: repairs };
  if (trimFirst) {
    var vPre = v;
    if (!_dynTrimOverfullMovements(fixed, v.errors, repairs)) return { ok: false, errors: v.errors };
    v = dynValidateExperienceV3(fixed);
    if (v.ok) {
      var esc0 = _dynRepairIntegrity(doc, fixed, repairs);
      return esc0 ? { ok: false, errors: vPre.errors, escalate: 'INTEGRITY', wouldRemove: esc0 } : { ok: true, doc: fixed, repairs: repairs };
    }
  }
  var removals = {};
  var listRemovals = {};
  var removalMatch = {};
  var trims = {};
  var typeRepeated = false;
  for (var i = 0; i < v.errors.length; i++) {
    var e = v.errors[i];
    if (repairs.length >= DYN_VC_REPAIR_MAX) return { ok: false, errors: v.errors };
    var toks = _dynPathTokens(e.path);
    var parent = _dynPathParent(fixed, toks);
    var key = toks[toks.length - 1];
    if ((key === 'why' || key === 'apply') && toks[0] === 'movements' && toks.length === 4 && parent && parent.type && e.code !== 'UNKNOWN_FIELD') {
      // P3 (fix I2): «por qué importa» / «cómo lo aplicas» son OPCIONALES: uno inválido (largo, lint, formato)
      // se QUITA entero —nunca se corta con «…» ni se paga un reintento por él—; el componente se conserva.
      // Si al final quedan menos campos que el mínimo, dynValidateEduFieldsV3 pide el reintento dirigido.
      if (key in parent) {
        delete parent[key];
        repairs.push({ code: 'EDU_FIELD_DROPPED', path: e.path, reason: e.code });
      }
      continue;
    }
    if (e.code === 'TEXT_TOO_LONG') {
      // Edu Phase A: un paso de cálculo, un resultado o una etiqueta de diagrama truncados son una falla
      // silenciosa: se va al reintento dirigido.
      var ownerType = _dynComponentTypeAt(fixed, toks);
      if (ownerType === 'worked_example' || ownerType === 'diagram') return { ok: false, errors: v.errors };
      var mm = /máximo (\d+)/.exec(e.message || '');
      var max = mm ? Number(mm[1]) : 0;
      var val = parent ? parent[key] : undefined;
      if (!max || typeof val !== 'string' || _dynCharLen(val) > max * DYN_VC_TRUNC_MAX_RATIO) return { ok: false, errors: v.errors };
      // EV5 (auditoría P5): títulos, ideas clave, la apertura y los casos no se cortan con «…»
      // (quedaban «…construir relaciones que…»): solo en fin de oración; si no hay, reintento.
      if (DYN_VC_NO_ELLIPSIS_TYPES.indexOf(ownerType) >= 0 || DYN_VC_NO_ELLIPSIS_KEYS.indexOf(key) >= 0) {
        // Rótulos (título, término, idea central…): corte en separador natural o en palabra, sin «…»;
        // texto largo de apertura/idea clave/caso: solo en fin de oración. Sin corte limpio → reintento.
        var atSentence = DYN_VC_NO_ELLIPSIS_KEYS.indexOf(key) >= 0 ? _dynTruncateLabel(val, max) : _dynTruncateAtSentence(val, max);
        if (atSentence === null) return { ok: false, errors: v.errors };
        parent[key] = atSentence;
        repairs.push({ code: 'TEXT_TOO_LONG', path: e.path, from: _dynCharLen(val), to: _dynCharLen(parent[key]) });
        continue;
      }
      parent[key] = _dynTruncateText(val, max);
      repairs.push({ code: 'TEXT_TOO_LONG', path: e.path, from: _dynCharLen(val), to: _dynCharLen(parent[key]) });
    } else if (e.code === 'ARITY_MISMATCH') {
      var cm = /hay (\d+) columnas/.exec(e.message || '');
      var cols = cm ? Number(cm[1]) : 0;
      var cells = parent ? parent[key] : undefined;
      if (!cols || !Array.isArray(cells)) return { ok: false, errors: v.errors };
      parent[key] = cells.length > cols ? cells.slice(0, cols) : cells.concat(Array(cols - cells.length).fill('—'));
      repairs.push({ code: 'ARITY_MISMATCH', path: e.path, from: cells.length, to: cols });
    } else if (e.code === 'DIAGRAM_SHAPE' && (key === 'x_axis' || key === 'y_axis') && parent && parent.type === 'diagram' && parent.kind !== 'matrix') {
      delete parent[key];
      repairs.push({ code: 'FIELD_REMOVED', path: e.path, reason: e.code });
    } else if (e.code === 'UNKNOWN_FIELD') {
      if (!parent || typeof key !== 'string' || toks.length < 2) return { ok: false, errors: v.errors };
      delete parent[key];
      repairs.push({ code: 'UNKNOWN_FIELD', path: e.path });
    } else if (e.code === 'MOVEMENT_RANGE') {
      // Exceso de componentes: se recortan después de las remociones (que pueden bastar).
      var mr = /^(\d+) componentes, se esperaban (\d+)–(\d+)/.exec(e.message || '');
      if (toks[0] !== 'movements' || typeof toks[1] !== 'string' || !mr || Number(mr[1]) <= Number(mr[3])) return { ok: false, errors: v.errors };
      trims[toks[1]] = Number(mr[3]);
    } else if ((e.code === 'RESOURCE_MENTION' || e.code === 'QUANTITY_CLAIM') && key === 'eyebrow' && parent && parent.type === 'hero') {
      // R14: el eyebrow es opcional y la apertura ya muestra "Módulo · Capítulo": se quita
      // SOLO el campo (el hero, que es la apertura del capítulo, se conserva).
      if (key in parent) {
        delete parent[key];
        repairs.push({ code: 'FIELD_REMOVED', path: e.path, reason: e.code });
      }
    } else if (e.code === 'TYPE_REPEATED' && e.path === '$.movements') {
      // R14: se resuelve después de remociones y recortes (que suelen bastar).
      typeRepeated = true;
    } else if (e.code === 'MISSING_FIELD' && key === 'questions' && parent && parent.type === 'case_scenario' && toks[0] === 'movements' && typeof toks[1] === 'string' && typeof toks[2] === 'number' && toks.length === 4) {
      // R14: a un componente le falta un campo obligatorio (p. ej. case_scenario sin questions).
      // No se inventa contenido: se quita el componente solo si el movimiento conserva su mínimo.
      (removals[toks[1]] = removals[toks[1]] || {})[toks[2]] = e.code;
    } else if (e.code === 'QUANTITY_CLAIM' && _dynComponentTypeAt(fixed, toks) === 'case_scenario') {
      // EV5 (auditoría P5): quitar oraciones con datos de un caso dejaba preguntas sobre hechos
      // que el relato ya no contaba («…en esos 4 días?»). El caso va entero al reintento dirigido.
      return { ok: false, errors: v.errors };
    } else if (e.code === 'RESOURCE_MENTION' || e.code === 'QUANTITY_CLAIM') {
      var hitMatch = (/"([^"]*)"/.exec(e.message || '') || [])[1];
      // R14: primero se quita SOLO la oración con la mención (el componente se conserva).
      if (parent && typeof parent[key] === 'string') {
        if (!_dynTextHasLintHit(parent[key])) continue; // otra oración del mismo campo ya lo resolvió
        if (_dynDropLintSentences(parent, key)) {
          repairs.push({ code: 'SENTENCE_REMOVED', path: e.path, reason: e.code, match: hitMatch });
          continue;
        }
      }
      // R14: en una lista de piezas INDEPENDIENTES (pregunta+respuesta, tarjeta, pestaña…) se quita solo
      // ese elemento completo —nunca media respuesta— si la lista conserva su mínimo.
      // (el registro LIST_ITEM_REMOVED se agrega al aplicarla, no al encolarla)
      if (_dynQueueListItemRemoval(fixed, toks, listRemovals, e.code, hitMatch)) continue;
      // Componente dueño del texto: $.movements.<m>[i]...
      if (toks[0] !== 'movements' || typeof toks[1] !== 'string' || typeof toks[2] !== 'number') return { ok: false, errors: v.errors };
      (removals[toks[1]] = removals[toks[1]] || {})[toks[2]] = e.code;
      if (hitMatch) removalMatch[toks[1] + '[' + toks[2] + ']'] = hitMatch;
    } else {
      return { ok: false, errors: v.errors };
    }
  }
  var gone = _dynApplyListRemovals(fixed, listRemovals, removals, repairs);
  Object.keys(removals).forEach(function (m) { Object.keys(removals[m]).forEach(function (ix) { gone.push('$.movements.' + m + '[' + ix + ']'); }); });
  repairs = _dynDropRepairsUnder(repairs, gone);
  var movs = Object.keys(removals);
  for (var j = 0; j < movs.length; j++) {
    var m = movs[j];
    var idxs = Object.keys(removals[m]).map(Number).sort(function (a, b) { return b - a; });
    var list = fixed.movements && fixed.movements[m];
    var lim = DYN_VC_MOVEMENT_LIMITS[m];
    if (!Array.isArray(list) || !lim || list.length - idxs.length < lim[0]) return { ok: false, errors: v.errors };
    idxs.forEach(function (ix) {
      var rec = { code: 'COMPONENT_REMOVED', path: '$.movements.' + m + '[' + ix + ']', reason: removals[m][ix], type: list[ix] && list[ix].type };
      if (removalMatch[m + '[' + ix + ']']) rec.match = removalMatch[m + '[' + ix + ']'];
      repairs.push(rec);
      list.splice(ix, 1);
    });
  }
  var tmovs = Object.keys(trims);
  for (var t = 0; t < tmovs.length; t++) {
    var tl = fixed.movements && fixed.movements[tmovs[t]];
    if (!Array.isArray(tl)) return { ok: false, errors: v.errors };
    while (tl.length > trims[tmovs[t]]) {
      var ti = _dynTrimIndex(tl);
      repairs.push({ code: 'COMPONENT_TRIMMED', path: '$.movements.' + tmovs[t] + '[' + ti + ']', reason: 'MOVEMENT_RANGE', type: tl[ti] && tl[ti].type });
      tl.splice(ti, 1);
    }
  }
  if (typeRepeated && !_dynReduceRepeatedTypes(fixed, repairs)) return { ok: false, errors: v.errors };
  if (repairs.length > DYN_VC_REPAIR_MAX) return { ok: false, errors: v.errors };
  // R14 — integridad pedagógica (sobre el resultado FINAL: remociones por lint, recortes y TYPE_REPEATED):
  // si se perdería un componente CENTRAL o 2+ componentes enteros, no se sigue recortando; falla y el
  // ejecutor escala al reintento dirigido (LLM). Validar no basta.
  var lost = _dynRepairIntegrity(doc, fixed, repairs);
  if (lost) return { ok: false, errors: v.errors, escalate: 'INTEGRITY', wouldRemove: lost };
  var v2 = dynValidateExperienceV3(fixed);
  return v2.ok ? { ok: true, doc: fixed, repairs: repairs } : { ok: false, errors: v.errors };
}

// ════ Espejo liviano de los schemas de intro v3 (R11a) ════
// Forma exacta del brief R11a; límites de caracteres que el brief no fija
// son holgados a propósito (el backend es autoritativo: si es más estricto,
// el complete se rechaza y el item falla retryable, visible).
var DYN_INTRO_URL_RE = /(https?:\/\/|www\.|\bdoi\s*:|\b10\.\d{4,9}\/\S+|\bisbn\b)/i;

function _dynIntroText(value, path, max, errors, opts) {
  opts = opts || {};
  if (typeof value !== 'string') { errors.push({ path: path, code: 'TYPE_MISMATCH', message: 'se esperaba texto (string)' }); return false; }
  if (!value.trim()) { errors.push({ path: path, code: 'TEXT_EMPTY', message: 'texto vacío' }); return false; }
  var len = _dynCharLen(value);
  if (len > max) errors.push({ path: path, code: 'TEXT_TOO_LONG', message: len + ' caracteres > máximo ' + max });
  if (_DYN_VC_HTML_TAG_RE.test(value)) errors.push({ path: path, code: 'HTML_IN_TEXT', message: 'el texto contiene algo con forma de etiqueta HTML' });
  if (_DYN_CONTROL_RE.test(value)) errors.push({ path: path, code: 'TEXT_FORMAT', message: 'caracteres de control no permitidos' });
  if (DYN_INTRO_URL_RE.test(value)) errors.push({ path: path, code: 'URL_IN_TEXT', message: 'no se permiten URLs, DOIs ni ISBN' });
  if (!opts.noLints) {
    dynLintResourceMentions(value).forEach(function (h) { errors.push({ path: path, code: 'RESOURCE_MENTION', message: 'menciona un recurso: "' + h.match + '"' }); });
    dynLintQuantityClaims(value).forEach(function (h) { errors.push({ path: path, code: 'QUANTITY_CLAIM', message: 'afirma una cantidad: "' + h.match + '"' }); });
    Array.prototype.push.apply(errors, _dynShellProseErrors(value, path));
  }
  return true;
}

// ── #542 (M1): copia de las intros (lint del cliente, no espejo del servidor) ──
// - SPELLED_NUMBER: como la prosa de la intro no admite dígitos, el modelo escribió una norma con su número
//   en palabras («la Ley mil cuatrocientos ochenta de dos mil once»): eso es solo del guion del audio.
// - NOT_INFINITIVE: competencias/logros que se muestran tras «Al terminar … podrás:» empiezan en infinitivo
//   (en el #542: «Seleccionas…», «Aplicas…»).
var _DYN_NUMW = '(?:cien|ciento|doscient[oa]s|trescient[oa]s|cuatrocient[oa]s|quinient[oa]s|seiscient[oa]s|setecient[oa]s|ochocient[oa]s|novecient[oa]s|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veinti[a-z]+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)';
var DYN_SPELLED_NUMBER_RE = new RegExp('(?:^|[^a-z])((?:(?:dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\\s+)?mil(?:\\s+(?:y\\s+)?' + _DYN_NUMW + ')+|(?:ley|decreto|resolucion|norma|articulo|circular|acuerdo)\\s+' + _DYN_NUMW + '(?:\\s+(?:y\\s+)?' + _DYN_NUMW + ')*)(?![a-z])');
function dynLintSpelledNumber(text) {
  var m = DYN_SPELLED_NUMBER_RE.exec(_dynShellNormalize(text));
  return m ? m[1] : null;
}
var _DYN_INFINITIVE_WORD_RE = /^[a-záéíóúñü]+(?:ar|er|ir|ír)(?:se|lo|la|los|las|le|les)?$/i;
function dynStartsWithInfinitive(text) {
  var m = /^[\s¿¡"«(*-]*([A-Za-zÁÉÍÓÚÑÜáéíóúñü]+)/.exec(String(text || ''));
  return !!(m && _DYN_INFINITIVE_WORD_RE.test(m[1]));
}
function dynLintIntroCopy(doc, kind) {
  var errors = [];
  var spelled = 0;
  var notInfinitive = 0;
  (function walk(v, path) {
    if (typeof v === 'string') {
      if (/^\$\.bibliography/.test(path)) return;
      var hit = dynLintSpelledNumber(v);
      if (hit) { spelled++; errors.push('[SPELLED_NUMBER] ' + path + ': número escrito en palabras ("' + hit + '"): escríbelo con cifras («Ley 1480 de 2011»)'); }
      return;
    }
    if (Array.isArray(v)) { v.forEach(function (x, i) { walk(x, path + '[' + i + ']'); }); return; }
    if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k], path + '.' + k); });
  })(doc, '$');
  var listKey = kind === 'course' ? 'competencies' : 'outcomes';
  var list = doc && Array.isArray(doc[listKey]) ? doc[listKey] : [];
  list.forEach(function (t, i) {
    if (typeof t === 'string' && !dynStartsWithInfinitive(t)) {
      notInfinitive++;
      errors.push('[NOT_INFINITIVE] $.' + listKey + '[' + i + ']: se muestra después de «Al terminar … podrás:»: empieza con un verbo en infinitivo (Aplicar, Seleccionar…), no «' + String(t).trim().split(/\s+/)[0] + '»');
    }
  });
  return { errors: errors, spelled: spelled, notInfinitive: notInfinitive };
}

// ── Fix round 1 (review G5 C1): lint de los slots LLM que el shell muestra ──
// Espejo LITERAL de lintShellProse (R11a intro-schemas.ts, fix round 1). Los
// textos de intro que el shell muestra como prosa (welcome, competencies,
// methodology_note, closing, presentation, outcomes, journey[].line) NO pueden
// traer cifras que cuenten el curso: esas salen de facts. La bibliografía queda exenta.
//  - DIGIT_IN_TEXT: #542 fix round 3 (espejo de V542 M1 del servidor): solo una cifra que CUENTA la
//    estructura o la duración del curso («4 capítulos», «6 semanas»); normas («Ley 1480 de 2011»),
//    plazos del dominio («15 días hábiles») y montos se permiten;
//  - QUANTITY_CLAIM: número en palabras junto a un sustantivo de estructura o
//    de tiempo ("tres módulos", "una docena de lecciones");
//  - FORBIDDEN_CLAIM: certificado/certificación/diploma, PDF, narración
//    profesional, horas, minutos, semanas (§E).
// "un/una" no cuentan como número (demasiado frecuentes en prosa normal).
var DYN_SHELL_NUMBER_WORDS = '(?:dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|' +
  'veinte|veinti[a-z]+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|docena|decena|par)';
var DYN_SHELL_STRUCTURE_OR_TIME_NOUNS = '(?:modulos?|capitulos?|videos?|actividad(?:es)?|preguntas?|intentos?|minutos?|horas?|paginas?|semanas?|dias?|meses|mes|anos?|' +
  'lecciones|leccion|unidad(?:es)?|sesion(?:es)?|clases?|ejercicios?|creditos?|temas?|diapositivas?|palabras?|niveles?|etapas?|' +
  'evaluacion(?:es)?|examen(?:es)?|cuestionarios?|pruebas?|juegos?|presentacion(?:es)?|partes?|secciones?|bloques?)';
var DYN_SHELL_NUMBER_WORD_RE = new RegExp(_DYN_WB_START + DYN_SHELL_NUMBER_WORDS + '\\s+(?:(?:de|del|los|las|sus|[\\p{L}]+)\\s+){0,2}' + DYN_SHELL_STRUCTURE_OR_TIME_NOUNS + _DYN_WB_END, 'gu');
// = DIGIT_COUNTED_NOUNS del servidor (sin días/meses/años: los plazos del dominio se permiten).
var DYN_SHELL_DIGIT_COUNTED_NOUNS = '(?:modulos?|capitulos?|videos?|actividad(?:es)?|preguntas?|intentos?|minutos?|horas?|paginas?|semanas?|' +
  'lecciones|leccion|unidad(?:es)?|sesion(?:es)?|clases?|ejercicios?|creditos?|temas?|diapositivas?|palabras?|niveles?|etapas?|' +
  'evaluacion(?:es)?|examen(?:es)?|cuestionarios?|pruebas?|juegos?|presentacion(?:es)?|partes?|secciones?|bloques?|' +
  // #542 fix round 5 (= servidor be13 92c7257): abreviaturas de duración («997 h», «40 hs», «2 hrs», «30 min»).
  'h|hs|hrs|min)';
var DYN_SHELL_DIGIT_COUNT_RE = new RegExp(_DYN_WB_START + '\\p{Nd}+(?:[.,]\\p{Nd}+)*\\s*(?:[\\p{L}]+\\s+)?' + DYN_SHELL_DIGIT_COUNTED_NOUNS + _DYN_WB_END, 'gu');
var DYN_SHELL_FORBIDDEN_CLAIM_RE = new RegExp(_DYN_WB_START + '(?:certificad[oa]s?|certificacion(?:es)?|certificar|diplomas?|pdf|narracion(?:es)? profesional(?:es)?|narrad[oa]s? profesionalmente|locucion profesional|horas|minutos|semanas)' + _DYN_WB_END, 'gu');

function _dynShellNormalize(text) {
  return String(text == null ? '' : text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\*\*/g, '').replace(/\s+/g, ' ');
}

// → [{code, match}] (mismo orden y forma que lintShellProse).
function dynLintShellProse(text) {
  var hits = [];
  var norm = _dynShellNormalize(text);
  _dynMatchAll(DYN_SHELL_DIGIT_COUNT_RE, norm).forEach(function (m) { hits.push({ code: 'DIGIT_IN_TEXT', match: /\p{Nd}+(?:[.,]\p{Nd}+)*/u.exec(m)[0] }); });
  _dynMatchAll(DYN_SHELL_NUMBER_WORD_RE, norm).forEach(function (m) { hits.push({ code: 'QUANTITY_CLAIM', match: m }); });
  _dynMatchAll(DYN_SHELL_FORBIDDEN_CLAIM_RE, norm).forEach(function (m) { hits.push({ code: 'FORBIDDEN_CLAIM', match: m }); });
  return hits;
}
function _dynShellProseErrors(text, path) {
  return dynLintShellProse(text).map(function (h) {
    var what = h.code === 'DIGIT_IN_TEXT' ? 'cifra que cuenta la estructura o la duración del curso (esas cifras las pone Cursia desde facts)' : h.code === 'FORBIDDEN_CLAIM' ? 'afirmación no respaldada' : 'cantidad en palabras';
    return { path: path, code: h.code, message: what + ': "' + h.match + '"' };
  });
}
function _dynIntroKeys(obj, path, allowed, errors) {
  Object.keys(obj).forEach(function (k) {
    if (allowed.indexOf(k) < 0) errors.push({ path: path + '.' + k, code: 'UNKNOWN_FIELD', message: 'campo no permitido "' + k + '"' });
  });
  allowed.forEach(function (k) {
    if (obj[k] === undefined) errors.push({ path: path + '.' + k, code: 'MISSING_FIELD', message: 'falta "' + k + '"' });
  });
}

function _dynIntroTextList(value, path, min, max, itemMax, errors) {
  if (!Array.isArray(value)) { if (value !== undefined) errors.push({ path: path, code: 'TYPE_MISMATCH', message: 'se esperaba una lista de textos' }); return; }
  if (value.length < min || value.length > max) errors.push({ path: path, code: 'COUNT_RANGE', message: value.length + ' elementos, se esperaban ' + min + '–' + max });
  value.forEach(function (t, i) { _dynIntroText(t, path + '[' + i + ']', itemMax, errors); });
}

// Bibliografía: sin lints de recursos/cantidades (títulos reales pueden
// contener "evaluación" o números); sí sin URLs/DOI/ISBN.
function _dynIntroBibliography(value, path, min, max, errors) {
  if (!Array.isArray(value)) { if (value !== undefined) errors.push({ path: path, code: 'TYPE_MISMATCH', message: 'se esperaba una lista de referencias' }); return; }
  if (value.length < min || value.length > max) errors.push({ path: path, code: 'COUNT_RANGE', message: value.length + ' referencias, se esperaban ' + min + '–' + max });
  value.forEach(function (b, i) {
    var p = path + '[' + i + ']';
    if (!_dynIsPlainObject(b)) { errors.push({ path: p, code: 'NOT_OBJECT', message: 'se esperaba {author,title,year,publisher}' }); return; }
    _dynIntroKeys(b, p, ['author', 'title', 'year', 'publisher'], errors);
    ['author', 'title', 'publisher'].forEach(function (k) { if (b[k] !== undefined) _dynIntroText(b[k], p + '.' + k, 300, errors, { noLints: true }); });
    if (b.year !== undefined && !(Number.isInteger(b.year) && b.year >= 1500 && b.year <= 2100)) {
      errors.push({ path: p + '.year', code: 'TYPE_MISMATCH', message: 'year debe ser un entero de 4 dígitos' });
    }
  });
}

function dynValidateCourseIntroV3(doc) {
  var L = DYN_COURSE_INTRO_V3_LIMITS;
  var errors = [];
  if (!_dynIsPlainObject(doc)) return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'el documento debe ser un objeto' }] };
  _dynIntroKeys(doc, '$', ['schemaVersion', 'welcome', 'competencies', 'methodology_note', 'closing', 'bibliography'], errors);
  if (doc.schemaVersion !== undefined && doc.schemaVersion !== 1) errors.push({ path: '$.schemaVersion', code: 'SCHEMA_VERSION', message: 'schemaVersion debe ser 1' });
  if (doc.welcome !== undefined && _dynIntroText(doc.welcome, '$.welcome', 2000, errors)) {
    var w = _dynWordCount(doc.welcome);
    if (w < L.welcomeMinWords || w > L.welcomeMaxWords) errors.push({ path: '$.welcome', code: 'WORD_RANGE', message: w + ' palabras, se esperaban ' + L.welcomeMinWords + '–' + L.welcomeMaxWords });
  }
  _dynIntroTextList(doc.competencies, '$.competencies', L.competenciesMin, L.competenciesMax, 300, errors);
  if (doc.methodology_note !== undefined && _dynIntroText(doc.methodology_note, '$.methodology_note', 800, errors)) {
    var mw = _dynWordCount(doc.methodology_note);
    if (mw > L.methodologyMaxWords) errors.push({ path: '$.methodology_note', code: 'WORD_RANGE', message: mw + ' palabras > máximo ' + L.methodologyMaxWords });
  }
  if (doc.closing !== undefined) _dynIntroText(doc.closing, '$.closing', 800, errors);
  _dynIntroBibliography(doc.bibliography, '$.bibliography', L.bibliographyMin, L.bibliographyMax, errors);
  return { ok: errors.length === 0, errors: errors };
}

function dynValidateModuleIntroV3(doc, moduleChapterIds) {
  var L = DYN_MODULE_INTRO_V3_LIMITS;
  var errors = [];
  if (!_dynIsPlainObject(doc)) return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'el documento debe ser un objeto' }] };
  _dynIntroKeys(doc, '$', ['schemaVersion', 'presentation', 'outcomes', 'journey', 'bibliography'], errors);
  if (doc.schemaVersion !== undefined && doc.schemaVersion !== 1) errors.push({ path: '$.schemaVersion', code: 'SCHEMA_VERSION', message: 'schemaVersion debe ser 1' });
  if (doc.presentation !== undefined) _dynIntroText(doc.presentation, '$.presentation', 2000, errors);
  _dynIntroTextList(doc.outcomes, '$.outcomes', L.outcomesMin, L.outcomesMax, 300, errors);
  if (doc.journey !== undefined) {
    if (!Array.isArray(doc.journey)) errors.push({ path: '$.journey', code: 'TYPE_MISMATCH', message: 'se esperaba una lista' });
    else {
      var ids = moduleChapterIds || [];
      var got = doc.journey.map(function (j) { return _dynIsPlainObject(j) ? j.chapterId : undefined; });
      if (got.length !== ids.length || got.some(function (id, i) { return id !== ids[i]; })) {
        errors.push({ path: '$.journey', code: 'JOURNEY_MISMATCH', message: 'los chapterId deben ser exactamente [' + ids.join(', ') + '] en ese orden (recibido [' + got.join(', ') + '])' });
      }
      doc.journey.forEach(function (j, i) {
        var p = '$.journey[' + i + ']';
        if (!_dynIsPlainObject(j)) { errors.push({ path: p, code: 'NOT_OBJECT', message: 'se esperaba {chapterId, line}' }); return; }
        _dynIntroKeys(j, p, ['chapterId', 'line'], errors);
        if (j.line !== undefined) _dynIntroText(j.line, p + '.line', 400, errors);
      });
    }
  }
  _dynIntroBibliography(doc.bibliography, '$.bibliography', L.bibliographyMin, L.bibliographyMax, errors);
  return { ok: errors.length === 0, errors: errors };
}

// ════ Espejo de R7 (entradas h5p) y R8 (plan + video_interactions) ════
// Mismas reglas que src/package/h5p/types/*.ts; errores "path: mensaje".
var _DYN_H5P_TAG_RE = /<\/?[a-zA-Z][^<>]*>|<!--|<!\[CDATA\[/;
var _DYN_H5P_ENTITY_RE = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;
var _DYN_H5P_ITEM_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_.\-/]{0,199}$/;

function _dynH5pIssues() {
  var list = [];
  return { list: list, add: function (path, msg) { list.push(path + ': ' + msg); } };
}
function _dynH5pKeys(issues, path, obj, allowed) {
  Object.keys(obj).forEach(function (k) { if (allowed.indexOf(k) < 0) issues.add(path, 'campo desconocido "' + k + '"'); });
}
function _dynH5pPlain(issues, path, v, rule) {
  if (typeof v !== 'string') { issues.add(path, 'debe ser texto'); return false; }
  var t = v.trim();
  var min = rule.min == null ? 1 : rule.min;
  if (t.length < min) { issues.add(path, min === 1 ? 'no puede estar vacío' : 'mínimo ' + min + ' caracteres'); return false; }
  if (t.length > rule.max) issues.add(path, 'máximo ' + rule.max + ' caracteres');
  if (_DYN_H5P_TAG_RE.test(v)) issues.add(path, 'no se permite HTML (solo texto plano)');
  if (_DYN_H5P_ENTITY_RE.test(v)) issues.add(path, 'no se permiten entidades HTML (solo texto plano)');
  if (_DYN_CONTROL_RE.test(v)) issues.add(path, 'caracteres de control no permitidos');
  if (!rule.multiline && /[\r\n]/.test(v)) issues.add(path, 'debe ser una sola línea');
  return true;
}
function _dynH5pArray(issues, path, v, min, max) {
  if (!Array.isArray(v)) { issues.add(path, 'debe ser una lista'); return false; }
  if (v.length < min || v.length > max) { issues.add(path, 'debe tener entre ' + min + ' y ' + max + ' elementos (tiene ' + v.length + ')'); return false; }
  return true;
}
function _dynH5pCommon(issues, input, allowed) {
  _dynH5pKeys(issues, '$', input, allowed);
  if (typeof input.itemKey !== 'string' || !_DYN_H5P_ITEM_KEY_RE.test(input.itemKey)) issues.add('itemKey', 'inválido (letras, dígitos y : _ . - /; sin "#")');
  _dynH5pPlain(issues, 'title', input.title, { max: 200 });
}
function _dynH5pPassPct(issues, v) {
  if (!Number.isInteger(v) || v < 0 || v > 100) issues.add('passPercentage', 'debe ser un entero entre 0 y 100');
}
function _dynH5pAnswers(issues, p, answers, min, max, exactlyOne, allowFeedback, answerMax, normWs) {
  if (!_dynH5pArray(issues, p + '.answers', answers, min, max)) return;
  var correct = 0;
  var seen = {};
  answers.forEach(function (a, j) {
    var ap = p + '.answers[' + j + ']';
    if (!_dynIsPlainObject(a)) { issues.add(ap, 'debe ser un objeto'); return; }
    _dynH5pKeys(issues, ap, a, allowFeedback ? ['text', 'correct', 'feedback'] : ['text', 'correct']);
    if (_dynH5pPlain(issues, ap + '.text', a.text, { max: answerMax })) {
      var norm = a.text.trim().toLowerCase();
      if (normWs) norm = norm.replace(/\s+/g, ' ');
      if (seen[norm]) issues.add(ap + '.text', 'respuesta duplicada');
      seen[norm] = true;
    }
    if (typeof a.correct !== 'boolean') issues.add(ap + '.correct', 'debe ser booleano');
    else if (a.correct) correct++;
    if (allowFeedback && a.feedback !== undefined) _dynH5pPlain(issues, ap + '.feedback', a.feedback, { max: 300 });
  });
  if (exactlyOne && correct !== 1) issues.add(p + '.answers', 'debe haber exactamente 1 correcta (hay ' + correct + ')');
  if (!exactlyOne && correct < 1) issues.add(p + '.answers', 'debe haber al menos 1 correcta');
}

// Espejo de parseBlankMarkup (R7 markup.ts).
function _dynParseBlankMarkup(issues, path, text, mode) {
  var parts = text.split('*');
  var blanks = [];
  if (parts.length % 2 === 0) { issues.add(path, 'asteriscos desbalanceados (cada hueco es *respuesta*)'); return blanks; }
  parts.forEach(function (part, i) {
    if (i % 2 === 0) return;
    var bp = path + ' hueco ' + (blanks.length + 1);
    if (part.length === 0) { issues.add(bp, 'hueco vacío (**)'); return; }
    if (part.trim() !== part) issues.add(bp, 'respuesta con espacios en los bordes ("' + part + '"): ¿asteriscos anidados?');
    if (/[\r\n]/.test(part)) issues.add(bp, 'la respuesta no puede tener saltos de línea');
    if (/[&<>]/.test(part)) issues.add(bp, 'la respuesta no puede contener & < >');
    if (/[:\\]/.test(part)) issues.add(bp, 'sintaxis avanzada no permitida (":" o "\\")');
    var alternatives = [part.trim()];
    if (mode === 'blanks') {
      alternatives = part.split('/').map(function (a) { return a.trim(); });
      if (alternatives.some(function (a) { return a.length === 0; })) issues.add(bp, 'alternativa vacía en "/"');
      // Integrado (review G4 M2): en Blanks "/" SIEMPRE separa alternativas;
      // "km/h" o "1/2" se partirían en respuestas sueltas → se rechazan.
      else if (alternatives.length > 1 && (alternatives.some(function (a) { return a.length < 2; }) || /\d\s*\/|\/\s*\d/.test(part))) {
        issues.add(bp, '"/" separa alternativas; "' + part + '" parece una unidad o fracción (usa otra redacción)');
      }
    }
    if (part.length > 80) issues.add(bp, 'respuesta demasiado larga (máx. 80)');
    blanks.push({ answer: alternatives[0], alternatives: alternatives });
  });
  return blanks;
}

// #583 (I2): DragText legible a 390 px. En el #583 el banco de palabras quedaba ~1.200 px debajo del primer
// hueco (texto de ~1.250 caracteres) y sin distractores (el último hueco salía por descarte). Con un backend que
// acepta `distractors` (claim: activityFeatures.dragTextDistractors) el texto es corto y lleva EXACTAMENTE 2
// distractores que no son la respuesta de ningún hueco. Espejo de los distractores: DragTextInput.distractors
// (backend drag-text.ts). Medido en Chrome con el reproductor H5P real (backend scripts/qa-h5p-mobile-legibility.js),
// peor caso del objetivo a 390 px: 300 caracteres, 5 huecos y 2 distractores de 14 → 536 px del primer hueco al
// final del banco (cabe en 390×664 y 390×844); con palabras de 16 → 740–788 px (no cabe en 664); el #583 → 1.452 px.
// Fix round 1 (I1, ruling): el objetivo móvil NUNCA hace fallar un item que antes pasaba:
//  - objetivo (prompt) = maxText / minBlanks–maxBlanks / wordMax / 2 distractores; pasarse es BLANDO (aviso + el
//    reintento dirigido de siempre; si el reintento falla, se conserva la primera respuesta válida);
//  - DURO solo pasado un tamaño medido inservible: texto > hardMaxText (600: 980 px) o más de hardMaxBlanks (6) huecos;
//  - distractores de más o inválidos se descartan (determinístico); con 0–1 válidos, aviso.
var DYN_DRAGTEXT_MOBILE = { maxText: 300, minBlanks: 4, maxBlanks: 5, distractors: 2, wordMax: 14, hardMaxText: 600, hardMaxBlanks: 6 };
var DYN_DRAGTEXT_LIMITS = { maxDistractors: 4, distractorMax: 80 };
function dynDragTextWordKey(s) { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function _dynDragTextDistractors(issues, v, blanks) {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length < 1 || v.length > DYN_DRAGTEXT_LIMITS.maxDistractors) { issues.add('distractors', 'debe ser una lista de 1 a ' + DYN_DRAGTEXT_LIMITS.maxDistractors + ' palabras'); return; }
  var answers = {};
  blanks.forEach(function (b) { answers[dynDragTextWordKey(b)] = true; });
  var seen = {};
  v.forEach(function (d, i) {
    var p = 'distractors[' + i + ']';
    if (!_dynH5pPlain(issues, p, d, { max: DYN_DRAGTEXT_LIMITS.distractorMax })) return;
    var x = d.trim();
    if (/[*:\\&<>]/.test(x)) issues.add(p, 'no puede contener * : \\ & < >');
    var k = dynDragTextWordKey(x);
    if (answers[k]) issues.add(p, '"' + x + '" es la respuesta de un hueco: un distractor nunca es una respuesta correcta');
    if (seen[k]) issues.add(p, '"' + x + '" repetido');
    seen[k] = true;
  });
}

// Valida `data` (entrada R7 completa, con itemKey/passPercentage) por tipo.
// Devuelve { ok, errors: string[] }. opts.dragTextMobile (#583 I2): reglas del DragText para teléfono.
function dynValidateH5pActivityData(type, data, opts) {
  var issues = _dynH5pIssues();
  var soft = [];
  if (!_dynIsPlainObject(data)) { issues.add('$', 'debe ser un objeto'); return { ok: false, errors: issues.list }; }
  if (type === 'questionset') {
    _dynH5pCommon(issues, data, ['itemKey', 'title', 'questions', 'passPercentage']);
    _dynH5pPassPct(issues, data.passPercentage);
    if (_dynH5pArray(issues, 'questions', data.questions, 2, 20)) {
      data.questions.forEach(function (q, i) {
        var p = 'questions[' + i + ']';
        if (!_dynIsPlainObject(q)) { issues.add(p, 'debe ser un objeto'); return; }
        if (q.kind === 'multichoice') {
          _dynH5pKeys(issues, p, q, ['kind', 'question', 'answers']);
          _dynH5pPlain(issues, p + '.question', q.question, { max: 400 });
          _dynH5pAnswers(issues, p, q.answers, 2, 5, true, true, 200, false); // R13 fix: espejo de exactlyOneCorrect del backend (1 correcta)
        } else if (q.kind === 'truefalse') {
          _dynH5pKeys(issues, p, q, ['kind', 'question', 'correct', 'feedbackCorrect', 'feedbackWrong']);
          _dynH5pPlain(issues, p + '.question', q.question, { max: 400 });
          if (typeof q.correct !== 'boolean') issues.add(p + '.correct', 'debe ser booleano');
          if (q.feedbackCorrect !== undefined) _dynH5pPlain(issues, p + '.feedbackCorrect', q.feedbackCorrect, { max: 300 });
          if (q.feedbackWrong !== undefined) _dynH5pPlain(issues, p + '.feedbackWrong', q.feedbackWrong, { max: 300 });
        } else {
          issues.add(p + '.kind', 'debe ser "multichoice" o "truefalse"');
        }
      });
    }
  } else if (type === 'singlechoiceset') {
    _dynH5pCommon(issues, data, ['itemKey', 'title', 'questions', 'passPercentage']);
    _dynH5pPassPct(issues, data.passPercentage);
    if (_dynH5pArray(issues, 'questions', data.questions, 2, 20)) {
      data.questions.forEach(function (q, i) {
        var p = 'questions[' + i + ']';
        if (!_dynIsPlainObject(q)) { issues.add(p, 'debe ser un objeto'); return; }
        _dynH5pKeys(issues, p, q, ['question', 'answers']);
        _dynH5pPlain(issues, p + '.question', q.question, { max: 400 });
        _dynH5pAnswers(issues, p, q.answers, 2, 4, true, false, 200, false);
      });
    }
  } else if (type === 'dragtext') {
    var mob = !!(opts && opts.dragTextMobile);
    // m6: `distractors` solo existe si el backend lo anunció (el ejecutor lo quita antes en otro caso).
    _dynH5pCommon(issues, data, ['itemKey', 'title', 'taskDescription', 'text'].concat(mob ? ['distractors'] : []));
    _dynH5pPlain(issues, 'taskDescription', data.taskDescription, { max: 400 });
    if (_dynH5pPlain(issues, 'text', data.text, { max: 3000, multiline: true })) {
      var b = _dynParseBlankMarkup(issues, 'text', data.text, 'dragtext');
      if (b.length < 2) issues.add('text', 'se requieren al menos 2 huecos (hay ' + b.length + ')');
      if (b.length > 20) issues.add('text', 'máximo 20 huecos');
      _dynDragTextDistractors(issues, data.distractors, b.map(function (x) { return x.answer; }));
      if (mob) {
        var M = DYN_DRAGTEXT_MOBILE;
        var tl = data.text.trim().length;
        // Duro: tamaño medido inservible en un teléfono (o lo que rompería la nota: menos de 2 huecos, arriba).
        if (tl > M.hardMaxText) issues.add('text', 'en el teléfono el banco de palabras queda a más de una pantalla de los huecos: máximo ' + M.hardMaxText + ' caracteres (tiene ' + tl + '); acorta el texto a unos ' + M.maxText);
        if (b.length > M.hardMaxBlanks) issues.add('text', 'en el teléfono como máximo ' + M.hardMaxBlanks + ' huecos (hay ' + b.length + '); deja ' + M.minBlanks + ' o ' + M.maxBlanks);
        // Blando: fuera del objetivo pero usable (aviso + reintento dirigido; nunca hace fallar el item).
        var sw = function (path, msg) { soft.push('[DRAGTEXT_MOBILE] ' + path + ': ' + msg); };
        if (tl > M.maxText && tl <= M.hardMaxText) sw('text', 'para que el banco de palabras quede en la misma pantalla que los huecos, como máximo ' + M.maxText + ' caracteres (tiene ' + tl + ')');
        if ((b.length < M.minBlanks || b.length > M.maxBlanks) && b.length <= M.hardMaxBlanks) sw('text', 'entre ' + M.minBlanks + ' y ' + M.maxBlanks + ' huecos (hay ' + b.length + ')');
        b.forEach(function (x, k) { if (x.answer.length > M.wordMax) sw('text hueco ' + (k + 1), '"' + x.answer + '": en el teléfono cada palabra del banco tiene como máximo ' + M.wordMax + ' caracteres (1 o 2 palabras)'); });
        var nd = Array.isArray(data.distractors) ? data.distractors.length : 0;
        if (nd !== M.distractors) sw('distractors', 'exactamente ' + M.distractors + ' distractores válidos (palabras plausibles que NO son la respuesta de ningún hueco); hay ' + nd);
        else data.distractors.forEach(function (d, k) { if (typeof d === 'string' && d.trim().length > M.wordMax) sw('distractors[' + k + ']', '"' + d.trim() + '": como máximo ' + M.wordMax + ' caracteres (1 o 2 palabras)'); });
      }
    } else if (data.distractors !== undefined) {
      _dynDragTextDistractors(issues, data.distractors, []);
    }
  } else if (type === 'blanks') {
    _dynH5pCommon(issues, data, ['itemKey', 'title', 'text', 'questions']);
    _dynH5pPlain(issues, 'text', data.text, { max: 400 });
    if (_dynH5pArray(issues, 'questions', data.questions, 1, 20)) {
      var total = 0;
      data.questions.forEach(function (q, i) {
        var p = 'questions[' + i + ']';
        if (!_dynH5pPlain(issues, p, q, { max: 500 })) return;
        var bl = _dynParseBlankMarkup(issues, p, q, 'blanks');
        if (bl.length < 1) issues.add(p, 'cada frase necesita al menos 1 hueco');
        total += bl.length;
      });
      if (total < 2) issues.add('questions', 'se requieren al menos 2 huecos en total (hay ' + total + ')');
      if (total > 30) issues.add('questions', 'máximo 30 huecos en total');
    }
  } else if (type === 'branchingscenario') {
    // EV6 H5P v2: espejo de validateBranchingScenarioData + lint RESOURCE_MENTION del backend
    // (validateH5pActivityPayload). Errores "[BS_CODE] path: mensaje" (el reintento dirigido los nombra).
    dynValidateBranchingScenarioData(data, { allowItemKey: true }).forEach(function (e) { issues.list.push('[' + e.code + '] ' + e.path + ': ' + e.message); });
    if ('itemKey' in data && (typeof data.itemKey !== 'string' || !_DYN_H5P_ITEM_KEY_RE.test(data.itemKey))) issues.add('itemKey', 'inválido (letras, dígitos y : _ . - /; sin "#")');
    _dynBranchingScenarioTexts(data).forEach(function (pt) {
      dynLintResourceMentions(pt[1]).forEach(function (h) { issues.list.push('[RESOURCE_MENTION] ' + pt[0] + ': menciona un recurso del curso ("' + h.match + '"): el caso debe sostenerse solo'); });
    });
  } else {
    issues.add('type', 'tipo h5p desconocido "' + type + '"');
  }
  return { ok: issues.list.length === 0, errors: issues.list, soft: soft };
}

// #583 fix round 1 (I1/m6): distractores del DragText, determinístico y ANTES de validar.
//  - sin el anuncio del backend (mobile=false): la clave `distractors` se quita (un backend anterior la rechazaría);
//  - con el anuncio: se descartan los inválidos (no texto, vacíos, > 80, con * : \ & < >, iguales a una respuesta o
//    repetidos) y los que sobran después de DYN_DRAGTEXT_MOBILE.distractors; sin ninguno válido, se quita la clave.
// → { stripped, dropped: [texto], kept }
function dynRepairDragTextDistractors(data, mobile) {
  var out = { stripped: false, dropped: [], kept: 0 };
  if (!_dynIsPlainObject(data) || !('distractors' in data)) return out;
  if (!mobile) { delete data.distractors; out.stripped = true; return out; }
  var v = data.distractors;
  if (!Array.isArray(v)) { delete data.distractors; out.dropped.push(String(v)); return out; }
  var answers = {};
  if (typeof data.text === 'string') {
    String(data.text).split('*').forEach(function (part, i) { if (i % 2 === 1 && part.trim()) answers[dynDragTextWordKey(part)] = true; });
  }
  var seen = {};
  var keep = [];
  v.forEach(function (d) {
    var x = typeof d === 'string' ? d.trim() : '';
    var k = dynDragTextWordKey(x);
    var bad = !x || x.length > DYN_DRAGTEXT_LIMITS.distractorMax || /[*:\\&<>\r\n]/.test(x) || _DYN_H5P_TAG_RE.test(x) || _DYN_H5P_ENTITY_RE.test(x) || _DYN_CONTROL_RE.test(x) || answers[k] || seen[k] || keep.length >= DYN_DRAGTEXT_MOBILE.distractors;
    if (bad) { out.dropped.push(typeof d === 'string' ? d : JSON.stringify(d)); return; }
    seen[k] = true;
    keep.push(x);
  });
  if (keep.length) data.distractors = keep; else delete data.distractors;
  out.kept = keep.length;
  return out;
}

// ════ EV6 H5P v2 — espejo de validateBranchingScenarioData (backend branching-scenario.ts) ════
// Devuelve TODOS los problemas {code, path, message}; lista vacía ⇔ válido. Mismos códigos BS_* que el
// servidor (BS_SHAPE, BS_TEXT, BS_REF, BS_FORWARD_ONLY, BS_UNREACHABLE, BS_DEAD_END, BS_ENDINGS,
// BS_DUP_OPTION, BS_DEPTH, BS_PATHS, BS_NODES). El servidor re-valida al completar y es autoritativo.
var _DYN_BS_DECISION_ID_RE = /^d[1-6]$/;
var _DYN_BS_ENDING_ID_RE = /^e[1-5]$/;
var _DYN_BS_NEXT_RE = /^(?:d[1-9]\d*|end:e[1-9]\d*)$/;
var _DYN_BS_QUALITIES = ['optimal', 'acceptable', 'poor'];

function dynValidateBranchingScenarioData(data, opts) {
  var L = DYN_BS_LIMITS;
  var out = [];
  function push(code, path, message) { out.push({ code: code, path: path, message: message }); }
  function text(path, v, max, multiline) {
    if (typeof v !== 'string') { push('BS_TEXT', path, 'debe ser texto'); return false; }
    var t = v.trim();
    if (!t) { push('BS_TEXT', path, 'no puede estar vacío'); return false; }
    if (t.length > max) push('BS_TEXT', path, 'máximo ' + max + ' caracteres (tiene ' + t.length + ')');
    if (_DYN_H5P_TAG_RE.test(v)) push('BS_TEXT', path, 'no se permite HTML (solo texto plano)');
    if (_DYN_H5P_ENTITY_RE.test(v)) push('BS_TEXT', path, 'no se permiten entidades HTML');
    if (_DYN_CONTROL_RE.test(v)) push('BS_TEXT', path, 'caracteres de control no permitidos');
    if (!multiline && /[\r\n]/.test(v)) push('BS_TEXT', path, 'debe ser una sola línea');
    return true;
  }
  function keys(path, o, allowed) {
    Object.keys(o).forEach(function (k) { if (allowed.indexOf(k) < 0) push('BS_SHAPE', path, 'campo desconocido "' + k + '"'); });
  }
  function list(path, v, min, max) {
    if (!Array.isArray(v)) { push('BS_SHAPE', path, 'debe ser una lista'); return false; }
    if (v.length < min || v.length > max) { push('BS_SHAPE', path, 'debe tener entre ' + min + ' y ' + max + ' elementos (tiene ' + v.length + ')'); return false; }
    return true;
  }
  function norm(s) { return s.trim().toLowerCase().replace(/\s+/g, ' '); }
  if (!_dynIsPlainObject(data)) return [{ code: 'BS_SHAPE', path: '$', message: 'debe ser un objeto' }];
  keys('$', data, ['title', 'situation', 'decisions', 'endings'].concat(opts && opts.allowItemKey ? ['itemKey'] : []));
  text('title', data.title, L.titleMax);
  text('situation', data.situation, L.situationMax, true);

  // Finales
  var endings = {};
  var endingOrder = [];
  var endingsOk = list('endings', data.endings, L.minEndings, L.maxEndings);
  if (endingsOk) {
    data.endings.forEach(function (e, i) {
      var p = 'endings[' + i + ']';
      if (!_dynIsPlainObject(e)) { push('BS_SHAPE', p, 'debe ser un objeto'); return; }
      keys(p, e, ['id', 'quality', 'title', 'text']);
      var idOk = typeof e.id === 'string' && _DYN_BS_ENDING_ID_RE.test(e.id);
      if (!idOk) push('BS_SHAPE', p + '.id', 'debe ser "e1".."e5"');
      else if (Object.prototype.hasOwnProperty.call(endings, e.id)) push('BS_SHAPE', p + '.id', 'id duplicado ' + e.id);
      var qOk = _DYN_BS_QUALITIES.indexOf(e.quality) >= 0;
      if (!qOk) push('BS_SHAPE', p + '.quality', 'debe ser "optimal", "acceptable" o "poor"');
      text(p + '.title', e.title, L.endingTitleMax);
      text(p + '.text', e.text, L.endingTextMax);
      if (idOk && !Object.prototype.hasOwnProperty.call(endings, e.id) && qOk) { endings[e.id] = { quality: e.quality, index: i }; endingOrder.push(e.id); }
    });
  }

  // Decisiones
  var decisionIndex = {};
  var decisionsOk = list('decisions', data.decisions, L.minDecisions, L.maxDecisions);
  var decisions = decisionsOk ? data.decisions : [];
  decisions.forEach(function (d, i) {
    if (_dynIsPlainObject(d) && typeof d.id === 'string' && _DYN_BS_DECISION_ID_RE.test(d.id) && !Object.prototype.hasOwnProperty.call(decisionIndex, d.id)) decisionIndex[d.id] = i;
  });
  var edges = decisions.map(function () { return []; });
  decisions.forEach(function (d, i) {
    var p = 'decisions[' + i + ']';
    if (!_dynIsPlainObject(d)) { push('BS_SHAPE', p, 'debe ser un objeto'); return; }
    keys(p, d, ['id', 'question', 'options']);
    if (typeof d.id !== 'string' || !_DYN_BS_DECISION_ID_RE.test(d.id)) push('BS_SHAPE', p + '.id', 'debe ser "d1".."d6"');
    else if (decisionIndex[d.id] !== i) push('BS_SHAPE', p + '.id', 'id duplicado ' + d.id);
    text(p + '.question', d.question, L.questionMax);
    if (!list(p + '.options', d.options, L.minOptions, L.maxOptions)) return;
    var seen = {};
    d.options.forEach(function (o, j) {
      var op = p + '.options[' + j + ']';
      if (!_dynIsPlainObject(o)) { push('BS_SHAPE', op, 'debe ser un objeto'); return; }
      keys(op, o, ['text', 'next', 'consequence']);
      if (text(op + '.text', o.text, L.optionTextMax)) {
        var n = norm(o.text);
        if (seen[n]) push('BS_DUP_OPTION', op + '.text', 'opción repetida en la misma decisión');
        seen[n] = true;
      }
      if (o.consequence !== undefined) text(op + '.consequence', o.consequence, L.consequenceMax);
      var next = o.next;
      if (next === undefined || next === null || (typeof next === 'string' && next.trim() === '')) {
        push('BS_DEAD_END', op + '.next', 'la opción no tiene destino (debe ser "dN" o "end:eK")');
        return;
      }
      if (typeof next !== 'string' || !_DYN_BS_NEXT_RE.test(next)) {
        push('BS_REF', op + '.next', 'destino inválido ' + JSON.stringify(next) + ' (debe ser "dN" o "end:eK")');
        return;
      }
      if (next.indexOf('end:') === 0) {
        var eid = next.slice(4);
        if (!Object.prototype.hasOwnProperty.call(endings, eid)) push('BS_REF', op + '.next', 'el final ' + eid + ' no existe');
        else edges[i].push({ ending: eid });
        return;
      }
      var t = decisionIndex[next];
      if (t === undefined) { push('BS_REF', op + '.next', 'la decisión ' + next + ' no existe'); return; }
      if (t <= i) { push('BS_FORWARD_ONLY', op + '.next', next + ' no está declarada después de ' + String(d.id) + ' (solo se avanza: sin ciclos)'); return; }
      edges[i].push({ decision: t });
    });
  });

  // Grafo: solo con forma básica válida y sin aristas inválidas (fix round 1 m-2 del backend).
  var edgeErrors = out.some(function (e) { return e.code === 'BS_REF' || e.code === 'BS_DEAD_END' || e.code === 'BS_FORWARD_ONLY'; });
  var shapeBlock = out.some(function (e) { return e.code === 'BS_SHAPE' && /\.id$|^decisions$|^endings$|options$/.test(e.path); });
  if (decisionsOk && endingsOk && !edgeErrors && !shapeBlock && decisions.length) {
    var reached = {};
    var endingDepth = {};
    var paths = 0;
    var maxDepthAll = 0;
    var dfs = function (i, depth) {
      if (paths > 10000) return;
      reached[i] = true;
      if (depth > maxDepthAll) maxDepthAll = depth;
      edges[i].forEach(function (e) {
        if (e.ending !== undefined) { paths++; endingDepth[e.ending] = Math.max(endingDepth[e.ending] || 0, depth); }
        else if (e.decision !== undefined) dfs(e.decision, depth + 1);
      });
    };
    dfs(0, 1);
    decisions.forEach(function (d, i) {
      if (!reached[i]) {
        var id = _dynIsPlainObject(d) && typeof d.id === 'string' ? d.id : '#' + (i + 1);
        push('BS_UNREACHABLE', 'decisions[' + i + ']', 'la decisión ' + id + ' (posición ' + (i + 1) + ') no se alcanza desde la situación');
      }
    });
    endingOrder.forEach(function (eid) {
      if (!Object.prototype.hasOwnProperty.call(endingDepth, eid)) push('BS_UNREACHABLE', 'endings[' + endings[eid].index + ']', 'el final ' + eid + ' no se alcanza desde la situación');
    });
    if (paths > L.maxPaths) push('BS_PATHS', 'decisions', 'hay ' + paths + ' caminos distintos (máximo ' + L.maxPaths + ')');
    if (maxDepthAll > L.maxDepth) push('BS_DEPTH', 'decisions', 'un camino recorre ' + maxDepthAll + ' decisiones (máximo ' + L.maxDepth + ')');
    if (maxDepthAll < 2) push('BS_DEPTH', 'decisions', 'ningún camino recorre 2 o más decisiones');
    var optimal = endingOrder.filter(function (eid) { return endings[eid].quality === 'optimal'; });
    var poor = endingOrder.filter(function (eid) { return endings[eid].quality === 'poor'; });
    if (optimal.length > L.maxOptimal) push('BS_ENDINGS', 'endings', 'máximo ' + L.maxOptimal + ' finales "optimal" (hay ' + optimal.length + ')');
    if (!poor.length) push('BS_ENDINGS', 'endings', 'falta al menos un final "poor"');
    if (!optimal.some(function (eid) { return (endingDepth[eid] || 0) >= 2; })) push('BS_ENDINGS', 'endings', 'ningún final "optimal" se alcanza tras 2 o más decisiones');
  }
  if (Array.isArray(data.decisions) && 1 + data.decisions.length > L.maxContentNodes) {
    push('BS_NODES', 'decisions', 'máximo ' + L.maxContentNodes + ' nodos H5P (situación + ' + data.decisions.length + ' decisiones)');
  }
  return out;
}

// Textos [ruta, valor] de un caso ramificado para el lint RESOURCE_MENTION (espejo de branchingScenarioTexts).
function _dynBranchingScenarioTexts(data) {
  var out = [];
  function take(p, v) { if (typeof v === 'string') out.push([p, v]); }
  if (!_dynIsPlainObject(data)) return out;
  take('title', data.title);
  take('situation', data.situation);
  if (Array.isArray(data.decisions)) {
    data.decisions.forEach(function (d, i) {
      if (!_dynIsPlainObject(d)) return;
      take('decisions[' + i + '].question', d.question);
      if (Array.isArray(d.options)) d.options.forEach(function (o, j) {
        if (!_dynIsPlainObject(o)) return;
        take('decisions[' + i + '].options[' + j + '].text', o.text);
        take('decisions[' + i + '].options[' + j + '].consequence', o.consequence);
      });
    });
  }
  if (Array.isArray(data.endings)) {
    data.endings.forEach(function (e, i) {
      if (!_dynIsPlainObject(e)) return;
      take('endings[' + i + '].title', e.title);
      take('endings[' + i + '].text', e.text);
    });
  }
  return out;
}

// ════ #542 (I1) — sesgo de patrón de respuesta en las prácticas H5P, las preguntas del video y el caso ramificado ════
// En el curso #542 la correcta era la opción más larga en 19/33 MC de H5P (el banco de exámenes, con su
// guardia, 12/74), 9/11 V/F eran «Falso» y la mejor opción del caso ramificado era SIEMPRE la más larga.
// No hay validador del servidor para esto (el banco tiene el suyo), así que el cliente lo revisa.
//
// Fix round 1 (I1): un set chico NO se juzga por proporciones crudas (con 3 MC, una sola correcta más
// larga ya era «33 %» y pedía un reintento pagado en ~2/3 de los sets SIN sesgo). Ahora el reintento
// se pide solo cuando el patrón es improbable por azar:
//   - Longitud: para cada MC, el rango de la correcta entre sus opciones (0 = la más corta … m−1 = la
//     más larga; empates = medio punto) es uniforme bajo la hipótesis nula (sin sesgo). Prueba exacta de la
//     suma de rangos normalizados (cola superior). Misma prueba para la mejor opción de cada decisión del
//     caso ramificado (la que lleva al mejor final alcanzable).
//   - V/F: binomial exacta de dos colas contra p = 0,5.
//   - Cada prueba con α = 0,025 (dos pruebas → ≤ 5 % de reintentos por item sin sesgo).
//   - Acumulado del run: el patrón del #542 era del CURSO (19/33, 9/11), no de un set. Las pruebas usan las
//     respuestas ya aceptadas de los demás items del mismo run en esta pestaña (memoria + sessionStorage,
//     mejor esfuerzo) más las de este item, y solo piden reintento si ESTE item empuja en la misma
//     dirección. Bajo la hipótesis nula cada decisión sigue siendo ≤ α (prueba exacta, conservadora).
// Siempre blando (fix round 1, I2): nunca hace fallar una parte; si el reintento sale peor o roto, se
// conserva la primera respuesta válida y queda registrado en el summary (`answerBias`).
var DYN_BIAS_ALPHA = 0.025;
var DYN_ANSWER_OUTLIER_MIN_DIFF = 8;
var DYN_ANSWER_OUTLIER_MIN_PCT = 15;
var DYN_BIAS_POOL_PREFIX = 'cursia.answerBias.v1|';
var _DYN_BS_QUALITY_RANK = { optimal: 3, acceptable: 2, poor: 1 };
var _DYN_BIAS_POOL = {};

function _dynAnsLen(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().length; }

// ¿El primer V/F del set debe ser verdadero? (sembrado: estable por item, mitad y mitad entre items; solo prompt)
function dynTfFirstTrue(seed) { return (dynFnv1a32('tf|' + String(seed || '')) & 1) === 1; }

// Rango de la longitud de `len` entre `others` (cuántas más cortas + medio punto por empate).
function _dynLenRank(len, others) {
  var r = 0;
  others.forEach(function (o) { if (o < len) r += 1; else if (o === len) r += 0.5; });
  return r;
}

// Calidad del mejor final alcanzable desde cada opción (grafo hacia adelante, sin ciclos).
function _dynBsOptionRanks(data) {
  var endQ = {};
  (data.endings || []).forEach(function (e) { if (_dynIsPlainObject(e)) endQ[e.id] = _DYN_BS_QUALITY_RANK[e.quality] || 0; });
  var byId = {};
  (data.decisions || []).forEach(function (d) { if (_dynIsPlainObject(d)) byId[d.id] = d; });
  var memo = {};
  function best(next, depth) {
    if (typeof next !== 'string' || depth > 12) return 0;
    if (next.indexOf('end:') === 0) return endQ[next.slice(4)] || 0;
    if (Object.prototype.hasOwnProperty.call(memo, next)) return memo[next];
    var d = byId[next];
    var r = 0;
    if (d && Array.isArray(d.options)) d.options.forEach(function (o) { if (_dynIsPlainObject(o)) r = Math.max(r, best(o.next, depth + 1)); });
    memo[next] = r;
    return r;
  }
  return (data.decisions || []).map(function (d) {
    return (_dynIsPlainObject(d) && Array.isArray(d.options)) ? d.options.map(function (o) { return _dynIsPlainObject(o) ? best(o.next, 0) : 0; }) : [];
  });
}

// Señales de un item: ranks [{m, r, path, longest, outlier}] y tf [{v, path}].
// kind: 'questionset' | 'video_interactions' | 'branchingscenario'.
function dynAnswerBiasSignals(kind, data) {
  var out = { ranks: [], tf: [] };
  if (!_dynIsPlainObject(data)) return out;
  if (kind === 'branchingscenario') {
    if (!Array.isArray(data.decisions)) return out;
    var q = _dynBsOptionRanks(data);
    data.decisions.forEach(function (d, i) {
      if (!_dynIsPlainObject(d) || !Array.isArray(d.options) || d.options.length < 2) return;
      var top = Math.max.apply(null, q[i]);
      var tops = q[i].map(function (x, j) { return x === top ? j : -1; }).filter(function (j) { return j >= 0; });
      if (tops.length !== 1) return; // sin una mejor opción única no hay patrón que esconder
      var bj = tops[0];
      var bl = _dynAnsLen(d.options[bj].text);
      var others = d.options.filter(function (o, j) { return j !== bj; }).map(function (o) { return _dynAnsLen(o && o.text); });
      var omax = Math.max.apply(null, others);
      out.ranks.push({ m: d.options.length, r: _dynLenRank(bl, others), path: 'decisions[' + i + '].options[' + bj + ']', longest: bl > omax,
        outlier: bl - omax >= DYN_ANSWER_OUTLIER_MIN_DIFF && 100 * (bl - omax) >= 20 * omax });
    });
    return out;
  }
  var key = kind === 'video_interactions' ? 'checkpoints' : 'questions';
  (Array.isArray(data[key]) ? data[key] : []).forEach(function (it, i) {
    if (!_dynIsPlainObject(it)) return;
    var p = key + '[' + i + ']';
    if (it.kind === 'truefalse' && typeof it.correct === 'boolean') { out.tf.push({ v: it.correct, path: p }); return; }
    if (!Array.isArray(it.answers) || (it.kind && it.kind !== 'multichoice')) return;
    var right = it.answers.filter(function (a) { return a && a.correct === true; });
    var wrong = it.answers.filter(function (a) { return a && a.correct === false; });
    if (right.length !== 1 || !wrong.length) return;
    var c = _dynAnsLen(right[0].text);
    var wl = wrong.map(function (a) { return _dynAnsLen(a.text); });
    var lmax = Math.max.apply(null, wl);
    out.ranks.push({ m: wl.length + 1, r: _dynLenRank(c, wl), path: p, longest: c > lmax,
      outlier: c - lmax >= DYN_ANSWER_OUTLIER_MIN_DIFF && 100 * (c - lmax) >= DYN_ANSWER_OUTLIER_MIN_PCT * lmax });
  });
  return out;
}

function _dynGcd(a, b) { while (b) { var t = b; b = a % b; a = t; } return a; }
// P(S ≥ s_obs) exacta: S = Σ rango_i / (m_i − 1), rango_i uniforme en {0…m_i−1} (enteros escalados).
function dynRankSumUpperP(ranks) {
  var list = (ranks || []).filter(function (x) { return x && x.m >= 2; });
  if (!list.length) return 1;
  var L = 2;
  list.forEach(function (x) { L = L * (x.m - 1) / _dynGcd(L, x.m - 1); });
  var dist = { 0: 1 };
  var obs = 0;
  list.forEach(function (x) {
    var step = L / (x.m - 1);
    obs += Math.round(x.r * step);
    var nd = {};
    Object.keys(dist).forEach(function (v) {
      for (var k = 0; k < x.m; k++) { var nv = +v + k * step; nd[nv] = (nd[nv] || 0) + dist[v] / x.m; }
    });
    dist = nd;
  });
  var p = 0;
  Object.keys(dist).forEach(function (v) { if (+v >= obs) p += dist[v]; });
  return Math.min(1, p);
}
// P de dos colas, binomial exacta con p = 0,5: n afirmaciones, t verdaderas.
function dynTfTwoSidedP(n, t) {
  if (!n) return 1;
  var lo = Math.min(t, n - t);
  var c = 1;
  var p = 0;
  for (var k = 0; k <= n; k++) {
    if (k > 0) c = c * (n - k + 1) / k;
    if (Math.min(k, n - k) <= lo) p += c;
  }
  return Math.min(1, p / Math.pow(2, n));
}

// ── Acumulado por run (señales de los items ya aceptados) ──
function _dynBiasRunKey(item) { return String((item && item.runId) || 'local'); }
function _dynBiasPool(runKey) {
  if (!_DYN_BIAS_POOL[runKey]) {
    var st = (typeof _dynEbStorage === 'function') ? _dynEbStorage() : null;
    var loaded = null;
    try { if (st) loaded = JSON.parse(st.getItem(DYN_BIAS_POOL_PREFIX + runKey) || 'null'); } catch (e) { loaded = null; }
    _DYN_BIAS_POOL[runKey] = (loaded && loaded.v === 1 && _dynIsPlainObject(loaded.items)) ? loaded.items : {};
  }
  return _DYN_BIAS_POOL[runKey];
}
// Registra las señales de la respuesta ACEPTADA de un item (reemplaza las de un intento anterior del mismo item).
function dynAnswerBiasRemember(item, kind, data) {
  var key = _dynBiasRunKey(item);
  var pool = _dynBiasPool(key);
  var s = dynAnswerBiasSignals(kind, data);
  pool[String(item.itemKey)] = { ranks: s.ranks.map(function (x) { return { m: x.m, r: x.r }; }), tf: s.tf.map(function (x) { return x.v; }) };
  var st = (typeof _dynEbStorage === 'function') ? _dynEbStorage() : null;
  try { if (st) st.setItem(DYN_BIAS_POOL_PREFIX + key, JSON.stringify({ v: 1, items: pool })); } catch (e) { /* sin espacio: solo memoria */ }
}

// Prueba de un item contra el acumulado del run. → { stats, errors }.
function dynAnswerBiasTest(item, kind, data) {
  var own = dynAnswerBiasSignals(kind, data);
  var pool = _dynBiasPool(_dynBiasRunKey(item));
  var ranks = own.ranks.map(function (x) { return { m: x.m, r: x.r }; });
  var tfs = own.tf.map(function (x) { return x.v; });
  var pooledItems = 0;
  Object.keys(pool).forEach(function (k) {
    if (k === String(item.itemKey)) return;
    pooledItems++;
    ranks = ranks.concat(pool[k].ranks || []);
    tfs = tfs.concat(pool[k].tf || []);
  });
  var errors = [];
  // Longitud: cola superior; este item tiene que empujar hacia «la correcta es la más larga».
  var pLen = dynRankSumUpperP(ranks);
  var ownMean = own.ranks.length ? own.ranks.reduce(function (s, x) { return s + x.r / (x.m - 1); }, 0) / own.ranks.length : 0;
  var longestPooled = ranks.filter(function (x) { return x.r === x.m - 1; }).length;
  if (own.ranks.length && pLen < DYN_BIAS_ALPHA && ownMean > 0.5) {
    var fix = own.ranks.filter(function (x) { return x.outlier; }).concat(own.ranks.filter(function (x) { return x.longest && !x.outlier; }));
    var code = kind === 'branchingscenario' ? 'BS_LENGTH_BIAS' : 'ANSWER_LENGTH_BIAS';
    var what = kind === 'branchingscenario' ? 'la mejor opción' : 'la respuesta correcta';
    errors.push('[' + code + '] ' + what + ' tiende a ser la más larga (' + longestPooled + ' de ' + ranks.length + (pooledItems ? ' en las partes de este curso' : '') +
      '; un patrón así no se da por azar): ' + (fix.length ? 'en ' + fix.map(function (x) { return x.path; }).join(', ') + ' ' : '') +
      'haz que una opción ' + (kind === 'branchingscenario' ? 'peor' : 'incorrecta') + ' sea igual o más larga y detallada' + (kind === 'branchingscenario' ? ' (± 20 %)' : '') + '.');
  }
  // V/F: dos colas; este item tiene que tener mayoría del mismo valor que el acumulado.
  var n = tfs.length;
  var t = tfs.filter(Boolean).length;
  var pTf = dynTfTwoSidedP(n, t);
  if (own.tf.length && 2 * t !== n && pTf < DYN_BIAS_ALPHA) {
    var major = 2 * t > n;
    var ownMajor = own.tf.filter(function (x) { return x.v === major; });
    if (2 * ownMajor.length > own.tf.length) {
      errors.push('[TF_BALANCE] ' + (major ? t : n - t) + ' de ' + n + ' afirmaciones V/F' + (pooledItems ? ' de este curso' : '') + ' son ' + (major ? 'verdaderas' : 'falsas') +
        ' (un patrón así no se da por azar): reescribe ' + ownMajor[0].path + ' para que sea ' + (major ? 'FALSA (correct: false)' : 'VERDADERA (correct: true)') + '.');
    }
  }
  var stats = {};
  stats[kind === 'branchingscenario' ? 'decisions' : 'mc'] = own.ranks.length;
  return {
    stats: Object.assign(stats, {
      correctLongest: own.ranks.filter(function (x) { return x.longest; }).length, outliers: own.ranks.filter(function (x) { return x.outlier; }).length,
      tf: own.tf.length, tfTrue: own.tf.filter(function (x) { return x.v; }).length,
      pLength: Math.round(pLen * 10000) / 10000, pTf: Math.round(pTf * 10000) / 10000, pooledItems: pooledItems }),
    errors: errors
  };
}

// Orden de las opciones del caso ramificado: barajado determinístico por decisión (mulberry32 de
// FNV-1a(seed|id)). Las referencias van por id (dN / end:eK), así que el grafo no cambia.
function dynShuffleBsOptions(data, seed) {
  if (!_dynIsPlainObject(data) || !Array.isArray(data.decisions)) return data;
  data.decisions.forEach(function (d) {
    if (!_dynIsPlainObject(d) || !Array.isArray(d.options) || d.options.length < 2) return;
    var rng = _dynMulberry32(dynFnv1a32('bs|' + String(seed || '') + '|' + String(d.id)));
    var o = d.options.slice();
    for (var i = o.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = o[i]; o[i] = o[j]; o[j] = tmp;
    }
    d.options = o;
  });
  return data;
}

// Códigos [XXX] de una lista de errores (únicos, en orden).
// Fix round 2 (n2): también la forma «$… CODE: …» (TRUNCATED, JSON_INVALID, IDIOMA, VERACIDAD…).
function _dynErrCodes(errors) {
  var codes = [];
  (errors || []).forEach(function (e) {
    var m = /\[([A-Z_]+)\]/.exec(String(e)) || /^\$\S* ([A-Z][A-Z_]+):/.exec(String(e));
    if (m && codes.indexOf(m[1]) < 0) codes.push(m[1]);
  });
  return codes;
}

// ════ #542 (I5) — el caso ramificado no repite el caso resuelto del capítulo ════
// En el #542 el caso ramificado del capítulo 3 («El reclamo de la chaqueta») era el mismo caso del
// capítulo (chaqueta fuera del plazo interno → escalar → registrar): el estudiante reconoce el caso en
// vez de decidir. El prompt recibe el caso del capítulo («■ Caso <país>: …» del libro, o un «Ejemplo
// resuelto») con la orden de usar otro, y este lint lo verifica: palabras propias del caso (que casi no
// aparecen en el resto del capítulo) repetidas en el título y la situación → UN reintento dirigido.
var DYN_CASE_HEADING_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*■?\s*(?:caso\b|ejemplo resuelto\b)/i;
var DYN_CASE_END_RE = /^\s*(?:#{1,6}\s|\*\*\s*[■✏]|[■✏])/;
var DYN_CASE_MAX_PROMPT_CHARS = 700;
var DYN_CASE_REUSE_MIN_DISTINCT = 4;
var DYN_CASE_REUSE_MIN_OVERLAP = 0.58;
var DYN_CASE_MIN_OTHER_PARAGRAPHS = 6;

// Texto del caso resuelto del capítulo ('' si no hay).
function dynExtractChapterCase(md) {
  var lines = String(md || '').split('\n');
  var out = null;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (out === null) {
      if (DYN_CASE_HEADING_RE.test(l) && l.indexOf('■■') < 0) out = [l];
    } else {
      if (DYN_CASE_END_RE.test(l)) break;
      out.push(l);
    }
  }
  return out ? out.join('\n').trim() : '';
}
function dynCaseForPrompt(caseText) {
  var t = String(caseText || '').replace(/[*_#■]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > DYN_CASE_MAX_PROMPT_CHARS ? t.slice(0, DYN_CASE_MAX_PROMPT_CHARS).replace(/\s+\S*$/, '') + '…' : t;
}
function _dynCaseTokens(s) {
  var o = {};
  dynExamTokens(dynNormalizeExamText(s)).forEach(function (t) { if ((t.length >= 5 || /\p{N}/u.test(t)) && !DYN_EXAM_STOPWORDS[t]) o[t] = true; });
  return o;
}
// → { reused, distinct: [palabras propias del caso repetidas], overlap }
function dynLintCaseReuse(text, md) {
  var caseText = dynExtractChapterCase(md);
  if (!caseText) return { reused: false, distinct: [], overlap: 0 };
  var C = _dynCaseTokens(caseText);
  var df = {};
  var others = 0;
  String(md || '').split(/\n\s*\n/).forEach(function (p) {
    var pt = p.trim();
    if (!pt || caseText.indexOf(pt) >= 0) return;
    others++;
    Object.keys(_dynCaseTokens(pt)).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
  });
  var B = _dynCaseTokens(text);
  var shared = Object.keys(B).filter(function (t) { return C[t]; });
  var distinct = shared.filter(function (t) { return (df[t] || 0) <= 1; });
  var denom = Math.min(Object.keys(B).length, Object.keys(C).length);
  var overlap = denom ? shared.length / denom : 0;
  // Con un capítulo muy corto «propia del caso» no significa nada (todo aparece poco): solo cuenta el solapamiento.
  var byDistinct = others >= DYN_CASE_MIN_OTHER_PARAGRAPHS && distinct.length >= DYN_CASE_REUSE_MIN_DISTINCT;
  return { reused: byDistinct || overlap >= DYN_CASE_REUSE_MIN_OVERLAP, distinct: distinct, overlap: Math.round(overlap * 100) / 100 };
}

// Espejo de planInteractionCheckpoints (R8 plan.ts). Lanza {code, message}.
var DYN_VIDEO_CHECKPOINT_RULES = { secondsPerInteraction: 100, minInteractions: 3, maxInteractions: 8, noInteractionFirstSec: 30, noInteractionLastSec: 15, minGapSec: 20, minDurationSec: 105, maxDurationSec: 14400 };

function _dynVideoPlanError(code, msg) { var e = new Error(code + ': ' + msg); e.code = code; return e; }
function dynVideoPlanDurationSec(durationSec) {
  var R = DYN_VIDEO_CHECKPOINT_RULES;
  if (typeof durationSec !== 'number' || !isFinite(durationSec) || durationSec <= 0) throw _dynVideoPlanError('VIDEO_DURATION_INVALID', 'durationSec debe ser un número finito > 0 (recibido ' + String(durationSec) + ')');
  if (durationSec > R.maxDurationSec) throw _dynVideoPlanError('VIDEO_DURATION_INVALID', 'durationSec ' + durationSec + ' supera el máximo ' + R.maxDurationSec);
  return Math.floor(durationSec);
}
function dynPlanInteractionCheckpoints(durationSec) {
  var R = DYN_VIDEO_CHECKPOINT_RULES;
  var d = dynVideoPlanDurationSec(durationSec);
  if (d < R.minDurationSec) throw _dynVideoPlanError('VIDEO_TOO_SHORT_FOR_INTERACTIONS', 'el video dura ' + d + ' s; se necesitan ≥ ' + R.minDurationSec + ' s');
  var n = Math.min(R.maxInteractions, Math.max(R.minInteractions, Math.round(d / R.secondsPerInteraction)));
  var start = R.noInteractionFirstSec;
  var end = d - R.noInteractionLastSec;
  var seg = (end - start) / n;
  var out = [];
  for (var i = 0; i < n; i++) {
    var s = Math.round(start + i * seg);
    var e = i === n - 1 ? end : Math.round(start + (i + 1) * seg);
    out.push({ index: i + 1, atSec: Math.round(start + (i + 0.5) * seg), segment: [s, e] });
  }
  return out;
}

// EV6 IV avanzado — espejo de planReflectionPauses (backend interactive-video/plan.ts). Puro.
//   cantidad: 0 si d < 180 s, 1 si 180–299 s, 2 si ≥ 300 s; ranuras k1 = ⌈n/3⌉, k2 = ⌈2n/3⌉;
//   la pausa j va en el punto medio entre los checkpoints kj y kj+1; una ranura que choca se
//   descarta (droppedReflections, con su motivo), nunca en silencio.
var DYN_REFLECTION_PAUSE_RULES = { oneFromSec: 180, twoFromSec: 300, windowSec: 10, afterWindowSec: 10, beforeQuestionSec: 10, minGapBetweenPausesSec: 10 };
function dynPlanReflectionPauses(durationSec, checkpoints) {
  var R = DYN_REFLECTION_PAUSE_RULES;
  var C = DYN_VIDEO_CHECKPOINT_RULES;
  var d = dynVideoPlanDurationSec(durationSec);
  var count = d < R.oneFromSec ? 0 : d < R.twoFromSec ? 1 : 2;
  var n = Array.isArray(checkpoints) ? checkpoints.length : 0;
  var reflections = [];
  var droppedReflections = [];
  if (count === 0) return { reflections: reflections, droppedReflections: droppedReflections };
  if (n === 0) throw _dynVideoPlanError('VIDEO_PLAN_INVARIANT', 'planReflectionPauses sin checkpoints');
  var slots = [Math.ceil(n / 3), Math.ceil((2 * n) / 3)].slice(0, count);
  var lo = C.noInteractionFirstSec;
  var hi = d - C.noInteractionLastSec;
  slots.forEach(function (k, j) {
    var index = j + 1;
    var a = checkpoints[k - 1];
    var b = checkpoints[k];
    if (!a || !b) { droppedReflections.push({ index: index, atSec: a ? a.atSec : -1, afterCheckpoint: k, reason: 'no hay checkpoint ' + (k + 1) + ' después del ' + k }); return; }
    var atSec = Math.round((a.atSec + b.atSec) / 2);
    var base = { index: index, atSec: atSec, afterCheckpoint: k };
    if (atSec < lo || atSec > hi) { droppedReflections.push(Object.assign({}, base, { reason: 'fuera de [' + lo + ', ' + hi + ']' })); return; }
    var clash = null;
    for (var c = 0; c < checkpoints.length; c++) {
      var cp = checkpoints[c];
      if (cp.atSec <= atSec ? atSec < cp.atSec + R.windowSec + R.afterWindowSec : cp.atSec - atSec < R.beforeQuestionSec) { clash = cp; break; }
    }
    if (clash) { droppedReflections.push(Object.assign({}, base, { reason: 'choca con la pregunta ' + clash.index + ' (' + clash.atSec + ' s): se exige ≥ ' + R.afterWindowSec + ' s tras su ventana y ≥ ' + R.beforeQuestionSec + ' s antes' })); return; }
    var other = null;
    for (var r = 0; r < reflections.length; r++) if (Math.abs(reflections[r].atSec - atSec) < R.minGapBetweenPausesSec) { other = reflections[r]; break; }
    if (other) { droppedReflections.push(Object.assign({}, base, { reason: 'colisión con la pausa ' + other.index + ' (' + other.atSec + ' s)' })); return; }
    reflections.push(base);
  });
  return { reflections: reflections, droppedReflections: droppedReflections };
}

// Espejo de validateVideoInteractionsDoc (R8). expect = {videoItemKey, durationSec, schemaVersion?}.
// EV6: expect.schemaVersion 2 (Manifest ivAdvanced) exige además `reflections` en los index del plan
// de pausas; sin él (o 1) es exactamente la validación de siempre (un documento v2 se rechaza).
function dynValidateVideoInteractionsDoc(doc, expect) {
  var L = DYN_VIDEO_INTERACTIONS_LIMITS;
  var issues = _dynH5pIssues();
  expect = expect || {};
  var wantVersion = expect.schemaVersion === 2 ? 2 : 1;
  if (!_dynIsPlainObject(doc)) { issues.add('$', 'debe ser un objeto'); return { ok: false, errors: issues.list }; }
  _dynH5pKeys(issues, '$', doc, ['schemaVersion', 'videoItemKey', 'durationSec', 'checkpoints'].concat(wantVersion === 2 ? ['reflections'] : []));
  if (doc.schemaVersion !== wantVersion) issues.add('schemaVersion', 'debe ser ' + wantVersion);
  if (typeof doc.videoItemKey !== 'string' || !_DYN_H5P_ITEM_KEY_RE.test(doc.videoItemKey)) issues.add('videoItemKey', 'inválido');
  else if (expect.videoItemKey !== undefined && doc.videoItemKey !== expect.videoItemKey) issues.add('videoItemKey', 'debe ser "' + expect.videoItemKey + '" (recibido "' + doc.videoItemKey + '")');
  var plan = null;
  try {
    var pd = dynVideoPlanDurationSec(doc.durationSec);
    if (expect.durationSec !== undefined && pd !== dynVideoPlanDurationSec(expect.durationSec)) issues.add('durationSec', 'debe coincidir con la duración real ' + dynVideoPlanDurationSec(expect.durationSec) + ' s (recibido ' + pd + ')');
    plan = dynPlanInteractionCheckpoints(pd);
  } catch (e) { issues.add('durationSec', (e && e.message) || String(e)); }
  if (plan && _dynH5pArray(issues, 'checkpoints', doc.checkpoints, plan.length, plan.length)) {
    doc.checkpoints.forEach(function (c, i) {
      var p = 'checkpoints[' + i + ']';
      if (!_dynIsPlainObject(c)) { issues.add(p, 'debe ser un objeto'); return; }
      if (c.index !== plan[i].index) issues.add(p + '.index', 'debe ser ' + plan[i].index + ' (recibido ' + String(c.index) + ')');
      if (c.feedbackCorrect !== undefined) _dynH5pPlain(issues, p + '.feedbackCorrect', c.feedbackCorrect, { max: L.feedbackMax });
      if (c.feedbackIncorrect !== undefined) _dynH5pPlain(issues, p + '.feedbackIncorrect', c.feedbackIncorrect, { max: L.feedbackMax });
      _dynH5pPlain(issues, p + '.question', c.question, { max: L.questionMax });
      if (c.kind === 'multichoice') {
        _dynH5pKeys(issues, p, c, ['index', 'kind', 'question', 'answers', 'feedbackCorrect', 'feedbackIncorrect']);
        _dynH5pAnswers(issues, p, c.answers, L.minAnswers, L.maxAnswers, true, false, L.answerMax, true);
      } else if (c.kind === 'truefalse') {
        _dynH5pKeys(issues, p, c, ['index', 'kind', 'question', 'correct', 'feedbackCorrect', 'feedbackIncorrect']);
        if (typeof c.correct !== 'boolean') issues.add(p + '.correct', 'debe ser booleano');
      } else {
        issues.add(p + '.kind', 'debe ser "multichoice" o "truefalse"');
      }
    });
  }
  if (wantVersion === 2 && plan) {
    var want = dynPlanReflectionPauses(dynVideoPlanDurationSec(doc.durationSec), plan).reflections;
    var RL = DYN_VIDEO_REFLECTION_LIMITS;
    // Sin pausas planificadas (d < 180 s) `reflections` puede omitirse o venir vacío (fix round 1 m-6 del backend).
    if (!(want.length === 0 && doc.reflections === undefined) && _dynH5pArray(issues, 'reflections', doc.reflections, want.length, want.length)) {
      doc.reflections.forEach(function (r, i) {
        var p = 'reflections[' + i + ']';
        if (!_dynIsPlainObject(r)) { issues.add(p, 'debe ser un objeto'); return; }
        _dynH5pKeys(issues, p, r, ['index', 'prompt', 'hint']);
        if (r.index !== want[i].index) issues.add(p + '.index', 'debe ser ' + want[i].index + ' (recibido ' + String(r.index) + ')');
        _dynH5pPlain(issues, p + '.prompt', r.prompt, { max: RL.promptMax });
        if (r.hint !== undefined) _dynH5pPlain(issues, p + '.hint', r.hint, { max: RL.hintMax });
      });
    }
  }
  return { ok: issues.list.length === 0, errors: issues.list };
}

// Espejo de activityTypeForChapter (R11a). Fix round 1 (review G5 I6,
// ruling del controlador): el tipo se deriva del UUID ESTABLE del capítulo,
// no del número global (un reorder reutiliza la actividad, R5/§P):
//   ['questionset','dragtext','blanks'][fnv1a32(utf8(chapterId.toLowerCase())) % 3]
// FNV-1a de 32 bits estándar (offset 2166136261, primo 16777619, sin signo).
// R-011: sin singlechoiceset (Moodle core no lo califica). El backend lo
// impone en el claim; acá se verifica.
function _dynUtf8BytesLocal(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
      var d = str.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
function dynFnv1a32(str) {
  var h = 2166136261 >>> 0;
  var bytes = _dynUtf8BytesLocal(String(str));
  for (var i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function dynActivityTypeForChapter(chapterId) {
  if (typeof chapterId !== 'string' || !chapterId.trim()) throw new Error('dynActivityTypeForChapter: chapterId inválido ' + String(chapterId));
  return DYN_H5P_ACTIVITY_TYPES[dynFnv1a32(chapterId.toLowerCase()) % DYN_H5P_ACTIVITY_TYPES.length];
}

// ════ Payload v3 del claim (R11a) ════
// El brief R11a fija QUÉ trae el claim (tipo h5p requerido; checkpoints +
// youtubeId/durationSec del video) pero no el nombre exacto del campo: se
// aceptan en el tope del ClaimedItem o bajo `claimPayload`/`payload`.
function _dynClaimField(item, names) {
  var sources = [item, item && item.claimPayload, item && item.payload, item && item.video, item && item.claimPayload && item.claimPayload.video, item && item.payload && item.payload.video];
  for (var s = 0; s < sources.length; s++) {
    var src = sources[s];
    if (!_dynIsPlainObject(src)) continue;
    for (var n = 0; n < names.length; n++) {
      if (src[names[n]] !== undefined && src[names[n]] !== null) return src[names[n]];
    }
  }
  return undefined;
}

// Checkpoints del claim → [{index, atSec, segmentStart, segmentEnd}] (acepta
// la forma R8 `segment:[s,e]` o la del brief `segmentStart/segmentEnd`).
function _dynNormalizeCheckpoints(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var c = raw[i];
    if (!_dynIsPlainObject(c)) return null;
    var s = Array.isArray(c.segment) ? c.segment[0] : c.segmentStart;
    var e = Array.isArray(c.segment) ? c.segment[1] : c.segmentEnd;
    if (!Number.isInteger(c.index) || typeof c.atSec !== 'number' || typeof s !== 'number' || typeof e !== 'number') return null;
    out.push({ index: c.index, atSec: c.atSec, segmentStart: s, segmentEnd: e });
  }
  return out;
}

// ════ Descarga de artifacts de dependencia (texto) ════
// #583 (N4): un solo «Failed to fetch» al bajar el Markdown de un capítulo costaba un intento entero
// del item (y 8 min de espera del scheduler). Ahora cada descarga se reintenta DENTRO del item: hasta
// DYN_DOWNLOAD_ATTEMPTS intentos con espera corta, y cada intento pide una URL firmada NUEVA (una URL
// vencida o un 403/5xx del Storage también se recuperan). No se reintenta lo que no puede cambiar
// (sin id, sin cliente del backend, método de descarga desconocido) ni un 404 (el artifact no existe).
// Las descargas no gastan nada (sin IA): reintentar es gratis.
var DYN_DOWNLOAD_ATTEMPTS = 3;
var DYN_DOWNLOAD_BACKOFF_MS = [1000, 3000]; // espera antes del 2.º y 3.er intento (el harness lo achica)
var DYN_DOWNLOAD_PERMANENT = ['missing_artifact_id', 'artifact_download_unavailable', 'unsupported_download_method', 'HTTP 404'];
function _dynDownloadArtifactText(artifactId) {
  var attempt = 0;
  function once() {
    attempt++;
    return _dynDownloadArtifactTextOnce(artifactId).then(function (res) {
      if (res && res.ok) return res;
      var err = (res && res.error) || 'desconocido';
      if (attempt >= DYN_DOWNLOAD_ATTEMPTS || DYN_DOWNLOAD_PERMANENT.indexOf(err) >= 0) {
        return attempt > 1 ? { ok: false, error: err + ' (tras ' + attempt + ' intentos)' } : res;
      }
      var wait = DYN_DOWNLOAD_BACKOFF_MS[Math.min(attempt - 1, DYN_DOWNLOAD_BACKOFF_MS.length - 1)] || 0;
      return _dynSleep(wait).then(once);
    });
  }
  return once();
}
function _dynDownloadArtifactTextOnce(artifactId) {
  if (!artifactId) return Promise.resolve({ ok: false, error: 'missing_artifact_id' });
  if (typeof artifactDownloadUrl !== 'function') return Promise.resolve({ ok: false, error: 'artifact_download_unavailable' });
  function fetchText(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (text) { return { ok: true, text: text }; })
      .catch(function (e) { return { ok: false, error: (e && e.message) || 'text_fetch_failed' }; });
  }
  return Promise.resolve(artifactDownloadUrl(artifactId)).then(function (urlRes) {
    if (!urlRes || !urlRes.ok) return { ok: false, error: (urlRes && urlRes.error) || 'download_url_failed' };
    if (urlRes.url) return fetchText(urlRes.url);
    if (urlRes.storagePath && typeof window !== 'undefined' && window.SB) {
      return window.SB.storage.from(urlRes.bucket || 'cursia-artifacts').createSignedUrl(urlRes.storagePath, 3600).then(function (signRes) {
        var signed = signRes && signRes.data && signRes.data.signedUrl;
        if (!signed) return { ok: false, error: 'sign_failed' };
        return fetchText(signed);
      });
    }
    return { ok: false, error: 'unsupported_download_method' };
  }).catch(function (e) { return { ok: false, error: (e && e.message) || String(e) }; });
}

// Carga EXACTAMENTE un artifact de dependencia del tipo pedido (texto).
// Falta o ambigüedad → contrato del backend roto → no retryable; descarga
// fallida → retryable. Devuelve {ok, text, artifactId} | {ok:false, result}.
async function _dynLoadDepText(item, type) {
  var deps = (item.dependencyArtifacts || []).filter(function (a) { return a && a.type === type; });
  if (deps.length !== 1) {
    return { ok: false, result: { ok: false, error: (deps.length ? 'ambiguous_' : 'missing_') + type + '_artifact: el item ' + item.itemKey + ' recibió ' + deps.length + ' artifacts ' + type + ' (se esperaba 1)', retryable: false } };
  }
  var dl = await _dynDownloadArtifactText(deps[0].artifactId);
  if (!dl || !dl.ok) return { ok: false, result: { ok: false, error: type + '_download_failed: ' + ((dl && dl.error) || 'desconocido'), retryable: true } };
  if (!dl.text || !String(dl.text).trim()) return { ok: false, result: { ok: false, error: type + '_empty: el artifact ' + deps[0].artifactId + ' está vacío', retryable: false } };
  return { ok: true, text: String(dl.text), artifactId: deps[0].artifactId };
}

// Contenido del capítulo + Context Package (ambos del item content:<ch>).
async function _dynLoadChapterSources(item) {
  var md = await _dynLoadDepText(item, 'dynamic_content_md');
  if (!md.ok) return md;
  var pk = await _dynLoadDepText(item, 'dynamic_context_package_json');
  if (!pk.ok) return pk;
  var pkg;
  try { pkg = JSON.parse(pk.text); } catch (e) {
    return { ok: false, result: { ok: false, error: 'context_package_invalid_json: ' + ((e && e.message) || String(e)), retryable: false } };
  }
  return { ok: true, contentMd: md.text, contextPackage: pkg, contentArtifactId: md.artifactId, contextPackageArtifactId: pk.artifactId };
}

// Motor de carga horaria: un CAPÍTULO DE PRÁCTICA no tiene content propio; su fuente es el texto de los
// capítulos de CONTENIDO del módulo (claimPayload.practice.sourceChapterIds, en orden; sus content llegan en
// dependencyArtifacts), recortado a un tope total para que el prompt no supere el límite del proxy.
var DYN_PRACTICE_SOURCE_MAX_CHARS = 24000;
function _dynPracticeClaim(item) {
  var pr = _dynClaimField(item, ['practice']);
  return _dynIsPlainObject(pr) ? pr : null;
}
function _dynTrimAtParagraph(text, max) {
  var t = String(text || '');
  if (t.length <= max) return t;
  var cut = t.lastIndexOf('\n\n', max);
  return (cut > max * 0.5 ? t.slice(0, cut) : t.slice(0, max)).replace(/\s+$/, '') + '\n\n[…]';
}
async function _dynLoadPracticeSources(item, practice) {
  var ids = Array.isArray(practice.sourceChapterIds) ? practice.sourceChapterIds : [];
  if (!ids.length) return { ok: false, result: { ok: false, error: 'practice_sources_missing: el claim del capítulo de práctica ' + item.itemKey + ' no trae sourceChapterIds', retryable: false } };
  var titles = {};
  ((item.blueprint && item.blueprint.outline) || []).forEach(function (m) { (m.chapters || []).forEach(function (c) { titles[c.id] = c.title; }); });
  var per = Math.floor(DYN_PRACTICE_SOURCE_MAX_CHARS / ids.length);
  var parts = [];
  var artifactIds = [];
  for (var i = 0; i < ids.length; i++) {
    var deps = (item.dependencyArtifacts || []).filter(function (a) { return a && a.type === 'dynamic_content_md' && a.itemKey === 'content:' + ids[i]; });
    var depsMsg = ': el capítulo de práctica ' + item.itemKey + ' recibió ' + deps.length + ' textos del capítulo ' + ids[i] + ' (se esperaba 1)';
    if (deps.length > 1) return { ok: false, result: { ok: false, error: 'ambiguous_dynamic_content_md_artifact' + depsMsg, retryable: false } };
    if (deps.length !== 1) return { ok: false, result: { ok: false, error: 'missing_dynamic_content_md_artifact' + depsMsg, retryable: false } };
    var dl = await _dynDownloadArtifactText(deps[0].artifactId);
    if (!dl || !dl.ok) return { ok: false, result: { ok: false, error: 'dynamic_content_md_download_failed: ' + ((dl && dl.error) || 'desconocido'), retryable: true } };
    if (!dl.text || !String(dl.text).trim()) return { ok: false, result: { ok: false, error: 'dynamic_content_md_empty: el artifact ' + deps[0].artifactId + ' está vacío', retryable: false } };
    parts.push('### ' + (titles[ids[i]] || ('Capítulo ' + ids[i])) + '\n\n' + _dynTrimAtParagraph(dl.text, per));
    artifactIds.push(deps[0].artifactId);
  }
  return { ok: true, contentMd: parts.join('\n\n'), contextPackage: null, contentArtifactId: artifactIds.join(','), practice: true, sourceChapterIds: ids.slice() };
}
/** Fuente de experience / activity: el capítulo de siempre o, en un capítulo de práctica, los de contenido del módulo. */
function _dynLoadSourcesFor(item) {
  var pr = _dynPracticeClaim(item);
  return pr ? _dynLoadPracticeSources(item, pr) : _dynLoadChapterSources(item);
}

// ════ Llamada JSON con validación + UN reintento dirigido ════
// build(obj) → { ok, value, errors: string[] } (obj ya parseado). Un
// stop_reason 'max_tokens' siempre cuenta como inválido.
function _dynV3ParseJson(raw) {
  try { return { ok: true, obj: JSON.parse(_dynStripJsonFence(raw)) }; }
  catch (e) { return { ok: false, errors: ['$ JSON_INVALID: JSON inválido: ' + ((e && e.message) || String(e))] }; }
}

// build(obj, attempt) → { ok:false, errors } (duro) | { ok:true, value, soft?: string[] } (válido; `soft` =
// advertencias blandas: sesgo, copia, caso repetido, concordancia, …).
// Fix round 1 (#542 I2): lo blando NUNCA hace fallar una parte. 1.er intento válido con solo advertencias
// blandas → UN reintento dirigido; si el reintento falla (roto, truncado, inválido, veracidad…) se conserva
// la PRIMERA respuesta (softFallback). Las advertencias del valor que se conserva van en `softWarnings` y
// `usedAttempt` dice de qué intento salió. Lo duro (schema, veracidad, voseo…) sigue como siempre.
// #583 (M4): `opts.normalizeMoney` → antes de validar, los montos de dinero de TODOS los textos pasan al formato
// es-CO («280 000 pesos» → «$280.000»); `moneyNormalized` = cuántos cambió el intento que se conserva.
async function _dynV3JsonWithRetry(item, sys, prompt, maxTok, build, opts) {
  var moneyBy = {};
  function evaluate(raw, meta, attempt) {
    var p = _dynV3ParseJson(raw);
    if (p.ok && opts && opts.normalizeMoney) moneyBy[attempt] = dynNormalizeMoneyDeep(p.obj);
    // Language QA: el voseo sin otra lectura se corrige solo (antes de validar); lo demás pide el reintento dirigido.
    if (p.ok) _dynLqaFixDeep(p.obj, item.context && item.context.courseContext);
    // `attempt` (1 = principal, 2 = reintento dirigido) es el intento real, aunque el anterior no
    // haya sido JSON válido (build no se llamó): las reglas «solo en el primer intento» lo usan.
    var r = p.ok ? build(p.obj, attempt) : { ok: false, errors: p.errors };
    // R14: veracidad + tuteo también en los items JSON v3 (intros, experiencia, video, actividad):
    // un hallazgo es un error de validación más → el reintento dirigido de siempre (nunca se recorta).
    if (r.ok) {
      var soft = (r.soft || []).slice();
      var th = _dynJsonTruthHits(r.value, item.context && item.context.courseContext);
      var label = function (h) { return '$ ' + (h.code === 'VOSEO' ? 'IDIOMA: ' + (h.lqa ? _dynTruthHitLabel(h.code, h) : 'voseo, usa tuteo (tú)') : (h.code === 'VOSOTROS' || h.code === 'ENGLISH' || h.code === 'GRAMMAR_PERSON' || h.code === 'REGIONAL') ? 'IDIOMA: ' + _dynTruthHitLabel(h.code, h) : 'VERACIDAD: ' + _dynTruthHitLabel(h.code)) + ': "' + h.text.slice(0, 120) + '"'; };
      var hard = th.filter(function (h) { return !DYN_SOFT_LANG_CODES[h.code]; });
      // #542 (M2): la concordancia es blanda.
      th.filter(function (h) { return DYN_SOFT_LANG_CODES[h.code]; }).forEach(function (h) { soft.push('[' + h.code + '] ' + label(h)); });
      if (hard.length) r = { ok: false, errors: hard.map(label).concat(soft) };
      else r = { ok: true, value: r.value, soft: soft };
    }
    if (meta.stopReason === 'max_tokens') r = { ok: false, errors: ['$ TRUNCATED: respuesta truncada (stop_reason=max_tokens); entrega el JSON completo y más conciso'].concat(r.errors || []) };
    return r;
  }
  var meta = {};
  var first = evaluate(await _dynV3Llm(item, 'main', sys, prompt, maxTok, meta), meta, 1);
  if (first.ok && !first.soft.length) return { ok: true, value: first.value, retried: false, firstErrors: [], softWarnings: [], usedAttempt: 1, moneyNormalized: moneyBy[1] || 0 };
  var firstErrors = first.ok ? first.soft : first.errors;
  console.warn('[dynExecutor:' + item.type + '] ' + item.itemKey + (first.ok ? ' con advertencias blandas' : ' inválido') + ', reintento dirigido: ' + firstErrors.slice(0, 5).join('; '));
  var meta2 = {};
  var second = evaluate(await _dynV3Llm(item, 'validation_retry', sys, dynV3RetryPrompt(prompt, firstErrors), maxTok, meta2), meta2, 2);
  if (second.ok) return { ok: true, value: second.value, retried: true, firstErrors: firstErrors, softWarnings: second.soft, usedAttempt: 2, moneyNormalized: moneyBy[2] || 0 };
  if (first.ok) {
    console.warn('[dynExecutor:' + item.type + '] ' + item.itemKey + ' reintento inválido: se conserva la primera respuesta válida');
    return { ok: true, value: first.value, retried: true, firstErrors: firstErrors, softWarnings: first.soft, usedAttempt: 1, softFallback: true, retryErrors: second.errors.slice(0, 8), moneyNormalized: moneyBy[1] || 0 };
  }
  return { ok: false, errors: second.errors, firstErrors: firstErrors, truncated: meta2.stopReason === 'max_tokens' };
}

// Resumen de advertencias blandas de un item (fix round 1, I2). null si no hubo nada.
function _dynSoftSummary(res) {
  if (!res || (!res.retried && !(res.softWarnings || []).length)) return null;
  var firstCodes = _dynErrCodes(res.firstErrors);
  var keptCodes = _dynErrCodes(res.softWarnings);
  if (!firstCodes.length && !keptCodes.length && !res.softFallback) return null;
  var o = { firstCodes: firstCodes, keptCodes: keptCodes, usedAttempt: res.usedAttempt || 1 };
  if (res.softFallback) { o.softFallback = true; o.retryErrorCodes = _dynErrCodes(res.retryErrors); }
  return o;
}

// Calibración #2: si el reintento dirigido TAMBIÉN se cortó por max_tokens, no es un error transitorio:
// el item falla NO reintentable (nunca otra ronda completa idéntica).
function _dynV3Invalid(item, errors, truncated) {
  return { ok: false, error: (truncated ? 'OUTPUT_TRUNCATED_MAX_TOKENS: ' : '') + item.type + ' inválido tras reintento dirigido: ' + (errors || []).slice(0, 8).join('; '), retryable: !truncated };
}

function _dynV3JsonArtifact(item, type, value, base) {
  var json = dynCanonicalJson(value);
  return { json: json, sha: dynSha256Hex(json), artifact: { type: type, content: json, filename: (base || item.itemRunId) + '_' + type + '.json', mimeType: 'application/json' } };
}

// ── experience:<ch> ──
async function _dynRunExperience(item) {
  var bp = item.blueprint || {};
  if (!item.chapterId || !bp.chapter) return { ok: false, error: 'experience: el claim no trae chapterId/blueprint.chapter', retryable: false };
  var src = await _dynLoadSourcesFor(item);
  if (!src.ok) return src.result;
  var courseContext = item.context.courseContext;
  var chapter = Object.assign({}, bp.chapter, { id: item.chapterId });
  var eduFields = _dynExperienceEduFields(item);
  var prompt = dynExperiencePrompt(courseContext, bp.outline, chapter, src.contentMd, src.contextPackage, Object.assign({ eduFields: eduFields, pedagogy: dynPedagogyBlock(item) }, src.practice ? { practice: true } : {}));
  // Fix round 2 (n4): reparaciones POR INTENTO; el summary usa las del intento que se conserva.
  var repairsBy = {};
  var res = await _dynV3JsonWithRetry(item, dynExperienceSys(courseContext), prompt, 8000, function (obj, attempt) {
    var autoRepairs = repairsBy[attempt] = [];
    // chapterId es de Cursia (UUID del Manifest): se fija acá, nunca se
    // confía en que el LLM lo copie bien. vcSchemaVersion sí se valida.
    if (_dynIsPlainObject(obj)) obj.chapterId = item.chapterId;
    // Edu EV2: un hero que no quedó primero en la apertura se mueve al inicio (sin reintento pagado).
    var op = _dynIsPlainObject(obj) && _dynIsPlainObject(obj.movements) && Array.isArray(obj.movements.opening) ? obj.movements.opening : null;
    if (op && op.length > 1 && !(op[0] && op[0].type === 'hero')) {
      var hi = op.findIndex(function (c) { return c && c.type === 'hero'; });
      if (hi > 0) { op.unshift(op.splice(hi, 1)[0]); autoRepairs.push({ code: 'HERO_MOVED_FIRST', path: '$.movements.opening[' + hi + ']' }); }
    }
    if (!eduFields) _dynStripEduFields(obj, autoRepairs);
    var v = dynValidateExperienceV3(obj);
    var doc = null;
    if (v.ok) doc = obj;
    else {
      // Calibración #2: reparación determinística y acotada ANTES de rechazar (y re-pagar el JSON).
      var rep = dynRepairExperienceV3(obj);
      // El reintento dirigido también nombra lo que falta de la estructura educativa (si no, el 2.º intento
      // arreglaría el schema y fallaría la pedagogía sin reintentos restantes).
      if (!rep.ok) return { ok: false, errors: _dynFormatErrors(v.errors.concat(_dynIsPlainObject(obj) ? dynValidatePedagogyV3(obj).concat(dynValidateSimulatedDiagramsV3(obj), eduFields ? dynValidateEduFieldsV3(obj) : []) : [])) };
      autoRepairs = repairsBy[attempt] = autoRepairs.concat(rep.repairs);
      doc = rep.doc;
    }
    // Edu EV2: estructura educativa mínima (el backend la exige al completar el item).
    // EV6: sin decisiones aplanadas en secuencias ni diagramas dibujados con flechas (el backend los exige desde v21-exp-5).
    // P3: why/apply en ≥ 2 bloques (el backend los exige desde v21-exp-6).
    var ped = dynValidatePedagogyV3(doc).concat(dynValidateSimulatedDiagramsV3(doc), eduFields ? dynValidateEduFieldsV3(doc) : []);
    if (ped.length) return { ok: false, errors: _dynFormatErrors(ped) };
    // #583 (M2/M3): cuentas del ejemplo resuelto y listas con nombre iguales a las del capítulo (blandos).
    var qsoft = [];
    DYN_VC_MOVEMENT_IDS.forEach(function (mv) {
      (doc.movements[mv] || []).forEach(function (c, ci) {
        if (_dynIsPlainObject(c) && c.type === 'worked_example') qsoft = qsoft.concat(dynLintWorkedExampleNumbers(c, '$.movements.' + mv + '[' + ci + ']'));
      });
    });
    qsoft = qsoft.concat(dynLintEnumerations(doc, src.contentMd));
    return { ok: true, value: doc, soft: qsoft };
  }, { normalizeMoney: dynCourseIsColombia(courseContext) });
  if (!res.ok) return _dynV3Invalid(item, res.errors, res.truncated);
  var autoRepairs = repairsBy[res.usedAttempt] || [];
  var a = _dynV3JsonArtifact(item, 'dynamic_experience_json', res.value, item.chapterId);
  var componentCount = DYN_VC_MOVEMENT_IDS.reduce(function (n, m) { return n + res.value.movements[m].length; }, 0);
  return {
    ok: true,
    artifacts: [a.artifact],
    summary: Object.assign({ chapterId: item.chapterId, vcSchemaVersion: DYN_VC_SCHEMA_VERSION, componentCount: componentCount, experienceSha256: a.sha, retried: res.retried, promptVersion: _dynExperiencePromptVersion(item), contentArtifactId: src.contentArtifactId, autoRepairs: autoRepairs }, src.practice ? { chapterKind: 'practice', practiceSourceChapterIds: src.sourceChapterIds } : {}, _dynQualSummary(res), dynPedagogySummary(item))
  };
}

// ── application_activity:<ch> (Fase 2 · Actividades de Aplicación) ──
// Espejo EXACTO de course-shell/application-activity.ts (validateApplicationStudentPart / ...SolutionPart): el
// servidor re-valida el documento completo al completar el item y es autoritativo. Paridad: harness test-51.
var DYN_APPLICATION_SCHEMA_VERSION = 1;
var DYN_APPLICATION_LIM = { short: 160, text: 1200, long: 2400, answer: 2400 };
var DYN_APPLICATION_SOURCE_MAX_CHARS = 20000;
function _dynAppHelpers(errors) {
  function err(path, code, message) { errors.push({ path: path, code: code, message: message }); }
  function text(v, path, max, min) {
    min = min === undefined ? 1 : min;
    if (typeof v !== 'string' || v.trim().length < min) { err(path, 'APPLICATION_TEXT', path + ' debe ser un texto de al menos ' + min + ' caracteres'); return null; }
    if (v.length > max) err(path, 'APPLICATION_TEXT_TOO_LONG', path + ' supera ' + max + ' caracteres (' + v.length + ')');
    return v.trim();
  }
  function list(v, path, min, max) {
    if (!Array.isArray(v)) { err(path, 'APPLICATION_LIST', path + ' debe ser una lista'); return []; }
    if (v.length < min || v.length > max) err(path, 'APPLICATION_COUNT', path + ' debe tener entre ' + min + ' y ' + max + ' elementos (tiene ' + v.length + ')');
    return v;
  }
  return { err: err, text: text, list: list };
}
function _dynIsInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
// Espejo de APPLICATION_SOLUTION_MARKERS_RE / STUDENT_KEYS / EXERCISE_KEYS (application-activity.ts): marcas de
// solucionario y campos extra nunca en la parte del estudiante (el .mbz la rechazaría DESPUÉS de pagar).
var DYN_APPLICATION_SOLUTION_MARKERS_RE = /Solucionario|Gu[ií]a de correcci[oó]n|Respuesta:|Soluci[oó]n esperada/i;
var DYN_APPLICATION_STUDENT_KEYS = ['genre', 'title', 'objective', 'context', 'examples', 'exercises', 'workshop', 'deliverable', 'selfCheck', 'criteria', 'minutesBySection'];
var DYN_APPLICATION_EXERCISE_KEYS = ['id', 'prompt', 'difficulty', 'answerLines'];
function _dynAppStrings(v, out) {
  out = out || [];
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(function (x) { _dynAppStrings(x, out); });
  else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { _dynAppStrings(v[k], out); });
  return out;
}
function dynValidateApplicationStudentPart(a, minutes) {
  if (!DYN_APPLICATION_EXERCISES_BY_MINUTES[minutes]) throw new Error('V3_VALIDATION_CONTEXT: Actividad de Aplicación con minutos inválidos ' + JSON.stringify(minutes));
  var errors = [];
  var h = _dynAppHelpers(errors);
  var L = DYN_APPLICATION_LIM;
  var ids = [];
  var names = [];
  if (!_dynIsPlainObject(a)) { h.err('$.activity', 'APPLICATION_SHAPE', 'falta la actividad del estudiante'); return { errors: errors, exerciseIds: ids, criteriaNames: names }; }
  Object.keys(a).forEach(function (k) { if (DYN_APPLICATION_STUDENT_KEYS.indexOf(k) < 0) h.err('$.activity.' + k, 'APPLICATION_SHAPE', 'campo desconocido en la actividad del estudiante: ' + k); });
  var marker = _dynAppStrings(a).filter(function (x) { return DYN_APPLICATION_SOLUTION_MARKERS_RE.test(x); })[0];
  if (marker !== undefined) h.err('$.activity', 'APPLICATION_SOLUTION_MARKER', 'la actividad del estudiante no puede contener marcas de solucionario («Respuesta:», «Solución esperada», «Guía de corrección», «Solucionario»): «' + marker.slice(0, 80) + '»');
  var genre = a.genre;
  var knownGenre = DYN_APPLICATION_GENRES.indexOf(genre) >= 0;
  if (!knownGenre) h.err('$.activity.genre', 'APPLICATION_GENRE', 'genre debe ser uno de ' + DYN_APPLICATION_GENRES.join(', '));
  h.text(a.title, '$.activity.title', L.short, 4);
  h.text(a.objective, '$.activity.objective', L.text, 20);
  h.text(a.context, '$.activity.context', L.long, 60);
  var b = DYN_APPLICATION_EXERCISES_BY_MINUTES[minutes];
  var examples = h.list(a.examples, '$.activity.examples', knownGenre && DYN_APPLICATION_GENRES_REQUIRING_EXAMPLE.indexOf(genre) >= 0 ? 1 : 0, b.examplesMax);
  examples.forEach(function (ex, i) {
    var p = '$.activity.examples[' + i + ']';
    if (!_dynIsPlainObject(ex)) return h.err(p, 'APPLICATION_SHAPE', p + ' debe ser un objeto');
    h.text(ex.title, p + '.title', L.short, 4);
    h.text(ex.problem, p + '.problem', L.text, 20);
    h.list(ex.steps, p + '.steps', 2, 10).forEach(function (st, j) { h.text(st, p + '.steps[' + j + ']', L.text, 3); });
    h.text(ex.result, p + '.result', L.text, 3);
  });
  var exercises = h.list(a.exercises, '$.activity.exercises', b.min, b.max);
  var lastD = -1;
  exercises.forEach(function (e, i) {
    var p = '$.activity.exercises[' + i + ']';
    if (!_dynIsPlainObject(e)) { ids.push(''); return h.err(p, 'APPLICATION_SHAPE', p + ' debe ser un objeto'); }
    Object.keys(e).forEach(function (k) { if (DYN_APPLICATION_EXERCISE_KEYS.indexOf(k) < 0) h.err(p + '.' + k, 'APPLICATION_SHAPE', 'campo desconocido en el ejercicio: ' + k); });
    var want = 'E' + (i + 1);
    if (e.id !== want) h.err(p + '.id', 'APPLICATION_EXERCISE_ID', p + '.id debe ser "' + want + '" (en orden)');
    ids.push(String(e.id));
    h.text(e.prompt, p + '.prompt', L.text, 15);
    var d = DYN_APPLICATION_DIFFICULTIES.indexOf(e.difficulty);
    if (d < 0) h.err(p + '.difficulty', 'APPLICATION_DIFFICULTY', p + '.difficulty debe ser ' + DYN_APPLICATION_DIFFICULTIES.join(' | '));
    else if (d < lastD) h.err(p + '.difficulty', 'APPLICATION_DIFFICULTY_ORDER', 'los ejercicios van de menor a mayor dificultad');
    else lastD = d;
    if (!_dynIsInt(e.answerLines) || e.answerLines < 1 || e.answerLines > 15) h.err(p + '.answerLines', 'APPLICATION_ANSWER_LINES', p + '.answerLines debe ser un entero de 1 a 15 (renglones para responder en papel)');
  });
  if (exercises.length >= 3 && lastD === 0) h.err('$.activity.exercises', 'APPLICATION_NOT_GRADED', 'los ejercicios deben subir de dificultad (al menos uno intermedio o avanzado)');
  var w = a.workshop;
  if (!_dynIsPlainObject(w)) h.err('$.activity.workshop', 'APPLICATION_SHAPE', 'falta el taller de aplicación');
  else {
    h.text(w.title, '$.activity.workshop.title', L.short, 4);
    h.text(w.situation, '$.activity.workshop.situation', L.long, 60);
    h.list(w.instructions, '$.activity.workshop.instructions', 2, 8).forEach(function (x, i) { h.text(x, '$.activity.workshop.instructions[' + i + ']', L.text, 8); });
  }
  var dv = a.deliverable;
  if (!_dynIsPlainObject(dv)) h.err('$.activity.deliverable', 'APPLICATION_SHAPE', 'falta el producto o evidencia');
  else {
    h.text(dv.description, '$.activity.deliverable.description', L.text, 15);
    h.text(dv.format, '$.activity.deliverable.format', L.short, 3);
    h.text(dv.extent, '$.activity.deliverable.extent', L.short, 2);
  }
  h.list(a.selfCheck, '$.activity.selfCheck', 4, 8).forEach(function (x, i) { h.text(x, '$.activity.selfCheck[' + i + ']', L.text, 8); });
  var criteria = h.list(a.criteria, '$.activity.criteria', 3, 4);
  var sum = 0;
  criteria.forEach(function (c, i) {
    var p = '$.activity.criteria[' + i + ']';
    if (!_dynIsPlainObject(c)) { names.push(''); return h.err(p, 'APPLICATION_SHAPE', p + ' debe ser un objeto'); }
    var n = h.text(c.name, p + '.name', L.short, 3);
    if (n && names.indexOf(n) >= 0) h.err(p + '.name', 'APPLICATION_CRITERIA_DUPLICATE', 'criterio repetido: ' + n);
    names.push(n || '');
    h.text(c.description, p + '.description', L.text, 10);
    if (!_dynIsInt(c.weight) || c.weight < 5 || c.weight > 70) h.err(p + '.weight', 'APPLICATION_CRITERIA_WEIGHT', p + '.weight debe ser un entero de 5 a 70');
    else sum += c.weight;
  });
  if (criteria.length && sum !== 100) h.err('$.activity.criteria', 'APPLICATION_CRITERIA_WEIGHTS', 'los pesos de los criterios deben sumar 100 (suman ' + sum + ')');
  var mbs = a.minutesBySection;
  var SECTIONS = ['examples', 'exercises', 'workshop', 'selfCheck'];
  if (!_dynIsPlainObject(mbs)) h.err('$.activity.minutesBySection', 'APPLICATION_SHAPE', 'falta minutesBySection');
  else {
    var total = 0;
    SECTIONS.forEach(function (k) {
      if (!_dynIsInt(mbs[k]) || mbs[k] < 0 || mbs[k] > 120) h.err('$.activity.minutesBySection.' + k, 'APPLICATION_SECTION_MINUTES', k + ' debe ser un entero de 0 a 120');
      else total += mbs[k];
    });
    Object.keys(mbs).forEach(function (k) { if (SECTIONS.indexOf(k) < 0) h.err('$.activity.minutesBySection.' + k, 'APPLICATION_SECTION_MINUTES', 'sección desconocida: ' + k); });
    if (Math.abs(total - minutes) > minutes * DYN_APPLICATION_MINUTES_TOLERANCE) {
      h.err('$.activity.minutesBySection', 'APPLICATION_MINUTES_BUDGET', 'las secciones suman ' + total + ' min; el nivel es ' + minutes + ' min (±' + Math.round(DYN_APPLICATION_MINUTES_TOLERANCE * 100) + ' %)');
    }
  }
  return { errors: errors, exerciseIds: ids, criteriaNames: names };
}
function dynValidateApplicationSolutionPart(s, exerciseIds, criteriaNames) {
  var errors = [];
  var h = _dynAppHelpers(errors);
  var L = DYN_APPLICATION_LIM;
  if (!_dynIsPlainObject(s)) { h.err('$.solution', 'APPLICATION_SHAPE', 'falta el solucionario docente'); return errors; }
  h.list(s.answers, '$.solution.answers', exerciseIds.length, exerciseIds.length).forEach(function (x, i) {
    var p = '$.solution.answers[' + i + ']';
    if (!_dynIsPlainObject(x)) return h.err(p, 'APPLICATION_SHAPE', p + ' debe ser un objeto');
    if (x.exerciseId !== exerciseIds[i]) h.err(p + '.exerciseId', 'APPLICATION_SOLUTION_COVERAGE', p + '.exerciseId debe ser "' + (exerciseIds[i] === undefined ? '?' : exerciseIds[i]) + '" (mismo orden que los ejercicios)');
    h.text(x.answer, p + '.answer', L.answer, 1);
    h.text(x.explanation, p + '.explanation', L.answer, 15);
  });
  h.text(s.workshopSolution, '$.solution.workshopSolution', L.long * 2, 60);
  h.list(s.correctionGuide, '$.solution.correctionGuide', criteriaNames.length, criteriaNames.length).forEach(function (g, i) {
    var p = '$.solution.correctionGuide[' + i + ']';
    if (!_dynIsPlainObject(g)) return h.err(p, 'APPLICATION_SHAPE', p + ' debe ser un objeto');
    if (g.criterion !== criteriaNames[i]) h.err(p + '.criterion', 'APPLICATION_SOLUTION_COVERAGE', p + '.criterion debe ser «' + (criteriaNames[i] === undefined ? '?' : criteriaNames[i]) + '» (mismo orden que los criterios)');
    h.text(g.achieved, p + '.achieved', L.text, 10);
    h.text(g.developing, p + '.developing', L.text, 10);
    h.text(g.insufficient, p + '.insufficient', L.text, 10);
  });
  h.list(s.teacherNotes, '$.solution.teacherNotes', 1, 6).forEach(function (x, i) { h.text(x, '$.solution.teacherNotes[' + i + ']', L.text, 10); });
  return errors;
}
function dynValidateApplicationDoc(doc, ctx) {
  if (!ctx || typeof ctx.chapterId !== 'string') throw new Error('V3_VALIDATION_CONTEXT: Actividad de Aplicación sin chapterId ' + JSON.stringify(ctx));
  if (!_dynIsPlainObject(doc)) return [{ path: '$', code: 'APPLICATION_SHAPE', message: 'el documento debe ser un objeto' }];
  var st = dynValidateApplicationStudentPart(doc.activity, ctx.minutes);
  var errors = [];
  if (doc.schemaVersion !== DYN_APPLICATION_SCHEMA_VERSION) errors.push({ path: '$.schemaVersion', code: 'APPLICATION_SCHEMA_VERSION', message: 'schemaVersion debe ser ' + DYN_APPLICATION_SCHEMA_VERSION });
  if (doc.chapterId !== ctx.chapterId) errors.push({ path: '$.chapterId', code: 'CHAPTER_ID_MISMATCH', message: 'chapterId debe ser "' + ctx.chapterId + '"' });
  if (doc.minutes !== ctx.minutes) errors.push({ path: '$.minutes', code: 'APPLICATION_MINUTES_MISMATCH', message: 'minutes debe ser ' + ctx.minutes + ' (nivel del Manifest)' });
  return errors.concat(st.errors, dynValidateApplicationSolutionPart(doc.solution, st.exerciseIds, st.criteriaNames));
}
function _dynApplicationClaim(item) {
  var a = _dynClaimField(item, ['application']);
  return _dynIsPlainObject(a) ? a : null;
}
async function _dynRunApplicationActivity(item) {
  var bp = item.blueprint || {};
  if (!item.chapterId || !bp.chapter) return { ok: false, error: 'application_activity: el claim no trae chapterId/blueprint.chapter', retryable: false };
  var app = _dynApplicationClaim(item);
  if (!app || !DYN_APPLICATION_EXERCISES_BY_MINUTES[app.minutes]) return { ok: false, error: 'claim_payload_unavailable: application_activity ' + item.itemKey + ' sin minutos válidos en el claim', retryable: false };
  if (app.schemaVersion !== DYN_APPLICATION_SCHEMA_VERSION) return { ok: false, error: 'claim_payload_unavailable: application_activity ' + item.itemKey + ' con schemaVersion ' + JSON.stringify(app.schemaVersion) + ' (este ejecutor escribe ' + DYN_APPLICATION_SCHEMA_VERSION + ')', retryable: false };
  var src = await _dynLoadSourcesFor(item);
  if (!src.ok) return src.result;
  var sourceMd = _dynTrimAtParagraph(src.contentMd, DYN_APPLICATION_SOURCE_MAX_CHARS);
  var courseContext = item.context.courseContext;
  var chapter = Object.assign({}, bp.chapter, { id: item.chapterId });
  var sys = dynApplicationSys(courseContext);
  // 1.ª pasada: actividad del estudiante.
  var st = null;
  var r1 = await _dynV3JsonWithRetry(item, sys, dynApplicationActivityPrompt(courseContext, bp.outline, chapter, sourceMd, app, dynPedagogyBlock(item)), 9000, function (obj) {
    var v = dynValidateApplicationStudentPart(obj, app.minutes);
    if (v.errors.length) return { ok: false, errors: _dynFormatErrors(v.errors) };
    st = v;
    return { ok: true, value: obj };
  }, { normalizeMoney: dynCourseIsColombia(courseContext) });
  if (!r1.ok) return _dynV3Invalid(item, r1.errors, r1.truncated);
  var activity = r1.value;
  var v1 = dynValidateApplicationStudentPart(activity, app.minutes);
  // 2.ª pasada: solucionario docente de ESA actividad (ids y criterios fijos).
  var r2 = await _dynV3JsonWithRetry(item, sys, dynApplicationSolutionPrompt(courseContext, chapter, activity, sourceMd), 9000, function (obj) {
    var errs = dynValidateApplicationSolutionPart(obj, v1.exerciseIds, v1.criteriaNames);
    if (errs.length) return { ok: false, errors: _dynFormatErrors(errs) };
    return { ok: true, value: obj };
  }, { normalizeMoney: dynCourseIsColombia(courseContext) });
  if (!r2.ok) return _dynV3Invalid(item, r2.errors, r2.truncated);
  // chapterId, minutos y schemaVersion los pone Cursia (nunca el LLM).
  var doc = { schemaVersion: DYN_APPLICATION_SCHEMA_VERSION, chapterId: item.chapterId, minutes: app.minutes, activity: activity, solution: r2.value };
  var all = dynValidateApplicationDoc(doc, { chapterId: item.chapterId, minutes: app.minutes });
  if (all.length) return _dynV3Invalid(item, _dynFormatErrors(all), false);
  var a = _dynV3JsonArtifact(item, 'dynamic_application_json', doc, item.chapterId);
  void st;
  return {
    ok: true,
    artifacts: [a.artifact],
    summary: Object.assign({
      chapterId: item.chapterId, applicationSchemaVersion: DYN_APPLICATION_SCHEMA_VERSION, minutes: app.minutes, genre: activity.genre,
      exerciseCount: activity.exercises.length, exampleCount: activity.examples.length, criteriaCount: activity.criteria.length,
      applicationSha256: a.sha, retried: !!(r1.retried || r2.retried), promptVersion: DYN_V3_APPLICATION_PROMPT_VERSION, contentArtifactId: src.contentArtifactId
    }, src.practice ? { chapterKind: 'practice', practiceSourceChapterIds: src.sourceChapterIds } : {}, dynPedagogySummary(item))
  };
}

// ── course_intro / module_intro v3 (JSON) ──
async function _dynRunIntroV3(item, kind) {
  var bp = item.blueprint || {};
  var courseContext = item.context.courseContext;
  var planRes = await _dynLoadCoursePlan(item);
  if (!planRes.ok) return planRes.result;
  var prompt, validate, type, base, summary;
  if (kind === 'course') {
    prompt = dynCourseIntroV3Prompt(courseContext, bp.outline, planRes.plan, dynPedagogyBlock(item));
    validate = dynValidateCourseIntroV3;
    type = 'dynamic_course_intro_json';
    base = item.itemRunId;
    summary = {};
  } else {
    if (!bp.module || !bp.module.id) return { ok: false, error: 'module_intro: el claim no trae blueprint.module', retryable: false };
    var mo = (bp.outline || []).filter(function (m) { return m.id === bp.module.id; })[0];
    if (!mo || !(mo.chapters || []).length) return { ok: false, error: 'module_intro: el módulo ' + bp.module.id + ' no está en el outline del claim', retryable: false };
    var chapterIds = mo.chapters.map(function (c) { return c.id; });
    prompt = dynModuleIntroV3Prompt(courseContext, bp.outline, bp.module, planRes.plan, dynPedagogyBlock(item));
    validate = function (doc) { return dynValidateModuleIntroV3(doc, chapterIds); };
    type = 'dynamic_module_intro_json';
    base = item.moduleId || item.itemRunId;
    summary = { moduleId: item.moduleId };
  }
  var copyRecs = {};
  var res = await _dynV3JsonWithRetry(item, dynIntroV3Sys(courseContext), prompt, 3000, function (obj, attempt) {
    var v = validate(obj);
    if (!v.ok) return { ok: false, errors: _dynFormatErrors(v.errors) };
    // #542 (M1): lints de copia del cliente (no espejo del servidor), blandos: un reintento dirigido y,
    // si persisten o el reintento falla, se conserva la respuesta válida y queda en summary.copyLint.
    var cl = dynLintIntroCopy(obj, kind);
    copyRecs[attempt] = { spelledNumbers: cl.spelled, notInfinitive: cl.notInfinitive };
    return { ok: true, value: obj, soft: cl.errors };
  });
  if (!res.ok) return _dynV3Invalid(item, res.errors, res.truncated);
  var keptCopy = copyRecs[res.usedAttempt];
  if (keptCopy) summary.copyLint = Object.assign({}, keptCopy, { softAccepted: keptCopy.spelledNumbers + keptCopy.notInfinitive > 0 });
  var iSoft = _dynSoftSummary(res);
  if (iSoft) summary.soft = iSoft;
  var a = _dynV3JsonArtifact(item, type, res.value, base);
  return {
    ok: true,
    artifacts: [a.artifact],
    summary: Object.assign(summary, { introSha256: a.sha, coursePlanArtifactId: planRes.artifactId, retried: res.retried, promptVersion: DYN_V3_PROMPT_VERSIONS[item.type] }, dynPedagogySummary(item))
  };
}

// ── video_interactions:<ch> ──
async function _dynRunVideoInteractions(item) {
  var videoKeys = (item.dependsOn || []).filter(function (k) { return String(k).indexOf('video:') === 0; });
  var videoItemKey = videoKeys.length === 1 ? videoKeys[0] : _dynClaimField(item, ['videoItemKey']);
  if (typeof videoItemKey !== 'string' || !videoItemKey) {
    return { ok: false, error: 'video_interactions: no se pudo determinar el item de video (dependsOn: ' + (item.dependsOn || []).join(', ') + ')', retryable: false };
  }
  var durationSec = _dynClaimField(item, ['durationSec']);
  var claimCheckpoints = _dynNormalizeCheckpoints(_dynClaimField(item, ['checkpoints']));
  if (typeof durationSec !== 'number' || !claimCheckpoints) {
    return { ok: false, error: 'video_interactions: el claim no trae la duración real del video y/o el plan de checkpoints (contrato R11a)', retryable: false };
  }
  // El plan del claim debe ser EXACTAMENTE el plan determinístico (R8).
  var plan;
  try { plan = dynPlanInteractionCheckpoints(durationSec); }
  catch (e) { return { ok: false, error: 'video_interactions: ' + ((e && e.message) || String(e)), retryable: false }; }
  var planMatches = plan.length === claimCheckpoints.length && plan.every(function (p, i) {
    var c = claimCheckpoints[i];
    return c.index === p.index && c.atSec === p.atSec && c.segmentStart === p.segment[0] && c.segmentEnd === p.segment[1];
  });
  if (!planMatches) return { ok: false, error: 'video_interactions: VIDEO_PLAN_MISMATCH — los checkpoints del claim no coinciden con planInteractionCheckpoints(' + durationSec + ')', retryable: false };

  // EV6 IV avanzado: el claim pide schemaVersion 2 (Manifest ivAdvanced) y trae el plan de pausas
  // (video.reflectionPlan). Se verifica contra el espejo del plan, igual que los checkpoints.
  var schemaClaim = _dynClaimField(item, ['videoInteractionsSchemaVersion']);
  if (schemaClaim !== undefined && schemaClaim !== 1 && schemaClaim !== 2) {
    return { ok: false, error: 'video_interactions: videoInteractionsSchemaVersion desconocido ' + JSON.stringify(schemaClaim) + ' (se esperaba 1 o 2)', retryable: false };
  }
  var v2 = schemaClaim === 2;
  var reflPlan = null;
  if (v2) {
    var claimRefl = _dynClaimField(item, ['reflectionPlan']);
    if (!_dynIsPlainObject(claimRefl) || !Array.isArray(claimRefl.reflections)) {
      return { ok: false, error: 'video_interactions: el claim pide schemaVersion 2 pero no trae video.reflectionPlan (contrato H5P v2)', retryable: false };
    }
    try { reflPlan = dynPlanReflectionPauses(durationSec, plan); }
    catch (e) { return { ok: false, error: 'video_interactions: ' + ((e && e.message) || String(e)), retryable: false }; }
    var reflMatches = reflPlan.reflections.length === claimRefl.reflections.length && reflPlan.reflections.every(function (r, i) {
      var c = claimRefl.reflections[i];
      return _dynIsPlainObject(c) && c.index === r.index && c.atSec === r.atSec && c.afterCheckpoint === r.afterCheckpoint;
    });
    if (!reflMatches) return { ok: false, error: 'video_interactions: VIDEO_REFLECTION_PLAN_MISMATCH: las pausas del claim no coinciden con planReflectionPauses(' + durationSec + ')', retryable: false };
  }

  var md = await _dynLoadDepText(item, 'dynamic_content_md');
  if (!md.ok) return md.result;
  // #542 (I1): reglas anti-patrón de respuesta + valor sembrado del primer V/F.
  var biasOpts = { tfFirst: dynTfFirstTrue(item.itemKey), pedagogy: dynPedagogyBlock(item) };
  var prompt = v2 ? dynVideoInteractionsPrompt(md.text, claimCheckpoints, reflPlan.reflections, biasOpts) : dynVideoInteractionsPrompt(md.text, claimCheckpoints, undefined, biasOpts);
  var recs = {};
  var res = await _dynV3JsonWithRetry(item, dynVideoInteractionsSys(), prompt, 4000, function (obj, attempt) {
    var rec = recs[attempt] = { polarityFixed: 0, answerBias: null };
    if (!_dynIsPlainObject(obj)) return { ok: false, errors: ['$ NOT_OBJECT: se esperaba {"checkpoints": [...]}'] };
    var allowed = v2 ? ['checkpoints', 'reflections'] : ['checkpoints'];
    var extra = Object.keys(obj).filter(function (k) { return allowed.indexOf(k) < 0; });
    rec.polarityFixed = dynFixFeedbackPolarity(obj.checkpoints, 'feedbackCorrect', 'feedbackIncorrect');
    var doc = { schemaVersion: 1, videoItemKey: videoItemKey, durationSec: durationSec, checkpoints: obj.checkpoints };
    if (v2) {
      doc.schemaVersion = 2;
      if (obj.reflections !== undefined || reflPlan.reflections.length) doc.reflections = obj.reflections;
    }
    var v = dynValidateVideoInteractionsDoc(doc, v2 ? { videoItemKey: videoItemKey, durationSec: durationSec, schemaVersion: 2 } : { videoItemKey: videoItemKey, durationSec: durationSec });
    var errors = extra.map(function (k) { return '$: campo desconocido "' + k + '" (solo ' + allowed.map(function (x) { return '"' + x + '"'; }).join(' y ') + ')'; }).concat(v.errors);
    if (errors.length) return { ok: false, errors: errors };
    var bt = dynAnswerBiasTest(item, 'video_interactions', doc);
    rec.answerBias = bt.stats;
    // #583 (M3): una lista con nombre («los cinco datos mínimos: …») es la misma que la del capítulo.
    return { ok: true, value: doc, soft: bt.errors.concat(dynLintEnumerations(doc, md.text)) };
  }, { normalizeMoney: dynCourseIsColombia(item.context && item.context.courseContext) });
  if (!res.ok) return _dynV3Invalid(item, res.errors, res.truncated);
  var kept = recs[res.usedAttempt] || {};
  var polarityFixed = kept.polarityFixed || 0;
  dynAnswerBiasRemember(item, 'video_interactions', res.value);
  var a = _dynV3JsonArtifact(item, 'dynamic_video_interactions_json', res.value, item.chapterId);
  var summary = Object.assign({ chapterId: item.chapterId, videoItemKey: videoItemKey, durationSec: durationSec, interactionCount: plan.length, interactionsSha256: a.sha, retried: res.retried, feedbackPolarityFixed: polarityFixed, promptVersion: DYN_V3_PROMPT_VERSIONS.video_interactions }, dynPedagogySummary(item));
  if (kept.answerBias) {
    var vFirst = _dynErrCodes(res.firstErrors);
    var vKept = _dynErrCodes(res.softWarnings);
    summary.answerBias = Object.assign({}, kept.answerBias, {
      retriedForBias: res.retried && (vFirst.indexOf('ANSWER_LENGTH_BIAS') >= 0 || vFirst.indexOf('TF_BALANCE') >= 0),
      softAccepted: vKept.indexOf('ANSWER_LENGTH_BIAS') >= 0 || vKept.indexOf('TF_BALANCE') >= 0
    });
  }
  var vSoft = _dynSoftSummary(res);
  if (vSoft) summary.soft = vSoft;
  Object.assign(summary, _dynQualSummary(res));
  if (v2) {
    summary.schemaVersion = 2;
    summary.reflectionCount = reflPlan.reflections.length;
    summary.droppedReflectionCount = reflPlan.droppedReflections.length;
    summary.promptVersion = DYN_V3_VINT_V2_PROMPT_VERSION;
  }
  return { ok: true, artifacts: [a.artifact], summary: summary };
}

// EV5 (auditoría P9): el modelo lee «feedbackCorrect» como «la afirmación es correcta» y a quien
// acertó un V/F le muestra «Incorrecto. …». Reparación determinística y gratuita: se quita el
// rótulo de polaridad contradictorio al inicio (la explicación que sigue sigue siendo válida;
// H5P ya muestra si la respuesta fue correcta). Devuelve cuántos campos se corrigieron.
var DYN_FB_NEG_RE = /^\s*[¡!]?\s*(?:incorrect[oa]|falso|error)\s*[.,:;!—–-][\s.,:;!—–-]*/i;
var DYN_FB_POS_RE = /^\s*[¡!]?\s*(?:correct[oa]|exacto|muy bien|bien hecho|así es)\s*[.,:;!—–-][\s.,:;!—–-]*/i;
function _dynUpperFirst(s) { return s ? s.charAt(0).toLocaleUpperCase('es') + s.slice(1) : s; }
function dynFixFeedbackPolarity(questions, rightKey, wrongKey) {
  var fixed = 0;
  (Array.isArray(questions) ? questions : []).forEach(function (q) {
    if (!_dynIsPlainObject(q)) return;
    [[rightKey, DYN_FB_NEG_RE], [wrongKey, DYN_FB_POS_RE]].forEach(function (kr) {
      var v = q[kr[0]];
      if (typeof v !== 'string' || !kr[1].test(v)) return;
      var rest = _dynUpperFirst(v.replace(kr[1], '').trim());
      if (rest) { q[kr[0]] = rest; fixed++; }
    });
  });
  return fixed;
}

// EV5 (auditoría P3): resúmenes de los capítulos (context_summary del content) para el examen.
// Nunca hace fallar el examen: sin resumen, ese capítulo va solo con título + objetivo.
async function _dynLoadContextSummaries(item) {
  var deps = (item.dependencyArtifacts || []).filter(function (a) { return a && a.type === 'dynamic_context_summary_json'; });
  var out = {};
  await Promise.all(deps.map(function (d) {
    return _dynDownloadArtifactText(d.artifactId).then(function (dl) {
      if (!dl || !dl.ok) return;
      try {
        var j = JSON.parse(dl.text);
        if (j && j.chapterId) out[j.chapterId] = j;
      } catch (e) { /* resumen ilegible: el capítulo va sin resumen */ }
    }).catch(function () {});
  }));
  return out;
}
function _dynExamChapters(chapters, summaries) {
  return (chapters || []).map(function (c, i) {
    var s = summaries[c.id] || {};
    return {
      number: c.chapterNumber || i + 1,
      title: c.title,
      objective: c.objective || null,
      summary: typeof s.summary === 'string' ? s.summary : '',
      concepts: Array.isArray(s.concepts_introduced) ? s.concepts_introduced : [],
      keyTerms: Array.isArray(s.key_terms) ? s.key_terms : []
    };
  });
}

// EV5 (auditoría P4): en el curso #241 la opción correcta era la más larga en 47 de 54 preguntas.
// Se marca una pregunta si la correcta supera a la opción más larga restante por ≥ 8 caracteres.
var DYN_GIFT_BIAS_MIN_DIFF = 8;
var DYN_GIFT_BIAS_MAX_SHARE = 0.2;
function _dynGiftMcBlocks(gift) {
  var out = [];
  var re = /::([^:\n]+)::/g;
  var m;
  var text = String(gift || '');
  while ((m = re.exec(text))) {
    var open = text.indexOf('{', m.index);
    var close = open >= 0 ? text.indexOf('}', open) : -1;
    var nextId = text.indexOf('::', m.index + m[0].length);
    if (open < 0 || close < 0 || (nextId >= 0 && nextId < open)) continue;
    var inner = text.slice(open + 1, close);
    var lines = inner.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var right = lines.filter(function (l) { return l.charAt(0) === '='; });
    var wrong = lines.filter(function (l) { return l.charAt(0) === '~'; });
    if (right.length !== 1 || wrong.length < 2 || inner.indexOf('->') >= 0) continue;
    function len(l) { return l.slice(1).split('#')[0].trim().length; }
    out.push({ id: m[1], start: m.index, end: close + 1, text: text.slice(m.index, close + 1), diff: len(right[0]) - Math.max.apply(null, wrong.map(len)) });
    re.lastIndex = close + 1;
  }
  return out;
}
function dynGiftAnswerBias(gift) {
  var blocks = _dynGiftMcBlocks(gift);
  var flagged = blocks.filter(function (b) { return b.diff >= DYN_GIFT_BIAS_MIN_DIFF; });
  return { mc: blocks.length, flagged: flagged, share: blocks.length ? flagged.length / blocks.length : 0 };
}
// Una corrección dirigida (solo las preguntas marcadas). Nunca hace fallar el examen: si la
// corrección no sirve o rompe algo, se conserva el original y el conteo queda en el summary.
function _dynGiftStem(blockText) {
  return String(blockText).replace(/^::[^:\n]+::/, '').split('{')[0].replace(/\s+/g, ' ').trim().toLowerCase();
}
function _dynGiftShape(gift) {
  var qs = (typeof parseGIFT === 'function') ? parseGIFT(gift) : [];
  return { n: qs.length, sig: qs.map(function (q) { return q.type + '|' + q.name; }).join('\n'), empty: qs.some(function (q) { return !String(q.text || '').trim(); }) };
}
async function _dynBalanceExamAnswers(courseContext, gift, llm) {
  var before = dynGiftAnswerBias(gift);
  var skip = { mc: before.mc, biasedBefore: before.flagged.length, biasedAfter: before.flagged.length, corrected: false };
  if (!before.mc || before.share <= DYN_GIFT_BIAS_MAX_SHARE) return { gift: gift, stats: skip };
  // IDs repetidos en el original: no se tocan (el reemplazo por ID sería ambiguo).
  var idCount = {};
  _dynGiftMcBlocks(gift).forEach(function (b) { idCount[b.id] = (idCount[b.id] || 0) + 1; });
  var targets = before.flagged.filter(function (b) { return idCount[b.id] === 1; });
  if (!targets.length) return { gift: gift, stats: skip };
  var raw;
  try { raw = await llm(dynGiftBalancePrompt(courseContext, targets.map(function (b) { return b.text; }).join('\n\n'))); }
  catch (e) { if (e && e.fatal) throw e; raw = ''; }
  var original = {};
  targets.forEach(function (b) { original[b.id] = b; });
  var fixedById = {};
  _dynGiftMcBlocks(String(raw || '').replace(/```gift|```/g, '')).forEach(function (b) {
    var o = original[b.id];
    if (!o || fixedById[b.id] || b.diff >= DYN_GIFT_BIAS_MIN_DIFF) return;
    if (/\n\s*\n/.test(b.text) || (b.text.match(/^\s*~/gm) || []).length < 3) return; // formato que parseGIFT partiría
    if (_dynGiftStem(b.text) !== _dynGiftStem(o.text)) return; // el enunciado no cambia
    fixedById[b.id] = b.text;
  });
  var out = gift;
  targets.slice().sort(function (a, b) { return b.start - a.start; }).forEach(function (b) {
    if (fixedById[b.id]) out = out.slice(0, b.start) + fixedById[b.id] + out.slice(b.end);
  });
  // El resultado debe tener exactamente las mismas preguntas (tipo + ID, en orden) y ninguna vacía.
  var s0 = _dynGiftShape(gift);
  var s1 = _dynGiftShape(out);
  if (out === gift || s1.n !== s0.n || s1.sig !== s0.sig || (s1.empty && !s0.empty)) return { gift: gift, stats: skip };
  var after = dynGiftAnswerBias(out);
  return { gift: out, stats: { mc: before.mc, biasedBefore: before.flagged.length, biasedAfter: after.flagged.length, corrected: true } };
}

// EV5-C: preguntas de definición («¿Qué es…?») en un cuestionario que debería practicar el objetivo.
var DYN_QS_DEFINITION_RE = /^\s*[¿]?\s*(?:que\s+(?:es|son)\b|cual\s+es\s+la\s+definicion|como\s+se\s+define|que\s+significan?|se\s+(?:denomina|define)\b)/;
function dynQsDefinitionStemHits(questions) {
  var qs = Array.isArray(questions) ? questions : [];
  var hits = qs.filter(function (q) { return q && typeof q.question === 'string' && DYN_QS_DEFINITION_RE.test(_dynFold(q.question)); }).length;
  return { hits: hits, total: qs.length, majority: qs.length > 0 && hits * 2 > qs.length };
}
// EV6 H5P v2: códigos BS_* (únicos, en orden) de los errores del primer intento (observabilidad del reintento).
function _dynBsErrorCodes(errors) {
  var out = [];
  (errors || []).forEach(function (e) {
    var m = /^\[(BS_[A-Z_]+|RESOURCE_MENTION)\]/.exec(String(e));
    if (m && out.indexOf(m[1]) < 0) out.push(m[1]);
  });
  return out;
}

// ════ #583 QUAL — lints determinísticos de copia y consistencia (blandos: UN reintento dirigido) ════
// Auditoría del curso de validación #583 («Gestión del inventario en una tienda de barrio»):
//  - M2: el ejemplo resuelto decía «Le quedan $5.000 de margen» y después «La caja queda en $55.000 para las
//    ventas del día» (dos saldos que no cuadran): cuentas explícitas, totales y saldos del ejemplo resuelto;
//  - M3: «cinco datos mínimos» con listas distintas en el capítulo, el acordeón, el diagrama y el video:
//    toda lista con nombre y número («los cinco datos mínimos: …») debe coincidir con la del capítulo;
//  - M4: «$180.000» en los capítulos y «280 000 pesos» en el caso ramificado: un solo formato de moneda (es-CO);
//  - I4: el caso ramificado recorría el procedimiento del capítulo paso a paso (lo mismo que el ejemplo
//    resuelto) y su mejor opción era la más larga en cada decisión.
// Todo es determinístico y gratis; lo blando nunca hace fallar el item (se conserva la respuesta válida).

// ── Moneda es-CO: «$180.000» (punto de miles, sin espacio, sin «pesos») ──
// Solo cifras con marca de moneda ($, «pesos», COP); nunca cantidades sin moneda ni «3 millones de pesos».
function dynCourseIsColombia(courseContext) {
  var p = String((courseContext && courseContext.pais) || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\bcolombia\b/.test(p);
}
function _dynGroupThousandsEs(digits) {
  var d = String(digits).replace(/^0+(?=\d)/, '');
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
// «280 000», «280.000», «280000», «280,000» → «280.000» (solo enteros: con decimales se deja igual).
function _dynMoneyDigits(num) {
  var s = String(num).trim();
  if (/^\d{1,3}(?:[ \u00a0\u202f]\d{3})+$/.test(s)) return _dynGroupThousandsEs(s.replace(/[ \u00a0\u202f]/g, ''));
  if (/^\d{1,3}(?:\.\d{3})+$/.test(s)) return s;
  if (/^\d{1,3}(?:,\d{3})+$/.test(s)) return _dynGroupThousandsEs(s.replace(/,/g, ''));
  if (/^\d+$/.test(s)) return _dynGroupThousandsEs(s);
  return null;
}
// Fix round 1 (m1): solo montos REALES con marca de moneda. Un número se toma entero o nada (nunca un pedazo de
// «12345.67» ni de «$1.234,50»): ni dígito ni «[.,]dígito» después. Con «$» o «COP» delante, los miles solo con
// punto o coma (un espacio no agrupa: «$ 5 100 unidades» no es $5.100); con «pesos» detrás, también con espacio
// («280 000 pesos»), salvo cuando lo que sigue a «pesos» no es la moneda («año 2024 pesos» → año).
var _DYN_MONEY_END = '(?![\\d]|[.,]\\d)';
var _DYN_MONEY_NUM_DOT = '(?:\\d{1,3}(?:[.,]\\d{3})+|\\d+)' + _DYN_MONEY_END;
var _DYN_MONEY_NUM_ANY = '(?:\\d{1,3}(?:[ \\u00a0\\u202f.,]\\d{3})+|\\d+)' + _DYN_MONEY_END;
var DYN_MONEY_PESOS_RE = new RegExp('(\\b(?:a[nñ]os?|del?|en)\\s+)?(?:\\$\\s?)?(' + _DYN_MONEY_NUM_ANY + ')\\s+(?:de\\s+)?(?:pesos(?:\\s+colombianos)?|COP)\\b', 'gi');
var DYN_MONEY_COP_PREFIX_RE = new RegExp('\\bCOP\\s?\\$?\\s?(' + _DYN_MONEY_NUM_DOT + ')', 'g');
var DYN_MONEY_DOLLAR_RE = new RegExp('\\$[ \\u00a0]?(' + _DYN_MONEY_NUM_DOT + ')(?!\\s+(?:de\\s+)?(?:millones|millón|mil\\b))', 'g');
function dynNormalizeMoneyEsCo(text) {
  var s = String(text == null ? '' : text);
  var n = 0;
  var fix = function (m, num) { var d = _dynMoneyDigits(num); if (d === null) return m; var out = '$' + d; if (out !== m) n++; return out; };
  s = s.replace(DYN_MONEY_PESOS_RE, function (m, pre, num) {
    // «el año 2024 pesos…»: un año (19xx/20xx tras «año», «de», «en») no es un monto.
    if (pre && /^(?:19|20)\d{2}$/.test(num)) return m;
    return (pre || '') + fix(m.slice((pre || '').length), num);
  });
  s = s.replace(DYN_MONEY_COP_PREFIX_RE, function (m, num) { return fix(m, num); });
  s = s.replace(DYN_MONEY_DOLLAR_RE, function (m, num) { return fix(m, num); });
  return { text: s, changed: n };
}
// Normaliza en el lugar TODOS los textos de un objeto JSON (claves de Cursia como itemKey o ids no llevan «$»).
function dynNormalizeMoneyDeep(obj) {
  var changed = 0;
  function walk(v) {
    if (typeof v === 'string') { var r = dynNormalizeMoneyEsCo(v); changed += r.changed; return r.text; }
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) v[i] = walk(v[i]); return v; }
    if (_dynIsPlainObject(v)) { Object.keys(v).forEach(function (k) { v[k] = walk(v[k]); }); return v; }
    return v;
  }
  walk(obj);
  return changed;
}

// ── Cifras es-CO: «180.000» = 180000, «1,5» = 1.5, «12.5» (sin grupo de 3) = 12.5 ──
function _dynParseNumEs(raw) {
  var s = String(raw).replace(/[\s\u00a0\u202f$]/g, '');
  if (!s) return null;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(s)) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  if (/^\d+,\d+$/.test(s)) return parseFloat(s.replace(',', '.'));
  if (/^\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
  return null;
}
var _DYN_EQ_NUM = '\\$?\\s?\\d[\\d.,]*\\d|\\$?\\s?\\d';
// «$180.000 − $110.000 = $70.000», «3 × 4 = 12», «$25.000 + $22.000 + $18.000 = $65.000».
var DYN_EQUATION_RE = new RegExp('((?:' + _DYN_EQ_NUM + ')(?:\\s*[+\\-−–×x*/÷]\\s*(?:' + _DYN_EQ_NUM + '))+)\\s*=\\s*(' + _DYN_EQ_NUM + ')', 'g');
function _dynEvalEs(expr) {
  var toks = String(expr).match(/\$?\s?\d[\d.,]*\d|\$?\s?\d|[+\-−–×x*/÷]/g) || [];
  var vals = [];
  var ops = [];
  for (var i = 0; i < toks.length; i++) {
    if (i % 2 === 0) { var v = _dynParseNumEs(toks[i]); if (v === null) return null; vals.push(v); }
    else ops.push(toks[i]);
  }
  if (vals.length !== ops.length + 1) return null;
  // × ÷ primero, después + −.
  var v2 = [vals[0]];
  var o2 = [];
  ops.forEach(function (op, k) {
    var b = vals[k + 1];
    if (op === '×' || op === 'x' || op === '*') v2[v2.length - 1] *= b;
    else if (op === '/' || op === '÷') { if (b === 0) { v2.push(NaN); return; } v2[v2.length - 1] /= b; }
    else { o2.push(op); v2.push(b); }
  });
  var r = v2[0];
  o2.forEach(function (op, k) { r = op === '+' ? r + v2[k + 1] : r - v2[k + 1]; });
  return isFinite(r) ? r : null;
}
// Montos de dinero de un texto («$180.000» o «180.000 pesos»), en orden.
function _dynMoneyAmounts(text) {
  var out = [];
  String(text || '').replace(/\$\s?(\d[\d.,]*\d|\d)/g, function (m, num) { var v = _dynParseNumEs(num); if (v !== null) out.push(v); return m; });
  return out;
}
var _DYN_FMT_MONEY = function (v) { return '$' + _dynGroupThousandsEs(String(Math.round(v))); };
// Saldos: «le quedan $5.000», «la caja queda en $55.000», «sobran $3.000», «saldo de $10.000».
var DYN_REMAINDER_RE = /\b(?:(?:le|te|nos|les|me)\s+)?(?:quedan?|sobran?|restan?)\b(?:\s+(?:en|con|de|unos|apenas|solo|sólo|todavía|aún))*\s+\$\s?(\d[\d.,]*\d|\d)|\bsaldo(?:\s+\w+){0,2}\s+(?:de|en|es de)\s+\$\s?(\d[\d.,]*\d|\d)/gi;

// Ejemplo resuelto (worked_example de la experiencia) → hallazgos blandos [WE_ARITH|WE_TOTAL|WE_REMAINDER].
function dynLintWorkedExampleNumbers(we, path) {
  var out = [];
  if (!_dynIsPlainObject(we)) return out;
  var p = path || '$';
  var texts = [];
  if (typeof we.situation === 'string') texts.push([p + '.situation', we.situation]);
  (Array.isArray(we.data) ? we.data : []).forEach(function (d, i) { if (typeof d === 'string') texts.push([p + '.data[' + i + ']', d]); });
  (Array.isArray(we.steps) ? we.steps : []).forEach(function (s, i) {
    if (!_dynIsPlainObject(s)) return;
    if (typeof s.action === 'string') texts.push([p + '.steps[' + i + '].action', s.action]);
    if (typeof s.detail === 'string') texts.push([p + '.steps[' + i + '].detail', s.detail]);
  });
  if (typeof we.result === 'string') texts.push([p + '.result', we.result]);
  if (typeof we.takeaway === 'string') texts.push([p + '.takeaway', we.takeaway]);
  // (1) Cuentas explícitas.
  texts.forEach(function (t) {
    String(t[1]).replace(DYN_EQUATION_RE, function (m, lhs, rhs) {
      var l = _dynEvalEs(lhs);
      var r = _dynParseNumEs(rhs);
      if (l === null || r === null) return m;
      var tol = Math.max(0.005 * Math.abs(r), 0.01);
      if (Math.abs(l - r) > tol) out.push('[WE_ARITH] ' + t[0] + ': la cuenta «' + m.replace(/\s+/g, ' ').trim() + '» no da (' + lhs.replace(/\s+/g, ' ').trim() + ' = ' + (Math.round(l * 100) / 100).toLocaleString('es-CO') + '); corrige el resultado o los datos');
      return m;
    });
  });
  // (2) «Total …: $T» en los datos = suma de los montos inmediatamente anteriores (≥ 2 seguidos).
  var data = (Array.isArray(we.data) ? we.data : []).map(function (d) { return typeof d === 'string' ? d : ''; });
  data.forEach(function (d, i) {
    if (!/^\s*total\b/i.test(d)) return;
    var t = _dynMoneyAmounts(d);
    if (t.length !== 1) return;
    var prev = [];
    for (var j = i - 1; j >= 0; j--) {
      if (/^\s*total\b/i.test(data[j])) break;
      var a = _dynMoneyAmounts(data[j]);
      if (a.length !== 1) break;
      prev.unshift(a[0]);
    }
    if (prev.length < 2) return;
    var ok = false;
    for (var k = 0; k <= prev.length - 2 && !ok; k++) {
      var sum = prev.slice(k).reduce(function (x, y) { return x + y; }, 0);
      if (Math.abs(sum - t[0]) <= 0.5) ok = true;
    }
    if (!ok) out.push('[WE_TOTAL] ' + p + '.data[' + i + ']: «' + d.trim() + '» no es la suma de los datos que lo preceden (' + prev.map(_DYN_FMT_MONEY).join(' + ') + '); corrige el total o los datos');
  });
  // (3) Saldos: un saldo posterior MAYOR que uno anterior (sin ingreso de por medio) mezcla dos bolsillos.
  var rem = [];
  texts.forEach(function (t) {
    if (/\.(?:data\[\d+\]|situation)$/.test(t[0])) return;
    String(t[1]).replace(DYN_REMAINDER_RE, function (m, a, b) { var v = _dynParseNumEs(a || b); if (v !== null) rem.push({ v: v, path: t[0], text: m.replace(/\s+/g, ' ').trim() }); return m; });
  });
  for (var x = 1; x < rem.length; x++) {
    if (rem[x].v > rem[x - 1].v && rem[x].path !== rem[x - 1].path) {
      out.push('[WE_REMAINDER] ' + rem[x].path + ': el ejemplo dice «' + rem[x - 1].text + '» y después «' + rem[x].text + '»: un saldo no puede crecer sin un ingreso; aclara de qué es cada monto (presupuesto, caja, dinero apartado) y haz que las cuentas cuadren con los datos');
      break;
    }
  }
  return out;
}

// ── Listas con nombre y número («los cinco datos mínimos: fecha, producto…») ──
var _DYN_NUM_WORDS = { dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
var _DYN_ENUM_SKIP = { veces: 1, dias: 1, semanas: 1, meses: 1, anos: 1, horas: 1, minutos: 1, pesos: 1, unidades: 1, cajas: 1, metros: 1, kilos: 1, litros: 1, paquetes: 1, productos: 1, clientes: 1, proveedores: 1, tiendas: 1, personas: 1, columnas: 1, filas: 1, lineas: 1 };
var _DYN_ENUM_HEAD_RE = /(?:^|[^\p{L}\p{N}])(?:(?:los|las|tus|sus|estos|estas|esos|esas)\s+)?(dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|[2-9]|10)\s+(\p{L}{4,}(?:\s+\p{L}{2,}){0,4}?)[ \t]*(?:\([^)]{0,40}\)[ \t]*)?:[ \t]*/gu;
function _dynFoldEs(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function _dynEnumKey(name) {
  var w = _dynFoldEs(name).split(/\s+/).filter(function (x) { return x.length >= 3 && !/^(que|del|los|las|con|por|para|una|uno)$/.test(x); });
  return w.slice(0, 2).join(' ');
}
function _dynEnumItemStems(item) {
  var o = {};
  _dynFoldEs(item).replace(/[\p{L}]{4,}/gu, function (w) { if (!DYN_EXAM_STOPWORDS[w]) o[w.slice(0, 5)] = true; return w; });
  return Object.keys(o);
}
// Texto → [{n, name, key, items[]}] solo cuando el número va seguido de «:» y una lista (viñetas o en línea).
function dynNamedEnumerations(text) {
  var src = String(text || '');
  var out = [];
  var m;
  _DYN_ENUM_HEAD_RE.lastIndex = 0;
  while ((m = _DYN_ENUM_HEAD_RE.exec(src))) {
    var numRaw = _dynFoldEs(m[1]);
    var n = _DYN_NUM_WORDS[numRaw] || parseInt(numRaw, 10);
    var name = m[2].trim().replace(/\s+(?:son|es|serán|serian|serían|incluyen|incluye|que\s+debes\s+anotar)$/i, '');
    var firstWord = _dynFoldEs(name.split(/\s+/)[0]);
    if (_DYN_ENUM_SKIP[firstWord] && name.split(/\s+/).length === 1) continue;
    var rest = src.slice(m.index + m[0].length);
    var items = [];
    var lines = rest.split('\n');
    if (!lines[0].trim()) {
      // Viñetas en las líneas siguientes.
      for (var i = 1; i < lines.length; i++) {
        var l = lines[i];
        if (!l.trim()) { if (items.length) break; continue; }
        var b = /^\s*(?:[-*•‣◦▪]|\d{1,2}[.)])\s+(.+)$/.exec(l);
        if (!b) break;
        items.push(b[1].replace(/\*\*/g, '').split(/[:—–(]/)[0].trim());
      }
    } else {
      var sent = lines[0].split(/[.;](?:\s|$)/)[0];
      items = sent.split(/\s*,\s*|\s+y\s+(?=[^,]*$)|\s+e\s+(?=[^,]*$)/).map(function (x) { return x.replace(/\*\*/g, '').trim(); }).filter(Boolean);
    }
    if (items.length < 2) continue;
    out.push({ n: n, name: name, key: _dynEnumKey(name), items: items.slice(0, 12) });
  }
  return out;
}
// Textos de un objeto JSON como «líneas» (cada elemento de una lista en su línea, como viñeta).
function _dynJsonAsLines(v, path, out) {
  if (typeof v === 'string') out.push([path, v]);
  else if (Array.isArray(v)) {
    if (v.length && v.every(function (x) { return typeof x === 'string'; })) out.push([path, '\n' + v.map(function (x) { return '- ' + x; }).join('\n')]);
    else v.forEach(function (x, i) { _dynJsonAsLines(x, path + '[' + i + ']', out); });
  } else if (_dynIsPlainObject(v)) Object.keys(v).forEach(function (k) { _dynJsonAsLines(v[k], path + '.' + k, out); });
  return out;
}
// Un componente como texto continuo: «título: …» + sus elementos como viñetas (encabezados de acordeón,
// pasos, nodos de diagrama), para que «Los cinco datos mínimos» + 6 nodos cuente como una lista de 6.
function _dynComponentListText(c) {
  if (!_dynIsPlainObject(c)) return '';
  var head = [c.title, c.heading, c.label].filter(function (x) { return typeof x === 'string'; }).join(' ');
  var arr = null;
  ['items', 'steps', 'nodes', 'cards', 'events', 'tabs'].some(function (k) { if (Array.isArray(c[k]) && c[k].length >= 2) { arr = c[k]; return true; } return false; });
  if (!head || !arr) return '';
  var labels = arr.map(function (x) {
    if (typeof x === 'string') return x;
    if (!_dynIsPlainObject(x)) return '';
    return [x.heading, x.action, x.label, x.title, x.term, x.text].filter(function (y) { return typeof y === 'string'; })[0] || '';
  }).filter(Boolean);
  if (labels.length < 2) return '';
  return head.replace(/\s*:?\s*$/, '') + ':\n' + labels.map(function (x) { return '- ' + x; }).join('\n');
}
// Enumeraciones canónicas del capítulo (las del Markdown; si el mismo nombre aparece dos veces, la primera).
function dynCanonicalEnumerations(md) {
  var out = {};
  dynNamedEnumerations(md).forEach(function (e) { if (e.key && !out[e.key] && e.items.length === e.n) out[e.key] = e; });
  return out;
}
function _dynEnumMismatch(canon, got) {
  if (got.n !== canon.n) return 'dice ' + got.n + ' y el capítulo enumera ' + canon.n;
  if (got.items.length !== got.n) return 'nombra ' + got.n + ' y enumera ' + got.items.length;
  var gs = got.items.map(_dynEnumItemStems);
  var missing = canon.items.filter(function (it) {
    var st = _dynEnumItemStems(it);
    return st.length && !gs.some(function (g) { return g.some(function (x) { return st.indexOf(x) >= 0; }); });
  });
  if (missing.length) return 'falta «' + missing.slice(0, 3).join('», «') + '» de la lista del capítulo';
  var cs = canon.items.map(_dynEnumItemStems);
  var extra = got.items.filter(function (it, k) {
    return gs[k].length && !cs.some(function (c) { return c.some(function (x) { return gs[k].indexOf(x) >= 0; }); });
  });
  if (extra.length) return 'agrega «' + extra.slice(0, 3).join('», «') + '», que no está en la lista del capítulo';
  return null;
}
// Hallazgos blandos [ENUM_MISMATCH] de un JSON (experiencia, video, actividad) contra el capítulo.
function dynLintEnumerations(doc, md) {
  var canon = dynCanonicalEnumerations(md);
  var out = [];
  var seen = {};
  var check = function (path, text) {
    dynNamedEnumerations(text).forEach(function (e) {
      var c = canon[e.key];
      var why = c ? _dynEnumMismatch(c, e) : (e.items.length !== e.n ? 'nombra ' + e.n + ' y enumera ' + e.items.length : null);
      if (!why || seen[path + '|' + e.key]) return;
      seen[path + '|' + e.key] = true;
      out.push('[ENUM_MISMATCH] ' + path + ': «' + e.n + ' ' + e.name + '» ' + why + (c ? ' (en el capítulo: ' + c.items.join(', ') + '); usa exactamente esa lista' : '; que el número y la lista coincidan'));
    });
  };
  _dynJsonAsLines(doc, '$', []).forEach(function (pt) { check(pt[0], pt[1]); });
  // Componentes: título + elementos.
  (function walk(v, path) {
    if (Array.isArray(v)) v.forEach(function (x, i) { walk(x, path + '[' + i + ']'); });
    else if (_dynIsPlainObject(v)) {
      var t = _dynComponentListText(v);
      if (t) check(path, t);
      Object.keys(v).forEach(function (k) { if (_dynIsPlainObject(v[k]) || Array.isArray(v[k])) walk(v[k], path + '.' + k); });
    }
  })(doc, '$');
  return out;
}
// Capítulo contra su objetivo (solo se mide: el capítulo es la fuente; el objetivo lo aprobó el usuario).
function dynLintEnumerationsVsObjective(md, objective) {
  var canon = dynCanonicalEnumerations(md);
  var out = [];
  dynNamedEnumerations(objective).forEach(function (e) {
    var c = canon[e.key];
    var why = c ? _dynEnumMismatch(e, c) : null;
    if (why) out.push({ name: e.n + ' ' + e.name, objective: e.items, chapter: c.items, why: why });
  });
  dynNamedEnumerations(md).forEach(function (e) {
    if (e.items.length !== e.n) out.push({ name: e.n + ' ' + e.name, chapter: e.items, why: 'nombra ' + e.n + ' y enumera ' + e.items.length });
  });
  return out;
}

// ── Caso ramificado: la mejor opción nunca es la más larga de SU decisión (#583 I4) ──
function dynLintBsLongestOptimal(data) {
  var out = [];
  if (!_dynIsPlainObject(data) || !Array.isArray(data.decisions)) return out;
  var q = _dynBsOptionRanks(data);
  data.decisions.forEach(function (d, i) {
    if (!_dynIsPlainObject(d) || !Array.isArray(d.options) || d.options.length < 2) return;
    var top = Math.max.apply(null, q[i]);
    var tops = q[i].map(function (x, j) { return x === top ? j : -1; }).filter(function (j) { return j >= 0; });
    if (tops.length !== 1) return;
    var bj = tops[0];
    var bl = _dynAnsLen(d.options[bj] && d.options[bj].text);
    var omax = Math.max.apply(null, d.options.filter(function (o, j) { return j !== bj; }).map(function (o) { return _dynAnsLen(o && o.text); }));
    if (bl > omax) out.push('[BS_OPTION_LONGEST] decisions[' + i + '].options[' + bj + ']: la mejor opción es la más larga de la decisión (' + bl + ' vs ' + omax + ' caracteres): alarga una opción peor o acorta la mejor para que la mejor NO sea la más larga');
  });
  return out;
}

// ── Caso ramificado vs el procedimiento del capítulo (lo que sigue el ejemplo resuelto) ──
// Procedimientos del capítulo: líneas «Paso N …» o listas numeradas de ≥ 3 pasos (fuera de las Actividades de Apoyo).
var DYN_PROC_STEP_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:paso\s+(\d{1,2})\b|(\d{1,2})[.)]\s)\s*(.*)$/i;
function dynChapterProcedures(md) {
  var lines = String(md || '').split('\n');
  var runs = [];
  var cur = [];
  var inActivity = false;
  var flush = function () { if (cur.length >= 3) runs.push(cur); cur = []; };
  lines.forEach(function (l) {
    if (/actividad de apoyo/i.test(l)) { flush(); inActivity = true; return; }
    if (/^\s*#{1,6}\s/.test(l) || /^\s*■(?!■)/.test(l)) { flush(); inActivity = /actividad de apoyo/i.test(l); return; }
    if (inActivity) return;
    var m = DYN_PROC_STEP_RE.exec(l);
    if (m && (m[3] || '').trim().length >= 8) { cur.push(l.replace(/[*_#]/g, '').trim()); return; }
    if (l.trim() && cur.length && !/^\s{2,}/.test(l)) flush();
  });
  flush();
  return runs;
}
function _dynStems5(s) {
  var o = {};
  _dynFoldEs(s).replace(/[\p{L}]{5,}/gu, function (w) { if (!DYN_EXAM_STOPWORDS[w]) o[w.slice(0, 5)] = true; return w; });
  return o;
}
// Decisiones del camino óptimo (las que llevan a la mejor calidad alcanzable desde d1).
function _dynBsOptimalPath(data) {
  var q = _dynBsOptionRanks(data);
  var byId = {};
  (data.decisions || []).forEach(function (d, i) { if (_dynIsPlainObject(d)) byId[d.id] = i; });
  var path = [];
  var cur = (data.decisions && data.decisions[0] && data.decisions[0].id) || null;
  var guard = 0;
  while (cur && byId[cur] !== undefined && guard++ < 8) {
    var i = byId[cur];
    var d = data.decisions[i];
    var top = Math.max.apply(null, q[i]);
    var bj = q[i].indexOf(top);
    path.push({ i: i, text: String(d.question || '') + ' ' + String((d.options[bj] && d.options[bj].text) || '') });
    var nx = d.options[bj] && d.options[bj].next;
    cur = typeof nx === 'string' && nx.indexOf('end:') !== 0 ? nx : null;
  }
  return path;
}
var DYN_BS_SKELETON_MIN_SHARED = 3;
// → { mirrored, steps: [índices de paso por decisión del camino óptimo], procedure }
function dynLintBsSkeleton(data, md) {
  var res = { mirrored: false, steps: [], procedure: null };
  if (!_dynIsPlainObject(data) || !Array.isArray(data.decisions)) return res;
  var procs = dynChapterProcedures(md);
  if (!procs.length) return res;
  var path = _dynBsOptimalPath(data);
  procs.forEach(function (proc) {
    if (res.mirrored) return;
    var ps = proc.map(_dynStems5);
    var seq = path.map(function (p) {
      var ds = _dynStems5(p.text);
      var best = -1, bestN = 0, second = 0;
      ps.forEach(function (s, k) {
        var n = Object.keys(ds).filter(function (w) { return s[w]; }).length;
        if (n > bestN) { second = bestN; bestN = n; best = k; } else if (n > second) second = n;
      });
      return bestN >= DYN_BS_SKELETON_MIN_SHARED && bestN > second ? best : -1;
    });
    var mapped = seq.filter(function (x) { return x >= 0; });
    var distinct = mapped.filter(function (x, k) { return mapped.indexOf(x) === k; });
    var ordered = mapped.every(function (x, k) { return k === 0 || x >= mapped[k - 1]; });
    if (path.length >= 2 && distinct.length >= 2 && ordered && 3 * mapped.length >= 2 * path.length) {
      res = { mirrored: true, steps: seq, procedure: proc };
    } else if (!res.procedure) {
      res = { mirrored: false, steps: seq, procedure: proc };
    }
  });
  return res;
}

// ── activity:<ch> ──
async function _dynRunActivity(item) {
  if (item.variant === 'scorm') return _dynRunScorm(item); // motor SCORM v2 de siempre (sin cambios)
  if (item.variant !== 'h5p') return { ok: false, error: 'activity: variant desconocido o ausente (' + JSON.stringify(item.variant) + ')', retryable: false };
  return _dynRunActivityH5p(item);
}

async function _dynRunActivityH5p(item) {
  var claimed = _dynClaimField(item, ['h5pType', 'activityType', 'requiredH5pType']);
  if (typeof claimed !== 'string' || !claimed) return { ok: false, error: 'activity h5p: el claim no trae el tipo h5p requerido (contrato R11a)', retryable: false };
  // EV5-C: con reglas por objetivo el tipo viene congelado en el Manifest (el servidor lo vuelve a
  // exigir al completar); el hash solo se exige a claims de Manifests sin reglas (rotación).
  var fromManifest = _dynClaimField(item, ['activityTypeSource']) === 'manifest';
  // EV6 H5P v2: branchingscenario solo si el Manifest lo declara (activityTypeSource 'manifest'; el
  // servidor además exige activityTypeRules = 2). Nunca se cambia por otro tipo: falla a la vista.
  var manifestOnly = DYN_H5P_MANIFEST_ONLY_TYPES.indexOf(claimed) >= 0;
  if (manifestOnly && !fromManifest) {
    return { ok: false, error: 'ACTIVITY_TYPE_NOT_IN_MANIFEST: el tipo "' + claimed + '" solo se genera cuando el Manifest lo declara (activityTypeSource "manifest"); el claim trae ' + JSON.stringify(_dynClaimField(item, ['activityTypeSource']) || null), retryable: false };
  }
  if (DYN_H5P_ACTIVITY_TYPES.indexOf(claimed) < 0 && !manifestOnly) return { ok: false, error: 'activity h5p: tipo "' + claimed + '" fuera de la whitelist ' + DYN_H5P_ACTIVITY_TYPES.concat(DYN_H5P_MANIFEST_ONLY_TYPES).join('|'), retryable: false };
  var expected;
  try { expected = dynActivityTypeForChapter(item.chapterId); }
  catch (e) { return { ok: false, error: 'activity h5p: ' + ((e && e.message) || String(e)), retryable: false }; }
  if (!fromManifest && claimed !== expected) {
    return { ok: false, error: 'ACTIVITY_TYPE_MISMATCH: el claim pide "' + claimed + '" pero el tipo derivado del capítulo ' + item.chapterId + ' es "' + expected + '"', retryable: false };
  }
  var type = claimed;
  var pp = _dynClaimField(item, ['passPercentage', 'passingGrade']);
  var ppSource = 'claim';
  if (!(Number.isInteger(pp) && pp >= 0 && pp <= 100)) { pp = DYN_DEFAULT_PASSING_GRADE; ppSource = 'default'; }

  var src = await _dynLoadSourcesFor(item);
  if (!src.ok) return src.result;
  var ch = (item.blueprint && item.blueprint.chapter) || {};
  // #542 (I1/I5): V/F sembrado del cuestionario; el caso ramificado recibe el caso del capítulo para no repetirlo.
  var focus = { objective: ch.objective, title: ch.title };
  // Fase 2 (motor pedagógico): intención, escenario y retroalimentación de ESTA actividad (escenario ramificado incluido).
  var ped = dynPedagogyBlock(item);
  if (ped) focus.pedagogy = ped;
  if (type === 'questionset') focus.tfFirst = dynTfFirstTrue(item.itemKey);
  if (src.practice) focus.practice = true;
  var chapterCase = type === 'branchingscenario' ? dynExtractChapterCase(src.contentMd) : '';
  if (chapterCase) focus.chapterCase = dynCaseForPrompt(chapterCase);
  // #583 (I4): el caso ramificado no recorre el procedimiento del capítulo paso a paso (eso hace el ejemplo resuelto).
  var procedures = type === 'branchingscenario' ? dynChapterProcedures(src.contentMd) : [];
  if (procedures.length) focus.chapterProcedure = procedures[0].map(function (l) { return l.length > 140 ? l.slice(0, 140).replace(/\s+\S*$/, '') + '…' : l; });
  // #583 (I2): DragText para teléfono (texto corto + 2 distractores) solo si el backend acepta `distractors`.
  var dragTextMobile = type === 'dragtext' && dynDragTextMobileSupported(item);
  if (dragTextMobile) focus.dragTextMobile = true;
  var prompt = dynH5pActivityPrompt(type, src.contentMd, src.contextPackage, focus);
  // Fix round 1 (#542 I2): registros POR INTENTO; el summary usa los del intento que se conserva.
  var recs = {};
  var res = await _dynV3JsonWithRetry(item, dynH5pActivitySys(), prompt, 5000, function (obj, attempt) {
    if (!_dynIsPlainObject(obj)) return { ok: false, errors: ['$: debe ser un objeto'] };
    var rec = recs[attempt] = { stemLint: null, polarityFixed: 0, answerBias: null, caseReuse: null, skeleton: null, distractors: null };
    // itemKey y passPercentage los pone Cursia (sobrescriben cualquier valor del LLM).
    var data = Object.assign({}, obj, { itemKey: item.itemKey });
    var defError = null;
    if (type === 'questionset' || type === 'branchingscenario') {
      // Mayoría de preguntas/decisiones de definición: el primer intento va al reintento dirigido (duro, como
      // siempre); en el reintento solo se registra (el item nunca falla más que antes por esto).
      var sh = dynQsDefinitionStemHits(type === 'questionset' ? data.questions : data.decisions);
      rec.stemLint = { hits: sh.hits, total: sh.total, softAccepted: sh.majority && attempt !== 1 };
      if (sh.majority && attempt === 1) {
        defError = type === 'questionset'
          ? '$.questions: la mayoría son preguntas de definición («¿Qué es…?»); reescríbelas como situaciones del sector en las que el estudiante decide qué hacer o por qué'
          : '$.decisions: la mayoría son preguntas de definición («¿Qué es…?»); reescríbelas como dilemas del sector en los que el estudiante decide qué hacer';
      }
    }
    if (type === 'questionset') rec.polarityFixed = dynFixFeedbackPolarity((data.questions || []).filter(function (q) { return q && q.kind === 'truefalse'; }), 'feedbackCorrect', 'feedbackWrong');
    if (type === 'questionset' || type === 'singlechoiceset') data.passPercentage = pp;
    if (type === 'dragtext') rec.distractors = dynRepairDragTextDistractors(data, dragTextMobile);
    var v = dynValidateH5pActivityData(type, data, { dragTextMobile: dragTextMobile });
    // H3 fix round 2 (A-m2): el único reintento recibe TAMBIÉN los errores del grafo de esta misma respuesta.
    if (!v.ok) return { ok: false, errors: (defError ? [defError] : []).concat(v.errors) };
    // #583 fix round 1 (I1): lo que excede el objetivo móvil del DragText es blando (aviso + reintento dirigido).
    var soft = (v.soft || []).slice();
    if (type === 'questionset' || type === 'branchingscenario') {
      var bt = dynAnswerBiasTest(item, type, data);
      rec.answerBias = bt.stats;
      soft = soft.concat(bt.errors);
    }
    if (type === 'branchingscenario' && chapterCase) {
      var cr = dynLintCaseReuse(String(data.title || '') + ' ' + String(data.situation || ''), src.contentMd);
      rec.caseReuse = { reused: cr.reused, distinct: cr.distinct.slice(0, 8), overlap: cr.overlap };
      if (cr.reused) soft.push('[BS_CASE_REUSE] situation: el caso repite el caso resuelto del capítulo (' + cr.distinct.slice(0, 6).join(', ') + '): usa otro producto o servicio, otra situación o una condición distinta');
    }
    if (type === 'branchingscenario') {
      // #583 (I4): la mejor opción no es la más larga en NINGUNA decisión (no solo en el acumulado) y el camino
      // óptimo no recorre el procedimiento del capítulo en orden (lo mismo que el ejemplo resuelto).
      soft = soft.concat(dynLintBsLongestOptimal(data));
      var sk = dynLintBsSkeleton(data, src.contentMd);
      if (sk.steps.length) rec.skeleton = { mirrored: sk.mirrored, steps: sk.steps };
      if (sk.mirrored) {
        soft.push('[BS_CASE_SKELETON] decisions: el camino óptimo recorre el procedimiento del capítulo en orden (' + sk.steps.filter(function (x) { return x >= 0; }).map(function (x) { return 'paso ' + (x + 1); }).join(' → ') +
          '), igual que el ejemplo resuelto del capítulo: plantea OTRA decisión del tema (una complicación: un imprevisto, un error de otra persona, un conflicto con un cliente o un proveedor, un dato que falta) en la que aplicar el capítulo no sea seguir esos pasos uno tras otro');
      }
    }
    // #583 (M3): una lista con nombre («los cinco datos mínimos: …») es la misma que la del capítulo.
    soft = soft.concat(dynLintEnumerations(obj, src.contentMd));
    // m4: la definición (dura) viaja junto con lo blando en el mismo y único reintento.
    if (defError) return { ok: false, errors: [defError].concat(soft) };
    return { ok: true, value: { type: type, data: data }, soft: soft };
  }, { normalizeMoney: dynCourseIsColombia(item.context && item.context.courseContext) });
  // EV6 H5P v2: un caso ramificado inválido tras el reintento dirigido FALLA (nunca se cambia por otro tipo).
  if (!res.ok) return _dynV3Invalid(item, res.errors, res.truncated);
  var kept = recs[res.usedAttempt] || {};
  var polarityFixed = kept.polarityFixed || 0;
  // #542 (I1): H5P.BranchingScenario no baraja las opciones: orden determinístico por decisión.
  if (type === 'branchingscenario') dynShuffleBsOptions(res.value.data, item.itemKey);
  if (type === 'questionset' || type === 'branchingscenario') dynAnswerBiasRemember(item, type, res.value.data);
  var a = _dynV3JsonArtifact(item, 'dynamic_h5p_params_json', res.value, item.chapterId);
  var summary = Object.assign({ chapterId: item.chapterId, variant: 'h5p', h5pType: type, activityTypeSource: fromManifest ? 'manifest' : 'rotation', paramsSha256: a.sha, retried: res.retried, feedbackPolarityFixed: polarityFixed, promptVersion: type === 'branchingscenario' ? DYN_V3_BS_PROMPT_VERSION : type === 'questionset' ? DYN_V3_QS_PROMPT_VERSION : dragTextMobile ? DYN_V3_DT_PROMPT_VERSION : DYN_V3_PROMPT_VERSIONS.activity }, dynPedagogySummary(item));
  if (type === 'dragtext') {
    var dtd = res.value.data;
    summary.dragText = { mobile: dragTextMobile, chars: String(dtd.text || '').trim().length, blanks: Math.floor(String(dtd.text || '').split('*').length / 2), distractors: Array.isArray(dtd.distractors) ? dtd.distractors.length : 0 };
    if (kept.distractors && (kept.distractors.stripped || kept.distractors.dropped.length)) summary.dragText.distractorsRepair = { stripped: kept.distractors.stripped, dropped: kept.distractors.dropped.slice(0, 6) };
    if (dragTextMobile) summary.dragText.softAccepted = _dynErrCodes(res.softWarnings).indexOf('DRAGTEXT_MOBILE') >= 0;
  }
  if (kept.skeleton) summary.caseSkeleton = Object.assign({}, kept.skeleton, { softAccepted: _dynErrCodes(res.softWarnings).indexOf('BS_CASE_SKELETON') >= 0 });
  Object.assign(summary, _dynQualSummary(res));
  if (type === 'branchingscenario') {
    var bsData = res.value.data;
    summary.branching = { decisionCount: bsData.decisions.length, endingCount: bsData.endings.length };
    if (res.retried) summary.branching.firstErrorCodes = _dynBsErrorCodes(res.firstErrors);
  }
  if (kept.stemLint) summary.stemLint = kept.stemLint;
  var firstCodes = _dynErrCodes(res.firstErrors);
  var keptCodes = _dynErrCodes(res.softWarnings);
  if (kept.answerBias) {
    summary.answerBias = Object.assign({}, kept.answerBias, {
      retriedForBias: res.retried && (firstCodes.indexOf('ANSWER_LENGTH_BIAS') >= 0 || firstCodes.indexOf('BS_LENGTH_BIAS') >= 0 || firstCodes.indexOf('TF_BALANCE') >= 0),
      softAccepted: keptCodes.indexOf('ANSWER_LENGTH_BIAS') >= 0 || keptCodes.indexOf('BS_LENGTH_BIAS') >= 0 || keptCodes.indexOf('TF_BALANCE') >= 0
    });
  }
  if (kept.caseReuse) summary.caseReuse = Object.assign({}, kept.caseReuse, { softAccepted: keptCodes.indexOf('BS_CASE_REUSE') >= 0 });
  var soft = _dynSoftSummary(res);
  if (soft) summary.soft = soft;
  if (type === 'questionset' || type === 'singlechoiceset') { summary.passPercentage = pp; summary.passPercentageSource = ppSource; }
  return { ok: true, artifacts: [a.artifact], summary: summary };
}

// Espejo de validateExamGift / giftCandidateBlocks (R11a final-exam.ts).
var DYN_FINAL_EXAM_QUESTION_RANGE = { min: 5, max: 40 };
function dynGiftCandidateBlocks(gift) {
  var lines = String(gift == null ? '' : gift).split('\n');
  var n = 0;
  var i = 0;
  while (i < lines.length) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === '/' || line.indexOf('$CATEGORY:') === 0) { i++; continue; }
    var nameMatch = line.match(/^::([^:]+)::/);
    if (nameMatch) line = line.substring(nameMatch[0].length).trim();
    var full = line;
    while (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].trim().charAt(0) !== ':') {
      i++;
      full += '\n' + lines[i].trim();
    }
    if (full.indexOf('{') >= 0 && full.lastIndexOf('}') >= 0) n++;
    i++;
  }
  return n;
}
function dynValidateExamGift(gift, range) {
  range = range || DYN_FINAL_EXAM_QUESTION_RANGE;
  var errors = [];
  if (typeof gift !== 'string' || !gift.trim()) return { ok: false, questionCount: 0, errors: [{ path: '$', code: 'GIFT_EMPTY', message: 'GIFT vacío' }] };
  var questions = parseGIFT(gift);
  var blocks = dynGiftCandidateBlocks(gift);
  if (questions.length === 0) errors.push({ path: '$', code: 'GIFT_NO_QUESTIONS', message: 'el GIFT no produjo ninguna pregunta parseable' });
  if (questions.length < blocks) errors.push({ path: '$', code: 'GIFT_UNPARSEABLE_BLOCK', message: (blocks - questions.length) + ' bloque(s) con llaves no se pudieron leer como pregunta (' + questions.length + '/' + blocks + ')' });
  if (questions.length > 0 && (questions.length < range.min || questions.length > range.max)) errors.push({ path: '$', code: 'GIFT_QUESTION_COUNT', message: questions.length + ' preguntas, se esperaban ' + range.min + '–' + range.max });
  questions.forEach(function (q, i) {
    if (!String((q && q.text) == null ? '' : q.text).trim()) errors.push({ path: '$[' + i + ']', code: 'GIFT_EMPTY_QUESTION', message: 'pregunta sin enunciado' });
  });
  return { ok: errors.length === 0, questionCount: questions.length, errors: errors };
}

// ── final_exam:<courseId> (GIFT) ──
// Mismo patrón que _dynRunExam (reparto por tipo, recorte de excedentes, UN
// reintento de corrección, falla si sigue incompleto), con el reparto del
// examen final (tope 40) y prefijo EF.
// R14-12: una respuesta CORRECTA (o una afirmación marcada VERDADERA, o un par de emparejamiento)
// apoyada en un neuromito enseña lo contrario de lo que el curso sostiene (#241: "estilos de
// aprendizaje" como respuesta correcta). Como distractor (~) está permitido.
// Solo el neuromito VAK ("estilo(s) de aprendizaje", "estilo visual/auditivo", kinestésico): el apoyo
// multimodal ("apoyos visuales y auditivos", DUA) es correcto y no se marca. Las respuestas que REFUTAN
// el mito ("no existe evidencia de que…") tampoco.
var DYN_NEUROMYTH_RE = /estilos? de aprendizaje|estilos? (?:visual|auditiv|kinestesic)|\bvak\b/;
// Solo frases que REFUTAN el mito (un "no"/"sin" suelto no alcanza: "…sin bajar la exigencia").
var DYN_NEUROMYTH_DEBUNK_RE = /\b(?:mito|neuromito|carece[n]?|falta de evidencia|no (?:existe|hay) (?:evidencia|respaldo)|sin (?:evidencia|respaldo)|no mejora\w*|refuta\w*|desmiente\w*)\b/;
function _dynGiftAnswers(body) {
  // body = "{…}"; tokeniza en = / ~ no escapados y descarta el feedback (#…) de cada respuesta.
  var inner = body.replace(/^\s*\{/, '').replace(/\}\s*$/, '');
  var out = [];
  var re = /(?<!\\)[=~]/g, m, marks = [];
  while ((m = re.exec(inner))) marks.push({ at: m.index, kind: m[0] });
  marks.forEach(function (mk, i) {
    var txt = inner.slice(mk.at + 1, i + 1 < marks.length ? marks[i + 1].at : inner.length);
    out.push({ correct: mk.kind === '=', text: txt.split('#')[0].trim() });
  });
  return out;
}
function dynExamNeuromythHits(giftText) {
  var hits = [];
  String(giftText || '').split(/(?=::[A-Za-z0-9_-]+::)/).forEach(function (block) {
    var idm = /^::([A-Za-z0-9_-]+)::/.exec(block);
    if (!idm) return;
    var brace = block.search(/(^|[^\\])\{/);
    if (brace > 0 && block.charAt(brace) !== '{') brace++;
    var stem = brace >= 0 ? block.slice(idm[0].length, brace) : block;
    var close = block.lastIndexOf('}');
    var body = brace >= 0 ? block.slice(brace, close >= brace ? close + 1 : block.length) : '';
    var asserted = [];
    if (/^\{\s*(?:TRUE|T|VERDADERO)\s*(?:#[^}]*)?\}$/i.test(body.trim())) asserted.push(stem);
    else _dynGiftAnswers(body).forEach(function (a) { if (a.correct) asserted.push(a.text); });
    var bad = asserted.some(function (t) { var ft = _dynFold(t); return DYN_NEUROMYTH_RE.test(ft) && !DYN_NEUROMYTH_DEBUNK_RE.test(ft); });
    if (bad) hits.push({ id: idm[1] });
  });
  return hits;
}
function _dynExamNeuromythError(gift) {
  var nm = dynExamNeuromythHits(gift);
  if (!nm.length) return null;
  return { ok: false, error: 'EXAM_NEUROMYTH: respuestas correctas apoyadas en un neuromito (' + nm.map(function (h) { return h.id; }).join(', ') + '); se regenera el examen', retryable: true };
}

async function _dynRunFinalExam(item) {
  var bp = item.blueprint || {};
  var courseContext = item.context.courseContext;
  var titles = [];
  (bp.outline || []).forEach(function (mo) { (mo.chapters || []).forEach(function (c) { if (c.kind !== 'practice') titles.push(c.title); }); });
  if (!titles.length) return { ok: false, error: 'final_exam: el outline del claim no tiene capítulos', retryable: false };
  var split = dynFinalExamQuestionSplit(titles.length);
  var expected = { multichoice: split.multichoice, truefalse: split.truefalse, match: split.match };
  var sys = sysG();
  var allChapters = [];
  (bp.outline || []).forEach(function (mo) { (mo.chapters || []).forEach(function (c) { if (c.kind !== 'practice') allChapters.push(c); }); });
  var finalChapters = _dynExamChapters(allChapters, await _dynLoadContextSummaries(item));
  var ped = dynPedagogyBlock(item); // Fase 2: estrategia de la evaluación final (solo v3 con perfil pedagógico)
  var raw = await _dynV3Llm(item, 'main', sys, dynFinalExamPrompt(courseContext, bp.outline, titles, ped) + dynExamContentBlock(finalChapters), 8192, null);
  var cl = String(raw || '').replace(/```gift|```/g, '').trim();
  cl = _trimExcessQuestions(cl, expected);
  function countByType(text) {
    var byType = { multichoice: 0, truefalse: 0, match: 0, shortanswer: 0 };
    parseGIFT(text).forEach(function (q) { if (byType[q.type] !== undefined) byType[q.type]++; });
    return byType;
  }
  var byType = countByType(cl);
  var faltantes = [];
  Object.keys(expected).forEach(function (t) {
    var missing = expected[t] - (byType[t] || 0);
    if (missing > 0) faltantes.push({ type: t, count: missing });
  });
  var retried = false;
  if (faltantes.length) {
    retried = true;
    var idNums = [];
    var idRe = /::EF-(\d+)::/g;
    var m;
    while ((m = idRe.exec(cl))) idNums.push(parseInt(m[1], 10));
    var nextIdNum = (idNums.length ? Math.max.apply(null, idNums) : 0) + 1;
    var raw2 = await _dynV3Llm(item, 'continuation', sys, dynFinalExamCorrectionPrompt(courseContext, bp.outline, faltantes, nextIdNum, ped) + dynExamContentBlock(finalChapters), 4096, null);
    cl = _trimExcessQuestions(cl + '\n\n' + String(raw2 || '').replace(/```gift|```/g, '').trim(), expected);
  }
  var finalByType = countByType(cl);
  var stillMissing = Object.keys(expected).filter(function (t) { return (finalByType[t] || 0) < expected[t]; });
  if (stillMissing.length) return { ok: false, error: 'GIFT del examen final incompleto tras corrección: faltan ' + stillMissing.join(', '), retryable: true };
  var bal = await _dynBalanceExamAnswers(courseContext, cl, function (p) { return _dynV3Llm(item, 'continuation', sys, p, 4096, null); });
  cl = bal.gift;
  var gift = giftFeedbackHeader() + cl;
  // Fix round 1 (review G5 M10): mismo gate que el servidor (validateExamGift,
  // R11a final-exam.ts) antes de subir: rango 5–40, ningún bloque con llaves
  // descartado por el parser, ninguna pregunta sin enunciado.
  var gv = dynValidateExamGift(gift);
  if (!gv.ok) return { ok: false, error: 'GIFT del examen final inválido: ' + _dynFormatErrors(gv.errors).join('; '), retryable: true };
  var nmErr = _dynExamNeuromythError(gift);
  if (nmErr) return nmErr;
  return {
    ok: true,
    artifacts: [{ type: 'dynamic_exam_gift', content: gift, filename: item.itemRunId + '_dynamic_exam_gift.gift', mimeType: 'text/plain' }],
    summary: Object.assign({ questionCount: gv.questionCount, plannedQuestionCount: split.total, byType: { multichoice: finalByType.multichoice, truefalse: finalByType.truefalse, match: finalByType.match }, retried: retried, contentGroundedChapters: finalChapters.filter(function (c) { return c.summary; }).length, answerBias: bal.stats, promptVersion: DYN_V3_PROMPT_VERSIONS.final_exam }, dynPedagogySummary(item))
  };
}

// ════════════════════════════════════════════════════════════════════════
// EV6 P2 (F2) — Modo banco de los exámenes: dynamic_exam_bank_json
// ════════════════════════════════════════════════════════════════════════
// exam:<módulo> y final_exam producen un banco JSON (contrato B2,
// orbia-backend src/modules/course-shell/exam-bank.ts) en vez de GIFT:
//   1. plan de slots (44: dynExamSlotPlan / dynFinalExamSlotPlan) == plan del claim;
//   2. una llamada por capítulo (módulo) / por módulo (final), partida en
//      ≤ 20 preguntas por llamada (dynExamBankChunkLeaves), concurrencia 3;
//      JSON inválido o max_tokens → UN reintento de esa llamada, si no el item
//      falla retryable;
//   3. por pregunta (puras, abajo): esquema → evidencia → lints de distractores
//      → neuromito → ¿hay combinación de 3 distractores elegible?;
//   4. hojas (2·slots mejores), balance V/F, duplicados, selección
//      determinística de 3 distractores (rango de longitud de la correcta
//      repartido 0..3 con semilla = itemKey);
//   5. UNA reparación por llamada (solo hojas por debajo de 2·slots), se
//      reensambla una vez; hoja < piso o regla de banco rota → EXAM_BANK_INCOMPLETE
//      retryable (nunca se sube un banco corto o sesgado);
//   6. compuerta final = port JS de validateExamBank (con evidencia).
// Modelo: el de siempre. Toda llamada pasa por _dynV3Llm (→ _dynLlmCall →
// api() → getModel()); nunca se pasa un modelo.
//
// INTERRUPTOR DE DESPLIEGUE: ENCENDIDO desde EV6 fase 2 (el backend ya empaqueta
// bancos — B3 — y publica «Respuestas explicadas» — B4 —, con validadores B5 y
// E2E B6). El banco se usa solo si además el claim trae claimPayload.examBank
// (backend B2); sin él, exam/final_exam siguen por la ruta GIFT de siempre.
// Ponerlo en false vuelve EXACTAMENTE a la ruta GIFT (kill switch por deploy).
var DYN_EXAM_BANK_MODE_ENABLED = true;
var DYN_EXAM_BANK_ARTIFACT_TYPE = 'dynamic_exam_bank_json';
var DYN_EXAM_BANK_CONCURRENCY = 3;

function _dynExamBankModeOn(item) {
  if (DYN_EXAM_BANK_MODE_ENABLED !== true) return false;
  if (!item || (item.type !== 'exam' && item.type !== 'final_exam')) return false;
  var eb = item.claimPayload && item.claimPayload.examBank;
  return !!(_dynIsPlainObject(eb) && eb.artifactType === DYN_EXAM_BANK_ARTIFACT_TYPE && eb.bankVersion === 1);
}

// ── Espejo byte a byte del contrato B2 ──
var DYN_EXAM_BANK_TYPES_F2 = ['multichoice', 'truefalse', 'match'];
var DYN_EXAM_LEVELS = ['recordar', 'comprender', 'aplicar', 'analizar'];
var DYN_EXAM_BANK_LIMITS = {
  stem: [20, 600], explanation: [60, 700], evidence: [40, 220], optionText: [1, 200], optionWhy: [20, 400],
  whyWrong: [20, 400], term: [1, 60], definition: [1, 200], pairs: [4, 6], distractors: 3
};
var DYN_EXAM_BANK_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
// normalizeExamText (B2 fix round 1): mismo orden, mismas clases.
function dynNormalizeExamText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[­​-‍⁠﻿]/g, '')
    .replace(/^[ \t>]*(?:[-+*•‣◦▪]|\d{1,3}[.)])[ \t]+/gm, '')
    .replace(/[*_#>`[\]()|]/g, '')
    .replace(/[«»“”„‟″]/g, '"')
    .replace(/[‘’‚‛′‹›]/g, "'")
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}
var DYN_EXAM_TOKEN_RE = /\p{N}+(?:[.,]\p{N}+)*|\p{L}+/gu;
function dynExamTokens(normalized) { return String(normalized).match(DYN_EXAM_TOKEN_RE) || []; }
// examTextContains: secuencia contigua de tokens (palabras completas).
function dynExamTextContains(outer, inner) {
  var o = dynExamTokens(dynNormalizeExamText(outer));
  var i = dynExamTokens(dynNormalizeExamText(inner));
  if (i.length === 0 || i.length > o.length) return false;
  for (var k = 0; k + i.length <= o.length; k++) {
    var ok = true;
    for (var j = 0; j < i.length; j++) { if (o[k + j] !== i[j]) { ok = false; break; } }
    if (ok) return true;
  }
  return false;
}
// EXAM_OPTION_FORBIDDEN_RE (B2 fix round 2): anclada, sobre el texto normalizado, sin flags.
var DYN_EXAM_OPTION_FORBIDDEN_RE =
  /^(?:(?:todas|ninguna|ambas) (?:de )?(?:las |los )?(?:otras |otros |demas )?(?:anteriores|opciones|respuestas|alternativas|demas)(?: anteriores)?(?: (?:son|es) (?:correctas?|incorrectas?|validas?))?|(?:todas|ambas|ninguna) (?:son|es) (?:correctas?|incorrectas?|validas?)|[a-e] y [a-e] (?:son )?correctas?)[.!]?$/;
// #583 (I3): piso por hoja = 2·slots (= objetivo; espejo de bankFloorFor(s, 4) del backend). Con el piso de 1,5·s
// las hojas de selección múltiple quedaban en 8 preguntas para 5 slots y dos intentos seguidos del módulo compartían
// 6 de 17 preguntas. La holgura del pedido (dynExamBankAskCount) sigue encima: solo lo que falta se repara.
function dynExamBankFloorF2(slots) { return 2 * slots; }

// ── Lints propios del ejecutor (F2) ──
function _dynEbLen(s) { return String(s == null ? '' : s).trim().length; }
// HTML, negrita **x** o __x__. Un espacio para completar («El ____ se mide…») es texto válido.
var _DYN_EB_NOT_PLAIN_RE = /<\/?[a-zA-Z][^<>]*>|\*\*[^*\s][^*]*\*\*|__[^_\s][^_]*__/;
var _DYN_EB_HTML_RE = /<\/?[a-zA-Z][^<>]*>/;
// B3 fix 1 (espejo byte a byte de EXAM_BANK_CONTROL_RE / EXAM_MATCH_TERM_FORBIDDEN_RE en exam-bank.ts):
// caracteres de control C0 (salvo \t y \n) y DEL — inválidos en XML 1.0 — en CUALQUIER texto del banco;
// < o > en el término de un par de emparejamiento (Moodle los borra al pasar por strip_tags en el desplegable).
var DYN_EXAM_BANK_CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;
var DYN_EXAM_MATCH_TERM_FORBIDDEN_RE = /[<>]/;
// Palabras de contenido: ≥ 5 letras y no vacías de significado (normalizadas, sin tildes).
var DYN_EXAM_STOPWORDS = {};
('sobre entre desde hasta hacia porque aunque cuando donde mientras tambien siempre nunca todos todas ninguno ninguna '
  + 'puede pueden podria podrian debe deben deberia deberian estos estas otros otras cuales cualquier cualquiera segun durante '
  + 'antes despues mismo misma mismos mismas tiene tienen tener hacer hacen parte forma manera mayor menor menos ademas '
  + 'contra nuestro nuestra nuestros nuestras aquel aquella aquello aquellos aquellas estar estan estaba fueron siendo haber '
  + 'habia hemos tienes puedes debes algun alguna alguno algunos algunas varios varias mucho mucha muchos muchas pocos pocas '
  + 'tanto tanta tantos tantas cuanto quien quienes dentro fuera luego entonces primero primera segundo segunda tercero tercera '
  + 'ultimo ultima correcta correcto incorrecta incorrecto verdadero verdadera falso falsa opcion opciones respuesta pregunta '
  + 'siguiente siguientes anterior anteriores ejemplo realizar utilizar permite permiten mediante traves sobre cierto cierta '
  + 'solamente unicamente mejor peor bastante demasiado ningun otra otro esto estos dicho dicha cosas tipos')
  .split(' ').forEach(function (w) { if (w) DYN_EXAM_STOPWORDS[w] = true; });
// Cantidad con unidad → clase de unidad. Sobre el texto CRUDO (A ≠ a, N ≠ n).
var DYN_EXAM_UNIT_CLASS = {
  '%': 'pct', '°C': 'temp', '°F': 'temp', 'bar': 'pressure', 'psi': 'pressure', 'kPa': 'pressure', 'MPa': 'pressure',
  'l/min': 'flow', 'L/min': 'flow', 'gpm': 'flow', 'rpm': 'rotation', 'm': 'length', 'cm': 'length', 'mm': 'length',
  'kg': 'mass', 'g': 'mass', 'N': 'force', 'Nm': 'torque', 'V': 'voltage', 'A': 'current', 'W': 'power', 'kW': 'power',
  'h': 'time', 'min': 'time', 's': 'time'
};
var DYN_EXAM_QTY_RE = /(?:^|[^\p{L}\p{N}])\d+(?:[.,]\d+)*\s?([°º]\s?[CF]|[lL]\/min|kPa|MPa|gpm|rpm|psi|bar|min|kW|Nm|kg|cm|mm|%|m|g|N|V|A|W|h|s)(?![\p{L}\p{N}])/gu;
var DYN_EXAM_MONEY_RE = /(?:US\$|R\$|S\/|[$€£¥₡₲₱])\s?\d|\d\s?(?:€|USD|COP|EUR|MXN|PEN|CLP|ARS)(?![\p{L}])/u;
function dynExamUnitClasses(text) {
  var s = String(text == null ? '' : text);
  var out = {};
  var m;
  DYN_EXAM_QTY_RE.lastIndex = 0;
  while ((m = DYN_EXAM_QTY_RE.exec(s))) {
    var u = m[1].replace(/\s/g, '').replace('º', '°');
    if (DYN_EXAM_UNIT_CLASS[u]) out[DYN_EXAM_UNIT_CLASS[u]] = true;
    DYN_EXAM_QTY_RE.lastIndex = m.index + m[0].length;
  }
  if (DYN_EXAM_MONEY_RE.test(s)) out.money = true;
  return Object.keys(out).sort();
}
// Desajuste: una opción con cantidad+unidad y la otra sin, o clases disjuntas.
function _dynEbUnitMismatch(correctClasses, d) {
  var dc = dynExamUnitClasses(d);
  if (!correctClasses.length && !dc.length) return false;
  if (!correctClasses.length || !dc.length) return true;
  return !dc.some(function (c) { return correctClasses.indexOf(c) >= 0; });
}
// Misma lista que el prompt (44: DYN_EXAM_ABSOLUTE_WORDS_LIST), normalizada.
// Se arma al primer uso (44 se carga antes que 45 en la página; algunos harnesses cargan 45 solo).
var _dynEbAbsoluteWords = null;
function _dynEbHasAbsolute(text) {
  if (!_dynEbAbsoluteWords) {
    _dynEbAbsoluteWords = {};
    DYN_EXAM_ABSOLUTE_WORDS_LIST.forEach(function (w) { _dynEbAbsoluteWords[dynNormalizeExamText(w)] = 1; });
  }
  return dynExamTokens(dynNormalizeExamText(text)).some(function (t) { return _dynEbAbsoluteWords[t] === 1; });
}
function _dynEbNeuromyth(text) {
  var ft = _dynFold(text);
  return DYN_NEUROMYTH_RE.test(ft) && !DYN_NEUROMYTH_DEBUNK_RE.test(ft);
}

// ── Selección determinística de 3 distractores ──
// Todas las combinaciones de 3 sobrevivientes (orden lexicográfico del índice
// original). rank = distractores elegidos ESTRICTAMENTE más cortos que la correcta
// (empate → la correcta queda más abajo); spread = max − min de las 4 longitudes.
// No elegible: outlier de B2 (correcta ≥ 8 caracteres y ≥ 15 % más larga que el
// distractor más largo) o pista de palabra absoluta (≥ 2 distractores con
// siempre/nunca/todos/ninguno/jamás y la correcta sin ninguna).
function dynExamDistractorCombos(correctText, distractors, survivors) {
  var c = _dynEbLen(correctText);
  var cAbs = _dynEbHasAbsolute(correctText);
  var s = (survivors || []).slice().sort(function (a, b) { return a - b; });
  var out = [];
  for (var a = 0; a < s.length; a++) {
    for (var b = a + 1; b < s.length; b++) {
      for (var d = b + 1; d < s.length; d++) {
        var idx = [s[a], s[b], s[d]];
        var lens = idx.map(function (i) { return _dynEbLen(distractors[i].text); });
        var L = Math.max.apply(null, lens);
        var rank = lens.filter(function (l) { return l < c; }).length;
        var spread = Math.max(c, L) - Math.min(c, Math.min.apply(null, lens));
        var outlier = c - L >= 8 && 100 * (c - L) >= 15 * L;
        var absCue = !cAbs && idx.filter(function (i) { return _dynEbHasAbsolute(distractors[i].text); }).length >= 2;
        out.push({ idx: idx, rank: rank, spread: spread, outlier: outlier, absCue: absCue, ok: !outlier && !absCue });
      }
    }
  }
  return out;
}
// Rango objetivo t; si no hay, el más cercano ≤ t (t−1 … 0) y luego > t (t+1 … 3).
// Entre las elegibles del rango: menor spread; empate → orden lexicográfico.
function dynExamPickCombo(combos, t) {
  var order = [t];
  var r;
  for (r = t - 1; r >= 0; r--) order.push(r);
  for (r = t + 1; r <= 3; r++) order.push(r);
  for (var k = 0; k < order.length; k++) {
    var best = null;
    for (var i = 0; i < combos.length; i++) {
      var cb = combos[i];
      if (cb.ok && cb.rank === order[k] && (!best || cb.spread < best.spread)) best = cb;
    }
    if (best) return best;
  }
  return null;
}
function _dynMulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Orden sembrado de las MC: ids ordenados y barajados (Fisher-Yates, mulberry32 de FNV-1a(seed)).
function dynExamBankSeededOrder(mcIds, seed) {
  var ids = (mcIds || []).slice().sort();
  var rng = _dynMulberry32(dynFnv1a32(String(seed)));
  for (var i = ids.length - 1; i > 0; i--) {
    var j = Math.floor(rng() * (i + 1));
    var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
  }
  return ids;
}
// Rango sembrado t = posición mod 4 (desempate de la selección voraz).
function dynExamBankTargetRanks(mcIds, seed) {
  var out = {};
  dynExamBankSeededOrder(mcIds, seed).forEach(function (id, k) { out[id] = k % 4; });
  return out;
}
// Fix 1 (I4) — balance voraz de rangos: en el orden sembrado, cada MC toma el rango
// ALCANZABLE (con alguna combinación elegible) menos usado hasta ahora; empate → el
// más cercano al t sembrado, luego el menor. «Correcta = más larga» (rango 3) se
// limita al 20 % de las procesadas, salvo que sea el único rango alcanzable.
// items: [{ id, combos }] → { [id]: combo }, histogram.
var DYN_EXAM_LONGEST_CAP = 0.2;
function dynExamBankBalanceRanks(items, seed) {
  var byId = {};
  (items || []).forEach(function (it) { byId[it.id] = it; });
  var order = dynExamBankSeededOrder(Object.keys(byId), seed);
  var counts = [0, 0, 0, 0];
  var chosen = {};
  order.forEach(function (id, i) {
    var t = i % 4;
    var combos = byId[id].combos;
    var reach = [0, 1, 2, 3].filter(function (r) { return combos.some(function (c) { return c.ok && c.rank === r; }); });
    var allowed = reach;
    if (reach.length > 1 && reach.indexOf(3) >= 0 && (counts[3] + 1) > DYN_EXAM_LONGEST_CAP * (i + 1)) allowed = reach.filter(function (r) { return r !== 3; });
    var best = allowed[0];
    allowed.forEach(function (r) {
      if (counts[r] < counts[best] || (counts[r] === counts[best] && Math.abs(r - t) < Math.abs(best - t))) best = r;
    });
    chosen[id] = dynExamPickCombo(combos, best);
    counts[best]++;
  });
  return { chosen: chosen, histogram: counts };
}
function _dynEbReachOnlyLongest(combos) {
  var ok = (combos || []).filter(function (c) { return c.ok; });
  return ok.length > 0 && ok.every(function (c) { return c.rank === 3; });
}
// Casi duplicados: Jaccard de los tokens (≥ 3 letras o números) del enunciado normalizado.
var DYN_EXAM_NEAR_DUP_JACCARD = 0.8;
function _dynEbStemTokens(stem) {
  var set = {};
  dynExamTokens(dynNormalizeExamText(stem)).forEach(function (t) { if (t.length >= 3 || /\p{N}/u.test(t)) set[t] = true; });
  return set;
}
function dynExamStemSimilarity(a, b) {
  var A = _dynEbStemTokens(a);
  var B = _dynEbStemTokens(b);
  var inter = 0;
  var union = 0;
  Object.keys(A).forEach(function (t) { union++; if (B[t]) inter++; });
  Object.keys(B).forEach(function (t) { if (!A[t]) union++; });
  return union ? inter / union : 0;
}

// #542 (I3): el Jaccard ≥ 0,8 del enunciado no veía casi duplicados reales del #542 («el cliente sube el
// tono» ×2, la misma afirmación V/F en el módulo y en el final). Métrica adicional para MC/V/F: el máximo
// entre el Jaccard del enunciado y (si los enunciados ya se parecen, Jaccard ≥ 0,3) el Jaccard de
// enunciado + respuesta correcta, sobre tokens de contenido (≥ 4 letras, sin stopwords) SIN las palabras del
// dominio que están en > 25 % de las preguntas del conjunto («tienda», «cliente», «reclamo»…).
// Fix round 1 (m5): sin la rama de solapamiento (marcaba pares de CONTRASTE legítimos: garantía nuevo vs
// usado, con vs sin factura, retracto en internet vs tienda física). Umbral 0,55: los 5 pares de contraste
// de la revisión quedan ≤ 0,50 (cero falsos rechazos) y atrapa 6/9 pares de la auditoría #542; se prefiere
// dejar pasar un casi duplicado a rechazar una pregunta válida.
var DYN_EXAM_NEAR_DUP_SCORE = 0.55;
var DYN_EXAM_NEAR_DUP_FREQ_SHARE = 0.25;
var DYN_EXAM_NEAR_DUP_MIN_POOL = 8;
var DYN_EXAM_NEAR_DUP_ANSWER_GATE = 0.3;
var DYN_EXAM_NEAR_DUP_MIN_TOKENS = 4;
function _dynEbDupTokens(s) {
  var o = {};
  dynExamTokens(dynNormalizeExamText(s)).forEach(function (t) { if ((t.length >= 4 || /\p{N}/u.test(t)) && !DYN_EXAM_STOPWORDS[t]) o[t] = true; });
  return o;
}
// entries: [{ stem, answer }] → { sigs, freq } (palabras frecuentes del conjunto, ignoradas en la métrica).
function dynExamDupIndex(entries) {
  var sigs = (entries || []).map(function (e) { return { s: _dynEbDupTokens(e.stem), a: _dynEbDupTokens(e.answer || '') }; });
  var df = {};
  sigs.forEach(function (g) { Object.keys(Object.assign({}, g.s, g.a)).forEach(function (t) { df[t] = (df[t] || 0) + 1; }); });
  var freq = {};
  Object.keys(df).forEach(function (t) { if (df[t] > DYN_EXAM_NEAR_DUP_FREQ_SHARE * sigs.length) freq[t] = true; });
  // Con pocas preguntas no se sabe qué palabras son «del dominio»: la métrica nueva no se aplica (queda el Jaccard ≥ 0,8).
  return { sigs: sigs, freq: freq, enabled: sigs.length >= DYN_EXAM_NEAR_DUP_MIN_POOL };
}
function dynExamNearDupScore(A, B, freq) {
  function keep(o) { var r = {}; Object.keys(o).forEach(function (t) { if (!freq[t]) r[t] = true; }); return r; }
  function ov(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b), i = 0;
    ka.forEach(function (t) { if (b[t]) i++; });
    var u = ka.length + kb.length - i;
    var m = Math.min(ka.length, kb.length);
    return { j: u ? i / u : 0, o: m ? i / m : 0 };
  }
  var as = keep(A.s), bs = keep(B.s);
  var s = ov(as, bs);
  // Muy pocas palabras propias: el solapamiento no dice nada.
  if (Math.min(Object.keys(as).length, Object.keys(bs).length) < DYN_EXAM_NEAR_DUP_MIN_TOKENS) return s.j;
  var c = ov(Object.assign({}, as, keep(A.a)), Object.assign({}, bs, keep(B.a)));
  // La respuesta solo suma cuando los enunciados ya se parecen (dos situaciones distintas pueden tener
  // la misma respuesta correcta, p. ej. «escalar al jefe»).
  return Math.max(s.j, s.j >= DYN_EXAM_NEAR_DUP_ANSWER_GATE ? c.j : 0);
}
function _dynEbAnswerText(q) { return q && q.type === 'multichoice' && q.correct ? q.correct.text : ''; }

// ── Chequeo por pregunta (pasos a–d + elegibilidad de e) ──
// expect = { id, type, scope, chapterIds: [...], moduleId }; chapterInfo(chId) →
// { norm, tokens } (Markdown normalizado del capítulo) | null.
// → { ok:true, q, survivors, combos, dropped } | { ok:false, code, message, dropped }.
function _dynEbReject(code, message, dropped) { return { ok: false, code: code, message: message, dropped: dropped || [] }; }
// allowMd: la evidencia puede traer los símbolos de Markdown del capítulo (la normalización los quita).
function _dynEbTextErr(v, lim, name, allowMd) {
  if (typeof v !== 'string') return name + ' debe ser texto';
  var n = _dynEbLen(v);
  if (n < lim[0] || n > lim[1]) return name + ': longitud ' + n + ' fuera de ' + lim[0] + '–' + lim[1];
  if (DYN_EXAM_BANK_CONTROL_RE.test(v)) return name + ': caracteres de control no permitidos (solo \t y \n)';
  if ((allowMd ? _DYN_EB_HTML_RE : _DYN_EB_NOT_PLAIN_RE).test(v)) return name + ': texto con HTML o Markdown';
  return null;
}
function dynExamBankCheckQuestion(raw, expect, chapterInfo) {
  var L = DYN_EXAM_BANK_LIMITS;
  var type = expect.type;
  if (!_dynIsPlainObject(raw)) return _dynEbReject('EXAM_BANK_SCHEMA', 'la pregunta no es un objeto');
  var keys = ['id', 'type', 'chapterId', 'level', 'stem', 'explanation', 'evidence']
    .concat(type === 'multichoice' ? ['correct', 'distractors'] : type === 'truefalse' ? ['answer', 'whyWrong'] : ['pairs']);
  var missing = keys.filter(function (k) { return !(k in raw); });
  if (missing.length) return _dynEbReject('MISSING_FIELD', 'faltan los campos ' + missing.join(', '));
  // (a) esquema que ve el LLM (5 distractores)
  if (raw.id !== expect.id) return _dynEbReject('EXAM_BANK_SCHEMA', 'id distinto del pedido ("' + expect.id + '")');
  if (raw.type !== type) return _dynEbReject('EXAM_BANK_SCHEMA', 'type debe ser "' + type + '"');
  if (typeof raw.chapterId !== 'string' || (expect.chapterIds || []).indexOf(raw.chapterId) < 0) {
    return _dynEbReject('EXAM_BANK_SCHEMA', 'chapterId debe ser ' + (expect.chapterIds || []).map(function (x) { return '"' + x + '"'; }).join(' o '));
  }
  if (DYN_EXAM_LEVELS.indexOf(raw.level) < 0) return _dynEbReject('EXAM_BANK_SCHEMA', 'level debe ser ' + DYN_EXAM_LEVELS.join('|'));
  var e = _dynEbTextErr(raw.stem, L.stem, 'stem') || _dynEbTextErr(raw.explanation, L.explanation, 'explanation') || _dynEbTextErr(raw.evidence, L.evidence, 'evidence', true);
  if (e) return _dynEbReject('EXAM_BANK_SCHEMA', e);
  var q = { id: raw.id, type: type, chapterId: raw.chapterId, level: raw.level, stem: raw.stem.trim(), explanation: raw.explanation.trim(), evidence: raw.evidence.trim() };
  if (expect.scope === 'final') q.moduleId = expect.moduleId; // dato estructural: lo pone Cursia
  var dropped = [];
  var survivors = null;
  var anchor;
  if (type === 'multichoice') {
    if (!_dynIsPlainObject(raw.correct)) return _dynEbReject('EXAM_BANK_SCHEMA', 'correct debe ser {text, why}');
    e = _dynEbTextErr(raw.correct.text, L.optionText, 'correct.text') || _dynEbTextErr(raw.correct.why, L.optionWhy, 'correct.why');
    if (e) return _dynEbReject('EXAM_BANK_SCHEMA', e);
    if (!Array.isArray(raw.distractors) || raw.distractors.length !== 5 || !raw.distractors.every(function (d) { return _dynIsPlainObject(d) && typeof d.text === 'string' && typeof d.why === 'string'; })) {
      return _dynEbReject('EXAM_BANK_SCHEMA', 'distractors debe tener EXACTAMENTE 5 objetos {text, why}');
    }
    var correct = { text: raw.correct.text.trim(), why: raw.correct.why.trim() };
    if (DYN_EXAM_OPTION_FORBIDDEN_RE.test(dynNormalizeExamText(correct.text))) return _dynEbReject('EXAM_BANK_OPTION_LINT', 'la correcta es del tipo «todas/ninguna de las anteriores»');
    var ds = raw.distractors.map(function (d) { return { text: d.text.trim(), why: d.why.trim() }; });
    var cLen = _dynEbLen(correct.text);
    var cNorm = dynNormalizeExamText(correct.text);
    var cUnits = dynExamUnitClasses(correct.text);
    survivors = [];
    // (c) lints de distractor: se descarta el distractor, no la pregunta
    ds.forEach(function (d, i) {
      var code = null;
      var dn = dynNormalizeExamText(d.text);
      var dl = _dynEbLen(d.text);
      if (_dynEbTextErr(d.text, L.optionText, 'text')) code = 'EXAM_BANK_SCHEMA';
      else if (!d.why) code = 'EXAM_BANK_EMPTY_WHY';
      else if (_dynEbTextErr(d.why, L.optionWhy, 'why')) code = 'EXAM_BANK_SCHEMA';
      else if (DYN_EXAM_OPTION_FORBIDDEN_RE.test(dn)) code = 'EXAM_BANK_OPTION_LINT';
      else if (!dn || dn === cNorm || dynExamTextContains(correct.text, d.text) || dynExamTextContains(d.text, correct.text)) code = 'EXAM_BANK_OPTION_LINT';
      else if (survivors.some(function (j) { var on = dynNormalizeExamText(ds[j].text); return on === dn || dynExamTextContains(ds[j].text, d.text) || dynExamTextContains(d.text, ds[j].text); })) code = 'EXAM_BANK_OPTION_LINT';
      else if (2 * dl < cLen || 10 * dl > 17 * cLen) code = 'EXAM_BANK_LENGTH_RANGE';
      else if (_dynEbUnitMismatch(cUnits, d.text)) code = 'EXAM_BANK_UNIT_CLASS';
      if (code) dropped.push({ index: i, code: code });
      else survivors.push(i);
    });
    if (survivors.length < 3) return _dynEbReject('EXAM_BANK_DISTRACTORS', 'solo ' + survivors.length + ' distractores válidos (' + dropped.map(function (d) { return d.code; }).join(', ') + ')', dropped);
    q.correct = correct;
    q.distractors5 = ds;
    anchor = correct.text;
  } else if (type === 'truefalse') {
    if (typeof raw.answer !== 'boolean') return _dynEbReject('EXAM_BANK_SCHEMA', 'answer debe ser true o false');
    e = _dynEbTextErr(raw.whyWrong, L.whyWrong, 'whyWrong');
    if (e) return _dynEbReject('EXAM_BANK_SCHEMA', e);
    q.answer = raw.answer;
    q.whyWrong = raw.whyWrong.trim();
    anchor = q.stem;
  } else {
    if (!Array.isArray(raw.pairs) || raw.pairs.length < L.pairs[0] || raw.pairs.length > L.pairs[1]) return _dynEbReject('EXAM_BANK_SCHEMA', 'pairs debe tener ' + L.pairs[0] + '–' + L.pairs[1] + ' pares');
    for (var p = 0; p < raw.pairs.length; p++) {
      var pr = raw.pairs[p];
      if (!_dynIsPlainObject(pr)) return _dynEbReject('EXAM_BANK_SCHEMA', 'cada par debe ser {term, definition}');
      e = _dynEbTextErr(pr.term, L.term, 'term') || _dynEbTextErr(pr.definition, L.definition, 'definition');
      if (e) return _dynEbReject('EXAM_BANK_SCHEMA', 'par ' + (p + 1) + ': ' + e);
    }
    q.pairs = raw.pairs.map(function (x) { return { term: x.term.trim(), definition: x.definition.trim() }; });
    var terms = q.pairs.map(function (x) { return dynNormalizeExamText(x.term); });
    var defs = q.pairs.map(function (x) { return dynNormalizeExamText(x.definition); });
    if (terms.some(function (t, i) { return terms.indexOf(t) !== i; })) return _dynEbReject('EXAM_BANK_MATCH', 'términos repetidos');
    if (defs.some(function (t, i) { return defs.indexOf(t) !== i; })) return _dynEbReject('EXAM_BANK_MATCH', 'definiciones repetidas');
    if (q.pairs.some(function (x) { return dynExamTextContains(x.definition, x.term); })) return _dynEbReject('EXAM_BANK_MATCH', 'una definición contiene su propio término');
    if (raw.pairs.some(function (x) { return typeof x.term === 'string' && DYN_EXAM_MATCH_TERM_FORBIDDEN_RE.test(x.term); })) return _dynEbReject('EXAM_BANK_MATCH', 'el término no puede llevar < ni > (Moodle los borra en el desplegable)');
    anchor = q.pairs[0].term + ' ' + q.pairs[0].definition;
  }
  // (b) evidencia en el texto de SU capítulo + palabra de contenido
  var info = chapterInfo ? chapterInfo(q.chapterId) : null;
  if (!info) return _dynEbReject('EXAM_BANK_EVIDENCE', 'no hay texto del capítulo ' + q.chapterId, dropped);
  var ev = dynNormalizeExamText(q.evidence);
  var relocated = null;
  // Fix round 3: con el texto crudo del capítulo, la evidencia además debe estar AFIRMADA por su oración
  // (sin negación antes ni excepción/condición después). Sin texto crudo (chapterInfo antiguo): solo textual.
  var support = typeof info.md === 'string' ? dynExamEvidenceSupport(_dynEbEvidenceIndexOf(info), q.evidence) : { ok: !!ev && info.norm.indexOf(ev) >= 0, reason: 'missing' };
  if (!support.ok && support.reason !== 'missing') {
    return _dynEbReject('EXAM_BANK_EVIDENCE', support.reason === 'negated'
      ? 'la oración del capítulo NIEGA o desmiente ese fragmento: cita la oración COMPLETA o una que lo afirme'
      : support.reason === 'question'
        ? 'la oración del capítulo es una PREGUNTA, no una afirmación: cita una oración que afirme lo que preguntas'
        : 'la oración del capítulo CONDICIONA o exceptúa ese fragmento (si/excepto/salvo/cuando/pero/aunque…): cita la oración COMPLETA o una que lo afirme sin condición', dropped);
  }
  if (!support.ok) {
    // BANKOPT (opción 1b): deriva de forma → se reemplaza por el texto REAL de la oración/viñeta del capítulo.
    relocated = dynExamBankRelocateEvidence(q.evidence, info);
    if (!relocated) return _dynEbReject('EXAM_BANK_EVIDENCE', 'la evidencia no es una copia textual de un fragmento del capítulo', dropped);
    q.evidence = relocated.text;
    ev = dynNormalizeExamText(q.evidence);
  }
  var evTokens = {};
  dynExamTokens(ev).forEach(function (t) { evTokens[t] = true; });
  var at = dynExamTokens(dynNormalizeExamText(anchor));
  var words = at.filter(function (t) { return /^\p{L}+$/u.test(t) && t.length >= 5 && !DYN_EXAM_STOPWORDS[t]; });
  var cands = words.length ? words : at.filter(function (t) { return /\p{N}/u.test(t); });
  if (cands.length && !cands.some(function (t) { return evTokens[t] || info.tokens[t]; })) {
    return _dynEbReject('EXAM_BANK_CONTENT_WORD', 'la respuesta no usa ninguna palabra del texto del capítulo', dropped);
  }
  // (d) neuromito en lo que la pregunta afirma como cierto
  var asserted = type === 'multichoice' ? [q.correct.text] : type === 'truefalse' ? (q.answer ? [q.stem] : []) : q.pairs.map(function (x) { return x.term + ' ' + x.definition; });
  if (asserted.some(_dynEbNeuromyth)) return _dynEbReject('EXAM_NEUROMYTH', 'la respuesta correcta se apoya en un neuromito', dropped);
  // (e) ¿existe al menos una combinación elegible de 3 distractores?
  var combos = null;
  if (type === 'multichoice') {
    combos = dynExamDistractorCombos(q.correct.text, q.distractors5, survivors);
    if (!combos.some(function (cb) { return cb.ok; })) {
      var allOutlier = combos.every(function (cb) { return cb.outlier; });
      return _dynEbReject(allOutlier ? 'EXAM_BANK_LENGTH_BIAS' : 'EXAM_BANK_ABSOLUTE_CUE',
        allOutlier ? 'la correcta es mucho más larga que todos los distractores (≥ 8 caracteres y ≥ 15 %): escribe al menos 2 distractores MÁS LARGOS que la correcta' : 'las palabras absolutas (siempre, nunca, todos…) solo aparecen en los distractores', dropped);
    }
  }
  return { ok: true, q: q, survivors: survivors, combos: combos, dropped: dropped, evidenceRelocated: !!relocated };
}

// ── Guardia de oración, reglas v3 (espejo de examEvidenceSupport rules 3, B2; fix bank-guard-minors) ──
// Rechazo si la oración del fragmento: es una pregunta (? ¿ fuera de citas, o el tramo está DENTRO de una
// pregunta citada) → 'question'; lo niega antes («No…», «Nunca…», «ni», «sin», «nadie»…) o lo desmiente
// alrededor («es falso que», «no es cierto», «es un mito», «es mentira») → 'negated'; lo condiciona o exceptúa
// antes («Si…», «Excepto…», «Salvo…», «Solo con…», «A menos que…», «Siempre y cuando…», «Hasta que…») o después
// («excepto», «salvo», «si», «cuando», «mientras», «sino», «pero», «aunque», «solo si», «siempre que»…)
// → 'conditioned'. Mitigaciones: límite de oración con comillas de cierre; el corte en «:»/«;» solo neutraliza una
// negación de cópula («No es X: es Y», «No se trata de X; …», y «no es / no se trata de … sino [frag]»);
// condiciones y desmentidos se buscan en TODO el prefijo; «si» interrogativo con un verbo de averiguar como
// palabra completa entre los 3 tokens anteriores y sin «y/o» en medio; «sí» con tilde nunca es condición;
// «sin embargo», «no obstante» y «no solo… sino también» no niegan. Normalización de la evidencia v3: solo se
// quitan las tildes de las letras («≠ ≮ ≯ ≤ ≥…» se conservan) y «>» solo como marca de cita al inicio de línea.
var DYN_EXAM_EVIDENCE_PREFIX_NEGATIONS = ['no', 'nunca', 'jamas', 'ni', 'sin', 'tampoco', 'nadie', 'nada', 'ninguno', 'ninguna', 'ningun', 'ningunos', 'ningunas'];
var DYN_EXAM_EVIDENCE_FALSITY_PHRASES = ['es falso', 'no es cierto', 'no es verdad', 'es un mito', 'es mentira'];
var DYN_EXAM_EVIDENCE_PREFIX_CONDITIONS = ['si', 'excepto', 'salvo'];
var DYN_EXAM_EVIDENCE_PREFIX_CONDITION_PAIRS = ['a menos', 'solo con', 'solamente con', 'unicamente con', 'solo si', 'solo cuando', 'siempre que', 'en caso', 'con tal', 'siempre y', 'hasta que'];
var DYN_EXAM_EVIDENCE_SUFFIX_CONDITIONS = ['excepto', 'salvo', 'si', 'cuando', 'mientras', 'sino', 'pero', 'aunque'];
var DYN_EXAM_EVIDENCE_SUFFIX_CONDITION_PAIRS = ['a menos', 'siempre que', 'siempre y', 'solo si', 'solo cuando', 'solamente si', 'solamente cuando', 'unicamente si', 'unicamente cuando', 'hasta que', 'con tal', 'en caso', 'a no'];
var DYN_EXAM_EVIDENCE_WHETHER_WORDS = [
  'verifica', 'verificar', 'verifique', 'verifiquen', 'verifican', 'verificas', 'verificamos', 'verificando', 'verificate',
  'revisa', 'revisar', 'revise', 'revisen', 'revisan', 'revisas', 'revisamos', 'revisando',
  'comprueba', 'comprobar', 'compruebe', 'comprueben', 'comprueban', 'compruebas', 'comprobamos', 'comprobando',
  'detecta', 'detectar', 'detecte', 'detecten', 'detectan', 'detectas', 'detectamos', 'detectando',
  'observa', 'observar', 'observe', 'observen', 'observan', 'observas', 'observamos', 'observando',
  'pregunta', 'preguntar', 'pregunte', 'pregunten', 'preguntan', 'preguntas', 'preguntamos', 'preguntando', 'preguntale', 'preguntate', 'preguntales',
  'sabe', 'saber', 'sabes', 'saben', 'sabemos', 'sepa', 'sepan', 'sabiendo',
  'decide', 'decidir', 'decida', 'decidan', 'deciden', 'decides', 'decidimos', 'decidiendo',
  'averigua', 'averiguar', 'averigue', 'averiguan', 'averiguando', 'evalua', 'evaluar', 'evalue', 'evaluan', 'evaluando',
  'determina', 'determinar', 'determine', 'determinan', 'define', 'definir', 'defina', 'definen', 'confirma', 'confirmar', 'confirme', 'confirman'
];
var _DYN_EXAM_COORDINATORS = ['y', 'o', 'e', 'u'];
var _DYN_EXAM_COPULAS = ['es', 'son', 'era', 'eran', 'fue', 'fueron', 'sera', 'seran', 'esta', 'estan'];
var _DYN_EXAM_SI_ACCENT_RE = /(^|[^\p{L}\p{N}])([sS])[\u00ed\u00cd](?![\p{L}\p{N}])/gu;
function dynNormalizeExamEvidenceText(s) {
  return String(s == null ? '' : s)
    .normalize('NFC')
    .replace(/\p{L}\p{M}*/gu, function (m) { return m.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); })
    .toLowerCase()
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/^[ \t]*>[ \t>]*/gm, '')
    .replace(/^[ \t]*(?:[-+*\u2022\u2023\u25e6\u25aa]|\d{1,3}[.)])[ \t]+/gm, '')
    .replace(/[*_#`[\]()|]/g, '')
    .replace(/[\u00ab\u00bb\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2039\u203a]/g, "'")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}
function dynExamGuardNormalize(s) {
  // NFC antes de marcar «sí» (una «í» descompuesta, i + U+0301, también es «sí»).
  return dynNormalizeExamEvidenceText(String(s == null ? '' : s).normalize('NFC').replace(_DYN_EXAM_SI_ACCENT_RE, '$1$2itilde'));
}
// Desmentido («es falso», «es un mito»…) que no esté negado («no es un mito: [frag]» afirma).
function _dynExamHasFalsity(tokens) {
  var s = ' ' + tokens.join(' ') + ' ';
  return DYN_EXAM_EVIDENCE_FALSITY_PHRASES.some(function (p) {
    for (var at = s.indexOf(' ' + p + ' '); at >= 0; at = s.indexOf(' ' + p + ' ', at + 1)) {
      if (!(p.indexOf('es ') === 0 && /\sno\s$/.test(s.slice(0, at + 1)))) return true;
    }
    return false;
  });
}
function dynExamEvidenceIndex(chapterMd) {
  var norm = '';
  var bounds = [0];
  String(chapterMd == null ? '' : chapterMd).split('\n').forEach(function (line) {
    var n = dynExamGuardNormalize(line);
    if (!n) return;
    if (norm) norm += ' ';
    var start = norm.length;
    bounds.push(start);
    norm += n;
    var re = /[.!?]+["']*(?=\s|$)/g;
    var m;
    while ((m = re.exec(n))) bounds.push(start + m.index + m[0].length);
    bounds.push(norm.length);
  });
  bounds.sort(function (a, b) { return a - b; });
  return { norm: norm, bounds: bounds, rules: 3 };
}
function _dynExamWhetherBefore(tokens) {
  var last = tokens.slice(-3);
  for (var k = last.length - 1; k >= 0; k--) {
    if (DYN_EXAM_EVIDENCE_WHETHER_WORDS.indexOf(last[k]) >= 0) return true;
    if (_DYN_EXAM_COORDINATORS.indexOf(last[k]) >= 0) return false;
  }
  return false;
}
function _dynExamHasPhrase(tokens, phrases) {
  var s = ' ' + tokens.join(' ') + ' ';
  return phrases.some(function (p) { return s.indexOf(' ' + p + ' ') >= 0; });
}
function _dynExamInsideQuotedQuestion(sentence, at, end) {
  var re = /"[^"]*"|'[^']*'/g;
  var m;
  while ((m = re.exec(sentence))) {
    if (m.index < at && m.index + m[0].length >= end && /[?\u00bf]/.test(m[0])) return true;
  }
  return false;
}
function dynExamEvidenceSupport(chapter, evidence) {
  var ev = dynExamGuardNormalize(evidence);
  if (!ev) return { ok: false, reason: 'missing' };
  var idx = typeof chapter === 'string' ? dynExamEvidenceIndex(chapter) : chapter;
  var norm = idx.norm;
  var bounds = idx.bounds;
  var evTok = dynExamTokens(ev);
  var found = false;
  var reason = 'negated';
  for (var at = norm.indexOf(ev); at >= 0; at = norm.indexOf(ev, at + 1)) {
    found = true;
    var end = at + ev.length;
    var sStart = 0;
    var sEnd = norm.length;
    for (var k = 0; k < bounds.length; k++) { var b = bounds[k]; if (b <= at && b > sStart) sStart = b; if (b >= end && b < sEnd) sEnd = b; }
    var sentence = norm.slice(sStart, sEnd);
    if (/[?\u00bf]/.test(sentence.replace(/"[^"]*"|'[^']*'/g, '')) || _dynExamInsideQuotedQuestion(sentence, at - sStart, end - sStart)) { reason = 'question'; continue; }
    var preText = norm.slice(sStart, at);
    var cut = Math.max(preText.lastIndexOf(':'), preText.lastIndexOf(';'));
    var post = dynExamTokens(norm.slice(end, sEnd));
    var before = cut >= 0 ? dynExamTokens(preText.slice(0, cut)) : [];
    var after = dynExamTokens(cut >= 0 ? preText.slice(cut + 1) : preText);
    var pre = before.concat(after);
    var next = function (i) { return i + 1 < pre.length ? pre[i + 1] : evTok[0]; };
    var copula = function (i) { return pre[i] === 'no' && (_DYN_EXAM_COPULAS.indexOf(next(i)) >= 0 || (next(i) === 'se' && (i + 2 < pre.length ? pre[i + 2] : evTok[i + 2 - pre.length]) === 'trata')); };
    var negated = pre.some(function (t, i) {
      if (DYN_EXAM_EVIDENCE_PREFIX_NEGATIONS.indexOf(t) < 0) return false;
      if (t === 'sin' && next(i) === 'embargo') return false;
      if (t === 'no' && ['obstante', 'solo', 'solamente', 'unicamente'].indexOf(next(i)) >= 0) return false;
      if (copula(i) && (i < before.length || pre.slice(i + 1).indexOf('sino') >= 0)) return false;
      return true;
    });
    if (negated || _dynExamHasFalsity(pre) || _dynExamHasFalsity(post)) { reason = 'negated'; continue; }
    var preCond = pre.some(function (t, i) { return DYN_EXAM_EVIDENCE_PREFIX_CONDITIONS.indexOf(t) >= 0 && !(t === 'si' && _dynExamWhetherBefore(pre.slice(0, i))); })
      || _dynExamHasPhrase(pre, DYN_EXAM_EVIDENCE_PREFIX_CONDITION_PAIRS);
    var postCond = post.some(function (t, i) {
      return DYN_EXAM_EVIDENCE_SUFFIX_CONDITIONS.indexOf(t) >= 0
        && !(t === 'si' && _dynExamWhetherBefore(evTok.concat(post.slice(0, i))))
        && !(t === 'sino' && post[i + 1] === 'tambien');
    }) || _dynExamHasPhrase(post, DYN_EXAM_EVIDENCE_SUFFIX_CONDITION_PAIRS);
    if (preCond || postCond) { reason = 'conditioned'; continue; }
    return { ok: true };
  }
  return found ? { ok: false, reason: reason } : { ok: false, reason: 'missing' };
}
function _dynEbEvidenceIndexOf(info) {
  if (!info._evIdx) info._evIdx = dynExamEvidenceIndex(info.md);
  return info._evIdx;
}

// ── BANKOPT (opción 1b; fix round 1 C1, fix round 2 N1/N4): reubicación de la evidencia SOLO por forma ──
// La evidencia no textual se acepta únicamente si, quitando mayúsculas, tildes, espacios y puntuación,
// es IDÉNTICA a UNA oración / viñeta / fila del capítulo o a una ventana de palabras de ella. Sin
// tolerancia de tipeo (una letra distinta puede ser otra palabra: normal/anormal, kilo/mili, junio/julio).
//   - la puntuación ENTRE dígitos se conserva y debe coincidir («1,500» ≠ «1.500», «0,7» ≠ «0.7»); todo
//     símbolo que no sea puntuación de oración también (fix round 4, R1: < > ≤ ≥ ± + − % ‰ ° $ € …);
//   - si el mismo texto aparece en dos oraciones distintas, es ambiguo → rechazo;
//   - una ventana recortada nunca deja afuera una negación anterior («no», «nunca», «ni», «sin»…) ni una
//     excepción / condición / limitación posterior («excepto», «salvo», «solo si», «a menos que»,
//     «siempre que»…): si lo haría, rechazo;
//   - se re-verifica copia textual (mismo chequeo que el backend) y 40–220 caracteres.
// Si algo falla, la pregunta se rechaza como siempre (EXAM_BANK_EVIDENCE → reparación).
var DYN_EXAM_LEADING_NEGATIONS = { no: 1, nunca: 1, jamas: 1, ni: 1, sin: 1, tampoco: 1, nadie: 1, nada: 1, ninguno: 1, ninguna: 1, ningun: 1, ningunos: 1, ningunas: 1 };
// Marcas de excepción / condición / limitación que no pueden quedar fuera de una ventana (palabras sueltas
// o comienzo de frase; «solo», «si», «cuando»… cubren «solo si», «solo cuando», «siempre que»…).
var DYN_EXAM_TRAILING_LIMITS = { excepto: 1, salvo: 1, menos: 1, si: 1, cuando: 1, siempre: 1, solo: 1, solamente: 1, unicamente: 1, mientras: 1, aunque: 1, pero: 1, sino: 1, no: 1, nunca: 1, ni: 1, sin: 1, hasta: 1, siempreque: 1 };
// Texto de comparación (fix round 4, R1): normalizado; se ignoran SOLO los espacios y la puntuación de
// oración . , ; : ¡ ! ¿ ? y comillas, y nunca junto a un dígito. Todo otro símbolo se conserva y debe coincidir
// (< > ≤ ≥ ± + - − % ‰ ° $ € £ / …): «< 0,5» ≠ «> 0,5», «-18 °C» ≠ «18 °C», «2 %» ≠ «2 ‰» ≠ «2». «>» se
// conserva con la normalización de la evidencia v3 (solo quita «>» como marca de cita al inicio de línea y no
// convierte «≠ ≮ ≯ ≤ ≥…» en «= < >…»).
function _dynEbCompareText(s) {
  return dynNormalizeExamEvidenceText(s)
    .replace(/(?<!\p{N})[.,;:\u00a1!\u00bf?"'](?!\p{N})/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}
// Unidades citables del capítulo: cada línea sin su marcador de viñeta/título, partida en oraciones.
function dynExamEvidenceUnits(md) {
  var out = [];
  String(md == null ? '' : md).split('\n').forEach(function (line) {
    var l = line.replace(/^[ \t>]*(?:[-+*•‣◦▪]|\d{1,3}[.)])[ \t]+/, '').replace(/^[ \t>]*#{1,6}[ \t]+/, '').trim();
    if (!l) return;
    l.split(/(?<=[.!?…])\s+(?=[¿¡«"“(]?[\p{Lu}\p{N}])/u).forEach(function (s) { s = s.trim(); if (s) out.push(s); });
  });
  return out;
}
// Texto legible de una unidad: sin **, __, `, # ni > iniciales; | se quita (la normalización lo quita igual: «a|b» = «ab»).
function _dynEbCleanEvidence(s) {
  return String(s).replace(/\*\*|__|`/g, '').replace(/^[ \t>#]+/, '').replace(/\|/g, '').replace(/\s+/g, ' ').trim();
}
function _dynEbCmpWords(s) { var c = _dynEbCompareText(s); return c ? c.split(' ') : []; }
function dynExamBankRelocateEvidence(evidence, info) {
  if (!info || typeof info.md !== 'string') return null;
  var lim = DYN_EXAM_BANK_LIMITS.evidence;
  var ev = _dynEbCompareText(evidence);
  if (ev.length < lim[0] / 2) return null;
  var evWords = ev.split(' ').length;
  if (!info._evUnits) {
    info._evUnits = dynExamEvidenceUnits(info.md).map(function (u) {
      var t = _dynEbCleanEvidence(u);
      var words = t.split(' ');
      return { text: t, words: words, cmpWords: words.map(_dynEbCmpWords) };
    });
  }
  var hits = []; // { unit, text }
  info._evUnits.forEach(function (u, ui) {
    if (_dynEbCompareText(u.text) === ev) { hits.push({ unit: ui, text: u.text, a: 0, z: u.words.length - 1 }); return; }
    // Ventanas de palabras crudas cuyo texto de comparación es exactamente el de la evidencia.
    for (var a = 0; a < u.words.length; a++) {
      if (!u.cmpWords[a].length) continue;
      var n = 0;
      for (var z = a; z < u.words.length && n < evWords; z++) {
        n += u.cmpWords[z].length;
        if (n === evWords) {
          var sp = u.words.slice(a, z + 1).join(' ');
          if (_dynEbCompareText(sp) === ev) hits.push({ unit: ui, text: sp, a: a, z: z });
        }
      }
    }
  });
  if (!hits.length) return null;
  // Ambigüedad: el mismo texto en dos oraciones distintas → rechazo.
  if (hits.some(function (h) { return h.unit !== hits[0].unit; })) return null;
  var best = hits[0];
  var unit = info._evUnits[best.unit];
  // Recorte (fix round 2): nunca deja afuera una negación anterior ni una excepción/condición posterior.
  var before = [].concat.apply([], unit.cmpWords.slice(0, best.a));
  var after = [].concat.apply([], unit.cmpWords.slice(best.z + 1));
  if (before.some(function (w) { return DYN_EXAM_LEADING_NEGATIONS[w]; })) return null;
  if (after.some(function (w) { return DYN_EXAM_TRAILING_LIMITS[w]; })) return null;
  var text = best.text;
  if (_dynEbTextErr(text, lim, 'evidence', true)) return null;
  var norm = dynNormalizeExamText(text);
  if (!norm || info.norm.indexOf(norm) < 0) return null;
  if (!dynExamEvidenceSupport(_dynEbEvidenceIndexOf(info), text).ok) return null; // fix round 3
  return { text: text };
}

// ── Ensamblado del banco (pasos 4e y 5) ──
// records: [{ id, leafIndex, order, status:'valid'|'rejected'|'missing', q, combos }]
// → { questions, perLeaf, short, duplicates, histogram, correctLongestShare, mcTotal, bankErrors }.
// BANKOPT fix round 1 (C2): recorte EQUITATIVO entre capítulos. Con holgura se piden más preguntas de las
// que se conservan; nunca se recorta «la cola» (el último capítulo del módulo en el examen final): se quita
// siempre del capítulo con MÁS conservadas (empate → el capítulo más tardío; dentro de él, la última).
// Determinista. list: registros válidos en orden; n: cuántos conservar.
function _dynEbRecChapter(r) { return (r.q && r.q.chapterId) || r.chapterId || (r.unit && r.unit.chapterId) || ''; }
function _dynEbChapterCounts(list) {
  var c = {};
  list.forEach(function (r) { var ch = _dynEbRecChapter(r); c[ch] = (c[ch] || 0) + 1; });
  return c;
}
function _dynEbDropFair(list, pool) {
  // Quita de `pool` (subconjunto de list) un registro del capítulo con más registros en `list`.
  var counts = _dynEbChapterCounts(list);
  var victim = null;
  pool.forEach(function (r) {
    if (!victim) { victim = r; return; }
    var cr = counts[_dynEbRecChapter(r)];
    var cv = counts[_dynEbRecChapter(victim)];
    if (cr > cv || (cr === cv && r.order > victim.order)) victim = r;
  });
  return victim;
}
function _dynEbFairTrim(list, n) {
  var out = list.slice();
  while (out.length > n) { var v = _dynEbDropFair(out, out); out.splice(out.indexOf(v), 1); }
  return out;
}
function _dynEbBalanceTf(rs, target) {
  var T = rs.filter(function (r) { return r.q.answer === true; });
  var F = rs.filter(function (r) { return r.q.answer === false; });
  for (var n = Math.min(rs.length, target); n >= 1; n--) {
    var lo, hi;
    if (n >= 4) { lo = Math.ceil(2 * n / 5); hi = Math.floor(3 * n / 5); } else if (n >= 2) { lo = 1; hi = n - 1; } else { lo = 0; hi = n; }
    lo = Math.max(lo, n - F.length);
    hi = Math.min(hi, T.length);
    if (lo > hi) continue;
    var best = lo;
    for (var t = lo; t <= hi; t++) if (Math.abs(2 * t - n) < Math.abs(2 * best - n)) best = t;
    // Fix round 1 (C2): del grupo que sobra se quita siempre del capítulo con más conservadas (V+F juntas).
    var t = T.slice();
    var f = F.slice();
    while (t.length > best || f.length > n - best) {
      var cur = t.concat(f);
      var pool = t.length > best ? t : f;
      var v = _dynEbDropFair(cur, pool);
      pool.splice(pool.indexOf(v), 1);
    }
    return t.concat(f).sort(function (a, b) { return a.order - b.order; });
  }
  return [];
}
function _dynEbOwnerOf(leaf) { return leaf.chapterId != null ? leaf.chapterId : leaf.moduleId; }
function _dynEbFinalQuestion(r, scope) {
  var q = r.q;
  var o = { id: q.id, type: q.type, chapterId: q.chapterId };
  if (scope === 'final') o.moduleId = q.moduleId;
  o.level = q.level; o.stem = q.stem; o.explanation = q.explanation; o.evidence = q.evidence;
  if (q.type === 'multichoice') {
    o.correct = { text: q.correct.text, why: q.correct.why };
    o.distractors = r.chosen.idx.map(function (i) { return { text: q.distractors5[i].text, why: q.distractors5[i].why }; });
  } else if (q.type === 'truefalse') {
    o.answer = q.answer; o.whyWrong = q.whyWrong;
  } else {
    o.pairs = q.pairs.map(function (p) { return { term: p.term, definition: p.definition }; });
  }
  return o;
}
// opts = { plan, scope, seed, records, chapterIds? (final: cobertura por capítulo) }.
// Reglas de conservación por hoja (2·slots como máximo):
//   - duplicado exacto o casi duplicado (Jaccard ≥ 0,8) de un enunciado anterior → fuera;
//   - MC cuya ÚNICA combinación elegible deja la correcta como la más larga → solo entra
//     para llegar al piso (fix 1, I1); si no, sale y va a la reparación;
//   - V/F: subconjunto balanceado.
// Hoja con < 2·slots → `short` con los ids a reemplazar y el motivo de cada válido descartado.
function dynExamBankAssemble(opts) {
  var plan = opts.plan;
  var records = (opts.records || []).slice().sort(function (a, b) { return a.order - b.order; });
  var duplicates = [];
  var dupIds = {};
  var why = {}; // id válido no conservado → { code, message }
  var seenStem = {};
  var accepted = [];
  // #542 (I3): índice de casi duplicados (MC/V/F) del banco + preguntas de las evaluaciones de módulo
  // (opts.externalStems, solo el examen final) — se recalcula en cada ensamblado.
  var isMcTf = function (q) { return q && (q.type === 'multichoice' || q.type === 'truefalse'); };
  var external = (opts.externalStems || []).filter(function (e) { return e && typeof e.stem === 'string' && e.stem; });
  var dupEntries = external.map(function (e) { return { stem: e.stem, answer: e.answer || '' }; });
  var dupAt = {};
  records.forEach(function (r) { if (r.status === 'valid' && isMcTf(r.q)) { dupAt[r.id] = dupEntries.length; dupEntries.push({ stem: r.q.stem, answer: _dynEbAnswerText(r.q) }); } });
  var dupIdx = dynExamDupIndex(dupEntries);
  // Fix round 1 (m5): decisiones estables. Una pregunta aceptada en un ensamblado anterior (r._dupAccepted;
  // se borra si la pregunta se reemplaza en una reparación) nunca se rechaza después: va primero y sin
  // chequeos; las nuevas se comparan contra ella.
  var ordered = records.filter(function (r) { return r.status === 'valid' && r._dupAccepted; })
    .concat(records.filter(function (r) { return !(r.status === 'valid' && r._dupAccepted); }));
  ordered.forEach(function (r) {
    if (r.status !== 'valid') return;
    var ns = dynNormalizeExamText(r.q.stem);
    var near = null;
    if (r._dupAccepted) { /* estable: ya aceptada */ }
    else if (Object.prototype.hasOwnProperty.call(seenStem, ns)) near = { code: 'EXAM_BANK_DUPLICATE', message: 'enunciado repetido de ' + seenStem[ns] };
    else {
      for (var i = 0; i < accepted.length; i++) {
        var a0 = accepted[i];
        if (dynExamStemSimilarity(a0.q.stem, r.q.stem) >= DYN_EXAM_NEAR_DUP_JACCARD ||
          (dupIdx.enabled && isMcTf(r.q) && isMcTf(a0.q) && dynExamNearDupScore(dupIdx.sigs[dupAt[a0.id]], dupIdx.sigs[dupAt[r.id]], dupIdx.freq) >= DYN_EXAM_NEAR_DUP_SCORE)) {
          near = { code: 'EXAM_BANK_NEAR_DUPLICATE', message: 'enunciado casi igual al de ' + a0.id + ': escribe una situación distinta' };
          break;
        }
      }
      if (!near && dupIdx.enabled && isMcTf(r.q)) {
        for (var x = 0; x < external.length; x++) {
          if (dynExamNearDupScore(dupIdx.sigs[x], dupIdx.sigs[dupAt[r.id]], dupIdx.freq) >= DYN_EXAM_NEAR_DUP_SCORE) {
            near = { code: 'EXAM_BANK_NEAR_DUPLICATE', message: 'casi igual a una pregunta de la evaluación del módulo («' + external[x].stem.replace(/\s+/g, ' ').slice(0, 90) + '…»): pregunta otra situación con otra respuesta' };
            break;
          }
        }
      }
    }
    if (near) {
      duplicates.push({ id: r.id, code: near.code, message: near.message });
      dupIds[r.id] = true;
      why[r.id] = near;
      return;
    }
    seenStem[ns] = r.id;
    accepted.push(r);
  });
  accepted.forEach(function (r) { r._dupAccepted = true; });
  accepted.sort(function (a, b) { return a.order - b.order; });
  var kept = [];
  var perLeaf = [];
  var short = [];
  var longestDropped = [];
  plan.forEach(function (leaf, li) {
    var rs = accepted.filter(function (r) { return r.leafIndex === li; });
    var target = 2 * leaf.slots;
    var floor = dynExamBankFloorF2(leaf.slots);
    var keep;
    if (leaf.type === 'truefalse') {
      keep = _dynEbBalanceTf(rs, target);
    } else if (leaf.type === 'multichoice') {
      var normal = rs.filter(function (r) { return !_dynEbReachOnlyLongest(r.combos); });
      var onlyLongest = rs.filter(function (r) { return _dynEbReachOnlyLongest(r.combos); });
      keep = _dynEbFairTrim(normal, target);
      if (keep.length < floor) {
        // Relleno hasta el piso con «solo más larga»: primero los capítulos con menos conservadas.
        var spare = onlyLongest.slice();
        while (keep.length < floor && spare.length) {
          var cnt = _dynEbChapterCounts(keep);
          spare.sort(function (a, b) { return ((cnt[_dynEbRecChapter(a)] || 0) - (cnt[_dynEbRecChapter(b)] || 0)) || (a.order - b.order); });
          keep.push(spare.shift());
        }
        keep.sort(function (a, b) { return a.order - b.order; });
      }
      onlyLongest.forEach(function (r) {
        why[r.id] = { code: 'EXAM_BANK_LENGTH_BIAS', message: 'la correcta es más larga que todos los distractores: escribe al menos 2 distractores MÁS LARGOS que la correcta' };
        if (keep.indexOf(r) < 0) longestDropped.push(r.id);
      });
    } else {
      keep = _dynEbFairTrim(rs, target);
    }
    var keepIds = {};
    keep.forEach(function (r) { keepIds[r.id] = true; });
    kept = kept.concat(keep);
    var row = { owner: _dynEbOwnerOf(leaf), type: leaf.type, slots: leaf.slots, kept: keep.length, target: target, floor: floor };
    perLeaf.push(row);
    // Fix round 1 (C2): mínimo por capítulo en una hoja del final = floor(objetivo / capítulos del módulo).
    // Un capítulo por debajo (sus preguntas fueron rechazadas) se repara aunque la hoja llegue al objetivo.
    var leafChs = leaf.moduleId != null ? (opts.chapters || []).filter(function (c) { return c.moduleId === leaf.moduleId; }).map(function (c) { return c.id; }) : [];
    var chDeficit = [];
    if (leafChs.length > 1) {
      var minPer = Math.floor(target / leafChs.length);
      var kc = _dynEbChapterCounts(keep);
      leafChs.forEach(function (c) { var d = minPer - (kc[c] || 0); if (d > 0) chDeficit.push({ chapterId: c, need: d }); });
      row.chapterMin = minPer;
    }
    // #583 (I3): con el piso en 2·slots el relleno «solo más larga» puede completar el objetivo; esas preguntas se
    // piden de nuevo igual (si el reemplazo no sirve, se conserva la original válida), como antes con el piso de 1,5·s.
    var longestFillers = {};
    if (leaf.type === 'multichoice') keep.forEach(function (r) { if (_dynEbReachOnlyLongest(r.combos)) longestFillers[r.id] = true; });
    if (keep.length < target || chDeficit.length || Object.keys(longestFillers).length) {
      // repairs = ids a reemplazar. MC/EM: todos los no conservados (rechazados, faltantes, duplicados,
      // «correcta = más larga»). V/F: solo los necesarios para llegar a floor(2s/2) verdaderas y el
      // resto falsas, con el valor pedido (primero los libres, después sobrantes de la mayoría).
      var notKept = records.filter(function (r) { return r.leafIndex === li && !keepIds[r.id]; });
      var repairs = [];
      var tag = function (r, extra) { var o = { id: r.id }; if (r.status === 'valid' && why[r.id]) { o.code = why[r.id].code; o.message = why[r.id].message; } return Object.assign(o, extra || {}); };
      if (leaf.type === 'truefalse') {
        var tT = Math.floor(target / 2);
        var needT = Math.max(0, tT - rs.filter(function (r) { return r.q.answer === true; }).length);
        var needF = Math.max(0, target - tT - rs.filter(function (r) { return r.q.answer === false; }).length);
        var usable = function (r) { return r.status !== 'valid' || dupIds[r.id]; };
        notKept.filter(usable).concat(notKept.filter(function (r) { return !usable(r); })).forEach(function (r) {
          var free = usable(r);
          if (needF > 0 && (free || r.q.answer === true)) { repairs.push(tag(r, { answer: false })); needF--; }
          else if (needT > 0 && (free || r.q.answer === false)) { repairs.push(tag(r, { answer: true })); needT--; }
        });
      } else {
        // BANKOPT (opción 1c): con la holgura del pedido, solo se reemplaza lo que FALTA para el
        // objetivo (need), primero los ids sin pregunta válida (rechazados, faltantes, duplicados) y
        // después los válidos descartados por la selección; nunca toda la lista de no conservados.
        var free = notKept.filter(function (r) { return r.status !== 'valid' || dupIds[r.id]; });
        var taken = notKept.filter(function (r) { return !(r.status !== 'valid' || dupIds[r.id]); });
        repairs = free.concat(taken).slice(0, target - keep.length).map(function (r) { return tag(r); });
        // Las «correcta = más larga» que entraron solo para llegar al piso también se piden de nuevo
        // (si el reemplazo no sirve, se conserva la original válida).
        if (leaf.type === 'multichoice') keep.forEach(function (r) { if (_dynEbReachOnlyLongest(r.combos)) repairs.push(tag(r)); });
      }
      if (keep.length >= target) repairs = repairs.filter(function (x) { return longestFillers[x.id]; });
      var deficitNeed = 0;
      // Fix round 2 (N3): en V/F el reemplazo lleva el valor que necesita la hoja: el que falta para el
      // balance o, con la hoja balanceada, el valor cuyo recorte posterior NO caería en un capítulo en su mínimo.
      var tfValueFor = function () {
        if (leaf.type !== 'truefalse') return null;
        var tT = Math.floor(target / 2);
        var kT = keep.filter(function (r) { return r.q.answer === true; }).length;
        var kF = keep.length - kT;
        if (kT < tT) return true;
        if (kF < target - tT) return false;
        var kc2 = _dynEbChapterCounts(keep);
        var safe = [true, false].filter(function (v) {
          var pool = keep.filter(function (r) { return r.q.answer === v; });
          if (!pool.length) return true;
          var victim = _dynEbDropFair(keep, pool);
          return (kc2[_dynEbRecChapter(victim)] || 0) > row.chapterMin;
        });
        return safe.length ? safe[0] : (kT <= kF);
      };
      chDeficit.forEach(function (d) {
        deficitNeed += d.need;
        var mine = notKept.filter(function (r) { return _dynEbRecChapter(r) === d.chapterId && !repairs.some(function (x) { return x.id === r.id; }); });
        var mineFree = mine.filter(function (r) { return r.status !== 'valid' || dupIds[r.id]; });
        mineFree.concat(mine.filter(function (r) { return mineFree.indexOf(r) < 0; })).slice(0, d.need).forEach(function (r) {
          var v = tfValueFor();
          repairs.push(tag(r, v === null ? { deficit: true } : { deficit: true, answer: v }));
        });
      });
      short.push({ leafIndex: li, owner: row.owner, type: leaf.type, kept: keep.length, floor: floor, need: Math.max(target - keep.length, deficitNeed), chapterDeficit: chDeficit, repairs: repairs });
    }
  });
  // Fix round 1 (C2): un capítulo del final sin ninguna pregunta conservada pero con una válida descartada
  // por la selección la recupera, cambiándola por una de un capítulo con ≥ 2 en esa hoja (mismo valor V/F).
  if (opts.chapterIds) {
    opts.chapterIds.forEach(function (c) {
      if (kept.some(function (r) { return _dynEbRecChapter(r) === c; })) return;
      for (var li2 = 0; li2 < plan.length; li2++) {
        var cand = accepted.filter(function (r) { return r.leafIndex === li2 && _dynEbRecChapter(r) === c && kept.indexOf(r) < 0 && !(r.q.type === 'multichoice' && _dynEbReachOnlyLongest(r.combos)); })[0];
        if (!cand) continue;
        var inLeaf = kept.filter(function (r) { return r.leafIndex === li2; });
        var cnt = _dynEbChapterCounts(inLeaf);
        var victim = null;
        inLeaf.forEach(function (r) {
          if (cand.q.type === 'truefalse' && r.q.answer !== cand.q.answer) return;
          var cr = cnt[_dynEbRecChapter(r)] || 0;
          if (cr < 2) return;
          var cv = victim ? cnt[_dynEbRecChapter(victim)] : -1;
          if (cr > cv || (cr === cv && r.order > victim.order)) victim = r;
        });
        if (!victim) continue;
        kept[kept.indexOf(victim)] = cand;
        break;
      }
    });
  }
  kept.sort(function (a, b) { return a.order - b.order; });
  var mc = kept.filter(function (r) { return r.q.type === 'multichoice'; });
  var bal = dynExamBankBalanceRanks(mc.map(function (r) { return { id: r.id, combos: r.combos }; }), opts.seed);
  var longest = bal.histogram[3];
  var questions = kept.map(function (r) {
    return _dynEbFinalQuestion(r.q.type === 'multichoice' ? { q: r.q, chosen: bal.chosen[r.id] } : r, opts.scope);
  });
  var uncovered = [];
  if (opts.chapterIds) {
    var covered = {};
    kept.forEach(function (r) { covered[r.q.chapterId] = true; });
    uncovered = opts.chapterIds.filter(function (c) { return !covered[c]; });
  }
  var bankErrors = [];
  if (mc.length && 10 * longest > 3 * mc.length) bankErrors.push('EXAM_BANK_LENGTH_BIAS: la correcta es la más larga en ' + longest + '/' + mc.length);
  return { questions: questions, perLeaf: perLeaf, short: short, duplicates: duplicates, longestDropped: longestDropped, uncovered: uncovered,
    histogram: bal.histogram, correctLongestShare: mc.length ? longest / mc.length : 0, mcTotal: mc.length, bankErrors: bankErrors };
}

// ── Port JS de validateExamBank (B2, planSource 'manifest') ──
// ctx = { scope, chapters: [{ id, moduleId }], chapterMd?: { [chapterId]: md } }.
function _dynEbExpectedPlan(scope, chapters) {
  if (scope === 'module') return dynExamSlotPlan(chapters.map(function (c) { return c.id; }));
  var mods = [];
  chapters.forEach(function (c) {
    var m = mods.filter(function (x) { return x.moduleId === c.moduleId; })[0];
    if (!m) { m = { moduleId: c.moduleId, chapterIds: [] }; mods.push(m); }
    m.chapterIds.push(c.id);
  });
  return dynFinalExamSlotPlan(mods);
}
function dynValidateExamBank(doc, ctx) {
  var E = [];
  function push(path, code, message) { E.push({ path: path, code: code, message: message }); }
  function keysOk(obj, allowed, path) {
    allowed.forEach(function (k) { if (!(k in obj)) push(path + '.' + k, 'MISSING_FIELD', 'falta el campo "' + k + '"'); });
    Object.keys(obj).forEach(function (k) { if (allowed.indexOf(k) < 0) push(path + '.' + k, 'UNKNOWN_FIELD', 'campo no permitido "' + k + '"'); });
  }
  function text(v, path, lim) {
    if (v === undefined) return;
    if (typeof v !== 'string') { push(path, 'EXAM_BANK_SCHEMA', 'se esperaba texto'); return; }
    var n = _dynEbLen(v);
    if (n < lim[0] || n > lim[1]) push(path, 'EXAM_BANK_SCHEMA', 'longitud ' + n + ' fuera de ' + lim[0] + '–' + lim[1]);
    if (DYN_EXAM_BANK_CONTROL_RE.test(v)) push(path, 'EXAM_BANK_SCHEMA', 'caracteres de control no permitidos (solo \t y \n)');
  }
  function option(v, path) {
    if (v === undefined) return;
    if (!_dynIsPlainObject(v)) { push(path, 'EXAM_BANK_SCHEMA', 'se esperaba un objeto {text, why}'); return; }
    keysOk(v, ['text', 'why'], path);
    text(v.text, path + '.text', DYN_EXAM_BANK_LIMITS.optionText);
    text(v.why, path + '.why', DYN_EXAM_BANK_LIMITS.optionWhy);
  }
  var L = DYN_EXAM_BANK_LIMITS;
  var chapterModule = {};
  ctx.chapters.forEach(function (c) { chapterModule[c.id] = c.moduleId; });
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  var examModule = ctx.scope === 'module' ? ctx.chapters[0].moduleId : null;
  var plan = _dynEbExpectedPlan(ctx.scope, ctx.chapters);
  var done = function (n) { return { ok: E.length === 0, errors: E, slotCount: plan.reduce(function (t, l) { return t + l.slots; }, 0), bankSize: n }; };
  if (!_dynIsPlainObject(doc)) { push('$', 'EXAM_BANK_SCHEMA', 'el banco debe ser un objeto JSON'); return done(0); }
  // Fix round 4 (R2): bankValidationVersion es opcional (solo se exige si está).
  keysOk(doc, ['bankVersion', 'scope', 'moduleId', 'plan', 'questions'].concat('bankValidationVersion' in doc ? ['bankValidationVersion'] : []), '$');
  if (doc.bankVersion !== undefined && doc.bankVersion !== 1) push('$.bankVersion', 'EXAM_BANK_SCHEMA', 'bankVersion debe ser 1');
  if (doc.bankValidationVersion !== undefined && !(Number.isInteger(doc.bankValidationVersion) && doc.bankValidationVersion >= 1 && doc.bankValidationVersion <= DYN_EXAM_BANK_VALIDATION_VERSION)) {
    push('$.bankValidationVersion', 'EXAM_BANK_SCHEMA', 'bankValidationVersion debe ser un entero de 1 a ' + DYN_EXAM_BANK_VALIDATION_VERSION);
  }
  if (doc.scope !== undefined && doc.scope !== ctx.scope) push('$.scope', 'EXAM_BANK_SCHEMA', 'scope debe ser "' + ctx.scope + '"');
  if ('moduleId' in doc) {
    if (ctx.scope === 'module') { if (doc.moduleId !== examModule) push('$.moduleId', 'EXAM_BANK_SCHEMA', 'moduleId debe ser "' + examModule + '"'); }
    else if (doc.moduleId !== null) push('$.moduleId', 'EXAM_BANK_SCHEMA', 'moduleId debe ser null en el examen final');
  }
  if (doc.plan !== undefined) {
    var p = doc.plan;
    var same = Array.isArray(p) && p.length === plan.length && p.every(function (l, i) {
      if (!_dynIsPlainObject(l)) return false;
      var ka = Object.keys(l).sort(); var kb = Object.keys(plan[i]).sort();
      return ka.length === kb.length && ka.every(function (k, j) { return k === kb[j] && l[k] === plan[i][k]; });
    });
    if (!same) push('$.plan', 'EXAM_BANK_PLAN', 'el plan no coincide con el del Manifest (' + JSON.stringify(plan) + ')');
  }
  if (doc.questions === undefined) return done(0);
  if (!Array.isArray(doc.questions)) { push('$.questions', 'EXAM_BANK_SCHEMA', 'questions debe ser una lista'); return done(0); }
  var questions = doc.questions;
  var str = function (v) { return typeof v === 'string' ? v : ''; };
  var idOf = function (q, i) { return typeof q.id === 'string' && q.id ? q.id : '#' + i; };
  var TYPE_KEYS = { multichoice: ['correct', 'distractors'], truefalse: ['answer', 'whyWrong'], match: ['pairs'] };
  var valid = [];
  questions.forEach(function (q, i) {
    var path = '$.questions[' + i + ']';
    if (!_dynIsPlainObject(q)) { push(path, 'EXAM_BANK_SCHEMA', 'cada pregunta debe ser un objeto'); return; }
    var type = DYN_EXAM_BANK_TYPES_F2.indexOf(q.type) >= 0 ? q.type : null;
    if (q.type !== undefined && !type) push(path + '.type', 'EXAM_BANK_SCHEMA', idOf(q, i) + ': type inválido');
    keysOk(q, ['id', 'type', 'chapterId', 'level', 'stem', 'explanation', 'evidence'].concat(ctx.scope === 'final' ? ['moduleId'] : [], type ? TYPE_KEYS[type] : []), path);
    if (q.id !== undefined && (typeof q.id !== 'string' || !DYN_EXAM_BANK_ID_RE.test(q.id))) push(path + '.id', 'EXAM_BANK_SCHEMA', 'id inválido');
    if (q.chapterId !== undefined && (typeof q.chapterId !== 'string' || !has(chapterModule, q.chapterId))) push(path + '.chapterId', 'EXAM_BANK_SCHEMA', idOf(q, i) + ': chapterId no es un capítulo de este examen');
    if (ctx.scope === 'final' && q.moduleId !== undefined && typeof q.chapterId === 'string' && has(chapterModule, q.chapterId) && q.moduleId !== chapterModule[q.chapterId]) {
      push(path + '.moduleId', 'EXAM_BANK_SCHEMA', idOf(q, i) + ': moduleId debe ser el módulo del capítulo');
    }
    if (q.level !== undefined && DYN_EXAM_LEVELS.indexOf(q.level) < 0) push(path + '.level', 'EXAM_BANK_SCHEMA', idOf(q, i) + ': level inválido');
    text(q.stem, path + '.stem', L.stem);
    text(q.explanation, path + '.explanation', L.explanation);
    text(q.evidence, path + '.evidence', L.evidence);
    if (type === 'multichoice') {
      option(q.correct, path + '.correct');
      if (q.distractors !== undefined) {
        if (!Array.isArray(q.distractors) || q.distractors.length !== L.distractors) push(path + '.distractors', 'EXAM_BANK_SCHEMA', idOf(q, i) + ': se esperaban exactamente 3 distractores');
        else q.distractors.forEach(function (d, j) { option(d, path + '.distractors[' + j + ']'); });
      }
    } else if (type === 'truefalse') {
      if (q.answer !== undefined && typeof q.answer !== 'boolean') push(path + '.answer', 'EXAM_BANK_SCHEMA', idOf(q, i) + ': answer debe ser booleano');
      text(q.whyWrong, path + '.whyWrong', L.whyWrong);
    } else if (type === 'match' && q.pairs !== undefined) {
      if (!Array.isArray(q.pairs) || q.pairs.length < L.pairs[0] || q.pairs.length > L.pairs[1]) push(path + '.pairs', 'EXAM_BANK_SCHEMA', idOf(q, i) + ': se esperaban 4–6 pares');
      else q.pairs.forEach(function (pp, j) {
        var ppath = path + '.pairs[' + j + ']';
        if (!_dynIsPlainObject(pp)) { push(ppath, 'EXAM_BANK_SCHEMA', 'cada par debe ser {term, definition}'); return; }
        keysOk(pp, ['term', 'definition'], ppath);
        text(pp.term, ppath + '.term', L.term);
        text(pp.definition, ppath + '.definition', L.definition);
        if (typeof pp.term === 'string' && DYN_EXAM_MATCH_TERM_FORBIDDEN_RE.test(pp.term)) push(ppath + '.term', 'EXAM_BANK_MATCH', idOf(q, i) + ': el término no puede llevar < ni > (Moodle los borra en el desplegable)');
      });
    }
    valid.push({ q: q, i: i, type: type });
  });
  var seenId = {};
  var seenStem = {};
  valid.forEach(function (v) {
    if (typeof v.q.id === 'string') {
      if (has(seenId, v.q.id)) push('$.questions[' + v.i + '].id', 'EXAM_BANK_DUPLICATE', 'id "' + v.q.id + '" repetido');
      else seenId[v.q.id] = v.i;
    }
    var ns = dynNormalizeExamText(str(v.q.stem));
    if (ns) {
      if (has(seenStem, ns)) push('$.questions[' + v.i + '].stem', 'EXAM_BANK_DUPLICATE', idOf(v.q, v.i) + ': enunciado repetido de ' + seenStem[ns]);
      else seenStem[ns] = idOf(v.q, v.i);
    }
  });
  var ownerOf = function (q) {
    if (typeof q.chapterId !== 'string' || !has(chapterModule, q.chapterId)) return null;
    return ctx.scope === 'module' ? q.chapterId : chapterModule[q.chapterId];
  };
  var byLeaf = {};
  valid.forEach(function (v) {
    var owner = ownerOf(v.q);
    if (!owner || !v.type) return;
    var k = owner + '\u0000' + v.type;
    (byLeaf[k] = byLeaf[k] || []).push(idOf(v.q, v.i));
  });
  var planned = {};
  plan.forEach(function (leaf) {
    var owner = _dynEbOwnerOf(leaf);
    var k = owner + '\u0000' + leaf.type;
    planned[k] = true;
    var n = (byLeaf[k] || []).length;
    var min = dynExamBankFloorF2(leaf.slots);
    var max = 2 * leaf.slots + 2;
    if (n < min || n > max) push('$.questions', 'EXAM_BANK_LEAF_COUNT', owner + ' × ' + leaf.type + ': ' + n + ' preguntas, se esperaban ' + min + '–' + max);
  });
  Object.keys(byLeaf).forEach(function (k) {
    if (!planned[k]) push('$.questions', 'EXAM_BANK_LEAF_COUNT', k.replace('\u0000', ' × ') + ': preguntas fuera del plan (' + byLeaf[k].join(', ') + ')');
  });
  var mcTotal = 0;
  var longestIds = [];
  valid.forEach(function (v) {
    var q = v.q;
    if (v.type !== 'multichoice' || !_dynIsPlainObject(q.correct) || typeof q.correct.text !== 'string' || !Array.isArray(q.distractors)) return;
    var ds = q.distractors.filter(function (d) { return _dynIsPlainObject(d) && typeof d.text === 'string'; });
    if (ds.length !== q.distractors.length || !ds.length) return;
    var path = '$.questions[' + v.i + ']';
    var id = idOf(q, v.i);
    var c = _dynEbLen(q.correct.text);
    var Ld = Math.max.apply(null, ds.map(function (d) { return _dynEbLen(d.text); }));
    mcTotal++;
    if (c > Ld) longestIds.push(id);
    if (c - Ld >= 8 && 100 * (c - Ld) >= 15 * Ld) push(path + '.correct.text', 'EXAM_BANK_LENGTH_BIAS', id + ': la correcta supera al distractor más largo por ≥ 8 caracteres y ≥ 15 %');
    var options = [q.correct.text].concat(ds.map(function (d) { return d.text; }));
    options.forEach(function (t, j) {
      if (DYN_EXAM_OPTION_FORBIDDEN_RE.test(dynNormalizeExamText(t))) push(j === 0 ? path + '.correct.text' : path + '.distractors[' + (j - 1) + '].text', 'EXAM_BANK_OPTION_LINT', id + ': opción del tipo «todas/ninguna de las anteriores»');
    });
    var norm = options.map(dynNormalizeExamText);
    for (var a = 0; a < options.length; a++) {
      for (var b = a + 1; b < options.length; b++) {
        if (!norm[a] || !norm[b]) continue;
        if (norm[a] === norm[b] || dynExamTextContains(options[a], options[b]) || dynExamTextContains(options[b], options[a])) push(path, 'EXAM_BANK_OPTION_LINT', id + ': las opciones ' + a + ' y ' + b + ' son iguales o una contiene a la otra');
      }
    }
  });
  if (mcTotal > 0 && 10 * longestIds.length > 3 * mcTotal) push('$.questions', 'EXAM_BANK_LENGTH_BIAS', 'la correcta es la opción más larga en ' + longestIds.length + '/' + mcTotal + ' preguntas (> 30 %)');
  var tf = {};
  valid.forEach(function (v) {
    if (v.type !== 'truefalse' || typeof v.q.answer !== 'boolean') return;
    var owner = ownerOf(v.q);
    if (!owner) return;
    var s = tf[owner] = tf[owner] || { t: 0, n: 0 };
    s.n++;
    if (v.q.answer) s.t++;
  });
  Object.keys(tf).forEach(function (owner) {
    var t = tf[owner].t;
    var n = tf[owner].n;
    if (n >= 4 && (5 * t < 2 * n || 5 * t > 3 * n)) push('$.questions', 'EXAM_BANK_TF_BALANCE', owner + ': ' + t + '/' + n + ' verdaderas (fuera de 40–60 %)');
    else if (n >= 2 && n <= 3 && (t === 0 || t === n)) push('$.questions', 'EXAM_BANK_TF_BALANCE', owner + ': ' + n + ' preguntas V/F todas iguales');
  });
  valid.forEach(function (v) {
    if (v.type !== 'match' || !Array.isArray(v.q.pairs)) return;
    var id = idOf(v.q, v.i);
    var pairs = v.q.pairs.filter(function (pp) { return _dynIsPlainObject(pp) && typeof pp.term === 'string' && typeof pp.definition === 'string'; });
    var terms = pairs.map(function (pp) { return dynNormalizeExamText(pp.term); });
    var defs = pairs.map(function (pp) { return dynNormalizeExamText(pp.definition); });
    if (terms.some(function (t, i) { return terms.indexOf(t) !== i; })) push('$.questions[' + v.i + '].pairs', 'EXAM_BANK_MATCH', id + ': términos repetidos');
    if (defs.some(function (t, i) { return defs.indexOf(t) !== i; })) push('$.questions[' + v.i + '].pairs', 'EXAM_BANK_MATCH', id + ': definiciones repetidas');
    pairs.forEach(function (pp, j) { if (dynExamTextContains(pp.definition, pp.term)) push('$.questions[' + v.i + '].pairs[' + j + ']', 'EXAM_BANK_MATCH', id + ': la definición contiene su propio término'); });
  });
  if (ctx.chapterMd) {
    var evIdx = {};
    valid.forEach(function (v) {
      if (typeof v.q.chapterId !== 'string' || typeof v.q.evidence !== 'string') return;
      var md = ctx.chapterMd[v.q.chapterId];
      if (typeof md !== 'string') return;
      if (!has(evIdx, v.q.chapterId)) evIdx[v.q.chapterId] = dynExamEvidenceIndex(md);
      var sup = dynExamEvidenceSupport(evIdx[v.q.chapterId], v.q.evidence);
      if (!sup.ok) {
        var why = sup.reason === 'missing' ? 'la evidencia no aparece en el texto del capítulo'
          : sup.reason === 'negated' ? 'la oración del capítulo NIEGA o desmiente ese fragmento en el capítulo'
            : sup.reason === 'question' ? 'la oración del capítulo es una PREGUNTA, no una afirmación, en el capítulo'
              : 'la oración del capítulo CONDICIONA o exceptúa ese fragmento (si/excepto/salvo/cuando/pero/aunque…) en el capítulo';
        push('$.questions[' + v.i + '].evidence', 'EXAM_BANK_EVIDENCE', idOf(v.q, v.i) + ': ' + why + ' ' + v.q.chapterId);
      }
    });
  }
  return done(questions.length);
}

// ── Ejecutor del modo banco ──
// Fix 1 (C1): cada llamada cabe en el proxy (functions/api/proxy.js: MAX_TOKENS_CAP 8000,
// MAX_BODY_BYTES 64 KB; no se tocan, son un tope de costo): salida ESTIMADA ≤ 6.500 tokens
// por llamada y cuerpo ≤ 56 KB. Las partes se cortan por tokens estimados (no por cantidad).
// El examen final se genera POR CAPÍTULO (cada llamada lleva solo el texto de su capítulo y
// su parte de las hojas del módulo). Una respuesta cortada por max_tokens se reintenta
// PARTIDA EN DOS (nunca el mismo tamaño).
var DYN_EXAM_BANK_CALL_MAX_TOKENS = 8000;          // = MAX_TOKENS_CAP del proxy
// Curso de validación #583: con ~6.500 tokens estimados (≈ 7.500-8.000 reales) una llamada tarda
// más de 100 s y Cloudflare la corta con 524 (el examen final falló 5 de 5). 3.500 estimados
// (≈ 4.200 reales, ~60 s) deja margen; más llamadas, pero el prefijo del capítulo va en caché.
var DYN_EXAM_BANK_MAX_OUTPUT_EST = 3500;           // tokens de salida estimados por llamada
var DYN_EXAM_BANK_MAX_BODY_BYTES = 56 * 1024;      // < MAX_BODY_BYTES (64 KB) del proxy
// Salida estimada por pregunta (JSON minificado, why ≤ 200, explanation ≤ 350), medida en el
// paquete real #542 (antes 560 / 200 / 300 subestimaba un 15-20 %).
var DYN_EXAM_BANK_TOKENS_EST = { multichoice: 660, truefalse: 265, match: 335 };
// #583 (I3): con el piso en 2·slots una hoja corta tras 2 rondas fallaba el intento entero (sim. fault ×2: intentos
// 3,1 → 5,4 por 2×2); una 3.ª ronda —solo los ids que faltan, prefijo en caché— casi siempre la completa.
var DYN_EXAM_BANK_REPAIR_ROUNDS = 3;               // 2.ª y 3.ª ronda solo para hojas bajo el piso (I2)
var DYN_EXAM_BANK_CACHE_PREFIX = 'cursia.examBank.v1|';

// Pool con concurrencia fija; al primer error deja de lanzar tareas nuevas.
async function _dynExamBankPool(tasks, limit) {
  var next = 0;
  var failure = null;
  var results = new Array(tasks.length);
  async function lane() {
    while (next < tasks.length && !failure) {
      var k = next++;
      try { results[k] = await tasks[k](); } catch (e) { if (!failure) failure = { e: e }; }
    }
  }
  var lanes = [];
  for (var i = 0; i < Math.min(limit, tasks.length); i++) lanes.push(lane());
  await Promise.all(lanes);
  if (failure) throw failure.e;
  return results;
}
function _dynEbCount(map, code, n) { map[code] = (map[code] || 0) + (n == null ? 1 : n); }
// Bytes del cuerpo que api() manda al proxy ({model, max_tokens, system, messages}); el modelo
// se reemplaza por un marcador de 64 caracteres (más largo que cualquier id de modelo).
// prompt: texto o bloques de contenido (dynExamBankUserContent, con cache_control).
function dynExamBankBodyBytes(sys, prompt, maxTok) {
  var body = JSON.stringify({ model: new Array(65).join('m'), max_tokens: maxTok, system: sys, messages: [{ role: 'user', content: prompt }] });
  return _dynUtf8BytesLocal(body).length;
}
function dynExamBankEstimateTokens(types) {
  return (types || []).reduce(function (t, ty) { return t + (DYN_EXAM_BANK_TOKENS_EST[ty] || 600); }, 0);
}
// Corta una secuencia de preguntas [{ leafIndex, n, type }] en partes de ≤ maxEst tokens
// estimados, balanceadas (nunca una cola diminuta si cabe en la anterior).
function dynExamBankSplitByTokens(seq, maxEst) {
  var cap = maxEst || DYN_EXAM_BANK_MAX_OUTPUT_EST;
  var total = dynExamBankEstimateTokens(seq.map(function (x) { return x.type; }));
  var nCalls = Math.max(1, Math.ceil(total / cap));
  var maxItem = Math.max.apply(null, [0].concat(seq.map(function (x) { return DYN_EXAM_BANK_TOKENS_EST[x.type] || 600; })));
  var limit = Math.min(cap, Math.ceil(total / nCalls) + maxItem);
  var out = [];
  var cur = [];
  var curEst = 0;
  seq.forEach(function (x) {
    var e = DYN_EXAM_BANK_TOKENS_EST[x.type] || 600;
    if (cur.length && curEst + e > limit) { out.push(cur); cur = []; curEst = 0; }
    cur.push(x);
    curEst += e;
  });
  if (cur.length) out.push(cur);
  return out;
}
// Caché del navegador de respuestas VALIDADAS por parte (I2). Clave = item + idempotencyKey
// (no cambia entre intentos) + generación + hash de (system + prompt de la parte), que ya
// incluye la versión del prompt y el texto del capítulo. Nunca se confía sin re-validar.
function _dynEbStorage() {
  try { return (typeof sessionStorage !== 'undefined' && sessionStorage) ? sessionStorage : null; } catch (e) { return null; }
}
function _dynEbCacheItemPrefix(item) {
  return DYN_EXAM_BANK_CACHE_PREFIX + item.itemKey + '|' + (item.idempotencyKey || item.itemRunId) + '|' + (item.generation == null ? '' : item.generation) + '|';
}
function _dynEbCacheGet(key) {
  var st = _dynEbStorage();
  if (!st) return null;
  try {
    var v = JSON.parse(st.getItem(key) || 'null');
    return v && v.v === 1 && Array.isArray(v.questions) ? v.questions : null;
  } catch (e) { return null; }
}
function _dynEbCacheSet(key, questions) {
  var st = _dynEbStorage();
  if (!st) return;
  try { st.setItem(key, JSON.stringify({ v: 1, questions: questions })); } catch (e) { /* cuota llena o bloqueada: sin caché */ }
}
function _dynEbCacheClear(prefix) {
  var st = _dynEbStorage();
  if (!st) return;
  try {
    var del = [];
    for (var i = 0; i < st.length; i++) { var k = st.key(i); if (k && k.indexOf(prefix) === 0) del.push(k); }
    del.forEach(function (k) { st.removeItem(k); });
  } catch (e) { /* sin caché */ }
}

// ── BANKOPT (opción 1e): borrador del banco entre intentos (servidor) ──
// Contrato mínimo: ante EXAM_BANK_INCOMPLETE / EXAM_BANK_GENERATION_FAILED el ejecutor sube un artifact
// `dynamic_exam_bank_draft_json` con las preguntas VÁLIDAS del intento y lo informa en el fail
// (`examBankDraftArtifactId`); el backend lo verifica (dueño, tipo, itemRunId del item) y lo deja en
// output_summary.examBankDraft = { artifactId, generation, attempt }. El próximo claim (cualquier navegador)
// lo trae en `outputSummary`; solo se usa si coinciden generación, alcance, versión del prompt, plan y el
// sha256 del Markdown de cada capítulo, y TODAS sus preguntas se re-validan. Solo se manda el id si el
// claim lo anuncia (`examBank.draftArtifactType`): un backend anterior rechazaría el campo (whitelist).
var DYN_EXAM_BANK_DRAFT_ARTIFACT_TYPE = 'dynamic_exam_bank_draft_json';
// Fix round 4 (R2): reglas de validación con que el ejecutor acepta el banco (2 = la oración afirma la
// evidencia). Se escribe en el banco SOLO si el claim la anuncia (`examBank.bankValidationVersion`): un
// backend anterior rechazaría el campo. El empaque re-valida con la versión con que el banco fue aceptado.
var DYN_EXAM_BANK_VALIDATION_VERSION = 4; // #583 (I3): piso por hoja 2·slots (v3 = fix bank-guard-minors: guardia v3)
var DYN_EXAM_BANK_DRAFT_MAX_QUESTIONS = 400;
// Fix round 1 (I1): motivos de faltante real que justifican un borrador (otros nunca se reanudan).
var DYN_EXAM_BANK_DRAFT_REASONS = ['leaf_below_floor', 'chapter_uncovered', 'generation_failed'];
function dynExamBankDraftSupported(item) {
  var eb = item && item.claimPayload && item.claimPayload.examBank;
  return _dynIsPlainObject(eb) && eb.draftArtifactType === DYN_EXAM_BANK_DRAFT_ARTIFACT_TYPE;
}
// expect = { scope, promptVersion, planSig, chapterMdSha: { [chapterId]: sha256 } }.
// → { questions: [...] | null, artifactId: string | null, reason: null | motivo de descarte }.
async function _dynEbLoadDraft(item, expect) {
  var ref = item && _dynIsPlainObject(item.outputSummary) ? item.outputSummary.examBankDraft : null;
  if (!_dynIsPlainObject(ref) || typeof ref.artifactId !== 'string' || !ref.artifactId) return { questions: null, artifactId: null, reason: null };
  var out = { questions: null, artifactId: ref.artifactId, reason: null };
  if (ref.generation !== item.generation) { out.reason = 'generation'; return out; }
  var dl = null;
  try { dl = await _dynDownloadArtifactText(ref.artifactId); } catch (e) { dl = null; }
  if (!dl || !dl.ok) { out.reason = 'download'; return out; }
  var doc = null;
  try { doc = JSON.parse(dl.text); } catch (e) { doc = null; }
  if (!_dynIsPlainObject(doc) || doc.draftVersion !== 1 || !Array.isArray(doc.questions)) { out.reason = 'format'; return out; }
  if (DYN_EXAM_BANK_DRAFT_REASONS.indexOf(doc.reason) < 0) { out.reason = 'not_shortfall'; return out; }
  if (doc.itemKey !== item.itemKey || doc.generation !== item.generation || doc.scope !== expect.scope) { out.reason = 'item'; return out; }
  if (doc.promptVersion !== expect.promptVersion) { out.reason = 'promptVersion'; return out; }
  if (doc.planSig !== expect.planSig) { out.reason = 'plan'; return out; }
  var shas = _dynIsPlainObject(doc.chapterMdSha) ? doc.chapterMdSha : {};
  var keys = Object.keys(expect.chapterMdSha);
  if (Object.keys(shas).length !== keys.length || keys.some(function (k) { return shas[k] !== expect.chapterMdSha[k]; })) { out.reason = 'chapterMd'; return out; }
  out.questions = doc.questions.slice(0, DYN_EXAM_BANK_DRAFT_MAX_QUESTIONS);
  return out;
}

// #542 (I3): preguntas de las evaluaciones de módulo para el examen final. Fuente 1: artifacts
// dynamic_exam_bank_json en las dependencias del claim (si el Manifest hace depender el final de los
// exámenes de módulo). Fuente 2: las que este navegador generó en el mismo run (sessionStorage, mejor
// esfuerzo: el ejecutor suele hacer los exámenes de módulo antes que el final). Nunca falla el final.
var DYN_EXAM_STEMS_PREFIX = 'cursia.examStems.v1|';
var DYN_EXAM_AVOID_MAX = 12;
function _dynEbStemEntries(questions, chapterIdFallback) {
  return (questions || []).filter(function (q) { return q && (q.type === 'multichoice' || q.type === 'truefalse') && typeof q.stem === 'string'; })
    .map(function (q) { return { stem: q.stem, answer: _dynEbAnswerText(q), chapterId: q.chapterId || chapterIdFallback || null }; });
}
function _dynEbRememberModuleStems(item, moduleId, questions) {
  var st = _dynEbStorage();
  if (!st || !item.runId) return;
  try { st.setItem(DYN_EXAM_STEMS_PREFIX + item.runId + '|' + moduleId, JSON.stringify({ v: 1, stems: _dynEbStemEntries(questions) })); } catch (e) { /* sin espacio: sin memoria */ }
}
async function _dynEbLoadModuleStems(item) {
  var out = [];
  var seen = {};
  function add(list) { (list || []).forEach(function (e) { var k = dynNormalizeExamText(e.stem); if (!seen[k]) { seen[k] = true; out.push(e); } }); }
  var deps = (item.dependencyArtifacts || []).filter(function (a) { return a && a.type === DYN_EXAM_BANK_ARTIFACT_TYPE; });
  await Promise.all(deps.map(function (d) {
    return _dynDownloadArtifactText(d.artifactId).then(function (dl) {
      if (!dl || !dl.ok) return;
      try { var j = JSON.parse(dl.text); if (j && j.scope === 'module') add(_dynEbStemEntries(j.questions)); } catch (e) { /* ilegible: se ignora */ }
    }).catch(function () {});
  }));
  // Fix round 1 (m6): si el backend manda los exámenes de módulo como dependencias, son la única fuente
  // (nunca el almacenamiento del navegador).
  if (deps.length) return out;
  var st = _dynEbStorage();
  if (st && item.runId) {
    try {
      var pre = DYN_EXAM_STEMS_PREFIX + item.runId + '|';
      for (var i = 0; i < st.length; i++) {
        var k = st.key(i);
        if (k && k.indexOf(pre) === 0) { var v = JSON.parse(st.getItem(k) || 'null'); if (v && v.v === 1) add(v.stems); }
      }
    } catch (e) { /* sin memoria */ }
  }
  return out;
}
// Bloque «no repitas» del prompt del final: las preguntas de módulo del MISMO capítulo (máx. 12).
function dynExamBankAvoidBlock(stems, chapterId) {
  var list = (stems || []).filter(function (e) { return e.chapterId === chapterId; }).slice(0, DYN_EXAM_AVOID_MAX);
  if (!list.length) return '';
  return '\n\nNO REPITAS ESTAS PREGUNTAS (ya están en la evaluación del módulo): las preguntas del examen final usan OTRAS situaciones, otros datos y otra respuesta correcta.\n'
    + list.map(function (e) { return '- ' + e.stem.replace(/\s+/g, ' ').slice(0, 160); }).join('\n');
}

async function _dynRunExamBank(item) {
  var scope = item.type === 'final_exam' ? 'final' : 'module';
  var eb = item.claimPayload && item.claimPayload.examBank;
  var bp = item.blueprint || {};
  var outline = bp.outline || [];
  var courseContext = item.context && item.context.courseContext;
  var fail = function (error, retryable) { return { ok: false, error: error, retryable: retryable }; };
  // Fase 2 (motor pedagógico): estrategia de evaluación en la parte «task» (no rompe el caché del «source»).
  var ped = dynPedagogyBlock(item);
  if (!_dynIsPlainObject(eb) || eb.scope !== scope || !Array.isArray(eb.chapters) || !eb.chapters.length) {
    return fail('EXAM_BANK_CLAIM: el claim no trae examBank válido para scope ' + scope, false);
  }
  var chapters = eb.chapters.map(function (c) { return { id: c && c.chapterId, moduleId: c && c.moduleId }; });
  var plan;
  try { plan = _dynEbExpectedPlan(scope, chapters); } catch (e) { return fail((e && e.message) || String(e), false); }
  var planSig = function (p) { return (p || []).map(function (l) { return [l.chapterId, l.moduleId, l.type, l.slots].join('|'); }).join(';'); };
  if (!Array.isArray(eb.plan) || planSig(plan) !== planSig(eb.plan)) {
    return fail('EXAM_BANK_PLAN: el plan del claim no coincide con el plan calculado (' + JSON.stringify(plan) + ')', false);
  }
  var moduleId = scope === 'module' ? eb.moduleId : null;
  if (scope === 'module' && (typeof moduleId !== 'string' || chapters.some(function (c) { return c.moduleId !== moduleId; }))) {
    return fail('EXAM_BANK_CLAIM: moduleId del examen inconsistente', false);
  }

  // Markdown de cada capítulo (dependencia content:<id>). Falta → falla retryable (nunca un banco parcial).
  var md = {};
  var mdErr = null;
  await Promise.all(chapters.map(function (c) {
    var deps = (item.dependencyArtifacts || []).filter(function (a) { return a && a.type === 'dynamic_content_md' && a.itemKey === 'content:' + c.id; });
    if (deps.length !== 1) { mdErr = mdErr || 'EXAM_BANK_CHAPTER_MD_MISSING: el capítulo ' + c.id + ' llegó con ' + deps.length + ' artifacts dynamic_content_md (se esperaba 1)'; return null; }
    return _dynDownloadArtifactText(deps[0].artifactId).then(function (dl) {
      if (!dl || !dl.ok || !String(dl.text || '').trim()) mdErr = mdErr || 'EXAM_BANK_CHAPTER_MD_MISSING: no se pudo leer el texto del capítulo ' + c.id + ' (' + ((dl && dl.error) || 'vacío') + ')';
      else md[c.id] = String(dl.text);
    });
  }));
  if (mdErr) return fail(mdErr, true);
  var summaries = await _dynLoadContextSummaries(item);
  // #542 (I3): el examen final no repite las preguntas de las evaluaciones de módulo.
  var externalStems = scope === 'final' ? await _dynEbLoadModuleStems(item) : [];
  var infoCache = {};
  function chapterInfo(chId) {
    if (!Object.prototype.hasOwnProperty.call(md, chId)) return null;
    if (!infoCache[chId]) {
      var norm = dynNormalizeExamText(md[chId]);
      var tokens = {};
      dynExamTokens(norm).forEach(function (t) { tokens[t] = true; });
      // md: texto crudo para la reubicación determinística de la evidencia (BANKOPT 1b).
      infoCache[chId] = { norm: norm, tokens: tokens, md: md[chId] };
    }
    return infoCache[chId];
  }
  function outlineChapter(id) {
    var found = null;
    outline.forEach(function (mo) { (mo.chapters || []).forEach(function (c) { if (c.id === id) found = c; }); });
    return found || (bp.moduleChapters || []).filter(function (c) { return c.id === id; })[0] || { id: id, title: '' };
  }
  function outlineModule(id) {
    var mo = outline.filter(function (x) { return x.id === id; })[0] || { id: id, title: '' };
    var ids = chapters.filter(function (c) { return c.moduleId === id; }).map(function (c) { return c.id; });
    return Object.assign({}, mo, { chapters: ids.map(outlineChapter) });
  }

  // Unidades de llamada: SIEMPRE un capítulo. Módulo: las hojas del capítulo. Final: cada hoja
  // del módulo (ids deterministas, con la holgura de dynExamBankAskCount) se reparte en rangos
  // contiguos entre sus capítulos.
  var sys = dynExamBankSys();
  var maxTok = DYN_EXAM_BANK_CALL_MAX_TOKENS;
  var records = {};
  var units = [];
  var chunks = [];
  var order = 0;
  try {
    var prefixes = {};
    plan.forEach(function (leaf, li) {
      var owner = _dynEbOwnerOf(leaf);
      if (!prefixes[owner]) prefixes[owner] = scope === 'module' ? dynExamBankChapterIdPrefix(outline, outlineChapter(owner)) : dynFinalExamBankIdPrefix(outline, outlineModule(owner));
      var ids = dynExamBankLeafIds(prefixes[owner], leaf);
      var chIds = scope === 'module' ? [owner] : chapters.filter(function (c) { return c.moduleId === owner; }).map(function (c) { return c.id; });
      var base = Math.floor(ids.length / chIds.length);
      var extra = ids.length - base * chIds.length;
      var at = 0;
      chIds.forEach(function (chId, j) {
        var n = base + (j < extra ? 1 : 0);
        var unit = units.filter(function (u) { return u.chapterId === chId; })[0];
        if (!unit) { unit = { chapterId: chId, moduleId: scope === 'final' ? owner : null, prefix: prefixes[owner], seq: [] }; units.push(unit); }
        for (var k = 0; k < n; k++) {
          var id = ids[at + k];
          if (records[id]) throw new Error('EXAM_BANK_ID: id repetido ' + id);
          records[id] = { id: id, leafIndex: li, order: order++, type: leaf.type, unit: unit, status: 'missing', reasons: [{ code: 'EXAM_BANK_MISSING', message: 'no se devolvió esta pregunta' }], q: null, raw: null, combos: null, chunk: -1, repaired: false };
          unit.seq.push({ leafIndex: li, n: at + k + 1, type: leaf.type, id: id });
        }
        at += n;
      });
    });
    // Orden de unidades = orden de capítulos del examen.
    units.sort(function (a, b) { return chapters.findIndex(function (c) { return c.id === a.chapterId; }) - chapters.findIndex(function (c) { return c.id === b.chapterId; }); });
    units.forEach(function (unit) {
      dynExamBankSplitByTokens(unit.seq, DYN_EXAM_BANK_MAX_OUTPUT_EST).forEach(function (part, k) {
        var ch = { index: chunks.length, unit: unit, first: k === 0, ids: part.map(function (x) { return x.id; }) };
        ch.parts = _dynEbChunkParts(unit, part, false);
        // Fix round 1 (m6): la clave de caché usa el prompt SIN el bloque «NO REPITAS» (depende de qué exámenes
        // de módulo se conocen en ese momento); la llamada lo lleva al final (fuera del prefijo cacheado).
        ch.prompt = dynExamBankPromptText(ch.parts);
        ch.callParts = dynExamBankWithTail(ch.parts, ch.parts.tail + avoidFor(unit));
        ch.ids.forEach(function (id) { records[id].chunk = ch.index; });
        chunks.push(ch);
      });
    });
  } catch (e) {
    return fail((e && e.message) || String(e), false);
  }
  // Partes de hoja del prompt: rangos contiguos { from, count } (o ids exactos al partir en dos).
  function _dynEbChunkParts(unit, part, exactIds) {
    var parts = [];
    part.forEach(function (x) {
      var last = parts[parts.length - 1];
      if (last && last.li === x.leafIndex && (exactIds || last.from + last.count === x.n)) { last.count++; last.ids.push(x.id); return; }
      parts.push({ li: x.leafIndex, from: x.n, count: 1, ids: [x.id] });
    });
    var leaves = parts.map(function (p) {
      var leaf = Object.assign({}, plan[p.li]);
      if (exactIds) leaf.ids = p.ids; else { leaf.from = p.from; leaf.count = p.count; }
      return leaf;
    });
    var chapter = outlineChapter(unit.chapterId);
    return scope === 'module'
      ? dynExamBankChapterPromptParts(courseContext, outline, chapter, leaves, md[unit.chapterId], summaries[unit.chapterId] || null, ped)
      : dynFinalExamBankChapterPromptParts(courseContext, outline, outlineModule(unit.moduleId), chapter, leaves, md[unit.chapterId], summaries, ped);
  }
  function avoidFor(unit) {
    return scope === 'final' ? dynExamBankAvoidBlock(externalStems, unit.chapterId) : '';
  }
  function bodyBytes(parts) { return dynExamBankBodyBytes(sys, dynExamBankUserContent(parts), maxTok); }
  // Ningún cuerpo puede pasar el límite del proxy: falla ANTES de gastar (no retryable: el texto no cambia).
  var tooBig = chunks.filter(function (ch) { return bodyBytes(ch.callParts) > DYN_EXAM_BANK_MAX_BODY_BYTES; });
  if (tooBig.length) {
    return fail('EXAM_BANK_PROMPT_TOO_LARGE: el texto del capítulo ' + tooBig[0].unit.chapterId + ' no cabe en una llamada (' + bodyBytes(tooBig[0].callParts) + ' bytes > ' + DYN_EXAM_BANK_MAX_BODY_BYTES + ')', false);
  }

  var stats = { calls: { main: 0, validation_retry: 0, continuation: 0 }, promptChars: 0, outputChars: 0, repairCallsFailed: 0, repairCallsSkipped: 0, cachedChunks: 0, splitRetries: 0, evidenceRelocated: 0, relocations: [], draftChunks: 0, moneyNormalized: 0 };
  var bankMoneyCo = dynCourseIsColombia(item.context && item.context.courseContext);
  // BANKOPT (opción 2): uso real de cada respuesta (api() → metaOut.usage), incluido el caché de prompts.
  var usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, measuredCalls: 0 };
  var rejectedByCode = {};
  var droppedByCode = {};
  var cachePrefix = _dynEbCacheItemPrefix(item);
  function cacheKey(ch) { return cachePrefix + dynFnv1a32(sys + '\u0000' + ch.prompt).toString(16) + '-' + ch.ids.length; }
  function saveChunk(ch) {
    var good = ch.ids.map(function (id) { return records[id]; }).filter(function (r) { return r.status === 'valid' && r.raw; }).map(function (r) { return r.raw; });
    if (good.length) _dynEbCacheSet(cacheKey(ch), good);
  }
  function addUsage(u) {
    if (!_dynIsPlainObject(u)) return;
    var n = function (v) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0; };
    usage.input += n(u.input_tokens);
    usage.output += n(u.output_tokens);
    usage.cacheWrite += n(u.cache_creation_input_tokens);
    usage.cacheRead += n(u.cache_read_input_tokens);
    usage.measuredCalls++;
  }
  async function callJson(role, parts) {
    var meta = {};
    // Bloques con cache_control (source + task); el texto de la llamada es el de las 3 partes.
    var prompt = dynExamBankUserContent(parts);
    stats.calls[role]++;
    stats.promptChars += sys.length + dynExamBankPromptText(parts).length;
    // Rol literal en cada llamada (cobertura estática de atribución FinOps, test-rfb-executor-headers).
    var raw = role === 'main' ? await _dynV3Llm(item, 'main', sys, prompt, maxTok, meta)
      : role === 'validation_retry' ? await _dynV3Llm(item, 'validation_retry', sys, prompt, maxTok, meta)
        : await _dynV3Llm(item, 'continuation', sys, prompt, maxTok, meta);
    addUsage(meta.usage);
    stats.outputChars += String(raw || '').length;
    if (meta.stopReason === 'max_tokens') return { ok: false, truncated: true, error: 'respuesta truncada (stop_reason=max_tokens)' };
    var p = _dynV3ParseJson(raw);
    if (!p.ok) return { ok: false, error: 'JSON inválido' };
    if (!_dynIsPlainObject(p.obj) || !Array.isArray(p.obj.questions)) return { ok: false, error: 'falta la lista "questions"' };
    return { ok: true, questions: p.obj.questions };
  }
  function expectFor(rec) {
    return { id: rec.id, type: rec.type, scope: scope, chapterIds: [rec.unit.chapterId], moduleId: rec.unit.moduleId };
  }
  function ingest(list, allowed, isRepair) {
    var seen = {};
    list.forEach(function (raw) {
      var id = raw && raw.id;
      if (typeof id !== 'string' || !allowed[id] || seen[id]) { _dynEbCount(rejectedByCode, 'EXAM_BANK_UNKNOWN_ID'); return; }
      // #583 fix round 1 (m2): moneda es-CO también en el banco (el Markdown ya está normalizado, así que la evidencia
      // textual sigue coincidiendo); antes de validar, para que los límites de longitud miren el texto final.
      if (bankMoneyCo && _dynIsPlainObject(raw)) stats.moneyNormalized += dynNormalizeMoneyDeep(raw);
      seen[id] = true;
      var rec = records[id];
      var r = dynExamBankCheckQuestion(raw, expectFor(rec), chapterInfo);
      r.dropped.forEach(function (d) { _dynEbCount(droppedByCode, d.code); });
      if (r.ok) {
        if (r.evidenceRelocated) {
          stats.evidenceRelocated++;
          // Auditoría (fix round 1, C1): qué escribió el modelo y qué texto real quedó (máx. 20).
          if (stats.relocations.length < 20) stats.relocations.push({ id: id, from: String(raw.evidence).slice(0, 240), to: r.q.evidence });
        }
        // La evidencia reubicada queda en la copia guardada (caché del navegador y borrador del servidor).
        rec.status = 'valid'; rec.q = r.q; rec.raw = r.evidenceRelocated ? Object.assign({}, raw, { evidence: r.q.evidence }) : raw;
        rec.combos = r.combos; rec.reasons = []; rec.repaired = !!isRepair; rec._dupAccepted = false;
      } else {
        _dynEbCount(rejectedByCode, r.code);
        if (!(isRepair && rec.status === 'valid')) { rec.status = 'rejected'; rec.reasons = [{ code: r.code, message: r.message }]; }
      }
    });
  }
  function idSet(ids) { var o = {}; ids.forEach(function (id) { o[id] = true; }); return o; }
  function recordList() { return Object.keys(records).map(function (k) { return records[k]; }); }
  function assemble() {
    var a = dynExamBankAssemble({ plan: plan, scope: scope, seed: item.itemKey, records: recordList(), chapterIds: scope === 'final' ? chapters.map(function (c) { return c.id; }) : null, chapters: scope === 'final' ? chapters : null, externalStems: externalStems });
    a.duplicates.forEach(function (d) {
      var rec = records[d.id];
      rec.status = 'rejected'; rec.reasons = [{ code: d.code, message: d.message }];
      _dynEbCount(rejectedByCode, d.code);
    });
    a.longestDropped.forEach(function (id) { if (!records[id].countedLongest) { records[id].countedLongest = true; _dynEbCount(rejectedByCode, 'EXAM_BANK_LENGTH_BIAS'); } });
    return a;
  }

  // BANKOPT (opción 1e): borrador del intento anterior (servidor). Sus preguntas se RE-VALIDAN contra el
  // texto actual del capítulo; una parte con preguntas válidas del borrador no se vuelve a pedir: el
  // reintento solo genera lo que falta (la hoja corta) vía reparación.
  var bankPromptVersion = DYN_V3_BANK_PROMPT_VERSIONS[item.type];
  var chapterMdSha = {};
  chapters.forEach(function (c) { chapterMdSha[c.id] = dynSha256Hex(md[c.id]); });
  var draftExpect = { scope: scope, promptVersion: bankPromptVersion, planSig: planSig(plan), chapterMdSha: chapterMdSha };
  var draft = await _dynEbLoadDraft(item, draftExpect);
  var draftInfo = draft.artifactId ? { artifactId: draft.artifactId, used: !!draft.questions, ignored: draft.reason || null, questions: 0 } : null;
  if (draft.questions) {
    ingest(draft.questions, idSet(Object.keys(records)), false);
    draftInfo.questions = recordList().filter(function (r) { return r.status === 'valid'; }).length;
  }
  function chunkHasValid(ch) { return ch.ids.some(function (id) { return records[id].status === 'valid'; }); }

  // Generación: caché validada / borrador → si no, una llamada por parte; truncada → la parte se pide
  // PARTIDA EN DOS (validation_retry); JSON inválido → UN reintento del mismo tamaño.
  // BANKOPT (opción 2): la PRIMERA parte de cada capítulo sale antes que sus hermanas; las hermanas
  // esperan a que termine (su prefijo — capítulo + reglas — ya está en el caché de prompts).
  var warm = {};
  units.forEach(function (u, i) { u._key = i; var res; warm[i] = { p: new Promise(function (r) { res = r; }) }; warm[i].done = res; });
  async function runChunk(ch) {
    var cached = _dynEbCacheGet(cacheKey(ch));
    if (cached) { stats.cachedChunks++; ingest(cached, idSet(ch.ids), false); return; }
    if (draft.questions && chunkHasValid(ch)) { stats.draftChunks++; return; }
    var res = await callJson('main', ch.callParts);
    if (res.ok) { ingest(res.questions, idSet(ch.ids), false); saveChunk(ch); return; }
    console.warn('[dynExecutor:' + item.type + '] ' + item.itemKey + ' parte ' + (ch.index + 1) + ' inválida (' + res.error + ')');
    var halves = res.truncated && ch.ids.length > 1 ? [ch.ids.slice(0, Math.ceil(ch.ids.length / 2)), ch.ids.slice(Math.ceil(ch.ids.length / 2))] : [ch.ids];
    if (halves.length > 1) stats.splitRetries++;
    for (var h = 0; h < halves.length; h++) {
      var ids = halves[h];
      var parts;
      if (halves.length > 1) {
        parts = _dynEbChunkParts(ch.unit, ids.map(function (id) { var r = records[id]; return { leafIndex: r.leafIndex, n: 0, type: r.type, id: id }; }), true);
        parts = dynExamBankWithTail(parts, parts.tail + avoidFor(ch.unit));
      } else {
        parts = dynExamBankWithTail(ch.callParts, ch.callParts.tail + '\n\nTU RESPUESTA ANTERIOR NO SE PUDO USAR (' + res.error + '). Devuelve el JSON COMPLETO y válido { "questions": [...] } con todas las preguntas pedidas.');
      }
      var r2 = await callJson('validation_retry', parts);
      if (!r2.ok) throw { examBankFail: true, msg: 'EXAM_BANK_GENERATION_FAILED: la parte ' + (ch.index + 1) + '/' + chunks.length + ' (' + ids[0] + '…) falló dos veces: ' + r2.error };
      ingest(r2.questions, idSet(ids), false);
      saveChunk(ch);
    }
  }
  var ordered = chunks.filter(function (ch) { return ch.first; }).concat(chunks.filter(function (ch) { return !ch.first; }));
  try {
    await _dynExamBankPool(ordered.map(function (ch) {
      return async function () {
        var w = warm[ch.unit._key];
        if (!ch.first) await w.p;
        try { await runChunk(ch); } finally { if (ch.first) w.done(); }
      };
    }), DYN_EXAM_BANK_CONCURRENCY);
  } catch (e) {
    if (e && e.examBankFail) return failWithDraft(e.msg, 'generation_failed');
    throw e; // fatal / reintentos agotados: processItem lo clasifica (_dynMapApiError)
  }
  _dynEbCount(rejectedByCode, 'EXAM_BANK_MISSING', recordList().filter(function (r) { return r.status === 'missing'; }).length);
  if (!rejectedByCode.EXAM_BANK_MISSING) delete rejectedByCode.EXAM_BANK_MISSING;

  // Reparación: ronda 1 = hojas bajo 2·slots (+ capítulos sin preguntas en el final); ronda 2 =
  // solo hojas bajo el piso (I2). Por capítulo, UNA llamada si el pedido estimado cabe (si no,
  // una por parte); nunca más de una llamada de reparación por parte y ronda. Con la holgura,
  // solo se piden los ids que faltan para el objetivo (dynExamBankAssemble → short[].repairs).
  var a = assemble();
  for (var round = 1; round <= DYN_EXAM_BANK_REPAIR_ROUNDS; round++) {
    var entries = [];
    a.short.forEach(function (s) {
      // Ronda 2: hojas bajo el piso y (fix round 2, N3) capítulos del final bajo su mínimo en la hoja.
      if (round >= 2 && s.kept >= s.floor) { s.repairs.forEach(function (fix) { if (fix.deficit) entries.push(fix); }); return; }
      s.repairs.forEach(function (fix) { entries.push(fix); });
    });
    a.uncovered.forEach(function (chId) {
      recordList().forEach(function (r) {
        if (r.unit.chapterId === chId && r.status !== 'valid' && !entries.some(function (e) { return e.id === r.id; })) entries.push({ id: r.id });
      });
    });
    if (!entries.length) break;
    var byUnit = [];
    entries.forEach(function (fix) {
      var rec = records[fix.id];
      var reasons = rec.status === 'valid'
        ? [{ code: fix.code || 'EXAM_BANK_TF_BALANCE', message: fix.message || ('sobran afirmaciones con answer: ' + rec.q.answer + ' en esta hoja') }]
        : rec.reasons.slice();
      if (typeof fix.answer === 'boolean') reasons.push({ code: 'EXAM_BANK_TF_BALANCE', message: 'debe ser answer: ' + fix.answer });
      var g = byUnit.filter(function (x) { return x.unit === rec.unit; })[0];
      if (!g) { g = { unit: rec.unit, list: [] }; byUnit.push(g); }
      g.list.push({ id: fix.id, type: rec.type, chapterId: rec.unit.chapterId, moduleId: rec.unit.moduleId, reasons: reasons, chunk: rec.chunk });
    });
    var calls = [];
    byUnit.forEach(function (g) {
      var est = dynExamBankEstimateTokens(g.list.map(function (x) { return x.type; }));
      var groups = est <= DYN_EXAM_BANK_MAX_OUTPUT_EST ? [g.list] : chunks.filter(function (ch) { return ch.unit === g.unit; }).map(function (ch) { return g.list.filter(function (x) { return x.chunk === ch.index; }); }).filter(function (l) { return l.length; });
      groups.forEach(function (list) { calls.push({ base: chunks[list[0].chunk], list: list }); });
    });
    await _dynExamBankPool(calls.map(function (c) {
      return async function () {
        var accepted = recordList().filter(function (r) { return r.unit === c.base.unit && r.status === 'valid'; }).map(function (r) { return r.q; });
        var list = c.list.map(function (x) { return { id: x.id, type: x.type, chapterId: x.chapterId, moduleId: x.moduleId, reasons: x.reasons }; });
        // Mismo prefijo (fuente + tarea) que las partes del capítulo: lectura de caché.
        var repairParts = function (acc) { var rp = dynExamBankRepairParts(c.base.parts, list, acc); return dynExamBankWithTail(rp, rp.tail + avoidFor(c.base.unit)); };
        var parts = repairParts(accepted);
        if (bodyBytes(parts) > DYN_EXAM_BANK_MAX_BODY_BYTES) parts = repairParts([]);
        if (bodyBytes(parts) > DYN_EXAM_BANK_MAX_BODY_BYTES) { stats.repairCallsSkipped++; return; }
        var res = await callJson('continuation', parts);
        if (!res.ok) { stats.repairCallsFailed++; return; }
        ingest(res.questions, idSet(c.list.map(function (x) { return x.id; })), true);
        chunks.filter(function (ch) { return ch.unit === c.base.unit; }).forEach(saveChunk);
      };
    }), DYN_EXAM_BANK_CONCURRENCY);
    a = assemble();
  }
  var repairedCount = recordList().filter(function (r) { return r.repaired && r.status === 'valid'; }).length;

  // Borrador para un reintento (opción 1e): las preguntas VÁLIDAS de este intento. processItem lo sube
  // como artifact y lo informa en el fail; el próximo intento (este u otro navegador) solo repara.
  // Fix round 1 (I1): SOLO ante un faltante real (ids sin pregunta válida tras la selección: hoja bajo el
  // piso, capítulo del final sin preguntas por rechazos, parte que nunca volvió). Una falla de reglas de
  // banco con todas las hojas completas NO deja borrador: el reintento regenera desde cero (si no, el
  // borrador repetiría la misma falla en cada intento). `reason` queda en el borrador y se exige al usarlo.
  function failWithDraft(msg, reason) {
    var out = fail(msg, true);
    // Fix round 4 (R4): una falla VALIDADA sin faltante pide borrar el borrador anterior (null explícito);
    // las transitorias (red/LLM, subida, 409) no pasan por acá y lo conservan.
    if (DYN_EXAM_BANK_DRAFT_REASONS.indexOf(reason) < 0) { out.draftClear = true; return out; }
    var qs = recordList().filter(function (r) { return r.status === 'valid' && r.raw; }).map(function (r) { return r.raw; });
    if (qs.length) {
      var doc = { draftVersion: 1, reason: reason, itemKey: item.itemKey, generation: item.generation == null ? null : item.generation, scope: scope, promptVersion: bankPromptVersion, planSig: draftExpect.planSig, chapterMdSha: chapterMdSha, questions: qs };
      out.draft = _dynV3JsonArtifact(item, DYN_EXAM_BANK_DRAFT_ARTIFACT_TYPE, doc, (scope === 'module' ? moduleId : item.itemRunId) + '_draft').artifact;
      out.draftQuestions = qs.length;
    }
    return out;
  }

  // Pisos, cobertura y reglas de banco: nunca se sube un banco corto o sesgado.
  var below = a.perLeaf.filter(function (l) { return l.kept < l.floor; });
  var codes = Object.keys(rejectedByCode).sort().map(function (k) { return k + '×' + rejectedByCode[k]; }).join(', ');
  if (below.length) {
    return failWithDraft('EXAM_BANK_INCOMPLETE: hojas por debajo del piso tras la reparación: ' + below.map(function (l) { return l.owner + ' × ' + l.type + ' ' + l.kept + '/' + l.floor; }).join('; ') + (codes ? ' (rechazos: ' + codes + ')' : ''), 'leaf_below_floor');
  }
  var slotTotal = plan.reduce(function (t, l) { return t + l.slots; }, 0);
  if (scope === 'final' && a.uncovered.length && slotTotal >= chapters.length) {
    // Faltante real solo si el capítulo sin preguntas tiene ids sin pregunta válida (rechazos / faltantes).
    var missingInUncovered = recordList().some(function (r) { return a.uncovered.indexOf(r.unit.chapterId) >= 0 && r.status !== 'valid'; });
    return failWithDraft('EXAM_BANK_INCOMPLETE: capítulos sin ninguna pregunta en el examen final tras la reparación: ' + a.uncovered.join(', '), missingInUncovered ? 'chapter_uncovered' : null);
  }
  var doc = { bankVersion: 1, scope: scope, moduleId: moduleId, plan: plan, questions: a.questions };
  // Se declara la versión que el backend anuncia (≥ 2), sin pasar la propia: el ejecutor siempre valida con
  // la más estricta que conoce, así que declarar una versión anterior solo afloja el re-chequeo del empaque.
  // #583 fix round 0: el piso 2·slots del servidor rige solo para bancos que declaran 4 (el claim lo anuncia); el
  // ejecutor siempre arma 2·slots, así que con un backend anterior (anuncia 3) el banco igual sale completo.
  if (typeof eb.bankValidationVersion === 'number' && Number.isInteger(eb.bankValidationVersion) && eb.bankValidationVersion >= 2) {
    doc = { bankVersion: 1, bankValidationVersion: Math.min(eb.bankValidationVersion, DYN_EXAM_BANK_VALIDATION_VERSION), scope: scope, moduleId: moduleId, plan: plan, questions: a.questions };
  }
  var v = dynValidateExamBank(doc, { scope: scope, chapters: chapters, chapterMd: md });
  if (a.bankErrors.length || !v.ok) {
    var errs = a.bankErrors.concat(v.errors.slice(0, 8).map(function (x) { return x.path + ' ' + x.code + ': ' + x.message; }));
    return failWithDraft('EXAM_BANK_INCOMPLETE: el banco no cumple las reglas del contrato: ' + errs.join('; '), null);
  }
  _dynEbCacheClear(cachePrefix);
  if (scope === 'module') _dynEbRememberModuleStems(item, moduleId, a.questions);
  var art = _dynV3JsonArtifact(item, DYN_EXAM_BANK_ARTIFACT_TYPE, doc, scope === 'module' ? moduleId : item.itemRunId);
  var covered = {};
  a.questions.forEach(function (q) { covered[q.chapterId] = true; });
  var summary = {
    promptVersion: bankPromptVersion,
    scope: scope,
    moduleId: moduleId,
    slots: v.slotCount,
    bankSize: a.questions.length,
    perLeaf: a.perLeaf.map(function (l) { return { owner: l.owner, type: l.type, slots: l.slots, kept: l.kept, floor: l.floor }; }),
    rejectedByCode: rejectedByCode,
    distractorsDroppedByCode: droppedByCode,
    repaired: repairedCount,
    lengthRankHistogram: a.histogram,
    correctLongestShare: Math.round(a.correctLongestShare * 1000) / 1000,
    evidenceChecked: true,
    evidenceRelocated: stats.evidenceRelocated,
    moneyNormalized: stats.moneyNormalized,
    evidenceRelocations: stats.relocations,
    chaptersCovered: Object.keys(covered).length,
    calls: stats.calls,
    cachedChunks: stats.cachedChunks,
    splitRetries: stats.splitRetries,
    repairCallsFailed: stats.repairCallsFailed,
    repairCallsSkipped: stats.repairCallsSkipped,
    promptChars: stats.promptChars,
    outputChars: stats.outputChars,
    promptCache: { inputTokens: usage.input, outputTokens: usage.output, cacheWriteTokens: usage.cacheWrite, cacheReadTokens: usage.cacheRead, measuredCalls: usage.measuredCalls },
    bankSha256: art.sha,
    externalStems: externalStems.length // #542 (I3): preguntas de módulo que el final evitó repetir
  };
  if (draftInfo) { draftInfo.chunksSkipped = stats.draftChunks; summary.draft = draftInfo; }
  Object.assign(summary, dynPedagogySummary(item));
  return { ok: true, artifacts: [art.artifact], summary: summary };
}

async function _dynRunItemV3(item) {
  if (item.type === 'course_plan') return _dynRunCoursePlan(item);      // igual que v2
  if (item.type === 'content') return _dynRunContentV2(item);           // igual que v2 (Context Package)
  // EV6 P2 (F2): modo banco SOLO con el interruptor encendido y el claim con examBank; si no, GIFT de siempre.
  if (item.type === 'exam') return _dynExamBankModeOn(item) ? _dynRunExamBank(item) : _dynRunExam(item); // GIFT: igual que v1/v2
  if (item.type === 'course_intro') return _dynRunIntroV3(item, 'course');
  if (item.type === 'module_intro') return _dynRunIntroV3(item, 'module');
  if (item.type === 'experience') return _dynRunExperience(item);
  if (item.type === 'video_interactions') return _dynRunVideoInteractions(item);
  if (item.type === 'activity') return _dynRunActivity(item);
  if (item.type === 'final_exam') return _dynExamBankModeOn(item) ? _dynRunExamBank(item) : _dynRunFinalExam(item);
  if (item.type === 'application_activity') return _dynRunApplicationActivity(item);
  return { ok: false, error: 'tipo no soportado por el ejecutor del navegador (v3): ' + item.type, retryable: false };
}

// ════ Loop del ejecutor ════
var _dynActiveExecutor = null;

function _dynSleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

var DYN_HEARTBEAT_MS = 15000;
var DYN_LEASE_SECONDS = 120;
var DYN_POLL_MIN_MS = 1000;
var DYN_POLL_MAX_MS = 15000;
var DYN_TERMINAL_CHECK_MIN_MS = 10000; // #583 (N8): un GET del run por ejecutor cada 10 s como mucho
// EV6 DoD: `preview` (todo completado pero con componentes de vista previa) también es terminal:
// el ejecutor se detiene igual que con un run completado.
var DYN_TERMINAL_STATUSES = ['completed', 'preview', 'failed', 'cancelled'];

function dynExecutorStart(opts) {
  opts = opts || {};
  if (_dynActiveExecutor) {
    _dynActiveExecutor.stop();
  }

  var courseId = opts.courseId;
  var blueprintNumber = opts.blueprintNumber;
  var runId = opts.runId;
  var concurrency = opts.concurrency || 2;
  // REL lease de ejecución: el executorId es ESTABLE POR EQUIPO (24-backend-client.js, localStorage). El
  // servidor da el lease de ejecución del run a un solo executorId: una recarga o una pestaña de este equipo
  // siguen al instante; otro equipo espera a que venza (el claim responde `run_leased_elsewhere`).
  var executorId = (typeof opts.executorId === 'string' && opts.executorId) ||
    (typeof window.backendDynDeviceExecutorId === 'function' && (function () { try { return window.backendDynDeviceExecutorId(); } catch (e) { return null; } })()) ||
    ('browser-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));

  var stopped = false;
  // R21 — "fatal pause": a genuine irrecoverable error (auth/credit/config,
  // never an exhausted-transient-retries wrapper) in ANY lane's item must
  // not just fail that one item — it stops the WHOLE executor instance
  // (every lane, no new claims) and surfaces the real cause via
  // state.fatalError/onUpdate, instead of letting other lanes limp along or
  // (worse, the pre-R21 bug) letting legacy's shared GEN_STOPPED silently
  // poison an unrelated lane with a misleading "detenida por el usuario".
  // Resuming after a fatal pause requires an explicit new dynExecutorStart
  // call — this controller never auto-resumes.
  var fatalPauseError = null;
  var listeners = [];
  var state = {
    status: 'running',
    executorId: executorId,
    claimed: 0,
    completed: 0,
    failed: 0,
    abandoned: 0,
    lastError: null,
    lastItemKey: null,
    fatalError: null,
    // R2: rulesVersion del run (decide los tipos que se reclaman) y de dónde
    // salió ('opts' | 'run' | 'item' | 'default'); cuántos content v2 se
    // completaron con el sidecar context_summary ausente (visible, no silencioso).
    rulesVersion: null,
    rulesVersionSource: null,
    contextSummaryMissing: 0,
    // REL lease: otro equipo tiene el lease de ejecución del run ({ expiresAt }); este ejecutor no reclama
    // nada y espera (la UI muestra «Generando en otro dispositivo»). null = este ejecutor puede reclamar.
    leasedElsewhere: null
  };

  function emit() {
    listeners.forEach(function (cb) {
      try { cb(state); } catch (e) { /* listener errors never break the loop */ }
    });
  }

  // #583 (N8): cada claim vacío de CADA lane hacía un GET del run (pesado en el backend). Las lanes
  // comparten una consulta cada DYN_TERMINAL_CHECK_MIN_MS como mucho (la detección del final se atrasa
  // a lo sumo eso; el claim sigue siendo la fuente de trabajo).
  var lastTerminalCheckAt = 0;
  async function checkTerminal() {
    var nowMs = Date.now();
    if (lastTerminalCheckAt && nowMs - lastTerminalCheckAt < DYN_TERMINAL_CHECK_MIN_MS) return null;
    lastTerminalCheckAt = nowMs;
    try {
      var res = await backendDynGetRun(courseId, blueprintNumber, runId, { quiet: true });
      // Fase 2: el mismo GET dice si el run tiene Actividades de Aplicación (el próximo claim las incluye).
      if (res.ok && res.data && _dynRunHasApplication(res.data)) state.withApplication = true;
      if (res.ok && res.data && DYN_TERMINAL_STATUSES.indexOf(res.data.status) >= 0) {
        return res.data.status;
      }
    } catch (e) { /* transient GET failure -> keep polling, do not treat as terminal */ }
    return null;
  }

  // I1: path inmutable por intento (R23) — nunca sobreescribe el
  // artifact de un intento previo (Manifest viejo, ejecutor zombi, dos
  // pestañas). userId propio (RLS de storage), NO course/blueprint
  // vivos — todos vienen del claim congelado.
  function uploadClaimedArtifact(item, a) {
    var meta = {
      manifestId: item.manifestId,
      itemKey: item.itemKey,
      itemRunId: item.itemRunId,
      idempotencyKey: item.idempotencyKey,
      contextHash: item.context.contextHash,
      runId: item.runId
    };
    var uid = (window.SB_USER && window.SB_USER.id) || 'unknown';
    var extMatch = /\.([a-zA-Z0-9]+)$/.exec(a.filename || '');
    var ext = extMatch ? extMatch[1] : 'bin';
    var attemptPath = uid + '/dynamic/' + item.artifactCourseId + '/' + item.manifestId + '/' + a.type + '/' +
      item.idempotencyKey + '/a' + item.attempt + '.' + ext;
    return dynArtifactUpload(item.artifactCourseId, a.type, a.content, a.filename, a.mimeType, meta, { storagePath: attemptPath, upsert: false });
  }

  async function processItem(item) {
    var abandoned = false;
    var hbTimer = setInterval(function () {
      backendDynHeartbeat(item.itemRunId, executorId, DYN_LEASE_SECONDS).then(function (hbRes) {
        // hbRes.ok is transport-level (backendApiRequest/backendApiRequest
        // succeeded reaching the server) — the GUARD result (lease lost,
        // cancelled, wrong worker) is business-level, inside hbRes.data.ok
        // (ItemOpResult, R14). Only an explicit business-level ok:false
        // means "abandon" — a transport hiccup is handled by the transient
        // retry path below, never as an abandon.
        if (hbRes.ok && hbRes.data && hbRes.data.ok === false) {
          abandoned = true;
          clearInterval(hbTimer);
        }
      }).catch(function () {
        // network hiccup on a heartbeat is NOT the same as an explicit
        // ok:false (lease lost/cancelled) — keep trying, next heartbeat or
        // the final complete/fail call will surface a real rejection.
      });
    }, DYN_HEARTBEAT_MS);

    // A fatal pause raised by ANOTHER lane while this item was in flight
    // means: don't complete it, don't fail it either (its lease will just
    // expire and it stays reclaimable on the next explicit restart) — stop
    // cleanly, exactly like an abandoned/lease-lost item.
    function fatallyPaused() { return fatalPauseError !== null; }

    try {
      var result = await _dynRunItem(item);
      clearInterval(hbTimer);
      if (abandoned || fatallyPaused()) { state.abandoned++; emit(); return; }

      if (!result.ok) {
        // BANKOPT (opción 1e): un banco incompleto deja su borrador (preguntas válidas) para que el
        // reintento solo genere lo que falta. Mejor esfuerzo: si la subida falla, el fail va sin él.
        var failExtra = null;
        if (result.draft && result.retryable !== false && dynExamBankDraftSupported(item) && !(abandoned || fatallyPaused())) {
          try {
            var upDraft = await uploadClaimedArtifact(item, result.draft);
            if (upDraft.ok && upDraft.artifactId) failExtra = { examBankDraftArtifactId: upDraft.artifactId };
          } catch (eDraft) { /* sin borrador: el fail va sin el campo y el backend conserva el anterior */ }
        } else if (result.draftClear && dynExamBankDraftSupported(item)) {
          failExtra = { examBankDraftArtifactId: null }; // fix round 4 (R4): falla de reglas sin faltante
        }
        var failRes = failExtra
          ? await backendDynFail(item.itemRunId, executorId, result.error, result.retryable !== false, failExtra)
          : await backendDynFail(item.itemRunId, executorId, result.error, result.retryable !== false);
        // Un backend que no acepta el campo (400 por whitelist) igual registra el fail, sin borrador.
        if (failExtra && failRes && failRes.ok === false && failRes._httpStatus === 400) {
          await backendDynFail(item.itemRunId, executorId, result.error, result.retryable !== false);
        }
        state.failed++; state.lastError = result.error; emit();
        return;
      }

      // I1 (final review): un heartbeat AWAIT-eado justo antes de subir nada —
      // si la lease ya se perdió (otro ejecutor la reclamó), abortar sin subir
      // (evita que un ejecutor "zombi" suba bytes que luego nadie vincula, o
      // peor, pise el path de intento de otro). Un rechazo transporte-level
      // (red) no cuenta como abandono — solo un ok:false de negocio (R14).
      if (!(abandoned || fatallyPaused())) {
        try {
          var preUploadHb = await backendDynHeartbeat(item.itemRunId, executorId, DYN_LEASE_SECONDS);
          if (preUploadHb.ok && preUploadHb.data && preUploadHb.data.ok === false) {
            abandoned = true;
            clearInterval(hbTimer);
          }
        } catch (eHb) { /* network hiccup — no es abandono, seguimos */ }
      }
      if (abandoned || fatallyPaused()) { state.abandoned++; emit(); return; }

      var artifactIds = [];
      for (var i = 0; i < result.artifacts.length; i++) {
        if (abandoned || fatallyPaused()) { state.abandoned++; emit(); return; }
        var a = result.artifacts[i];
        var up = await uploadClaimedArtifact(item, a);
        if (!up.ok || !up.artifactId) {
          clearInterval(hbTimer);
          if (abandoned || fatallyPaused()) { state.abandoned++; emit(); return; }
          await backendDynFail(item.itemRunId, executorId, 'no se pudo subir el artifact ' + a.type + ': ' + (up.error || 'desconocido'), true);
          state.failed++; state.lastError = up.error; emit();
          return;
        }
        artifactIds.push(up.artifactId);
      }

      if (abandoned || fatallyPaused()) { state.abandoned++; emit(); return; }

      var summary = Object.assign({ contextHash: item.context.contextHash }, result.summary || {});
      var compRes = await backendDynComplete(item.itemRunId, executorId, artifactIds, summary);
      if (compRes.ok && compRes.data && compRes.data.ok !== false) {
        state.completed++;
        if (summary.contextSummary === 'missing') state.contextSummaryMissing++;
      } else {
        state.failed++;
        state.lastError = (compRes.data && compRes.data.reason) || compRes.error || 'complete_rejected';
        if (!compRes.ok && compRes._httpStatus === 409) {
          // M1 (fix wave review-rv2): el backend rechazó el complete por
          // artifacts obligatorios faltantes. Se registra el fallo en el item
          // (retryable, error visible en el run) en vez de dejarlo colgado
          // hasta que venza el lease.
          try { await backendDynFail(item.itemRunId, executorId, 'complete rechazado: ' + state.lastError, true); } catch (eF) { /* el lease vencerá igual */ }
        }
      }
      emit();
    } catch (e) {
      clearInterval(hbTimer);
      if (abandoned) { state.abandoned++; emit(); return; }
      var mapped = _dynMapApiError(e);
      try {
        await backendDynFail(item.itemRunId, executorId, mapped.msg, mapped.retryable);
      } catch (e2) { /* best-effort: the lease will expire and the item becomes reclaimable anyway */ }
      if (mapped.runPaused) {
        // No es un fallo de la parte: el run se pausó (el servidor decide). Las demás lanes se detienen al volver a reclamar.
        stopped = true;
        state.status = 'paused';
        emit();
        return;
      }
      state.failed++; state.lastError = mapped.msg; emit();
      // R21: a genuine irrecoverable error (retryable=false) pauses the
      // WHOLE executor, not just this item — every lane stops claiming
      // (checked in lane()'s loop and right after each claim/no-item
      // branch), and any item another lane is mid-flight on abandons
      // itself via fatallyPaused() above instead of completing.
      if (!mapped.retryable && !mapped.itemOnly && !fatalPauseError) {
        fatalPauseError = mapped.msg;
        stopped = true;
        state.status = 'fatal';
        state.fatalError = mapped.msg;
        // #583 fix round 2 (N1): qué parte causó la pausa (la UI reanuda solo si el servidor la reabre).
        state.fatalItem = { itemKey: item.itemKey, attempt: item.attempt == null ? null : item.attempt, generation: item.generation == null ? null : item.generation };
        emit();
      }
    }
  }

  // R2: rulesVersion del run ANTES del primer claim (decide los tipos a
  // reclamar). opts.rulesVersion explícito gana; si no, GET del run
  // (RunDto.rulesVersion, o derivado de sus items). Si el GET no responde
  // tras 3 intentos se asume 1 (lo que un backend sin v2 soporta) y queda
  // visible en state.rulesVersionSource='default'; si igual llega un item v2
  // (ClaimedItem.rulesVersion), el ejecutor pasa a reclamar tipos v2.
  // Un rulesVersion desconocido es una pausa fatal (nunca se adivina).
  function setRulesVersion(v, source) {
    if (v !== 1 && v !== 2 && v !== 3) {
      var msg = 'rulesVersion ' + v + ' no soportado por el ejecutor del navegador (origen: ' + source + ')';
      fatalPauseError = msg;
      stopped = true;
      state.status = 'fatal';
      state.fatalError = msg;
      emit();
      return;
    }
    state.rulesVersion = v;
    state.rulesVersionSource = source;
    emit();
  }

  async function resolveRulesVersion() {
    if (opts.rulesVersion !== undefined && opts.rulesVersion !== null) {
      setRulesVersion(opts.rulesVersion, 'opts');
      // Fase 2: sin GET extra (#583 N8) — el GET del run de checkTerminal descubre las Actividades de Aplicación.
      return;
    }
    for (var attempt = 0; attempt < 3 && !stopped; attempt++) {
      try {
        var res = await backendDynGetRun(courseId, blueprintNumber, runId);
        if (res && res.ok && res.data) {
          setRulesVersion(_dynRunRulesVersion(res.data), 'run');
          state.withApplication = _dynRunHasApplication(res.data);
          return;
        }
      } catch (e) { /* transitorio — reintentar */ }
      if (!stopped) await _dynSleep(DYN_POLL_MIN_MS);
    }
    if (stopped) return;
    console.warn('[dynExecutor] no se pudo leer el rulesVersion del run ' + runId + ' — se asume 1 (se corrige si llega un item v2)');
    setRulesVersion(1, 'default');
  }
  var rulesVersionReady = resolveRulesVersion();
  // REL lease fix round 1: ¿el último claim de este ejecutor fue aceptado (tiene el lease del run)?
  var heldRunLease = false;

  async function lane() {
    var backoff = DYN_POLL_MIN_MS;
    await rulesVersionReady;
    while (!stopped) {
      var claimRes;
      var sentTypes = _dynClaimTypesFor(state.rulesVersion, state.withApplication === true);
      try {
        claimRes = await backendDynClaim(runId, executorId, sentTypes, DYN_LEASE_SECONDS);
      } catch (e) {
        await _dynSleep(backoff);
        backoff = Math.min(backoff * 2, DYN_POLL_MAX_MS);
        continue;
      }
      if (stopped) return;
      if (!claimRes.ok && claimRes._httpStatus === 409 && /rules_version_mismatch/.test(String(claimRes.error || ''))) {
        // M3 (fix wave review-rv2): el backend rechaza un claim con tipos de
        // otra rulesVersion (p.ej. GET del run caído → default v1 sobre un run
        // v2). Si dice rulesVersion=2 y ESTE claim mandó tipos v1, se pasa a
        // v2 y se sigue (idempotente: otra lane pudo haberlo hecho ya);
        // cualquier otro caso es una pausa fatal VISIBLE — nunca un reintento
        // silencioso para siempre.
        var mv = /rulesVersion=(\d+)/.exec(String(claimRes.error));
        var wanted = mv ? parseInt(mv[1], 10) : null;
        // V2.1 (R11b): mismo manejo para un run v3 reclamado con tipos v1/v2.
        if (wanted === 3 && sentTypes.indexOf('experience') === -1) {
          if (state.rulesVersion !== 3) {
            console.warn('[dynExecutor] el backend indica rulesVersion=3 para el run ' + runId + ' — se pasa a reclamar tipos v3');
            state.rulesVersion = 3;
            state.rulesVersionSource = 'claim_conflict';
            emit();
          }
          continue;
        }
        if (wanted === 2 && sentTypes.indexOf('course_plan') === -1) {
          if (state.rulesVersion !== 2) {
            console.warn('[dynExecutor] el backend indica rulesVersion=2 para el run ' + runId + ' — se pasa a reclamar tipos v2');
            state.rulesVersion = 2;
            state.rulesVersionSource = 'claim_conflict';
            emit();
          }
          continue;
        }
        if (!fatalPauseError) {
          fatalPauseError = String(claimRes.error);
          stopped = true;
          state.status = 'fatal';
          state.fatalError = fatalPauseError;
          emit();
        }
        return;
      }
      if (!claimRes.ok) {
        await _dynSleep(backoff);
        backoff = Math.min(backoff * 2, DYN_POLL_MAX_MS);
        continue;
      }
      var item = claimRes.data && claimRes.data.item;
      // REL lease: el servidor rechazó el claim porque otro equipo tiene el lease de ejecución del run.
      // Esto no es una falla; el ejecutor queda a la espera sin reclamar items y, al vencer el lease, el próximo claim lo toma.
      if (!item && claimRes.data && claimRes.data.reason === 'run_leased_elsewhere') {
        var expAt = claimRes.data.leaseExpiresAt || null;
        heldRunLease = false;
        if (!state.leasedElsewhere || state.leasedElsewhere.expiresAt !== expAt) {
          state.leasedElsewhere = { expiresAt: expAt };
          emit();
        }
        var terminalL = await checkTerminal();
        if (terminalL) { stopped = true; state.status = terminalL; emit(); return; }
        if (stopped) return;
        var waitMs = DYN_POLL_MAX_MS;
        var expMs = expAt ? Date.parse(expAt) : NaN;
        if (isFinite(expMs)) waitMs = Math.max(DYN_POLL_MIN_MS, Math.min(DYN_POLL_MAX_MS, expMs - Date.now() + 500));
        await _dynSleep(waitMs);
        continue;
      }
      if (state.leasedElsewhere) { state.leasedElsewhere = null; emit(); }
      // Pausa del usuario (servidor = autoridad): no hay nada que reclamar hasta que el usuario la reanude. El
      // ejecutor se detiene (sin esperar ni reintentar); solo «Reanudar generación» lo vuelve a arrancar.
      if (!item && claimRes.data && claimRes.data.reason === 'run_paused') {
        heldRunLease = false;
        stopped = true;
        state.status = 'paused';
        emit();
        return;
      }
      // Claim aceptado (con o sin parte): el servidor dio / renovó el lease del run a este equipo.
      heldRunLease = true;
      if (!item) {
        var terminal = await checkTerminal();
        if (terminal) {
          stopped = true;
          state.status = terminal;
          emit();
          return;
        }
        if (stopped) return;
        await _dynSleep(backoff);
        backoff = Math.min(backoff * 2, DYN_POLL_MAX_MS);
        continue;
      }
      if (_dynItemRulesVersion(item) === 3 && state.rulesVersion !== 3) {
        console.warn('[dynExecutor] item v3 (' + item.itemKey + ') en un ejecutor v' + state.rulesVersion + ' — se pasa a reclamar tipos v3');
        state.rulesVersion = 3;
        state.rulesVersionSource = 'item';
      }
      if (_dynItemRulesVersion(item) === 2 && state.rulesVersion !== 2) {
        console.warn('[dynExecutor] item v2 (' + item.itemKey + ') en un ejecutor v' + state.rulesVersion + ' — se pasa a reclamar tipos v2');
        state.rulesVersion = 2;
        state.rulesVersionSource = 'item';
      }
      state.claimed++; state.lastItemKey = item.itemKey; emit();
      await processItem(item);
      // Always yield at least DYN_POLL_MIN_MS between one item and the
      // next claim, win or lose. Two reasons: (1) an item that keeps
      // failing (a persistently broken prompt/config) must never be
      // reclaimed in a zero-delay hot loop hammering the backend; (2) this
      // guarantees the event loop actually gets a turn between attempts —
      // without it, a chain of already-resolved fake-backend promises (as
      // in the harness, and in a real backend under a very fast failure)
      // can starve pending timers (heartbeats, stop()) indefinitely. Only
      // successful claims reset the backoff toward the fast end below.
      backoff = DYN_POLL_MIN_MS;
      await _dynSleep(backoff);
    }
  }

  var lanes = [];
  for (var i = 0; i < concurrency; i++) lanes.push(lane());
  Promise.all(lanes).then(function () {
    if (state.status === 'running') state.status = 'stopped';
    // REL lease fix round 1 (I1/m2): liberación explícita SOLO al detenerse de verdad (detención del usuario,
    // pausa fatal, cambio de curso, run terminado) y solo si este ejecutor tenía el lease. Nunca al cerrar /
    // recargar la página (el vencimiento es la garantía y una recarga del mismo equipo sigue al instante).
    // Si en esta pestaña ya corre otro ejecutor (mismo executorId del equipo), no se le suelta el lease.
    var other = _dynActiveExecutor && _dynActiveExecutor !== controller && _dynActiveExecutor.state && _dynActiveExecutor.state.status === 'running';
    if (heldRunLease && !other) { heldRunLease = false; controller.releaseLease(); }
    emit();
  });

  var controller = {
    state: state,
    executorId: executorId,
    runId: runId,
    stop: function () {
      stopped = true;
      if (state.status === 'running') state.status = 'stopped';
    },
    // REL lease: suelta el lease de ejecución del run (best-effort; solo al detenerse de verdad, nunca al cerrar la página).
    releaseLease: function (o) {
      if (typeof window.backendDynReleaseLease !== 'function' || !runId) return Promise.resolve(null);
      try { return Promise.resolve(window.backendDynReleaseLease(runId, executorId, o || {})).catch(function () { return null; }); } catch (e) { return Promise.resolve(null); }
    },
    onUpdate: function (cb) {
      if (typeof cb === 'function') listeners.push(cb);
    }
  };
  _dynActiveExecutor = controller;
  return controller;
}

function dynExecutorStop() {
  if (_dynActiveExecutor) {
    _dynActiveExecutor.stop();
    _dynActiveExecutor = null;
  }
}

// ════ Freeze helper — ÚNICO punto autorizado a leer D/SEL (spec §7 condición
// 1). Se llama UNA vez, al arrancar la generación dynamic desde la UI
// (Task 6b) — el resultado se envía a backendDynStartRun() y el backend lo
// congela en generation_run_contexts; el ejecutor de arriba NUNCA vuelve a
// leer D/SEL, solo lo que el claim del backend le entrega.
function dynBuildCourseContextFromCurrentFields() {
  // I3 (final review): `D` solo se refresca cuando algo más llama a
  // collect() (carga de la librería, navegación al dashboard, etc.) — sin
  // esto, freeze podía leer campos que el usuario ya editó, los defaults de
  // collect() ('Curso Virtual', 'Colombia', 'General') si nunca corrió, o el
  // `D` de OTRO curso abierto antes en la misma pestaña. Llamarlo acá
  // garantiza que el freeze siempre lea los campos del formulario TAL COMO
  // están en este instante — collect() no tiene otro efecto que reescribir
  // `D` desde el DOM (01-state.js:673), así que sigue siendo un freeze point
  // puro (condición 1: se llama una sola vez, acá, nunca desde el ejecutor).
  if (typeof collect === 'function') {
    try { collect(); } catch (e) { /* best-effort: si falla, seguimos con el D que haya */ }
  }
  var d = (typeof window !== 'undefined' && window.D) || (typeof D !== 'undefined' ? D : {}) || {};
  // Acceptance fix (Important 1): con el campo vacío collect() deja el
  // default 'Curso Virtual'; si el backend ya dio el título real, ese manda.
  var nombreEl = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('c-nombre') : null;
  var typedNombre = nombreEl && nombreEl.value ? String(nombreEl.value).trim() : '';
  // dynBackendTitle() (43) ya descarta placeholders ('Curso Virtual', 'Curso sin título').
  // Fix wave 2 (Mr5): mismo orden que la pantalla — último run, después backend.
  var backendTitle = '';
  if (!typedNombre && typeof window !== 'undefined') {
    // #583 (N5): solo el run del curso ACTIVO (DYNGEN.run puede seguir siendo el del curso anterior
    // justo después de «Nuevo curso»: su nombre nunca debe congelarse en el curso nuevo).
    var activeRun = (typeof window.dynActiveRun === 'function') ? window.dynActiveRun() : (window.DYNGEN && window.DYNGEN.run);
    if (typeof window.dynRunCourseName === 'function') backendTitle = window.dynRunCourseName(activeRun);
    if (!backendTitle && typeof window.dynBackendTitle === 'function') backendTitle = window.dynBackendTitle();
  }
  var ctx = {
    nombre: backendTitle || d.nombre || '',
    sector: d.sector || '',
    pais: d.pais || '',
    ciudad: d.ciudad || '',
    contexto: d.contexto || '',
    nivel: d.nivel || '',
    tono: d.tono || '',
    obj: d.obj || '',
    comp: d.comp || ''
  };
  if (d.prevCourse && d.prevCourse.caps && d.prevCourse.caps.length) {
    ctx.prevCourse = { nombre: d.prevCourse.nombre || '', caps: d.prevCourse.caps.slice() };
  }
  var sel = (typeof window !== 'undefined' && window.SEL) || (typeof SEL !== 'undefined' ? SEL : {}) || {};
  var catalog = (typeof SCORM_V2_TEMPLATES !== 'undefined') ? SCORM_V2_TEMPLATES : [];
  if (typeof sv2ResolveActiveTemplateIds === 'function') {
    ctx.scormTemplateIds = sv2ResolveActiveTemplateIds(sel.scormTemplates, catalog);
  }
  return ctx;
}

if (typeof window !== 'undefined') {
  window.dynExecutorStart = dynExecutorStart;
  window.dynExecutorStop = dynExecutorStop;
  window.dynBuildCourseContextFromCurrentFields = dynBuildCourseContextFromCurrentFields;
}
