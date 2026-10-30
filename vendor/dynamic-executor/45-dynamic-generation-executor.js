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
// Loop 6 (estimador calibrado): la generación dinámica usa SIEMPRE el modelo con el que se validó la calidad y se
// calibraron el estimador y los presupuestos (Sonnet 4.6), nunca el selector de la barra lateral (que por defecto
// muestra Haiku 4.5 y aplica a los flujos legacy). Un cambio de modelo por tarea (model routing) entra solo con
// evidencia de calidad, por este mismo punto.
var DYN_GENERATION_MODEL = 'claude-sonnet-4-6';

// Review r1 (M-1): procedencia del texto de IA de ESTE ejecutor. `real` salvo que quien inyecta un LLM falso o de
// reproducción lo declare: `window.CURSIA_LLM_MODE` ('mock' | 'replay') o la marca `api.__cursiaLlmMode` del api()
// sustituido (fixtures / harnesses / el runtime del worker). Un item no real va con `llmMode` en la metadata de sus
// artifacts y en el resumen del complete: el servidor lo clasifica como vista previa (nunca un paquete final).
function _dynExecutorLlmMode() {
  var ok = function (m) { return m === 'mock' || m === 'replay'; };
  try {
    var g = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (ok(g.CURSIA_LLM_MODE)) return g.CURSIA_LLM_MODE;
    var f = typeof api === 'function' ? api : g.api;
    if (f && ok(f.__cursiaLlmMode)) return f.__cursiaLlmMode;
  } catch (e) { /* sin entorno → real */ }
  return 'real';
}
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
async function _dynLlmCall(system, user, maxTok, maxRetries, schema, metaOut, attr, cacheOpts) {
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
          if (cacheOpts) return await api(system, user, maxTok, schema, DYN_GENERATION_MODEL, metaOut, extra || undefined, cacheOpts);
          if (extra) return await api(system, user, maxTok, schema, DYN_GENERATION_MODEL, metaOut, extra);
          return await api(system, user, maxTok, schema, DYN_GENERATION_MODEL, metaOut);
        } finally {
          usageAcc = _dynAddUsage(usageAcc, metaOut.usage);
          metaOut.usage = usageAcc;
        }
      }
      if (cacheOpts) return await api(system, user, maxTok, schema, DYN_GENERATION_MODEL, undefined, extra || undefined, cacheOpts);
      if (extra) return await api(system, user, maxTok, schema, DYN_GENERATION_MODEL, undefined, extra);
      return await api(system, user, maxTok, schema, DYN_GENERATION_MODEL);
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
// Loop 6: semillas DETERMINÍSTICAS por parte y generación. Un reintento de la MISMA generación (falla de Storage,
// lease vencido, deploy) repite exactamente el mismo prompt y el worker lo responde desde su punto de guardado (sin
// volver a generar ni cobrar); capítulos distintos siguen con semillas distintas, y una regeneración (generación
// nueva) obtiene otra semilla. Antes era Math.random(): cada reintento era un prompt nuevo y se pagaba otra vez.
function _dynItemSeed(item, salt) {
  return dynFnv1a32(String(salt) + '|' + String((item && (item.chapterId || item.itemKey)) || '') + '|' + String((item && item.generation) || 1)) / 4294967296;
}
function _dynItemRng(item, salt) {
  return _dynMulberry32(dynFnv1a32(String(salt) + '|' + String((item && (item.chapterId || item.itemKey)) || '') + '|' + String((item && item.generation) || 1)));
}
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
  var prompt = dynLibroChapterPrompt(courseContext, bp.outline, bp.chapter, bp.module, item.chapterNumber, item.moduleNumber, _dynItemSeed(item, 'libro'));
  var md = await _dynLlmCall(sys, prompt, 4096, 3, undefined, undefined, _dynAttr(item, 'main'));
  if (!md || !md.trim()) {
    return { ok: false, error: 'contenido vacío tras generación', retryable: true };
  }
  md = dynStripInternalNotes(md).text; // r60 Q-03
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
  var roomAssignment = _dynAssignRoomTemplates(templateIds, 5, _dynItemRng(item, 'scorm-rooms'));
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
// Loop 9 B: `guided_practice` también se reclama SOLO si el run lo tiene (mismo motivo que application_activity).

// Fase 2: `application_activity` se reclama SOLO si el run lo tiene (un backend anterior no conoce el tipo y
// rechazaría el claim entero): el run es la prueba de que el backend lo soporta.
function _dynRunHasApplication(run) {
  return !!(run && Array.isArray(run.items) && run.items.some(function (it) { return it && it.type === 'application_activity'; }));
}
function _dynRunHasGuidedPractice(run) {
  return !!(run && Array.isArray(run.items) && run.items.some(function (it) { return it && it.type === 'guided_practice'; }));
}
function _dynClaimTypesFor(rulesVersion, withApplication, withGuidedPractice) {
  if (rulesVersion === 3) return DYN_CLAIM_TYPES_V3.slice().concat(withApplication ? ['application_activity'] : [], withGuidedPractice ? ['guided_practice'] : []);
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

// ════ Loop 7 (O2): reparación parcial del Libro Guía (solo las oraciones señaladas) ════
var DYN_PARTIAL_REPAIR_ENABLED = true;
var DYN_SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡"«(])/g;

// Oraciones del Markdown con su posición exacta (mismo corte que dynLintContentTruth: por línea, luego por oración).
function _dynSentenceSpans(md) {
  var spans = [];
  var text = String(md || '');
  var lineStart = 0;
  text.split('\n').forEach(function (line) {
    // Review L7 (I2): el prefijo de la línea (viñeta, número de lista, cita, rótulo en negrita) queda FUERA del tramo:
    // una reparación nunca lo borra (antes «- …» perdía la viñeta y se pegaba al ítem anterior).
    var pm = /^\s*(?:(?:[-*•]|\d{1,3}[.)])\s+|>\s*)?(?:\*\*[^*\n]{1,80}\*\*\s*[:—–-]?\s*)?/.exec(line);
    var cut = pm ? pm[0].length : 0;
    var m;
    DYN_SENTENCE_SPLIT_RE.lastIndex = cut;
    var bounds = [];
    while ((m = DYN_SENTENCE_SPLIT_RE.exec(line))) { if (m.index < cut) continue; bounds.push([cut, m.index]); cut = m.index + m[0].length; }
    bounds.push([cut, line.length]);
    bounds.forEach(function (b) {
      var raw = line.slice(b[0], b[1]);
      var lead = raw.length - raw.replace(/^\s+/, '').length;
      var t = raw.trim();
      if (t) spans.push({ start: lineStart + b[0] + lead, end: lineStart + b[0] + lead + t.length, text: t, line: line });
    });
    lineStart += line.length + 1;
  });
  return spans;
}

// Cada hallazgo → UNA oración del capítulo (sin ambigüedad); null si alguna no se ubica o se repite.
function _dynLocateTruthSpans(md, hits) {
  var spans = _dynSentenceSpans(md);
  var picked = [];
  for (var i = 0; i < hits.length; i++) {
    // El hallazgo trae la oración con el prefijo de la línea («- », «1. », «**Rótulo**: »); el tramo, sin él.
    var key = String(hits[i].text || '').trim().replace(/^(?:(?:[-*•]|\d{1,3}[.)])\s+|>\s*)?(?:\*\*[^*\n]{1,80}\*\*\s*[:—–-]?\s*)?/, '');
    if (key.length < 12) return null;
    var c = spans.filter(function (s) { return s.text.indexOf(key) === 0; });
    if (c.length !== 1) return null;
    // Review L7 (I1): una oración dentro de una fila de tabla no se repara por partes (el tramo podría llevarse celdas).
    if (/^\s*\|/.test(c[0].line) || c[0].text.indexOf('|') >= 0) return null;
    var prev = picked.filter(function (p) { return p.start === c[0].start; })[0];
    if (!prev) picked.push(Object.assign({ hits: [hits[i]] }, c[0]));
    else if (!prev.hits.some(function (h) { return h.code === hits[i].code; })) prev.hits.push(hits[i]);
  }
  return picked.sort(function (a, b) { return a.start - b.start; });
}

// Lo que una reparación parcial NUNCA puede cambiar: títulos, filas de tabla, glosario, actividades y secciones.
function _dynMdInvariants(md, chapterNumber) {
  var text = String(md || '');
  var ped = dynContentPedagogy(text, chapterNumber);
  return {
    headings: text.split('\n').filter(function (l) { return /^\s*#{1,6}\s/.test(l); }).map(function (l) { return l.trim(); }).join('\n'),
    tableRows: text.split('\n').filter(function (l) { return /^\s*\|/.test(l); }).length,
    // Review L7: celdas por línea y viñetas/numeración de listas tampoco pueden cambiar.
    pipesPerLine: text.split('\n').map(function (l) { return (l.match(/\|/g) || []).length; }).join(','),
    listItems: text.split('\n').filter(function (l) { return /^\s*(?:[-*•]|\d{1,3}[.)])\s+/.test(l); }).length,
    glossaryTerms: ped.glossaryTerms, activities: ped.activities, sections: ped.sections,
  };
}

function dynContentSentenceRepairPrompt(courseContext, chapterTitle, spans) {
  var cc = courseContext || {};
  var lines = spans.map(function (s, i) {
    return (i + 1) + '. Oración: «' + s.text + '»\n   Problema: ' + s.hits.map(function (h) { return _dynTruthHitLabel(h.code, h); }).join('; ') + '\n   Párrafo donde está (solo contexto, NO lo reescribas): «' + String(s.line).trim().slice(0, 1200) + '»';
  }).join('\n\n');
  return 'Curso: "' + (cc.nombre || '') + '" | Sector: ' + (cc.sector || '') + ' | País: ' + (cc.pais || '') + '\nCapítulo: "' + (chapterTitle || '') + '"\n\n'
    + 'Estas oraciones del capítulo no son aceptables. Reescribe CADA UNA por separado para que conserve su idea y su función en el párrafo (que siga leyéndose con la oración anterior y la siguiente), pero:\n'
    + '- sin estadísticas, porcentajes, estudios, encuestas, instituciones, autores, fechas ni citas inventadas (si un número ilustra, di que es hipotético);\n'
    + '- sin rotular casos o personajes como reales;\n'
    + '- en español latinoamericano neutro con tuteo (tú): nunca voseo, «vosotros», regionalismos ni frases en inglés;\n'
    + '- UNA sola oración por reemplazo, sin saltos de línea, sin títulos (#), sin viñetas, sin tablas (|) ni markdown nuevo; misma extensión aproximada.\n\n'
    + lines
    + '\n\nResponde SOLO con JSON: {"replacements":[{"n":1,"text":"…"}, …]} con un reemplazo por cada número, en el mismo orden.';
}

/**
 * Repara SOLO las oraciones señaladas por la veracidad/idioma. Devuelve {ok:true, md, replaced} o {ok:false, reason}.
 * Invariantes (o se descarta y se usa el reintento completo): ubicación inequívoca de cada oración; un reemplazo
 * por oración, de una sola línea y sin estructura markdown; títulos, filas de tabla, glosario, actividades y
 * secciones idénticos; cambio de palabras acotado; y el capítulo resultante sin hallazgos duros.
 */
async function _dynContentPartialRepair(item, sys, md, hardHits, courseContext) {
  if (!DYN_PARTIAL_REPAIR_ENABLED) return { ok: false, reason: 'disabled' };
  // Review L7 (m2): con muchas oraciones señaladas la reparación casi nunca alcanza: directo al reintento completo.
  if (hardHits.length > 6) return { ok: false, reason: 'too_many' };
  var spans = _dynLocateTruthSpans(md, hardHits);
  if (!spans || !spans.length) return { ok: false, reason: 'locate' };
  var chapterTitle = (item.blueprint && item.blueprint.chapter && item.blueprint.chapter.title) || '';
  var raw;
  try {
    raw = await _dynLlmCall(sys, dynContentSentenceRepairPrompt(courseContext, chapterTitle, spans), 2000, 3, undefined, {}, _dynAttr(item, 'validation_retry'));
  } catch (e) {
    // Pausa, presupuesto, desconocido: se respeta igual que en el reintento completo. Reintentos de red agotados en
    // esta llamada OPCIONAL no hacen fallar la parte (review L7 m1): se sigue con el reintento completo.
    if (e && e.fatal && !DYN_EXHAUSTED_RETRIES_RE.test((e.msg || e.message || ''))) throw e;
    return { ok: false, reason: 'call' };
  }
  var obj = null;
  try { obj = JSON.parse(String(raw || '').replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/, '').trim()); } catch (e) { obj = null; }
  var reps = obj && Array.isArray(obj.replacements) ? obj.replacements : null;
  if (!reps || reps.length !== spans.length) return { ok: false, reason: 'shape' };
  var out = String(md);
  var addedWords = 0;
  var removedWords = 0;
  for (var i = spans.length - 1; i >= 0; i--) {
    var r = reps[i];
    var t = r && Number(r.n) === i + 1 && typeof r.text === 'string' ? r.text.trim() : '';
    if (!t || /[\n\r|]/.test(t) || /^\s*(?:#|[-*•]\s|\d+[.)]\s)/.test(t) || t === spans[i].text) return { ok: false, reason: 'replacement' };
    if (t.length > spans[i].text.length * 2 + 80 || t.length < Math.min(20, spans[i].text.length)) return { ok: false, reason: 'length' };
    // Review L7 (m4): una sola oración por reemplazo.
    if (/[.!?]\s+[A-ZÁÉÍÓÚÑ¿¡]/.test(t)) return { ok: false, reason: 'replacement' };
    // Review L7 (I5): un número de la oración que el capítulo vuelve a usar en otra parte tiene que seguir en el reemplazo
    // (si no, el resto del capítulo hablaría de una cifra que ya no está).
    var rest = String(md).slice(0, spans[i].start) + ' ' + String(md).slice(spans[i].end);
    // Re-review L7 (m-a): se ignoran números < 10 y años (títulos «## 3 …» y fechas no son cifras «en uso»).
    var nums = (spans[i].text.match(/\d+(?:[.,]\d+)?/g) || []).filter(function (x) { var v = Number(x.replace(',', '.')); return !(v < 10) && !/^(1[5-9]|20)\d{2}$/.test(x); });
    for (var k = 0; k < nums.length; k++) {
      var nre = new RegExp('(^|[^\\d.,])' + nums[k].replace(/[.,]/g, '[.,]') + '(?![\\d])');
      if (nre.test(rest) && t.indexOf(nums[k]) < 0) return { ok: false, reason: 'numbers' };
    }
    // Una oración que vivía en una fila de tabla tampoco puede traer el separador de celdas (ya filtrado arriba).
    out = out.slice(0, spans[i].start) + t + out.slice(spans[i].end);
    addedWords += t.split(/\s+/).length;
    removedWords += spans[i].text.split(/\s+/).length;
  }
  var before = _dynMdInvariants(md, item.chapterNumber);
  var after = _dynMdInvariants(out, item.chapterNumber);
  if (JSON.stringify(before) !== JSON.stringify(after)) return { ok: false, reason: 'invariants' };
  if (Math.abs(addedWords - removedWords) > Math.max(40, removedWords)) return { ok: false, reason: 'length' };
  out = _dynLqaFixText(out, courseContext);
  var still = dynLintContentTruth(out, courseContext).filter(function (h) { return !DYN_SOFT_LANG_CODES[h.code]; });
  if (still.length) return { ok: false, reason: 'still_flagged' };
  return { ok: true, md: out, replaced: spans.length };
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
  var v1Prompt = dynLibroChapterPrompt(courseContext, bp.outline, bp.chapter, bp.module, item.chapterNumber, item.moduleNumber, _dynItemSeed(item, 'libro'));
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
  // r60 Q-03 (review I-1): la nota interna se quita GRATIS antes de verificar (nunca dispara reparación ni reintento
  // pagados); el lint INTERNAL_NOTE queda solo como respaldo para la nota incrustada en prosa.
  var internalNotesRemoved = 0;
  var stripped = dynStripInternalNotes(ex.markdown);
  ex.markdown = stripped.text;
  internalNotesRemoved += stripped.removed;
  // R14: veracidad + tuteo. Un reintento dirigido del capítulo completo; si persiste, falla visible.
  var truthHits = dynLintContentTruth(ex.markdown, courseContext);
  var truthRetried = false;
  // #542 (M2): la concordancia de persona («lo que dijiste el cliente») es barata solo si ya hay un
  // reintento: sola no reescribe un capítulo entero (≈ 16k tokens) ni lo hace fallar; queda en el summary.
  var hardTruth = function (hs) { return hs.filter(function (h) { return !DYN_SOFT_LANG_CODES[h.code]; }); };
  var partialRepair = null;
  if (hardTruth(truthHits).length) {
    // Loop 7 (O2): primero se reparan SOLO las oraciones señaladas (~cientos de tokens en vez de reescribir el
    // capítulo, ~8k). La reparación se acepta solo si conserva intacto todo lo demás (títulos, tablas, glosario,
    // actividades, longitud) y queda limpia; si no, se sigue con el reintento completo de siempre.
    var pr = await _dynContentPartialRepair(item, sys, ex.markdown, hardTruth(truthHits), courseContext);
    if (pr.ok) {
      ex.markdown = pr.md;
      truthRetried = true;
      partialRepair = { sentences: pr.replaced };
      // Review L7 (I3): el sidecar se escribió junto con las oraciones reparadas; si repite el dato inventado se descarta
      // y se pide de nuevo (reintento barato SOLO del sidecar, sobre el capítulo ya reparado).
      if (ex.contextSummary && _dynJsonTruthHits(ex.contextSummary, courseContext).filter(function (h) { return !DYN_SOFT_LANG_CODES[h.code]; }).length) {
        ex.contextSummary = null;
        ex.status = 'missing';
        partialRepair.sidecarRegenerated = true;
      }
    } else {
      partialRepair = { fallback: pr.reason };
    }
  }
  if (hardTruth(truthHits).length && !(partialRepair && partialRepair.sentences)) {
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
    var strippedT = dynStripInternalNotes(exT.markdown); // r60 Q-03: antes del lint, gratis
    exT.markdown = strippedT.text;
    internalNotesRemoved += strippedT.removed;
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
  // r60 Q-03: una nota interna de producción nunca es texto para el estudiante (también tras la reparación parcial).
  var internalNotes = dynStripInternalNotes(contentMd);
  contentMd = internalNotes.text;
  internalNotesRemoved += internalNotes.removed;
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
    partialRepair: partialRepair,
    truthHits: truthHits.slice(0, 8)
  };
  Object.assign(summary, dynPedagogySummary(item));
  // Loop 9 (B-extra-1): variante del Libro para un capítulo con práctica guiada propia (sin «Actividades de Apoyo»).
  if (bp.chapter && typeof bp.chapter.guidedPracticeMinutes === 'number' && bp.chapter.guidedPracticeMinutes > 0) summary.libroVariant = 'guided-practice-1';
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
  if (internalNotesRemoved) summary.internalNotesRemoved = internalNotesRemoved;
  return { ok: true, artifacts: artifacts, summary: summary };
}

// ════ r60 Q-03 — notas internas de producción fuera del Libro Guía ════
// El prompt viejo pedía «■■ Nota: actividad de apoyo, opcional, no subir a Moodle.» bajo cada Actividad de
// Apoyo y llegaba al PDF del estudiante. El prompt V2 ya no lo pide; si el modelo la escribe igual, la línea
// completa de la nota se quita (determinista, contada en el summary: nunca en silencio).
// Review M-1: anclado a la forma completa de la nota («actividad de apoyo … (opcional) … no subir a Moodle»), no a
// «no subir a Moodle» suelto: un curso que enseña Moodle puede decirlo con todo derecho.
var _DYN_INTERNAL_NOTE_CORE = 'actividad(?:es)?\\s+de\\s+apoyo\\b[^\\n]{0,120}?\\bno\\s+subir\\s+a\\s+moodle\\b';
var DYN_INTERNAL_NOTE_LINE_RE = new RegExp('^[ \\t>*_\\-\\u2022\\u25a0]*(?:nota|note)\\s*:?[^\\n]*?' + _DYN_INTERNAL_NOTE_CORE + '[^\\n]*$', 'i');
var DYN_INTERNAL_NOTE_PHRASE_RE = new RegExp(_DYN_INTERNAL_NOTE_CORE, 'i');
function dynStripInternalNotes(md) {
  var removed = 0;
  var lines = String(md == null ? '' : md).split('\n').filter(function (line) {
    if (DYN_INTERNAL_NOTE_LINE_RE.test(line)) { removed++; return false; }
    return true;
  });
  return { text: removed ? lines.join('\n') : String(md == null ? '' : md), removed: removed };
}
/** true si el texto conserva la frase interna «no subir a Moodle» (chequeo determinista del Libro). */
function dynHasInternalNote(md) { return DYN_INTERNAL_NOTE_PHRASE_RE.test(String(md == null ? '' : md)); }

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
    if (DYN_INTERNAL_NOTE_PHRASE_RE.test(f)) { hits.push({ code: 'INTERNAL_NOTE', text: t200 }); special = true; } // r60 Q-03
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
  if (code === 'INTERNAL_NOTE') return 'nota interna de producción («no subir a Moodle»): no es texto para el estudiante, quítala';
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
var DYN_V3_APPLICATION_PROMPT_VERSION = 'v21-app-3'; // r79.1: tipos de actividad + nivel de 120 reforzado · r79.2: 60/90/120 proporcionales
// Loop 9 B: práctica guiada del capítulo (una pasada + el reintento dirigido).
var DYN_V3_GUIDED_PRACTICE_PROMPT_VERSION = 'v21-gp-3';
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
// Exam-bank D (#1353): evidencia por referencia [S#], pool moderado y memoria por hoja → v21-exam-5 / v21-final-7.
var DYN_V3_BANK_PROMPT_VERSIONS = { exam: 'v21-exam-5', final_exam: 'v21-final-7' };

// P3 (fix I3): el prompt v21-exp-6 (why/apply) se usa SOLO si el backend anuncia que los acepta
// (claim de la experiencia: `experienceFeatures.eduFields === true`). Con un backend anterior (deploy
// del frontend primero), el ejecutor se comporta como v21-exp-5: sin why/apply en el prompt ni en el JSON.
var DYN_V3_EXPERIENCE_PROMPT_FALLBACK = 'v21-exp-5';
function _dynExperienceEduFields(item) {
  var f = _dynClaimField(item, ['experienceFeatures']);
  return _dynIsPlainObject(f) && f.eduFields === true;
}
// T2 (r57): con requisitos del marco instruccional en el brief (solo un backend que los valida los manda), el ejecutor
// los espeja y reporta v21-exp-7: el backend los exige solo desde esa versión (frameworkRequirementsApply).
var DYN_V3_EXPERIENCE_FRAMEWORK_PROMPT = 'v21-exp-7';
function _dynExperienceFrameworkRequirements(item) {
  var p = item && item.pedagogy;
  var reqs = p && Array.isArray(p.experienceRequirements) ? p.experienceRequirements : null;
  if (!reqs || !reqs.length) return null;
  reqs.forEach(function (r) {
    if (!_dynIsPlainObject(r) || typeof r.id !== 'string' || typeof r.message !== 'string' || !Array.isArray(r.movements) || !Array.isArray(r.anyOf) || !r.movements.length || !r.anyOf.length) {
      throw new Error('PEDAGOGY_BRIEF_INVALID: requisitos del marco con forma inválida en el item ' + (item && item.itemKey));
    }
  });
  return reqs;
}
function _dynExperiencePromptVersion(item) {
  if (!_dynExperienceEduFields(item)) return DYN_V3_EXPERIENCE_PROMPT_FALLBACK;
  return _dynExperienceFrameworkRequirements(item) ? DYN_V3_EXPERIENCE_FRAMEWORK_PROMPT : DYN_V3_PROMPT_VERSIONS.experience;
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

function _dynV3Llm(item, role, sys, prompt, maxTok, metaOut, cacheOpts) {
  return _dynLlmCall(sys, prompt, maxTok, 3, undefined, metaOut, _dynLlmCallHeaders(item, role, item && item.attempt), cacheOpts);
}

// Loop 6 (O5): el prompt original de una parte se marca cacheable (sin reordenar ni cambiar texto). Su reintento
// dirigido es ese mismo prompt + los errores (dynV3RetryPrompt), y un nuevo intento de la parte repite el prompt:
// ambos leen el prefijo del caché (5 min) al 10 % del precio de entrada. Escribir el caché cuesta 1,25× la entrada
// en CADA llamada principal: solo conviene si los reintentos son frecuentes (punto de equilibrio ≈ 28 %). Tipos
// habilitados = los que en #1209 hicieron ≥ 1,8 llamadas por parte (experiencia ~2,1; video ~4,8; Actividad de
// Aplicación; actividad H5P ~1,8). El Libro Guía NO: su segunda llamada frecuente es el reintento del sidecar, con
// otro prefijo (no leería el caché); intros y plan: llamadas cortas.
var DYN_PROMPT_CACHE_ENABLED = true;
var DYN_PROMPT_CACHE_TYPES = { experience: true, video_interactions: true, application_activity: true, activity: true, guided_practice: true };
function _dynCacheOpts(prompt, itemType) {
  return DYN_PROMPT_CACHE_ENABLED && DYN_PROMPT_CACHE_TYPES[itemType] === true && typeof prompt === 'string' && prompt ? { cachePrefix: prompt } : undefined;
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

// ════ T2 (r57) — requisitos del marco instruccional (espejo de validateFrameworkRequirements, pedagogy.ts) ════
// Datos del brief (item.pedagogy.experienceRequirements): algún componente de anyOf en alguno de movements.
function dynValidateFrameworkRequirementsV3(doc, reqs) {
  var errors = [];
  if (!reqs || !reqs.length) return errors;
  var mv = (doc && doc.movements) || {};
  reqs.forEach(function (r) {
    var found = r.movements.some(function (m) {
      return (Array.isArray(mv[m]) ? mv[m] : []).some(function (c) { return c && r.anyOf.indexOf(c.type) >= 0; });
    });
    if (!found) errors.push({ path: '$.movements.' + r.movements[0], code: 'FRAMEWORK_ELEMENT_MISSING', message: r.message + ' [' + r.id + ']' });
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
// T6 (r57): regla de conjunto de las MC de video (= VIDEO_MC_* de be/src/modules/quality/answer-length-bias.ts).
var DYN_VIDEO_MC_LONGEST_MAX_SHARE = 0.3;
var DYN_VIDEO_MC_MIN_QUESTIONS = 10;
var DYN_VIDEO_MC_MIN_Z = 1.96;
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
// T6 (r57): el claim de video_interactions / activity trae las señales de los items YA completados del run
// (claimPayload.answerBiasPool, del servidor: generación vigente). Se siembran en el acumulado del run para que la
// prueba vea el CURSO aunque cada item lo genere un proceso distinto (workers del servidor, otra pestaña). El servidor
// manda sobre las entradas de otros items; la del propio item nunca viene (la excluye el claim).
function _dynBiasSeedFromClaim(item, pool) {
  var cp = item && item.claimPayload && item.claimPayload.answerBiasPool;
  if (!_dynIsPlainObject(cp) || cp.v !== 1 || !_dynIsPlainObject(cp.items)) return 0;
  var n = 0;
  Object.keys(cp.items).forEach(function (k) {
    var e = cp.items[k];
    if (k === String(item.itemKey) || !_dynIsPlainObject(e) || !Array.isArray(e.ranks) || !Array.isArray(e.tf)) return;
    var ranks = e.ranks.filter(function (x) { return _dynIsPlainObject(x) && x.m >= 2 && x.r >= 0 && x.r <= x.m - 1; }).map(function (x) { return { m: x.m, r: x.r }; });
    pool[k] = { k: typeof e.k === 'string' ? e.k : null, ranks: ranks, tf: e.tf.filter(function (v) { return typeof v === 'boolean'; }) };
    n++;
  });
  return n;
}
// Señales compactas de un item para el summary (`answerBias.signals`): el servidor las devuelve en el claim de los
// demás items del run (T6). Solo longitudes relativas y valores V/F: nunca texto.
function _dynBiasCompactSignals(kind, s) {
  return { k: kind, ranks: s.ranks.map(function (x) { return { m: x.m, r: x.r }; }), tf: s.tf.map(function (x) { return x.v; }) };
}
// Registra las señales de la respuesta ACEPTADA de un item (reemplaza las de un intento anterior del mismo item).
function dynAnswerBiasRemember(item, kind, data) {
  var key = _dynBiasRunKey(item);
  var pool = _dynBiasPool(key);
  var s = dynAnswerBiasSignals(kind, data);
  pool[String(item.itemKey)] = _dynBiasCompactSignals(kind, s);
  var st = (typeof _dynEbStorage === 'function') ? _dynEbStorage() : null;
  try { if (st) st.setItem(DYN_BIAS_POOL_PREFIX + key, JSON.stringify({ v: 1, items: pool })); } catch (e) { /* sin espacio: solo memoria */ }
}

// Prueba de un item contra el acumulado del run. → { stats, errors }.
function dynAnswerBiasTest(item, kind, data) {
  var own = dynAnswerBiasSignals(kind, data);
  var pool = _dynBiasPool(_dynBiasRunKey(item));
  _dynBiasSeedFromClaim(item, pool);
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
  // T6 (r57): regla de CONJUNTO de los videos del curso (la misma del banco de examen y del aviso del paquete,
  // video_mc_length_bias): correcta = la más larga en > 30 % de las MC de video Y por encima del azar (z > 1,96 sobre
  // Σ 1/m). Solo pide el reintento si ESTE item empuja: más del 30 % de sus MC con la correcta más larga Y más que su
  // azar (Σ 1/m del item: con 3 opciones, 1 de 3 es azar, no empuje).
  var course = null;
  if (kind === 'video_interactions' && own.ranks.length) {
    var vr = own.ranks.map(function (x) { return { m: x.m, r: x.r }; });
    Object.keys(pool).forEach(function (k) {
      if (k !== String(item.itemKey) && pool[k] && pool[k].k === 'video_interactions') vr = vr.concat(pool[k].ranks || []);
    });
    var vLongest = vr.filter(function (x) { return x.r === x.m - 1; }).length;
    var vExp = 0;
    var vVar = 0;
    vr.forEach(function (x) { var p = 1 / x.m; vExp += p; vVar += p * (1 - p); });
    var vZ = vVar > 0 ? (vLongest - vExp) / Math.sqrt(vVar) : 0;
    var ownLongest = own.ranks.filter(function (x) { return x.longest; }).length;
    var ownChance = own.ranks.reduce(function (a, x) { return a + 1 / x.m; }, 0);
    course = { mc: vr.length, correctLongest: vLongest, z: Math.round(vZ * 100) / 100 };
    var biasedCourse = vr.length >= DYN_VIDEO_MC_MIN_QUESTIONS && vLongest > DYN_VIDEO_MC_LONGEST_MAX_SHARE * vr.length && vZ > DYN_VIDEO_MC_MIN_Z;
    if (biasedCourse && ownLongest > Math.max(DYN_VIDEO_MC_LONGEST_MAX_SHARE * own.ranks.length, ownChance) && !errors.some(function (e) { return e.indexOf('[ANSWER_LENGTH_BIAS]') === 0; })) {
      var fixV = own.ranks.filter(function (x) { return x.longest; });
      errors.push('[ANSWER_LENGTH_BIAS] en los videos de este curso la respuesta correcta es la más larga en ' + vLongest + ' de ' + vr.length +
        ' preguntas (máximo 30 %): en ' + fixV.map(function (x) { return x.path; }).join(', ') + ' haz que una opción incorrecta sea igual o más larga y detallada que la correcta.');
    }
  }
  var stats = {};
  stats[kind === 'branchingscenario' ? 'decisions' : 'mc'] = own.ranks.length;
  return {
    stats: Object.assign(stats, {
      correctLongest: own.ranks.filter(function (x) { return x.longest; }).length, outliers: own.ranks.filter(function (x) { return x.outlier; }).length,
      tf: own.tf.length, tfTrue: own.tf.filter(function (x) { return x.v; }).length,
      pLength: Math.round(pLen * 10000) / 10000, pTf: Math.round(pTf * 10000) / 10000, pooledItems: pooledItems },
      course ? { course: course } : {}, { signals: _dynBiasCompactSignals(kind, own) }),
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

// r61 Q-04 — espejo de planVideoCheckpoints (backend interactive-video/plan.ts). Puro.
// Con la línea de tiempo del video (claim video.videoScenes: escenas de Videogen [{order, startSec, endSec,
// narration}]) cada pregunta se ancla al FINAL de una escena: misma cantidad que el plan equidistante;
// candidatos = ⌈fin de escena⌉ en [30, d − 15]; n crecientes, ≥ 20 s entre sí, que minimizan
// Σ|candidato − atSec equidistante| (empates → el más temprano); segmento = [atSec anterior (0), atSec].
// Sin escenas, escenas inconsistentes con la duración o sin candidatos → plan equidistante + motivo.
var DYN_VIDEO_SCENE_RULES = { maxScenes: 100, narrationMax: 360, anchorEpsilonSec: 1, durationToleranceSec: 3, durationToleranceRatio: 0.03 };
function _dynVideoScenesProblem(durationSec, scenes) {
  var R = DYN_VIDEO_SCENE_RULES;
  if (!Array.isArray(scenes) || !scenes.length) return 'no_scene_data';
  if (scenes.length > R.maxScenes) return 'too_many_scenes(' + scenes.length + ')';
  var prevEnd = 0;
  var prevOrder = -Infinity;
  for (var i = 0; i < scenes.length; i++) {
    var s = scenes[i];
    if (!_dynIsPlainObject(s)) return 'invalid_scene';
    if (!Number.isInteger(s.order) || s.order <= prevOrder) return 'invalid_scene_order';
    if (typeof s.startSec !== 'number' || typeof s.endSec !== 'number' || !isFinite(s.startSec) || !isFinite(s.endSec)) return 'invalid_scene_times';
    if (Math.abs(s.startSec - prevEnd) > 0.001 || s.endSec <= s.startSec) return 'invalid_scene_times';
    if (typeof s.narration !== 'string' || s.narration.length > R.narrationMax) return 'invalid_scene_narration';
    prevEnd = s.endSec;
    prevOrder = s.order;
  }
  var tol = Math.max(R.durationToleranceSec, durationSec * R.durationToleranceRatio);
  if (Math.abs(prevEnd - durationSec) > tol) return 'timeline_duration_mismatch(' + prevEnd.toFixed(1) + 's≠' + durationSec + 's)';
  return null;
}
function _dynAssertSceneAnchored(d, checkpoints, scenes) {
  var C = DYN_VIDEO_CHECKPOINT_RULES;
  var eps = DYN_VIDEO_SCENE_RULES.anchorEpsilonSec;
  checkpoints.forEach(function (c, i) {
    if (c.atSec < C.noInteractionFirstSec || c.atSec > d - C.noInteractionLastSec) throw _dynVideoPlanError('VIDEO_PLAN_INVARIANT', 'checkpoint ' + c.index + ' en ' + c.atSec + ' fuera de [' + C.noInteractionFirstSec + ', ' + (d - C.noInteractionLastSec) + ']');
    var anchored = scenes.some(function (s, j) {
      var nextStart = j + 1 < scenes.length ? scenes[j + 1].startSec : s.endSec;
      return c.atSec >= s.endSec - eps && c.atSec <= nextStart + eps;
    });
    if (!anchored) throw _dynVideoPlanError('VIDEO_PLAN_INVARIANT', 'checkpoint ' + c.index + ' en ' + c.atSec + ' no está anclado al final de una escena');
    if (c.atSec < c.segment[0] || c.atSec > c.segment[1]) throw _dynVideoPlanError('VIDEO_PLAN_INVARIANT', 'checkpoint ' + c.index + ' en ' + c.atSec + ' fuera de su segmento');
    if (i > 0 && c.atSec - checkpoints[i - 1].atSec < C.minGapSec) throw _dynVideoPlanError('VIDEO_PLAN_INVARIANT', 'checkpoints ' + i + ' y ' + (i + 1) + ' a menos de ' + C.minGapSec + ' s');
  });
}
// Escenas que cubre un checkpoint: las que TERMINAN (⌈fin⌉) en su segmento (inicio, atSec] — partición exacta,
// también las de < 1 s (review M-2); espejo de scenesForCheckpoint.
function dynScenesForCheckpoint(checkpoint, scenes) {
  var s0 = Array.isArray(checkpoint.segment) ? checkpoint.segment[0] : checkpoint.segmentStart;
  return (scenes || []).filter(function (s) { var e = Math.ceil(s.endSec - 1e-6); return e > s0 && e <= checkpoint.atSec; });
}
// Review M-1/M-7: tiempos re-escalados por d/Σ (d = duración medida, sin redondear) a la línea de tiempo del MP4; espejo de scaleVideoScenes.
function dynScaleVideoScenes(durationSec, scenes) {
  var f = durationSec / scenes[scenes.length - 1].endSec;
  var at = function (x) { return Math.round(x * f * 1000) / 1000; };
  return scenes.map(function (s) { return { order: s.order, startSec: at(s.startSec), endSec: at(s.endSec), narration: s.narration }; });
}
function dynPlanVideoCheckpoints(durationSec, scenes) {
  var even = dynPlanInteractionCheckpoints(durationSec);
  if (scenes === undefined || scenes === null) return { checkpoints: even, timelineSource: 'even_spacing', timelineReason: 'no_scene_data' };
  var C = DYN_VIDEO_CHECKPOINT_RULES;
  var d = dynVideoPlanDurationSec(durationSec);
  var problem = _dynVideoScenesProblem(d, scenes);
  if (problem) return { checkpoints: even, timelineSource: 'even_spacing', timelineReason: problem };
  var lo = C.noInteractionFirstSec;
  var hi = d - C.noInteractionLastSec;
  var cand = [];
  var sc = dynScaleVideoScenes(durationSec, scenes); // review M-7: la duración MEDIDA cruda, como el servidor
  sc.forEach(function (s) {
    var b = Math.ceil(s.endSec - 1e-6);
    if (b >= lo && b <= hi && (!cand.length || b > cand[cand.length - 1])) cand.push(b);
  });
  var n = even.length;
  var m = cand.length;
  var cost = [];
  var par = [];
  for (var i = 0; i < n; i++) {
    cost.push([]);
    par.push([]);
    for (var j = 0; j < m; j++) {
      cost[i][j] = Infinity;
      par[i][j] = -1;
      var own = Math.abs(cand[j] - even[i].atSec);
      if (i === 0) { cost[i][j] = own; continue; }
      var best = Infinity;
      var bp = -1;
      for (var p = 0; p < j; p++) {
        if (cand[j] - cand[p] < C.minGapSec) break;
        if (cost[i - 1][p] < best) { best = cost[i - 1][p]; bp = p; }
      }
      if (bp >= 0) { cost[i][j] = best + own; par[i][j] = bp; }
    }
  }
  var end = -1;
  var endCost = Infinity;
  for (var k = 0; k < m; k++) if (cost[n - 1][k] < endCost) { endCost = cost[n - 1][k]; end = k; }
  if (end < 0) return { checkpoints: even, timelineSource: 'even_spacing', timelineReason: 'insufficient_scene_boundaries(' + m + '<' + n + ')' };
  var picks = new Array(n);
  for (var q = n - 1, jj = end; q >= 0; q--) { picks[q] = cand[jj]; jj = par[q][jj]; }
  var out = picks.map(function (atSec, x) { return { index: x + 1, atSec: atSec, segment: [x === 0 ? 0 : picks[x - 1], atSec] }; });
  _dynAssertSceneAnchored(d, out, sc);
  return { checkpoints: out, timelineSource: 'videogen_scenes', scenes: sc };
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

// Espejo de validateVideoInteractionsDoc (R8). expect = {videoItemKey, durationSec, schemaVersion?, videoScenes?}
// (r61 Q-04: videoScenes = línea de tiempo del claim → plan anclado a escenas; ausente → equidistante).
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
    plan = dynPlanVideoCheckpoints(expect.durationSec !== undefined ? expect.durationSec : pd, expect.videoScenes).checkpoints;
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
      return (window.r75SignStoragePath ? window.r75SignStoragePath(urlRes.bucket || 'cursia-artifacts', urlRes.storagePath, 3600) : window.SB.storage.from(urlRes.bucket || 'cursia-artifacts').createSignedUrl(urlRes.storagePath, 3600)).then(function (signRes) {
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
  var first = evaluate(await _dynV3Llm(item, 'main', sys, prompt, maxTok, meta, _dynCacheOpts(prompt, item && item.type)), meta, 1);
  if (first.ok && !first.soft.length) return { ok: true, value: first.value, retried: false, firstErrors: [], softWarnings: [], usedAttempt: 1, moneyNormalized: moneyBy[1] || 0 };
  var firstErrors = first.ok ? first.soft : first.errors;
  console.warn('[dynExecutor:' + item.type + '] ' + item.itemKey + (first.ok ? ' con advertencias blandas' : ' inválido') + ', reintento dirigido: ' + firstErrors.slice(0, 5).join('; '));
  var meta2 = {};
  var second = evaluate(await _dynV3Llm(item, 'validation_retry', sys, dynV3RetryPrompt(prompt, firstErrors), maxTok, meta2, _dynCacheOpts(prompt, item && item.type)), meta2, 2);
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
  // T2 (r57): requisitos del marco (solo con why/apply: el mismo backend que los valida anuncia eduFields).
  var fwReqs = eduFields ? _dynExperienceFrameworkRequirements(item) : null;
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
      if (!rep.ok) return { ok: false, errors: _dynFormatErrors(v.errors.concat(_dynIsPlainObject(obj) ? dynValidatePedagogyV3(obj).concat(dynValidateSimulatedDiagramsV3(obj), eduFields ? dynValidateEduFieldsV3(obj) : [], dynValidateFrameworkRequirementsV3(obj, fwReqs)) : [])) };
      autoRepairs = repairsBy[attempt] = autoRepairs.concat(rep.repairs);
      doc = rep.doc;
    }
    // Edu EV2: estructura educativa mínima (el backend la exige al completar el item).
    // EV6: sin decisiones aplanadas en secuencias ni diagramas dibujados con flechas (el backend los exige desde v21-exp-5).
    // P3: why/apply en ≥ 2 bloques (el backend los exige desde v21-exp-6).
    var ped = dynValidatePedagogyV3(doc).concat(dynValidateSimulatedDiagramsV3(doc), eduFields ? dynValidateEduFieldsV3(doc) : [], dynValidateFrameworkRequirementsV3(doc, fwReqs));
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
// r79.1: 2 = documento con `kind` (la de siempre «standard» o un tipo nuevo) y el nivel de 120 reforzado. Los v1 que ya
// existen siguen siendo válidos para el servidor (reglas v1); este ejecutor solo escribe v2.
var DYN_APPLICATION_SCHEMA_VERSION = 2;
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
function dynValidateApplicationStudentPart(a, minutes, schemaVersion) {
  if (!DYN_APPLICATION_EXERCISES_BY_MINUTES[minutes]) throw new Error('V3_VALIDATION_CONTEXT: Actividad de Aplicación con minutos inválidos ' + JSON.stringify(minutes));
  var sv = schemaVersion === undefined ? DYN_APPLICATION_SCHEMA_VERSION : schemaVersion;
  var sp = DYN_APPLICATION_STANDARD_SPEC[sv === 1 ? 1 : 2][minutes];
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
  var exMin = Math.max(sp.examples[0], knownGenre && DYN_APPLICATION_GENRES_REQUIRING_EXAMPLE.indexOf(genre) >= 0 ? 1 : 0);
  var examples = h.list(a.examples, '$.activity.examples', exMin, sp.examples[1]);
  examples.forEach(function (ex, i) {
    var p = '$.activity.examples[' + i + ']';
    if (!_dynIsPlainObject(ex)) return h.err(p, 'APPLICATION_SHAPE', p + ' debe ser un objeto');
    h.text(ex.title, p + '.title', L.short, 4);
    h.text(ex.problem, p + '.problem', L.text, 20);
    h.list(ex.steps, p + '.steps', 2, 10).forEach(function (st, j) { h.text(st, p + '.steps[' + j + ']', L.text, 3); });
    h.text(ex.result, p + '.result', L.text, 3);
  });
  var exercises = h.list(a.exercises, '$.activity.exercises', sp.exercises[0], sp.exercises[1]);
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
    h.list(w.instructions, '$.activity.workshop.instructions', sp.workshopInstructions[0], sp.workshopInstructions[1]).forEach(function (x, i) { h.text(x, '$.activity.workshop.instructions[' + i + ']', L.text, 8); });
    // r79.1 (v2): hitos del taller con producto intermedio (solo el nivel de 120 los lleva).
    if (sv !== 1) {
      Object.keys(w).forEach(function (k) { if (['title', 'situation', 'instructions', 'milestones'].indexOf(k) < 0) h.err('$.activity.workshop.' + k, 'APPLICATION_SHAPE', 'campo desconocido en el taller: ' + k); });
      if (sp.workshopMilestones[1] > 0) {
        h.list(w.milestones, '$.activity.workshop.milestones', sp.workshopMilestones[0], sp.workshopMilestones[1]).forEach(function (ms, i) {
          var p = '$.activity.workshop.milestones[' + i + ']';
          if (!_dynIsPlainObject(ms)) return h.err(p, 'APPLICATION_SHAPE', p + ' debe ser un objeto');
          Object.keys(ms).forEach(function (k) { if (k !== 'title' && k !== 'product') h.err(p + '.' + k, 'APPLICATION_SHAPE', 'campo desconocido en el hito: ' + k); });
          h.text(ms.title, p + '.title', L.short, 4);
          h.text(ms.product, p + '.product', L.text, 15);
        });
      } else if (w.milestones !== undefined) h.err('$.activity.workshop.milestones', 'APPLICATION_SHAPE', 'el nivel de ' + minutes + ' min no lleva hitos (solo el de 120)');
    }
  }
  var dv = a.deliverable;
  if (!_dynIsPlainObject(dv)) h.err('$.activity.deliverable', 'APPLICATION_SHAPE', 'falta el producto o evidencia');
  else {
    h.text(dv.description, '$.activity.deliverable.description', L.text, 15);
    h.text(dv.format, '$.activity.deliverable.format', L.short, 3);
    h.text(dv.extent, '$.activity.deliverable.extent', L.short, 2);
  }
  h.list(a.selfCheck, '$.activity.selfCheck', sp.selfCheck[0], sp.selfCheck[1]).forEach(function (x, i) { h.text(x, '$.activity.selfCheck[' + i + ']', L.text, 8); });
  var criteria = h.list(a.criteria, '$.activity.criteria', sp.criteria[0], sp.criteria[1]);
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
    // r79.1: pisos de minutos del nivel.
    Object.keys(sp.floors).forEach(function (k) {
      if (_dynIsInt(mbs[k]) && mbs[k] < sp.floors[k]) h.err('$.activity.minutesBySection.' + k, 'APPLICATION_SECTION_FLOOR', k + ': ' + mbs[k] + ' min; el nivel de ' + minutes + ' min exige al menos ' + sp.floors[k] + ' min en esta sección');
    });
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
// ── r79.1 · intérprete de los esquemas de los tipos nuevos (espejo EXACTO de validateKindValue / applyKindRule de
// course-shell/application-kinds.ts). El esquema, las cantidades y los pisos del nivel vienen en el claim (kindSpec): son
// los MISMOS datos con los que valida el servidor. Paridad: harness test-90 y check-r79-1-activity-kinds.js.
var DYN_KIND_SOLUTION_MARKERS_RE = /Solucionario|Gu[ií]a de correcci[oó]n|Respuesta:|Soluci[oó]n esperada/i;
function _dynKindAt(root, path) {
  return path.split('.').reduce(function (o, k) { return _dynIsPlainObject(o) ? o[k] : undefined; }, root);
}
function dynValidateKindValue(spec, v, path, counts, errors) {
  function err(code, message, p) { errors.push({ path: p === undefined ? path : p, code: code, message: message }); }
  function num(c, side) { return typeof c === 'number' ? c : ((counts[c.tier] || [0, 0])[side]); }
  if (spec.k === 'text') {
    var mn = typeof spec.min === 'number' ? spec.min : num(spec.min, 0);
    var mx = typeof spec.max === 'number' ? spec.max : num(spec.max, 1);
    if (typeof v !== 'string' || v.trim().length < mn) return err('APPLICATION_TEXT', path + ' debe ser un texto de al menos ' + mn + ' caracteres');
    if (v.length > mx) err('APPLICATION_TEXT_TOO_LONG', path + ' supera ' + mx + ' caracteres (' + v.length + ')');
    return;
  }
  if (spec.k === 'int') {
    if (!_dynIsInt(v) || v < spec.min || v > spec.max) err('APPLICATION_INT', path + ' debe ser un entero de ' + spec.min + ' a ' + spec.max);
    return;
  }
  if (spec.k === 'enum') {
    if (typeof v !== 'string' || spec.values.indexOf(v) < 0) err('APPLICATION_ENUM', path + ' debe ser uno de ' + spec.values.join(', '));
    return;
  }
  if (spec.k === 'texts') {
    var a = num(spec.min, 0); var b = num(spec.max, 1);
    if (!Array.isArray(v)) return err('APPLICATION_LIST', path + ' debe ser una lista');
    if (v.length < a || v.length > b) err('APPLICATION_COUNT', path + ' debe tener entre ' + a + ' y ' + b + ' elementos (tiene ' + v.length + ')');
    v.forEach(function (x, i) { dynValidateKindValue({ k: 'text', min: spec.itemMin, max: spec.itemMax }, x, path + '[' + i + ']', counts, errors); });
    return;
  }
  if (spec.k === 'list') {
    var lmin = num(spec.min, 0); var lmax = num(spec.max, 1);
    if (!Array.isArray(v)) return err('APPLICATION_LIST', path + ' debe ser una lista');
    if (v.length < lmin || v.length > lmax) err('APPLICATION_COUNT', path + ' debe tener entre ' + lmin + ' y ' + lmax + ' elementos (tiene ' + v.length + ')');
    var seen = {}; var last = -1;
    v.forEach(function (x, i) {
      var p = path + '[' + i + ']';
      dynValidateKindValue(spec.of, x, p, counts, errors);
      if (!_dynIsPlainObject(x)) return;
      if (spec.ids && x[spec.ids.key] !== spec.ids.prefix + (i + 1)) err('APPLICATION_ID', p + '.' + spec.ids.key + ' debe ser "' + spec.ids.prefix + (i + 1) + '" (en orden)', p + '.' + spec.ids.key);
      if (spec.unique) {
        var u = String(x[spec.unique] == null ? '' : x[spec.unique]).trim();
        if (u && seen[u]) err('APPLICATION_DUPLICATE', spec.unique + ' repetido: ' + u, p + '.' + spec.unique);
        seen[u] = true;
      }
      if (spec.order) {
        var d = spec.order.values.indexOf(x[spec.order.key]);
        if (d >= 0 && d < last) err('APPLICATION_ORDER', path + ': «' + spec.order.key + '» va de menor a mayor (' + spec.order.values.join(' → ') + ')', p + '.' + spec.order.key);
        if (d >= 0) last = Math.max(last, d);
      }
    });
    return;
  }
  if (spec.k === 'obj') {
    if (!_dynIsPlainObject(v)) return err('APPLICATION_SHAPE', 'falta ' + path + ' (objeto)');
    Object.keys(v).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(spec.fields, k)) err('APPLICATION_SHAPE', 'campo desconocido: ' + path + '.' + k, path + '.' + k); });
    Object.keys(spec.fields).forEach(function (k) {
      if (v[k] === undefined && spec.optional && spec.optional.indexOf(k) >= 0) return;
      dynValidateKindValue(spec.fields[k], v[k], path + '.' + k, counts, errors);
    });
  }
}
function _dynApplyKindRule(rule, root, ctx, kindSpec, errors) {
  var counts = kindSpec.counts || {};
  var p = '$.' + rule.path;
  var v = _dynKindAt(root, String(rule.path));
  if (rule.r === 'weights100') {
    if (!Array.isArray(v) || !v.length) return;
    var ws = v.map(function (c) { return _dynIsPlainObject(c) ? c.weight : null; });
    if (ws.every(function (w) { return _dynIsInt(w); })) {
      var sum = ws.reduce(function (a, b) { return a + b; }, 0);
      if (sum !== 100) errors.push({ path: p, code: 'APPLICATION_CRITERIA_WEIGHTS', message: 'los pesos de los criterios deben sumar 100 (suman ' + sum + ')' });
    }
    return;
  }
  if (rule.r === 'presence') {
    var want = ((counts[String(rule.tier)] || [0, 0])[0]) > 0;
    var has = v !== undefined;
    if (want && !has) errors.push({ path: p, code: 'APPLICATION_SHAPE', message: p + ' es obligatorio en el nivel de ' + ctx.minutes + ' min' });
    if (!want && has) errors.push({ path: p, code: 'APPLICATION_SHAPE', message: p + ' no corresponde al nivel de ' + ctx.minutes + ' min' });
    var mbs = _dynKindAt(root, 'activity.minutesBySection');
    var sec = String(rule.section);
    if (_dynIsPlainObject(mbs)) {
      if (want && mbs[sec] === undefined) errors.push({ path: '$.activity.minutesBySection.' + sec, code: 'APPLICATION_SECTION_MINUTES', message: 'falta minutesBySection.' + sec });
      if (!want && mbs[sec] !== undefined) errors.push({ path: '$.activity.minutesBySection.' + sec, code: 'APPLICATION_SECTION_MINUTES', message: 'minutesBySection.' + sec + ' no corresponde al nivel de ' + ctx.minutes + ' min' });
    }
    return;
  }
  if (rule.r === 'minutesBudget') {
    if (!_dynIsPlainObject(v)) return;
    var vals = Object.keys(v).map(function (k) { return v[k]; });
    if (!vals.every(function (x) { return _dynIsInt(x); })) return;
    var total = vals.reduce(function (a, b) { return a + b; }, 0);
    var tol = typeof kindSpec.tolerance === 'number' ? kindSpec.tolerance : 0.2;
    if (Math.abs(total - ctx.minutes) > ctx.minutes * tol) errors.push({ path: p, code: 'APPLICATION_MINUTES_BUDGET', message: 'las secciones suman ' + total + ' min; el nivel es ' + ctx.minutes + ' min (±' + Math.round(tol * 100) + ' %)' });
    var fl = kindSpec.floors || {};
    Object.keys(fl).forEach(function (sec2) {
      if (typeof v[sec2] === 'number' && v[sec2] < fl[sec2]) errors.push({ path: p + '.' + sec2, code: 'APPLICATION_SECTION_FLOOR', message: sec2 + ': ' + v[sec2] + ' min; el nivel de ' + ctx.minutes + ' min exige al menos ' + fl[sec2] + ' min de trabajo en esta sección' });
    });
    return;
  }
  if (rule.r === 'sumEquals') {
    if (!Array.isArray(v)) return;
    var wantS = _dynKindAt(root, String(rule.equals));
    var xs = v.map(function (x) { return _dynIsPlainObject(x) ? x[String(rule.key)] : null; });
    if (!xs.every(function (x) { return _dynIsInt(x); }) || !_dynIsInt(wantS)) return;
    var s2 = xs.reduce(function (a, b) { return a + b; }, 0);
    if (s2 !== wantS) errors.push({ path: p, code: 'APPLICATION_STAGE_MINUTES', message: 'las etapas suman ' + s2 + ' min y minutesBySection.' + String(rule.equals).split('.').pop() + ' dice ' + String(wantS) });
    return;
  }
  if (rule.r === 'mustInclude') {
    if (!Array.isArray(v)) return;
    var have = {};
    v.forEach(function (x) { if (_dynIsPlainObject(x)) have[x[String(rule.key)]] = true; });
    var miss = rule.values.filter(function (x) { return !have[x]; });
    if (miss.length) errors.push({ path: p, code: 'APPLICATION_LEVELS', message: p + ' debe incluir al menos una pregunta de nivel ' + miss.join(' y ') });
    return;
  }
  if (rule.r === 'covers') {
    var of = _dynKindAt(root, String(rule.of));
    if (!Array.isArray(v) || !Array.isArray(of)) return;
    var wantC = of.map(function (x) { return _dynIsPlainObject(x) ? String(x[String(rule.ofKey)] == null ? '' : x[String(rule.ofKey)]).trim() : ''; });
    if (v.length !== wantC.length) errors.push({ path: p, code: 'APPLICATION_SOLUTION_COVERAGE', message: p + ' debe tener EXACTAMENTE ' + wantC.length + ' elementos (uno por cada ' + String(rule.of).split('.').pop() + ', en orden; tiene ' + v.length + ')' });
    v.forEach(function (x, i) {
      var got = _dynIsPlainObject(x) ? String(x[String(rule.key)] == null ? '' : x[String(rule.key)]).trim() : '';
      if (i < wantC.length && got !== wantC[i]) errors.push({ path: p + '[' + i + '].' + String(rule.key), code: 'APPLICATION_SOLUTION_COVERAGE', message: p + '[' + i + '].' + String(rule.key) + ' debe ser «' + wantC[i] + '» (mismo orden)' });
    });
    return;
  }
  if (rule.r === 'outcomeRefs') {
    if (!Array.isArray(v)) return;
    var allowed = ctx.outcomeIds || [];
    if (!allowed.length) return;
    var needD = Math.min(Number(rule.minDistinct == null ? 1 : rule.minDistinct), allowed.length);
    var distinct = {}; var nd = 0;
    v.forEach(function (x) { var id = _dynIsPlainObject(x) ? x.outcomeId : null; if (typeof id === 'string' && allowed.indexOf(id) >= 0 && !distinct[id]) { distinct[id] = true; nd++; } });
    if (nd < needD) errors.push({ path: p, code: 'APPLICATION_OUTCOME_COVERAGE', message: p + ' debe citar al menos ' + needD + ' resultados distintos del capítulo (' + allowed.join(', ') + ')' });
    v.forEach(function (x, i) {
      var id = _dynIsPlainObject(x) ? x.outcomeId : undefined;
      if (typeof id === 'string' && allowed.indexOf(id) < 0) errors.push({ path: p + '[' + i + '].outcomeId', code: 'APPLICATION_OUTCOME_REF', message: p + '[' + i + '].outcomeId «' + id + '» no es un resultado de este capítulo (' + allowed.join(', ') + ')' });
    });
  }
}
// Una parte de un tipo nuevo ('student' = la actividad; 'solution' = el solucionario, que necesita la actividad).
function dynValidateKindPart(kindSpec, ctx, part, which, activity) {
  var errors = [];
  var schema = kindSpec.schema;
  var path = which === 'student' ? '$.activity' : '$.solution';
  dynValidateKindValue(which === 'student' ? schema.student : schema.solution, part, path, kindSpec.counts || {}, errors);
  if (which === 'student' && _dynIsPlainObject(part)) {
    var marker = _dynAppStrings(part).filter(function (x) { return DYN_KIND_SOLUTION_MARKERS_RE.test(x); })[0];
    if (marker !== undefined) errors.push({ path: path, code: 'APPLICATION_SOLUTION_MARKER', message: 'la actividad del estudiante no puede contener marcas de solucionario («Respuesta:», «Solución esperada», «Guía de corrección», «Solucionario»): «' + marker.slice(0, 80) + '»' });
  }
  var root = { activity: which === 'student' ? part : activity, solution: which === 'solution' ? part : undefined };
  (schema.rules || []).forEach(function (rule) {
    if (String(rule.path).indexOf(which === 'student' ? 'activity' : 'solution') !== 0) return;
    _dynApplyKindRule(rule, root, ctx, kindSpec, errors);
  });
  return errors;
}
// ctx = { chapterId, minutes, kind?, kindSpec?, outcomeIds? } (kind ausente/'standard' = la Actividad de siempre).
function dynValidateApplicationDoc(doc, ctx) {
  if (!ctx || typeof ctx.chapterId !== 'string') throw new Error('V3_VALIDATION_CONTEXT: Actividad de Aplicación sin chapterId ' + JSON.stringify(ctx));
  if (!_dynIsPlainObject(doc)) return [{ path: '$', code: 'APPLICATION_SHAPE', message: 'el documento debe ser un objeto' }];
  var kind = ctx.kind && ctx.kind !== 'standard' ? ctx.kind : null;
  var errors = [];
  if (doc.schemaVersion !== DYN_APPLICATION_SCHEMA_VERSION) { errors.push({ path: '$.schemaVersion', code: 'APPLICATION_SCHEMA_VERSION', message: 'schemaVersion debe ser ' + DYN_APPLICATION_SCHEMA_VERSION }); return errors; }
  if (doc.chapterId !== ctx.chapterId) errors.push({ path: '$.chapterId', code: 'CHAPTER_ID_MISMATCH', message: 'chapterId debe ser "' + ctx.chapterId + '"' });
  if (doc.minutes !== ctx.minutes) errors.push({ path: '$.minutes', code: 'APPLICATION_MINUTES_MISMATCH', message: 'minutes debe ser ' + ctx.minutes + ' (nivel del Manifest)' });
  if ((doc.kind === 'standard' ? null : doc.kind) !== kind) { errors.push({ path: '$.kind', code: 'APPLICATION_KIND_MISMATCH', message: 'kind debe ser "' + (kind || 'standard') + '" (tipo del Manifest)' }); return errors; }
  if (kind) {
    if (!ctx.kindSpec) throw new Error('V3_VALIDATION_CONTEXT: ' + kind + ' sin kindSpec en el claim');
    Object.keys(doc).forEach(function (k) { if (['schemaVersion', 'chapterId', 'minutes', 'kind', 'activity', 'solution'].indexOf(k) < 0) errors.push({ path: '$.' + k, code: 'APPLICATION_SHAPE', message: 'campo desconocido: ' + k }); });
    var kc = { kind: kind, minutes: ctx.minutes, outcomeIds: ctx.outcomeIds || [] };
    return errors.concat(dynValidateKindPart(ctx.kindSpec, kc, doc.activity, 'student'), dynValidateKindPart(ctx.kindSpec, kc, doc.solution, 'solution', doc.activity));
  }
  var st = dynValidateApplicationStudentPart(doc.activity, ctx.minutes, 2);
  return errors.concat(st.errors, dynValidateApplicationSolutionPart(doc.solution, st.exerciseIds, st.criteriaNames));
}
function _dynApplicationClaim(item) {
  var a = _dynClaimField(item, ['application']);
  return _dynIsPlainObject(a) ? a : null;
}

// ── O2b: borrador de la actividad del estudiante entre intentos (servidor) ──
// Mismo contrato que el borrador del banco (BANKOPT 1e): si la 1.ª pasada (actividad, la cara) quedó VALIDADA y
// la 2.ª (solucionario) falla reintentable, el ejecutor sube un artifact `dynamic_application_draft_json` con la
// actividad y lo informa en el fail (`applicationDraftArtifactId`); el backend lo verifica (dueño, tipo, itemRunId)
// y lo deja en output_summary.applicationDraft. El próximo intento (cualquier navegador o el worker) solo corre
// la 2.ª pasada SI coinciden generación, item, capítulo, minutos, schemaVersion, versión del prompt y el sha256
// del Markdown fuente EXACTO de la 1.ª pasada, `resumes` < 1, y la actividad RE-VALIDA. Si la 2.ª pasada vuelve a
// fallar tras reanudar, el fail pide borrarlo (null explícito): una actividad mala nunca atrapa los reintentos.
// Solo se manda el campo si el claim lo anuncia (`application.draftArtifactType`).
var DYN_APPLICATION_DRAFT_ARTIFACT_TYPE = 'dynamic_application_draft_json';
var DYN_APPLICATION_DRAFT_MAX_RESUMES = 1;
function dynApplicationDraftSupported(item) {
  var a = item && item.type === 'application_activity' && item.claimPayload ? item.claimPayload.application : null;
  return _dynIsPlainObject(a) && a.draftArtifactType === DYN_APPLICATION_DRAFT_ARTIFACT_TYPE;
}
// Campo del fail que lleva el borrador de ESTE item (o null si el claim no anuncia soporte).
function dynDraftFieldFor(item) {
  if (dynExamBankDraftSupported(item)) return 'examBankDraftArtifactId';
  if (dynApplicationDraftSupported(item)) return 'applicationDraftArtifactId';
  return null;
}
// expect = { chapterId, minutes, schemaVersion, promptVersion, sourceSha256 }.
// → { activity: obj | null, check: resultado del validador | null, resumes, artifactId, reason }.
async function _dynAppLoadDraft(item, expect) {
  var ref = item && _dynIsPlainObject(item.outputSummary) ? item.outputSummary.applicationDraft : null;
  var out = { activity: null, check: null, resumes: 0, artifactId: null, reason: null, attempt: null };
  if (!dynApplicationDraftSupported(item)) return out;
  if (!_dynIsPlainObject(ref) || typeof ref.artifactId !== 'string' || !ref.artifactId) return out;
  out.artifactId = ref.artifactId;
  out.attempt = typeof ref.attempt === 'number' ? ref.attempt : null;
  if (ref.generation !== item.generation) { out.reason = 'generation'; return out; }
  var dl = null;
  try { dl = await _dynDownloadArtifactText(ref.artifactId); } catch (e) { dl = null; }
  if (!dl || !dl.ok) { out.reason = 'download'; return out; }
  var doc = null;
  try { doc = JSON.parse(dl.text); } catch (e) { doc = null; }
  if (!_dynIsPlainObject(doc) || doc.draftVersion !== 1 || !_dynIsPlainObject(doc.activity)) { out.reason = 'format'; return out; }
  if (doc.itemKey !== item.itemKey || doc.generation !== item.generation || doc.chapterId !== expect.chapterId) { out.reason = 'item'; return out; }
  if (doc.minutes !== expect.minutes || doc.schemaVersion !== expect.schemaVersion || (doc.kind || 'standard') !== (expect.kind || 'standard')) { out.reason = 'shape'; return out; }
  if (doc.promptVersion !== expect.promptVersion) { out.reason = 'promptVersion'; return out; }
  if (doc.sourceSha256 !== expect.sourceSha256) { out.reason = 'sourceMd'; return out; }
  if (typeof doc.resumes !== 'number' || !(doc.resumes >= 0) || doc.resumes >= DYN_APPLICATION_DRAFT_MAX_RESUMES) { out.reason = 'resumes'; return out; }
  // Fix round 1 (3): las mismas correcciones deterministas y la misma veracidad/idioma que la 1.ª pasada
  // (_dynV3JsonWithRetry): dinero (Colombia), Language QA y, tras validar, hallazgos DUROS → corrida completa.
  // Fix round 2 (N1): cualquier excepción de estas pasadas descarta el borrador (corrida completa), nunca falla el item.
  var cc = item.context && item.context.courseContext;
  try {
    if (dynCourseIsColombia(cc)) dynNormalizeMoneyDeep(doc.activity);
    _dynLqaFixDeep(doc.activity, cc);
  } catch (e) { out.reason = 'invalid'; return out; }
  var v = null;
  try { v = expect.validateStudent ? expect.validateStudent(doc.activity) : dynValidateApplicationStudentPart(doc.activity, expect.minutes); } catch (e) { v = null; }
  if (!v || v.errors.length) { out.reason = 'invalid'; return out; }
  var hardTruth;
  try { hardTruth = _dynJsonTruthHits(doc.activity, cc).filter(function (h) { return !DYN_SOFT_LANG_CODES[h.code]; }); }
  catch (e) { out.reason = 'invalid'; return out; }
  if (hardTruth.length) { out.reason = 'truth'; return out; }
  out.activity = doc.activity;
  out.check = v;
  out.resumes = doc.resumes;
  return out;
}
// r79.2: presupuesto de salida por pasada. La Actividad de siempre de 90/120 pide 11–16 ejercicios (y su solucionario):
// con 9 000 tokens fijos el JSON se podía truncar (lección de los SCORM pesados). Los tipos nuevos no cambian (9 000).
var DYN_APPLICATION_MAX_TOKENS = { 30: 9000, 60: 10000, 90: 12000, 120: 14000 };
function _dynApplicationMaxTokens(minutes, kind) {
  if (kind) return 9000;
  return DYN_APPLICATION_MAX_TOKENS[minutes] || 9000;
}

async function _dynRunApplicationActivity(item) {
  var bp = item.blueprint || {};
  if (!item.chapterId || !bp.chapter) return { ok: false, error: 'application_activity: el claim no trae chapterId/blueprint.chapter', retryable: false };
  var app = _dynApplicationClaim(item);
  if (!app || !DYN_APPLICATION_EXERCISES_BY_MINUTES[app.minutes]) return { ok: false, error: 'claim_payload_unavailable: application_activity ' + item.itemKey + ' sin minutos válidos en el claim', retryable: false };
  if (app.schemaVersion !== DYN_APPLICATION_SCHEMA_VERSION) return { ok: false, error: 'claim_payload_unavailable: application_activity ' + item.itemKey + ' con schemaVersion ' + JSON.stringify(app.schemaVersion) + ' (este ejecutor escribe ' + DYN_APPLICATION_SCHEMA_VERSION + ')', retryable: false };
  // r79.1: tipo de la Actividad (del Manifest, vía el claim). Un tipo nuevo exige su especificación en el claim.
  var kind = app.kind && app.kind !== 'standard' ? app.kind : null;
  if (kind && (!_dynIsPlainObject(app.kindSpec) || !_dynIsPlainObject(app.kindSpec.schema) || !_dynIsPlainObject(app.kindSpec.counts))) {
    return { ok: false, error: 'claim_payload_unavailable: application_activity ' + item.itemKey + ' de tipo ' + kind + ' sin su especificación (kindSpec) en el claim', retryable: false };
  }
  var outcomeIds = Array.isArray(app.outcomes) ? app.outcomes.map(function (o) { return o && o.id; }).filter(function (x) { return typeof x === 'string'; }) : [];
  var kc = { kind: kind, minutes: app.minutes, outcomeIds: outcomeIds };
  function validateStudent(obj) {
    if (!kind) return dynValidateApplicationStudentPart(obj, app.minutes);
    return { errors: dynValidateKindPart(app.kindSpec, kc, obj, 'student'), exerciseIds: [], criteriaNames: [] };
  }
  function validateSolution(obj, activity, v1) {
    if (!kind) return dynValidateApplicationSolutionPart(obj, v1.exerciseIds, v1.criteriaNames);
    return dynValidateKindPart(app.kindSpec, kc, obj, 'solution', activity);
  }
  var src = await _dynLoadSourcesFor(item);
  if (!src.ok) return src.result;
  var sourceMd = _dynTrimAtParagraph(src.contentMd, DYN_APPLICATION_SOURCE_MAX_CHARS);
  var courseContext = item.context.courseContext;
  var chapter = Object.assign({}, bp.chapter, { id: item.chapterId });
  var sys = dynApplicationSys(courseContext);
  // O2b: borrador del intento anterior (actividad ya validada) → solo se corre la 2.ª pasada.
  var draftExpect = { chapterId: item.chapterId, minutes: app.minutes, schemaVersion: DYN_APPLICATION_SCHEMA_VERSION, promptVersion: DYN_V3_APPLICATION_PROMPT_VERSION, sourceSha256: dynSha256Hex(sourceMd), kind: kind || 'standard', validateStudent: validateStudent };
  var draft = await _dynAppLoadDraft(item, draftExpect);
  var resumed = !!draft.activity;
  // Falla validada: pide borrar el borrador anterior (null explícito; solo se manda si el claim lo anuncia).
  // Fix round 1 (2): si el borrador se ignoró por una descarga fallida (transitoria) puede ser bueno: no se borra.
  function withDraftClear(res) { if (draft.reason !== 'download') res.draftClear = true; return res; }
  function draftArtifact() {
    var draftDoc = {
      draftVersion: 1, itemKey: item.itemKey, generation: item.generation == null ? null : item.generation, chapterId: item.chapterId,
      minutes: app.minutes, schemaVersion: DYN_APPLICATION_SCHEMA_VERSION, kind: kind || 'standard', promptVersion: DYN_V3_APPLICATION_PROMPT_VERSION,
      // `resumes` nunca se incrementa: un intento reanudado nunca escribe un borrador nuevo (si falla, lo borra).
      sourceSha256: draftExpect.sourceSha256, resumes: draft.resumes, activity: activity
    };
    return _dynV3JsonArtifact(item, DYN_APPLICATION_DRAFT_ARTIFACT_TYPE, draftDoc, item.chapterId + '_draft').artifact;
  }
  var r1 = null;
  var activity, v1;
  if (resumed) {
    activity = draft.activity;
    v1 = draft.check;
  } else {
    // 1.ª pasada: actividad del estudiante.
    var prompt1 = kind
      ? dynApplicationKindActivityPrompt(courseContext, bp.outline, chapter, sourceMd, app, dynPedagogyBlock(item))
      : dynApplicationActivityPrompt(courseContext, bp.outline, chapter, sourceMd, app, dynPedagogyBlock(item));
    r1 = await _dynV3JsonWithRetry(item, sys, prompt1, _dynApplicationMaxTokens(app.minutes, kind), function (obj) {
      var v = validateStudent(obj);
      if (v.errors.length) return { ok: false, errors: _dynFormatErrors(v.errors) };
      return { ok: true, value: obj };
    }, { normalizeMoney: dynCourseIsColombia(courseContext) });
    if (!r1.ok) return withDraftClear(_dynV3Invalid(item, r1.errors, r1.truncated));
    activity = r1.value;
    v1 = validateStudent(activity);
  }
  // 2.ª pasada: solucionario docente de ESA actividad (ids y criterios fijos).
  var r2;
  try {
    var prompt2 = kind ? dynApplicationKindSolutionPrompt(courseContext, chapter, activity, sourceMd, app) : dynApplicationSolutionPrompt(courseContext, chapter, activity, sourceMd);
    r2 = await _dynV3JsonWithRetry(item, sys, prompt2, _dynApplicationMaxTokens(app.minutes, kind), function (obj) {
      var errs = validateSolution(obj, activity, v1);
      if (errs.length) return { ok: false, errors: _dynFormatErrors(errs) };
      return { ok: true, value: obj };
    }, { normalizeMoney: dynCourseIsColombia(courseContext) });
  } catch (e2) {
    // Fix round 1 (1): la 2.ª pasada LANZÓ (429/529/red/inactividad) tras una 1.ª pasada nueva y validada: el
    // borrador viaja en el error y processItem lo sube si el error es reintentable (mismas reglas de anuncio).
    // Nunca tras reanudar.
    if (!resumed && e2 && typeof e2 === 'object') { try { e2.__dynDraft = draftArtifact(); } catch (eD) { /* sin borrador */ } }
    throw e2;
  }
  if (!r2.ok) {
    var f2 = _dynV3Invalid(item, r2.errors, r2.truncated);
    // Reanudado y vuelve a fallar, o falla no reintentable → el próximo intento regenera las dos pasadas.
    if (resumed || f2.retryable === false) return withDraftClear(f2);
    f2.draft = draftArtifact();
    return f2;
  }
  // chapterId, minutos, tipo y schemaVersion los pone Cursia (nunca el LLM).
  var doc = { schemaVersion: DYN_APPLICATION_SCHEMA_VERSION, chapterId: item.chapterId, minutes: app.minutes, kind: kind || 'standard', activity: activity, solution: r2.value };
  var all = dynValidateApplicationDoc(doc, { chapterId: item.chapterId, minutes: app.minutes, kind: kind, kindSpec: app.kindSpec, outcomeIds: outcomeIds });
  if (all.length) return withDraftClear(_dynV3Invalid(item, _dynFormatErrors(all), false));
  var a = _dynV3JsonArtifact(item, 'dynamic_application_json', doc, item.chapterId);
  var counts = kind
    ? { kind: kind, criteriaCount: activity.criteria.length, outcomeIds: (activity.outcomeLinks || []).map(function (o) { return o.outcomeId; }) }
    : { genre: activity.genre, exerciseCount: activity.exercises.length, exampleCount: activity.examples.length, criteriaCount: activity.criteria.length };
  return {
    ok: true,
    artifacts: [a.artifact],
    summary: Object.assign({
      chapterId: item.chapterId, applicationSchemaVersion: DYN_APPLICATION_SCHEMA_VERSION, minutes: app.minutes
    }, counts, {
      applicationSha256: a.sha, retried: !!((r1 && r1.retried) || r2.retried), promptVersion: DYN_V3_APPLICATION_PROMPT_VERSION, contentArtifactId: src.contentArtifactId,
      resumedFromDraft: resumed
    }, resumed ? { draftResumedFromAttempt: draft.attempt } : {}, draft.artifactId ? { draft: { artifactId: draft.artifactId, used: resumed, ignored: draft.reason || null } } : {},
    src.practice ? { chapterKind: 'practice', practiceSourceChapterIds: src.sourceChapterIds } : {}, dynPedagogySummary(item))
  };
}

// ── guided_practice:<ch> (Loop 9 B · «Ejercicios guiados» del capítulo) ──
// Espejo EXACTO de course-shell/guided-practice.ts (validateGuidedPracticeDoc): el servidor re-valida el documento al
// completar el item y es autoritativo. Paridad: harness test-67 y scripts/check-guided-practice.js. Formativa y sin
// nota: sin solucionario oculto ni pesos. chapterId, minutes, ids y minutos de cada ejercicio los pone Cursia.
var DYN_GUIDED_PRACTICE_SCHEMA_VERSION = 1;
var DYN_GUIDED_PRACTICE_EXERCISES_BY_MINUTES = { 40: [20, 20], 60: [30, 30], 80: [40, 40], 120: [40, 40, 40] };
var DYN_GUIDED_PRACTICE_LIM = {
  titleMax: 90, situationMin: 300, situationMax: 1400, tasksMin: 3, tasksMax: 6, taskMin: 10, taskMax: 400,
  expectedProductMin: 10, expectedProductMax: 300, criteriaMin: 3, criteriaMax: 5, criterionNameMax: 80,
  criterionDescriptorMin: 10, criterionDescriptorMax: 300, modelAnswerMin: 450, modelAnswerMax: 2200
};
// Fix C1: pisos por minutos del ejercicio (los minutos acreditados tienen trabajo detrás). Espejo de GUIDED_PRACTICE_FLOORS.
var DYN_GUIDED_PRACTICE_FLOORS = {
  20: { situationMin: 300, tasksMin: 3, modelAnswerMin: 450, expectedProductMin: 10 },
  30: { situationMin: 550, tasksMin: 4, modelAnswerMin: 950, expectedProductMin: 20 },
  40: { situationMin: 800, tasksMin: 5, modelAnswerMin: 1400, expectedProductMin: 60 }
};
// Fix C1: consignas de solo recordar («Define», «Menciona», «Enumera», «¿Qué es…?»): cada consigna debe producir algo.
var DYN_GUIDED_PRACTICE_RECALL_TASK_RE = /^\s*(?:¿\s*)?(?:defin[ea]|mencion[ae]|enumer[ae]|nombr[ae]|list[ae]|recuerd[ae]|cit[ae]|qu[eé] es|cu[aá]l es la definici[oó]n)(?![\p{L}])/iu;
var DYN_GUIDED_PRACTICE_DOC_KEYS = ['schemaVersion', 'chapterId', 'minutes', 'exercises'];
var DYN_GUIDED_PRACTICE_EXERCISE_KEYS = ['id', 'minutes', 'kind', 'title', 'situation', 'tasks', 'expectedProduct', 'criteria', 'modelAnswer'];
var DYN_GUIDED_PRACTICE_CRITERION_KEYS = ['name', 'descriptor'];
var DYN_GUIDED_PRACTICE_RESOURCE_RE = /\bvideos? (interactivos?|del cap[ií]tulo|del curso|del m[oó]dulo)\b|\bH5P\b|\bactividad(es)? de aplicaci[oó]n\b|\bex[aá]men(es)? (del|de este) (m[oó]dulo|curso)\b|\bevaluaci[oó]n final\b|\baudiolibro\b|\bpresentaci[oó]n del cap[ií]tulo\b|\blibro gu[ií]a\b|\bSCORM\b/i;
var DYN_GUIDED_PRACTICE_SOURCE_MAX_CHARS = 16000;
// Loop 10 C1 — guardia de calidad (espejo EXACTO de GUIDED_PRACTICE_DISTINCT y sus funciones en guided-practice.ts):
// a) en el documento, 2+ tipos distintos y ninguna pareja casi igual (shingles de 3 palabras: situación ≥ 0,5 o
// consignas ≥ 0,6); b) en el curso, ningún ejercicio repite el título ni la situación (firma ≥ 0,5) de un ejercicio
// guiado de otro capítulo del run (claim `avoid.previousExercises`); c) cada consigna con una respuesta sustantiva.
var DYN_GUIDED_PRACTICE_DISTINCT = { shingleSize: 3, situationJaccard: 0.5, tasksJaccard: 0.6, signatureMax: 64, previousMax: 40, answerSegmentMin: 60, answerStubRemainderMin: 40 };
// Fix I1: solo remisiones al MATERIAL DEL CURSO que dejan < answerStubRemainderMin caracteres de respuesta propia.
// Fix M3: «2 tipos distintos» vale para 2 y 3 ejercicios (3 ejercicios con 2 tipos alcanza).
var DYN_GUIDED_PRACTICE_ANSWER_STUB_RE = /\b(?:ver|v[eé]ase|consulta(?:r)?|revisa(?:r)?)\s+(?:la|el|los|las)\s+(?:tabla|cuadro|secci[oó]n|apartado|cap[ií]tulo|texto|libro)\s+(?:del|de este|de la)\s+(?:cap[ií]tulo|texto|libro|curso|lectura)\b/i;
function dynGuidedPracticeThinReason(segment) {
  var D = DYN_GUIDED_PRACTICE_DISTINCT;
  var sg = String(segment || '').trim();
  if (sg.length < D.answerSegmentMin) return 'segmento corto (' + sg.length + ' < ' + D.answerSegmentMin + ' caracteres)';
  var m = DYN_GUIDED_PRACTICE_ANSWER_STUB_RE.exec(sg);
  if (m) {
    var rest = sg.replace(m[0], ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (rest.length < D.answerStubRemainderMin) return 'remite al material sin responder («' + m[0] + '»)';
  }
  return null;
}
function _dynGpWords(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').trim().split(' ').filter(Boolean);
}
function _dynGpShingles(t) {
  var w = _dynGpWords(t);
  var k = DYN_GUIDED_PRACTICE_DISTINCT.shingleSize;
  if (!w.length) return [];
  if (w.length < k) return [w.join(' ')];
  var seen = {}, out = [];
  for (var i = 0; i + k <= w.length; i++) { var sh = w.slice(i, i + k).join(' '); if (!seen[sh]) { seen[sh] = true; out.push(sh); } }
  return out;
}
function _dynGpUniq(xs) { var seen = {}, out = []; xs.forEach(function (x) { if (!Object.prototype.hasOwnProperty.call(seen, x)) { seen[x] = true; out.push(x); } }); return out; }
function _dynGpJaccard(a, b) {
  if (!a.length || !b.length) return 0;
  var A = _dynGpUniq(a), B = _dynGpUniq(b), inB = {};
  B.forEach(function (x) { inB[x] = true; });
  var inter = 0;
  A.forEach(function (x) { if (inB[x]) inter++; });
  return inter / (A.length + B.length - inter);
}
function _dynGpHash(s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}
function _dynGpSigHashes(sig) {
  if (typeof sig !== 'string' || !/^(?:[0-9a-f]{8})*$/.test(sig)) return [];
  var out = [];
  for (var i = 0; i < sig.length && out.length < DYN_GUIDED_PRACTICE_DISTINCT.signatureMax; i += 8) out.push(sig.slice(i, i + 8));
  return out;
}
function dynGuidedPracticeSignature(t) {
  return _dynGpUniq(_dynGpShingles(t).map(_dynGpHash)).sort().slice(0, DYN_GUIDED_PRACTICE_DISTINCT.signatureMax).join('');
}
function dynGuidedPracticeSignatureJaccard(sigA, sigB) {
  var a = _dynGpSigHashes(sigA), b = _dynGpSigHashes(sigB);
  if (!a.length || !b.length) return 0;
  var inA = {}, inB = {};
  a.forEach(function (h) { inA[h] = true; });
  b.forEach(function (h) { inB[h] = true; });
  var union = _dynGpUniq(a.concat(b)).sort().slice(0, DYN_GUIDED_PRACTICE_DISTINCT.signatureMax);
  var both = 0;
  union.forEach(function (h) { if (inA[h] && inB[h]) both++; });
  return both / union.length;
}
function dynGuidedPracticeAnswerSegments(answer, taskCount) {
  // Fix M4: solo marcas de primer nivel (mismo estilo que la 1 y sin más sangría); si no se completan, las de siempre.
  function find(strict) {
    var out = [];
    var from = 0, style = '', indent = 0;
    for (var k = 1; k <= taskCount; k++) {
      var re = new RegExp('(?:^|\\n)([ \\t]*)(?:consigna[ \\t]+)?' + k + '([.)])[ \\t]', 'gi');
      re.lastIndex = from;
      var m;
      while ((m = re.exec(answer))) {
        if (!strict || k === 1 || (m[2] === style && m[1].length <= indent)) break;
      }
      if (!m) return null;
      if (k === 1) { style = m[2]; indent = m[1].length; }
      out.push({ start: m.index, end: m.index + m[0].length });
      from = m.index + m[0].length;
    }
    return out;
  }
  var marks = find(true) || find(false);
  if (!marks) return null;
  return marks.map(function (mk, i) { return answer.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : answer.length).trim(); });
}
function dynGuidedPracticeDistinctErrors(doc) {
  var out = [];
  if (!_dynIsPlainObject(doc) || !Array.isArray(doc.exercises)) return out;
  var D = DYN_GUIDED_PRACTICE_DISTINCT;
  var xs = doc.exercises.map(function (e) { return _dynIsPlainObject(e) ? e : null; });
  var kinds = xs.map(function (e) { return e && DYN_GUIDED_PRACTICE_KINDS.indexOf(e.kind) >= 0 ? String(e.kind) : null; });
  if (xs.length >= 2 && kinds.every(function (k) { return k !== null; }) && _dynGpUniq(kinds).length < 2) {
    out.push({ path: '$.exercises', code: 'GUIDED_PRACTICE_KIND_REPEATED', message: 'los ' + xs.length + ' ejercicios son del mismo tipo (' + kinds[0] + '): usa al menos 2 tipos distintos (' + DYN_GUIDED_PRACTICE_KINDS.join(', ') + ')' });
  }
  var sit = xs.map(function (e) { return e ? _dynGpShingles(e.situation) : []; });
  var tasks = xs.map(function (e) { return e && Array.isArray(e.tasks) ? _dynGpUniq([].concat.apply([], e.tasks.map(function (t) { return _dynGpShingles(t); }))) : []; });
  var titles = xs.map(function (e) { return e ? _dynNormTitle(e.title) : ''; });
  for (var j = 1; j < xs.length; j++) {
    if (!xs[j]) continue;
    for (var i = 0; i < j; i++) {
      if (!xs[i]) continue;
      var p = '$.exercises[' + j + ']';
      if (titles[j] && titles[j] === titles[i]) { out.push({ path: p + '.title', code: 'GUIDED_PRACTICE_DUPLICATE', message: p + '.title repite el título del ejercicio ' + (i + 1) + ': cada ejercicio es una situación distinta' }); break; }
      var js = _dynGpJaccard(sit[i], sit[j]);
      if (js >= D.situationJaccard) { out.push({ path: p + '.situation', code: 'GUIDED_PRACTICE_DUPLICATE', message: p + '.situation es casi igual a la del ejercicio ' + (i + 1) + ' (similitud ' + js.toFixed(2) + '): usa otra situación, con otras personas y otro problema' }); break; }
      var jt = _dynGpJaccard(tasks[i], tasks[j]);
      if (jt >= D.tasksJaccard) { out.push({ path: p + '.tasks', code: 'GUIDED_PRACTICE_DUPLICATE', message: p + '.tasks son casi iguales a las del ejercicio ' + (i + 1) + ' (similitud ' + jt.toFixed(2) + '): cada ejercicio pide un trabajo distinto' }); break; }
    }
  }
  return out;
}
function dynGuidedPracticeRunClashes(doc, avoid) {
  var out = [];
  var prev = _dynIsPlainObject(avoid) && Array.isArray(avoid.previousExercises) ? avoid.previousExercises.slice(0, DYN_GUIDED_PRACTICE_DISTINCT.previousMax) : [];
  if (!prev.length || !_dynIsPlainObject(doc) || !Array.isArray(doc.exercises)) return out;
  var prevTitles = prev.map(function (x) { return _dynIsPlainObject(x) ? _dynNormTitle(x.title) : ''; });
  doc.exercises.forEach(function (e, i) {
    if (!_dynIsPlainObject(e)) return;
    var p = '$.exercises[' + i + ']';
    var nt = _dynNormTitle(e.title);
    var k = nt ? prevTitles.indexOf(nt) : -1;
    if (k >= 0) { out.push({ path: p + '.title', code: 'GUIDED_PRACTICE_RUN_DUPLICATE', message: p + '.title repite un ejercicio guiado de otro capítulo del curso («' + prev[k].title + '»): usa otra situación y otro título' }); return; }
    var sig = dynGuidedPracticeSignature(e.situation);
    for (var q = 0; q < prev.length; q++) {
      var x = prev[q];
      if (!_dynIsPlainObject(x)) continue;
      var jj = dynGuidedPracticeSignatureJaccard(sig, x.sig);
      if (jj >= DYN_GUIDED_PRACTICE_DISTINCT.situationJaccard) { out.push({ path: p + '.situation', code: 'GUIDED_PRACTICE_RUN_DUPLICATE', message: p + '.situation es casi igual a la de un ejercicio guiado de otro capítulo del curso («' + x.title + '», similitud ' + jj.toFixed(2) + '): usa otra situación' }); return; }
    }
  });
  return out;
}
function dynGuidedPracticePlan(minutes) {
  var m = DYN_GUIDED_PRACTICE_EXERCISES_BY_MINUTES[minutes];
  if (!m) throw new Error('V3_VALIDATION_CONTEXT: práctica guiada con minutos inválidos ' + JSON.stringify(minutes));
  return m.map(function (x, i) { return { id: 'E' + (i + 1), minutes: x }; });
}
function dynGuidedPracticeAnswerCoversTasks(answer, taskCount) {
  var from = 0;
  for (var k = 1; k <= taskCount; k++) {
    // Fix M1: una marca por consigna AL INICIO DE LÍNEA («1. », «2) », «Consigna 3. »); cifras como «2.000» no cuentan.
    var re = new RegExp('(?:^|\\n)[ \\t]*(?:consigna[ \\t]+)?' + k + '[.)][ \\t]', 'gi');
    re.lastIndex = from;
    var m = re.exec(answer);
    if (!m) return false;
    from = m.index + m[0].length;
  }
  return true;
}
function dynValidateGuidedPracticeDoc(doc, ctx) {
  if (!ctx || typeof ctx.chapterId !== 'string' || !ctx.chapterId) throw new Error('V3_VALIDATION_CONTEXT: práctica guiada sin chapterId ' + JSON.stringify(ctx));
  var plan = dynGuidedPracticePlan(ctx.minutes);
  var L = DYN_GUIDED_PRACTICE_LIM;
  var errors = [];
  function err(path, code, message) { errors.push({ path: path, code: code, message: message }); }
  if (!_dynIsPlainObject(doc)) return [{ path: '$', code: 'GUIDED_PRACTICE_SHAPE', message: 'el documento debe ser un objeto' }];
  Object.keys(doc).forEach(function (k) { if (DYN_GUIDED_PRACTICE_DOC_KEYS.indexOf(k) < 0) err('$.' + k, 'GUIDED_PRACTICE_SHAPE', 'campo desconocido: ' + k + ' (la práctica guiada no tiene solucionario oculto ni nota)'); });
  if (doc.schemaVersion !== DYN_GUIDED_PRACTICE_SCHEMA_VERSION) err('$.schemaVersion', 'GUIDED_PRACTICE_SCHEMA_VERSION', 'schemaVersion debe ser ' + DYN_GUIDED_PRACTICE_SCHEMA_VERSION);
  if (doc.chapterId !== ctx.chapterId) err('$.chapterId', 'CHAPTER_ID_MISMATCH', 'chapterId debe ser "' + ctx.chapterId + '"');
  if (doc.minutes !== ctx.minutes) err('$.minutes', 'GUIDED_PRACTICE_MINUTES_MISMATCH', 'minutes debe ser ' + ctx.minutes + ' (nivel del Manifest)');
  function text(v, path, min, max) {
    if (typeof v !== 'string' || v.trim().length < Math.max(1, min)) { err(path, 'GUIDED_PRACTICE_TEXT', path + ' debe ser un texto de al menos ' + Math.max(1, min) + ' caracteres'); return null; }
    if (v.length > max) err(path, 'GUIDED_PRACTICE_TEXT_TOO_LONG', path + ' supera ' + max + ' caracteres (' + v.length + ')');
    if (DYN_GUIDED_PRACTICE_RESOURCE_RE.test(v)) err(path, 'GUIDED_PRACTICE_RESOURCE_MENTION', path + ' menciona otro recurso del curso («' + (DYN_GUIDED_PRACTICE_RESOURCE_RE.exec(v) || [''])[0] + '»): la práctica guiada se lee sola');
    return v;
  }
  if (!Array.isArray(doc.exercises)) { err('$.exercises', 'GUIDED_PRACTICE_SHAPE', 'exercises debe ser una lista'); return errors; }
  if (doc.exercises.length !== plan.length) err('$.exercises', 'GUIDED_PRACTICE_COUNT', 'exercises debe tener ' + plan.length + ' ejercicios para ' + ctx.minutes + ' min (tiene ' + doc.exercises.length + ')');
  doc.exercises.forEach(function (e, i) {
    var p = '$.exercises[' + i + ']';
    if (!_dynIsPlainObject(e)) return err(p, 'GUIDED_PRACTICE_SHAPE', p + ' debe ser un objeto');
    Object.keys(e).forEach(function (k) { if (DYN_GUIDED_PRACTICE_EXERCISE_KEYS.indexOf(k) < 0) err(p + '.' + k, 'GUIDED_PRACTICE_SHAPE', 'campo desconocido en el ejercicio: ' + k); });
    var want = plan[i];
    if (want) {
      if (e.id !== want.id) err(p + '.id', 'GUIDED_PRACTICE_EXERCISE_ID', p + '.id debe ser "' + want.id + '" (en orden)');
      if (e.minutes !== want.minutes) err(p + '.minutes', 'GUIDED_PRACTICE_EXERCISE_MINUTES', p + '.minutes debe ser ' + want.minutes + ' (lo fija Cursia)');
    }
    if (DYN_GUIDED_PRACTICE_KINDS.indexOf(e.kind) < 0) err(p + '.kind', 'GUIDED_PRACTICE_KIND', p + '.kind debe ser ' + DYN_GUIDED_PRACTICE_KINDS.join(' | '));
    text(e.title, p + '.title', 4, L.titleMax);
    // C1: pisos según los minutos del ejercicio (los del plan de Cursia; un ejercicio de más usa los de 20 min).
    var F = DYN_GUIDED_PRACTICE_FLOORS[want ? want.minutes : 20] || DYN_GUIDED_PRACTICE_FLOORS[20];
    text(e.situation, p + '.situation', F.situationMin, L.situationMax);
    var taskCount = 0;
    if (!Array.isArray(e.tasks)) err(p + '.tasks', 'GUIDED_PRACTICE_SHAPE', p + '.tasks debe ser una lista');
    else {
      taskCount = e.tasks.length;
      if (e.tasks.length < F.tasksMin || e.tasks.length > L.tasksMax) err(p + '.tasks', 'GUIDED_PRACTICE_COUNT', p + '.tasks debe tener entre ' + F.tasksMin + ' y ' + L.tasksMax + ' consignas para ' + (want ? want.minutes : 20) + ' min (tiene ' + e.tasks.length + ')');
      e.tasks.forEach(function (t, j) {
        var tt = text(t, p + '.tasks[' + j + ']', L.taskMin, L.taskMax);
        if (tt && DYN_GUIDED_PRACTICE_RECALL_TASK_RE.test(tt)) err(p + '.tasks[' + j + ']', 'GUIDED_PRACTICE_TASK_RECALL', p + '.tasks[' + j + '] solo pide recordar («' + tt.slice(0, 40) + '»): cada consigna debe pedir analizar, decidir, calcular o justificar');
      });
    }
    text(e.expectedProduct, p + '.expectedProduct', F.expectedProductMin, L.expectedProductMax);
    if (!Array.isArray(e.criteria)) err(p + '.criteria', 'GUIDED_PRACTICE_SHAPE', p + '.criteria debe ser una lista');
    else {
      if (e.criteria.length < L.criteriaMin || e.criteria.length > L.criteriaMax) err(p + '.criteria', 'GUIDED_PRACTICE_COUNT', p + '.criteria debe tener entre ' + L.criteriaMin + ' y ' + L.criteriaMax + ' criterios (tiene ' + e.criteria.length + ')');
      var names = [];
      e.criteria.forEach(function (c, j) {
        var cp = p + '.criteria[' + j + ']';
        if (!_dynIsPlainObject(c)) return err(cp, 'GUIDED_PRACTICE_SHAPE', cp + ' debe ser un objeto { name, descriptor }');
        Object.keys(c).forEach(function (k) { if (DYN_GUIDED_PRACTICE_CRITERION_KEYS.indexOf(k) < 0) err(cp + '.' + k, 'GUIDED_PRACTICE_SHAPE', 'campo desconocido en el criterio: ' + k + ' (sin pesos ni puntajes: es formativa)'); });
        var n = text(c.name, cp + '.name', 3, L.criterionNameMax);
        if (n && names.indexOf(n.trim().toLowerCase()) >= 0) err(cp + '.name', 'GUIDED_PRACTICE_CRITERIA_DUPLICATE', 'criterio repetido: ' + n);
        if (n) names.push(n.trim().toLowerCase());
        text(c.descriptor, cp + '.descriptor', L.criterionDescriptorMin, L.criterionDescriptorMax);
      });
    }
    var ans = text(e.modelAnswer, p + '.modelAnswer', F.modelAnswerMin, L.modelAnswerMax);
    if (ans && taskCount >= L.tasksMin && !dynGuidedPracticeAnswerCoversTasks(ans, taskCount)) {
      err(p + '.modelAnswer', 'GUIDED_PRACTICE_ANSWER_ORDER', p + '.modelAnswer debe responder las ' + taskCount + ' consignas en orden, una por línea, cada una empezando con «1. », «2. », …');
    } else if (ans && taskCount >= L.tasksMin) {
      // Loop 10 C1-c: cada consigna con una respuesta sustantiva (nunca «ver la tabla del capítulo»).
      var thin = (dynGuidedPracticeAnswerSegments(ans, taskCount) || []).map(function (sg, k) { var r = dynGuidedPracticeThinReason(sg); return r ? (k + 1) + ': ' + r : null; }).filter(Boolean);
      if (thin.length) err(p + '.modelAnswer', 'GUIDED_PRACTICE_ANSWER_THIN', p + '.modelAnswer no responde de verdad la(s) consigna(s) ' + thin.join('; ') + ': cada respuesta desarrolla el trabajo pedido (al menos ' + DYN_GUIDED_PRACTICE_DISTINCT.answerSegmentMin + ' caracteres) y no remite al material del curso');
    }
  });
  // Loop 10 C1-a: ejercicios distintos dentro del documento.
  return errors.concat(dynGuidedPracticeDistinctErrors(doc));
}
// Documento desde la respuesta del LLM: Cursia pone chapterId, minutos, ids y minutos de cada ejercicio; del LLM solo se
// toman los campos de contenido (un campo extra del modelo —p. ej. «solution» o «score»— nunca llega al documento).
function dynGuidedPracticeDocFrom(obj, chapterId, minutes) {
  var plan = dynGuidedPracticePlan(minutes);
  var xs = _dynIsPlainObject(obj) && Array.isArray(obj.exercises) ? obj.exercises : null;
  return {
    schemaVersion: DYN_GUIDED_PRACTICE_SCHEMA_VERSION, chapterId: chapterId, minutes: minutes,
    exercises: xs === null ? null : xs.map(function (e, i) {
      var x = _dynIsPlainObject(e) ? e : {};
      var crit = Array.isArray(x.criteria) ? x.criteria.map(function (c) { return _dynIsPlainObject(c) ? { name: c.name, descriptor: c.descriptor } : c; }) : x.criteria;
      return { id: plan[i] ? plan[i].id : 'E' + (i + 1), minutes: plan[i] ? plan[i].minutes : null, kind: x.kind, title: x.title, situation: x.situation, tasks: x.tasks, expectedProduct: x.expectedProduct, criteria: crit, modelAnswer: x.modelAnswer };
    })
  };
}
function _dynGuidedPracticeClaim(item) {
  var g = _dynClaimField(item, ['guidedPractice']);
  return _dynIsPlainObject(g) ? g : null;
}
// Cuentas explícitas de la situación y de la respuesta modelo («$180.000 − $110.000 = $70.000»): las mismas reglas que el
// ejemplo resuelto de la experiencia (dynLintWorkedExampleNumbers), pero DURAS (una respuesta modelo con cuentas que no
// dan se rehace: el estudiante la usa para corregirse).
function dynLintGuidedPracticeNumbers(doc) {
  var out = [];
  (doc.exercises || []).forEach(function (e, i) {
    if (!_dynIsPlainObject(e)) return;
    var we = { situation: e.situation, steps: [], result: e.modelAnswer };
    dynLintWorkedExampleNumbers(we, '$.exercises[' + i + ']').forEach(function (h) {
      if (/^\[WE_ARITH\]/.test(h)) out.push(h.replace('[WE_ARITH]', 'GUIDED_PRACTICE_ARITH:').replace('.result', '.modelAnswer'));
    });
  });
  return out;
}
// Fix I5: lo que los ejercicios guiados no deben repetir (del claim: práctica del módulo y casos de sus AA). DURO si un
// ejercicio usa el mismo título de escenario o a 2+ de los mismos protagonistas; BLANDO con un solo nombre en común o
// un título muy parecido (un reintento dirigido; si no mejora, se conserva y queda registrado).
function _dynNormTitle(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^(practica|taller|caso|ejercicio)[^:]*:\s*/, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function _dynTitleTokens(t) { return _dynNormTitle(t).split(' ').filter(function (w) { return w.length > 3; }); }
function dynLintGuidedPracticeAvoid(doc, avoid) {
  var hard = [], soft = [];
  if (!_dynIsPlainObject(avoid)) return { hard: hard, soft: soft };
  var titles = [].concat(avoid.practiceChapterTitles || []);
  var names = [];
  (avoid.applicationCases || []).forEach(function (c) {
    if (!_dynIsPlainObject(c)) return;
    if (c.title) titles.push(c.title);
    if (c.workshopTitle) titles.push(c.workshopTitle);
    (c.names || []).forEach(function (n) { if (typeof n === 'string' && n.trim() && names.indexOf(n) < 0) names.push(n); });
  });
  var normTitles = titles.map(_dynNormTitle).filter(Boolean);
  (doc.exercises || []).forEach(function (e, i) {
    if (!_dynIsPlainObject(e)) return;
    var p = '$.exercises[' + i + ']';
    var nt = _dynNormTitle(e.title);
    var text = String(e.title || '') + '\n' + String(e.situation || '');
    var shared = names.filter(function (n) { return new RegExp('(^|[^\\p{L}])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}])', 'u').test(text); });
    if (nt && normTitles.indexOf(nt) >= 0) hard.push({ path: p + '.title', code: 'GUIDED_PRACTICE_CASE_CLASH', message: p + '.title repite el escenario de la práctica o de una Actividad de Aplicación del módulo («' + e.title + '»): usa otra situación' });
    else if (shared.length >= 2) hard.push({ path: p + '.situation', code: 'GUIDED_PRACTICE_CASE_CLASH', message: p + '.situation usa a los mismos protagonistas de una Actividad de Aplicación del módulo (' + shared.slice(0, 4).join(', ') + '): usa otras personas y otra organización' });
    else {
      var tk = _dynTitleTokens(e.title);
      var close = tk.length && titles.some(function (t) { var o = _dynTitleTokens(t); if (!o.length) return false; var inter = tk.filter(function (w) { return o.indexOf(w) >= 0; }).length; return inter / Math.max(tk.length, o.length) >= 0.6; });
      if (shared.length === 1 || close) soft.push('[GP_CASE_CLASH] ' + p + ': se parece al caso de la práctica o de una Actividad de Aplicación del módulo' + (shared.length ? ' (' + shared[0] + ')' : '') + ': cambia la situación o los protagonistas');
    }
  });
  return { hard: hard, soft: soft };
}
async function _dynRunGuidedPractice(item) {
  var bp = item.blueprint || {};
  if (!item.chapterId || !bp.chapter) return { ok: false, error: 'guided_practice: el claim no trae chapterId/blueprint.chapter', retryable: false };
  var gp = _dynGuidedPracticeClaim(item);
  if (!gp || !DYN_GUIDED_PRACTICE_EXERCISES_BY_MINUTES[gp.minutes]) return { ok: false, error: 'claim_payload_unavailable: guided_practice ' + item.itemKey + ' sin minutos válidos en el claim', retryable: false };
  if (gp.schemaVersion !== DYN_GUIDED_PRACTICE_SCHEMA_VERSION) return { ok: false, error: 'claim_payload_unavailable: guided_practice ' + item.itemKey + ' con schemaVersion ' + JSON.stringify(gp.schemaVersion) + ' (este ejecutor escribe ' + DYN_GUIDED_PRACTICE_SCHEMA_VERSION + ')', retryable: false };
  // El plan del claim debe ser el del nivel (Cursia fija ejercicios y minutos; un claim incoherente no se adivina).
  if (JSON.stringify(gp.exercises) !== JSON.stringify(dynGuidedPracticePlan(gp.minutes))) return { ok: false, error: 'claim_payload_unavailable: guided_practice ' + item.itemKey + ' con un plan de ejercicios distinto del nivel ' + gp.minutes, retryable: false };
  var src = await _dynLoadChapterSources(item);
  if (!src.ok) return src.result;
  var sourceMd = _dynTrimAtParagraph(src.contentMd, DYN_GUIDED_PRACTICE_SOURCE_MAX_CHARS);
  var courseContext = item.context.courseContext;
  var chapter = Object.assign({}, bp.chapter, { id: item.chapterId });
  var caseReuse = {};
  var clashSoft = {};
  // Fix M3: 120 min = 3 ejercicios de 40 → más espacio de salida.
  var maxTok = gp.minutes === 120 ? 10000 : 8000; // prior de salida p90 ≈ 6,5k (2 ej.) / 9,75k (3 ej.): sin truncar en el worker (tope 16k)
  var res = await _dynV3JsonWithRetry(item, dynGuidedPracticeSys(courseContext), dynGuidedPracticePrompt(courseContext, bp.outline, chapter, sourceMd, gp, dynPedagogyBlock(item)), maxTok, function (obj, attempt) {
    var doc = dynGuidedPracticeDocFrom(obj, item.chapterId, gp.minutes);
    var v = dynValidateGuidedPracticeDoc(doc, { chapterId: item.chapterId, minutes: gp.minutes });
    // Fix I5: mismo escenario o protagonistas que la práctica o las AA del módulo → se rehace.
    var av = dynLintGuidedPracticeAvoid(doc, gp.avoid);
    // Loop 10 C1-b: ni repetir un ejercicio guiado de otro capítulo del run (el servidor lo verifica también al completar).
    v = v.concat(av.hard, dynGuidedPracticeRunClashes(doc, gp.avoid));
    if (v.length) return { ok: false, errors: _dynFormatErrors(v) };
    var nums = dynLintGuidedPracticeNumbers(doc);
    if (nums.length) return { ok: false, errors: nums.map(function (x) { return '$ ' + x; }) };
    // No reutilizar el caso del capítulo (blando: un reintento dirigido; si no mejora, se conserva y queda registrado).
    var soft = [];
    var reused = [];
    doc.exercises.forEach(function (e, i) {
      var cr = dynLintCaseReuse(String(e.title || '') + ' ' + String(e.situation || ''), src.contentMd);
      if (cr.reused) { reused.push(i + 1); soft.push('[GP_CASE_REUSE] $.exercises[' + i + '].situation: repite el caso del capítulo (' + cr.distinct.slice(0, 6).join(', ') + '): usa otra situación, otra organización o una condición distinta'); }
    });
    caseReuse[attempt] = reused;
    clashSoft[attempt] = av.soft.length;
    return { ok: true, value: doc, soft: soft.concat(av.soft) };
  }, { normalizeMoney: dynCourseIsColombia(courseContext) });
  if (!res.ok) return _dynV3Invalid(item, res.errors, res.truncated);
  var all = dynValidateGuidedPracticeDoc(res.value, { chapterId: item.chapterId, minutes: gp.minutes });
  if (all.length) return _dynV3Invalid(item, _dynFormatErrors(all), false);
  var a = _dynV3JsonArtifact(item, 'dynamic_guided_practice_json', res.value, item.chapterId);
  return {
    ok: true,
    artifacts: [a.artifact],
    summary: Object.assign({
      chapterId: item.chapterId, guidedPracticeSchemaVersion: DYN_GUIDED_PRACTICE_SCHEMA_VERSION, minutes: gp.minutes,
      exerciseCount: res.value.exercises.length, kinds: res.value.exercises.map(function (e) { return e.kind; }),
      guidedPracticeSha256: a.sha, retried: !!res.retried, promptVersion: DYN_V3_GUIDED_PRACTICE_PROMPT_VERSION, contentArtifactId: src.contentArtifactId
    }, (caseReuse[res.usedAttempt] || []).length ? { caseReuse: caseReuse[res.usedAttempt] } : {}, clashSoft[res.usedAttempt] ? { caseClashSoft: clashSoft[res.usedAttempt] } : {}, _dynQualSummary(res), dynPedagogySummary(item))
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
  // r61 Q-04: línea de tiempo del video (escenas reales de Videogen) si el servidor ancló el plan a ella.
  var claimTimeline = _dynClaimField(item, ['timelineSource']);
  var claimScenes = _dynClaimField(item, ['videoScenes']);
  if (claimTimeline !== undefined && claimTimeline !== 'videogen_scenes' && claimTimeline !== 'even_spacing') {
    return { ok: false, error: 'video_interactions: timelineSource desconocido ' + JSON.stringify(claimTimeline), retryable: false };
  }
  // El plan del claim debe ser EXACTAMENTE el plan determinístico (R8; r61: anclado a escenas si las trae).
  var vplan;
  try { vplan = dynPlanVideoCheckpoints(durationSec, claimScenes); }
  catch (e) { return { ok: false, error: 'video_interactions: ' + ((e && e.message) || String(e)), retryable: false }; }
  if (claimTimeline === 'videogen_scenes' && vplan.timelineSource !== 'videogen_scenes') {
    return { ok: false, error: 'video_interactions: VIDEO_PLAN_MISMATCH — el claim ancla las preguntas a las escenas pero su línea de tiempo no es utilizable (' + vplan.timelineReason + ')', retryable: false };
  }
  var plan = vplan.checkpoints;
  var anchored = vplan.timelineSource === 'videogen_scenes';
  var planMatches = plan.length === claimCheckpoints.length && plan.every(function (p, i) {
    var c = claimCheckpoints[i];
    return c.index === p.index && c.atSec === p.atSec && c.segmentStart === p.segment[0] && c.segmentEnd === p.segment[1];
  });
  if (!planMatches) return { ok: false, error: 'video_interactions: VIDEO_PLAN_MISMATCH — los checkpoints del claim no coinciden con ' + (anchored ? 'planVideoCheckpoints(' + durationSec + ', escenas)' : 'planInteractionCheckpoints(' + durationSec + ')'), retryable: false };

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
  // r61 Q-04: con escenas, el prompt muestra el guion real del video por tramos (sin escenas: prompt de siempre).
  // (escenas re-escaladas a la duración medida: las mismas con las que se ancló el plan.)
  if (anchored) biasOpts.videoScenes = vplan.scenes;
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
    var vexp = v2 ? { videoItemKey: videoItemKey, durationSec: durationSec, schemaVersion: 2 } : { videoItemKey: videoItemKey, durationSec: durationSec };
    if (anchored) vexp.videoScenes = claimScenes;
    var v = dynValidateVideoInteractionsDoc(doc, vexp);
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
  var summary = Object.assign({ chapterId: item.chapterId, videoItemKey: videoItemKey, durationSec: durationSec, interactionCount: plan.length, interactionsSha256: a.sha, retried: res.retried, feedbackPolarityFixed: polarityFixed, promptVersion: DYN_V3_PROMPT_VERSIONS.video_interactions, timelineSource: vplan.timelineSource }, anchored ? {} : { timelineReason: _dynClaimField(item, ['timelineReason']) || vplan.timelineReason }, dynPedagogySummary(item));
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
// Modelo: DYN_GENERATION_MODEL (Loop 6). Toda llamada pasa por _dynV3Llm (→ _dynLlmCall →
// api(…, DYN_GENERATION_MODEL)).
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
  if (DYN_EXAM_REF_TAG_RE.test(v)) return name + ': trae una marca [S#] del capítulo (las marcas solo van en "evidenceRef")';
  return null;
}
function dynExamBankCheckQuestion(raw, expect, chapterInfo) {
  var L = DYN_EXAM_BANK_LIMITS;
  var type = expect.type;
  if (!_dynIsPlainObject(raw)) return _dynEbReject('EXAM_BANK_SCHEMA', 'la pregunta no es un objeto');
  // Exam-bank D1: la evidencia llega como "evidenceRef" (marca [S#] del capítulo) o, en borradores y cachés, ya
  // resuelta en "evidence"; una de las dos es obligatoria.
  var keys = ['id', 'type', 'chapterId', 'level', 'stem', 'explanation']
    .concat(type === 'multichoice' ? ['correct', 'distractors'] : type === 'truefalse' ? ['answer', 'whyWrong'] : ['pairs']);
  var missing = keys.filter(function (k) { return !(k in raw); });
  if (!('evidenceRef' in raw) && !('evidence' in raw)) missing.push('evidenceRef');
  if (missing.length) return _dynEbReject('MISSING_FIELD', 'faltan los campos ' + missing.join(', '));
  // (a) esquema que ve el LLM (5 distractores)
  if (raw.id !== expect.id) return _dynEbReject('EXAM_BANK_SCHEMA', 'id distinto del pedido ("' + expect.id + '")');
  if (raw.type !== type) return _dynEbReject('EXAM_BANK_SCHEMA', 'type debe ser "' + type + '"');
  if (typeof raw.chapterId !== 'string' || (expect.chapterIds || []).indexOf(raw.chapterId) < 0) {
    return _dynEbReject('EXAM_BANK_SCHEMA', 'chapterId debe ser ' + (expect.chapterIds || []).map(function (x) { return '"' + x + '"'; }).join(' o '));
  }
  if (DYN_EXAM_LEVELS.indexOf(raw.level) < 0) return _dynEbReject('EXAM_BANK_SCHEMA', 'level debe ser ' + DYN_EXAM_LEVELS.join('|'));
  // Exam-bank D1: "evidenceRef" gana sobre "evidence". Una marca que no es un fragmento citable de ESE capítulo se
  // rechaza como evidencia (nunca se busca otra): la validación de la evidencia sigue intacta más abajo.
  var evidenceText = raw.evidence;
  var byRef = false;
  if ('evidenceRef' in raw) {
    var refInfo = chapterInfo ? chapterInfo(raw.chapterId) : null;
    var refKey = typeof raw.evidenceRef === 'string' ? raw.evidenceRef.trim().replace(/^\[|\]$/g, '') : '';
    var refText = refInfo && refInfo.refs && DYN_EXAM_REF_RE.test(refKey) && Object.prototype.hasOwnProperty.call(refInfo.refs, refKey) ? refInfo.refs[refKey] : null;
    if (typeof refText !== 'string') return _dynEbReject('EXAM_BANK_EVIDENCE', 'evidenceRef ' + JSON.stringify(String(raw.evidenceRef).slice(0, 20)) + ' no es una marca [S#] de ESTE capítulo: elige una de las que aparecen en el texto');
    evidenceText = refText;
    byRef = true;
  }
  var e = _dynEbTextErr(raw.stem, L.stem, 'stem') || _dynEbTextErr(raw.explanation, L.explanation, 'explanation') || _dynEbTextErr(evidenceText, L.evidence, 'evidence', true);
  if (e) return _dynEbReject('EXAM_BANK_SCHEMA', e);
  var q = { id: raw.id, type: type, chapterId: raw.chapterId, level: raw.level, stem: raw.stem.trim(), explanation: raw.explanation.trim(), evidence: evidenceText.trim() };
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
  return { ok: true, q: q, survivors: survivors, combos: combos, dropped: dropped, evidenceRelocated: !!relocated, evidenceByRef: byRef };
}

// ── Revisión de FORMA de candidatas rechazadas (2026-10-15, examen final #1353) ──
// Reproducción local de las 28 respuestas pagadas del examen final: 98 candidatas rechazadas, 76 de ellas SOLO por
// forma (opción correcta de > 200 caracteres en preguntas integradoras, distractores fuera de 0,5–1,7× la correcta,
// "explanation"/"evidenceRef" omitidos en V/F) y con el contenido válido. La reparación las reescribía desde cero y
// volvía a fallar igual (rendimiento de la reparación MC ≈ 30 %). La revisión le pide al modelo corregir SOLO esos
// campos (parche) y la pregunta resultante pasa por el MISMO validador: las reglas no se aflojan.
// Clasificador: una candidata es REVISABLE si su rechazo es de forma Y una sonda determinística (esos campos llevados
// a una longitud válida; "evidenceRef" faltante probado contra las marcas del capítulo) pasa el validador real.
// Rangos objetivo dentro de los del validador (y de los que el prompt ya pide), con margen para el conteo del modelo.
var DYN_EXAM_BANK_REVISION_TARGETS = { stem: [40, 520], explanation: [80, 330], why: [30, 190], whyWrong: [30, 190], term: [2, 55], definition: [10, 190], optionMax: 190, correctLong: [110, 140] };
var DYN_EXAM_BANK_REVISION_FORM_CODES = { MISSING_FIELD: true, EXAM_BANK_SCHEMA: true, EXAM_BANK_DISTRACTORS: true, EXAM_BANK_LENGTH_BIAS: true };
// Salida estimada de una revisión por pregunta (parche: correcta + 5 distractores / un campo de V/F).
var DYN_EXAM_BANK_REVISION_TOKENS_EST = { multichoice: 450, truefalse: 160, match: 260 };
var DYN_EXAM_BANK_REVISION_YIELD_PRIOR = 0.75;   // rendimiento supuesto de la revisión hasta medirlo en el intento
var DYN_EXAM_BANK_REVISION_MAX_REFS = 80;
var DYN_EXAM_BANK_REVISION_MAX_ITEMS = 40;        // ids por llamada de revisión (= lo que lista dynExamBankRevisionParts)         // marcas probadas por la sonda (evidenceRef faltante)
function _dynEbClampProbe(s, lo, hi) {
  s = String(s == null ? '' : s).trim();
  if (s.length > hi) return s.slice(0, hi).trim();
  while (s.length < lo) s += (s ? ' ' : '') + 'dato';
  return s.length > hi ? s.slice(0, hi).trim() : s;
}
function _dynEbLenOut(v, lim) { return typeof v !== 'string' || _dynEbLen(v) < lim[0] || _dynEbLen(v) > lim[1]; }
// Rechazo de CONTENIDO que la sonda no debe «arreglar» al rellenar o cortar textos (rev. I1): opción prohibida
// («todas/ninguna de las anteriores»), distractor igual o contenido en la correcta o en otro, unidades distintas,
// texto con HTML/marcas, neuromito en lo que se afirma, palabras absolutas solo en distractores. Se mira el ORIGINAL.
function _dynEbRevisionContentIssue(raw, type) {
  var L = DYN_EXAM_BANK_LIMITS;
  var notLen = function (v, lim, name) { var e = _dynEbTextErr(v, lim, name); return !!e && !_dynEbLenOut(v, lim); };
  if (notLen(raw.stem, L.stem, 'stem')) return true;
  if (typeof raw.explanation === 'string' && notLen(raw.explanation, L.explanation, 'explanation')) return true;
  if (type === 'multichoice') {
    var c = raw.correct.text;
    if (notLen(c, L.optionText, 'correct.text') || DYN_EXAM_OPTION_FORBIDDEN_RE.test(dynNormalizeExamText(c)) || _dynEbNeuromyth(c)) return true;
    var cNorm = dynNormalizeExamText(c);
    var cUnits = dynExamUnitClasses(c);
    var ds = raw.distractors.map(function (d) { return String(d.text); });
    for (var i = 0; i < ds.length; i++) {
      var dn = dynNormalizeExamText(ds[i]);
      if (notLen(ds[i], L.optionText, 'text') || DYN_EXAM_OPTION_FORBIDDEN_RE.test(dn)) return true;
      if (!dn || dn === cNorm || dynExamTextContains(c, ds[i]) || dynExamTextContains(ds[i], c)) return true;
      if (_dynEbUnitMismatch(cUnits, ds[i])) return true;
      for (var j = 0; j < i; j++) {
        if (dynNormalizeExamText(ds[j]) === dn || dynExamTextContains(ds[j], ds[i]) || dynExamTextContains(ds[i], ds[j])) return true;
      }
      if (typeof raw.distractors[i].why === 'string' && notLen(raw.distractors[i].why, L.optionWhy, 'why')) return true;
    }
    // ABSOLUTE_CUE (reglas del validador): basta una terna con < 2 absolutas → irrecuperable solo con < 2 distractores sin ellas.
    if (!_dynEbHasAbsolute(c) && ds.filter(function (d) { return !_dynEbHasAbsolute(d); }).length < 2) return true;
  } else if (type === 'truefalse') {
    if (raw.answer === true && _dynEbNeuromyth(raw.stem)) return true;
  } else if (raw.pairs.some(function (p) { return notLen(p.term, L.term, 'term') || notLen(p.definition, L.definition, 'definition') || _dynEbNeuromyth(p.term + ' ' + p.definition); })) return true;
  return false;
}
// → null (no revisable: el rechazo es de contenido, o falta estructura) | { fixes: [texto], code, fields, probe }
// (fields = campos que la revisión puede cambiar; probe = la sonda que pasó, solo diagnóstico/pruebas).
// rev. M1: primero se prueba SOLO con los campos que fallan (faltantes, textos libres, enunciado/términos largos); las
// longitudes de opciones se piden solo si sin ellas la pregunta no pasa.
function dynExamBankRevisionPlan(raw, expect, chapterInfo, check) {
  if (!check || check.ok || !DYN_EXAM_BANK_REVISION_FORM_CODES[check.code] || !_dynIsPlainObject(raw)) return null;
  var L = DYN_EXAM_BANK_LIMITS;
  var T = DYN_EXAM_BANK_REVISION_TARGETS;
  var type = expect.type;
  // Estructura intacta (la revisión no inventa una pregunta): id, tipo, capítulo, nivel, enunciado y respuesta.
  if (raw.id !== expect.id || raw.type !== type || typeof raw.chapterId !== 'string' || (expect.chapterIds || []).indexOf(raw.chapterId) < 0) return null;
  if (DYN_EXAM_LEVELS.indexOf(raw.level) < 0 || typeof raw.stem !== 'string') return null;
  if (type === 'multichoice' && !(_dynIsPlainObject(raw.correct) && typeof raw.correct.text === 'string' && Array.isArray(raw.distractors) && raw.distractors.length === 5
    && raw.distractors.every(function (d) { return _dynIsPlainObject(d) && typeof d.text === 'string'; }))) return null;
  if (type === 'truefalse' && typeof raw.answer !== 'boolean') return null;
  if (type === 'match' && !(Array.isArray(raw.pairs) && raw.pairs.length >= L.pairs[0] && raw.pairs.length <= L.pairs[1]
    && raw.pairs.every(function (p) { return _dynIsPlainObject(p) && typeof p.term === 'string' && typeof p.definition === 'string'; }))) return null;
  // rev. I1: DISTRACTORS solo si TODOS los descartes son de longitud / why vacío; y ningún rechazo de contenido en el original.
  if (check.code === 'EXAM_BANK_DISTRACTORS' && (check.dropped || []).some(function (d) { return ['EXAM_BANK_LENGTH_RANGE', 'EXAM_BANK_SCHEMA', 'EXAM_BANK_EMPTY_WHY'].indexOf(d.code) < 0; })) return null;
  if (_dynEbRevisionContentIssue(raw, type)) return null;
  var probe = JSON.parse(JSON.stringify(raw));
  var fixes = [];
  var fields = {};
  function freeText(get, set, lim, target, label, field) {
    var v = get(raw);
    if (v === undefined) { fixes.push('agrega ' + label + ' (' + target[0] + '–' + target[1] + ' caracteres)'); set(probe, _dynEbClampProbe('', target[0], target[1])); fields[field] = true; return; }
    if (!_dynEbLenOut(v, lim)) return;
    fixes.push(label + ': hoy ' + _dynEbLen(v) + ' caracteres → escribe entre ' + target[0] + ' y ' + target[1]);
    set(probe, _dynEbClampProbe(v, target[0], target[1]));
    fields[field] = true;
  }
  function anchored(v, lim, target, label, set, field) {
    if (!_dynEbLenOut(v, lim)) return;
    fixes.push(label + ': hoy ' + _dynEbLen(v) + ' caracteres → condénsalo a ' + target[0] + '–' + target[1]);
    set(_dynEbClampProbe(v, target[0], target[1]));
    fields[field] = true;
  }
  anchored(raw.stem, L.stem, T.stem, '"stem"', function (x) { probe.stem = x; }, 'stem');
  freeText(function (o) { return o.explanation; }, function (o, x) { o.explanation = x; }, L.explanation, T.explanation, '"explanation"', 'explanation');
  var needRef = !('evidenceRef' in raw) && !('evidence' in raw);
  if (needRef) { fixes.push('agrega "evidenceRef": la marca [S#] del texto de ESTE capítulo cuyo fragmento respalda ' + (type === 'multichoice' ? 'la respuesta correcta' : type === 'truefalse' ? 'la afirmación' : 'los pares')); fields.evidenceRef = true; }
  if (type === 'truefalse') freeText(function (o) { return o.whyWrong; }, function (o, x) { o.whyWrong = x; }, L.whyWrong, T.whyWrong, '"whyWrong"', 'whyWrong');
  if (type === 'match') {
    raw.pairs.forEach(function (p, i) {
      anchored(p.term, L.term, T.term, 'term del par ' + (i + 1), function (x) { probe.pairs[i].term = x; }, 'pairs');
      anchored(p.definition, L.definition, T.definition, 'definition del par ' + (i + 1), function (x) { probe.pairs[i].definition = x; }, 'pairs');
    });
  }
  if (type === 'multichoice') {
    freeText(function (o) { return o.correct.why; }, function (o, x) { o.correct.why = x; }, L.optionWhy, T.why, '"correct.why"', 'correct.why');
    raw.distractors.forEach(function (d, i) {
      freeText(function (o) { return o.distractors[i].why; }, function (o, x) { o.distractors[i].why = x; }, L.optionWhy, T.why, '"why" del distractor ' + (i + 1), 'distractors.why');
    });
  }
  var refs = [null];
  if (needRef) {
    var info = chapterInfo ? chapterInfo(raw.chapterId) : null;
    refs = info && info.refs ? Object.keys(info.refs).slice(0, DYN_EXAM_BANK_REVISION_MAX_REFS) : [];
  }
  function passes() {
    for (var k = 0; k < refs.length; k++) {
      if (refs[k]) probe.evidenceRef = refs[k];
      if (dynExamBankCheckQuestion(probe, expect, chapterInfo).ok) return true;
    }
    return false;
  }
  var cl = type === 'multichoice' ? _dynEbLen(raw.correct.text) : 0;
  if (fixes.length && !(type === 'multichoice' && cl > L.optionText[1]) && passes()) return { fixes: fixes, code: check.code, fields: Object.keys(fields), probe: probe };
  if (type !== 'multichoice') return null;
  // Longitudes de opciones: la correcta de más de 170 caracteres se condensa a 110–140; distractores entre 0,6×máx y
  // 1,5×mín de la correcta (validador: 0,5–1,7×), nunca más de 190, al menos 2 más largos y 2 más cortos que ella.
  var lens = raw.distractors.map(function (d) { return _dynEbLen(d.text); });
  var cLo = cl, cHi = cl;
  if (cl > 170) { cLo = T.correctLong[0]; cHi = T.correctLong[1]; }
  var dLo = Math.max(1, Math.ceil(0.6 * cHi));
  var dHi = Math.min(T.optionMax, Math.floor(1.5 * cLo));
  if (dHi <= cHi || dLo >= cLo) return null;
  if (cl !== cHi) fixes.push('"correct.text": hoy ' + cl + ' caracteres → condénsala a ' + cLo + '–' + cHi + ' (misma respuesta)');
  fixes.push('"distractors": devuelve los 5 en el mismo orden y con la misma idea de cada uno; cada "text" entre ' + dLo + ' y ' + dHi + ' caracteres, al menos 2 MÁS LARGOS que la opción correcta y al menos 2 MÁS CORTOS (hoy miden ' + lens.join(', ') + ')');
  fields['correct.text'] = cl !== cHi; fields.distractors = true;
  if (!fields['correct.text']) delete fields['correct.text'];
  probe.correct.text = _dynEbClampProbe(raw.correct.text, cLo, cHi);
  var pc = _dynEbLen(probe.correct.text);
  var longL = Math.min(dHi, Math.max(pc + 10, Math.ceil(1.2 * pc)));
  var shortL = Math.max(dLo, Math.min(pc - 10, Math.floor(0.8 * pc)));
  var want = [longL, shortL, longL, shortL, Math.round((longL + shortL) / 2)];
  probe.distractors.forEach(function (d, i) { d.text = _dynEbClampProbe(d.text, want[i], want[i]); });
  return passes() ? { fixes: fixes, code: check.code, fields: Object.keys(fields), probe: probe } : null;
}
// Parche de la revisión sobre la candidata original: solo campos de contenido conocidos — y, con `fields` (rev. M3),
// solo los que la revisión debía corregir; los arreglos (distractores, pares) se combinan por posición y deben tener el
// mismo largo. id / type / capítulo / nivel / respuesta nunca cambian.
function dynExamBankApplyRevision(orig, patch, fields) {
  if (!_dynIsPlainObject(orig) || !_dynIsPlainObject(patch)) return null;
  var allow = function (k) { return !fields || fields.indexOf(k) >= 0; };
  var out = JSON.parse(JSON.stringify(orig));
  ['stem', 'explanation', 'whyWrong'].forEach(function (k) { if (allow(k) && typeof patch[k] === 'string') out[k] = patch[k]; });
  if (allow('evidenceRef') && typeof patch.evidenceRef === 'string') { out.evidenceRef = patch.evidenceRef; delete out.evidence; }
  if (_dynIsPlainObject(patch.correct) && _dynIsPlainObject(out.correct)) {
    if (allow('correct.text') && typeof patch.correct.text === 'string') out.correct.text = patch.correct.text;
    if (allow('correct.why') && typeof patch.correct.why === 'string') out.correct.why = patch.correct.why;
  }
  function byIndex(key, fieldsOf) {
    if (!Array.isArray(patch[key]) || !Array.isArray(out[key])) return;
    if (patch[key].length !== out[key].length) return;
    patch[key].forEach(function (p, i) {
      if (!_dynIsPlainObject(p) || !_dynIsPlainObject(out[key][i])) return;
      fieldsOf.forEach(function (f) { if (typeof p[f] === 'string') out[key][i][f] = p[f]; });
    });
  }
  byIndex('distractors', allow('distractors') ? ['text', 'why'] : allow('distractors.text') ? ['text'] : allow('distractors.why') ? ['why'] : []);
  if (allow('pairs')) byIndex('pairs', ['term', 'definition']);
  return out;
}
// ── Revisión de LONGITUD por la regla del banco (≤ 30 % «la correcta es la más larga»; 2026-10-15, #1353 intento 3) ──
// Una MC VÁLIDA cuya única combinación elegible deja la correcta como la más larga entra al banco solo de relleno;
// si el banco pasa el 30 %, SOLO el excedente se revisa: se alargan 2 distractores (los que mejor sobreviven) para que
// al menos una combinación deje de tener la correcta como la más larga. Nada más cambia (enunciado, correcta,
// evidencia, explicación, los otros 3 distractores) y la pregunta resultante pasa por el MISMO validador; se acepta
// solo si además deja de ser «solo más larga» (si no, se conserva la original válida: nunca se pierde una pregunta).
// → null (no aplica / imposible sin tocar la correcta) | { fixes, idx: [i, j], probe }.
function dynExamBankLengthRevisionPlan(raw, expect, chapterInfo) {
  if (!_dynIsPlainObject(raw) || expect.type !== 'multichoice' || !Array.isArray(raw.distractors) || raw.distractors.length !== 5) return null;
  var r0 = dynExamBankCheckQuestion(raw, expect, chapterInfo);
  if (!r0.ok || !_dynEbReachOnlyLongest(r0.combos)) return null;
  var cl = _dynEbLen(raw.correct.text);
  var lo = cl + 5;
  var hi = Math.min(DYN_EXAM_BANK_LIMITS.optionText[1] - 5, Math.floor(1.6 * cl));
  if (hi < lo + 5) return null;
  var surv = (r0.survivors || []).slice().sort(function (x, y) { return _dynEbLen(raw.distractors[y].text) - _dynEbLen(raw.distractors[x].text) || x - y; });
  if (surv.length < 3) return null;
  var idx = surv.slice(0, 2).sort(function (x, y) { return x - y; });
  var fixes = ['distractores ' + (idx[0] + 1) + ' y ' + (idx[1] + 1) + ' (hoy ' + _dynEbLen(raw.distractors[idx[0]].text) + ' y ' + _dynEbLen(raw.distractors[idx[1]].text) + ' caracteres): alárgalos a ' + lo + '–' + hi + ' caracteres, MÁS LARGOS que la opción correcta (' + cl + '), desarrollando el MISMO error conceptual con más detalle concreto (sin relleno, sin repetir la respuesta correcta, sin palabras absolutas ni pistas)',
    'devuelve "distractors" con los 5 en el mismo orden: los otros 3 EXACTAMENTE iguales; no cambies la opción correcta, el enunciado, la explicación ni la evidencia'];
  var probe = JSON.parse(JSON.stringify(raw));
  idx.forEach(function (i) { probe.distractors[i].text = _dynEbClampProbe(probe.distractors[i].text, lo + 2, lo + 2); });
  var pr = dynExamBankCheckQuestion(probe, expect, chapterInfo);
  if (!pr.ok || _dynEbReachOnlyLongest(pr.combos)) return null;
  return { fixes: fixes, idx: idx, probe: probe };
}
// Parche de longitud: SOLO el texto de los 2 distractores indicados; todo lo demás queda como en el original.
function dynExamBankApplyLengthRevision(orig, patch, idx) {
  var out = dynExamBankApplyRevision(orig, patch, ['distractors.text']);
  if (!out) return null;
  for (var i = 0; i < out.distractors.length; i++) if (idx.indexOf(i) < 0) out.distractors[i] = JSON.parse(JSON.stringify(orig.distractors[i]));
  return out;
}
// rev. I2 (guardia ADITIVA, además del validador): el distractor alargado conserva la idea del original (≥ 60 % de sus
// palabras), no se rellena con palabras repetidas, no se parece a la correcta (Jaccard < 0,6), los 2 alargados no se
// parecen entre sí (< 0,8) y no aparecen palabras absolutas nuevas. Si no, la pregunta original queda.
function _dynEbLenTokens(t) { return dynExamTokens(dynNormalizeExamText(t)).filter(function (x) { return x.length >= 3 || /\p{N}/u.test(x); }); }
function _dynEbJaccard(a, b) {
  var A = {}, B = {}, inter = 0, uni = 0;
  a.forEach(function (x) { A[x] = true; }); b.forEach(function (x) { B[x] = true; });
  Object.keys(A).forEach(function (x) { uni++; if (B[x]) inter++; });
  Object.keys(B).forEach(function (x) { if (!A[x]) uni++; });
  return uni ? inter / uni : 0;
}
function dynExamBankLengthPatchOk(origQ, newQ, idx) {
  var cTok = _dynEbLenTokens(newQ.correct.text);
  var news = [];
  for (var k = 0; k < idx.length; k++) {
    var o = String(origQ.distractors[idx[k]].text), n = String(newQ.distractors[idx[k]].text);
    var oT = _dynEbLenTokens(o), nT = _dynEbLenTokens(n);
    var nSet = {}; nT.forEach(function (x) { nSet[x] = true; });
    var kept = oT.filter(function (x) { return nSet[x]; }).length;
    if (oT.length && kept < 0.6 * oT.length) return false;                 // otra idea
    if (nT.length && Object.keys(nSet).length < 0.75 * nT.length) return false; // relleno repetido
    // rev. r2 N3: una palabra (≥ 4 letras) repetida ≥ 3 veces que en el original aparecía menos de 3 = relleno.
    var cntN = {}, cntO = {};
    nT.forEach(function (x) { cntN[x] = (cntN[x] || 0) + 1; }); oT.forEach(function (x) { cntO[x] = (cntO[x] || 0) + 1; });
    if (Object.keys(cntN).some(function (x) { return x.length >= 4 && cntN[x] >= 3 && (cntO[x] || 0) < 3; })) return false;
    // rev. r2 N1: parecido a la correcta RELATIVO al original (un distractor que ya compartía el vocabulario de la
    // correcta puede alargarse; lo que se rechaza es acercarse a ella al alargar).
    var jn = _dynEbJaccard(nT, cTok), jo = _dynEbJaccard(oT, _dynEbLenTokens(origQ.correct.text));
    if (jn >= 0.6 && jn - jo >= 0.3) return false;                          // se acerca a la correcta
    if (!_dynEbHasAbsolute(o) && _dynEbHasAbsolute(n)) return false;       // pista absoluta nueva
    news.push(nT);
  }
  if (news.length === 2 && _dynEbJaccard(news[0], news[1]) >= 0.8) return false; // los 2 alargados casi iguales
  return true;
}
// Excedente sobre el 30 % del banco ensamblado (0 si cumple).
function dynExamBankLengthBiasExcess(a) {
  if (!a || !a.mcTotal) return 0;
  var longest = a.histogram ? a.histogram[3] : 0;
  return 10 * longest > 3 * a.mcTotal ? longest - Math.floor(3 * a.mcTotal / 10) : 0;
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

// ── Exam-bank D1: evidencia por referencia ──
// Marca [S#] al comienzo de cada oración / viñeta / fila CITABLE del capítulo: la misma partición que
// dynExamEvidenceUnits, texto limpio (_dynEbCleanEvidence) de 40–220 caracteres que la guardia de oración v3
// acepta (afirmada; sin negación, condición ni pregunta). El modelo devuelve "evidenceRef" y el ejecutor pone el
// texto EXACTO: nunca hay que copiar a mano, y la evidencia sigue validándose igual (aquí y en el backend).
// Determinista: mismo Markdown → mismo texto marcado y mismas marcas (fuente idéntica en el examen del módulo y
// en el final del mismo capítulo, caché de prompts compartido).
var DYN_EXAM_REF_RE = /^S\d{1,4}$/;
var DYN_EXAM_REF_TAG_RE = /\[S\d{1,4}\]/;
var _DYN_EB_UNIT_SPLIT_RE = /(?<=[.!?…])\s+(?=[¿¡«"“(]?[\p{Lu}\p{N}])/u;
// Abreviaturas tras las que el corte de oración del guardia parte una oración real («art. 5», «Dr. Pérez»): el trozo
// siguiente no se ofrece como fragmento (quedaría truncado), aunque siga siendo citable a mano como antes.
var _DYN_EB_ABBREV_END_RE = /(?:^|[\s(])(?:art|arts|dr|dra|sr|sra|srta|núm|num|no|inc|lit|ej|pág|pag|cap|vol|ed|etc|aprox|tel|av|ud|uds)\.$/i;
function dynExamBankCitableIndex(md, maxTags) {
  var src = String(md == null ? '' : md);
  var idx = dynExamEvidenceIndex(src);
  var lim = DYN_EXAM_BANK_LIMITS.evidence;
  var cap = typeof maxTags === 'number' && maxTags >= 0 ? maxTags : Infinity;
  var refs = {};
  var list = [];
  var n = 0;
  var srcLines = src.split('\n');
  var lines = srcLines.map(function (line, li) {
    // Títulos y encabezados / separadores de tabla no son evidencia: sin marca.
    if (/^[ \t>]*#{1,6}[ \t]/.test(line)) return line;
    var isRow = /^[ \t]*\|/.test(line);
    if (isRow && (/^[ \t]*\|?[ \t:|-]+\|?[ \t]*$/.test(line) || /^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/.test(srcLines[li + 1] || ''))) return line;
    var r1 = line.replace(/^[ \t>]*(?:[-+*•‣◦▪]|\d{1,3}[.)])[ \t]+/, '');
    var r2 = r1.replace(/^[ \t>]*#{1,6}[ \t]+/, '');
    var body = r2.trim();
    if (!body) return line;
    var lead = line.slice(0, line.length - r2.length) + (/^\s*/.exec(r2) || [''])[0];
    // Fila de tabla: la marca va DESPUÉS de la barra inicial (no rompe la tabla que lee el modelo).
    var rowPipe = isRow && body.charAt(0) === '|' ? '| ' : '';
    if (rowPipe) body = body.replace(/^\|[ \t]*/, '');
    var tagged = false;
    var prev = '';
    var pieces = body.split(_DYN_EB_UNIT_SPLIT_RE).map(function (sent) {
      var t = sent.trim();
      var after = prev;
      prev = t;
      if (!t) return t;
      if (_DYN_EB_ABBREV_END_RE.test(after)) return t;
      if (n >= cap) return t;
      var clean = _dynEbCleanEvidence(t);
      if (clean.length < lim[0] || clean.length > lim[1] || DYN_EXAM_REF_TAG_RE.test(clean)) return t;
      if (!dynExamEvidenceSupport(idx, clean).ok) return t;
      n++;
      var ref = 'S' + n;
      refs[ref] = clean;
      list.push({ ref: ref, text: clean });
      tagged = true;
      return '[' + ref + '] ' + t;
    });
    return tagged ? lead + rowPipe + pieces.join(' ') : line;
  });
  var byText = {};
  list.forEach(function (u) { if (!byText[dynNormalizeExamText(u.text)]) byText[dynNormalizeExamText(u.text)] = u.ref; });
  return { text: lines.join('\n'), refs: refs, list: list, byText: byText };
}
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
    // O4 (medición para el piloto): pedidas / válidas por hoja (y cuántas válidas salieron de una reparación) para
    // decidir con datos si la holgura del pedido (MC 2·s+2, V/F y EM 2·s+1) puede bajar. Solo se reporta: no cambia nada.
    var asked = records.filter(function (r) { return r.leafIndex === li; }).length;
    var row = { owner: _dynEbOwnerOf(leaf), type: leaf.type, slots: leaf.slots, kept: keep.length, target: target, floor: floor,
      requested: asked, accepted: rs.length, acceptedAfterRepair: rs.filter(function (r) { return r.repaired; }).length,
      // Revisión O4: «usables» excluye las MC con la correcta como la más larga (solo entran de relleno hasta el piso).
      acceptedUsable: leaf.type === 'multichoice' ? rs.filter(function (r) { return !_dynEbReachOnlyLongest(r.combos); }).length : rs.length };
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
// 2026-10-15 (#1353, examen final): las reparaciones salen más largas que la primera pasada (preguntas integradoras:
// 770–930 tokens por MC medidos en las 13 reparaciones; una de 12.000 salió truncada con la tabla de arriba). Las
// llamadas de reparación se cortan con esta tabla; la primera pasada sigue con la de arriba (mismos prompts).
var DYN_EXAM_BANK_REPAIR_TOKENS_EST = { multichoice: 930, truefalse: 320, match: 420 };
// #583 (I3): con el piso en 2·slots una hoja corta tras 2 rondas fallaba el intento entero (sim. fault ×2: intentos
// 3,1 → 5,4 por 2×2); una 3.ª ronda —solo los ids que faltan, prefijo en caché— casi siempre la completa.
// Exam-bank D2: 5 rondas (las últimas solo corren en la cola: hojas que siguen bajo el piso) — con el pool, cerrar dentro del
// intento cuesta una llamada; repetir el intento entero, decenas (#1353: 19 intentos extra, 104 llamadas).
var DYN_EXAM_BANK_REPAIR_ROUNDS = 5;
var DYN_EXAM_BANK_POOL_ROUND_TOKENS = 14000;          // rev. M6: tope del pool por hoja y ronda (tokens de salida estimados)               // 2.ª–4.ª ronda solo para hojas bajo el piso (I2)
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
function dynExamBankEstimateTokens(types, table) {
  var est = table || DYN_EXAM_BANK_TOKENS_EST;
  return (types || []).reduce(function (t, ty) { return t + (est[ty] || 600); }, 0);
}
// Corta una secuencia de preguntas [{ leafIndex, n, type }] en partes de ≤ maxEst tokens
// estimados, balanceadas (nunca una cola diminuta si cabe en la anterior).
// table (opcional): tokens por tipo (reparación / revisión); por omisión, los de la primera pasada.
function dynExamBankSplitByTokens(seq, maxEst, table) {
  var est = table || DYN_EXAM_BANK_TOKENS_EST;
  var cap = maxEst || DYN_EXAM_BANK_MAX_OUTPUT_EST;
  var total = dynExamBankEstimateTokens(seq.map(function (x) { return x.type; }), est);
  var nCalls = Math.max(1, Math.ceil(total / cap));
  var maxItem = Math.max.apply(null, [0].concat(seq.map(function (x) { return est[x.type] || 600; })));
  var limit = Math.min(cap, Math.ceil(total / nCalls) + maxItem);
  var out = [];
  var cur = [];
  var curEst = 0;
  seq.forEach(function (x) {
    var e = est[x.type] || 600;
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
// bank_rule (2026-10-15): banco con TODAS las hojas completas que falla una regla de conjunto (≤ 30 % «correcta la más
// larga»): el borrador conserva lo ya pagado y el reintento solo corrige el excedente (revisión de longitud).
var DYN_EXAM_BANK_DRAFT_REASONS = ['leaf_below_floor', 'chapter_uncovered', 'generation_failed', 'bank_rule'];
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
  out.draftReason = doc.reason;
  // Regla de conjunto: ids ya revisados por longitud (no se repiten) e intentos con esa falla.
  if (Array.isArray(doc.lengthRevisedIds)) out.lengthRevisedIds = doc.lengthRevisedIds.filter(function (x) { return typeof x === 'string' && DYN_EXAM_BANK_ID_RE.test(x); }).slice(0, DYN_EXAM_BANK_DRAFT_MAX_QUESTIONS);
  if (typeof doc.setRuleAttempts === 'number' && isFinite(doc.setRuleAttempts)) out.setRuleAttempts = Math.max(0, Math.min(10, Math.floor(doc.setRuleAttempts)));
  if (typeof doc.setRuleFixedLast === 'number' && isFinite(doc.setRuleFixedLast)) out.setRuleFixedLast = Math.max(0, Math.floor(doc.setRuleFixedLast));
  if (typeof doc.setRuleReturnedLast === 'number' && isFinite(doc.setRuleReturnedLast)) out.setRuleReturnedLast = Math.max(0, Math.floor(doc.setRuleReturnedLast));
  // Exam-bank D3: memoria por hoja del intento anterior (opcional; un borrador sin ella empieza de cero).
  if (_dynIsPlainObject(doc.leafHistory)) out.leafHistory = doc.leafHistory;
  // Revisión de forma: candidatas revisables del intento anterior (opcional).
  if (Array.isArray(doc.candidates)) out.candidates = doc.candidates.slice(0, DYN_EXAM_BANK_DRAFT_MAX_QUESTIONS);
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
// Loop 9 (worker de IA): el worker corre cada parte en un contexto NUEVO (sin la memoria del navegador): el Manifest
// hace depender el final de los exam:<m> y los bancos llegan como dependencias. Devuelve la lista de preguntas y, en
// `meta`, de dónde salieron (source: dependencies | dependencies_unreadable | session | none) y cuántas dependencias
// no se pudieron leer: el final NUNCA falla por eso (sale sin bloque «no repitas»), pero queda visible en el summary.
async function _dynEbLoadModuleStemsDetailed(item) {
  var out = [];
  var seen = {};
  function add(list) { (list || []).forEach(function (e) { var k = dynNormalizeExamText(e.stem); if (!seen[k]) { seen[k] = true; out.push(e); } }); }
  var deps = (item.dependencyArtifacts || []).filter(function (a) { return a && a.type === DYN_EXAM_BANK_ARTIFACT_TYPE; });
  var unreadable = 0;
  var readable = 0;
  await Promise.all(deps.map(function (d) {
    return _dynDownloadArtifactText(d.artifactId).then(function (dl) {
      if (!dl || !dl.ok) { unreadable++; return; }
      try {
        var j = JSON.parse(dl.text);
        if (j && j.scope === 'module') { readable++; add(_dynEbStemEntries(j.questions)); } else { unreadable++; }
      } catch (e) { unreadable++; /* ilegible: se cuenta */ }
    }).catch(function () { unreadable++; });
  }));
  // Fix round 1 (m6): si el backend manda los exámenes de módulo como dependencias, son la única fuente
  // (nunca el almacenamiento del navegador).
  if (deps.length) {
    return { stems: out, meta: { source: readable > 0 ? 'dependencies' : 'dependencies_unreadable', dependencies: deps.length, unreadable: unreadable } };
  }
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
  return { stems: out, meta: { source: out.length ? 'session' : 'none', dependencies: 0, unreadable: 0 } };
}
async function _dynEbLoadModuleStems(item) {
  return (await _dynEbLoadModuleStemsDetailed(item)).stems;
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
  // Exam-bank D1: texto marcado con [S#] (va al prompt) y marcas → texto exacto (para resolver "evidenceRef").
  var cit = {};
  chapters.forEach(function (c) { cit[c.id] = dynExamBankCitableIndex(md[c.id]); });
  var summaries = await _dynLoadContextSummaries(item);
  // #542 (I3): el examen final no repite las preguntas de las evaluaciones de módulo.
  var stemsInfo = scope === 'final' ? await _dynEbLoadModuleStemsDetailed(item) : { stems: [], meta: null };
  var externalStems = stemsInfo.stems;
  var infoCache = {};
  function chapterInfo(chId) {
    if (!Object.prototype.hasOwnProperty.call(md, chId)) return null;
    if (!infoCache[chId]) {
      var norm = dynNormalizeExamText(md[chId]);
      var tokens = {};
      dynExamTokens(norm).forEach(function (t) { tokens[t] = true; });
      // md: texto crudo para la reubicación determinística de la evidencia (BANKOPT 1b).
      infoCache[chId] = { norm: norm, tokens: tokens, md: md[chId], refs: cit[chId] ? cit[chId].refs : null };
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
        var ch = { index: chunks.length, unit: unit, first: k === 0, ids: part.map(function (x) { return x.id; }), seqPart: part };
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
      ? dynExamBankChapterPromptParts(courseContext, outline, chapter, leaves, cit[unit.chapterId].text, summaries[unit.chapterId] || null, ped)
      : dynFinalExamBankChapterPromptParts(courseContext, outline, outlineModule(unit.moduleId), chapter, leaves, cit[unit.chapterId].text, summaries, ped);
  }
  function avoidFor(unit) {
    return scope === 'final' ? dynExamBankAvoidBlock(externalStems, unit.chapterId) : '';
  }
  function bodyBytes(parts) { return dynExamBankBodyBytes(sys, dynExamBankUserContent(parts), maxTok); }
  // Ningún cuerpo puede pasar el límite del proxy: falla ANTES de gastar (no retryable: el texto no cambia).
  var tagsReduced = 0;
  // rev. M3: las marcas [S#] agrandan el prompt (~7 bytes por fragmento). Un capítulo que no cabe con todas las marcas
  // se reintenta con MENOS marcas (las primeras del capítulo) antes de fallar; sin marcas = el texto de siempre.
  chapters.forEach(function (c) {
    var mine = chunks.filter(function (ch) { return ch.unit.chapterId === c.id; });
    var over = function () { return mine.some(function (ch) { return bodyBytes(ch.callParts) > DYN_EXAM_BANK_MAX_BODY_BYTES; }); };
    var tags = cit[c.id].list.length;
    while (over() && tags > 0) {
      var excess = Math.max.apply(null, mine.map(function (ch) { return bodyBytes(ch.callParts) - DYN_EXAM_BANK_MAX_BODY_BYTES; }));
      tags = Math.max(0, tags - Math.max(10, Math.ceil(excess / 6)));
      cit[c.id] = dynExamBankCitableIndex(md[c.id], tags);
      infoCache[c.id] = null;
      delete infoCache[c.id];
      mine.forEach(function (ch) {
        ch.parts = _dynEbChunkParts(ch.unit, ch.seqPart, false);
        ch.prompt = dynExamBankPromptText(ch.parts);
        ch.callParts = dynExamBankWithTail(ch.parts, ch.parts.tail + avoidFor(ch.unit));
      });
      tagsReduced++;
    }
  });
  var tooBig = chunks.filter(function (ch) { return bodyBytes(ch.callParts) > DYN_EXAM_BANK_MAX_BODY_BYTES; });
  if (tooBig.length) {
    return fail('EXAM_BANK_PROMPT_TOO_LARGE: el texto del capítulo ' + tooBig[0].unit.chapterId + ' no cabe en una llamada (' + bodyBytes(tooBig[0].callParts) + ' bytes > ' + DYN_EXAM_BANK_MAX_BODY_BYTES + ')', false);
  }

  var stats = { calls: { main: 0, validation_retry: 0, continuation: 0 }, promptChars: 0, outputChars: 0, repairCallsFailed: 0, repairCallsSkipped: 0, cachedChunks: 0, splitRetries: 0, evidenceRelocated: 0, relocations: [], draftChunks: 0, moneyNormalized: 0,
    // Exam-bank D4 (instrumentación): evidencia por marca, candidatas del pool y de la estrategia alternativa, y la
    // primera pasada (pedidas / válidas por tipo) también cuando el intento falla.
    evidenceByRef: 0, poolCandidates: 0, mintedIds: 0, strategyCandidates: 0, draftUnused: 0, firstPass: {}, tagsReduced: tagsReduced,
    // Revisión de forma: candidatas revisables detectadas, pedidas, devueltas y válidas; llamadas y por tipo.
    revision: { revisable: 0, requested: 0, returned: 0, valid: 0, calls: 0, callsFailed: 0, skipped: 0, afterMain: 0, inRounds: 0, fromDraft: 0, byType: {}, stillCodes: {} } };
  // Exam-bank D4: submotivos de rechazo por código (mensaje normalizado: sin cifras ni ids), los 6 más frecuentes.
  var rejectedDetail = {};
  function noteDetail(code, message) {
    var k = String(message || '').replace(/"[^"]*"/g, '"…"').replace(/\d+([.,]\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80);
    var m = rejectedDetail[code] = rejectedDetail[code] || {};
    m[k] = (m[k] || 0) + 1;
  }
  function topDetail() {
    var out = {};
    Object.keys(rejectedDetail).forEach(function (code) {
      out[code] = Object.keys(rejectedDetail[code]).map(function (k) { return [k, rejectedDetail[code][k]]; })
        .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 6).map(function (x) { return x[1] + '× ' + x[0]; });
    });
    return out;
  }
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
  // listKey: "questions" (generación / reparación) o "revisions" (revisión de forma); statKey: contador de stats.calls.
  async function callJson(role, parts, listKey, statKey) {
    var meta = {};
    var key = listKey || 'questions';
    // Bloques con cache_control (source + task); el texto de la llamada es el de las 3 partes.
    var prompt = dynExamBankUserContent(parts);
    stats.calls[statKey || role] = (stats.calls[statKey || role] || 0) + 1;
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
    // Mensajes literales (clasificador de fallas del backend: failure-classifier.ts).
    if (!_dynIsPlainObject(p.obj) || !Array.isArray(p.obj[key])) {
      if (key === 'revisions') return { ok: false, error: 'falta la lista "revisions"' };
      return { ok: false, error: 'falta la lista "questions"' };
    }
    return { ok: true, questions: p.obj[key] };
  }
  function expectFor(rec) {
    return { id: rec.id, type: rec.type, scope: scope, chapterIds: [rec.unit.chapterId], moduleId: rec.unit.moduleId };
  }
  var roundLog = null; // D3: { leafIndex: [{ ok, code, ref, terms }] } de la ronda de reparación en curso
  // isRevision: la lista viene de una revisión de forma (parche ya aplicado): una revisión por candidata.
  // quiet: recarga de candidatas del borrador (ya contadas en el intento anterior): no suma a rejectedByCode (rev. M7).
  function ingest(list, allowed, isRepair, fromStore, isRevision, quiet) {
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
      if (isRevision) {
        var rv = stats.revision.byType[rec.type] = stats.revision.byType[rec.type] || { returned: 0, valid: 0 };
        stats.revision.returned++; rv.returned++;
        if (r.ok) { stats.revision.valid++; rv.valid++; } else _dynEbCount(stats.revision.stillCodes, r.code);
      }
      if (!isRepair && !fromStore) {
        var fp = stats.firstPass[rec.type] = stats.firstPass[rec.type] || { returned: 0, valid: 0 };
        fp.returned++;
        if (r.ok) fp.valid++;
      }
      if (isRepair && roundLog) {
        (roundLog[rec.leafIndex] = roundLog[rec.leafIndex] || []).push({ id: id, ok: !!r.ok, code: r.ok ? null : r.code, ref: _dynIsPlainObject(raw) && typeof raw.evidenceRef === 'string' ? raw.evidenceRef.trim().slice(0, 8) : null, terms: r.ok || !_dynIsPlainObject(raw) || !Array.isArray(raw.pairs) ? null : raw.pairs.map(function (x) { return x && typeof x.term === 'string' ? x.term.trim().slice(0, 40) : ''; }).filter(Boolean).slice(0, 6) });
      }
      if (r.ok) {
        if (r.evidenceByRef) stats.evidenceByRef++;
        if (r.evidenceRelocated) {
          stats.evidenceRelocated++;
          // Auditoría (fix round 1, C1): qué escribió el modelo y qué texto real quedó (máx. 20).
          if (stats.relocations.length < 20) stats.relocations.push({ id: id, from: String(raw.evidence).slice(0, 240), to: r.q.evidence });
        }
        // La evidencia reubicada queda en la copia guardada (caché del navegador y borrador del servidor).
        // D1: la copia guardada (caché / borrador) lleva la evidencia RESUELTA y sin "evidenceRef".
        var stored = (r.evidenceRelocated || r.evidenceByRef) ? Object.assign({}, raw, { evidence: r.q.evidence }) : raw;
        if (r.evidenceByRef) delete stored.evidenceRef;
        rec.status = 'valid'; rec.q = r.q; rec.raw = stored;
        rec.combos = r.combos; rec.reasons = []; rec.repaired = !!isRepair; rec._dupAccepted = false;
        rec.revCand = null;
      } else {
        // rev. M7: el rechazo de una revisión va solo a stats.revision.stillCodes (la candidata ya se contó).
        if (!isRevision && !quiet) { _dynEbCount(rejectedByCode, r.code); noteDetail(r.code, r.message); }
        if (!(isRepair && rec.status === 'valid')) {
          rec.status = 'rejected'; rec.reasons = [{ code: r.code, message: r.message }];
          // Revisión de forma: la candidata rechazada SOLO por forma se guarda con sus correcciones (una revisión por
          // candidata: el resultado de una revisión ya no se vuelve a revisar; lo cubre la reparación).
          var rp = !isRevision ? dynExamBankRevisionPlan(raw, expectFor(rec), chapterInfo, r) : null;
          rec.revCand = rp ? { raw: JSON.parse(JSON.stringify(raw)), fixes: rp.fixes, code: rp.code, fields: rp.fields } : null;
          if (rp) stats.revision.revisable++;
        }
      }
    });
  }
  function idSet(ids) { var o = {}; ids.forEach(function (id) { o[id] = true; }); return o; }
  function recordList() { return Object.keys(records).map(function (k) { return records[k]; }); }
  // ── Exam-bank D2: ids del pool (más candidatas que el faltante) ──
  // Mismo prefijo y etiqueta que la hoja (p. ej. «M2-C6-EM-»), número siguiente al mayor de la hoja; el registro
  // queda en la unidad (capítulo) indicada. El banco subido sigue con 2·slots por hoja: el pool solo amplía la
  // selección. Los ids acuñados en un intento vuelven con el borrador (mintFromDraft).
  function leafPrefixOf(li) {
    var r0 = recordList().filter(function (r) { return r.leafIndex === li && !r.minted; })[0];
    return r0 ? r0.id.replace(/\d+$/, '') : null;
  }
  var POOL_REASON = { code: 'EXAM_BANK_POOL', message: 'pregunta ADICIONAL para completar esta hoja: escribe una pregunta NUEVA, distinta de las aceptadas' };
  function addRecord(id, li, unit) {
    var first = chunks.filter(function (ch) { return ch.unit === unit; })[0];
    records[id] = { id: id, leafIndex: li, order: order++, type: plan[li].type, unit: unit, status: 'missing', minted: true,
      reasons: [POOL_REASON],
      q: null, raw: null, combos: null, chunk: first ? first.index : 0, repaired: false };
    return records[id];
  }
  function mint(li, unit) {
    var pre = leafPrefixOf(li);
    if (!pre) return null;
    var max = 0;
    recordList().forEach(function (r) { if (r.leafIndex === li) { var x = /(\d+)$/.exec(r.id); if (x) max = Math.max(max, Number(x[1])); } });
    var id = pre + _dynPad2Bank(max + 1);
    if (records[id] || !DYN_EXAM_BANK_ID_RE.test(id)) return null;
    return addRecord(id, li, unit);
  }
  function mintFromDraft(q) {
    var unit = units.filter(function (u) { return u.chapterId === q.chapterId; })[0];
    if (!unit) return;
    for (var li = 0; li < plan.length; li++) {
      var leaf = plan[li];
      if (leaf.type !== q.type) continue;
      if (scope === 'module' ? leaf.chapterId !== q.chapterId : leaf.moduleId !== unit.moduleId) continue;
      var pre = leafPrefixOf(li);
      if (pre && q.id.indexOf(pre) === 0 && /^\d+$/.test(q.id.slice(pre.length)) && DYN_EXAM_BANK_ID_RE.test(q.id)) addRecord(q.id, li, unit);
      return;
    }
  }
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
    // D2: las preguntas del pool con ids acuñados en un intento anterior vuelven a tener su registro.
    draft.questions.forEach(function (q) { if (_dynIsPlainObject(q) && typeof q.id === 'string' && !records[q.id]) mintFromDraft(q); });
    ingest(draft.questions, idSet(Object.keys(records)), false, true);
    draftInfo.questions = recordList().filter(function (r) { return r.status === 'valid'; }).length;
    if (draft.candidates && draft.candidates.length) {
      // Solo para ids sin pregunta válida: el validador las vuelve a rechazar y quedan revisables (sin llamadas acá).
      draft.candidates.forEach(function (q) { if (_dynIsPlainObject(q) && typeof q.id === 'string' && !records[q.id]) mintFromDraft(q); });
      var candList = draft.candidates.filter(function (q) { return _dynIsPlainObject(q) && typeof q.id === 'string' && records[q.id] && records[q.id].status !== 'valid'; });
      var before = stats.revision.revisable;
      ingest(candList, idSet(candList.map(function (q) { return q.id; })), false, true, false, true);
      stats.revision.fromDraft = stats.revision.revisable - before;
      draftInfo.candidates = stats.revision.fromDraft;
    }
  }
  // Revisión de forma: una parte con candidatas revisables del borrador tampoco se vuelve a pedir (se revisan).
  // rev. M4: con al menos una válida, o con candidatas revisables para la mitad de sus ids o más.
  function chunkHasValid(ch) {
    if (ch.ids.some(function (id) { return records[id].status === 'valid'; })) return true;
    return 2 * ch.ids.filter(function (id) { return !!records[id].revCand; }).length >= ch.ids.length;
  }
  // D3: memoria por hoja (se llena desde el borrador antes de reparar); existe desde ya porque una falla de la
  // generación (EXAM_BANK_GENERATION_FAILED) también arma el borrador.
  var hist = Object.create(null);
  var a = null;
  if (draft.leafHistory) {
    // rev. M4: memoria del borrador saneada — solo claves de hojas del plan, números enteros acotados, textos con tope
    // (van al prompt de reparación) y objeto sin prototipo.
    var planKeys = {};
    plan.forEach(function (leaf) { planKeys[_dynEbOwnerOf(leaf) + '|' + leaf.type] = true; });
    var nInt = function (v) { return typeof v === 'number' && isFinite(v) && v > 0 ? Math.min(Math.floor(v), 10000) : 0; };
    var str = function (v, n) { return typeof v === 'string' ? v.slice(0, n) : null; };
    Object.keys(draft.leafHistory).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(planKeys, k)) return;
      var h = draft.leafHistory[k];
      if (!_dynIsPlainObject(h)) return;
      var sc0 = Object.create(null);
      if (_dynIsPlainObject(h.stratCodes)) Object.keys(h.stratCodes).slice(0, 20).forEach(function (c) { var v = nInt(h.stratCodes[c]); if (v && /^[A-Z_]{1,60}$/.test(c)) sc0[c] = v; });
      hist[k] = { stuck: nInt(h.stuck), strategy: h.strategy === true, strategyFails: nInt(h.strategyFails), sig: typeof h.sig === 'string' && /^[A-Z_]{1,60}$/.test(h.sig) ? h.sig : null, capacity: false,
        tried: nInt(h.tried), triedStrategy: nInt(h.triedStrategy), stratDryRounds: nInt(h.stratDryRounds), stratDryTries: nInt(h.stratDryTries), stratCodes: sc0,
        rejectedRefs: Array.isArray(h.rejectedRefs) ? h.rejectedRefs.filter(function (x) { return typeof x === 'string' && DYN_EXAM_REF_RE.test(x); }).slice(-40) : [],
        rejectedTerms: Array.isArray(h.rejectedTerms) ? h.rejectedTerms.filter(Array.isArray).map(function (t) { return t.filter(function (x) { return typeof x === 'string'; }).map(function (x) { return x.slice(0, 40); }).slice(0, 6); }).slice(-12) : [] };
    });
  }
  // Generación: caché validada / borrador → si no, una llamada por parte; truncada → la parte se pide
  // PARTIDA EN DOS (validation_retry); JSON inválido → UN reintento del mismo tamaño.
  // BANKOPT (opción 2): la PRIMERA parte de cada capítulo sale antes que sus hermanas; las hermanas
  // esperan a que termine (su prefijo — capítulo + reglas — ya está en el caché de prompts).
  // ── Revisión de forma (ver dynExamBankRevisionPlan) ──
  // Rendimiento medido de la revisión en ESTE intento (≥ 4 muestras), si no el supuesto.
  function revYield() {
    var rv = stats.revision;
    return rv.returned >= 4 ? Math.max(0.2, rv.valid / rv.returned) : DYN_EXAM_BANK_REVISION_YIELD_PRIOR;
  }
  // rev. M5: revisiones que no sirven (≥ 8 devueltas y < 5 % válidas) → no se piden más en el intento (como la reparación).
  function revisionStopped() {
    var rv = stats.revision;
    if (rv.returned >= 8 && rv.valid < 0.05 * rv.returned) { rv.stopped = true; return true; }
    return false;
  }
  // Llamadas de revisión para estas candidatas: por capítulo (mismo prefijo que sus partes → caché) y cortadas por la
  // salida estimada del parche. Cada candidata se revisa a lo sumo una vez por intento.
  function revisionCalls(recs) {
    var byU = [];
    recs.forEach(function (r) {
      var g = byU.filter(function (x) { return x.unit === r.unit; })[0];
      if (!g) { g = { unit: r.unit, seq: [] }; byU.push(g); }
      g.seq.push({ id: r.id, type: r.type });
    });
    var out = [];
    byU.forEach(function (g) {
      var first = chunks.filter(function (ch) { return ch.unit === g.unit; })[0];
      // rev. M2: además del tope de tokens, ≤ DYN_EXAM_BANK_REVISION_MAX_ITEMS por llamada (lo que lista el prompt).
      dynExamBankSplitByTokens(g.seq, DYN_EXAM_BANK_MAX_OUTPUT_EST, DYN_EXAM_BANK_REVISION_TOKENS_EST).forEach(function (part) {
        for (var i = 0; i < part.length; i += DYN_EXAM_BANK_REVISION_MAX_ITEMS) out.push({ base: first, ids: part.slice(i, i + DYN_EXAM_BANK_REVISION_MAX_ITEMS).map(function (x) { return x.id; }) });
      });
    });
    return out;
  }
  async function runRevision(c) {
    var cands = {};
    var items = [];
    c.ids.forEach(function (id) {
      var r = records[id];
      if (!r || r.status === 'valid' || !r.revCand) return;
      cands[id] = r.revCand;
      items.push({ id: id, type: r.type, chapterId: r.unit.chapterId, moduleId: r.unit.moduleId, question: r.revCand.raw, fixes: r.revCand.fixes });
    });
    if (!items.length) return;
    var parts = dynExamBankRevisionParts(c.base.parts, items);
    if (bodyBytes(parts) > DYN_EXAM_BANK_MAX_BODY_BYTES) { stats.revision.skipped += items.length; return; }
    Object.keys(cands).forEach(function (id) { records[id].revCand = null; });
    stats.revision.requested += items.length;
    stats.revision.calls++;
    var res = await callJson('continuation', parts, 'revisions', 'revision');
    if (!res.ok) {
      // Una llamada que no sirvió (JSON inválido, truncada) no es evidencia: las candidatas siguen revisables.
      stats.revision.callsFailed++;
      Object.keys(cands).forEach(function (id) { if (records[id].status !== 'valid' && !records[id].revCand) records[id].revCand = cands[id]; });
      return;
    }
    var merged = [];
    var seen = {};
    res.questions.forEach(function (p) {
      if (!_dynIsPlainObject(p) || typeof p.id !== 'string' || !Object.prototype.hasOwnProperty.call(cands, p.id) || seen[p.id]) return;
      seen[p.id] = true;
      var m = dynExamBankApplyRevision(cands[p.id].raw, p, cands[p.id].fields);
      if (m) merged.push(m);
    });
    ingest(merged, idSet(Object.keys(seen)), true, false, true);
    chunks.filter(function (ch) { return ch.unit === c.base.unit; }).forEach(saveChunk);
  }
  // Cuando terminan TODAS las partes de un capítulo (prefijo recién escrito en caché): se revisan las candidatas
  // revisables de cada hoja del capítulo hasta cubrir su cuota del objetivo (2·slots × pedidas en el capítulo / pedidas
  // en la hoja; en el examen del módulo = la hoja entera), con el rendimiento esperado de la revisión. Lo que falte lo
  // decide la reparación con la hoja ya ensamblada.
  async function reviseAfterMain(ids) {
    if (revisionStopped()) return;
    var byLeaf = {};
    ids.forEach(function (id) { var r = records[id]; (byLeaf[r.leafIndex] = byLeaf[r.leafIndex] || []).push(r); });
    var pick = [];
    Object.keys(byLeaf).forEach(function (k) {
      var li = Number(k);
      var rs = byLeaf[li];
      var total = recordList().filter(function (r) { return r.leafIndex === li && !r.minted; }).length;
      var share = Math.ceil(rs.length * 2 * plan[li].slots / Math.max(1, total));
      var deficit = share - rs.filter(function (r) { return r.status === 'valid'; }).length;
      if (deficit <= 0) return;
      var cands = rs.filter(function (r) { return r.status !== 'valid' && r.revCand; })
        .sort(function (x, y) { return x.revCand.fixes.length - y.revCand.fixes.length || x.order - y.order; });
      pick = pick.concat(cands.slice(0, Math.ceil(deficit / revYield())));
    });
    if (!pick.length) return;
    stats.revision.afterMain += pick.length;
    var calls = revisionCalls(pick);
    for (var i = 0; i < calls.length; i++) await runRevision(calls[i]);
  }
  // Al inicio de cada ronda de reparación: candidatas revisables de las hojas cortas (y de capítulos del final sin
  // preguntas) antes de pedir reemplazos; los reemplazos cubren solo lo que la revisión no cerró.
  async function reviseShortLeaves(round) {
    if (revisionStopped()) return false;
    var pick = [];
    var taken = {};
    a.short.forEach(function (s) {
      if (H(s.leafIndex).capacity) return;
      if (round >= 2 && s.kept >= s.floor && !s.repairs.some(function (fix) { return fix.deficit; })) return;
      var need = Math.max(0, s.need || 0);
      if (!need) return;
      var defCh = {};
      (s.chapterDeficit || []).forEach(function (d) { defCh[d.chapterId] = true; });
      var cands = recordList().filter(function (r) { return r.leafIndex === s.leafIndex && r.status !== 'valid' && r.revCand && !taken[r.id]; })
        .sort(function (x, y) { return (defCh[y.unit.chapterId] ? 1 : 0) - (defCh[x.unit.chapterId] ? 1 : 0) || x.revCand.fixes.length - y.revCand.fixes.length || x.order - y.order; });
      cands.slice(0, Math.ceil(need / revYield())).forEach(function (r) { taken[r.id] = true; pick.push(r); });
    });
    a.uncovered.forEach(function (chId) {
      recordList().filter(function (r) { return r.unit.chapterId === chId && r.status !== 'valid' && r.revCand && !taken[r.id]; }).slice(0, 2)
        .forEach(function (r) { taken[r.id] = true; pick.push(r); });
    });
    if (!pick.length) return false;
    stats.revision.inRounds += pick.length;
    await _dynExamBankPool(revisionCalls(pick).map(function (c) { return function () { return runRevision(c); }; }), DYN_EXAM_BANK_CONCURRENCY);
    return true;
  }
  // ── Regla de conjunto (≤ 30 % «correcta la más larga»): revisión de longitud SOLO del excedente ──
  var lenTried = Object.create(null);
  (draft.lengthRevisedIds || []).forEach(function (id) { lenTried[id] = true; });
  var setRuleStats = { excessFirst: null, asked: 0, returned: 0, fixed: 0, calls: 0, callsFailed: 0, skipped: 0, passes: 0 };
  var lenPlans = Object.create(null);
  var lenFailedThisAttempt = Object.create(null); // rev. r2 N2: una llamada fallida no se repite igual en el intento
  function lengthPlanOf(rec) {
    if (!rec || rec.status !== 'valid' || !rec.raw || rec.type !== 'multichoice') return null;
    if (!Object.prototype.hasOwnProperty.call(lenPlans, rec.id)) lenPlans[rec.id] = dynExamBankLengthRevisionPlan(rec.raw, expectFor(rec), chapterInfo);
    return lenPlans[rec.id];
  }
  // includeFailed: cuenta también las que fallaron por formato EN ESTE intento (para decidir si queda algo por revisar:
  // una llamada fallida no es evidencia — rev. r3 R1).
  function lengthCandidates(asm, includeFailed) {
    var inBank = idSet(asm.questions.filter(function (q) { return q.type === 'multichoice'; }).map(function (q) { return q.id; }));
    return recordList().filter(function (r) { return inBank[r.id] && r.status === 'valid' && _dynEbReachOnlyLongest(r.combos) && !lenTried[r.id] && (includeFailed || !lenFailedThisAttempt[r.id]); })
      .sort(function (x, y) { return x.order - y.order; })
      .filter(function (r) { return !!lengthPlanOf(r); });
  }
  async function runLengthRevision(c) {
    var items = [];
    c.ids.forEach(function (id) {
      var r = records[id];
      items.push({ id: id, type: 'multichoice', chapterId: r.unit.chapterId, moduleId: r.unit.moduleId, question: r.raw, fixes: lenPlans[id].fixes });
    });
    var parts = dynExamBankRevisionParts(c.base.parts, items);
    // rev. r2 N2: el número de intento va en el tail — el reintento pregunta de nuevo (otro cuerpo, otro punto de guardado).
    parts = dynExamBankWithTail(parts, parts.tail + '\n\nREVISIÓN DE LONGITUD (regla de conjunto del banco), intento ' + (item.attempt || 1) + '.');
    if (bodyBytes(parts) > DYN_EXAM_BANK_MAX_BODY_BYTES) { setRuleStats.skipped += items.length; c.ids.forEach(function (id) { lenFailedThisAttempt[id] = true; }); return; }
    setRuleStats.asked += items.length;
    setRuleStats.calls++;
    var res = await callJson('continuation', parts, 'revisions', 'lengthRevision');
    if (!res.ok) { setRuleStats.callsFailed++; c.ids.forEach(function (id) { lenFailedThisAttempt[id] = true; }); return; }
    var seen = {};
    res.questions.forEach(function (p) {
      if (!_dynIsPlainObject(p) || typeof p.id !== 'string' || !lenPlans[p.id] || seen[p.id] || c.ids.indexOf(p.id) < 0) return;
      seen[p.id] = true;
      // rev. I1: solo una respuesta REAL del modelo gasta la revisión de ese id (una llamada fallida no es evidencia).
      lenTried[p.id] = true;
      setRuleStats.returned++;
      var rec = records[p.id];
      var m = dynExamBankApplyLengthRevision(rec.raw, p, lenPlans[p.id].idx);
      if (!m) return;
      // rev. M1: moneda es-CO también en los distractores alargados (antes de validar).
      if (bankMoneyCo) stats.moneyNormalized += dynNormalizeMoneyDeep(m);
      if (!dynExamBankLengthPatchOk(rec.raw, m, lenPlans[p.id].idx)) { setRuleStats.guardRejected = (setRuleStats.guardRejected || 0) + 1; return; }
      var r = dynExamBankCheckQuestion(m, expectFor(rec), chapterInfo);
      // Solo si pasa el validador Y deja de ser «solo más larga»; si no, queda la original (válida).
      if (!r.ok || _dynEbReachOnlyLongest(r.combos)) return;
      var stored = (r.evidenceRelocated || r.evidenceByRef) ? Object.assign({}, m, { evidence: r.q.evidence }) : m;
      if (r.evidenceByRef) delete stored.evidenceRef;
      rec.q = r.q; rec.raw = stored; rec.combos = r.combos; rec.lengthFixed = true;
      setRuleStats.fixed++;
    });
    chunks.filter(function (ch) { return ch.unit === c.base.unit; }).forEach(saveChunk);
  }
  // Una pasada: revisa a lo sumo el excedente actual (las de menos índice primero; cada id una vez por intento).
  async function reviseLengthExcess() {
    var excess = dynExamBankLengthBiasExcess(a);
    if (setRuleStats.excessFirst === null && a) setRuleStats.excessFirst = excess;
    if (!excess) return false;
    // Sin ninguna corrección tras ≥ 3 respuestas del modelo en el intento → no insiste (las siguientes pasadas no se piden).
    if (setRuleStats.stalled) return false;
    var pick = lengthCandidates(a).slice(0, excess);
    if (!pick.length) return false;
    setRuleStats.passes++;
    var calls = revisionCalls(pick);
    await _dynExamBankPool(calls.map(function (c) { return function () { return runLengthRevision(c); }; }), DYN_EXAM_BANK_CONCURRENCY);
    if (setRuleStats.fixed === 0 && setRuleStats.returned >= 3) setRuleStats.stalled = true;
    return true;
  }
  var warm = {};
  units.forEach(function (u, i) { u._key = i; var res; warm[i] = { p: new Promise(function (r) { res = r; }) }; warm[i].done = res; });
  async function runChunk(ch) {
    var cached = _dynEbCacheGet(cacheKey(ch));
    if (cached) { stats.cachedChunks++; ch.fromCache = true; ingest(cached, idSet(ch.ids), false, true); return; }
    if (draft.questions && chunkHasValid(ch)) { stats.draftChunks++; ch.skippedByDraft = true; return; }
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
      // Exam-bank D2: una parte que falla dos veces (JSON inválido / truncada) ya no tumba el intento entero: sus ids
      // quedan FALTANTES y la reparación con pool los cubre en este mismo intento (el banco nunca sale corto: si no
      // alcanzan, EXAM_BANK_INCOMPLETE con borrador como siempre).
      if (!r2.ok) { stats.mainPartsFailed = (stats.mainPartsFailed || 0) + 1; console.warn('[dynExecutor:' + item.type + '] ' + item.itemKey + ' parte ' + (ch.index + 1) + '/' + chunks.length + ' falló dos veces (' + r2.error + '): la cubre la reparación'); continue; }
      ingest(r2.questions, idSet(ids), false);
      saveChunk(ch);
    }
  }
  var ordered = chunks.filter(function (ch) { return ch.first; }).concat(chunks.filter(function (ch) { return !ch.first; }));
  try {
    units.forEach(function (u) { u._pending = chunks.filter(function (ch) { return ch.unit === u; }).length; });
    await _dynExamBankPool(ordered.map(function (ch) {
      return async function () {
        var w = warm[ch.unit._key];
        if (!ch.first) await w.p;
        try { await runChunk(ch); } finally { if (ch.first) w.done(); }
        // Revisión de forma del capítulo apenas terminan sus partes (mismo prefijo, todavía en caché).
        if (--ch.unit._pending === 0) {
          await reviseAfterMain([].concat.apply([], chunks.filter(function (x) { return x.unit === ch.unit; }).map(function (x) { return x.ids; })));
        }
      };
    }), DYN_EXAM_BANK_CONCURRENCY);
  } catch (e) {
    if (e && e.examBankFail) return failWithDraft(e.msg, 'generation_failed');
    throw e; // fatal / reintentos agotados: processItem lo clasifica (_dynMapApiError)
  }
  // D4: un id de una parte que no se pidió porque el borrador ya la cubría no es una pregunta «faltante» del modelo.
  recordList().forEach(function (r) {
    if (r.status !== 'missing') return;
    if (chunks[r.chunk] && chunks[r.chunk].skippedByDraft) stats.draftUnused++;
    else {
      _dynEbCount(rejectedByCode, 'EXAM_BANK_MISSING');
      // D4 (rev. M10): una pregunta pedida y no devuelta cuenta en el rendimiento de la primera pasada (como inválida).
      if (!(chunks[r.chunk] && chunks[r.chunk].fromCache)) { var fpm = stats.firstPass[r.type] = stats.firstPass[r.type] || { returned: 0, valid: 0 }; fpm.returned++; }
    }
  });
  if (!rejectedByCode.EXAM_BANK_MISSING) delete rejectedByCode.EXAM_BANK_MISSING;

  // Reparación: ronda 1 = hojas bajo 2·slots (+ capítulos sin preguntas en el final); ronda 2 =
  // solo hojas bajo el piso (I2). Por capítulo, UNA llamada si el pedido estimado cabe (si no,
  // una por parte); nunca más de una llamada de reparación por parte y ronda. Con la holgura,
  // solo se piden los ids que faltan para el objetivo (dynExamBankAssemble → short[].repairs).
  a = assemble();
  var keptAtStart = a.perLeaf.map(function (r) { return r.kept; }); // rev. I2: avance de cada hoja en ESTE intento
  // ── Exam-bank D2/D3: reparación con pool, memoria por hoja y estrategia alternativa ──
  // Ronda 1 = hojas bajo 2·slots (+ capítulos sin preguntas en el final); rondas 2+ = solo hojas bajo el piso.
  // D2: por cada hoja corta se piden faltante / rendimiento medido (+1) candidatas (entre faltante+2 y 6×faltante; ×2 desde la 2.ª ronda; tope 2 llamadas por hoja y ronda)
  //     y el ensamblado conserva las mejores 2·slots (duplicados, balance V/F y rangos como siempre).
  // D3: memoria por hoja (fragmentos y términos ya usados o rechazados) en cada reparación. Una hoja que no avanza
  //     en una ronda pasa a la ESTRATEGIA ALTERNATIVA (otro fragmento, otra situación, marcas aún no usadas); si con
  //     ella tampoco avanza en 2 rondas con la misma firma (≥ 10 candidatas, ≥ 80 % mismo código) — o en 2 intentos enteros con ella (≥ 20 candidatas) —, la hoja queda AGOTADA: no se gasta más
  //     y el intento falla con EXAM_BANK_LEAF_CAPACITY (clase D: sin reintentos automáticos). La memoria viaja en el
  //     borrador, así que el diagnóstico se completa a más tardar en el 2.º intento.
  function leafKey(li) { return _dynEbOwnerOf(plan[li]) + '|' + plan[li].type; }
  function H(li) {
    var k = leafKey(li);
    return hist[k] || (hist[k] = { stuck: 0, strategy: false, strategyFails: 0, sig: null, capacity: false, tried: 0, triedStrategy: 0, rejectedRefs: [], rejectedTerms: [] });
  }
  var repairPass = {};
  function typeYield(type) {
    var f = stats.firstPass[type] || { returned: 0, valid: 0 };
    var r = repairPass[type] || { returned: 0, valid: 0 };
    var n = f.returned + r.returned;
    return n >= 4 ? (f.valid + r.valid) / n : 0.5;
  }
  function typeSamples(type) { return ((stats.firstPass[type] || {}).returned || 0) + ((repairPass[type] || {}).returned || 0); }
  function uniq(xs) { var seen = {}; return xs.filter(function (x) { if (seen[x]) return false; seen[x] = true; return true; }); }
  function memoryFor(unit, list) {
    var c = cit[unit.chapterId];
    var lis = uniq(list.map(function (x) { return x.li; })).filter(function (li) { return li != null; });
    var blocks = [];
    lis.forEach(function (li) {
      var h = H(li);
      var leaf = plan[li];
      var acceptedHere = recordList().filter(function (r) { return r.leafIndex === li && r.unit === unit && r.status === 'valid' && r.q; });
      var usedRefs = uniq(acceptedHere.map(function (r) { return c.byText[dynNormalizeExamText(r.q.evidence)]; }).filter(Boolean));
      var usedTerms = leaf.type === 'match' ? acceptedHere.map(function (r) { return r.q.pairs.map(function (x) { return x.term; }).join(' / '); }) : [];
      var lines = [];
      if (h.strategy) {
        var avoid = {};
        usedRefs.concat(h.rejectedRefs).forEach(function (x) { avoid[x] = true; });
        var fresh = c.list.filter(function (u) { return !avoid[u.ref]; });
        if (leaf.type === 'match') fresh = fresh.filter(function (u) { return /[:;,]/.test(u.text); }).concat(fresh.filter(function (u) { return !/[:;,]/.test(u.text); }));
        lines.push(DYN_EXAM_BANK_STRATEGY_MARKER + ' para esta hoja: las candidatas anteriores fallaron' + (h.sig ? ' por ' + h.sig : '') + '. Cambia de enfoque: otra situación y otro fragmento' + (leaf.type === 'match' ? ', y otros términos' : '') + '.'
          + (fresh.length ? ' Elige "evidenceRef" entre estas marcas aún no usadas: ' + fresh.slice(0, 30).map(function (u) { return u.ref; }).join(', ') + '.' : '')
          + (leaf.type === 'multichoice' ? ' En selección múltiple: la opción correcta de 50 a 110 caracteres y cada distractor entre 0,7 y 1,4 veces su longitud.' : ''));
      }
      if (usedRefs.length) lines.push('marcas ya usadas por preguntas aceptadas de esta hoja: ' + usedRefs.join(', '));
      if (usedTerms.length) lines.push('términos ya usados en emparejamientos aceptados (usa otros): ' + usedTerms.slice(0, 8).join(' | '));
      if (h.rejectedRefs.length) lines.push('marcas de candidatas rechazadas: ' + uniq(h.rejectedRefs).slice(-15).join(', '));
      if (h.rejectedTerms.length) lines.push('pares de candidatas rechazadas (no los repitas): ' + h.rejectedTerms.slice(-6).map(function (t) { return t.join(' / '); }).join(' | '));
      if (lines.length) blocks.push('MEMORIA DE LA HOJA type "' + leaf.type + '":\n- ' + lines.join('\n- '));
    });
    return blocks.join('\n\n');
  }
  for (var round = 1; round <= DYN_EXAM_BANK_REPAIR_ROUNDS; round++) {
    // rev. I2: el avance de la ronda se mide desde ANTES de sus revisiones (una hoja que crece por revisión avanzó).
    var keptPreRound = a.perLeaf.map(function (l) { return l.kept; });
    if (await reviseShortLeaves(round)) a = assemble();
    if (await reviseLengthExcess()) a = assemble();
    // Rellenos «solo más larga» de hojas completas: se piden reemplazos SOLO si el banco sigue sobre el 30 % y a lo
    // sumo tantos como el excedente (antes: todos, aunque el banco cumpliera la regla).
    var fillerBudget = dynExamBankLengthBiasExcess(a);
    var keptIds = idSet(a.questions.map(function (q) { return q.id; }));
    var entries = [];
    var inEntries = {};
    var leafInfo = {};
    a.short.forEach(function (s) {
      var h = H(s.leafIndex);
      if (h.capacity) return;
      // Ronda 2+: hojas bajo el piso y (fix round 2, N3) capítulos del final bajo su mínimo en la hoja.
      var base = (round >= 2 && s.kept >= s.floor) ? s.repairs.filter(function (fix) { return fix.deficit; }) : s.repairs.slice();
      // Reemplazo de un relleno «solo más larga» VÁLIDO y conservado (no de un faltante ni de un déficit de capítulo):
      // solo dentro del excedente del banco sobre el 30 % (una pregunta válida nunca se reemplaza sin necesidad).
      base = base.filter(function (fix) {
        var rr = records[fix.id];
        var isFiller = !fix.deficit && rr && rr.status === 'valid' && keptIds[fix.id] && rr.type === 'multichoice' && _dynEbReachOnlyLongest(rr.combos);
        if (!isFiller) return true;
        if (fillerBudget <= 0) return false;
        fillerBudget--;
        return true;
      });
      if (!base.length) return;
      base.forEach(function (fix) { if (inEntries[fix.id]) return; entries.push(Object.assign({ li: s.leafIndex }, fix)); inEntries[fix.id] = true; });
      var need = Math.max(0, s.need || 0);
      if (need > 0) {
        // Desde la 2.ª ronda la hoja ya falló una vez con el pool: el doble de candidatas (tope 6×faltante).
        var ty = plan[s.leafIndex].type;
        // Sin tope por múltiplo del faltante: con rendimiento bajo (≈ 20 %) 6×faltante dejaba la última pregunta sin cubrir
        // (Monte Carlo de sensibilidad); el tope es por tokens (abajo).
        var want = Math.max(need + 2, Math.ceil((round >= 2 ? 2 : 1) * need / Math.max(typeYield(ty), 0.15)) + 1);
        // Rendimiento medido < 5 % (≥ 8 muestras): el modelo no produce (no es una hoja difícil); más candidatas no lo
        // arreglan → sin pool. Un rendimiento bajo pero real (p. ej. 20 %) sí recibe el pool completo.
        if (typeSamples(ty) >= 8 && typeYield(ty) < 0.05) want = need + 2;
        // rev. M6: tope por hoja y ronda = 14.000 tokens estimados (2 llamadas del worker, 4 del navegador; nunca menos que
        // faltante + 2): acota el peor caso sin depender del tamaño de llamada de cada ejecutor.
        want = Math.min(want, Math.max(need + 2, Math.floor(DYN_EXAM_BANK_POOL_ROUND_TOKENS / (DYN_EXAM_BANK_REPAIR_TOKENS_EST[ty] || 600))));
        // Prototipos = pedidos por faltante (no los reemplazos de una «solo más larga» ya conservada).
        var protos = base.filter(function (fix) { return records[fix.id].status !== 'valid' || !keptIds[fix.id]; });
        if (!protos.length) protos = base;
        var extra = Math.max(0, want - protos.length);
        for (var j = 0; j < extra; j++) {
          var proto = protos[j % protos.length];
          var unitP = records[proto.id].unit;
          var freeRec = recordList().filter(function (r) { return r.leafIndex === s.leafIndex && r.unit === unitP && !keptIds[r.id] && !inEntries[r.id] && r.status !== 'valid'; })[0];
          var rec2 = freeRec || mint(s.leafIndex, unitP);
          if (!rec2) break;
          if (!freeRec) stats.mintedIds++;
          inEntries[rec2.id] = true;
          var e2 = { id: rec2.id, li: s.leafIndex, pool: true };
          if (typeof proto.answer === 'boolean') e2.answer = proto.answer;
          if (proto.deficit) e2.deficit = true;
          entries.push(e2);
          stats.poolCandidates++;
        }
      }
      leafInfo[s.leafIndex] = { strategy: h.strategy, keptBefore: Math.min(s.kept, keptPreRound[s.leafIndex]) };
    });
    a.uncovered.forEach(function (chId) {
      recordList().forEach(function (r) {
        if (r.unit.chapterId === chId && r.status !== 'valid' && !inEntries[r.id]) { entries.push({ id: r.id, li: r.leafIndex }); inEntries[r.id] = true; }
      });
    });
    if (!entries.length) break;
    var byUnit = [];
    entries.forEach(function (fix) {
      var rec = records[fix.id];
      var reasons = rec.status === 'valid'
        ? [{ code: fix.code || 'EXAM_BANK_TF_BALANCE', message: fix.message || ('sobran afirmaciones con answer: ' + rec.q.answer + ' en esta hoja') }]
        : (fix.pool ? [{ code: 'EXAM_BANK_POOL', message: 'pregunta ADICIONAL para completar esta hoja: escribe una pregunta NUEVA, distinta de las aceptadas' }] : rec.reasons.slice());
      if (typeof fix.answer === 'boolean') reasons.push({ code: 'EXAM_BANK_TF_BALANCE', message: 'debe ser answer: ' + fix.answer });
      var g = byUnit.filter(function (x) { return x.unit === rec.unit; })[0];
      if (!g) { g = { unit: rec.unit, list: [] }; byUnit.push(g); }
      g.list.push({ id: fix.id, li: fix.li != null ? fix.li : rec.leafIndex, type: rec.type, chapterId: rec.unit.chapterId, moduleId: rec.unit.moduleId, reasons: reasons });
    });
    // Partes de ≤ 3500 tokens estimados por llamada (el pool puede pasar el tamaño de una parte original).
    var calls = [];
    byUnit.forEach(function (g) {
      var first = chunks.filter(function (ch) { return ch.unit === g.unit; })[0];
      dynExamBankSplitByTokens(g.list, DYN_EXAM_BANK_MAX_OUTPUT_EST, DYN_EXAM_BANK_REPAIR_TOKENS_EST).forEach(function (list) { calls.push({ base: first, list: list }); });
    });
    roundLog = {};
    var callFailedIds = {};
    await _dynExamBankPool(calls.map(function (c) {
      return async function () {
        var accepted = recordList().filter(function (r) { return r.unit === c.base.unit && r.status === 'valid'; }).map(function (r) { return r.q; });
        var list = c.list.map(function (x) { return { id: x.id, type: x.type, chapterId: x.chapterId, moduleId: x.moduleId, reasons: x.reasons }; });
        var memory = memoryFor(c.base.unit, c.list);
        c.list.forEach(function (x) { if (x.li != null && H(x.li).strategy) stats.strategyCandidates++; });
        // Mismo prefijo (fuente + tarea) que las partes del capítulo: lectura de caché.
        var repairParts = function (acc, mem) { var rp = dynExamBankRepairParts(c.base.parts, list, acc, mem); return dynExamBankWithTail(rp, rp.tail + avoidFor(c.base.unit)); };
        var parts = repairParts(accepted, memory);
        if (bodyBytes(parts) > DYN_EXAM_BANK_MAX_BODY_BYTES) parts = repairParts([], memory);
        if (bodyBytes(parts) > DYN_EXAM_BANK_MAX_BODY_BYTES) parts = repairParts([], '');
        if (bodyBytes(parts) > DYN_EXAM_BANK_MAX_BODY_BYTES) { stats.repairCallsSkipped++; c.list.forEach(function (x) { callFailedIds[x.id] = true; }); return; }
        var res = await callJson('continuation', parts);
        // Una llamada que no sirvió (JSON inválido, truncada) no es evidencia sobre la hoja: sus ids no cuentan como faltantes.
        if (!res.ok) { stats.repairCallsFailed++; c.list.forEach(function (x) { callFailedIds[x.id] = true; }); return; }
        ingest(res.questions, idSet(c.list.map(function (x) { return x.id; })), true);
        chunks.filter(function (ch) { return ch.unit === c.base.unit; }).forEach(saveChunk);
      };
    }), DYN_EXAM_BANK_CONCURRENCY);
    var log = roundLog;
    roundLog = null;
    // D3: un id pedido que el modelo no devolvió también es un intento sin progreso de la hoja (EXAM_BANK_MISSING),
    // pero NO es evidencia contra el capítulo: no entra en la firma ni en las candidatas que deciden la capacidad
    // (rev. I1). Una llamada fallida u omitida por tamaño no cuenta en nada.
    entries.forEach(function (fix) {
      if (callFailedIds[fix.id]) return;
      var li = fix.li != null ? fix.li : records[fix.id].leafIndex;
      var got = (log[li] || []).some(function (t) { return t.id === fix.id; });
      if (!got) {
        (log[li] = log[li] || []).push({ id: fix.id, ok: false, code: 'EXAM_BANK_MISSING', ref: null, terms: null });
        // rev. M5: un id del pool pedido y no devuelto se vuelve a pedir como faltante, no como «adicional».
        if (records[fix.id] && records[fix.id].status !== 'valid') records[fix.id].reasons = [{ code: 'EXAM_BANK_MISSING', message: 'no se devolvió esta pregunta' }];
      }
    });
    a = assemble();
    // rev. I2: una candidata válida que el ensamblado descartó (duplicado / casi duplicado) también es un intento fallido.
    Object.keys(log).forEach(function (k) {
      log[k].forEach(function (t) {
        var rec = records[t.id];
        if (t.ok && rec && rec.status !== 'valid') { t.ok = false; t.code = (rec.reasons && rec.reasons[0] && rec.reasons[0].code) || 'EXAM_BANK_DUPLICATE'; }
      });
    });
    Object.keys(log).forEach(function (k) {
      log[k].forEach(function (t) {
        var ty = plan[Number(k)].type;
        var rp = repairPass[ty] = repairPass[ty] || { returned: 0, valid: 0 };
        rp.returned++;
        if (t.ok) rp.valid++;
      });
    });
    // Falla sistémica: el rendimiento de TODO el intento (primera pasada + reparaciones, todos los tipos) es < 5 % con
    // ≥ 20 muestras → modelo o servicio que no produce; no se sigue escalando dentro del intento (queda el borrador y
    // decide la recuperación normal; nunca un banco corto). Una hoja difícil con rendimiento bajo pero real no corta.
    // Debe verse en ≥ 2 tipos de pregunta (≥ 5 muestras cada uno): una sola hoja atascada (p. ej. el reintento con
    // borrador que solo repara esa hoja) no es una falla sistémica — la decide la regla de capacidad.
    var byType = {};
    [stats.firstPass, repairPass].forEach(function (src) { Object.keys(src).forEach(function (t) { var b = byType[t] = byType[t] || { n: 0, v: 0 }; b.n += src[t].returned || 0; b.v += src[t].valid || 0; }); });
    var sampled = Object.keys(byType).filter(function (t) { return byType[t].n >= 5; });
    var systemic = sampled.length >= 2 && sampled.every(function (t) { return byType[t].v < 0.05 * byType[t].n; });
    if (systemic) { stats.systemicStop = round; break; } // rev. I1: una ronda sistémica no actualiza la memoria de ninguna hoja
    Object.keys(leafInfo).forEach(function (k) {
      var li = Number(k);
      var h = H(li);
      var info = leafInfo[li];
      var row = a.perLeaf[li];
      var tries = log[li] || [];
      if (!tries.length) return; // sin respuesta del modelo (llamada fallida u omitida): no es evidencia de nada
      var real = tries.filter(function (t) { return t.code !== 'EXAM_BANK_MISSING'; });
      h.tried += real.length;
      if (info.strategy) { h.triedStrategy += real.length; if (!h.strategyUsedThisAttempt) { h.strategyUsedThisAttempt = true; h.keptAtStrategy = info.keptBefore; } }
      real.forEach(function (t) { if (!t.ok) { if (t.ref) h.rejectedRefs.push(t.ref); if (t.terms && t.terms.length) h.rejectedTerms.push(t.terms); } });
      h.rejectedRefs = h.rejectedRefs.slice(-40);
      h.rejectedTerms = h.rejectedTerms.slice(-12);
      if (row.kept >= row.target || row.kept > info.keptBefore) { h.stuck = 0; h.strategyFails = 0; h.stratDryRounds = 0; h.stratDryTries = 0; return; }
      if (!real.length) return; // solo omisiones: la hoja no avanzó, pero nada dice que el capítulo no alcance
      var codes = {};
      real.forEach(function (t) { if (!t.ok) codes[t.code] = (codes[t.code] || 0) + 1; });
      var dom = Object.keys(codes).sort(function (x, y) { return codes[y] - codes[x]; })[0] || 'EXAM_BANK_DUPLICATE';
      if (info.strategy) {
        h.strategyFails = (h.strategyFails === 0 || h.sig === dom) ? h.strategyFails + 1 : 1;
        h.sig = dom;
        var sc = h.stratCodes = h.stratCodes || {};
        real.forEach(function (t) { if (!t.ok) sc[t.code] = (sc[t.code] || 0) + 1; });
        // AGOTADA — regla única, independiente del código (rev. I2 + sensibilidad): ≥ 4 rondas SEGUIDAS con la estrategia
        // alternativa sin avanzar y ≥ 20 candidatas respondidas desde el último avance. Con 20 candidatas, una hoja con
        // rendimiento real (≥ 15–20 %) casi nunca queda en cero (≤ 0,85²⁰ ≈ 4 %·10⁻²); el ruido no la corta. Como la
        // estrategia viaja en el borrador, el corte llega a más tardar en el 2.º intento.
        h.stratDryRounds = (h.stratDryRounds | 0) + 1;
        h.stratDryTries = (h.stratDryTries | 0) + real.length;
        if (h.stratDryRounds >= 4 && h.stratDryTries >= 20) h.capacity = true;
      } else {
        h.stuck++;
        h.sig = dom;
        h.strategy = true;
      }
    });
  }
  // Regla de conjunto: con todas las hojas sobre el piso, hasta 2 pasadas de longitud para el excedente que quede
  // (cada id una vez por intento: acotado).
  if (!a.perLeaf.some(function (l) { return l.kept < l.floor; })) {
    for (var lp = 0; lp < 2; lp++) { if (!(await reviseLengthExcess())) break; a = assemble(); }
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
      var doc = { draftVersion: 1, reason: reason, itemKey: item.itemKey, generation: item.generation == null ? null : item.generation, scope: scope, promptVersion: bankPromptVersion, planSig: draftExpect.planSig, chapterMdSha: chapterMdSha, questions: qs,
        // Exam-bank D3/D4: memoria por hoja para el próximo intento y diagnóstico persistido de ESTE intento.
        leafHistory: leafHistoryOut(), diagnostics: diagnosticsOut() };
      // Revisión de forma: candidatas rechazadas solo por forma, aún sin revisar (el próximo intento las revisa).
      var revCands = recordList().filter(function (r) { return r.status !== 'valid' && r.revCand; }).map(function (r) { return r.revCand.raw; }).slice(0, DYN_EXAM_BANK_DRAFT_MAX_QUESTIONS);
      if (revCands.length) doc.candidates = revCands;
      // Regla de conjunto: ids ya revisados por longitud (no se repiten) e intentos que terminaron con esa falla.
      var lenIds = Object.keys(lenTried).slice(0, DYN_EXAM_BANK_DRAFT_MAX_QUESTIONS);
      if (lenIds.length) doc.lengthRevisedIds = lenIds;
      // setRuleAttempts: diagnóstico; setRuleFixedLast/ReturnedLast: deciden el corte sin avance del intento siguiente.
      if (reason === 'bank_rule') { doc.setRuleAttempts = (draft.draftReason === 'bank_rule' ? (draft.setRuleAttempts || 1) : 0) + 1; doc.setRuleFixedLast = setRuleStats.fixed; doc.setRuleReturnedLast = setRuleStats.returned; }
      out.draft = _dynV3JsonArtifact(item, DYN_EXAM_BANK_DRAFT_ARTIFACT_TYPE, doc, (scope === 'module' ? moduleId : item.itemRunId) + '_draft').artifact;
      out.draftQuestions = qs.length;
      // bank_rule: lo ya pagado se conserva — el worker no descarta los puntos de guardado de este intento.
      if (reason === 'bank_rule') out.keepCheckpoints = true;
    }
    return out;
  }

  function leafHistoryOut() {
    var out = {};
    Object.keys(hist).forEach(function (k) {
      var h = hist[k];
      if (!h.tried && !h.strategy) return;
      out[k] = { stuck: h.stuck, strategy: h.strategy, strategyFails: h.strategyFails, sig: h.sig, tried: h.tried, triedStrategy: h.triedStrategy, stratDryRounds: h.stratDryRounds | 0, stratDryTries: h.stratDryTries | 0, stratCodes: h.stratCodes || {}, rejectedRefs: h.rejectedRefs.slice(-40), rejectedTerms: h.rejectedTerms.slice(-12) };
    });
    return out;
  }
  function diagnosticsOut() {
    return { rejectedByCode: rejectedByCode, rejectedDetail: topDetail(), firstPass: stats.firstPass, repairPass: repairPass, calls: stats.calls,
      poolCandidates: stats.poolCandidates, mintedIds: stats.mintedIds, strategyCandidates: stats.strategyCandidates, evidenceByRef: stats.evidenceByRef, draftUnused: stats.draftUnused, systemicStop: stats.systemicStop || null, revision: stats.revision, setRule: setRuleStats, correctLongest: a ? (a.histogram || [])[3] : null, mcTotal: a ? a.mcTotal : null, mainPartsFailed: stats.mainPartsFailed || 0, tagsReduced: stats.tagsReduced || 0,
      perLeaf: (a ? a.perLeaf : []).map(function (l) { return { owner: l.owner, type: l.type, slots: l.slots, kept: l.kept, requested: l.requested, accepted: l.accepted, acceptedAfterRepair: l.acceptedAfterRepair }; }) };
  }
  function detailTail() {
    var d = topDetail();
    var parts = Object.keys(d).sort(function (x, y) { return (rejectedByCode[y] || 0) - (rejectedByCode[x] || 0); }).slice(0, 3).map(function (code) { return code + '[' + d[code].slice(0, 2).join('; ') + ']'; });
    return parts.length ? ' — detalle: ' + parts.join(' ') : '';
  }

  // Exam-bank D3: hoja AGOTADA (tampoco avanzó con la estrategia alternativa) → falla definitiva y explícita, sin
  // reintentos automáticos (clase D en el backend: la decide una persona). Nunca se sube un banco corto.
  var exhausted = a.perLeaf.map(function (l, li) { return { l: l, h: H(li) }; }).filter(function (x) { return x.l.kept < x.l.floor && x.h.capacity; });
  if (exhausted.length) {
    var capOut = fail('EXAM_BANK_LEAF_CAPACITY: ' + exhausted.map(function (x) {
      return x.l.owner + ' × ' + x.l.type + ' ' + x.l.kept + '/' + x.l.floor + ' (' + x.h.tried + ' candidatas, ' + x.h.triedStrategy + ' con la estrategia alternativa; motivo ' + (x.h.sig || '?') + ')';
    }).join('; ') + ': el texto del capítulo no alcanza para esta hoja con las reglas del banco; revisar el capítulo o el plan del examen' + detailTail(), false);
    capOut.diagnostics = diagnosticsOut();
    capOut.leafHistory = leafHistoryOut();
    return capOut;
  }

  // Pisos, cobertura y reglas de banco: nunca se sube un banco corto o sesgado.
  var below = a.perLeaf.filter(function (l) { return l.kept < l.floor; });
  var codes = Object.keys(rejectedByCode).sort().map(function (k) { return k + '×' + rejectedByCode[k]; }).join(', ');
  if (below.length) {
    return failWithDraft('EXAM_BANK_INCOMPLETE: hojas por debajo del piso tras la reparación: ' + below.map(function (l) { return l.owner + ' × ' + l.type + ' ' + l.kept + '/' + l.floor; }).join('; ') + (codes ? ' (rechazos: ' + codes + ')' : '') + detailTail(), 'leaf_below_floor');
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
    // Regla de conjunto con TODAS las hojas completas (el único error es el ≤ 30 % «correcta la más larga» del banco):
    // borrador bank_rule (se conserva lo pagado; el reintento solo corrige el excedente). Si ya no queda ninguna
    // candidata revisable y el intento anterior terminó igual → falla DEFINITIVA y explícita (sin bucle).
    var setOnly = a.bankErrors.every(function (e) { return /^EXAM_BANK_LENGTH_BIAS/.test(e); }) &&
      v.errors.every(function (x) { return x.code === 'EXAM_BANK_LENGTH_BIAS' && x.path === '$.questions'; });
    if (setOnly) {
      var left = lengthCandidates(a, true).length;
      var lbMsg = 'la correcta es la opción más larga en ' + a.histogram[3] + '/' + a.mcTotal + ' MC (máx. 30 %; excedente ' + dynExamBankLengthBiasExcess(a) + ')';
      // Sin bucle: el intento anterior ya terminó por esta regla y (no quedan candidatas, o ni aquel ni este corrigieron
      // ninguna) → la revisión no avanza: falla definitiva.
      // rev. I1: «sin avance» exige respuestas REALES del modelo en ambos intentos (fallas de formato no cuentan).
      var noProgress = draft.draftReason === 'bank_rule' && (!left || ((draft.setRuleFixedLast || 0) === 0 && (draft.setRuleReturnedLast || 0) > 0 && setRuleStats.fixed === 0 && setRuleStats.returned > 0));
      if (noProgress) {
        var srOut = fail('EXAM_BANK_SET_RULE_CAPACITY: ' + lbMsg + ' tras la revisión de longitud (' + setRuleStats.fixed + ' corregidas en este intento, ' + Object.keys(lenTried).length + ' revisadas en total) y sin candidatas revisables: revisar el capítulo o el plan del examen' + detailTail(), false);
        srOut.diagnostics = diagnosticsOut();
        return srOut;
      }
      return failWithDraft('EXAM_BANK_INCOMPLETE: regla de conjunto: ' + lbMsg + ' — todas las hojas completas; el reintento solo corrige el excedente (' + left + ' candidatas revisables)', 'bank_rule');
    }
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
    perLeaf: a.perLeaf.map(function (l) { return { owner: l.owner, type: l.type, slots: l.slots, kept: l.kept, floor: l.floor, requested: l.requested, accepted: l.accepted, acceptedAfterRepair: l.acceptedAfterRepair, acceptedUsable: l.acceptedUsable }; }),
    // Revisión O4: con partes desde caché o borrador, una reparación anterior parece de primera pasada → la tasa por
    // hoja de ESTA corrida no sirve para decidir la holgura (solo se usan corridas con yieldMeasurable).
    yieldMeasurable: stats.cachedChunks === 0 && !(draftInfo && draftInfo.used),
    rejectedByCode: rejectedByCode,
    rejectedDetail: topDetail(),
    firstPass: stats.firstPass,
    repairPass: repairPass,
    poolCandidates: stats.poolCandidates,
    revision: stats.revision,
    setRule: setRuleStats,
    mintedIds: stats.mintedIds,
    strategyCandidates: stats.strategyCandidates,
    evidenceByRef: stats.evidenceByRef,
    draftUnused: stats.draftUnused,
    mainPartsFailed: stats.mainPartsFailed || 0,
    tagsReduced: stats.tagsReduced || 0,
    leafHistory: leafHistoryOut(),
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
  if (stemsInfo.meta) {
    // Loop 9: de dónde salieron las preguntas de módulo (y cuántos bancos no se pudieron leer) — nunca en silencio.
    summary.externalStemsSource = stemsInfo.meta.source;
    summary.externalStemsDependencies = stemsInfo.meta.dependencies;
    summary.externalStemsUnreadable = stemsInfo.meta.unreadable;
  }
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
  if (item.type === 'guided_practice') return _dynRunGuidedPractice(item);
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
      if (res.ok && res.data && _dynRunHasGuidedPractice(res.data)) state.withGuidedPractice = true;
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
    var llmMode = _dynExecutorLlmMode();
    if (llmMode !== 'real') meta.llmMode = llmMode;
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
        // O2b: igual para la actividad de aplicación (actividad validada, solucionario fallido); el campo depende del tipo.
        var failExtra = null;
        var draftField = dynDraftFieldFor(item);
        if (result.draft && result.retryable !== false && draftField && !(abandoned || fatallyPaused())) {
          try {
            var upDraft = await uploadClaimedArtifact(item, result.draft);
            if (upDraft.ok && upDraft.artifactId) { failExtra = {}; failExtra[draftField] = upDraft.artifactId; }
          } catch (eDraft) { /* sin borrador: el fail va sin el campo y el backend conserva el anterior */ }
        } else if (result.draftClear && draftField) {
          failExtra = {}; failExtra[draftField] = null; // fix round 4 (R4): falla de reglas sin faltante
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
      var execLlmMode = _dynExecutorLlmMode();
      if (execLlmMode !== 'real') summary.llmMode = execLlmMode;
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
      // O2b fix round 1 (1): la actividad ya validada viaja en el error (e.__dynDraft) si la 2.ª pasada lanzó; se sube
      // solo si el error es reintentable, el run no está pausado y el claim anuncia el borrador (400 → sin el campo).
      var thrownExtra = null;
      var thrownField = dynDraftFieldFor(item);
      if (e && e.__dynDraft && thrownField && mapped.retryable && !mapped.runPaused && !(abandoned || fatallyPaused())) {
        try {
          var upThrown = await uploadClaimedArtifact(item, e.__dynDraft);
          if (upThrown.ok && upThrown.artifactId) { thrownExtra = {}; thrownExtra[thrownField] = upThrown.artifactId; }
        } catch (eUp) { /* sin borrador */ }
      }
      try {
        var thrownRes = thrownExtra
          ? await backendDynFail(item.itemRunId, executorId, mapped.msg, mapped.retryable, thrownExtra)
          : await backendDynFail(item.itemRunId, executorId, mapped.msg, mapped.retryable);
        if (thrownExtra && thrownRes && thrownRes.ok === false && thrownRes._httpStatus === 400) {
          await backendDynFail(item.itemRunId, executorId, mapped.msg, mapped.retryable);
        }
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
          state.withGuidedPractice = _dynRunHasGuidedPractice(res.data);
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
      var sentTypes = _dynClaimTypesFor(state.rulesVersion, state.withApplication === true, state.withGuidedPractice === true);
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
